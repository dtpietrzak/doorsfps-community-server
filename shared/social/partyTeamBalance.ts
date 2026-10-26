/**
 * Pure group-aware team balancing for open-match parties and solos (S9-PR2).
 *
 * Parties are weighted indivisible items. Solos are groups of size 1. Callers
 * (runtime join, voted rebalance, multi-party batch seating) share this logic
 * so cohesion rules stay consistent.
 */

export type PartyTeamId = "A" | "B";

export type PartyTeamCounts = { A: number; B: number };

/**
 * Absolute ceiling for a single party on a runtime session/claim.
 * Matches historical join-token clamp; authority must not configure higher.
 */
export const RUNTIME_PARTY_SIZE_ABSOLUTE_MAX = 8;

/** One indivisible seating unit (party of N, or solo as N=1). */
export type BalanceGroup = {
  /** Stable key for deterministic ordering (partyId or player id). */
  id: string;
  /** Seat weight; must be >= 1. */
  size: number;
  /**
   * When set, the group is already seated and is not reassigned — it only
   * contributes to base team counts.
   */
  lockedTeam?: PartyTeamId | null;
};

export type GroupTeamAssignment = {
  groupId: string;
  team: PartyTeamId;
  size: number;
};

export type AssignGroupsResult =
  | {
    ok: true;
    assignments: GroupTeamAssignment[];
    teamCounts: PartyTeamCounts;
  }
  | {
    ok: false;
    reason: "invalid_group" | "impossible";
    detail?: string;
  };

/** Normalize a non-negative integer count (team totals, capacity, …). */
export function normalizeTeamCount(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
  return Math.max(0, Math.floor(raw));
}

/**
 * Supported max party size for a runtime with the given human seat capacity.
 * A party is indivisible and cannot exceed total human seats or the absolute
 * claim ceiling.
 */
export function runtimeMaxPartySize(humanCapacity: number): number {
  const cap = normalizeTeamCount(humanCapacity);
  return Math.min(RUNTIME_PARTY_SIZE_ABSOLUTE_MAX, cap);
}

/**
 * True when the authority open-party limit fits inside a runtime's reported
 * (or derived) max party size.
 */
export function isPartyLimitWithinRuntimeCapability(
  authorityMaxSize: number,
  runtimeMax: number,
): boolean {
  if (
    typeof authorityMaxSize !== "number" ||
    typeof runtimeMax !== "number" ||
    !Number.isFinite(authorityMaxSize) ||
    !Number.isFinite(runtimeMax)
  ) {
    return false;
  }
  const auth = Math.floor(authorityMaxSize);
  const run = Math.floor(runtimeMax);
  return auth >= 1 && run >= 1 && auth <= run;
}

/**
 * Pick the team that minimizes |A−B| after seating an indivisible group of
 * `size`. Ties → the currently lighter team, then A.
 */
export function pickTeamForGroupSize(
  size: number,
  counts: PartyTeamCounts,
): PartyTeamId {
  const s = Math.max(1, Math.floor(size));
  const A = normalizeTeamCount(counts.A);
  const B = normalizeTeamCount(counts.B);
  const imbalanceIfA = Math.abs(A + s - B);
  const imbalanceIfB = Math.abs(A - (B + s));
  if (imbalanceIfB < imbalanceIfA) return "B";
  if (imbalanceIfA < imbalanceIfB) return "A";
  if (B < A) return "B";
  return "A";
}

/**
 * Whether moving `size` seats from `from` to the other team reduces |A−B|.
 * Used by voted rebalance so whole parties only move when materially better.
 */
export function movingGroupImprovesBalance(
  size: number,
  from: PartyTeamId,
  counts: PartyTeamCounts,
): boolean {
  const s = Math.floor(size);
  if (!Number.isFinite(s) || s < 1) return false;
  const A = normalizeTeamCount(counts.A);
  const B = normalizeTeamCount(counts.B);
  const before = Math.abs(A - B);
  const afterA = from === "A" ? A - s : A + s;
  const afterB = from === "B" ? B - s : B + s;
  if (afterA < 0 || afterB < 0) return false;
  const after = Math.abs(afterA - afterB);
  return after < before;
}

