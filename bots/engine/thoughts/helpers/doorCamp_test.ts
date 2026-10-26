import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { MapCollision } from "../../world/MapCollision.ts";
import type { DoorsMap } from "../../shared/map.ts";
import {
  campLookHoldRangeSec,
  collectEnemyDoorCampClaims,
  DOOR_CAMP_OCCUPY_RADIUS,
  doorCampLookYaw,
  doorCampOwnDoorYaw,
  doorCampYawSignedDelta,
  enemySpawnCorners,
  isAtDoorCampPlant,
  pickEnemyDoorCampPlant,
  rollCampLookHoldSec,
  shortestArcPassesNear,
  wantsEnemyDoorCamp,
  wantsLipDoorCamp,
} from "./doorCamp.ts";
import { enemyDoorSide, enemyDoorTarget } from "../../helpers/nav.ts";

function openMap(): DoorsMap {
  return {
    version: 1,
    name: "DoorCampOpen",
    bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 },
    gridSize: 1,
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
    walls: [],
  };
}

Deno.test("wantsEnemyDoorCamp: strict less-than 0.5", () => {
  assertEquals(wantsEnemyDoorCamp(0.49), true);
  assertEquals(wantsEnemyDoorCamp(0), true);
  assertEquals(wantsEnemyDoorCamp(0.5), false);
  assertEquals(wantsEnemyDoorCamp(0.75), false);
  assertEquals(wantsEnemyDoorCamp(undefined), false);
});

Deno.test("campLookHoldRangeSec: high anxiety short, low long", () => {
  const high = campLookHoldRangeSec(1);
  assertAlmostEquals(high.lo, 1.25, 1e-9);
  assertAlmostEquals(high.hi, 2.0, 1e-9);

  const low = campLookHoldRangeSec(0);
  assertAlmostEquals(low.lo, 2.0, 1e-9);
  assertAlmostEquals(low.hi, 5.0, 1e-9);

  const mid = campLookHoldRangeSec(0.5);
  assert(mid.lo > high.lo && mid.lo < low.lo);
  assert(mid.hi > high.hi && mid.hi < low.hi);
  // High floor must stay ≥1.25s (0.75 was too twitchy).
  assert(high.lo >= 1.25 - 1e-9);
});

Deno.test("rollCampLookHoldSec stays inside anxiety band", () => {
  const { lo, hi } = campLookHoldRangeSec(1);
  for (const u of [0, 0.5, 1]) {
    const s = rollCampLookHoldSec(1, () => u);
    assert(s >= lo - 1e-9 && s <= hi + 1e-9);
  }
});

Deno.test("enemySpawnCorners: enemy team corners", () => {
  const map = openMap();
  const [c0, c1] = enemySpawnCorners(map, "A");
  // Team B corners 2,3 → (maxX,maxZ), (minX,maxZ)
  assertEquals(c0, { x: 20, z: 20 });
  assertEquals(c1, { x: -20, z: 20 });
});

Deno.test("pickEnemyDoorCampPlant: lands in enemy capture zone", () => {
  const col = new MapCollision(openMap());
  const plant = pickEnemyDoorCampPlant(col, "A", { rng: () => 0.5 });
  const side = enemyDoorSide(col.map, "A");
  assert(col.isInDoorZone(plant.x, plant.z, side));
});

Deno.test("pickEnemyDoorCampPlant: avoid mid pushes lateral", () => {
  const col = new MapCollision(openMap());
  const mid = enemyDoorTarget(col.map, "A");
  const plant = pickEnemyDoorCampPlant(col, "A", {
    avoid: [mid],
    occupyRadius: DOOR_CAMP_OCCUPY_RADIUS,
    rng: () => 0.5,
  });
  const d = Math.hypot(plant.x - mid.x, plant.z - mid.z);
  assert(
    d >= DOOR_CAMP_OCCUPY_RADIUS * 0.85,
    `expected lateral separation, got ${d}`,
  );
});

Deno.test("pickEnemyDoorCampPlant: two picks stay separated", () => {
  const col = new MapCollision(openMap());
  const a = pickEnemyDoorCampPlant(col, "A", { rng: () => 0.1 });
  const b = pickEnemyDoorCampPlant(col, "A", {
    avoid: [a],
    rng: () => 0.9,
  });
  const d = Math.hypot(a.x - b.x, a.z - b.z);
  assert(d >= 1.0, `two campers stacked: dist=${d}`);
});

Deno.test("doorCamp look yaws face spawn corners / own door", () => {
  const map = openMap();
  const plant = enemyDoorTarget(map, "A");
  const y0 = doorCampLookYaw(plant.x, plant.z, map, "A", 0);
  const y1 = doorCampLookYaw(plant.x, plant.z, map, "A", 1);
  const own = doorCampOwnDoorYaw(plant.x, plant.z, map, "A");
  // Spawns differ; own door is roughly south (yaw ~0).
  assert(Math.abs(doorCampYawSignedDelta(y0, y1)) > 0.5);
  assert(Math.abs(doorCampYawSignedDelta(own, 0)) < 0.35);
});

Deno.test("shortestArcPassesNear: short spawn-to-spawn skips own door", () => {
  const map = openMap();
  const plant = enemyDoorTarget(map, "A");
  const y0 = doorCampLookYaw(plant.x, plant.z, map, "A", 0);
  const y1 = doorCampLookYaw(plant.x, plant.z, map, "A", 1);
  const own = doorCampOwnDoorYaw(plant.x, plant.z, map, "A");
  // Short arc between north-wall corners goes through out-door, not own door.
  assertEquals(shortestArcPassesNear(y0, y1, own), false);
});

Deno.test("collectEnemyDoorCampClaims + isAtDoorCampPlant", () => {
  const map = openMap();
  const door = enemyDoorTarget(map, "A");
  const claims = collectEnemyDoorCampClaims(
    map,
    "A",
    [
      {
        id: "self",
        team: "A",
        alive: true,
        x: door.x,
        z: door.z,
      },
      {
        id: "mate",
        team: "A",
        alive: true,
        x: door.x + 0.5,
        z: door.z,
      },
      {
        id: "far",
        team: "A",
        alive: true,
        x: 0,
        z: 0,
      },
      {
        id: "enemy",
        team: "B",
        alive: true,
        x: door.x,
        z: door.z,
      },
    ],
    "self",
  );
  assertEquals(claims.length, 1);
  assertEquals(claims[0]!.x, door.x + 0.5);

  assert(isAtDoorCampPlant(door.x, door.z, door.x, door.z));
  assert(!isAtDoorCampPlant(0, 0, door.x, door.z));
});

Deno.test("wantsLipDoorCamp: high aggression or last seconds of close", () => {
  assertEquals(wantsLipDoorCamp(0.3), false);
  assertEquals(wantsLipDoorCamp(0.75), true);
  assertEquals(wantsLipDoorCamp(0.3, 100, 400), false);
  assertEquals(wantsLipDoorCamp(0.3, 100, 200), true);
  assertEquals(wantsLipDoorCamp(0.3, 100, 80), false);
});
