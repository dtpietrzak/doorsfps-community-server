/**
 * PR6 — ability charges, global lock, bar regen, door regen.
 * Skills start locked until a door capture; death re-locks the kit.
 * Run: deno test -A server/players/ability_charges_test.ts
 */
import { assertEquals } from "jsr:@std/assert@1";
import {
  abilityBarRegenTicks,
  abilityDoorRegenTicks,
  abilityDurationTicks,
  abilityGlobalLockTicks,
} from "../shared/sim/abilities.ts";
import { isSkillActivatable, SKILL_ORDER } from "../shared/sim/skills.ts";
import { Player } from "./Player.ts";

const lockTicks = abilityGlobalLockTicks();
const barRegenTicks = abilityBarRegenTicks();
const doorRegenTicks = abilityDoorRegenTicks();
const durationTicks = abilityDurationTicks("quick");
const bulletsDurationTicks = abilityDurationTicks("bullets");
const hawkeyesDurationTicks = abilityDurationTicks("hawkeyes");

/** Unrestricted player with charges armed (skips door gate for unit paths). */
function makePlayer(): Player {
  const p = new Player("c", "ChargeTester", "A", {
    spawn: { x: 0, z: 0, yaw: Math.PI },
  });
  p.spawnedAtTick = 0;
  p.restoreAbilityCharges();
  return p;
}

Deno.test("spawn: all activatable skills spent until door", () => {
  const p = new Player("lock", "Locker", "A", {
    spawn: { x: 0, z: 0, yaw: 0 },
  });
  p.spawnedAtTick = 0;
  for (const id of SKILL_ORDER) {
    if (!isSkillActivatable(id)) continue;
    assertEquals(p.isAbilitySpent(id), true);
  }
  assertEquals(p.tryActivateAbility("quick", 0), false);
  assertEquals(p.tryActivateAbility("teleport", 0), false);
});

Deno.test("door regen after spawn unlocks skill charges", () => {
  const p = new Player("door", "DoorUnlock", "A", {
    spawn: { x: 0, z: 0, yaw: 0 },
  });
  p.spawnedAtTick = 0;
  assertEquals(p.tryActivateAbility("quick", 0), false);

  const tick = 10;
  p.beginAbilityDoorRegen(tick);
  assertEquals(p.abilityDoorRegenEndsAtTick, tick + doorRegenTicks);
  // Still blocked during door regen.
  assertEquals(p.tryActivateAbility("quick", tick), false);

  p.tickAbilityCharges(tick + doorRegenTicks);
  assertEquals(p.isAbilitySpent("quick"), false);
  assertEquals(p.tryActivateAbility("quick", tick + doorRegenTicks), true);
});

Deno.test("death re-locks all skill charges until next door", () => {
  const p = makePlayer();
  p.spawnedAtTick = -10_000;
  const tick = 5;
  assertEquals(p.tryActivateAbility("quick", tick), true);
  p.tickAbilityCharges(tick + durationTicks);
  // Kill player — full kit locks (not only previously spent charges).
  assertEquals(
    p.takeDamage(999, "body", tick + durationTicks + 1, Date.now()),
    true,
  );
  assertEquals(p.alive, false);
  for (const id of SKILL_ORDER) {
    if (!isSkillActivatable(id)) continue;
    assertEquals(p.isAbilitySpent(id), true);
  }
  // Respawn without door still locked.
  p.respawn({ x: 0, z: 0, yaw: 0 }, tick + durationTicks + 100);
  assertEquals(
    p.tryActivateAbility("glitch", tick + durationTicks + 100),
    false,
  );
  assertEquals(
    p.tryActivateAbility("bullets", tick + durationTicks + 100),
    false,
  );

  // Door after death unlocks again.
  const doorTick = tick + durationTicks + 200;
  p.beginAbilityDoorRegen(doorTick);
  p.tickAbilityCharges(doorTick + doorRegenTicks);
  assertEquals(p.tryActivateAbility("glitch", doorTick + doorRegenTicks), true);
});

Deno.test("PR7: unowned ability cannot activate", () => {
  const p = new Player("own", "Owner", "A", {
    spawn: { x: 0, z: 0, yaw: 0 },
    ownedAbilities: [],
  });
  p.spawnedAtTick = 0;
  p.restoreAbilityCharges();
  assertEquals(p.ownsAbility("quick"), false);
  assertEquals(p.tryActivateAbility("quick", 10), false);

  p.setOwnedAbilities(["quick"]);
  assertEquals(p.ownsAbility("quick"), true);
  // PR-2: ownership alone is not enough — skill must be in the match loadout.
  // Guest default loadout is empty; equip after purchase / client SkillLoadout.
  assertEquals(p.tryActivateAbility("quick", 10), false);
  p.setSkillLoadout(["quick", null, null, null]);
  assertEquals(p.tryActivateAbility("quick", 10), true);
  assertEquals(p.tryActivateAbility("bullets", 11), false);
});

