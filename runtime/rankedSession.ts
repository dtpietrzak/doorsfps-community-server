/**
 * Ranked session joinability helpers (Phase 8 / 9).
 * Pure functions so status + party logic stay unit-testable without a full GameServer.
 */

import type { MatchPhase } from "../protocol/network.ts";

export type RankedSessionSnapshot = {
  ranked: boolean;
  phase: MatchPhase;
  humanCount: number;
  maxPlayers: number;
  /** Live match voided by abandon (remaining free to leave). */
  matchVoided?: boolean;
};

export type RankedSessionStatus = {
  /** Free human seats (bots do not consume party capacity). */
  freeSlots: number;
  /**
   * True when a party / solo can join this instance now.
   * Ranked: only joinable during pre-match with free seats (no mid-live drop-in).
   * Open/community: joinable whenever free seats remain.
   */
  joinable: boolean;
};

/**
 * Compute free slots + joinable for /api/status and future menu-party polls.
 */
export function rankedSessionStatus(
  snap: RankedSessionSnapshot,
): RankedSessionStatus {
  const maxPlayers = Math.max(0, Math.floor(snap.maxPlayers));
  const humanCount = Math.max(0, Math.floor(snap.humanCount));
  const freeSlots = Math.max(0, maxPlayers - humanCount);

  if (freeSlots <= 0) {
    return { freeSlots: 0, joinable: false };
  }

  if (!snap.ranked) {
    // Community servers accept joins mid-match.
    return { freeSlots, joinable: true };
  }

  // Official ranked: only clean pre-match accepts new parties (Phase 9 default).
  const joinable = snap.phase === "prematch";
  return { freeSlots, joinable };
}
