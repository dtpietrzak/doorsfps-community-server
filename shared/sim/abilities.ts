/**
 * Combat runtime + legacy “ability” surface for the classic four timed
 * families (Quick / Bullets / Glitch / Hawkeyes).
 *
 * **Catalog source of truth is {@link ./skills.ts}** (PR-3): blurbs, durations,
 * min levels, and coin costs all come from `SKILL_*` products. This module
 * keeps:
 * - `AbilityId` / `AbilityProductId` aliases and HUD order
 * - charge / global-lock timing constants
 * - Glitch visibility + FP gun fade helpers
 * - thin wrappers so older call sites keep working
 *
 * Wire activate payload accepts full {@link SkillId}. New skills should not
 * add dual catalog rows here — extend `skills.ts` only.
 */

import { TICK_HZ } from "./game.ts";
import {
  SKILL_DEFS,
  SKILL_PRODUCTS,
  canPurchaseSkillProduct,
  coinCostForSkillProduct,
  highestOwnedSkillTier,
  isSkillProductLevelUnlocked,
  isSkillProductOwned,
  minLevelForSkillProduct,
  ownedSkillsForLevel,
  ownsSkill,
  productsForSkill,
  timedSkillDurationSForOwned,
  timedSkillDurationTicks,
  type SkillId,
  type SkillProductId,
} from "./skills.ts";

/** HUD / match family id for the four classic timed abilities. */
export type AbilityId = "quick" | "bullets" | "glitch" | "hawkeyes";

/** Permanent shop product for the classic four (subset of SkillProductId). */
export type AbilityProductId =
  | "quick"
  | "quick2"
  | "quick3"
  | "bullets"
  | "bullets2"
  | "bullets3"
  | "glitch"
  | "glitch2"
  | "glitch3"
  | "hawkeyes"
  | "hawkeyes2"
  | "hawkeyes3";

export type AbilityTier = 1 | 2 | 3;

/** HUD / loadout fallback order left → right above the energy bar. */
export const ABILITY_ORDER: readonly AbilityId[] = [
  "quick",
  "bullets",
  "glitch",
  "hawkeyes",
] as const;

/** Shop product order: family × tier (Quick I…III, Bullets I…III, …). */
export const ABILITY_PRODUCT_ORDER: readonly AbilityProductId[] = [
  "quick",
  "quick2",
  "quick3",
  "bullets",
  "bullets2",
  "bullets3",
  "glitch",
  "glitch2",
  "glitch3",
  "hawkeyes",
  "hawkeyes2",
  "hawkeyes3",
] as const;

export const ABILITY_MAX_TIER: AbilityTier = 3;

/**
 * Active duration (seconds) by tier for the classic four.
 * Derived from skills catalog (Quick I/II/III values).
 */
export const ABILITY_TIER_DURATION_S: Readonly<Record<AbilityTier, number>> = {
  1: SKILL_PRODUCTS.quick.value,
  2: SKILL_PRODUCTS.quick2.value,
  3: SKILL_PRODUCTS.quick3.value,
} as const;

/** Max duration (Tier 3) — bots / unrestricted use this. */
export const ABILITY_MAX_DURATION_S = ABILITY_TIER_DURATION_S[3];

/**
 * Legacy per-ability CD seconds (unused by charge model).
 * Kept for {@link abilityCooldownTicks} / historical AbilityDef fields only.
 */
const LEGACY_COOLDOWN_S: Readonly<Record<AbilityId, number>> = {
  quick: 8,
  bullets: 12,
  glitch: 10,
  hawkeyes: 14,
};

/** Family-level def (HUD glyph). Shop uses {@link AbilityProductDef}. */
export type AbilityDef = {
  id: AbilityId;
  /** Short HUD label (family name). */
  label: string;
  /** Single-letter glyph for compact HUD slots. */
  glyph: string;
  /**
   * Default / max duration (Tier 3). Prefer
   * {@link durationSForOwned} for real players.
   */
  durationS: number;
  /**
   * Legacy per-ability CD (unused). Prefer
   * {@link ABILITY_GLOBAL_LOCK_S}, {@link ABILITY_BAR_REGEN_S},
   * {@link ABILITY_DOOR_REGEN_S}.
   */
  cooldownS: number;
  /** Tier 1 shop level gate (from skills catalog). */
  minLevel: number;
  /** Tier 1 permanent ownership cost in coins (from skills catalog). */
  coinCost: number;
  /** Short family blurb (no duration — tiers differ). */
  blurb: string;
};

