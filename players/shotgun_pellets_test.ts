/**
 * Shotgun PR 3: server multi-pellet resolution (notes/shotgun.md).
 * Tests set `weaponId` directly (bypasses the switch timer).
 * Run: deno test -A server-community/players/shotgun_pellets_test.ts
 */
import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertExists,
} from "jsr:@std/assert@1";
import { PlayerManager } from "./PlayerManager.ts";
import type { Player } from "./Player.ts";
import {
  SPAWN_INVULN_TICKS,
  WEAPON_SHOTGUN,
} from "../protocol/network.ts";
import type { DoorsMap, Wall } from "../world/map.ts";
import { MapCollision } from "../world/MapCollision.ts";
import {
  HAWKEYES_PELLET_CONE_SCALE,
  isWeaponId,
  PISTOL,
  SHOTGUN,
  shotBaseDamage,
  WEAPON_ORDER,
  WEAPON_PISTOL,
  WEAPON_RIFLE,
} from "../shared/sim/weapons.ts";
import { pelletDirections, pelletDrawCount } from "../shared/sim/pellets.ts";
import { spreadDirectionFromYawPitch } from "../combat/aimSpread.ts";

function testMap(walls: Wall[] = [], half = 300): DoorsMap {
  return {
    name: "shotgun-pellets-test",
    version: 1,
    bounds: { minX: -half, maxX: half, minZ: -half, maxZ: half },
    gridSize: 1,
    walls,
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
}

const TICK = SPAWN_INVULN_TICKS + 60;
/** Shotgun still bloom draws (cone open) — both zeroed to keep the aim. */
const BLOOM = [0, 0];
/** Normal pattern: ring rotation 0, then neutral (0.5) jitter per draw. */
const PATTERN = [
  0,
  ...new Array(pelletDrawCount(SHOTGUN, false) - 1).fill(0.5),
];

type Rig = {
  players: PlayerManager;
  shooter: Player;
  log: number[];
  shoot: () => ReturnType<PlayerManager["handleShoot"]>;
  place: (p: Player, x: number, z: number) => void;
};

/**
 * One shared RNG queue (spread shares `damageRandom` when no `spreadRandom`
 * is injected). Throws on an unexpected extra draw.
 */
function rig(opts: {
  samples: number[];
  walls?: Wall[];
  shooterZ?: number;
  weaponId?: number;
}): Rig {
  const samples = [...opts.samples];
  const log: number[] = [];
  const players = new PlayerManager(new MapCollision(testMap(opts.walls)), {
    damageRandom: () => {
      const v = samples.shift();
      if (v === undefined) throw new Error("extra rng draw");
      log.push(v);
      return v;
    },
  });
  const shooterZ = opts.shooterZ ?? 3;
  const shooter = players.add("s", "S", "A");
  const place = (p: Player, x: number, z: number) => {
    p.x = x;
    p.y = 1.7;
    p.z = z;
    p.yaw = 0;
    p.pitch = 0;
    p.spawnedAtTick = 0;
    p.health = 100;
    for (let t = TICK - 16; t <= TICK + 4; t++) p.recordPose(t);
  };
  place(shooter, 0, shooterZ);
  shooter.weaponId = opts.weaponId ?? WEAPON_SHOTGUN;
  shooter.unlimitedAmmo = true;
  const shoot = () =>
    players.handleShoot(shooter.id, TICK, {
      yaw: 0,
      pitch: 0,
      clientTick: TICK,
      origin: [0, 1.7, shooterZ],
    });
  return { players, shooter, log, shoot, place };
}

/** Neutral-roll damage for the pellets that hit `victimId` (from the wire). */
function expectedDamage(
  shot: NonNullable<ReturnType<PlayerManager["handleShoot"]>>["shot"],
  victimId: string,
): number {
  let sum = 0;
  for (const p of shot.pellets!) {
    if (p.hitId !== victimId) continue;
    const dist = Math.hypot(
      p.hitPoint![0] - shot.origin[0],
      p.hitPoint![1] - shot.origin[1],
      p.hitPoint![2] - shot.origin[2],
    );
    sum += shotBaseDamage(SHOTGUN, p.hitZone === "head", dist);
  }
  return Math.round(sum);
}

Deno.test("shotgun def: 8 pellets, third in the loadout order", () => {
  assertEquals(SHOTGUN.pellets, 8);
  assertEquals(isWeaponId(WEAPON_SHOTGUN), true);
  assertEquals([...WEAPON_ORDER], [WEAPON_PISTOL, WEAPON_RIFLE, WEAPON_SHOTGUN]);
});

Deno.test("single-pellet guns keep today's draws and wire shape", () => {
  // Pistol: 2 bloom draws + 1 damage roll, no pattern draws.
  const { shoot, log, place, players } = rig({
    samples: [0, 0, 0.5],
    weaponId: PISTOL.id,
  });
  const victim = players.add("v", "V", "B");
  place(victim, 0, 0);
  const outcome = shoot();
  assertExists(outcome?.damages);
  assertEquals(log, [0, 0, 0.5]);
  assertEquals(outcome.shot.pellets, undefined);
  assertEquals(outcome.shot.hitId, "v");
  assertEquals(outcome.damages.length, 1);
  assertEquals(outcome.damages[0]!.damage, PISTOL.headDamage);
});

Deno.test("point blank: every pellet on one victim, one summed outcome", () => {
  const { shoot, log, place, players } = rig({
    samples: [...BLOOM, ...PATTERN, 0.5],
  });
  const victim = players.add("v", "V", "B");
  place(victim, 0, 0);
  const outcome = shoot();
  assertExists(outcome?.damages);
  const pellets = outcome.shot.pellets!;
  assertEquals(pellets.length, 8);
  assert(pellets.every((p) => p.hitId === "v"));
  // Centre pellet mirrors the top-level fields.
  assertEquals(pellets[0]!.direction, outcome.shot.direction);
  assertEquals(pellets[0]!.hitPoint, outcome.shot.hitPoint);
  // One damage roll for the whole blast.
  assertEquals(log.length, BLOOM.length + PATTERN.length + 1);
  assertEquals(outcome.damages.length, 1);
  const d = outcome.damages[0]!;
  assertEquals(d.targetId, "v");
  // Eye-level centre pellet → head.
  assertEquals(d.zone, "head");
  assertEquals(d.damage, expectedDamage(outcome.shot, "v"));
  assert(d.damage > SHOTGUN.bodyDamage * 7);
  assertEquals(d.killed, true);
});

Deno.test("pellets split across two victims: one outcome each, id order", () => {
  // Aim between two victims 8 units out: the centre pellet flies through the
  // gap, ring pellets land on either side.
  const { shoot, log, place, players } = rig({
    samples: [...BLOOM, ...PATTERN, 0.5, 0.5],
    shooterZ: 8,
  });
  // Add in reverse id order: outcomes still come out v1, v2.
  const v2 = players.add("v2", "V2", "B");
  const v1 = players.add("v1", "V1", "B");
  place(v1, -0.45, 0);
  place(v2, 0.45, 0);
  const outcome = shoot();
  assertExists(outcome?.damages);
  const pellets = outcome.shot.pellets!;
  assertEquals(outcome.shot.hitId, null);
  assert(pellets.some((p) => p.hitId === "v1"));
  assert(pellets.some((p) => p.hitId === "v2"));
  assertEquals(log.length, BLOOM.length + PATTERN.length + 2);
  assertEquals(outcome.damages.map((d) => d.targetId), ["v1", "v2"]);
  assertEquals(outcome.damages[0]!.damage, expectedDamage(outcome.shot, "v1"));
  assertEquals(outcome.damages[1]!.damage, expectedDamage(outcome.shot, "v2"));
  assertEquals(v1.health, 100 - outcome.damages[0]!.damage);
  assertEquals(v2.health, 100 - outcome.damages[1]!.damage);
});

Deno.test("a wall blocks some pellets; the rest still hit", () => {
  // Full wall covering x < 0 between shooter and victim.
  const walls: Wall[] = [{ id: "w", a: { x: -5, z: 3 }, b: { x: -0.1, z: 3 } }];
  const { shoot, place, players } = rig({
    samples: [...BLOOM, ...PATTERN, 0.5],
    walls,
    shooterZ: 8,
  });
  const victim = players.add("v", "V", "B");
  place(victim, 0, 0);
  const outcome = shoot();
  assertExists(outcome);
  const pellets = outcome.shot.pellets!;
  // Blocked pellets stop on the wall (tracer impact point, left side).
  const blocked = pellets.filter((p) =>
    p.hitId === null && p.hitPoint !== null &&
    Math.abs(p.hitPoint[2] - 3) < 0.5
  );
  const hits = pellets.filter((p) => p.hitId === "v");
  assert(blocked.length > 0, "some pellets blocked");
  assert(hits.length > 0, "some pellets through");
  for (const p of blocked) assert(p.hitPoint![0] < 0);
  // No pellet reaches the victim through the wall's side.
  for (const p of hits) assert(p.hitPoint![0] > -0.1);
  assertExists(outcome.damages);
  assertEquals(outcome.damages[0]!.damage, expectedDamage(outcome.shot, "v"));
});

Deno.test("falloff at range: pellets that land do reduced damage", () => {
  const { shoot, place, players } = rig({
    samples: [...BLOOM, ...PATTERN, 0.5],
    shooterZ: 30,
  });
  const victim = players.add("v", "V", "B");
  place(victim, 0, 0);
  const outcome = shoot();
  assertExists(outcome?.damages);
  const hits = outcome.shot.pellets!.filter((p) => p.hitId === "v");
  assert(hits.length > 0);
  const full = hits.reduce(
    (s, p) => s + (p.hitZone === "head" ? SHOTGUN.headDamage : SHOTGUN.bodyDamage),
    0,
  );
  const dealt = outcome.damages[0]!.damage;
  assertEquals(dealt, expectedDamage(outcome.shot, "v"));
  assert(dealt < full, `${dealt} < ${full}`);
});

Deno.test("a single far pellet (200+ units) still deals ≥ 1 damage", () => {
  // Lowest roll (-5) on a floor-scaled pellet would reach 0 without the clamp.
  const { shoot, place, players } = rig({
    samples: [...BLOOM, ...PATTERN, 0],
    shooterZ: 220,
  });
  const victim = players.add("v", "V", "B");
  place(victim, 0, 0);
  const outcome = shoot();
  assertExists(outcome?.damages);
  const hits = outcome.shot.pellets!.filter((p) => p.hitId === "v");
  assertEquals(hits.length, 1);
  assertEquals(outcome.damages[0]!.damage, 1);
  assertEquals(victim.health, 99);
});

Deno.test("teamfire: mirror applied once for the summed damage", () => {
  const { shoot, place, players, shooter, log } = rig({
    samples: [...BLOOM, ...PATTERN, 0.5],
    shooterZ: 30,
  });
  const mate = players.add("m", "M", "A");
  place(mate, 0, 0);
  const outcome = shoot();
  assertExists(outcome?.damages);
  assertEquals(log.length, BLOOM.length + PATTERN.length + 1);
  assertEquals(outcome.damages.map((d) => d.targetId), ["m", "s"]);
  const dealt = outcome.damages[0]!.damage;
  assertEquals(outcome.damages[1]!.damage, dealt);
  assertEquals(shooter.health, 100 - dealt);
  assertEquals(mate.health, 100 - dealt);
});

Deno.test("leech: heals once from the summed damage", () => {
  const { shoot, place, players, shooter } = rig({
    samples: [...BLOOM, ...PATTERN, 0.5],
    shooterZ: 30,
  });
  const victim = players.add("v", "V", "B");
  place(victim, 0, 0);
  shooter.health = 50;
  const outcome = shoot();
  assertExists(outcome?.damages);
  assertEquals(outcome.leech, true);
  const applied = 100 - victim.health;
  assert(applied > 0);
  // Unrestricted (bot-style) loadout → tier II 15%.
  assertEquals(shooter.health, 50 + Math.floor(applied * 0.15));
});

Deno.test("oneShot: summed pellets are lethal", () => {
  const { shoot, place, players, shooter } = rig({
    samples: [...BLOOM, ...PATTERN, 0.5],
    shooterZ: 30,
  });
  const victim = players.add("v", "V", "B");
  place(victim, 0, 0);
  shooter.restoreAbilityCharges();
  assertEquals(shooter.tryActivateAbility("oneShot", TICK), true);
  const outcome = shoot();
  assertExists(outcome?.damages);
  assertEquals(outcome.damages.length, 1);
  assertEquals(outcome.damages[0]!.killed, true);
  assertEquals(victim.alive, false);
  assertEquals(shooter.kills, 1);
});

Deno.test("invulnerable victim: pellet tracers, no damage, no damage draws", () => {
  const { shoot, place, players, log } = rig({
    samples: [...BLOOM, ...PATTERN],
  });
  const victim = players.add("v", "V", "B");
  place(victim, 0, 0);
  // Fresh spawn protection.
  victim.spawnedAtTick = TICK;
  const outcome = shoot();
  assertExists(outcome);
  assert(outcome.shot.pellets!.every((p) => p.hitId === "v"));
  assertEquals(outcome.damages, undefined);
  assertEquals(victim.health, 100);
  assertEquals(log.length, BLOOM.length + PATTERN.length);
});

Deno.test("hawkeyes: uniform half-size ring, no spread draws", () => {
  const { shoot, place, players, shooter, log } = rig({ samples: [0.5] });
  const victim = players.add("v", "V", "B");
  place(victim, 0, 0);
  shooter.restoreAbilityCharges();
  assertEquals(shooter.tryActivateAbility("hawkeyes", TICK), true);
  const outcome = shoot();
  assertExists(outcome?.damages);
  // Only the damage roll: no bloom, no pattern draws.
  assertEquals(log, [0.5]);
  const expected = pelletDirections(
    spreadDirectionFromYawPitch(0, 0, 0),
    SHOTGUN,
    { uniform: true, coneScale: HAWKEYES_PELLET_CONE_SCALE },
    () => {
      throw new Error("uniform pattern must not draw");
    },
  );
  const got = outcome.shot.pellets!.map((p) => p.direction);
  assertEquals(got.length, expected.length);
  for (let i = 0; i < got.length; i++) {
    assertAlmostEquals(got[i]![0], expected[i]!.x, 1e-9);
    assertAlmostEquals(got[i]![1], expected[i]!.y, 1e-9);
    assertAlmostEquals(got[i]![2], expected[i]!.z, 1e-9);
  }
});
