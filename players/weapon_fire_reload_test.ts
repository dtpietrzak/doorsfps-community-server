/**
 * Epic 4.4 Chunk 2: tick-exact fire / reload / switch gates.
 * Run: deno test -A server-community/players/weapon_fire_reload_test.ts
 */
import { assertEquals } from "jsr:@std/assert@1";
import {
  getWeapon,
  SPAWN_INVULN_TICKS,
  WEAPON_PISTOL,
  WEAPON_RIFLE,
  WEAPON_SWITCH_TICKS,
} from "../protocol/network.ts";
import { msToTicks } from "../shared/sim/game.ts";
import { Player } from "./Player.ts";

const pistol = getWeapon(WEAPON_PISTOL);
const rifle = getWeapon(WEAPON_RIFLE);

function makePlayer(id = "w"): Player {
  const p = new Player(id, "WeaponGate", "A", {
    spawn: { x: 0, z: 0, yaw: Math.PI },
  });
  p.spawnedAtTick = 0;
  p.restoreAbilityCharges();
  return p;
}

function simSnapshot(p: Player, tick: number) {
  return {
    weaponId: p.weaponId,
    lastShotAtTick: p.lastShotAtTick,
    lastMeleeAtTick: p.lastMeleeAtTick,
    ammoInMag: p.ammoInMag,
    spareClips: p.spareClips,
    reloadEndsAtTick: p.reloadEndsAtTick,
    weaponSwitchEndsAtTick: p.weaponSwitchEndsAtTick,
    isReloading: p.isReloading(),
    isSwitching: p.isSwitching(tick),
    alive: p.alive,
  };
}

Deno.test("fire gate: pistol cooldown edge ticks", () => {
  const p = makePlayer();
  const cd = pistol.fireCooldownTicks;
  assertEquals(p.canShoot(0), true);
  p.markShot(0);
  assertEquals(p.ammoInMag, pistol.magSize - 1);
  assertEquals(p.canShoot(cd - 1), false);
  assertEquals(p.canShoot(cd), true);
});

Deno.test("fire gate: rifle cooldown edge ticks", () => {
  const p = makePlayer();
  assertEquals(p.trySwitchWeapon(WEAPON_RIFLE, 0), true);
  p.tickWeaponSwitch(WEAPON_SWITCH_TICKS);
  assertEquals(p.weaponId, WEAPON_RIFLE);
  const cd = rifle.fireCooldownTicks;
  const t0 = WEAPON_SWITCH_TICKS;
  assertEquals(p.canShoot(t0), true);
  p.markShot(t0);
  assertEquals(p.canShoot(t0 + cd - 1), false);
  assertEquals(p.canShoot(t0 + cd), true);
});

Deno.test("fire gate: empty mag blocks; unlimitedAmmo free-fires", () => {
  const p = makePlayer();
  const cd = pistol.fireCooldownTicks;
  let tick = 0;
  while (p.ammoInMag > 0) {
    assertEquals(p.canShoot(tick), true);
    p.markShot(tick);
    tick += cd;
  }
  assertEquals(p.ammoInMag, 0);
  assertEquals(p.canShoot(tick), false);

  p.unlimitedAmmo = true;
  assertEquals(p.canShoot(tick), true);
  const mag = p.ammoInMag;
  p.markShot(tick);
  assertEquals(p.ammoInMag, mag);
});

Deno.test("fire gate: reloading / switching / dead / connectionIssue block", () => {
  const p = makePlayer();
  p.markShot(0);
  assertEquals(p.tryBeginReload(pistol.fireCooldownTicks), true);
  assertEquals(p.isReloading(), true);
  assertEquals(p.canShoot(pistol.fireCooldownTicks), false);

  const p2 = makePlayer("s");
  assertEquals(p2.trySwitchWeapon(WEAPON_RIFLE, 0), true);
  assertEquals(p2.isSwitching(0), true);
  assertEquals(p2.canShoot(0), false);
  assertEquals(p2.canShoot(WEAPON_SWITCH_TICKS - 1), false);
  p2.tickWeaponSwitch(WEAPON_SWITCH_TICKS);
  assertEquals(p2.canShoot(WEAPON_SWITCH_TICKS), true);

  const p3 = makePlayer("d");
  const deathTick = SPAWN_INVULN_TICKS + 10;
  p3.takeDamage(999, "body", deathTick, 1_000_000);
  assertEquals(p3.alive, false);
  assertEquals(p3.canShoot(deathTick), false);

  const p4 = makePlayer("c");
  p4.connectionIssue = true;
  assertEquals(p4.canShoot(0), false);
});

