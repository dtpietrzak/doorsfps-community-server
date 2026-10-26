/**
 * PR5 Hawkeyes — perfect accuracy (0 aim cone) for 3s.
 * Run: deno test -A server/players/ability_hawkeyes_test.ts
 */
import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import { abilityDurationTicks } from "../shared/sim/abilities.ts";
import {
  aimSpreadRad,
  spreadDirectionFromYawPitch,
} from "../combat/aimSpread.ts";
import { directionFromYawPitch } from "../combat/hitscan.ts";
import { WEAPON_RIFLE } from "../shared/sim/weapons.ts";
import { Player } from "./Player.ts";

const durationTicks = abilityDurationTicks("hawkeyes");

function makePlayer(): Player {
  const p = new Player("h", "HawkeyesTester", "A", {
    spawn: { x: 0, z: 0, yaw: Math.PI },
  });
  p.spawnedAtTick = 0;
  p.restoreAbilityCharges();
  return p;
}

const airSprint = {
  onGround: false,
  crouch: false,
  moving: true,
  sprint: true,
  sliding: false,
} as const;

Deno.test("tryActivateAbility hawkeyes sets end tick and isAbilityActive", () => {
  const p = makePlayer();
  const tick = 10;
  assertEquals(p.tryActivateAbility("hawkeyes", tick), true);
  assertEquals(p.isAbilityActive("hawkeyes", tick), true);
  assertEquals(p.isAbilityActive("hawkeyes", tick + durationTicks - 1), true);
  assertEquals(p.isAbilityActive("hawkeyes", tick + durationTicks), false);
  // Re-activate while active is no-op
  assertEquals(p.tryActivateAbility("hawkeyes", tick + 1), false);
});

Deno.test("Hawkeyes duration is 3s wall-clock (TICK_HZ ticks)", () => {
  // Product: 3.0s. At default 60 Hz → 180 ticks.
  assertEquals(durationTicks, 180);
});

Deno.test("dead player cannot activate Hawkeyes", () => {
  const p = makePlayer();
  p.alive = false;
  assertEquals(p.tryActivateAbility("hawkeyes", 0), false);
});

Deno.test("snapshot includes active hawkeyes while window open", () => {
  const p = makePlayer();
  const tick = 20;
  p.tryActivateAbility("hawkeyes", tick);
  const snap = p.toSnapshot(tick, "motion");
  assertEquals(Array.isArray(snap.abilities), true);
  assertEquals(snap.abilities!.some((a) => a.id === "hawkeyes"), true);
  const entry = snap.abilities!.find((a) => a.id === "hawkeyes")!;
  assertEquals(entry.endsAtTick, tick + durationTicks);

  const after = p.toSnapshot(tick + durationTicks, "motion");
  assertEquals(
    after.abilities?.some((a) => a.id === "hawkeyes") ?? false,
    false,
  );
});

Deno.test("perfectAccuracy forces 0 spread; non-zero without", () => {
  // Air stance normally has large rifle bloom.
  assertEquals(aimSpreadRad(airSprint, WEAPON_RIFLE) > 0, true);
  assertEquals(
    aimSpreadRad(airSprint, WEAPON_RIFLE, { perfectAccuracy: true }),
    0,
  );
  assertEquals(
    aimSpreadRad(airSprint, WEAPON_RIFLE, { perfectAccuracy: false }),
    aimSpreadRad(airSprint, WEAPON_RIFLE),
  );
});

Deno.test("Hawkeyes ray direction matches look (zero cone)", () => {
  const p = makePlayer();
  const tick = 0;
  assertEquals(p.tryActivateAbility("hawkeyes", tick), true);

  // Simulate PlayerManager handleShoot path: perfectAccuracy when active.
  p.yaw = Math.PI / 4;
  p.pitch = -0.2;
  const perfect = p.isAbilityActive("hawkeyes", tick);
  const spread = aimSpreadRad(p.aimMovementState(), p.weaponId, {
    perfectAccuracy: perfect,
  });
  assertEquals(spread, 0);

  // Deterministic RNG would still matter if angle > 0; with 0, identity.
  const dir = spreadDirectionFromYawPitch(p.yaw, p.pitch, spread, () => 0.99);
  const look = directionFromYawPitch(p.yaw, p.pitch);
  assertAlmostEquals(dir.x, look.x, 1e-9);
  assertAlmostEquals(dir.y, look.y, 1e-9);
  assertAlmostEquals(dir.z, look.z, 1e-9);

  // After window ends, perfectAccuracy is off → air stance bloom resumes.
  const afterSpread = aimSpreadRad(airSprint, WEAPON_RIFLE, {
    perfectAccuracy: p.isAbilityActive("hawkeyes", tick + durationTicks),
  });
  assertEquals(afterSpread > 0, true);
});

Deno.test("Hawkeyes does not block shoot or free ammo", () => {
  const p = makePlayer();
  const tick = 0;
  const mag = p.ammoInMag;
  assertEquals(p.tryActivateAbility("hawkeyes", tick), true);
  assertEquals(p.canShoot(tick), true);
  assertEquals(p.hasFreeAmmo(tick), false);
  p.markShot(tick);
  assertEquals(p.ammoInMag, mag - 1);
});
