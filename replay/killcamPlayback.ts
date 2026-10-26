/**
 * Epic 13.3–13.5 — killcam driver (thin 11.6 session consumer).
 *
 * Owns death→window→killer-focus→bounded-1×-play→exit only:
 *   KillcamDeath + KillcamWindow (13.1 / 13.2)
 *     → createReplayPlayback (11.6)
 *     → ReplayPlayback.seek to the tick before startTick (14.3; virgin when
 *       the window already begins at firstTick)
 *     → setFocusedPlayerId(killer) (12.1 slot-only)
 *     → pose via firstPersonCamera (default) / thirdPersonCamera (caller)
 *     → frame() at 1× until endTick, skip, victim respawn, or session end
 *     → restore prior / victim focus (12.1 slot-only, no reset)
 *
 * Open-window cost: `start()` then `seek(startTick - 1)` when the window
 * begins after `firstTick`. 14.3 floors to a checkpoint when the session
 * exposes one, then replays forward. `openSteps` stays the logical distance
 * `startTick - firstTick` (callers unchanged). A window that already starts
 * at `firstTick` keeps the virgin `start()` posture.
 *
 * Contract (see notes/replay/13-killcams/13-killcams.md):
 * - Drives ReplayPlayback.frame(); never steps the runner, never owns the
 *   clock beyond setSpeed(1) at start, never redefines blend/projection.
 * - Pause is the shared 11.3 flag. Skip is an exit, not a seek.
 * - End clamps at window.endTick (inclusive). Never steps past the window.
 * - Live buffer source uses a committed ReplayRunSession over 8.5 reads;
 *   does not import delayedLiveTail.ts (12.7 delay policy is untouched).
 * - Scan-locked: caller owns the play loop and supplies dtWallMs. No
 *   wall-clock reads, rAF/timers, fs/blob/store/net. Checkpoint choice
 *   stays inside ReplayPlayback.seek.
 *
 * Handoffs: 14.3 opens the window through `seek`; 15.1 stores the window
 * with `replayClipFromKillcamWindow`; 21.x calls start/skip/exit and applies
 * poses.
 */

import { TICK_MS } from "../shared/sim/game.ts";
import type { AuthoritativeEvent } from "../shared/sim/authoritativeEvent.ts";
import type { MapCollision } from "../world/MapCollision.ts";
import {
  frameKillcamWindow,
  type KillcamCameraMode,
  type KillcamDeath,
  type KillcamDeathQuery,
  KillcamError,
  type KillcamExitReason,
  killcamFocusPlayerId,
  killcamPlayTickCount,
  type KillcamWindow,
  resolveKillcamDeath,
  victimRespawnedInEvents,
} from "./killcam.ts";
import { DEFAULT_REPLAY_SPEED, MAX_STEPS_PER_ADVANCE } from "./replayClock.ts";
import {
  createReplayPlayback,
  type CreateReplayPlaybackOptions,
  type ReplayPlayback,
  type ReplayPlaybackFrameResult,
  type ReplayPlaybackInput,
} from "./replayPlaybackSession.ts";
import { floorFromCheckpointFrames } from "./replaySeek.ts";
import type { ReplayRunSession } from "./replaySimulationRunner.ts";
import type { ReplaySessionBuffer } from "./replaySessionBuffer.ts";
import { ReplayStateAccessError } from "./replayStateAccess.ts";
import {
  type CameraPose,
  firstPersonCamera,
  type SpectatorRaycast,
  thirdPersonCamera,
} from "./spectatorCamera.ts";
import { SpectatorSelectionError } from "./spectatorSelection.ts";

const EMPTY_EVENTS: readonly AuthoritativeEvent[] = Object.freeze([]);

export type StartKillcamOptions = {
  readonly collision: MapCollision;
  readonly camera?: KillcamCameraMode;
  /** Restored on exit. Defaults to the victim. */
  readonly restoreFocusId?: string;
  readonly preMs?: number;
  readonly postMs?: number;
  /** Required when camera is third-person (12.3 caller-injected raycast). */
  readonly raycast?: SpectatorRaycast;
};

