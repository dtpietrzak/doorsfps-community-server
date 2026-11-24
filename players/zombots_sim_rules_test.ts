/**
 * Zombots sim rules (notes/zombots.md steps 12a / 12b): armed sets, fist
 * melee with a per-player damage override, downed instead of dead, revive.
 * Each rule is off unless `zombots` is passed, so the "off" cases pin that
 * other modes see no change.
 */
import { assert, assertEquals, assertExists } from "jsr:@std/assert@1";
import { PlayerManager, type ZombotsSimRules } from "./PlayerManager.ts";
import {
  MAX_HEALTH,
  RESPAWN_DELAY_TICKS,
  SPAWN_INVULN_TICKS,
  WEAPON_PISTOL,
  WEAPON_RIFLE,
  WEAPON_SHOTGUN,
  WEAPON_SWITCH_TICKS,
} from "../protocol/network.ts";
import { FIST_MELEE } from "../shared/sim/armedWeapons.ts";
import { ZOMBOTS_TUNING } from "../shared/zombots/zombotsTuning.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";
import { buildThinkFrame } from "../bots/shadow/frame.ts";
import { runtimePlayer } from "../bots/engine/runtime/player.ts";

const miniMap: DoorsMap = {
  name: "test",
  version: 1,
  bounds: { minX: -50, maxX: 50, minZ: -50, maxZ: 50 },
  gridSize: 1,
  walls: [],
  teamA: { corners: [0, 1], edge: "south", doorHalfWidth: 2, spawnRadius: 4 },
  teamB: { corners: [2, 3], edge: "north", doorHalfWidth: 2, spawnRadius: 4 },
};

const ALL_ON: ZombotsSimRules = {
  armedWeapons: true,
  downedState: true,
  teammatesPassThrough: true,
};

function makeManager(zombots?: ZombotsSimRules): PlayerManager {
  return new PlayerManager(new MapCollision(miniMap), {
    damageRandom: () => 0.5,
    ...(zombots ? { zombots } : {}),
  });
}

const TICK = SPAWN_INVULN_TICKS + 60;

type Placed = {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  spawnedAtTick: number;
  recordPose: (t: number) => void;
};

/** `who` stands at (0, z) looking toward -z, past spawn protection. */
function place(who: Placed, z: number): void {
  who.x = 0;
  who.y = 1.7;
  who.z = z;
  who.yaw = 0;
  who.pitch = 0;
  who.spawnedAtTick = 0;
  for (let t = TICK - 16; t <= TICK; t++) who.recordPose(t);
}

function swing(pm: PlayerManager, id: string, z: number, tick = TICK) {
  return pm.handleMelee(id, tick, {
    yaw: 0,
    pitch: 0,
    clientTick: tick,
    origin: [0, 1.7, z],
  });
}

function shoot(pm: PlayerManager, id: string, z: number, tick = TICK) {
  return pm.handleShoot(id, tick, {
    yaw: 0,
    pitch: 0,
    clientTick: tick,
    origin: [0, 1.7, z],
  });
}

// ── off by default ──

Deno.test("zombots rules off: everyone armed, no armedMask/downed on the row", () => {
  const pm = makeManager();
  assertEquals(pm.getZombotsRules(), null);
  const p = pm.add("h1", "H", "A");
  for (const id of [WEAPON_PISTOL, WEAPON_RIFLE, WEAPON_SHOTGUN]) {
    assert(p.isWeaponArmed(id));
  }
  assertEquals(pm.armPlayer("h1", WEAPON_RIFLE), false);
  const snap = p.toSnapshot(TICK, "full", null, 0);
  assertEquals("armedMask" in snap, false);
  assertEquals("downed" in snap, false);
  // Cycling is the plain +1 walk.
  assert(p.tryCycleWeapon(TICK));
  assertEquals(p.weaponId, WEAPON_RIFLE);
});

Deno.test("zombots rules off: a killed human still respawns", () => {
  const pm = makeManager();
  const p = pm.add("h1", "H", "A");
  assert(p.takeDamage(500, "body", TICK, 0));
  assertEquals(p.downed, false);
  assert(p.shouldRespawn(TICK + RESPAWN_DELAY_TICKS));
});

// ── 12a armed set ──

Deno.test("armed set: players and bots join empty-handed", () => {
  const pm = makeManager(ALL_ON);
  const h = pm.add("h1", "H", "A");
  const z = pm.addBot("z1", "Z", { team: "B" });
  for (const p of [h, z]) {
    assertEquals(p.armedMask(), 0);
    assertEquals(p.toSnapshot(TICK, "motion", null, 0).armedMask, 0);
  }
});

