/**
 * Shotgun PR 4: server shell reload + pump (notes/shotgun.md).
 * The shotgun isn't in WEAPON_ORDER / isWeaponId yet (PR 8), so tests equip
 * it by setting `weaponId` directly (every defined weapon has a loadout slot)
 * and simulate a draw by setting `weaponSwitchEndsAtTick`.
 * Run: deno test -A server-community/players/shotgun_shell_reload_test.ts
 */
import { assert, assertEquals, assertExists } from "jsr:@std/assert@1";
import {
  getWeapon,
  WEAPON_PISTOL,
  WEAPON_SHOTGUN,
  WEAPON_SWITCH_TICKS,
} from "../protocol/network.ts";
import { msToTicks } from "../shared/sim/game.ts";
import {
  RAPID_FIRE_BONUS_SHELLS,
  SHOTGUN,
  shellReloadOf,
} from "../shared/sim/weapons.ts";
import { Player } from "./Player.ts";
import { PlayerManager } from "./PlayerManager.ts";
import type { DoorsMap } from "../world/map.ts";
import { MapCollision } from "../world/MapCollision.ts";
import { captureCheckpointState } from "../replay/authoritativeCheckpoint.ts";

const shotgun = getWeapon(WEAPON_SHOTGUN);
const shell = shellReloadOf(SHOTGUN)!;
const START = msToTicks(shell.startMs);
const PER_SHELL = msToTicks(shell.perShellMs);
const PUMP = msToTicks(shell.pumpMs);
const COOLDOWN = shotgun.fireCooldownTicks;
const TUBE = shotgun.magSize;

function makePlayer(id = "sg"): Player {
  const p = new Player(id, "Shotgun", "A", {
    spawn: { x: 0, z: 0, yaw: Math.PI },
  });
  p.spawnedAtTick = 0;
  p.restoreAbilityCharges();
  p.weaponId = WEAPON_SHOTGUN;
  return p;
}

/** Run the per-tick weapon timers the way `Player.update` does. */
function step(p: Player, from: number, to: number): void {
  for (let t = from; t <= to; t++) {
    p.tickWeaponSwitch(t);
    p.tickReload(t);
    p.tickPump(t);
  }
}

/** Fire, then wait out the full cooldown (pump included). Returns next tick. */
function fireAndCycle(p: Player, tick: number): number {
  assert(p.canShoot(tick), `can shoot at ${tick}`);
  p.markShot(tick);
  step(p, tick + 1, tick + COOLDOWN);
  return tick + COOLDOWN;
}

Deno.test("shotgun spawns with a full cocked tube and spare shells", () => {
  const p = makePlayer();
  assertEquals(p.ammoInMag, TUBE);
  assertEquals(p.spareClips, shell.spareShells);
  assertEquals(p.chambered, true);
  assertEquals(p.isPumping(), false);
});

Deno.test("every shot pumps: fire is refused until the pump finishes", () => {
  const p = makePlayer();
  assertEquals(PUMP < COOLDOWN, true, "pump sits inside the fire cooldown");
  p.markShot(0);
  assertEquals(p.ammoInMag, TUBE - 1);
  assertEquals(p.chambered, false);
  assertEquals(p.isPumping(), true);
  step(p, 1, PUMP - 1);
  assertEquals(p.isPumping(), true);
  step(p, PUMP, PUMP);
  assertEquals(p.isPumping(), false);
  assertEquals(p.chambered, true);
  // Pumped, but the overall cooldown still gates.
  assertEquals(p.canShoot(COOLDOWN - 1), false);
  step(p, PUMP + 1, COOLDOWN);
  assertEquals(p.canShoot(COOLDOWN), true);
});

Deno.test("firing before the pump finishes is refused even past cooldown", () => {
  const p = makePlayer();
  p.markShot(0);
  // Cooldown elapsed, but the pump never ran (no ticks stepped).
  assertEquals(p.canShoot(COOLDOWN), false);
  step(p, 1, COOLDOWN);
  assertEquals(p.canShoot(COOLDOWN), true);
});

