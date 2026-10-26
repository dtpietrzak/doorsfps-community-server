/**
 * Epic 14.1 — replay timeline (presentation only).
 *
 * Represents the playable span and the current playhead:
 *   start, end, position, duration.
 *
 * Contract (notes/replay/replay-detailed.md §14.1, clock handoff in
 * notes/replay/11-replay-playback/11-03-replay-clock.md):
 * - Tick is canonical. Every time field is derived with `tickToTimeMs` /
 *   `tickToTimeSec` from checkpointIndex.ts. Nothing here stores ms.
 * - Duration matches `ReplayClock.durationMs`:
 *   `tickToTimeMs(lastTick - firstTick + 1)`, the full width of every tick
 *   in the inclusive span. The playhead sits on a tick. `elapsedMs` is
 *   `tickToTimeMs(currentTick - firstTick) + carryMs` (not a subtraction of
 *   the two absolute times). At the inclusive end that is the time of the
 *   distance to the last tick, one tick short of `durationMs`. `progress`
 *   is 1 there because the end tick has been reached.
 * - Sub-tick `carryMs` is presentation (`fraction`, `presentedMs`). It never
 *   becomes a new tick. `timeMsToTick(presentedMs) === position.tick`.
 * - This module does not own the cursor. No advance, pause, speed, reset, or
 *   seek. 14.2 places markers (`replayEventMarkers`). 14.3 seeks. 14.4/14.5
 *   change playback. 21.4 draws the bar.
 * - Pure: no runner, clock, camera, THREE, DOM, wall-clock, fs, blob, store,
 *   or net imports. The caller passes the cursor it already owns.
 */

import { TICK_MS } from "../shared/sim/game.ts";
import { tickToTimeMs, tickToTimeSec } from "./checkpointIndex.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReplayTimelineInput = {
  readonly firstTick: number;
  readonly lastTick: number;
  readonly currentTick: number;
  /**
   * Sub-tick replay milliseconds toward the next tick. Default 0.
   * Must be in `[0, TICK_MS)`. A full tick of carry would move the cursor,
   * which this module does not do.
   */
  readonly carryMs?: number;
  /**
   * Clock ended flag. A multi-tick cursor sitting on `lastTick` is the ended
   * timeline; pass the flag rather than inferring it. Default false.
   */
  readonly isEnded?: boolean;
};

/** A tick and the absolute replay time of that tick. */
export type ReplayTimelinePoint = {
  readonly tick: number;
  readonly timeMs: number;
  readonly timeSec: number;
};

/**
 * Playhead. `timeMs` is the tick instant. `presentedMs` adds carry so a
 * scrubber can move between ticks. `elapsedMs` is that presented time
 * measured from `start`.
 */
export type ReplayTimelinePosition = {
  readonly tick: number;
  readonly timeMs: number;
  readonly timeSec: number;
  /** `carryMs / TICK_MS`, in `[0, 1)`. */
  readonly fraction: number;
  readonly presentedMs: number;
  readonly presentedSec: number;
  /** `tickToTimeMs(tick - start.tick) + carryMs`. */
  readonly elapsedMs: number;
  readonly elapsedSec: number;
};

export type ReplayTimeline = {
  readonly start: ReplayTimelinePoint;
  readonly end: ReplayTimelinePoint;
  readonly position: ReplayTimelinePosition;
  /** Playable span. Same derivation as `ReplayClock.durationMs`. */
  readonly durationMs: number;
  readonly durationSec: number;
  /**
   * 0 at the start tick with no carry, 1 on the inclusive end tick
   * (and whenever `isEnded`). Single-tick: the carry fraction until ended.
   */
  readonly progress: number;
  readonly isEnded: boolean;
};

export type ReplayTimelineErrorCode =
  | "replay-timeline-bad-tick"
  | "replay-timeline-bad-range"
  | "replay-timeline-bad-position"
  | "replay-timeline-bad-carry"
  | "replay-timeline-bad-ended";

export class ReplayTimelineError extends Error {
  readonly code: ReplayTimelineErrorCode;
  readonly detail: string | null;

