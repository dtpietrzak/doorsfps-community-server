/**
 * Per-player guns (notes/zombots.md decision 8).
 *
 * Everyone joins unarmed. A rack take is free and the rack never runs out.
 * The first take of a weapon emits `weaponTaken`; a later take of the same
 * weapon is an ammo refill for the glue, with no intent. Reach is planar
 * and inclusive: squared distance, so a point exactly `racks.reach` away
 * is in reach without a square-root rounding the boundary.
 */

import { distanceSquared2 } from "../math/distance.ts";
import {
  getWeapon,
  shellReloadOf,
  spareClipsForWeapon,
  WEAPON_ORDER,
  WEAPON_PISTOL,
  WEAPON_RIFLE,
  WEAPON_SHOTGUN,
} from "../sim/weapons.ts";
import type { ZombotsIntent, ZombotsPlayerId, ZombotsRackKind, ZombotsRackWeapon } from "./types.ts";
import { ZOMBOTS_TUNING } from "./zombotsTuning.ts";

/** Sim weapon id for each rack kind. */
export const ZOMBOTS_RACK_WEAPON_ID: Record<ZombotsRackWeapon, number> = {
  pistol: WEAPON_PISTOL,
  rifle: WEAPON_RIFLE,
  shotgun: WEAPON_SHOTGUN,
};

export type ZombotsGunRack = {
  id: string;
  weapon: ZombotsRackWeapon;
  center: { x: number; z: number };
};

/** Any rack on the map: a gun rack, power recharge rack, or dis-rack-tor. */
export type ZombotsRack = Omit<ZombotsGunRack, "weapon"> & { weapon: ZombotsRackKind };

/** True for a rack that hangs a gun (the armory's), not power/distractor. */
export function isGunRackEntry(rack: ZombotsRack): rack is ZombotsGunRack {
  return rack.weapon !== "power" && rack.weapon !== "distractor";
}

/**
 * Magazines granted by a gun rack use:
 * - First take (`!armed`): all magazines (`totalClips`, loaded + spares).
 * - Refill (`armed`): missing spare magazines (0 when spare mags are full).
 *   Shell-reloading guns (shotgun) round missing shells up to whole tubes (`magSize`).
 */
export function gunRackMags(
  weaponId: number,
  armed: boolean,
  spareClips: number,
): number {
  const w = getWeapon(weaponId);
  if (!armed) return Math.max(0, w.totalClips);
  const fullSpares = spareClipsForWeapon(weaponId);
  const missing = Math.max(0, fullSpares - Math.max(0, spareClips));
  if (missing <= 0) return 0;
  return shellReloadOf(w) ? Math.ceil(missing / w.magSize) : missing;
}

/** Zompoints a gun rack use costs (`gunRackMags * ZOMBOTS_TUNING.racks.gunCostPerMag`). */
export function gunRackCost(
  weaponId: number,
  armed: boolean,
  spareClips: number,
): number {
  return gunRackMags(weaponId, armed, spareClips) * ZOMBOTS_TUNING.racks.gunCostPerMag;
}

export type RackTakeRefusal = "outOfReach" | "downed" | "absent";

export type WeaponTakenIntent = Extract<ZombotsIntent, { kind: "weaponTaken" }>;

export type RackTakeResult =
  | { kind: "refused"; reason: RackTakeRefusal }
  | {
    kind: "ok";
    /** False when they already had this weapon: the glue refills ammo. */
    firstTake: boolean;
    weaponId: number;
    /** Set only on the first take. A refill emits nothing. */
    intent?: WeaponTakenIntent;
  };

/**
 * Inclusive planar reach around a rack. Non-finite coordinates are out of
 * reach: a NaN squared distance would otherwise compare as in reach.
 */
export function withinRackReach(
  center: { x: number; z: number },
  eye: { x: number; z: number },
  reach = ZOMBOTS_TUNING.racks.reach,
): boolean {
  if (
    !Number.isFinite(eye.x) || !Number.isFinite(eye.z) ||
    !Number.isFinite(center.x) || !Number.isFinite(center.z) ||
    !Number.isFinite(reach)
  ) {
    return false;
  }
  return distanceSquared2(eye.x - center.x, eye.z - center.z) <= reach * reach;
}

export class Armory {
  private readonly armed = new Map<ZombotsPlayerId, Set<number>>();

