/**
  * Epic 8.1–8.6 — ReplayRecorder: owns the 7.5 sink subscription, durable
 * lifecycle rows, in-memory 8.2–8.4 capture, the bounded 8.5 session buffer,
 * and 8.6 finalization (sole writer of status=`finalized`).
 *
 * Contract:
 * - 8.1 lifecycle (see 08-01-recorder-lifecycle.md): counters + row status.
 * - 8.2 initial state (see 08-02-initial-state-recording.md): fills recordInit
 *   with a frozen MatchInitEvent + MatchMetadata capture; exposes
 *   getInitialState(runtimeMatchId). Memory-only until 8.6 finalizes.
 * - 8.3 inputs (see 08-03-input-recording.md): fills recordInputs with frozen
 *   per-tick movement + action rows; exposes getTickInputs / getInputStream.
 * - 8.4 events (see 08-04-event-recording.md): fills recordEvents with frozen
 *   drain-order authoritative event lists; exposes getTickEvents / getEventStream.
 * - 8.5 buffering (see 08-05-replay-buffering.md): one ReplaySessionBuffer per
 *   runtimeMatchId holds frozen 8.2–8.4 objects by reference; caps fail loud;
 *   getBufferedSession / getTailWindow for 8.6 / 12.7; no file I/O on tick path.
 * * * - 8.6 finalization (see 08-06-replay-finalization.md): after beginFinalize
 *   parks the row at `finalizing` and detaches, completeFinalization claims the
 *   intact session, serializes provisional bytes, and uploads via
 *   ReplayLifecycleClient.finalize (authority writes blob + stamps `finalized`).
 *   Partway failure → `failed` + cleanup; never `finalized` without a verified
 *   file. Crash sweep runs on authority boot, not in the runtime.
 * - 9.2 checkpoints (see 09-02-checkpoint-creation.md): interval gate inside
 *   onTick (anchor + every N ticks + final before beginFinalize) calls the 9.1
 *   builder verbatim, stores frozen frames in the 8.5 session buffer, counts,
 *   and forwards to an injectable hook. Schedule state resets on rotation.
 * - 9.5 checkpoint index (see 09-05-checkpoint-indexing.md): each captured
 *   frame is fed into a per-match CheckpointIndex (tick-keyed floor lookup).
 *   Index lives and dies with the recording session; no seek/step/bytes here.
 * - Implements ReplayIntegrationSink; nothing else attaches for recording.
 * - Methods never throw into the game loop (errors → error_count / markFailed).
 */

import type {
  ReplayCounterPatch,
  ReplayLifecycleStatus,
} from "../shared/replay/replayLifecycle.ts";
import type { ReplayLifecycleClient } from "./replayLifecycleClient.ts";
import { serializeReplaySession } from "./serializeReplaySession.ts";
import type {
  ReplayCheckpointPayload,
  ReplayIntegrationSink,
  ReplayLifecyclePayload,
  ReplayMatchInitPayload,
  ReplayTickPayload,
} from "./replayIntegration.ts";
import type { AuthoritativeCheckpoint } from "./authoritativeCheckpoint.ts";
import {
  checkpointIntervalFromEnv,
  resolveCheckpointInterval,
  type CheckpointIntervalConfig,
} from "./checkpointInterval.ts";
import { CheckpointIndex } from "./checkpointIndex.ts";
import {
  captureRecordedInitialState,
  type RecordedInitialState,
} from "./recordedInitialState.ts";
import {
  captureRecordedTickInputs,
  freezeRecordedTickInputs,
  type RecordedActionRow,
  type RecordedTickInputs,
} from "./recordedTickInputs.ts";
import {
  captureRecordedTickEvents,
  EMPTY_RECORDED_EVENTS,
  freezeRecordedTickEvents,
  matchInitAgreesWithSlot,
  type RecordedTickEvents,
} from "./recordedTickEvents.ts";
import type { MatchInitEvent } from "../shared/sim/authoritativeEvent.ts";
import {
  ReplaySessionBuffer,
  type ReplayBufferCaps,
  type ReplayBufferedSessionView,
  type ReplaySessionBufferOptions,
  type ReplayTailWindow,
} from "./replaySessionBuffer.ts";

export type {
  RecordedInitialState,
  RecordedActionRow,
  RecordedTickInputs,
  RecordedTickEvents,
};

export type {
  ReplayBufferCaps,
  ReplayBufferedSessionView,
  ReplayTailWindow,
};

export {
  MAX_BUFFERED_BYTES_EST,
  MAX_BUFFERED_TICKS,
  MAX_RECORDING_TICKS,
  DEFAULT_REPLAY_BUFFER_CAPS,
  ReplaySessionBuffer,
} from "./replaySessionBuffer.ts";

export {
  CheckpointIndex,
  CheckpointIndexCrossMatchError,
  CheckpointIndexDuplicateTickError,
  CheckpointIndexOutOfOrderError,
  tickToTimeMs,
  timeMsToTick,
  tickToTimeSec,
} from "./checkpointIndex.ts";
export type {
  CheckpointIndexHit,
  CheckpointIndexLookup,
  CheckpointIndexMiss,
} from "./checkpointIndex.ts";

