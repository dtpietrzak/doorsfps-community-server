/**
 * Replay sink fan-out and recorder lifecycle. Owns the sink, the recorder,
 * the payload counters, the deferred match-end, the step re-entrancy flag,
 * and the action-effect buffer. GameServer passes the roster and getters
 * for the match id, the raid checkpoint, and match metadata. It never
 * imports GameServer.
 */

import type { PlayerManager } from "../players/PlayerManager.ts";
import type { SimActionEffect } from "../players/simActionEffect.ts";
import type { TickSelectedInput } from "../players/tickAssociation.ts";
import type { GameOverPacket } from "../protocol/network.ts";
import {
  type AuthoritativeCheckpoint,
  captureCheckpointState,
  type CheckpointRaidState,
  type CheckpointZombotsRunState,
} from "../replay/authoritativeCheckpoint.ts";
import { replayAccessAccountId } from "../replay/replayAccess.ts";
import { isReplayRecordingEnabled } from "../replay/recordingEnabled.ts";
import type { ReplayLifecycleClient } from "../replay/replayLifecycleClient.ts";
import { ReplayRecorder } from "../replay/ReplayRecorder.ts";
import type {
  ReplayIntegrationSink,
  ReplayLifecyclePayload,
} from "../replay/replayIntegration.ts";
import type {
  AuthoritativeEvent,
  MatchInitEvent,
} from "../shared/sim/authoritativeEvent.ts";
import type { MatchMetadataBuildResult } from "../shared/replay/matchMetadata.ts";

export type ReplayTapDeps = {
  players: PlayerManager;
  /** Current id. GameServer rotates it before {@link ReplayTap.onIdentityRotated}. */
  runtimeMatchId: () => string;
  raidCheckpointState: () => CheckpointRaidState;
  /** Zombots rules objects (step 14). Omitted / undefined off zombots. */
  zombotsCheckpointState?: () => CheckpointZombotsRunState | undefined;
  matchMetadata: (tick: number) => MatchMetadataBuildResult;
  createReplayLifecycleClient: () => ReplayLifecycleClient | null;
};

export class ReplayTap {
  /**
   * Epic 7.5 — single recorder sink. Null = disabled (zero payload construction).
   * Attach/detach are the only enable path; producers never call the sink.
   * Epic 8.1: when recording is enabled, {@link recorder} owns this slot.
   */
  sink: ReplayIntegrationSink | null = null;
  /**
   * Epic 8.1 — named lifecycle recorder. Null when REPLAY_RECORDING_ENABLED is
   * off or the recorder has not been started yet. Owns the 7.5 sink subscription.
   */
  recorder: ReplayRecorder | null = null;
  /** Sink-callback throws contained at the fan-out (never break the tick). */
  sinkErrorCount = 0;
  /**
   * Temp/dev policy: only record when a human is or has been in this match.
   * Sticky for the current runtimeMatchId (keeps recording after the last
   * human leaves). Late human join starts recording from that point.
   * Later (public): record always, discard on finalize if no human joined.
   */
  private matchHadHuman = false;
  /**
   * Epic 20.4 — real human account ids seen while this match was current.
   * Cleared on identity rotation. Copied onto the recorder at match end.
   * Not written into the replay file.
   */
  private accessAccountIds = new Set<string>();
  /**
   * Counts sink payload construction (inputs map / init / checkpoint notify).
   * Used by tests to prove the no-sink fast path does zero extra work.
   */
  payloadConstructionCount = 0;
  /**
   * Epic 9.2 — defer matchEnd/matchDraw sink notify until after the 7.3 drain
   * + onTick fan-out when the end is raised inside stepSim. Keeps the final
   * checkpoint on the post-drain boundary and lets the end tick's onTick run
   * while the recorder is still attached.
   */
  pendingMatchEnd: GameOverPacket | null = null;
  /** True while stepSim is on the stack (drives deferral of replay match-end). */
  private inStep = false;
  /**
   * Epic 8.3 — tick-local action-effect buffer filled by PlayerManager.handle*
   * while a sink is attached. Drained into onTick.actions each fan-out.
   */
  private actionEffects: SimActionEffect[] = [];

  constructor(private readonly deps: ReplayTapDeps) {}

  attach(sink: ReplayIntegrationSink): void {
    this.sink = sink;
    // Arm the unified handle* action-effect tap only while a sink is attached.
    this.deps.players.setActionEffectObserver((effect) => {
      this.actionEffects.push(effect);
    });
  }

  detach(): void {
    this.sink = null;
    this.deps.players.setActionEffectObserver(null);
    this.actionEffects = [];
  }