Deno.test("reload loads shell by shell and ends with a pump", () => {
  const p = makePlayer();
  let t = fireAndCycle(p, 0);
  t = fireAndCycle(p, t);
  assertEquals(p.ammoInMag, TUBE - 2);
  const spare0 = p.spareClips;

  const r0 = t;
  assertEquals(p.tryBeginReload(r0), true);
  assertEquals(p.isReloading(), true);
  assertEquals(p.canShoot(r0), false);
  const first = r0 + START + PER_SHELL;
  step(p, r0 + 1, first - 1);
  assertEquals(p.ammoInMag, TUBE - 2, "nothing before open + one shell");
  step(p, first, first);
  assertEquals(p.ammoInMag, TUBE - 1);
  assertEquals(p.spareClips, spare0 - 1);
  assertEquals(p.isReloading(), true);

  const second = first + PER_SHELL;
  step(p, first + 1, second);
  assertEquals(p.ammoInMag, TUBE, "tube full");
  assertEquals(p.spareClips, spare0 - 2);
  assertEquals(p.isReloading(), false, "stops by itself when full");
  assertEquals(p.isPumping(), true, "every reload ends cocked via a pump");
  assertEquals(p.canShoot(second + PUMP - 1), false);
  step(p, second + 1, second + PUMP);
  assertEquals(p.chambered, true);
  assertEquals(p.canShoot(second + PUMP), true);
});

Deno.test("full tube or no spares: reload refused", () => {
  const p = makePlayer();
  assertEquals(p.tryBeginReload(0), false, "tube already full");
  const t = fireAndCycle(p, 0);
  setShotgunSlot(p, { spareClips: 0 });
  assertEquals(p.tryBeginReload(t), false, "no spare shells");
});

Deno.test("running out of spares partway ends the reload with a pump", () => {
  const p = makePlayer();
  let t = 0;
  for (let i = 0; i < 3; i++) t = fireAndCycle(p, t);
  assertEquals(p.ammoInMag, TUBE - 3);
  // Leave exactly one spare shell.
  setShotgunSlot(p, { spareClips: 1 });
  assertEquals(p.spareClips, 1);

  assertEquals(p.tryBeginReload(t), true);
  const first = t + START + PER_SHELL;
  step(p, t + 1, first);
  assertEquals(p.ammoInMag, TUBE - 2);
  assertEquals(p.spareClips, 0);
  assertEquals(p.isReloading(), false);
  assertEquals(p.isPumping(), true);
  step(p, first + 1, first + PUMP);
  assertEquals(p.canShoot(first + PUMP), true);
});

Deno.test("unlimitedAmmo loads without spending spares", () => {
  const p = makePlayer();
  p.unlimitedAmmo = true;
  // Free ammo: shots do not use the tube, so drop it by hand.
  setShotgunSlot(p, { ammoInMag: 3 });
  const spare = p.spareClips;
  assertEquals(p.tryBeginReload(0), true);
  step(p, 1, START + 2 * PER_SHELL);
  assertEquals(p.ammoInMag, TUBE);
  assertEquals(p.spareClips, spare);
});

Deno.test("interrupt: first press only cocks, a second press after the pump fires", () => {
  const p = makePlayer();
  let t = 0;
  for (let i = 0; i < 4; i++) t = fireAndCycle(p, t);
  assertEquals(p.ammoInMag, 1);

  assertEquals(p.tryBeginReload(t), true);
  const first = t + START + PER_SHELL;
  step(p, t + 1, first);
  assertEquals(p.ammoInMag, 2, "2/5 loaded");

  const press = first + 3;
  step(p, first + 1, press);
  assertEquals(p.canShoot(press), false, "loading blocks fire");
  assertEquals(p.tryInterruptShellReload(press), true);
  assertEquals(p.ammoInMag, 2, "loaded shells stay, no shot fired");
  assertEquals(p.isReloading(), false);
  assertEquals(p.isPumping(), true);
  assertEquals(p.tryInterruptShellReload(press + 1), false, "nothing to interrupt");

  // A press during the pump is dropped (canShoot false, no buffer).
  assertEquals(p.canShoot(press + PUMP - 1), false);
  step(p, press + 1, press + PUMP - 1);
  step(p, press + PUMP, press + PUMP);
  assertEquals(p.canShoot(press + PUMP), true);
  p.markShot(press + PUMP);
  assertEquals(p.ammoInMag, 1);
  // No more shells arrive after the interrupt.
  step(p, press + PUMP + 1, press + PUMP + 10 * PER_SHELL);
  assertEquals(p.ammoInMag, 1);
});

