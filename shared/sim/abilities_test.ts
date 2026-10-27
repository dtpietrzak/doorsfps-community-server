import { assertEquals } from "jsr:@std/assert@1";
import { TICK_HZ } from "./game.ts";
import {
  ABILITY_BAR_REGEN_S,
  ABILITY_DEFS,
  ABILITY_DOOR_REGEN_S,
  ABILITY_GLOBAL_LOCK_S,
  ABILITY_MAX_DURATION_S,
  ABILITY_ORDER,
  ABILITY_PRODUCT_ORDER,
  ABILITY_TIER_DURATION_S,
  GLITCH_DOOR_FORCE_VISIBLE_U,
  abilityAtSlot,
  abilityBarRegenTicks,
  abilityBindAction,
  abilityDoorRegenTicks,
  abilityDurationTicks,
  abilityGlobalLockTicks,
  abilityGlobalLockTicksForDuration,
  abilityLockMessage,
  canPurchaseAbility,
  coinCostForAbility,
  distPointToSegment2d,
  durationSForOwned,
  emptyOwnedAbilities,
  getAbilityDef,
  getAbilityProduct,
  glitchSelfGunOpacity,
  glitchVisibilityOpacity,
  highestOwnedTier,
  isAbilityActiveAt,
  isAbilityId,
  isAbilityOwned,
  isAbilityProductId,
  isAbilityShopUnlocked,
  isGlitchForcedVisible,
  minLevelForAbility,
  normalizeOwnedAbilities,
  ownedAbilitiesForLevel,
  ownsAbilityFamily,
  parseOwnedAbilitiesColumn,
  productsForFamily,
  serializeOwnedAbilities,
  withOwnedAbility,
} from "./abilities.ts";

Deno.test("ABILITY_ORDER is left→right Quick Bullets Glitch Hawkeyes", () => {
  assertEquals([...ABILITY_ORDER], [
    "quick",
    "bullets",
    "glitch",
    "hawkeyes",
  ]);
});

Deno.test("each ordered ability has a def with positive duration", () => {
  for (const id of ABILITY_ORDER) {
    const def = getAbilityDef(id);
    assertEquals(def.id, id);
    assertEquals(def.durationS > 0, true);
    assertEquals(def.glyph.length >= 1, true);
    assertEquals(def.label.length >= 1, true);
  }
});

Deno.test("isAbilityId + isAbilityProductId", () => {
  assertEquals(isAbilityId("quick"), true);
  assertEquals(isAbilityId("hawkeyes"), true);
  assertEquals(isAbilityId("quick2"), false);
  assertEquals(isAbilityId("nope"), false);
  assertEquals(isAbilityId(null), false);

  assertEquals(isAbilityProductId("quick"), true);
  assertEquals(isAbilityProductId("quick2"), true);
  assertEquals(isAbilityProductId("quick3"), true);
  assertEquals(isAbilityProductId("bullets2"), true);
  assertEquals(isAbilityProductId("nope"), false);
  assertEquals(isAbilityProductId("quick1"), false);
});

Deno.test("abilityAtSlot + abilityBindAction", () => {
  assertEquals(abilityAtSlot(0), "quick");
  assertEquals(abilityAtSlot(3), "hawkeyes");
  assertEquals(abilityAtSlot(4), null);
  assertEquals(abilityAtSlot(-1), null);
  assertEquals(abilityBindAction(0), "ability1");
  assertEquals(abilityBindAction(3), "ability4");
  assertEquals(abilityBindAction(9), null);
});

Deno.test("tier durations: Quick 1.5/2/2.5; other classic families 2/2.5/3", () => {
  // ABILITY_TIER_DURATION_S tracks Quick (catalog source for the shared table).
  assertEquals(ABILITY_TIER_DURATION_S[1], 1.5);
  assertEquals(ABILITY_TIER_DURATION_S[2], 2);
  assertEquals(ABILITY_TIER_DURATION_S[3], 2.5);
  assertEquals(ABILITY_MAX_DURATION_S, 2.5);
  assertEquals(
    productsForFamily("quick").map((p) => p.durationS),
    [1.5, 2, 2.5],
  );
  for (const family of ABILITY_ORDER) {
    if (family === "quick") continue;
    const products = productsForFamily(family);
    assertEquals(products.map((p) => p.durationS), [2, 2.5, 3]);
  }
  // Family def duration is max tier (bots / HUD default).
  assertEquals(ABILITY_DEFS.quick.durationS, 2.5);
  assertEquals(ABILITY_DEFS.bullets.durationS, 3);
  assertEquals(ABILITY_DEFS.glitch.durationS, 3);
  assertEquals(ABILITY_DEFS.hawkeyes.durationS, 3);
  assertEquals(GLITCH_DOOR_FORCE_VISIBLE_U, 5);
});

