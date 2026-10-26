/**
 * Epic 15.1 — clip definition.
 *
 * A clip is a pointer at a replay plus presentation instructions. It does
 * not copy simulation state, bytes, or video.
 *
 * ```text
 * replayId + inclusive tick range + camera + player + speed + settings
 * ```
 *
 * Contract (notes/replay/replay-detailed.md §15.1, killcam handoff in
 * notes/replay/13-killcams/13-killcams.md):
 * - Ticks are canonical. `startTimeMs` / `endTimeMs` are `tickToTimeMs`.
 *   The inclusive duration is `tickToTimeMs(endTick - startTick + 1)`.
 * - `KillcamWindow.startTick` / `endTick` are stored unchanged. Death tick
 *   is not a clip field.
 * - Camera mode is the 12.1 set. Speed is `REPLAY_SPEEDS`. Neither list
 *   is copied here.
 * - `cameraSettings` is version 1, resolved by 15.6
 *   (`resolveReplayClipCameraSettings`). This module stores the result.
 * - Creation from absolute sim times is 15.2 (`createReplayClip`).
 *   Preview is 15.3 (`startClipPreview`). Persistence is 15.4
 *   (`insertReplayClip` in server-authority). Visibility is 15.5
 *   (`replayClipPermission`). No UI.
 *
 * Scan-locked: no runner, playback, clock advance, camera math, THREE,
 * DOM, wall-clock, fs, blob, store, or net.
 */

import { tickToTimeMs, tickToTimeSec } from "./checkpointIndex.ts";
import type { KillcamWindow } from "./killcam.ts";
import {
  DEFAULT_REPLAY_SPEED,
  isReplaySpeed,
  REPLAY_SPEEDS,
  type ReplaySpeed,
} from "./replayClock.ts";
import {
  type ReplayClipCameraSettings,
  type ReplayClipCameraSettingsInput,
  resolveReplayClipCameraSettings,
} from "./replayClipPresentation.ts";
import {
  DEFAULT_SPECTATOR_CAMERA_MODE,
  SPECTATOR_CAMERA_MODES,
  type SpectatorCameraMode,
} from "./spectatorSelection.ts";

export {
  defaultReplayClipCameraSettings,
  REPLAY_CLIP_CAMERA_SETTINGS_VERSION,
  type ReplayClipCameraSettings,
  type ReplayClipCameraSettingsInput,
  type ReplayClipSettingsParse,
  resolveReplayClipCameraSettings,
} from "./replayClipPresentation.ts";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ReplayClipErrorCode =
  | "replay-clip-bad-id"
  | "replay-clip-bad-player"
  | "replay-clip-bad-tick"
  | "replay-clip-bad-range"
  | "replay-clip-bad-camera"
  | "replay-clip-bad-speed"
  | "replay-clip-bad-settings"
  // 15.2 throws the time/span codes. 15.3 throws the preview code
  // and `replay-clip-outside-span` when the clip misses the session.
  // 15.4 throws `replay-clip-bad-row` for a clip row id.
  // 15.5 throws `replay-clip-bad-visibility` and `replay-clip-bad-audience`.
  // defineReplayClip does not throw these.
  | "replay-clip-bad-time"
  | "replay-clip-bad-span"
  | "replay-clip-outside-span"
  | "replay-clip-preview-needs-raycast"
  | "replay-clip-bad-row"
  | "replay-clip-bad-visibility"
  | "replay-clip-bad-audience";

export class ReplayClipError extends Error {
  readonly code: ReplayClipErrorCode;
  readonly detail: string | null;

  constructor(
    code: ReplayClipErrorCode,
    message: string,
    opts?: { detail?: string | null },
  ) {
    super(message);
    this.name = "ReplayClipError";
    this.code = code;
    this.detail = opts?.detail ?? null;
  }
}

// ---------------------------------------------------------------------------
// Record
// ---------------------------------------------------------------------------

export type ReplayClip = {
  readonly replayId: string;
  /** Inclusive. */
  readonly startTick: number;
  /** Inclusive. */
  readonly endTick: number;
  readonly startTimeMs: number;
  readonly endTimeMs: number;
  readonly startTimeSec: number;
  readonly endTimeSec: number;
  /** Playable span of every tick in `[startTick, endTick]`. */
  readonly durationMs: number;
  readonly durationSec: number;
  readonly cameraMode: SpectatorCameraMode;
  readonly playerId: string;
  readonly playbackSpeed: ReplaySpeed;
  readonly cameraSettings: ReplayClipCameraSettings;
};

