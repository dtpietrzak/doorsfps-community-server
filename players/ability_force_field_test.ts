/**
 * Skill C — Force Field (Medic, timed, invincible).
 * Run: deno test -A server/players/ability_force_field_test.ts
 */
import { assertEquals } from "jsr:@std/assert@1";
import { MAX_HEALTH } from "../protocol/network.ts";
import {
  abilityBarRegenTicks,
  abilityDoorRegenTicks,
} from "../shared/sim/abilities.ts";
import { timedSkillDurationTicks } from "../shared/sim/skills.ts";
import { Player } from "./Player.ts";

const durationI = timedSkillDurationTicks("forceField", undefined, [
  "forceField",
]);
const durationII = timedSkillDurationTicks("forceField", undefined, [
  "forceField",
  "forceField2",
]);
const durationMax = timedSkillDurationTicks("forceField"); // unrestricted max
const barRegenTicks = abilityBarRegenTicks();

/** Past spawn invuln so takeDamage is not blocked by spawn protect. */
const PAST_SPAWN = 10_000;

function makePlayer(
  owned?: readonly string[] | null,
): Player {
  const p = new Player("ff", "ForceFieldTester", "A", {
    spawn: { x: 0, z: 0, yaw: Math.PI },
    ...(owned !== undefined ? { ownedAbilities: owned } : {}),
  });
  p.spawnedAtTick = 0;
  p.restoreAbilityCharges();
  return p;
}

Deno.test("forceField activate sets window and isAbilityActive", () => {
  const p = makePlayer();
  const tick = 10;
  assertEquals(p.tryActivateAbility("forceField", tick), true);
  assertEquals(p.isAbilityActive("forceField", tick), true);
  assertEquals(
    p.isAbilityActive("forceField", tick + durationMax - 1),
    true,
  );
  assertEquals(
    p.isAbilityActive("forceField", tick + durationMax),
    false,
  );
  // Re-activate while active is no-op.
  assertEquals(p.tryActivateAbility("forceField", tick + 1), false);
});

Deno.test("forceField tier I duration is 1s", () => {
  const p = makePlayer(["forceField"]);
  const tick = 0;
  assertEquals(p.tryActivateAbility("forceField", tick), true);
  assertEquals(p.isAbilityActive("forceField", tick + durationI - 1), true);
  assertEquals(p.isAbilityActive("forceField", tick + durationI), false);
  assertEquals(
    durationI,
    timedSkillDurationTicks("forceField", undefined, [
      "forceField",
    ]),
  );
});

Deno.test("forceField tier II duration is 2s (max)", () => {
  const p = makePlayer(["forceField", "forceField2"]);
  const tick = 0;
  assertEquals(p.tryActivateAbility("forceField", tick), true);
  assertEquals(p.isAbilityActive("forceField", tick + durationII - 1), true);
  assertEquals(p.isAbilityActive("forceField", tick + durationII), false);
  assertEquals(durationII, durationMax);
});

Deno.test("takeDamage is blocked while forceField active", () => {
  const p = makePlayer();
  p.spawnedAtTick = 0;
  const tick = PAST_SPAWN;
  assertEquals(p.isSpawnProtected(tick), false);
  assertEquals(p.tryActivateAbility("forceField", tick), true);
  assertEquals(p.isInvulnerable(tick), true);

  const hp = p.health;
  assertEquals(p.takeDamage(50, "body", tick, Date.now()), false);
  assertEquals(p.health, hp);
  assertEquals(p.alive, true);

  // Still blocked near end of window.
  const mid = tick + durationMax - 1;
  assertEquals(p.takeDamage(999, "head", mid, Date.now()), false);
  assertEquals(p.health, hp);
  assertEquals(p.alive, true);
});

