/**
 * Per-reviver revive progress (notes/zombots.md decision 2).
 *
 * The glue reports who is being looked at and whether that body is in reach.
 * This module never raycasts and never reads the clock: there is no timeout.
 * Looking at the same target keeps the count; looking away, or looking at
 * someone else, drops it to 0. Points already spent are not refunded — the
 * purse lives in the glue's `trySpend`.
 *
 * On a completed revive, `health` (and `intent.health`) is a fraction of max
 * HP (`revive.healthFraction`). The glue multiplies by the player's max HP.
 */

import type { ZombotsIntent, ZombotsPlayerId } from "./types.ts";
import { ZOMBOTS_TUNING } from "./zombotsTuning.ts";

export type PlayerRevivedIntent = Extract<ZombotsIntent, { kind: "playerRevived" }>;

export type ReviveRefusal =
  | "notDowned"
  | "noTarget"
  | "outOfReach"
  | "cantAfford"
  | "reviverDown";

/**
 * `health` is a fraction of max HP, the same number as `intent.health`.
 * `presses` is the count after this press, from 1 up to but not including
 * `revive.presses`.
 */
export type ReviveResult =
  | { kind: "refused"; reason: ReviveRefusal }
  | { kind: "progress"; presses: number }
  | { kind: "revived"; targetId: ZombotsPlayerId; health: number; intent: PlayerRevivedIntent };

/**
 * Match facts the glue fills in for one press.
 *
 * `isAlive` means still in the match, not "HP above zero". A downed player
 * is alive and downed. A reviver must be alive and standing; a target must
 * be alive and downed.
 *
 * `trySpend` charges the reviver. Return false to refuse without taking
 * points. `inReach` is the glue's answer for this reviver's current target.
 */
export type RevivePressContext = {
  isDowned: (playerId: ZombotsPlayerId) => boolean;
  isAlive: (playerId: ZombotsPlayerId) => boolean;
  trySpend: (reviverId: ZombotsPlayerId, cost: number) => boolean;
  inReach: boolean;
};

type ReviveRow = { targetId: ZombotsPlayerId; presses: number };

export class ReviveTracker {
  private readonly rows = new Map<ZombotsPlayerId, ReviveRow>();

  /**
   * Remember who `reviverId` is looking at. Null, or a different target,
   * drops that reviver's count to 0. The same target does not change it,
   * however many times the glue repeats the look.
   */
  observeLook(reviverId: ZombotsPlayerId, targetId: ZombotsPlayerId | null): void {
    if (targetId === null) {
      this.rows.delete(reviverId);
      return;
    }
    const row = this.rows.get(reviverId);
    if (row && row.targetId === targetId) return;
    this.rows.set(reviverId, { targetId, presses: 0 });
  }

  /**
   * One E press. Checks run in a fixed order and only a press the purse
   * accepts advances the count. A press that fails any earlier check does
   * not spend and does not reset. The press that reaches `revive.presses`
   * revives the target and clears every reviver's count on that target.
   */
  press(reviverId: ZombotsPlayerId, ctx: RevivePressContext): ReviveResult {
    // A downed (or departed) player cannot revive, even with no look target.
    if (!ctx.isAlive(reviverId) || ctx.isDowned(reviverId)) {
      return { kind: "refused", reason: "reviverDown" };
    }
    const row = this.rows.get(reviverId);
    if (!row) return { kind: "refused", reason: "noTarget" };
    if (!ctx.inReach) return { kind: "refused", reason: "outOfReach" };
    const targetId = row.targetId;
    if (!ctx.isAlive(targetId) || !ctx.isDowned(targetId)) {
      return { kind: "refused", reason: "notDowned" };
    }
    if (!ctx.trySpend(reviverId, ZOMBOTS_TUNING.revive.costPerPress)) {
      return { kind: "refused", reason: "cantAfford" };
    }
    row.presses += 1;
    if (row.presses < ZOMBOTS_TUNING.revive.presses) {
      return { kind: "progress", presses: row.presses };
    }
    const health = ZOMBOTS_TUNING.revive.healthFraction;
    this.forgetTarget(targetId);
    return {
      kind: "revived",
      targetId,
      health,
      intent: { kind: "playerRevived", playerId: targetId, by: reviverId, health },
    };
  }

  /** This reviver's target and count, or null when they are not reviving. */
  progress(reviverId: ZombotsPlayerId): { targetId: ZombotsPlayerId; presses: number } | null {
    const row = this.rows.get(reviverId);
    if (!row) return null;
    return { targetId: row.targetId, presses: row.presses };
  }

  /**
   * Drop this player's own count, and anyone who was reviving them.
   * Spent points stay spent.
   */
  leave(playerId: ZombotsPlayerId): void {
    this.rows.delete(playerId);
    this.forgetTarget(playerId);
  }

  /** First finisher wins: every count aimed at this body goes away. */
  private forgetTarget(targetId: ZombotsPlayerId): void {
    const drop: ZombotsPlayerId[] = [];
    for (const [reviverId, row] of this.rows) {
      if (row.targetId === targetId) drop.push(reviverId);
    }
    for (const reviverId of drop) this.rows.delete(reviverId);
  }
}
