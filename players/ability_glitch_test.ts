/**
 * PR4 Glitch — invisible 3s, cannot shoot, forced visible within 5u of enemy door.
 * Run: deno test -A server/players/ability_glitch_test.ts
 */
import { assertEquals } from "jsr:@std/assert@1";
import { abilityDurationTicks } from "../shared/sim/abilities.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";
import { getWeapon, WEAPON_PISTOL } from "../protocol/network.ts";
import { Player } from "./Player.ts";

const durationTicks = abilityDurationTicks("glitch");
const pistol = getWeapon(WEAPON_PISTOL);
const cd = pistol.fireCooldownTicks;

const openMap: DoorsMap = {
  version: 1,
  name: "GlitchOpen",
  bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 },
  gridSize: 1,
  walls: [],
  teamA: {
    corners: [0, 1],
    edge: "south",
    doorHalfWidth: 2.5,
    spawnRadius: 3,
  },
  teamB: {
    corners: [2, 3],
    edge: "north",
    doorHalfWidth: 2.5,
    spawnRadius: 3,
  },
};

function makePlayer(): Player {
  const p = new Player("g", "GlitchTester", "A", {
    spawn: { x: 0, z: 0, yaw: Math.PI },
  });
  p.spawnedAtTick = 0;
  p.restoreAbilityCharges();
  return p;
}

function makeCollision(): MapCollision {
  return new MapCollision(openMap);
}

Deno.test("tryActivateAbility glitch sets end tick and isAbilityActive", () => {
  const p = makePlayer();
  const tick = 10;
  assertEquals(p.tryActivateAbility("glitch", tick), true);
  assertEquals(p.isAbilityActive("glitch", tick), true);
  assertEquals(p.isAbilityActive("glitch", tick + durationTicks - 1), true);
  assertEquals(p.isAbilityActive("glitch", tick + durationTicks), false);
  // Re-activate while active is no-op
  assertEquals(p.tryActivateAbility("glitch", tick + 1), false);
});

Deno.test("canShoot is false for full glitch window (even when door-revealed)", () => {
  const p = makePlayer();
  const col = makeCollision();
  const tick = 0;
  assertEquals(p.canShoot(tick), true);
  assertEquals(p.tryActivateAbility("glitch", tick), true);
  // Mid-map: hidden
  p.x = 0;
  p.z = 0;
  assertEquals(p.canShoot(tick), false);
  assertEquals(p.canShoot(tick + durationTicks - 1), false);
  // At enemy door: revealed, still cannot shoot
  p.z = 20 - 1;
  assertEquals(p.glitchSnapState(tick, col), "revealed");
  assertEquals(p.canShoot(tick), false);
  // After window ends, shoot resumes
  assertEquals(p.canShoot(tick + durationTicks), true);
});

Deno.test("glitch snap: hidden mid-map, revealed near enemy door", () => {
  const p = makePlayer();
  const col = makeCollision();
  const tick = 5;
  assertEquals(p.tryActivateAbility("glitch", tick), true);

  p.x = 0;
  p.z = 0;
  assertEquals(p.glitchSnapState(tick, col), "hidden");
  const mid = p.toSnapshot(tick, "motion", col);
  assertEquals(mid.glitch, "hidden");
  assertEquals(mid.abilities!.some((a) => a.id === "glitch"), true);

  // North door (team B) at z=20; 4u in front is still within 5u.
  p.z = 16;
  assertEquals(p.glitchSnapState(tick, col), "revealed");
  const near = p.toSnapshot(tick, "motion", col);
  assertEquals(near.glitch, "revealed");

  // Just outside 5u.
  p.z = 14.9;
  assertEquals(p.glitchSnapState(tick, col), "hidden");

  // After expiry: no glitch field
  const after = p.toSnapshot(tick + durationTicks, "motion", col);
  assertEquals(after.glitch, undefined);
  assertEquals(
    after.abilities?.some((a) => a.id === "glitch") ?? false,
    false,
  );
});

Deno.test("dead player cannot activate Glitch", () => {
  const p = makePlayer();
  p.alive = false;
  assertEquals(p.tryActivateAbility("glitch", 0), false);
});

Deno.test("glitch duration is 3s wall-clock (TICK_HZ ticks)", () => {
  // Product: 3.0s. At default 60 Hz → 180 ticks.
  assertEquals(durationTicks, 180);
});

Deno.test("fire blocked mid-window even with free ammo / full mag", () => {
  const p = makePlayer();
  p.unlimitedAmmo = true;
  const tick = 0;
  assertEquals(p.canShoot(tick), true);
  assertEquals(p.tryActivateAbility("glitch", tick), true);
  assertEquals(p.canShoot(tick), false);
  // Cooldown would allow fire; glitch still blocks.
  assertEquals(p.canShoot(tick + cd), false);
  assertEquals(p.canShoot(tick + durationTicks), true);
});
