/**
 * Epic 8.5 — in-memory replay session buffer (+ 9.2 checkpoint frames).
 *
 * Owns the frozen 8.2–8.4 capture objects for one `runtimeMatchId`:
 * init (once) + per-tick inputs + per-tick events, plus 9.2 frozen
 * AuthoritativeCheckpoint frames keyed by tick. Append is by reference,
 * O(1)-amortized, never serializes / awaits / flushes. Cap or duration
 * exceedance is fail-loud (`buffer-cap-exceeded` / `duration-limit`) — never
 * a silent truncation or ring-buffer eviction.
 *
 * Contract (see notes/replay/08-replay-recording/08-05-replay-buffering.md):
 * - One buffer per runtimeMatchId; rotation replaces, reset-without-rotation
 *   keeps, terminal disposition discards.
 * - Live tail (`getTailWindow`) is a read-only view of the same object.
 * - Memory-only; no store / file / finalized writes.
 */

import { TICK_HZ } from "../shared/sim/game.ts";
import type { AuthoritativeCheckpoint } from "./authoritativeCheckpoint.ts";
import type { RecordedInitialState } from "./recordedInitialState.ts";
import type { RecordedTickEvents } from "./recordedTickEvents.ts";
import type { RecordedTickInputs } from "./recordedTickInputs.ts";

/**
 * Max ticks a single recording session may hold.
 * Matches host-tunable match duration ceiling (3h @ TICK_HZ) so a legal match
 * fits; longer recordings fail loud rather than grow unboundedly.
 */
export const MAX_BUFFERED_TICKS = 3 * 60 * 60 * TICK_HZ; // 648_000

/**
 * Max estimated bytes a session may hold.
 * Estimate rule below — not a serializer run. 512 MiB bounds memory; a dense
 * long match that would exceed this fails loud (`buffer-cap-exceeded`).
 */
export const MAX_BUFFERED_BYTES_EST = 512 * 1024 * 1024;

/**
 * Max ticks the recorder will accept before ending the recording (not the
 * match) with reason `duration-limit`. Equal to {@link MAX_BUFFERED_TICKS}.
 */
export const MAX_RECORDING_TICKS = MAX_BUFFERED_TICKS;

/** Byte-estimate constants (counted rows × these; no JSON.stringify per tick). */
export const BYTES_EST_INIT_BASE = 4096;
export const BYTES_EST_ROSTER_ENTRY = 256;
export const BYTES_EST_TICK_OVERHEAD = 32;
export const BYTES_EST_MOVEMENT_ROW = 96;
export const BYTES_EST_ACTION_ROW = 64;
export const BYTES_EST_EVENT = 128;
/** Flat per-checkpoint estimate (~15KB measured for 8h+4b; no JSON.stringify). */
export const BYTES_EST_CHECKPOINT_BASE = 4096;
export const BYTES_EST_CHECKPOINT_PLAYER = 1024;

export type ReplayBufferCaps = {
  maxBufferedTicks: number;
  maxBufferedBytesEst: number;
  maxRecordingTicks: number;
};

export const DEFAULT_REPLAY_BUFFER_CAPS: ReplayBufferCaps = {
  maxBufferedTicks: MAX_BUFFERED_TICKS,
  maxBufferedBytesEst: MAX_BUFFERED_BYTES_EST,
  maxRecordingTicks: MAX_RECORDING_TICKS,
};

export type ReplaySessionBufferStatus =
  | "recording"
  | "finalizing"
  | "failed"
  | "discarded";

/** Pinned fail-loud reasons (row `error` / markFailed). */
export type ReplayBufferFailReason =
  | "buffer-cap-exceeded"
  | "duration-limit"
  | "alloc-failed";

export type BufferCommitResult =
  | { ok: true }
  | { ok: false; reason: ReplayBufferFailReason };

/**
 * Frozen view of an intact buffered session for 8.6 / #10 / 11.2.
 * `finalizable` is true only while status is `finalizing`.
 */
export type ReplayBufferedSessionView = {
  readonly runtimeMatchId: string;
  readonly startTick: number | null;
  readonly init: RecordedInitialState | null;
  readonly inputs: ReadonlyArray<RecordedTickInputs>;
  readonly events: ReadonlyArray<RecordedTickEvents>;
  /** Epic 9.2 — frozen checkpoints ordered by tick. */
  readonly checkpoints: ReadonlyArray<AuthoritativeCheckpoint>;
  readonly usageTicks: number;
  readonly usageBytesEstimate: number;
  readonly status: ReplaySessionBufferStatus;
  readonly finalizable: boolean;
};

