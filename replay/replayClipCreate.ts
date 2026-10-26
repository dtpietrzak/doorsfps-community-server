/**
 * Epic 15.2 — clip creation.
 *
 * Turn a pair of absolute sim times into a 15.1 clip. The caller passes the
 * replay span. This module does not look up the replay, the player, or a
 * session.
 *
 * ```text
 * startTimeMs / endTimeMs + span → inclusive ticks → defineReplayClip
 * ```
 *
 * Contract (notes/replay/replay-detailed.md §15.2):
 * - Times are absolute sim time, the same coordinate as `tickToTimeMs` and
 *   the 14.1 timeline points. `timeMsToTick` floors. The clip stores the
 *   tick instants, not the raw marks.
 * - The playable span is `[firstTick, lastTick]`. The exact duration end
 *   `tickToTimeMs(lastTick + 1)` is the close of `lastTick` and lands there.
 *   Any other resolved tick outside the span throws. Nothing is clamped.
 * - `endTick < startTick` throws `replay-clip-bad-range` from 15.1. Marks
 *   are not swapped.
 * - Killcam ranges stay on `replayClipFromKillcamWindow`. This module does
 *   not read a `KillcamWindow`.
 * - Preview is 15.3 (`startClipPreview`). Persistence is 15.4
 *   (`insertReplayClip`). Visibility is 15.5 (`replayClipPermission`).
 *   Settings interpretation is 15.6. No UI.
 *
 * Scan-locked: no runner, playback, clock, seek clamp, camera math, THREE,
 * DOM, wall-clock, fs, blob, store, or net.
 */

import { tickToTimeMs, timeMsToTick } from "./checkpointIndex.ts";
import {
  defineReplayClip,
  type DefineReplayClipInput,
  type ReplayClip,
  ReplayClipError,
} from "./replayClip.ts";

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** Inclusive replay ticks the marks must land in. Not looked up. */
export type ReplayClipSpan = {
  readonly firstTick: number;
  readonly lastTick: number;
};

export type CreateReplayClipInput = {
  readonly replayId: string;
  readonly playerId: string;
  readonly cameraMode: DefineReplayClipInput["cameraMode"];
  readonly playbackSpeed?: DefineReplayClipInput["playbackSpeed"];
  readonly cameraSettings?: DefineReplayClipInput["cameraSettings"];
  readonly span: ReplayClipSpan;
  /** Absolute sim time. Floored with `timeMsToTick`. */
  readonly startTimeMs: number;
  /** Absolute sim time. Floored with `timeMsToTick`. */
  readonly endTimeMs: number;
};

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

/**
 * Tick for one absolute sim time. Sub-tick remainder is dropped. The exact
 * duration end lands on `lastTick`. Every other outside time throws.
 */
export function resolveReplayClipTime(
  timeMs: number,
  span: ReplayClipSpan,
): number {
  const { firstTick, lastTick } = requireSpan(span);
  if (typeof timeMs !== "number" || !Number.isFinite(timeMs)) {
    throw new ReplayClipError(
      "replay-clip-bad-time",
      "clip time must be a finite number of milliseconds",
      { detail: String(timeMs) },
    );
  }
  const tick = timeMsToTick(timeMs);
  if (tick >= firstTick && tick <= lastTick) return tick;
  const durationEnd = tickToTimeMs(lastTick + 1);
  if (tick === lastTick + 1 && timeMs === durationEnd) return lastTick;
  throw new ReplayClipError(
    "replay-clip-outside-span",
    "clip time is outside the replay span",
    { detail: `${timeMs} -> ${tick} not in ${firstTick}..${lastTick}` },
  );
}

/** Define a clip from start and end times. Forwards 15.1 validation. */
export function createReplayClip(input: CreateReplayClipInput): ReplayClip {
  const startTick = resolveReplayClipTime(input.startTimeMs, input.span);
  const endTick = resolveReplayClipTime(input.endTimeMs, input.span);
  return defineReplayClip({
    replayId: input.replayId,
    playerId: input.playerId,
    cameraMode: input.cameraMode,
    playbackSpeed: input.playbackSpeed,
    cameraSettings: input.cameraSettings,
    startTick,
    endTick,
  });
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function requireSpan(
  span: ReplayClipSpan,
): { firstTick: number; lastTick: number } {
  if (span === null || typeof span !== "object") {
    throw new ReplayClipError(
      "replay-clip-bad-span",
      "clip span must be { firstTick, lastTick }",
      { detail: String(span) },
    );
  }
  const firstTick = requireSpanTick("firstTick", span.firstTick);
  const lastTick = requireSpanTick("lastTick", span.lastTick);
  if (lastTick < firstTick) {
    throw new ReplayClipError(
      "replay-clip-bad-span",
      "clip span lastTick precedes firstTick",
      { detail: `${firstTick}..${lastTick}` },
    );
  }
  return { firstTick, lastTick };
}

function requireSpanTick(name: string, value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    !Number.isFinite(value) ||
    value < 0
  ) {
    throw new ReplayClipError(
      "replay-clip-bad-span",
      `clip span ${name} must be a non-negative integer tick`,
      { detail: String(value) },
    );
  }
  return value;
}
