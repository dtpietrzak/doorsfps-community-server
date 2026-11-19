/**
 * Epic 19.2 — recording memory cost.
 *
 * Summarizes estimated bytes held by one recording session. The caller
 * supplies the reading. The summarizer does not walk rows, does not
 * serialize, and does not change what is stored.
 *
 * A sample is one reading of an 8.5 session buffer.
 * `bufferBytes` is the init object plus input rows plus event rows.
 * `checkpointBytes` is the 9.2 checkpoint map. That half is already
 * inside the cap total (`usageBytesEstimate`). `startCheckpointBytes`
 * is the opening frame stored on the init object. The cap leaves that
 * frame on its flat init estimate, so the report names it beside the
 * cap. `heldBytes` is the cap total plus the opening frame.
 *
 * `held` is false only for the idle reading (no buffer). An empty
 * session that exists is held, with zeros.
 *
 * The meter keeps three views. `current` is the latest note. `recentPeak`
 * is the greatest `heldBytes` among the last 30 seconds of notes (same
 * horizon as recording CPU cost; a later note wins a tie). `peak` is
 * that high-water mark since construction. Init, an external checkpoint,
 * and release add a note, so the recent window can run a little short
 * of 30 seconds. Lifetime keeps one peak sample, so a long match does
 * not store one row per tick.
 *
 * Section compression is 19.6. Storage capacity is 19.7. Seek latency is
 * 19.5. Replay size is 19.3. Playback CPU is 19.4. The status page
 * is 23.4.
 * `ReplayRecorder` is the only production caller.
 */
import { TICK_HZ } from "../shared/sim/game.ts";
import {
  estimateCheckpointBytes,
  type ReplaySessionBuffer,
} from "./replaySessionBuffer.ts";

export const REPLAY_RECORDING_MEMORY_INVALID =
  "replay-recording-memory-invalid" as const;

/** Recent window: 30 seconds of notes, matching the recording CPU horizon. */
export const REPLAY_RECORDING_MEMORY_WINDOW_TICKS = 30 * TICK_HZ;

export type ReplayRecordingMemoryErrorCode =
  typeof REPLAY_RECORDING_MEMORY_INVALID;

export class ReplayRecordingMemoryError extends Error {
  readonly code: ReplayRecordingMemoryErrorCode;
  readonly detail: string | null;

  constructor(message: string, detail?: string | null) {
    super(message);
    this.name = "ReplayRecordingMemoryError";
    this.code = REPLAY_RECORDING_MEMORY_INVALID;
    this.detail = detail ?? null;
  }
}

export type ReplayRecordingMemorySample = {
  /** False when no session buffer is held. */
  readonly held: boolean;
  /** Init + input rows + event rows. */
  readonly bufferBytes: number;
  /** 9.2 frames in the checkpoint map. Included in the cap total. */
  readonly checkpointBytes: number;
  /** Opening frame on the init object. Reported beside the cap. */
  readonly startCheckpointBytes: number;
  readonly usageTicks: number;
  readonly inputRows: number;
  readonly eventRows: number;
  readonly checkpointCount: number;
  /** `ReplayBufferCaps.maxBufferedBytesEst` for this session. 0 when idle. */
  readonly capLimitBytes: number;
};

/** Idle reading. A live tick with no session notes this. */
export const REPLAY_RECORDING_MEMORY_IDLE: ReplayRecordingMemorySample =
  Object.freeze({
    held: false,
    bufferBytes: 0,
    checkpointBytes: 0,
    startCheckpointBytes: 0,
    usageTicks: 0,
    inputRows: 0,
    eventRows: 0,
    checkpointCount: 0,
    capLimitBytes: 0,
  });

export type ReplayRecordingMemoryLevel = {
  readonly held: boolean;
  readonly bufferBytes: number;
  readonly checkpointBytes: number;
  readonly startCheckpointBytes: number;
  /** Periodic frames plus the opening frame. */
  readonly checkpointMemoryBytes: number;
  /** bufferBytes + checkpointBytes. The 8.5 cap total. */
  readonly capBytes: number;
  /** capBytes + startCheckpointBytes. */
  readonly heldBytes: number;
  readonly usageTicks: number;
  readonly inputRows: number;
  readonly eventRows: number;
  readonly checkpointCount: number;
  readonly capLimitBytes: number;
  /** capBytes / capLimitBytes. 0 when the limit is 0. */
  readonly capLoad: number;
  /** checkpointBytes / capBytes. 0 when the cap total is 0. */
  readonly checkpointShare: number;
  /** checkpointMemoryBytes / heldBytes. 0 when nothing is held. */
  readonly checkpointMemoryShare: number;
  /** capBytes / usageTicks. 0 when no tick has committed. */
  readonly capBytesPerTick: number;
};

export type ReplayRecordingMemoryReport = {
  /** Latest note. Idle after release. */
  readonly current: ReplayRecordingMemoryLevel;
  /** Greatest heldBytes in the retained window. */
  readonly recentPeak: ReplayRecordingMemoryLevel;
  /** Greatest heldBytes since the meter was created. */
  readonly peak: ReplayRecordingMemoryLevel;
  readonly recentSamples: number;
  readonly lifetimeSamples: number;
};