Deno.test("takeDamage applies after forceField expires", () => {
  const p = makePlayer();
  const tick = PAST_SPAWN;
  assertEquals(p.tryActivateAbility("forceField", tick), true);
  const after = tick + durationMax;
  p.tickAbilityCharges(after);
  assertEquals(p.isAbilityActive("forceField", after), false);
  assertEquals(p.isInvulnerable(after), false);

  assertEquals(p.takeDamage(40, "body", after, Date.now()), false); // not lethal
  assertEquals(p.health, MAX_HEALTH - 40);
  assertEquals(p.alive, true);

  assertEquals(p.takeDamage(999, "head", after + 1, Date.now()), true);
  assertEquals(p.alive, false);
  assertEquals(p.health, 0);
});

Deno.test("snapshot invulnerable while forceField active (past spawn)", () => {
  const p = makePlayer();
  const tick = PAST_SPAWN;
  // No force field yet → not invulnerable past spawn.
  assertEquals(p.toSnapshot(tick, "motion").invulnerable, false);

  assertEquals(p.tryActivateAbility("forceField", tick), true);
  assertEquals(p.toSnapshot(tick, "motion").invulnerable, true);
  assertEquals(
    p.toSnapshot(tick + durationMax - 1, "motion").invulnerable,
    true,
  );
  assertEquals(
    p.toSnapshot(tick + durationMax, "motion").invulnerable,
    false,
  );

  // Ability entry still on the wire during the window.
  const snap = p.toSnapshot(tick, "motion");
  assertEquals(snap.abilities!.some((a) => a.id === "forceField"), true);
});

Deno.test("forceField charge spent after window; global lock tracks duration", () => {
  const p = makePlayer(["forceField"]);
  const tick = 0;
  assertEquals(p.tryActivateAbility("forceField", tick), true);
  assertEquals(p.abilityGlobalLockEndsAtTick, tick + durationI);
  assertEquals(p.isAbilitySpent("forceField"), false);

  p.tickAbilityCharges(tick + durationI);
  assertEquals(p.isAbilitySpent("forceField"), true);
  assertEquals(p.tryActivateAbility("forceField", tick + durationI), false);

  // After bar regen, still spent until door regen / match reset.
  const afterRegen = tick + durationI + barRegenTicks;
  p.tickAbilityCharges(afterRegen);
  assertEquals(p.isAbilitySpent("forceField"), true);
  assertEquals(p.tryActivateAbility("forceField", afterRegen), false);
});

Deno.test("unowned forceField cannot activate", () => {
  const p = makePlayer([]);
  assertEquals(p.tryActivateAbility("forceField", PAST_SPAWN), false);
  assertEquals(p.takeDamage(10, "body", PAST_SPAWN, Date.now()), false);
  // No FF → damage applies (not lethal).
  assertEquals(p.health, MAX_HEALTH - 10);
});

Deno.test("dead player cannot activate forceField", () => {
  const p = makePlayer();
  p.alive = false;
  assertEquals(p.tryActivateAbility("forceField", 0), false);
});

Deno.test("door regen restores forceField charge", () => {
  const p = makePlayer();
  const tick = PAST_SPAWN;
  assertEquals(p.tryActivateAbility("forceField", tick), true);
  p.tickAbilityCharges(tick + durationMax);
  assertEquals(p.isAbilitySpent("forceField"), true);

  const doorTick = tick + durationMax + 5;
  p.beginAbilityDoorRegen(doorTick);
  p.tickAbilityCharges(doorTick + abilityDoorRegenTicks());
  assertEquals(p.isAbilitySpent("forceField"), false);
  assertEquals(
    p.tryActivateAbility("forceField", doorTick + abilityDoorRegenTicks()),
    true,
  );
});

Deno.test("spawn protect and forceField both block via isInvulnerable", () => {
  const p = makePlayer();
  // Fresh spawn: spawn protect alone.
  assertEquals(p.isSpawnProtected(0), true);
  assertEquals(p.isInvulnerable(0), true);
  assertEquals(p.takeDamage(50, "body", 0, Date.now()), false);
  assertEquals(p.health, MAX_HEALTH);

  // Mid-spawn with FF still invulnerable either way.
  assertEquals(p.tryActivateAbility("forceField", 1), true);
  assertEquals(p.isInvulnerable(1), true);
});
