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
import { WEAPON_ORDER, WEAPON_PISTOL, WEAPON_RIFLE, WEAPON_SHOTGUN } from "../sim/weapons.ts";
import type { ZombotsIntent, ZombotsPlayerId, ZombotsRackWeapon } from "./types.ts";
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
