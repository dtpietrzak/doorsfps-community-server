/**
 * Epic 4.4 Chunk 1 + 4.6 Chunk 3: seeded spread on the authoritative shoot
 * path, per-shot draw order (spread → damage → raid-scale), and independent
 * damage / spread domain streams under matchSeed.
 */
import { assertEquals, assertExists } from "jsr:@std/assert@1";
import { PlayerManager } from "./PlayerManager.ts";
import { SPAWN_INVULN_TICKS } from "../protocol/network.ts";
import type { DoorsMap } from "../world/map.ts";
import { MapCollision } from "../world/MapCollision.ts";
import { WEAPON_RIFLE } from "../shared/sim/weapons.ts";

const miniMap: DoorsMap = {
  name: "weapon-spread-rng-test",
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

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

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
    spawnedAtTick: number;
    health: number;
    recordPose: (t: number) => void;
  },
): void {
  shooter.x = 0;
  shooter.y = 1.7;
  shooter.z = 5;
  shooter.yaw = 0;
  shooter.pitch = 0;
  shooter.spawnedAtTick = 0;
  for (let t = TICK - 16; t <= TICK; t++) shooter.recordPose(t);

  victim.x = 0;
  victim.y = 1.7;
  victim.z = 0;
  victim.spawnedAtTick = 0;
  victim.health = 100;
  for (let t = TICK - 16; t <= TICK; t++) victim.recordPose(t);
}

Deno.test("handleShoot: same seed → bit-identical shot direction", () => {
  const run = () => {
    const players = new PlayerManager(new MapCollision(miniMap), {
      damageRandom: mulberry32(0xa11_5ead),
    });
    const shooter = players.add("shooter", "Human", "A");
    const victim = players.add("victim", "Victim", "B");
    placeFacing(shooter, victim);
    const outcome = players.handleShoot(shooter.id, TICK, {
      yaw: 0,
      pitch: 0,
      clientTick: TICK,
      origin: [0, 1.7, 5],
    });
    assertExists(outcome);
    return outcome.shot.direction;
  };

  const a = run();
  const b = run();
  assertEquals(a[0], b[0]);
  assertEquals(a[1], b[1]);
  assertEquals(a[2], b[2]);
});

Deno.test("handleShoot draw order: spread then damage then raid-scale", () => {
  const log: number[] = [];
  // Open pistol still cone → 2 spread samples, then damage, then raid scale.
  const samples = [0.11, 0.22, 0.5, 1.0];
  const players = new PlayerManager(new MapCollision(miniMap), {
    damageRandom: () => {
      const v = samples.shift();
      if (v === undefined) throw new Error("unexpected extra rng draw");
      log.push(v);
      return v;
    },
  });
  const shooter = players.addBot("shooter", "Bot", {
    team: "A",
    isRaidBot: true,
  });
  const victim = players.add("victim", "Victim", "B");
  placeFacing(shooter, victim);

  const outcome = players.handleShoot(shooter.id, TICK, {
    yaw: 0,
    pitch: 0,
    clientTick: TICK,
    origin: [0, 1.7, 5],
  });
  assertExists(outcome?.damages);
  assertEquals(log, [0.11, 0.22, 0.5, 1.0]);
  // Neutral damage sample 0.5 → +0 offset; raid scale sample 1.0 → 20% of roll.
  assertEquals(outcome.damages[0]!.critical, false);
});

Deno.test("handleShoot draw order: rifle still skips spread samples", () => {
  const log: number[] = [];
  const samples = [0.5, 0.8];
  const players = new PlayerManager(new MapCollision(miniMap), {
    damageRandom: () => {
      const v = samples.shift();
      if (v === undefined) throw new Error("unexpected extra rng draw");
      log.push(v);
      return v;
    },
  });
  const shooter = players.addBot("shooter", "Bot", {
    team: "A",
    isRaidBot: true,
  });
  shooter.trySwitchWeapon(WEAPON_RIFLE, TICK - 60);
  // Advance past switch lock so the rifle is fireable.
  shooter.tickWeaponSwitch(TICK);
  const victim = players.add("victim", "Victim", "B");
  placeFacing(shooter, victim);

  assertEquals(shooter.weaponId, WEAPON_RIFLE);
  const outcome = players.handleShoot(shooter.id, TICK, {
    yaw: 0,
    pitch: 0,
    clientTick: TICK,
    origin: [0, 1.7, 5],
  });
  assertExists(outcome?.damages);
  // Zero still-cone: no spread draws; damage then raid-scale only.
  assertEquals(log, [0.5, 0.8]);
});

Deno.test("handleShoot: matchSeed → bit-identical direction and damage", () => {
  const run = () => {
    const players = new PlayerManager(new MapCollision(miniMap), {
      matchSeed: 0x4d6c0b47,
    });
    const shooter = players.add("shooter", "Human", "A");
    const victim = players.add("victim", "Victim", "B");
    placeFacing(shooter, victim);
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
    };
  };
  assertEquals(run(), run());
});

Deno.test("handleShoot: damage-domain draws do not shift spread", () => {
  const shootDir = (extraDamageDraws: number) => {
    const players = new PlayerManager(new MapCollision(miniMap), {
      matchSeed: 0x51d3de01,
    });
    for (let i = 0; i < extraDamageDraws; i++) {
      players.getSimRngStreams().damage();
    }
    const shooter = players.add("shooter", "Human", "A");
    const victim = players.add("victim", "Victim", "B");
    placeFacing(shooter, victim);
    const outcome = players.handleShoot(shooter.id, TICK, {
      yaw: 0,
      pitch: 0,
      clientTick: TICK,
      origin: [0, 1.7, 5],
    });
    assertExists(outcome);
    return outcome.shot.direction;
  };
  const a = shootDir(0);
  const b = shootDir(40);
  assertEquals(a[0], b[0]);
  assertEquals(a[1], b[1]);
  assertEquals(a[2], b[2]);
});