export type KillcamDriverState = {
  readonly phase: "playing" | "exited";
  readonly death: KillcamDeath;
  readonly window: KillcamWindow;
  readonly camera: KillcamCameraMode;
  readonly focusedPlayerId: string | null;
  readonly restoreFocusId: string;
  readonly currentTick: number;
  readonly isPaused: boolean;
  readonly speed: number;
  readonly carryMs: number;
  readonly exitReason: KillcamExitReason | null;
  /** Ticks re-stepped from initial to open the window (14.3 seam). */
  readonly openSteps: number;
};

export type KillcamFrameResult = {
  readonly playback: ReplayPlaybackFrameResult | null;
  readonly pose: CameraPose | null;
  readonly exited: boolean;
  readonly exitReason: KillcamExitReason | null;
  readonly currentTick: number;
  readonly focusedPlayerId: string | null;
};

export type KillcamPlayback = {
  readonly death: KillcamDeath;
  readonly window: KillcamWindow;
  readonly playback: ReplayPlayback;
  readonly camera: KillcamCameraMode;
  readonly restoreFocusId: string;
  readonly openSteps: number;
  state(): KillcamDriverState;
  frame(dtWallMs: number): KillcamFrameResult;
  skip(): KillcamFrameResult;
  exit(reason: KillcamExitReason): KillcamFrameResult;
};

export function startKillcam(
  input: ReplayPlaybackInput,
  query: KillcamDeathQuery | KillcamDeath,
  options: StartKillcamOptions,
): KillcamPlayback {
  const playback = createReplayPlayback(
    input,
    {
      collision: options.collision,
      focusedPlayerId: focusHint(query, options),
    } satisfies CreateReplayPlaybackOptions,
  );

  return armKillcam(playback, query, options);
}

/**
 * Live-buffer source: committed 8.5 rows as a ReplayRunSession. Window
 * policy is the same as the viewer path. Does not import delayedLiveTail.
 */
export function startKillcamFromBuffer(
  buffer: ReplaySessionBuffer,
  query: KillcamDeathQuery | KillcamDeath,
  options: StartKillcamOptions,
): KillcamPlayback {
  return startKillcam(killcamSessionFromBuffer(buffer), query, options);
}

export function killcamSessionFromBuffer(
  buffer: ReplaySessionBuffer,
): ReplayRunSession {
  const init = buffer.init;
  if (init == null) {
    throw new KillcamError(
      "replay-killcam-empty-source",
      "Killcam: live buffer has no init",
      { detail: "no-init" },
    );
  }
  const rows = buffer.orderedInputs();
  if (rows.length === 0) {
    throw new KillcamError(
      "replay-killcam-empty-source",
      "Killcam: live buffer has no dense input rows",
      { detail: "no-inputs" },
    );
  }
  let firstTick = rows[0].tick;
  let lastTick = rows[0].tick;
  for (const row of rows) {
    if (row.tick < firstTick) firstTick = row.tick;
    if (row.tick > lastTick) lastTick = row.tick;
  }
  return {
    initialState: init,
    firstTick,
    lastTick,
    inputAt(tick: number) {
      const row = buffer.getInputs(tick);
      if (row === undefined) {
        throw new KillcamError(
          "replay-killcam-empty-source",
          `Killcam: no dense input row for tick ${tick}`,
          { detail: `missingTick=${tick} window=[${firstTick}, ${lastTick}]` },
        );
      }
      return row;
    },
    eventsAt(tick: number) {
      return buffer.getEvents(tick)?.events ?? EMPTY_EVENTS;
    },
    findPriorCheckpoint: floorFromCheckpointFrames(buffer.orderedCheckpoints()),
  };
}

function focusHint(
  query: KillcamDeathQuery | KillcamDeath,
  options: StartKillcamOptions,
): string | undefined {
  if (options.restoreFocusId) return options.restoreFocusId;
  if ("victimId" in query) return query.victimId;
  return undefined;
}

