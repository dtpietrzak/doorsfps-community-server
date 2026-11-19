/**
 * Epic 19.1 — recording CPU cost.
 *
 * Summarizes wall time spent inside `ReplayRecorder.onTick`. The caller
 * supplies durations. The summarizer does not read a clock, does not
 * record a match, and does not change what is stored.
 *
 * A sample is one `onTick` call. `recording` is true when a session was
 * active for that call. Idle samples (no session) are the baseline.
 * Overhead is the recording mean minus the idle mean when both exist.
 * With no idle sample, overhead is the recording mean itself (absolute
 * recorder time). With no recording sample, overhead is 0.
 *
 * The meter keeps two views. `recent` is a ring of the last 30 seconds
 * at `TICK_HZ` (same horizon as tick-phase peaks). `lifetime` is every
 * call since construction, kept as running totals so a long match does
 * not store one row per tick. Loads are against the tick budget
 * (`1000 / tickHz`). A negative overhead is allowed: the recording path
 * can be quieter than the idle path inside one window.
 *
 * Section compression is 19.6. Storage capacity is 19.7. Seek latency is
 * 19.5. Recording memory is 19.2. Replay size is 19.3. Playback CPU
 * is 19.4. The status page is 23.4.
 * `ReplayRecorder.onTick` is the only production caller.
 */
import { TICK_HZ } from "../shared/sim/game.ts";

export const REPLAY_RECORDING_COST_INVALID =
  "replay-recording-cost-invalid" as const;

/** Recent window: 30 seconds of ticks, matching tick-phase peak horizon. */
export const REPLAY_RECORDING_COST_WINDOW_TICKS = 30 * TICK_HZ;

export type ReplayRecordingCostErrorCode =
  typeof REPLAY_RECORDING_COST_INVALID;

export class ReplayRecordingCostError extends Error {
  readonly code: ReplayRecordingCostErrorCode;
  readonly detail: string | null;

  constructor(message: string, detail?: string | null) {
    super(message);
    this.name = "ReplayRecordingCostError";
    this.code = REPLAY_RECORDING_COST_INVALID;
    this.detail = detail ?? null;
  }
}

export type ReplayRecordingCostSample = {
  readonly recordMs: number;
  /** True when the recorder had an active session for this call. */
  readonly recording: boolean;
};

export type ReplayRecordingCostBucket = {
  readonly samples: number;
  readonly totalMs: number;
  readonly meanMs: number;
  readonly rmsMs: number;
  readonly peakMs: number;
  /** meanMs / tick budget. */
  readonly meanLoad: number;
  /** peakMs / tick budget. */
  readonly peakLoad: number;
};

export type ReplayRecordingCostSpan = {
  readonly recording: ReplayRecordingCostBucket;
  readonly idle: ReplayRecordingCostBucket;
  /**
   * recording.meanMs - idle.meanMs when both sides have samples.
   * Otherwise the recording mean, or 0 when nothing was recorded.
   */
  readonly overheadMs: number;
  readonly overheadLoad: number;
  /** True only when overheadMs is a recording-minus-idle delta. */
  readonly comparedToIdle: boolean;
};

export type ReplayRecordingCostReport = {
  readonly tickHz: number;
  /** Max wall time of one simulation tick (ms) = 1000 / tickHz. */
  readonly budgetMs: number;
  /** Last `capacity` calls. Default capacity is 30s at TICK_HZ. */
  readonly recent: ReplayRecordingCostSpan;
  /** Every call since the meter was created. */
  readonly lifetime: ReplayRecordingCostSpan;
};

type CostAcc = {
  count: number;
  total: number;
  sumSq: number;
  peak: number;
};

function fail(message: string, detail?: string): never {
  throw new ReplayRecordingCostError(message, detail ?? null);
}

function assertTickHz(tickHz: number): number {
  if (!Number.isInteger(tickHz) || tickHz < 1) {
    fail("recording cost tick rate must be an integer >= 1", String(tickHz));
  }
  return tickHz;
}

function emptyBucket(): ReplayRecordingCostBucket {
  return {
    samples: 0,
    totalMs: 0,
    meanMs: 0,
    rmsMs: 0,
    peakMs: 0,
    meanLoad: 0,
    peakLoad: 0,
  };
}

function bucketFrom(
  count: number,
  total: number,
  sumSq: number,
  peak: number,
  budgetMs: number,
): ReplayRecordingCostBucket {
  if (count === 0) return emptyBucket();
  const meanMs = total / count;
  const rmsMs = Math.sqrt(sumSq / count);
  return {
    samples: count,
    totalMs: total,
    meanMs,
    rmsMs,
    peakMs: peak,
    meanLoad: meanMs / budgetMs,
    peakLoad: peak / budgetMs,
  };
}

function spanFrom(
  recording: ReplayRecordingCostBucket,
  idle: ReplayRecordingCostBucket,
  budgetMs: number,
): ReplayRecordingCostSpan {
  const comparedToIdle = recording.samples > 0 && idle.samples > 0;
  const overheadMs = recording.samples === 0
    ? 0
    : comparedToIdle
    ? recording.meanMs - idle.meanMs
    : recording.meanMs;
  return {
    recording,
    idle,
    overheadMs,
    overheadLoad: overheadMs / budgetMs,
    comparedToIdle,
  };
}

/**
 * Summarize caller-supplied durations. Does not read a clock.
 * `tickHz` defaults to the shared simulation rate.
 */
