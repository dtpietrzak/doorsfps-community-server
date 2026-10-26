import { assertEquals, assertExists } from "jsr:@std/assert@1";
import {
  SKILL_CATEGORIES,
  SKILL_CATEGORY_ORDER,
  SKILL_DEFS,
  SKILL_ORDER,
  SKILL_PRODUCT_ORDER,
  SKILL_PRODUCTS,
  SKILL_LOADOUT_SLOTS,
  INSTANT_SKILL_LOCK_S,
  availableSkillsForLoadoutSlot,
  canAddSkillToLoadout,
  canPurchaseSkillProduct,
  canUnlockSkillProduct,
  clearSkillLoadoutSlot,
  coinCostForSkillProduct,
  defaultSkillLoadout,
  emptyOwnedSkills,
  emptySkillLoadout,
  getSkillDef,
  getSkillProduct,
  highestOwnedSkillTier,
  instantSkillLockTicks,
  skillValueForOwned,
  isInstantSkill,
  isPassiveSkill,
  isSkillActivatable,
  isSkillEquipped,
  isSkillId,
  isSkillProductCombatReady,
  isSkillProductId,
  isSkillProductOwned,
  isTimedSkill,
  normalizeOwnedSkills,
  normalizeSkillLoadout,
  ownedSkillsForLevel,
  ownsSkill,
  parseOwnedSkillsColumn,
  parseSkillLoadoutColumn,
  prerequisitesForSkillProduct,
  productsForSkill,
  serializeOwnedSkills,
  serializeSkillLoadout,
  setSkillLoadoutSlot,
  skillKindTag,
  skillLoadoutEquippedCount,
  skillLockMessage,
  skillPlanForTargets,
  skillProductId,
  timedSkillDurationSForOwned,
  toggleSkillInLoadout,
  withOwnedSkill,
  withoutOwnedSkill,
  type SkillId,
  type SkillLoadout,
  type SkillProductId,
} from "./skills.ts";
import {
  ABILITY_DEFS,
  ABILITY_ORDER,
  ABILITY_PRODUCT_ORDER,
  ABILITY_PRODUCTS,
  ABILITY_TIER_DURATION_S,
  coinCostForAbility,
  durationSForOwned,
  minLevelForAbility,
} from "./abilities.ts";

Deno.test("categories are Hacker · Medic · Marksman", () => {
  assertEquals([...SKILL_CATEGORY_ORDER], ["hacker", "medic", "marksman"]);
  assertEquals([...SKILL_CATEGORIES.hacker.skills], [
    "quick",
    "glitch",
    "rewind",
    "teleport",
  ]);
  assertEquals([...SKILL_CATEGORIES.medic.skills], [
    "selfHeal",
    "teamHeal",
    "leech",
    "forceField",
  ]);
  assertEquals([...SKILL_CATEGORIES.marksman.skills], [
    "bullets",
    "hawkeyes",
    "rapidFire",
    "oneShot",
  ]);
});

Deno.test("medic max tier II; hacker and marksman max tier III", () => {
  for (const id of SKILL_CATEGORIES.medic.skills) {
    assertEquals(SKILL_DEFS[id].maxTier, 2);
    assertEquals(productsForSkill(id).length, 2);
  }
  for (const id of [
    ...SKILL_CATEGORIES.hacker.skills,
    ...SKILL_CATEGORIES.marksman.skills,
  ]) {
    assertEquals(SKILL_DEFS[id].maxTier, 3);
    assertEquals(productsForSkill(id).length, 3);
  }
});

Deno.test("every product has unique id and matches skill/tier", () => {
  const seen = new Set<string>();
  for (const id of SKILL_PRODUCT_ORDER) {
    assertEquals(seen.has(id), false);
    seen.add(id);
    const p = SKILL_PRODUCTS[id];
    assertExists(p);
    assertEquals(p.id, id);
    assertEquals(isSkillProductId(id), true);
    assertEquals(isSkillId(p.skill), true);
    assertEquals(p.label.length > 0, true);
    assertEquals(p.minLevel >= 2, true);
    assertEquals(p.value > 0, true);
  }
  assertEquals(SKILL_PRODUCT_ORDER.length, seen.size);
  // 4 hacker × 3 + 4 medic × 2 + 4 marksman × 3 = 12 + 8 + 12 = 32
  assertEquals(SKILL_PRODUCT_ORDER.length, 32);
});

Deno.test("chain requiresSkill points to previous skill in category", () => {
  for (const cat of SKILL_CATEGORY_ORDER) {
    const skills = SKILL_CATEGORIES[cat].skills;
    for (let i = 0; i < skills.length; i++) {
      const def = getSkillDef(skills[i]!);
      if (i === 0) {
        assertEquals(def.requiresSkill, null);
      } else {
        assertEquals(def.requiresSkill, skills[i - 1]!);
      }
    }
  }
});

