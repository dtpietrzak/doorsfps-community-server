/**
 * Match, abandon, heatmap, and reservation reports to authority.
 * Pure builders decide the body. AuthorityReporter owns the dedup keys
 * and the fire-and-forget posts. It never imports GameServer.
 *
 * onMatchEnded stays on GameServer. Its order is replay defer, raid
 * encounter clear, rebalance cancel, prematch broadcast, heatmap flush,
 * then the scored report.
 */

import type { Player } from "../players/Player.ts";
import type { HeatmapTracker } from "../heatmaps/HeatmapTracker.ts";
import {
  type HeatmapReportResponse,
  type MatchReportBody,
  type MatchReportPlayer,
  matchReportProgressRow,
  type MatchReportResponse,
} from "../authority/adapter.ts";
import type { HeatmapIngestBody } from "../shared/world/heatmaps.ts";
import { isSyntheticUserId } from "../shared/authority/syntheticIdentity.ts";
import {
  type GameOverPacket,
  type MatchProgressionPacket,
  type MatchResult,
  NetEvents,
  type TeamId,
  type TeamScores,
} from "../protocol/network.ts";
import type { SessionHub } from "../transport/types.ts";

export type MatchReportSkipReason =
  | "void"
  | "authority_disabled"
  | "no_accounts";

export function skip(
  reason: MatchReportSkipReason,
): { skip: MatchReportSkipReason } {
  return { skip: reason };
}

/** One game-over roster row, already resolved and AFK-sampled. */
export type MatchReportActor = {
  id: string;
  accountUserId: string | null;
  name: string;
  team: TeamId;
  kills: number;
  deaths: number;
  score: number;
  isBot: boolean;
  poolAccount: boolean;
  synthetic: boolean;
  /** `Player.isAfk(endedAtMs)` from the orchestrator. */
  afk: boolean;
};

/** Account-linked raider kept after they leave, for side credit. */
export type RaidCreditRow = {
  clerkUserId: string;
  username: string;
  team: TeamId;
  kills: number;
  deaths: number;
  score: number;
};

export type MatchReportBuildInput = {
  ranked: boolean;
  authorityEnabled: boolean;
  /** Live match was already voided by abandon. Do not also score it. */
  voided: boolean;
  winner: MatchResult;
  scores: TeamScores;
  /** Packet order. Missing roster rows are already dropped. */
  actors: readonly MatchReportActor[];
  participation: {
    matchDurationMs: number;
    liveStartedAtMs: number | null;
    byPlayerId: ReadonlyMap<string, number>;
  };
  endedAtMs: number;
  raid: { humanTeam: TeamId; raidId: string } | null;
  raidCredits: Iterable<RaidCreditRow>;
  raidPrizeIneligible: ReadonlySet<string>;
  runtimeMatchId: string;
  serverId: string;
  modeId: string | null;
  mapName: string;
};

export type BuiltMatchReport = {
  body: MatchReportBody;
  reportPlayers: MatchReportPlayer[];
  key: string;
};

export type MatchReportBuildResult =
  | { skip: MatchReportSkipReason }
  | BuiltMatchReport;

/**
 * Scored or unranked end report. Raid side credit, the AFK-at-buzzer
 * prize rule, and pawn rows (only beside a human account) live here.
 * The dedup key is returned. AuthorityReporter stores it.
 */
