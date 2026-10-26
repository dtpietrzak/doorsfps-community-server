/**
 * Epic 14.3 — checkpoint-based seeking.
 *
 * ```text
 * Target Time
 * → Nearest Prior Checkpoint
 * → Load Checkpoint
 * → Replay Forward
 * → Target Time
 * ```
 *
 * Contract (notes/replay/replay-detailed.md §14.3, floors from 9.5 / 11.1):
 * - One `findPriorOrEqual` per seek. A miss (`empty` or `before-first`) is
 *   the initial state. This module never clamps a miss forward to a later
 *   checkpoint.
 * - A hit loads that frame with `resetToCheckpoint` (completed tick). The
 *   initial anchor uses `resetToInitial` (runner sits on `firstTick - 1`).
 * - Forward replay is `runner.step` from the anchor through `targetTick`.
 *   An exact checkpoint hit steps nothing.
 * - Tick is canonical. `timeMs` is absolute sim time via `timeMsToTick`
 *   (sub-tick floors). Out-of-range integers clamp into
 *   `[firstTick, lastTick]`, matching `ReplayClock.resetTo`.
 * - The landed tick is completed. The caller parks the clock with
 *   `resetTo(target)` (virgin stays the 11.6 `start()` posture). Speed,
 *   pause, and focus are not this module's.
 * - This function always describes the reload. 14.5 (`replayScrub.ts`)
 *   skips it when the runner is already between the anchor and the target.
 *
 * Scan-locked: no clock, playback, camera, THREE, DOM, wall-clock, fs,
 * blob, store, or net imports. The runner steps; this module does not
 * reimplement the floor or the step body.
 *
 * Handoffs: 11.6 `ReplayPlayback.seek` applies the plan and the clock;
 * 13.4 opens a killcam window by seeking to `startTick - 1`; 14.4 owns
 * speed; 14.5 decides whether the reload runs; 21.4 draws the bar.
 */

import type { AuthoritativeCheckpoint } from "./authoritativeCheckpoint.ts";
import {
  CheckpointIndex,
  type CheckpointIndexLookup,
  timeMsToTick,
} from "./checkpointIndex.ts";
import type {
  ReplayRunner,
  ReplayRunSession,
} from "./replaySimulationRunner.ts";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ReplaySeekErrorCode =
  | "replay-seek-bad-tick"
  | "replay-seek-bad-time"
  | "replay-seek-bad-range"
  | "replay-seek-bad-target"
  | "replay-seek-bad-anchor";

export class ReplaySeekError extends Error {
  readonly code: ReplaySeekErrorCode;
  readonly detail: string | null;

