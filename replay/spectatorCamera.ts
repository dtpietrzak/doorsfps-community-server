/**
 * Spectator cameras — 12.2 first-person + 12.3 third-person + 12.4 free-fly
 * (inputs → CameraPose).
 *
 * Shared CameraPose is defined once here. No function reads THREE, DOM,
 * keyboard, wall-clock, ReplayPlayback, MapCollision, the runner, or the clock.
 * Client `applySpectatorPose` writes xyz/yaw/pitch and currently voids `fov`.
 * Applying 12.4 fov is later driver work — not this module.
 *
 * 12.2 first-person:
 *   ReplayRenderFeedState (xyz + viewOffset + Q4A yaw/pitch/alive)
 *     → firstPersonCamera({ kind: "feed", feed })
 *     → CameraPose (eyes via live renderCameraFromSimLayers formula)
 *
 * 12.3 third-person:
 *   Q1A `{ pose, snapped }` + caller-supplied 11.5 `viewOffset` as `eye`
 *     → thirdPersonCamera({ kind: "pose", pose, snapped, eye }, { raycast })
 *     → CameraPose (Decision 8 boom behind player yaw + presentation clamp)
 *   Eye-delta plumbing (Open Question 1, pinned A): 12.3 never recomputes crouch
 *   height / moveEyeHeight / crouchEyeViewOffset. The Q1A feeder returns only
 *   `{ pose, snapped }`; the caller passes `feeders.render().viewOffset` as `eye`.
 *
 * Caller mapping for feeder misses (not a `frame()` change): after a valid 12.1
 * focus, `replay-state-focus-unknown` from `frame()` or `focusedDisplay()` means
 * absent. `projectCurrent` assigns lastSnapshot / lastFeed only after both
 * projectors succeed, so feeders still hold the last successful feed. Pass
 * `{ kind: "absent", lastPose }` built from the last chase CameraPose.
 * Unknown-at-selection never reaches this mapping. End-hold is a successful
 * exact-newest pose — chase it as present/eliminated, not absent.
 *
 * 12.4 free-fly (mirrored cinematic math; no client import):
 *   spawnFreeCamera(source) → initial free CameraPose (presence always "present")
 *   freeCamera(pose, held, yaw, pitch, dtSeconds) → stepped CameraPose
 *   stepFreeCameraFov(currentFov, direction) → fov
 *   Displacement equals client cinematic helpers (yaw-follow horizontal,
 *   world-up vertical; look-down-minus-Z at yaw 0; WASD/QE/Space/Shift/Alt;
 *   speed 4.5, fast ×3, precision ×0.5). FOV step 5, clamp 30–110, round-to-step.
 *   Pitch clamp ±(π/2 − 0.01) matches ReplayDevFpsPlayer pointer-lock look.
 *   Caller enter: spawn at current 12.2 FP eyes when the feed is present, else
 *   last applied pose. Caller exit: 12.2/12.3 from the untouched 12.1 focus.
 *   This module never writes the focus slot and never reads cameraMode.
 *
 * Contract:
 * - Pose purity: inputs → CameraPose only. No apply here.
 * - FP eyes equal live renderCameraFromSimLayers + renderFromSim. Crouch delta
 *   stays 11.5's viewOffset.
 * - 3P boom: desired tip = (pose xyz + eye) − forward(yaw)·DISTANCE +
 *   up·HEIGHT + right(yaw)·SHOULDER, with forward = (-sin(yaw), 0, -cos(yaw))
 *   and right = (cos(yaw), 0, -sin(yaw)). Camera yaw/pitch = player view
 *   yaw/pitch. Shoulder is player-local, never world X, never side-flip.
 * - Clamp is an injected read-only raycast (production: bound MapCollision
 *   .raycastSolid). Origin = eyes; dir → tip; shorten to hit − epsilon, floor
 *   at MIN_DISTANCE; no hit → full boom. Never writes sim collision.
 * - `snapped: true` is a hard cut: the function is stateless, so the caller
 *   feeding the new display pose is the cut — never lerp across it.
 * - Dead-but-present: current pose/feed + presence "eliminated". No hold-last
 *   on death; no auto-switch.
 * - Valid-then-absent: last xyz/yaw/pitch + presence "absent". No last pose →
 *   `replay-spectator-camera-absent-without-pose`. Never zero-pose. Never
 *   migrate 12.1 focus.
 * - Focus switch and FP↔3P are immediate (no blend between poses / modes).
 *   This module does not read SpectatorState.cameraMode or call setters.
 * - `CameraPose.fov` is written by 12.4 (carried through move steps; omitted
 *   until stepped). 12.2/12.3 leave it unset.
 * - Free presence is always "present". Focus death/leave never moves the
 *   free pose. No collision clamp, no raycast, no snapped handling.
 * - Non-finite free pose/yaw/pitch/dt/fov → `replay-spectator-camera-free-invalid`.
 *   Empty held / dt <= 0 → zero displacement, still a valid pose.
 *
 * Handoffs: 12.6 reads presence for HUD copy independently of free flight;
 * 13.x killer chase = 12.1 focus + 12.2/12.3; 14.x re-renders the selected
 * pose (including free) at seek targets; 18.x asserts CameraPose exactness;
 * item 8 / 21.5 apply CameraPose → camera and must not invent hold-last,
 * auto-switch, cross-cut smoothing, or inter-focus blends.
 */