export function buildMatchReport(
  input: MatchReportBuildInput,
): MatchReportBuildResult {
  // Already reported no_score for this live session — do not also score it.
  if (input.voided) return skip("void");
  if (!input.authorityEnabled) return skip("authority_disabled");

  const ranked = input.ranked;
  const endedAtMs = input.endedAtMs;
  const participation = input.participation;
  const matchDurationMs = Math.max(1, participation.matchDurationMs);
  // A raid has one authoritative human side. Credit every authenticated
  // raider from that side together: a stale per-player team assignment must
  // never turn a completed co-op raid into a loss for progression/cards.
  const raidHumanTeam = input.raid?.humanTeam ?? null;
  const raidWon = raidHumanTeam != null && input.winner === raidHumanTeam;

  const reportPlayers: MatchReportPlayer[] = [];
  const pawnPlayers: MatchReportPlayer[] = [];

  for (const p of input.actors) {
    if (!p.accountUserId) continue;

    let result: MatchReportPlayer["result"];
    if (raidHumanTeam != null) {
      // AFK at the buzzer: no prize. Teammates who stayed still get the win.
      result = raidWon && !p.afk ? "win" : "loss";
    } else if (input.winner === "draw") result = "draw";
    else if (input.winner === p.team) result = "win";
    else result = "loss";

    const activeMs = participation.byPlayerId.get(p.id) ?? 0;
    const factor = p.isBot
      ? 1
      : Math.min(1, Math.max(0, activeMs / matchDurationMs));

    const entry: MatchReportPlayer = {
      clerkUserId: p.accountUserId,
      username: p.name,
      team: p.team,
      kills: p.kills,
      deaths: p.deaths,
      score: p.score,
      result,
      participation: factor,
      ...(p.synthetic ? { synthetic: true as const } : {}),
    };

    if (p.isBot) {
      if (!ranked && p.poolAccount && p.accountUserId) {
        pawnPlayers.push({ ...entry, pawn: true });
      }
      continue;
    }
    reportPlayers.push(entry);
  }

  if (raidHumanTeam != null) {
    const seen = new Set(
      reportPlayers.map((row) => row.clerkUserId).filter(Boolean),
    );
    for (const credit of input.raidCredits) {
      if (seen.has(credit.clerkUserId)) continue;
      if (input.raidPrizeIneligible.has(credit.clerkUserId)) continue;
      reportPlayers.push({
        clerkUserId: credit.clerkUserId,
        username: credit.username,
        team: credit.team,
        kills: credit.kills,
        deaths: credit.deaths,
        score: credit.score,
        result: raidWon ? "win" : "loss",
        participation: 1,
        ...(isSyntheticUserId(credit.clerkUserId)
          ? { synthetic: true as const }
          : {}),
      });
    }
  }

  if (reportPlayers.length === 0) {
    // Guests have nothing to grant. Authority would also grant nothing to
    // a pawn-only report, so do not post one.
    return skip("no_accounts");
  }
  reportPlayers.push(...pawnPlayers);

  const outcome = ranked ? "scored" : "unranked";
  // Dedup key: scores + all clerk ids (same end shouldn't double-post).
  const key = [
    outcome,
    input.winner,
    input.scores.A,
    input.scores.B,
    ...reportPlayers.map((p) => p.clerkUserId).sort(),
  ].join("|");

  const startedAt = participation.liveStartedAtMs != null
    ? new Date(participation.liveStartedAtMs).toISOString()
    : undefined;

  const body: MatchReportBody = {
    runtimeMatchId: input.runtimeMatchId,
    serverId: input.serverId,
    // Occupancy for open XP/coin tiers when serverId is host+slot.
    ...(input.modeId ? { modeId: input.modeId } : {}),
    ...(input.raid ? { raidId: input.raid.raidId } : {}),
    mapName: input.mapName,
    winningTeam: input.winner,
    scoreA: input.scores.A,
    scoreB: input.scores.B,
    startedAt: startedAt ?? null,
    endedAt: new Date(endedAtMs).toISOString(),
    outcome,
    players: reportPlayers,
  };

  return { body, reportPlayers, key };
}

export type AbandonHuman = {
  id: string;
  name: string;
  team: TeamId;
  kills: number;
  deaths: number;
  score: number;
  accountUserId: string | null;
  synthetic: boolean;
};

export type AbandonReportInput = {
  leaver: { id: string; name: string; accountUserId: string | null };
  humans: readonly AbandonHuman[];
  scores: TeamScores;
  runtimeMatchId: string;
  serverId: string;
  modeId: string | null;
  mapName: string;
  endedAt: string;
};

