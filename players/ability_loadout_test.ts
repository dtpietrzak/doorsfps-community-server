/**
 * PR-2 — Match skill loadout (equip gates for activate + passives).
 * Run: deno test -A server/players/ability_loadout_test.ts
 */
import { assertEquals, assertExists } from "jsr:@std/assert@1";
import { MAX_HEALTH, SPAWN_INVULN_TICKS } from "../protocol/network.ts";
import { defaultSkillLoadout } from "../shared/sim/skills.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";
import { PISTOL } from "../shared/sim/weapons.ts";
import { Player } from "./Player.ts";
import { PlayerManager } from "./PlayerManager.ts";

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
  return new PlayerManager(new MapCollision(miniMap), {
    damageRandom: () => 0.5,
  });
}

const TICK = SPAWN_INVULN_TICKS + 60;

Deno.test("unrestricted (bots/tests): null loadout equips everything", () => {
  const p = new Player("b1", "Bot", "A");
  p.restoreAbilityCharges();
  assertEquals(p.snapshotSkillLoadout(), null);
  assertEquals(p.hasSkillEquipped("quick"), true);
  assertEquals(p.hasSkillEquipped("leech"), true);
  assertEquals(p.hasSkillEquipped("oneShot"), true);
  assertEquals(p.tryActivateAbility("quick", 0), true);
});

Deno.test("explicit ownership defaults loadout to first owned skills", () => {
  const p = new Player("h1", "Human", "A", {
    ownedAbilities: ["quick", "glitch", "bullets", "selfHeal", "leech"],
  });
  p.restoreAbilityCharges();
  assertEquals(
    p.snapshotSkillLoadout(),
    defaultSkillLoadout(["quick", "glitch", "bullets", "selfHeal", "leech"]),
  );
  // Tree order: quick, glitch, selfHeal, leech (bullets is 5th → not default).
  assertEquals(p.hasSkillEquipped("quick"), true);
  assertEquals(p.hasSkillEquipped("bullets"), false);
  assertEquals(p.tryActivateAbility("quick", 0), true);
  assertEquals(p.tryActivateAbility("bullets", 1000), false);
});

Deno.test("setSkillLoadout validates owned + unique + max 4", () => {
  const p = new Player("h1", "Human", "A", {
    ownedAbilities: ["quick", "glitch", "bullets", "hawkeyes", "leech"],
  });
  p.setSkillLoadout(["bullets", "leech", "nope", "quick", "glitch"]);
  p.restoreAbilityCharges();
  assertEquals(p.snapshotSkillLoadout(), [
    "bullets",
    "leech",
    null,
    "quick",
  ]);
  // Unowned / junk dropped; duplicate glitch never made it (5th slot).
  assertEquals(p.hasSkillEquipped("glitch"), false);
  assertEquals(p.hasSkillEquipped("leech"), true);
  assertEquals(p.tryActivateAbility("bullets", 0), true);
  assertEquals(p.tryActivateAbility("glitch", 1000), false);
});

Deno.test("unowned skill cannot be equipped or activated", () => {
  const p = new Player("g1", "Guest", "A", {
    ownedAbilities: ["quick"],
  });
  p.setSkillLoadout(["quick", "teleport", null, null]);
  p.restoreAbilityCharges();
  assertEquals(p.snapshotSkillLoadout(), ["quick", null, null, null]);
  assertEquals(p.ownsAbility("teleport"), false);
  assertEquals(p.tryActivateAbility("teleport", 0), false);
  assertEquals(p.tryActivateAbility("quick", 0), true);
});

Deno.test("PlayerManager.handleSkillLoadout applies client payload", () => {
  const pm = makeManager();
  const p = pm.add("h1", "Human", "A", {
    ownedAbilities: ["quick", "bullets", "selfHeal", "glitch"],
  });
  p.restoreAbilityCharges();
  const applied = pm.handleSkillLoadout("h1", [
    "selfHeal",
    "bullets",
    null,
    "quick",
  ]);
  assertEquals(applied, ["selfHeal", "bullets", null, "quick"]);
  assertEquals(p.snapshotSkillLoadout(), applied);
  p.health = MAX_HEALTH - 10;
  assertEquals(pm.handleAbility("h1", "selfHeal", 0), true);
  // Owned but not equipped → deny even after lock/regen window.
  assertEquals(p.hasSkillEquipped("glitch"), false);
  assertEquals(pm.handleAbility("h1", "glitch", 10_000), false);
  // Equipped skill works after busy window.
  assertEquals(pm.handleAbility("h1", "bullets", 10_000), true);
});

Deno.test("handleSkillLoadout ignores non-array (no unrestricted escape)", () => {
  const pm = makeManager();
  const p = pm.add("h1", "Human", "A", {
    ownedAbilities: ["quick"],
    skillLoadout: ["quick", null, null, null],
  });
  p.restoreAbilityCharges();
  const before = p.snapshotSkillLoadout();
  assertEquals(pm.handleSkillLoadout("h1", { slots: ["quick"] }), before);
  assertEquals(pm.handleSkillLoadout("h1", null), before);
  assertEquals(p.snapshotSkillLoadout(), ["quick", null, null, null]);
});

Deno.test("leech passive only while equipped", () => {
  const pm = makeManager();
  const shooter = pm.add("s1", "Shooter", "A", {
    ownedAbilities: ["selfHeal", "teamHeal", "leech"],
    skillLoadout: ["selfHeal", "teamHeal", null, null], // leech owned but not equipped
  });
  shooter.restoreAbilityCharges();
  const victim = pm.add("v1", "Enemy", "B");
  shooter.x = 0;
  shooter.y = 1.7;
  shooter.z = 5;
  shooter.yaw = 0;
  shooter.pitch = 0;
  shooter.spawnedAtTick = 0;
  shooter.health = 50;
  for (let t = TICK - 16; t <= TICK; t++) shooter.recordPose(t);
  victim.x = 0;
  victim.y = 1.7;
  victim.z = 0;
  victim.spawnedAtTick = 0;
  victim.health = 100;
  for (let t = TICK - 16; t <= TICK; t++) victim.recordPose(t);

  assertEquals(shooter.hasSkillEquipped("leech"), false);
  const noLeech = pm.handleShoot("s1", TICK, {
    yaw: 0,
    pitch: 0,
    clientTick: TICK,
    origin: [0, 1.7, 5],
  });
  assertExists(noLeech);
  assertEquals(shooter.health, 50);

  // Equip leech and shoot again (need fire cooldown gap).
  shooter.setSkillLoadout(["leech", null, null, null]);
  assertEquals(shooter.hasSkillEquipped("leech"), true);
  const later = TICK + 60;
  for (let t = later - 16; t <= later; t++) {
    shooter.recordPose(t);
    victim.recordPose(t);
  }
  victim.health = 100;
  const withLeech = pm.handleShoot("s1", later, {
    yaw: 0,
    pitch: 0,
    clientTick: later,
    origin: [0, 1.7, 5],
  });
  assertExists(withLeech);
  // Tier I 10%: floor(head * 0.10)
  const expected = 50 + Math.floor(PISTOL.headDamage * 0.1);
  assertEquals(shooter.health, expected);
});

Deno.test("setOwnedAbilities re-normalizes loadout (drops unowned)", () => {
  const p = new Player("h1", "Human", "A", {
    ownedAbilities: ["quick", "glitch"],
    skillLoadout: ["quick", "glitch", null, null],
  });
  p.setOwnedAbilities(["quick"]);
  assertEquals(p.snapshotSkillLoadout(), ["quick", null, null, null]);
  assertEquals(p.hasSkillEquipped("glitch"), false);
});
