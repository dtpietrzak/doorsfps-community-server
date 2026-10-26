import { assertEquals, assert } from "jsr:@std/assert@1";
import {
  CROSSHAIR_OPACITY_MIN,
  crosshairColorCss,
  EQUIPMENT_COLOR_DEFAULT,
  normalizeCrosshairColor,
  normalizeEquipmentColorUnlocks,
  normalizeNameHue,
  packCrosshairColor,
  serializeEquipmentColorUnlocks,
  unpackCrosshairColor,
} from "./game.ts";
import {
  CROUCH_SPEED_MULT,
  CRITICAL_DAMAGE_ROLL_CHANCE,
  DAMAGE_VARIATION_MAX_POINTS,
  DT,
  EQUIPMENT_SHOP_BODY_TYPE_COUNT,
  EQUIPMENT_SHOP_HEAD_TYPE_COUNT,
  EQUIPMENT_SHOP_LEG_TYPE_COUNT,
  EQUIPMENT_SHOP_SHOULDER_TYPE_COUNT,
  EQUIPMENT_SHOP_VISOR_TYPE_COUNT,
  BODY_TYPE_COUNT,
  HEAD_TYPE_COUNT,
  LEG_TYPE_COUNT,
  RIFLE_TYPE_COUNT,
  SECRET_EQUIPMENT_SETS,
  SHOULDER_TYPE_COUNT,
  SHOTGUN_TYPE_COUNT,
  SCOPE_PART_LABELS,
  SCOPE_TYPE_COUNT,
  VISOR_TYPE_COUNT,
  HIT_SLOW_MAX_STACKS,
  HIT_SLOW_PER_STACK,
  hitSlowMoveSpeedScale,
  JUMP_STAMINA_COST,
  jumpStaminaCostSeconds,
  agentPlayerEquipment,
  canEquipHue,
  canEquipPartVariant,
  canPurchaseHue,
  canPurchasePartVariant,
  clampEquipmentToXpLevel,
  coinCostForPartVariant,
  defaultPlayerEquipment,
  dropOnlyHueSteps,
  dropOnlyPartVariants,
  emptyEquipmentOwnedParts,
  minLevelForPartVariant,
  normalizeEquipmentOwnedParts,
  normalizePlayerEquipment,
  paidHueSteps,
  paidPartVariants,
  equipmentItemRarity,
  equipmentPartLabel,
  equipmentPartRarity,
  equipmentHueCatalogIndices,
  isDropOnlyHueStep,
  isDropOnlyPartVariant,
  isHueUnlocked,
  isPartVariantOwned,
  isPartVariantUnlocked,
  levelLegalHueSteps,
  levelLegalPartVariants,
  moveSpeedForInput,
  rollDamageVariation,
  pickLevelLegalEquipment,
  SPRINT_DURATION_S,
  SPRINT_SPEED_MULT,
  TICK_HZ,
  TICK_MS,
  msToTicks,
  simTime,
  ticksToMs,
  WALK_SPEED,
  withOwnedHue,
  withOwnedPartVariant,
  withoutOwnedPartVariant,
  withoutOwnedHue,
  isAlwaysOwnedPartVariant,
  isAlwaysOwnedHueStep,
  isRemovableEquipmentItem,
  EQUIPMENT_SELL_COINS,
  EQUIPMENT_HUE_STEPS,
} from "./game.ts";
import { RIFLE } from "./weapons.ts";

Deno.test("simulation clock derives fixed step values from TICK_HZ", () => {
  assertEquals(TICK_MS, 1000 / TICK_HZ);
  assertEquals(DT, 1 / TICK_HZ);
  assertEquals(TICK_MS, DT * 1000);
  assertEquals(msToTicks(50), 3);
  assertEquals(ticksToMs(3), 50);
  assertEquals(simTime(120), 2);
});

Deno.test("moveSpeedForInput: ground crouch is half walk", () => {
  assertEquals(
    moveSpeedForInput(false, true),
    WALK_SPEED * CROUCH_SPEED_MULT,
  );
});

