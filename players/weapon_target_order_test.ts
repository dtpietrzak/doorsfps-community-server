/**
 * Epic 4.4 Chunk 3: stable ascending id target order for hitscan fill.
 * Opposite join orders must produce identical hit victims.
 * Run: deno test -A server-community/players/weapon_target_order_test.ts
 */
import { assertEquals, assertExists } from "jsr:@std/assert@1";
import { PlayerManager } from "./PlayerManager.ts";
import { SPAWN_INVULN_TICKS } from "../protocol/network.ts";
import type { DoorsMap } from "../world/map.ts";
import { MapCollision } from "../world/MapCollision.ts";

const miniMap: DoorsMap = {
  name: "weapon-target-order-test",
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

const TICK = SPAWN_INVULN_TICKS + 60;

/** Neutral damage + zero pistol bloom samples so direction stays look-forward. */
function fixedRng(): () => number {
  // Open pistol still cone consumes 2 samples; then damage.
  const samples = [0, 0, 0.5];
  return () => samples.shift() ?? 0.5;
}

function shootEquidistant(
  joinOrder: readonly ["alice" | "zack", "alice" | "zack"],
): string | null {
  const players = new PlayerManager(new MapCollision(miniMap), {
    damageRandom: fixedRng(),
  });
  const shooter = players.add("shooter", "Shooter", "A");
  for (const id of joinOrder) {
    players.add(id, id === "alice" ? "Alice" : "Zack", "B");
  }

  shooter.x = 0;
  shooter.y = 1.7;
  shooter.z = 5;
  shooter.yaw = 0;
  shooter.pitch = 0;
  shooter.spawnedAtTick = 0;
  for (let t = TICK - 16; t <= TICK; t++) shooter.recordPose(t);

  for (const id of joinOrder) {
    const v = players.get(id)!;
    // Identical pose (incl. yaw/pitch) → equidistant head volumes; tie-break
    // must follow ascending id, not join order.
    v.x = 0;
    v.y = 1.7;
    v.z = 0;
    v.yaw = 0;
    v.pitch = 0;
    v.spawnedAtTick = 0;
    v.health = 100;
    for (let t = TICK - 16; t <= TICK; t++) v.recordPose(t);
  }

  const outcome = players.handleShoot(shooter.id, TICK, {
    yaw: 0,
    pitch: 0,
    clientTick: TICK,
    origin: [0, 1.7, 5],
  });
  assertExists(outcome);
  return outcome.shot.hitId;
}

Deno.test("equidistant victims: lower stable id wins regardless of join order", () => {
  const aFirst = shootEquidistant(["alice", "zack"]);
  const zFirst = shootEquidistant(["zack", "alice"]);
  assertEquals(aFirst, "alice");
  assertEquals(zFirst, "alice");
  assertEquals(aFirst, zFirst);
});