/**
 * Consecutive onTick failures before markFailed.
 * Lifecycle-write failures fail immediately (threshold effectively 1).
 */
export const REPLAY_RECORDER_TICK_ERROR_THRESHOLD = 3;

export type ReplayRecorderDeps = {
  /**
   * Authority-backed (or in-memory test) lifecycle persistence.
   * Official runtimes use HttpReplayLifecycleClient; never a local SQLite handle.
   */
  lifecycle: ReplayLifecycleClient;
  /** Attach this recorder as the GameServer sink. */
  attachSink: (sink: ReplayIntegrationSink) => void;
  /** Detach the GameServer sink (7.5 no-sink fast path). */
  detachSink: () => void;
  /** Optional 8.5 buffer cap overrides (tests pin small limits). */
  bufferCaps?: Partial<ReplayBufferCaps>;
  /** Optional 8.5 pressure hook forwarded to ReplaySessionBuffer. */
  bufferBeforeCommit?: () => void;
  /** Test-only: override provisional serialization. */
  serializeSession?: (session: ReplayBufferedSessionView) => Uint8Array;
  /**
   * Epic 9.2 — build a frozen AuthoritativeCheckpoint at due ticks.
   * Wired from GameServer to `captureCheckpointState(players, tick, id)`.
   * When omitted (unit tests that do not exercise checkpoints), the schedule
   * gate performs zero builder work.
   */
  captureCheckpointState?: (
    tick: number,
    runtimeMatchId: string,
  ) => AuthoritativeCheckpoint;
  /**
   * Full authoritative state at recording start (8.2 `startCheckpoint`),
   * read beside the init payload — recordings usually start mid-match.
   * Separate from the 9.2 schedule builder: no counters, no buffer put.
   * Omitted ⇒ initial state carries init + metadata only.
   */
  captureStartState?: (
    tick: number,
    runtimeMatchId: string,
  ) => AuthoritativeCheckpoint;
  /**
   * Epic 9.2 — injectable observer of each captured checkpoint (after the
   * frame is stored in the 8.5 session buffer). Default no-op.
   */
  onCheckpointCaptured?: (checkpoint: AuthoritativeCheckpoint) => void;
  /**
   * Epic 9.2 — interval in seconds. Validated once at construct.
   * Omit to read REPLAY_CHECKPOINT_INTERVAL_SECONDS (or shipped default).
   */
  checkpointIntervalSeconds?: number;
};

type ActiveRecording = {
  rowId: number;
  runtimeMatchId: string;
  /** True after a live `matchStart` transition for this id. */
  reachedLive: boolean;
  ticksObserved: number;
  inputTicks: number;
  eventTicks: number;
  errorCount: number;
  consecutiveTickErrors: number;
  /** Tick at which onMatchInit arrived (provenance for 8.2). */
  initTick: number | null;
  /** Bounded 8.5 session buffer holding frozen 8.2–8.4 captures. */
  buffer: ReplaySessionBuffer;
  /** Epic 9.2 — true after the anchor checkpoint for this runtimeMatchId. */
  checkpointAnchorCaptured: boolean;
  /** Epic 9.2 — successful captures this session. */
  checkpointCapturedCount: number;
  /** Epic 9.2 — tick of the most recent successful capture (-1 if none). */
  checkpointLastTick: number;
  /** Epic 9.2 — builder throws counted for this session. */
  checkpointErrorCount: number;
  /** Epic 9.5 — tick-keyed index of captured frames (one runtimeMatchId). */
  checkpointIndex: CheckpointIndex;
};

/**
 * Named recorder for epic 8.1. Construct once per GameServer when recording
 * is enabled; call {@link ReplayRecorder.sweepAbandoned} at store open / boot.
 */
export class ReplayRecorder implements ReplayIntegrationSink {
  private readonly lifecycle: ReplayLifecycleClient;
  private readonly attachSink: (sink: ReplayIntegrationSink) => void;
  private readonly detachSink: () => void;
  private readonly bufferCaps: Partial<ReplayBufferCaps> | undefined;
  private readonly bufferBeforeCommit: (() => void) | undefined;
  private readonly serializeSession:
    | ((session: ReplayBufferedSessionView) => Uint8Array)
    | undefined;
  /** Epic 9.2 — optional builder; absent ⇒ schedule gate skips capture. */
  private readonly captureCheckpointState:
    | ((tick: number, runtimeMatchId: string) => AuthoritativeCheckpoint)
    | undefined;
  /** 8.2 — optional recording-start state builder. */
  private readonly captureStartState:
    | ((tick: number, runtimeMatchId: string) => AuthoritativeCheckpoint)
    | undefined;
  /** Epic 9.2 — injectable hook; default drops. */
  private readonly onCheckpointCaptured:
    | ((checkpoint: AuthoritativeCheckpoint) => void)
    | undefined;
  /** Epic 9.2 — validated interval (seconds → ticks). */
  private readonly checkpointInterval: CheckpointIntervalConfig;

