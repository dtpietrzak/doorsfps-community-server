/**
 * Skill F — Teleport (Hacker, instant, distance).
 * Run: deno test -A server/players/ability_teleport_test.ts
 */
import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import {
  abilityBarRegenTicks,
  abilityDoorRegenTicks,
} from "../shared/sim/abilities.ts";
import {
  INSTANT_SKILL_FLASH_TICKS,
  instantSkillLockTicks,
  skillValueForOwned,
} from "../shared/sim/skills.ts";
import { blinkAlongYaw, NO_COLLISION } from "../shared/sim/moveStep.ts";
import { Player } from "./Player.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";

const instantLockTicks = instantSkillLockTicks();
const barRegenTicks = abilityBarRegenTicks();

function openMap(): DoorsMap {
  return {
    version: 1,
    name: "teleport-open",
    bounds: { minX: -100, maxX: 100, minZ: -100, maxZ: 100 },
    gridSize: 1,
    teamA: {
      corners: [0, 1],
      edge: "south",
      doorHalfWidth: 2,
      spawnRadius: 4,
    },
    teamB: {
      corners: [2, 3],
      edge: "north",
      doorHalfWidth: 2,
      spawnRadius: 4,
    },
    walls: [],
  };
}

/** Wall across +Z so blink forward (yaw=0 → −Z) is free; wall blocks +Z. */
function wallMap(): DoorsMap {
  return {
    ...openMap(),
    name: "teleport-wall",
    walls: [
      // Full wall at z = -3, spanning x so forward blink (yaw 0 → −z) hits it.
      { id: "w1", a: { x: -20, z: -3 }, b: { x: 20, z: -3 } },
    ],
  };
}

function makePlayer(
  owned?: readonly string[] | null,
  yaw = 0,
): Player {
  const p = new Player("t", "TeleportTester", "A", {
    spawn: { x: 0, y: 1.7, z: 0, yaw },
    ...(owned !== undefined ? { ownedAbilities: owned } : {}),
  });
  p.spawnedAtTick = 0;
  p.restoreAbilityCharges();
  return p;
}

/** Owned chain for Teleport I (needs rewind tree). */
const TELEPORT_I = [
  "quick",
  "glitch",
  "rewind",
  "teleport",
] as const;

const TELEPORT_II = [...TELEPORT_I, "teleport2"] as const;
const TELEPORT_III = [...TELEPORT_II, "teleport3"] as const;

Deno.test("blinkAlongYaw open space moves full distance along yaw", () => {
  // yaw 0 → forward (−z)
  const got = blinkAlongYaw(NO_COLLISION, 0, 0, 0, 4);
  assertAlmostEquals(got.x, 0, 1e-5);
  assertAlmostEquals(got.z, -4, 1e-5);

  // yaw π/2 → (−x)
  const left = blinkAlongYaw(NO_COLLISION, 0, 0, Math.PI / 2, 6);
  assertAlmostEquals(left.x, -6, 1e-5);
  assertAlmostEquals(left.z, 0, 1e-5);
});

Deno.test("blinkAlongYaw stops before a wall", () => {
  const col = new MapCollision(wallMap());
  // Start at origin; wall at z=-3; blink 7u forward (yaw 0 → −z).
  const got = blinkAlongYaw(col, 0, 0, 0, 7, 0, 1.7);
  // Should stop near the wall (z ≈ -3 + radius + half-thick), not past it.
  assertEquals(got.z > -3, true);
  assertEquals(got.z < -1.5, true); // still moved well past start
  assertAlmostEquals(got.x, 0, 0.2);
});

Deno.test("teleport unrestricted = tier III 7u in open space", () => {
  const p = makePlayer(); // unrestricted → max 7
  assertEquals(skillValueForOwned("teleport", null), 7);
  const startX = p.x;
  const startZ = p.z;
  const startY = p.y;
  assertEquals(p.tryActivateAbility("teleport", 0), true);
  // yaw 0 → −z by 7
  assertAlmostEquals(p.x, startX, 1e-5);
  assertAlmostEquals(p.z, startZ - 7, 1e-4);
  assertAlmostEquals(p.y, startY, 1e-5); // eye height preserved
  assertEquals(p.isAbilitySpent("teleport"), true);
  assertEquals(p.abilityGlobalLockEndsAtTick, instantLockTicks);
  assertEquals(p.velocityY, 0);
});

