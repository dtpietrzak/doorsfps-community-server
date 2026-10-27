import { TICK_HZ } from "./game.ts";

/**
 * Talent tree catalog — shared client + authority shop + admin sandbox.
 *
 * Three categories with vertical skill chains (skill above is the prereq).
 * Within a skill, tiers are sequential (I → II → III). Medic maxes at II.
 *
 * Ownership + coin shop use {@link SkillProductId}. Match combat for live
 * skills is gated on {@link isLiveAbilitySkill} / {@link LIVE_ABILITY_SKILL_IDS}.
 * Single catalog for blurbs, durations, min levels, and coin costs (PR-3).
 * {@link ./abilities.ts} is a thin combat/compat layer over this module.
 *
 * ## Match activation (PR-1)
 *
 * Wire activate payload (`NetEvents.Ability`) uses family {@link SkillId}
 * (not product tier). Client prediction + server {@link Player.tryActivateAbility}
 * branch on {@link SkillDef.kind}:
 *
 * | Kind | Activate | Charge | Global lock | Active window |
 * | --- | --- | --- | --- | --- |
 * | **timed** | keybind | spent when window ends | during window | `abilityEndsAtTick` |
 * | **instant** | keybind | spent on activate | {@link INSTANT_SKILL_LOCK_S} then bar regen | optional 1-tick flash for VFX |
 * | **passive** | never | n/a | n/a | always-on when equipped + owned |
 *
 * Instants use the same charge + global-lock economy as timed skills so
 * loadout slots compete. Passives never call activate.
 *
 * ## Match loadout (PR-2)
 *
 * {@link SkillLoadout} is the player's Ability 1–4 bar. Signed-in accounts
 * persist it on the authority player row (`skill_loadout`) so it follows
 * across browsers. The client caches the same slots in localStorage (My Skills
 * + guests) and emits `NetEvents.SkillLoadout` on join. Join tokens carry the
 * saved bar so a match can start before that packet. Server
 * {@link normalizeSkillLoadout} validates owned + unique; activate and
 * passives require {@link isSkillEquipped}. Match bots get level-gated
 * ownership + a favorite-4 loadout; `null` loadout remains unrestricted for
 * unit tests.
 */

export type SkillCategoryId = "hacker" | "medic" | "marksman";

export type SkillId =
  | "quick"
  | "glitch"
  | "rewind"
  | "teleport"
  | "selfHeal"
  | "teamHeal"
  | "leech"
  | "forceField"
  | "bullets"
  | "hawkeyes"
  | "rapidFire"
  | "oneShot";

/**
 * Timed buff, instant fire-and-forget, or always-on passive.
 * @see Match activation (PR-1) in this file's module docs.
 */
export type SkillKind = "timed" | "instant" | "passive";

/**
 * Global lock after an instant skill activate (seconds).
 * Top bar drains; no other skill may start. After this, the usual
 * ability bar reverse-fill applies ({@link ./abilities.ts ABILITY_BAR_REGEN_S}).
 * Timed skills lock for their active window instead.
 */
export const INSTANT_SKILL_LOCK_S = 1;

/**
 * Instant VFX flash length on the wire (sim ticks @ {@link TICK_HZ}).
 * ~100 ms so 20 Hz motion snaps always carry the flash for clients.
 * Charge is already spent on activate — flash expiry must not re-spend.
 */
export const INSTANT_SKILL_FLASH_TICKS = 6;

/** What the product `value` scales. */
export type SkillScale =
  | "duration"
  | "time"
  | "distance"
  | "hp"
  | "hpPerDamage";

export type SkillTier = 1 | 2 | 3;

export type SkillMaxTier = 1 | 2 | 3;

/** Permanent tree product id (tier 1 = skill id). */
export type SkillProductId =
  | "quick"
  | "quick2"
  | "quick3"
  | "glitch"
  | "glitch2"
  | "glitch3"
  | "rewind"
  | "rewind2"
  | "rewind3"
  | "teleport"
  | "teleport2"
  | "teleport3"
  | "selfHeal"
  | "selfHeal2"
  | "teamHeal"
  | "teamHeal2"
  | "leech"
  | "leech2"
  | "forceField"
  | "forceField2"
  | "bullets"
  | "bullets2"
  | "bullets3"
  | "hawkeyes"
  | "hawkeyes2"
  | "hawkeyes3"
  | "rapidFire"
  | "rapidFire2"
  | "rapidFire3"
  | "oneShot"
  | "oneShot2"
  | "oneShot3";

export type SkillCategoryDef = {
  id: SkillCategoryId;
  label: string;
  /** Skill chain top → bottom (prereq order). */
  skills: readonly SkillId[];
};

export type SkillDef = {
  id: SkillId;
  category: SkillCategoryId;
  label: string;
  /** Single-letter glyph for compact nodes. */
  glyph: string;
  kind: SkillKind;
  scale: SkillScale;
  /** Previous skill in the category chain, or null for roots. */
  requiresSkill: SkillId | null;
  maxTier: SkillMaxTier;
  /** Effect blurb without tier-specific value. */
  effectBlurb: string;
  /**
   * Match visual readout (My Skills tooltip subtitle).
   * Describes what opponents / self see while the skill is active.
   */
  vfxBlurb: string;
};

export type SkillProductDef = {
  id: SkillProductId;
  skill: SkillId;
  category: SkillCategoryId;
  tier: SkillTier;
  /** Shop / tree label, e.g. "Quick II". */
  label: string;
  /** Account XP level gate. */
  minLevel: number;
  /** Permanent ownership cost in coins. */
  coinCost: number;
  /** Previous tier product, or null for tier 1. */
  requires: SkillProductId | null;
  /** Effect value (duration s, rewind s, blink u, heal hp, leech fraction). */
  value: number;
  valueUnit: string;
  blurb: string;
};

