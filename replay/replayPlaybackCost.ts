/**
 * Epic 19.4 — playback CPU cost.
 *
 * Summarizes wall time spent inside one `ReplayPlayback.frame` simulation
 * step. The caller supplies durations. The summarizer does not read a
 * clock, does not step a replay, and does not change the cursor.
 *
 * A sample is one `runner.step` inside `frame`. A frame that steps four
 * ticks stores four samples. A paused frame, or a frame that does not
 * reach a tick, stores none. Seek steps are measured by 19.5 and are
 * not samples here. The view projection after the step is outside
 * the sample.
 *
 * The meter keeps two views. `recent` is a ring of the last 30 seconds
 * of simulated ticks (same horizon as tick-phase peaks). `lifetime` is
 * every step since construction, kept as running totals so a long
 * replay does not store one row per tick. Loads are against the tick
 * budget (`1000 / tickHz`).
 *
 * Section compression is 19.6. Storage capacity is 19.7. Seek latency is
 * 19.5. The status page is 23.4.
 * `ReplayPlayback.frame` is the only production caller.
 */
import { TICK_HZ } from "../shared/sim/game.ts";

export const REPLAY_PLAYBACK_COST_INVALID =
  "replay-playback-cost-invalid" as const;

/** Recent window: 30 seconds of simulated ticks, matching tick-phase peaks. */
export const REPLAY_PLAYBACK_COST_WINDOW_TICKS = 30 * TICK_HZ;

export type ReplayPlaybackCostErrorCode =
  typeof REPLAY_PLAYBACK_COST_INVALID;

export class ReplayPlaybackCostError extends Error {
  readonly code: ReplayPlaybackCostErrorCode;
  readonly detail: string | null;

  constructor(message: string, detail?: string | null) {
    super(message);
    this.name = "ReplayPlaybackCostError";
    this.code = REPLAY_PLAYBACK_COST_INVALID;
    this.detail = detail ?? null;
  }
}

export type ReplayPlaybackCostSample = {
  readonly simMs: number;
};

export type ReplayPlaybackCostBucket = {
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

export type ReplayPlaybackCostReport = {
  readonly tickHz: number;
  /** Max wall time of one simulation tick (ms) = 1000 / tickHz. */
  readonly budgetMs: number;
  /** Last `capacity` steps. Default capacity is 30s at TICK_HZ. */
  readonly recent: ReplayPlaybackCostBucket;
  /** Every step since the meter was created. */
  readonly lifetime: ReplayPlaybackCostBucket;
};

type CostAcc = {
  count: number;
  total: number;
  sumSq: number;
  peak: number;
};

function fail(message: string, detail?: string): never {
  throw new ReplayPlaybackCostError(message, detail ?? null);
}

function assertTickHz(tickHz: number): number {
  if (!Number.isInteger(tickHz) || tickHz < 1) {
    fail("playback cost tick rate must be an integer >= 1", String(tickHz));
  }
  return tickHz;
}

function assertSimMs(simMs: number): void {
  if (!Number.isFinite(simMs) || simMs < 0) {
    fail("playback cost sample must be a finite number >= 0", String(simMs));
  }
}

function emptyBucket(): ReplayPlaybackCostBucket {
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
): ReplayPlaybackCostBucket {
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

/**
 * Summarize caller-supplied durations. Does not read a clock.
 * `tickHz` defaults to the shared simulation rate.
 */
export function summarizeReplayPlaybackCost(
  samples: readonly ReplayPlaybackCostSample[],
  tickHz: number = TICK_HZ,
): ReplayPlaybackCostBucket {
  const hz = assertTickHz(tickHz);
  const budgetMs = 1000 / hz;
  let count = 0;
  let total = 0;
  let sumSq = 0;
  let peak = 0;
  for (const sample of samples) {
    assertSimMs(sample.simMs);
    count += 1;
    total += sample.simMs;
    sumSq += sample.simMs * sample.simMs;
    if (sample.simMs > peak) peak = sample.simMs;
  }
  return bucketFrom(count, total, sumSq, peak, budgetMs);
}

function emptyAcc(): CostAcc {
  return { count: 0, total: 0, sumSq: 0, peak: 0 };
}

function addAcc(acc: CostAcc, simMs: number): void {
  acc.count += 1;
  acc.total += simMs;
  acc.sumSq += simMs * simMs;
  if (simMs > acc.peak) acc.peak = simMs;
}

const defaultNow = (): number => performance.now();

/**
 * Rolling playback-cost meter. `note` stores a caller-supplied duration.
 * `measure` reads the clock around one step. The default clock is
 * `performance.now`; tests inject `nowMs`. A backwards or non-finite
 * clock stores 0 and does not throw — a bad sample must not fail playback.
 * `note` still rejects a bad duration so the contract stays loud.
 */
export class ReplayPlaybackCostMeter {
  private readonly capacity: number;
  private readonly simMs: Float64Array;
  private write = 0;
  private count = 0;
  private readonly nowMs: () => number;
  private readonly life: CostAcc = emptyAcc();

  constructor(options?: { capacity?: number; nowMs?: () => number }) {
    const capacity = options?.capacity ?? REPLAY_PLAYBACK_COST_WINDOW_TICKS;
    if (!Number.isInteger(capacity) || capacity < 1) {
      fail("playback cost capacity must be an integer >= 1", String(capacity));
    }
    this.capacity = capacity;
    this.simMs = new Float64Array(capacity);
    this.nowMs = options?.nowMs ?? defaultNow;
  }

  /** Store one duration. Rejects non-finite and negative values. */
  note(simMs: number): void {
    assertSimMs(simMs);
    this.push(simMs);
  }

  /**
   * Time `fn`. The sample is stored even when `fn` throws, and the
   * original error is rethrown. Non-finite or negative clock deltas
   * are stored as 0.
   */
  measure<T>(fn: () => T): T {
    const t0 = this.nowMs();
    try {
      return fn();
    } finally {
      const dt = this.nowMs() - t0;
      this.push(Number.isFinite(dt) && dt >= 0 ? dt : 0);
    }
  }

  report(tickHz: number = TICK_HZ): ReplayPlaybackCostReport {
    const hz = assertTickHz(tickHz);
    const budgetMs = 1000 / hz;
    const recent = summarizeReplayPlaybackCost(this.recentSamples(), hz);
    const lifetime = bucketFrom(
      this.life.count,
      this.life.total,
      this.life.sumSq,
      this.life.peak,
      budgetMs,
    );
    return { tickHz: hz, budgetMs, recent, lifetime };
  }

  private push(simMs: number): void {
    this.simMs[this.write] = simMs;
    this.write = (this.write + 1) % this.capacity;
    if (this.count < this.capacity) this.count += 1;
    addAcc(this.life, simMs);
  }

  /** Oldest → newest among the retained window. */
  private recentSamples(): ReplayPlaybackCostSample[] {
    const out: ReplayPlaybackCostSample[] = [];
    const start = this.count < this.capacity ? 0 : this.write;
    for (let i = 0; i < this.count; i++) {
      const idx = (start + i) % this.capacity;
      out.push({ simMs: this.simMs[idx]! });
    }
    return out;
  }
}