Deno.test("tier products require previous tier", () => {
  assertEquals(getSkillProduct("quick").requires, null);
  assertEquals(getSkillProduct("quick2").requires, "quick");
  assertEquals(getSkillProduct("quick3").requires, "quick2");
  assertEquals(getSkillProduct("selfHeal2").requires, "selfHeal");
  assertEquals(getSkillProduct("leech2").requires, "leech");
});

Deno.test("minLevel schedule matches design table", () => {
  const expect: Record<string, number> = {
    quick: 2,
    bullets: 3,
    selfHeal: 4,
    glitch: 5,
    hawkeyes: 5,
    quick2: 6,
    bullets2: 6,
    teamHeal: 7,
    glitch2: 8,
    hawkeyes2: 8,
    rewind: 9,
    rapidFire: 9,
    quick3: 10,
    bullets3: 10,
    selfHeal2: 11,
    glitch3: 12,
    hawkeyes3: 12,
    rewind2: 13,
    rapidFire2: 13,
    leech: 14,
    teleport: 15,
    oneShot: 15,
    rewind3: 16,
    rapidFire3: 16,
    teamHeal2: 17,
    teleport2: 17,
    oneShot2: 17,
    forceField: 18,
    leech2: 19,
    teleport3: 19,
    oneShot3: 19,
    forceField2: 20,
  };
  for (const [id, level] of Object.entries(expect)) {
    assertEquals(
      getSkillProduct(id as SkillProductId).minLevel,
      level,
      `${id} minLevel`,
    );
  }
});

Deno.test("PR-1 activation helpers: activatable / timed / instant / passive", () => {
  assertEquals(isSkillActivatable("quick"), true);
  assertEquals(isSkillActivatable("selfHeal"), true);
  assertEquals(isSkillActivatable("leech"), false);
  assertEquals(isTimedSkill("quick"), true);
  assertEquals(isTimedSkill("forceField"), true);
  assertEquals(isInstantSkill("rewind"), true);
  assertEquals(isPassiveSkill("leech"), true);
  assertEquals(timedSkillDurationSForOwned("forceField", null), 2);
  assertEquals(timedSkillDurationSForOwned("forceField", ["forceField"]), 1);
  assertEquals(timedSkillDurationSForOwned("selfHeal", null), 0);
  assertEquals(instantSkillLockTicks(60), INSTANT_SKILL_LOCK_S * 60);
});

Deno.test("skillValueForOwned: selfHeal tiers + unrestricted max", () => {
  assertEquals(skillValueForOwned("selfHeal", null), 25);
  assertEquals(skillValueForOwned("selfHeal", undefined), 25);
  assertEquals(skillValueForOwned("selfHeal", []), 0);
  assertEquals(skillValueForOwned("selfHeal", ["selfHeal"]), 15);
  assertEquals(skillValueForOwned("selfHeal", ["selfHeal", "selfHeal2"]), 25);
  assertEquals(skillValueForOwned("selfHeal", ["selfHeal2"]), 25); // orphan tier
});

Deno.test("skillValueForOwned: teamHeal tiers + unrestricted max", () => {
  assertEquals(skillValueForOwned("teamHeal", null), 25);
  assertEquals(skillValueForOwned("teamHeal", undefined), 25);
  assertEquals(skillValueForOwned("teamHeal", []), 0);
  assertEquals(skillValueForOwned("teamHeal", ["teamHeal"]), 15);
  assertEquals(skillValueForOwned("teamHeal", ["teamHeal", "teamHeal2"]), 25);
  assertEquals(skillValueForOwned("teamHeal", ["teamHeal2"]), 25);
});

Deno.test("skillValueForOwned: leech tiers + unrestricted max", () => {
  assertEquals(skillValueForOwned("leech", null), 0.15);
  assertEquals(skillValueForOwned("leech", undefined), 0.15);
  assertEquals(skillValueForOwned("leech", []), 0);
  assertEquals(skillValueForOwned("leech", ["leech"]), 0.1);
  assertEquals(skillValueForOwned("leech", ["leech", "leech2"]), 0.15);
  assertEquals(skillValueForOwned("leech", ["leech2"]), 0.15); // orphan tier
});

Deno.test("isSkillId / isSkillProductId", () => {
  assertEquals(isSkillId("quick"), true);
  assertEquals(isSkillId("rapidFire"), true);
  assertEquals(isSkillId("quick2"), false);
  assertEquals(isSkillId(null), false);
  assertEquals(isSkillProductId("quick"), true);
  assertEquals(isSkillProductId("quick2"), true);
  assertEquals(isSkillProductId("oneShot3"), true);
  assertEquals(isSkillProductId("selfHeal2"), true);
  assertEquals(isSkillProductId("nope"), false);
  assertEquals(isSkillProductId("quick1"), false);
});

