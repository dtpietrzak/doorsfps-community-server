/**
 * Multi-rate think-step cadence (bot-tick periods).
 *
 * Outer think stays {@link BOT_TICK_HZ} (20 Hz). Slow switch steps
 * (`navMode`, `navGoal`, `yawPole`) only replan every N bot ticks;
 * skip paths rehydrate last decisions without bag churn or RNG.
 *
 * @see docs/game/bots.md — multi-rate addendum
 */

import { botCadenceWorkTick, botWorkSlot } from "../helpers/combat.ts";
import { floor } from "../math/index.ts";
import { BOT_TICK_HZ } from "../types.ts";

/**
 * Bot-tick periods at 20 Hz think:
 * - 10 → 2 Hz  (strategic mode)
 * - 4  → 5 Hz  (nav goal / personality latches)
 * - 2  → 10 Hz (yaw pole re-score)
 * - 1  → every think
 */
export const STEP_CADENCE_PERIOD = {
  navMode: 10,
  navGoal: 4,
  personality: 4,
  yawPole: 2,
} as const;

/**
 * Nominal think rate (Hz) for a pipeline step id.
 * Cadenced switch steps use {@link STEP_CADENCE_PERIOD}; everything else
 * runs every bot think ({@link BOT_TICK_HZ}).
 */
export function thinkStepCadenceHz(stepId: string): number {
  if (
    stepId === "navMode" ||
    stepId === "navGoal" ||
    stepId === "personality" ||
    stepId === "yawPole"
  ) {
    return BOT_TICK_HZ / stepCadencePeriod(stepId);
  }
  return BOT_TICK_HZ;
}

export type CadencedStepKey = keyof typeof STEP_CADENCE_PERIOD;

/** Mutable overrides for tests (period 1 = always run). */
let periodOverrides: Partial<Record<CadencedStepKey, number>> | null = null;

/**
 * Replace cadence periods for unit tests. Pass `null` / call
 * {@link resetStepCadencePeriodsForTests} to restore defaults.
 */
export function setStepCadencePeriodsForTests(
  overrides: Partial<Record<CadencedStepKey, number>> | null,
): void {
  periodOverrides = overrides;
}

export function resetStepCadencePeriodsForTests(): void {
  periodOverrides = null;
}

/** Effective period for a cadenced step (≥ 1). */
export function stepCadencePeriod(key: CadencedStepKey): number {
  const override = periodOverrides !== null ? periodOverrides[key] : undefined;
  const raw = override !== undefined ? override : STEP_CADENCE_PERIOD[key];
  const n = floor(raw);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/**
 * Whether this bot should run a cadenced step on this sim tick.
 *
 * - `force: true` always runs (doors edge, mode change, empty latch, …).
 * - period ≤ 1 → every bot think.
 * - otherwise: `workTick % period === botWorkSlot(botId, period)`.
 */
export function shouldRunCadencedStep(
  key: CadencedStepKey,
  simTick: number,
  botId: string,
  opts?: { force?: boolean },
): boolean {
  if (opts?.force === true) return true;
  const period = stepCadencePeriod(key);
  if (period <= 1) return true;
  const workTick = botCadenceWorkTick(simTick);
  const slot = botWorkSlot(botId, period);
  return workTick % period === slot;
}