  startRecorder(): ReplayRecorder | null {
    if (!isReplayRecordingEnabled()) return null;
    if (this.recorder) {
      this.recorder.ensureAttached();
      return this.recorder;
    }
    const lifecycle = this.deps.createReplayLifecycleClient();
    if (!lifecycle) return null;
    this.recorder = new ReplayRecorder({
      lifecycle,
      attachSink: (sink) => this.attach(sink),
      detachSink: () => this.detach(),
      // 9.2: builder only — do not call captureCheckpoint (would re-enter sink).
      captureCheckpointState: (tick, runtimeMatchId) =>
        captureCheckpointState(
          this.deps.players,
          tick,
          runtimeMatchId,
          this.deps.raidCheckpointState(),
          this.zombotsOpts(),
        ),
      // Init is read mid-tick; its pending events are already applied state.
      captureStartState: (tick, runtimeMatchId) =>
        captureCheckpointState(
          this.deps.players,
          tick,
          runtimeMatchId,
          this.deps.raidCheckpointState(),
          { allowPendingEvents: true, ...this.zombotsOpts() },
        ),
    });
    this.recorder.ensureAttached();
    return this.recorder;
  }

  private zombotsOpts(): { zombotsRun?: CheckpointZombotsRunState } {
    const run = this.deps.zombotsCheckpointState?.();
    return run ? { zombotsRun: run } : {};
  }

  stopRecorder(): void {
    this.recorder?.shutdown();
    this.recorder = null;
  }

  /**
   * Epic 7.5 / 9.1 — named checkpoint read via `captureCheckpointState`.
   * Owner reads only (never createSnapshot / toSnapshot). Interval is 9.2-owned;
   * this tap only builds + fans out when called. Always returns the frozen
   * checkpoint to the explicit caller (driver / tests / later epics).
   */
  captureCheckpoint(
    tick: number = this.deps.players.tick,
  ): AuthoritativeCheckpoint {
    const checkpoint = captureCheckpointState(
      this.deps.players,
      tick,
      this.deps.runtimeMatchId(),
      this.deps.raidCheckpointState(),
      this.zombotsOpts(),
    );
    const sink = this.sink;
    if (sink) {
      this.payloadConstructionCount++;
      this.safeSinkCall("onCheckpoint", () => {
        sink.onCheckpoint({ tick, checkpoint });
      });
    }
    return checkpoint;
  }

  onIdentityRotated(previousRuntimeMatchId: string, tick: number): void {
    this.accessAccountIds.clear();
    // Epic 8.1: re-attach after finalize detach so rotation/init notifies land.
    this.recorder?.ensureAttached();
    // Skip bot-only and all-synthetic matches. Sticky once a real human
    // has been present. There is no per-account replay library; not opening
    // a row is what keeps a synthetic flood off disk.
    this.matchHadHuman = this.hasRecordableHuman();
    if (!this.matchHadHuman) {
      // Close any prior human-match row without opening a bot-only recording.
      this.recorder?.discardActiveWithoutRecording();
      return;
    }
    this.notifyIdentityRotated(tick, previousRuntimeMatchId);
    this.notifyMatchInit(tick);
  }

  /** True when a non-synthetic human is on the roster. */
  private hasRecordableHuman(): boolean {
    let human = false;
    for (const player of this.deps.players.all()) {
      this.rememberAccessCandidate(player);
      if (player.isBot || player.isAgent) continue;
      if (!player.synthetic) human = true;
    }
    return human;
  }

  /** Keep a real human account for the current match. Leavers stay. */
  private rememberAccessCandidate(player: {
    accountUserId?: string | null;
    isBot?: boolean;
    isAgent?: boolean;
    synthetic?: boolean;
    poolAccount?: boolean;
  }): void {
    const id = replayAccessAccountId(player);
    if (id) this.accessAccountIds.add(id);
  }

  private rememberRoster(): void {
    for (const player of this.deps.players.all()) {
      this.rememberAccessCandidate(player);
    }
  }

  /**
   * Hand the accumulated accounts to the recorder that will finalize.
   * Production sets `recorder`. Tests that only attach the recorder as
   * the sink still reach it.
   */
  private noteMatchAccess(matchId: string): void {
    const recorder = this.recorder ??
      (this.sink instanceof ReplayRecorder ? this.sink : null);
    if (!recorder) return;
    if (recorder.getActiveRuntimeMatchId() !== matchId) return;
    recorder.noteAccessAccounts(matchId, [...this.accessAccountIds]);
  }

  /**
   * Temp/dev: arm recording when the first human seats in a previously
   * bot-only match. Starts from this tick onward (no backfill).
   */
  noteHumanPresence(tick: number = this.deps.players.tick): void {
    if (this.matchHadHuman) return;
    // Synthetic joins do not arm recording. A later real human still does.
    if (!this.hasRecordableHuman()) return;
    this.matchHadHuman = true;
    const sink = this.sink;
    if (!sink) return;
    // Late start for an already-rotated identity: open a row from this tick
    // (no backfill of prior bot-only ticks).
    this.payloadConstructionCount++;
    const startPayload: ReplayLifecyclePayload = Object.freeze({
      tick,
      runtimeMatchId: this.deps.runtimeMatchId(),
      transition: "runtimeMatchIdRotated" as const,
    });
    this.safeSinkCall("runtimeMatchIdRotated", () => {
      sink.onMatchStart(startPayload);
    });
    this.notifyMatchInit(tick);
    if (this.deps.players.isLive()) this.notifyMatchStart(tick);
  }