Deno.test("switch mid-load keeps loaded shells; unchambered gun pumps on draw", () => {
  const p = makePlayer();
  let t = fireAndCycle(p, 0);
  t = fireAndCycle(p, t);
  t = fireAndCycle(p, t);
  assertEquals(p.tryBeginReload(t), true);
  const first = t + START + PER_SHELL;
  step(p, t + 1, first);
  assertEquals(p.ammoInMag, TUBE - 2);

  // Holster mid-load: loading stops, loaded shell kept, no paused reload.
  const sw = first + 2;
  assertEquals(p.trySwitchWeapon(WEAPON_PISTOL, sw), true);
  assertEquals(p.isReloading(), false);
  assertEquals(p.ammoInMagFor(WEAPON_SHOTGUN), TUBE - 2);
  step(p, sw + 1, sw + WEAPON_SWITCH_TICKS + 3 * PER_SHELL);
  assertEquals(p.ammoInMagFor(WEAPON_SHOTGUN), TUBE - 2);
  assertEquals(p.snapshotPausedReloadRemainingTicks(), {});

  // Shotgun was cocked when holstered (the post-shot pumps finished).
  assertEquals(p.chamberedFor(WEAPON_SHOTGUN), true);
  const back = sw + WEAPON_SWITCH_TICKS + 3 * PER_SHELL + 1;
  drawShotgun(p, back);
  const drawn = back + WEAPON_SWITCH_TICKS;
  step(p, back, drawn);
  assertEquals(p.isPumping(), false, "cocked gun needs no pump on draw");
  assertEquals(p.isReloading(), false, "loading does not resume");
  assertEquals(p.canShoot(drawn), true);
});

Deno.test("holstering mid-pump leaves it unchambered; the pump plays after the draw", () => {
  const p = makePlayer();
  p.markShot(0);
  step(p, 1, 2);
  assertEquals(p.isPumping(), true);
  assertEquals(p.trySwitchWeapon(WEAPON_PISTOL, 3), true);
  assertEquals(p.isPumping(), false);
  assertEquals(p.chamberedFor(WEAPON_SHOTGUN), false);
  // Pistol is unaffected.
  step(p, 4, 3 + WEAPON_SWITCH_TICKS);
  assertEquals(p.canShoot(3 + WEAPON_SWITCH_TICKS), true);

  const back = 3 + WEAPON_SWITCH_TICKS + 1;
  drawShotgun(p, back);
  const drawn = back + WEAPON_SWITCH_TICKS;
  step(p, back, drawn);
  assertEquals(p.isPumping(), true);
  assertEquals(p.canShoot(drawn + PUMP - 1), false);
  step(p, drawn + 1, drawn + PUMP);
  assertEquals(p.chambered, true);
  assertEquals(p.canShoot(drawn + PUMP), true);
});

Deno.test("reload during a post-shot pump replaces it; the reload still ends cocked", () => {
  const p = makePlayer();
  p.markShot(0);
  assertEquals(p.tryBeginReload(1), true);
  assertEquals(p.isPumping(), false);
  const first = 1 + START + PER_SHELL;
  step(p, 2, first);
  assertEquals(p.ammoInMag, TUBE);
  assertEquals(p.isPumping(), true);
  step(p, first + 1, first + PUMP);
  assertEquals(p.chambered, true);
});

Deno.test("Rapid Fire halves open / per-shell / pump timers started under the buff", () => {
  const p = makePlayer();
  const half = (ms: number) => Math.max(1, msToTicks(ms / 2));
  p.abilityEndsAtTick.rapidFire = 1_000_000;
  p.markShot(0);
  step(p, 1, half(shell.pumpMs) - 1);
  assertEquals(p.isPumping(), true);
  step(p, half(shell.pumpMs), half(shell.pumpMs));
  assertEquals(p.isPumping(), false);

  const t = 100;
  assertEquals(p.tryBeginReload(t), true);
  const first = t + half(shell.startMs) + half(shell.perShellMs);
  step(p, t + 1, first - 1);
  assertEquals(p.ammoInMag, TUBE - 1);
  step(p, first, first);
  assertEquals(p.ammoInMag, TUBE);
  assertEquals(p.pumpEndsAtTick, first + half(shell.pumpMs));
});