  private active: ActiveRecording | null = null;
  /**
   * Intact buffer parked at normal end for 8.6 `getBufferedSession` claim.
   * Cleared on claim discard, fail, rotation, or shutdown. Never holds a
   * failed/abandoned session as finalizable.
   */
  private pendingFinalize: ReplaySessionBuffer | null = null;
  private attached = false;
  /** Duplicate matchStart (same id) observations. */
  private duplicateStartCount = 0;
  /** end-without-start / other no-op observations. */
  private noopCount = 0;
  /** Serializes async lifecycle HTTP/DB ops so sink methods stay sync. */
  private persistChain: Promise<void> = Promise.resolve();

  constructor(deps: ReplayRecorderDeps) {
    this.lifecycle = deps.lifecycle;
    this.attachSink = deps.attachSink;
    this.detachSink = deps.detachSink;
    this.bufferCaps = deps.bufferCaps;
    this.bufferBeforeCommit = deps.bufferBeforeCommit;
    this.serializeSession = deps.serializeSession;
    this.captureCheckpointState = deps.captureCheckpointState;
    this.captureStartState = deps.captureStartState;
    this.onCheckpointCaptured = deps.onCheckpointCaptured;
    this.checkpointInterval =
      deps.checkpointIntervalSeconds != null
        ? resolveCheckpointInterval(deps.checkpointIntervalSeconds)
        : checkpointIntervalFromEnv();
  }

  /** Drain in-flight lifecycle persistence (tests / shutdown). */
  whenIdle(): Promise<void> {
    return this.persistChain;
  }

  private enqueuePersist(op: () => Promise<void>): void {
    this.persistChain = this.persistChain.then(op).catch((err) => {
      console.error("[replay-recorder] persist failed:", err);
    });
  }

  /**
   * @deprecated Crash recovery lives on authority boot. Kept as a no-op so
   * older call sites compile; always returns 0.
   */
  sweepAbandoned(): number {
    return 0;
  }

  /**
   * Ensure this recorder is the attached 7.5 sink.
   * Called from GameServer before identity rotation so init/start notifies land.
   */
  ensureAttached(): void {
    if (this.attached) return;
    this.attachSink(this);
    this.attached = true;
  }

  /** Test/observability. */
  isAttached(): boolean {
    return this.attached;
  }

  getActiveRuntimeMatchId(): string | null {
    return this.active?.runtimeMatchId ?? null;
  }

  /**
   * Close an open row without opening a replacement (e.g. rotating into a
   * bot-only match that will not be recorded). Uses the same failed/abandoned
   * disposition as closePriorRowForNewId.
   */
  discardActiveWithoutRecording(): void {
    this.safe("discardActiveWithoutRecording", () => {
      this.closePriorRowForNewId();
    }, { lifecycle: true });
  }

  getDuplicateStartCount(): number {
    return this.duplicateStartCount;
  }

  getNoopCount(): number {
    return this.noopCount;
  }

  getActiveCounters(): ReplayCounterPatch | null {
    if (!this.active) return null;
    return {
      ticksObserved: this.active.ticksObserved,
      inputTicks: this.active.inputTicks,
      eventTicks: this.active.eventTicks,
      errorCount: this.active.errorCount,
    };
  }

  getInitTick(): number | null {
    return this.active?.initTick ?? null;
  }

  /**
   * Epic 8.2 — frozen initial-state capture for `runtimeMatchId`.
   * Returns null when no active session holds that id (miss, terminal
   * disposition, or capture not yet taken). Accessor returns the frozen
   * object; callers must not mutate it (Object.isFrozen).
   */
  getInitialState(runtimeMatchId: string): RecordedInitialState | null {
    if (!this.active || this.active.runtimeMatchId !== runtimeMatchId) {
      return null;
    }
    return this.active.buffer.init;
  }

  /**
   * Epic 8.3 — frozen per-tick input capture for `runtimeMatchId` at `tick`.
   * Returns null when no active session holds that id/tick (miss, terminal
   * disposition, or tick not yet captured). Accessor returns the frozen
   * object; callers must not mutate it (Object.isFrozen).
   */
  getTickInputs(
    runtimeMatchId: string,
    tick: number,
  ): RecordedTickInputs | null {
    if (!this.active || this.active.runtimeMatchId !== runtimeMatchId) {
      return null;
    }
    return this.active.buffer.getInputs(tick) ?? null;
  }

  /**
   * Epic 8.3 — full frozen input stream for `runtimeMatchId`, ordered by tick.
   * Returns null when no active session holds that id. Entries are frozen;
   * the returned array is a fresh shallow copy of references (not live Map).
   */
  getInputStream(runtimeMatchId: string): ReadonlyArray<RecordedTickInputs> | null {
    if (!this.active || this.active.runtimeMatchId !== runtimeMatchId) {
      return null;
    }
    return this.active.buffer.orderedInputs();
  }

  /**
   * 8.4 accessor: frozen events for one draining tick, or synthesized empty
   * list when the session is live but that tick stored nothing (sparse).
   * Returns null when no session holds `runtimeMatchId`.
   */
  getTickEvents(
    runtimeMatchId: string,
    tick: number,
  ): RecordedTickEvents | null {
    if (!this.active || this.active.runtimeMatchId !== runtimeMatchId) {
      return null;
    }
    const row = this.active.buffer.getEvents(tick);
    if (row) return row;
    return freezeRecordedTickEvents(tick, EMPTY_RECORDED_EVENTS);
  }

