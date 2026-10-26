/**
 * MMS (Match Making Score) prestige ranks — 10 equal percentile bands.
 *
 * Ranking is relative to the live player population:
 *   - Sort everyone by MMS ascending (worst → best).
 *   - A player's tier uses only players with *strictly lower* MMS
 *     (`below = count(s < mms)`), so ties always take the lowest rank
 *     that the score group can occupy.
 *   - tierIndex = min(9, floor(below * 10 / n)), n = total players.
 *
 * Product terms: docs/play/ranking.md (MMS = SS + ceil(XP × 1%)).
 */

export const MMS_RANK_COUNT = 10;

export type MmsRankId =
  | "scrap"
  | "iron"
  | "steel"
  | "alloy"
  | "titanium"
  | "sentinel"
  | "vanguard"
  | "elite"
  | "overlord"
  | "singularity";

export type MmsRankDef = {
  /** 1-based rank (1 = Scrap … 10 = Singularity). */
  rank: number;
  /** 0-based tier index used in math. */
  tierIndex: number;
  id: MmsRankId;
  name: string;
  /** Inclusive lower percentile bound [0, 100). */
  percentileMin: number;
  /** Exclusive upper percentile bound (100 for the top tier). */
  percentileMax: number;
  /** Short blurb for the MMS modal chart. */
  blurb: string;
};

/**
 * Fixed catalog — names and order never change; score thresholds do
 * (they slide with the live ladder).
 */
export const MMS_RANKS: readonly MmsRankDef[] = [
  {
    rank: 1,
    tierIndex: 0,
    id: "scrap",
    name: "Scrap",
    percentileMin: 0,
    percentileMax: 10,
    blurb: "Bottom decile — still warming up the ladder.",
  },
  {
    rank: 2,
    tierIndex: 1,
    id: "iron",
    name: "Iron",
    percentileMin: 10,
    percentileMax: 20,
    blurb: "Foundational strength; climbing out of the basement.",
  },
  {
    rank: 3,
    tierIndex: 2,
    id: "steel",
    name: "Steel",
    percentileMin: 20,
    percentileMax: 30,
    blurb: "Hardened by reps — solid mid-low field.",
  },
  {
    rank: 4,
    tierIndex: 3,
    id: "alloy",
    name: "Alloy",
    percentileMin: 30,
    percentileMax: 40,
    blurb: "Mixed metals; above average investment and skill.",
  },
  {
    rank: 5,
    tierIndex: 4,
    id: "titanium",
    name: "Titanium",
    percentileMin: 40,
    percentileMax: 50,
    blurb: "Light and lethal — middle of the pack and rising.",
  },
  {
    rank: 6,
    tierIndex: 5,
    id: "sentinel",
    name: "Sentinel",
    percentileMin: 50,
    percentileMax: 60,
    blurb: "Top half — watching the doors for real.",
  },
  {
    rank: 7,
    tierIndex: 6,
    id: "vanguard",
    name: "Vanguard",
    percentileMin: 60,
    percentileMax: 70,
    blurb: "Front line of the strong; matchmaking takes notice.",
  },
  {
    rank: 8,
    tierIndex: 7,
    id: "elite",
    name: "Elite",
    percentileMin: 70,
    percentileMax: 80,
    blurb: "Upper echelon — only a minority sit here.",
  },
  {
    rank: 9,
    tierIndex: 8,
    id: "overlord",
    name: "Overlord",
    percentileMin: 80,
    percentileMax: 90,
    blurb: "Dominates lobbies; rare company.",
  },
  {
    rank: 10,
    tierIndex: 9,
    id: "singularity",
    name: "Singularity",
    percentileMin: 90,
    percentileMax: 100,
    blurb: "Top decile — gravity well of the ladder.",
  },
] as const;

export function mmsRankByTierIndex(tierIndex: number): MmsRankDef {
  const i = Math.max(0, Math.min(MMS_RANK_COUNT - 1, Math.floor(tierIndex)));
  return MMS_RANKS[i]!;
}

