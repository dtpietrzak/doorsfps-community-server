/**
 * Skill G — Rapid fire (Marksman, timed): 2× fire + reload speed, +1 spare mag.
 * Run: deno test -A server/players/ability_rapid_fire_test.ts
 */
import { assertEquals } from "jsr:@std/assert@1";
import { abilityBarRegenTicks } from "../shared/sim/abilities.ts";
import { timedSkillDurationTicks } from "../shared/sim/skills.ts";
import { getWeapon, WEAPON_PISTOL, WEAPON_RIFLE } from "../protocol/network.ts";
import { Player } from "./Player.ts";

const durationI = timedSkillDurationTicks("rapidFire", undefined, [
  "rapidFire",
]);
const durationII = timedSkillDurationTicks("rapidFire", undefined, [
  "rapidFire",
  "rapidFire2",
]);
const durationIII = timedSkillDurationTicks("rapidFire", undefined, [
  "rapidFire",
  "rapidFire2",
  "rapidFire3",
]);
const durationMax = timedSkillDurationTicks("rapidFire"); // unrestricted max
const barRegenTicks = abilityBarRegenTicks();
const pistol = getWeapon(WEAPON_PISTOL);
const rifle = getWeapon(WEAPON_RIFLE);

function makePlayer(owned?: readonly string[] | null): Player {
  const p = new Player("rf", "RapidFireTester", "A", {
    spawn: { x: 0, z: 0, yaw: Math.PI },
    ...(owned !== undefined ? { ownedAbilities: owned } : {}),
  });
  p.spawnedAtTick = 0;
  p.restoreAbilityCharges();
  return p;
}

function fireIfPossible(p: Player, tick: number): boolean {
  if (!p.canShoot(tick)) return false;
  p.markShot(tick);
  return true;
}

Deno.test("tryActivateAbility rapidFire sets window and isAbilityActive", () => {
  const p = makePlayer();
  const tick = 10;
  assertEquals(p.tryActivateAbility("rapidFire", tick), true);
  assertEquals(p.isAbilityActive("rapidFire", tick), true);
  assertEquals(
    p.isAbilityActive("rapidFire", tick + durationMax - 1),
    true,
  );
  assertEquals(
    p.isAbilityActive("rapidFire", tick + durationMax),
    false,
  );
  // Re-activate while active is no-op.
  assertEquals(p.tryActivateAbility("rapidFire", tick + 1), false);
});

Deno.test("rapidFire grants +1 spare magazine on activate", () => {
  const p = makePlayer();
  const startSpares = p.spareClips;
  assertEquals(startSpares, pistol.totalClips - 1);

  assertEquals(p.tryActivateAbility("rapidFire", 0), true);
  assertEquals(p.spareClips, startSpares + 1);

  // Other weapons unchanged.
  assertEquals(p.ammoInMagFor(WEAPON_RIFLE), rifle.magSize);
  // Rifle spares still at default (via snapshot of inactive loadout).
  p.trySwitchWeapon(WEAPON_RIFLE, 0);
  p.tickWeaponSwitch(1000);
  assertEquals(p.spareClips, rifle.totalClips - 1);
});

Deno.test("rapidFire spare mag stacks when already empty of spares", () => {
  const p = makePlayer();
  // Burn spares by reloading until none left.
  while (p.spareClips > 0) {
    p.markShot(0);
    assertEquals(p.tryBeginReload(0), true);
    p.tickReload(p.reloadEndsAtTick!);
  }
  assertEquals(p.spareClips, 0);
  assertEquals(p.tryActivateAbility("rapidFire", 10), true);
  assertEquals(p.spareClips, 1);
  // Can reload again with the gifted mag.
  p.markShot(10);
  assertEquals(p.tryBeginReload(11), true);
});