  /** Empty set. A second join does not take guns away. */
  join(playerId: ZombotsPlayerId): void {
    if (this.armed.has(playerId)) return;
    this.armed.set(playerId, new Set());
  }

  leave(playerId: ZombotsPlayerId): void {
    this.armed.delete(playerId);
  }

  /** True once the player has joined (and until they leave). */
  has(playerId: ZombotsPlayerId): boolean {
    return this.armed.has(playerId);
  }

  isArmed(playerId: ZombotsPlayerId, weaponId: number): boolean {
    return this.armed.get(playerId)?.has(weaponId) ?? false;
  }

  /** Weapon ids this player holds, in `WEAPON_ORDER` (not take order). */
  armedWeapons(playerId: ZombotsPlayerId): number[] {
    const have = this.armed.get(playerId);
    if (!have) return [];
    const out: number[] = [];
    for (const weaponId of WEAPON_ORDER) {
      if (have.has(weaponId)) out.push(weaponId);
    }
    return out;
  }

  /**
   * Take or refill from a rack. `isDowned` is the taker. Downed, unknown,
   * and out-of-reach players take nothing. Checks run in that order.
   * `firstTake` is per weapon, not per rack: a second pistol rack refills.
   */
  tryTakeFromRack(
    playerId: ZombotsPlayerId,
    rack: ZombotsGunRack,
    eye: { x: number; z: number },
    isDowned: boolean,
  ): RackTakeResult {
    const have = this.armed.get(playerId);
    if (!have) return { kind: "refused", reason: "absent" };
    if (isDowned) return { kind: "refused", reason: "downed" };
    if (!withinRackReach(rack.center, eye)) return { kind: "refused", reason: "outOfReach" };
    const weaponId = ZOMBOTS_RACK_WEAPON_ID[rack.weapon];
    if (have.has(weaponId)) return { kind: "ok", firstTake: false, weaponId };
    have.add(weaponId);
    return {
      kind: "ok",
      firstTake: true,
      weaponId,
      intent: { kind: "weaponTaken", playerId, rackId: rack.id, weapon: rack.weapon },
    };
  }
}

export type RackBuyRefusal = RackTakeRefusal | "full" | "notEnough";

export type RackBuyResult =
  | { kind: "refused"; reason: RackBuyRefusal }
  | (Extract<RackTakeResult, { kind: "ok" }> & { cost: number });

export type RackBuyInput = {
  playerId: ZombotsPlayerId;
  rack: ZombotsGunRack;
  eye: { x: number; z: number };
  isDowned: boolean;
  /** Spare mags the player holds for this rack's gun now (0 when unarmed). */
  spareClips: number;
  /** True when those spare mags are already full. */
  spareClipsFull: boolean;
  /** Debit the purse. Called at most once, after every other check passes. */
  trySpend: (cost: number) => { ok: boolean };
};

/**
 * Buy from a gun rack (notes/zombots.md "Gun rack cost and full-ammo
 * refusal"): a first take buys every mag, a refill buys the missing spare
 * mags at {@link ZOMBOTS_TUNING.racks.gunCostPerMag} each. Refusals in order:
 * absent, downed, out of reach, full (already armed with full spares), not
 * enough points. Nothing is debited and nothing is armed on a refusal; the
 * glue sends a `rackRefused` feed event only for "full".
 */
export function tryBuyFromRack(armory: Armory, input: RackBuyInput): RackBuyResult {
  const { playerId, rack, eye, isDowned } = input;
  if (!armory.has(playerId)) return { kind: "refused", reason: "absent" };
  if (isDowned) return { kind: "refused", reason: "downed" };
  if (!withinRackReach(rack.center, eye)) return { kind: "refused", reason: "outOfReach" };
  const weaponId = ZOMBOTS_RACK_WEAPON_ID[rack.weapon];
  const armed = armory.isArmed(playerId, weaponId);
  const cost = gunRackCost(weaponId, armed, input.spareClips);
  if ((armed && input.spareClipsFull) || cost <= 0) {
    return { kind: "refused", reason: "full" };
  }
  if (!input.trySpend(cost).ok) return { kind: "refused", reason: "notEnough" };
  const taken = armory.tryTakeFromRack(playerId, rack, eye, isDowned);
  // Unreachable after the checks above; kept so a refusal can never arm.
  if (taken.kind !== "ok") return taken;
  return { ...taken, cost };
}
