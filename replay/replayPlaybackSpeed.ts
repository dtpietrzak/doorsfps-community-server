/**
 * Epic 14.4 — variable playback speed.
 *
 * The closed set lives on the clock (`REPLAY_SPEEDS`). This module presents
 * that ladder and steps it. It does not copy the numbers, advance time, or
 * seek.
 *
 * Contract (notes/replay/replay-detailed.md §14.4, mechanism in
 * notes/replay/11-replay-playback/11-03-replay-clock.md):
 * - Rungs are `REPLAY_SPEEDS` in order. The default is `DEFAULT_REPLAY_SPEED`.
 *   A label is `${speed}×` from that number.
 * - `stepReplaySpeed` moves one rung and wraps at the ends (4× → 0.25×
 *   and the reverse), matching the dev-viewer keys.
 * - Pause is a separate flag. Arming a speed never resumes.
 * - A scrub drag forces pause and remembers the pre-drag pause flag. Speed
 *   stays, including a speed change made while the drag is held. Releasing
 *   restores the remembered pause flag. A second begin does not overwrite it.
 * - This module does not seek. 14.5 continues a seek from the cursor.
 *   21.4 draws the control.
 *
 * Scan-locked: speed symbols from `replayClock.ts` only. No clock advance,
 * runner, camera, THREE, DOM, wall-clock, fs, blob, store, or net.
 */

import {
  DEFAULT_REPLAY_SPEED,
  isReplaySpeed,
  REPLAY_SPEEDS,
  type ReplaySpeed,
} from "./replayClock.ts";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ReplayPlaybackSpeedErrorCode =
  | "replay-speed-invalid"
  | "replay-speed-bad-step"
  | "replay-speed-bad-scrub";

export class ReplayPlaybackSpeedError extends Error {
  readonly code: ReplayPlaybackSpeedErrorCode;
  readonly detail: string | null;

  constructor(
    code: ReplayPlaybackSpeedErrorCode,
    message: string,
    opts?: { detail?: string | null },
  ) {
    super(message);
    this.name = "ReplayPlaybackSpeedError";
    this.code = code;
    this.detail = opts?.detail ?? null;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** +1 is faster, −1 is slower. */
export type ReplaySpeedStep = 1 | -1;

export type ReplaySpeedRung = {
  readonly speed: ReplaySpeed;
  readonly index: number;
  readonly label: string;
};

/** Read-only view of the armed speed. Reading it changes nothing. */
export type ReplayPlaybackSpeed = {
  readonly speed: ReplaySpeed;
  readonly index: number;
  readonly label: string;
  readonly paused: boolean;
  readonly scrubbing: boolean;
  readonly ladder: readonly ReplaySpeedRung[];
};

/**
 * Pause/speed memory for a timeline drag. `pausedBeforeScrub` is set only
 * while `scrubbing` is true.
 */
export type ReplaySpeedScrub = {
  readonly speed: ReplaySpeed;
  readonly paused: boolean;
  readonly scrubbing: boolean;
  readonly pausedBeforeScrub: boolean | null;
};

// ---------------------------------------------------------------------------
// Ladder
// ---------------------------------------------------------------------------

export function replaySpeedLabel(speed: ReplaySpeed): string {
  return `${speed}×`;
}

/** One rung per `REPLAY_SPEEDS` entry, same order, same numbers. */
export function replaySpeedLadder(): readonly ReplaySpeedRung[] {
  return REPLAY_SPEEDS.map((speed, index) => ({
    speed,
    index,
    label: replaySpeedLabel(speed),
  }));
}

export function presentReplaySpeed(input: {
  readonly speed: unknown;
  readonly paused: boolean;
  readonly scrubbing?: boolean;
}): ReplayPlaybackSpeed {
  const speed = requireReplaySpeed(input.speed);
  return {
    speed,
    index: replaySpeedIndex(speed),
    label: replaySpeedLabel(speed),
    paused: input.paused,
    scrubbing: input.scrubbing === true,
    ladder: replaySpeedLadder(),
  };
}

/**
 * One rung toward `direction`. The ends wrap: faster than the last rung
 * returns the first, and slower than the first returns the last.
 */
export function stepReplaySpeed(
  current: unknown,
  direction: unknown,
): ReplaySpeed {
  const speed = requireReplaySpeed(current);
  if (direction !== 1 && direction !== -1) {
    throw new ReplayPlaybackSpeedError(
      "replay-speed-bad-step",
      `Replay speed: step must be 1 or -1, got ${String(direction)}`,
      { detail: String(direction) },
    );
  }
  const index = replaySpeedIndex(speed);
  const length = REPLAY_SPEEDS.length;
  const next = (index + direction + length) % length;
  return REPLAY_SPEEDS[next] ?? DEFAULT_REPLAY_SPEED;
}

/** Validate and store a speed. Pause and scrub flags stay. */
export function armReplaySpeed(
  state: ReplaySpeedScrub,
  speed: unknown,
): ReplaySpeedScrub {
  return {
    speed: requireReplaySpeed(speed),
    paused: state.paused,
    scrubbing: state.scrubbing,
    pausedBeforeScrub: state.pausedBeforeScrub,
  };
}

/**
 * Hold the drag. The clock should pause. Speed is unchanged. A second call
 * keeps the original pause flag.
 */
export function beginReplaySpeedScrub(
  state: ReplaySpeedScrub,
): ReplaySpeedScrub {
  const speed = requireReplaySpeed(state.speed);
  if (state.scrubbing) {
    if (typeof state.pausedBeforeScrub !== "boolean") {
      throw new ReplayPlaybackSpeedError(
        "replay-speed-bad-scrub",
        "Replay speed: scrub is missing the pause flag to restore",
      );
    }
    return {
      speed,
      paused: true,
      scrubbing: true,
      pausedBeforeScrub: state.pausedBeforeScrub,
    };
  }
  return {
    speed,
    paused: true,
    scrubbing: true,
    pausedBeforeScrub: state.paused,
  };
}

/** Release the drag. Speed stays. Pause returns to the remembered flag. */
export function endReplaySpeedScrub(state: ReplaySpeedScrub): ReplaySpeedScrub {
  const speed = requireReplaySpeed(state.speed);
  if (!state.scrubbing) {
    return {
      speed,
      paused: state.paused,
      scrubbing: false,
      pausedBeforeScrub: null,
    };
  }
  if (typeof state.pausedBeforeScrub !== "boolean") {
    throw new ReplayPlaybackSpeedError(
      "replay-speed-bad-scrub",
      "Replay speed: scrub is missing the pause flag to restore",
    );
  }
  return {
    speed,
    paused: state.pausedBeforeScrub,
    scrubbing: false,
    pausedBeforeScrub: null,
  };
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function requireReplaySpeed(value: unknown): ReplaySpeed {
  if (!isReplaySpeed(value)) {
    throw new ReplayPlaybackSpeedError(
      "replay-speed-invalid",
      `Replay speed: ${String(value)} is outside ${REPLAY_SPEEDS.join(", ")}`,
      { detail: String(value) },
    );
  }
  return value;
}

function replaySpeedIndex(speed: ReplaySpeed): number {
  const index = REPLAY_SPEEDS.indexOf(speed);
  if (index < 0) {
    throw new ReplayPlaybackSpeedError(
      "replay-speed-invalid",
      `Replay speed: ${String(speed)} is outside ${REPLAY_SPEEDS.join(", ")}`,
      { detail: String(speed) },
    );
  }
  return index;
}