  /**
   * 8.4 accessor: frozen event rows for every draining tick that stored a
   * non-empty list, sorted by tick. Null when no session holds the id.
   */
  getEventStream(
    runtimeMatchId: string,
  ): ReadonlyArray<RecordedTickEvents> | null {
    if (!this.active || this.active.runtimeMatchId !== runtimeMatchId) {
      return null;
    }
    return this.active.buffer.orderedEvents();
  }

  /**
   * Epic 9.2 — frozen checkpoint at `tick` for `runtimeMatchId`.
   * Returns null on miss / wrong id / not yet captured.
   */
  getCheckpoint(
    runtimeMatchId: string,
    tick: number,
  ): AuthoritativeCheckpoint | null {
    if (!this.active || this.active.runtimeMatchId !== runtimeMatchId) {
      return null;
    }
    return this.active.buffer.getCheckpoint(tick) ?? null;
  }

  /**
   * Epic 9.2 — ordered checkpoint stream for `runtimeMatchId`.
   * Returns null when no active session holds that id.
   */
  getCheckpointStream(
    runtimeMatchId: string,
  ): ReadonlyArray<AuthoritativeCheckpoint> | null {
    if (!this.active || this.active.runtimeMatchId !== runtimeMatchId) {
      return null;
    }
    return this.active.buffer.orderedCheckpoints();
  }

  /**
   * Epic 9.5 — per-match checkpoint index (tick-keyed floor lookup).
   * Lives only while the recording is active; null after finalize/detach.
   */
  getCheckpointIndex(runtimeMatchId: string): CheckpointIndex | null {
    if (!this.active || this.active.runtimeMatchId !== runtimeMatchId) {
      return null;
    }
    return this.active.checkpointIndex;
  }

  /**
   * Epic 8.5 — frozen view of the buffered session for `runtimeMatchId`.
   * Returns the active recording buffer or the parked finalizing buffer.
   * `finalizable` is true only when status is `finalizing` (8.6 claim).
   * Miss / discarded / failed sessions return null.
   */
  getBufferedSession(
    runtimeMatchId: string,
  ): ReplayBufferedSessionView | null {
    const buf = this.bufferFor(runtimeMatchId);
    if (!buf || buf.status === "discarded" || buf.status === "failed") {
      return null;
    }
    return buf.toView();
  }

  /**
   * Epic 8.5 / 12.7 — live-tail window over the same recording buffer.
   * Only while `recording`; never mutates or evicts. Null on miss.
   */
  getTailWindow(
    runtimeMatchId: string,
    fromTick: number,
  ): ReplayTailWindow | null {
    if (!this.active || this.active.runtimeMatchId !== runtimeMatchId) {
      return null;
    }
    return this.active.buffer.getTailWindow(fromTick);
  }

  /** Observable 8.5 usage for 19.x measurement hooks. */
  getBufferUsage(
    runtimeMatchId: string,
  ): { usageTicks: number; usageBytesEstimate: number } | null {
    const buf = this.bufferFor(runtimeMatchId);
    if (!buf || buf.status === "discarded") return null;
    return {
      usageTicks: buf.usageTicks,
      usageBytesEstimate: buf.usageBytesEstimate,
    };
  }

  /**
   * Start (or no-op) a recording for `runtimeMatchId`.
   * Invoked from onMatchStart on rotation / live start (7.2 transitions).
   */
  startRecording(runtimeMatchId: string, _tick: number): void {
    this.safe("startRecording", () => {
      this.ensureAttached();

      if (this.active?.runtimeMatchId === runtimeMatchId) {
        this.duplicateStartCount++;
        return;
      }

      if (this.active) {
        this.closePriorRowForNewId();
      }

      // Local session starts immediately so ticks buffer while the authority
      // insert is in flight. rowId 0 means "pending durable row".
      this.active = {
        rowId: 0,
        runtimeMatchId,
        reachedLive: false,
        ticksObserved: 0,
        inputTicks: 0,
        eventTicks: 0,
        errorCount: 0,
        consecutiveTickErrors: 0,
        initTick: null,
        buffer: this.createBuffer(runtimeMatchId),
        checkpointAnchorCaptured: false,
        checkpointCapturedCount: 0,
        checkpointLastTick: -1,
        checkpointErrorCount: 0,
        checkpointIndex: new CheckpointIndex(),
      };

      this.enqueuePersist(async () => {
        const existing = await this.lifecycle.getByRuntimeMatchId(
          runtimeMatchId,
        );
        if (existing) {
          if (
            existing.status === "recording" &&
            this.active?.runtimeMatchId === runtimeMatchId
          ) {
            this.active.rowId = existing.id;
            this.active.ticksObserved = existing.ticksObserved;
            this.active.inputTicks = existing.inputTicks;
            this.active.eventTicks = existing.eventTicks;
            this.active.errorCount = existing.errorCount;
            return;
          }
          // Non-recording existing row: drop local session.
          if (this.active?.runtimeMatchId === runtimeMatchId) {
            this.active.buffer.discard();
            this.active = null;
            this.noopCount++;
          }
          return;
        }

        const row = await this.lifecycle.insertRecording(runtimeMatchId);
        if (this.active?.runtimeMatchId === runtimeMatchId) {
          this.active.rowId = row.id;
        }
      });
    }, { lifecycle: true });
  }

