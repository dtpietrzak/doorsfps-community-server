/**
 * Epic 19.5 — seek latency.
 *
 * Summarizes wall time spent inside one `executeReplayScrub` call.
 * The caller supplies the duration and the scrub plan's step count.
 * The summarizer does not read a clock, does not seek, and does not
 * change the cursor.
 *
 * A sample is one `ReplayPlayback.seek` or `seekToTimeMs`. The floor
 * plan, the clock park, and `projectCurrent` after the scrub are
 * outside the sample. The scrub's own view-copy hooks are inside it.
 * A `frame` step is 19.4 and is not a sample here.
 * `steps` is the `runner.step` count in that plan. An exact checkpoint
 * hit has 0 steps and still records the load. `resumed` is the 14.5
 * continuation: false when the floor was loaded.
 *
 * The report splits every seek, reloads, and continuations. `msPerStep`
 * divides the wall time of seeks that stepped by their step count. A
 * 0-step load stays in the means and the peak and out of that ratio.
 * A reload's checkpoint restore stays in its own wall time, so the
 * steps of that seek carry the load that made them possible. Loads
 * compare a seek's wall time with one tick budget. A gap of many ticks
 * is expected to exceed one budget. `stepLoad` compares `msPerStep`
 * with the same budget, which is the per-tick cost inside a long
 * replay. `slowest` is the greatest `wallMs`. A later equal time
 * replaces it. Its step count is not `peakSteps`.
 *
 * `recent` is a ring of the last 30 seconds of ticks, counted in
 * seeks, so a scrub that seeks every frame still drops the oldest.
 * `lifetime` is running totals. A long session does not store one row
 * per seek.
 *
 * Section compression is 19.6. Storage capacity is 19.7. The status page
 * is 23.4. `ReplayPlayback.seek` is the only production caller.
 */
import { TICK_HZ } from "../shared/sim/game.ts";

export const REPLAY_SEEK_LATENCY_INVALID =
  "replay-seek-latency-invalid" as const;

/**
 * Recent window, in seeks. Same bound as the playback-cost ring
 * (30 seconds of ticks). Seeks are not ticks; the bound is a count.
 */
export const REPLAY_SEEK_LATENCY_WINDOW = 30 * TICK_HZ;

export type ReplaySeekLatencyErrorCode =
  typeof REPLAY_SEEK_LATENCY_INVALID;

export class ReplaySeekLatencyError extends Error {
  readonly code: ReplaySeekLatencyErrorCode;
  readonly detail: string | null;

  constructor(message: string, detail?: string | null) {
    super(message);
    this.name = "ReplaySeekLatencyError";
    this.code = REPLAY_SEEK_LATENCY_INVALID;
    this.detail = detail ?? null;
  }
}

/** Step count and continuation flag. The meter adds the wall time. */
export type ReplaySeekLatencyFacts = {
  readonly steps: number;
  /** True when 14.5 continued from the cursor instead of loading. */
  readonly resumed: boolean;
};

export type ReplaySeekLatencySample = ReplaySeekLatencyFacts & {
  readonly wallMs: number;
};

export type ReplaySeekLatencyBucket = {
  readonly samples: number;
  readonly totalMs: number;
  readonly meanMs: number;
  readonly rmsMs: number;
  readonly peakMs: number;
  readonly totalSteps: number;
  readonly meanSteps: number;
  readonly peakSteps: number;
  /**
   * Wall time of seeks with `steps > 0`, divided by `totalSteps`.
   * 0 when nothing stepped. Exact hits do not enter this ratio.
   */
  readonly msPerStep: number;
  /** meanMs / tick budget. The whole seek against one tick. */
  readonly meanLoad: number;
  /** peakMs / tick budget. */
  readonly peakLoad: number;
  /** msPerStep / tick budget. 0 when nothing stepped. */
  readonly stepLoad: number;
  /**
   * Greatest wallMs. A later equal time replaces it. Null when empty.
   * `steps` here is that seek, not `peakSteps`.
   */
  readonly slowest: ReplaySeekLatencySample | null;
};

export type ReplaySeekLatencySplit = {
  readonly all: ReplaySeekLatencyBucket;
  readonly reloaded: ReplaySeekLatencyBucket;
  readonly resumed: ReplaySeekLatencyBucket;
};

export type ReplaySeekLatencyReport = {
  readonly tickHz: number;
  /** Max wall time of one simulation tick (ms) = 1000 / tickHz. */
  readonly budgetMs: number;
  /** Last `capacity` seeks. Default capacity is 30s of ticks, in seeks. */
  readonly recent: ReplaySeekLatencySplit;
  /** Every seek since the meter was created. */
  readonly lifetime: ReplaySeekLatencySplit;
};

