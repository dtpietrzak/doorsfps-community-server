/**
 * Epic 12.7 — delayed live spectating (buffer tail → runner → observe).
 *
 * Owns the live-buffer → ReplayRunSession → targetTailTick boundary only:
 *   ReplaySessionBuffer (8.5 read seam: getTailWindow + dense input rows)
 *     → createDelayedLiveSession / createDelayedLiveTail
 *     → poll() steps the 11.2 runner to
 *       targetTailTick = liveLatestCommittedTick - DELAY_TICKS
 *   12.1–12.6 observe the reconstructed cursor; this module never poses,
 *   filters, or shapes context.
 *
 * Contract (see notes/replay/12-spectator-system/12-07-delayed-live-spectating.md):
 * - Tick delay: DELAY_TICKS = DELAY_MS * TICK_HZ / 1000, asserted integral
 *   + round-trip at construction. Default DELAY_MS = 5_000 → 300 ticks.
 *   Non-positive / non-integral → replay-delayed-live-bad-delay.
 * - firstTick = first dense committed input tick (recording start). Delay is
 *   pacing, not a sliding session range: resetToInitial restores captureTick
 *   state, so firstTick = live - DELAY would skip ticks and diverge.
 * - lastTick at runner construct is the buffer cap ceiling (the runner copies
 *   lastTick once). Frozen playback-conformance sessions use max committed.
 * - ReplayPlayback.frame() is not the live loop (11.6 clocks snapshot lastTick
 *   at start() and would play toward live). poll() owns step/hold.
 * - Committed-tick gate: step iff a dense input row is present. Sparse event
 *   absence is valid. Incomplete ticks wait (not an error).
 * - Warm-up (target < firstTick) waits with no frame — not underrun, not
 *   tick-0-as-live. Underrun (retention floor / contiguity gap) is named
 *   replay-delayed-live-underrun; never silent jump, never shrink delay.
 * - getTailWindow() === null → replay-delayed-live-closed. Cap-terminal
 *   reasons ride optional terminalReason() → replay-delayed-live-failed.
 * - checkpointFrameAt unset (always-miss). No loader, bytes, socket, or
 *   buffer writes. Raid sessions fail at createReplayRunner, unchanged.
 * - Observational non-interference: tailing does not write the buffer or
 *   the live match.
 *
 * Handoffs: 11.2 runner steps; 11.6 playback consumes frozen committed
 * sessions for conformance; 12.1–12.6 observe; 13.x/14.x do not apply to
 * the live tail; 18.x asserts equivalence + non-interference; 21.5 owns
 * "watch live" chrome and the frame loop, never delay policy.
 */

import { TICK_HZ } from "../shared/sim/game.ts";
import type { AuthoritativeEvent } from "../shared/sim/authoritativeEvent.ts";
import type { MapCollision } from "../world/MapCollision.ts";
import type { RecordedTickInputs } from "./recordedTickInputs.ts";
import type { ReplaySessionBuffer } from "./replaySessionBuffer.ts";
import type { ReplayBufferFailReason } from "./replaySessionBuffer.ts";
import {
  createReplayRunner,
  type ReplayRunner,
  type ReplayRunSession,
  type ReplayTickOutcome,
} from "./replaySimulationRunner.ts";

// ---------------------------------------------------------------------------
// Delay config
// ---------------------------------------------------------------------------

/** Recommended anti-spoiler delay (5s at TICK_HZ = 60 → 300 ticks). */
export const DELAYED_LIVE_DELAY_MS = 5_000;

const EMPTY_EVENTS: readonly AuthoritativeEvent[] = Object.freeze([]);

export type DelayedLiveErrorCode =
  | "replay-delayed-live-bad-delay"
  | "replay-delayed-live-underrun"
  | "replay-delayed-live-closed"
  | "replay-delayed-live-failed";

export class DelayedLiveError extends Error {
  readonly code: DelayedLiveErrorCode;
  readonly detail: string | null;

  constructor(
    code: DelayedLiveErrorCode,
    message: string,
    opts?: { detail?: string | null },
  ) {
    super(message);
    this.name = "DelayedLiveError";
    this.code = code;
    this.detail = opts?.detail ?? null;
  }
}

