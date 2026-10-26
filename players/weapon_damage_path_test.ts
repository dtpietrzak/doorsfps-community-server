/**
 * Epic 4.4 Chunk 4: damage-path pins at the takeDamage boundary.
 * Deeper ability/melee/teamfire/hit-slow tables live in their dedicated suites;
 * this file locks shoot vs melee RNG consumption and OneShot floor behavior
 * under the seeded spread draw order from Chunk 1.
 * Run: deno test -A server-community/players/weapon_damage_path_test.ts
 */
import { assertEquals, assertExists } from "jsr:@std/assert@1";
import { PlayerManager } from "./PlayerManager.ts";
import { SPAWN_INVULN_TICKS } from "../protocol/network.ts";
import type { DoorsMap } from "../world/map.ts";
import { MapCollision } from "../world/MapCollision.ts";
import { PISTOL } from "../shared/sim/weapons.ts";

const miniMap: DoorsMap = {
  name: "weapon-damage-path-test",
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

function placeFacing(
  shooter: {
    x: number;
    y: number;
    z: number;
    yaw: number;
    pitch: number;
    spawnedAtTick: number;
    recordPose: (t: number) => void;
  },
  victim: {
    x: number;
    y: number;
    z: number;
    yaw: number;
    pitch: number;
    spawnedAtTick: number;
    health: number;
    recordPose: (t: number) => void;
  },
  rangeZ = 5,
): void {
  shooter.x = 0;
  shooter.y = 1.7;
  shooter.z = rangeZ;
  shooter.yaw = 0;
  shooter.pitch = 0;
  shooter.spawnedAtTick = 0;
  for (let t = TICK - 16; t <= TICK; t++) shooter.recordPose(t);

  victim.x = 0;
  victim.y = 1.7;
  victim.z = 0;
  victim.yaw = 0;
  victim.pitch = 0;
  victim.spawnedAtTick = 0;
  victim.health = 100;
  for (let t = TICK - 16; t <= TICK; t++) victim.recordPose(t);
}

Deno.test("melee draw order skips spread (damage sample is first)", () => {
  const log: number[] = [];
  const samples = [0.5, 0.9];
  const players = new PlayerManager(new MapCollision(miniMap), {
    damageRandom: () => {
      const v = samples.shift();
      if (v === undefined) throw new Error("extra rng draw");
      log.push(v);
      return v;
    },
  });
  const shooter = players.add("s", "S", "A");
  const victim = players.add("v", "V", "B");
  placeFacing(shooter, victim, 1.5);

  const outcome = players.handleMelee(shooter.id, TICK, {
    yaw: 0,
    pitch: 0,
    clientTick: TICK,
    origin: [0, 1.7, 1.5],
  });
  assertExists(outcome?.damages);
  // Melee: no bloom — only the damage sample (human, no raid-scale).
  assertEquals(log, [0.5]);
  assertEquals(outcome.shot.melee, true);
  assertEquals(outcome.damages[0]!.damage, 50);
});

Deno.test("OneShot floor uses computed damage after spread+roll", () => {
  // Zero cone samples + neutral damage → base head damage; OneShot raises to HP.
  const samples = [0, 0, 0.5];
  const players = new PlayerManager(new MapCollision(miniMap), {
    damageRandom: () => samples.shift() ?? 0.5,
  });
  const shooter = players.add("s", "S", "A");
  shooter.restoreAbilityCharges();
  assertEquals(shooter.tryActivateAbility("oneShot", TICK), true);
  const victim = players.add("v", "V", "B");
  placeFacing(shooter, victim);

  const outcome = players.handleShoot(shooter.id, TICK, {
    yaw: 0,
    pitch: 0,
    clientTick: TICK,
    origin: [0, 1.7, 5],
  });
  assertExists(outcome?.damages);
  // Neutral roll would be PISTOL.headDamage; OneShot floors to full health.
  assertEquals(PISTOL.headDamage < 100, true);
  assertEquals(outcome.damages[0]!.damage, 100);
  assertEquals(victim.alive, false);
});