function armKillcam(
  playback: ReplayPlayback,
  query: KillcamDeathQuery | KillcamDeath,
  options: StartKillcamOptions,
): KillcamPlayback {
  const session = playback.session;
  const deathQuery: KillcamDeathQuery = {
    victimId: query.victimId,
    deathTick: query.deathTick,
  };
  const death = resolveKillcamDeath(session, deathQuery);
  const window = frameKillcamWindow(death.deathTick, {
    firstTick: session.firstTick,
    lastTick: session.lastTick,
    preMs: options.preMs,
    postMs: options.postMs,
  });

  const camera: KillcamCameraMode = options.camera ?? "first-person";
  if (camera === "third-person" && typeof options.raycast !== "function") {
    throw new KillcamError(
      "replay-killcam-bad-window",
      "Killcam: third-person camera requires an injected raycast",
    );
  }

  const restoreFocusId = options.restoreFocusId ?? death.victimId;
  playback.start();
  playback.setSpeed(DEFAULT_REPLAY_SPEED);

  const openSteps = openToStartTick(playback, window.startTick);
  enterKillcamFocus(playback, death);

  let phase: "playing" | "exited" = "playing";
  let exitReason: KillcamExitReason | null = null;
  let playTicksRemaining = killcamPlayTickCount(window);
  let killerAbsent = false;
  let lastCompletedTick = window.startTick - 1;
  let lastPose: CameraPose | null = poseFromPlayback(
    playback,
    camera,
    null,
    options.raycast,
  );
  let lastFrame: ReplayPlaybackFrameResult | null = null;

  const snapshot = (): KillcamDriverState => ({
    phase,
    death,
    window,
    camera,
    focusedPlayerId: playback.state.focusedPlayerId,
    restoreFocusId,
    currentTick: playback.state.currentTick,
    isPaused: playback.state.isPaused,
    speed: playback.state.speed,
    carryMs: playback.state.carryMs,
    exitReason,
    openSteps,
  });

  const emit = (
    frameResult: ReplayPlaybackFrameResult | null,
  ): KillcamFrameResult => {
    lastPose = poseFromPlayback(
      playback,
      camera,
      lastPose,
      options.raycast,
      killerAbsent,
    );
    return {
      playback: frameResult,
      pose: lastPose,
      exited: phase === "exited",
      exitReason,
      currentTick: playback.state.currentTick,
      focusedPlayerId: playback.state.focusedPlayerId,
    };
  };

  const finishExit = (
    reason: KillcamExitReason,
    frameResult: ReplayPlaybackFrameResult | null,
  ): KillcamFrameResult => {
    if (phase === "exited") return emit(frameResult);
    phase = "exited";
    exitReason = reason;
    killerAbsent = false;
    restoreFocus(playback, restoreFocusId, reason);
    playTicksRemaining = 0;
    return emit(frameResult);
  };

  const handle: KillcamPlayback = {
    death,
    window,
    playback,
    camera,
    restoreFocusId,
    openSteps,
    state: snapshot,
    frame(dtWallMs: number): KillcamFrameResult {
      if (phase === "exited") return emit(lastFrame);
      const state = playback.state;
      if (state.isPaused) {
        const paused = stepPlayback(playback, dtWallMs, {
          onAbsent: () => {
            killerAbsent = true;
          },
        });
        lastFrame = paused.frame;
        return emit(lastFrame);
      }
      if (playTicksRemaining <= 0) {
        return finishExit("window-end", lastFrame);
      }
      const cap = Math.min(playTicksRemaining, MAX_STEPS_PER_ADVANCE);
      const maxDt = dtForMaxSteps(cap, state.carryMs, state.speed);
      const dt = Math.min(dtWallMs, maxDt);
      const stepped = stepPlayback(playback, dt, {
        onAbsent: () => {
          killerAbsent = true;
        },
      });
      lastFrame = stepped.frame;
      const steps = stepped.steps ??
        (playback.state.currentTick - lastCompletedTick);
      lastCompletedTick = playback.state.currentTick;
      playTicksRemaining -= steps;
      if (
        victimRespawnedSince(
          playback,
          lastCompletedTick - steps + 1,
          lastCompletedTick,
          death.victimId,
        )
      ) {
        return finishExit("victim-respawned", lastFrame);
      }
      if (playTicksRemaining <= 0) {
        return finishExit("window-end", lastFrame);
      }
      if (playback.state.isEnded) {
        return finishExit("session-end", lastFrame);
      }
      return emit(lastFrame);
    },
    skip(): KillcamFrameResult {
      return finishExit("skip", lastFrame);
    },
    exit(reason: KillcamExitReason): KillcamFrameResult {
      return finishExit(reason, lastFrame);
    },
  };

  return handle;
}

