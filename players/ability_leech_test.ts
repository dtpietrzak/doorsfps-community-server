/**
 * Skill D — Leech (Medic, passive, lifesteal).
 * Run: deno test -A server/players/ability_leech_test.ts
 */
import { assertEquals, assertExists } from "jsr:@std/assert@1";
import { MAX_HEALTH, SPAWN_INVULN_TICKS } from "../protocol/network.ts";
import { skillValueForOwned } from "../shared/sim/skills.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";
import { PISTOL } from "../shared/sim/weapons.ts";
import { PlayerManager } from "./PlayerManager.ts";

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

function makeManager(): PlayerManager {
  return new PlayerManager(new MapCollision(miniMap), {
    damageRandom: () => 0.5,
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

function shoot(pm: PlayerManager, shooterId: string) {
  return pm.handleShoot(shooterId, TICK, {
    yaw: 0,
    pitch: 0,
    clientTick: TICK,
    origin: [0, 1.7, 5],
  });
}

Deno.test("leech: catalog values 10% / 15%", () => {
  assertEquals(skillValueForOwned("leech", ["leech"]), 0.1);
  assertEquals(skillValueForOwned("leech", ["leech", "leech2"]), 0.15);
  assertEquals(skillValueForOwned("leech", null), 0.15);
  assertEquals(skillValueForOwned("leech", []), 0);
});

Deno.test("leech: unrestricted (bots) heals floor(damage * 0.15) on enemy hit", () => {
  const pm = makeManager();
  const shooter = pm.add("s1", "Shooter", "A");
  const victim = pm.add("v1", "Enemy", "B");
  // Wound shooter so heal is visible.
  placeForShot(shooter, victim, { shooterHealth: 50 });

  const outcome = shoot(pm, "s1");
  assertExists(outcome);
  assertEquals(outcome!.shot.hitId, "v1");
  // Eye-level center mass → head.
  assertEquals(outcome!.shot.hitZone, "head");

  const applied = PISTOL.headDamage;
  assertEquals(victim.health, 100 - applied);
  // Max tier 15%: floor(55 * 0.15) = 8
  assertEquals(Math.floor(applied * 0.15), 8);
  assertEquals(shooter.health, 50 + 8);
});

Deno.test("leech: tier I heals floor(damage * 0.10)", () => {
  const pm = makeManager();
  const shooter = pm.add("s1", "Shooter", "A", {
    ownedAbilities: ["selfHeal", "teamHeal", "leech"],
  });
  const victim = pm.add("v1", "Enemy", "B");
  placeForShot(shooter, victim, { shooterHealth: 40 });

  assertEquals(skillValueForOwned("leech", ["leech"]), 0.1);
  const outcome = shoot(pm, "s1");
  assertExists(outcome);
  assertEquals(outcome!.shot.hitZone, "head");
  // floor(55 * 0.10) = 5
  assertEquals(shooter.health, 40 + 5);
  assertEquals(victim.health, 100 - PISTOL.headDamage);
});

Deno.test("leech: tier II heals floor(damage * 0.15)", () => {
  const pm = makeManager();
  const shooter = pm.add("s1", "Shooter", "A", {
    ownedAbilities: ["selfHeal", "teamHeal", "leech", "leech2"],
  });
  const victim = pm.add("v1", "Enemy", "B");
  placeForShot(shooter, victim, { shooterHealth: 40 });

  const outcome = shoot(pm, "s1");
  assertExists(outcome);
  assertEquals(shooter.health, 40 + Math.floor(PISTOL.headDamage * 0.15));
});

Deno.test("leech: unowned guest gets no heal", () => {
  const pm = makeManager();
  const shooter = pm.add("s1", "Guest", "A", {
    ownedAbilities: [],
  });
  const victim = pm.add("v1", "Enemy", "B");
  placeForShot(shooter, victim, { shooterHealth: 50 });

  assertEquals(shooter.ownsAbility("leech"), false);
  const outcome = shoot(pm, "s1");
  assertExists(outcome);
  assertEquals(outcome!.shot.hitId, "v1");
  assertEquals(shooter.health, 50);
  assertEquals(victim.health, 100 - PISTOL.headDamage);
});

Deno.test("leech: no lifesteal on teamfire (friendly mirror)", () => {
  const pm = makeManager();
  // Unrestricted ownership would leech on enemies; team hits must not.
  const shooter = pm.add("s1", "Shooter", "A");
  const victim = pm.add("v1", "Ally", "A");
  // Start high enough to survive mirror damage so we can assert exact HP.
  placeForShot(shooter, victim, { shooterHealth: 90 });

  const outcome = shoot(pm, "s1");
  assertExists(outcome);
  assertEquals(outcome!.damages!.length, 2);
  // Teamfire: both take full damage; no leech top-up on shooter.
  assertEquals(victim.health, 100 - PISTOL.headDamage);
  assertEquals(shooter.health, 90 - PISTOL.headDamage);
  assertEquals(shooter.alive, true);
});

Deno.test("leech: clamps to max health", () => {
  const pm = makeManager();
  const shooter = pm.add("s1", "Shooter", "A", {
    ownedAbilities: ["leech", "leech2"],
  });
  const victim = pm.add("v1", "Enemy", "B");
  // Missing only 2 HP; leech would want 8.
  placeForShot(shooter, victim, { shooterHealth: MAX_HEALTH - 2 });

  const outcome = shoot(pm, "s1");
  assertExists(outcome);
  assertEquals(shooter.health, MAX_HEALTH);
});

Deno.test("leech: uses actual HP removed (no overkill lifesteal)", () => {
  const pm = makeManager();
  const shooter = pm.add("s1", "Shooter", "A", {
    ownedAbilities: ["leech"],
  });
  const victim = pm.add("v1", "Enemy", "B");
  // Victim has 3 HP; headshot is 55 but applied is only 3.
  placeForShot(shooter, victim, {
    shooterHealth: 50,
    victimHealth: 3,
  });

  const outcome = shoot(pm, "s1");
  assertExists(outcome);
  assertEquals(victim.alive, false);
  assertEquals(victim.health, 0);
  // floor(3 * 0.10) = 0 — no heal when applied damage * fraction < 1
  assertEquals(Math.floor(3 * 0.1), 0);
  assertEquals(shooter.health, 50);

  // Larger remaining HP so floor is non-zero: 12 * 0.10 = 1.2 → 1
  const pm2 = makeManager();
  const s2 = pm2.add("s2", "Shooter", "A", {
    ownedAbilities: ["leech"],
  });
  const v2 = pm2.add("v2", "Enemy", "B");
  placeForShot(s2, v2, { shooterHealth: 50, victimHealth: 12 });
  // Need a fresh tick / canShoot — new players can shoot at TICK.
  const out2 = shoot(pm2, "s2");
  assertExists(out2);
  assertEquals(v2.alive, false);
  assertEquals(s2.health, 50 + Math.floor(12 * 0.1));
});

Deno.test("leech: invulnerable victim (spawn protect) yields no heal", () => {
  const pm = makeManager();
  const shooter = pm.add("s1", "Shooter", "A");
  const victim = pm.add("v1", "Enemy", "B");
  placeForShot(shooter, victim, { shooterHealth: 50 });
  // Victim still under spawn invuln at low tick — re-place with recent spawn.
  victim.spawnedAtTick = TICK; // still protected at TICK
  for (let t = TICK - 16; t <= TICK; t++) victim.recordPose(t);

  const outcome = shoot(pm, "s1");
  assertExists(outcome);
  // Hit for tracers but no damage outcomes when invulnerable.
  assertEquals(outcome!.shot.hitId, "v1");
  assertEquals(outcome!.damages, undefined);
  assertEquals(victim.health, 100);
  assertEquals(shooter.health, 50);
});

Deno.test("leech: passive never activates / spends charge", () => {
  const pm = makeManager();
  const shooter = pm.add("s1", "Shooter", "A");
  assertEquals(shooter.canActivateAbility("leech", 0), false);
  assertEquals(shooter.tryActivateAbility("leech", 0), false);
  assertEquals(pm.handleAbility("s1", "leech", 0), false);
  assertEquals(shooter.isAbilitySpent("leech"), false);
});