export function delayTicksFromMs(
  delayMs: number = DELAYED_LIVE_DELAY_MS,
): number {
  if (!Number.isFinite(delayMs) || delayMs <= 0) {
    failBadDelay(delayMs, "delayMs must be a positive finite number");
  }
  const ticks = (delayMs * TICK_HZ) / 1000;
  if (!Number.isInteger(ticks) || ticks < 1) {
    failBadDelay(
      delayMs,
      `DELAY_TICKS = delayMs * TICK_HZ / 1000 must be a positive integer (got ${ticks})`,
    );
  }
  const roundTrip = (ticks * 1000) / TICK_HZ;
  if (roundTrip !== delayMs) {
    failBadDelay(
      delayMs,
      `delayMs round-trip failed: ${delayMs} → ${ticks} ticks → ${roundTrip}`,
    );
  }
  return ticks;
}

export function computeTargetTailTick(
  liveLatestCommittedTick: number,
  delayTicks: number,
): number {
  return liveLatestCommittedTick - delayTicks;
}

function failBadDelay(delayMs: number, message: string): never {
  throw new DelayedLiveError(
    "replay-delayed-live-bad-delay",
    `DelayedLive: ${message}`,
    { detail: `delayMs=${String(delayMs)}` },
  );
}

function fail(
  code: DelayedLiveErrorCode,
  message: string,
  detail: string | null,
): never {
  throw new DelayedLiveError(code, message, { detail });
}

// ---------------------------------------------------------------------------
// Buffer reads (no writes)
// ---------------------------------------------------------------------------

function minInputTick(buffer: ReplaySessionBuffer): number | null {
  let min: number | null = null;
  for (const tick of buffer.inputs.keys()) {
    if (min === null || tick < min) min = tick;
  }
  return min;
}

function maxInputTick(buffer: ReplaySessionBuffer): number | null {
  let max: number | null = null;
  for (const tick of buffer.inputs.keys()) {
    if (max === null || tick > max) max = tick;
  }
  return max;
}

function ceilingLastTick(
  firstTick: number,
  buffer: ReplaySessionBuffer,
): number {
  return firstTick + buffer.caps.maxRecordingTicks - 1;
}

export type DelayedLiveLastTickMode = "committed" | "ceiling";

export type CreateDelayedLiveSessionOptions = {
  readonly lastTickMode?: DelayedLiveLastTickMode;
};

/**
 * ReplayRunSession over a live (or frozen) 8.5 buffer.
 *
 * `lastTickMode: "ceiling"` (tail controller) lets the runner keep stepping
 * as live grows, because the runner copies lastTick at construct.
 * `lastTickMode: "committed"` (playback conformance) snapshots the current
 * max input tick so 11.6 clocks end-hold correctly.
 */
export function createDelayedLiveSession(
  buffer: ReplaySessionBuffer,
  opts?: CreateDelayedLiveSessionOptions,
): ReplayRunSession {
  const init = buffer.init;
  if (init == null) {
    fail(
      "replay-delayed-live-closed",
      "DelayedLive: buffer has no init",
      "no-init",
    );
  }
  const firstTick = minInputTick(buffer);
  if (firstTick == null) {
    fail(
      "replay-delayed-live-closed",
      "DelayedLive: buffer has no dense input rows",
      "no-inputs",
    );
  }
  const mode = opts?.lastTickMode ?? "committed";
  const lastTick = mode === "ceiling"
    ? ceilingLastTick(firstTick, buffer)
    : (maxInputTick(buffer) ?? firstTick);
  if (lastTick < firstTick) {
    fail(
      "replay-delayed-live-closed",
      "DelayedLive: invalid session tick range",
      `firstTick=${firstTick} lastTick=${lastTick}`,
    );
  }

  const session: ReplayRunSession = {
    initialState: init,
    firstTick,
    lastTick,
    inputAt(tick: number): RecordedTickInputs {
      const row = buffer.getInputs(tick);
      if (row === undefined) {
        fail(
          "replay-delayed-live-underrun",
          `DelayedLive: no dense input row for tick ${tick}`,
          `missingTick=${tick} window=[${firstTick}, ${lastTick}]`,
        );
      }
      return row;
    },
    eventsAt(tick: number): ReadonlyArray<AuthoritativeEvent> {
      return buffer.getEvents(tick)?.events ?? EMPTY_EVENTS;
    },
  };
  return session;
}

// ---------------------------------------------------------------------------
// Tail controller
// ---------------------------------------------------------------------------

export type DelayedLivePollWaiting = {
  readonly status: "waiting";
  readonly targetTailTick: number;
  readonly liveLatestCommittedTick: number;
};

export type DelayedLivePollTracking = {
  readonly status: "tracking";
  readonly targetTailTick: number;
  readonly liveLatestCommittedTick: number;
  readonly currentTick: number;
  readonly outcome: ReplayTickOutcome | null;
};

export type DelayedLivePollResult =
  | DelayedLivePollWaiting
  | DelayedLivePollTracking;