  constructor(
    code: ReplaySeekErrorCode,
    message: string,
    opts?: { detail?: string | null; cause?: unknown },
  ) {
    super(
      message,
      opts?.cause !== undefined ? { cause: opts.cause } : undefined,
    );
    this.name = "ReplaySeekError";
    this.code = code;
    this.detail = opts?.detail ?? null;
  }
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export type ReplaySeekAnchor =
  | { readonly kind: "initial" }
  | { readonly kind: "checkpoint"; readonly frame: AuthoritativeCheckpoint };

/**
 * What one seek will do. `stepFrom` is the first `runner.step` tick when
 * `steps > 0`. The half-open run is `[stepFrom, stepFrom + steps)`.
 */
export type ReplaySeekPlan = {
  readonly targetTick: number;
  readonly anchor: ReplaySeekAnchor;
  readonly stepFrom: number;
  readonly steps: number;
};

export type ReplaySeekResult = {
  readonly targetTick: number;
  readonly anchorKind: "initial" | "checkpoint";
  /** Checkpoint tick, or null when the anchor is the initial state. */
  readonly anchorTick: number | null;
  readonly steps: number;
  readonly ended: boolean;
  /**
   * 14.5 — the floor reload was skipped and the runner stepped from its
   * current tick. False when the anchor was loaded.
   */
  readonly resumed: boolean;
};

type ReplaySeekTarget =
  | { readonly tick: number }
  | { readonly timeMs: number };

function assertIntegerTick(name: string, tick: number): void {
  if (!Number.isInteger(tick) || !Number.isFinite(tick)) {
    throw new ReplaySeekError(
      "replay-seek-bad-tick",
      `${name} must be an integer tick`,
      { detail: String(tick) },
    );
  }
}

/**
 * Canonical target tick. `{ tick }` must be an integer. `{ timeMs }` is
 * absolute sim time and floors. Either result clamps into the session.
 */
export function resolveReplaySeekTick(
  target: ReplaySeekTarget,
  firstTick: number,
  lastTick: number,
): number {
  assertIntegerTick("firstTick", firstTick);
  assertIntegerTick("lastTick", lastTick);
  if (lastTick < firstTick) {
    throw new ReplaySeekError(
      "replay-seek-bad-range",
      "lastTick precedes firstTick",
      { detail: `${firstTick}..${lastTick}` },
    );
  }

  const hasTick = "tick" in target;
  const hasTime = "timeMs" in target;
  if (hasTick === hasTime) {
    throw new ReplaySeekError(
      "replay-seek-bad-target",
      "seek target must be exactly one of tick or timeMs",
    );
  }

  let tick: number;
  if (hasTime) {
    const timeMs = target.timeMs;
    if (typeof timeMs !== "number" || !Number.isFinite(timeMs)) {
      throw new ReplaySeekError(
        "replay-seek-bad-time",
        "timeMs must be a finite number",
        { detail: String(timeMs) },
      );
    }
    tick = timeMsToTick(timeMs);
  } else {
    assertIntegerTick("targetTick", target.tick);
    tick = target.tick;
  }

  if (tick < firstTick) return firstTick;
  if (tick > lastTick) return lastTick;
  return tick;
}

/**
 * Floor once, then choose the anchor. A checkpoint outside
 * `[firstTick, targetTick]` is not a start point: a later frame is a
 * bug, an earlier-than-session frame is ignored in favor of initial state.
 */
export function planReplaySeek(
  targetTick: number,
  firstTick: number,
  lastTick: number,
  findPriorCheckpoint: (tick: number) => CheckpointIndexLookup,
): ReplaySeekPlan {
  assertIntegerTick("targetTick", targetTick);
  assertIntegerTick("firstTick", firstTick);
  assertIntegerTick("lastTick", lastTick);
  if (lastTick < firstTick) {
    throw new ReplaySeekError(
      "replay-seek-bad-range",
      "lastTick precedes firstTick",
      { detail: `${firstTick}..${lastTick}` },
    );
  }
  if (targetTick < firstTick || targetTick > lastTick) {
    throw new ReplaySeekError(
      "replay-seek-bad-tick",
      "targetTick is outside [firstTick, lastTick]",
      { detail: `${targetTick} not in ${firstTick}..${lastTick}` },
    );
  }

  const lookup = findPriorCheckpoint(targetTick);
  if (lookup.kind === "hit") {
    const frame = lookup.frame;
    if (!Number.isInteger(frame.tick) || !Number.isFinite(frame.tick)) {
      throw new ReplaySeekError(
        "replay-seek-bad-anchor",
        "checkpoint tick is not an integer",
        { detail: String(frame.tick) },
      );
    }
    if (frame.tick > targetTick) {
      throw new ReplaySeekError(
        "replay-seek-bad-anchor",
        "checkpoint floor returned a frame after the target",
        { detail: `frame ${frame.tick} target ${targetTick}` },
      );
    }
    if (frame.tick >= firstTick) {
      const steps = targetTick - frame.tick;
      return {
        targetTick,
        anchor: { kind: "checkpoint", frame },
        stepFrom: frame.tick + 1,
        steps,
      };
    }
  }

  const steps = targetTick - firstTick + 1;
  return {
    targetTick,
    anchor: { kind: "initial" },
    stepFrom: firstTick,
    steps,
  };
}

export type ReplaySeekHooks = {
  /** Runner is on the anchor and has not stepped toward the target. */
  onAnchored(): void;
  /** `runner.step(tick)` just completed. */
  onStepped(tick: number): void;
};

/**
 * Load the anchor and step forward to `plan.targetTick`.
 * Does not touch a clock.
 */
export function executeReplaySeek(
  runner: ReplayRunner,
  plan: ReplaySeekPlan,
  hooks: ReplaySeekHooks,
): void {
  if (plan.anchor.kind === "checkpoint") {
    runner.resetToCheckpoint(plan.anchor.frame);
  } else {
    runner.resetToInitial();
  }
  hooks.onAnchored();

  if (plan.steps === 0) {
    if (runner.currentTick !== plan.targetTick) {
      throw new ReplaySeekError(
        "replay-seek-bad-anchor",
        "checkpoint anchor did not land on the target tick",
        {
          detail: `runner ${runner.currentTick} target ${plan.targetTick}`,
        },
      );
    }
    return;
  }

  if (runner.currentTick + 1 !== plan.stepFrom) {
    throw new ReplaySeekError(
      "replay-seek-bad-anchor",
      "anchor did not land on the tick before the forward replay",
      { detail: `runner ${runner.currentTick} stepFrom ${plan.stepFrom}` },
    );
  }

  for (let i = 0; i < plan.steps; i++) {
    const tick = plan.stepFrom + i;
    runner.step(tick);
    hooks.onStepped(tick);
  }

  if (runner.currentTick !== plan.targetTick) {
    throw new ReplaySeekError(
      "replay-seek-bad-anchor",
      "forward replay did not finish on the target tick",
      { detail: `runner ${runner.currentTick} target ${plan.targetTick}` },
    );
  }
}

// ---------------------------------------------------------------------------
// Session floors
// ---------------------------------------------------------------------------

type SessionWithFloor = ReplayRunSession & {
  findPriorCheckpoint?: (tick: number) => CheckpointIndexLookup;
};

/**
 * Floor for a session that already has one (a loaded file, or a buffer
 * adapter). Sessions without one miss, and the seek starts from initial
 * state. Does not scan `checkpointFrameAt`.
 */
export function replaySeekFloor(
  session: ReplayRunSession,
): (tick: number) => CheckpointIndexLookup {
  const find = (session as SessionWithFloor).findPriorCheckpoint;
  if (typeof find !== "function") {
    return () => ({ kind: "miss", reason: "empty" });
  }
  return (tick) => find.call(session, tick);
}

/** 9.5 floor over an already-ordered checkpoint list. Empty misses. */
export function floorFromCheckpointFrames(
  frames: readonly AuthoritativeCheckpoint[],
): (tick: number) => CheckpointIndexLookup {
  if (frames.length === 0) {
    return () => ({ kind: "miss", reason: "empty" });
  }
  const index = new CheckpointIndex();
  for (const frame of frames) index.insert(frame);
  return (tick) => index.findPriorOrEqual(tick);
}