Deno.test("PR7 tiers: duration + lock match highest owned product", () => {
  const p = new Player("tier", "Tierer", "A", {
    spawn: { x: 0, z: 0, yaw: 0 },
    ownedAbilities: ["quick"],
  });
  p.spawnedAtTick = 0;
  p.restoreAbilityCharges();
  const tick = 0;
  assertEquals(p.abilityDurationS("quick"), 1.5);
  assertEquals(p.tryActivateAbility("quick", tick), true);
  const t1Dur = abilityDurationTicks("quick", 60, ["quick"]);
  assertEquals(p.abilityEndsAtTick.quick, tick + t1Dur);
  assertEquals(p.abilityGlobalLockEndsAtTick, tick + t1Dur);

  // Upgrade ownership mid-test: highest tier wins next activate.
  p.tickAbilityCharges(tick + t1Dur);
  p.abilitySpent = {};
  p.abilityBarRegenEndsAtTick = null;
  p.setOwnedAbilities(["quick", "quick2", "quick3"]);
  assertEquals(p.abilityDurationS("quick"), 2.5);
  const t3 = tick + t1Dur + 100;
  assertEquals(p.tryActivateAbility("quick", t3), true);
  const t3Dur = abilityDurationTicks("quick", 60, [
    "quick",
    "quick2",
    "quick3",
  ]);
  assertEquals(p.abilityEndsAtTick.quick, t3 + t3Dur);
  assertEquals(p.abilityGlobalLockEndsAtTick, t3 + t3Dur);

  // quick2 alone still owns the family at 2s
  const p2 = new Player("t2", "T2", "A", {
    spawn: { x: 0, z: 0, yaw: 0 },
    ownedAbilities: ["quick2"],
  });
  p2.spawnedAtTick = 0;
  p2.restoreAbilityCharges();
  assertEquals(p2.ownsAbility("quick"), true);
  assertEquals(p2.abilityDurationS("quick"), 2);
});

Deno.test("activate sets global lock; second ability rejected during lock", () => {
  const p = makePlayer();
  const tick = 10;
  assertEquals(p.tryActivateAbility("quick", tick), true);
  assertEquals(p.abilityGlobalLockEndsAtTick, tick + lockTicks);
  // Other abilities blocked while lock is up.
  assertEquals(p.tryActivateAbility("bullets", tick + 1), false);
  assertEquals(p.tryActivateAbility("glitch", tick + 1), false);
  assertEquals(p.tryActivateAbility("hawkeyes", tick + 1), false);
});

Deno.test("after lock ends, ability is spent and bar regen blocks activates", () => {
  const p = makePlayer();
  const tick = 0;
  assertEquals(p.tryActivateAbility("quick", tick), true);

  // Expire active window.
  p.tickAbilityCharges(tick + durationTicks);
  assertEquals(p.isAbilityActive("quick", tick + durationTicks), false);
  assertEquals(p.isAbilitySpent("quick"), true);
  assertEquals(
    p.abilityBarRegenEndsAtTick,
    tick + durationTicks + barRegenTicks,
  );

  // Same ability spent; others blocked during bar regen.
  assertEquals(p.tryActivateAbility("quick", tick + durationTicks), false);
  assertEquals(p.tryActivateAbility("bullets", tick + durationTicks), false);

  // After bar regen, other abilities work; spent still blocked.
  const afterRegen = tick + durationTicks + barRegenTicks;
  p.tickAbilityCharges(afterRegen);
  assertEquals(p.tryActivateAbility("bullets", afterRegen), true);
  assertEquals(p.tryActivateAbility("quick", afterRegen), false);
});