Deno.test("moveSpeedForInput: airborne crouch keeps walk speed", () => {
  // Half-wall vault feet-clear window is short; crouch-speed mid-jump fails it.
  assertEquals(
    moveSpeedForInput(false, true, 1, false, true),
    WALK_SPEED,
  );
  assertEquals(
    moveSpeedForInput(true, true, 1, false, true),
    WALK_SPEED * SPRINT_SPEED_MULT,
  );
});

Deno.test("moveSpeedForInput: slide still beats crouch when airborne flag set", () => {
  assertEquals(
    moveSpeedForInput(false, true, 1, true, true),
    WALK_SPEED * SPRINT_SPEED_MULT,
  );
});

Deno.test("hitSlowMoveSpeedScale stacks 5% up to 15%", () => {
  assertEquals(HIT_SLOW_PER_STACK, 0.05);
  assertEquals(HIT_SLOW_MAX_STACKS, 3);
  assertEquals(hitSlowMoveSpeedScale(0), 1);
  assertEquals(hitSlowMoveSpeedScale(1), 0.95);
  assertEquals(hitSlowMoveSpeedScale(2), 0.9);
  assertEquals(hitSlowMoveSpeedScale(3), 0.85);
  assertEquals(hitSlowMoveSpeedScale(99), 0.85);
});

Deno.test("damage varies by ±5 points with +5 reserved for the top 10%", () => {
  assertEquals(DAMAGE_VARIATION_MAX_POINTS, 5);
  assertEquals(CRITICAL_DAMAGE_ROLL_CHANCE, 0.1);
  assertEquals(rollDamageVariation(100, 0), {
    damage: 95,
    offset: -5,
    critical: false,
  });
  assertEquals(rollDamageVariation(100, 0.5), {
    damage: 100,
    offset: 0,
    critical: false,
  });
  assertEquals(rollDamageVariation(100, 0.899_999), {
    damage: 104,
    offset: 4,
    critical: false,
  });
  assertEquals(rollDamageVariation(100, 0.9).critical, true);
  assertEquals(rollDamageVariation(100, 1), {
    damage: 105,
    offset: 5,
    critical: true,
  });
});

Deno.test("rifle headshots range from 100 through 110", () => {
  assertEquals(rollDamageVariation(RIFLE.headDamage, 0).damage, 100);
  assertEquals(rollDamageVariation(RIFLE.headDamage, 1).damage, 110);
});

Deno.test("rollDamageVariation clamps non-finite and out-of-range samples", () => {
  // Non-finite → treat as neutral 0.5 → +0 offset.
  assertEquals(rollDamageVariation(100, Number.NaN), {
    damage: 100,
    offset: 0,
    critical: false,
  });
  assertEquals(rollDamageVariation(100, Number.POSITIVE_INFINITY), {
    damage: 100,
    offset: 0,
    critical: false,
  });
  // Out of [0,1] clamps to the edge band.
  assertEquals(rollDamageVariation(100, -1).offset, -5);
  assertEquals(rollDamageVariation(100, 2).critical, true);
  assertEquals(rollDamageVariation(100, 2).offset, 5);
  // Non-finite base → 0 damage floor.
  assertEquals(rollDamageVariation(Number.NaN, 0.5).damage, 0);
});

Deno.test("jump costs 10% of a full stamina bar", () => {
  assertEquals(JUMP_STAMINA_COST, 0.1);
  assertEquals(jumpStaminaCostSeconds(), SPRINT_DURATION_S * 0.1);
});

Deno.test("pickLevelLegalEquipment only uses unlocks for level", () => {
  let i = 0;
  const seq = [0.1, 0.3, 0.5, 0.7, 0.9, 0.2, 0.4, 0.6, 0.8, 0.15, 0.25];
  const rand = () => seq[i++ % seq.length]!;
  const low = pickLevelLegalEquipment(1, rand);
  assert(isPartVariantUnlocked("head", low.head, 1));
  assert(isPartVariantUnlocked("visor", low.visor, 1));
  assert(isHueUnlocked(low.hue, 1));
  // Level 1 cannot wear high-tier dome head (unlock 11)
  assertEquals(low.head, 0);

  i = 0;
  const high = pickLevelLegalEquipment(15, rand);
  assert(isPartVariantUnlocked("head", high.head, 15));
  assert(isHueUnlocked(high.hue, 15));
  assertEquals(isDropOnlyPartVariant("head", high.head), false);
  assertEquals(isDropOnlyPartVariant("visor", high.visor), false);
});