function compareGroupOrder(a: BalanceGroup, b: BalanceGroup): number {
  // Larger first so big parties claim the lighter side before solos fill in.
  if (b.size !== a.size) return b.size - a.size;
  return a.id.localeCompare(b.id);
}

/**
 * Deterministic multi-group team assignment.
 *
 * 1. Apply locked groups to base counts.
 * 2. Sort unlocked groups by size desc, then id asc.
 * 3. Greedily seat each unlocked group with {@link pickTeamForGroupSize}.
 *
 * Optional `maxTeamSize` rejects an assignment that would put more than that
 * many match players on one team (impossible placement).
 */
export function assignGroupsToTeams(
  groups: readonly BalanceGroup[],
  baseCounts: PartyTeamCounts = { A: 0, B: 0 },
  opts?: { maxTeamSize?: number | null },
): AssignGroupsResult {
  const counts: PartyTeamCounts = {
    A: normalizeTeamCount(baseCounts.A),
    B: normalizeTeamCount(baseCounts.B),
  };
  const maxTeam = opts?.maxTeamSize == null
    ? null
    : normalizeTeamCount(opts.maxTeamSize);

  const locked: BalanceGroup[] = [];
  const unlocked: BalanceGroup[] = [];

  for (const raw of groups) {
    if (!raw || typeof raw.id !== "string" || !raw.id.trim()) {
      return { ok: false, reason: "invalid_group", detail: "missing id" };
    }
    const size = Math.floor(raw.size);
    if (!Number.isFinite(size) || size < 1) {
      return {
        ok: false,
        reason: "invalid_group",
        detail: `invalid size for ${raw.id}`,
      };
    }
    const group: BalanceGroup = {
      id: raw.id.trim(),
      size,
      lockedTeam: raw.lockedTeam === "A" || raw.lockedTeam === "B"
        ? raw.lockedTeam
        : null,
    };
    if (group.lockedTeam) locked.push(group);
    else unlocked.push(group);
  }

  const assignments: GroupTeamAssignment[] = [];

  for (const g of locked) {
    const team = g.lockedTeam!;
    counts[team] += g.size;
    if (maxTeam != null && counts[team] > maxTeam) {
      return {
        ok: false,
        reason: "impossible",
        detail: `locked group ${g.id} exceeds team capacity`,
      };
    }
    assignments.push({ groupId: g.id, team, size: g.size });
  }

  unlocked.sort(compareGroupOrder);

  for (const g of unlocked) {
    const team = pickTeamForGroupSize(g.size, counts);
    const next = counts[team] + g.size;
    if (maxTeam != null && next > maxTeam) {
      // Try the other side before failing.
      const other: PartyTeamId = team === "A" ? "B" : "A";
      const otherNext = counts[other] + g.size;
      if (otherNext <= maxTeam) {
        counts[other] = otherNext;
        assignments.push({ groupId: g.id, team: other, size: g.size });
        continue;
      }
      return {
        ok: false,
        reason: "impossible",
        detail: `group ${g.id} size ${g.size} cannot fit`,
      };
    }
    counts[team] = next;
    assignments.push({ groupId: g.id, team, size: g.size });
  }

  // Stable output: locked first (input order among locked), then unlocked order.
  return { ok: true, assignments, teamCounts: counts };
}

/**
 * Compare two candidate rebalance groups for "worst first" selection among
 * groups that all improve balance. Prefer smaller groups (less disruption),
 * then worse anchor rating, then id.
 */
export function compareRebalanceGroupPreference(
  a: {
    size: number;
    anchorRating: number;
    anchorAfk: boolean;
    id: string;
  },
  b: {
    size: number;
    anchorRating: number;
    anchorAfk: boolean;
    id: string;
  },
): number {
  // Smaller first — solos before multi-member parties when both improve.
  if (a.size !== b.size) return a.size - b.size;
  // AFK preferred (worse).
  if (a.anchorAfk !== b.anchorAfk) return a.anchorAfk ? -1 : 1;
  if (a.anchorRating !== b.anchorRating) {
    return a.anchorRating - b.anchorRating;
  }
  return a.id.localeCompare(b.id);
}