Deno.test("abilityDurationTicks: unrestricted max, owned tier, unowned zero", () => {
  // Unrestricted (bots): max tier — Quick 2.5s, Bullets 3s
  assertEquals(abilityDurationTicks("quick"), Math.ceil(2.5 * TICK_HZ));
  assertEquals(abilityDurationTicks("bullets"), TICK_HZ * 3);
  // Explicit null = same
  assertEquals(
    abilityDurationTicks("quick", TICK_HZ, null),
    Math.ceil(2.5 * TICK_HZ),
  );
  // Tier 1 only
  assertEquals(
    abilityDurationTicks("quick", TICK_HZ, ["quick"]),
    Math.ceil(1.5 * TICK_HZ),
  );
  // Tier 2
  assertEquals(
    abilityDurationTicks("quick", TICK_HZ, ["quick", "quick2"]),
    TICK_HZ * 2,
  );
  // Tier 3
  assertEquals(
    abilityDurationTicks("quick", TICK_HZ, ["quick", "quick2", "quick3"]),
    Math.ceil(2.5 * TICK_HZ),
  );
  // Empty ownership
  assertEquals(abilityDurationTicks("quick", TICK_HZ, []), 0);
  // Highest orphan still counts
  assertEquals(
    abilityDurationTicks("quick", TICK_HZ, ["quick3"]),
    Math.ceil(2.5 * TICK_HZ),
  );
});

Deno.test("PR6 charge model: default global lock = Quick max (2.5s), bar/door regen 1s", () => {
  assertEquals(ABILITY_GLOBAL_LOCK_S, 2.5);
  assertEquals(ABILITY_BAR_REGEN_S, 1);
  assertEquals(ABILITY_DOOR_REGEN_S, 1);
  assertEquals(abilityGlobalLockTicks(), Math.ceil(2.5 * TICK_HZ));
  assertEquals(abilityBarRegenTicks(), TICK_HZ * 1);
  assertEquals(abilityDoorRegenTicks(), TICK_HZ * 1);
  assertEquals(
    abilityGlobalLockTicksForDuration(2),
    TICK_HZ * 2,
  );
  assertEquals(
    abilityGlobalLockTicksForDuration(2.5),
    Math.ceil(2.5 * TICK_HZ),
  );
});

Deno.test("distPointToSegment2d: endpoint, midpoint, off-segment", () => {
  const a = { x: -2, z: 0 };
  const b = { x: 2, z: 0 };
  assertEquals(distPointToSegment2d(-2, 0, a, b), 0);
  assertEquals(distPointToSegment2d(0, 0, a, b), 0);
  assertEquals(distPointToSegment2d(0, 3, a, b), 3);
  // Past endpoint: distance to nearest end.
  assertEquals(distPointToSegment2d(5, 0, a, b), 3);
});

Deno.test("isGlitchForcedVisible: inside/outside 5u of door segment", () => {
  const a = { x: -2.5, z: 20 };
  const b = { x: 2.5, z: 20 };
  // On the door line.
  assertEquals(isGlitchForcedVisible(0, 20, a, b), true);
  // 4u in front of door — still forced visible.
  assertEquals(isGlitchForcedVisible(0, 16, a, b), true);
  // Exactly at the threshold.
  assertEquals(isGlitchForcedVisible(0, 15, a, b), true);
  // Just outside 5u.
  assertEquals(isGlitchForcedVisible(0, 14.9, a, b), false);
  // Far away.
  assertEquals(isGlitchForcedVisible(0, 0, a, b), false);
});

