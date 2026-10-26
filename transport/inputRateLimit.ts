/**
 * Per-socket input flood protection for human clients.
 * Caps how many Input events are accepted per wall-clock window so a
 * misbehaving or laggy client cannot stall the Deno event loop.
 * Bots never go through this path.
 */

import { TICK_HZ } from "../protocol/network.ts";

/** Allow up to 2× sim rate (e.g. 120/s at 60 Hz) with a short window. */
export const INPUT_RATE_MAX_PER_SEC = TICK_HZ * 2;

/** Sliding window length (ms). */
export const INPUT_RATE_WINDOW_MS = 100;

type Bucket = {
  windowStartMs: number;
  count: number;
};

export class InputRateLimiter {
  private readonly maxPerSec: number;
  private readonly windowMs: number;
  private readonly maxPerWindow: number;
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    maxPerSec: number = INPUT_RATE_MAX_PER_SEC,
    windowMs: number = INPUT_RATE_WINDOW_MS,
  ) {
    this.maxPerSec = Math.max(1, Math.floor(maxPerSec));
    this.windowMs = Math.max(10, Math.floor(windowMs));
    // e.g. 120/s over 100ms → 12 events per window.
    this.maxPerWindow = Math.max(
      1,
      Math.ceil((this.maxPerSec * this.windowMs) / 1000),
    );
  }

  /**
   * Returns true if this input should be applied.
   * Drops excess events in the current window (silent).
   */
  allow(socketId: string, nowMs: number = Date.now()): boolean {
    let b = this.buckets.get(socketId);
    if (!b || nowMs - b.windowStartMs >= this.windowMs) {
      b = { windowStartMs: nowMs, count: 1 };
      this.buckets.set(socketId, b);
      return true;
    }
    if (b.count >= this.maxPerWindow) return false;
    b.count += 1;
    return true;
  }

  /** Drop state when a socket disconnects. */
  forget(socketId: string): void {
    this.buckets.delete(socketId);
  }

  /** Test helper. */
  getMaxPerWindow(): number {
    return this.maxPerWindow;
  }
}
