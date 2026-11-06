/**
 * /api/status JSON. GameServer gathers a snapshot; this module shapes it.
 * Fleet, the client, and integration read these keys.
 */

import { statfsSync } from "node:fs";
import type { BotThinkMetrics } from "../bots/BotManager.ts";
import type { HeatmapRuntimeStats } from "../heatmaps/HeatmapTracker.ts";
import {
  TICK_HZ,
  type MatchPhase,
  type PrematchStatePacket,
  type TeamId,
  type TeamScores,
} from "../protocol/network.ts";
import type { NetMirrorSummary } from "../transport/poseHeartbeat.ts";
import type { ServerJoinMode } from "./gameServerOptions.ts";
import {
  type PhaseBucketSnapshot,
  TICK_PHASE_NAMES,
  type TickPhaseName,
  type TickTimingSnapshot,
} from "./tickTiming.ts";

export const PROCESS_STARTED_AT = new Date().toISOString();

/** Round tick timing fields for JSON (keep payload small / stable). */
export function roundTickTiming(s: TickTimingSnapshot): TickTimingSnapshot {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const r4 = (n: number) => Math.round(n * 10000) / 10000;
  const out: TickTimingSnapshot = {
    tickHz: s.tickHz,
    budgetMs: r2(s.budgetMs),
    avgMs: r2(s.avgMs),
    peakMs: r2(s.peakMs),
    avgLoad: r4(s.avgLoad),
    peakLoad: r4(s.peakLoad),
    samples1s: s.samples1s,
    samples30s: s.samples30s,
  };
  if (s.phases) {
    const phases = {} as Record<TickPhaseName, PhaseBucketSnapshot>;
    for (const name of TICK_PHASE_NAMES) {
      const p = s.phases[name];
      if (!p) continue;
      phases[name] = {
        lastMs: r2(p.lastMs),
        avgMs: r2(p.avgMs),
        peakMs: r2(p.peakMs),
        avgLoad: r4(p.avgLoad),
        peakLoad: r4(p.peakLoad),
      };
    }
    out.phases = phases;
  }
  if (typeof s.skippedDeficitTicks === "number") {
    out.skippedDeficitTicks = Math.max(0, Math.floor(s.skippedDeficitTicks));
  }
  return out;
}

export function roundHeatmapStats(s: HeatmapRuntimeStats): HeatmapRuntimeStats {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    botTrackingEngaged: s.botTrackingEngaged,
    active: s.active,
    actorCount: s.actorCount,
    humanActorCount: s.humanActorCount,
    botActorCount: s.botActorCount,
    cellEntryCount: s.cellEntryCount,
    estBytes: Math.max(0, Math.round(s.estBytes)),
    lastSampleMs: r2(s.lastSampleMs),
    avgSampleMs: r2(s.avgSampleMs),
  };
}

export type RuntimeHostStatus = {
  platform: string;
  os: string;
  arch: string;
  hostname: string | null;
  uptimeSeconds: number | null;
  cpu: {
    cores: number | null;
    loadAvg: [number, number, number] | null;
    loadPerCore: number | null;
  };
  memory: {
    totalBytes: number;
    availableBytes: number;
    usedBytes: number;
    usedRatio: number;
  } | null;
  disk: {
    totalBytes: number;
    availableBytes: number;
    usedBytes: number;
    usedRatio: number;
  } | null;
};

export function runtimeHostStatus(): RuntimeHostStatus {
  let hostname: string | null = null;
  let uptimeSeconds: number | null = null;
  let loadAvg: [number, number, number] | null = null;
  let memory: ReturnType<typeof Deno.systemMemoryInfo> | null = null;
  let disk: {
    totalBytes: number;
    availableBytes: number;
    usedBytes: number;
    usedRatio: number;
  } | null = null;
  try {
    hostname = Deno.hostname();
  } catch { /* unavailable on some targets */ }
  try {
    uptimeSeconds = Deno.osUptime();
  } catch { /* unavailable on some targets */ }
  try {
    const value = Deno.loadavg();
    loadAvg = [value[0]!, value[1]!, value[2]!];
  } catch { /* unavailable on some targets */ }
  try {
    memory = Deno.systemMemoryInfo();
  } catch { /* unavailable on some targets */ }
  try {
    const value = statfsSync(".");
    const blockSize = Number(value.bsize) || 0;
    const totalBytes = Number(value.blocks) * blockSize;
    const availableBytes = Number(value.bavail) * blockSize;
    if (totalBytes > 0) {
      const usedBytes = Math.max(0, totalBytes - availableBytes);
      disk = {
        totalBytes,
        availableBytes,
        usedBytes,
        usedRatio: usedBytes / totalBytes,
      };
    }
  } catch { /* unavailable on some targets */ }
  const cores = navigator.hardwareConcurrency || null;
  return {
    platform: `${Deno.build.os} (${Deno.build.arch})`,
    os: Deno.build.os,
    arch: Deno.build.arch,
    hostname,
    uptimeSeconds,
    cpu: {
      cores,
      loadAvg,
      loadPerCore: loadAvg && cores ? loadAvg[0] / cores : null,
    },
    memory: memory
      ? {
        totalBytes: memory.total,
        availableBytes: memory.available,
        usedBytes: Math.max(0, memory.total - memory.available),
        usedRatio: memory.total > 0
          ? Math.max(0, memory.total - memory.available) / memory.total
          : 0,
      }
      : null,
    disk,
  };
}

