/**
 * Power recharge rack (the user's call, 2026-11-24).
 *
 * Skills are one use each and only come back on an enemy door capture. Zombots
 * has no captures, so a power rack restores them: use it with at least one
 * spent skill and {@link ZOMBOTS_TUNING.racks.powerCost} zompoints and the
 * glue starts the same 1 s charge regen a capture does. Energy is untouched
 * (it refills on its own). Free of charge when refused: nothing spent means
 * nothing to restore, so the purse is never debited for a no-op.
 *
 * Pure: the glue supplies the purse debit and reads the verdict. Reach is the
 * gun racks' reach ({@link withinRackReach}).
 */

import { withinRackReach } from "./armory.ts";
import type { ZompointsSpendResult } from "./zompoints.ts";
import { ZOMBOTS_TUNING } from "./zombotsTuning.ts";

export type PowerRechargeRefusal =
  | "downed"
  | "outOfReach"
  | "nothingSpent"
  | "notEnough";

export type PowerRechargeResult =
  | { kind: "refused"; reason: PowerRechargeRefusal }
  | { kind: "ok"; cost: number };

export type PowerRechargeInput = {
  rackCenter: { x: number; z: number };
  eye: { x: number; z: number };
  isDowned: boolean;
  /** True when the player has a spent skill (and no regen already running). */
  canRecharge: boolean;
  /** Debit the purse. Called once, only when everything else passes. */
  trySpend: (cost: number) => Pick<ZompointsSpendResult, "ok">;
};

export function tryPowerRecharge(input: PowerRechargeInput): PowerRechargeResult {
  if (input.isDowned) return { kind: "refused", reason: "downed" };
  if (!withinRackReach(input.rackCenter, input.eye)) {
    return { kind: "refused", reason: "outOfReach" };
  }
  if (!input.canRecharge) return { kind: "refused", reason: "nothingSpent" };
  const cost = ZOMBOTS_TUNING.racks.powerCost;
  if (!input.trySpend(cost).ok) return { kind: "refused", reason: "notEnough" };
  return { kind: "ok", cost };
}
