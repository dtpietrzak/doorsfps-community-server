/**
 * Skill A — Self heal (Medic, instant, hp).
 * Run: deno test -A server/players/ability_self_heal_test.ts
 */
import { assertEquals } from "jsr:@std/assert@1";
import { MAX_HEALTH } from "../protocol/network.ts";
import {
  abilityBarRegenTicks,
  abilityDoorRegenTicks,
} from "../shared/sim/abilities.ts";
import {
  INSTANT_SKILL_FLASH_TICKS,
  instantSkillLockTicks,
  skillValueForOwned,
} from "../shared/sim/skills.ts";
import { Player } from "./Player.ts";

const instantLockTicks = instantSkillLockTicks();
const barRegenTicks = abilityBarRegenTicks();

function makePlayer(
  owned?: readonly string[] | null,
): Player {
  const p = new Player("h", "HealTester", "A", {
    spawn: { x: 0, z: 0, yaw: Math.PI },
    ...(owned !== undefined ? { ownedAbilities: owned } : {}),
  });
  p.spawnedAtTick = 0;
  p.restoreAbilityCharges();
  return p;
}

/** Drop HP so Self heal is legal (full HP is a deny path). */
function wound(p: Player, missingHp: number): void {
  p.health = Math.max(1, MAX_HEALTH - missingHp);
  p.alive = true;
}

Deno.test("heal() clamps to max health and returns restored amount", () => {
  const p = makePlayer();
  p.health = 90;
  assertEquals(p.heal(25), 10);
  assertEquals(p.health, MAX_HEALTH);
  assertEquals(p.heal(25), 0);
  assertEquals(p.health, MAX_HEALTH);

  p.health = 50;
  assertEquals(p.heal(25), 25);
  assertEquals(p.health, 75);

  p.alive = false;
  p.health = 50;
  assertEquals(p.heal(40), 0);
  assertEquals(p.health, 50);
});

Deno.test("heal() ignores non-positive / non-finite amounts", () => {
  const p = makePlayer();
  p.health = 50;
  assertEquals(p.heal(0), 0);
  assertEquals(p.heal(-10), 0);
  assertEquals(p.heal(Number.NaN), 0);
  assertEquals(p.health, 50);
});

Deno.test("selfHeal restores max tier HP when unrestricted (bots)", () => {
  const p = makePlayer(); // unrestricted → max tier 25
  wound(p, 50);
  assertEquals(p.health, 50);
  assertEquals(p.tryActivateAbility("selfHeal", 0), true);
  assertEquals(p.health, 75); // 50 + 25
  assertEquals(p.isAbilitySpent("selfHeal"), true);
  assertEquals(p.abilityGlobalLockEndsAtTick, instantLockTicks);
});

Deno.test("selfHeal tier I restores 15 hp", () => {
  const p = makePlayer(["selfHeal"]);
  wound(p, 40);
  assertEquals(p.health, 60);
  assertEquals(skillValueForOwned("selfHeal", ["selfHeal"]), 15);
  assertEquals(p.tryActivateAbility("selfHeal", 5), true);
  assertEquals(p.health, 75);
});

Deno.test("selfHeal tier II restores 25 hp", () => {
  const p = makePlayer(["selfHeal", "selfHeal2"]);
  wound(p, 50);
  assertEquals(p.health, 50);
  assertEquals(p.tryActivateAbility("selfHeal", 0), true);
  assertEquals(p.health, 75);
});

Deno.test("selfHeal clamps when remaining missing HP < value", () => {
  const p = makePlayer(["selfHeal"]);
  wound(p, 10);
  assertEquals(p.health, 90);
  assertEquals(p.tryActivateAbility("selfHeal", 0), true);
  assertEquals(p.health, MAX_HEALTH);
});

Deno.test("selfHeal denied at full HP (no charge spent)", () => {
  const p = makePlayer();
  assertEquals(p.health, MAX_HEALTH);
  assertEquals(p.canActivateAbility("selfHeal", 0), false);
  assertEquals(p.tryActivateAbility("selfHeal", 0), false);
  assertEquals(p.isAbilitySpent("selfHeal"), false);
  assertEquals(p.abilityGlobalLockEndsAtTick, null);
});

Deno.test("selfHeal denied when dead", () => {
  const p = makePlayer();
  wound(p, 30);
  p.alive = false;
  assertEquals(p.tryActivateAbility("selfHeal", 0), false);
  assertEquals(p.health, 70); // heal not applied
});

Deno.test("selfHeal denied when unowned (guest)", () => {
  const p = makePlayer([]);
  wound(p, 40);
  assertEquals(p.ownsAbility("selfHeal"), false);
  assertEquals(p.tryActivateAbility("selfHeal", 0), false);
  assertEquals(p.health, 60);
});

Deno.test("selfHeal denied while global lock / spent", () => {
  const p = makePlayer();
  wound(p, 60);
  assertEquals(p.tryActivateAbility("selfHeal", 0), true);
  const mid = p.health;
  assertEquals(p.tryActivateAbility("selfHeal", 1), false);
  assertEquals(p.health, mid); // no double heal

  // After lock + bar regen, charge still spent.
  const after = instantLockTicks + barRegenTicks;
  p.tickAbilityCharges(after);
  assertEquals(p.tryActivateAbility("selfHeal", after), false);
});

Deno.test("selfHeal flash for VFX without re-spend on expire", () => {
  const p = makePlayer();
  wound(p, 40);
  const tick = 10;
  assertEquals(p.tryActivateAbility("selfHeal", tick), true);
  if (INSTANT_SKILL_FLASH_TICKS > 0) {
    assertEquals(p.isAbilityActive("selfHeal", tick), true);
    p.tickAbilityCharges(tick + INSTANT_SKILL_FLASH_TICKS);
  }
  assertEquals(p.isAbilitySpent("selfHeal"), true);
});

Deno.test("door regen restores selfHeal charge", () => {
  const p = makePlayer();
  wound(p, 40);
  const tick = 0;
  assertEquals(p.tryActivateAbility("selfHeal", tick), true);
  assertEquals(p.isAbilitySpent("selfHeal"), true);

  const idle = tick + instantLockTicks + barRegenTicks;
  p.tickAbilityCharges(idle);
  p.beginAbilityDoorRegen(idle);
  p.tickAbilityCharges(idle + abilityDoorRegenTicks());
  assertEquals(p.isAbilitySpent("selfHeal"), false);

  // Can heal again after regen.
  wound(p, 30);
  assertEquals(
    p.tryActivateAbility("selfHeal", idle + abilityDoorRegenTicks()),
    true,
  );
});

Deno.test("snapshot includes selfHeal spent + health after heal", () => {
  const p = makePlayer(["selfHeal"]);
  wound(p, 40);
  const tick = 3;
  assertEquals(p.tryActivateAbility("selfHeal", tick), true);
  const full = p.toSnapshot(tick, "full");
  assertEquals(full.health, 75);
  assertEquals(full.abilitySpent?.includes("selfHeal") ?? false, true);
  assertEquals(full.abilityLockEndsAtTick, tick + instantLockTicks);
});