export const SKILL_CATEGORY_ORDER: readonly SkillCategoryId[] = [
  "hacker",
  "medic",
  "marksman",
] as const;

export const SKILL_CATEGORIES: Readonly<
  Record<SkillCategoryId, SkillCategoryDef>
> = {
  hacker: {
    id: "hacker",
    label: "Hacker",
    skills: ["quick", "glitch", "rewind", "teleport"],
  },
  medic: {
    id: "medic",
    label: "Medic",
    skills: ["selfHeal", "teamHeal", "leech", "forceField"],
  },
  marksman: {
    id: "marksman",
    label: "Marksman",
    skills: ["bullets", "hawkeyes", "rapidFire", "oneShot"],
  },
} as const;

const TIER_ROMAN: Record<SkillTier, string> = {
  1: "I",
  2: "II",
  3: "III",
};

/**
 * Skills with a shipped match combat effect (purchase + activate allowed).
 * Durations / costs live only in this module (not dual-mapped in abilities.ts).
 */
export const LIVE_ABILITY_SKILL_IDS: readonly SkillId[] = [
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
] as const;

/** Tier 1 cost multiplier; T2 = 2×, T3 = 4× (matches live ability shop). */
const TIER_COST_MULT: Record<SkillTier, number> = {
  1: 1,
  2: 2,
  3: 4,
};

/**
 * Starter skills: tier I is free (level lock only). The authority grants each
 * one when the player first reaches its level and drops it into this loadout
 * slot (0 = slot 1). Higher tiers keep the normal price.
 */
export const STARTER_SKILL_SLOTS: Readonly<Partial<Record<SkillId, number>>> = {
  quick: 0,
  bullets: 1,
  selfHeal: 2,
};

type SkillBase = {
  category: SkillCategoryId;
  label: string;
  glyph: string;
  kind: SkillKind;
  scale: SkillScale;
  requiresSkill: SkillId | null;
  maxTier: SkillMaxTier;
  effectBlurb: string;
  /** Match visual readout for tooltips / My Skills. */
  vfxBlurb: string;
  /** Tier → value. Length must match maxTier. */
  values: readonly number[];
  valueUnit: string;
  /** Tier → min account level. Length must match maxTier. */
  minLevels: readonly number[];
  /**
   * Tier 1 coin cost. Higher tiers use {@link TIER_COST_MULT}.
   * Classic four (Quick / Glitch / Bullets / Hawkeyes) use the live shop curve.
   */
  coinCost: number;
};

const SKILL_BASE: Readonly<Record<SkillId, SkillBase>> = {
  quick: {
    category: "hacker",
    label: "Quick",
    glyph: "Q",
    kind: "timed",
    scale: "duration",
    requiresSkill: null,
    maxTier: 3,
    effectBlurb: "Energy actions cost no energy",
    vfxBlurb: "Feet glow in your team color while active.",
    values: [1.5, 2, 2.5],
    valueUnit: "s",
    minLevels: [2, 6, 10],
    coinCost: 25,
  },
  glitch: {
    category: "hacker",
    label: "Glitch",
    glyph: "G",
    kind: "timed",
    scale: "duration",
    requiresSkill: "quick",
    maxTier: 3,
    effectBlurb: "Invisible except near doors; cannot shoot",
    vfxBlurb:
      "Quick blip — gone, flash back, then stay invisible. Your gun does the same.",
    values: [2, 2.5, 3],
    valueUnit: "s",
    minLevels: [5, 8, 12],
    coinCost: 50,
  },
  rewind: {
    category: "hacker",
    label: "Rewind",
    glyph: "R",
    kind: "instant",
    scale: "time",
    requiresSkill: "glitch",
    maxTier: 3,
    effectBlurb: "Return to where you were a moment ago",
    vfxBlurb:
      "Grey ghost at where you left for 0.5s; bright flash where you reappear.",
    values: [1.5, 2.25, 3],
    valueUnit: "s",
    minLevels: [9, 13, 16],
    coinCost: 75,
  },
  teleport: {
    category: "hacker",
    label: "Teleport",
    glyph: "T",
    kind: "instant",
    scale: "distance",
    requiresSkill: "rewind",
    maxTier: 3,
    effectBlurb: "Blink forward in the direction you are aiming",
    vfxBlurb: "Fading tracer line from start to end so the path stays readable.",
    values: [3, 5, 7],
    valueUnit: "u",
    minLevels: [15, 17, 19],
    coinCost: 100,
  },
  selfHeal: {
    category: "medic",
    label: "Self heal",
    glyph: "S",
    kind: "instant",
    scale: "hp",
    requiresSkill: null,
    maxTier: 2,
    effectBlurb: "Heal yourself",
    vfxBlurb: "Green flash on you (screen wash in first person).",
    values: [15, 25],
    valueUnit: "hp",
    minLevels: [4, 11],
    coinCost: 30,
  },
  teamHeal: {
    category: "medic",
    label: "Team heal",
    glyph: "H",
    kind: "instant",
    scale: "hp",
    requiresSkill: "selfHeal",
    maxTier: 2,
    effectBlurb: "Heal your alive teammates (not you)",
    vfxBlurb:
      "Purple flash on you; green flash on visible teammates (skips cloaked allies).",
    values: [15, 25],
    valueUnit: "hp",
    minLevels: [7, 17],
    coinCost: 50,
  },
  leech: {
    category: "medic",
    label: "Leech",
    glyph: "L",
    kind: "passive",
    scale: "hpPerDamage",
    requiresSkill: "teamHeal",
    maxTier: 2,
    effectBlurb: "Heal for a fraction of damage you deal",
    vfxBlurb:
      "Light green flash on damage dealt — HP bar for you, body glow for others.",
    values: [0.1, 0.15],
    valueUnit: "heal/dmg",
    minLevels: [14, 19],
    coinCost: 70,
  },
  forceField: {
    category: "medic",
    label: "Force Field",
    glyph: "F",
    kind: "timed",
    scale: "duration",
    requiresSkill: "leech",
    maxTier: 2,
    effectBlurb: "Invincible",
    vfxBlurb: "Yellow shield glow on your body and a yellow edge wash in first person.",
    values: [1, 2],
    valueUnit: "s",
    minLevels: [18, 20],
    coinCost: 90,
  },
  bullets: {
    category: "marksman",
    label: "Bullets",
    glyph: "B",
    kind: "timed",
    scale: "duration",
    requiresSkill: null,
    maxTier: 3,
    effectBlurb: "Shooting does not cost ammo",
    vfxBlurb: "Gun glows white while free-fire is active.",
    values: [2, 2.5, 3],
    valueUnit: "s",
    minLevels: [3, 6, 10],
    coinCost: 40,
  },
  hawkeyes: {
    category: "marksman",
    label: "Hawkeyes",
    glyph: "E",
    kind: "timed",
    scale: "duration",
    requiresSkill: "bullets",
    maxTier: 3,
    effectBlurb: "Perfect accuracy",
    vfxBlurb: "Visor turns white and glows with your team color.",
    values: [2, 2.5, 3],
    valueUnit: "s",
    minLevels: [5, 8, 12],
    coinCost: 60,
  },
  rapidFire: {
    category: "marksman",
    label: "Rapid fire",
    glyph: "F",
    kind: "timed",
    scale: "duration",
    requiresSkill: "hawkeyes",
    maxTier: 3,
    effectBlurb: "Double shoot and reload speeds (+1 spare mag)",
    vfxBlurb: "Gun glows yellow while the speed buff is active.",
    values: [2, 2.5, 3],
    valueUnit: "s",
    minLevels: [9, 13, 16],
    coinCost: 80,
  },
  oneShot: {
    category: "marksman",
    label: "One-shot",
    glyph: "O",
    kind: "timed",
    scale: "duration",
    requiresSkill: "rapidFire",
    maxTier: 3,
    effectBlurb: "One shot = kill while active",
    vfxBlurb: "Gun goes black with a purple glow while lethal shots are armed.",
    values: [2, 2.5, 3],
    valueUnit: "s",
    minLevels: [15, 17, 19],
    coinCost: 100,
  },
};