import type { ReplayRenderFeedState } from "./replayStateAccess.ts";

// ---------------------------------------------------------------------------
// Pose
// ---------------------------------------------------------------------------

export type CameraPresence = "present" | "eliminated" | "absent";

/**
 * Pure camera output shared by 12.2 / 12.3 / 12.4. No THREE.
 * `fov` is written by 12.4; 12.2 / 12.3 leave it unset.
 */
export type CameraPose = {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly pitch: number;
  readonly presence: CameraPresence;
  readonly fov?: number;
};

export type FirstPersonCameraInput =
  | { readonly kind: "feed"; readonly feed: ReplayRenderFeedState }
  | { readonly kind: "absent"; readonly lastPose: CameraPose };

/** Display-pose fields 12.3 consumes from the Q1A `{ pose, snapped }` result. */
export type ThirdPersonDisplayPose = {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly pitch: number;
  readonly alive: boolean;
};

export type ThirdPersonEyeDelta = {
  readonly x: number;
  readonly y: number;
  readonly z: number;
};

export type ThirdPersonCameraInput =
  | {
    readonly kind: "pose";
    readonly pose: ThirdPersonDisplayPose;
    readonly snapped: boolean;
    readonly eye: ThirdPersonEyeDelta;
  }
  | { readonly kind: "absent"; readonly lastPose: CameraPose };

/** Injected read-only boom query. Production binds MapCollision.raycastSolid. */
export type SpectatorRaycast = (
  origin: { readonly x: number; readonly y: number; readonly z: number },
  dir: { readonly x: number; readonly y: number; readonly z: number },
  maxRange: number,
) => number | null;

export type ThirdPersonCameraOpts = {
  readonly raycast: SpectatorRaycast;
  /** Omitted fields use the 12.3 boom constants. Clip settings pass these. */
  readonly distance?: number;
  readonly height?: number;
  readonly shoulder?: number;
};

/** Decision 8 boom — values are non-load-bearing tuning. */
export const THIRD_PERSON_DISTANCE = 3.5;
export const THIRD_PERSON_HEIGHT = 0.35;
export const THIRD_PERSON_SHOULDER = 0.45;
export const THIRD_PERSON_MIN_DISTANCE = 0.4;
export const THIRD_PERSON_CLAMP_EPSILON = 0.08;

/** Mirrored cinematic fly tuning (client cinematic helpers; one fly feel). */
export const FREE_CAMERA_MOVE_SPEED = 4.5;
export const FREE_CAMERA_FAST_MULTIPLIER = 3;
export const FREE_CAMERA_PRECISION_MULTIPLIER = 0.5;
export const FREE_CAMERA_FOV_MIN = 30;
export const FREE_CAMERA_FOV_MAX = 110;
export const FREE_CAMERA_FOV_STEP = 5;
/** Pointer-lock look bound used by ReplayDevFpsPlayer free-fly. */
export const FREE_CAMERA_PITCH_LIMIT = Math.PI / 2 - 0.01;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type SpectatorCameraErrorCode =
  | "replay-spectator-camera-orientation-missing"
  | "replay-spectator-camera-absent-without-pose"
  | "replay-spectator-camera-display-missing"
  | "replay-spectator-camera-raycast-missing"
  | "replay-spectator-camera-free-invalid";