/**
 * Ordered live-tail slice for 12.7 delayed spectating.
 * Same buffer object — no copy of the stream, no eviction.
 */
export type ReplayTailWindow = {
  readonly runtimeMatchId: string;
  readonly fromTick: number;
  readonly startTick: number | null;
  readonly init: RecordedInitialState | null;
  readonly inputs: ReadonlyArray<RecordedTickInputs>;
  readonly events: ReadonlyArray<RecordedTickEvents>;
  readonly checkpoints: ReadonlyArray<AuthoritativeCheckpoint>;
};

export type ReplaySessionBufferOptions = {
  caps?: Partial<ReplayBufferCaps>;
  /**
   * Test / pressure hook invoked at the start of {@link ReplaySessionBuffer.commitTick}.
   * Throw to simulate alloc/pressure failure (`alloc-failed`).
   */
  beforeCommit?: () => void;
};

export function estimateInitBytes(init: RecordedInitialState): number {
  const rosterLen = Array.isArray(init.init.roster) ? init.init.roster.length : 0;
  return BYTES_EST_INIT_BASE + rosterLen * BYTES_EST_ROSTER_ENTRY;
}

export function estimateInputsBytes(row: RecordedTickInputs): number {
  return (
    BYTES_EST_TICK_OVERHEAD +
    row.movement.length * BYTES_EST_MOVEMENT_ROW +
    row.actions.length * BYTES_EST_ACTION_ROW
  );
}

export function estimateEventsBytes(row: RecordedTickEvents): number {
  return BYTES_EST_TICK_OVERHEAD + row.events.length * BYTES_EST_EVENT;
}

export function estimateCheckpointBytes(cp: AuthoritativeCheckpoint): number {
  return (
    BYTES_EST_CHECKPOINT_BASE +
    cp.players.length * BYTES_EST_CHECKPOINT_PLAYER
  );
}

/**
 * One in-memory recording session. Stores frozen 8.2–8.4 + 9.2 objects by reference.
 */
export class ReplaySessionBuffer {
  readonly runtimeMatchId: string;
  readonly caps: ReplayBufferCaps;

  /** Capture tick of init, or first buffered input tick if init absent. */
  startTick: number | null = null;
  init: RecordedInitialState | null = null;
  readonly inputs: Map<number, RecordedTickInputs> = new Map();
  readonly events: Map<number, RecordedTickEvents> = new Map();
  /** Epic 9.2 — frozen checkpoints keyed by capture tick. */
  readonly checkpoints: Map<number, AuthoritativeCheckpoint> = new Map();

  usageTicks = 0;
  usageBytesEstimate = 0;
  status: ReplaySessionBufferStatus = "recording";

  private readonly beforeCommit: (() => void) | null;

  constructor(runtimeMatchId: string, opts?: ReplaySessionBufferOptions) {
    this.runtimeMatchId = runtimeMatchId;
    this.caps = {
      ...DEFAULT_REPLAY_BUFFER_CAPS,
      ...(opts?.caps ?? {}),
    };
    this.beforeCommit = opts?.beforeCommit ?? null;
  }

  /** Store frozen init once; replaces prior estimate if called again (should not). */
  setInit(state: RecordedInitialState): void {
    this.assertMutable();
    if (this.init) {
      this.usageBytesEstimate -= estimateInitBytes(this.init);
    }
    this.init = state;
    if (this.startTick === null) {
      this.startTick = state.captureTick;
    }
    this.usageBytesEstimate += estimateInitBytes(state);
  }

  /**
   * Store / replace a frozen per-tick input row by reference.
   * Upserts (8.3 late-action merges) adjust the byte estimate.
   */
  putInputs(row: RecordedTickInputs): void {
    this.assertMutable();
    const prev = this.inputs.get(row.tick);
    if (prev) {
      this.usageBytesEstimate -= estimateInputsBytes(prev);
    }
    this.inputs.set(row.tick, row);
    this.usageBytesEstimate += estimateInputsBytes(row);
    if (this.startTick === null) {
      this.startTick = row.tick;
    }
  }

  /**
   * Store a frozen per-tick event list by reference.
   * Sparse ticks store nothing (caller skips empty lists).
   */
  putEvents(row: RecordedTickEvents): void {
    this.assertMutable();
    const prev = this.events.get(row.tick);
    if (prev) {
      this.usageBytesEstimate -= estimateEventsBytes(prev);
    }
    this.events.set(row.tick, row);
    this.usageBytesEstimate += estimateEventsBytes(row);
    if (this.startTick === null) {
      this.startTick = row.tick;
    }
  }

