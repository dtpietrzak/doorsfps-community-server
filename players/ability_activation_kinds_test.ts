/**
 * PR-1 — activation model: timed / instant / passive.
 * Run: deno test -A server/players/ability_activation_kinds_test.ts
 */
import { assertEquals } from "jsr:@std/assert@1";
import {
  abilityBarRegenTicks,
  abilityDoorRegenTicks,
  abilityDurationTicks,
} from "../shared/sim/abilities.ts";
import {
  INSTANT_SKILL_FLASH_TICKS,
  instantSkillLockTicks,
  isInstantSkill,
  isPassiveSkill,
  isSkillActivatable,
  isTimedSkill,
} from "../shared/sim/skills.ts";
import { Player } from "./Player.ts";

const barRegenTicks = abilityBarRegenTicks();
const instantLockTicks = instantSkillLockTicks();
const timedDurationTicks = abilityDurationTicks("quick");

function makePlayer(): Player {
  const p = new Player("c", "KindTester", "A", {
    spawn: { x: 0, z: 0, yaw: Math.PI },
  });
  p.spawnedAtTick = 0;
  p.restoreAbilityCharges();
  return p;
}

Deno.test("skill kind helpers: timed / instant / passive", () => {
  assertEquals(isTimedSkill("quick"), true);
  assertEquals(isTimedSkill("forceField"), true);
  assertEquals(isInstantSkill("selfHeal"), true);
  assertEquals(isInstantSkill("rewind"), true);
  assertEquals(isPassiveSkill("leech"), true);
  assertEquals(isSkillActivatable("quick"), true);
  assertEquals(isSkillActivatable("selfHeal"), true);
  assertEquals(isSkillActivatable("leech"), false);
});

Deno.test("passive never activates", () => {
  const p = makePlayer();
  assertEquals(p.canActivateAbility("leech", 0), false);
  assertEquals(p.tryActivateAbility("leech", 0), false);
  assertEquals(p.isAbilitySpent("leech"), false);
  assertEquals(p.abilityGlobalLockEndsAtTick, null);
});

// Generic instant economy uses teleport (no HP gate). Self heal has its own suite.

Deno.test("instant: spends charge immediately + global lock + bar regen", () => {
  const p = makePlayer();
  const tick = 10;
  assertEquals(p.tryActivateAbility("teleport", tick), true);
  assertEquals(p.isAbilitySpent("teleport"), true);
  assertEquals(p.abilityGlobalLockEndsAtTick, tick + instantLockTicks);
  assertEquals(
    p.abilityBarRegenEndsAtTick,
    tick + instantLockTicks + barRegenTicks,
  );
  // Optional flash for VFX.
  if (INSTANT_SKILL_FLASH_TICKS > 0) {
    assertEquals(p.isAbilityActive("teleport", tick), true);
    assertEquals(
      p.isAbilityActive("teleport", tick + INSTANT_SKILL_FLASH_TICKS),
      false,
    );
  }
  // Flash expire does not double-spend (already spent).
  p.tickAbilityCharges(tick + INSTANT_SKILL_FLASH_TICKS);
  assertEquals(p.isAbilitySpent("teleport"), true);
});

Deno.test("instant: second activate denied while spent / lock", () => {
  const p = makePlayer();
  const tick = 0;
  assertEquals(p.tryActivateAbility("teleport", tick), true);
  assertEquals(p.tryActivateAbility("teleport", tick + 1), false);
  assertEquals(p.tryActivateAbility("rewind", tick + 1), false);
  assertEquals(p.tryActivateAbility("quick", tick + 1), false);
});