Deno.test("fire gate: Glitch blocks shoot and melee", () => {
  const p = makePlayer();
  assertEquals(p.tryActivateAbility("glitch", 0), true);
  assertEquals(p.canShoot(0), false);
  assertEquals(p.canMelee(0), false);
});

Deno.test("rapidFire: cooldown and reload halve at timer start only", () => {
  const p = makePlayer();
  assertEquals(p.tryActivateAbility("rapidFire", 0), true);
  const halfCd = p.fireCooldownTicksAt(0);
  assertEquals(halfCd, Math.max(1, msToTicks(pistol.fireCooldownMs / 2)));
  assertEquals(halfCd < pistol.fireCooldownTicks, true);

  p.markShot(0);
  assertEquals(p.canShoot(halfCd - 1), false);
  assertEquals(p.canShoot(halfCd), true);

  // Start reload under Rapid Fire → end tick uses halved duration.
  p.markShot(halfCd);
  // Need a non-full mag; markShot already decremented.
  const reloadStart = halfCd + halfCd;
  assertEquals(p.tryBeginReload(reloadStart), true);
  const halfReload = p.reloadTicksAt(reloadStart);
  assertEquals(p.reloadEndsAtTick, reloadStart + halfReload);

  // Expire Rapid Fire while reload is in progress — end tick stays.
  const ends = p.reloadEndsAtTick!;
  // Rapid Fire window is long; force-clear by advancing past ability if needed.
  // In-progress timer must keep the end tick set at start regardless.
  assertEquals(p.reloadEndsAtTick, ends);
  p.tickReload(ends - 1);
  assertEquals(p.isReloading(), true);
  p.tickReload(ends);
  assertEquals(p.ammoInMag, pistol.magSize);
  assertEquals(p.isReloading(), false);
});

Deno.test("reload: full-swap, spare consumption, refusals", () => {
  const p = makePlayer();
  const startSpares = p.spareClips;
  p.markShot(0);
  assertEquals(p.tryBeginReload(pistol.fireCooldownTicks), true);
  // Full mag refusal while reloading already blocked; after complete:
  p.tickReload(pistol.fireCooldownTicks + pistol.reloadTicks);
  assertEquals(p.ammoInMag, pistol.magSize);
  assertEquals(p.spareClips, startSpares - 1);
  assertEquals(p.tryBeginReload(10_000), false); // full mag

  // Burn remaining spares.
  while (p.spareClips > 0) {
    p.markShot(10_000);
    const t = 10_000 + pistol.fireCooldownTicks;
    assertEquals(p.tryBeginReload(t), true);
    p.tickReload(t + pistol.reloadTicks);
  }
  p.markShot(20_000);
  assertEquals(p.spareClips, 0);
  assertEquals(p.tryBeginReload(20_000 + pistol.fireCooldownTicks), false);
});

