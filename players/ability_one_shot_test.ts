/**
 * Skill H — One-shot (Marksman, timed): any damaging hit kills while active.
 * Run: deno test -A server/players/ability_one_shot_test.ts
 */
import { assertEquals, assertExists } from "jsr:@std/assert@1";
import { abilityBarRegenTicks } from "../shared/sim/abilities.ts";
import { timedSkillDurationTicks } from "../shared/sim/skills.ts";
import { SPAWN_INVULN_TICKS } from "../protocol/network.ts";
import { PISTOL } from "../shared/sim/weapons.ts";
import type { DoorsMap } from "../world/map.ts";
import { MapCollision } from "../world/MapCollision.ts";
import { Player } from "./Player.ts";
import { PlayerManager } from "./PlayerManager.ts";

const durationI = timedSkillDurationTicks("oneShot", undefined, [
  "oneShot",
]);
const durationII = timedSkillDurationTicks("oneShot", undefined, [
  "oneShot",
  "oneShot2",
]);
const durationIII = timedSkillDurationTicks("oneShot", undefined, [
  "oneShot",
  "oneShot2",
  "oneShot3",
]);
const durationMax = timedSkillDurationTicks("oneShot"); // unrestricted max
const barRegenTicks = abilityBarRegenTicks();

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

function makePlayer(owned?: readonly string[] | null): Player {
  const p = new Player("os", "OneShotTester", "A", {
    spawn: { x: 0, z: 0, yaw: Math.PI },
    ...(owned !== undefined ? { ownedAbilities: owned } : {}),
  });
  p.spawnedAtTick = 0;
  p.restoreAbilityCharges();
  return p;
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
    restoreAbilityCharges?: () => void;
  },
  victim: {
    x: number;
    y: number;
    z: number;
    spawnedAtTick: number;
    health: number;
    recordPose: (t: number) => void;
    restoreAbilityCharges?: () => void;
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
  shooter.restoreAbilityCharges?.();
  for (let t = TICK - 16; t <= TICK; t++) shooter.recordPose(t);

  victim.x = 0;
  victim.y = 1.7;
  victim.z = 0;
  victim.spawnedAtTick = 0;
  victim.health = opts?.victimHealth ?? 100;
  victim.restoreAbilityCharges?.();
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

Deno.test("tryActivateAbility oneShot sets window and isAbilityActive", () => {
  const p = makePlayer();
  const tick = 10;
  assertEquals(p.tryActivateAbility("oneShot", tick), true);
  assertEquals(p.isAbilityActive("oneShot", tick), true);
  assertEquals(
    p.isAbilityActive("oneShot", tick + durationMax - 1),
    true,
  );
  assertEquals(
    p.isAbilityActive("oneShot", tick + durationMax),
    false,
  );
  // Re-activate while active is no-op.
  assertEquals(p.tryActivateAbility("oneShot", tick + 1), false);
});

Deno.test("oneShot tier durations: 2 / 2.5 / 3 s", () => {
  assertEquals(
    durationI,
    timedSkillDurationTicks("oneShot", undefined, [
      "oneShot",
    ]),
  );
  assertEquals(
    durationII,
    timedSkillDurationTicks("oneShot", undefined, [
      "oneShot",
      "oneShot2",
    ]),
  );
  assertEquals(durationIII, durationMax);

  const p1 = makePlayer(["oneShot"]);
  assertEquals(p1.tryActivateAbility("oneShot", 0), true);
  assertEquals(p1.isAbilityActive("oneShot", durationI - 1), true);
  assertEquals(p1.isAbilityActive("oneShot", durationI), false);

  const p2 = makePlayer(["oneShot", "oneShot2"]);
  assertEquals(p2.tryActivateAbility("oneShot", 0), true);
  assertEquals(p2.isAbilityActive("oneShot", durationII - 1), true);
  assertEquals(p2.isAbilityActive("oneShot", durationII), false);

  const p3 = makePlayer(["oneShot", "oneShot2", "oneShot3"]);
  assertEquals(p3.tryActivateAbility("oneShot", 0), true);
  assertEquals(p3.isAbilityActive("oneShot", durationIII - 1), true);
  assertEquals(p3.isAbilityActive("oneShot", durationIII), false);
});

Deno.test("unowned oneShot cannot activate", () => {
  const p = makePlayer([]);
  assertEquals(p.ownsAbility("oneShot"), false);
  assertEquals(p.tryActivateAbility("oneShot", 0), false);
});

Deno.test("dead player cannot activate oneShot", () => {
  const p = makePlayer();
  p.alive = false;
  assertEquals(p.tryActivateAbility("oneShot", 0), false);
});

Deno.test("oneShot: enemy hit is lethal (body or head irrelevant)", () => {
  const pm = makeManager();
  const shooter = pm.add("s1", "Shooter", "A");
  const victim = pm.add("v1", "Enemy", "B");
  placeForShot(shooter, victim, { victimHealth: 100 });
  assertEquals(shooter.tryActivateAbility("oneShot", TICK), true);

  // Without one-shot, pistol headshot is not always lethal at full HP depending
  // on catalog — assert kill regardless of zone damage.
  assertEquals(PISTOL.headDamage < 100 || PISTOL.bodyDamage < 100, true);

  const outcome = shoot(pm, "s1");
  assertExists(outcome);
  assertEquals(outcome!.shot.hitId, "v1");
  assertExists(outcome!.damages);
  assertEquals(outcome!.damages!.length, 1);
  assertEquals(outcome!.damages![0]!.killed, true);
  assertEquals(victim.alive, false);
  assertEquals(victim.health, 0);
  assertEquals(victim.deaths, 1);
  assertEquals(shooter.kills, 1);
  assertEquals(shooter.alive, true);
});

Deno.test("oneShot: kills even when victim is above normal weapon damage", () => {
  const pm = makeManager();
  const shooter = pm.add("s1", "Shooter", "A", {
    ownedAbilities: ["oneShot"],
  });
  const victim = pm.add("v1", "Enemy", "B");
  // Full HP; body/head damage alone may not kill — one-shot forces lethal.
  placeForShot(shooter, victim, { victimHealth: 100 });
  assertEquals(shooter.tryActivateAbility("oneShot", TICK), true);

  const outcome = shoot(pm, "s1");
  assertExists(outcome);
  assertEquals(outcome!.damages![0]!.killed, true);
  assertEquals(victim.alive, false);
  // Reported damage is at least full HP so kill is guaranteed.
  assertEquals(outcome!.damages![0]!.damage >= 100, true);
});

Deno.test("oneShot inactive: normal weapon damage applies", () => {
  const pm = makeManager();
  const shooter = pm.add("s1", "Shooter", "A", {
    ownedAbilities: ["oneShot"],
  });
  const victim = pm.add("v1", "Enemy", "B");
  placeForShot(shooter, victim, { victimHealth: 100 });
  // Owned but not activated.
  assertEquals(shooter.isAbilityActive("oneShot", TICK), false);

  const outcome = shoot(pm, "s1");
  assertExists(outcome);
  assertEquals(outcome!.shot.hitZone, "head");
  assertEquals(victim.health, 100 - PISTOL.headDamage);
  assertEquals(victim.alive, true);
  assertEquals(outcome!.damages![0]!.killed, false);
  assertEquals(shooter.kills, 0);
});

Deno.test("oneShot does not pierce Force Field", () => {
  const pm = makeManager();
  const shooter = pm.add("s1", "Shooter", "A");
  const victim = pm.add("v1", "Enemy", "B", {
    ownedAbilities: ["forceField", "forceField2"],
  });
  placeForShot(shooter, victim);
  assertEquals(shooter.tryActivateAbility("oneShot", TICK), true);
  assertEquals(victim.tryActivateAbility("forceField", TICK), true);
  assertEquals(victim.isInvulnerable(TICK), true);

  const outcome = shoot(pm, "s1");
  assertExists(outcome);
  // Hit registers for tracers, but no damage outcomes.
  assertEquals(outcome!.shot.hitId, "v1");
  assertEquals(outcome!.damages, undefined);
  assertEquals(victim.alive, true);
  assertEquals(victim.health, 100);
  assertEquals(shooter.kills, 0);
});

Deno.test("oneShot does not pierce spawn protection", () => {
  const pm = makeManager();
  const shooter = pm.add("s1", "Shooter", "A");
  const victim = pm.add("v1", "Enemy", "B");
  placeForShot(shooter, victim);
  // Fresh spawn invuln.
  victim.spawnedAtTick = TICK;
  for (let t = TICK - 16; t <= TICK; t++) victim.recordPose(t);
  assertEquals(victim.isSpawnProtected(TICK), true);
  assertEquals(shooter.tryActivateAbility("oneShot", TICK), true);

  const outcome = shoot(pm, "s1");
  assertExists(outcome);
  assertEquals(outcome!.shot.hitId, "v1");
  assertEquals(outcome!.damages, undefined);
  assertEquals(victim.alive, true);
  assertEquals(victim.health, 100);
});

Deno.test("oneShot teamfire: lethal on ally mirrors to shooter", () => {
  const pm = makeManager();
  const shooter = pm.add("s1", "Shooter", "A");
  const victim = pm.add("v1", "Ally", "A");
  placeForShot(shooter, victim, {
    shooterHealth: 100,
    victimHealth: 100,
  });
  shooter.kills = 3;
  assertEquals(shooter.tryActivateAbility("oneShot", TICK), true);

  const outcome = shoot(pm, "s1");
  assertExists(outcome);
  assertEquals(outcome!.damages!.length, 2);
  assertEquals(victim.alive, false);
  assertEquals(shooter.alive, false);
  // Teamkill: −2 kills on victim death; self-death from mirror adds death only.
  assertEquals(shooter.kills, 1);
  assertEquals(victim.deaths, 1);
  assertEquals(shooter.deaths, 1);
});

Deno.test("after oneShot expires, shots deal normal damage", () => {
  const pm = makeManager();
  const shooter = pm.add("s1", "Shooter", "A");
  const victim = pm.add("v1", "Enemy", "B");
  // Activate past spawn protect; shoot after the window has ended.
  const start = TICK;
  const after = start + durationMax + 5;
  shooter.restoreAbilityCharges();
  assertEquals(shooter.tryActivateAbility("oneShot", start), true);
  assertEquals(shooter.isAbilityActive("oneShot", after), false);

  placeForShot(shooter, victim, { victimHealth: 100 });
  // placeForShot stamps poses at TICK; re-stamp for the later fire tick.
  for (let t = after - 16; t <= after; t++) {
    shooter.recordPose(t);
    victim.recordPose(t);
  }

  const outcome = pm.handleShoot("s1", after, {
    yaw: 0,
    pitch: 0,
    clientTick: after,
    origin: [0, 1.7, 5],
  });
  assertExists(outcome);
  assertEquals(victim.alive, true);
  assertEquals(victim.health, 100 - PISTOL.headDamage);
});

Deno.test("snapshot includes active oneShot while window open", () => {
  const p = makePlayer();
  const tick = 20;
  p.tryActivateAbility("oneShot", tick);
  const snap = p.toSnapshot(tick, "motion");
  assertEquals(Array.isArray(snap.abilities), true);
  assertEquals(snap.abilities!.some((a) => a.id === "oneShot"), true);
  const entry = snap.abilities!.find((a) => a.id === "oneShot")!;
  assertEquals(entry.endsAtTick, tick + durationMax);

  const after = p.toSnapshot(tick + durationMax, "motion");
  assertEquals(
    after.abilities?.some((a) => a.id === "oneShot") ?? false,
    false,
  );
});

Deno.test("oneShot charge spent when window ends + bar regen", () => {
  const p = makePlayer();
  const tick = 0;
  assertEquals(p.tryActivateAbility("oneShot", tick), true);
  p.tickAbilityCharges(tick + durationMax);
  assertEquals(p.isAbilitySpent("oneShot"), true);
  assertEquals(p.isAbilityActive("oneShot", tick + durationMax), false);
  assertEquals(
    p.abilityBarRegenEndsAtTick !== null &&
      p.abilityBarRegenEndsAtTick! >= tick + durationMax,
    true,
  );
  const afterRegen = tick + durationMax + barRegenTicks;
  p.tickAbilityCharges(afterRegen);
  assertEquals(p.tryActivateAbility("oneShot", afterRegen), false);
});

Deno.test("global lock blocks other skills during oneShot", () => {
  const p = makePlayer();
  const tick = 0;
  assertEquals(p.tryActivateAbility("oneShot", tick), true);
  assertEquals(p.tryActivateAbility("bullets", tick + 1), false);
  assertEquals(p.tryActivateAbility("rapidFire", tick + 1), false);
});