Deno.test("cannot unlock glitch without quick I; can unlock quick II without glitch", () => {
  assertEquals(canUnlockSkillProduct("glitch", 5, []), false);
  assertEquals(
    canUnlockSkillProduct("glitch", 5, ["quick"]),
    true,
  );
  assertEquals(
    canUnlockSkillProduct("quick2", 6, ["quick"]),
    true,
  );
  assertEquals(
    canUnlockSkillProduct("quick2", 6, []),
    false,
  );
  // quick II is level 6 — still locked at 5 even with quick I.
  assertEquals(
    canUnlockSkillProduct("quick2", 5, ["quick"]),
    false,
  );
});

Deno.test("cannot unlock tier II without tier I", () => {
  assertEquals(canUnlockSkillProduct("bullets2", 6, []), false);
  assertEquals(
    canUnlockSkillProduct("bullets2", 6, ["bullets"]),
    true,
  );
});

Deno.test("level 1 owns nothing; level 15 includes mid/tops available at 15", () => {
  assertEquals(ownedSkillsForLevel(1), []);
  const at15 = ownedSkillsForLevel(15);
  assertEquals(at15.includes("teleport"), true);
  assertEquals(at15.includes("oneShot"), true);
  assertEquals(at15.includes("leech"), true);
  assertEquals(at15.includes("teleport2"), false);
  assertEquals(at15.includes("oneShot2"), false);
  assertEquals(at15.includes("leech2"), false);
  assertEquals(at15.includes("forceField"), false);
  assertEquals(at15.includes("quick3"), true);
  assertEquals(at15.length, 22);
});

Deno.test("level 20 includes force field II", () => {
  const at20 = ownedSkillsForLevel(20);
  assertEquals(at20.includes("forceField"), true);
  assertEquals(at20.includes("forceField2"), true);
  assertEquals(at20.length, 32);
});

Deno.test("level 5 legal set matches table (with prereqs)", () => {
  const at5 = ownedSkillsForLevel(5);
  assertEquals(at5.includes("quick"), true);
  assertEquals(at5.includes("quick2"), false); // L6
  assertEquals(at5.includes("glitch"), true);
  assertEquals(at5.includes("bullets"), true);
  assertEquals(at5.includes("bullets2"), false); // L6
  assertEquals(at5.includes("hawkeyes"), true);
  assertEquals(at5.includes("selfHeal"), true);
  assertEquals(at5.includes("teamHeal"), false); // L7
  assertEquals(at5.includes("quick3"), false);
  assertEquals(at5.includes("glitch2"), false); // L8
});

Deno.test("skillLockMessage explains level and prereqs", () => {
  assertEquals(
    skillLockMessage("quick", 1, []),
    "Reach level 2 to unlock Quick I",
  );
  assertEquals(
    skillLockMessage("glitch", 5, []),
    "Unlock Quick I first",
  );
  assertEquals(
    skillLockMessage("quick2", 6, []),
    "Unlock Quick I first",
  );
  assertEquals(
    skillLockMessage("quick2", 5, ["quick"]),
    "Reach level 6 to unlock Quick II",
  );
  assertEquals(skillLockMessage("quick", 2, ["quick"]), null);
});

Deno.test("withOwnedSkill / withoutOwnedSkill cascade", () => {
  let owned = emptyOwnedSkills();
  owned = withOwnedSkill(owned, "quick");
  owned = withOwnedSkill(owned, "glitch");
  owned = withOwnedSkill(owned, "glitch2");
  assertEquals(ownsSkill("glitch", owned), true);
  assertEquals(highestOwnedSkillTier("glitch", owned), 2);

  // Dropping glitch I drops glitch II and downstream rewind/teleport if any.
  owned = withOwnedSkill(owned, "rewind");
  owned = withoutOwnedSkill(owned, "glitch");
  assertEquals(isSkillProductOwned("glitch", owned), false);
  assertEquals(isSkillProductOwned("glitch2", owned), false);
  assertEquals(isSkillProductOwned("rewind", owned), false);
  assertEquals(isSkillProductOwned("quick", owned), true);
});

Deno.test("normalizeOwnedSkills drops junk and orders", () => {
  assertEquals(
    normalizeOwnedSkills(["nope", "quick2", "quick", "quick"]),
    ["quick", "quick2"],
  );
  assertEquals(normalizeOwnedSkills({ quick: true, bullets: true }), [
    "quick",
    "bullets",
  ]);
});

Deno.test("skillKindTag matches design tags", () => {
  assertEquals(skillKindTag(getSkillDef("quick")), "(t)");
  assertEquals(skillKindTag(getSkillDef("rewind")), "(i-time)");
  assertEquals(skillKindTag(getSkillDef("teleport")), "(i-distance)");
  assertEquals(skillKindTag(getSkillDef("selfHeal")), "(i-hp)");
  assertEquals(skillKindTag(getSkillDef("leech")), "(p-hp/damage)");
});

Deno.test("skillProductId helper", () => {
  assertEquals(skillProductId("quick", 1), "quick");
  assertEquals(skillProductId("quick", 3), "quick3");
  assertEquals(skillProductId("rapidFire", 2), "rapidFire2");
});

