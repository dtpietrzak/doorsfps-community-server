/**
 * Per-player armed weapons (notes/zombots.md step 12a). Shared by the server
 * sim and client prediction.
 *
 * Arenas, ranked and raids carry every gun in `WEAPON_ORDER` and pass `null`
 * ("everything armed"), so none of this changes them. Zombots players start
 * with an empty set and arm guns from racks. A player whose equipped slot is
 * not armed holds nothing: no fire, no reload, but they can still swing a fist.
 */

import {
  PISTOL,
  WEAPON_ORDER,
  type WeaponDef,
  type WeaponMelee,
} from "./weapons.ts";

/** Armed weapon ids, or null when every weapon is armed. */
export type ArmedWeapons = ReadonlySet<number> | null;

/**
 * The unarmed swing. It reuses the pistol-whip numbers so an unarmed human's
 * cadence and reach match the pistol. A zombie bite uses
 * `ZOMBOTS_TUNING.zombie.meleeRange` instead of this range, and wave damage
 * replaces `baseDamage` per zombie.
 */
export const FIST_MELEE: WeaponMelee = PISTOL.melee!;

export function isWeaponArmedIn(armed: ArmedWeapons, weaponId: number): boolean {
  return armed === null || armed.has(weaponId);
}

/**
 * Next armed weapon after `currentId` in `WEAPON_ORDER` (wrapping), or null
 * when nothing else is armed. With `armed` null this is plain +1 cycling.
 */
export function nextArmedWeapon(
  currentId: number,
  armed: ArmedWeapons,
): number | null {
  const order = WEAPON_ORDER;
  const idx = order.indexOf(currentId as (typeof order)[number]);
  const start = idx < 0 ? -1 : idx;
  for (let step = 1; step <= order.length; step++) {
    const candidate = order[(start + step) % order.length]!;
    if (candidate !== currentId && isWeaponArmedIn(armed, candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * The swing a player can make: the equipped gun's melee when it is armed
 * (undefined for guns without one, which zoom instead), else the fist.
 */
export function meleeForLoadout(
  equipped: WeaponDef,
  armed: ArmedWeapons,
): WeaponMelee | undefined {
  return isWeaponArmedIn(armed, equipped.id) ? equipped.melee : FIST_MELEE;
}