Deno.test("armed set: unarmed fire, reload and switch are refused", () => {
  const pm = makeManager(ALL_ON);
  const h = pm.add("h1", "H", "A");
  place(h, 5);
  assertEquals(h.canShoot(TICK), false);
  assertEquals(shoot(pm, "h1", 5), null);
  // A half-empty pistol that gets taken away can't be reloaded.
  assert(pm.armPlayer("h1", WEAPON_PISTOL));
  const ready = TICK + WEAPON_SWITCH_TICKS + 1;
  assert(shoot(pm, "h1", 5, ready));
  assert(pm.setArmedWeapons("h1", []));
  assertEquals(pm.handleReload("h1", ready + 60), false);
  assertEquals(shoot(pm, "h1", 5, ready + 60), null);
  assertEquals(pm.handleWeaponSwitch("h1", WEAPON_RIFLE, ready + 60), false);
  assertEquals(pm.handleWeaponSwitch("h1", undefined, ready + 60), false);
  assertEquals(h.weaponId, WEAPON_PISTOL);
});

Deno.test("armed set: armPlayer draws the gun; cycling skips unarmed guns", () => {
  const pm = makeManager(ALL_ON);
  const h = pm.add("h1", "H", "A");
  place(h, 5);
  pm.update(TICK);
  assert(pm.armPlayer("h1", WEAPON_RIFLE));
  assertEquals(h.weaponId, WEAPON_RIFLE);
  assert(h.isSwitching(TICK));
  const ready = TICK + WEAPON_SWITCH_TICKS + 1;
  assert(h.canShoot(ready));
  // Only one gun: nothing to cycle to.
  assertEquals(h.tryCycleWeapon(ready), false);
  // Shotgun armed too: switches straight to shotgun; cycling visits shotgun → rifle → shotgun (pistol skipped).
  pm.update(ready);
  assert(pm.armPlayer("h1", WEAPON_SHOTGUN));
  assertEquals(h.weaponId, WEAPON_SHOTGUN);
  assert(h.isSwitching(ready));
  const afterShotgunDraw = ready + WEAPON_SWITCH_TICKS + 1;
  assert(h.tryCycleWeapon(afterShotgunDraw));
  assertEquals(h.weaponId, WEAPON_RIFLE);
  const later = afterShotgunDraw + WEAPON_SWITCH_TICKS + 1;
  assert(h.tryCycleWeapon(later));
  assertEquals(h.weaponId, WEAPON_SHOTGUN);
  assertEquals(
    h.toSnapshot(later, "full", null, 0).armedMask,
    (1 << WEAPON_RIFLE) | (1 << WEAPON_SHOTGUN),
  );
});

Deno.test("armed set: a rack refill replenishes spare mags without refilling current mag and switches to it", () => {
  const pm = makeManager(ALL_ON);
  const h = pm.add("h1", "H", "A");
  place(h, 5);
  pm.update(TICK);
  assert(pm.armPlayer("h1", WEAPON_PISTOL));
  const ready = TICK + WEAPON_SWITCH_TICKS + 1;
  const full = h.ammoInMag;
  const fullSpares = h.spareClips;
  assert(shoot(pm, "h1", 5, ready));
  assertEquals(h.ammoInMag, full - 1);
  // Spend one spare mag via reload, then fire one round from the fresh mag.
  assert(pm.handleReload("h1", ready + 1));
  const afterReload = ready + 1 + 200;
  pm.update(afterReload);
  assertEquals(h.spareClips, fullSpares - 1);
  assert(shoot(pm, "h1", 5, afterReload + 1));
  assertEquals(h.ammoInMag, full - 1);
  assertEquals(pm.refillPlayerAmmo("h1", WEAPON_RIFLE), false);
  // Refilling the equipped gun restores spare mags without refilling the current mag or starting a switch.
  pm.update(afterReload + 2);
  assert(pm.refillPlayerAmmo("h1", WEAPON_PISTOL));
  assertEquals(h.ammoInMag, full - 1);
  assertEquals(h.spareClips, fullSpares);
  assertEquals(h.isSwitching(afterReload + 2), false);
  // Arming rifle switches to rifle; refilling pistol switches back to pistol.
  assert(pm.armPlayer("h1", WEAPON_RIFLE));
  assertEquals(h.weaponId, WEAPON_RIFLE);
  const later = afterReload + 2 + WEAPON_SWITCH_TICKS + 1;
  pm.update(later);
  assert(pm.refillPlayerAmmo("h1", WEAPON_PISTOL));
  assertEquals(h.weaponId, WEAPON_PISTOL);
  assertEquals(h.ammoInMag, full - 1);
  assertEquals(h.spareClips, fullSpares);
  assert(h.isSwitching(later));
});

