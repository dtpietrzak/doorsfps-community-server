/**
 * Epic 4.6 Chunk 4: per-match spawn reseed + fixed draws per randomSpawn.
 */
import { assertEquals } from "jsr:@std/assert@1";
import {
  MapCollision,
  RANDOM_SPAWN_DRAWS_PER_CALL,
} from "./MapCollision.ts";
import type { DoorsMap } from "./map.ts";
import { createSimRng } from "../shared/sim/simRng.ts";

const miniMap: DoorsMap = {
  name: "spawn-rng-test",
  version: 1,
  bounds: { minX: -50, maxX: 50, minZ: -50, maxZ: 50 },
  gridSize: 1,
  walls: [],
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
};

Deno.test("randomSpawn: same spawn seed → identical pose sequence", () => {
  const run = (seed: number) => {
    const map = new MapCollision(miniMap);
    map.reseedSpawnRng(seed);
    return Array.from({ length: 8 }, () => map.randomSpawn(miniMap.teamA));
  };
  assertEquals(run(0x5ba401), run(0x5ba401));
});

Deno.test("randomSpawn: consumes a fixed draw count per call", () => {
  let draws = 0;
  const inner = createSimRng(0x111);
  const map = new MapCollision(miniMap);
  map.reseedSpawnRng(() => {
    draws += 1;
    return inner();
  });
  map.randomSpawn(miniMap.teamA);
  assertEquals(draws, RANDOM_SPAWN_DRAWS_PER_CALL);
  const afterFirst = draws;
  map.randomSpawn(miniMap.teamB);
  assertEquals(draws - afterFirst, RANDOM_SPAWN_DRAWS_PER_CALL);
});

Deno.test("randomSpawn: reseed isolates match history", () => {
  const map = new MapCollision(miniMap);
  map.reseedSpawnRng(0x42);
  // Burn an arbitrary amount of history.
  for (let i = 0; i < 20; i++) map.randomSpawn(miniMap.teamA);

  map.reseedSpawnRng(0x42);
  const afterReseed = Array.from(
    { length: 5 },
    () => map.randomSpawn(miniMap.teamA),
  );

  const fresh = new MapCollision(miniMap);
  fresh.reseedSpawnRng(0x42);
  const control = Array.from(
    { length: 5 },
    () => fresh.randomSpawn(miniMap.teamA),
  );
  assertEquals(afterReseed, control);
});