export type AbilityProductDef = {
  id: AbilityProductId;
  family: AbilityId;
  tier: AbilityTier;
  /** Shop / confirm label, e.g. "Quick II". */
  label: string;
  /** Active duration (wall-clock seconds) — from skills product `value`. */
  durationS: number;
  /** Shop level gate. */
  minLevel: number;
  /** Permanent ownership cost in coins. */
  coinCost: number;
  /** Previous tier product, or null for Tier 1. */
  requires: AbilityProductId | null;
  /** Short tooltip / shop blurb including duration. */
  blurb: string;
};

/**
 * Distance (world units) to enemy door geometry at which Glitch is always
 * forced visible. Applied every tick while Glitch is active.
 */
export const GLITCH_DOOR_FORCE_VISIBLE_U = 5;

function productFromSkill(id: AbilityProductId): AbilityProductDef {
  const p = SKILL_PRODUCTS[id];
  const family = p.skill as AbilityId;
  // requires is always the previous tier product (or null); avoid
  // isAbilityProductId here — ABILITY_PRODUCTS is still initializing.
  const requires =
    p.requires != null &&
      (ABILITY_PRODUCT_ORDER as readonly string[]).includes(p.requires)
      ? (p.requires as AbilityProductId)
      : null;
  return {
    id,
    family,
    tier: p.tier as AbilityTier,
    label: p.label,
    durationS: p.value,
    minLevel: p.minLevel,
    coinCost: p.coinCost,
    requires,
    blurb: p.blurb,
  };
}

function defFromSkill(id: AbilityId): AbilityDef {
  const skill = SKILL_DEFS[id];
  const products = productsForSkill(id);
  const t1 = products[0]!;
  const max = products[products.length - 1]!;
  return {
    id,
    label: skill.label,
    glyph: skill.glyph,
    durationS: max.value,
    cooldownS: LEGACY_COOLDOWN_S[id],
    minLevel: t1.minLevel,
    coinCost: t1.coinCost,
    blurb: skill.effectBlurb + (skill.effectBlurb.endsWith(".") ? "" : "."),
  };
}

export const ABILITY_PRODUCTS: Readonly<
  Record<AbilityProductId, AbilityProductDef>
> = {
  quick: productFromSkill("quick"),
  quick2: productFromSkill("quick2"),
  quick3: productFromSkill("quick3"),
  bullets: productFromSkill("bullets"),
  bullets2: productFromSkill("bullets2"),
  bullets3: productFromSkill("bullets3"),
  glitch: productFromSkill("glitch"),
  glitch2: productFromSkill("glitch2"),
  glitch3: productFromSkill("glitch3"),
  hawkeyes: productFromSkill("hawkeyes"),
  hawkeyes2: productFromSkill("hawkeyes2"),
  hawkeyes3: productFromSkill("hawkeyes3"),
} as const;

/** Family defs for HUD (duration = max tier). Shop uses products. */
export const ABILITY_DEFS: Readonly<Record<AbilityId, AbilityDef>> = {
  quick: defFromSkill("quick"),
  bullets: defFromSkill("bullets"),
  glitch: defFromSkill("glitch"),
  hawkeyes: defFromSkill("hawkeyes"),
} as const;

export function isAbilityId(id: string | null | undefined): id is AbilityId {
  return (
    id === "quick" ||
    id === "bullets" ||
    id === "glitch" ||
    id === "hawkeyes"
  );
}

export function isAbilityProductId(
  id: string | null | undefined,
): id is AbilityProductId {
  return (
    typeof id === "string" &&
    (ABILITY_PRODUCT_ORDER as readonly string[]).includes(id)
  );
}

