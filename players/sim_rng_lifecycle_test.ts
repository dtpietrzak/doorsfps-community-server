/**
 * Epic 4.6 Chunk 2: match seed lifecycle + domain stream holders.
 * Combat/spawn/agent call sites still use legacy defaults until Chunks 3–4.
 */
import { assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { PlayerManager } from "./PlayerManager.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";
import { createMatchSimRngStreams } from "../shared/sim/simRng.ts";

const miniMap: DoorsMap = {
  name: "sim-rng-lifecycle-test",
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

Deno.test("PlayerManager: matchSeed option seeds all domain streams", () => {
  const pm = new PlayerManager(new MapCollision(miniMap), { matchSeed: 0xabc });
  assertEquals(pm.getMatchSeed(), 0xabc);
  const expected = createMatchSimRngStreams(0xabc);
  const got = pm.getSimRngStreams();
  for (let i = 0; i < 8; i++) {
    assertEquals(got.damage(), expected.damage());
    assertEquals(got.spread(), expected.spread());
    assertEquals(got.spawn(), expected.spawn());
    assertEquals(got.agents(), expected.agents());
  }
});

Deno.test("PlayerManager: reseedSimRng resets streams and notifies listener", () => {
  const pm = new PlayerManager(new MapCollision(miniMap), { matchSeed: 1 });
  const heard: number[] = [];
  pm.setSimRngReseedListener((seed) => {
    heard.push(seed);
  });
  pm.reseedSimRng(99);
  assertEquals(pm.getMatchSeed(), 99);
  assertEquals(heard, [99]);

  const before = Array.from({ length: 4 }, () => pm.getSimRngStreams().damage());
  pm.reseedSimRng(99);
  const after = Array.from({ length: 4 }, () => pm.getSimRngStreams().damage());
  assertEquals(after, before);
});

Deno.test("PlayerManager: first beginLiveMatch keeps construct matchSeed", () => {
  const pm = new PlayerManager(new MapCollision(miniMap), { matchSeed: 10 });
  pm.beginLiveMatch(0, 1_000);
  assertEquals(pm.getMatchSeed(), 10);
});

Deno.test("PlayerManager: beginLiveMatch after matchOver reseeds", () => {
  const pm = new PlayerManager(new MapCollision(miniMap), { matchSeed: 10 });
  pm.beginLiveMatch(0, 1_000);
  pm.forceEndMatch(0, "draw");
  const seedBefore = pm.getMatchSeed();
  pm.beginLiveMatch(100, 2_000);
  assertNotEquals(pm.getMatchSeed(), seedBefore);
});

Deno.test("PlayerManager: prematch → live keeps the same match seed", () => {
  const pm = new PlayerManager(new MapCollision(miniMap), {
    matchSeed: 0x5555,
    enablePrematch: true,
  });
  pm.enterPrematch(0, 1_000);
  const seed = pm.getMatchSeed();
  // enterPrematch reseeds — capture after prematch start.
  pm.beginLiveMatch(10, 2_000);
  assertEquals(pm.getMatchSeed(), seed);
});

Deno.test("MapCollision: reseedSpawnRng replaces stream; same seed → same draws", () => {
  const a = new MapCollision(miniMap);
  const b = new MapCollision(miniMap);
  a.reseedSpawnRng(0x2222);
  b.reseedSpawnRng(0x2222);
  for (let i = 0; i < 12; i++) {
    assertEquals(a.randomSpawn(a.map.teamA), b.randomSpawn(b.map.teamA));
  }
});

Deno.test("PlayerManager: setCollision inherits current spawn stream", () => {
  const pm = new PlayerManager(new MapCollision(miniMap), { matchSeed: 77 });
  pm.reseedSimRng(77);
  const nextMap = new MapCollision(miniMap);
  pm.setCollision(nextMap);
  const control = new MapCollision(miniMap);
  control.reseedSpawnRng(createMatchSimRngStreams(77).spawn);
  for (let i = 0; i < 5; i++) {
    assertEquals(
      nextMap.randomSpawn(miniMap.teamA),
      control.randomSpawn(miniMap.teamA),
    );
  }
});