Deno.test("Rapid Fire grants +5 spare shells on a shell gun", () => {
  const p = makePlayer();
  const spare = p.spareClips;
  assertEquals(p.tryActivateAbility("rapidFire", 0), true);
  assertEquals(RAPID_FIRE_BONUS_SHELLS, 5);
  assertEquals(p.spareClips, spare + 5);
});

Deno.test("dry fire with an empty tube: refused, no pump", () => {
  const p = makePlayer();
  let t = 0;
  for (let i = 0; i < TUBE; i++) t = fireAndCycle(p, t);
  assertEquals(p.ammoInMag, 0);
  assertEquals(p.chambered, true);
  assertEquals(p.canShoot(t), false);
  assertEquals(p.isPumping(), false);
});

Deno.test("death and respawn clear shell timers and restore a cocked tube", () => {
  const p = makePlayer();
  p.markShot(0);
  assertEquals(p.tryBeginReload(1), true);
  p.cancelReload();
  assertEquals(p.isReloading(), false);
  assertEquals(p.isPumping(), false);
  p.restoreLoadouts();
  assertEquals(p.ammoInMag, TUBE);
  assertEquals(p.chambered, true);
  assertEquals(p.spareClips, shell.spareShells);
});

Deno.test("mag guns never pump", () => {
  const p = makePlayer();
  p.weaponId = WEAPON_PISTOL;
  p.markShot(0);
  assertEquals(p.isPumping(), false);
  assertEquals(p.chambered, true);
  assertEquals(p.canShoot(getWeapon(WEAPON_PISTOL).fireCooldownTicks), true);
});

// ── PlayerManager: shoot packets ──

function testMap(): DoorsMap {
  return {
    name: "shotgun-reload-test",
    version: 1,
    bounds: { minX: -100, maxX: 100, minZ: -100, maxZ: 100 },
    gridSize: 1,
    walls: [],
    teamA: { corners: [0, 1], edge: "south", doorHalfWidth: 2, spawnRadius: 4 },
    teamB: { corners: [2, 3], edge: "north", doorHalfWidth: 2, spawnRadius: 4 },
  };
}

Deno.test("manager: the interrupting shoot packet never fires; the next press after the pump does", () => {
  const players = new PlayerManager(new MapCollision(testMap()), {
    damageRandom: () => 0.5,
  });
  const s = players.add("s", "S", "A");
  s.weaponId = WEAPON_SHOTGUN;
  const packet = { yaw: 0, pitch: 0 };
  let t = 10;
  for (let i = 0; i < 3; i++) {
    assertExists(players.handleShoot(s.id, t, packet));
    step(s, t + 1, t + COOLDOWN);
    t += COOLDOWN;
  }
  assertEquals(s.ammoInMag, 2);
  assertEquals(players.handleReload(s.id, t), true);
  const first = t + START + PER_SHELL;
  step(s, t + 1, first + PER_SHELL);
  assertEquals(s.ammoInMag, 4);

  const press = first + PER_SHELL + 1;
  assertEquals(players.handleShoot(s.id, press, packet), null, "interrupt only");
  assertEquals(s.ammoInMag, 4);
  assertEquals(s.isPumping(), true);
  // Held trigger / a press during the pump: dropped.
  assertEquals(players.handleShoot(s.id, press + 1, packet), null);
  assertEquals(s.ammoInMag, 4);
  step(s, press + 1, press + PUMP);
  const shot = players.handleShoot(s.id, press + PUMP, packet);
  assertExists(shot);
  assertEquals(shot.shot.pellets?.length, SHOTGUN.pellets);
  assertEquals(s.ammoInMag, 3);
});

// ── Snapshot / checkpoint surface ──

/** `players.add` queues a join event; these captures run outside a tick. */
const PENDING_OK = { allowPendingEvents: true } as const;