Deno.test("glitchSelfGunOpacity: entrance blip then stay gone", () => {
  const dur = 1;
  // At activate / after end → solid
  assertEquals(glitchSelfGunOpacity(0, dur), 1);
  assertEquals(glitchSelfGunOpacity(dur, dur), 1);
  // First gone blip
  assertEquals(glitchSelfGunOpacity(0.02, dur), 0);
  // Flash back
  assertEquals(glitchSelfGunOpacity(0.06, dur), 1);
  // Stay gone for the rest of the window (no long fade-in)
  assertEquals(glitchSelfGunOpacity(0.1, dur), 0);
  assertEquals(glitchSelfGunOpacity(0.5, dur), 0);
  assertEquals(glitchSelfGunOpacity(0.99, dur), 0);
  // Outside window clamps
  assertEquals(glitchSelfGunOpacity(-1, dur), 1);
  assertEquals(glitchSelfGunOpacity(2, dur), 1);
  // Alias for remotes
  assertEquals(glitchVisibilityOpacity(0.06, dur), 1);
  assertEquals(glitchVisibilityOpacity(0.5, dur), 0);
});

Deno.test("isAbilityActiveAt is exclusive of end tick", () => {
  assertEquals(isAbilityActiveAt(100, 99), true);
  assertEquals(isAbilityActiveAt(100, 100), false);
  assertEquals(isAbilityActiveAt(null, 50), false);
  assertEquals(isAbilityActiveAt(undefined, 50), false);
});

Deno.test("tier unlock catalog: levels + escalating costs (skills source)", () => {
  // Sourced from shared/sim/skills.ts (PR-3) — not a dual catalog.
  // Quick
  assertEquals(minLevelForAbility("quick"), 2);
  assertEquals(minLevelForAbility("quick2"), 6);
  assertEquals(minLevelForAbility("quick3"), 10);
  assertEquals(coinCostForAbility("quick"), 0);
  assertEquals(coinCostForAbility("quick2"), 50);
  assertEquals(coinCostForAbility("quick3"), 100);
  // Bullets
  assertEquals(minLevelForAbility("bullets"), 3);
  assertEquals(minLevelForAbility("bullets2"), 6);
  assertEquals(minLevelForAbility("bullets3"), 10);
  assertEquals(coinCostForAbility("bullets"), 0);
  assertEquals(coinCostForAbility("bullets2"), 80);
  assertEquals(coinCostForAbility("bullets3"), 160);
  // Glitch (tree node after Quick)
  assertEquals(minLevelForAbility("glitch"), 5);
  assertEquals(minLevelForAbility("glitch2"), 8);
  assertEquals(minLevelForAbility("glitch3"), 12);
  // Hawkeyes (tree node after Bullets)
  assertEquals(minLevelForAbility("hawkeyes"), 5);
  assertEquals(minLevelForAbility("hawkeyes2"), 8);
  assertEquals(minLevelForAbility("hawkeyes3"), 12);

  assertEquals(ABILITY_PRODUCT_ORDER.length, 12);
  assertEquals(getAbilityProduct("quick2").requires, "quick");
  assertEquals(getAbilityProduct("quick3").requires, "quick2");
  assertEquals(getAbilityProduct("quick").requires, null);
});

Deno.test("ownership normalize / serialize includes tier products", () => {
  assertEquals(emptyOwnedAbilities(), []);
  assertEquals(normalizeOwnedAbilities(["hawkeyes", "quick", "nope"]), [
    "quick",
    "hawkeyes",
  ]);
  assertEquals(
    normalizeOwnedAbilities(["quick3", "quick", "bullets2", "nope"]),
    ["quick", "quick3", "bullets2"],
  );
  assertEquals(normalizeOwnedAbilities({ bullets: true, glitch: 1 }), [
    "bullets",
    "glitch",
  ]);
  const json = serializeOwnedAbilities(["glitch2", "quick"]);
  assertEquals(parseOwnedAbilitiesColumn(json), ["quick", "glitch2"]);
  assertEquals(parseOwnedAbilitiesColumn("[]"), []);
  assertEquals(parseOwnedAbilitiesColumn(null), []);
});

Deno.test("highestOwnedTier + durationSForOwned", () => {
  assertEquals(highestOwnedTier("quick", []), 0);
  assertEquals(highestOwnedTier("quick", ["quick"]), 1);
  assertEquals(highestOwnedTier("quick", ["quick", "quick2"]), 2);
  assertEquals(highestOwnedTier("quick", ["quick3"]), 3);
  assertEquals(ownsAbilityFamily("quick", ["quick2"]), true);
  assertEquals(ownsAbilityFamily("bullets", ["quick"]), false);

  assertEquals(durationSForOwned("quick", null), 2.5);
  assertEquals(durationSForOwned("quick", undefined), 2.5);
  assertEquals(durationSForOwned("quick", []), 0);
  assertEquals(durationSForOwned("quick", ["quick"]), 1.5);
  assertEquals(durationSForOwned("quick", ["quick", "quick2"]), 2);
});