  /**
   * Epic 9.2 — store a frozen checkpoint by reference, keyed by capture tick.
   * Replaces prior estimate if the same tick is captured twice (should not).
   * Returns fail-loud when the byte cap would be exceeded.
   */
  putCheckpoint(cp: AuthoritativeCheckpoint): BufferCommitResult {
    this.assertMutable();
    const prev = this.checkpoints.get(cp.tick);
    if (prev) {
      this.usageBytesEstimate -= estimateCheckpointBytes(prev);
    }
    this.checkpoints.set(cp.tick, cp);
    this.usageBytesEstimate += estimateCheckpointBytes(cp);
    if (this.startTick === null) {
      this.startTick = cp.tick;
    }
    if (this.usageBytesEstimate > this.caps.maxBufferedBytesEst) {
      return { ok: false, reason: "buffer-cap-exceeded" };
    }
    return { ok: true };
  }

  getInputs(tick: number): RecordedTickInputs | undefined {
    return this.inputs.get(tick);
  }

  getEvents(tick: number): RecordedTickEvents | undefined {
    return this.events.get(tick);
  }

  getCheckpoint(tick: number): AuthoritativeCheckpoint | undefined {
    return this.checkpoints.get(tick);
  }

  orderedInputs(): ReadonlyArray<RecordedTickInputs> {
    return [...this.inputs.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, row]) => row);
  }

  orderedEvents(): ReadonlyArray<RecordedTickEvents> {
    return [...this.events.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, row]) => row);
  }

  orderedCheckpoints(): ReadonlyArray<AuthoritativeCheckpoint> {
    return [...this.checkpoints.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, cp]) => cp);
  }

  /**
   * End-of-tick accounting: bump usage, run pressure hook, check caps.
   * O(1). Never I/O / await / serialize.
   */
  commitTick(): BufferCommitResult {
    this.assertMutable();
    try {
      this.beforeCommit?.();
    } catch {
      return { ok: false, reason: "alloc-failed" };
    }

    this.usageTicks++;

    if (this.usageTicks > this.caps.maxRecordingTicks) {
      return { ok: false, reason: "duration-limit" };
    }
    if (this.usageTicks > this.caps.maxBufferedTicks) {
      return { ok: false, reason: "buffer-cap-exceeded" };
    }
    if (this.usageBytesEstimate > this.caps.maxBufferedBytesEst) {
      return { ok: false, reason: "buffer-cap-exceeded" };
    }
    return { ok: true };
  }

  /** Normal end: freeze for 8.6 claim. Failed/abandoned sessions never reach this. */
  freezeForFinalize(): void {
    if (this.status !== "recording") return;
    this.status = "finalizing";
  }

  markFailed(): void {
    if (this.status === "discarded") return;
    this.status = "failed";
  }

  /** Drop contents; buffer is no longer readable as a session. */
  discard(): void {
    this.status = "discarded";
    this.init = null;
    this.inputs.clear();
    this.events.clear();
    this.checkpoints.clear();
    this.usageTicks = 0;
    this.usageBytesEstimate = 0;
    this.startTick = null;
  }

  toView(): ReplayBufferedSessionView {
    return {
      runtimeMatchId: this.runtimeMatchId,
      startTick: this.startTick,
      init: this.init,
      inputs: this.orderedInputs(),
      events: this.orderedEvents(),
      checkpoints: this.orderedCheckpoints(),
      usageTicks: this.usageTicks,
      usageBytesEstimate: this.usageBytesEstimate,
      status: this.status,
      finalizable: this.status === "finalizing",
    };
  }

  /**
   * Live-tail window for 12.7: ordered inputs/events/checkpoints with tick
   * >= fromTick (and >= session start). Read-only; does not mutate or evict.
   * Returns null when not `recording`.
   */
  getTailWindow(fromTick: number): ReplayTailWindow | null {
    if (this.status !== "recording") return null;
    const start = this.startTick ?? fromTick;
    const lower = Math.max(fromTick, start);
    return {
      runtimeMatchId: this.runtimeMatchId,
      fromTick: lower,
      startTick: this.startTick,
      init: this.init,
      inputs: this.orderedInputs().filter((row) => row.tick >= lower),
      events: this.orderedEvents().filter((row) => row.tick >= lower),
      checkpoints: this.orderedCheckpoints().filter((cp) => cp.tick >= lower),
    };
  }

  private assertMutable(): void {
    if (this.status !== "recording") {
      throw new Error(
        `replay session buffer not mutable (status=${this.status})`,
      );
    }
  }
}
