/**
 * Epic 11.6 — basic replay start (orchestration).
 *
 * Owns the session → watchable-replay boundary only:
 *   bytes | session
 *     → createReplayPlayback
 *     → start() / frame(dtWallMs)
 *     → 6.5 seam feeders (SnapshotPacket + ReplayRenderFeedState)
 *     → Q1A focusedDisplay() ({ pose, snapped } via 11.5, exact 11.4)
 *
 * Fixed per-frame order (locked):
 *   clock.advance(dtWallMs)
 *     → runner.step(t) for each tick in [fromTick, toTick)
 *     → projectReplaySnapshot + projectReplayRenderFeed
 *       (blend via 11.5 → 11.4; u = clock.carryMs / TICK_MS)
 *
 * Contract (see notes/replay/11-replay-playback/11-06-basic-replay-start.md):
 * - Thin orchestrator: calls 11.1–11.5 public APIs only; never re-validates,
 *   re-counts, re-blends, or hand-shapes packets.
 * - Bytes *or* session entry; load/decode at most once (never per frame).
 * - Start = resetToInitial + fresh virgin clock + initial projection.
 *   Double-start is an idempotent restart (full reset), never a partial resume.
 * - Focus is one explicit id (default: first roster id in runner order);
 *   unknown id surfaces 11.5's named error unchanged. Mid-run switch is
 *   `setFocusedPlayerId` (12.1 / Open Question 2A): slot-only, then immediate
 *   re-project at the live cursor — no reset, no re-step, no clock change.
 *   Valid-then-absent never migrates the slot (Decision 9).
 * - End clamps via the clock; no wrap, no over-step, no auto-restart.
 * - Raid rejection surfaces unchanged from createReplayRunner / resetToInitial.
 * - Caller owns the frame loop and supplies dtWallMs (scan-locked: no wall
 *   clock reads, no rAF/timers, no fs/blob/store/net imports).
 *
 * Handoffs: 12.x selection/cameras (12.3 reads focusedDisplay()); 13.x death
 * framing; 14.1 reads `timeline` and 14.2 reads `eventMarkers` (presentation
 * only — the clock keeps the cursor; markers come from a filled file index);
 * 14.3 `seek` / `seekToTimeMs` reposition via replaySeek.ts, then
 * `clock.resetTo` (completed tick, carry cleared); 14.4 `playbackSpeed` /
 * `faster` / `slower` / scrub pause reuse the clock ladder (no second speed
 * set); 14.5 continues a seek when the cursor is already between the floor
 * and the target; 15.3 previews a clip through this playback;
 * 18.x fixtures; 20.x trust; 21.x rAF + UI.
 */

import { TICK_MS } from "../shared/sim/game.ts";
import type { SnapshotPacket } from "../protocol/network.ts";
import type { MapCollision } from "../world/MapCollision.ts";
import { captureCheckpointState } from "./authoritativeCheckpoint.ts";
import {
  createReplayClock,
  DEFAULT_REPLAY_SPEED,
  type ReplayClock,
  type ReplaySpeed,
} from "./replayClock.ts";
import {
  armReplaySpeed,
  beginReplaySpeedScrub,
  endReplaySpeedScrub,
  presentReplaySpeed,
  type ReplayPlaybackSpeed,
  type ReplaySpeedScrub,
  stepReplaySpeed,
} from "./replayPlaybackSpeed.ts";
import {
  type ReplayEventMarkers,
  replayEventMarkers,
} from "./replayEventMarkers.ts";
import { isFilledReplayIndex, type ReplayIndexMarker } from "./replayIndex.ts";
import {
  isLoadedReplay,
  type LoadedReplay,
  loadReplay,
} from "./replayLoader.ts";
import {
  planReplaySeek,
  replaySeekFloor,
  type ReplaySeekResult,
  resolveReplaySeekTick,
} from "./replaySeek.ts";
import { executeReplayScrub, planReplayScrub } from "./replayScrub.ts";
import { type ReplayTimeline, replayTimeline } from "./replayTimeline.ts";
import {
  createReplayRunner,
  type ReplayRunner,
  type ReplayRunSession,
} from "./replaySimulationRunner.ts";
import {
  projectReplayFocusedDisplay,
  projectReplayRenderFeed,
  projectReplaySnapshot,
  type ReplayFocusedDisplay,
  type ReplayRenderFeedState,
  type ReplayViewState,
} from "./replayStateAccess.ts";
import {
  createSpectatorState,
  nextPlayer,
  orderSpectatorRoster,
  previousPlayer,
  selectFocusedPlayer,
} from "./spectatorSelection.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Bytes (11.1) or a runner-shaped session (tests / 12.7 buffer adapters). */
export type ReplayPlaybackInput = Uint8Array | ReplayRunSession | LoadedReplay;