  /**
   * Epic 7.5 — exception-isolated sink invoke. Throws never reach the tick loop.
   */
  private safeSinkCall(label: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.sinkErrorCount++;
      console.error(`[replay-sink] ${label} threw (isolated):`, err);
    }
  }

  /**
   * Epic 7.5 — identity rotation notice.
   * Delivered through `onMatchStart` with `transition: "runtimeMatchIdRotated"`
   * (no dedicated callback on the sink; sinks branch on `payload.transition`).
   */
  private notifyIdentityRotated(
    tick: number,
    previousRuntimeMatchId: string,
  ): void {
    const sink = this.sink;
    if (!sink) return;
    this.payloadConstructionCount++;
    const payload: ReplayLifecyclePayload = Object.freeze({
      tick,
      runtimeMatchId: this.deps.runtimeMatchId(),
      transition: "runtimeMatchIdRotated" as const,
      previousRuntimeMatchId,
    });
    this.safeSinkCall("runtimeMatchIdRotated", () => {
      sink.onMatchStart(payload);
    });
  }

  private notifyMatchInit(tick: number): void {
    const sink = this.sink;
    if (!sink) return;
    this.payloadConstructionCount++;
    const initRaw = this.deps.players.buildMatchInitEvent(tick);
    if (initRaw.kind !== "matchInit") {
      console.error(
        "[replay-sink] buildMatchInitEvent did not return matchInit",
      );
      return;
    }
    const initEvent = initRaw as MatchInitEvent;
    const meta = this.deps.matchMetadata(tick);
    if (!meta.ok) {
      console.warn(
        `[replay-sink] getMatchMetadata failed at init tick=${tick}: ${meta.reason}`,
      );
      return;
    }
    this.safeSinkCall("onMatchInit", () => {
      sink.onMatchInit({
        initEvent: Object.freeze({ ...initEvent }),
        metadata: Object.freeze({ ...meta.metadata }),
      });
    });
  }

  /**
   * Epic 7.5 — live-entry lifecycle. Call at driver match-start rows when the
   * match is actually live (not ranked prematch warm-up).
   */
  notifyMatchStart(tick: number): void {
    const sink = this.sink;
    if (!sink || !this.matchHadHuman || !this.deps.players.isLive()) return;
    this.payloadConstructionCount++;
    const payload: ReplayLifecyclePayload = Object.freeze({
      tick,
      runtimeMatchId: this.deps.runtimeMatchId(),
      transition: "matchStart" as const,
    });
    this.safeSinkCall("onMatchStart", () => {
      sink.onMatchStart(payload);
    });
  }

  notifyMatchEnded(packet: GameOverPacket, tick: number): void {
    const sink = this.sink;
    if (!sink) return;
    this.rememberRoster();
    this.noteMatchAccess(this.deps.runtimeMatchId());
    // Bot-only matches never opened a row; recorder beginFinalize no-ops.
    // Still fan out so non-recorder sinks (and tests) observe the end.
    this.payloadConstructionCount++;
    const isDraw = packet.winner === "draw";
    const payload: ReplayLifecyclePayload = Object.freeze({
      tick,
      runtimeMatchId: this.deps.runtimeMatchId(),
      transition: isDraw ? "matchDraw" as const : "matchEnd" as const,
    });
    this.safeSinkCall(isDraw ? "onMatchDraw" : "onMatchEnd", () => {
      if (isDraw) sink.onMatchDraw(payload);
      else sink.onMatchEnd(payload);
    });
  }

  /**
   * Epic 7.5 / 9.2: end/draw sink notify.
   * Inside stepSim → store the packet until {@link flushPendingEnd}.
   * Outside stepSim (tests / leave-to-empty raid) → notify immediately.
   */
  deferMatchEnd(packet: GameOverPacket): void {
    if (this.inStep) {
      this.pendingMatchEnd = packet;
    } else {
      this.notifyMatchEnded(packet, this.deps.players.tick);
    }
  }

  flushPendingEnd(tick: number = this.deps.players.tick): void {
    const packet = this.pendingMatchEnd;
    if (!packet) return;
    this.pendingMatchEnd = null;
    this.notifyMatchEnded(packet, tick);
  }

  deliverTick(
    tick: number,
    events: ReadonlyArray<AuthoritativeEvent>,
  ): void {
    const sink = this.sink;
    if (!sink) return;
    this.payloadConstructionCount++;
    const inputs = new Map<string, TickSelectedInput | null>();
    for (const p of this.deps.players.all()) {
      inputs.set(p.id, p.lastTickInputSelection());
      this.rememberAccessCandidate(p);
    }
    Object.freeze(inputs);
    // Drain action notes accumulated at handle* since the prior fan-out
    // (includes between-tick immediates stamped with an earlier tick).
    const actions = Object.freeze(this.actionEffects.slice());
    this.actionEffects = [];
    const eventsView = Object.freeze(events.slice());
    this.safeSinkCall("onTick", () => {
      sink.onTick({
        tick,
        inputs,
        actions,
        events: eventsView,
      });
    });
  }

  enterStep(): void {
    this.inStep = true;
  }

  exitStep(): void {
    this.inStep = false;
  }
}
