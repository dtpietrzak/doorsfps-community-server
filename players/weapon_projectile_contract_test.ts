/**
 * Epic 4.4 Chunk 5: hitscan-only projectile contract.
 * Run: deno test -A server-community/players/weapon_projectile_contract_test.ts
 */
import { assertEquals } from "jsr:@std/assert@1";
import { PlayerManager } from "./PlayerManager.ts";
import type { DoorsMap } from "../world/map.ts";
import { MapCollision } from "../world/MapCollision.ts";

const miniMap: DoorsMap = {
  name: "weapon-projectile-contract-test",
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

Deno.test("createSnapshot always carries projectiles: []", () => {
  const players = new PlayerManager(new MapCollision(miniMap));
  players.add("a", "A", "A");
  players.add("b", "B", "B");
  const snap = players.createSnapshot(120);
  assertEquals(snap.projectiles, []);
  assertEquals(Array.isArray(snap.projectiles), true);
  assertEquals(snap.projectiles.length, 0);
});
