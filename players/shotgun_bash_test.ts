/**
 * Shotgun PR 5: stock bash (per-weapon melee) on the server (notes/shotgun.md).
 * The shotgun isn't in WEAPON_ORDER / isWeaponId yet (PR 8), so tests equip
 * it by setting `weaponId` directly.
 * Run: deno test -A server-community/players/shotgun_bash_test.ts
 */
import { assert, assertEquals, assertExists } from "jsr:@std/assert@1";
import {
  getWeapon,
  MELEE_COOLDOWN_TICKS,
  SPAWN_INVULN_TICKS,
  WEAPON_RIFLE,
  WEAPON_SHOTGUN,
} from "../protocol/network.ts";
import { msToTicks } from "../shared/sim/game.ts";
import { SHOTGUN, shellReloadOf } from "../shared/sim/weapons.ts";
import type { Player } from "./Player.ts";
import { PlayerManager } from "./PlayerManager.ts";
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

const bash = SHOTGUN.melee!;
const shell = shellReloadOf(SHOTGUN)!;
const BASH_COOLDOWN = getWeapon(WEAPON_SHOTGUN).meleeCooldownTicks!;
const SWING = msToTicks(bash.swingMs);
const START = msToTicks(shell.startMs);
const PER_SHELL = msToTicks(shell.perShellMs);
const PUMP = msToTicks(shell.pumpMs);

/** Past spawn protection; room for timers set up before it. */
const TICK = SPAWN_INVULN_TICKS + 200;

function makeManager(damageSample = 0.5): PlayerManager {
  return new PlayerManager(new MapCollision(miniMap), {
    damageRandom: () => damageSample,
  });
}

/** Shotgun attacker faces the victim at `gap` world units; stamps poses. */
function setup(gap: number, damageSample = 0.5) {
  const pm = makeManager(damageSample);
  const attacker = pm.add("s1", "Attacker", "A");
  const victim = pm.add("v1", "Enemy", "B");
  attacker.weaponId = WEAPON_SHOTGUN;
  // yaw=0 → look dir (0, 0, -1)
  attacker.x = 0;
  attacker.y = 1.7;
  attacker.z = gap;
  attacker.yaw = 0;
  attacker.pitch = 0;
  attacker.spawnedAtTick = 0;
  victim.x = 0;
  victim.y = 1.7;
  victim.z = 0;
  victim.spawnedAtTick = 0;
  stampPoses(attacker, victim, TICK);
  return { pm, attacker, victim };
}

function stampPoses(a: Player, v: Player, tick: number): void {
  for (let t = tick - 16; t <= tick; t++) {
    a.recordPose(t);
    v.recordPose(t);
  }
}

function swing(pm: PlayerManager, tick: number, gap: number) {
  return pm.handleMelee("s1", tick, {
    yaw: 0,
    pitch: 0,
    clientTick: tick,
    origin: [0, 1.7, gap],
  });
}

/** Test-only: overwrite a slot's tube / mag ammo (no public setter). */
function setSlotAmmo(p: Player, weaponId: number, ammoInMag: number): void {
  (p as unknown as {
    loadouts: Record<number, { ammoInMag: number }>;
  }).loadouts[weaponId]!.ammoInMag = ammoInMag;
}

/** Run the per-tick weapon timers the way `Player.update` does. */
function step(p: Player, from: number, to: number): void {
  for (let t = from; t <= to; t++) {
    p.tickWeaponSwitch(t);
    p.tickReload(t);
    p.tickPump(t);
  }
}

Deno.test("shotgun has stock-bash stats; rifle still has none", () => {
  assertEquals(bash, {
    baseDamage: 55,
    range: 2.6,
    cooldownMs: 800,
    swingMs: 500,
    hitMomentT: 0.5,
  });
  assertEquals(getWeapon(WEAPON_RIFLE).meleeCooldownTicks, null);
  assert(BASH_COOLDOWN > MELEE_COOLDOWN_TICKS, "bash slower than whip");
});