Deno.test("coin costs: classic four + tree; tiers 1× / 2× / 4×", () => {
  // Classic timed four (single catalog in skills.ts).
  assertEquals(coinCostForSkillProduct("quick"), 25);
  assertEquals(coinCostForSkillProduct("quick2"), 50);
  assertEquals(coinCostForSkillProduct("quick3"), 100);
  assertEquals(coinCostForSkillProduct("bullets"), 40);
  assertEquals(coinCostForSkillProduct("bullets2"), 80);
  assertEquals(coinCostForSkillProduct("bullets3"), 160);
  assertEquals(coinCostForSkillProduct("glitch"), 50);
  assertEquals(coinCostForSkillProduct("glitch2"), 100);
  assertEquals(coinCostForSkillProduct("glitch3"), 200);
  assertEquals(coinCostForSkillProduct("hawkeyes"), 60);
  assertEquals(coinCostForSkillProduct("hawkeyes2"), 120);
  assertEquals(coinCostForSkillProduct("hawkeyes3"), 240);

  // New chain nodes — higher bases further down the tree.
  assertEquals(coinCostForSkillProduct("rewind"), 75);
  assertEquals(coinCostForSkillProduct("rewind2"), 150);
  assertEquals(coinCostForSkillProduct("teleport"), 100);
  assertEquals(coinCostForSkillProduct("selfHeal"), 30);
  assertEquals(coinCostForSkillProduct("selfHeal2"), 60);
  assertEquals(coinCostForSkillProduct("teamHeal"), 50);
  assertEquals(coinCostForSkillProduct("leech"), 70);
  assertEquals(coinCostForSkillProduct("forceField"), 90);
  assertEquals(coinCostForSkillProduct("forceField2"), 180);
  assertEquals(coinCostForSkillProduct("rapidFire"), 80);
  assertEquals(coinCostForSkillProduct("oneShot"), 100);
  assertEquals(coinCostForSkillProduct("oneShot3"), 400);
  assertEquals(coinCostForSkillProduct("nope"), 0);

  for (const id of SKILL_PRODUCT_ORDER) {
    const p = SKILL_PRODUCTS[id];
    assertEquals(p.coinCost > 0, true, `${id} coinCost`);
    assertEquals(p.coinCost, coinCostForSkillProduct(id));
  }
});

