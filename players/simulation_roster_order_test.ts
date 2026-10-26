/**
 * Epic 4.7 Chunk 2: simulationRoster ascending-id join-order independence.
 * Run from server-community/:
 *   deno test -A players/simulation_roster_order_test.ts
 */

import { assertEquals } from "@std/assert";
import { PlayerManager } from "./PlayerManager.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";
import type { PlayerInput } from "../protocol/network.ts";

const openMap: DoorsMap = {
  name: "roster-order-open",
  version: 1,
  bounds: { minX: -50, maxX: 50, minZ: -50, maxZ: 50 },
  gridSize: 1,
  walls: [],
  teamA: { corners: [0, 1], edge: "south", doorHalfWidth: 2, spawnRadius: 4 },
  teamB: { corners: [2, 3], edge: "north", doorHalfWidth: 2, spawnRadius: 4 },
};

function place(
  p: { x: number; y: number; z: number; yaw: number; spawnedAtTick: number },
  x: number,
  z: number,
): void {
  p.x = x;
  p.y = 1.7;
  p.z = z;
  p.yaw = 0;
  p.spawnedAtTick = 0;
}

function input(sequence: number, overrides: Partial<PlayerInput> = {}): PlayerInput {
  return {
    sequence,
    forward: false,
    backward: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
    crouch: false,
    yaw: 0,
    pitch: 0,
    ...overrides,
  };
}

function snap(pm: PlayerManager) {
  return ["p1", "p2", "p3"].map((id) => {
    const p = pm.get(id)!;
    return {
      id,
      x: p.x,
      z: p.z,
      velocityX: p.velocityX,
      velocityZ: p.velocityZ,
      health: p.health,
      alive: p.alive,
      score: p.score,
    };
  });
}

function runScripted(joinOrder: readonly string[]) {
  const pm = new PlayerManager(new MapCollision(openMap));
  for (const id of joinOrder) {
    pm.add(id, id, id === "p2" ? "B" : "A");
  }
  const p1 = pm.get("p1")!;
  const p2 = pm.get("p2")!;
  const p3 = pm.get("p3")!;
  place(p1, 0, 4);
  place(p2, 0, 0);
  place(p3, 2, 0);

  for (let tick = 1; tick <= 12; tick++) {
    p1.queueInput(input(tick, { forward: true, yaw: Math.PI }));
    p2.queueInput(input(tick, { right: true }));
    p3.queueInput(input(tick, { left: true }));
    pm.update(tick);
  }
  return snap(pm);
}

Deno.test("scripted multi-player update is join-order independent", () => {
  const forward = runScripted(["p1", "p2", "p3"]);
  const reverse = runScripted(["p3", "p2", "p1"]);
  const shuffled = runScripted(["p2", "p1", "p3"]);
  assertEquals(forward, reverse);
  assertEquals(forward, shuffled);
});

Deno.test("clipObstaclesExcept lists alive peers in ascending id", () => {
  const pm = new PlayerManager(new MapCollision(openMap));
  pm.add("z", "Z", "A");
  pm.add("a", "A", "A");
  pm.add("m", "M", "A");
  assertEquals(
    pm.clipObstaclesExcept("mover").map((p) => p.id),
    ["a", "m", "z"],
  );
});
