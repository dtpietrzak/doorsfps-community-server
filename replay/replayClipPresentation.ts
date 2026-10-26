/**
 * Epic 15.6 — clip presentation.
 *
 * Version 1 of a clip's camera and playback settings. Omitted fields are
 * the 12.x / non-looping defaults. This module does not move the camera
 * or the clock. Preview reads the resolved object.
 *
 * ```text
 * { version: 1, camera?, playback? } → distance, height, shoulder, fov, loop
 * ```
 *
 * Contract (notes/replay/replay-detailed.md §15.6):
 * - `version` stays 1. Unknown keys throw. Nothing is clamped.
 * - Camera boom is the 12.3 distance / height / shoulder. Distance must
 *   be finite and at least `THIRD_PERSON_MIN_DISTANCE`.
 * - `fov` null leaves the 12.x pose unset. A number must sit in the 12.4
 *   free-camera range. The step grid is not required.
 * - `playback.loop` defaults to false. Speed stays on the clip, not here.
 * - UI chrome is 21.x. The dev viewer is not rewired.
 *
 * Scan-locked: no clip builder, playback, camera chase, wall-clock, fs,
 * blob, or store. Boom numbers come from the 12.3 constants.
 */

import {
  FREE_CAMERA_FOV_MAX,
  FREE_CAMERA_FOV_MIN,
  THIRD_PERSON_DISTANCE,
  THIRD_PERSON_HEIGHT,
  THIRD_PERSON_MIN_DISTANCE,
  THIRD_PERSON_SHOULDER,
} from "./spectatorCamera.ts";

export const REPLAY_CLIP_CAMERA_SETTINGS_VERSION = 1 as const;

/** What `defineReplayClip` accepts. Missing pieces become the defaults. */
export type ReplayClipCameraSettingsInput = {
  readonly version: 1;
  readonly camera?: {
    readonly distance?: number;
    readonly height?: number;
    readonly shoulder?: number;
    readonly fov?: number | null;
  };
  readonly playback?: {
    readonly loop?: boolean;
  };
};

/** Resolved settings. Every clip stores this shape. */
export type ReplayClipCameraSettings = {
  readonly version: 1;
  readonly camera: {
    readonly distance: number;
    readonly height: number;
    readonly shoulder: number;
    /** Null leaves the spectator pose's fov unset. */
    readonly fov: number | null;
  };
  readonly playback: {
    /** When true, the next frame after `endTick` plays `startTick` again. */
    readonly loop: boolean;
  };
};

export type ReplayClipSettingsParse =
  | { readonly ok: true; readonly settings: ReplayClipCameraSettings }
  | { readonly ok: false; readonly detail: string };

const TOP_KEYS = new Set(["version", "camera", "playback"]);
const CAMERA_KEYS = new Set(["distance", "height", "shoulder", "fov"]);
const PLAYBACK_KEYS = new Set(["loop"]);

export function defaultReplayClipCameraSettings(): ReplayClipCameraSettings {
  return {
    version: REPLAY_CLIP_CAMERA_SETTINGS_VERSION,
    camera: {
      distance: THIRD_PERSON_DISTANCE,
      height: THIRD_PERSON_HEIGHT,
      shoulder: THIRD_PERSON_SHOULDER,
      fov: null,
    },
    playback: { loop: false },
  };
}

/** Fill defaults. Does not throw; the caller raises `replay-clip-bad-settings`. */
export function resolveReplayClipCameraSettings(
  value: unknown,
): ReplayClipSettingsParse {
  if (value === undefined) {
    return { ok: true, settings: defaultReplayClipCameraSettings() };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, detail: String(value) };
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!TOP_KEYS.has(key)) {
      return { ok: false, detail: JSON.stringify(value) };
    }
  }
  if (record.version !== REPLAY_CLIP_CAMERA_SETTINGS_VERSION) {
    return { ok: false, detail: JSON.stringify(value) };
  }
  const camera = readCamera(record.camera);
  if (!camera.ok) return camera;
  const playback = readPlayback(record.playback);
  if (!playback.ok) return playback;
  return {
    ok: true,
    settings: {
      version: REPLAY_CLIP_CAMERA_SETTINGS_VERSION,
      camera: camera.camera,
      playback: playback.playback,
    },
  };
}

function readCamera(
  value: unknown,
):
  | { ok: true; camera: ReplayClipCameraSettings["camera"] }
  | { ok: false; detail: string } {
  const defaults = defaultReplayClipCameraSettings().camera;
  if (value === undefined) return { ok: true, camera: defaults };
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, detail: JSON.stringify(value) };
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!CAMERA_KEYS.has(key)) {
      return { ok: false, detail: JSON.stringify(value) };
    }
  }
  const distance = readFinite(
    record,
    "distance",
    defaults.distance,
    THIRD_PERSON_MIN_DISTANCE,
  );
  if (typeof distance !== "number") return { ok: false, detail: distance };
  const height = readFinite(record, "height", defaults.height);
  if (typeof height !== "number") return { ok: false, detail: height };
  const shoulder = readFinite(record, "shoulder", defaults.shoulder);
  if (typeof shoulder !== "number") return { ok: false, detail: shoulder };
  const fov = readFov(record);
  if (typeof fov !== "number" && fov !== null) {
    return { ok: false, detail: fov };
  }
  return { ok: true, camera: { distance, height, shoulder, fov } };
}

function readPlayback(
  value: unknown,
):
  | { ok: true; playback: ReplayClipCameraSettings["playback"] }
  | { ok: false; detail: string } {
  if (value === undefined) return { ok: true, playback: { loop: false } };
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, detail: JSON.stringify(value) };
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!PLAYBACK_KEYS.has(key)) {
      return { ok: false, detail: JSON.stringify(value) };
    }
  }
  if (!Object.prototype.hasOwnProperty.call(record, "loop")) {
    return { ok: true, playback: { loop: false } };
  }
  if (typeof record.loop !== "boolean") {
    return { ok: false, detail: JSON.stringify(value) };
  }
  return { ok: true, playback: { loop: record.loop } };
}

/** A missing key keeps `fallback`. A present key must be finite, and at least `min` when set. */
function readFinite(
  record: Record<string, unknown>,
  key: string,
  fallback: number,
  min?: number,
): number | string {
  if (!Object.prototype.hasOwnProperty.call(record, key)) return fallback;
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (min !== undefined && value < min) return JSON.stringify(value);
  return value;
}

function readFov(record: Record<string, unknown>): number | null | string {
  if (!Object.prototype.hasOwnProperty.call(record, "fov")) return null;
  const value = record.fov;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (value < FREE_CAMERA_FOV_MIN || value > FREE_CAMERA_FOV_MAX) {
    return JSON.stringify(value);
  }
  return value;
}
