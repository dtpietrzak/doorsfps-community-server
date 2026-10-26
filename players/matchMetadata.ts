/**
 * Epic 7.4 — match metadata boundary (server read).
 *
 * Pure builder over existing owners. Live transport / reports / heatmaps never
 * call this — 7.5 / 8.2 / #10 / 11.1 attach later as the sole consumers.
 *
 * Flow:
 * ```text
 * PlayerManager (seed/clock/config/roster) ─┐
 * GameServer (runtimeMatchId/server/ctx) ───┼──→ getMatchMetadata(tick)
 * collision.map (name + version) ───────────┘         │
 *    constants (TICK_HZ / GAME_PROTO / format v) ─────┘
 *         │
 *         ├──→ live path (unchanged: never reads the builder)
 *         └──→ future 7.5 / 8.2 / 8.6 / #10 / 11.1
 * ```
 */

import {
  buildMatchMetadata,
  type MatchMetadata,
  type MatchMetadataBuildResult,
  type MatchMetadataIdentitySource,
  type MatchMetadataSimSource,
} from "../shared/replay/matchMetadata.ts";
import type {
  AuthoritativeEvent,
  AuthoritativeMapIdentity,
  AuthoritativeRaidDoorPolicy,
  MatchInitEvent,
} from "../shared/sim/authoritativeEvent.ts";

/** PlayerManager surface the metadata boundary may read (no privates). */
export type MatchMetadataPlayerSource = {
  buildMatchInitEvent(appliedTick?: number): AuthoritativeEvent;
  getMatchClockState(): { matchEndTick: number };
  getDoorCycleOriginTick(): number;
  getMatchDurationTicks(): number;
  getRaidDoorPolicy(): AuthoritativeRaidDoorPolicy;
};

/** GameServer surface the metadata boundary may read (no privates). */
export type MatchMetadataServerSource = {
  getMatchMetadataIdentity(): MatchMetadataIdentitySource;
};

/**
 * Read the PlayerManager-owned sim half at `captureTick`.
 * Uses `buildMatchInitEvent` for map/seed/config/roster (same derivation as
 * 5.5) plus explicit clock-origin getters for fields matchInit does not carry.
 */
export type MatchMetadataSimSourceResult =
  | { ok: true; sim: MatchMetadataSimSource }
  | { ok: false; reason: string };

export function readMatchMetadataSimSource(
  players: MatchMetadataPlayerSource,
  captureTick: number,
): MatchMetadataSimSourceResult {
  const initEvent = players.buildMatchInitEvent(captureTick);
  if (initEvent.kind !== "matchInit") {
    return {
      ok: false,
      reason: `buildMatchInitEvent returned kind=${initEvent.kind}`,
    };
  }
  const init = initEvent as MatchInitEvent;
  const map: AuthoritativeMapIdentity = {
    name: init.map.name,
    version: init.map.version,
  };
  return {
    ok: true,
    sim: {
      matchSeed: init.matchSeed,
      matchDurationTicks: players.getMatchDurationTicks(),
      matchEndTick: players.getMatchClockState().matchEndTick,
      doorCycleOriginTick: players.getDoorCycleOriginTick(),
      map,
      prematchEnabled: init.prematchEnabled,
      raidDoorPolicy: players.getRaidDoorPolicy(),
      debugForceDoorsOpen: init.debugForceDoorsOpen,
      phase: init.phase,
      scores: { ...init.scores },
      roster: init.roster.map((r) => ({ ...r, pose: { ...r.pose } })),
    },
  };
}

/**
 * Pure combine: PlayerManager sim source + GameServer identity → MatchMetadata.
 * Fail-loud on invalid/absent load-bearing values (never silently defaulted).
 */
export function getMatchMetadata(
  captureTick: number,
  players: MatchMetadataPlayerSource,
  server: MatchMetadataServerSource,
  opts?: { capturedAtIso?: string; nowMs?: number },
): MatchMetadataBuildResult {
  const simResult = readMatchMetadataSimSource(players, captureTick);
  if (!simResult.ok) return simResult;
  return buildMatchMetadata(
    captureTick,
    simResult.sim,
    server.getMatchMetadataIdentity(),
    opts,
  );
}

/** Convenience: unwrap or throw with the fail-loud reason. */
export function requireMatchMetadata(
  captureTick: number,
  players: MatchMetadataPlayerSource,
  server: MatchMetadataServerSource,
  opts?: { capturedAtIso?: string; nowMs?: number },
): MatchMetadata {
  const result = getMatchMetadata(captureTick, players, server, opts);
  if (!result.ok) {
    throw new Error(`getMatchMetadata failed: ${result.reason}`);
  }
  return result.metadata;
}
