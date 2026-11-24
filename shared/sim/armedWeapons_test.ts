import { assertEquals } from "@std/assert";
import {
  FIST_MELEE,
  isWeaponArmedIn,
  meleeForLoadout,
  nextArmedWeapon,
} from "./armedWeapons.ts";
import {
  PISTOL,
  RIFLE,
  SHOTGUN,
  WEAPON_ORDER,
  WEAPON_PISTOL,
  WEAPON_RIFLE,
  WEAPON_SHOTGUN,
} from "./weapons.ts";

Deno.test("armedWeapons: null arms everything and cycles like +1", () => {
  for (const id of WEAPON_ORDER) {
    assertEquals(isWeaponArmedIn(null, id), true);
    const idx = WEAPON_ORDER.indexOf(id);
    assertEquals(
      nextArmedWeapon(id, null),
      WEAPON_ORDER[(idx + 1) % WEAPON_ORDER.length],
    );
  }
});

Deno.test("armedWeapons: cycling skips unarmed and returns null when alone", () => {
  const armed = new Set([WEAPON_PISTOL, WEAPON_SHOTGUN]);
  assertEquals(nextArmedWeapon(WEAPON_PISTOL, armed), WEAPON_SHOTGUN);
  assertEquals(nextArmedWeapon(WEAPON_SHOTGUN, armed), WEAPON_PISTOL);
  // Empty hands on an unarmed slot step to the next armed gun.
  assertEquals(nextArmedWeapon(WEAPON_RIFLE, armed), WEAPON_SHOTGUN);
  assertEquals(nextArmedWeapon(WEAPON_RIFLE, new Set([WEAPON_RIFLE])), null);
  assertEquals(nextArmedWeapon(WEAPON_PISTOL, new Set()), null);
});

Deno.test("armedWeapons: unarmed slot swings the fist, armed guns their own", () => {
  const none = new Set<number>();
  assertEquals(meleeForLoadout(RIFLE, none), FIST_MELEE);
  assertEquals(meleeForLoadout(PISTOL, null), PISTOL.melee);
  assertEquals(meleeForLoadout(SHOTGUN, new Set([WEAPON_SHOTGUN])), SHOTGUN.melee);
  assertEquals(meleeForLoadout(RIFLE, new Set([WEAPON_RIFLE])), undefined);
});