  constructor(
    code: ReplayTimelineErrorCode,
    message: string,
    opts?: { detail?: string | null; cause?: unknown },
  ) {
    super(
      message,
      opts?.cause !== undefined ? { cause: opts.cause } : undefined,
    );
    this.name = "ReplayTimelineError";
    this.code = code;
    this.detail = opts?.detail ?? null;
  }
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

function assertIntegerTick(name: string, tick: number): void {
  if (!Number.isInteger(tick) || !Number.isFinite(tick)) {
    throw new ReplayTimelineError(
      "replay-timeline-bad-tick",
      `${name} must be an integer tick`,
      { detail: String(tick) },
    );
  }
}

function point(tick: number): ReplayTimelinePoint {
  return {
    tick,
    timeMs: tickToTimeMs(tick),
    timeSec: tickToTimeSec(tick),
  };
}

/**
 * Present start, end, current position, and duration for a cursor someone
 * else owns. Does not read or write a clock.
 */
export function replayTimeline(input: ReplayTimelineInput): ReplayTimeline {
  assertIntegerTick("firstTick", input.firstTick);
  assertIntegerTick("lastTick", input.lastTick);
  assertIntegerTick("currentTick", input.currentTick);

  if (input.lastTick < input.firstTick) {
    throw new ReplayTimelineError(
      "replay-timeline-bad-range",
      "lastTick precedes firstTick",
      { detail: `${input.firstTick}..${input.lastTick}` },
    );
  }

  if (
    input.currentTick < input.firstTick ||
    input.currentTick > input.lastTick
  ) {
    throw new ReplayTimelineError(
      "replay-timeline-bad-position",
      "currentTick is outside [firstTick, lastTick]",
      {
        detail:
          `${input.currentTick} not in ${input.firstTick}..${input.lastTick}`,
      },
    );
  }

  const carryMs = input.carryMs ?? 0;
  if (
    typeof carryMs !== "number" ||
    !Number.isFinite(carryMs) ||
    carryMs < 0 ||
    carryMs >= TICK_MS
  ) {
    throw new ReplayTimelineError(
      "replay-timeline-bad-carry",
      "carryMs must be in [0, TICK_MS)",
      { detail: String(carryMs) },
    );
  }

  const isEnded = input.isEnded ?? false;
  if (typeof isEnded !== "boolean") {
    throw new ReplayTimelineError(
      "replay-timeline-bad-ended",
      "isEnded must be a boolean",
    );
  }
  if (isEnded && (input.currentTick !== input.lastTick || carryMs !== 0)) {
    throw new ReplayTimelineError(
      "replay-timeline-bad-ended",
      "an ended timeline sits on lastTick with no carry",
      { detail: `tick ${input.currentTick} carry ${carryMs}` },
    );
  }
  if (
    !isEnded &&
    input.currentTick === input.lastTick &&
    input.lastTick !== input.firstTick
  ) {
    throw new ReplayTimelineError(
      "replay-timeline-bad-ended",
      "a multi-tick cursor on lastTick is the ended timeline",
      { detail: String(input.currentTick) },
    );
  }

  const start = point(input.firstTick);
  const end = point(input.lastTick);
  const at = point(input.currentTick);
  const presentedMs = at.timeMs + carryMs;
  const elapsedMs = tickToTimeMs(input.currentTick - input.firstTick) + carryMs;
  const spanTicks = input.lastTick - input.firstTick;
  const fraction = carryMs / TICK_MS;
  // Inclusive end is progress 1. While playing, progress counts ticks
  // completed past the start, plus the sub-tick fraction. The span width
  // in the denominator is last-first (the distance to the end tick), not
  // the duration tick count, so the playhead lands on the end tick at 1.
  const progress = isEnded
    ? 1
    : spanTicks === 0
    ? fraction
    : (input.currentTick - input.firstTick + fraction) / spanTicks;

  const spanTickCount = input.lastTick - input.firstTick + 1;

  return {
    start,
    end,
    position: {
      tick: at.tick,
      timeMs: at.timeMs,
      timeSec: at.timeSec,
      fraction,
      presentedMs,
      presentedSec: presentedMs / 1000,
      elapsedMs,
      elapsedSec: elapsedMs / 1000,
    },
    durationMs: tickToTimeMs(spanTickCount),
    durationSec: tickToTimeSec(spanTickCount),
    progress,
    isEnded,
  };
}