Deno.test("secret heads and visors are drop-only and never shop or seed legal", () => {
  assertEquals(HEAD_TYPE_COUNT, 24);
  assertEquals(
    dropOnlyPartVariants("head"),
    [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23],
  );
  assertEquals(VISOR_TYPE_COUNT, 7);
  assertEquals(dropOnlyPartVariants("visor"), [5, 6]);
  assertEquals(equipmentPartLabel("head", 5), "Medusa");
  assertEquals(equipmentPartLabel("head", 6), "Taurus");
  assertEquals(equipmentPartLabel("head", 7), "Ancient");
  assertEquals(equipmentPartLabel("head", 8), "Pop Can");
  assertEquals(equipmentPartLabel("head", 9), "Star");
  assertEquals(equipmentPartLabel("head", 10), "Glitch");
  assertEquals(equipmentPartLabel("head", 11), "Pirate");
  assertEquals(equipmentPartLabel("head", 12), "Barrel");
  assertEquals(equipmentPartLabel("head", 13), "Bucket Head");
  assertEquals(equipmentPartLabel("head", 14), "Doodle");
  assertEquals(equipmentPartLabel("head", 15), "Princess");
  assertEquals(equipmentPartLabel("head", 16), "Hotdog");
  assertEquals(equipmentPartLabel("head", 17), "Banana");
  assertEquals(equipmentPartLabel("head", 18), "Football");
  assertEquals(equipmentPartLabel("head", 19), "Zombie");
  assertEquals(equipmentPartLabel("head", 20), "Pumpkin");
  assertEquals(equipmentPartLabel("head", 21), "Cheerleader");
  assertEquals(equipmentPartLabel("head", 22), "Unicorn");
  assertEquals(equipmentPartLabel("visor", 5), "Doodle");
  assertEquals(equipmentPartLabel("visor", 6), "Princess");

  const empty = emptyEquipmentOwnedParts();
  for (let v = EQUIPMENT_SHOP_HEAD_TYPE_COUNT; v < HEAD_TYPE_COUNT; v++) {
    assertEquals(isDropOnlyPartVariant("head", v), true);
    assertEquals(canPurchasePartVariant("head", v, 30, empty), false);
    assertEquals(isPartVariantOwned("head", v, empty), false);
    assertEquals(canEquipPartVariant("head", v, empty), false);
  }

  const owned = withOwnedPartVariant(empty, "head", 5);
  assertEquals(owned.head, [5]);
  assertEquals(canEquipPartVariant("head", 5, owned), true);
  assertEquals(withoutOwnedPartVariant(owned, "head", 5).head, []);
  assertEquals(withoutOwnedPartVariant(owned, "head", 0).head, [5]);
  assertEquals(levelLegalPartVariants("head", 30).includes(5), false);

  for (let v = EQUIPMENT_SHOP_VISOR_TYPE_COUNT; v < VISOR_TYPE_COUNT; v++) {
    assertEquals(isDropOnlyPartVariant("visor", v), true);
    assertEquals(canPurchasePartVariant("visor", v, 30, empty), false);
    assertEquals(isPartVariantOwned("visor", v, empty), false);
    assertEquals(canEquipPartVariant("visor", v, empty), false);
  }
  const doodleHeadOwned = withOwnedPartVariant(empty, "head", 14);
  assertEquals(doodleHeadOwned.head, [14]);
  assertEquals(doodleHeadOwned.visor, []);
  const doodlePair = withOwnedPartVariant(doodleHeadOwned, "visor", 5);
  assertEquals(doodlePair.head, [14]);
  assertEquals(doodlePair.visor, [5]);
  assertEquals(canEquipPartVariant("visor", 5, doodlePair), true);
  assertEquals(levelLegalPartVariants("visor", 30).includes(5), false);
});