export function isAbilityTier(n: number): n is AbilityTier {
  return n === 1 || n === 2 || n === 3;
}

export function getAbilityDef(id: AbilityId): AbilityDef {
  return ABILITY_DEFS[id];
}

export function getAbilityProduct(id: AbilityProductId): AbilityProductDef {
  return ABILITY_PRODUCTS[id];
}

/** Products for one family, tier 1 → 3. */
export function productsForFamily(
  family: AbilityId,
): readonly AbilityProductDef[] {
  return productsForSkill(family).map((p) => ABILITY_PRODUCTS[p.id as AbilityProductId]);
}

/** Ability at HUD slot index 0…3, or null if out of range. */
export function abilityAtSlot(index: number): AbilityId | null {
  if (!Number.isInteger(index) || index < 0 || index >= ABILITY_ORDER.length) {
    return null;
  }
  return ABILITY_ORDER[index]!;
}

/** BindableAction suffix for slot 0…3 → ability1…ability4. */
export function abilityBindAction(
  index: number,
): "ability1" | "ability2" | "ability3" | "ability4" | null {
  if (index === 0) return "ability1";
  if (index === 1) return "ability2";
  if (index === 2) return "ability3";
  if (index === 3) return "ability4";
  return null;
}

/**
 * Active duration in sim ticks (ceil so the window is never shorter than
 * wall-clock seconds × tick rate).
 *
 * Delegates to {@link timedSkillDurationTicks} (skills catalog).
 *
 * @param owned When omitted or null → max tier (bots / unrestricted).
 *              When an array → highest owned tier for this family (0 → 0 ticks).
 */
export function abilityDurationTicks(
  id: AbilityId,
  tickHz: number = TICK_HZ,
  owned?: readonly AbilityProductId[] | null,
): number {
  return timedSkillDurationTicks(
    id,
    tickHz,
    owned as readonly SkillProductId[] | null | undefined,
  );
}

/**
 * Global lock after activate: top bar drains, no other ability may start.
 * Default matches max ability duration (Tier 3). Prefer locking for the
 * activated window length via {@link abilityGlobalLockTicksForDuration}.
 */
export const ABILITY_GLOBAL_LOCK_S = ABILITY_MAX_DURATION_S;

/**
 * After global lock ends: top bar reverse-fills and non-spent slots undim.
 * Activations blocked until this completes.
 */
export const ABILITY_BAR_REGEN_S = 1;

/**
 * After door capture: spent charges restore over this window (also unlocks
 * the full kit after spawn/death, when every activatable skill starts spent).
 * Activations blocked until this completes.
 */
export const ABILITY_DOOR_REGEN_S = 1;

function abilitySecondsToTicks(
  seconds: number,
  tickHz: number = TICK_HZ,
): number {
  const hz = tickHz > 0 && Number.isFinite(tickHz) ? tickHz : TICK_HZ;
  const s =
    typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
      ? seconds
      : 0;
  return Math.ceil(s * hz);
}

/** Global lock duration in sim ticks (max / default). */
export function abilityGlobalLockTicks(tickHz: number = TICK_HZ): number {
  return abilitySecondsToTicks(ABILITY_GLOBAL_LOCK_S, tickHz);
}

/** Global lock ticks for a specific active duration (seconds). */
export function abilityGlobalLockTicksForDuration(
  durationS: number,
  tickHz: number = TICK_HZ,
): number {
  return abilitySecondsToTicks(durationS, tickHz);
}

/** Post-use bar reverse-fill duration in sim ticks. */
export function abilityBarRegenTicks(tickHz: number = TICK_HZ): number {
  return abilitySecondsToTicks(ABILITY_BAR_REGEN_S, tickHz);
}

/** Door-capture charge regen duration in sim ticks. */
export function abilityDoorRegenTicks(tickHz: number = TICK_HZ): number {
  return abilitySecondsToTicks(ABILITY_DOOR_REGEN_S, tickHz);
}

/**
 * Legacy per-ability cooldown ticks (unused by charge model).
 * Prefer {@link abilityGlobalLockTicks}.
 */
