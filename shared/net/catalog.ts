import { MMS_RANKS, type MmsRankId } from "../progression/mmsRanks.ts";
import {
  SKILL_ORDER,
  SKILL_PRODUCT_ORDER,
  type SkillId,
  type SkillProductId,
} from "../sim/skills.ts";

const skillIndex = new Map<string, number>();
for (let i = 0; i < SKILL_ORDER.length; i++) {
  skillIndex.set(SKILL_ORDER[i]!, i);
}

const productIndex = new Map<string, number>();
for (let i = 0; i < SKILL_PRODUCT_ORDER.length; i++) {
  productIndex.set(SKILL_PRODUCT_ORDER[i]!, i);
}

const rankIndex = new Map<string, number>();
for (let i = 0; i < MMS_RANKS.length; i++) {
  rankIndex.set(MMS_RANKS[i]!.id, i);
}

/** 255 = null / unknown on the wire. */
export const CATALOG_NONE = 255;

export function skillToIndex(id: string | null | undefined): number {
  if (id == null) return CATALOG_NONE;
  return skillIndex.get(id) ?? CATALOG_NONE;
}

export function indexToSkill(index: number): SkillId | null {
  if (index === CATALOG_NONE) return null;
  return SKILL_ORDER[index] ?? null;
}

export function productToIndex(id: string | null | undefined): number {
  if (id == null) return CATALOG_NONE;
  return productIndex.get(id) ?? CATALOG_NONE;
}

export function indexToProduct(index: number): SkillProductId | null {
  if (index === CATALOG_NONE) return null;
  return SKILL_PRODUCT_ORDER[index] ?? null;
}

export function rankToIndex(id: string | null | undefined): number {
  if (id == null) return CATALOG_NONE;
  return rankIndex.get(id) ?? CATALOG_NONE;
}

export function indexToRank(index: number): MmsRankId | null {
  if (index === CATALOG_NONE) return null;
  return MMS_RANKS[index]?.id ?? null;
}