Deno.test("canPurchaseSkillProduct gates combat-ready + tree prereqs", () => {
  // Live product with full unlock path.
  assertEquals(canPurchaseSkillProduct("quick", 2, []), true);
  assertEquals(canPurchaseSkillProduct("quick", 1, []), false);
  assertEquals(canPurchaseSkillProduct("quick2", 6, ["quick"]), true);
  assertEquals(canPurchaseSkillProduct("quick2", 6, []), false);
  assertEquals(canPurchaseSkillProduct("quick2", 5, ["quick"]), false);

  // Glitch needs Quick I in the tree.
  assertEquals(canPurchaseSkillProduct("glitch", 5, []), false);
  assertEquals(canPurchaseSkillProduct("glitch", 5, ["quick"]), true);

  // Hawkeyes needs Bullets I.
  assertEquals(canPurchaseSkillProduct("hawkeyes", 5, []), false);
  assertEquals(
    canPurchaseSkillProduct("hawkeyes", 5, ["bullets"]),
    true,
  );

  // Self heal + team heal + leech are combat-ready; other future products gated.
  assertEquals(isSkillProductCombatReady("selfHeal"), true);
  assertEquals(canUnlockSkillProduct("selfHeal", 4, []), true);
  assertEquals(canPurchaseSkillProduct("selfHeal", 4, []), true);
  assertEquals(canPurchaseSkillProduct("selfHeal2", 11, ["selfHeal"]), true);
  assertEquals(isSkillProductCombatReady("teamHeal"), true);
  assertEquals(canUnlockSkillProduct("teamHeal", 7, ["selfHeal"]), true);
  assertEquals(canPurchaseSkillProduct("teamHeal", 7, ["selfHeal"]), true);
  assertEquals(
    canPurchaseSkillProduct("teamHeal2", 17, ["selfHeal", "teamHeal"]),
    true,
  );
  // Team heal needs selfHeal I in the tree.
  assertEquals(canPurchaseSkillProduct("teamHeal", 7, []), false);
  assertEquals(isSkillProductCombatReady("leech"), true);
  assertEquals(
    canUnlockSkillProduct("leech", 14, ["selfHeal", "teamHeal"]),
    true,
  );
  assertEquals(
    canPurchaseSkillProduct("leech", 14, ["selfHeal", "teamHeal"]),
    true,
  );
  assertEquals(
    canPurchaseSkillProduct("leech2", 19, ["selfHeal", "teamHeal", "leech"]),
    true,
  );
  // Leech needs teamHeal I in the tree.
  assertEquals(canPurchaseSkillProduct("leech", 14, ["selfHeal"]), false);
  assertEquals(canUnlockSkillProduct("rewind", 9, ["quick", "glitch"]), true);
  assertEquals(
    canPurchaseSkillProduct("rewind", 9, ["quick", "glitch"]),
    true,
  );
  assertEquals(isSkillProductCombatReady("rewind"), true);
  assertEquals(isSkillProductCombatReady("rewind2"), true);
  assertEquals(isSkillProductCombatReady("rewind3"), true);
  assertEquals(
    canUnlockSkillProduct("teleport", 15, ["quick", "glitch", "rewind"]),
    true,
  );
  assertEquals(
    canPurchaseSkillProduct("teleport", 15, ["quick", "glitch", "rewind"]),
    true,
  );
  assertEquals(isSkillProductCombatReady("teleport"), true);
  assertEquals(isSkillProductCombatReady("teleport2"), true);
  assertEquals(isSkillProductCombatReady("teleport3"), true);
  // Teleport needs rewind I in the tree.
  assertEquals(
    canPurchaseSkillProduct("teleport", 15, ["quick", "glitch"]),
    false,
  );
  assertEquals(
    canUnlockSkillProduct("rapidFire", 9, ["bullets", "hawkeyes"]),
    true,
  );
  assertEquals(
    canPurchaseSkillProduct("rapidFire", 9, ["bullets", "hawkeyes"]),
    true,
  );
  assertEquals(isSkillProductCombatReady("rapidFire"), true);
  assertEquals(isSkillProductCombatReady("rapidFire2"), true);
  assertEquals(isSkillProductCombatReady("rapidFire3"), true);
  // Rapid fire needs hawkeyes I in the tree.
  assertEquals(
    canPurchaseSkillProduct("rapidFire", 9, ["bullets"]),
    false,
  );
  assertEquals(
    canUnlockSkillProduct("oneShot", 15, [
      "bullets",
      "hawkeyes",
      "rapidFire",
    ]),
    true,
  );
  assertEquals(
    canPurchaseSkillProduct("oneShot", 15, [
      "bullets",
      "hawkeyes",
      "rapidFire",
    ]),
    true,
  );
  assertEquals(isSkillProductCombatReady("oneShot"), true);
  assertEquals(isSkillProductCombatReady("oneShot2"), true);
  assertEquals(isSkillProductCombatReady("oneShot3"), true);
  // One-shot needs rapid fire I in the tree.
  assertEquals(
    canPurchaseSkillProduct("oneShot", 15, ["bullets", "hawkeyes"]),
    false,
  );

  // Live combat-ready families (full 12-skill tree).
  for (const id of [
    "quick",
    "glitch",
    "bullets",
    "hawkeyes",
    "selfHeal",
    "teamHeal",
    "leech",
    "forceField",
    "rewind",
    "teleport",
    "rapidFire",
    "oneShot",
  ] as const) {
    assertEquals(isSkillProductCombatReady(id), true);
  }
});

Deno.test("parseOwnedSkillsColumn keeps full skill product set", () => {
  const mixed = [
    "quick",
    "selfHeal",
    "nope",
    "rapidFire2",
    "bullets",
    "selfHeal",
  ];
  assertEquals(normalizeOwnedSkills(mixed), [
    "quick",
    "selfHeal",
    "bullets",
    "rapidFire2",
  ]);
  const json = serializeOwnedSkills(["selfHeal2", "quick", "forceField"]);
  assertEquals(parseOwnedSkillsColumn(json), [
    "quick",
    "selfHeal2",
    "forceField",
  ]);
  assertEquals(parseOwnedSkillsColumn("[]"), []);
  assertEquals(parseOwnedSkillsColumn(null), []);
});

Deno.test("prerequisitesForSkillProduct walks tier + chain", () => {
  assertEquals(prerequisitesForSkillProduct("quick"), ["quick"]);
  assertEquals(prerequisitesForSkillProduct("glitch"), ["quick", "glitch"]);
  assertEquals(prerequisitesForSkillProduct("glitch2"), [
    "quick",
    "glitch",
    "glitch2",
  ]);
  // Chain gate only needs prior skill tier I; higher tiers of earlier skills
  // are not required unless those tiers are themselves goals.
  assertEquals(prerequisitesForSkillProduct("teleport"), [
    "quick",
    "glitch",
    "rewind",
    "teleport",
  ]);
  assertEquals(prerequisitesForSkillProduct("teleport3"), [
    "quick",
    "glitch",
    "rewind",
    "teleport",
    "teleport2",
    "teleport3",
  ]);
  // Same-skill higher tier only pulls prior tiers of that skill (+ chain roots).
  assertEquals(prerequisitesForSkillProduct("selfHeal2"), [
    "selfHeal",
    "selfHeal2",
  ]);
  assertEquals(prerequisitesForSkillProduct("forceField"), [
    "selfHeal",
    "teamHeal",
    "leech",
    "forceField",
  ]);
  assertEquals(prerequisitesForSkillProduct("not-real"), []);
});