Deno.test("secret bodies are drop-only and never shop or seed legal", () => {
  assertEquals(BODY_TYPE_COUNT, 17);
  assertEquals(
    dropOnlyPartVariants("body"),
    [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
  );
  assertEquals(equipmentPartLabel("body", 5), "Gym Bro");
  assertEquals(equipmentPartLabel("body", 6), "Pop Can");
  assertEquals(equipmentPartLabel("body", 7), "Barrel");
  assertEquals(equipmentPartLabel("body", 8), "Glitch");
  assertEquals(equipmentPartLabel("body", 9), "Ancient");
  assertEquals(equipmentPartLabel("body", 10), "Princess");
  assertEquals(equipmentPartLabel("body", 11), "Hotdog");
  assertEquals(equipmentPartLabel("body", 12), "Banana");
  assertEquals(equipmentPartLabel("body", 13), "Football");
  assertEquals(equipmentPartLabel("body", 14), "Zombie");
  assertEquals(equipmentPartLabel("body", 15), "Cheerleader");

  const empty = emptyEquipmentOwnedParts();
  for (let v = EQUIPMENT_SHOP_BODY_TYPE_COUNT; v < BODY_TYPE_COUNT; v++) {
    assertEquals(isDropOnlyPartVariant("body", v), true);
    assertEquals(canPurchasePartVariant("body", v, 30, empty), false);
    assertEquals(isPartVariantOwned("body", v, empty), false);
    assertEquals(canEquipPartVariant("body", v, empty), false);
  }

  const owned = withOwnedPartVariant(empty, "body", 5);
  assertEquals(owned.body, [5]);
  assertEquals(canEquipPartVariant("body", 5, owned), true);
  assertEquals(levelLegalPartVariants("body", 30).includes(5), false);
});

Deno.test("secret legs are drop-only and never shop or seed legal", () => {
  assertEquals(EQUIPMENT_SHOP_LEG_TYPE_COUNT, 5);
  assertEquals(LEG_TYPE_COUNT, 11);
  assertEquals(dropOnlyPartVariants("leg"), [5, 6, 7, 8, 9, 10]);
  assertEquals(equipmentPartLabel("leg", 5), "Princess");
  assertEquals(equipmentPartLabel("leg", 6), "Hotdog");
  assertEquals(equipmentPartLabel("leg", 7), "Banana");
  assertEquals(equipmentPartLabel("leg", 8), "Zombie");
  assertEquals(equipmentPartLabel("leg", 9), "Cheerleader");

  const empty = emptyEquipmentOwnedParts();
  assertEquals(isDropOnlyPartVariant("leg", 5), true);
  assertEquals(canPurchasePartVariant("leg", 5, 30, empty), false);
  assertEquals(isPartVariantOwned("leg", 5, empty), false);
  assertEquals(canEquipPartVariant("leg", 5, empty), false);

  const owned = withOwnedPartVariant(empty, "leg", 5);
  assertEquals(owned.leg, [5]);
  assertEquals(canEquipPartVariant("leg", 5, owned), true);
  assertEquals(levelLegalPartVariants("leg", 30).includes(5), false);
});

Deno.test("hotdog and banana expose only their remaining secret pieces", () => {
  assertEquals(EQUIPMENT_SHOP_SHOULDER_TYPE_COUNT, 5);
  assertEquals(SHOULDER_TYPE_COUNT, 9);
  assertEquals(dropOnlyPartVariants("shoulder"), [5, 6, 7, 8]);
  assertEquals(equipmentPartLabel("shoulder", 5), "Football");
  assertEquals(equipmentPartLabel("shoulder", 6), "Princess");
  assertEquals(equipmentPartLabel("shoulder", 7), "Zombie");

  const empty = emptyEquipmentOwnedParts();
  for (const [setName, set] of Object.entries(SECRET_EQUIPMENT_SETS)) {
    const label = setName === "hotdog" ? "Hotdog" : "Banana";
    for (const [slot, variant] of Object.entries(set) as [
      "head" | "visor" | "shoulder" | "body" | "leg",
      number,
    ][]) {
      assertEquals(equipmentPartLabel(slot, variant), label);
      assertEquals(isDropOnlyPartVariant(slot, variant), true);
      assertEquals(canPurchasePartVariant(slot, variant, 30, empty), false);
      assertEquals(canEquipPartVariant(slot, variant, empty), false);
      const owned = withOwnedPartVariant(empty, slot, variant);
      assertEquals(canEquipPartVariant(slot, variant, owned), true);
    }
  }

  assertEquals(Object.keys(SECRET_EQUIPMENT_SETS.hotdog), [
    "head",
    "body",
    "leg",
  ]);
  assertEquals(Object.keys(SECRET_EQUIPMENT_SETS.banana), ["head", "body", "leg"]);
});

Deno.test("secretary set is drop-only across head, arms, body, and legs", () => {
  const empty = emptyEquipmentOwnedParts();
  const set = [
    ["head", 23],
    ["shoulder", 8],
    ["body", 16],
    ["leg", 10],
  ] as const;

  for (const [slot, variant] of set) {
    assertEquals(equipmentPartLabel(slot, variant), "Secretary");
    assertEquals(equipmentPartRarity(slot, variant), "epic");
    assertEquals(isDropOnlyPartVariant(slot, variant), true);
    assertEquals(canPurchasePartVariant(slot, variant, 30, empty), false);
    assertEquals(canEquipPartVariant(slot, variant, empty), false);
    const owned = withOwnedPartVariant(empty, slot, variant);
    assertEquals(canEquipPartVariant(slot, variant, owned), true);
  }
});

Deno.test("cheerleader set is drop-only across head, body, and legs", () => {
  const empty = emptyEquipmentOwnedParts();
  const set = [
    ["head", 21],
    ["body", 15],
    ["leg", 9],
  ] as const;

  for (const [slot, variant] of set) {
    assertEquals(equipmentPartLabel(slot, variant), "Cheerleader");
    assertEquals(isDropOnlyPartVariant(slot, variant), true);
    assertEquals(canPurchasePartVariant(slot, variant, 30, empty), false);
    assertEquals(canEquipPartVariant(slot, variant, empty), false);
    const owned = withOwnedPartVariant(empty, slot, variant);
    assertEquals(canEquipPartVariant(slot, variant, owned), true);
  }
});

Deno.test("equipment family rarity is cosmetic and keyed by style name", () => {
  assertEquals(equipmentPartRarity("head", 0), "common");
  assertEquals(equipmentPartRarity("body", 1), "common");
  assertEquals(equipmentPartRarity("visor", 2), "uncommon");
  assertEquals(equipmentPartRarity("shoulder", 3), "uncommon");
  assertEquals(equipmentPartRarity("leg", 4), "rare");
  assertEquals(equipmentPartRarity("head", 5), "rare");
  assertEquals(equipmentPartRarity("head", 6), "rare");
  assertEquals(equipmentPartRarity("head", 9), "rare");
  assertEquals(equipmentPartRarity("body", 5), "epic");
  assertEquals(equipmentPartRarity("head", 13), "epic");
  assertEquals(equipmentPartRarity("head", 15), "epic");
  assertEquals(equipmentPartRarity("head", 19), "epic");
  assertEquals(equipmentPartRarity("head", 20), "epic");
  assertEquals(equipmentPartRarity("head", 21), "epic");
  assertEquals(equipmentPartRarity("head", 22), "legendary");
  assertEquals(equipmentPartRarity("body", 15), "epic");
  assertEquals(equipmentPartRarity("leg", 9), "epic");
  assertEquals(equipmentPartRarity("body", 14), "epic");
  assertEquals(equipmentPartRarity("shoulder", 7), "epic");
  assertEquals(equipmentPartRarity("leg", 8), "epic");
  assertEquals(equipmentPartRarity("visor", 5), "legendary");
  assertEquals(equipmentPartRarity("body", 8), "legendary");
  assertEquals(equipmentPartRarity("leg", 6), "legendary");
  assertEquals(equipmentItemRarity("hue", 3), "uncommon");
  assertEquals(equipmentItemRarity("gunHue", 0), "uncommon");
  assertEquals(equipmentItemRarity("hue", 2), "common");
  assertEquals(equipmentItemRarity("hue", 6), "epic");
  assertEquals(equipmentItemRarity("hue", 7), "epic");
  assertEquals(equipmentItemRarity("hue", 5), "legendary");
  assertEquals(equipmentItemRarity("gunHue", 8), "legendary");
  assertEquals(equipmentItemRarity("head", 16), "legendary");
});

Deno.test("secret cool and warm tints are drops, not shop colors", () => {
  assertEquals(equipmentHueCatalogIndices(), [5, 6, 0, 1, 2, 3, 4, 7, 8]);
  assertEquals(dropOnlyHueSteps(), [-2, -1.5, 1.5, 2]);
  assertEquals(EQUIPMENT_HUE_STEPS[5], -2);
  assertEquals(isDropOnlyHueStep(5), true);
  assertEquals(isDropOnlyHueStep(6), true);
  assertEquals(isDropOnlyHueStep(7), true);
  assertEquals(isDropOnlyHueStep(8), true);
  assertEquals(isDropOnlyHueStep(0), false);
  assertEquals(canPurchaseHue(-2, 30, []), false);
  assertEquals(canPurchaseHue(2, 30, []), false);
  assertEquals(canPurchaseHue(-1, 30, []), true);
  assertEquals(canEquipHue(-1.5, []), false);
  assertEquals(withOwnedHue([], -1.5), [6]);
  assertEquals(canEquipHue(-1.5, [6]), true);
  assertEquals(paidHueSteps().includes(-2), false);
  assertEquals(levelLegalHueSteps(30).includes(1.5), false);
  assertEquals(levelLegalHueSteps(30).includes(-1), true);
  assertEquals(normalizePlayerEquipment({ hue: -2 }).hue, -2);
  assertEquals(normalizePlayerEquipment({ hue: 2 }).hue, 2);
  assertEquals(normalizePlayerEquipment({ hue: -1 }).hue, -1);
});

Deno.test("bag item remove helpers leave free defaults alone", () => {
  assertEquals(EQUIPMENT_SELL_COINS, 5);
  assertEquals(isAlwaysOwnedPartVariant("head", 0), true);
  assertEquals(isRemovableEquipmentItem("head", 0), false);
  assertEquals(isRemovableEquipmentItem("head", 1), true);
  assertEquals(isAlwaysOwnedHueStep(2), true);
  assertEquals(isRemovableEquipmentItem("hue", 2), false);
  assertEquals(isRemovableEquipmentItem("hue", 0), true);

  const empty = emptyEquipmentOwnedParts();
  const owned = withOwnedPartVariant(empty, "head", 1);
  assertEquals(withoutOwnedPartVariant(owned, "head", 0).head, [1]);
  assertEquals(withoutOwnedPartVariant(owned, "head", 1).head, []);

  const defaultHue = EQUIPMENT_HUE_STEPS[2]!;
  assertEquals(withoutOwnedHue([0], defaultHue), [0]);
  const cool = EQUIPMENT_HUE_STEPS[0]!;
  assertEquals(withoutOwnedHue([0], cool), []);
});

Deno.test("shotgun shop matches rifle prices, levels, and ownership", () => {
  assertEquals(SHOTGUN_TYPE_COUNT, RIFLE_TYPE_COUNT);
  assertEquals(SHOTGUN_TYPE_COUNT, 5);
  for (let v = 0; v < SHOTGUN_TYPE_COUNT; v++) {
    assertEquals(
      coinCostForPartVariant("shotgun", v),
      coinCostForPartVariant("rifle", v),
      `shotgun cost ${v}`,
    );
    assertEquals(
      minLevelForPartVariant("shotgun", v),
      minLevelForPartVariant("rifle", v),
      `shotgun level ${v}`,
    );
    assertEquals(equipmentPartLabel("shotgun", v), equipmentPartLabel("rifle", v));
    assertEquals(
      equipmentItemRarity("shotgun", v),
      equipmentItemRarity("rifle", v),
    );
    assertEquals(isDropOnlyPartVariant("shotgun", v), false);
  }
  assertEquals(paidPartVariants("shotgun"), paidPartVariants("rifle"));
  assertEquals(paidPartVariants("shotgun"), [1, 2, 3, 4]);

  const empty = emptyEquipmentOwnedParts();
  assertEquals(empty.shotgun, []);
  // Paid styles need purchase even at max level.
  assertEquals(canPurchasePartVariant("shotgun", 2, 30, empty), true);
  assertEquals(canEquipPartVariant("shotgun", 2, empty), false);
  const owned = withOwnedPartVariant(empty, "shotgun", 2);
  assertEquals(owned.shotgun, [2]);
  assertEquals(owned.rifle, []);
  assertEquals(canEquipPartVariant("shotgun", 2, owned), true);
  // Owned parts survive a JSON round trip.
  const revived = normalizeEquipmentOwnedParts(JSON.parse(JSON.stringify(owned)));
  assertEquals(revived.shotgun, [2]);

  // New slot defaults to standard; agents wear dome like the rifle.
  assertEquals(defaultPlayerEquipment().shotgun, 0);
  assertEquals(agentPlayerEquipment().shotgun, 4);
  assertEquals(normalizePlayerEquipment({}).shotgun, 0);
  assertEquals(normalizePlayerEquipment({ shotgun: 3 }).shotgun, 3);
  assertEquals(normalizePlayerEquipment({ shotgun: 99 }).shotgun, 4);
  // Unowned paid styles clamp to standard; owned styles stick.
  const clamped = clampEquipmentToXpLevel(
    normalizePlayerEquipment({ shotgun: 3 }),
    30,
    empty,
    [],
    [],
  );
  assertEquals(clamped.shotgun, 0);
  const owned3 = withOwnedPartVariant(empty, "shotgun", 3);
  const kept = clampEquipmentToXpLevel(
    normalizePlayerEquipment({ shotgun: 3 }),
    30,
    owned3,
    [],
    [],
  );
  assertEquals(kept.shotgun, 3);
});

Deno.test("scope shop matches rifle prices, levels, and family names", () => {
  assertEquals(SCOPE_TYPE_COUNT, 5);
  assertEquals(SCOPE_PART_LABELS.length, SCOPE_TYPE_COUNT);
  for (let v = 0; v < SCOPE_TYPE_COUNT; v++) {
    assertEquals(
      coinCostForPartVariant("scope", v),
      coinCostForPartVariant("rifle", v),
      `scope cost ${v}`,
    );
    assertEquals(
      minLevelForPartVariant("scope", v),
      minLevelForPartVariant("rifle", v),
      `scope level ${v}`,
    );
    assertEquals(equipmentPartLabel("scope", v), equipmentPartLabel("rifle", v));
    assertEquals(SCOPE_PART_LABELS[v], equipmentPartLabel("rifle", v));
    assertEquals(
      equipmentItemRarity("scope", v),
      equipmentItemRarity("rifle", v),
    );
    assertEquals(isDropOnlyPartVariant("scope", v), false);
  }
  assertEquals(paidPartVariants("scope"), paidPartVariants("rifle"));
  assertEquals(paidPartVariants("scope"), [1, 2, 3, 4]);

  const empty = emptyEquipmentOwnedParts();
  assertEquals(empty.scope, []);
  assertEquals(canPurchasePartVariant("scope", 2, 30, empty), true);
  assertEquals(canEquipPartVariant("scope", 2, empty), false);
  const owned = withOwnedPartVariant(empty, "scope", 2);
  assertEquals(owned.scope, [2]);
  assertEquals(owned.rifle, []);
  assertEquals(canEquipPartVariant("scope", 2, owned), true);
  const revived = normalizeEquipmentOwnedParts(JSON.parse(JSON.stringify(owned)));
  assertEquals(revived.scope, [2]);

  assertEquals(defaultPlayerEquipment().scope, 0);
  assertEquals(agentPlayerEquipment().scope, 0);
  assertEquals(agentPlayerEquipment().rifle, 4);
  assertEquals(normalizePlayerEquipment({}).scope, 0);
  assertEquals(normalizePlayerEquipment({ scope: 3 }).scope, 3);
  assertEquals(normalizePlayerEquipment({ scopeType: 2 }).scope, 2);
  assertEquals(normalizePlayerEquipment({ scope_type: 1 }).scope, 1);
  assertEquals(normalizePlayerEquipment({ scope: 99 }).scope, 4);
  assertEquals(normalizePlayerEquipment({ scope: -3 }).scope, 0);

  const clamped = clampEquipmentToXpLevel(
    normalizePlayerEquipment({ scope: 3 }),
    30,
    empty,
    [],
    [],
  );
  assertEquals(clamped.scope, 0);
  const owned3 = withOwnedPartVariant(empty, "scope", 3);
  const kept = clampEquipmentToXpLevel(
    normalizePlayerEquipment({ scope: 3 }),
    30,
    owned3,
    [],
    [],
  );
  assertEquals(kept.scope, 3);
});

Deno.test("crosshair color packs hue / brightness / opacity", () => {
  const packed = packCrosshairColor({ hue: 359, brightness: 42, opacity: 77 });
  assertEquals(unpackCrosshairColor(packed), {
    hue: 359,
    brightness: 42,
    opacity: 77,
  });
  assertEquals(crosshairColorCss(packed), "hsla(359, 100%, 42%, 0.77)");
  // Opacity floors so a custom crosshair can't vanish.
  assertEquals(
    unpackCrosshairColor(packCrosshairColor({ hue: 0, brightness: 50, opacity: 0 }))
      ?.opacity,
    CROSSHAIR_OPACITY_MIN,
  );
  assertEquals(unpackCrosshairColor(EQUIPMENT_COLOR_DEFAULT), null);
  assertEquals(crosshairColorCss(EQUIPMENT_COLOR_DEFAULT), null);
  assertEquals(normalizeCrosshairColor("junk"), EQUIPMENT_COLOR_DEFAULT);
  assertEquals(normalizeCrosshairColor(0x7fffffff), EQUIPMENT_COLOR_DEFAULT);
  // Name tag is a team-relative shift clamped to the tint range.
  assertEquals(normalizeNameHue(400), 2);
  assertEquals(normalizeNameHue(-3), -2);
  assertEquals(normalizeNameHue(0.4567), 0.46);
  assertEquals(normalizeNameHue("junk"), 0);
});

Deno.test("bullet tint + free colors clamp to ownership", () => {
  const crosshairColor = packCrosshairColor({
    hue: 120,
    brightness: 50,
    opacity: 90,
  });
  const raw = normalizePlayerEquipment({
    bulletHue: 1,
    crosshairColor,
    nameHue: 1.3,
  });
  assertEquals(raw.bulletHue, 1);
  assertEquals(raw.crosshairColor, crosshairColor);
  assertEquals(raw.nameHue, 1.3);

  const locked = clampEquipmentToXpLevel(raw, 30, null, [], []);
  assertEquals(locked.bulletHue, 0);
  assertEquals(locked.crosshairColor, EQUIPMENT_COLOR_DEFAULT);
  assertEquals(locked.nameHue, 0);

  const warm2 = EQUIPMENT_HUE_STEPS.indexOf(1);
  const kept = clampEquipmentToXpLevel(raw, 30, null, [], [], [warm2], {
    crosshairColor: true,
    nameHue: true,
  });
  assertEquals(kept.bulletHue, 1);
  assertEquals(kept.crosshairColor, crosshairColor);
  assertEquals(kept.nameHue, 1.3);

  assertEquals(
    normalizeEquipmentColorUnlocks('["nameHue","bogus"]'),
    { crosshairColor: false, nameHue: true },
  );
  assertEquals(
    serializeEquipmentColorUnlocks({ crosshairColor: true, nameHue: true }),
    '["crosshairColor","nameHue"]',
  );
});
