/**
 * Pistol-whip melee: short range, flat 45–55 roll, pistol-only, cooldown-gated.
 */
import { assert, assertEquals, assertExists } from "jsr:@std/assert@1";
import { PlayerManager } from "./PlayerManager.ts";
import {
  MELEE_COOLDOWN_TICKS,
  SPAWN_INVULN_TICKS,
  WEAPON_RIFLE,
  WEAPON_SWITCH_TICKS,
} from "../protocol/network.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";

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

type Placed = {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  spawnedAtTick: number;
  health: number;
  recordPose: (t: number) => void;
};

/** Attacker faces victim at `gap` world units; stamps lag-comp poses. */
function placeForMelee(shooter: Placed, victim: Placed, gap: number): void {
  // yaw=0 → look dir (0, 0, -1)
  shooter.x = 0;
  shooter.y = 1.7;
  shooter.z = gap;
  shooter.yaw = 0;
  shooter.pitch = 0;
  shooter.spawnedAtTick = 0;
  shooter.health = 100;
  for (let t = TICK - 16; t <= TICK; t++) shooter.recordPose(t);

  victim.x = 0;
  victim.y = 1.7;
  victim.z = 0;
  victim.spawnedAtTick = 0;
  victim.health = 100;
  for (let t = TICK - 16; t <= TICK; t++) victim.recordPose(t);
}

function swing(pm: PlayerManager, tick: number, gap: number) {
  return pm.handleMelee("s1", tick, {
    yaw: 0,
    pitch: 0,
    clientTick: tick,
    origin: [0, 1.7, gap],
  });
}

Deno.test("melee: in-range swing connects with flat 50 roll, no ammo spent", () => {
  const pm = makeManager();
  const attacker = pm.add("s1", "Attacker", "A");
  const victim = pm.add("v1", "Enemy", "B");
  placeForMelee(attacker, victim, 2.5);
  const ammoBefore = attacker.ammoInMag;

  const outcome = swing(pm, TICK, 2.5);

  assertExists(outcome);
  assertEquals(outcome!.shot.melee, true);
  assertEquals(outcome!.shot.weapon, 0);
  assertEquals(outcome!.shot.hitId, "v1");
  assertExists(outcome!.damages);
  assertEquals(outcome!.damages!.length, 1);
  // Eye-level registers head, but melee deals the flat body roll (50 at 0.5).
  assertEquals(outcome!.shot.hitZone, "head");
  assertEquals(outcome!.damages![0]!.damage, 50);
  assertEquals(victim.health, 50);
  assertEquals(attacker.ammoInMag, ammoBefore);
  assertEquals(outcome!.damages![0]!.hitSlowStacks, 1);
});

Deno.test("melee: damage roll spans 45–55 across samples", () => {
  for (const [sample, want] of [[0.0, 45], [0.5, 50], [0.95, 55]] as const) {
    const pm = makeManager(sample);
    const attacker = pm.add("s1", "Attacker", "A");
    const victim = pm.add("v1", "Enemy", "B");
    placeForMelee(attacker, victim, 2.5);
    const outcome = swing(pm, TICK, 2.5);
    assertExists(outcome?.damages, `sample ${sample}`);
    assertEquals(outcome!.damages![0]!.damage, want, `sample ${sample}`);
    assert(victim.health === 100 - want, `sample ${sample}`);
  }
});

Deno.test("melee: out-of-range swing whiffs but still broadcasts the swing", () => {
  const pm = makeManager();
  const attacker = pm.add("s1", "Attacker", "A");
  const victim = pm.add("v1", "Enemy", "B");
  placeForMelee(attacker, victim, 5);

  const outcome = swing(pm, TICK, 5);

  assertExists(outcome);
  assertEquals(outcome!.shot.melee, true);
  assertEquals(outcome!.shot.hitId, null);
  assertEquals(outcome!.damages, undefined);
  assertEquals(victim.health, 100);
});

Deno.test("melee: rifle equipped denies the swing", () => {
  const pm = makeManager();
  const attacker = pm.add("s1", "Attacker", "A");
  const victim = pm.add("v1", "Enemy", "B");
  placeForMelee(attacker, victim, 2.5);
  assertEquals(
    pm.handleWeaponSwitch("s1", WEAPON_RIFLE, TICK - WEAPON_SWITCH_TICKS - 1),
    true,
  );

  const outcome = swing(pm, TICK, 2.5);

  assertEquals(outcome, null);
  assertEquals(victim.health, 100);
});

Deno.test("melee: cooldown blocks an instant second swing", () => {
  const pm = makeManager();
  const attacker = pm.add("s1", "Attacker", "A");
  const victim = pm.add("v1", "Enemy", "B");
  placeForMelee(attacker, victim, 2.5);

  assertExists(swing(pm, TICK, 2.5));
  assertEquals(swing(pm, TICK, 2.5), null);
  assertExists(swing(pm, TICK + MELEE_COOLDOWN_TICKS, 2.5));
  assertEquals(victim.health, 0);
  assertEquals(victim.alive, false);
});

Deno.test("melee: reloading blocks the swing", () => {
  const pm = makeManager();
  const attacker = pm.add("s1", "Attacker", "A");
  const victim = pm.add("v1", "Enemy", "B");
  placeForMelee(attacker, victim, 2.5);
  // Spend the mag so a reload can start.
  for (let i = 0; i < attacker.ammoInMag; i++) attacker.markShot(TICK - 100);
  assertEquals(pm.handleReload("s1", TICK), true);

  assertEquals(swing(pm, TICK, 2.5), null);
  assertEquals(victim.health, 100);
});
