// deno-lint-ignore-file no-import-prefix no-unversioned-import
import Clock from "good-clock";
import { TICK_HZ, TICK_MS } from "../protocol/network.ts";
import { TickTimingStats } from "./tickTiming.ts";

/** Wall-clock period for the scheduler only — sim never uses real dt. */
export { TICK_HZ, TICK_MS };

/**
 * Max back-to-back "catch-up" sim steps after an overrun.
 * good-clock drift correction shortens the next interval when a tick runs long;
 * without a cap, a slow host can chain many steps in one wall-clock moment and
 * freeze the event loop. Prefer dropping surplus steps (brief time skip).
 */
export const MAX_CATCH_UP_CHAIN = 3;

/**
 * Gap after the previous tick's end below which the next fire counts as
 * catch-up (fraction of the nominal period).
 */
const CATCH_UP_GAP_FRAC = 0.35;

export type CatchUpDecision = {
  shouldDrop: boolean;
  catchUpChain: number;
};

/**
 * Decide whether a scheduler callback is a catch-up step or a dropped surplus
 * step. The scheduler's tick number remains authoritative in either case.
 */
export function decideCatchUp(
  lastCallbackEndMs: number,
  nowMs: number,
  catchUpChain: number,
): CatchUpDecision {
  const isCatchUp = lastCallbackEndMs > 0 &&
    nowMs - lastCallbackEndMs < TICK_MS * CATCH_UP_GAP_FRAC;
  const nextChain = isCatchUp ? catchUpChain + 1 : 0;
  if (nextChain >= MAX_CATCH_UP_CHAIN) {
    return {
      shouldDrop: true,
      catchUpChain: MAX_CATCH_UP_CHAIN - 1,
    };
  }
  return { shouldDrop: false, catchUpChain: nextChain };
}

export class GameLoop {
  public tickCount = 0;
  /** Rolling tick wall-time stats (avg 1s RMS, peak 30s). */
  public readonly timing = new TickTimingStats(TICK_HZ);
  /**
   * How many scheduled callbacks were dropped because the catch-up chain
   * already hit MAX_CATCH_UP_CHAIN. Visible on /api/status for host diagnosis.
   */
  public skippedDeficitTicks = 0;

  private clock: Clock.Clock;
  private readonly onTick: (tickCount: number) => void;
  /** performance.now() when the previous callback finished. */
  private lastCallbackEndMs = 0;
  /** Consecutive rapid-fire callbacks after an overrun. */
  private catchUpChain = 0;

  constructor(onTick: (tickCount: number) => void) {
    // @ts-expect-error - Clock is a class, but its type definition is not correct
    this.clock = new Clock();
    this.onTick = onTick;
  }

  public start() {
    this.lastCallbackEndMs = 0;
    this.catchUpChain = 0;
    this.clock.start(
      (value) => {
        const now = performance.now();
        const catchUp = decideCatchUp(
          this.lastCallbackEndMs,
          now,
          this.catchUpChain,
        );
        this.catchUpChain = catchUp.catchUpChain;

        if (catchUp.shouldDrop) {
          // Drop surplus sim steps so the host can breathe.
          // Keep tickCount aligned with the scheduler value so late joiners
          // still see a monotonic sim clock.
          this.tickCount = value;
          this.skippedDeficitTicks += 1;
          this.lastCallbackEndMs = performance.now();
          // Soft-reset chain so we don't drop forever; allow a few more after
          // one real gap, but if still rapid-firing, keep dropping.
          this.catchUpChain = MAX_CATCH_UP_CHAIN - 1;
          return;
        }

        this.tickCount = value;
        const t0 = performance.now();
        try {
          this.onTick(value);
        } finally {
          this.timing.record(performance.now() - t0);
          this.lastCallbackEndMs = performance.now();
        }
      },
      TICK_MS,
      {
        driftCorrectionOn: true,
      },
    );
  }

  public stop() {
    this.clock.stop();
  }
}