function fail(message: string, detail?: string): never {
  throw new ReplayRecordingMemoryError(message, detail ?? null);
}

function assertCount(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || Object.is(value, -0)) {
    fail(`${name} must be an integer >= 0`, String(value));
  }
}

function assertSample(sample: ReplayRecordingMemorySample): void {
  if (typeof sample.held !== "boolean") {
    fail("recording memory sample held must be a boolean", String(sample.held));
  }
  assertCount("bufferBytes", sample.bufferBytes);
  assertCount("checkpointBytes", sample.checkpointBytes);
  assertCount("startCheckpointBytes", sample.startCheckpointBytes);
  assertCount("usageTicks", sample.usageTicks);
  assertCount("inputRows", sample.inputRows);
  assertCount("eventRows", sample.eventRows);
  assertCount("checkpointCount", sample.checkpointCount);
  assertCount("capLimitBytes", sample.capLimitBytes);
  if (!sample.held) {
    const idle = sample.bufferBytes === 0 &&
      sample.checkpointBytes === 0 &&
      sample.startCheckpointBytes === 0 &&
      sample.usageTicks === 0 &&
      sample.inputRows === 0 &&
      sample.eventRows === 0 &&
      sample.checkpointCount === 0 &&
      sample.capLimitBytes === 0;
    if (!idle) {
      fail("an idle recording memory sample must be zero");
    }
  }
}

export function heldReplayMemoryBytes(
  sample: Pick<
    ReplayRecordingMemorySample,
    "bufferBytes" | "checkpointBytes" | "startCheckpointBytes"
  >,
): number {
  return sample.bufferBytes + sample.checkpointBytes +
    sample.startCheckpointBytes;
}

function emptyLevel(): ReplayRecordingMemoryLevel {
  return levelFrom(REPLAY_RECORDING_MEMORY_IDLE);
}

function levelFrom(
  sample: ReplayRecordingMemorySample,
): ReplayRecordingMemoryLevel {
  const capBytes = sample.bufferBytes + sample.checkpointBytes;
  const startCheckpointBytes = sample.startCheckpointBytes;
  const heldBytes = capBytes + startCheckpointBytes;
  const checkpointMemoryBytes = sample.checkpointBytes + startCheckpointBytes;
  return {
    held: sample.held,
    bufferBytes: sample.bufferBytes,
    checkpointBytes: sample.checkpointBytes,
    startCheckpointBytes,
    checkpointMemoryBytes,
    capBytes,
    heldBytes,
    usageTicks: sample.usageTicks,
    inputRows: sample.inputRows,
    eventRows: sample.eventRows,
    checkpointCount: sample.checkpointCount,
    capLimitBytes: sample.capLimitBytes,
    capLoad: sample.capLimitBytes > 0 ? capBytes / sample.capLimitBytes : 0,
    checkpointShare: capBytes > 0 ? sample.checkpointBytes / capBytes : 0,
    checkpointMemoryShare: heldBytes > 0
      ? checkpointMemoryBytes / heldBytes
      : 0,
    capBytesPerTick: sample.usageTicks > 0 ? capBytes / sample.usageTicks : 0,
  };
}

function copySample(
  sample: ReplayRecordingMemorySample,
): ReplayRecordingMemorySample {
  return {
    held: sample.held,
    bufferBytes: sample.bufferBytes,
    checkpointBytes: sample.checkpointBytes,
    startCheckpointBytes: sample.startCheckpointBytes,
    usageTicks: sample.usageTicks,
    inputRows: sample.inputRows,
    eventRows: sample.eventRows,
    checkpointCount: sample.checkpointCount,
    capLimitBytes: sample.capLimitBytes,
  };
}

/**
 * Read one session buffer into a sample. A discarded buffer is idle.
 * Checkpoint-map bytes above the cap total are a broken counter and throw.
 * Does not walk rows and does not mutate the buffer.
 */
export function sampleReplayBufferMemory(
  buffer: ReplaySessionBuffer,
): ReplayRecordingMemorySample {
  if (buffer.status === "discarded") return REPLAY_RECORDING_MEMORY_IDLE;
  const checkpointBytes = buffer.checkpointBytesEstimate;
  const bufferBytes = buffer.usageBytesEstimate - checkpointBytes;
  if (!Number.isInteger(bufferBytes) || bufferBytes < 0) {
    fail(
      "checkpoint bytes exceed the recording cap total",
      `${checkpointBytes} > ${buffer.usageBytesEstimate}`,
    );
  }
  const start = buffer.init?.startCheckpoint;
  return {
    held: true,
    bufferBytes,
    checkpointBytes,
    startCheckpointBytes: start ? estimateCheckpointBytes(start) : 0,
    usageTicks: buffer.usageTicks,
    inputRows: buffer.inputs.size,
    eventRows: buffer.events.size,
    checkpointCount: buffer.checkpoints.size,
    capLimitBytes: buffer.caps.maxBufferedBytesEst,
  };
}