export function abilityCooldownTicks(
  id: AbilityId,
  tickHz: number = TICK_HZ,
): number {
  const hz = tickHz > 0 && Number.isFinite(tickHz) ? tickHz : TICK_HZ;
  return Math.ceil(getAbilityDef(id).cooldownS * hz);
}

/**
 * True while `tick` is strictly before the exclusive end tick.
 * Missing / non-finite end → inactive.
 */
export function isAbilityActiveAt(
  endsAtTick: number | null | undefined,
  tick: number,
): boolean {
  return (
    typeof endsAtTick === "number" &&
    Number.isFinite(endsAtTick) &&
    Number.isFinite(tick) &&
    tick < endsAtTick
  );
}

/**
 * Compact wire entry for active skill windows (timed buffs, or a short
 * instant flash for VFX). Id is {@link SkillId} so all skills share the
 * same snapshot path.
 */
export type AbilitySnapEntry = {
  id: SkillId;
  /** Sim tick when the active window ends (exclusive). */
  endsAtTick: number;
  /**
   * Legacy per-ability CD end tick (unused by charge model).
   * Prefer snapshot-level lock/regen fields.
   */
  cooldownEndsAtTick?: number;
  /**
   * Pre-warp eye pose for rewind / teleport VFX (ghost + tracer).
   * Present only while the instant flash is live for those skills.
   */
  fromX?: number;
  fromY?: number;
  fromZ?: number;
};

/** Horizontal point for door-segment distance checks. */
export type GlitchDoorPoint = { x: number; z: number };

/**
 * Shortest horizontal distance from a point to a finite door segment.
 */
export function distPointToSegment2d(
  px: number,
  pz: number,
  a: GlitchDoorPoint,
  b: GlitchDoorPoint,
): number {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const ab2 = abx * abx + abz * abz;
  if (ab2 < 1e-12) return Math.hypot(px - a.x, pz - a.z);
  let t = ((px - a.x) * abx + (pz - a.z) * abz) / ab2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a.x + abx * t), pz - (a.z + abz * t));
}

/**
 * True when Glitch must force the player visible (within maxDist of the
 * enemy door segment). Applied every tick while Glitch is active.
 */
export function isGlitchForcedVisible(
  px: number,
  pz: number,
  doorA: GlitchDoorPoint,
  doorB: GlitchDoorPoint,
  maxDist: number = GLITCH_DOOR_FORCE_VISIBLE_U,
): boolean {
  const limit =
    typeof maxDist === "number" && Number.isFinite(maxDist) && maxDist > 0
      ? maxDist
      : GLITCH_DOOR_FORCE_VISIBLE_U;
  return distPointToSegment2d(px, pz, doorA, doorB) <= limit;
}

/**
 * @deprecated Glitch no longer uses a long edge fade — see {@link GLITCH_BLIP_GONE_S}.
 * Kept so older tests / imports still resolve; value unused by the blip curve.
 */
export const GLITCH_SELF_FADE_S = 0.08;

/** First "gone" phase of the Glitch entrance blip (seconds). */
export const GLITCH_BLIP_GONE_S = 0.04;
/** "Flash back" visible phase of the Glitch entrance blip (seconds). */
export const GLITCH_BLIP_BACK_S = 0.04;

/**
 * Glitch visibility / FP gun opacity while the ability is active.
 *
 * Entrance blip then stay gone for the full window (no long fade-in at end):
 *   0 → first-gone → flash-back → fully invisible until duration ends → solid.
 *
 * Used by remote mesh visibility and the local first-person gun.
 *
 * @param elapsedS Seconds since activate.
 * @param durationS Total ability window (defaults to max Glitch duration).
 * @param _fadeS Ignored (legacy arg for call-site compat).
 */
export function glitchSelfGunOpacity(
  elapsedS: number,
  durationS: number = ABILITY_MAX_DURATION_S,
  _fadeS: number = GLITCH_SELF_FADE_S,
): number {
  return glitchVisibilityOpacity(elapsedS, durationS);
}

/**
 * Same curve as {@link glitchSelfGunOpacity} — preferred name for remotes.
 */