Deno.test("armed set: empty hands swing a fist with the override damage", () => {
  const pm = makeManager(ALL_ON);
  const z = pm.addBot("z1", "Zombie", { team: "B" });
  const h = pm.add("h1", "Human", "A");
  place(z, 2);
  place(h, 0);
  assertEquals(z.meleeDef, FIST_MELEE);
  assert(pm.setMeleeDamageOverride("z1", 20));
  const out = swing(pm, "z1", 2);
  assertExists(out);
  assertEquals(out.shot.melee, true);
  assertEquals(out.shot.hitId, "h1");
  // ±5 roll at sample 0.5 is the base itself.
  assertEquals(out.damages?.[0]?.damage, 20);
  assertEquals(h.health, MAX_HEALTH - 20);
});

Deno.test("zombie bite connects only when the body is on the target", () => {
  const reach = ZOMBOTS_TUNING.zombie.meleeRange;
  const pm = makeManager(ALL_ON);
  const z = pm.addBot("z1", "Zombie", { team: "B" });
  const h = pm.add("h1", "Human", "A");
  z.climbsWindows = true;
  assert(pm.setMeleeDamageOverride("z1", 20));

  place(z, reach + 0.4);
  place(h, 0);
  const far = swing(pm, "z1", reach + 0.4);
  assertExists(far);
  assertEquals(far.shot.melee, true);
  assertEquals(far.shot.hitId, null);
  assertEquals(far.damages, undefined);
  assertEquals(h.health, MAX_HEALTH);

  const later = TICK + 60;
  place(z, reach);
  place(h, 0);
  for (let t = later - 16; t <= later; t++) {
    z.recordPose(t);
    h.recordPose(t);
  }
  const onTop = swing(pm, "z1", reach, later);
  assertExists(onTop?.damages);
  assertEquals(onTop!.shot.hitId, "h1");
  assertEquals(onTop!.damages![0]!.damage, 20);
});

Deno.test("armed set: an armed rifle still has no swing (it zooms)", () => {
  const pm = makeManager(ALL_ON);
  const h = pm.add("h1", "H", "A");
  place(h, 2);
  assert(pm.armPlayer("h1", WEAPON_RIFLE));
  assertEquals(h.meleeDef, undefined);
  assertEquals(h.canMelee(TICK + WEAPON_SWITCH_TICKS + 1), false);
});

Deno.test("pass-through: a zombie's swing goes through the zombie in front", () => {
  const pm = makeManager(ALL_ON);
  const back = pm.addBot("z1", "Back", { team: "B" });
  const front = pm.addBot("z2", "Front", { team: "B" });
  const h = pm.add("h1", "Human", "A");
  place(back, 2.4);
  place(front, 1.2);
  place(h, 0);
  const out = swing(pm, "z1", 2.4);
  assertExists(out);
  assertEquals(out.shot.hitId, "h1");
  assertEquals(front.health, MAX_HEALTH);
  assertEquals(back.health, MAX_HEALTH);
});

Deno.test("pass-through off: the same swing hits the zombie in front", () => {
  const pm = makeManager({ ...ALL_ON, teammatesPassThrough: false });
  const back = pm.addBot("z1", "Back", { team: "B" });
  const front = pm.addBot("z2", "Front", { team: "B" });
  const h = pm.add("h1", "Human", "A");
  place(back, 2.4);
  place(front, 1.2);
  place(h, 0);
  assertEquals(swing(pm, "z1", 2.4)?.shot.hitId, "z2");
});

// ── 12b downed ──

Deno.test("downed: a human at 0 HP is downed, never respawns, takes no input", () => {
  const pm = makeManager(ALL_ON);
  const h = pm.add("h1", "H", "A");
  place(h, 0);
  assert(h.takeDamage(500, "body", TICK, 0));
  assertEquals(h.alive, false);
  assert(h.downed);
  assert(pm.isDowned("h1"));
  assertEquals(h.shouldRespawn(TICK + 100_000), false);
  assertEquals(pm.processRespawns(TICK + 100_000).length, 0);
  assertEquals(h.canMelee(TICK + 100), false);
  assertEquals(pm.handleWeaponSwitch("h1", undefined, TICK + 100), false);
  const snap = h.toSnapshot(TICK, "motion", null, 0);
  assertEquals(snap.downed, true);
  assertEquals(snap.alive, false);
  // Already at 0: more hits change nothing.
  assertEquals(h.takeDamage(50, "body", TICK + 1, 0), false);
});