Deno.test("skillPlanForTargets unions goals and subtracts owned", () => {
  const empty = skillPlanForTargets([]);
  assertEquals(empty.path, []);
  assertEquals(empty.missing, []);
  assertEquals(empty.totalCoins, 0);
  assertEquals(empty.requiredLevel, 1);

  const single = skillPlanForTargets(["glitch2"]);
  assertEquals(single.path, ["quick", "glitch", "glitch2"]);
  assertEquals(single.missing, single.path);
  assertEquals(
    single.totalCoins,
    coinCostForSkillProduct("quick") +
      coinCostForSkillProduct("glitch") +
      coinCostForSkillProduct("glitch2"),
  );
  assertEquals(
    single.requiredLevel,
    Math.max(
      SKILL_PRODUCTS.quick.minLevel,
      SKILL_PRODUCTS.glitch.minLevel,
      SKILL_PRODUCTS.glitch2.minLevel,
    ),
  );

  // Multi-tree goals: union unique products.
  const multi = skillPlanForTargets(["glitch", "selfHeal2"]);
  assertEquals(multi.path, ["quick", "glitch", "selfHeal", "selfHeal2"]);

  // Owned subtraction.
  const partial = skillPlanForTargets(["glitch2"], ["quick", "glitch"]);
  assertEquals(partial.path, ["quick", "glitch", "glitch2"]);
  assertEquals(partial.missing, ["glitch2"]);
  assertEquals(partial.totalCoins, coinCostForSkillProduct("glitch2"));
  assertEquals(partial.requiredLevel, SKILL_PRODUCTS.glitch2.minLevel);

  // Fully owned path → zero cost, level 1 placeholder.
  const done = skillPlanForTargets(["glitch"], ["quick", "glitch"]);
  assertEquals(done.missing, []);
  assertEquals(done.totalCoins, 0);
  assertEquals(done.requiredLevel, 1);

  // Invalid targets ignored.
  assertEquals(skillPlanForTargets(["nope" as SkillProductId]).path, []);
});

Deno.test("SKILL_ORDER covers every def", () => {
  assertEquals(SKILL_ORDER.length, 12);
  for (const id of SKILL_ORDER) {
    assertExists(SKILL_DEFS[id]);
  }
});

Deno.test("ownsSkill treats null as unrestricted; empty as guest", () => {
  assertEquals(ownsSkill("quick", null), true);
  assertEquals(ownsSkill("leech", undefined), true);
  assertEquals(ownsSkill("quick", []), false);
  assertEquals(ownsSkill("quick", ["quick"]), true);
  assertEquals(ownsSkill("notASkill" as SkillId, null), false);
});

Deno.test("isSkillEquipped treats null loadout as unrestricted", () => {
  assertEquals(isSkillEquipped("quick", null), true);
  assertEquals(isSkillEquipped("leech", undefined), true);
  assertEquals(isSkillEquipped("quick", [null, null, null, null]), false);
  assertEquals(
    isSkillEquipped("leech", ["quick", "leech", null, null]),
    true,
  );
  assertEquals(
    isSkillEquipped("bullets", ["quick", "leech", null, null]),
    false,
  );
});

Deno.test("serialize/parse skill loadout column: null means unset", () => {
  assertEquals(parseSkillLoadoutColumn(null), null);
  assertEquals(parseSkillLoadoutColumn(undefined), null);
  assertEquals(parseSkillLoadoutColumn(""), null);
  assertEquals(parseSkillLoadoutColumn("not-json"), null);
  assertEquals(parseSkillLoadoutColumn("{}"), null);
  assertEquals(
    parseSkillLoadoutColumn(["quick", "glitch", null, "nope"]),
    ["quick", "glitch", null, null],
  );
  assertEquals(
    parseSkillLoadoutColumn(serializeSkillLoadout(["leech", null, "quick"])),
    ["leech", null, "quick", null],
  );
  assertEquals(
    parseSkillLoadoutColumn(serializeSkillLoadout(emptySkillLoadout())),
    emptySkillLoadout(),
  );
});

Deno.test("defaultSkillLoadout with unrestricted packs first 4 tree skills", () => {
  assertEquals(defaultSkillLoadout(null).length, SKILL_LOADOUT_SLOTS);
  assertEquals(defaultSkillLoadout(null), [
    SKILL_ORDER[0],
    SKILL_ORDER[1],
    SKILL_ORDER[2],
    SKILL_ORDER[3],
  ]);
});

