/**
 * Shotgun PR 1: distance falloff on the server shot path.
 * Falloff scales the base before the ±5 roll and draws no extra RNG.
 * Run: deno test -A server-community/players/weapon_falloff_test.ts
 */
import { assertEquals, assertExists } from "jsr:@std/assert@1";
import { PlayerManager } from "./PlayerManager.ts";
import {
  SPAWN_INVULN_TICKS,
  WEAPON_RIFLE,
  WEAPON_SWITCH_TICKS,
} from "../protocol/network.ts";
import type { DoorsMap } from "../world/map.ts";
import { MapCollision } from "../world/MapCollision.ts";
import { PISTOL, RIFLE } from "../shared/sim/weapons.ts";

const miniMap: DoorsMap = {
  name: "weapon-falloff-test",
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

/** Shooter at z=shooterZ facing -Z, victim at z=victimZ; eye-level ray → head. */
function setup(
  shooterZ: number,
  victimZ: number,
  // Pistol: zero cone samples, then neutral damage roll.
  samples = [0, 0, 0.5],
) {
  const log: number[] = [];
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
  shooter.x = 0;
  shooter.y = 1.7;
  shooter.z = shooterZ;
  shooter.yaw = 0;
  shooter.pitch = 0;
  shooter.spawnedAtTick = 0;
  victim.x = 0;
  victim.y = 1.7;
  victim.z = victimZ;
  victim.spawnedAtTick = 0;
  victim.health = 100;
  for (let t = TICK - 16; t <= TICK + 40; t++) {
    shooter.recordPose(t);
    victim.recordPose(t);
  }
  const shoot = (tick: number) =>
    players.handleShoot(shooter.id, tick, {
      yaw: 0,
      pitch: 0,
      clientTick: tick,
      origin: [0, 1.7, shooterZ],
    });
  return { players, shooter, victim, shoot, log };
}

Deno.test("pistol: full head damage inside fullDamageRange", () => {
  const { shoot, log } = setup(5, 0);
  const outcome = shoot(TICK);
  assertExists(outcome?.damages);
  assertEquals(outcome.shot.hitZone, "head");
  assertEquals(outcome.damages[0]!.damage, PISTOL.headDamage);
  // Falloff draws nothing extra: spread ×2 + damage ×1.
  assertEquals(log.length, 3);
});

Deno.test("pistol: far head hit lands at the falloff floor, never 0", () => {
  const { shoot, log } = setup(45, -40);
  const outcome = shoot(TICK);
  assertExists(outcome?.damages);
  assertEquals(outcome.shot.hitZone, "head");
  // 55 × 0.45 = 24.75 → rounds to 25, neutral roll +0.
  assertEquals(outcome.damages[0]!.damage, 25);
  assertEquals(log.length, 3);
});

Deno.test("rifle: no falloff at long range", () => {
  // Rifle still cone is 0: no spread draws, only the neutral damage roll.
  const { shooter, shoot } = setup(45, -40, [0.5]);
  const switchTick = TICK - WEAPON_SWITCH_TICKS - 1;
  assertEquals(shooter.trySwitchWeapon(WEAPON_RIFLE, switchTick), true);
  shooter.tickWeaponSwitch(TICK);
  assertEquals(shooter.weaponId, WEAPON_RIFLE);
  const outcome = shoot(TICK);
  assertExists(outcome?.damages);
  assertEquals(outcome.damages[0]!.damage, RIFLE.headDamage);
});
