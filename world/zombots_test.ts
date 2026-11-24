import { assertEquals } from "jsr:@std/assert@1";
import {
  MapCollision,
  PLAYER_RADIUS,
  STAND_COLLISION_HEIGHT,
  WALL_HALF_THICK,
} from "./MapCollision.ts";
import { type DoorsMap, wallKind } from "./map.ts";
import { loadMapFile } from "./loadMap.ts";
import { slidingDoorPlacement } from "../shared/world/slidingDoors.ts";
import { ZOMBOTS_ROOM_WALL_HALF_THICK } from "../shared/zombots/zombotsDoors.ts";
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

Deno.test("openSlidingDoor lets movement, hitscan and LOS through, once", () => {
  const collision = new MapCollision(arena(true));
  const eye = { x: 0, y: STAND_EYE_HEIGHT, z: -2 };
  const north = { x: 0, y: 0, z: 1 };
  assertEquals(collision.raycastSolid(eye, north, 6) !== null, true);
  assertEquals(collision.raycastFullSolid(eye, north, 6) !== null, true);
  assertEquals(collision.classifyProbe(0, 0), "blocked");
  assertEquals(collision.isSlidingDoorOpen("d"), false);

  assertEquals(collision.openSlidingDoor("nope"), false);
  assertEquals(collision.openSlidingDoor("d"), true);
  assertEquals(collision.openSlidingDoor("d"), false);
  assertEquals(collision.isSlidingDoorOpen("d"), true);
  assertEquals(collision.openSlidingDoorIds(), ["d"]);

  assertEquals(collision.raycastSolid(eye, north, 6), null);
  assertEquals(collision.raycastFullSolid(eye, north, 6), null);
  assertEquals(collision.classifyProbe(0, 0), "clear");
  const through = collision.resolvePosition(0, 0);
  assertEquals(through, { x: 0, z: 0 });
  // The wall beside the door is untouched.
  assertEquals(
    collision.raycastSolid({ x: 3, y: STAND_EYE_HEIGHT, z: -2 }, north, 6) !== null,
    true,
  );
});

Deno.test("a never-opened door behaves exactly as before; replaying opens matches", () => {
  const map = arena(true);
  const plain = new MapCollision(map);
  const other = new MapCollision(map);
  other.openSlidingDoor("unknown");
  const probes: [number, number][] = [];
  for (let x = -5; x <= 5; x += 0.37) {
    for (let z = -2; z <= 2; z += 0.29) probes.push([x, z]);
  }
  for (const [x, z] of probes) {
    assertEquals(other.resolvePosition(x, z), plain.resolvePosition(x, z));
  }

  const live = new MapCollision(map);
  live.openSlidingDoor("d");
  const restored = new MapCollision(map);
  for (const id of live.openSlidingDoorIds()) restored.openSlidingDoor(id);
  for (const [x, z] of probes) {
    assertEquals(restored.resolvePosition(x, z), live.resolvePosition(x, z));
    assertEquals(
      restored.raycastSolid({ x, y: 1, z: -3 }, { x: 0.1, y: 0, z: 1 }, 8),
      live.raycastSolid({ x, y: 1, z: -3 }, { x: 0.1, y: 0, z: 1 }, 8),
    );
  }
});

Deno.test("room flood fill uses the same wall thickness as collision", () => {
  assertEquals(ZOMBOTS_ROOM_WALL_HALF_THICK, WALL_HALF_THICK);
});

Deno.test("openSlidingDoor rebuild cost on the biggest competitive map", async () => {
  const base = await loadMapFile(
    new URL("../maps/competitive/Pillars.doors.json", import.meta.url).pathname,
  );
  // Put a door at the middle of every long full wall.
  const doors = base.walls
    .filter((w) => wallKind(w) === "full")
    .map((w) => ({ w, place: slidingDoorPlacement(w.a, w.b, mid(w.a, w.b)) }))
    .filter((d) => d.place !== null)
    .map((d, i) => ({ id: `d${i}`, wallId: d.w.id, center: mid(d.w.a, d.w.b) }));
  const map: DoorsMap = { ...base, mirrorMode: "zombots", spawnCorner: 0, doors };
  assertEquals(doors.length > 0, true);
  const collision = new MapCollision(map);
  const t0 = performance.now();
  for (const door of doors) assertEquals(collision.openSlidingDoor(door.id), true);
  const perOpen = (performance.now() - t0) / doors.length;
  console.log(
    `openSlidingDoor: ${doors.length} doors, ${base.walls.length} walls, ` +
      `${perOpen.toFixed(3)} ms per open`,
  );
  // Generous bound; a door opens a few times a match, not per tick.
  assertEquals(perOpen < 5, true);
});

function mid(a: { x: number; z: number }, b: { x: number; z: number }) {
  return { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
}