function productIdFor(skill: SkillId, tier: SkillTier): SkillProductId {
  if (tier === 1) return skill as SkillProductId;
  return `${skill}${tier}` as SkillProductId;
}

/** Tier list for a skill's max tier (1 → max). */
function tiersForMax(max: SkillMaxTier): SkillTier[] {
  if (max === 1) return [1];
  if (max === 2) return [1, 2];
  return [1, 2, 3];
}

function formatValue(value: number, unit: string): string {
  if (unit === "heal/dmg") {
    const pct = Math.round(value * 100);
    return `${pct}%`;
  }
  if (Number.isInteger(value)) return `${value}${unit === "s" || unit === "u" || unit === "hp" ? unit : ` ${unit}`}`;
  const text = value % 1 === 0 ? `${value}` : value.toFixed(1);
  if (unit === "s" || unit === "u" || unit === "hp") return `${text}${unit}`;
  return `${text} ${unit}`;
}

function blurbFor(base: SkillBase, value: number): string {
  const shown = formatValue(value, base.valueUnit);
  switch (base.kind) {
    case "timed":
      return `${base.effectBlurb} for ${shown}.`;
    case "instant":
      if (base.scale === "time") {
        return `${base.effectBlurb} (${shown} window).`;
      }
      if (base.scale === "distance") {
        return `${base.effectBlurb} (${shown}).`;
      }
      if (base.scale === "hp") {
        return `${base.effectBlurb} (${shown}).`;
      }
      return `${base.effectBlurb} (${shown}).`;
    case "passive":
      return `${base.effectBlurb} (${shown}).`;
  }
}

function buildProduct(skill: SkillId, tier: SkillTier): SkillProductDef {
  const base = SKILL_BASE[skill];
  if (tier > base.maxTier) {
    throw new Error(`Skill ${skill} has no tier ${tier}`);
  }
  const idx = tier - 1;
  const value = base.values[idx]!;
  const minLevel = base.minLevels[idx]!;
  return {
    id: productIdFor(skill, tier),
    skill,
    category: base.category,
    tier,
    label: `${base.label} ${TIER_ROMAN[tier]}`,
    minLevel,
    coinCost: tier === 1 && STARTER_SKILL_SLOTS[skill] != null
      ? 0
      : base.coinCost * TIER_COST_MULT[tier],
    requires: tier === 1 ? null : productIdFor(skill, (tier - 1) as SkillTier),
    value,
    valueUnit: base.valueUnit,
    blurb: blurbFor(base, value),
  };
}

function buildSkillDef(id: SkillId): SkillDef {
  const base = SKILL_BASE[id];
  return {
    id,
    category: base.category,
    label: base.label,
    glyph: base.glyph,
    kind: base.kind,
    scale: base.scale,
    requiresSkill: base.requiresSkill,
    maxTier: base.maxTier,
    effectBlurb: base.effectBlurb,
    vfxBlurb: base.vfxBlurb,
  };
}

/** All skill ids in category order, chain order. */
export const SKILL_ORDER: readonly SkillId[] = SKILL_CATEGORY_ORDER.flatMap(
  (cat) => SKILL_CATEGORIES[cat].skills,
);

