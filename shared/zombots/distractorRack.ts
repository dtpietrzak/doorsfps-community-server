/**
 * Dis-rack-tor rack: spend zompoints to lure every zombie to the rack instead
 * of the players for 1 minute ({@link ZOMBOTS_TUNING.racks.distractorDurationMs}).
 * First use costs {@link ZOMBOTS_TUNING.racks.distractorBaseCost} (2000), and
 * every use raises the cost by {@link ZOMBOTS_TUNING.racks.distractorCostStep}
 * (500). Free of charge when refused (downed, out of reach, already active, or
 * not enough zompoints).
 *
 * Pure: no clock, no wall-time. The caller passes the current sim tick and the
 * duration in ticks.
 */

import { withinRackReach } from "./armory.ts";
import type { ZompointsSpendResult } from "./zompoints.ts";
import { ZOMBOTS_TUNING } from "./zombotsTuning.ts";

export type DistractorRefusal =
  | "downed"
  | "outOfReach"
  | "alreadyActive"
  | "notEnough";

export type DistractorActivateResult =
  | { kind: "refused"; reason: DistractorRefusal }
  | {
    kind: "ok";
    cost: number;
    rackId: string;
    point: { x: number; z: number };
    endsAtTick: number;
    uses: number;
  };

export type DistractorActivateInput = {
  rackId: string;
  rackCenter: { x: number; z: number };
  /** Floor point in front of the rack that zombies walk toward. */
  lurePoint: { x: number; z: number };
  eye: { x: number; z: number };
  isDowned: boolean;
  tick: number;
  durationTicks: number;
  /** Debit the purse. Called once, only when everything else passes. */
  trySpend: (cost: number) => Pick<ZompointsSpendResult, "ok">;
};

export type ActiveDistractor = {
  rackId: string;
  point: { x: number; z: number };
  endsAtTick: number;
};

/** How far off the wall centerline (along the rack's facing normal) zombies gather. */
export const DISTRACTOR_LURE_OFFSET = 1.0;

/** Current zompoints cost for the next dis-rack-tor use after `uses` activations. */
export function distractorCostForUses(uses: number): number {
  const n = Number.isFinite(uses) && uses > 0 ? Math.floor(uses) : 0;
  return ZOMBOTS_TUNING.racks.distractorBaseCost +
    n * ZOMBOTS_TUNING.racks.distractorCostStep;
}

/** Floor point in front of a wall-mounted rack that zombies can path to. */
export function distractorLurePoint(
  center: { x: number; z: number },
  facing: { x: number; z: number } | null,
): { x: number; z: number } {
  if (!facing) return { x: center.x, z: center.z };
  return {
    x: center.x + facing.x * DISTRACTOR_LURE_OFFSET,
    z: center.z + facing.z * DISTRACTOR_LURE_OFFSET,
  };
}

export class DistractorTracker {
  private usesValue = 0;
  private activeValue: ActiveDistractor | null = null;

  /** Total activations in this run. */
  get uses(): number {
    return this.usesValue;
  }

  /** Zompoints the next activation will cost. */
  get nextCost(): number {
    return distractorCostForUses(this.usesValue);
  }

  /** Active lure state, or null when expired / never activated. */
  activeAt(tick: number): ActiveDistractor | null {
    if (!this.activeValue) return null;
    if (tick >= this.activeValue.endsAtTick) return null;
    return this.activeValue;
  }

  isActive(tick: number): boolean {
    return this.activeAt(tick) !== null;
  }

  /** Clear an expired lure. Returns true on the tick it expired. */
  expire(tick: number): boolean {
    if (!this.activeValue || tick < this.activeValue.endsAtTick) return false;
    this.activeValue = null;
    return true;
  }

  tryActivate(input: DistractorActivateInput): DistractorActivateResult {
    if (input.isDowned) return { kind: "refused", reason: "downed" };
    if (!withinRackReach(input.rackCenter, input.eye)) {
      return { kind: "refused", reason: "outOfReach" };
    }
    if (this.isActive(input.tick)) {
      return { kind: "refused", reason: "alreadyActive" };
    }
    const cost = this.nextCost;
    if (!input.trySpend(cost).ok) {
      return { kind: "refused", reason: "notEnough" };
    }
    this.usesValue += 1;
    const endsAtTick = input.tick + Math.max(1, Math.round(input.durationTicks));
    const point = { x: input.lurePoint.x, z: input.lurePoint.z };
    this.activeValue = {
      rackId: input.rackId,
      point,
      endsAtTick,
    };
    return {
      kind: "ok",
      cost,
      rackId: input.rackId,
      point,
      endsAtTick,
      uses: this.usesValue,
    };
  }
}