Deno.test("teleport tier I is 3u; tier II 5u; tier III 7u", () => {
  assertEquals(skillValueForOwned("teleport", [...TELEPORT_I]), 3);
  assertEquals(skillValueForOwned("teleport", [...TELEPORT_II]), 5);
  assertEquals(skillValueForOwned("teleport", [...TELEPORT_III]), 7);

  const p1 = makePlayer(TELEPORT_I);
  assertEquals(p1.tryActivateAbility("teleport", 0), true);
  assertAlmostEquals(p1.z, -3, 1e-4);

  const p2 = makePlayer(TELEPORT_II);
  assertEquals(p2.tryActivateAbility("teleport", 0), true);
  assertAlmostEquals(p2.z, -5, 1e-4);

  const p3 = makePlayer(TELEPORT_III);
  assertEquals(p3.tryActivateAbility("teleport", 0), true);
  assertAlmostEquals(p3.z, -7, 1e-4);
});

Deno.test("teleport with MapCollision stops at wall", () => {
  const col = new MapCollision(wallMap());
  const p = makePlayer(TELEPORT_III); // 7u would pass wall at −3
  const startZ = p.z;
  assertEquals(p.tryActivateAbility("teleport", 0, col), true);
  assertEquals(p.z > -3, true);
  assertEquals(p.z < startZ - 1, true);
});

Deno.test("teleport denied when unowned (guest)", () => {
  const p = makePlayer([]);
  assertEquals(p.ownsAbility("teleport"), false);
  assertEquals(p.tryActivateAbility("teleport", 0), false);
  assertEquals(p.isAbilitySpent("teleport"), false);
});

Deno.test("teleport denied when dead", () => {
  const p = makePlayer();
  p.alive = false;
  assertEquals(p.tryActivateAbility("teleport", 0), false);
});

Deno.test("teleport denied while global lock / spent", () => {
  const p = makePlayer(TELEPORT_I);
  const tick = 0;
  assertEquals(p.tryActivateAbility("teleport", tick), true);
  assertEquals(p.tryActivateAbility("teleport", tick + 1), false);
  // After lock + bar regen, still spent until door regen.
  const after = tick + instantLockTicks + barRegenTicks;
  p.tickAbilityCharges(after);
  assertEquals(p.tryActivateAbility("teleport", after), false);
  assertEquals(p.isAbilitySpent("teleport"), true);
});

Deno.test("teleport flash for VFX without re-spend on expire", () => {
  const p = makePlayer();
  const tick = 5;
  assertEquals(p.tryActivateAbility("teleport", tick), true);
  if (INSTANT_SKILL_FLASH_TICKS > 0) {
    assertEquals(p.isAbilityActive("teleport", tick), true);
  }
  p.tickAbilityCharges(tick + INSTANT_SKILL_FLASH_TICKS);
  assertEquals(p.isAbilitySpent("teleport"), true);
});

Deno.test("door regen restores teleport charge", () => {
  const p = makePlayer(TELEPORT_I);
  const tick = 0;
  assertEquals(p.tryActivateAbility("teleport", tick), true);
  assertEquals(p.isAbilitySpent("teleport"), true);

  const idle = tick + instantLockTicks + barRegenTicks;
  p.tickAbilityCharges(idle);
  p.beginAbilityDoorRegen(idle);
  p.tickAbilityCharges(idle + abilityDoorRegenTicks());
  assertEquals(p.isAbilitySpent("teleport"), false);

  // Can blink again after regen.
  const zBefore = p.z;
  assertEquals(
    p.tryActivateAbility("teleport", idle + abilityDoorRegenTicks()),
    true,
  );
  assertEquals(Math.abs(p.z - zBefore) > 1, true);
});

Deno.test("snapshot includes teleport spent + pose after activate", () => {
  const p = makePlayer(TELEPORT_I);
  const tick = 10;
  assertEquals(p.tryActivateAbility("teleport", tick), true);
  const full = p.toSnapshot(tick, "full");
  assertEquals(full.abilitySpent?.includes("teleport") ?? false, true);
  assertAlmostEquals(full.z, -3, 1e-4);
});

Deno.test("teleport preserves crouch eye height (y)", () => {
  const p = makePlayer(TELEPORT_I);
  p.crouch = true;
  p.y = 1.05; // crouch eye
  assertEquals(p.tryActivateAbility("teleport", 0), true);
  assertAlmostEquals(p.y, 1.05, 1e-5);
  assertEquals(p.crouch, true);
});