export type RuntimeStatusTopPlayer = {
  id: string;
  name: string;
  team: TeamId;
  kills: number;
  deaths: number;
  score: number;
  rating: number;
  isBot: boolean;
};

export type RuntimeStatusSnapshot = {
  /** Raw `DOORS_HOST_ID`. Blank becomes `"local"`. */
  hostIdEnv: string | null | undefined;
  /** Raw `DOORS_RUNTIME_ID`. Blank falls back to `rankedServerId`. */
  runtimeIdEnv: string | null | undefined;
  rankedServerId: string;
  /** Occupancy mode. Blank falls back to `rankedServerId`. */
  modeId: string | null;
  /** Raw `DOORS_INSTANCE_ID`. Blank becomes `"0"`. */
  instanceIdEnv: string | null | undefined;
  /** Raw `DOORS_GENERATION`. */
  generationEnv: string | null | undefined;
  /** Raw `DOORS_BUILD_SHA`. Blank becomes null. */
  buildShaEnv: string | null | undefined;
  host: RuntimeHostStatus;
  processId: number;
  processStartedAt: string;
  serverName: string;
  tls: boolean;
  connections: number;
  playerCount: number;
  humanCount: number;
  botCount: number;
  maxPlayers: number;
  maxPartySize: number;
  map: string;
  tick: number;
  scores: TeamScores;
  maps: string[];
  matchOver: boolean;
  matchSecondsRemaining: number;
  restartSecondsRemaining: number | null;
  phase: MatchPhase;
  matchVoided: boolean;
  /** `rankedSessionStatus().freeSlots` before the raid override. */
  sessionFreeSlots: number;
  /** `rankedSessionStatus().joinable` before drain and raid overrides. */
  sessionJoinable: boolean;
  raidRuntime: boolean;
  /** True when a raid match object exists. */
  raidActive: boolean;
  draining: boolean;
  joinMode: ServerJoinMode;
  passwordRequired: boolean;
  board: Array<{
    name: string;
    team: TeamId;
    kills: number;
    deaths: number;
    score: number;
    isBot: boolean;
  }>;
  prematch: PrematchStatePacket | null;
  topPlayer: RuntimeStatusTopPlayer | null;
  /** Unrounded loop timing, or null before the loop starts. */
  tickTiming: TickTimingSnapshot | null;
  botThink: BotThinkMetrics;
  heatmap: HeatmapRuntimeStats;
  netMirror: NetMirrorSummary & {
    websocketSessions: number;
    webTransportSessions: number;
    /** Humans only, sorted by id. Diagnostic; not hashed. */
    players: Array<{
      id: string;
      inOverwritten: number;
      inRepeatTicks: number;
      /** Alive-path inputs accepted. Denominator for inOverwritten. */
      inAccepted: number;
      /** p95 gap between accepted inputs. Null before the second input. */
      inputGapP95Ms: number | null;
      /** p95 of arrivalTick − clientTick, in ms. Null before the first shot. */
      shotDelayP95Ms: number | null;
      alive: boolean;
      connectionIssue: boolean;
    }>;
  };
  webTransport: {
    enabled: boolean;
    listening: boolean;
    port: number;
    path: string;
    proto: number;
  };
  protocolVersion: number;
};

