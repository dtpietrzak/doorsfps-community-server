/**
 * Deferred Shoot/Melee queue helpers, shared by humans and bots (PR 4 of
 * the keys-only note).
 *
 * Human packets enqueue on arrival; bot shots enqueue from the apply pipe
 * (`bots/pipeline/applySteps.ts`) instead of resolving inline. `GameServer`
 * flushes both in the `Weapons` phase (after BotApply, before MovePhysics)
 * in ascending shooter id order. See DETERMINISTIC_SYSTEM_ORDERING.md.
 */

import type { ShootPacket } from "../protocol/network.ts";
import type { PlayerManager, ShootOutcome } from "./PlayerManager.ts";

export type PendingWeaponKind = "shoot" | "melee";

export interface PendingWeapon {
  readonly kind: PendingWeaponKind;
  readonly shooterId: string;
  readonly packet: ShootPacket | null;
  readonly volDropPct?: number;
}

/**
 * Stable ascending shooter-id order (FIFO among equal ids).
 * Join/arrival order of distinct shooters must not change flush order.
 */
export function orderPendingWeapons<T extends { shooterId: string }>(
  items: readonly T[],
): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      if (a.item.shooterId < b.item.shooterId) return -1;
      if (a.item.shooterId > b.item.shooterId) return 1;
      return a.index - b.index;
    })
    .map(({ item }) => item);
}

/**
 * Resolve a batch of deferred Shoot/Melee requests (ascending shooter id)
 * against `PlayerManager`. Shared by `GameServer`'s Weapons phase and
 * `BotManager.tick`'s offline apply+flush convenience path — the only
 * difference between a bot's and a human's entry is which sink pushed it.
 *
 * `heatmapGate`, when given, is consulted per successful "shoot" outcome to
 * decide whether to emit a heatmap fact for that shooter (e.g. GameServer
 * gates bot heatmap facts on `heatmaps.botTrackingEngaged` while humans are
 * always recorded); omitted, every successful shot gets a fact.
 */
export function flushPendingWeapons(
  pending: readonly PendingWeapon[],
  players: PlayerManager,
  tick: number,
  nowMs: number,
  heatmapGate?: (shooterId: string) => boolean,
): {
  outcomes: ShootOutcome[];
  shootHeatmap: { playerId: string; doorsOpen: boolean }[];
} {
  if (pending.length === 0) {
    return { outcomes: [], shootHeatmap: [] };
  }
  const ordered = orderPendingWeapons(pending);
  const outcomes: ShootOutcome[] = [];
  const shootHeatmap: { playerId: string; doorsOpen: boolean }[] = [];
  const doorsOpen = players.areDoorsOpen(tick);
  for (const req of ordered) {
    const opts = { volDropPct: req.volDropPct, nowMs };
    const outcome = req.kind === "shoot"
      ? players.handleShoot(req.shooterId, tick, req.packet, opts)
      : players.handleMelee(req.shooterId, tick, req.packet, opts);
    if (!outcome) continue;
    outcomes.push(outcome);
    if (req.kind === "shoot" && (!heatmapGate || heatmapGate(req.shooterId))) {
      shootHeatmap.push({ playerId: req.shooterId, doorsOpen });
    }
  }
  return { outcomes, shootHeatmap };
}