export type CreateDelayedLiveTailOptions = {
  readonly buffer: ReplaySessionBuffer;
  readonly collision: MapCollision;
  readonly delayMs?: number;
  /**
   * Latest live tick whose recording write should be treated as committed.
   * Defaults to the buffer's max dense input tick. A supplier that runs
   * ahead of the buffer is how incomplete-tick wait is tested.
   */
  readonly liveLatestCommittedTick?: () => number;
  /**
   * Retention floor. If targetTailTick is below this (and the floor is
   * above firstTick), poll fails underrun rather than jumping forward.
   * Production leaves this unset (buffer never evicts).
   */
  readonly fromTick?: number;
  /** Cap-terminal reason; when the window is null this becomes `failed`. */
  readonly terminalReason?: () => ReplayBufferFailReason | null;
};

export type DelayedLiveTail = {
  readonly delayMs: number;
  readonly delayTicks: number;
  readonly session: ReplayRunSession | null;
  readonly runner: ReplayRunner | null;
  poll(): DelayedLivePollResult;
};

export function createDelayedLiveTail(
  opts: CreateDelayedLiveTailOptions,
): DelayedLiveTail {
  const delayMs = opts.delayMs ?? DELAYED_LIVE_DELAY_MS;
  const delayTicks = delayTicksFromMs(delayMs);
  const buffer = opts.buffer;
  const collision = opts.collision;
  const fromTick = opts.fromTick;
  const liveLatest = opts.liveLatestCommittedTick ??
    (() => maxInputTick(buffer) ?? Number.NEGATIVE_INFINITY);
  const terminalReason = opts.terminalReason;

  let session: ReplayRunSession | null = null;
  let runner: ReplayRunner | null = null;
  let closed = false;

  function readLive(): number {
    return liveLatest();
  }

  function ensureOpen(): void {
    const window = buffer.getTailWindow(buffer.startTick ?? 0);
    if (window === null) {
      closed = true;
      const reason = terminalReason?.() ?? null;
      if (reason != null) {
        fail(
          "replay-delayed-live-failed",
          "DelayedLive: recording failed",
          `reason=${reason}`,
        );
      }
      fail(
        "replay-delayed-live-closed",
        "DelayedLive: live tail window closed",
        "window=null",
      );
    }
  }

  function arm(): void {
    if (session != null && runner != null) return;
    session = createDelayedLiveSession(buffer, { lastTickMode: "ceiling" });
    runner = createReplayRunner(session, { collision });
  }

  function poll(): DelayedLivePollResult {
    if (closed) {
      fail(
        "replay-delayed-live-closed",
        "DelayedLive: poll after close",
        "already-closed",
      );
    }
    ensureOpen();

    const live = readLive();
    const target = computeTargetTailTick(live, delayTicks);
    const firstDense = minInputTick(buffer);

    if (firstDense == null) {
      return {
        status: "waiting",
        targetTailTick: target,
        liveLatestCommittedTick: live,
      };
    }

    if (fromTick != null && target < fromTick) {
      fail(
        "replay-delayed-live-underrun",
        "DelayedLive: targetTailTick is below the retained window floor",
        `targetTailTick=${target} fromTick=${fromTick} liveLatestCommittedTick=${live} firstTick=${firstDense}`,
      );
    }

    arm();
    const activeRunner = runner;
    const activeSession = session;
    if (activeRunner == null || activeSession == null) {
      fail(
        "replay-delayed-live-closed",
        "DelayedLive: runner failed to arm",
        "no-runner",
      );
    }

    if (target < firstDense) {
      return {
        status: "waiting",
        targetTailTick: target,
        liveLatestCommittedTick: live,
      };
    }

    let outcome: ReplayTickOutcome | null = null;
    while (activeRunner.currentTick < target) {
      const next = activeRunner.currentTick + 1;
      if (buffer.getInputs(next) === undefined) {
        const max = maxInputTick(buffer);
        if (max != null && max > next) {
          fail(
            "replay-delayed-live-underrun",
            "DelayedLive: contiguity gap; refusing to skip",
            `targetTailTick=${target} missingTick=${next} window=[${activeSession.firstTick}, ${max}]`,
          );
        }
        return {
          status: "waiting",
          targetTailTick: target,
          liveLatestCommittedTick: live,
        };
      }
      outcome = activeRunner.step(next);
    }

    return {
      status: "tracking",
      targetTailTick: target,
      liveLatestCommittedTick: live,
      currentTick: activeRunner.currentTick,
      outcome,
    };
  }

  return {
    delayMs,
    delayTicks,
    get session() {
      return session;
    },
    get runner() {
      return runner;
    },
    poll,
  };
}