Deno.test("snapshot: pumping flag while cocking", () => {
  const p = makePlayer();
  assertEquals(p.toSnapshot(0).pumping, undefined);
  p.markShot(0);
  assertEquals(p.toSnapshot(1).pumping, true);
  step(p, 1, PUMP);
  assertEquals(p.toSnapshot(PUMP).pumping, undefined);
});

Deno.test("checkpoint: shell timers + chambered round-trip; shotgun slot in the order", () => {
  const players = new PlayerManager(new MapCollision(testMap()), {
    damageRandom: () => 0.5,
  });
  const a = players.add("a", "A", "A");
  const plain = captureCheckpointState(players, 1, "m1", undefined, PENDING_OK).players[0]!;
  assertEquals("shellReloadNextAtTick" in plain, false);
  assertEquals("pumpEndsAtTick" in plain, false);
  assertEquals(plain.weaponLoadouts.length, 3);
  for (const slot of plain.weaponLoadouts) {
    if (slot.weaponId === WEAPON_SHOTGUN) {
      assertEquals(slot.chambered, true);
    } else {
      assertEquals("chambered" in slot, false, "mag guns carry no chambered");
    }
  }

  a.weaponId = WEAPON_SHOTGUN;
  a.markShot(2);
  assertEquals(a.tryBeginReload(3), true);
  const cp = captureCheckpointState(players, 3, "m1", undefined, PENDING_OK).players[0]!;
  assertEquals(cp.shellReloadNextAtTick, a.shellReloadNextAtTick);
  assertEquals(cp.pumpEndsAtTick, undefined);

  // The shotgun slot rides the checkpoint now (no hand-added row).
  const b = new Player("b", "B", "A");
  b.restoreFromCheckpoint(cp);
  assertEquals(b.weaponId, WEAPON_SHOTGUN);
  assertEquals(b.shellReloadNextAtTick, a.shellReloadNextAtTick);
  assertEquals(b.pumpEndsAtTick, null);
  assertEquals(b.ammoInMag, 4);
  assertEquals(b.chambered, false);
  // Pre-shotgun rows (no `chambered`) restore as cocked.
  const c = new Player("c", "C", "A");
  c.restoreFromCheckpoint({
    ...plain,
    weaponLoadouts: plain.weaponLoadouts.filter(
      (slot) => slot.weaponId !== WEAPON_SHOTGUN,
    ),
  });
  assertEquals(c.chamberedFor(WEAPON_PISTOL), true);
  assertEquals(c.shellReloadNextAtTick, null);
});

/** Test-only: overwrite the shotgun slot's ammo (no public setter). */
function setShotgunSlot(
  p: Player,
  next: { ammoInMag?: number; spareClips?: number },
): void {
  const slot = (p as unknown as {
    loadouts: Record<number, { ammoInMag: number; spareClips: number }>;
  }).loadouts[WEAPON_SHOTGUN]!;
  if (next.ammoInMag != null) slot.ammoInMag = next.ammoInMag;
  if (next.spareClips != null) slot.spareClips = next.spareClips;
}

/** Equip the shotgun directly (bypasses the switch timer). */
function drawShotgun(p: Player, tick: number): void {
  p.weaponId = WEAPON_SHOTGUN;
  p.weaponSwitchEndsAtTick = tick + WEAPON_SWITCH_TICKS;
}

Deno.test("R right after the second shot (mid-pump) loads both shells back in", () => {
  const p = makePlayer();
  const t = fireAndCycle(p, 0);
  p.markShot(t);
  assertEquals(p.isPumping(), true);
  assertEquals(p.ammoInMag, TUBE - 2);
  const spare0 = p.spareClips;
  assertEquals(p.tryBeginReload(t + 1), true, "R accepted mid-pump");
  const first = t + 1 + START + PER_SHELL;
  step(p, t + 2, first + PER_SHELL);
  assertEquals(p.ammoInMag, TUBE);
  assertEquals(p.spareClips, spare0 - 2);
  assertEquals(p.isReloading(), false);
  step(p, first + PER_SHELL + 1, first + PER_SHELL + PUMP);
  assertEquals(p.canShoot(first + PER_SHELL + PUMP), true);
});