export function summarizeReplayRecordingCost(
  samples: readonly ReplayRecordingCostSample[],
  tickHz: number = TICK_HZ,
): ReplayRecordingCostSpan {
  const hz = assertTickHz(tickHz);
  const budgetMs = 1000 / hz;
  let recCount = 0;
  let recTotal = 0;
  let recSumSq = 0;
  let recPeak = 0;
  let idleCount = 0;
  let idleTotal = 0;
  let idleSumSq = 0;
  let idlePeak = 0;
  for (const sample of samples) {
    if (!Number.isFinite(sample.recordMs) || sample.recordMs < 0) {
      fail(
        "recording cost sample must be a finite number >= 0",
        String(sample.recordMs),
      );
    }
    if (sample.recording) {
      recCount += 1;
      recTotal += sample.recordMs;
      recSumSq += sample.recordMs * sample.recordMs;
      if (sample.recordMs > recPeak) recPeak = sample.recordMs;
    } else {
      idleCount += 1;
      idleTotal += sample.recordMs;
      idleSumSq += sample.recordMs * sample.recordMs;
      if (sample.recordMs > idlePeak) idlePeak = sample.recordMs;
    }
  }
  return spanFrom(
    bucketFrom(recCount, recTotal, recSumSq, recPeak, budgetMs),
    bucketFrom(idleCount, idleTotal, idleSumSq, idlePeak, budgetMs),
    budgetMs,
  );
}

function emptyAcc(): CostAcc {
  return { count: 0, total: 0, sumSq: 0, peak: 0 };
}

function addAcc(acc: CostAcc, recordMs: number): void {
  acc.count += 1;
  acc.total += recordMs;
  acc.sumSq += recordMs * recordMs;
  if (recordMs > acc.peak) acc.peak = recordMs;
}

const defaultNow = (): number => performance.now();

/**
 * Rolling recorder-cost meter. `note` stores a caller-supplied duration.
 * `measure` reads the clock around one call. The default clock is
 * `performance.now`; tests inject `nowMs`. A backwards or non-finite
 * clock stores 0 and does not throw — a bad sample must not fail a live
 * tick. `note` still rejects a bad duration so the contract stays loud.
 */
export class ReplayRecordingCostMeter {
  private readonly capacity: number;
  private readonly recordMs: Float64Array;
  private readonly recording: Uint8Array;
  private write = 0;
  private count = 0;
  private readonly nowMs: () => number;
  private readonly lifeRec: CostAcc = emptyAcc();
  private readonly lifeIdle: CostAcc = emptyAcc();

  constructor(options?: { capacity?: number; nowMs?: () => number }) {
    const capacity = options?.capacity ?? REPLAY_RECORDING_COST_WINDOW_TICKS;
    if (!Number.isInteger(capacity) || capacity < 1) {
      fail("recording cost capacity must be an integer >= 1", String(capacity));
    }
    this.capacity = capacity;
    this.recordMs = new Float64Array(capacity);
    this.recording = new Uint8Array(capacity);
    this.nowMs = options?.nowMs ?? defaultNow;
  }

  /** Store one duration. Rejects non-finite and negative values. */
  note(recordMs: number, recording: boolean): void {
    if (!Number.isFinite(recordMs) || recordMs < 0) {
      fail(
        "recording cost sample must be a finite number >= 0",
        String(recordMs),
      );
    }
    this.push(recordMs, recording);
  }

  /**
   * Time `fn`. The sample is stored even when `fn` throws, and the
   * original error is rethrown. Non-finite or negative clock deltas
   * are stored as 0.
   */
  measure<T>(recording: boolean, fn: () => T): T {
    const t0 = this.nowMs();
    try {
      return fn();
    } finally {
      const dt = this.nowMs() - t0;
      this.push(Number.isFinite(dt) && dt >= 0 ? dt : 0, recording);
    }
  }

  report(tickHz: number = TICK_HZ): ReplayRecordingCostReport {
    const hz = assertTickHz(tickHz);
    const budgetMs = 1000 / hz;
    const recent = summarizeReplayRecordingCost(this.recentSamples(), hz);
    const lifetime = spanFrom(
      bucketFrom(
        this.lifeRec.count,
        this.lifeRec.total,
        this.lifeRec.sumSq,
        this.lifeRec.peak,
        budgetMs,
      ),
      bucketFrom(
        this.lifeIdle.count,
        this.lifeIdle.total,
        this.lifeIdle.sumSq,
        this.lifeIdle.peak,
        budgetMs,
      ),
      budgetMs,
    );
    return { tickHz: hz, budgetMs, recent, lifetime };
  }

  private push(recordMs: number, recording: boolean): void {
    this.recordMs[this.write] = recordMs;
    this.recording[this.write] = recording ? 1 : 0;
    this.write = (this.write + 1) % this.capacity;
    if (this.count < this.capacity) this.count += 1;
    addAcc(recording ? this.lifeRec : this.lifeIdle, recordMs);
  }

  /** Oldest → newest among the retained window. */
  private recentSamples(): ReplayRecordingCostSample[] {
    const out: ReplayRecordingCostSample[] = [];
    const start = this.count < this.capacity ? 0 : this.write;
    for (let i = 0; i < this.count; i++) {
      const idx = (start + i) % this.capacity;
      out.push({
        recordMs: this.recordMs[idx]!,
        recording: this.recording[idx] === 1,
      });
    }
    return out;
  }
}