Deno.test("skill loadout is max 4 unique owned skills including passives", () => {
  const owned: SkillProductId[] = [
    "quick",
    "glitch",
    "bullets",
    "hawkeyes",
    "selfHeal",
    "leech",
  ];
  assertEquals(SKILL_LOADOUT_SLOTS, 4);
  assertEquals(defaultSkillLoadout(owned), [
    "quick",
    "glitch",
    "selfHeal",
    "leech",
  ]);
  assertEquals(emptySkillLoadout(), [null, null, null, null]);
  assertEquals(
    normalizeSkillLoadout(
      ["leech", "quick", "nope", "quick", "bullets", "hawkeyes", "glitch"],
      owned,
    ),
    ["leech", "quick", null, null],
  );
  // Drops unowned / keeps sparse holes / pads to 4.
  assertEquals(
    normalizeSkillLoadout(["teleport", "quick", "leech"], ["quick", "leech"]),
    [null, "quick", "leech", null],
  );
  assertEquals(
    normalizeSkillLoadout([null, "quick", null, "glitch"], owned),
    [null, "quick", null, "glitch"],
  );

  let loadout = defaultSkillLoadout(owned);
  assertEquals(canAddSkillToLoadout(loadout, "bullets", owned), false); // full
  loadout = toggleSkillInLoadout(loadout, "leech", owned); // clear its slot
  assertEquals(loadout.includes("leech"), false);
  assertEquals(loadout, ["quick", "glitch", "selfHeal", null]);
  assertEquals(canAddSkillToLoadout(loadout, "bullets", owned), true);
  loadout = toggleSkillInLoadout(loadout, "bullets", owned);
  assertEquals(loadout.includes("bullets"), true);
  assertEquals(skillLoadoutEquippedCount(loadout), 4);
  // Full again — add fails.
  assertEquals(
    toggleSkillInLoadout(loadout, "hawkeyes", owned),
    loadout,
  );
  loadout = clearSkillLoadoutSlot(loadout, 0, owned);
  assertEquals(loadout, [null, "glitch", "selfHeal", "bullets"]);
  assertEquals(skillLoadoutEquippedCount(loadout), 3);
  // Unowned cannot be added.
  assertEquals(
    toggleSkillInLoadout(emptySkillLoadout(), "teleport", owned),
    emptySkillLoadout(),
  );
});

Deno.test("loadout slot picker lists owned, free, highest-tier skills only", () => {
  const owned: SkillProductId[] = [
    "quick",
    "quick2",
    "glitch",
    "bullets",
    "bullets3",
    "selfHeal",
  ];
  const loadout: SkillLoadout = ["quick", "glitch", null, null];

  // Slot 0 keeps current selection; excludes glitch (other slot).
  assertEquals(availableSkillsForLoadoutSlot(loadout, 0, owned), [
    "quick",
    "selfHeal",
    "bullets",
  ]);
  // Empty slot excludes both equipped skills.
  assertEquals(availableSkillsForLoadoutSlot(loadout, 2, owned), [
    "selfHeal",
    "bullets",
  ]);
  // Unowned never listed; only one entry per skill (not tier products).
  assertEquals(
    availableSkillsForLoadoutSlot(emptySkillLoadout(), 0, ["quick", "quick2"]),
    ["quick"],
  );
  assertEquals(highestOwnedSkillTier("bullets", owned), 3);
  assertEquals(highestOwnedSkillTier("quick", owned), 2);
});

Deno.test("setSkillLoadoutSlot replaces, fills holes, moves, and clears", () => {
  const owned: SkillProductId[] = [
    "quick",
    "glitch",
    "bullets",
    "hawkeyes",
    "selfHeal",
  ];
  // Slot 2 alone — slot 1 stays empty.
  assertEquals(setSkillLoadoutSlot(emptySkillLoadout(), 2, "quick", owned), [
    null,
    null,
    "quick",
    null,
  ]);
  assertEquals(setSkillLoadoutSlot(["quick", null, null, null], 1, "glitch", owned), [
    "quick",
    "glitch",
    null,
    null,
  ]);
  assertEquals(
    setSkillLoadoutSlot(["quick", "glitch", null, null], 0, "bullets", owned),
    ["bullets", "glitch", null, null],
  );
  // Move equipped skill to another slot (leaves a hole).
  assertEquals(
    setSkillLoadoutSlot(
      ["quick", "glitch", "bullets", null],
      0,
      "bullets",
      owned,
    ),
    ["bullets", "glitch", null, null],
  );
  assertEquals(
    setSkillLoadoutSlot(["quick", "glitch", null, null], 1, null, owned),
    ["quick", null, null, null],
  );
  // Unowned / OOB no-ops.
  assertEquals(
    setSkillLoadoutSlot(["quick", null, null, null], 0, "teleport", owned),
    ["quick", null, null, null],
  );
  assertEquals(
    setSkillLoadoutSlot(["quick", null, null, null], 9, "glitch", owned),
    ["quick", null, null, null],
  );
});