  /**
   * Normal match end → park `finalizing`, detach sink, then run 8.6
   * completeFinalization inline (serialize + put + stamp). Off the tick path.
   */
  beginFinalize(_tick: number, reason: "matchEnd" | "matchDraw"): void {
    let parked = false;
    let runtimeMatchId: string | null = null;
    this.safe("beginFinalize", () => {
      if (!this.active) {
        this.noopCount++;
        return;
      }
      const counters = this.counterPatch();
      runtimeMatchId = this.active.runtimeMatchId;
      const pendingRowId = this.active.rowId;
      // Park intact buffer for 8.6 claim; 8.2–8.4 accessors miss after detach.
      this.active.buffer.freezeForFinalize();
      this.discardPendingFinalize();
      this.pendingFinalize = this.active.buffer;
      this.active = null;
      this.detach();
      parked = true;

      this.enqueuePersist(async () => {
        const rowId = await this.resolveRowId(runtimeMatchId!, pendingRowId);
        if (rowId == null) {
          this.failFinalizingClaim(
            0,
            "beginFinalize: missing durable row",
          );
          return;
        }
        await this.lifecycle.update(rowId, {
          status: "finalizing",
          error: `beginFinalize:${reason}`,
          counters,
        });
        await this.completeFinalizationAsync(rowId);
      });
    }, { lifecycle: true });
    void parked;
  }

  /**
   * Abnormal failure → `failed`, detach sink.
   * Also covers a parked finalizing session when finalization fails mid-flight.
   * Clean shutdown mid-match also uses this (known outcome).
   */
  markFailed(error: string, _tick?: number): void {
    this.safe("markFailed", () => {
      const note = truncateError(error);
      if (this.active) {
        const counters = this.counterPatch();
        const runtimeMatchId = this.active.runtimeMatchId;
        const pendingRowId = this.active.rowId;
        this.active.buffer.markFailed();
        this.active.buffer.discard();
        this.discardPendingFinalize();
        this.active = null;
        this.detach();
        this.enqueuePersist(async () => {
          const rowId = await this.resolveRowId(runtimeMatchId, pendingRowId);
          if (rowId == null) return;
          await this.lifecycle.update(rowId, {
            status: "failed",
            error: note,
            counters,
          });
        });
        return;
      }
      if (this.pendingFinalize) {
        const runtimeMatchId = this.pendingFinalize.runtimeMatchId;
        this.pendingFinalize.markFailed();
        this.discardPendingFinalize();
        this.enqueuePersist(async () => {
          const row = await this.lifecycle.getByRuntimeMatchId(runtimeMatchId);
          if (
            row &&
            (row.status === "finalizing" || row.status === "recording")
          ) {
            await this.lifecycle.update(row.id, {
              status: "failed",
              error: note,
            });
          }
        });
        return;
      }
      this.noopCount++;
    }, { lifecycle: true, rethrow: false });
  }

  /**
   * Epic 8.6 — sole path that may mark a row `finalized`.
   * Serializes the parked session and uploads via lifecycle.finalize
   * (authority writes the blob and stamps). Sync entry for tests; production
   * goes through beginFinalize's persist queue.
   */
  completeFinalization(rowId: number): void {
    this.enqueuePersist(async () => {
      await this.completeFinalizationAsync(rowId);
    });
  }