export class SpectatorCameraError extends Error {
  readonly code: SpectatorCameraErrorCode;
  readonly detail: string | null;

  constructor(
    code: SpectatorCameraErrorCode,
    message: string,
    opts?: { detail?: string | null },
  ) {
    super(message);
    this.name = "SpectatorCameraError";
    this.code = code;
    this.detail = opts?.detail ?? null;
  }
}

function fail(
  code: SpectatorCameraErrorCode,
  message: string,
  detail?: string | null,
): never {
  throw new SpectatorCameraError(code, message, { detail: detail ?? null });
}

// ---------------------------------------------------------------------------
// Eye formula (published live renderCameraFromSimLayers + renderFromSim)
// ---------------------------------------------------------------------------

/**
 * Live `renderCameraFromSimLayers` (client/src/game/renderSync.ts) lerp of
 * prev→sim by accum/simDt, then `renderFromSim` xyz add of viewOffset.
 * 11.5 production feeds set prev==local and accum=0 so a=0 and body=localSim;
 * eyes = body + viewOffset. Do not recompute crouch eye height here.
 */
export function replayEyesFromSimLayers(
  prev: { readonly x: number; readonly y: number; readonly z: number },
  sim: { readonly x: number; readonly y: number; readonly z: number },
  accum: number,
  simDt: number,
  offset: { readonly x: number; readonly y: number; readonly z: number },
): { x: number; y: number; z: number } {
  const dt = simDt > 0 ? simDt : 1;
  const a = Math.min(1, Math.max(0, accum / dt));
  const body = {
    x: prev.x + (sim.x - prev.x) * a,
    y: prev.y + (sim.y - prev.y) * a,
    z: prev.z + (sim.z - prev.z) * a,
  };
  return {
    x: body.x + (Number.isFinite(offset.x) ? offset.x : 0),
    y: body.y + (Number.isFinite(offset.y) ? offset.y : 0),
    z: body.z + (Number.isFinite(offset.z) ? offset.z : 0),
  };
}

// ---------------------------------------------------------------------------
// firstPersonCamera
// ---------------------------------------------------------------------------

function isFinitePose(pose: CameraPose | null | undefined): pose is CameraPose {
  return (
    pose != null &&
    Number.isFinite(pose.x) &&
    Number.isFinite(pose.y) &&
    Number.isFinite(pose.z) &&
    Number.isFinite(pose.yaw) &&
    Number.isFinite(pose.pitch)
  );
}

/**
 * Focused-feed (or explicit absent) → first-person CameraPose.
 * Frozen in conceptually (numbers copied); new frozen pose out.
 */
export function firstPersonCamera(input: FirstPersonCameraInput): CameraPose {
  if (input.kind === "absent") {
    return holdLastPose(input.lastPose);
  }

  const feed = input.feed;
  if (
    feed == null ||
    typeof feed !== "object" ||
    !Number.isFinite(feed.yaw) ||
    !Number.isFinite(feed.pitch)
  ) {
    fail(
      "replay-spectator-camera-orientation-missing",
      "SpectatorCamera: feed yaw/pitch missing (Q4A orientation rides on the 11.5 feed)",
    );
  }

  const eyes = replayEyesFromSimLayers(
    feed.prevSim,
    feed.localSim,
    feed.localSimAccum,
    feed.localSimDt,
    feed.viewOffset,
  );

  return Object.freeze({
    x: eyes.x,
    y: eyes.y,
    z: eyes.z,
    yaw: feed.yaw,
    pitch: feed.pitch,
    presence: feed.alive === false ? "eliminated" : "present",
  });
}

function holdLastPose(lastPose: CameraPose): CameraPose {
  if (!isFinitePose(lastPose)) {
    fail(
      "replay-spectator-camera-absent-without-pose",
      "SpectatorCamera: absent input requires a last CameraPose",
    );
  }
  return Object.freeze({
    x: lastPose.x,
    y: lastPose.y,
    z: lastPose.z,
    yaw: lastPose.yaw,
    pitch: lastPose.pitch,
    presence: "absent",
  });
}

function isFiniteEye(
  eye: ThirdPersonEyeDelta | null | undefined,
): eye is ThirdPersonEyeDelta {
  return (
    eye != null &&
    Number.isFinite(eye.x) &&
    Number.isFinite(eye.y) &&
    Number.isFinite(eye.z)
  );
}