Deno.test("bash: in-range swing deals a flat 55 roll, no ammo or pump", () => {
  const { pm, attacker, victim } = setup(2.3);
  const ammoBefore = attacker.ammoInMag;
  const spareBefore = attacker.spareClips;

  const outcome = swing(pm, TICK, 2.3);

  assertExists(outcome);
  assertEquals(outcome!.shot.melee, true);
  assertEquals(outcome!.shot.weapon, WEAPON_SHOTGUN);
  assertEquals(outcome!.shot.hitId, "v1");
  assertEquals(outcome!.shot.pellets, undefined);
  assertEquals(outcome!.damages?.length, 1);
  assertEquals(outcome!.damages![0]!.damage, 55);
  assertEquals(victim.health, 45);
  assertEquals(attacker.ammoInMag, ammoBefore);
  assertEquals(attacker.spareClips, spareBefore);
  assertEquals(attacker.chambered, true);
  assertEquals(attacker.isPumping(), false);
});

Deno.test("bash: damage roll spans 50–60 across samples", () => {
  for (const [sample, want] of [[0.0, 50], [0.5, 55], [0.95, 60]] as const) {
    const { pm, victim } = setup(2.3, sample);
    const outcome = swing(pm, TICK, 2.3);
    assertEquals(outcome?.damages?.[0]?.damage, want, `sample ${sample}`);
    assertEquals(victim.health, 100 - want, `sample ${sample}`);
  }
});

Deno.test("bash: out-of-range swing whiffs but still broadcasts", () => {
  const { pm, victim } = setup(5);
  const outcome = swing(pm, TICK, 5);
  assertExists(outcome);
  assertEquals(outcome!.shot.melee, true);
  assertEquals(outcome!.shot.hitId, null);
  assertEquals(outcome!.damages, undefined);
  assertEquals(victim.health, 100);
});

Deno.test("bash: shotgun cooldown, not the pistol-whip one", () => {
  const { pm, attacker, victim } = setup(2.3);
  assertExists(swing(pm, TICK, 2.3));
  assertEquals(swing(pm, TICK + MELEE_COOLDOWN_TICKS, 2.3), null);
  assertEquals(attacker.canMelee(TICK + BASH_COOLDOWN - 1), false);
  stampPoses(attacker, victim, TICK + BASH_COOLDOWN);
  assertExists(swing(pm, TICK + BASH_COOLDOWN, 2.3)?.damages);
  assertEquals(victim.alive, false, "two bashes kill");
});

Deno.test("bash mid-reload stops loading and pumps after the swing", () => {
  const { pm, attacker } = setup(2.3);
  // Two shells short, then start loading so the swing lands at TICK with
  // one shell in and the second still pending.
  const tick = TICK;
  const t0 = tick - (START + PER_SHELL + 1);
  setSlotAmmo(attacker, WEAPON_SHOTGUN, SHOTGUN.magSize - 2);
  assertEquals(attacker.tryBeginReload(t0), true);
  step(attacker, t0 + 1, tick - 1);
  assertEquals(attacker.ammoInMag, SHOTGUN.magSize - 1);
  assertEquals(attacker.isReloading(), true);

  const outcome = swing(pm, tick, 2.3);

  assertExists(outcome?.damages, "the bash connects mid-reload");
  assertEquals(attacker.isReloading(), false);
  assertEquals(attacker.ammoInMag, SHOTGUN.magSize - 1, "loaded shell stays");
  assertEquals(attacker.chambered, false);
  assertEquals(attacker.isPumping(), true);
  assertEquals(attacker.pumpEndsAtTick, tick + SWING + PUMP);
  // No more shells arrive after the interrupt.
  step(attacker, tick + 1, tick + SWING + PUMP - 1);
  assertEquals(attacker.ammoInMag, SHOTGUN.magSize - 1);
  assertEquals(attacker.canShoot(tick + SWING + PUMP - 1), false);
  step(attacker, tick + SWING + PUMP, tick + SWING + PUMP);
  assertEquals(attacker.chambered, true);
  assertEquals(attacker.canShoot(tick + SWING + PUMP), true);
});

Deno.test("bash during a post-shot pump leaves the pump alone", () => {
  const { pm, attacker } = setup(2.3);
  attacker.markShot(TICK);
  const pumpEnd = attacker.pumpEndsAtTick;
  assertExists(swing(pm, TICK + 1, 2.3));
  assertEquals(attacker.pumpEndsAtTick, pumpEnd);
  assertEquals(attacker.chambered, false);
});

Deno.test("pistol-whip is still blocked by a mag reload", () => {
  const { pm, attacker } = setup(2.3);
  attacker.weaponId = 0;
  setSlotAmmo(attacker, 0, 0);
  assertEquals(attacker.tryBeginReload(TICK), true);
  assertEquals(swing(pm, TICK, 2.3), null);
});
