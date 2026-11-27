/**
 * Per-player zompoints (notes/zombots.md decision 3).
 *
 * Seeds and awards come from `ZOMBOTS_TUNING`. A spend goes through
 * `trySpendZompoints`, which refuses a cost the purse cannot cover and
 * leaves the balance unchanged. Balances stay non-negative integers when
 * every cost is a non-negative integer.
 */

import { trySpendZompoints } from "../world/slidingDoors.ts";
import type { ZombotsIntent, ZombotsPlayerId, ZombotsPointsReason } from "./types.ts";
import { ZOMBOTS_TUNING } from "./zombotsTuning.ts";

export type ZombotsPointsIntent = Extract<ZombotsIntent, { kind: "pointsChanged" }>;

/** Reasons `award` pays. Spends use the other `ZombotsPointsReason` values. */
export type ZompointsAwardReason = "hit" | "kill" | "waveSurvived";

export type ZompointsSpendResult =
  | { ok: true; points: number; intent: ZombotsPointsIntent }
  | { ok: false; points: number };

function pointsIntent(
  playerId: ZombotsPlayerId,
  points: number,
  delta: number,
  reason: ZombotsPointsReason,
): ZombotsPointsIntent {
  return { kind: "pointsChanged", playerId, points, delta, reason };
}

/**
 * One purse per player, in join order. Missing players are not inserted by
 * an award or a spend: the glue joins them first.
 */
export class ZompointsLedger {
  private readonly purses = new Map<ZombotsPlayerId, number>();
  private readonly totals = new Map<ZombotsPlayerId, number>();

  /**
   * Seed `points.start`. A second join leaves the purse alone and returns
   * null, so a repeated playerJoined cannot wipe points already earned.
   */
  join(playerId: ZombotsPlayerId): ZombotsPointsIntent | null {
    if (this.purses.has(playerId)) return null;
    const start = ZOMBOTS_TUNING.points.start;
    this.purses.set(playerId, start);
    this.totals.set(playerId, start);
    return pointsIntent(playerId, start, start, "start");
  }

  leave(playerId: ZombotsPlayerId): void {
    this.purses.delete(playerId);
    this.totals.delete(playerId);
  }

  /** Current balance, or 0 when the player has no purse. */
  get(playerId: ZombotsPlayerId): number {
    return this.purses.get(playerId) ?? 0;
  }

  /** Total zompoints gathered in this run (start + all awards, never reduced by spends). */
  total(playerId: ZombotsPlayerId): number {
    return this.totals.get(playerId) ?? 0;
  }

  /**
   * Pay a hit, kill, or wave bonus. An unknown player is not enrolled;
   * the intent then has delta 0 so the glue can ignore it.
   */
  award(playerId: ZombotsPlayerId, reason: ZompointsAwardReason): ZombotsPointsIntent {
    return this.credit(playerId, ZOMBOTS_TUNING.points[reason], reason);
  }

  /**
   * Pay one hit on a zombie: `points.headHit` for a head-zone hit, `points.hit`
   * otherwise. Both carry reason `hit`; the delta tells them apart.
   */
  awardHit(playerId: ZombotsPlayerId, head: boolean): ZombotsPointsIntent {
    const points = ZOMBOTS_TUNING.points;
    return this.credit(playerId, head ? points.headHit : points.hit, "hit");
  }

  /**
   * Wave bonus for each id in `livingIds`, once, in that order.
   * The caller omits downed players; this ledger does not know who is down.
   * Ids with no purse are skipped.
   */
  awardWaveSurvived(livingIds: readonly ZombotsPlayerId[]): ZombotsPointsIntent[] {
    const intents: ZombotsPointsIntent[] = [];
    const seen = new Set<ZombotsPlayerId>();
    for (const playerId of livingIds) {
      if (seen.has(playerId)) continue;
      seen.add(playerId);
      if (!this.purses.has(playerId)) continue;
      intents.push(this.award(playerId, "waveSurvived"));
    }
    return intents;
  }

  /**
   * Debit `cost` for `reason` (`door`, `revivePress`, …). Failure does not
   * change the purse and carries no intent.
   */
  trySpend(
    playerId: ZombotsPlayerId,
    cost: number,
    reason: ZombotsPointsReason,
  ): ZompointsSpendResult {
    const current = this.purses.get(playerId);
    if (current === undefined) return { ok: false, points: 0 };
    const spent = trySpendZompoints(current, cost);
    if (!spent.ok) return { ok: false, points: current };
    this.purses.set(playerId, spent.points);
    return {
      ok: true,
      points: spent.points,
      intent: pointsIntent(playerId, spent.points, spent.points - current, reason),
    };
  }

  private credit(
    playerId: ZombotsPlayerId,
    delta: number,
    reason: ZombotsPointsReason,
  ): ZombotsPointsIntent {
    const current = this.purses.get(playerId);
    if (current === undefined) return pointsIntent(playerId, 0, 0, reason);
    const points = current + delta;
    this.purses.set(playerId, points);
    if (delta > 0) {
      this.totals.set(playerId, (this.totals.get(playerId) ?? 0) + delta);
    }
    return pointsIntent(playerId, points, delta, reason);
  }
}