/**
 * Summarize caller-supplied readings. The last sample is current. The
 * peak is the greatest heldBytes; a later sample wins a tie. An empty
 * list is the idle level for both.
 */
export function summarizeReplayRecordingMemory(
  samples: readonly ReplayRecordingMemorySample[],
): { current: ReplayRecordingMemoryLevel; peak: ReplayRecordingMemoryLevel } {
  if (samples.length === 0) {
    const empty = emptyLevel();
    return { current: empty, peak: empty };
  }
  let peak = samples[0]!;
  let peakBytes = heldReplayMemoryBytes(peak);
  for (const sample of samples) {
    assertSample(sample);
    const bytes = heldReplayMemoryBytes(sample);
    if (bytes >= peakBytes) {
      peak = sample;
      peakBytes = bytes;
    }
  }
  return {
    current: levelFrom(samples[samples.length - 1]!),
    peak: levelFrom(peak),
  };
}

/**
 * Rolling recording-memory meter. `note` stores a caller-supplied
 * reading. `report` does not add a note.
 */
export class ReplayRecordingMemoryMeter {
  private readonly capacity: number;
  private readonly bufferBytes: Float64Array;
  private readonly checkpointBytes: Float64Array;
  private readonly startCheckpointBytes: Float64Array;
  private readonly usageTicks: Float64Array;
  private readonly inputRows: Float64Array;
  private readonly eventRows: Float64Array;
  private readonly checkpointCount: Float64Array;
  private readonly capLimitBytes: Float64Array;
  private readonly held: Uint8Array;
  private write = 0;
  private count = 0;
  private lifetimeSamples = 0;
  private peakSample: ReplayRecordingMemorySample | null = null;

  constructor(options?: { capacity?: number }) {
    const capacity = options?.capacity ?? REPLAY_RECORDING_MEMORY_WINDOW_TICKS;
    if (!Number.isInteger(capacity) || capacity < 1) {
      fail(
        "recording memory capacity must be an integer >= 1",
        String(capacity),
      );
    }
    this.capacity = capacity;
    this.bufferBytes = new Float64Array(capacity);
    this.checkpointBytes = new Float64Array(capacity);
    this.startCheckpointBytes = new Float64Array(capacity);
    this.usageTicks = new Float64Array(capacity);
    this.inputRows = new Float64Array(capacity);
    this.eventRows = new Float64Array(capacity);
    this.checkpointCount = new Float64Array(capacity);
    this.capLimitBytes = new Float64Array(capacity);
    this.held = new Uint8Array(capacity);
  }

  /** Store one reading. Rejects a sample the summarizer would reject. */
  note(sample: ReplayRecordingMemorySample): void {
    assertSample(sample);
    this.bufferBytes[this.write] = sample.bufferBytes;
    this.checkpointBytes[this.write] = sample.checkpointBytes;
    this.startCheckpointBytes[this.write] = sample.startCheckpointBytes;
    this.usageTicks[this.write] = sample.usageTicks;
    this.inputRows[this.write] = sample.inputRows;
    this.eventRows[this.write] = sample.eventRows;
    this.checkpointCount[this.write] = sample.checkpointCount;
    this.capLimitBytes[this.write] = sample.capLimitBytes;
    this.held[this.write] = sample.held ? 1 : 0;
    this.write = (this.write + 1) % this.capacity;
    if (this.count < this.capacity) this.count += 1;
    this.lifetimeSamples += 1;
    const bytes = heldReplayMemoryBytes(sample);
    if (
      this.peakSample == null ||
      bytes >= heldReplayMemoryBytes(this.peakSample)
    ) {
      this.peakSample = copySample(sample);
    }
  }

  report(): ReplayRecordingMemoryReport {
    const recent = summarizeReplayRecordingMemory(this.recentSamples());
    return {
      current: recent.current,
      recentPeak: recent.peak,
      peak: this.peakSample ? levelFrom(this.peakSample) : emptyLevel(),
      recentSamples: this.count,
      lifetimeSamples: this.lifetimeSamples,
    };
  }

  /** Oldest → newest among the retained window. */
  private recentSamples(): ReplayRecordingMemorySample[] {
    const out: ReplayRecordingMemorySample[] = [];
    const start = this.count < this.capacity ? 0 : this.write;
    for (let i = 0; i < this.count; i++) {
      const idx = (start + i) % this.capacity;
      out.push({
        held: this.held[idx] === 1,
        bufferBytes: this.bufferBytes[idx]!,
        checkpointBytes: this.checkpointBytes[idx]!,
        startCheckpointBytes: this.startCheckpointBytes[idx]!,
        usageTicks: this.usageTicks[idx]!,
        inputRows: this.inputRows[idx]!,
        eventRows: this.eventRows[idx]!,
        checkpointCount: this.checkpointCount[idx]!,
        capLimitBytes: this.capLimitBytes[idx]!,
      });
    }
    return out;
  }
}