Deno.test("door regen restores all spent charges after 1s", () => {
  const p = makePlayer();
  let tick = 0;
  assertEquals(p.tryActivateAbility("quick", tick), true);
  tick += durationTicks;
  p.tickAbilityCharges(tick);
  assertEquals(p.isAbilitySpent("quick"), true);

  // Wait out post-use bar regen so we can use another.
  tick += barRegenTicks;
  p.tickAbilityCharges(tick);
  assertEquals(p.tryActivateAbility("bullets", tick), true);
  tick += bulletsDurationTicks;
  p.tickAbilityCharges(tick);
  assertEquals(p.isAbilitySpent("bullets"), true);
  tick += barRegenTicks;
  p.tickAbilityCharges(tick);

  assertEquals(p.isAbilitySpent("quick"), true);
  assertEquals(p.isAbilitySpent("bullets"), true);

  p.beginAbilityDoorRegen(tick);
  assertEquals(p.abilityDoorRegenEndsAtTick, tick + doorRegenTicks);
  // Still blocked during door regen.
  assertEquals(p.tryActivateAbility("hawkeyes", tick), false);

  p.tickAbilityCharges(tick + doorRegenTicks);
  assertEquals(p.isAbilitySpent("quick"), false);
  assertEquals(p.isAbilitySpent("bullets"), false);
  assertEquals(p.tryActivateAbility("quick", tick + doorRegenTicks), true);
});

Deno.test("door regen during active ability does not re-spend on expire", () => {
  const p = makePlayer();
  const tick = 0;
  assertEquals(p.tryActivateAbility("hawkeyes", tick), true);
  // Capture mid-window.
  p.beginAbilityDoorRegen(tick + 10);
  // Finish door regen while ability still active.
  p.tickAbilityCharges(tick + 10 + doorRegenTicks);
  assertEquals(p.abilityDoorRegenEndsAtTick, null);
  // Expire active after door regen completed.
  p.tickAbilityCharges(tick + hawkeyesDurationTicks);
  assertEquals(p.isAbilitySpent("hawkeyes"), false);
});

Deno.test("resetMatchStats re-locks ability charges until door", () => {
  const p = makePlayer();
  assertEquals(p.tryActivateAbility("quick", 0), true);
  p.tickAbilityCharges(durationTicks);
  assertEquals(p.isAbilitySpent("quick"), true);
  p.resetMatchStats();
  // New match: full kit locked (not free charges).
  assertEquals(p.isAbilitySpent("quick"), true);
  assertEquals(p.tryActivateAbility("bullets", 0), false);
  assertEquals(p.abilityGlobalLockEndsAtTick, null);
  assertEquals(p.abilityBarRegenEndsAtTick, null);
  assertEquals(p.abilityDoorRegenEndsAtTick, null);
});

Deno.test("snapshot includes spent + lock/regen on full snaps", () => {
  const p = makePlayer();
  const tick = 20;
  assertEquals(p.tryActivateAbility("quick", tick), true);
  const mid = p.toSnapshot(tick, "full");
  assertEquals(mid.abilityLockEndsAtTick, tick + lockTicks);
  assertEquals(mid.abilities?.some((a) => a.id === "quick") ?? false, true);

  p.tickAbilityCharges(tick + durationTicks);
  const after = p.toSnapshot(tick + durationTicks, "full");
  assertEquals(after.abilitySpent?.includes("quick") ?? false, true);
  assertEquals(
    after.abilityRegenEndsAtTick,
    tick + durationTicks + barRegenTicks,
  );

  // Motion snaps omit charge fields.
  const motion = p.toSnapshot(tick + durationTicks, "motion");
  assertEquals(motion.abilitySpent, undefined);
  assertEquals(motion.abilityLockEndsAtTick, undefined);
  assertEquals(motion.abilityRegenEndsAtTick, undefined);
});

Deno.test("dead player still advances ability charge timers", () => {
  // Arm then activate, then die without full lock path (manual death).
  const p = makePlayer();
  const tick = 0;
  assertEquals(p.tryActivateAbility("bullets", tick), true);
  // Manual death without takeDamage so active window can finish → spent.
  p.alive = false;
  p.diedAtTick = tick + 1;
  p.tickAbilityCharges(tick + bulletsDurationTicks);
  assertEquals(p.isAbilitySpent("bullets"), true);
});

Deno.test("takeDamage death cancels mid-active ability", () => {
  const p = makePlayer();
  // Past spawn protection so damage can kill.
  p.spawnedAtTick = -10_000;
  const tick = 100;
  assertEquals(p.tryActivateAbility("glitch", tick), true);
  assertEquals(p.isAbilityActive("glitch", tick + 1), true);
  assertEquals(p.takeDamage(999, "body", tick + 1, Date.now()), true);
  assertEquals(p.isAbilityActive("glitch", tick + 1), false);
  assertEquals(p.abilityGlobalLockEndsAtTick, null);
});
