/**
 * Tall zombot variant helpers (1 in every `tallEvery` zombots).
 *
 * Pure game truth shared by server sim, runtime, and client rendering:
 * - Stretched vertically by `tallHeightScale` (1.15x Y, 1x X/Z).
 * - Walks at `tallWalkSpeedMultiplier` (0.85x) of normal wave speed.
 * - Every `tallCycleMs` (7.5s), sprints for `tallSprintDurationMs` (1s) at
 *   `tallSprintSpeedMultiplier` (1.75x) of normal wave speed, then stops
 *   walking completely for `tallPauseDurationMs` (0.75s).
 */

import { ZOMBOTS_TUNING } from "./zombotsTuning.ts";

export type TallZombotPacePhase = "walk" | "sprint" | "pause";

export type TallZombotPaceTuning = {
  readonly tallWalkSpeedMultiplier: number;
  readonly tallSprintSpeedMultiplier: number;
  readonly tallCycleMs: number;
  readonly tallSprintDurationMs: number;
  readonly tallPauseDurationMs: number;
};

/**
 * True for tall sprinter zombots (`bot:zombie-tall-<n>`,
 * server-community/runtime/zombotsRuntime.ts). Still a zombot.
 */
export function isTallZombotId(id: string): boolean {
  return id.startsWith("bot:zombie-tall-");
}

/**
 * Current pace phase for a tall zombot `elapsedMs` after spawn.
 * Cycle layout: [0, walkMs) walk → [walkMs, walkMs + sprintMs) sprint → [walkMs + sprintMs, cycleMs) pause.
 */
export function tallZombotPacePhase(
  elapsedMs: number,
  tuning: TallZombotPaceTuning = ZOMBOTS_TUNING.zombie,
): TallZombotPacePhase {
  const cycleMs = tuning.tallCycleMs;
  if (!(cycleMs > 0) || !Number.isFinite(elapsedMs) || elapsedMs < 0) {
    return "walk";
  }
  const sprintMs = Math.max(0, tuning.tallSprintDurationMs);
  const pauseMs = Math.max(0, tuning.tallPauseDurationMs);
  const walkMs = Math.max(0, cycleMs - sprintMs - pauseMs);
  const t = elapsedMs % cycleMs;
  if (t < walkMs) return "walk";
  if (t < walkMs + sprintMs) return "sprint";
  return "pause";
}

/**
 * Multiplier applied on top of a tall zombot's base `moveSpeedScale`
 * (`waveSpeed * tallWalkSpeedMultiplier`):
 * - walk: 1 (effective `0.85x` wave speed)
 * - sprint: `tallSprintSpeedMultiplier / tallWalkSpeedMultiplier` (effective `1.75x` wave speed)
 * - pause: 0 (stops walking completely)
 */
export function tallZombotSpeedFactor(
  elapsedMs: number,
  tuning: TallZombotPaceTuning = ZOMBOTS_TUNING.zombie,
): number {
  const phase = tallZombotPacePhase(elapsedMs, tuning);
  if (phase === "pause") return 0;
  if (phase === "sprint") {
    return tuning.tallWalkSpeedMultiplier > 0
      ? tuning.tallSprintSpeedMultiplier / tuning.tallWalkSpeedMultiplier
      : 1;
  }
  return 1;
}
