/**
 * Epic 15.3 — clip preview.
 *
 * Play a 15.1 clip through `ReplayPlayback`, the same session the replay
 * viewer already drives. The caller passes the loaded session. This module
 * does not look up `replayId`.
 *
 * ```text
 * start → speed + focus → seek to the tick before the clip
 *       → frame() plays [startTick, endTick]
 *       → stop, or reopen when playback.loop is set
 * ```
 *
 * Contract (notes/replay/replay-detailed.md §15.3):
 * - The next `frame` plays `startTick`. A clip that begins at `firstTick`
 *   stays on the virgin `start()`. Otherwise `seek(startTick - 1)`.
 * - Playback stops when `endTick` has been played, unless
 *   `cameraSettings.playback.loop` is set. A loop reopens so the next
 *   `frame` plays `startTick` again. `stop()` ends without seeking.
 * - Focus is the clip player. Speed is `clip.playbackSpeed`. Camera mode
 *   is the 12.x camera for that mode. Free view spawns once from the
 *   player's eyes and holds. Boom and fov come from `cameraSettings`.
 * - A clip outside `[firstTick, lastTick]` throws. Nothing is clamped.
 * - Third-person requires an injected raycast.
 * - Persistence is 15.4 (`insertReplayClip`). Visibility is 15.5
 *   (`replayClipPermission`). Settings are 15.6
 *   (`resolveReplayClipCameraSettings`). No viewer chrome (21.x).
 *
 * Scan-locked: no second clock, no killcam policy, no wall-clock, no
 * lookup, no fs, blob, store, or net.
 */

import { TICK_MS } from "../shared/sim/game.ts";
import { MapCollision } from "../world/MapCollision.ts";
import { type ReplayClip, ReplayClipError } from "./replayClip.ts";
import type { ReplayClipCameraSettings } from "./replayClipPresentation.ts";
import { MAX_STEPS_PER_ADVANCE } from "./replayClock.ts";
import {
  createReplayPlayback,
  type ReplayPlayback,
  type ReplayPlaybackFrameResult,
  type ReplayPlaybackInput,
} from "./replayPlaybackSession.ts";
import { ReplayStateAccessError } from "./replayStateAccess.ts";
import {
  type CameraPose,
  firstPersonCamera,
  spawnFreeCamera,
  type SpectatorRaycast,
  thirdPersonCamera,
} from "./spectatorCamera.ts";
import type { SpectatorCameraMode } from "./spectatorSelection.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ClipPreviewExitReason = "clip-end" | "session-end" | "stop";

export type StartClipPreviewOptions = {
  /** Injected collision for the recorded map. Never loaded here. */
  readonly collision: MapCollision;
  /** Required when `clip.cameraMode` is third-person. */
  readonly raycast?: SpectatorRaycast;
};

export type ClipPreviewState = {
  readonly phase: "playing" | "ended";
  readonly exitReason: ClipPreviewExitReason | null;
  readonly currentTick: number;
  readonly focusedPlayerId: string | null;
  readonly speed: number;
  readonly isPaused: boolean;
  readonly carryMs: number;
  /** Ticks of `[startTick, endTick]` not yet played. */
  readonly ticksRemaining: number;
};

export type ClipPreviewFrame = {
  readonly playback: ReplayPlaybackFrameResult | null;
  readonly pose: CameraPose | null;
  readonly ended: boolean;
  readonly exitReason: ClipPreviewExitReason | null;
  readonly currentTick: number;
  readonly focusedPlayerId: string | null;
};

export type ClipPreview = {
  readonly clip: ReplayClip;
  readonly playback: ReplayPlayback;
  readonly cameraMode: SpectatorCameraMode;
  /** Pose at the open, then the latest frame. Free view does not follow. */
  readonly pose: CameraPose | null;
  state(): ClipPreviewState;
  frame(dtWallMs: number): ClipPreviewFrame;
  /** End the preview. Does not seek and does not change focus. */
  stop(): ClipPreviewFrame;
};

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/**
 * Open a clip on a replay session the caller already has. `replayId` is
 * not resolved. The returned pose is the open frame, before `frame`.
 */
