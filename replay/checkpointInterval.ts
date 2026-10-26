/**
 * Epic 9.2 — checkpoint capture interval config.
 *
 * One knob (`checkpointIntervalSeconds`) converts once to ticks via TICK_HZ.
 * Schedule math is tick-modulo only — never wall-clock.
 *
 * Tick table (TICK_HZ = 60):
 *   1s   → 60 ticks
 *   5s   → 300 ticks   (shipped default; see benchmark in 09-02 plan)
 *   7.5s → 450 ticks
 *   10s  → 600 ticks
 *   60s  → 3600 ticks  (supported max)
 *
 * Validation: non-positive → throw; above max → clamp + log.
 * Kill-switch for recording itself remains REPLAY_RECORDING_ENABLED (8.1).
 */

import { TICK_HZ } from "../shared/sim/game.ts";

/** Supported minimum interval (seconds). */
export const CHECKPOINT_INTERVAL_SECONDS_MIN = 1;

/** Supported maximum interval (seconds). Above this clamps with a log. */
export const CHECKPOINT_INTERVAL_SECONDS_MAX = 60;

/**
 * Shipped default (seconds). Benchmark across 5–10s on representative rosters
 * (duel / full lobby / bot-heavy) pinned 5s: p99 capture well under TICK_MS
 * (~16.67ms) on reference hardware; see 09-02 Implementation Notes.
 */
export const CHECKPOINT_INTERVAL_SECONDS_DEFAULT = 5;

/** Env key read once at recorder construction. */
export const REPLAY_CHECKPOINT_INTERVAL_SECONDS_ENV =
  "REPLAY_CHECKPOINT_INTERVAL_SECONDS";

export type CheckpointIntervalConfig = {
  /** Validated / possibly-clamped seconds. */
  readonly intervalSeconds: number;
  /** `round(intervalSeconds * TICK_HZ)` — the modulo period. */
  readonly intervalTicks: number;
  /** True when the input was clamped to the supported max. */
  readonly clamped: boolean;
};

/**
 * Convert seconds → ticks with Decision-4 validation.
 * Non-positive / non-finite → throw (fail loud). Above max → clamp + warn.
 */
export function resolveCheckpointInterval(
  seconds: number,
): CheckpointIntervalConfig {
  if (!Number.isFinite(seconds) || !(seconds > 0)) {
    throw new Error(
      `checkpointIntervalSeconds must be a positive finite number, got ${seconds}`,
    );
  }

  let intervalSeconds = seconds;
  let clamped = false;
  if (intervalSeconds > CHECKPOINT_INTERVAL_SECONDS_MAX) {
    console.warn(
      `[replay-checkpoint] checkpointIntervalSeconds=${seconds} exceeds max ` +
        `${CHECKPOINT_INTERVAL_SECONDS_MAX}s; clamping`,
    );
    intervalSeconds = CHECKPOINT_INTERVAL_SECONDS_MAX;
    clamped = true;
  }

  const intervalTicks = Math.round(intervalSeconds * TICK_HZ);
  if (intervalTicks < 1) {
    throw new Error(
      `checkpointIntervalSeconds=${seconds} yields intervalTicks < 1`,
    );
  }

  return { intervalSeconds, intervalTicks, clamped };
}

/**
 * Resolve from env (or default). Empty / unset → shipped default.
 * Invalid parse → throw (fail loud at startup).
 */
export function checkpointIntervalFromEnv(
  env: { get(key: string): string | undefined } = Deno.env,
): CheckpointIntervalConfig {
  const raw = env.get(REPLAY_CHECKPOINT_INTERVAL_SECONDS_ENV)?.trim();
  if (!raw) {
    return resolveCheckpointInterval(CHECKPOINT_INTERVAL_SECONDS_DEFAULT);
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(
      `${REPLAY_CHECKPOINT_INTERVAL_SECONDS_ENV}=${JSON.stringify(raw)} is not a number`,
    );
  }
  return resolveCheckpointInterval(parsed);
}

/** Documented tick-table helpers for tests / sizing notes. */
export function secondsToCheckpointTicks(seconds: number): number {
  return Math.round(seconds * TICK_HZ);
}