type SideAcc = {
  count: number;
  total: number;
  sumSq: number;
  peak: number;
  totalSteps: number;
  peakSteps: number;
  slowestSteps: number;
  /** Wall time of samples whose step count is greater than 0. */
  steppedWall: number;
};

function fail(message: string, detail?: string): never {
  throw new ReplaySeekLatencyError(message, detail ?? null);
}

function assertTickHz(tickHz: number): number {
  if (!Number.isInteger(tickHz) || tickHz < 1) {
    fail("seek latency tick rate must be an integer >= 1", String(tickHz));
  }
  return tickHz;
}

function assertWallMs(wallMs: number): void {
  if (!Number.isFinite(wallMs) || wallMs < 0) {
    fail("seek latency must be a finite number >= 0", String(wallMs));
  }
}

function assertSteps(steps: number): void {
  if (
    !Number.isSafeInteger(steps) || steps < 0 || Object.is(steps, -0)
  ) {
    fail("seek latency steps must be an integer >= 0", String(steps));
  }
}

function assertResumed(resumed: boolean): void {
  if (typeof resumed !== "boolean") {
    fail("seek latency resumed must be a boolean", String(resumed));
  }
}

function assertSample(sample: ReplaySeekLatencySample): void {
  assertWallMs(sample.wallMs);
  assertSteps(sample.steps);
  assertResumed(sample.resumed);
}

function emptyBucket(): ReplaySeekLatencyBucket {
  return {
    samples: 0,
    totalMs: 0,
    meanMs: 0,
    rmsMs: 0,
    peakMs: 0,
    totalSteps: 0,
    meanSteps: 0,
    peakSteps: 0,
    msPerStep: 0,
    meanLoad: 0,
    peakLoad: 0,
    stepLoad: 0,
    slowest: null,
  };
}

function emptySide(): SideAcc {
  return {
    count: 0,
    total: 0,
    sumSq: 0,
    peak: 0,
    totalSteps: 0,
    peakSteps: 0,
    slowestSteps: 0,
    steppedWall: 0,
  };
}

/** Returns true when this sample becomes the slowest (a later tie wins). */
function addSide(side: SideAcc, wallMs: number, steps: number): boolean {
  const slower = side.count === 0 || wallMs >= side.peak;
  side.count += 1;
  side.total += wallMs;
  side.sumSq += wallMs * wallMs;
  side.totalSteps += steps;
  if (steps > side.peakSteps) side.peakSteps = steps;
  if (steps > 0) side.steppedWall += wallMs;
  if (slower) {
    side.peak = wallMs;
    side.slowestSteps = steps;
  }
  return slower;
}

function bucketFrom(
  side: SideAcc,
  budgetMs: number,
  resumed: boolean,
): ReplaySeekLatencyBucket {
  if (side.count === 0) return emptyBucket();
  const meanMs = side.total / side.count;
  const rmsMs = Math.sqrt(side.sumSq / side.count);
  const meanSteps = side.totalSteps / side.count;
  const msPerStep = side.totalSteps === 0
    ? 0
    : side.steppedWall / side.totalSteps;
  return {
    samples: side.count,
    totalMs: side.total,
    meanMs,
    rmsMs,
    peakMs: side.peak,
    totalSteps: side.totalSteps,
    meanSteps,
    peakSteps: side.peakSteps,
    msPerStep,
    meanLoad: meanMs / budgetMs,
    peakLoad: side.peak / budgetMs,
    stepLoad: msPerStep / budgetMs,
    slowest: {
      wallMs: side.peak,
      steps: side.slowestSteps,
      resumed,
    },
  };
}

function splitFrom(
  all: SideAcc,
  reloaded: SideAcc,
  resumed: SideAcc,
  slowestResumed: boolean,
  budgetMs: number,
): ReplaySeekLatencySplit {
  return {
    all: bucketFrom(all, budgetMs, slowestResumed),
    reloaded: bucketFrom(reloaded, budgetMs, false),
    resumed: bucketFrom(resumed, budgetMs, true),
  };
}

/**
 * Summarize caller-supplied seeks. Does not read a clock.
 * `tickHz` defaults to the shared simulation rate.
 */
