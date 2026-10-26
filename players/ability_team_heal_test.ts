/**
 * Skill B — Team heal (Medic, instant, hp).
 * Run: deno test -A server/players/ability_team_heal_test.ts
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
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";
import { PlayerManager } from "./PlayerManager.ts";
import { Player } from "./Player.ts";

const instantLockTicks = instantSkillLockTicks();
const barRegenTicks = abilityBarRegenTicks();

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

function makeManager(): PlayerManager {
  return new PlayerManager(new MapCollision(miniMap));
}

function wound(p: Player, missingHp: number): void {
  p.health = Math.max(1, MAX_HEALTH - missingHp);
  p.alive = true;
}

Deno.test("teamHeal: direct Player.tryActivateAbility is incomplete (use manager)", () => {
  const p = new Player("solo", "Solo", "A", {
    spawn: { x: 0, z: 0, yaw: Math.PI },
  });
  p.spawnedAtTick = 0;
  p.restoreAbilityCharges();
  wound(p, 40);
  assertEquals(p.tryActivateAbility("teamHeal", 0), false);
  assertEquals(p.health, 60);
  assertEquals(p.isAbilitySpent("teamHeal"), false);
});

Deno.test("teamHeal: heals alive teammates, not caster or enemies", () => {
  const pm = makeManager();
  const caster = pm.add("c1", "Caster", "A");
  const ally = pm.add("a1", "Ally", "A");
  const enemy = pm.add("e1", "Enemy", "B");
  caster.spawnedAtTick = 0;
  caster.restoreAbilityCharges();
  ally.spawnedAtTick = 0;
  enemy.spawnedAtTick = 0;

  wound(caster, 50);
  wound(ally, 30);
  wound(enemy, 40);

  assertEquals(pm.handleAbility("c1", "teamHeal", 0), true);
  // Unrestricted ownership → max tier 25. Caster is never healed.
  assertEquals(caster.health, 50); // untouched
  assertEquals(ally.health, 95); // 70 + 25
  assertEquals(enemy.health, 60); // untouched
  assertEquals(caster.isAbilitySpent("teamHeal"), true);
  assertEquals(caster.abilityGlobalLockEndsAtTick, instantLockTicks);
});

Deno.test("teamHeal: tier I restores 15 hp to teammates, not caster", () => {
  const pm = makeManager();
  const caster = pm.add("c1", "Caster", "A", {
    ownedAbilities: ["selfHeal", "teamHeal"],
  });
  const ally = pm.add("a1", "Ally", "A");
  caster.spawnedAtTick = 0;
  caster.restoreAbilityCharges();
  ally.spawnedAtTick = 0;
  wound(caster, 40);
  wound(ally, 40);

  assertEquals(skillValueForOwned("teamHeal", ["teamHeal"]), 15);
  assertEquals(pm.handleAbility("c1", "teamHeal", 5), true);
  assertEquals(caster.health, 60); // untouched
  assertEquals(ally.health, 75); // 60 + 15
});

Deno.test("teamHeal: tier II restores 25 hp to teammates, not caster", () => {
  const pm = makeManager();
  const caster = pm.add("c1", "Caster", "A", {
    ownedAbilities: ["selfHeal", "teamHeal", "teamHeal2"],
  });
  const ally = pm.add("a1", "Ally", "A");
  caster.spawnedAtTick = 0;
  caster.restoreAbilityCharges();
  ally.spawnedAtTick = 0;
  wound(caster, 50);
  wound(ally, 50);

  assertEquals(pm.handleAbility("c1", "teamHeal", 0), true);
  assertEquals(caster.health, 50); // untouched
  assertEquals(ally.health, 75); // 50 + 25
});

Deno.test("teamHeal: denied when alone (no teammates to heal)", () => {
  const pm = makeManager();
  const caster = pm.add("c1", "Caster", "A");
  caster.spawnedAtTick = 0;
  caster.restoreAbilityCharges();
  wound(caster, 40);

  assertEquals(pm.handleAbility("c1", "teamHeal", 0), false);
  assertEquals(caster.health, 60);
  assertEquals(caster.isAbilitySpent("teamHeal"), false);
  assertEquals(caster.abilityGlobalLockEndsAtTick, null);
});

Deno.test("teamHeal: denied when whole team is full HP (no charge spent)", () => {
  const pm = makeManager();
  const caster = pm.add("c1", "Caster", "A");
  const ally = pm.add("a1", "Ally", "A");
  caster.spawnedAtTick = 0;
  caster.restoreAbilityCharges();
  ally.spawnedAtTick = 0;
  assertEquals(caster.health, MAX_HEALTH);
  assertEquals(ally.health, MAX_HEALTH);

  assertEquals(pm.handleAbility("c1", "teamHeal", 0), false);
  assertEquals(caster.isAbilitySpent("teamHeal"), false);
  assertEquals(caster.abilityGlobalLockEndsAtTick, null);
});

Deno.test("teamHeal: allowed when only ally is wounded (caster full)", () => {
  const pm = makeManager();
  const caster = pm.add("c1", "Caster", "A");
  const ally = pm.add("a1", "Ally", "A");
  caster.spawnedAtTick = 0;
  caster.restoreAbilityCharges();
  ally.spawnedAtTick = 0;
  wound(ally, 40);

  assertEquals(pm.handleAbility("c1", "teamHeal", 0), true);
  assertEquals(caster.health, MAX_HEALTH);
  assertEquals(ally.health, 85); // 60 + 25
  assertEquals(caster.isAbilitySpent("teamHeal"), true);
});

Deno.test("teamHeal: denied when only the caster is wounded", () => {
  const pm = makeManager();
  const caster = pm.add("c1", "Caster", "A");
  const ally = pm.add("a1", "Ally", "A");
  caster.spawnedAtTick = 0;
  caster.restoreAbilityCharges();
  ally.spawnedAtTick = 0;
  wound(caster, 40);

  assertEquals(pm.handleAbility("c1", "teamHeal", 0), false);
  assertEquals(caster.health, 60);
  assertEquals(ally.health, MAX_HEALTH);
  assertEquals(caster.isAbilitySpent("teamHeal"), false);
});

Deno.test("teamHeal: skips dead teammates", () => {
  const pm = makeManager();
  const caster = pm.add("c1", "Caster", "A");
  const ally = pm.add("a1", "Ally", "A");
  const ally2 = pm.add("a2", "Ally2", "A");
  caster.spawnedAtTick = 0;
  caster.restoreAbilityCharges();
  ally.spawnedAtTick = 0;
  ally2.spawnedAtTick = 0;
  wound(caster, 40);
  wound(ally, 40);
  ally.alive = false;
  wound(ally2, 40);

  assertEquals(pm.handleAbility("c1", "teamHeal", 0), true);
  assertEquals(caster.health, 60); // caster never healed
  assertEquals(ally.health, 60); // dead — not healed
  assertEquals(ally2.health, 85); // 60 + 25
});

Deno.test("teamHeal: skips agents on same door team", () => {
  const pm = makeManager();
  const caster = pm.add("c1", "Caster", "A");
  const agent = pm.addAgent("ag1", "Agent", "A", {
    x: 0,
    z: 0,
    yaw: 0,
  });
  const ally = pm.add("a1", "Ally", "A");
  caster.spawnedAtTick = 0;
  caster.restoreAbilityCharges();
  agent.spawnedAtTick = 0;
  ally.spawnedAtTick = 0;
  wound(caster, 40);
  wound(agent, 40);
  wound(ally, 40);

  assertEquals(pm.handleAbility("c1", "teamHeal", 0), true);
  assertEquals(caster.health, 60); // caster never healed
  assertEquals(agent.health, 60); // agent not healed
  assertEquals(ally.health, 85); // 60 + 25
});

Deno.test("teamHeal: denied when dead", () => {
  const pm = makeManager();
  const caster = pm.add("c1", "Caster", "A");
  const ally = pm.add("a1", "Ally", "A");
  caster.spawnedAtTick = 0;
  caster.restoreAbilityCharges();
  ally.spawnedAtTick = 0;
  wound(caster, 40);
  wound(ally, 40);
  caster.alive = false;

  assertEquals(pm.handleAbility("c1", "teamHeal", 0), false);
  assertEquals(caster.health, 60);
  assertEquals(ally.health, 60);
});

Deno.test("teamHeal: denied when unowned (guest)", () => {
  const pm = makeManager();
  const caster = pm.add("c1", "Caster", "A", { ownedAbilities: [] });
  const ally = pm.add("a1", "Ally", "A");
  caster.spawnedAtTick = 0;
  caster.restoreAbilityCharges();
  ally.spawnedAtTick = 0;
  wound(caster, 40);
  wound(ally, 40);

  assertEquals(caster.ownsAbility("teamHeal"), false);
  assertEquals(pm.handleAbility("c1", "teamHeal", 0), false);
  assertEquals(caster.health, 60);
  assertEquals(ally.health, 60);
});

Deno.test("teamHeal: denied while global lock / spent", () => {
  const pm = makeManager();
  const caster = pm.add("c1", "Caster", "A");
  const ally = pm.add("a1", "Ally", "A");
  caster.spawnedAtTick = 0;
  caster.restoreAbilityCharges();
  ally.spawnedAtTick = 0;
  wound(caster, 60);
  wound(ally, 60);

  assertEquals(pm.handleAbility("c1", "teamHeal", 0), true);
  const midCaster = caster.health;
  const midAlly = ally.health;
  assertEquals(pm.handleAbility("c1", "teamHeal", 1), false);
  assertEquals(caster.health, midCaster);
  assertEquals(ally.health, midAlly);

  const after = instantLockTicks + barRegenTicks;
  caster.tickAbilityCharges(after);
  assertEquals(pm.handleAbility("c1", "teamHeal", after), false);
});

Deno.test("teamHeal: flash for VFX without re-spend on expire", () => {
  const pm = makeManager();
  const caster = pm.add("c1", "Caster", "A");
  const ally = pm.add("a1", "Ally", "A");
  caster.spawnedAtTick = 0;
  caster.restoreAbilityCharges();
  ally.spawnedAtTick = 0;
  wound(ally, 40);
  const tick = 10;
  assertEquals(pm.handleAbility("c1", "teamHeal", tick), true);
  if (INSTANT_SKILL_FLASH_TICKS > 0) {
    assertEquals(caster.isAbilityActive("teamHeal", tick), true);
    caster.tickAbilityCharges(tick + INSTANT_SKILL_FLASH_TICKS);
  }
  assertEquals(caster.isAbilitySpent("teamHeal"), true);
});

Deno.test("teamHeal: door regen restores charge", () => {
  const pm = makeManager();
  const caster = pm.add("c1", "Caster", "A");
  const ally = pm.add("a1", "Ally", "A");
  caster.spawnedAtTick = 0;
  caster.restoreAbilityCharges();
  ally.spawnedAtTick = 0;
  wound(ally, 40);
  const tick = 0;
  assertEquals(pm.handleAbility("c1", "teamHeal", tick), true);
  assertEquals(caster.isAbilitySpent("teamHeal"), true);

  const idle = tick + instantLockTicks + barRegenTicks;
  caster.tickAbilityCharges(idle);
  caster.beginAbilityDoorRegen(idle);
  caster.tickAbilityCharges(idle + abilityDoorRegenTicks());
  assertEquals(caster.isAbilitySpent("teamHeal"), false);

  wound(ally, 30);
  assertEquals(
    pm.handleAbility("c1", "teamHeal", idle + abilityDoorRegenTicks()),
    true,
  );
});

Deno.test("teamHeal: snapshot includes spent; caster health unchanged", () => {
  const pm = makeManager();
  const caster = pm.add("c1", "Caster", "A", {
    ownedAbilities: ["selfHeal", "teamHeal"],
  });
  const ally = pm.add("a1", "Ally", "A");
  caster.spawnedAtTick = 0;
  caster.restoreAbilityCharges();
  ally.spawnedAtTick = 0;
  wound(caster, 40);
  wound(ally, 40);
  const tick = 3;
  assertEquals(pm.handleAbility("c1", "teamHeal", tick), true);
  const full = caster.toSnapshot(tick, "full");
  assertEquals(full.health, 60); // caster never healed
  assertEquals(ally.health, 75); // 60 + 15 (tier I)
  assertEquals(full.abilitySpent?.includes("teamHeal") ?? false, true);
  assertEquals(full.abilityLockEndsAtTick, tick + instantLockTicks);
});