function isFiniteDisplay(
  pose: ThirdPersonDisplayPose | null | undefined,
): pose is ThirdPersonDisplayPose {
  return (
    pose != null &&
    Number.isFinite(pose.x) &&
    Number.isFinite(pose.y) &&
    Number.isFinite(pose.z) &&
    Number.isFinite(pose.yaw) &&
    Number.isFinite(pose.pitch)
  );
}

/**
 * Chase CameraPose behind the focused display pose (Q1A / 11.4).
 * `snapped` is accepted for the cut contract but is unused: the function is
 * stateless, so a new pose is a hard cut. `eye` is the 11.5 viewOffset.
 */
export function thirdPersonCamera(
  input: ThirdPersonCameraInput,
  opts: ThirdPersonCameraOpts,
): CameraPose {
  if (input.kind === "absent") {
    return holdLastPose(input.lastPose);
  }

  if (typeof opts?.raycast !== "function") {
    fail(
      "replay-spectator-camera-raycast-missing",
      "SpectatorCamera: thirdPersonCamera requires an injected raycast",
    );
  }

  const pose = input.pose;
  const eye = input.eye;
  if (!isFiniteDisplay(pose) || !isFiniteEye(eye)) {
    fail(
      "replay-spectator-camera-display-missing",
      "SpectatorCamera: display pose + eye delta required (Q1A + 11.5 viewOffset)",
    );
  }

  const eyeX = pose.x + eye.x;
  const eyeY = pose.y + eye.y;
  const eyeZ = pose.z + eye.z;
  const yaw = pose.yaw;
  const forwardX = -Math.sin(yaw);
  const forwardZ = -Math.cos(yaw);
  const rightX = Math.cos(yaw);
  const rightZ = -Math.sin(yaw);

  const distance = opts.distance ?? THIRD_PERSON_DISTANCE;
  const height = opts.height ?? THIRD_PERSON_HEIGHT;
  const shoulder = opts.shoulder ?? THIRD_PERSON_SHOULDER;
  const tipX = eyeX - forwardX * distance + rightX * shoulder;
  const tipY = eyeY + height;
  const tipZ = eyeZ - forwardZ * distance + rightZ * shoulder;

  const dx = tipX - eyeX;
  const dy = tipY - eyeY;
  const dz = tipZ - eyeZ;
  const boomLen = Math.hypot(dx, dy, dz);
  if (!(boomLen > 1e-12)) {
    return Object.freeze({
      x: eyeX,
      y: eyeY,
      z: eyeZ,
      yaw: pose.yaw,
      pitch: pose.pitch,
      presence: pose.alive === false ? "eliminated" : "present",
    });
  }

  const dirX = dx / boomLen;
  const dirY = dy / boomLen;
  const dirZ = dz / boomLen;
  const hit = opts.raycast(
    { x: eyeX, y: eyeY, z: eyeZ },
    { x: dirX, y: dirY, z: dirZ },
    boomLen,
  );
  const raw =
    hit != null && Number.isFinite(hit) && hit < boomLen
      ? hit - THIRD_PERSON_CLAMP_EPSILON
      : boomLen;
  const length = Math.max(raw, THIRD_PERSON_MIN_DISTANCE);

  return Object.freeze({
    x: eyeX + dirX * length,
    y: eyeY + dirY * length,
    z: eyeZ + dirZ * length,
    yaw: pose.yaw,
    pitch: pose.pitch,
    presence: pose.alive === false ? "eliminated" : "present",
  });
}

function isHeldSet(held: ReadonlySet<string>): held is ReadonlySet<string> {
  return held != null && typeof (held as { has?: unknown }).has === "function";
}

function freezeFreePose(
  x: number,
  y: number,
  z: number,
  yaw: number,
  pitch: number,
  fov: number | undefined,
): CameraPose {
  if (fov === undefined) {
    return Object.freeze({ x, y, z, yaw, pitch, presence: "present" as const });
  }
  return Object.freeze({
    x,
    y,
    z,
    yaw,
    pitch,
    presence: "present" as const,
    fov,
  });
}

function carriedFov(pose: CameraPose): number | undefined {
  if (pose.fov === undefined) return undefined;
  if (!Number.isFinite(pose.fov)) {
    fail(
      "replay-spectator-camera-free-invalid",
      "SpectatorCamera: free camera fov must be finite when set",
    );
  }
  return pose.fov;
}

