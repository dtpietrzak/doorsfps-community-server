import { assertEquals } from "jsr:@std/assert@1";
import {
  MapCollision,
  PLAYER_RADIUS,
  STAND_COLLISION_HEIGHT,
  WALL_HALF_THICK,
} from "./MapCollision.ts";
import type { DoorsMap } from "./map.ts";
import { STAND_EYE_HEIGHT } from "../shared/sim/playerHitVolumes.ts";

function arena(zombots: boolean): DoorsMap {
  return {
    version: 1,
    name: "zombots",
    bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 },
    gridSize: 1,
    ...(zombots ? { mirrorMode: "zombots" as const, spawnCorner: 1 as const } : {}),
    teamA: { corners: [0, 1], edge: "south", doorHalfWidth: 2, spawnRadius: 3 },
    teamB: { corners: [2, 3], edge: "north", doorHalfWidth: 2, spawnRadius: 3 },
    walls: [{ id: "w1", a: { x: -4, z: 0 }, b: { x: 4, z: 0 } }],
    doors: [{ id: "d", wallId: "w1", center: { x: 0, z: 0 } }],
  };
}

Deno.test("zombots seals the energy doors and a closed sliding door", () => {
  const throughSouth = { x: 0, y: 0, z: -1 };
  const openArena = new MapCollision(arena(false));
  assertEquals(
    openArena.raycastSolid({ x: 0, y: STAND_EYE_HEIGHT, z: -18 }, throughSouth, 6),
    null,
  );
  const sealed = new MapCollision(arena(true));
  const hit = sealed.raycastSolid(
    { x: 0, y: STAND_EYE_HEIGHT, z: -18 },
    throughSouth,
    6,
  );
  assertEquals(hit !== null && hit < 3, true);
  assertEquals(
    sealed.raycastSolid(
      { x: 0, y: STAND_EYE_HEIGHT, z: -2 },
      { x: 0, y: 0, z: 1 },
      6,
    ) !== null,
    true,
  );

  sealed.doorWalkInEnabled = false;
  const resolved = sealed.resolvePosition(
    0,
    -19.9,
    PLAYER_RADIUS,
    0,
    STAND_COLLISION_HEIGHT,
  );
  const againstWall = -20 + WALL_HALF_THICK + PLAYER_RADIUS;
  assertEquals(Math.abs(resolved.z - againstWall) < 0.05, true);
});