export const SKILL_DEFS: Readonly<Record<SkillId, SkillDef>> = Object
  .fromEntries(
    SKILL_ORDER.map((id) => [id, buildSkillDef(id)]),
  ) as Readonly<Record<SkillId, SkillDef>>;

/** Product order: category → skill chain → tiers ascending. */
export const SKILL_PRODUCT_ORDER: readonly SkillProductId[] = SKILL_ORDER
  .flatMap((skill) => {
    const max = SKILL_BASE[skill].maxTier;
    return tiersForMax(max).map((t) => productIdFor(skill, t));
  });

function buildAllProducts(): Record<SkillProductId, SkillProductDef> {
  const out = {} as Record<SkillProductId, SkillProductDef>;
  for (const skill of SKILL_ORDER) {
    for (const t of tiersForMax(SKILL_BASE[skill].maxTier)) {
      const p = buildProduct(skill, t);
      out[p.id] = p;
    }
  }
  return out;
}

export const SKILL_PRODUCTS: Readonly<
  Record<SkillProductId, SkillProductDef>
> = buildAllProducts();

export function isSkillCategoryId(
  id: string | null | undefined,
): id is SkillCategoryId {
  return id === "hacker" || id === "medic" || id === "marksman";
}

export function isSkillId(id: string | null | undefined): id is SkillId {
  return typeof id === "string" &&
    Object.prototype.hasOwnProperty.call(SKILL_DEFS, id);
}

export function isSkillProductId(
  id: string | null | undefined,
): id is SkillProductId {
  return typeof id === "string" &&
    Object.prototype.hasOwnProperty.call(SKILL_PRODUCTS, id);
}

export function isSkillTier(n: number): n is SkillTier {
  return n === 1 || n === 2 || n === 3;
}

export function getSkillDef(id: SkillId): SkillDef {
  return SKILL_DEFS[id];
}

export function getSkillProduct(id: SkillProductId): SkillProductDef {
  return SKILL_PRODUCTS[id];
}

export function getSkillCategory(id: SkillCategoryId): SkillCategoryDef {
  return SKILL_CATEGORIES[id];
}

/** Products for one skill, tier 1 → max. */
export function productsForSkill(
  skill: SkillId,
): readonly SkillProductDef[] {
  const def = SKILL_DEFS[skill];
  return tiersForMax(def.maxTier).map(
    (t) => SKILL_PRODUCTS[productIdFor(skill, t)],
  );
}

export function emptyOwnedSkills(): SkillProductId[] {
  return [];
}

/**
 * Normalize a wire/sandbox owned list.
 * Drops unknowns, de-dupes, preserves {@link SKILL_PRODUCT_ORDER}.
 */
export function normalizeOwnedSkills(
  raw: unknown,
): SkillProductId[] {
  const set = new Set<SkillProductId>();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === "string" && isSkillProductId(item)) set.add(item);
    }
  } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const key of Object.keys(raw as Record<string, unknown>)) {
      if (isSkillProductId(key) && (raw as Record<string, unknown>)[key]) {
        set.add(key);
      }
    }
  }
  return SKILL_PRODUCT_ORDER.filter((id) => set.has(id));
}

/** Highest owned tier for a skill (0 if none). */
export function highestOwnedSkillTier(
  skill: SkillId,
  owned: readonly SkillProductId[] | null | undefined,
): 0 | SkillTier {
  if (!isSkillId(skill) || !owned || owned.length === 0) return 0;
  let max: 0 | SkillTier = 0;
  for (const id of owned) {
    if (!isSkillProductId(id)) continue;
    const p = SKILL_PRODUCTS[id];
    if (p.skill !== skill) continue;
    if (p.tier > max) max = p.tier;
  }
  return max;
}

/**
 * Whether any tier of this skill is owned.
 * - `null` / `undefined` owned → unrestricted (bots / unit tests): all skills.
 * - Empty array → guest: nothing owned.
 * - Product list → any tier of the family counts.
 */
export function ownsSkill(
  skill: SkillId,
  owned: readonly SkillProductId[] | null | undefined,
): boolean {
  if (!isSkillId(skill)) return false;
  if (owned === null || owned === undefined) return true;
  return highestOwnedSkillTier(skill, owned) > 0;
}

/**
 * Whether `skill` is currently equipped in a match loadout.
 * - `null` / `undefined` loadout → unrestricted equip (bots / unit tests).
 * - Explicit slots → skill must appear in a non-null cell.
 */
export function isSkillEquipped(
  skill: SkillId,
  loadout: readonly SkillLoadoutSlot[] | null | undefined,
): boolean {
  if (!isSkillId(skill)) return false;
  if (loadout == null) return true;
  return loadout.includes(skill);
}

export function isSkillProductOwned(
  id: SkillProductId | string,
  owned: readonly SkillProductId[] | null | undefined,
): boolean {
  if (!isSkillProductId(id)) return false;
  if (!owned || owned.length === 0) return false;
  return owned.includes(id);
}

export function minLevelForSkillProduct(
  id: SkillProductId | string,
): number {
  if (isSkillProductId(id)) return SKILL_PRODUCTS[id].minLevel;
  return 1;
}

export function isSkillProductLevelUnlocked(
  id: SkillProductId | string,
  level: number,
): boolean {
  const safeLevel =
    typeof level === "number" && Number.isFinite(level) ? Math.floor(level) : 1;
  return safeLevel >= minLevelForSkillProduct(id);
}

/**
 * Coin cost for permanent ownership of a skill product.
 * Unknown ids → 0.
 */