Deno.test("shop gates: level, prerequisite tier, tree chain, coins own", () => {
  assertEquals(isAbilityShopUnlocked("quick", 1), false);
  assertEquals(isAbilityShopUnlocked("quick", 2), true);
  assertEquals(isAbilityShopUnlocked("quick2", 5), false);
  assertEquals(isAbilityShopUnlocked("quick2", 6), true);

  assertEquals(isAbilityOwned("quick", []), false);
  assertEquals(isAbilityOwned("quick", ["quick"]), true);
  // Exact product only (family membership is ownsAbilityFamily)
  assertEquals(isAbilityOwned("quick", ["quick2"]), false);
  assertEquals(ownsAbilityFamily("quick", ["quick2"]), true);
  assertEquals(isAbilityOwned("quick2", ["quick"]), false);
  assertEquals(isAbilityOwned("quick2", ["quick", "quick2"]), true);

  // T1 buy
  assertEquals(canPurchaseAbility("quick", 1, []), false);
  assertEquals(canPurchaseAbility("quick", 2, []), true);
  assertEquals(canPurchaseAbility("quick", 2, ["quick"]), false);

  // T2 requires T1 owned (min level 6 from skills catalog)
  assertEquals(canPurchaseAbility("quick2", 6, []), false);
  assertEquals(canPurchaseAbility("quick2", 6, ["quick"]), true);
  assertEquals(canPurchaseAbility("quick2", 5, ["quick"]), false);
  assertEquals(canPurchaseAbility("quick2", 6, ["quick", "quick2"]), false);

  // T3 requires T2 (min level 10)
  assertEquals(canPurchaseAbility("quick3", 10, ["quick"]), false);
  assertEquals(canPurchaseAbility("quick3", 10, ["quick", "quick2"]), true);

  // Glitch requires Quick I in the skill tree (not just level).
  assertEquals(canPurchaseAbility("glitch", 5, []), false);
  assertEquals(canPurchaseAbility("glitch", 5, ["quick"]), true);

  assertEquals(withOwnedAbility([], "bullets"), ["bullets"]);
  assertEquals(withOwnedAbility(["quick"], "quick2"), ["quick", "quick2"]);
  assertEquals(withOwnedAbility(["quick"], "quick"), ["quick"]);

  assertEquals(
    abilityLockMessage("quick", 1, []),
    "Reach level 2 to unlock Quick I in the shop",
  );
  assertEquals(
    abilityLockMessage("quick", 5, []),
    "Unlock Quick I in Profile (free)",
  );
  assertEquals(abilityLockMessage("quick", 5, ["quick"]), null);
  assertEquals(
    abilityLockMessage("quick2", 6, []),
    "Buy Quick I first",
  );
  assertEquals(
    abilityLockMessage("quick2", 5, ["quick"]),
    "Reach level 6 to unlock Quick II in the shop",
  );
  assertEquals(
    abilityLockMessage("quick2", 6, ["quick"]),
    "Buy Quick II in Profile (50 coins)",
  );
  assertEquals(
    abilityLockMessage("glitch", 5, []),
    "Buy Quick I first",
  );

  // Seed unlock path mirrors skill tree prereqs.
  assertEquals(ownedAbilitiesForLevel(1), []);
  assertEquals(ownedAbilitiesForLevel(3), ["quick", "bullets"]);
  assertEquals(ownedAbilitiesForLevel(5).includes("quick"), true);
  assertEquals(ownedAbilitiesForLevel(5).includes("quick2"), false); // L6
  assertEquals(ownedAbilitiesForLevel(5).includes("bullets"), true);
  assertEquals(ownedAbilitiesForLevel(5).includes("bullets2"), false); // L6
  assertEquals(ownedAbilitiesForLevel(5).includes("glitch"), true);
  assertEquals(ownedAbilitiesForLevel(5).includes("hawkeyes"), true);
  assertEquals(ownedAbilitiesForLevel(10).includes("quick3"), true);
  assertEquals(ownedAbilitiesForLevel(10).includes("bullets3"), true);
  assertEquals(ownedAbilitiesForLevel(8).includes("quick3"), false);
  assertEquals(ownedAbilitiesForLevel(8).includes("glitch2"), true);
});