Deno.test("charge/lock exclusive across timed and instant", () => {
  const p = makePlayer();
  const tick = 0;

  // Timed first → blocks instant during window.
  assertEquals(p.tryActivateAbility("quick", tick), true);
  assertEquals(p.tryActivateAbility("teleport", tick + 1), false);
  assertEquals(p.tryActivateAbility("bullets", tick + 1), false);

  // Expire timed + bar regen, clear spent for clean slate.
  p.tickAbilityCharges(tick + timedDurationTicks);
  assertEquals(p.isAbilitySpent("quick"), true);
  const afterRegen = tick + timedDurationTicks + barRegenTicks;
  p.tickAbilityCharges(afterRegen);
  // Spent persists; other unspent skills ok.
  assertEquals(p.tryActivateAbility("teleport", afterRegen), true);
  assertEquals(p.isAbilitySpent("teleport"), true);
  assertEquals(p.tryActivateAbility("glitch", afterRegen + 1), false);

  // After instant lock + bar regen, another timed can fire; spent still blocked.
  const afterInstant = afterRegen + instantLockTicks + barRegenTicks;
  p.tickAbilityCharges(afterInstant);
  assertEquals(p.tryActivateAbility("glitch", afterInstant), true);
  assertEquals(p.tryActivateAbility("teleport", afterInstant), false);
  assertEquals(p.tryActivateAbility("quick", afterInstant), false);
});

Deno.test("instant first then timed blocked during lock", () => {
  const p = makePlayer();
  const tick = 5;
  assertEquals(p.tryActivateAbility("rewind", tick), true);
  assertEquals(p.tryActivateAbility("quick", tick + 1), false);
  assertEquals(p.tryActivateAbility("hawkeyes", tick + 1), false);

  const afterBusy = tick + instantLockTicks + barRegenTicks;
  p.tickAbilityCharges(afterBusy);
  assertEquals(p.tryActivateAbility("quick", afterBusy), true);
});

Deno.test("timed still sets long window (regression)", () => {
  const p = makePlayer();
  const tick = 0;
  assertEquals(p.tryActivateAbility("bullets", tick), true);
  assertEquals(p.isAbilityActive("bullets", tick), true);
  assertEquals(p.isAbilitySpent("bullets"), false); // spent on end, not activate
  assertEquals(
    p.abilityEndsAtTick.bullets,
    tick + abilityDurationTicks("bullets"),
  );
  assertEquals(p.abilityGlobalLockEndsAtTick, p.abilityEndsAtTick.bullets);
});

Deno.test("snapshot: instant spent + lock on full snap; flash in abilities", () => {
  const p = makePlayer();
  const tick = 20;
  assertEquals(p.tryActivateAbility("teleport", tick), true);
  const full = p.toSnapshot(tick, "full");
  assertEquals(full.abilitySpent?.includes("teleport") ?? false, true);
  assertEquals(full.abilityLockEndsAtTick, tick + instantLockTicks);
  if (INSTANT_SKILL_FLASH_TICKS > 0) {
    assertEquals(
      full.abilities?.some((a) => a.id === "teleport") ?? false,
      true,
    );
  }
  // Motion snaps omit charge fields.
  const motion = p.toSnapshot(tick, "motion");
  assertEquals(motion.abilitySpent, undefined);
  assertEquals(motion.abilityLockEndsAtTick, undefined);
});

Deno.test("dead player cannot activate instant", () => {
  const p = makePlayer();
  p.alive = false;
  assertEquals(p.tryActivateAbility("teleport", 0), false);
});

Deno.test("unowned timed still blocked; unrestricted owns instants", () => {
  const guest = new Player("g", "Guest", "A", {
    spawn: { x: 0, z: 0, yaw: 0 },
    ownedAbilities: [],
  });
  guest.spawnedAtTick = 0;
  assertEquals(guest.tryActivateAbility("quick", 0), false);
  assertEquals(guest.tryActivateAbility("teleport", 0), false);

  const bot = makePlayer(); // unrestricted
  assertEquals(bot.ownsAbility("teleport"), true);
  assertEquals(bot.tryActivateAbility("teleport", 0), true);
});

Deno.test("door regen restores instant spent charge", () => {
  const p = makePlayer();
  const tick = 0;
  assertEquals(p.tryActivateAbility("teleport", tick), true);
  assertEquals(p.isAbilitySpent("teleport"), true);

  // Wait out lock+regen so bar is idle, then capture.
  const idle = tick + instantLockTicks + barRegenTicks;
  p.tickAbilityCharges(idle);
  p.beginAbilityDoorRegen(idle);
  p.tickAbilityCharges(idle + abilityDoorRegenTicks());
  assertEquals(p.isAbilitySpent("teleport"), false);
});