export function coinCostForSkillProduct(
  id: SkillProductId | string,
): number {
  if (isSkillProductId(id)) return SKILL_PRODUCTS[id].coinCost;
  return 0;
}

/**
 * Whether the skill family is combat-ready (live match effect shipped).
 * Purchase is gated on this so players cannot buy dead content.
 */
export function isSkillProductCombatReady(
  id: SkillProductId | string,
): boolean {
  if (!isSkillProductId(id)) return false;
  return isLiveAbilitySkill(SKILL_PRODUCTS[id].skill);
}

/**
 * Whether the player may unlock this product now (sandbox / future shop).
 * Requires level gate, not already owned, previous tier owned, and previous
 * skill in the category chain at least tier I.
 *
 * Does **not** check coin balance or combat-ready — use
 * {@link canPurchaseSkillProduct} for the live shop.
 */
export function canUnlockSkillProduct(
  id: SkillProductId | string,
  level: number,
  owned: readonly SkillProductId[] | null | undefined,
): boolean {
  if (!isSkillProductId(id)) return false;
  const product = SKILL_PRODUCTS[id];
  if (!isSkillProductLevelUnlocked(id, level)) return false;
  if (isSkillProductOwned(id, owned)) return false;
  if (product.requires && !isSkillProductOwned(product.requires, owned)) {
    return false;
  }
  const skillDef = SKILL_DEFS[product.skill];
  if (skillDef.requiresSkill && !ownsSkill(skillDef.requiresSkill, owned)) {
    return false;
  }
  return true;
}

/**
 * Whether the player may buy this product in the live coin shop now.
 * Requires combat-ready skill, positive cost, level + tree prereqs
 * ({@link canUnlockSkillProduct}). Does not check coin balance.
 */
export function canPurchaseSkillProduct(
  id: SkillProductId | string,
  level: number,
  owned: readonly SkillProductId[] | null | undefined,
): boolean {
  if (!isSkillProductId(id)) return false;
  if (!isSkillProductCombatReady(id)) return false;
  if (coinCostForSkillProduct(id) <= 0 && !isStarterSkillProduct(id)) {
    return false;
  }
  return canUnlockSkillProduct(id, level, owned);
}

/** Tier I of a {@link STARTER_SKILL_SLOTS} skill (free, auto-granted). */
export function isStarterSkillProduct(id: SkillProductId | string): boolean {
  if (!isSkillProductId(id)) return false;
  const product = SKILL_PRODUCTS[id];
  return product.tier === 1 && STARTER_SKILL_SLOTS[product.skill] != null;
}

/**
 * Starter products the player has reached the level for but does not own
 * yet, in {@link STARTER_SKILL_SLOTS} order.
 */
export function starterSkillsDueAtLevel(
  level: number,
  owned: readonly SkillProductId[] | null | undefined,
): SkillProductId[] {
  const out: SkillProductId[] = [];
  for (const skill of Object.keys(STARTER_SKILL_SLOTS) as SkillId[]) {
    const id = productIdFor(skill, 1);
    if (isSkillProductOwned(id, owned)) continue;
    if (!isSkillProductCombatReady(id)) continue;
    if (!isSkillProductLevelUnlocked(id, level)) continue;
    out.push(id);
  }
  return out;
}

/** JSON string for the players.owned_abilities column (full skill product set). */
export function serializeOwnedSkills(
  owned: readonly SkillProductId[] | null | undefined,
): string {
  return JSON.stringify(normalizeOwnedSkills(owned ?? emptyOwnedSkills()));
}

/** Parse a DB column or API field into a sorted owned skill product list. */
export function parseOwnedSkillsColumn(raw: unknown): SkillProductId[] {
  if (raw == null) return emptyOwnedSkills();
  if (typeof raw === "string") {
    const s = raw.trim();
    if (!s) return emptyOwnedSkills();
    try {
      return normalizeOwnedSkills(JSON.parse(s));
    } catch {
      return emptyOwnedSkills();
    }
  }
  return normalizeOwnedSkills(raw);
}

/**
 * JSON string for the players.skill_loadout column (fixed 4 slots).
 * Serializes valid skill ids only; ownership is applied by the writer.
 */
export function serializeSkillLoadout(
  loadout: readonly SkillLoadoutSlot[] | null | undefined,
): string {
  return JSON.stringify(normalizeSkillLoadout(loadout, null));
}

/**
 * Parse a DB column or API field into a 4-slot loadout.
 * `null` / missing / corrupt → `null` (never saved). Ownership is applied
 * by the caller via {@link normalizeSkillLoadout}.
 */