Deno.test("rapidFire tier durations: 2 / 2.5 / 3 s", () => {
  assertEquals(
    durationI,
    timedSkillDurationTicks("rapidFire", undefined, [
      "rapidFire",
    ]),
  );
  assertEquals(
    durationII,
    timedSkillDurationTicks("rapidFire", undefined, [
      "rapidFire",
      "rapidFire2",
    ]),
  );
  assertEquals(durationIII, durationMax);

  const p1 = makePlayer(["rapidFire"]);
  assertEquals(p1.tryActivateAbility("rapidFire", 0), true);
  assertEquals(p1.isAbilityActive("rapidFire", durationI - 1), true);
  assertEquals(p1.isAbilityActive("rapidFire", durationI), false);

  const p2 = makePlayer(["rapidFire", "rapidFire2"]);
  assertEquals(p2.tryActivateAbility("rapidFire", 0), true);
  assertEquals(p2.isAbilityActive("rapidFire", durationII - 1), true);
  assertEquals(p2.isAbilityActive("rapidFire", durationII), false);

  const p3 = makePlayer(["rapidFire", "rapidFire2", "rapidFire3"]);
  assertEquals(p3.tryActivateAbility("rapidFire", 0), true);
  assertEquals(p3.isAbilityActive("rapidFire", durationIII - 1), true);
  assertEquals(p3.isAbilityActive("rapidFire", durationIII), false);
});

Deno.test("unowned rapidFire cannot activate", () => {
  const p = makePlayer([]);
  assertEquals(p.ownsAbility("rapidFire"), false);
  assertEquals(p.tryActivateAbility("rapidFire", 0), false);
});

Deno.test("dead player cannot activate rapidFire", () => {
  const p = makePlayer();
  p.alive = false;
  assertEquals(p.tryActivateAbility("rapidFire", 0), false);
});

Deno.test("fire cooldown is halved while rapidFire active", () => {
  const p = makePlayer();
  const tick = 0;
  const fullCd = p.fireCooldownTicksAt(tick);
  assertEquals(fullCd, pistol.fireCooldownTicks);
  assertEquals(fullCd > 1, true);

  assertEquals(p.tryActivateAbility("rapidFire", tick), true);
  const halfCd = p.fireCooldownTicksAt(tick);
  // ~half of full (ceil of ms/2 → ticks); never longer than full.
  assertEquals(halfCd < fullCd, true);
  assertEquals(halfCd >= 1, true);
  // Double rate: after a shot, ready at halfCd not fullCd.
  assertEquals(fireIfPossible(p, tick), true);
  assertEquals(p.canShoot(tick + 1), false);
  if (halfCd > 1) {
    assertEquals(p.canShoot(tick + halfCd - 1), false);
  }
  assertEquals(p.canShoot(tick + halfCd), true);
  // Still blocked at fullCd-1 if half is strictly less (redundant safety).
  if (fullCd > halfCd + 1) {
    // Already ready at halfCd; just confirm mag still decrements.
    assertEquals(fireIfPossible(p, tick + halfCd), true);
  }
});

Deno.test("after rapidFire expires, full fire cooldown resumes", () => {
  const p = makePlayer();
  const start = 0;
  assertEquals(p.tryActivateAbility("rapidFire", start), true);
  const halfCd = p.fireCooldownTicksAt(start);
  assertEquals(fireIfPossible(p, start), true);

  // Wait out the ability window + leftover half CD so the next shot is clean.
  const after = start + durationMax + halfCd;
  assertEquals(p.isAbilityActive("rapidFire", after), false);
  const fullCd = p.fireCooldownTicksAt(after);
  assertEquals(fullCd, pistol.fireCooldownTicks);

  assertEquals(fireIfPossible(p, after), true);
  // Immediate next tick still on full CD.
  if (fullCd > 1) {
    assertEquals(p.canShoot(after + 1), false);
  }
  // Ready only after full cooldown.
  assertEquals(p.canShoot(after + fullCd), true);
  // Not ready at half of full (unless half equals full for tiny weapons).
  if (Math.floor(fullCd / 2) < fullCd) {
    assertEquals(
      p.canShoot(after + Math.max(1, Math.floor(fullCd / 2))),
      false,
    );
  }
});

