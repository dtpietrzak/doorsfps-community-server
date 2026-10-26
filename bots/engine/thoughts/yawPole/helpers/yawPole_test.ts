/**
 * Server adapter tests — pure pick lives in shared/world/yawPole_test.ts.
 * Re-export path + MapCollision LOS wiring smoke.
 */
import { assertEquals, assertExists } from "@std/assert";
import {
  pickYawPoleFromView,
  pickYawPoleTarget,
  polesForTeam,
  YAW_POLE_SKIP_RADIUS,
} from "./yawPole.ts";
import type { DoorsMap } from "../../../shared/map.ts";

function openMap(): DoorsMap {
  return {
    version: 1,
    name: "YawPoleTest",
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
    wallCorners: [],
  };
}

Deno.test("server re-export: pickYawPoleFromView open map hits door center", () => {
  const map = openMap();
  const { enemyDoorPoles } = polesForTeam(map, "A");
  const pick = pickYawPoleFromView({
    x: 0,
    z: 0,
    yaw: 0,
    team: "A",
    map,
  });
  assertExists(pick);
  const mid = enemyDoorPoles[1]!;
  assertEquals(pick.x, mid.x);
  assertEquals(pick.z, mid.z);
});

Deno.test("server re-export: pickYawPoleTarget skip radius", () => {
  const map = openMap();
  const pick = pickYawPoleTarget({
    x: 0,
    z: 0,
    yaw: Math.PI,
    team: "A",
    map,
    wallPoles: [
      { x: 0, z: 0.1 },
      { x: 0, z: 5 },
    ],
    enemyDoorPoles: [],
  });
  assertExists(pick);
  assertEquals(pick.z, 5);
  assertEquals(Math.hypot(pick.x, pick.z) > YAW_POLE_SKIP_RADIUS, true);
});