export type BuiltAbandonReport = {
  body: MatchReportBody;
  reportPlayers: MatchReportPlayer[];
  key: string;
};

/** Ranked live abandon. Outcome is no_score. The leaver is abandon. */
export function buildAbandonReport(
  input: AbandonReportInput,
): BuiltAbandonReport {
  const reportPlayers: MatchReportPlayer[] = [];
  for (const p of input.humans) {
    const isLeaver = p.id === input.leaver.id;
    const row: MatchReportPlayer = {
      username: p.name,
      team: p.team,
      kills: p.kills,
      deaths: p.deaths,
      score: p.score,
      result: isLeaver ? "abandon" : "no_score",
    };
    if (p.accountUserId) {
      row.clerkUserId = p.accountUserId;
    }
    if (p.synthetic) row.synthetic = true;
    reportPlayers.push(row);
  }

  const abandonedBy = input.leaver.accountUserId
    ? { clerkUserId: input.leaver.accountUserId }
    : { username: input.leaver.name };

  // Dedup: void report once per live session.
  const key = [
    "no_score",
    input.leaver.accountUserId ?? input.leaver.name,
    ...reportPlayers.map((p) => p.clerkUserId ?? p.username).sort(),
  ].join("|");

  const body: MatchReportBody = {
    runtimeMatchId: input.runtimeMatchId,
    serverId: input.serverId,
    ...(input.modeId ? { modeId: input.modeId } : {}),
    mapName: input.mapName,
    scoreA: input.scores.A,
    scoreB: input.scores.B,
    endedAt: input.endedAt,
    outcome: "no_score",
    abandonedBy,
    players: reportPlayers,
  };

  return { body, reportPlayers, key };
}

export type ProgressionHuman = {
  id: string;
  accountUserId: string | null;
  socketId: string | null;
};

export type ProgressionDelivery = {
  socketId: string;
  packet: MatchProgressionPacket;
};

type ProgressAuthRow = {
  clerkUserId?: string;
  skillBefore?: number;
  skillDelta?: number;
  skillAfter?: number;
  mmrBefore?: number;
  mmrDelta?: number;
  mmrAfter?: number;
  xpBefore?: number;
  xpEarned?: number;
  xpAfter?: number;
  coinsBefore?: number;
  coinsEarned?: number;
  coinsAfter?: number;
  teamSkillPot?: number;
  teamShare?: number;
  doorBonus?: number;
  shareOfPot?: number;
  performanceRank?: number;
  teamSize?: number;
};

/**
 * One progression packet per reported human still seated, joined to the
 * authority row by clerk id (positional only when the response has no ids).
 */