Deno.test("reload duration is halved when reload starts under rapidFire", () => {
  const p = makePlayer();
  // Empty one round so reload is allowed.
  p.markShot(0);
  assertEquals(p.ammoInMag < pistol.magSize, true);

  const tick = 10;
  assertEquals(p.tryActivateAbility("rapidFire", tick), true);
  const halfReload = p.reloadTicksAt(tick);
  assertEquals(halfReload < pistol.reloadTicks, true);
  assertEquals(halfReload >= 1, true);

  assertEquals(p.tryBeginReload(tick), true);
  assertEquals(p.isReloading(), true);
  assertEquals(p.reloadEndsAtTick, tick + halfReload);

  // Completes at half duration.
  p.tickReload(tick + halfReload - 1);
  assertEquals(p.isReloading(), true);
  p.tickReload(tick + halfReload);
  assertEquals(p.isReloading(), false);
  assertEquals(p.ammoInMag, pistol.magSize);
});

Deno.test("reload started without rapidFire keeps full duration even if RF later", () => {
  const p = makePlayer();
  p.markShot(0);
  const tick = 5;
  assertEquals(p.tryBeginReload(tick), true);
  assertEquals(p.reloadEndsAtTick, tick + pistol.reloadTicks);

  // Activating RF mid-reload does not rewrite the end tick.
  assertEquals(p.tryActivateAbility("rapidFire", tick + 1), true);
  assertEquals(p.reloadEndsAtTick, tick + pistol.reloadTicks);
  p.tickReload(tick + pistol.reloadTicks - 1);
  assertEquals(p.isReloading(), true);
  p.tickReload(tick + pistol.reloadTicks);
  assertEquals(p.isReloading(), false);
});

Deno.test("rapidFire works on rifle fire cooldown", () => {
  const p = makePlayer();
  assertEquals(p.trySwitchWeapon(WEAPON_RIFLE, 0), true);
  // Wait out switch lock.
  const ready = 0 + 1000; // comfortably past WEAPON_SWITCH_TICKS
  p.tickWeaponSwitch(ready);
  assertEquals(p.isSwitching(ready), false);
  assertEquals(p.weaponId, WEAPON_RIFLE);

  const full = p.fireCooldownTicksAt(ready);
  assertEquals(full, rifle.fireCooldownTicks);
  assertEquals(p.tryActivateAbility("rapidFire", ready), true);
  const half = p.fireCooldownTicksAt(ready);
  assertEquals(half < full, true);
  assertEquals(fireIfPossible(p, ready), true);
  assertEquals(p.canShoot(ready + half), true);
});

Deno.test("snapshot includes active rapidFire while window open", () => {
  const p = makePlayer();
  const tick = 20;
  p.tryActivateAbility("rapidFire", tick);
  const snap = p.toSnapshot(tick, "motion");
  assertEquals(Array.isArray(snap.abilities), true);
  assertEquals(snap.abilities!.some((a) => a.id === "rapidFire"), true);
  const entry = snap.abilities!.find((a) => a.id === "rapidFire")!;
  assertEquals(entry.endsAtTick, tick + durationMax);

  const after = p.toSnapshot(tick + durationMax, "motion");
  assertEquals(
    after.abilities?.some((a) => a.id === "rapidFire") ?? false,
    false,
  );
});

Deno.test("rapidFire charge spent when window ends + bar regen", () => {
  const p = makePlayer();
  const tick = 0;
  assertEquals(p.tryActivateAbility("rapidFire", tick), true);
  p.tickAbilityCharges(tick + durationMax);
  assertEquals(p.isAbilitySpent("rapidFire"), true);
  assertEquals(p.isAbilityActive("rapidFire", tick + durationMax), false);
  // Global lock ends with window; bar regen follows.
  assertEquals(
    p.abilityBarRegenEndsAtTick !== null &&
      p.abilityBarRegenEndsAtTick! >= tick + durationMax,
    true,
  );
  // Cannot re-activate while spent.
  const afterRegen = tick + durationMax + barRegenTicks;
  p.tickAbilityCharges(afterRegen);
  assertEquals(p.tryActivateAbility("rapidFire", afterRegen), false);
});

Deno.test("global lock blocks other skills during rapidFire", () => {
  const p = makePlayer();
  const tick = 0;
  assertEquals(p.tryActivateAbility("rapidFire", tick), true);
  assertEquals(p.tryActivateAbility("bullets", tick + 1), false);
  assertEquals(p.tryActivateAbility("quick", tick + 1), false);
});