export function mmsRankById(id: MmsRankId): MmsRankDef {
  const found = MMS_RANKS.find((r) => r.id === id);
  return found ?? MMS_RANKS[0]!;
}

/**
 * 0-based tier from how many players sit *strictly below* this MMS.
 * Ties and floor rounding always bias toward the lower rank.
 */
export function mmsTierIndexFromBelowCount(
  belowCount: number,
  totalPlayers: number,
): number {
  const n = Math.max(0, Math.floor(totalPlayers));
  if (n <= 0) return 0;
  const below = Math.max(0, Math.floor(belowCount));
  return Math.min(MMS_RANK_COUNT - 1, Math.floor((below * MMS_RANK_COUNT) / n));
}

/**
 * Assign tier for a score given the full multiset of population MMS values.
 * Pure helper for tests / offline use.
 */
export function mmsTierIndexForScore(
  playerMms: number,
  populationMms: readonly number[],
): number {
  const n = populationMms.length;
  if (n === 0) return 0;
  const mms = Math.trunc(playerMms);
  let below = 0;
  for (const s of populationMms) {
    if (Math.trunc(s) < mms) below++;
  }
  return mmsTierIndexFromBelowCount(below, n);
}

export type MmsLandscapeTier = {
  rank: number;
  tierIndex: number;
  id: MmsRankId;
  name: string;
  percentileMin: number;
  percentileMax: number;
  blurb: string;
  /** Lowest MMS currently held by anyone in this tier (null if empty). */
  minMms: number | null;
  /** Highest MMS currently held by anyone in this tier (null if empty). */
  maxMms: number | null;
  /** Players currently sitting in this tier. */
  playerCount: number;
};

export type MmsLandscape = {
  totalPlayers: number;
  tiers: MmsLandscapeTier[];
};

/**
 * Build the live percentile chart from a multiset of MMS scores.
 * Score thresholds slide with the population; empty tiers stay empty.
 */
export function buildMmsLandscape(
  populationMms: readonly number[],
): MmsLandscape {
  const scores = populationMms.map((s) => Math.trunc(s));
  const n = scores.length;

  const buckets: { min: number; max: number; count: number }[] = Array.from(
    { length: MMS_RANK_COUNT },
    () => ({ min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY, count: 0 }),
  );

  if (n > 0) {
    // Pre-count strictly-below via sort for O(n log n).
    const sorted = scores.slice().sort((a, b) => a - b);
    // For each distinct value, below = index of first occurrence.
    let i = 0;
    while (i < sorted.length) {
      const value = sorted[i]!;
      let j = i + 1;
      while (j < sorted.length && sorted[j] === value) j++;
      const below = i; // ties share the lowest index → lowest rank
      const tier = mmsTierIndexFromBelowCount(below, n);
      const bucket = buckets[tier]!;
      const groupSize = j - i;
      bucket.count += groupSize;
      bucket.min = Math.min(bucket.min, value);
      bucket.max = Math.max(bucket.max, value);
      i = j;
    }
  }

  const tiers: MmsLandscapeTier[] = MMS_RANKS.map((def) => {
    const b = buckets[def.tierIndex]!;
    const empty = b.count === 0;
    return {
      rank: def.rank,
      tierIndex: def.tierIndex,
      id: def.id,
      name: def.name,
      percentileMin: def.percentileMin,
      percentileMax: def.percentileMax,
      blurb: def.blurb,
      minMms: empty ? null : b.min,
      maxMms: empty ? null : b.max,
      playerCount: b.count,
    };
  });

  return { totalPlayers: n, tiers };
}

/** Human percentile band label, e.g. "0–10%" or "Top 10%". */
export function mmsPercentileLabel(def: Pick<MmsRankDef, "percentileMin" | "percentileMax">): string {
  if (def.percentileMin === 90 && def.percentileMax === 100) return "Top 10%";
  if (def.percentileMin === 0 && def.percentileMax === 10) return "Bottom 10%";
  return `${def.percentileMin}–${def.percentileMax}%`;
}