export function buildProgressionPackets(input: {
  reportPlayers: readonly MatchReportPlayer[];
  gameOver: GameOverPacket;
  res: { matchId?: number; players?: unknown[] };
  humans: readonly ProgressionHuman[];
}): ProgressionDelivery[] {
  const rows = Array.isArray(input.res.players) ? input.res.players : [];
  if (rows.length === 0) return [];

  const deliveries: ProgressionDelivery[] = [];
  for (let i = 0; i < input.reportPlayers.length; i++) {
    const reported = input.reportPlayers[i]!;
    const row = matchReportProgressRow(
      input.reportPlayers,
      rows as ProgressAuthRow[],
      i,
    );
    if (!row || !reported.clerkUserId) continue;

    const live = input.humans.find(
      (p) => p.accountUserId === reported.clerkUserId,
    );
    if (!live) continue;

    // Door count from game-over stats (runtime score).
    const goRow = input.gameOver.players.find((p) => p.id === live.id);
    const doors = Math.max(
      0,
      Math.trunc(goRow?.score ?? reported.score ?? 0),
    );

    const teamShare = Math.trunc(row.teamShare ?? 0);
    const doorBonus = Math.trunc(
      row.doorBonus ?? doors * 1,
    );
    const skillDelta = Math.trunc(
      row.skillDelta ?? teamShare + doorBonus,
    );
    const teamSkillPot = Math.trunc(row.teamSkillPot ?? teamShare);
    const teamSize = Math.max(
      1,
      Math.trunc(row.teamSize ?? 1),
    );
    const shareOfPot = typeof row.shareOfPot === "number" &&
        Number.isFinite(row.shareOfPot)
      ? row.shareOfPot
      : teamSize > 0
      ? 1 / teamSize
      : 1;

    const packet: MatchProgressionPacket = {
      matchId: input.res.matchId,
      skillBefore: Math.trunc(row.skillBefore ?? 0),
      skillDelta,
      skillAfter: Math.trunc(row.skillAfter ?? 0),
      mmrBefore: Math.trunc(row.mmrBefore ?? 0),
      mmrDelta: Math.trunc(row.mmrDelta ?? skillDelta),
      mmrAfter: Math.trunc(row.mmrAfter ?? 0),
      xpBefore: Math.trunc(row.xpBefore ?? 0),
      xpEarned: Math.trunc(row.xpEarned ?? 0),
      xpAfter: Math.trunc(row.xpAfter ?? 0),
      coinsBefore: Math.trunc(row.coinsBefore ?? 0),
      coinsEarned: Math.trunc(row.coinsEarned ?? 0),
      coinsAfter: Math.trunc(row.coinsAfter ?? 0),
      teamSkillPot,
      teamShare,
      doorBonus,
      doors,
      shareOfPot,
      performanceRank: Math.max(
        1,
        Math.trunc(row.performanceRank ?? 1),
      ),
      teamSize,
    };

    if (live.socketId) {
      deliveries.push({ socketId: live.socketId, packet });
    }
  }
  return deliveries;
}

export type ReservationAckInput = {
  reservationId: string;
  status: "member_connected" | "completed" | "released" | "server_full";
  jti?: string;
};

export type ReservationAckBody = {
  hostId: string;
  runtimeId: string;
  serverId: string;
  reservationId: string;
  status: ReservationAckInput["status"];
  jti?: string;
};

export type AuthorityReporterDeps = {
  authority: {
    readonly enabled: boolean;
    reportMatch(body: MatchReportBody): Promise<MatchReportResponse>;
    reportHeatmaps(body: HeatmapIngestBody): Promise<HeatmapReportResponse>;
    reportOpenReservationAck?(body: ReservationAckBody): Promise<unknown>;
  };
  sessions: () => SessionHub | null;
  humans: () => readonly ProgressionHuman[];
  heatmaps: Pick<HeatmapTracker, "buildIngestPayload">;
  mapName: () => string;
  serverId: () => string;
  runtimeMatchId: () => string;
  heatmapBatchId: () => string;
  players: () => Iterable<Player>;
};

/**
 * Dedup keys and the posts. Callers keep orchestration (void packet,
 * participation sampling, match-end order).
 */
export class AuthorityReporter {
  /** Prevent double-report if endMatch is observed twice. */
  lastReportedMatchKey: string | null = null;
  /** Dedup key so flush is not double-posted on the same end path. */
  lastHeatmapReportKey: string | null = null;

  constructor(private readonly deps: AuthorityReporterDeps) {}

  reportMatch(built: BuiltMatchReport, gameOver: GameOverPacket): void {
    if (this.lastReportedMatchKey === built.key) return;
    this.lastReportedMatchKey = built.key;

    const outcome = built.body.outcome;
    void this.deps.authority.reportMatch(built.body).then((res) => {
      if (res.ok) {
        console.log(
          `[server] ${outcome} match reported to authority` +
            (res.matchId != null ? ` matchId=${res.matchId}` : ""),
        );
        // Only after authority DB write succeeds — never push optimistic gains.
        // Ranked: skill pot / doors / XP / coins. Unranked: XP / coins.
        if (outcome === "scored" || outcome === "unranked") {
          this.emitMatchProgression(built.reportPlayers, gameOver, res);
        }
      } else {
        console.warn(
          `[server] Match report failed: ${res.error ?? "unknown"}`,
        );
      }
    });
  }