Deno.test("forceField is medic invincibility I@18 / II@20", () => {
  const def = getSkillDef("forceField");
  assertEquals(def.category, "medic");
  assertEquals(def.requiresSkill, "leech");
  assertEquals(def.maxTier, 2);
  assertEquals(def.kind, "timed");
  const p1 = getSkillProduct("forceField");
  assertEquals(p1.label, "Force Field I");
  assertEquals(p1.minLevel, 18);
  assertEquals(p1.value, 1);
  assertEquals(p1.blurb, "Invincible for 1s.");
  const p2 = getSkillProduct("forceField2");
  assertEquals(p2.label, "Force Field II");
  assertEquals(p2.minLevel, 20);
  assertEquals(p2.value, 2);
  assertEquals(p2.requires, "forceField");
  assertEquals(p2.blurb, "Invincible for 2s.");
  assertEquals(
    canUnlockSkillProduct("forceField", 18, [
      "selfHeal",
      "teamHeal",
      "leech",
    ]),
    true,
  );
  assertEquals(
    canUnlockSkillProduct("forceField", 17, [
      "selfHeal",
      "teamHeal",
      "leech",
    ]),
    false,
  );
  assertEquals(
    canUnlockSkillProduct("forceField2", 20, [
      "selfHeal",
      "teamHeal",
      "leech",
      "forceField",
    ]),
    true,
  );
});

Deno.test("oneShot is marksman timed kill window I@15 / II@17 / III@19", () => {
  const def = getSkillDef("oneShot");
  assertEquals(def.category, "marksman");
  assertEquals(def.requiresSkill, "rapidFire");
  assertEquals(def.maxTier, 3);
  assertEquals(def.kind, "timed");
  assertEquals(def.scale, "duration");
  const p1 = getSkillProduct("oneShot");
  assertEquals(p1.label, "One-shot I");
  assertEquals(p1.minLevel, 15);
  assertEquals(p1.value, 2);
  assertEquals(p1.blurb, "One shot = kill while active for 2s.");
  const p2 = getSkillProduct("oneShot2");
  assertEquals(p2.label, "One-shot II");
  assertEquals(p2.minLevel, 17);
  assertEquals(p2.value, 2.5);
  assertEquals(p2.requires, "oneShot");
  const p3 = getSkillProduct("oneShot3");
  assertEquals(p3.label, "One-shot III");
  assertEquals(p3.minLevel, 19);
  assertEquals(p3.value, 3);
  assertEquals(p3.requires, "oneShot2");
  assertEquals(
    canUnlockSkillProduct("oneShot", 15, [
      "bullets",
      "hawkeyes",
      "rapidFire",
    ]),
    true,
  );
  assertEquals(
    canUnlockSkillProduct("oneShot", 14, [
      "bullets",
      "hawkeyes",
      "rapidFire",
    ]),
    false,
  );
  assertEquals(
    canUnlockSkillProduct("oneShot3", 19, [
      "bullets",
      "hawkeyes",
      "rapidFire",
      "oneShot",
      "oneShot2",
    ]),
    true,
  );
});

// ── PR-3: abilities.ts is a thin layer over skills.ts ────────────────────

Deno.test("PR-3 catalog unify: ability products mirror skill products", () => {
  for (const id of ABILITY_PRODUCT_ORDER) {
    const ability = ABILITY_PRODUCTS[id];
    const skill = SKILL_PRODUCTS[id];
    assertExists(skill, id);
    assertEquals(ability.label, skill.label, `${id} label`);
    assertEquals(ability.minLevel, skill.minLevel, `${id} minLevel`);
    assertEquals(ability.coinCost, skill.coinCost, `${id} coinCost`);
    assertEquals(ability.durationS, skill.value, `${id} duration/value`);
    assertEquals(ability.blurb, skill.blurb, `${id} blurb`);
    assertEquals(ability.family, skill.skill, `${id} family`);
    assertEquals(ability.tier, skill.tier, `${id} tier`);
    assertEquals(minLevelForAbility(id), skill.minLevel);
    assertEquals(coinCostForAbility(id), skill.coinCost);
  }
});

Deno.test("PR-3 catalog unify: family defs + duration helpers", () => {
  for (const id of ABILITY_ORDER) {
    const def = ABILITY_DEFS[id];
    const skill = SKILL_DEFS[id];
    assertEquals(def.label, skill.label);
    assertEquals(def.glyph, skill.glyph);
    assertEquals(def.blurb, skill.effectBlurb + ".");
    assertEquals(def.minLevel, SKILL_PRODUCTS[id].minLevel);
    assertEquals(def.coinCost, SKILL_PRODUCTS[id].coinCost);
    // Max duration = highest tier product value
    const products = productsForSkill(id);
    assertEquals(def.durationS, products[products.length - 1]!.value);
  }

  assertEquals(ABILITY_TIER_DURATION_S[1], SKILL_PRODUCTS.quick.value);
  assertEquals(ABILITY_TIER_DURATION_S[2], SKILL_PRODUCTS.quick2.value);
  assertEquals(ABILITY_TIER_DURATION_S[3], SKILL_PRODUCTS.quick3.value);

  assertEquals(durationSForOwned("quick", null), timedSkillDurationSForOwned("quick", null));
  assertEquals(
    durationSForOwned("quick", ["quick"]),
    timedSkillDurationSForOwned("quick", ["quick"]),
  );
  assertEquals(
    durationSForOwned("forceField" as never, null),
    0,
  ); // not an AbilityId
});