export function startClipPreview(
  input: ReplayPlaybackInput,
  clip: ReplayClip,
  options: StartClipPreviewOptions,
): ClipPreview {
  const playback = createReplayPlayback(input, {
    collision: options.collision,
  });
  const session = playback.session;
  if (
    clip.startTick < session.firstTick ||
    clip.endTick > session.lastTick ||
    clip.endTick < clip.startTick
  ) {
    throw new ReplayClipError(
      "replay-clip-outside-span",
      "clip range is outside the replay being previewed",
      {
        detail:
          `${clip.startTick}..${clip.endTick} not in ${session.firstTick}..${session.lastTick}`,
      },
    );
  }
  if (
    clip.cameraMode === "third-person" && typeof options.raycast !== "function"
  ) {
    throw new ReplayClipError(
      "replay-clip-preview-needs-raycast",
      "third-person clip preview requires an injected raycast",
    );
  }

  playback.start();
  playback.setSpeed(clip.playbackSpeed);
  playback.setFocusedPlayerId(clip.playerId);
  if (clip.startTick > session.firstTick) {
    playback.seek(clip.startTick - 1);
  }

  const cameraMode = clip.cameraMode;
  const settings = clip.cameraSettings;
  let phase: "playing" | "ended" = "playing";
  let exitReason: ClipPreviewExitReason | null = null;
  let ticksRemaining = clip.endTick - clip.startTick + 1;
  let lastCompletedTick = clip.startTick - 1;
  let absent = false;
  let restart = false;
  let lastFrame: ReplayPlaybackFrameResult | null = null;
  let freePose: CameraPose | null = null;

  const reopen = (): void => {
    const paused = playback.state.isPaused;
    playback.start();
    playback.setSpeed(clip.playbackSpeed);
    playback.setFocusedPlayerId(clip.playerId);
    if (clip.startTick > session.firstTick) {
      playback.seek(clip.startTick - 1);
    }
    if (paused) playback.setPaused(true);
    ticksRemaining = clip.endTick - clip.startTick + 1;
    lastCompletedTick = clip.startTick - 1;
    absent = false;
  };

  const opened = poseFromPlayback(
    playback,
    cameraMode,
    null,
    null,
    options.raycast,
    absent,
    settings,
  );
  let lastPose = opened.pose;
  freePose = opened.freePose;

  const emit = (
    frameResult: ReplayPlaybackFrameResult | null,
  ): ClipPreviewFrame => {
    const posed = poseFromPlayback(
      playback,
      cameraMode,
      lastPose,
      freePose,
      options.raycast,
      absent,
      settings,
    );
    lastPose = posed.pose;
    freePose = posed.freePose;
    return {
      playback: frameResult,
      pose: lastPose,
      ended: phase === "ended",
      exitReason,
      currentTick: playback.state.currentTick,
      focusedPlayerId: playback.state.focusedPlayerId,
    };
  };

  const finish = (
    reason: ClipPreviewExitReason,
    frameResult: ReplayPlaybackFrameResult | null,
  ): ClipPreviewFrame => {
    if (phase === "ended") return emit(frameResult);
    phase = "ended";
    exitReason = reason;
    ticksRemaining = 0;
    absent = false;
    return emit(frameResult);
  };

  const preview: ClipPreview = {
    clip,
    playback,
    cameraMode,
    get pose() {
      return lastPose;
    },
    state(): ClipPreviewState {
      const clock = playback.state;
      return {
        phase,
        exitReason,
        currentTick: clock.currentTick,
        focusedPlayerId: clock.focusedPlayerId,
        speed: clock.speed,
        isPaused: clock.isPaused,
        carryMs: clock.carryMs,
        ticksRemaining,
      };
    },
    frame(dtWallMs: number): ClipPreviewFrame {
      if (phase === "ended") return emit(lastFrame);
      if (restart) {
        reopen();
        restart = false;
      }
      const clock = playback.state;
      if (clock.isPaused) {
        const paused = stepPlayback(playback, dtWallMs, () => {
          absent = true;
        });
        lastFrame = paused.frame;
        return emit(lastFrame);
      }
      if (ticksRemaining <= 0) return finish("clip-end", lastFrame);
      const cap = Math.min(ticksRemaining, MAX_STEPS_PER_ADVANCE);
      const maxDt = dtForMaxSteps(cap, clock.carryMs, clock.speed);
      const dt = Math.min(dtWallMs, maxDt);
      const stepped = stepPlayback(playback, dt, () => {
        absent = true;
      });
      lastFrame = stepped.frame;
      const steps = stepped.steps ??
        (playback.state.currentTick - lastCompletedTick);
      lastCompletedTick = playback.state.currentTick;
      ticksRemaining -= steps;
      if (ticksRemaining <= 0) {
        if (settings.playback.loop) {
          restart = true;
          return emit(lastFrame);
        }
        return finish("clip-end", lastFrame);
      }
      if (playback.state.isEnded) return finish("session-end", lastFrame);
      return emit(lastFrame);
    },
    stop(): ClipPreviewFrame {
      return finish("stop", lastFrame);
    },
  };

  return preview;
}