function freeFlyDelta(
  held: ReadonlySet<string>,
  yaw: number,
  dtSeconds: number,
): { x: number; y: number; z: number } {
  const forward = (held.has("KeyW") ? 1 : 0) -
    (held.has("KeyS") ? 1 : 0);
  const right = (held.has("KeyD") ? 1 : 0) -
    (held.has("KeyA") ? 1 : 0);
  const up = (held.has("KeyE") || held.has("Space") ? 1 : 0) -
    (held.has("KeyQ") ? 1 : 0);
  const length = Math.hypot(forward, right, up);
  if (length <= 0 || !(dtSeconds > 0)) return { x: 0, y: 0, z: 0 };

  const fast = held.has("ShiftLeft") || held.has("ShiftRight");
  const precision = held.has("AltLeft") || held.has("AltRight");
  const speed = FREE_CAMERA_MOVE_SPEED *
    (fast ? FREE_CAMERA_FAST_MULTIPLIER : 1) *
    (precision ? FREE_CAMERA_PRECISION_MULTIPLIER : 1);
  const distance = speed * dtSeconds / length;

  const forwardX = -Math.sin(yaw);
  const forwardZ = -Math.cos(yaw);
  const rightX = Math.cos(yaw);
  const rightZ = -Math.sin(yaw);

  return {
    x: (forwardX * forward + rightX * right) * distance,
    y: up * distance,
    z: (forwardZ * forward + rightZ * right) * distance,
  };
}

/**
 * Copy a follow pose into a detached free pose. Presence is always "present".
 * Finite `fov` is carried; omitted otherwise. Non-finite source → loud.
 * Caller pattern: spawn at current 12.2 FP eyes when the feed is present.
 */
export function spawnFreeCamera(source: CameraPose): CameraPose {
  if (!isFinitePose(source)) {
    fail(
      "replay-spectator-camera-free-invalid",
      "SpectatorCamera: spawnFreeCamera requires a finite CameraPose",
    );
  }
  return freezeFreePose(
    source.x,
    source.y,
    source.z,
    source.yaw,
    source.pitch,
    carriedFov(source),
  );
}

/**
 * Step FOV by ±FREE_CAMERA_FOV_STEP after rounding onto the step grid,
 * clamped to [FREE_CAMERA_FOV_MIN, FREE_CAMERA_FOV_MAX].
 */
export function stepFreeCameraFov(
  currentFov: number,
  direction: -1 | 1,
): number {
  if (!Number.isFinite(currentFov) || (direction !== -1 && direction !== 1)) {
    fail(
      "replay-spectator-camera-free-invalid",
      "SpectatorCamera: stepFreeCameraFov requires a finite fov and direction ±1",
    );
  }
  const stepped = Math.round(currentFov / FREE_CAMERA_FOV_STEP) *
      FREE_CAMERA_FOV_STEP + direction * FREE_CAMERA_FOV_STEP;
  return Math.max(
    FREE_CAMERA_FOV_MIN,
    Math.min(FREE_CAMERA_FOV_MAX, stepped),
  );
}

/**
 * Integrate one free-fly frame. Held codes and dtSeconds are caller inputs.
 * Displacement matches the admin cinematic fly formula; output yaw is the
 * input yaw; pitch is clamped to ±FREE_CAMERA_PITCH_LIMIT; presence is
 * always "present"; fov is carried.
 */
export function freeCamera(
  pose: CameraPose,
  held: ReadonlySet<string>,
  yaw: number,
  pitch: number,
  dtSeconds: number,
): CameraPose {
  if (!isFinitePose(pose) || !isHeldSet(held) ||
    !Number.isFinite(yaw) || !Number.isFinite(pitch) ||
    !Number.isFinite(dtSeconds)
  ) {
    fail(
      "replay-spectator-camera-free-invalid",
      "SpectatorCamera: freeCamera requires a finite pose, held set, yaw, pitch, and dtSeconds",
    );
  }
  const fov = carriedFov(pose);
  const clampedPitch = Math.max(
    -FREE_CAMERA_PITCH_LIMIT,
    Math.min(FREE_CAMERA_PITCH_LIMIT, pitch),
  );
  const delta = freeFlyDelta(held, yaw, dtSeconds);
  return freezeFreePose(
    pose.x + delta.x,
    pose.y + delta.y,
    pose.z + delta.z,
    yaw,
    clampedPitch,
    fov,
  );
}
