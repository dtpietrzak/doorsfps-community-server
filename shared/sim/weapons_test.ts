import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import {
  clampHitDamage,
  crosshairSpreadMultFromDeg,
  damageFalloffMult,
  isWeaponId,
  MELEE_BASE_DAMAGE,
  MELEE_COOLDOWN_MS,
  MELEE_HIT_MOMENT_T,
  MELEE_RANGE,
  MELEE_SWING_MS,
  PISTOL,
  RIFLE,
  SHOTGUN,
  shotBaseDamage,
  type WeaponDef,
  WEAPON_ORDER,
  WEAPON_PISTOL,
  WEAPON_RIFLE,
  WEAPON_SHOTGUN,
} from "./weapons.ts";
import { rollDamageVariation } from "./game.ts";

Deno.test("damageFalloffMult: full damage inside fullDamageRange", () => {
  assertEquals(damageFalloffMult(PISTOL, 0), 1);
  assertEquals(damageFalloffMult(PISTOL, 10), 1);
  assertEquals(damageFalloffMult(PISTOL, 25), 1);
});

Deno.test("damageFalloffMult: linear ramp down to the floor", () => {
  assertAlmostEquals(damageFalloffMult(PISTOL, 37.5), (1 + 0.45) / 2);
  assertAlmostEquals(damageFalloffMult(PISTOL, 50), 0.45);
});

Deno.test("damageFalloffMult: floor holds far past minDamageRange, never 0", () => {
  for (const d of [50, 51, 100, 500, 10_000, Number.POSITIVE_INFINITY]) {
    const mult = damageFalloffMult(PISTOL, d);
    assertEquals(mult, 0.45);
    assert(mult > 0);
  }
});

Deno.test("damageFalloffMult: weapons without falloff stay at 1", () => {
  assertEquals(RIFLE.falloff, undefined);
  assertEquals(damageFalloffMult(RIFLE, 0), 1);
  assertEquals(damageFalloffMult(RIFLE, 900), 1);
});

Deno.test("damageFalloffMult: NaN / negative distances are full damage", () => {
  assertEquals(damageFalloffMult(PISTOL, Number.NaN), 1);
  assertEquals(damageFalloffMult(PISTOL, -5), 1);
});

Deno.test("damageFalloffMult: degenerate ramp snaps to the floor", () => {
  const w: WeaponDef = {
    ...PISTOL,
    falloff: { fullDamageRange: 10, minDamageRange: 10, minMult: 0.5 },
  };
  assertEquals(damageFalloffMult(w, 10), 1);
  assertEquals(damageFalloffMult(w, 10.01), 0.5);
});

Deno.test("shotBaseDamage: pistol body/head at range", () => {
  assertEquals(shotBaseDamage(PISTOL, false, 5), 30);
  assertEquals(shotBaseDamage(PISTOL, true, 5), 55);
  assertAlmostEquals(shotBaseDamage(PISTOL, false, 60), 13.5);
  assertAlmostEquals(shotBaseDamage(PISTOL, true, 60), 24.75);
  assertEquals(shotBaseDamage(RIFLE, true, 800), RIFLE.headDamage);
});

Deno.test("clampHitDamage: a real hit always does at least 1", () => {
  assertEquals(clampHitDamage(0), 1);
  assertEquals(clampHitDamage(-3), 1);
  assertEquals(clampHitDamage(Number.NaN), 1);
  assertEquals(clampHitDamage(17), 17);
  // A tiny far hit that rolls -5 still lands for 1.
  const tiny = rollDamageVariation(2, 0).damage;
  assertEquals(tiny, 0);
  assertEquals(clampHitDamage(tiny), 1);
});

Deno.test("shotgun PR8: loadout order is pistol → rifle → shotgun", () => {
  assertEquals([...WEAPON_ORDER], [WEAPON_PISTOL, WEAPON_RIFLE, WEAPON_SHOTGUN]);
  assertEquals(SHOTGUN.id, WEAPON_SHOTGUN);
  assert(isWeaponId(WEAPON_PISTOL));
  assert(isWeaponId(WEAPON_RIFLE));
  assert(isWeaponId(WEAPON_SHOTGUN));
  assertEquals(isWeaponId(3), false);
  assertEquals(isWeaponId("0"), false);
});

Deno.test("shotgun PR8: crosshair mult grows from cone + still", () => {
  // Shotgun still: 1× of its cone-sized base ring; movement grows slowly
  // because the cone dominates. Pistol/rifle keep the legacy formula.
  assertEquals(crosshairSpreadMultFromDeg(WEAPON_SHOTGUN, 1.2), 1);
  assertAlmostEquals(
    crosshairSpreadMultFromDeg(WEAPON_SHOTGUN, 2.2),
    (4.5 + 2.2 + 1) / (4.5 + 1.2 + 1),
  );
  assertEquals(crosshairSpreadMultFromDeg(WEAPON_SHOTGUN, 0), 1);
  assertEquals(crosshairSpreadMultFromDeg(WEAPON_RIFLE, 0), 1);
  assertEquals(crosshairSpreadMultFromDeg(WEAPON_RIFLE, 1.15), 2);
  assertEquals(crosshairSpreadMultFromDeg(WEAPON_PISTOL, 1.0), 1);
});

Deno.test("pistol-whip stats live on PISTOL.melee (aliases unchanged)", () => {
  const m = PISTOL.melee!;
  assertEquals(m, {
    baseDamage: 50,
    range: 2.8,
    cooldownMs: 700,
    swingMs: 450,
    hitMomentT: 0.45,
  });
  assertEquals(MELEE_BASE_DAMAGE, m.baseDamage);
  assertEquals(MELEE_RANGE, m.range);
  assertEquals(MELEE_COOLDOWN_MS, m.cooldownMs);
  assertEquals(MELEE_SWING_MS, m.swingMs);
  assertEquals(MELEE_HIT_MOMENT_T, m.hitMomentT);
  assertEquals(RIFLE.melee, undefined);
});