// ---------------------------------------------------------------------------
// Pose + stepping
// ---------------------------------------------------------------------------

function poseFromPlayback(
  playback: ReplayPlayback,
  camera: SpectatorCameraMode,
  lastPose: CameraPose | null,
  freePose: CameraPose | null,
  raycast: SpectatorRaycast | undefined,
  absent: boolean,
  settings: ReplayClipCameraSettings,
): { pose: CameraPose | null; freePose: CameraPose | null } {
  if (camera === "free" && freePose != null) {
    return { pose: freePose, freePose };
  }

  const follow = followPose(
    playback,
    camera,
    lastPose,
    raycast,
    absent,
    settings,
  );
  if (camera !== "free") {
    return {
      pose: follow == null ? null : withFov(follow, settings.camera.fov),
      freePose: null,
    };
  }
  if (follow == null) return { pose: null, freePose: null };
  const spawned = withFov(spawnFreeCamera(follow), settings.camera.fov);
  return { pose: spawned, freePose: spawned };
}

function withFov(pose: CameraPose, fov: number | null): CameraPose {
  if (fov == null) return pose;
  return { ...pose, fov };
}

function boom(
  raycast: SpectatorRaycast,
  settings: ReplayClipCameraSettings,
): {
  raycast: SpectatorRaycast;
  distance: number;
  height: number;
  shoulder: number;
} {
  return {
    raycast,
    distance: settings.camera.distance,
    height: settings.camera.height,
    shoulder: settings.camera.shoulder,
  };
}

function followPose(
  playback: ReplayPlayback,
  camera: SpectatorCameraMode,
  lastPose: CameraPose | null,
  raycast: SpectatorRaycast | undefined,
  absent: boolean,
  settings: ReplayClipCameraSettings,
): CameraPose | null {
  const mode = camera === "free" ? "first-person" : camera;
  if (absent && lastPose != null) {
    if (mode === "third-person") {
      return thirdPersonCamera(
        { kind: "absent", lastPose },
        boom(raycast ?? ((_o, _d, _m) => null), settings),
      );
    }
    return firstPersonCamera({ kind: "absent", lastPose });
  }

  const feed = playback.feeders.render();
  if (mode === "third-person") {
    const display = playback.focusedDisplay();
    if (display != null && feed != null && typeof raycast === "function") {
      return thirdPersonCamera(
        {
          kind: "pose",
          pose: display.pose,
          snapped: display.snapped,
          eye: feed.viewOffset,
        },
        boom(raycast, settings),
      );
    }
    if (lastPose != null) {
      return thirdPersonCamera(
        { kind: "absent", lastPose },
        boom(raycast ?? ((_o, _d, _m) => null), settings),
      );
    }
    return lastPose;
  }

  if (feed != null) return firstPersonCamera({ kind: "feed", feed });
  if (lastPose != null) return firstPersonCamera({ kind: "absent", lastPose });
  return lastPose;
}

function stepPlayback(
  playback: ReplayPlayback,
  dtWallMs: number,
  onAbsent: () => void,
): { frame: ReplayPlaybackFrameResult | null; steps: number | null } {
  try {
    const frame = playback.frame(dtWallMs);
    return { frame, steps: frame.steps };
  } catch (err) {
    if (
      err instanceof ReplayStateAccessError &&
      err.code === "replay-state-focus-unknown"
    ) {
      onAbsent();
      return { frame: null, steps: null };
    }
    throw err;
  }
}

/** Wall dt that completes at most `maxSteps` sim ticks at the armed speed. */
function dtForMaxSteps(
  maxSteps: number,
  carryMs: number,
  speed: number,
): number {
  if (maxSteps <= 0) return 0;
  const budget = maxSteps * TICK_MS - carryMs;
  if (budget <= 0) return 0;
  return budget / speed;
}