export function parseSkillLoadoutColumn(raw: unknown): SkillLoadout | null {
  if (raw == null) return null;
  if (typeof raw === "string") {
    const s = raw.trim();
    if (!s) return null;
    try {
      const parsed = JSON.parse(s);
      if (!Array.isArray(parsed)) return null;
      return normalizeSkillLoadout(parsed, null);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(raw)) return null;
  return normalizeSkillLoadout(raw, null);
}

/** Copy owned list and add product `id` (no-op if already owned / invalid). */
export function withOwnedSkill(
  owned: readonly SkillProductId[] | null | undefined,
  id: SkillProductId | string,
): SkillProductId[] {
  const base = normalizeOwnedSkills(owned ?? emptyOwnedSkills());
  if (!isSkillProductId(id) || base.includes(id)) return base;
  return normalizeOwnedSkills([...base, id]);
}

/**
 * Remove a product and any dependents that would break prereqs
 * (higher tiers of same skill, and later skills in the category chain).
 */
export function withoutOwnedSkill(
  owned: readonly SkillProductId[] | null | undefined,
  id: SkillProductId | string,
): SkillProductId[] {
  if (!isSkillProductId(id)) {
    return normalizeOwnedSkills(owned ?? emptyOwnedSkills());
  }
  const base = new Set(normalizeOwnedSkills(owned ?? emptyOwnedSkills()));
  if (!base.has(id)) return normalizeOwnedSkills([...base]);

  const removed = SKILL_PRODUCTS[id];
  const toDrop = new Set<SkillProductId>([id]);

  // Higher tiers of same skill.
  for (const p of productsForSkill(removed.skill)) {
    if (p.tier > removed.tier) toDrop.add(p.id);
  }

  // Downstream skills in the same category (need this skill at least I).
  // If we drop tier I of a skill, drop the whole downstream chain.
  if (removed.tier === 1) {
    const cat = SKILL_CATEGORIES[removed.category];
    const idx = cat.skills.indexOf(removed.skill);
    if (idx >= 0) {
      for (let i = idx + 1; i < cat.skills.length; i++) {
        const downstream = cat.skills[i]!;
        for (const p of productsForSkill(downstream)) {
          toDrop.add(p.id);
        }
      }
    }
  }

  for (const drop of toDrop) base.delete(drop);
  return normalizeOwnedSkills([...base]);
}

/**
 * Lock reason for an unowned product. Null when owned.
 */
export function skillLockMessage(
  id: SkillProductId | string,
  level: number,
  owned: readonly SkillProductId[] | null | undefined,
): string | null {
  if (!isSkillProductId(id)) return null;
  if (isSkillProductOwned(id, owned)) return null;
  const product = SKILL_PRODUCTS[id];
  if (!isSkillProductLevelUnlocked(id, level)) {
    return `Reach level ${product.minLevel} to unlock ${product.label}`;
  }
  if (product.requires && !isSkillProductOwned(product.requires, owned)) {
    const prev = SKILL_PRODUCTS[product.requires];
    return `Unlock ${prev.label} first`;
  }
  const skillDef = SKILL_DEFS[product.skill];
  if (skillDef.requiresSkill && !ownsSkill(skillDef.requiresSkill, owned)) {
    const prevSkill = SKILL_DEFS[skillDef.requiresSkill];
    return `Unlock ${prevSkill.label} I first`;
  }
  return null;
}

/**
 * All products legal at `level` when taking the full chain in order
 * (every product with minLevel ≤ level whose prereqs are also in the set).
 * Used by sandbox “unlock all at level”.
 */
export function ownedSkillsForLevel(level: number): SkillProductId[] {
  const safeLevel =
    typeof level === "number" && Number.isFinite(level) ? Math.floor(level) : 1;
  const owned: SkillProductId[] = [];
  // Iterate product order so prereqs appear before dependents.
  for (const id of SKILL_PRODUCT_ORDER) {
    if (canUnlockSkillProduct(id, safeLevel, owned)) {
      owned.push(id);
    }
  }
  return owned;
}

/**
 * Every product that must be owned before (and including) `id` can unlock,
 * in {@link SKILL_PRODUCT_ORDER}. Mirrors prereqs in
 * {@link canUnlockSkillProduct}: previous tier of the same skill, plus tier I
 * of the previous skill in the category chain.
 */
export function prerequisitesForSkillProduct(
  id: SkillProductId | string,
): SkillProductId[] {
  if (!isSkillProductId(id)) return [];
  const needed = new Set<SkillProductId>();
  const visit = (productId: SkillProductId) => {
    if (needed.has(productId)) return;
    const product = SKILL_PRODUCTS[productId];
    if (product.requires) visit(product.requires);
    const skillDef = SKILL_DEFS[product.skill];
    if (skillDef.requiresSkill) {
      visit(productIdFor(skillDef.requiresSkill, 1));
    }
    needed.add(productId);
  };
  visit(id);
  return SKILL_PRODUCT_ORDER.filter((p) => needed.has(p));
}

export type SkillPlan = {
  /** Full prereq union for all targets, stable product order. */
  path: SkillProductId[];
  /** Path products not already owned. */
  missing: SkillProductId[];
  /** Sum of {@link coinCostForSkillProduct} for `missing`. */
  totalCoins: number;
  /**
   * Max `minLevel` among `missing` (1 when nothing remains to unlock).
   * UI may show the player's current level when the path is fully owned.
   */
  requiredLevel: number;
};

/**
 * Skill-planner math: expand goal products to their prereq union, optionally
 * subtract already-owned products, and report remaining coins + level gate.
 */
export function skillPlanForTargets(
  targets: readonly SkillProductId[] | null | undefined,
  owned?: readonly SkillProductId[] | null,
): SkillPlan {
  const needed = new Set<SkillProductId>();
  if (targets) {
    for (const raw of targets) {
      if (!isSkillProductId(raw)) continue;
      for (const p of prerequisitesForSkillProduct(raw)) {
        needed.add(p);
      }
    }
  }
  const path = SKILL_PRODUCT_ORDER.filter((id) => needed.has(id));
  const ownedSet = new Set(normalizeOwnedSkills(owned ?? emptyOwnedSkills()));
  const missing = path.filter((id) => !ownedSet.has(id));
  let totalCoins = 0;
  let requiredLevel = 1;
  for (const id of missing) {
    totalCoins += coinCostForSkillProduct(id);
    const min = SKILL_PRODUCTS[id].minLevel;
    if (min > requiredLevel) requiredLevel = min;
  }
  return { path, missing, totalCoins, requiredLevel };
}

/** Kind label for UI legend. */
export function skillKindLabel(kind: SkillKind): string {
  switch (kind) {
    case "timed":
      return "Timed";
    case "instant":
      return "Instant";
    case "passive":
      return "Passive";
  }
}

/** Short tag like (t), (i-time), (p-hp/damage) for admin detail. */
export function skillKindTag(def: SkillDef): string {
  if (def.kind === "timed") return "(t)";
  if (def.kind === "passive") {
    if (def.scale === "hpPerDamage") return "(p-hp/damage)";
    return "(p)";
  }
  // instant
  if (def.scale === "time") return "(i-time)";
  if (def.scale === "distance") return "(i-distance)";
  if (def.scale === "hp") return "(i-hp)";
  return "(i)";
}

export function isLiveAbilitySkill(skill: SkillId): boolean {
  return (LIVE_ABILITY_SKILL_IDS as readonly string[]).includes(skill);
}

/** Whether this skill may be activated via keybind (not passive). */
export function isSkillActivatable(skill: SkillId): boolean {
  if (!isSkillId(skill)) return false;
  return SKILL_DEFS[skill].kind !== "passive";
}

export function isTimedSkill(skill: SkillId): boolean {
  return isSkillId(skill) && SKILL_DEFS[skill].kind === "timed";
}

export function isInstantSkill(skill: SkillId): boolean {
  return isSkillId(skill) && SKILL_DEFS[skill].kind === "instant";
}

export function isPassiveSkill(skill: SkillId): boolean {
  return isSkillId(skill) && SKILL_DEFS[skill].kind === "passive";
}

/**
 * Active window duration (seconds) for a **timed** skill given ownership.
 * Uses product `value` for the highest owned tier (single catalog source).
 * - Instants / passives → 0.
 * - `null` / omitted owned → max tier; empty array → 0.
 */
export function timedSkillDurationSForOwned(
  skill: SkillId,
  owned?: readonly SkillProductId[] | null,
): number {
  if (!isSkillId(skill)) return 0;
  const def = SKILL_DEFS[skill];
  if (def.kind !== "timed") return 0;
  if (owned === undefined || owned === null) {
    const products = productsForSkill(skill);
    return products[products.length - 1]!.value;
  }
  const tier = highestOwnedSkillTier(skill, owned);
  if (tier === 0) return 0;
  return SKILL_PRODUCTS[productIdFor(skill, tier)].value;
}

/** Active window duration in sim ticks for timed skills (0 for non-timed). */
export function timedSkillDurationTicks(
  skill: SkillId,
  tickHz: number = TICK_HZ,
  owned?: readonly SkillProductId[] | null,
): number {
  const hz = tickHz > 0 && Number.isFinite(tickHz) ? tickHz : TICK_HZ;
  const seconds = timedSkillDurationSForOwned(skill, owned);
  if (seconds <= 0) return 0;
  return Math.ceil(seconds * hz);
}

/**
 * Product `value` for the highest owned tier of a skill.
 * - `null` / omitted owned → max tier value (bots / unrestricted).
 * - Empty array or unowned → 0.
 * Used for instant HP heals, blink distance, leech fraction, etc.
 */
export function skillValueForOwned(
  skill: SkillId,
  owned?: readonly SkillProductId[] | null,
): number {
  if (!isSkillId(skill)) return 0;
  const products = productsForSkill(skill);
  if (products.length === 0) return 0;
  if (owned === undefined || owned === null) {
    return products[products.length - 1]!.value;
  }
  const tier = highestOwnedSkillTier(skill, owned);
  if (tier === 0) return 0;
  return SKILL_PRODUCTS[productIdFor(skill, tier)].value;
}

/** Global lock ticks after an instant activate. */
export function instantSkillLockTicks(tickHz: number = TICK_HZ): number {
  const hz = tickHz > 0 && Number.isFinite(tickHz) ? tickHz : TICK_HZ;
  return Math.ceil(INSTANT_SKILL_LOCK_S * hz);
}

/** Product id helper for tests / UI. */
export function skillProductId(
  skill: SkillId,
  tier: SkillTier,
): SkillProductId {
  return productIdFor(skill, tier);
}

/** Active match / HUD loadout size (passives count as a slot). */
export const SKILL_LOADOUT_SLOTS = 4;

/** One loadout cell: equipped skill or empty. */
export type SkillLoadoutSlot = SkillId | null;

/**
 * Fixed-length match loadout. Index is the slot number (0 = slot 1 in UI).
 * Empty slots are `null` and are preserved — slot 2 can be filled while slot 1
 * stays empty.
 */
export type SkillLoadout = SkillLoadoutSlot[];

/** Four empty slots. */
export function emptySkillLoadout(): SkillLoadout {
  return Array.from({ length: SKILL_LOADOUT_SLOTS }, () => null);
}

/** How many slots currently have a skill. */
export function skillLoadoutEquippedCount(
  loadout: readonly SkillLoadoutSlot[] | null | undefined,
): number {
  if (!loadout || loadout.length === 0) return 0;
  let n = 0;
  for (const slot of loadout) {
    if (slot != null) n++;
  }
  return n;
}

/**
 * Normalize a loadout into a fixed-length sparse array: unique owned skill
 * ids, empty slots kept as `null`, max {@link SKILL_LOADOUT_SLOTS}. Accepts
 * legacy dense arrays (no nulls) and sparse arrays with holes.
 */
export function normalizeSkillLoadout(
  raw: unknown,
  owned: readonly SkillProductId[] | null | undefined,
): SkillLoadout {
  const out = emptySkillLoadout();
  const seen = new Set<SkillId>();
  if (!Array.isArray(raw)) return out;
  const len = Math.min(raw.length, SKILL_LOADOUT_SLOTS);
  for (let i = 0; i < len; i++) {
    const item = raw[i];
    if (item == null || item === "") {
      out[i] = null;
      continue;
    }
    if (typeof item !== "string" || !isSkillId(item)) {
      out[i] = null;
      continue;
    }
    if (seen.has(item) || !ownsSkill(item, owned)) {
      out[i] = null;
      continue;
    }
    out[i] = item;
    seen.add(item);
  }
  return out;
}

/**
 * Default loadout: first owned skills in tree order packed into the leading
 * slots (remaining slots empty).
 */
export function defaultSkillLoadout(
  owned: readonly SkillProductId[] | null | undefined,
): SkillLoadout {
  const out = emptySkillLoadout();
  let i = 0;
  for (const skill of SKILL_ORDER) {
    if (!ownsSkill(skill, owned)) continue;
    out[i] = skill;
    i++;
    if (i >= SKILL_LOADOUT_SLOTS) break;
  }
  return out;
}

/**
 * Drop newly granted starter skills into their {@link STARTER_SKILL_SLOTS}
 * slot. A taken slot falls back to the first empty one; a full bar or a skill
 * already equipped is left alone. `owned` must include the new grants.
 */
export function withStarterSkillsSlotted(
  loadout: readonly SkillLoadoutSlot[],
  granted: readonly SkillProductId[],
  owned: readonly SkillProductId[] | null | undefined,
): SkillLoadout {
  const out = normalizeSkillLoadout(loadout, owned);
  for (const id of granted) {
    if (!isStarterSkillProduct(id)) continue;
    const skill = SKILL_PRODUCTS[id].skill;
    if (out.includes(skill)) continue;
    const preferred = STARTER_SKILL_SLOTS[skill]!;
    const slot = out[preferred] == null ? preferred : out.indexOf(null);
    if (slot < 0) continue;
    out[slot] = skill;
  }
  return out;
}

/** Whether `skill` can be added to the loadout right now. */
export function canAddSkillToLoadout(
  loadout: readonly SkillLoadoutSlot[],
  skill: SkillId,
  owned: readonly SkillProductId[] | null | undefined,
): boolean {
  if (!isSkillId(skill)) return false;
  if (!ownsSkill(skill, owned)) return false;
  const base = normalizeSkillLoadout(loadout, owned);
  if (base.includes(skill)) return false;
  return skillLoadoutEquippedCount(base) < SKILL_LOADOUT_SLOTS;
}

/**
 * Toggle `skill` in the loadout. Adding places it in the first empty slot
 * (fails silently when full / unowned); removing clears its slot and leaves
 * other slots in place.
 */
export function toggleSkillInLoadout(
  loadout: readonly SkillLoadoutSlot[],
  skill: SkillId,
  owned: readonly SkillProductId[] | null | undefined,
): SkillLoadout {
  const base = normalizeSkillLoadout(loadout, owned);
  if (!isSkillId(skill)) return base;
  const existing = base.indexOf(skill);
  if (existing >= 0) {
    base[existing] = null;
    return base;
  }
  if (!ownsSkill(skill, owned)) return base;
  const empty = base.indexOf(null);
  if (empty < 0) return base;
  base[empty] = skill;
  return base;
}

/** Clear skill at slot index (leaves a hole; no-op if empty / OOB). */
export function clearSkillLoadoutSlot(
  loadout: readonly SkillLoadoutSlot[],
  slotIndex: number,
  owned: readonly SkillProductId[] | null | undefined,
): SkillLoadout {
  const base = normalizeSkillLoadout(loadout, owned);
  if (
    !Number.isInteger(slotIndex) ||
    slotIndex < 0 ||
    slotIndex >= SKILL_LOADOUT_SLOTS
  ) {
    return base;
  }
  base[slotIndex] = null;
  return base;
}

/**
 * Owned skills that may be chosen for a loadout slot: tree order, unique by
 * skill id (highest owned tier is implied — loadout stores skill id only),
 * excluding skills already equipped in a different slot. The skill currently
 * in `slotIndex` remains listed so the picker can show the active selection.
 */
export function availableSkillsForLoadoutSlot(
  loadout: readonly SkillLoadoutSlot[],
  slotIndex: number,
  owned: readonly SkillProductId[] | null | undefined,
): SkillId[] {
  const base = normalizeSkillLoadout(loadout, owned);
  const current =
    Number.isInteger(slotIndex) &&
    slotIndex >= 0 &&
    slotIndex < SKILL_LOADOUT_SLOTS
      ? base[slotIndex]!
      : null;
  const out: SkillId[] = [];
  for (const skill of SKILL_ORDER) {
    if (!ownsSkill(skill, owned)) continue;
    if (base.includes(skill) && skill !== current) continue;
    out.push(skill);
  }
  return out;
}

/**
 * Assign `skill` to a loadout slot (or clear when `null`). Empty slots stay
 * empty — setting slot 2 does not fill or shift slot 1. If `skill` is already
 * equipped elsewhere it is moved to this slot. Unowned / invalid inputs are
 * no-ops.
 */
export function setSkillLoadoutSlot(
  loadout: readonly SkillLoadoutSlot[],
  slotIndex: number,
  skill: SkillId | null,
  owned: readonly SkillProductId[] | null | undefined,
): SkillLoadout {
  const base = normalizeSkillLoadout(loadout, owned);
  if (
    !Number.isInteger(slotIndex) ||
    slotIndex < 0 ||
    slotIndex >= SKILL_LOADOUT_SLOTS
  ) {
    return base;
  }

  if (skill === null) {
    base[slotIndex] = null;
    return base;
  }
  if (!isSkillId(skill) || !ownsSkill(skill, owned)) return base;

  for (let i = 0; i < base.length; i++) {
    if (i !== slotIndex && base[i] === skill) base[i] = null;
  }
  base[slotIndex] = skill;
  return base;
}