export type CreateReplayPlaybackOptions = {
  /** Injected collision for the recorded map (never loaded here). */
  readonly collision: MapCollision;
  /**
   * Focused player for the render feed. When omitted, resolves once at
   * `start()` to the first roster id in runner (`allCached`) order.
   */
  readonly focusedPlayerId?: string;
};

/** Read-only playback cursor + control mirrors (clock is source of truth). */
export type ReplayPlaybackState = {
  readonly currentTick: number;
  readonly firstTick: number;
  readonly lastTick: number;
  readonly isEnded: boolean;
  readonly isPaused: boolean;
  readonly speed: ReplaySpeed;
  readonly replayTimeMs: number;
  readonly carryMs: number;
  readonly focusedPlayerId: string | null;
  readonly started: boolean;
};

/**
 * One `frame(dtWallMs)` result: clock step descriptor + projected seam outputs.
 * `fromTick`/`toTick` are the half-open step range from the clock (exclusive end).
 */
export type ReplayPlaybackFrameResult = {
  readonly steps: number;
  readonly fromTick: number;
  readonly toTick: number;
  readonly ended: boolean;
  readonly droppedSteps: number;
  readonly snapshot: SnapshotPacket | null;
  readonly feed: ReplayRenderFeedState | null;
};

/** 6.5 state seam: indistinguishable from a staged live SnapshotPacket. */
export type ReplayStateFeeder = () => SnapshotPacket | null;

/** 6.5 render seam: syncCameraFromLayers / remotes.update cannot tell live from fed. */
export type ReplayRenderFeeder = () => ReplayRenderFeedState | null;

export type ReplayPlaybackFeeders = {
  readonly state: ReplayStateFeeder;
  readonly render: ReplayRenderFeeder;
};

export type ReplayPlayback = {
  readonly session: ReplayRunSession;
  readonly state: ReplayPlaybackState;
  /**
   * 14.1 — start, end, playhead, and duration for the clock cursor.
   * Reading it does not advance, pause, or seek. Before `start`, the
   * playhead is the session start (the runner's pre-step tick is not a
   * timeline position).
   */
  readonly timeline: ReplayTimeline;
  /**
   * 14.2 — kills, deaths, door captures, agent appearances, and major match
   * events for the whole span. A loaded replay presents its file index.
   * A buffer session with no index presents nothing: this does not scan
   * events into a second marker table. Reading it does not advance or seek.
   */
  readonly eventMarkers: ReplayEventMarkers;
  /**
   * 14.4 — armed speed on the clock ladder (label, index, pause, scrub).
   * Reading it does not change speed, pause, or the cursor. Before `start`
   * the view is the default 1× rung.
   */
  readonly playbackSpeed: ReplayPlaybackSpeed;
  readonly feeders: ReplayPlaybackFeeders;
  /** Idempotent restart: reset runner + fresh virgin clock + initial project. */
  start(): void;
  /** advance → step → project. Caller supplies wall delta; no internal timers. */
  frame(dtWallMs: number): ReplayPlaybackFrameResult;
  setPaused(paused: boolean): void;
  /**
   * Arm a ladder speed. Invalid values fail. Carry clears. Pause and a
   * held scrub stay as they are (a speed change never resumes).
   */
  setSpeed(speed: ReplaySpeed): void;
  /** One rung faster. Wraps from the top rung to the first. */
  faster(): ReplaySpeed;
  /** One rung slower. Wraps from the bottom rung to the last. */
  slower(): ReplaySpeed;
  /**
   * Timeline drag. Pauses and remembers the pre-drag pause flag. Speed
   * stays. A second call does not overwrite that flag. Requires `start`.
   */
  beginScrub(): void;
  /**
   * Release the drag. Restores the remembered pause flag. Speed stays.
   * Does not move the playhead.
   */
  endScrub(): void;
  /**
   * 14.3 floor, then 14.5: if the runner is already on that anchor or
   * between it and `targetTick`, step forward from the cursor. Otherwise
   * load the anchor and replay. Integers outside the session clamp.
   * Non-integers fail. The land is a completed tick (carry 0). Speed,
   * pause, and focus stay. The next `frame` steps `targetTick + 1` unless
   * the clock ended. Requires `start`.
   */
  seek(targetTick: number): ReplaySeekResult;
  /** Same seek from absolute sim time (`timeMsToTick`, then the same clamp). */
  seekToTimeMs(timeMs: number): ReplaySeekResult;
  /**
   * 12.1 / Open Question 2A — flip the focus slot only, then re-project at
   * the live cursor. Unknown id fails loud and leaves the prior slot intact.
   * Once selected, later absence does not migrate the slot.
   */
  setFocusedPlayerId(playerId: string): void;
  /** Advance one identity-roster slot (ascending id, wrap). Slot-only. */
  selectNextPlayer(): void;
  /** Retreat one identity-roster slot (ascending id, wrap). Slot-only. */
  selectPreviousPlayer(): void;
  /**
   * Identity roster for cycling: init ∪ live cache ∪ current view, unique,
   * ascending id. Presence is not filtered — absent ids keep their slot.
   */
  focusRoster(): readonly string[];
  /**
   * 12.3 / Open Question 1A — focused `{ pose, snapped }` from the same
   * prev/curr views + `u` that `projectCurrent` uses (exact 11.4 semantics).
   * Unknown / post-leave miss throws `replay-state-focus-unknown` (11.5 family).
   * Does not change `frame()`'s return shape. Eye height is not included;
   * pass `feeders.render().viewOffset` into `thirdPersonCamera`.
   */
  focusedDisplay(): ReplayFocusedDisplay | null;
};