  private async completeFinalizationAsync(rowId: number): Promise<void> {
    try {
      const session = this.pendingFinalize
        ? this.getBufferedSession(this.pendingFinalize.runtimeMatchId)
        : null;
      if (
        !session ||
        !session.finalizable ||
        session.status !== "finalizing" ||
        !session.init
      ) {
        await this.failFinalizingClaimAsync(
          rowId,
          "finalize-claim-failed: truncated-or-missing-session",
        );
        return;
      }

      let bytes: Uint8Array;
      try {
        bytes = (this.serializeSession ?? serializeReplaySession)(session);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.failFinalizingClaimAsync(
          rowId,
          `finalize-write-failed: ${message}`,
        );
        return;
      }
      if (bytes.byteLength === 0) {
        await this.failFinalizingClaimAsync(
          rowId,
          "finalize-verify-failed: empty-bytes",
        );
        return;
      }

      try {
        await this.lifecycle.finalize({
          rowId,
          runtimeMatchId: session.runtimeMatchId,
          bytes,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.failFinalizingClaimAsync(
          rowId,
          `finalize-write-failed: ${message}`,
        );
        return;
      }

      this.discardPendingFinalize();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[replay-recorder] completeFinalization failed:", err);
      await this.failFinalizingClaimAsync(
        rowId,
        `finalize-write-failed: ${message}`,
      );
    }
  }

  /** Fail a finalizing claim: discard parked buffer + mark row failed. */
  private failFinalizingClaim(rowId: number, reason: string): void {
    this.enqueuePersist(async () => {
      await this.failFinalizingClaimAsync(rowId, reason);
    });
  }

  private async failFinalizingClaimAsync(
    rowId: number,
    reason: string,
  ): Promise<void> {
    const note = truncateError(reason);
    if (this.pendingFinalize) {
      this.pendingFinalize.markFailed();
      this.discardPendingFinalize();
    }
    if (rowId <= 0) return;
    try {
      await this.lifecycle.update(rowId, { status: "failed", error: note });
    } catch (err) {
      console.error(
        "[replay-recorder] failFinalizingClaim persist failed:",
        err,
      );
    }
  }

  /** Resolve a durable row id, waiting for an in-flight insert when needed. */
  private async resolveRowId(
    runtimeMatchId: string,
    knownId: number,
  ): Promise<number | null> {
    if (knownId > 0) return knownId;
    // Allow the start insert on this same persist chain to finish first by
    // re-reading; callers enqueue after start, so prior ops have completed.
    const row = await this.lifecycle.getByRuntimeMatchId(runtimeMatchId);
    return row?.id ?? null;
  }

  /** Clean shutdown: fail any open recording/finalizing row, detach, leave store to caller. */
  shutdown(): void {
    if (this.active || this.pendingFinalize) {
      this.markFailed("clean-shutdown");
    } else {
      this.detach();
    }
  }

  // --- ReplayIntegrationSink -----------------------------------------------

  onMatchInit(payload: Readonly<ReplayMatchInitPayload>): void {
    // Capture failure is a lifecycle abort (no silent partial initial state).
    this.safe("onMatchInit", () => {
      if (!this.active) return;
      const tick = payload.initEvent.appliedTick;
      this.active.initTick = tick;
      this.recordInit(payload);
    }, { lifecycle: true });
  }

  onMatchStart(payload: Readonly<ReplayLifecyclePayload>): void {
    this.safe("onMatchStart", () => {
      const { runtimeMatchId, tick, transition } = payload;

      if (transition === "runtimeMatchIdRotated") {
        this.startRecording(runtimeMatchId, tick);
        return;
      }

      if (transition === "matchStart") {
        this.startRecording(runtimeMatchId, tick);
        if (this.active?.runtimeMatchId === runtimeMatchId) {
          this.active.reachedLive = true;
        }
        return;
      }

      // matchEnd / matchDraw should not arrive via onMatchStart.
      this.noopCount++;
    });
  }

  onMatchEnd(payload: Readonly<ReplayLifecyclePayload>): void {
    // 9.2 final capture before beginFinalize detaches (skip if already due).
    this.safe("onMatchEnd.finalCheckpoint", () => {
      this.captureFinalCheckpointIfNeeded(payload.tick);
    }, { tick: true });
    this.beginFinalize(payload.tick, "matchEnd");
  }

  onMatchDraw(payload: Readonly<ReplayLifecyclePayload>): void {
    this.safe("onMatchDraw.finalCheckpoint", () => {
      this.captureFinalCheckpointIfNeeded(payload.tick);
    }, { tick: true });
    this.beginFinalize(payload.tick, "matchDraw");
  }

  onTick(payload: Readonly<ReplayTickPayload>): void {
    this.safe("onTick", () => {
      if (!this.active) return;
      this.active.ticksObserved++;
      this.active.inputTicks++;
      this.active.eventTicks++;
      this.recordInputs(payload);
      this.recordEvents(payload);
      // 8.5: O(1) commit + cap/duration check. Fail loud immediately — never
      // leave a truncated session readable as finalizable. Loop never waits.
      const commit = this.active.buffer.commitTick();
      if (!commit.ok) {
        this.failActiveRow(commit.reason);
        return;
      }
      this.active.consecutiveTickErrors = 0;
      // 9.2: post-drain boundary (onTick is fanned out after 7.3 drain).
      // Off-schedule: O(1) modulo/anchor check only.
      this.maybeCaptureCheckpoint(payload.tick);
    }, { tick: true });
  }

  onCheckpoint(payload: Readonly<ReplayCheckpointPayload>): void {
    this.safe("onCheckpoint", () => {
      if (!this.active) return;
      this.recordCheckpoint(payload);
    });
  }

  // --- Content hooks (8.2–8.4 capture → 8.5 buffer) --------------------------------

  /**
   * 8.2 — capture init-tick payload content into session memory.
   * Validates map version + load-bearing agreement, deep-freezes, stores on
   * the active row. Throws on failure so onMatchInit marks the row failed.
   */
  protected recordInit(payload: Readonly<ReplayMatchInitPayload>): void {
    if (!this.active) return;
    // Same instant as the init read: full state for mid-match starts.
    const startCheckpoint = this.captureStartState?.(
      payload.initEvent.appliedTick,
      this.active.runtimeMatchId,
    );
    const result = captureRecordedInitialState(
      payload,
      this.active.runtimeMatchId,
      startCheckpoint,
    );
    if (!result.ok) {
      throw new Error(result.reason);
    }
    // Rotation replaces prior capture via new ActiveRecording/buffer;
    // empty-ranked reset without rotation keeps this same buffer.
    this.active.buffer.setInit(result.state);
  }

  /**
   * 8.3 — capture per-tick input family into session memory.
   * Movement and actions are keyed by the envelope tick; each action keeps its
   * own effect tick (between-tick immediates carry the prior tick).
   * Throws on structural gaps so onTick error accounting / threshold apply.
   */
  protected recordInputs(payload: Readonly<ReplayTickPayload>): void {
    if (!this.active) return;
    const result = captureRecordedTickInputs(payload);
    if (!result.ok) {
      throw new Error(result.reason);
    }

    const buffer = this.active.buffer;

    // Every action stays in the envelope bucket in drain order, keeping its
    // own effect tick. Between-tick immediates (reload / switch / ability,
    // stamped with the prior tick) ran live *after* that tick's MovePhysics,
    // so filing them under the earlier bucket would replay them one tick
    // early. Replay applies them at the start of the envelope tick instead.
    const envelopePrior = buffer.getInputs(result.tick);
    const baseOrdinal = envelopePrior?.actions.length ?? 0;
    const envelopeActions = [
      ...(envelopePrior?.actions ?? []),
      ...result.actions.map((a, i) => ({ ...a, ordinal: baseOrdinal + i })),
    ];
    for (const action of result.actions) {
      if (action.tick > result.tick) {
        throw new Error(
          `action tick ${action.tick} is after envelope ${result.tick}`,
        );
      }
    }
    buffer.putInputs(
      freezeRecordedTickInputs(result.tick, result.movement, envelopeActions),
    );
  }

  /** 8.4 — capture per-tick event family (order included). */
  protected recordEvents(payload: Readonly<ReplayTickPayload>): void {
    if (!this.active) return;
    const result = captureRecordedTickEvents(payload);
    if (!result.ok) {
      throw new Error(result.reason);
    }

    for (const init of result.divertedMatchInits) {
      this.divertMatchInit(init);
    }

    // Sparse: event-free ticks (after divert) store nothing.
    if (result.events.length === 0) return;

    if (this.active.buffer.getEvents(result.tick)) {
      throw new Error(`duplicate event list for tick ${result.tick}`);
    }

    this.active.buffer.putEvents(
      freezeRecordedTickEvents(result.tick, result.events),
    );
  }

  /**
   * 8.4 / 8.2 handoff: a `matchInit` in the tick-event family never joins the
   * event stream. Agree with the existing 8.2 slot or fail loud.
   */
  private divertMatchInit(init: MatchInitEvent): void {
    if (!this.active) return;
    const slot = this.active.buffer.init;
    if (!slot) {
      throw new Error(
        "matchInit in tick stream without prior 8.2 capture",
      );
    }
    if (!matchInitAgreesWithSlot(slot.init, init)) {
      throw new Error(
        "matchInit in tick stream disagrees with 8.2 slot",
      );
    }
  }

  /**
   * Epic 9.2 — receive path for an already-built checkpoint (e.g. manual
   * GameServer.captureCheckpoint). Schedule-driven captures go through
   * maybeCaptureCheckpoint → captureDueCheckpoint instead.
   */
  protected recordCheckpoint(
    payload: Readonly<ReplayCheckpointPayload>,
  ): void {
    this.forwardCapturedCheckpoint(payload.checkpoint);
  }

  /** Epic 9.2 — validated interval config (seconds + ticks). */
  getCheckpointInterval(): CheckpointIntervalConfig {
    return this.checkpointInterval;
  }

  /** Epic 9.2 — session checkpoint counters (null when no active row). */
  getCheckpointCounters(): {
    capturedCount: number;
    lastTick: number;
    errorCount: number;
    anchorCaptured: boolean;
  } | null {
    if (!this.active) return null;
    return {
      capturedCount: this.active.checkpointCapturedCount,
      lastTick: this.active.checkpointLastTick,
      errorCount: this.active.checkpointErrorCount,
      anchorCaptured: this.active.checkpointAnchorCaptured,
    };
  }

  /**
   * Epic 9.2 schedule gate (Decision 1–3):
   * due ⟺ anchor-pending OR tick % intervalTicks === 0.
   * Off-schedule is O(1). No builder when dep missing or not recording.
   */
  private maybeCaptureCheckpoint(tick: number): void {
    if (!this.active) return;
    if (!this.captureCheckpointState) return;

    const due =
      !this.active.checkpointAnchorCaptured ||
      tick % this.checkpointInterval.intervalTicks === 0;
    if (!due) return;

    this.captureDueCheckpoint(tick);
  }

  /**
   * Epic 9.2 — final capture on matchEnd/matchDraw unless this tick already
   * produced a checkpoint (no double-capture on due+finalize coincidence).
   */
  private captureFinalCheckpointIfNeeded(tick: number): void {
    if (!this.active) return;
    if (!this.captureCheckpointState) return;
    if (this.active.checkpointLastTick === tick) return;
    this.captureDueCheckpoint(tick);
  }

  /**
   * Epic 9.2 — call 9.1 builder verbatim, bump counters, forward to hook.
   * Throws propagate to the surrounding `safe(..., { tick: true })` so the
   * 8.1 error threshold / markFailed policy applies; never mutates live sim.
   */
  private captureDueCheckpoint(tick: number): void {
    if (!this.active || !this.captureCheckpointState) return;
    const runtimeMatchId = this.active.runtimeMatchId;
    try {
      const checkpoint = this.captureCheckpointState(tick, runtimeMatchId);
      this.active.checkpointAnchorCaptured = true;
      this.forwardCapturedCheckpoint(checkpoint);
    } catch (err) {
      this.active.checkpointErrorCount++;
      throw err;
    }
  }

  /**
   * Store in the 8.5 session buffer, count, then notify the injectable hook.
   * Never reshapes the frozen checkpoint. Cap exceedance fails the recording.
   */
  private forwardCapturedCheckpoint(
    checkpoint: AuthoritativeCheckpoint,
  ): void {
    if (!this.active) return;
    const put = this.active.buffer.putCheckpoint(checkpoint);
    if (!put.ok) {
      this.failActiveRow(put.reason);
      return;
    }
    // 9.5: feed-only handoff — index receives the frozen frame after buffer put.
    this.active.checkpointIndex.insert(checkpoint);
    this.active.checkpointCapturedCount++;
    this.active.checkpointLastTick = checkpoint.tick;
    this.onCheckpointCaptured?.(checkpoint);
  }

  // --- internals -----------------------------------------------------------

  private detach(): void {
    if (!this.attached) return;
    this.detachSink();
    this.attached = false;
  }

  private counterPatch(): ReplayCounterPatch {
    const a = this.active!;
    return {
      ticksObserved: a.ticksObserved,
      inputTicks: a.inputTicks,
      eventTicks: a.eventTicks,
      errorCount: a.errorCount,
    };
  }

  /**
   * Prior-row close on new runtimeMatchId:
   * - recording that never reached live → abandoned
   * - recording that reached live → failed (interrupted)
   * - finalizing stays finalizing (should not be active; belt-and-suspenders)
   */
  private closePriorRowForNewId(): void {
    if (!this.active) return;
    const counters = this.counterPatch();
    const status: ReplayLifecycleStatus = this.active.reachedLive
      ? "failed"
      : "abandoned";
    const error = this.active.reachedLive
      ? "interrupted-by-new-match"
      : "never-reached-live";
    const runtimeMatchId = this.active.runtimeMatchId;
    const pendingRowId = this.active.rowId;
    this.active.buffer.markFailed();
    this.active.buffer.discard();
    this.discardPendingFinalize();
    this.active = null;
    this.enqueuePersist(async () => {
      const rowId = await this.resolveRowId(runtimeMatchId, pendingRowId);
      if (rowId == null) return;
      await this.lifecycle.update(rowId, { status, error, counters });
    });
  }

  private safe(
    label: string,
    fn: () => void,
    opts?: { lifecycle?: boolean; tick?: boolean; rethrow?: boolean },
  ): void {
    try {
      fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[replay-recorder] ${label} failed:`, err);
      if (this.active) {
        this.active.errorCount++;
        if (opts?.tick) {
          this.active.consecutiveTickErrors++;
          if (
            this.active.consecutiveTickErrors >=
              REPLAY_RECORDER_TICK_ERROR_THRESHOLD
          ) {
            this.failActiveRow(`${label}: ${message}`);
            return;
          }
        } else if (opts?.lifecycle) {
          // Lifecycle-write / start failures fail immediately (no recursion).
          this.failActiveRow(`${label}: ${message}`);
          return;
        }
      }
      if (opts?.rethrow) throw err;
    }
  }

  /** Persist failed + detach without going through safe()/markFailed. */
  private failActiveRow(error: string): void {
    if (!this.active) return;
    const counters = this.counterPatch();
    const runtimeMatchId = this.active.runtimeMatchId;
    const pendingRowId = this.active.rowId;
    this.active.buffer.markFailed();
    this.active.buffer.discard();
    this.discardPendingFinalize();
    this.active = null;
    this.detach();
    this.enqueuePersist(async () => {
      try {
        const rowId = await this.resolveRowId(runtimeMatchId, pendingRowId);
        if (rowId == null) return;
        await this.lifecycle.update(rowId, {
          status: "failed",
          error: truncateError(error),
          counters,
        });
      } catch (err) {
        console.error("[replay-recorder] failActiveRow persist failed:", err);
      }
    });
  }

  private createBuffer(runtimeMatchId: string): ReplaySessionBuffer {
    const opts: ReplaySessionBufferOptions = {};
    if (this.bufferCaps) opts.caps = this.bufferCaps;
    if (this.bufferBeforeCommit) opts.beforeCommit = this.bufferBeforeCommit;
    return new ReplaySessionBuffer(runtimeMatchId, opts);
  }

  private bufferFor(runtimeMatchId: string): ReplaySessionBuffer | null {
    if (this.active?.runtimeMatchId === runtimeMatchId) {
      return this.active.buffer;
    }
    if (this.pendingFinalize?.runtimeMatchId === runtimeMatchId) {
      return this.pendingFinalize;
    }
    return null;
  }

  private discardPendingFinalize(): void {
    if (!this.pendingFinalize) return;
    this.pendingFinalize.discard();
    this.pendingFinalize = null;
  }
}

function truncateError(error: string, max = 240): string {
  if (error.length <= max) return error;
  return `${error.slice(0, max - 3)}...`;
}

/** Re-export shared lifecycle types for tests. */
export type {
  ReplayLifecycleRow,
  ReplayLifecycleStatus,
} from "../shared/replay/replayLifecycle.ts";

export {
  InMemoryReplayLifecycleClient,
  type ReplayLifecycleClient,
} from "./replayLifecycleClient.ts";
