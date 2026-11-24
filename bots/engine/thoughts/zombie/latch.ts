/**
 * Zombie latches live in gun-brain slots. The death gate already wipes
 * these, and BotBrainState has no zombie fields of its own.
 *
 * - `targetEnemyId` — sticky human
 * - `targetEnemySampleX/Z` — last place that human was seen
 * - `reactionReadyAtTick` — sim tick the next swing is allowed
 */

import { MELEE_COOLDOWN_MS } from "../../../../shared/sim/weapons.ts";
import { msToTicks } from "../../shared/network.ts";
import { isSetNumber, type BotBrainState } from "../../pipeline/state.ts";

export function zombieStickyId(state: BotBrainState): string {
  return state.targetEnemyId;
}

/** Remember a living target, or drop the id and keep the last XZ. */
export function rememberZombieTarget(
  state: BotBrainState,
  target: { id: string; x: number; z: number } | null,
): void {
  if (target) {
    state.targetEnemyId = target.id;
    state.targetEnemySampleX = target.x;
    state.targetEnemySampleZ = target.z;
    return;
  }
  state.targetEnemyId = "";
}

/** Last known target XZ, or null when this life has never seen one. */
export function zombieLastKnown(
  state: BotBrainState,
): { x: number; z: number } | null {
  if (
    !isSetNumber(state.targetEnemySampleX) ||
    !isSetNumber(state.targetEnemySampleZ)
  ) {
    return null;
  }
  return { x: state.targetEnemySampleX, z: state.targetEnemySampleZ };
}

/** Sim ticks between swings. From the weapon table, not a local copy. */
export function meleeCooldownTicks(): number {
  return msToTicks(MELEE_COOLDOWN_MS);
}

/** Next think may swing once `tick` reaches this. */
export function armMeleeCooldown(state: BotBrainState, tick: number): void {
  if (!Number.isFinite(tick)) return;
  state.reactionReadyAtTick = tick + meleeCooldownTicks();
}