export type ReplayPlaybackErrorCode =
  | "replay-playback-not-started"
  | "replay-playback-focus-empty";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ReplayPlaybackError extends Error {
  readonly code: ReplayPlaybackErrorCode;
  readonly detail: string | null;

  constructor(
    code: ReplayPlaybackErrorCode,
    message: string,
    opts?: { detail?: string | null },
  ) {
    super(message);
    this.name = "ReplayPlaybackError";
    this.code = code;
    this.detail = opts?.detail ?? null;
  }
}

// ---------------------------------------------------------------------------
// Input resolution
// ---------------------------------------------------------------------------

function isUint8Array(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

function fileIndexMarkers(
  session: ReplayRunSession,
): readonly ReplayIndexMarker[] {
  if (!isLoadedReplay(session)) return [];
  if (!isFilledReplayIndex(session.index)) return [];
  return session.index.markers;
}

function resolveSession(input: ReplayPlaybackInput): ReplayRunSession {
  if (isUint8Array(input)) {
    return loadReplay(input);
  }
  return input;
}

/**
 * Runner cursor → structural 11.5 view.
 * Uses checkpoint capture for player rows (same field set as 9.1) plus live
 * door/phase getters. Never steps; never loads checkpoints.
 */
function viewFromRunner(runner: ReplayRunner): ReplayViewState {
  const sim = runner.simulation;
  const tick = runner.currentTick;
  const checkpoint = captureCheckpointState(
    sim,
    tick,
    runner.session.initialState.runtimeMatchId,
  );
  const doors = sim.getDoorCycleState(tick);
  return {
    tick,
    players: checkpoint.players,
    scores: { ...sim.getScores() },
    phase: sim.getMatchPhase(),
    doorsOpen: doors.doorsOpen,
    doorChangeTick: doors.doorChangeTick,
    matchEndTick: checkpoint.match.matchEndTick,
    projectiles: checkpoint.projectiles,
  };
}

function defaultFocusId(runner: ReplayRunner): string {
  const first = runner.simulation.allCached()[0];
  if (first) return first.id;
  const roster = runner.session.initialState.init.roster;
  if (roster.length > 0) return roster[0]!.id;
  throw new ReplayPlaybackError(
    "replay-playback-focus-empty",
    "ReplayPlayback: cannot default focus — roster is empty",
  );
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class ReplayPlaybackImpl implements ReplayPlayback {
  readonly session: ReplayRunSession;
  private readonly collision: MapCollision;
  private readonly focusExplicit: string | null;
  private readonly runner: ReplayRunner;

  private clock: ReplayClock | null = null;
  private started = false;
  private focusedPlayerId: string | null = null;

  /** Prior completed view (T−1); null until at least one step after start. */
  private prevView: ReplayViewState | null = null;
  /** Newest reconstructed view (post-reset or post-step). */
  private currView: ReplayViewState | null = null;

  private lastSnapshot: SnapshotPacket | null = null;
  private lastFeed: ReplayRenderFeedState | null = null;
  /** 14.4 drag. The clock is paused for the hold; this remembers resume. */
  private scrubbing = false;
  private pausedBeforeScrub: boolean | null = null;

  constructor(session: ReplayRunSession, options: CreateReplayPlaybackOptions) {
    this.session = session;
    this.collision = options.collision;
    this.focusExplicit = typeof options.focusedPlayerId === "string" &&
        options.focusedPlayerId.length > 0
      ? options.focusedPlayerId
      : null;
    // Raid guard fires here (and again on resetToInitial) — surface unchanged.
    this.runner = createReplayRunner(session, { collision: this.collision });
  }

  get state(): ReplayPlaybackState {
    const clock = this.clock;
    return {
      currentTick: clock?.currentTick ?? this.runner.currentTick,
      firstTick: this.session.firstTick,
      lastTick: this.session.lastTick,
      isEnded: clock?.isEnded ?? false,
      isPaused: clock?.isPaused ?? false,
      speed: clock?.speed ?? DEFAULT_REPLAY_SPEED,
      replayTimeMs: clock?.replayTimeMs ?? 0,
      carryMs: clock?.carryMs ?? 0,
      focusedPlayerId: this.focusedPlayerId,
      started: this.started,
    };
  }

  get timeline(): ReplayTimeline {
    const clock = this.clock;
    if (clock) {
      return replayTimeline({
        firstTick: clock.firstTick,
        lastTick: clock.lastTick,
        currentTick: clock.currentTick,
        carryMs: clock.carryMs,
        isEnded: clock.isEnded,
      });
    }
    return replayTimeline({
      firstTick: this.session.firstTick,
      lastTick: this.session.lastTick,
      currentTick: this.session.firstTick,
      carryMs: 0,
      isEnded: false,
    });
  }

  get eventMarkers(): ReplayEventMarkers {
    return replayEventMarkers({
      firstTick: this.session.firstTick,
      lastTick: this.session.lastTick,
      markers: fileIndexMarkers(this.session),
      eventsAt: (tick) => this.session.eventsAt(tick),
    });
  }

  get playbackSpeed(): ReplayPlaybackSpeed {
    const clock = this.clock;
    return presentReplaySpeed({
      speed: clock?.speed ?? DEFAULT_REPLAY_SPEED,
      paused: clock?.isPaused ?? false,
      scrubbing: this.scrubbing,
    });
  }

  get feeders(): ReplayPlaybackFeeders {
    return {
      state: () => this.lastSnapshot,
      render: () => this.lastFeed,
    };
  }

  start(): void {
    this.runner.resetToInitial();
    // Fresh virgin clock — do NOT resetTo(firstTick); that leaves virgin mode
    // and would treat firstTick as already completed (11.3 contract for 11.6).
    this.clock = createReplayClock({
      firstTick: this.session.firstTick,
      lastTick: this.session.lastTick,
    });
    this.scrubbing = false;
    this.pausedBeforeScrub = null;
    this.focusedPlayerId = this.focusExplicit ?? defaultFocusId(this.runner);
    this.prevView = null;
    this.currView = viewFromRunner(this.runner);
    this.started = true;
    this.projectCurrent(0, /* ended */ false);
  }

  frame(dtWallMs: number): ReplayPlaybackFrameResult {
    if (!this.started || !this.clock) {
      throw new ReplayPlaybackError(
        "replay-playback-not-started",
        "ReplayPlayback: frame() called before start()",
      );
    }
    const clock = this.clock;
    const advance = clock.advance(dtWallMs);

    let steppedTo = advance.fromTick - 1;
    try {
      for (let tick = advance.fromTick; tick < advance.toTick; tick++) {
        this.runner.step(tick);
        steppedTo = tick;
        this.prevView = this.currView;
        this.currView = viewFromRunner(this.runner);
      }
    } catch (err) {
      // advance() already moved the clock; resync so a later frame() cannot
      // throw ReplayStepOrderError on top of the original failure.
      this.resyncClockAfterStepFailure(steppedTo);
      throw err;
    }

    const u = clock.carryMs / TICK_MS;
    const { snapshot, feed } = this.projectCurrent(u, clock.isEnded);

    return {
      steps: advance.steps,
      fromTick: advance.fromTick,
      toTick: advance.toTick,
      ended: advance.ended,
      droppedSteps: advance.droppedSteps,
      snapshot,
      feed,
    };
  }

  setPaused(paused: boolean): void {
    const clock = this.requireClock();
    if (this.scrubbing) {
      // The drag owns the clock pause. This arms what release restores.
      this.pausedBeforeScrub = paused;
      if (!clock.isPaused) clock.pause();
      return;
    }
    if (paused) clock.pause();
    else clock.resume();
  }

  setSpeed(speed: ReplaySpeed): void {
    const clock = this.requireClock();
    const next = armReplaySpeed(this.speedScrub(clock), speed);
    clock.setSpeed(next.speed);
  }

  faster(): ReplaySpeed {
    return this.stepSpeed(1);
  }

  slower(): ReplaySpeed {
    return this.stepSpeed(-1);
  }

  beginScrub(): void {
    const clock = this.requireClock();
    const next = beginReplaySpeedScrub(this.speedScrub(clock));
    this.scrubbing = next.scrubbing;
    this.pausedBeforeScrub = next.pausedBeforeScrub;
    if (!clock.isPaused) clock.pause();
  }

  endScrub(): void {
    const clock = this.requireClock();
    const next = endReplaySpeedScrub(this.speedScrub(clock));
    this.scrubbing = next.scrubbing;
    this.pausedBeforeScrub = next.pausedBeforeScrub;
    if (next.paused) {
      if (!clock.isPaused) clock.pause();
    } else if (clock.isPaused) {
      clock.resume();
    }
  }

  private speedScrub(clock: ReplayClock): ReplaySpeedScrub {
    return {
      speed: clock.speed,
      paused: clock.isPaused,
      scrubbing: this.scrubbing,
      pausedBeforeScrub: this.pausedBeforeScrub,
    };
  }

  private stepSpeed(direction: 1 | -1): ReplaySpeed {
    const clock = this.requireClock();
    const next = stepReplaySpeed(clock.speed, direction);
    if (next !== clock.speed) clock.setSpeed(next);
    return next;
  }

  seek(targetTick: number): ReplaySeekResult {
    return this.seekResolved({ tick: targetTick });
  }

  seekToTimeMs(timeMs: number): ReplaySeekResult {
    return this.seekResolved({ timeMs });
  }

  /**
   * Floor, then continue or load, then park the clock on that completed
   * tick. 14.5 skips the reload when the cursor is already in range.
   */
  private seekResolved(
    target: { readonly tick: number } | { readonly timeMs: number },
  ): ReplaySeekResult {
    const clock = this.requireClock();
    const targetTick = resolveReplaySeekTick(
      target,
      this.session.firstTick,
      this.session.lastTick,
    );
    const floor = planReplaySeek(
      targetTick,
      this.session.firstTick,
      this.session.lastTick,
      replaySeekFloor(this.session),
    );
    const scrub = planReplayScrub(floor, this.runner.currentTick);
    try {
      executeReplayScrub(this.runner, scrub, {
        onAnchored: () => {
          this.prevView = null;
          this.currView = viewFromRunner(this.runner);
        },
        onStepped: () => {
          this.prevView = this.currView;
          this.currView = viewFromRunner(this.runner);
        },
      });
    } catch (err) {
      this.resyncClockToRunner();
      throw err;
    }
    clock.resetTo(targetTick);
    this.projectCurrent(0, clock.isEnded);
    return {
      targetTick,
      anchorKind: floor.anchor.kind,
      anchorTick: floor.anchor.kind === "checkpoint"
        ? floor.anchor.frame.tick
        : null,
      steps: scrub.steps,
      resumed: scrub.resumed,
      ended: clock.isEnded,
    };
  }

  setFocusedPlayerId(playerId: string): void {
    this.requireClock();
    this.applyFocusSlot(
      selectFocusedPlayer(this.selectionState(), playerId, this.focusRoster()),
    );
  }

  selectNextPlayer(): void {
    this.requireClock();
    this.applyFocusSlot(
      nextPlayer(this.selectionState(), this.focusRoster()),
    );
  }

  selectPreviousPlayer(): void {
    this.requireClock();
    this.applyFocusSlot(
      previousPlayer(this.selectionState(), this.focusRoster()),
    );
  }

  focusRoster(): readonly string[] {
    const ids: string[] = [];
    for (const p of this.session.initialState.init.roster) ids.push(p.id);
    for (const p of this.runner.simulation.allCached()) ids.push(p.id);
    if (this.currView) {
      for (const p of this.currView.players) ids.push(p.id);
    }
    return orderSpectatorRoster(ids);
  }

  focusedDisplay(): ReplayFocusedDisplay | null {
    const clock = this.requireClock();
    const focus = this.focusedPlayerId;
    if (focus === null) {
      throw new ReplayPlaybackError(
        "replay-playback-focus-empty",
        "ReplayPlayback: focusedPlayerId unresolved",
      );
    }
    const view = this.currView;
    if (view === null) return null;
    const u = clock.carryMs / TICK_MS;
    if (clock.isEnded || this.prevView === null) {
      return projectReplayFocusedDisplay(view, null, focus, u);
    }
    return projectReplayFocusedDisplay(this.prevView, view, focus, u);
  }

  private selectionState() {
    return createSpectatorState({
      focusedPlayerId: this.focusedPlayerId,
    });
  }

  /** Flip the slot, then re-project at the live cursor. Clock/runner untouched. */
  private applyFocusSlot(next: { focusedPlayerId: string | null }): void {
    this.focusedPlayerId = next.focusedPlayerId;
    const clock = this.clock;
    if (!clock) return;
    this.projectCurrent(clock.carryMs / TICK_MS, clock.isEnded);
  }

  private requireClock(): ReplayClock {
    if (!this.started || !this.clock) {
      throw new ReplayPlaybackError(
        "replay-playback-not-started",
        "ReplayPlayback: control called before start()",
      );
    }
    return this.clock;
  }

  /**
   * `clock.advance` commits before `runner.step`. On a mid-batch failure,
   * park the clock on the last tick the runner actually completed (or a
   * fresh virgin clock if none) so the next `frame()` stays in order.
   */
  /**
   * A failed seek may have moved the runner and not the clock. Park the
   * clock on the runner's completed tick, keeping speed and pause.
   */
  private resyncClockToRunner(): void {
    const clock = this.clock;
    if (!clock) return;
    const speed = clock.speed;
    const paused = clock.isPaused;
    const tick = this.runner.currentTick;
    if (tick >= this.session.firstTick) {
      clock.resetTo(tick);
      return;
    }
    this.clock = createReplayClock({
      firstTick: this.session.firstTick,
      lastTick: this.session.lastTick,
    });
    this.clock.setSpeed(speed);
    if (paused) this.clock.pause();
  }

  private resyncClockAfterStepFailure(steppedTo: number): void {
    if (steppedTo >= this.session.firstTick) {
      this.clock = createReplayClock({
        firstTick: this.session.firstTick,
        lastTick: this.session.lastTick,
      });
      this.clock.resetTo(steppedTo);
      return;
    }
    // No tick completed — same posture as start(): virgin clock, runner behind.
    this.clock = createReplayClock({
      firstTick: this.session.firstTick,
      lastTick: this.session.lastTick,
    });
  }

  /**
   * Project snapshot + render feed for the current cursor.
   * - Ended / no next: exact newest (nextView = null).
   * - Otherwise: last-two-views blend with caller-threaded u.
   */
  private projectCurrent(
    u: number,
    ended: boolean,
  ): { snapshot: SnapshotPacket | null; feed: ReplayRenderFeedState | null } {
    const focus = this.focusedPlayerId;
    if (focus === null) {
      throw new ReplayPlaybackError(
        "replay-playback-focus-empty",
        "ReplayPlayback: focusedPlayerId unresolved",
      );
    }

    const view = this.currView;
    if (view === null) {
      this.lastSnapshot = null;
      this.lastFeed = null;
      return { snapshot: null, feed: null };
    }

    const snapshot = projectReplaySnapshot(view);

    let feed: ReplayRenderFeedState | null;
    if (ended || this.prevView === null) {
      // Pre-first-step or end-of-replay: single-view exact (11.5 null-next rule).
      feed = projectReplayRenderFeed(view, null, focus, u);
    } else {
      // last-two-views: blend prev → curr with clock carry u.
      feed = projectReplayRenderFeed(this.prevView, view, focus, u);
    }

    this.lastSnapshot = snapshot;
    this.lastFeed = feed;
    return { snapshot, feed };
  }
}

/**
 * Create a playback session over bytes (load once via 11.1) or a runner-shaped
 * session. Collision is injected; focus defaults at `start()` when omitted.
 */
export function createReplayPlayback(
  input: ReplayPlaybackInput,
  options: CreateReplayPlaybackOptions,
): ReplayPlayback {
  const session = resolveSession(input);
  return new ReplayPlaybackImpl(session, options);
}