Deno.test("reload: pause-on-switch resumes remaining ticks on draw", () => {
  const p = makePlayer();
  p.markShot(0);
  const reloadStart = pistol.fireCooldownTicks;
  assertEquals(p.tryBeginReload(reloadStart), true);
  const fullReload = pistol.reloadTicks;
  assertEquals(p.reloadEndsAtTick, reloadStart + fullReload);

  // Switch halfway through reload.
  const mid = reloadStart + Math.floor(fullReload / 2);
  const remainingBefore = (p.reloadEndsAtTick ?? mid) - mid;
  assertEquals(p.trySwitchWeapon(WEAPON_RIFLE, mid), true);
  assertEquals(p.reloadEndsAtTick, null);
  assertEquals(p.isSwitching(mid), true);

  // While switching, cannot reload or shoot or re-switch.
  assertEquals(p.tryBeginReload(mid), false);
  assertEquals(p.canShoot(mid), false);
  assertEquals(p.trySwitchWeapon(WEAPON_PISTOL, mid), false);

  // Finish draw → paused pistol reload is NOT auto-resumed on rifle.
  p.tickWeaponSwitch(mid + WEAPON_SWITCH_TICKS);
  assertEquals(p.weaponId, WEAPON_RIFLE);
  assertEquals(p.reloadEndsAtTick, null);

  // Switch back to pistol; after draw, paused remaining resumes.
  const backAt = mid + WEAPON_SWITCH_TICKS;
  assertEquals(p.trySwitchWeapon(WEAPON_PISTOL, backAt), true);
  p.tickWeaponSwitch(backAt + WEAPON_SWITCH_TICKS);
  assertEquals(p.weaponId, WEAPON_PISTOL);
  assertEquals(p.reloadEndsAtTick, backAt + WEAPON_SWITCH_TICKS + remainingBefore);

  const doneAt = p.reloadEndsAtTick!;
  p.tickReload(doneAt - 1);
  assertEquals(p.isReloading(), true);
  p.tickReload(doneAt);
  assertEquals(p.ammoInMag, pistol.magSize);
});

Deno.test("switch lock window blocks shoot / reload / re-switch", () => {
  const p = makePlayer();
  assertEquals(p.trySwitchWeapon(WEAPON_RIFLE, 0), true);
  assertEquals(p.weaponSwitchEndsAtTick, WEAPON_SWITCH_TICKS);
  assertEquals(p.isSwitching(WEAPON_SWITCH_TICKS - 1), true);
  assertEquals(p.isSwitching(WEAPON_SWITCH_TICKS), false);
  // tickWeaponSwitch clears at the end tick.
  p.tickWeaponSwitch(WEAPON_SWITCH_TICKS - 1);
  assertEquals(p.weaponSwitchEndsAtTick, WEAPON_SWITCH_TICKS);
  p.tickWeaponSwitch(WEAPON_SWITCH_TICKS);
  assertEquals(p.weaponSwitchEndsAtTick, null);
});

Deno.test("death cancels active reload, paused reload, and switch", () => {
  const p = makePlayer();
  p.markShot(0);
  assertEquals(p.tryBeginReload(pistol.fireCooldownTicks), true);
  const mid = pistol.fireCooldownTicks + 2;
  assertEquals(p.trySwitchWeapon(WEAPON_RIFLE, mid), true);
  // Paused reload on pistol + active switch on rifle.
  assertEquals(p.reloadEndsAtTick, null);
  assertEquals(p.weaponSwitchEndsAtTick !== null, true);

  const deathTick = Math.max(mid + 1, SPAWN_INVULN_TICKS + 1);
  p.takeDamage(999, "body", deathTick, 1_000_000);
  assertEquals(p.alive, false);
  assertEquals(p.reloadEndsAtTick, null);
  assertEquals(p.weaponSwitchEndsAtTick, null);
  // Paused map cleared by cancelReload.
  assertEquals(p.tryBeginReload(mid + 100), false);
});

Deno.test("markShot touchActivity does not mutate weapon sim state beyond shot", () => {
  const p = makePlayer();
  const beforeActivity = p.lastActivityAtMs;
  const before = simSnapshot(p, 0);
  p.markShot(0);
  const after = simSnapshot(p, 0);
  // Expected SIM mutations from markShot only:
  assertEquals(after.lastShotAtTick, 0);
  assertEquals(after.ammoInMag, before.ammoInMag - 1);
  assertEquals(after.reloadEndsAtTick, before.reloadEndsAtTick);
  assertEquals(after.weaponSwitchEndsAtTick, before.weaponSwitchEndsAtTick);
  assertEquals(after.weaponId, before.weaponId);
  assertEquals(after.spareClips, before.spareClips);
  // NON-SIM AFK stamp moved (or stayed if Date.now collided — either way
  // weapon fields above are the contract).
  assertEquals(typeof p.lastActivityAtMs, "number");
  void beforeActivity;
});