/**
 * 13.3 — slot-only killer focus. Self-kill is a no-op onto the victim.
 * Unknown killer wraps 12.1's named error.
 */
export function enterKillcamFocus(
  playback: ReplayPlayback,
  death: KillcamDeath,
): void {
  const focusId = killcamFocusPlayerId(death);
  try {
    playback.setFocusedPlayerId(focusId);
  } catch (err) {
    if (
      err instanceof SpectatorSelectionError &&
      (err.code === "replay-spectator-focus-unknown" ||
        err.code === "replay-spectator-focus-empty")
    ) {
      throw new KillcamError(
        "replay-killcam-unknown-killer",
        `Killcam: killer "${death.killerId}" is not on the roster (death victim=${death.victimId} tick=${death.deathTick})`,
        { detail: death.killerId, cause: err },
      );
    }
    throw err;
  }
}

export function poseFromPlayback(
  playback: ReplayPlayback,
  camera: KillcamCameraMode,
  lastPose: CameraPose | null,
  raycast?: SpectatorRaycast,
  absent = false,
): CameraPose | null {
  if (absent && lastPose != null) {
    if (camera === "third-person") {
      return thirdPersonCamera({ kind: "absent", lastPose }, {
        raycast: raycast ?? ((_o, _d, _m) => null),
      });
    }
    return firstPersonCamera({ kind: "absent", lastPose });
  }

  const feed = playback.feeders.render();
  if (camera === "third-person") {
    const display = playback.focusedDisplay();
    if (display != null && feed != null && typeof raycast === "function") {
      return thirdPersonCamera(
        {
          kind: "pose",
          pose: display.pose,
          snapped: display.snapped,
          eye: feed.viewOffset,
        },
        { raycast },
      );
    }
    if (lastPose != null) {
      return thirdPersonCamera({ kind: "absent", lastPose }, {
        raycast: raycast ?? ((_o, _d, _m) => null),
      });
    }
    return lastPose;
  }

  if (feed != null) {
    return firstPersonCamera({ kind: "feed", feed });
  }
  if (lastPose != null) {
    return firstPersonCamera({ kind: "absent", lastPose });
  }
  return lastPose;
}

function openToStartTick(
  playback: ReplayPlayback,
  startTick: number,
): number {
  const firstTick = playback.state.firstTick;
  const distance = startTick - firstTick;
  // Completed tick just before the window, so the next frame plays startTick.
  // distance 0 is already the virgin start() posture.
  if (distance > 0) {
    playback.seek(startTick - 1);
  }
  return distance;
}

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

function stepPlayback(
  playback: ReplayPlayback,
  dtWallMs: number,
  hooks: { onAbsent: () => void },
): { frame: ReplayPlaybackFrameResult | null; steps: number | null } {
  try {
    const frame = playback.frame(dtWallMs);
    return { frame, steps: frame.steps };
  } catch (err) {
    if (
      err instanceof ReplayStateAccessError &&
      err.code === "replay-state-focus-unknown"
    ) {
      hooks.onAbsent();
      return { frame: null, steps: null };
    }
    throw err;
  }
}

function victimRespawnedSince(
  playback: ReplayPlayback,
  fromTick: number,
  toTickInclusive: number,
  victimId: string,
): boolean {
  for (let tick = fromTick; tick <= toTickInclusive; tick++) {
    if (victimRespawnedInEvents(playback.session.eventsAt(tick), victimId)) {
      return true;
    }
  }
  return false;
}

function restoreFocus(
  playback: ReplayPlayback,
  restoreFocusId: string,
  reason: KillcamExitReason,
): void {
  try {
    playback.setFocusedPlayerId(restoreFocusId);
  } catch (err) {
    if (reason === "session-end") return;
    throw err;
  }
}