export function glitchVisibilityOpacity(
  elapsedS: number,
  durationS: number = ABILITY_MAX_DURATION_S,
): number {
  const dur =
    typeof durationS === "number" && Number.isFinite(durationS) && durationS > 0
      ? durationS
      : ABILITY_MAX_DURATION_S;
  const t =
    typeof elapsedS === "number" && Number.isFinite(elapsedS) ? elapsedS : 0;
  // Outside the window → solid (caller usually skips when inactive).
  if (t <= 0 || t >= dur) return 1;

  // Short windows: compress the blip so it never exceeds the full duration.
  let gone = GLITCH_BLIP_GONE_S;
  let back = GLITCH_BLIP_BACK_S;
  const blipTotal = gone + back;
  if (blipTotal > dur * 0.5) {
    const scale = (dur * 0.5) / blipTotal;
    gone *= scale;
    back *= scale;
  }

  if (t < gone) return 0; // first gone
  if (t < gone + back) return 1; // flash back
  return 0; // stay gone for the rest of the window
}

/** Wire flag for remote Glitch visibility (omitted when ability inactive). */
export type GlitchSnapState = "hidden" | "revealed";

// ── Ownership helpers (classic four only; full tree uses skills.ts) ───────

/** Empty ownership ledger (no products purchased). */
export function emptyOwnedAbilities(): AbilityProductId[] {
  return [];
}

/**
 * Normalize a wire/DB owned-abilities list to the classic four families.
 * Drops unknowns, de-dupes, preserves {@link ABILITY_PRODUCT_ORDER}.
 * Prefer {@link normalizeOwnedSkills} for the full skill tree.
 */
export function normalizeOwnedAbilities(
  raw: unknown,
): AbilityProductId[] {
  const set = new Set<AbilityProductId>();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === "string" && isAbilityProductId(item)) set.add(item);
    }
  } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    // Tolerate `{ quick: true, … }` maps from older prototypes.
    for (const key of Object.keys(raw as Record<string, unknown>)) {
      if (isAbilityProductId(key) && (raw as Record<string, unknown>)[key]) {
        set.add(key);
      }
    }
  }
  return ABILITY_PRODUCT_ORDER.filter((id) => set.has(id));
}

/** JSON string for the classic-four owned list (not full skill tree). */
export function serializeOwnedAbilities(
  owned: readonly AbilityProductId[] | null | undefined,
): string {
  return JSON.stringify(normalizeOwnedAbilities(owned ?? emptyOwnedAbilities()));
}

/** Parse a DB column or API field into a sorted classic-four product list. */
export function parseOwnedAbilitiesColumn(raw: unknown): AbilityProductId[] {
  if (raw == null) return emptyOwnedAbilities();
  if (typeof raw === "string") {
    const s = raw.trim();
    if (!s) return emptyOwnedAbilities();
    try {
      return normalizeOwnedAbilities(JSON.parse(s));
    } catch {
      return emptyOwnedAbilities();
    }
  }
  return normalizeOwnedAbilities(raw);
}

/**
 * Highest owned tier for a family (0 if none).
 * Orphan higher tiers (without lower) still count — do not destroy paid data.
 */
export function highestOwnedTier(
  family: AbilityId,
  owned: readonly AbilityProductId[] | null | undefined,
): 0 | AbilityTier {
  if (!isAbilityId(family)) return 0;
  const tier = highestOwnedSkillTier(
    family,
    owned as readonly SkillProductId[] | null | undefined,
  );
  return tier as 0 | AbilityTier;
}

/** Whether any tier of this family is owned. */
export function ownsAbilityFamily(
  family: AbilityId,
  owned: readonly AbilityProductId[] | null | undefined,
): boolean {
  return ownsSkill(
    family,
    owned as readonly SkillProductId[] | null | undefined,
  );
}

/**
 * Active duration seconds for a family given ownership.
 * `null` / omitted owned → max tier (bots). Empty array → 0.
 * Delegates to {@link timedSkillDurationSForOwned}.
 */
