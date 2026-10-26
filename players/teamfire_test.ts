/**
 * Friendly fire: hitting a teammate deals the same damage to the shooter.
 */
import { assertEquals, assertExists } from "jsr:@std/assert@1";
import { PlayerManager } from "./PlayerManager.ts";
import {
  HIT_SLOW_DURATION_TICKS,
  SPAWN_INVULN_TICKS,
} from "../protocol/network.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";
import { PISTOL } from "../shared/sim/weapons.ts";

const miniMap: DoorsMap = {
  name: "test",
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

function makeManager(damageSample = 0.5): PlayerManager {
  return new PlayerManager(new MapCollision(miniMap), {
    damageRandom: () => damageSample,
  });
}

/** Past spawn protection; large enough for fire cooldown too. */
const TICK = SPAWN_INVULN_TICKS + 60;

/** Place shooter facing victim at known coords and stamp lag-comp poses. */
function placeForShot(
  shooter: {
    x: number;
    y: number;
    z: number;
    yaw: number;
    pitch: number;
    spawnedAtTick: number;
    health: number;
    recordPose: (t: number) => void;
  },
  victim: {
    x: number;
    y: number;
    z: number;
    spawnedAtTick: number;
    health: number;
    recordPose: (t: number) => void;
  },
  opts?: { shooterHealth?: number; victimHealth?: number },
): void {
  // yaw=0 → look dir (0, 0, -1)
  shooter.x = 0;
  shooter.y = 1.7;
  shooter.z = 5;
  shooter.yaw = 0;
  shooter.pitch = 0;
  shooter.spawnedAtTick = 0;
  shooter.health = opts?.shooterHealth ?? 100;
  for (let t = TICK - 16; t <= TICK; t++) shooter.recordPose(t);

  victim.x = 0;
  victim.y = 1.7;
  victim.z = 0;
  victim.spawnedAtTick = 0;
  victim.health = opts?.victimHealth ?? 100;
  for (let t = TICK - 16; t <= TICK; t++) victim.recordPose(t);
}

Deno.test("teamfire: hit damages shooter the same amount", () => {
  const pm = makeManager();
  const shooter = pm.add("s1", "Shooter", "A");
  const victim = pm.add("v1", "Victim", "A");
  placeForShot(shooter, victim);

  const outcome = pm.handleShoot("s1", TICK, {
    yaw: 0,
    pitch: 0,
    clientTick: TICK,
    origin: [0, 1.7, 5],
  });

  assertExists(outcome);
  assertEquals(outcome!.shot.hitId, "v1");
  // Eye-level center mass registers as head (matches hitscan tests).
  assertEquals(outcome!.shot.hitZone, "head");
  assertExists(outcome!.damages);
  assertEquals(outcome!.damages!.length, 2);

  const [toVictim, toShooter] = outcome!.damages!;
  assertEquals(toVictim!.targetId, "v1");
  assertEquals(toShooter!.targetId, "s1");
  assertEquals(toVictim!.damage, toShooter!.damage);
  assertEquals(toVictim!.damage, PISTOL.headDamage);
  assertEquals(victim.health, 100 - PISTOL.headDamage);
  assertEquals(shooter.health, 100 - PISTOL.headDamage);
  assertEquals(toVictim!.killed, false);
  assertEquals(toShooter!.killed, false);
  assertEquals(toVictim!.hitSlowStacks, 1);
  assertEquals(toShooter!.hitSlowStacks, 1);
  assertEquals(toVictim!.hitSlowEndsAtTick, TICK + HIT_SLOW_DURATION_TICKS);
  assertEquals(toShooter!.hitSlowEndsAtTick, TICK + HIT_SLOW_DURATION_TICKS);
  assertEquals(victim.activeHitSlowStacks(TICK), 1);
  assertEquals(shooter.activeHitSlowStacks(TICK), 1);
});

Deno.test("teamfire: enemy hit does not damage shooter", () => {
  const pm = makeManager();
  const shooter = pm.add("s1", "Shooter", "A");
  const victim = pm.add("v1", "Enemy", "B");
  placeForShot(shooter, victim);

  const outcome = pm.handleShoot("s1", TICK, {
    yaw: 0,
    pitch: 0,
    clientTick: TICK,
    origin: [0, 1.7, 5],
  });

  assertExists(outcome);
  assertEquals(outcome!.shot.hitId, "v1");
  assertEquals(outcome!.damages!.length, 1);
  assertEquals(outcome!.damages![0]!.targetId, "v1");
  assertEquals(victim.health, 100 - PISTOL.headDamage);
  assertEquals(shooter.health, 100);
  assertEquals(outcome!.damages![0]!.hitSlowStacks, 1);
  assertEquals(victim.activeHitSlowStacks(TICK), 1);
  assertEquals(shooter.activeHitSlowStacks(TICK), 0);
});

Deno.test("damage variation marks only upper-tail rolls as critical", () => {
  const pm = makeManager(0.91);
  const shooter = pm.add("s1", "Shooter", "A");
  const victim = pm.add("v1", "Enemy", "B");
  placeForShot(shooter, victim);

  const outcome = pm.handleShoot("s1", TICK, {
    yaw: 0,
    pitch: 0,
    clientTick: TICK,
    origin: [0, 1.7, 5],
  });

  assertExists(outcome?.damages);
  assertEquals(outcome!.damages![0]!.damage, 60);
  assertEquals(outcome!.damages![0]!.critical, true);
});

Deno.test("teamfire: self-death from mirrored damage only increments deaths", () => {
  const pm = makeManager();
  const shooter = pm.add("s1", "Shooter", "A");
  const victim = pm.add("v1", "Victim", "A");
  placeForShot(shooter, victim, { shooterHealth: 20 });
  shooter.kills = 5;

  const outcome = pm.handleShoot("s1", TICK, {
    yaw: 0,
    pitch: 0,
    clientTick: TICK,
    origin: [0, 1.7, 5],
  });

  assertExists(outcome);
  assertEquals(outcome!.damages!.length, 2);
  assertEquals(shooter.alive, false);
  assertEquals(shooter.deaths, 1);
  // Suicide-by-teamfire: no kill score change (still 5).
  assertEquals(shooter.kills, 5);
  assertEquals(victim.alive, true);
  assertEquals(victim.health, 100 - PISTOL.headDamage);
});

Deno.test("teamfire: teamkill applies −2 kills and can go negative", () => {
  const pm = makeManager();
  const shooter = pm.add("s1", "Shooter", "A");
  const victim = pm.add("v1", "Victim", "A");
  placeForShot(shooter, victim, { victimHealth: 1 });

  const outcome = pm.handleShoot("s1", TICK, {
    yaw: 0,
    pitch: 0,
    clientTick: TICK,
    origin: [0, 1.7, 5],
  });

  assertExists(outcome);
  assertEquals(victim.alive, false);
  assertEquals(shooter.alive, true);
  assertEquals(shooter.kills, -2);
});