export function summarizeReplaySeekLatency(
  samples: readonly ReplaySeekLatencySample[],
  tickHz: number = TICK_HZ,
): ReplaySeekLatencySplit {
  const hz = assertTickHz(tickHz);
  const budgetMs = 1000 / hz;
  const all = emptySide();
  const reloaded = emptySide();
  const resumed = emptySide();
  let slowestResumed = false;
  for (const sample of samples) {
    assertSample(sample);
    const slower = addSide(all, sample.wallMs, sample.steps);
    if (sample.resumed) addSide(resumed, sample.wallMs, sample.steps);
    else addSide(reloaded, sample.wallMs, sample.steps);
    if (slower) slowestResumed = sample.resumed;
  }
  return splitFrom(all, reloaded, resumed, slowestResumed, budgetMs);
}

const defaultNow = (): number => performance.now();

/**
 * Rolling seek-latency meter. `note` stores a caller-supplied sample.
 * `measure` reads the clock around one scrub. The default clock is
 * `performance.now`; tests inject `nowMs`. A backwards or non-finite
 * clock stores 0 and does not throw — a bad sample must not fail the
 * seek. Facts are checked before the scrub runs. A thrown scrub still
 * leaves a sample for the plan it started, and the original error is
 * rethrown. `note` still rejects a bad duration so the contract stays
 * loud.
 */
export class ReplaySeekLatencyMeter {
  private readonly capacity: number;
  private readonly wallMs: Float64Array;
  private readonly steps: Float64Array;
  private readonly resumed: Uint8Array;
  private write = 0;
  private count = 0;
  private readonly nowMs: () => number;
  private readonly lifeAll: SideAcc = emptySide();
  private readonly lifeReloaded: SideAcc = emptySide();
  private readonly lifeResumed: SideAcc = emptySide();
  private lifeSlowestResumed = false;

  constructor(options?: { capacity?: number; nowMs?: () => number }) {
    const capacity = options?.capacity ?? REPLAY_SEEK_LATENCY_WINDOW;
    if (!Number.isInteger(capacity) || capacity < 1) {
      fail(
        "seek latency capacity must be an integer >= 1",
        String(capacity),
      );
    }
    this.capacity = capacity;
    this.wallMs = new Float64Array(capacity);
    this.steps = new Float64Array(capacity);
    this.resumed = new Uint8Array(capacity);
    this.nowMs = options?.nowMs ?? defaultNow;
  }

  /** Store one seek. Rejects a bad duration, step count, or flag. */
  note(sample: ReplaySeekLatencySample): void {
    assertSample(sample);
    this.push(sample.wallMs, sample.steps, sample.resumed);
  }

  /**
   * Time `fn`. Facts are validated first; a bad plan does not run `fn`
   * and stores nothing. The sample is stored even when `fn` throws.
   * Non-finite or negative clock deltas are stored as 0.
   */
  measure<T>(facts: ReplaySeekLatencyFacts, fn: () => T): T {
    assertSteps(facts.steps);
    assertResumed(facts.resumed);
    const steps = facts.steps;
    const resumed = facts.resumed;
    const t0 = this.nowMs();
    try {
      return fn();
    } finally {
      const dt = this.nowMs() - t0;
      this.push(Number.isFinite(dt) && dt >= 0 ? dt : 0, steps, resumed);
    }
  }

  report(tickHz: number = TICK_HZ): ReplaySeekLatencyReport {
    const hz = assertTickHz(tickHz);
    const budgetMs = 1000 / hz;
    const recent = summarizeReplaySeekLatency(this.recentSamples(), hz);
    const lifetime = splitFrom(
      this.lifeAll,
      this.lifeReloaded,
      this.lifeResumed,
      this.lifeSlowestResumed,
      budgetMs,
    );
    return { tickHz: hz, budgetMs, recent, lifetime };
  }

  private push(wallMs: number, steps: number, resumed: boolean): void {
    this.wallMs[this.write] = wallMs;
    this.steps[this.write] = steps;
    this.resumed[this.write] = resumed ? 1 : 0;
    this.write = (this.write + 1) % this.capacity;
    if (this.count < this.capacity) this.count += 1;
    const slower = addSide(this.lifeAll, wallMs, steps);
    if (resumed) addSide(this.lifeResumed, wallMs, steps);
    else addSide(this.lifeReloaded, wallMs, steps);
    if (slower) this.lifeSlowestResumed = resumed;
  }

  /** Oldest → newest among the retained window. */
  private recentSamples(): ReplaySeekLatencySample[] {
    const out: ReplaySeekLatencySample[] = [];
    const start = this.count < this.capacity ? 0 : this.write;
    for (let i = 0; i < this.count; i++) {
      const idx = (start + i) % this.capacity;
      out.push({
        wallMs: this.wallMs[idx]!,
        steps: this.steps[idx]!,
        resumed: this.resumed[idx] === 1,
      });
    }
    return out;
  }
}