export function durationSForOwned(
  family: AbilityId,
  owned?: readonly AbilityProductId[] | null,
): number {
  if (!isAbilityId(family)) return 0;
  return timedSkillDurationSForOwned(
    family,
    owned as readonly SkillProductId[] | null | undefined,
  );
}

/**
 * Min account XP level required to buy this product in the shop.
 * Family ids (`quick`) resolve as Tier 1 products (same string).
 */
export function minLevelForAbility(id: AbilityProductId | string): number {
  return minLevelForSkillProduct(id);
}

/**
 * Coin cost for permanent ownership of a product.
 * Family ids resolve as Tier 1 products.
 */
export function coinCostForAbility(id: AbilityProductId | string): number {
  if (!isAbilityProductId(id)) return 0;
  return coinCostForSkillProduct(id);
}

/** Level gate for the shop (right to buy), not equip/use by itself. */
export function isAbilityShopUnlocked(
  id: AbilityProductId | string,
  level: number,
): boolean {
  if (!isAbilityProductId(id)) return false;
  return isSkillProductLevelUnlocked(id, level);
}

/**
 * Whether the player permanently owns this **product** (exact id).
 * For “any tier of family” use {@link ownsAbilityFamily}.
 */
export function isAbilityOwned(
  id: AbilityProductId | string,
  owned: readonly AbilityProductId[] | null | undefined,
): boolean {
  return isSkillProductOwned(
    id,
    owned as readonly SkillProductId[] | null | undefined,
  );
}

/**
 * Whether the player may buy this product now.
 * Delegates to {@link canPurchaseSkillProduct} (combat-ready + tree prereqs).
 */
export function canPurchaseAbility(
  id: AbilityProductId | string,
  level: number,
  owned: readonly AbilityProductId[] | null | undefined,
): boolean {
  if (!isAbilityProductId(id)) return false;
  return canPurchaseSkillProduct(
    id,
    level,
    owned as readonly SkillProductId[] | null | undefined,
  );
}

/** Copy owned list and add product `id` (no-op if already owned / invalid). */
export function withOwnedAbility(
  owned: readonly AbilityProductId[] | null | undefined,
  id: AbilityProductId | string,
): AbilityProductId[] {
  const base = normalizeOwnedAbilities(owned ?? emptyOwnedAbilities());
  if (!isAbilityProductId(id) || base.includes(id)) return base;
  return normalizeOwnedAbilities([...base, id]);
}

/**
 * Shop lock reason for an unowned product row.
 * Returns null when that product is owned.
 *
 * For HUD “family not owned” messages, pass the Tier 1 product id (`quick`)
 * or use {@link ownsAbilityFamily} separately.
 */
export function abilityLockMessage(
  id: AbilityProductId | string,
  level: number,
  owned: readonly AbilityProductId[] | null | undefined,
): string | null {
  if (!isAbilityProductId(id)) return null;
  if (isAbilityOwned(id, owned)) return null;
  const product = ABILITY_PRODUCTS[id];
  if (!isAbilityShopUnlocked(id, level)) {
    return `Reach level ${product.minLevel} to unlock ${product.label} in the shop`;
  }
  if (product.requires && !isAbilityOwned(product.requires, owned)) {
    const prev = ABILITY_PRODUCTS[product.requires];
    return `Buy ${prev.label} first`;
  }
  // Tree chain prereq (e.g. Glitch needs Quick I) — from skills catalog.
  const skillDef = SKILL_DEFS[product.family];
  if (
    skillDef.requiresSkill &&
    !ownsSkill(
      skillDef.requiresSkill,
      owned as readonly SkillProductId[] | null | undefined,
    )
  ) {
    const prevSkill = SKILL_DEFS[skillDef.requiresSkill];
    return `Buy ${prevSkill.label} I first`;
  }
  return `Buy ${product.label} in Profile (${product.coinCost} coins)`;
}

/**
 * Owned classic-four products legal for a seed account at `level`
 * (full skill-tree unlock path, filtered to ability products).
 * Used by fake ladder seeds — not auto-granted to real players.
 */
export function ownedAbilitiesForLevel(level: number): AbilityProductId[] {
  return ownedSkillsForLevel(level).filter(isAbilityProductId);
}
