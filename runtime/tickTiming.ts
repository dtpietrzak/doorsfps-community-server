/**
 * Rolling tick-duration stats for capacity / sim budget monitoring.
 *
 * Fixed-rate sim: budgetMs = 1000 / tickHz. If a tick regularly exceeds the
 * budget, the host cannot keep real-time and player experience degrades.
 *
 * - avgMs: RMS of tick wall times over the last ~1 second (not arithmetic mean)
 * - peakMs: max tick wall time over the last ~30 seconds
 * - phases: per-phase rolling stats. **Phase peaks are independent** (each is
 *   the max of that phase over 30s on possibly different ticks). Do not sum
 *   phase peaks and expect the total tick peak.
 *
 * Exclusive phases that partition the tick: bots, sim, heatmap, scores, emit.
 * `think` is AI-only and is a **subset of bots** (bots = apply + think).
 */

import { TICK_HZ } from "../protocol/network.ts";

/**
 * Named work buckets inside one sim tick.
 * Note: after PR4, bot work is split (apply pre-sim, think post-emit); the
 * `bots` sample is the **sum** of both segments on the same tick.
 */
export const TICK_PHASE_NAMES = [
  "bots",
  "sim",
  "heatmap",
  "scores",
  "emit",
  "think",
] as const;

/** Phases that partition the tick (no overlap). `think` is inside `bots`. */
export const EXCLUSIVE_TICK_PHASES = [
  "bots",
  "sim",
  "heatmap",
  "scores",
  "emit",
] as const;
export type TickPhaseName = (typeof TICK_PHASE_NAMES)[number];

export type PhaseBucketSnapshot = {
  /** Wall time of the most recent sample (ms). */
  lastMs: number;
  /** RMS over the last ~1s (ms). */
  avgMs: number;
  /** Peak over the last ~30s (ms). */
  peakMs: number;
  /** avgMs / full tick budget. */
  avgLoad: number;
  /** peakMs / full tick budget. */
  peakLoad: number;
};

export type TickTimingSnapshot = {
  /** Sim rate (Hz). */
  tickHz: number;
  /** Max wall time allowed per tick (ms) = 1000 / tickHz. */
  budgetMs: number;
  /** RMS of tick durations over the last ~1s (ms). */
  avgMs: number;
  /** Peak tick duration over the last ~30s (ms). */
  peakMs: number;
  /** avgMs / budgetMs (≥1 means average tick over budget). */
  avgLoad: number;
  /** peakMs / budgetMs. */
  peakLoad: number;
  /** Samples used for the 1s RMS window. */
  samples1s: number;
  /** Samples used for the 30s peak window. */
  samples30s: number;
  /**
   * Per-phase breakdown when the host records buckets (Phase 0+).
   * Loads are vs full tick budget so phases are comparable to total.
   */
  phases?: Record<TickPhaseName, PhaseBucketSnapshot>;
  /**
   * Sim steps dropped by the catch-up limiter (lifetime counter on the loop).
   * Present when reported via GameServer.getTickTiming /api/status.
   */
  skippedDeficitTicks?: number;
};

/** Durations for one completed tick's phases (ms). */
export type TickPhaseSample = Record<TickPhaseName, number>;

/** RMS of a sequence: sqrt(mean(x²)). */
export function rms(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sumSq = 0;
  for (const v of values) {
    sumSq += v * v;
  }
  return Math.sqrt(sumSq / values.length);
}

export class TickTimingStats {
  private readonly tickHz: number;
  private readonly window1s: number;
  private readonly window30s: number;
  private readonly samples: Float64Array;
  private write = 0;
  private count = 0;
  private lastMs = 0;

  constructor(tickHz: number = TICK_HZ) {
    this.tickHz = Math.max(1, Math.floor(tickHz));
    this.window1s = this.tickHz;
    this.window30s = this.tickHz * 30;
    this.samples = new Float64Array(this.window30s);
  }

  /** Record one completed tick's wall-clock duration in milliseconds. */
  record(durationMs: number): void {
    const v = Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0;
    this.lastMs = v;
    this.samples[this.write] = v;
    this.write = (this.write + 1) % this.window30s;
    if (this.count < this.window30s) this.count += 1;
  }

  /** Most recent sample (ms), or 0 if none. */
  last(): number {
    return this.lastMs;
  }

  /** Collect the most recent `n` samples (oldest → newest). */
  recent(n: number): number[] {
    const take = Math.min(Math.max(0, Math.floor(n)), this.count);
    if (take === 0) return [];
    const out = new Array<number>(take);
    for (let i = 0; i < take; i++) {
      out[i] = this.samples[this.indexOfRecent(take, i)]!;
    }
    return out;
  }

  snapshot(): TickTimingSnapshot {
    const budgetMs = 1000 / this.tickHz;
    const last1s = this.recent(this.window1s);
    const last30s = this.recent(this.window30s);

    let peakMs = 0;
    for (const v of last30s) {
      if (v > peakMs) peakMs = v;
    }

    const avgMs = rms(last1s);
    const safeBudget = budgetMs > 0 ? budgetMs : 1;

    return {
      tickHz: this.tickHz,
      budgetMs,
      avgMs,
      peakMs,
      avgLoad: avgMs / safeBudget,
      peakLoad: peakMs / safeBudget,
      samples1s: last1s.length,
      samples30s: last30s.length,
    };
  }

  /** Index of the i-th sample among the most recent `take` (0 = oldest of window). */
  private indexOfRecent(take: number, i: number): number {
    if (this.count < this.window30s) {
      // Buffer not full yet: valid samples are [0, count).
      return this.count - take + i;
    }
    // Full ring: next write index is the oldest overall.
    return (this.write - take + i + this.window30s) % this.window30s;
  }
}

/**
 * Rolling stats for each tick phase (bots / sim / scores / emit).
 * Loads are relative to the full tick budget so numbers are comparable.
 */
export class PhaseTimingBundle {
  private readonly tickHz: number;
  private readonly buckets: Record<TickPhaseName, TickTimingStats>;

  constructor(tickHz: number = TICK_HZ) {
    this.tickHz = Math.max(1, Math.floor(tickHz));
    this.buckets = {
      bots: new TickTimingStats(this.tickHz),
      sim: new TickTimingStats(this.tickHz),
      heatmap: new TickTimingStats(this.tickHz),
      scores: new TickTimingStats(this.tickHz),
      emit: new TickTimingStats(this.tickHz),
      think: new TickTimingStats(this.tickHz),
    };
  }

  /** Record one tick's phase durations (ms). Missing names treated as 0. */
  record(sample: Partial<TickPhaseSample>): void {
    for (const name of TICK_PHASE_NAMES) {
      const v = sample[name];
      this.buckets[name].record(
        typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0,
      );
    }
  }

  snapshot(): Record<TickPhaseName, PhaseBucketSnapshot> {
    const budgetMs = 1000 / this.tickHz;
    const safeBudget = budgetMs > 0 ? budgetMs : 1;
    const out = {} as Record<TickPhaseName, PhaseBucketSnapshot>;
    for (const name of TICK_PHASE_NAMES) {
      const s = this.buckets[name].snapshot();
      out[name] = {
        lastMs: this.buckets[name].last(),
        avgMs: s.avgMs,
        peakMs: s.peakMs,
        avgLoad: s.avgMs / safeBudget,
        peakLoad: s.peakMs / safeBudget,
      };
    }
    return out;
  }
}
