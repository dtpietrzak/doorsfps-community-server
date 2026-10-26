/**
 * Epic 4.6 Chunk 5: NON-SIM randomness may vary without changing seeded sim
 * outcomes (damage / spread) under a fixed match seed + fixed inputs.
 */
import { assertEquals, assertExists } from "jsr:@std/assert@1";
import { PlayerManager } from "./PlayerManager.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";
import { SPAWN_INVULN_TICKS } from "../protocol/network.ts";

const miniMap: DoorsMap = {
  name: "sim-rng-non-obs-test",
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
const MATCH_SEED = 0xc5e5d001;

function shootOnce(noise: number): {
  direction: [number, number, number];
  damage: number | null;
  critical: boolean | null;
  spawn: { x: number; z: number; yaw: number };
} {
  // Distinct NON-SIM noise must not enter combat/spawn domain streams.
  void noise;
  const collision = new MapCollision(miniMap);
  const players = new PlayerManager(collision, { matchSeed: MATCH_SEED });
  // Simulate divergent UUID / analytics entropy that must stay outside sim.
  const _opaqueId = `bot-${noise}-${Math.random()}`;
  void _opaqueId;

  const spawn = collision.randomSpawn(miniMap.teamA);
  const shooter = players.add("shooter", "Human", "A");
  const victim = players.add("victim", "Victim", "B");
  shooter.x = 0;
  shooter.y = 1.7;
  shooter.z = 5;
  shooter.yaw = 0;
  shooter.pitch = 0;
  shooter.spawnedAtTick = 0;
  victim.x = 0;
  victim.y = 1.7;
  victim.z = 0;
  victim.spawnedAtTick = 0;
  victim.health = 100;
  for (let t = TICK - 16; t <= TICK; t++) {
    shooter.recordPose(t);
    victim.recordPose(t);
  }

  const outcome = players.handleShoot(shooter.id, TICK, {
    yaw: 0,
    pitch: 0,
    clientTick: TICK,
    origin: [0, 1.7, 5],
  });
  assertExists(outcome);
  return {
    direction: outcome.shot.direction,
    damage: outcome.damages?.[0]?.damage ?? null,
    critical: outcome.damages?.[0]?.critical ?? null,
    spawn,
  };
}

Deno.test("NON-SIM entropy does not change seeded combat or spawn outcomes", () => {
  const a = shootOnce(1);
  const b = shootOnce(999_991);
  assertEquals(a.direction, b.direction);
  assertEquals(a.damage, b.damage);
  assertEquals(a.critical, b.critical);
  assertEquals(a.spawn, b.spawn);
});