function parseGeneration(raw: string | null | undefined): number {
  const trimmed = raw?.trim();
  if (!trimmed) return 0;
  const n = Number(trimmed);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/** JSON body of `GET /api/status`. */
export function buildRuntimeStatus(snapshot: RuntimeStatusSnapshot) {
  const top = snapshot.topPlayer;
  const prematch = snapshot.prematch;
  return {
    online: true,
    hostId: snapshot.hostIdEnv?.trim() || "local",
    runtimeId: snapshot.runtimeIdEnv?.trim() || snapshot.rankedServerId,
    // Prefer occupancy mode; fall back to server id only for legacy bare
    // mode names (local dev without DOORS_MODE_ID).
    modeId: snapshot.modeId || snapshot.rankedServerId,
    instanceId: snapshot.instanceIdEnv?.trim() || "0",
    // Slot provisioning generation (host agent / inventory). Directory
    // rejects generation-skewed observations when seed is higher (S7).
    generation: parseGeneration(snapshot.generationEnv),
    buildSha: snapshot.buildShaEnv?.trim() || null,
    host: snapshot.host,
    processId: snapshot.processId,
    processStartedAt: snapshot.processStartedAt,
    serverName: snapshot.serverName,
    tls: snapshot.tls,
    connections: snapshot.connections,
    playerCount: snapshot.playerCount,
    humanCount: snapshot.humanCount,
    botCount: snapshot.botCount,
    maxPlayers: snapshot.maxPlayers,
    /**
     * Max indivisible open-party size this runtime can seat. Authority
     * OPEN_PARTY_MAX_SIZE must not exceed this (S9-PR2).
     */
    maxPartySize: snapshot.maxPartySize,
    map: snapshot.map,
    /** Authoritative simulation tick; monotonic for this loop instance. */
    tick: snapshot.tick,
    /** Fixed simulation rate used to interpret tick and tickTiming. */
    tickRate: TICK_HZ,
    scores: snapshot.scores,
    maps: snapshot.maps,
    matchOver: snapshot.matchOver,
    /** Seconds left on the live match clock. */
    matchSecondsRemaining: snapshot.matchSecondsRemaining,
    /** Intermission countdown after game over; null while match is live. */
    restartSecondsRemaining: snapshot.restartSecondsRemaining,
    /** Ranked phase: prematch | live | intermission. */
    phase: snapshot.phase,
    /** True when live ranked match was voided by first abandon. */
    matchVoided: snapshot.matchVoided,
    /**
     * Free human seats (bots do not reduce party capacity — they can be
     * evicted on join). Used by menu parties (Phase 9).
     * Raid: exclusive — 0 while a party occupies the instance.
     */
    freeSlots: snapshot.raidRuntime &&
        (snapshot.raidActive || snapshot.humanCount > 0)
      ? 0
      : snapshot.sessionFreeSlots,
    /**
     * Host-agent scale-in drain (S7-PR4). Authority treats draining as
     * placement-ineligible; bots alone do not clear this flag.
     */
    draining: snapshot.draining,
    /**
     * Whether a new player/party can join now.
     * Ranked: only during pre-match with free seats.
     * Open: whenever free seats remain.
     * Raid: only when idle (no live raid, no humans).
     * Draining runtimes never advertise joinable.
     */
    joinable: snapshot.draining
      ? false
      : snapshot.raidRuntime
      ? !snapshot.raidActive && snapshot.humanCount === 0
      : snapshot.sessionJoinable,
    /** open = guest name; ranked = account username via join token. */
    joinMode: snapshot.joinMode,
    ranked: snapshot.joinMode === "ranked",
    /**
     * Community hosts only. True when config.json `password` is set.
     * The secret is never included in status.
     */
    passwordRequired: snapshot.passwordRequired,
    /**
     * Condensed live roster for browse UI (name, team, doors, K/D).
     */
    board: snapshot.board,
    /**
     * Ranked lobby snapshot when prematch is enabled (null on open servers).
     */
    lobby: prematch
      ? {
        humanCount: prematch.humanCount,
        humansReady: prematch.humansReady,
        minHumans: prematch.minHumans,
        canVote: prematch.canVote,
        teamHumans: prematch.teamHumans,
        requireEvenTeams: prematch.requireEvenTeams,
      }
      : null,
    /**
     * Best player by doors + max(0, kills − deaths).
     * Null when the server is empty.
     */
    topPlayer: top
      ? {
        name: top.name,
        team: top.team,
        kills: top.kills,
        deaths: top.deaths,
        score: top.score,
        rating: Math.round(top.rating * 100) / 100,
        isBot: top.isBot,
      }
      : null,
    /**
     * Sim tick wall-time vs budget (1000/tickHz ms).
     * avgMs = RMS over ~1s; peakMs = max over ~30s. Load = time/budget.
     */
    tickTiming: snapshot.tickTiming
      ? roundTickTiming(snapshot.tickTiming)
      : null,
    /**
     * Bot AI buffer: soft incomplete-debt slots, failure-tick count,
     * same-tick apply+think wall ms. Soft ≠ ready-action delay depth.
     * @see docs/game/bots.md §6
     */
    // consumeSnapshot: softSlotsPeak = worst soft credit since last /api/status poll
    botThink: snapshot.botThink,
    /**
     * In-match heatmap sampler cost (memory + sample CPU).
     * Surfaces on /admin/status so we can tell if tracking is too heavy.
     */
    heatmap: roundHeatmapStats(snapshot.heatmap),
    /**
     * Pose stream mirror (C5): volatile drops / reliable heartbeats /
     * write-buffer peaks, datagram size, and per-human input health.
     * Explains simultaneous multi-client rubberband when host uplink is
     * thrashing. Diagnostic only; not on the wire and not checkpointed.
     */
    netMirror: snapshot.netMirror,
    webTransport: snapshot.webTransport,
    protocolVersion: snapshot.protocolVersion,
  };
}