Deno.test("downed: bots still die normally", () => {
  const pm = makeManager(ALL_ON);
  const z = pm.addBot("z1", "Z", { team: "B" });
  assert(z.takeDamage(500, "body", TICK, 0));
  assertEquals(z.downed, false);
  assert(z.shouldRespawn(TICK + RESPAWN_DELAY_TICKS));
});

Deno.test("downed: revive stands them up in place at the fraction of max HP", () => {
  const pm = makeManager(ALL_ON);
  const h = pm.add("h1", "H", "A");
  place(h, 3);
  h.takeDamage(500, "body", TICK, 0);
  assertEquals(pm.revivePlayer("h1", 0.5, 0)?.id, "h1");
  assert(h.alive);
  assertEquals(h.downed, false);
  assertEquals(h.health, Math.round(MAX_HEALTH * 0.5));
  assertEquals(h.z, 3);
  assertEquals("downed" in h.toSnapshot(TICK, "motion", null, 0), false);
  // Standing players can't be revived.
  assertEquals(pm.revivePlayer("h1", 1, 0), null);
});

Deno.test("downed: a zombie swing at a downed body passes through it", () => {
  const pm = makeManager(ALL_ON);
  const z = pm.addBot("z1", "Z", { team: "B" });
  const h = pm.add("h1", "H", "A");
  place(z, 2);
  place(h, 0);
  h.takeDamage(500, "body", TICK - 20, 0);
  assertEquals(swing(pm, "z1", 2)?.shot.hitId, null);
});

Deno.test("downed: downedBodyInSight finds the body in reach only", () => {
  const pm = makeManager(ALL_ON);
  const helper = pm.add("h1", "Helper", "A");
  const down = pm.add("h2", "Down", "A");
  place(down, 0);
  down.takeDamage(500, "body", TICK, 0);
  place(helper, 1.5);
  pm.update(TICK);
  assertEquals(pm.downedBodyInSight("h1", 2), "h2");
  helper.z = 5;
  assertEquals(pm.downedBodyInSight("h1", 2), null);
  helper.z = 1.5;
  helper.yaw = Math.PI;
  assertEquals(pm.downedBodyInSight("h1", 2), null);
});

Deno.test("downed: think frame carries isDowned to the engine Player", () => {
  const pm = makeManager(ALL_ON);
  const h = pm.add("h1", "H", "A");
  const standing = pm.add("h2", "S", "A");
  h.takeDamage(500, "body", TICK, 0);
  const collision = new MapCollision(miniMap);
  const frame = buildThinkFrame({
    tick: TICK,
    simDelta: 1,
    collision,
    players: [h, standing],
    doorsOpen: true,
    doorChangeTick: null,
    teamScoreA: 0,
    teamScoreB: 0,
  });
  const rows = new Map(frame.players.map((row) => [row.id, row]));
  assertEquals(rows.get("h1")?.isDowned, true);
  assertEquals("isDowned" in rows.get("h2")!, false);
  assertEquals(runtimePlayer(rows.get("h1")!).isDowned, true);
  assertEquals("isDowned" in runtimePlayer(rows.get("h2")!), false);
});

Deno.test("setZombotsRules: turns rules on and off for players already in", () => {
  const pm = makeManager();
  const h = pm.add("h1", "H", "A");
  pm.setZombotsRules(ALL_ON);
  assertEquals(h.armedMask(), 0);
  assert(h.downOnDeath);
  pm.setZombotsRules(null);
  assertEquals(h.getArmedWeapons(), null);
  assertEquals(h.downOnDeath, false);
});

Deno.test("zombotsState round-trips through restoreZombotsState", () => {
  const pm = makeManager(ALL_ON);
  const h = pm.add("h1", "H", "A");
  pm.armPlayer("h1", WEAPON_SHOTGUN);
  pm.setMeleeDamageOverride("h1", 33);
  h.takeDamage(500, "body", TICK, 0);
  const saved = h.zombotsState();
  const fresh = makeManager().add("h1", "H", "A");
  fresh.restoreZombotsState(saved);
  assertEquals(fresh.zombotsState(), saved);
});
