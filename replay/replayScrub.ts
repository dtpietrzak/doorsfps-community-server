/**
 * Epic 14.5 — efficient scrubbing.
 *
 * 14.3 always reloads the nearest prior checkpoint and steps from there.
 * Navigating a long match would resimulate that gap on every small move.
 * This module keeps that floor plan and skips the reload when the runner
 * has already completed the anchor and has not passed the target:
 *
 * ```text
 * cursor >= anchor and cursor <= target
 *   → step cursor+1 .. target
 * otherwise
 *   → 14.3 load + step
 * ```
 *
 * Backward seeks and seeks that have not reached the anchor still load.
 * A later checkpoint is not walked past. An already-landed target steps
 * nothing and does not reload.
 *
 * Scan-locked: no clock, playback, camera, THREE, DOM, wall-clock, fs,
 * blob, store, or net. No second floor. The runner steps.
 *
 * Handoffs: 11.6 `ReplayPlayback.seek` applies the decision then
 * `clock.resetTo`. 14.4 owns pause across a drag and does not seek.
 * 21.4 draws the bar.
 */

import type { ReplayRunner } from "./replaySimulationRunner.ts";
import {
  executeReplaySeek,
  type ReplaySeekHooks,
  type ReplaySeekPlan,
} from "./replaySeek.ts";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ReplayScrubErrorCode =
  | "replay-scrub-bad-cursor"
  | "replay-scrub-bad-continue";

export class ReplayScrubError extends Error {
  readonly code: ReplayScrubErrorCode;
  readonly detail: string | null;

  constructor(
    code: ReplayScrubErrorCode,
    message: string,
    opts?: { detail?: string | null; cause?: unknown },
  ) {
    super(
      message,
      opts?.cause !== undefined ? { cause: opts.cause } : undefined,
    );
    this.name = "ReplayScrubError";
    this.code = code;
    this.detail = opts?.detail ?? null;
  }
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

/**
 * A 14.3 floor plus whether this navigation continues from the cursor.
 * `steps` is the `runner.step` count actually performed.
 */
export type ReplayScrubPlan = {
  readonly floor: ReplaySeekPlan;
  readonly targetTick: number;
  /** Completed tick we continue from. Null when the floor is loaded. */
  readonly fromTick: number | null;
  readonly stepFrom: number;
  readonly steps: number;
  readonly resumed: boolean;
};

/**
 * Tick the 14.3 anchor has already completed. A checkpoint frame is the
 * state after `frame.tick`. The initial anchor is the tick before
 * `stepFrom` (`firstTick - 1`).
 */
export function replayScrubAnchorTick(plan: ReplaySeekPlan): number {
  return plan.stepFrom - 1;
}

/**
 * Continue when `currentTick` is on the anchor or between it and the
 * target. Otherwise return the floor plan unchanged.
 */
export function planReplayScrub(
  floor: ReplaySeekPlan,
  currentTick: number,
): ReplayScrubPlan {
  if (!Number.isInteger(currentTick) || !Number.isFinite(currentTick)) {
    throw new ReplayScrubError(
      "replay-scrub-bad-cursor",
      "scrub cursor must be an integer tick",
      { detail: String(currentTick) },
    );
  }

  const anchorTick = replayScrubAnchorTick(floor);
  const canContinue = currentTick >= anchorTick &&
    currentTick <= floor.targetTick;
  if (!canContinue) {
    return {
      floor,
      targetTick: floor.targetTick,
      fromTick: null,
      stepFrom: floor.stepFrom,
      steps: floor.steps,
      resumed: false,
    };
  }

  return {
    floor,
    targetTick: floor.targetTick,
    fromTick: currentTick,
    stepFrom: currentTick + 1,
    steps: floor.targetTick - currentTick,
    resumed: true,
  };
}

/**
 * Load the floor, or step forward from the cursor. Does not touch a clock.
 */
export function executeReplayScrub(
  runner: ReplayRunner,
  plan: ReplayScrubPlan,
  hooks: ReplaySeekHooks,
): void {
  if (!plan.resumed) {
    executeReplaySeek(runner, plan.floor, hooks);
    return;
  }

  if (runner.currentTick !== plan.fromTick) {
    throw new ReplayScrubError(
      "replay-scrub-bad-continue",
      "runner is not on the scrub continuation tick",
      {
        detail: `runner ${runner.currentTick} from ${plan.fromTick}`,
      },
    );
  }

  hooks.onAnchored();

  if (plan.steps === 0) {
    if (runner.currentTick !== plan.targetTick) {
      throw new ReplayScrubError(
        "replay-scrub-bad-continue",
        "scrub continuation did not land on the target tick",
        {
          detail: `runner ${runner.currentTick} target ${plan.targetTick}`,
        },
      );
    }
    return;
  }

  if (runner.currentTick + 1 !== plan.stepFrom) {
    throw new ReplayScrubError(
      "replay-scrub-bad-continue",
      "scrub continuation is not the tick before the forward replay",
      {
        detail: `runner ${runner.currentTick} stepFrom ${plan.stepFrom}`,
      },
    );
  }

  for (let i = 0; i < plan.steps; i++) {
    const tick = plan.stepFrom + i;
    runner.step(tick);
    hooks.onStepped(tick);
  }

  if (runner.currentTick !== plan.targetTick) {
    throw new ReplayScrubError(
      "replay-scrub-bad-continue",
      "scrub continuation did not finish on the target tick",
      {
        detail: `runner ${runner.currentTick} target ${plan.targetTick}`,
      },
    );
  }
}