export type DefineReplayClipInput = {
  readonly replayId: string;
  readonly startTick: number;
  readonly endTick: number;
  readonly cameraMode: SpectatorCameraMode;
  readonly playerId: string;
  readonly playbackSpeed?: ReplaySpeed;
  readonly cameraSettings?: ReplayClipCameraSettingsInput;
};

/** Validate a clip. Does not look up the replay, the player, or a session. */
export function defineReplayClip(input: DefineReplayClipInput): ReplayClip {
  const replayId = requireId(
    "replay-clip-bad-id",
    "replayId",
    input.replayId,
  );
  const playerId = requireId(
    "replay-clip-bad-player",
    "playerId",
    input.playerId,
  );
  const startTick = requireTick("startTick", input.startTick);
  const endTick = requireTick("endTick", input.endTick);
  if (endTick < startTick) {
    throw new ReplayClipError(
      "replay-clip-bad-range",
      "clip endTick precedes startTick",
      { detail: `${startTick}..${endTick}` },
    );
  }
  const cameraMode = requireCameraMode(input.cameraMode);
  const playbackSpeed = input.playbackSpeed === undefined
    ? DEFAULT_REPLAY_SPEED
    : requireSpeed(input.playbackSpeed);
  const cameraSettings = requireSettings(input.cameraSettings);
  const span = endTick - startTick + 1;
  return {
    replayId,
    startTick,
    endTick,
    startTimeMs: tickToTimeMs(startTick),
    endTimeMs: tickToTimeMs(endTick),
    startTimeSec: tickToTimeSec(startTick),
    endTimeSec: tickToTimeSec(endTick),
    durationMs: tickToTimeMs(span),
    durationSec: tickToTimeSec(span),
    cameraMode,
    playerId,
    playbackSpeed,
    cameraSettings,
  };
}

/**
 * Store a killcam window as a clip range. `startTick` and `endTick` are
 * copied. The death tick is not stored. Camera defaults to first-person
 * and speed to 1×, matching killcam playback.
 */
export function replayClipFromKillcamWindow(input: {
  readonly replayId: string;
  readonly window: KillcamWindow;
  readonly playerId: string;
  readonly cameraMode?: SpectatorCameraMode;
  readonly playbackSpeed?: ReplaySpeed;
  readonly cameraSettings?: ReplayClipCameraSettingsInput;
}): ReplayClip {
  return defineReplayClip({
    replayId: input.replayId,
    startTick: input.window.startTick,
    endTick: input.window.endTick,
    cameraMode: input.cameraMode ?? DEFAULT_SPECTATOR_CAMERA_MODE,
    playerId: input.playerId,
    playbackSpeed: input.playbackSpeed,
    cameraSettings: input.cameraSettings,
  });
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function requireId(
  code: "replay-clip-bad-id" | "replay-clip-bad-player",
  name: string,
  value: unknown,
): string {
  if (
    typeof value !== "string" || value.length === 0 || value.trim() !== value
  ) {
    throw new ReplayClipError(
      code,
      `clip ${name} must be a non-empty string`,
      { detail: String(value) },
    );
  }
  return value;
}

function requireTick(name: string, value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    !Number.isFinite(value) ||
    value < 0
  ) {
    throw new ReplayClipError(
      "replay-clip-bad-tick",
      `clip ${name} must be a non-negative integer tick`,
      { detail: String(value) },
    );
  }
  return value;
}

function requireCameraMode(value: unknown): SpectatorCameraMode {
  if (
    typeof value !== "string" ||
    !SPECTATOR_CAMERA_MODES.includes(value as SpectatorCameraMode)
  ) {
    throw new ReplayClipError(
      "replay-clip-bad-camera",
      `clip cameraMode must be one of ${SPECTATOR_CAMERA_MODES.join(", ")}`,
      { detail: String(value) },
    );
  }
  return value as SpectatorCameraMode;
}

function requireSpeed(value: unknown): ReplaySpeed {
  if (!isReplaySpeed(value)) {
    throw new ReplayClipError(
      "replay-clip-bad-speed",
      `clip playbackSpeed is outside ${REPLAY_SPEEDS.join(", ")}`,
      { detail: String(value) },
    );
  }
  return value;
}

function requireSettings(value: unknown): ReplayClipCameraSettings {
  const parsed = resolveReplayClipCameraSettings(value);
  if (!parsed.ok) {
    throw new ReplayClipError(
      "replay-clip-bad-settings",
      "clip cameraSettings must be version 1 camera and playback settings",
      { detail: parsed.detail },
    );
  }
  return parsed.settings;
}