  reportAbandon(built: BuiltAbandonReport): void {
    // Dedup: void report once per live session.
    if (this.lastReportedMatchKey === built.key) return;
    this.lastReportedMatchKey = built.key;

    if (!this.deps.authority.enabled) {
      console.warn(
        "[server] Match voided but authority reports disabled — local void only",
      );
      return;
    }

    if (built.reportPlayers.length === 0) {
      console.warn(
        "[server] Abandon with no humans in report list — skip authority",
      );
      return;
    }

    void this.deps.authority.reportMatch(built.body).then((res) => {
      if (res.ok) {
        console.log(
          `[server] no_score abandon reported to authority` +
            (res.matchId != null ? ` matchId=${res.matchId}` : ""),
        );
      } else {
        console.warn(
          `[server] no_score match report failed: ${res.error ?? "unknown"}`,
        );
      }
    });
  }

  /**
   * Official start: pull merged walk layers, compile pole tables, drop raw
   * cells. Fail-soft — bots run without a prior if authority is unreachable.
   */
  /**
   * Queue heatmap ingest for durable authority delivery. Safe on community
   * (noop). Clears nothing — caller resets on next match start.
   */
  public flushHeatmapsToAuthority(): void {
    if (!this.deps.authority.enabled) return;
    const body = this.deps.heatmaps.buildIngestPayload(
      this.deps.mapName(),
      this.deps.serverId(),
      this.deps.runtimeMatchId(),
      this.deps.players(),
    );
    if (!body || body.sessions.length === 0) return;
    body.batchId = this.deps.heatmapBatchId();
    // Avoid double-post of identical buffer in the same end path.
    const key = `hm|${body.mapName}|${body.sessions.length}|${
      body.sessions.map((s) => s.actorKey).sort().join(",")
    }`;
    if (this.lastHeatmapReportKey === key) return;
    this.lastHeatmapReportKey = key;

    void this.deps.authority.reportHeatmaps(body).then((res) => {
      if (res.ok) {
        console.log(
          `[server] Heatmaps reported` +
            (res.inserted != null ? ` inserted=${res.inserted}` : "") +
            ` sessions=${body.sessions.length}`,
        );
      } else {
        console.warn(
          `[server] Heatmap report failed: ${res.error ?? "unknown"}`,
        );
      }
    });
  }

  /**
   * Best-effort reservation progress to authority. Never blocks admission;
   * seat holds already live in authority reservations.
   */
  reportOpenReservationAck(input: ReservationAckInput): void {
    if (
      !this.deps.authority.reportOpenReservationAck ||
      !this.deps.authority.enabled
    ) {
      return;
    }
    const serverId = this.deps.serverId();
    const body: ReservationAckBody = {
      hostId: Deno.env.get("DOORS_HOST_ID")?.trim() || "local",
      runtimeId: serverId,
      serverId,
      reservationId: input.reservationId,
      status: input.status,
      ...(input.jti ? { jti: input.jti } : {}),
    };
    void this.deps.authority.reportOpenReservationAck(body).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[server] open reservation ack failed reservation=${input.reservationId} ` +
          `status=${input.status}: ${message}`,
      );
    });
  }

  private emitMatchProgression(
    reportPlayers: MatchReportPlayer[],
    gameOver: GameOverPacket,
    res: { matchId?: number; players?: unknown[] },
  ): void {
    const sessions = this.deps.sessions();
    if (!sessions) return;
    const rows = Array.isArray(res.players) ? res.players : [];
    if (rows.length === 0) return;

    const deliveries = buildProgressionPackets({
      reportPlayers,
      gameOver,
      res,
      humans: this.deps.humans(),
    });
    for (const row of deliveries) {
      sessions.get(row.socketId)?.emit(NetEvents.MatchProgression, row.packet);
    }
  }
}
