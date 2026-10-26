// @ts-types="@types/express"
// deno-lint-ignore-file no-import-prefix
import express from "express";
import cors from "cors";
import { statfsSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { Server as NodeHttpServer } from "node:http";
import type { Server as NodeHttpsServer } from "node:https";
import type { TlsMaterial } from "../host/tlsConfig.ts";
import { type BotThinkEngine, createBotThinkEngine } from "@doors/bot-engine";
import { GAME_PROTO } from "../shared/net/index.ts";
import { countSessionsByKind, createCompositeHub } from "../transport/compositeHub.ts";
import { isClientInitiatedDisconnect } from "../transport/disconnectReason.ts";
import { createSocketIoHub } from "../transport/socketIoHub.ts";
import type { SessionData, SessionHub } from "../transport/types.ts";
import { webTransportWanted, WEBTRANSPORT_PATH } from "../transport/webTransportConfig.ts";
import {
  createWebTransportHub,
  type WebTransportHub,
} from "../transport/webTransportHub.ts";

import { GameLoop, TICK_HZ } from "./GameLoop.ts";
import {
  type PhaseBucketSnapshot,
  PhaseTimingBundle,
  TICK_PHASE_NAMES,
  type TickPhaseName,
  type TickTimingSnapshot,
} from "./tickTiming.ts";
import { HostChannel } from "../host/channel/server.ts";
import { seedPoolMapVotes } from "../bots/poolMapVotes.ts";
import {
  type BotAdmissionReconcileReport,
  BotManager,
  OPEN_ADMISSION_BOT_RECONCILE_MS,
} from "../bots/BotManager.ts";
import type { BotDifficulty, BotSnapshotInfo } from "../bots/types.ts";

import {
  type CompiledBotThinkPipeline,
  DEFAULT_DENO_COMPILED_BOT_THINK_HOST,
  DEFAULT_PERRY_COMPILED_BOT_THINK_HOST,
  startCompiledBotThinkPipelineFromEnv,
} from "../bots/compiled/index.ts";
import { PlayerManager } from "../players/PlayerManager.ts";
import type { ShootOutcome } from "../players/PlayerManager.ts";
import { packCombatOutcomePacket } from "../players/combatOutcomePacket.ts";
import type { Player } from "../players/Player.ts";
import {
  flushPendingWeapons as flushWeaponsQueue,
  type PendingWeapon,
} from "../players/weaponsQueue.ts";
import {
  ingressAbility,
  ingressMelee,
  ingressMovementInput,
  ingressReload,
  ingressShoot,
  ingressSkillLoadout,
  ingressWeaponSwitch,
  type SimIngressSinks,
} from "../players/simIngress.ts";
import type { SimTickEvent, SimTickResult } from "../players/simTickResult.ts";
import { drainTickAuthoritativeEvents } from "../players/authoritativeEventSource.ts";
import type { SimActionEffect } from "../players/simActionEffect.ts";
import type { TickSelectedInput } from "../players/tickAssociation.ts";
import type {
  ReplayIntegrationSink,
  ReplayIntegrationSinkHandle,
  ReplayLifecyclePayload,
} from "../replay/replayIntegration.ts";
import { ReplayRecorder } from "../replay/ReplayRecorder.ts";
import { isReplayRecordingEnabled } from "../replay/recordingEnabled.ts";
import {
  type AuthoritativeCheckpoint,
  captureCheckpointState,
  type CheckpointRaidState,
} from "../replay/authoritativeCheckpoint.ts";
import type { AuthoritativeEvent, MatchInitEvent } from "../shared/sim/authoritativeEvent.ts";
import {
  getMatchMetadata as buildMatchMetadataFromOwners,
  requireMatchMetadata,
} from "../players/matchMetadata.ts";
import type {
  MatchMetadata,
  MatchMetadataBuildResult,
  MatchMetadataIdentitySource,
  RaidMatchMetadataState,
} from "../shared/replay/matchMetadata.ts";
import { checkPlayerName } from "../shared/authority/nameModeration.ts";
import {
  type AdminCommandResultPacket,
  AUTO_REBALANCE_DELAY_MS,
  AUTO_REBALANCE_NOTICE_MESSAGE,
  type AutoTeamRebalanceCancelPacket,
  type AutoTeamRebalanceNoticePacket,
  type ChangeTeamResultPacket,
  type CombatBurstPacket,
  type CombatOutcomePacket,
  CONNECTION_ISSUE_TIMEOUT_MS,
  type GameOverPacket,
  JoinErrors,
  type KickedPacket,
  type MapChangePacket,
  type MapVoteStatePacket,
  type MatchProgressionPacket,
  type MatchStartPacket,
  type MatchVoidedPacket,
  NetEvents,
  type PingPacket,
  rebalanceVotePasses,
  rebalanceVotesNeeded,
  type SessionReplacedPacket,
  SNAPSHOT_EVERY_TICKS,
  type TeamChangedPacket,
  type TeamId,
  type TeamRebalanceVoteResultPacket,
  type TeamRebalanceVoteStatePacket,
} from "../protocol/network.ts";
import {
  classifyVolatileEmit,
  type ClientNetMirror,
  createClientNetMirror,
  noteMirrorPingInterval,
  shouldSendReliablePose,
  summarizeNetMirrors,
} from "../transport/poseHeartbeat.ts";
import type { DoorsMap } from "../world/map.ts";
import type { MapCollision } from "../world/MapCollision.ts";
import {
  isOpenOfficialServerId,
  verifyRankedJoinToken,
} from "../authority/rankedAuth.ts";
import {
  consumeOpenAdmissionJti,
  openAdmissionSubjectKey,
} from "../authority/openAdmission.ts";
import { consumeAdminActionJti, verifyAdminActionToken } from "../authority/adminAuth.ts";
import type { AdminActionClaims } from "../shared/admin/adminCommands.ts";
import type { AuthorityPublicKeys } from "../shared/authority/authorityTokens.ts";
import {
  type AuthorityAdapter,
  createAuthorityAdapter,
  loadAuthorityUrlFromEnv,
  type MatchReportBody,
  matchReportProgressRow,
  type MatchReportPlayer,
} from "../authority/adapter.ts";
import { HeatmapTracker } from "../heatmaps/HeatmapTracker.ts";
import { poolBrainCommandFromEnv } from "../bots/poolCommand.ts";
import { rankedSessionStatus } from "./rankedSession.ts";
import { InputRateLimiter } from "../transport/inputRateLimit.ts";
import { isRuntimeDraining } from "../shared/fleet/runtimeDrain.ts";
import { isSyntheticUserId } from "../shared/authority/syntheticIdentity.ts";
import {
  admissionLocked,
  authorityStatusUrl,
  releaseLockedFromAuthorityStatus,
  shouldHoldMatchRestart,
} from "./releaseLock.ts";
import { RaidMatch } from "../raid/RaidMatch.ts";
import {
  isRaidOnlyMapName,
  RAID_AFK_MAX_MS,
  RAID_FAIL_RETURN_SECONDS,
  RAID_LOAD_TIMEOUT_PARTY_BLOCK_MS,
  RAID_WIN_RETURN_SECONDS,
} from "../shared/campaign/raids.ts";

/** Round tick timing fields for JSON (keep payload small / stable). */
function roundTickTiming(s: TickTimingSnapshot): TickTimingSnapshot {
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

/** Preloaded map available for host CLI changes and post-match voting. */
export interface MapCatalogEntry {
  name: string;
  stem: string;
  path: string;
  map: DoorsMap;
  collision: MapCollision;
}

/** open = guest name; ranked = authority join token (official only). */
export type ServerJoinMode = "open" | "ranked";

interface GameServerOptions {
  name: string;
  port: number;
  /**
   * Interface to bind (default `0.0.0.0`).
   * Official v2 hosts still bind loopback behind Caddy until the TLS cutover;
   * when `tls` is set, this process terminates HTTPS itself.
   */
  host?: string;
  /**
   * PEM cert + key. When set, listen with `node:https` (WSS on the same port).
   * Community / local HTTP leave this unset.
   */
  tls?: TlsMaterial | null;
  /**
   * When set, overrides WEBTRANSPORT_ENABLED. Still requires `tls`.
   * Official TLS hosts default on; community HTTP stays off.
   */
  webTransport?: boolean;
  map: DoorsMap;
  collision: MapCollision;
  mapPath?: string;
  /** All maps discovered at boot (preloaded). Used for voting + CLI. */
  mapCatalog?: MapCatalogEntry[];
  /**
   * Desired total roster size for auto-fill
   * (from config.json bots.autofillBots).
   */
  autofillBots?: number;
  /**
   * Bot AI tier (from config.json bots.difficulty).
   * `"easy"` | `"hard"` — see bots/difficulty.ts to add more.
   */
  botDifficulty?: BotDifficulty;
  /**
   * When true (default), drop bots if no human is connected.
   * From config.json bots.noBotsOnEmptyServer.
   */
  noBotsOnEmptyServer?: boolean;
  /**
   * Fill/balance brain from config.json `bots.brain`.
   * Omitted and `"builtin"` keep the in-process engine.
   */
  botBrain?: "builtin" | readonly string[];
  /**
   * Official pool brain command. Omitted reads `DOORS_POOL_BRAIN_CMD`.
   * `"builtin"` keeps pool pawns on the in-process engine.
   */
  poolBrain?: "builtin" | readonly string[];
  /**
   * Hard cap on connected players (humans + bots).
   * From config.json `maxPlayers` (default 8).
   */
  maxPlayers?: number;
  /**
   * Live match length in seconds.
   * From config.json `matchDurationSeconds` (default shared MATCH_DURATION_SECONDS).
   */
  matchDurationSeconds?: number;
  /**
   * Community join password from config.json `password`.
   * Required to start a community host. Ignored on official open/ranked.
   */
  joinPassword?: string | null;
  /**
   * Join policy. Community downloadables always use `open`.
   * Official ranked instances use `ranked` + authorityTokenPublicKeys.
   */
  joinMode?: ServerJoinMode;
  /** Authority Ed25519 public keys used to verify join/admin tokens. */
  authorityTokenPublicKeys?: AuthorityPublicKeys;
  /**
   * Authentic server / runtime id that tokens must target
   * (legacy: `"ranked"` / `"easy"`; slot shape: `"g00/0"`).
   */
  rankedServerId?: string;
  /**
   * Occupancy mode for this process (`DOORS_MODE_ID`). Required for host+slot
   * runtime ids that do not encode mode in the path.
   */
  modeId?: string | null;
  /**
   * Authority base URL for match reports (official authentic only).
   * Defaults from AUTHORITY_URL env when omitted.
   */
  authorityUrl?: string | null;
  /**
   * Optional inject for tests. When omitted, built from join mode + secret + URL.
   */
  authorityAdapter?: AuthorityAdapter;
  /**
   * When true, official open joins require assignment-bearing admissions
   * (`assignmentId` + `jti`). Dual-accept is off. Ranked/community ignore this.
   * Env: OPEN_ASSIGNMENT_REQUIRED (default false).
   */
  openAssignmentRequired?: boolean;
  /**
   * Tests: force the authority release lock without polling.
   * Official processes poll AUTHORITY_URL /api/status instead.
   */
  releaseLocked?: boolean;
  /** Tests may inject/disable the complete browser/Deno thought pipeline. */
  botThinkEngine?: BotThinkEngine | null;
  /** Tests may inject/disable the persistent compiled child pipeline. */
  compiledBotThinkEngine?: CompiledBotThinkPipeline | null;
  compiledBotThinkMode?: "shadow" | "compiled";
}

const DEFAULT_MAX_PLAYERS = 8;
const PROCESS_STARTED_AT = new Date().toISOString();

export type BotThinkRuntimeMode =
  | "pipeline-js"
  | "pipeline-js-codec"
  | "pipeline-compiled-shadow"
  | "pipeline-compiled"
  | "pipeline-compiled-deno-shadow"
  | "pipeline-compiled-deno"
  | "pipeline-compiled-perry"
  | "pipeline-compiled-perry-shadow";

export function parseBotThinkRuntimeMode(
  value: string | null | undefined,
): BotThinkRuntimeMode {
  const raw = value?.trim().toLowerCase();
  if (raw === "compiled" || raw === "pipeline-compiled") {
    return "pipeline-compiled";
  }
  if (raw === "compiled-shadow" || raw === "pipeline-compiled-shadow") {
    return "pipeline-compiled-shadow";
  }
  if (
    raw === "compiled-deno" || raw === "pipeline-compiled-deno" ||
    raw === "deno-compiled" || raw === "pipeline-deno"
  ) {
    return "pipeline-compiled-deno";
  }
  if (
    raw === "compiled-deno-shadow" ||
    raw === "pipeline-compiled-deno-shadow" ||
    raw === "deno-compiled-shadow"
  ) {
    return "pipeline-compiled-deno-shadow";
  }
  if (raw === "js-codec" || raw === "pipeline-js-codec") {
    return "pipeline-js-codec";
  }
  if (raw === "pipeline-compiled-perry" || raw === "compiled-perry" || raw === "pipeline-perry") {
    return "pipeline-compiled-perry";
  }
  if (raw === "pipeline-compiled-perry-shadow" || raw === "compiled-perry-shadow" || raw === "pipeline-perry-shadow") {
    return "pipeline-compiled-perry-shadow";
  }
  if (
    raw &&
    raw !== "pipeline-js" &&
    raw !== "js"
  ) {
    console.warn(
      `[bot-brain] unknown runtime '${raw}'; using pipeline-js`,
    );
  }
  return "pipeline-js";
}

export function botThinkRuntimeModeFromEnv(): BotThinkRuntimeMode {
  return parseBotThinkRuntimeMode(Deno.env.get("DOORS_BOT_THINK_RUNTIME"));
}

function isCompiledChildRuntime(mode: BotThinkRuntimeMode): boolean {
  return mode === "pipeline-compiled" ||
    mode === "pipeline-compiled-shadow" ||
    mode === "pipeline-compiled-deno" ||
    mode === "pipeline-compiled-deno-shadow" ||
    mode === "pipeline-compiled-perry" ||
    mode === "pipeline-compiled-perry-shadow";
}

function isCompiledAuthorityRuntime(mode: BotThinkRuntimeMode): boolean {
  return mode === "pipeline-compiled" || mode === "pipeline-compiled-deno" ||
    mode === "pipeline-compiled-perry";
}

function isDenoCompiledRuntime(mode: BotThinkRuntimeMode): boolean {
  return mode === "pipeline-compiled-deno" ||
    mode === "pipeline-compiled-deno-shadow";
}

/** Select the in-process half of the whole-brain runtime. */
export function createBotThinkEngineFromEnv(): BotThinkEngine | null {
  return isCompiledAuthorityRuntime(botThinkRuntimeModeFromEnv())
    ? null
    : createBotThinkEngine();
}

/** Constant-time-ish compare so join passwords are not leaked by timing. */
function joinPasswordsMatch(expected: string, provided: string): boolean {
  const a = new TextEncoder().encode(expected);
  const b = new TextEncoder().encode(provided);
  const n = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < n; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

function runtimeHostStatus() {
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

export class GameServer implements ReplayIntegrationSinkHandle {
  private readonly serverName: string;
  private port: number;
  private readonly host: string;
  private readonly maxPlayers: number;
  /**
   * Community-only. Null on official runtimes and when config omits a password.
   */
  private readonly joinPassword: string | null;
  private readonly joinMode: ServerJoinMode;
  private readonly openOfficial: boolean;
  private readonly openAssignmentRequired: boolean;
  private readonly authorityTokenPublicKeys: AuthorityPublicKeys;
  private readonly rankedServerId: string;
  /** Occupancy mode; null when unknown (community / legacy bare id only). */
  private readonly modeId: string | null;
  private releaseLocked = false;
  private releasePollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly authorityStatusUrl: string | null;
  private raid: RaidMatch | null = null;
  private pendingRaidAgentEncounter: {
    wave: number;
    atTick: number;
    count: number;
    doorTeam: TeamId;
  } | null = null;
  /** Account-linked raiders who started or joined, kept after they leave. */
  private raidCredits = new Map<string, {
    clerkUserId: string;
    username: string;
    team: TeamId;
    kills: number;
    deaths: number;
    score: number;
  }>();
  /** AFK-kicked raiders do not share a late win. */
  private raidPrizeIneligible = new Set<string>();
  /** Raiders whose client reported the map built (NetEvents.MapLoaded). */
  private raidLoadedPlayerIds = new Set<string>();
  /**
   * Parties kicked for not loading in time → wall-clock expiry. A straggler's
   * already-issued join token must not reopen the idled slot by themselves.
   */
  private raidLoadTimeoutParties = new Map<string, number>();
  private readonly authority: AuthorityAdapter;
  private map: DoorsMap;
  private mapPath?: string;
  private readonly mapCatalog: MapCatalogEntry[];
  private readonly players: PlayerManager;
  private readonly bots: BotManager;
  private hostChannel: HostChannel | null = null;
  private readonly compiledBotThinkEngine: CompiledBotThinkPipeline | null;
  /** Prevent double-report if endMatch is observed twice. */
  private lastReportedMatchKey: string | null = null;
  /** Immutable delivery identity for the current live match. */
  private runtimeMatchId = crypto.randomUUID();
  /** Immutable id for the current match's additive heatmap batch. */
  private heatmapBatchId = crypto.randomUUID();
  /**
   * Epic 7.5 — single recorder sink. Null = disabled (zero payload construction).
   * Attach/detach are the only enable path; producers never call the sink.
   * Epic 8.1: when recording is enabled, {@link replayRecorder} owns this slot.
   */
  private replaySink: ReplayIntegrationSink | null = null;
  /**
   * Epic 8.1 — named lifecycle recorder. Null when REPLAY_RECORDING_ENABLED is
   * off or the recorder has not been started yet. Owns the 7.5 sink subscription.
   */
  private replayRecorder: ReplayRecorder | null = null;
  /** Sink-callback throws contained at the fan-out (never break the tick). */
  private replaySinkErrorCount = 0;
  /**
   * Temp/dev policy: only record when a human is or has been in this match.
   * Sticky for the current runtimeMatchId (keeps recording after the last
   * human leaves). Late human join starts recording from that point.
   * Later (public): record always, discard on finalize if no human joined.
   */
  private replayMatchHadHuman = false;
  /**
   * Counts sink payload construction (inputs map / init / checkpoint notify).
   * Used by tests to prove the no-sink fast path does zero extra work.
   */
  private replayPayloadConstructionCount = 0;
  /**
   * Epic 9.2 — defer matchEnd/matchDraw sink notify until after the 7.3 drain
   * + onTick fan-out when the end is raised inside stepSim. Keeps the final
   * checkpoint on the post-drain boundary and lets the end tick's onTick run
   * while the recorder is still attached.
   */
  private pendingReplayMatchEnd: GameOverPacket | null = null;
  /** True while stepSim is on the stack (drives deferral of replay match-end). */
  private inStepSim = false;
  /**
   * Epic 8.3 — tick-local action-effect buffer filled by PlayerManager.handle*
   * while a sink is attached. Drained into onTick.actions each fan-out.
   */
  private replayActionEffects: SimActionEffect[] = [];
  /** In-match human/bot heatmap sampling (server-side only). */
  private readonly heatmaps = new HeatmapTracker({ tickHz: TICK_HZ });
  /** Dedup key so flush is not double-posted on the same end path. */
  private lastHeatmapReportKey: string | null = null;

  /** playerId → map name (only meaningful while voting is open). */
  private readonly mapVotes = new Map<string, string>();
  private mapVotingOpen = false;

  /**
   * Open-match player votes for team rebalance (human player ids).
   * Fires when votes are strictly more than 1/3 of connected humans and
   * match-player teams differ by ≥2. Ranked never uses this.
   */
  private readonly rebalanceVotes = new Set<string>();

  /**
   * Open-match pending human rebalance (indivisible group on heavy → light
   * after delay). Only scheduled after a passing rebalance vote; ranked never
   * schedules this. `playerIds` is the whole party cohort or a single solo or pool pawn.
   */
  private pendingRebalance: {
    playerIds: string[];
    from: TeamId;
    to: TeamId;
    fireAtMs: number;
  } | null = null;

  /**
   * Coalesce timer for multi-seat open admissions (S9-PR3).
   * Fires a single fill/balance bot reconcile after the settle window so
   * near-simultaneous party connections do not thrash the bot roster.
   */
  private admissionBotReconcileTimer: ReturnType<typeof setTimeout> | null =
    null;
  /** Party ids still expected to finish connecting during the open wave. */
  private readonly admissionBotPendingParties = new Map<
    string,
    { partySize: number }
  >();

  private app?: express.Application;
  private httpServer?: NodeHttpServer | NodeHttpsServer;
  private sessions?: SessionHub;
  private readonly tls: TlsMaterial | null;
  private readonly wantWebTransport: boolean;
  private wtHub: WebTransportHub | null = null;
  private webTransportListening = false;
  private webTransportListenPort: number | null = null;
  private loop!: GameLoop;
  /** Most recent tick-loop wall time for non-sim death/AFK bookkeeping. */
  private lastSimNowMs = Date.now();
  /**
   * Deferred Shoot/Melee queue, shared by humans (queued on packet arrival
   * via ingress) and bots (queued from the apply pipe, PR 4). Flushed in the
   * Weapons phase (after BotApply, before MovePhysics).
   */
  private pendingWeapons: PendingWeapon[] = [];
  /** Per-phase wall times (bots / sim / scores / emit) for /api/status. */
  private readonly phaseTiming = new PhaseTimingBundle(TICK_HZ);
  /** Per-socket human input flood guard (bots are not rate-limited). */
  private readonly inputRate = new InputRateLimiter();
  /**
   * Per-socket pose stream health (A4 / C5): volatile drops, reliable
   * heartbeats, write-buffer peaks. Keyed by session.id.
   */
  private readonly clientNetMirrors = new Map<string, ClientNetMirror>();

  constructor(options: GameServerOptions) {
    this.serverName = options.name;
    this.port = options.port;
    this.host = options.host?.trim() || "0.0.0.0";
    this.tls = options.tls ?? null;
    this.wantWebTransport = options.webTransport ??
      webTransportWanted({ tls: this.tls != null });
    this.maxPlayers = Math.max(
      1,
      Math.floor(options.maxPlayers ?? DEFAULT_MAX_PLAYERS),
    );
    this.joinMode = options.joinMode === "ranked" ? "ranked" : "open";
    this.authorityTokenPublicKeys = options.authorityTokenPublicKeys ?? {};
    this.rankedServerId = options.rankedServerId?.trim() || "ranked";
    // Prefer explicit option, then DOORS_MODE_ID (orchestrator), then legacy
    // mode-bearing server ids when DOORS_MODE_ID is unset (local bare modes).
    const envModeId = Deno.env.get("DOORS_MODE_ID")?.trim() || null;
    this.modeId = options.modeId?.trim() || envModeId || null;
    this.openOfficial = this.joinMode === "open" &&
      isOpenOfficialServerId(this.rankedServerId, this.modeId);
    const rawJoinPassword = options.joinPassword?.trim() || "";
    this.joinPassword = (this.joinMode === "open" && !this.openOfficial &&
        rawJoinPassword.length > 0)
      ? rawJoinPassword
      : null;
    this.openAssignmentRequired = this.openOfficial &&
      options.openAssignmentRequired === true;
    // Official authentic runtimes get scoped reporting credentials via env.
    // Community downloadables leave those credentials unset → silent noop.
    this.authority = options.authorityAdapter ?? createAuthorityAdapter({
      official: this.joinMode === "ranked" || this.openOfficial,
      authorityUrl: options.authorityUrl,
    });
    const official = this.joinMode === "ranked" || this.openOfficial;
    this.authorityStatusUrl = official
      ? authorityStatusUrl(options.authorityUrl ?? loadAuthorityUrlFromEnv())
      : null;
    this.releaseLocked = options.releaseLocked === true;
    if (
      (this.joinMode === "ranked" || this.openOfficial) &&
      Object.keys(this.authorityTokenPublicKeys).length === 0
    ) {
      console.warn(
        "[server] official runtime has no authority public key — joins will fail. " +
          "Set AUTHORITY_TOKEN_PUBLIC_KEYS.",
      );
    }
    this.map = options.map;
    this.mapPath = options.mapPath;
    this.mapCatalog = options.mapCatalog?.length ? options.mapCatalog : [{
      name: options.map.name,
      stem: options.map.name,
      path: options.mapPath ?? "",
      map: options.map,
      collision: options.collision,
    }];
    this.players = new PlayerManager(options.collision, {
      matchDurationSeconds: options.matchDurationSeconds,
      // Participation metadata is initialized at the server boundary; it is
      // not part of tick advancement.
      nowMs: this.lastSimNowMs,
      // Official ranked: start in warm-up lobby until unanimous ready.
      enablePrematch: this.joinMode === "ranked",
    });
    const fill: { minPlayers?: number; noBotsOnEmptyServer?: boolean } = {};
    if (options.autofillBots !== undefined) {
      fill.minPlayers = options.autofillBots;
    }
    if (options.noBotsOnEmptyServer !== undefined) {
      fill.noBotsOnEmptyServer = options.noBotsOnEmptyServer;
    }
    const runtimeMode = botThinkRuntimeModeFromEnv();
    let botThinkEngine = options.botThinkEngine === undefined
      ? createBotThinkEngineFromEnv()
      : options.botThinkEngine;
    this.compiledBotThinkEngine =
      options.compiledBotThinkEngine === undefined &&
        options.botThinkEngine === undefined &&
        isCompiledChildRuntime(runtimeMode)
        ? (isDenoCompiledRuntime(runtimeMode)
          ? startCompiledBotThinkPipelineFromEnv(undefined, {
            envName: "DOORS_BOT_THINK_DENO_BIN",
            defaultPath: DEFAULT_DENO_COMPILED_BOT_THINK_HOST,
          })
          : (runtimeMode === "pipeline-compiled-perry"
            ? startCompiledBotThinkPipelineFromEnv(undefined, {
              envName: "DOORS_BOT_THINK_BIN",
              defaultPath: DEFAULT_PERRY_COMPILED_BOT_THINK_HOST,
            })
            : startCompiledBotThinkPipelineFromEnv()))
        : options.compiledBotThinkEngine ?? null;
    if (
      isCompiledAuthorityRuntime(runtimeMode) &&
      this.compiledBotThinkEngine === null &&
      options.botThinkEngine === undefined
    ) {
      console.warn(
        `[bot-brain ${runtimeMode}] binary unavailable; falling back to pipeline-js`,
      );
      botThinkEngine = createBotThinkEngine();
    }
    const activeThinkRuntime: BotThinkRuntimeMode = botThinkEngine
      ? (this.compiledBotThinkEngine
        ? (isDenoCompiledRuntime(runtimeMode)
          ? "pipeline-compiled-deno-shadow"
          : (runtimeMode === "pipeline-compiled-perry" ? "pipeline-compiled-perry-shadow" : "pipeline-compiled-shadow"))
        : runtimeMode === "pipeline-js-codec"
        ? "pipeline-js-codec"
        : "pipeline-js")
      : (isDenoCompiledRuntime(runtimeMode)
        ? "pipeline-compiled-deno"
        : (runtimeMode === "pipeline-compiled-perry" ? "pipeline-compiled-perry" : "pipeline-compiled"));
    console.log(`[bot-brain] runtime=${activeThinkRuntime}`);
    this.bots = new BotManager(this.players, {
      onBotJoined: (player) => {
        if (!this.sessions) return;
        this.sessions.emit(
          NetEvents.PlayerJoined,
          player.toSnapshot(
            this.players.tick,
            "full",
            this.players.getCollision(),
          ),
        );
      },
      onBotLeft: (playerId) => {
        if (!this.sessions) return;
        this.mapVotes.delete(playerId);
        this.sessions.emit(NetEvents.PlayerLeft, { id: playerId });
      },
    }, {
      fill: Object.keys(fill).length > 0 ? fill : undefined,
      difficulty: options.botDifficulty,
      brain: options.botBrain,
      poolBrain: options.poolBrain ?? poolBrainCommandFromEnv(),
      thoughtEngine: botThinkEngine,
      thoughtCodecLoop: runtimeMode === "pipeline-js-codec",
      compiledThoughtEngine: this.compiledBotThinkEngine,
      compiledThoughtMode: options.compiledBotThinkMode ??
        (isCompiledAuthorityRuntime(runtimeMode) ? "compiled" : "shadow"),
      compiledThoughtHost: runtimeMode === "pipeline-compiled-perry"
        ? "perry"
        : (isDenoCompiledRuntime(runtimeMode) ? "deno" : "scriptc"),
    });
    this.bots.setPoolCap(this.maxPlayers);
    this.bots.setPoolListener((event) => {
      this.hostChannel?.send(event);
    });
    if (this.isRaidRuntime()) {
      this.bots.setRaidMode(true);
      this.players.setRaidDoorPolicy("idle");
    }
    // Epic 4.6: keep BotManager agents-domain stream in sync with match reseeds.
    this.players.setSimRngReseedListener((_seed, streams) => {
      this.bots.setAgentsRandom(streams.agents);
    });
    // PlayerManager already reseeded in its constructor before bots existed.
    this.bots.setAgentsRandom(this.players.getSimRngStreams().agents);
  }

  private isRaidRuntime(): boolean {
    return this.modeId === "raid" || this.rankedServerId === "raid";
  }

  /** Downloadable / self-hosted open server (not official Easy/Medium/Hard). */
  private isCommunityHost(): boolean {
    return this.joinMode === "open" && !this.openOfficial;
  }

  public start(): Promise<void> {
    if (this.isCommunityHost() && !this.joinPassword) {
      return Promise.reject(
        new Error(
          'Community servers require a join password. Set "password" in config.json.',
        ),
      );
    }
    this.app = express();
    this.httpServer = this.tls
      ? createHttpsServer(
        { cert: this.tls.cert, key: this.tls.key },
        this.app,
      )
      : createHttpServer(this.app);
    this.app.use(express.json());
    this.app.use(
      cors({
        origin: "*",
        methods: ["GET", "POST", "OPTIONS"],
        allowedHeaders: ["Content-Type"],
      }),
    );

    // Game traffic is small/frequent — prefer WS only and skip per-message
    // compression (CPU cost on the host often exceeds bandwidth savings).
    const socketHub = createSocketIoHub(this.httpServer, {
      cors: { origin: "*" },
    });
    if (this.wantWebTransport && this.tls) {
      this.wtHub = createWebTransportHub();
      this.sessions = createCompositeHub([socketHub, this.wtHub]);
    } else {
      this.sessions = socketHub;
    }

    this.app.get("/api/status", (_req, res) => {
      const top = this.players.getTopPlayer();
      const matchTime = this.players.getMatchTimeStatus();
      const humanCount = this.players.humanCount();
      const draining = admissionLocked(isRuntimeDraining(), this.releaseLocked);
      const session = rankedSessionStatus({
        ranked: this.joinMode === "ranked",
        phase: matchTime.phase,
        humanCount,
        maxPlayers: this.maxPlayers,
        matchVoided: this.players.isLiveMatchVoided(),
      });
      const board = this.players.getStatusBoard();
      const prematch = this.players.isPrematchEnabled()
        ? this.players.getPrematchState()
        : null;
      // Sim tick budget: how close we are to missing real-time (CPU bottleneck).
      const tickTiming = this.loop
        ? roundTickTiming({
          ...this.loop.timing.snapshot(),
          phases: this.phaseTiming.snapshot(),
          skippedDeficitTicks: this.loop.skippedDeficitTicks,
        })
        : null;
      res.json({
        online: true,
        hostId: Deno.env.get("DOORS_HOST_ID")?.trim() || "local",
        runtimeId: Deno.env.get("DOORS_RUNTIME_ID")?.trim() ||
          this.rankedServerId,
        // Prefer occupancy mode; fall back to server id only for legacy bare
        // mode names (local dev without DOORS_MODE_ID).
        modeId: this.modeId || this.rankedServerId,
        instanceId: Deno.env.get("DOORS_INSTANCE_ID")?.trim() || "0",
        // Slot provisioning generation (host agent / inventory). Directory
        // rejects generation-skewed observations when seed is higher (S7).
        generation: (() => {
          const raw = Deno.env.get("DOORS_GENERATION")?.trim();
          if (!raw) return 0;
          const n = Number(raw);
          return Number.isInteger(n) && n >= 0 ? n : 0;
        })(),
        buildSha: Deno.env.get("DOORS_BUILD_SHA")?.trim() || null,
        host: runtimeHostStatus(),
        processId: Deno.pid,
        processStartedAt: PROCESS_STARTED_AT,
        serverName: this.serverName,
        tls: this.tls != null,
        connections: this.sessions!.size,
        playerCount: this.players.size,
        humanCount,
        botCount: this.bots.count,
        maxPlayers: this.maxPlayers,
        /**
         * Max indivisible open-party size this runtime can seat. Authority
         * OPEN_PARTY_MAX_SIZE must not exceed this (S9-PR2).
         */
        maxPartySize: this.players.maxPartySize(this.maxPlayers),
        map: this.map.name,
        /** Authoritative simulation tick; monotonic for this loop instance. */
        tick: this.players.tick,
        /** Fixed simulation rate used to interpret tick and tickTiming. */
        tickRate: TICK_HZ,
        scores: this.players.getScores(),
        maps: this.voteMapCatalog().map((m) => m.name),
        matchOver: matchTime.matchOver,
        /** Seconds left on the live match clock. */
        matchSecondsRemaining: matchTime.matchSecondsRemaining,
        /** Intermission countdown after game over; null while match is live. */
        restartSecondsRemaining: matchTime.restartSecondsRemaining,
        /** Ranked phase: prematch | live | intermission. */
        phase: matchTime.phase,
        /** True when live ranked match was voided by first abandon. */
        matchVoided: this.players.isLiveMatchVoided(),
        /**
         * Free human seats (bots do not reduce party capacity — they can be
         * evicted on join). Used by menu parties (Phase 9).
         * Raid: exclusive — 0 while a party occupies the instance.
         */
        freeSlots: this.isRaidRuntime() && (this.raid != null || humanCount > 0)
          ? 0
          : session.freeSlots,
        /**
         * Host-agent scale-in drain (S7-PR4). Authority treats draining as
         * placement-ineligible; bots alone do not clear this flag.
         */
        draining,
        /**
         * Whether a new player/party can join now.
         * Ranked: only during pre-match with free seats.
         * Open: whenever free seats remain.
         * Raid: only when idle (no live raid, no humans).
         * Draining runtimes never advertise joinable.
         */
        joinable: draining
          ? false
          : this.isRaidRuntime()
          ? this.raid == null && humanCount === 0
          : session.joinable,
        /** open = guest name; ranked = account username via join token. */
        joinMode: this.joinMode,
        ranked: this.joinMode === "ranked",
        /**
         * Community hosts only. True when config.json `password` is set.
         * The secret is never included in status.
         */
        passwordRequired: this.joinPassword != null,
        /**
         * Condensed live roster for browse UI (name, team, doors, K/D).
         */
        board,
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
        tickTiming,
        /**
         * Bot AI buffer: soft incomplete-debt slots, failure-tick count,
         * same-tick apply+think wall ms. Soft ≠ ready-action delay depth.
         * @see docs/game/bots.md §6
         */
        // consumeSnapshot: softSlotsPeak = worst soft credit since last /api/status poll
        botThink: this.bots.getBotThinkMetrics({ consumeSnapshot: true }),
        /**
         * In-match heatmap sampler cost (memory + sample CPU).
         * Surfaces on /admin/status so we can tell if tracking is too heavy.
         */
        heatmap: this.roundHeatmapStats(
          this.heatmaps.getRuntimeStats(this.players.getMatchPhase()),
        ),
        /**
         * Pose stream mirror (C5): volatile drops / reliable heartbeats /
         * write-buffer peaks across connected clients. Explains simultaneous
         * multi-client rubberband when host uplink is thrashing.
         */
        netMirror: {
          ...summarizeNetMirrors(this.clientNetMirrors.values()),
          ...countSessionsByKind(this.sessions),
        },
        webTransport: {
          enabled: this.wantWebTransport,
          listening: this.webTransportListening,
          port: this.webTransportListenPort ?? this.port,
          path: this.wtHub?.path ?? WEBTRANSPORT_PATH,
          proto: GAME_PROTO,
        },
        protocolVersion: GAME_PROTO,
      });
    });

    this.app.get("/api/map", (_req, res) => {
      res.json(this.map);
    });

    this.registerEvents();
    this.startReplayRecorder();
    this.startGameLoop();
    this.startReleasePoll();
    this.openHostChannel();
    // Populate bots immediately when noBotsOnEmptyServer is false (empty lobby).
    this.bots.reconcile(this.maxPlayers);

    return new Promise((resolve, reject) => {
      this.httpServer!.once("error", reject);
      this.httpServer!.listen(this.port, this.host, () => {
        const addr = this.httpServer!.address();
        if (addr && typeof addr === "object") {
          this.port = addr.port;
        }
        const scheme = this.tls ? "https" : "http";
        const loopbackHint = !this.tls &&
            (this.host === "127.0.0.1" || this.host === "localhost")
          ? " (loopback — put TLS proxy in front for browser clients)"
          : "";
        const tlsHint = this.tls ? " (Deno TLS)" : "";
        console.log(
          `[server] listening on ${scheme}://${this.host}:${this.port}` +
            tlsHint + loopbackHint,
        );
        this.startWebTransportListener();
        resolve();
      });
    });
  }

  private startWebTransportListener(): void {
    if (!this.wtHub || !this.tls) return;
    try {
      this.wtHub.listen({
        hostname: this.host,
        port: this.port,
        cert: this.tls.cert,
        key: this.tls.key,
      });
      this.webTransportListening = this.wtHub.listening;
      this.webTransportListenPort = this.wtHub.listenPort;
      if (this.webTransportListening) {
        console.log(
          `[server] webtransport listening on https://${this.host}:` +
            `${this.webTransportListenPort ?? this.port}${this.wtHub.path}`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[server] webtransport listen failed (WSS still up): ${message}`,
      );
      this.webTransportListening = false;
    }
  }

  public async stop(): Promise<void> {
    this.stopReleasePoll();
    this.stopReplayRecorder();
    this.loop?.stop();
    // Drop a pending admission wave without reconciling — no refill on shutdown.
    if (this.admissionBotReconcileTimer != null) {
      clearTimeout(this.admissionBotReconcileTimer);
      this.admissionBotReconcileTimer = null;
    }
    this.admissionBotPendingParties.clear();
    this.bots.clear();
    await this.hostChannel?.close();
    this.hostChannel = null;
    await this.bots.closeCommandBrain();
    await this.bots.closePoolBrain();
    await this.compiledBotThinkEngine?.close();

    if (this.sessions) {
      await this.sessions.close();
      this.sessions = undefined;
    }

    if (this.httpServer) {
      await new Promise<void>((resolve, reject) => {
        this.httpServer!.close((err) => {
          // Socket.IO `close()` already shuts the underlying listener.
          if (err && !/not running/i.test(err.message)) {
            reject(err);
            return;
          }
          resolve();
        });
      });
      this.httpServer = undefined;
    }

    await this.authority.close?.(2_000);
    this.app = undefined;
  }

  public getPort(): number {
    return this.port;
  }

  /** True when this process terminates HTTPS itself (`TLS_CERT` / `tls` option). */
  public isUsingTls(): boolean {
    return this.tls != null;
  }

  public getName(): string {
    return this.serverName;
  }

  /**
   * Epic 7.4 — informational identity half for match metadata.
   * Live transport/reports never read this; recorder / #10 attach later.
   */
  public getMatchMetadataIdentity(): MatchMetadataIdentitySource {
    return {
      runtimeMatchId: this.runtimeMatchId,
      serverName: this.serverName,
      serverId: this.rankedServerId,
      modeId: this.modeId,
      raidId: this.raid?.raidId ?? null,
      buildSha: Deno.env.get("DOORS_BUILD_SHA")?.trim() || null,
      raidMatch: this.getRaidMatchMetadataState(),
    };
  }

  /**
   * Full `RaidMatch` snapshot for recording (metadata/init) — genuine dynamic
   * sim state, not config: wave/started/ended/failReason change during
   * `stepSimBody` (`tickRaidAgentEncounter` / `handleRaidScores` /
   * `handleRaidFailConditions`). `{ active: false }` off-raid, never `null`,
   * so this stays a load-bearing field without a special-cased presence check.
   * See notes/replay.md §29.2 item 2.
   */
  private getRaidMatchMetadataState(): RaidMatchMetadataState {
    const raid = this.raid;
    if (!raid) return { active: false };
    return {
      active: true,
      raidId: raid.raidId,
      humanTeam: raid.humanTeam,
      goal: raid.goal,
      maxTimeSeconds: raid.maxTimeSeconds,
      respawnMs: raid.respawnMs,
      initialMap: raid.initialMap,
      expectedHumans: raid.expectedHumans,
      startWaitSeconds: raid.startWaitSeconds,
      started: raid.started,
      ended: raid.ended,
      wave: raid.wave,
      failReason: raid.failReason,
    };
  }

  /**
   * Dynamic-only `RaidMatch` fields for checkpoint capture — static identity
   * (raidId/humanTeam/goal/...) already lives in the initial-state metadata;
   * this is what actually changes mid-match and must round-trip at each
   * checkpoint tick. `{ active: false }` off-raid. See notes/replay.md §29.2.
   */
  private getRaidCheckpointState(): CheckpointRaidState {
    const raid = this.raid;
    if (!raid) return { active: false };
    return {
      active: true,
      wave: raid.wave,
      started: raid.started,
      ended: raid.ended,
      expectedHumans: raid.expectedHumans,
      failReason: raid.failReason,
    };
  }

  /**
   * Epic 7.4 — single pure match-metadata read at `captureTick`.
   * Does not mutate owners, emit, or persist. Live path must not call this
   * for behavior (emits/snapshots/reports/heatmaps stay on existing paths).
   */
  public getMatchMetadata(
    captureTick: number = this.players.tick,
    opts?: { capturedAtIso?: string; nowMs?: number },
  ): MatchMetadataBuildResult {
    return buildMatchMetadataFromOwners(
      captureTick,
      this.players,
      this,
      opts,
    );
  }

  /** Epic 7.4 — fail-loud unwrap of {@link getMatchMetadata}. */
  public requireMatchMetadata(
    captureTick: number = this.players.tick,
    opts?: { capturedAtIso?: string; nowMs?: number },
  ): MatchMetadata {
    return requireMatchMetadata(captureTick, this.players, this, opts);
  }

  /**
   * Epic 7.5 — attach the single recorder sink (replace semantics).
   * No sink → tick loop skips all replay payload construction.
   */
  public attachReplaySink(sink: ReplayIntegrationSink): void {
    this.replaySink = sink;
    // Arm the unified handle* action-effect tap only while a sink is attached.
    this.players.setActionEffectObserver((effect) => {
      this.replayActionEffects.push(effect);
    });
  }

  /** Epic 7.5 — detach the recorder sink; live game continues unchanged. */
  public detachReplaySink(): void {
    this.replaySink = null;
    this.players.setActionEffectObserver(null);
    this.replayActionEffects = [];
  }

  /** Epic 8.1 test/observability: the lifecycle recorder, if started. */
  public getReplayRecorder(): ReplayRecorder | null {
    return this.replayRecorder;
  }

  /**
   * Epic 8.1 — start the lifecycle recorder (idempotent).
   * Production `start()` calls this when REPLAY_RECORDING_ENABLED is on and
   * the authority adapter can create an HTTP lifecycle client. Community /
   * Noop adapters never open replays.sqlite on the game host.
   */
  public startReplayRecorder(_unused?: string): ReplayRecorder | null {
    if (!isReplayRecordingEnabled()) return null;
    if (this.replayRecorder) {
      this.replayRecorder.ensureAttached();
      return this.replayRecorder;
    }
    const lifecycle = this.authority.createReplayLifecycleClient?.() ?? null;
    if (!lifecycle) return null;
    this.replayRecorder = new ReplayRecorder({
      lifecycle,
      attachSink: (sink) => this.attachReplaySink(sink),
      detachSink: () => this.detachReplaySink(),
      // 9.2: builder only — do not call this.captureCheckpoint (would re-enter sink).
      captureCheckpointState: (tick, runtimeMatchId) =>
        captureCheckpointState(
          this.players,
          tick,
          runtimeMatchId,
          this.getRaidCheckpointState(),
        ),
      // Init is read mid-tick; its pending events are already applied state.
      captureStartState: (tick, runtimeMatchId) =>
        captureCheckpointState(
          this.players,
          tick,
          runtimeMatchId,
          this.getRaidCheckpointState(),
          { allowPendingEvents: true },
        ),
    });
    this.replayRecorder.ensureAttached();
    return this.replayRecorder;
  }

  /** Epic 8.1 — fail open row (clean shutdown) and detach. */
  public stopReplayRecorder(): void {
    this.replayRecorder?.shutdown();
    this.replayRecorder = null;
  }

  /** Epic 7.5 test/observability: contained sink-throw count. */
  public getReplaySinkErrorCount(): number {
    return this.replaySinkErrorCount;
  }

  /** Epic 7.5 test/observability: payload-construction counter (no-sink gate). */
  public getReplayPayloadConstructionCount(): number {
    return this.replayPayloadConstructionCount;
  }

  /**
   * Epic 7.5 / 9.1 — named checkpoint read via `captureCheckpointState`.
   * Owner reads only (never createSnapshot / toSnapshot). Interval is 9.2-owned;
   * this tap only builds + fans out when called. Always returns the frozen
   * checkpoint to the explicit caller (driver / tests / later epics).
   */
  public captureCheckpoint(
    tick: number = this.players.tick,
  ): AuthoritativeCheckpoint {
    const checkpoint = captureCheckpointState(
      this.players,
      tick,
      this.runtimeMatchId,
      this.getRaidCheckpointState(),
    );
    const sink = this.replaySink;
    if (sink) {
      this.replayPayloadConstructionCount++;
      this.safeReplaySinkCall("onCheckpoint", () => {
        sink.onCheckpoint({ tick, checkpoint });
      });
    }
    return checkpoint;
  }

  private startReleasePoll(): void {
    if (!this.authorityStatusUrl || this.releasePollTimer) return;
    const tick = async () => {
      try {
        const response = await fetch(this.authorityStatusUrl!, {
          cache: "no-store",
          signal: AbortSignal.timeout(4_000),
        });
        if (!response.ok) return;
        this.releaseLocked = releaseLockedFromAuthorityStatus(
          await response.json(),
        );
      } catch {
        // Keep the last observed lock; HTTP poll is best-effort.
      }
    };
    void tick();
    this.releasePollTimer = setInterval(() => {
      void tick();
    }, 5_000);
  }

  private stopReleasePoll(): void {
    if (this.releasePollTimer == null) return;
    clearInterval(this.releasePollTimer);
    this.releasePollTimer = null;
  }

  public getMapName(): string {
    return this.map.name;
  }

  public getMapPath(): string | undefined {
    return this.mapPath;
  }

  public getPlayerCount(): number {
    return this.players.size;
  }

  public getHumanCount(): number {
    return this.players.humanCount();
  }

  public getBotCount(): number {
    return this.bots.count;
  }

  /** Auto-fill target (total humans + bots) from config / defaults. */
  public getAutofillBots(): number {
    return this.bots.minPlayers;
  }

  /** Current bot AI difficulty for newly spawned bots. */
  public getBotDifficulty(): BotDifficulty {
    return this.bots.getDifficulty();
  }

  /** Whether bots are culled when the last human leaves. */
  public getNoBotsOnEmptyServer(): boolean {
    return this.bots.getNoBotsOnEmptyServer();
  }

  public getMaxPlayers(): number {
    return this.maxPlayers;
  }

  public getScores(): { A: number; B: number } {
    return this.players.getScores();
  }

  /**
   * Rolling sim tick timing (total + phases) for host TUI / diagnostics.
   * Null before the game loop has started.
   */
  public getTickTiming(): TickTimingSnapshot | null {
    if (!this.loop) return null;
    return {
      ...this.loop.timing.snapshot(),
      phases: this.phaseTiming.snapshot(),
      skippedDeficitTicks: this.loop.skippedDeficitTicks,
    };
  }

  /**
   * Pose-stream mirror totals (C5): volatile drops / heartbeats / write buffer.
   * Used by host TUI so simultaneous multi-client “loss” is not blamed on Wi‑Fi alone.
   */
  public getNetMirrorSummary() {
    return summarizeNetMirrors(this.clientNetMirrors.values());
  }

  /**
   * Bot soft-buffer / failure-tick / apply+think ms for diagnostics.
   * @see docs/game/bots.md §6
   */
  public getBotThinkMetrics(opts?: { consumeSnapshot?: boolean }) {
    return this.bots.getBotThinkMetrics(opts);
  }

  /** Host CLI: list managed bots. */
  public listBots(): BotSnapshotInfo[] {
    return this.bots.list();
  }

  /**
   * Host CLI: `bots add n` — spawn up to n extra bots (respects maxPlayers).
   * Returns how many were actually added.
   */
  public addBots(n: number): number {
    return this.bots.addBots(n, this.maxPlayers);
  }

  /**
   * Host CLI: `bots remove n` — remove up to n bots.
   * Returns how many were actually removed.
   */
  public removeBots(n: number): number {
    return this.bots.removeBots(n, this.maxPlayers);
  }

  /** Re-run auto-fill (target roster while any human is present). */
  public reconcileBots(): void {
    this.bots.reconcile(this.maxPlayers);
  }

  public isMatchOver(): boolean {
    return this.players.isMatchOver();
  }

  public getMapCatalog(): MapCatalogEntry[] {
    return this.mapCatalog;
  }

  /**
   * Hot-swap the active map while keeping connections open.
   * Mid-game (live) changes end the current match as a draw; intermission and
   * ranked pre-match just switch the world and start a fresh session
   * (ranked → prematch, open → live).
   */
  public changeMap(options: {
    map: DoorsMap;
    collision: MapCollision;
    mapPath?: string;
  }): MapChangePacket {
    const tick = this.players.tick;
    const previousScores = this.players.getScores();
    const wasLive = this.players.isLive();

    // Live match only: record a draw. Prematch / intermission have no scored match.
    if (wasLive) {
      this.players.forceDraw(tick);
    }

    this.clearMapVotes();
    this.map = options.map;
    this.mapPath = options.mapPath;
    this.players.setCollision(options.collision);

    // Map swap starts a new match session — flush any live samples first.
    if (wasLive) this.flushHeatmapsToAuthority();
    this.heatmaps.resetForNewMatch();
    const matchStart = this.players.startNewMatch(tick, Date.now());
    this.beginRuntimeMatchIdentity(tick);
    // Map-change open path skips emitMatchStart — still notify live entry.
    this.notifyReplayMatchStart(tick);
    const packet: MapChangePacket = {
      map: this.map,
      scores: matchStart.scores,
      players: matchStart.players,
      doorsOpen: matchStart.doorsOpen,
      doorChangeTick: matchStart.doorChangeTick,
      matchEndTick: matchStart.matchEndTick,
      endedAsDraw: wasLive,
      ...(wasLive ? { previousScores } : {}),
    };

    if (this.sessions) {
      // MapChange alone carries map + fresh match state (clients rebuild world).
      this.sessions.emit(NetEvents.MapChange, packet);
      this.sessions.emit(NetEvents.Snapshot, this.players.createSnapshot(tick));
      if (this.players.isPrematchEnabled()) {
        this.broadcastPrematchState();
      }
    }

    return packet;
  }

  private welcomePayload(playerId: string) {
    const p = this.players.get(playerId);
    if (!p) return null;
    const gameOver = this.players.getGameOverForJoin();
    const withVote = gameOver ? this.decorateGameOver(gameOver) : undefined;
    const tick = this.players.tick;
    const ranked = this.isRanked();
    return {
      id: p.id,
      serverName: this.serverName,
      tickRate: TICK_HZ,
      snapshotRate: Math.round(TICK_HZ / SNAPSHOT_EVERY_TICKS),
      tick,
      spawn: p.toSnapshot(tick, "full", this.players.getCollision()),
      // Full roster so mid-join clients cache names + cosmetics (20 Hz is motion-only).
      players: this.players.getFullPlayerRoster(tick),
      team: p.team,
      map: this.map,
      scores: this.players.getScores(),
      ranked,
      ...(this.raid
        ? {
          matchKind: "raid" as const,
          raid: this.raid.hud(this.players.getScores()[this.raid.humanTeam]),
        }
        : {}),
      // Open matches: client uses autofill target for change-team eligibility UI.
      ...(!ranked ? { autofillBots: this.getAutofillBots() } : {}),
      ...(!ranked
        ? {
          rebalanceVote: {
            ...this.getTeamRebalanceVoteState(),
            youVoted: this.rebalanceVotes.has(playerId),
          },
        }
        : {}),
      ...(ranked || this.players.isPrematchEnabled()
        ? { prematch: this.players.getPrematchState() }
        : {}),
      ...this.players.getDoorCycleState(tick),
      ...this.players.getMatchClockState(),
      ...(withVote ? { gameOver: withVote } : {}),
      // PR7: always send owned list so client HUD can lock unowned slots.
      ownedAbilities: p.snapshotOwnedAbilities() ?? [],
      // PR-2: validated match loadout (Ability 1–4). Empty = all empty slots.
      skillLoadout: p.snapshotSkillLoadout() ?? [
        null,
        null,
        null,
        null,
      ],
    };
  }

  /**
   * Admin spectator welcome: full map + roster, no player body on the sim.
   * Client follows any roster id with arrow keys.
   */
  private welcomePayloadSpectator(socketId: string) {
    const tick = this.players.tick;
    const ranked = this.isRanked();
    const roster = this.players.getFullPlayerRoster(tick);
    const first = roster[0];
    const midX = (this.map.bounds.minX + this.map.bounds.maxX) / 2;
    const midZ = (this.map.bounds.minZ + this.map.bounds.maxZ) / 2;
    const spawn = first ?? {
      id: `spec:${socketId}`,
      name: "Spectator",
      x: midX,
      y: 1.62,
      z: midZ,
      yaw: 0,
      pitch: 0,
      health: 100,
      alive: true,
      team: "A" as TeamId,
    };
    const gameOver = this.players.getGameOverForJoin();
    const withVote = gameOver ? this.decorateGameOver(gameOver) : undefined;
    return {
      id: `spec:${socketId}`,
      spectator: true as const,
      serverName: this.serverName,
      tickRate: TICK_HZ,
      snapshotRate: Math.round(TICK_HZ / SNAPSHOT_EVERY_TICKS),
      tick,
      spawn,
      players: roster,
      team: "A" as TeamId,
      map: this.map,
      scores: this.players.getScores(),
      ranked,
      ...(!ranked ? { autofillBots: this.getAutofillBots() } : {}),
      ...(ranked || this.players.isPrematchEnabled()
        ? { prematch: this.players.getPrematchState() }
        : {}),
      ...this.players.getDoorCycleState(tick),
      ...this.players.getMatchClockState(),
      ...(withVote ? { gameOver: withVote } : {}),
    };
  }

  /**
   * Open-match team switch. Ranked rejects. On success respawns the player on
   * the new side and re-runs bot fill so a new bot can rebalance when under cap.
   */
  private handleChangeTeam(
    playerId: string,
    raw: unknown,
  ): ChangeTeamResultPacket {
    if (this.isRanked() || this.isRaidRuntime()) {
      return {
        ok: false,
        error: this.isRaidRuntime()
          ? "Team switching is disabled in raids."
          : "Team switching is only available in open matches.",
      };
    }
    let team: TeamId | undefined;
    if (raw && typeof raw === "object" && "team" in raw) {
      const t = (raw as { team: unknown }).team;
      if (t === "A" || t === "B") team = t;
    }
    const result = this.players.changeTeam(playerId, {
      autofillBots: this.getAutofillBots(),
      team,
    });
    if (!result.ok) {
      return { ok: false, error: result.error };
    }

    // Manual switch may resolve or create human imbalance — drop pending if
    // this player was in the scheduled group, then re-evaluate.
    if (this.pendingRebalance?.playerIds.includes(playerId)) {
      this.cancelPendingRebalance("manual_switch");
    }

    this.emitTeamChanged(result.player, result.to, "manual");
    // At fill cap a new bot cannot spawn — reassign bots heavy→light instead.
    for (const bot of this.players.rebalanceBotTeams()) {
      this.emitTeamChanged(bot, bot.team);
    }
    // Under fill: may add a bot on the lighter side after the flip.
    this.bots.reconcile(this.maxPlayers);
    // Manual switch may resolve imbalance — drop votes / pending if balanced.
    this.syncRebalanceAfterRosterChange();
    return { ok: true, team: result.to };
  }

  private emitTeamChanged(
    player: Player,
    team: TeamId,
    reason?: TeamChangedPacket["reason"],
  ): void {
    if (!this.sessions) return;
    const packet: TeamChangedPacket = {
      id: player.id,
      team,
      player: player.toSnapshot(
        this.players.tick,
        "full",
        this.players.getCollision(),
      ),
      ...(reason ? { reason } : {}),
    };
    this.sessions.emit(NetEvents.TeamChanged, packet);
  }

  /** Live open-match rebalance vote tallies for clients. */
  private getTeamRebalanceVoteState(): TeamRebalanceVoteStatePacket {
    this.pruneRebalanceVotes();
    const humans = this.players.humanCount();
    return {
      votes: this.rebalanceVotes.size,
      needed: rebalanceVotesNeeded(humans),
      humans,
      neededByBalance: this.players.needsHumanRebalance(),
    };
  }

  private broadcastTeamRebalanceVoteState(): void {
    if (!this.sessions || this.isRanked()) return;
    this.sessions.emit(
      NetEvents.TeamRebalanceVoteState,
      this.getTeamRebalanceVoteState(),
    );
  }

  /** Drop votes from players who left or are no longer human. */
  private pruneRebalanceVotes(): void {
    for (const id of [...this.rebalanceVotes]) {
      const p = this.players.get(id);
      if (!p || p.isBot) this.rebalanceVotes.delete(id);
    }
  }

  private clearRebalanceVotes(reason?: string): void {
    if (this.rebalanceVotes.size === 0) return;
    this.rebalanceVotes.clear();
    if (reason) {
      console.log(`[server] rebalance votes cleared (${reason})`);
    }
    this.broadcastTeamRebalanceVoteState();
  }

  /**
   * Open-match only: cast or clear a rebalance vote. When more than 1/3 of
   * humans have voted and teams need rebalancing, starts the same force-swap
   * pipeline as the former auto rebalance.
   */
  private handleTeamRebalanceVote(
    playerId: string,
    raw: unknown,
  ): TeamRebalanceVoteResultPacket {
    if (this.isRanked()) {
      return {
        ok: false,
        error: "Team rebalance voting is only available in open matches.",
      };
    }
    if (!this.players.isLive()) {
      return {
        ok: false,
        error: "Team rebalance is only available mid-match.",
      };
    }
    const player = this.players.get(playerId);
    if (!player || player.isBot) {
      return { ok: false, error: "Not in match." };
    }
    if (player.connectionIssue) {
      return { ok: false, error: "Reconnect before voting." };
    }

    let wantVote = true;
    if (raw && typeof raw === "object" && "vote" in raw) {
      const v = (raw as { vote: unknown }).vote;
      if (typeof v === "boolean") wantVote = v;
    }

    this.pruneRebalanceVotes();

    if (!wantVote) {
      this.rebalanceVotes.delete(playerId);
      this.broadcastTeamRebalanceVoteState();
      return { ok: true, voted: false };
    }

    if (!this.players.needsHumanRebalance() && !this.pendingRebalance) {
      return {
        ok: false,
        error: "Teams don't need rebalancing right now.",
        voted: this.rebalanceVotes.has(playerId),
      };
    }

    this.rebalanceVotes.add(playerId);
    this.broadcastTeamRebalanceVoteState();
    this.maybeScheduleHumanRebalance();
    return { ok: true, voted: true };
  }

  /**
   * After join/leave/manual team switch: prune votes, cancel pending if no
   * longer needed, and only continue rebalance if votes still pass.
   */
  private syncRebalanceAfterRosterChange(): void {
    if (this.isRanked()) return;
    this.pruneRebalanceVotes();
    if (!this.players.isLive() || !this.players.needsHumanRebalance()) {
      this.cancelPendingRebalance("balanced");
      this.clearRebalanceVotes("balanced");
      return;
    }
    this.broadcastTeamRebalanceVoteState();
    // Join/leave can push the threshold above remaining votes.
    if (
      !rebalanceVotePasses(
        this.rebalanceVotes.size,
        this.players.humanCount(),
      )
    ) {
      this.cancelPendingRebalance("votes_dropped");
      return;
    }
    this.maybeScheduleHumanRebalance();
  }

  /**
   * Open live matches only, after a passing rebalance vote: if match players
   * (humans + pool pawns) differ by ≥2, pick an indivisible group on the heavy
   * side (solo or pool pawn preferred, whole party only when that improves balance)
   * and schedule a force-swap after {@link AUTO_REBALANCE_DELAY_MS}.
   * Humans get a client notice; pool pawns swap silently after the delay.
   * Chains while imbalance remains and the vote mandate is still active.
   */
  private maybeScheduleHumanRebalance(): void {
    if (this.isRanked() || !this.sessions) return;
    if (!this.players.isLive()) return;
    if (this.pendingRebalance) return;

    this.pruneRebalanceVotes();
    const humans = this.players.humanCount();
    if (!rebalanceVotePasses(this.rebalanceVotes.size, humans)) return;

    const sides = this.players.humanRebalanceSides();
    if (!sides) {
      // Votes passed but already balanced — clear mandate.
      this.clearRebalanceVotes("already_balanced");
      return;
    }

    const group = this.players.pickGroupForRebalance(sides.heavy, sides.light);
    if (!group) {
      // Imbalance exists but no legal whole-group move (e.g. only a party that
      // would not improve |diff|). Drop mandate rather than splitting.
      this.clearRebalanceVotes("no_legal_group_move");
      return;
    }

    const fireAtMs = Date.now() + AUTO_REBALANCE_DELAY_MS;
    this.pendingRebalance = {
      playerIds: group.memberIds,
      from: sides.heavy,
      to: sides.light,
      fireAtMs,
    };

    const notice: AutoTeamRebalanceNoticePacket = {
      delayMs: AUTO_REBALANCE_DELAY_MS,
      from: sides.heavy,
      to: sides.light,
      message: AUTO_REBALANCE_NOTICE_MESSAGE,
    };
    let notified = 0;
    for (const id of group.memberIds) {
      const member = this.players.get(id);
      if (member?.socketId) {
        this.sessions.get(member.socketId)?.emit(
          NetEvents.AutoTeamRebalanceNotice,
          notice,
        );
        notified++;
      }
    }
    if (notified === 0) {
      console.log(
        `[server] rebalance scheduled group size=${group.size}` +
          ` anchor=${group.anchor.name}` +
          ` ${sides.heavy}→${sides.light} in ${AUTO_REBALANCE_DELAY_MS}ms`,
      );
    }
  }

  private cancelPendingRebalance(reason?: string): void {
    const pending = this.pendingRebalance;
    if (!pending) return;
    this.pendingRebalance = null;
    if (!this.sessions) return;
    const packet: AutoTeamRebalanceCancelPacket = reason ? { reason } : {};
    for (const id of pending.playerIds) {
      const player = this.players.get(id);
      const socketId = player?.socketId;
      if (!socketId) continue;
      this.sessions.get(socketId)?.emit(NetEvents.AutoTeamRebalanceCancel, packet);
    }
  }

  /**
   * Fire or cancel a pending open-match team rebalance. Call each tick.
   */
  private tickPendingRebalance(nowMs = Date.now()): void {
    const pending = this.pendingRebalance;
    if (!pending) return;

    if (this.isRanked() || !this.players.isLive()) {
      this.cancelPendingRebalance("not_live");
      this.clearRebalanceVotes("not_live");
      return;
    }

    // Vote mandate dropped (e.g. enough unvotes / leavers) → cancel mid-notice.
    this.pruneRebalanceVotes();
    if (
      !rebalanceVotePasses(
        this.rebalanceVotes.size,
        this.players.humanCount(),
      )
    ) {
      this.cancelPendingRebalance("votes_dropped");
      return;
    }

    const members = pending.playerIds.map((id) => this.players.get(id));
    if (
      members.some((p) => !p || !p.isMatchPlayer() || p.connectionIssue)
    ) {
      this.cancelPendingRebalance("victim_gone");
      // Imbalance may still need a different group.
      this.maybeScheduleHumanRebalance();
      return;
    }

    // Still need rebalance with this whole group on heavy?
    const sides = this.players.humanRebalanceSides();
    const allOnHeavy = members.every((p) => p!.team === sides?.heavy);
    if (!sides || !allOnHeavy) {
      this.cancelPendingRebalance("balanced");
      if (!sides) {
        this.clearRebalanceVotes("balanced");
        return;
      }
      // Different imbalance (e.g. other side heavy now) → reschedule.
      this.maybeScheduleHumanRebalance();
      return;
    }

    if (nowMs < pending.fireAtMs) return;

    // Commit swap for the whole indivisible group.
    this.pendingRebalance = null;
    const result = this.players.forceChangeTeamGroup(
      pending.playerIds,
      sides.light,
    );
    if (!result.ok) {
      this.maybeScheduleHumanRebalance();
      return;
    }

    for (const player of result.moved) {
      this.emitTeamChanged(player, result.to, "auto_rebalance");
    }
    for (const bot of this.players.rebalanceBotTeams()) {
      this.emitTeamChanged(bot, bot.team);
    }
    this.bots.reconcile(this.maxPlayers);
    // Further imbalance (e.g. 6v2 → 5v3 still ≥2) → chain another notice.
    // Fully balanced → clear the vote mandate.
    if (!this.players.needsHumanRebalance()) {
      this.clearRebalanceVotes("rebalance_done");
      return;
    }
    this.maybeScheduleHumanRebalance();
  }

  /** Broadcast current ranked lobby state to all clients. */
  private broadcastPrematchState(): void {
    if (!this.sessions || !this.players.isPrematchEnabled()) return;
    this.sessions.emit(NetEvents.PrematchState, this.players.getPrematchState());
  }

  /**
   * Handle MatchReady from a client. Broadcasts lobby state; may start live
   * match when unanimous ready + gates pass.
   */
  private handleMatchReady(playerId: string, ready: boolean): void {
    if (!this.players.setMatchReady(playerId, ready)) {
      // Still re-broadcast so the client stays in sync if they re-sent.
      this.broadcastPrematchState();
      return;
    }
    this.broadcastPrematchState();

    const tick = this.players.tick;
    const matchStart = this.players.tryStartLiveFromReady(tick);
    if (!matchStart) return;
    this.beginRuntimeMatchIdentity(tick);
    this.emitMatchStart(matchStart, tick);
  }

  private emitMatchStart(matchStart: MatchStartPacket, tick: number): void {
    // Epic 7.5: lifecycle fan-out is independent of transport sessions.
    this.notifyReplayMatchStart(tick);
    if (!this.sessions) return;
    this.sessions.emit(NetEvents.MatchStart, matchStart);
    this.sessions.emit(NetEvents.Snapshot, this.players.createSnapshot(tick));
    if (this.players.isPrematchEnabled()) {
      this.broadcastPrematchState();
    }
  }

  /** Community vote pool excludes raid-only maps; official raid keeps them. */
  private voteMapCatalog(): MapCatalogEntry[] {
    if (this.isRaidRuntime()) return this.mapCatalog;
    return this.mapCatalog.filter((entry) => !isRaidOnlyMapName(entry.name));
  }

  /**
   * Local socket for the process that spawned this match. Community
   * downloads leave `DOORS_HOST_CHANNEL` unset and never listen.
   */
  private openHostChannel(): void {
    const path = Deno.env.get("DOORS_HOST_CHANNEL")?.trim();
    if (!path || this.hostChannel) return;
    try {
      this.hostChannel = this.listenHostChannel(path);
    } catch (err) {
      // The match still runs; fill stays on `botN` until a restart.
      console.error(
        `[server] host channel listen failed at ${path}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private listenHostChannel(path: string): HostChannel {
    return HostChannel.listen(path, {
      hello: () => ({
        runtimeId: this.rankedServerId,
        map: this.map.name,
        maxPlayers: this.maxPlayers,
      }),
      setPolicy: (policy) => {
        this.bots.setChurnPolicy(policy.churn);
        this.bots.setVoteSeedPolicy(policy.seedMapVotes);
      },
      putIdentities: (identities) => this.bots.putPoolIdentities(identities),
      setPing: (pawnId, pingMs) => this.bots.setPawnPing(pawnId, pingMs),
    });
  }

  private beginMapVote(): void {
    this.mapVotes.clear();
    this.mapVotingOpen = this.voteMapCatalog().length > 0;
    if (this.mapVotingOpen) {
      this.seedFakeMapVotes();
    }
  }

  /**
   * When vote seeding is on, cast random map votes for a share of the pool
   * pawns. Community leaves the policy off.
   */
  private seedFakeMapVotes(): void {
    const share = this.bots.voteSeedPolicy();
    if (!share) return;
    const catalog = this.voteMapCatalog();
    if (catalog.length === 0) return;
    const pawnIds = this.bots.poolPawnIds();
    if (pawnIds.length === 0) return;
    const mapNames = catalog.map((entry) => entry.name);
    const votes = seedPoolMapVotes(pawnIds, mapNames, share);
    for (const [playerId, mapName] of votes) {
      this.mapVotes.set(playerId, mapName);
    }
  }

  private clearMapVotes(): void {
    this.mapVotes.clear();
    this.mapVotingOpen = false;
  }

  private getMapVoteState(): MapVoteStatePacket {
    const catalog = this.voteMapCatalog();
    const counts = new Map<string, number>();
    for (const entry of catalog) {
      counts.set(entry.name, 0);
    }
    for (const mapName of this.mapVotes.values()) {
      if (!counts.has(mapName)) continue;
      counts.set(mapName, (counts.get(mapName) ?? 0) + 1);
    }
    return {
      options: catalog.map((entry) => ({
        name: entry.name,
        votes: counts.get(entry.name) ?? 0,
      })),
      voterCount: this.mapVotes.size,
    };
  }

  private findCatalogEntry(query: string): MapCatalogEntry | null {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return (
      this.mapCatalog.find((m) => m.name.toLowerCase() === q) ??
        this.mapCatalog.find((m) => m.stem.toLowerCase() === q) ??
        null
    );
  }

  /**
   * Execute a verified admin action (identity already checked by caller).
   */
  private executeAdminCommand(
    claims: AdminActionClaims,
  ): AdminCommandResultPacket {
    if (claims.cmd === "change_map") {
      const mapName = String(claims.args.mapName ?? "");
      const entry = this.findCatalogEntry(mapName);
      if (!entry) {
        const available = this.mapCatalog.map((m) => m.name).join(", ");
        return {
          ok: false,
          command: claims.cmd,
          error: available
            ? `Unknown map "${mapName}". Available: ${available}`
            : `Unknown map "${mapName}".`,
          code: "admin_unknown_map",
          jti: claims.jti,
        };
      }
      if (
        entry.name === this.map.name &&
        entry.path === this.mapPath
      ) {
        return {
          ok: true,
          command: claims.cmd,
          message: `Already on map "${entry.name}".`,
          data: { mapName: entry.name },
          jti: claims.jti,
        };
      }
      const result = this.changeMap({
        map: entry.map,
        collision: entry.collision,
        mapPath: entry.path,
      });
      const drawNote = result.endedAsDraw
        ? " (previous match recorded as a draw)"
        : "";
      return {
        ok: true,
        command: claims.cmd,
        message: `Changed map to "${entry.name}"${drawNote}.`,
        data: {
          mapName: entry.name,
          endedAsDraw: result.endedAsDraw,
        },
        jti: claims.jti,
      };
    }

    if (claims.cmd === "kick") {
      return this.executeAdminKick(claims);
    }

    if (claims.cmd === "track_bots") {
      const engaged = this.heatmaps.toggleBotTracking();
      return {
        ok: true,
        command: claims.cmd,
        message: engaged ? "Bot tracking engaged." : "Bot tracking disengaged.",
        data: { engaged },
        jti: claims.jti,
      };
    }

    if (claims.cmd === "force_doors") {
      const enabled = typeof claims.args.enabled === "boolean"
        ? this.players.setDebugForceDoorsOpen(claims.args.enabled)
        : this.players.toggleDebugForceDoorsOpen();
      return {
        ok: true,
        command: claims.cmd,
        message: enabled
          ? "Doors forced open (debug — no closures)."
          : "Door cycle restored.",
        data: { enabled },
        jti: claims.jti,
      };
    }

    return {
      ok: false,
      command: claims.cmd,
      error: `Unhandled admin command: ${claims.cmd}`,
      code: "admin_unknown_command",
      jti: claims.jti,
    };
  }

  /**
   * Admin kick by display name (human or bot / pool pawn).
   * Humans are hard-removed (no connection-issue grace). Bots lower autofill
   * offset so they are not instantly re-spawned.
   */
  private executeAdminKick(
    claims: AdminActionClaims,
  ): AdminCommandResultPacket {
    const name = String(claims.args.name ?? "").trim();
    if (!name) {
      return {
        ok: false,
        command: claims.cmd,
        error: "kick requires a player name.",
        code: "admin_kick_bad_args",
        jti: claims.jti,
      };
    }

    const target = this.players.findByName(name);
    if (!target) {
      return {
        ok: false,
        command: claims.cmd,
        error: `No player named "${name}" on this server.`,
        code: "admin_kick_not_found",
        jti: claims.jti,
      };
    }

    // Do not let an admin boot themselves mid-command.
    if (
      !target.isBot &&
      target.accountUserId &&
      target.accountUserId === claims.sub
    ) {
      return {
        ok: false,
        command: claims.cmd,
        error: "You cannot kick yourself.",
        code: "admin_kick_self",
        jti: claims.jti,
      };
    }

    if (target.isBot) {
      const wasSeed = target.isMatchPlayer();
      const kind = target.isAgent
        ? "agent"
        : target.isBalanceBot
        ? "balance bot"
        : wasSeed
        ? "pool pawn"
        : "fill bot";
      const kickedName = target.name;
      const kickedId = target.id;
      const ok = this.bots.kickBot(target.id);
      if (!ok) {
        return {
          ok: false,
          command: claims.cmd,
          error: `Failed to kick ${kind} "${kickedName}".`,
          code: "admin_kick_failed",
          jti: claims.jti,
        };
      }
      // Clear pending rebalance if we kicked a scheduled group member.
      if (this.pendingRebalance?.playerIds.includes(kickedId)) {
        this.pendingRebalance = null;
      }
      // Pool pawns count as real players — may change rebalance need / votes.
      // Fill/balance/agent kicks do not change match-player counts.
      if (wasSeed && this.players.isLive()) {
        this.syncRebalanceAfterRosterChange();
      }
      // After removing a fill bot, do not force reconcile (would re-add).
      console.log(
        `[server] admin kick ${kind} name=${kickedName} id=${kickedId}` +
          ` by=${claims.sub}`,
      );
      return {
        ok: true,
        command: claims.cmd,
        message: `Kicked ${kind} "${kickedName}".`,
        data: {
          name: kickedName,
          id: kickedId,
          isBot: true,
          isSeed: wasSeed,
          isAgent: target.isAgent,
          isBalanceBot: target.isBalanceBot,
        },
        jti: claims.jti,
      };
    }

    // Human: permanent leave (same path as intentional Leave).
    const kickedName = target.name;
    const kickedId = target.id;
    const socketId = target.socketId;
    if (socketId && this.sessions) {
      const session = this.sessions.get(socketId);
      if (session) session.data.intentionalLeave = true;
    }
    this.dropPlayer(kickedId);
    if (socketId && this.sessions) {
      this.sessions.get(socketId)?.disconnect();
    }
    console.log(
      `[server] admin kick human name=${kickedName} id=${kickedId}` +
        ` by=${claims.sub}`,
    );
    return {
      ok: true,
      command: claims.cmd,
      message: `Kicked "${kickedName}".`,
      data: {
        name: kickedName,
        id: kickedId,
        isBot: false,
      },
      jti: claims.jti,
    };
  }

  /**
   * Cast or change a player's map vote. Returns the new state when accepted.
   */
  private castMapVote(
    playerId: string,
    mapName: string,
  ): MapVoteStatePacket | null {
    if (!this.mapVotingOpen || !this.players.isMatchOver()) return null;
    if (!this.players.get(playerId)) return null;
    const entry = this.findCatalogEntry(mapName);
    if (!entry) return null;
    this.mapVotes.set(playerId, entry.name);
    return this.getMapVoteState();
  }

  /**
   * Pick the voted map: highest votes wins; ties broken randomly.
   * No votes → random map from this server's catalog.
   */
  /**
   * Intermission map pick. Epic 4.6: MATCH-CONFIG / RECORD — do not seed.
   * #5/#8 records the chosen map as initial state for the next match.
   */
  private resolveMapVoteWinner(): MapCatalogEntry | null {
    if (this.mapCatalog.length === 0) return null;
    if (this.mapVotes.size === 0) {
      return this.mapCatalog[
        Math.floor(Math.random() * this.mapCatalog.length)
      ]!;
    }

    const counts = new Map<string, number>();
    for (const name of this.mapVotes.values()) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }

    let best = 0;
    for (const n of counts.values()) {
      if (n > best) best = n;
    }
    const leaders = this.mapCatalog.filter(
      (m) => (counts.get(m.name) ?? 0) === best,
    );
    if (leaders.length === 0) return null;
    if (leaders.length === 1) return leaders[0]!;
    return leaders[Math.floor(Math.random() * leaders.length)]!;
  }

  /**
   * XP grant mode for official authentic servers (absent on community hosts).
   * Clients use this to show the post-match XP bar.
   */
  private gameOverXpMode(): GameOverPacket["xpMode"] {
    if (!this.authority.enabled) return undefined;
    return this.isRanked() ? "ranked" : "unranked";
  }

  private decorateGameOver(packet: GameOverPacket): GameOverPacket {
    if (this.raid) {
      const xpMode = this.gameOverXpMode();
      const humanScore = packet.scores[this.raid.humanTeam];
      const won = packet.winner === this.raid.humanTeam;
      const remaining = Math.max(0, Math.ceil(packet.restartInSeconds || 0));
      return {
        ...packet,
        restartInSeconds: remaining > 0
          ? remaining
          : (won ? RAID_WIN_RETURN_SECONDS : RAID_FAIL_RETURN_SECONDS),
        returnToMenu: true,
        matchKind: "raid",
        raid: this.raid.hud(humanScore),
        ...(xpMode ? { xpMode } : {}),
      };
    }
    const xpMode = this.gameOverXpMode();
    if (shouldHoldMatchRestart(this.releaseLocked)) {
      return {
        ...packet,
        returnToMenu: true,
        ...(xpMode ? { xpMode } : {}),
      };
    }
    return {
      ...packet,
      mapVote: this.getMapVoteState(),
      ...(xpMode ? { xpMode } : {}),
    };
  }

  private enrichGameOver(packet: GameOverPacket): GameOverPacket {
    if (!this.raid && !shouldHoldMatchRestart(this.releaseLocked)) {
      this.beginMapVote();
    }
    return this.decorateGameOver(packet);
  }

  private raidFailEndOpts(): { scheduleRestart: true; restartSeconds: number } {
    return {
      scheduleRestart: true,
      restartSeconds: RAID_FAIL_RETURN_SECONDS,
    };
  }

  private raidWinEndOpts(): { scheduleRestart: true; restartSeconds: number } {
    return {
      scheduleRestart: true,
      restartSeconds: RAID_WIN_RETURN_SECONDS,
    };
  }

  /** Reject a later join whose token disagrees with the live raid instance. */
  private raidJoinConflict(input: {
    team?: "A" | "B";
    raidId?: string;
  }): boolean {
    if (!this.raid) return false;
    if (input.team && input.team !== this.raid.humanTeam) return true;
    if (input.raidId && input.raidId !== this.raid.raidId) return true;
    return false;
  }

  private activateRaidFromJoin(input: {
    team?: "A" | "B";
    raidId?: string;
    partySize?: number;
    soloRaid?: boolean;
  }): void {
    if (!this.isRaidRuntime()) return;
    if (this.raid) {
      if (typeof input.partySize === "number") {
        this.raid.raiseExpectedHumans(input.partySize);
      }
      return;
    }
    if (this.players.isMatchOver()) {
      this.players.startNewMatch(this.players.tick, Date.now());
    }
    // A warm raid slot serves many parties without restarting the process.
    // Give every newly activated raid its own authority/idempotency identity;
    // otherwise later clears replay the previous match receipt and receive no
    // fresh XP, coins, unlock, or match-card claim.
    this.beginRuntimeMatchIdentity(this.players.tick);
    this.notifyReplayMatchStart(this.players.tick);
    this.heatmaps.resetForNewMatch();
    const team = input.team === "B" ? "B" : "A";
    this.raidCredits.clear();
    this.raidPrizeIneligible.clear();
    this.raidLoadedPlayerIds.clear();
    this.raid = new RaidMatch({
      humanTeam: team,
      raidId: input.raidId,
      expectedHumans: input.partySize,
      allowSolo: input.soloRaid === true,
    });
    this.switchRaidMap(this.raid.planForWave(1).map, false);
    // Match clock starts when the raid starts, not during the party wait.
  }

  /** Swap a raid stage map without resetting scores, clock, or progression. */
  private switchRaidMap(mapName: string, emit: boolean = true): boolean {
    const entry = this.findCatalogEntry(mapName);
    if (!entry) {
      console.warn(`[raid] required map "${mapName}" is not preloaded`);
      return false;
    }
    if (entry.path === this.mapPath && entry.name === this.map.name) {
      return true;
    }

    this.map = entry.map;
    this.mapPath = entry.path;
    this.players.setCollision(entry.collision);

    if (!emit) return true;
    const tick = this.players.tick;
    this.players.relocateRaidSurvivors(tick);
    const door = this.players.getDoorCycleState(tick);
    const plan = this.raid?.planForWave(this.raid.wave);
    const packet: MapChangePacket = {
      map: this.map,
      scores: this.players.getScores(),
      players: this.players.getFullPlayerRoster(tick),
      doorsOpen: door.doorsOpen,
      doorChangeTick: door.doorChangeTick,
      matchEndTick: this.players.getMatchClockState().matchEndTick,
      endedAsDraw: false,
      raidStage: true,
      ...(plan?.prevMap ? { prevMap: plan.prevMap } : {}),
      ...(plan?.nextMap ? { nextMap: plan.nextMap } : {}),
    };
    this.sessions?.emit(NetEvents.MapChange, packet);
    this.sessions?.emit(NetEvents.Snapshot, this.players.createSnapshot(tick));
    return true;
  }

  /** Replace the enemy roster and arm any scripted encounter for this round. */
  private beginRaidWave(wave: number): GameOverPacket | null {
    if (!this.raid || this.raid.ended) return null;
    const plan = this.raid.planForWave(wave);
    this.pendingRaidAgentEncounter = null;
    this.bots.clearRaidBots();
    if (!this.switchRaidMap(plan.map)) {
      this.raid.onTimeout();
      return this.players.forceEndMatch(
        this.players.tick,
        this.raid.enemyTeam,
        this.raidFailEndOpts(),
      );
    }

    const bossEncounter = plan.bossEncounter;
    const miniEncounter = plan.miniEncounter;
    if (miniEncounter) {
      this.bots.setRaidMixedWave(this.raid.enemyTeam, {
        normals: plan.botCount,
        minis: {
          count: miniEncounter.count,
          maxHealth: miniEncounter.maxHealth,
          modelScale: miniEncounter.scale,
          moveSpeedScale: miniEncounter.moveSpeedScale,
        },
        ...(bossEncounter
          ? {
            bosses: {
              count: bossEncounter.count,
              maxHealth: bossEncounter.maxHealth,
              modelScale: bossEncounter.scale,
              moveSpeedScale: bossEncounter.moveSpeedScale,
            },
          }
          : {}),
      });
    } else if (bossEncounter) {
      this.bots.setRaidBossWave(
        bossEncounter.count,
        this.raid.enemyTeam,
        {
          maxHealth: bossEncounter.maxHealth,
          modelScale: bossEncounter.scale,
          moveSpeedScale: bossEncounter.moveSpeedScale,
        },
      );
    } else {
      this.bots.setRaidWave(plan.botCount, this.raid.enemyTeam);
    }

    if (plan.agentEncounter) {
      this.pendingRaidAgentEncounter = {
        wave: plan.wave,
        atTick: this.players.tick + Math.ceil(
          plan.agentEncounter.delaySeconds * TICK_HZ,
        ),
        count: plan.agentEncounter.count,
        doorTeam: this.raid.humanTeam,
      };
      if (plan.agentEncounter.delaySeconds > 0) {
        this.players.setRaidDoorPolicy("idle");
      }
      this.tickRaidAgentEncounter(this.players.tick);
    }
    return null;
  }

  private tickRaidAgentEncounter(tick: number): void {
    const encounter = this.pendingRaidAgentEncounter;
    if (!encounter || tick < encounter.atTick) return;
    this.pendingRaidAgentEncounter = null;
    if (
      !this.raid || !this.raid.started || this.raid.ended ||
      this.raid.wave !== encounter.wave || this.players.isMatchOver()
    ) return;
    this.bots.spawnAgentsAtDoor(
      encounter.count,
      this.players.getCollision(),
      encounter.doorTeam,
    );
    this.players.setRaidDoorPolicy("open");
  }

  private maybeStartRaid(): GameOverPacket | null {
    if (!this.raid || this.raid.started || this.raid.ended) return null;
    const humans = this.players.humans().filter((p) =>
      p.team === this.raid!.humanTeam
    );
    // Connected is not enough: a slow loader would join a fight already
    // underway. Hold doors and bots until every client has built the map.
    const loaded = humans.filter((p) => this.raidLoadedPlayerIds.has(p.id));
    if (!this.raid.tryStart(loaded.length)) return null;
    for (const human of humans) human.raidAfkAccumMs = 0;
    this.players.setRaidDoorPolicy("open");
    this.players.setMatchClock(this.players.tick, this.raid.maxTimeSeconds);
    return this.beginRaidWave(1);
  }

  private handleRaidScores(
    scores: { team: TeamId }[],
  ): GameOverPacket | null {
    if (!this.raid || !this.raid.started || this.raid.ended) return null;
    // Same tick as a bot capture: the house wins. Do not start the next wave
    // and then fail — and do not ignore the enemy score.
    if (scores.some((ev) => ev.team !== this.raid!.humanTeam)) {
      this.raid.onEnemyCapture();
      return this.players.forceEndMatch(
        this.players.tick,
        this.raid.enemyTeam,
        this.raidFailEndOpts(),
      );
    }
    for (const ev of scores) {
      if (ev.team !== this.raid.humanTeam) continue;
      const humanScore = this.players.getScores()[this.raid.humanTeam];
      const result = this.raid.onHumanCapture(humanScore);
      if (result === "win") {
        return this.players.forceEndMatch(
          this.players.tick,
          this.raid.humanTeam,
          this.raidWinEndOpts(),
        );
      }
      const over = this.beginRaidWave(this.raid.wave);
      if (over) return over;
    }
    return null;
  }

  private handleRaidFailConditions(): GameOverPacket | null {
    if (!this.raid || this.raid.ended) return null;
    if (!this.raid.started) {
      const startedOver = this.maybeStartRaid();
      if (startedOver) return startedOver;
      if (this.raid.started || this.raid.ended) return null;
      const waiting = this.players.humans().filter((p) =>
        p.team === this.raid!.humanTeam
      );
      if (waiting.length === 0) {
        this.raid.onEmpty();
        return this.players.forceEndMatch(
          this.players.tick,
          this.raid.enemyTeam,
        );
      }
      if (this.raid.startWaitElapsed()) this.kickRaidPartyForLoadTimeout();
      return null;
    }
    const humans = this.players.humans();
    const ours = humans.filter((p) => p.team === this.raid!.humanTeam);
    if (ours.length === 0) {
      this.raid.onEmpty();
      return this.players.forceEndMatch(this.players.tick, this.raid.enemyTeam);
    }
    if (this.raid.allHumansDead(ours)) {
      this.raid.onWipe();
      return this.players.forceEndMatch(
        this.players.tick,
        this.raid.enemyTeam,
        this.raidFailEndOpts(),
      );
    }
    if (this.players.isMatchTimeExpired()) {
      this.raid.onTimeout();
      return this.players.forceEndMatch(
        this.players.tick,
        this.raid.enemyTeam,
        this.raidFailEndOpts(),
      );
    }
    return null;
  }

  /**
   * Someone in the party never finished loading within the start wait: send
   * the whole party back to the menu and idle the slot for the next party.
   */
  private kickRaidPartyForLoadTimeout(nowMs: number = Date.now()): void {
    const humans = [...this.players.humans()];
    const loaded = humans.filter((p) => this.raidLoadedPlayerIds.has(p.id))
      .length;
    console.log(
      `[raid] load timeout: ${loaded}/${this.raid?.expectedHumans ?? 0} ` +
        `loaded (${humans.length} connected); kicking party`,
    );
    for (const [partyId, expiresAtMs] of this.raidLoadTimeoutParties) {
      if (expiresAtMs <= nowMs) this.raidLoadTimeoutParties.delete(partyId);
    }
    for (const player of humans) {
      if (player.partyId) {
        this.raidLoadTimeoutParties.set(
          player.partyId,
          nowMs + RAID_LOAD_TIMEOUT_PARTY_BLOCK_MS,
        );
      }
      this.dismissHumanToMenu(player, {
        reason: "raid_load_timeout",
        message: "Raid cancelled: not everyone in your party loaded in time.",
      });
    }
    this.resetIdleRaidRuntime();
  }

  private raidPartyTimedOut(
    partyId: string | undefined,
    nowMs: number = Date.now(),
  ): boolean {
    if (!partyId) return false;
    const expiresAtMs = this.raidLoadTimeoutParties.get(partyId);
    if (expiresAtMs == null) return false;
    if (expiresAtMs > nowMs) return true;
    this.raidLoadTimeoutParties.delete(partyId);
    return false;
  }

  private snapshotRaidCredit(player: Player): void {
    if (!this.raid || player.isBot || !player.accountUserId) return;
    this.raidCredits.set(player.accountUserId, {
      clerkUserId: player.accountUserId,
      username: player.name,
      team: player.team,
      kills: player.kills,
      deaths: player.deaths,
      score: player.score,
    });
  }

  private resetIdleRaidRuntime(): void {
    if (!this.isRaidRuntime()) return;
    this.raid = null;
    this.pendingRaidAgentEncounter = null;
    this.raidCredits.clear();
    this.raidPrizeIneligible.clear();
    this.raidLoadedPlayerIds.clear();
    this.bots.clearRaidBots();
    this.bots.setRaidMode(true);
    this.players.setRaidDoorPolicy("idle");
    this.players.clearScheduledRestart();
    // Last party can leave during the win/fail sit. Clearing only the restart
    // timer left matchOver + gameOverSnapshot armed, so the next join walked
    // into an already-lost raid.
    this.players.startNewMatch(this.players.tick, Date.now());
  }

  /** Raid win/fail sit elapsed: boot remaining humans and idle the slot. */
  private closeEndedRaidSession(): void {
    for (const player of [...this.players.humans()]) {
      this.dismissHumanToMenu(player, {
        reason: "return_to_menu",
        message: "Returning to main menu.",
      });
    }
    this.resetIdleRaidRuntime();
  }

  /**
   * Intermission elapsed during a coordinated release: drop remaining humans
   * as a real leave so humanCount can hit 0 and drain can finish.
   */
  private returnHumansToMenuAfterDrain(): void {
    this.players.clearScheduledRestart();
    for (const player of [...this.players.humans()]) {
      this.dismissHumanToMenu(player, {
        reason: "return_to_menu",
        message: "Returning to main menu.",
      });
    }
  }

  private dismissHumanToMenu(
    player: Player,
    packet: KickedPacket,
  ): void {
    if (player.isBot) return;
    const playerId = player.id;
    const socketId = player.socketId;
    if (socketId && this.sessions) {
      const session = this.sessions.get(socketId);
      if (session) {
        session.data.intentionalLeave = true;
        try {
          session.emit(NetEvents.Kicked, packet);
        } catch {
          // Best-effort notify; disconnect still proceeds.
        }
      }
    }
    this.dropPlayer(playerId);
    if (socketId && this.sessions) {
      this.sessions.get(socketId)?.disconnect();
    }
  }

  /**
   * After a normal scored match ends (score win or time limit), report to
   * authority on official authentic servers. Fire-and-forget so the tick loop
   * is not blocked. Host map-change forceDraw is not reported.
   * If the match was already voided by abandon, skip the completion report.
   *
   * Ranked → outcome "scored" (skill + match XP + kill/door XP).
   * Open official → outcome "unranked" (open match/win XP + kill/door XP).
   */
  private onMatchEnded(packet: GameOverPacket, nowMs = Date.now()): void {
    this.hostChannel?.send({ type: "match-over" });
    // Epic 7.5 / 9.2: end/draw sink notify.
    // Inside stepSim → defer until post-drain (see flushPendingReplayMatchEnd).
    // Outside stepSim (tests / leave-to-empty raid) → notify immediately.
    if (this.inStepSim) {
      this.pendingReplayMatchEnd = packet;
    } else {
      this.notifyReplayMatchEnded(packet, this.players.tick);
    }
    this.pendingRaidAgentEncounter = null;
    // Drop any mid-match rebalance; phase is no longer live.
    this.cancelPendingRebalance("match_over");
    this.clearRebalanceVotes("match_over");
    // Live match ended — lobby phase becomes intermission (for ranked UI).
    if (this.players.isPrematchEnabled()) {
      this.broadcastPrematchState();
    }
    // Flush heatmaps even when progression report is skipped (void / no accounts),
    // as long as authority is configured — samples already collected in memory.
    this.flushHeatmapsToAuthority();

    // Already reported no_score for this live session — do not also score it.
    if (this.players.isLiveMatchVoided()) {
      console.log(
        "[server] Match ended after abandon void — skip scored report",
      );
      return;
    }
    if (!this.authority.enabled) return;

    const ranked = this.isRanked();
    // Adapter timestamp: stepSim passes tick-captured nowMs (epic 4.8).
    const endedAtMs = nowMs;
    const participation = this.players.getMatchParticipation(endedAtMs);
    const matchDurationMs = Math.max(1, participation.matchDurationMs);
    // A raid has one authoritative human side. Credit every authenticated
    // raider from that side together: a stale per-player team assignment must
    // never turn a completed co-op raid into a loss for progression/cards.
    const raidHumanTeam = this.raid?.humanTeam ?? null;
    const raidWon = raidHumanTeam != null && packet.winner === raidHumanTeam;

    const reportPlayers: MatchReportPlayer[] = [];
    const pawnPlayers: MatchReportPlayer[] = [];

    for (const row of packet.players) {
      const p = this.players.get(row.id);
      if (!p || !p.accountUserId) continue;

      let result: MatchReportPlayer["result"];
      if (raidHumanTeam != null) {
        // AFK at the buzzer: no prize. Teammates who stayed still get the win.
        result = raidWon && !p.isAfk(endedAtMs) ? "win" : "loss";
      } else if (packet.winner === "draw") result = "draw";
      else if (packet.winner === p.team) result = "win";
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
      for (const credit of this.raidCredits.values()) {
        if (seen.has(credit.clerkUserId)) continue;
        if (this.raidPrizeIneligible.has(credit.clerkUserId)) continue;
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
      if (ranked) {
        console.warn(
          "[server] Ranked match ended with no account-linked humans — skip report",
        );
      }
      return;
    }
    reportPlayers.push(...pawnPlayers);

    const outcome = ranked ? "scored" : "unranked";
    // Dedup key: scores + all clerk ids (same end shouldn't double-post).
    const key = [
      outcome,
      packet.winner,
      packet.scores.A,
      packet.scores.B,
      ...reportPlayers.map((p) => p.clerkUserId).sort(),
    ].join("|");
    if (this.lastReportedMatchKey === key) return;
    this.lastReportedMatchKey = key;

    const startedAt = participation.liveStartedAtMs != null
      ? new Date(participation.liveStartedAtMs).toISOString()
      : undefined;

    const body: MatchReportBody = {
      runtimeMatchId: this.runtimeMatchId,
      serverId: this.rankedServerId,
      // Occupancy for open XP/coin tiers when serverId is host+slot.
      ...(this.modeId ? { modeId: this.modeId } : {}),
      ...(this.raid ? { raidId: this.raid.raidId } : {}),
      mapName: this.map.name,
      winningTeam: packet.winner,
      scoreA: packet.scores.A,
      scoreB: packet.scores.B,
      startedAt: startedAt ?? null,
      endedAt: new Date(endedAtMs).toISOString(),
      outcome,
      players: reportPlayers,
    };

    void this.authority.reportMatch(body).then((res) => {
      if (res.ok) {
        console.log(
          `[server] ${outcome} match reported to authority` +
            (res.matchId != null ? ` matchId=${res.matchId}` : ""),
        );
        // Only after authority DB write succeeds — never push optimistic gains.
        // Ranked: skill pot / doors / XP / coins. Unranked: XP / coins.
        if (outcome === "scored" || outcome === "unranked") {
          this.emitMatchProgression(reportPlayers, packet, res);
        }
      } else {
        console.warn(
          `[server] Match report failed: ${res.error ?? "unknown"}`,
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
  private flushHeatmapsToAuthority(): void {
    if (!this.authority.enabled) return;
    const body = this.heatmaps.buildIngestPayload(
      this.map.name,
      this.rankedServerId,
      this.runtimeMatchId,
      this.players.all(),
    );
    if (!body || body.sessions.length === 0) return;
    body.batchId = this.heatmapBatchId;
    // Avoid double-post of identical buffer in the same end path.
    const key = `hm|${body.mapName}|${body.sessions.length}|${
      body.sessions.map((s) => s.actorKey).sort().join(",")
    }`;
    if (this.lastHeatmapReportKey === key) return;
    this.lastHeatmapReportKey = key;

    void this.authority.reportHeatmaps(body).then((res) => {
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

  private roundHeatmapStats(
    s: ReturnType<HeatmapTracker["getRuntimeStats"]>,
  ): ReturnType<HeatmapTracker["getRuntimeStats"]> {
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

  /**
   * After authority records a match (DB committed), tell each linked human
   * their XP / coins (and ranked skill pot) for the game-over UI.
   * Joins each reported player to the authority row by echoed clerk id.
   * Unranked ingest can omit an unknown clerk, so position is not identity.
   * Never called unless the match-report request succeeded.
   */
  private emitMatchProgression(
    reportPlayers: MatchReportPlayer[],
    gameOver: GameOverPacket,
    res: { matchId?: number; players?: unknown[] },
  ): void {
    if (!this.sessions) return;
    const rows = Array.isArray(res.players) ? res.players : [];
    if (rows.length === 0) return;

    type AuthRow = {
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

    const humans = this.players.humans();

    for (let i = 0; i < reportPlayers.length; i++) {
      const reported = reportPlayers[i]!;
      const row = matchReportProgressRow(
        reportPlayers,
        rows as AuthRow[],
        i,
      );
      if (!row || !reported.clerkUserId) continue;

      const live = humans.find(
        (p) => p.accountUserId === reported.clerkUserId,
      );
      if (!live) continue;

      // Door count from game-over stats (runtime score).
      const goRow = gameOver.players.find((p) => p.id === live.id);
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
        matchId: res.matchId,
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
        this.sessions.get(live.socketId)?.emit(
          NetEvents.MatchProgression,
          packet,
        );
      }
    }
  }

  /**
   * First human permanent leave during a live ranked match:
   * void the match, report no_score once, notify remaining clients.
   * Call while the leaver is still on the roster (before remove).
   * Pre-match / intermission / subsequent leaves: no-op.
   */
  private handleHumanAbandon(leaver: Player): void {
    if (!this.isRanked()) return;
    if (leaver.isBot) return;
    // Only scored live play can be abandoned (not prematch warm-up / intermission).
    if (!this.players.isLive()) return;
    if (!this.players.markLiveMatchVoided(leaver.id)) {
      // Already voided — free leave for everyone else.
      return;
    }

    const scores = this.players.getScores();
    const reportPlayers: MatchReportPlayer[] = [];
    for (const p of this.players.humans()) {
      const isLeaver = p.id === leaver.id;
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

    const abandonedBy = leaver.accountUserId
      ? { clerkUserId: leaver.accountUserId }
      : { username: leaver.name };

    const voidPacket: MatchVoidedPacket = {
      abandonedById: leaver.id,
      abandonedByName: leaver.name,
      freeToLeave: true,
      message: "Match voided — free to leave",
    };
    if (this.sessions) {
      this.sessions.emit(NetEvents.MatchVoided, voidPacket);
    }

    console.log(
      `[server] Ranked match voided by abandon: ${leaver.name}` +
        (leaver.accountUserId ? ` (${leaver.accountUserId})` : ""),
    );

    // Dedup: void report once per live session.
    const key = [
      "no_score",
      leaver.accountUserId ?? leaver.name,
      ...reportPlayers.map((p) => p.clerkUserId ?? p.username).sort(),
    ].join("|");
    if (this.lastReportedMatchKey === key) return;
    this.lastReportedMatchKey = key;

    if (!this.authority.enabled) {
      console.warn(
        "[server] Match voided but authority reports disabled — local void only",
      );
      return;
    }

    if (reportPlayers.length === 0) {
      console.warn(
        "[server] Abandon with no humans in report list — skip authority",
      );
      return;
    }

    const body: MatchReportBody = {
      runtimeMatchId: this.runtimeMatchId,
      serverId: this.rankedServerId,
      ...(this.modeId ? { modeId: this.modeId } : {}),
      mapName: this.map.name,
      scoreA: scores.A,
      scoreB: scores.B,
      endedAt: new Date().toISOString(),
      outcome: "no_score",
      abandonedBy,
      players: reportPlayers,
    };

    void this.authority.reportMatch(body).then((res) => {
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
   * Kick the live transport for a player so a new join can take over the same
   * roster slot (other tab / device). Marks intentional leave so disconnect
   * does not start connection-issue grace. No-op when already disconnected.
   */
  private displaceExistingSession(playerId: string): void {
    const existing = this.players.get(playerId);
    if (!existing || existing.isBot) return;
    const socketId = existing.socketId;
    if (!socketId || !this.sessions) return;
    const session = this.sessions.get(socketId);
    if (!session) return;

    session.data.intentionalLeave = true;
    const packet: SessionReplacedPacket = {
      reason: "joined_elsewhere",
      message:
        "Your account joined this match from another tab or device. This session was closed.",
    };
    try {
      session.emit(NetEvents.SessionReplaced, packet);
    } catch {
      // Best-effort notify; disconnect still proceeds.
    }
    session.disconnect();
    console.log(
      `[server] session replaced for ${existing.name}` +
        (existing.accountUserId ? ` (${existing.accountUserId})` : "") +
        ` — prior socket ${socketId}`,
    );
  }

  /**
   * Hard-kick a human for AFK (flag + AFK_KICK_MS). Notifies the client, then
   * permanent leave (same path as intentional Leave / admin kick).
   */
  private kickPlayerForAfk(player: Player): void {
    if (player.isBot) return;
    const playerId = player.id;
    const name = player.name;
    const socketId = player.socketId;
    if (socketId && this.sessions) {
      const session = this.sessions.get(socketId);
      if (session) {
        session.data.intentionalLeave = true;
        const packet: KickedPacket = {
          reason: "afk",
          message: "You were removed for being away from keyboard too long.",
        };
        try {
          session.emit(NetEvents.Kicked, packet);
        } catch {
          // Best-effort notify; disconnect still proceeds.
        }
      }
    }
    if (this.raid && player.accountUserId) {
      this.raidPrizeIneligible.add(player.accountUserId);
    }
    this.dropPlayer(playerId);
    if (socketId && this.sessions) {
      this.sessions.get(socketId)?.disconnect();
    }
    console.log(`[server] AFK kick human name=${name} id=${playerId}`);
  }

  /**
   * Permanently remove a player (intentional leave or grace timeout).
   * Broadcasts PlayerLeft and refreshes map-vote tallies when needed.
   * During ranked pre-match, clears ready votes (via remove) and rebroadcasts lobby.
   * During ranked live: first human leave voids the match (abandon).
   * When the last human leaves ranked: hard-reset to clean pre-match (Phase 8).
   */
  private dropPlayer(playerId: string): void {
    const leaver = this.players.get(playerId);
    if (leaver) {
      this.heatmaps.recordPlayerDeparture(leaver);
    }
    // Abandon while still on roster so report includes the leaver + remaining.
    if (leaver && !leaver.isBot) {
      this.snapshotRaidCredit(leaver);
      this.handleHumanAbandon(leaver);
    }

    if (this.pendingRebalance?.playerIds.includes(playerId)) {
      // Group member left — cancel without packets (partial group invalid).
      this.pendingRebalance = null;
    }
    const hadRebalanceVote = this.rebalanceVotes.delete(playerId);

    const hadVote = this.mapVotes.delete(playerId);
    const wasPrematch = this.players.isPrematch();
    this.players.remove(playerId);
    this.sessions!.emit(NetEvents.PlayerLeft, { id: playerId });
    if (hadVote && this.mapVotingOpen) {
      this.sessions!.emit(NetEvents.MapVoteState, this.getMapVoteState());
    }

    // Last human left official ranked → clean pre-match for the next party.
    if (this.maybeResetEmptyRankedInstance()) {
      return;
    }
    if (this.isRaidRuntime() && this.players.humanCount() === 0) {
      if (
        this.raid?.started && !this.raid.ended && !this.players.isMatchOver()
      ) {
        this.raid.onEmpty();
        const over = this.players.forceEndMatch(
          this.players.tick,
          this.raid.enemyTeam,
        );
        if (over) {
          this.onMatchEnded(over);
          this.sessions!.emit(NetEvents.GameOver, this.enrichGameOver(over));
        }
      }
      this.resetIdleRaidRuntime();
      return;
    }

    // Human left → refill / cull bots (authentic: 30% mirror within base ±1).
    // Collapse any open admission bot wave first so leave does not race the
    // settle timer (S9-PR3).
    if (
      this.bots.isAdmissionBatchActive() ||
      this.admissionBotReconcileTimer != null
    ) {
      this.finishAdmissionBotBatch("leave");
    }
    this.bots.onHumanLeft(this.maxPlayers);
    if (wasPrematch) {
      this.broadcastPrematchState();
    } else if (
      hadRebalanceVote || this.rebalanceVotes.size > 0 || this.pendingRebalance
    ) {
      this.syncRebalanceAfterRosterChange();
    }
  }

  /**
   * Phase 8: when human count hits 0 on the official ranked server, hard-reset
   * to a clean pre-match lobby (scores, ready votes, void flag, doors locked,
   * bots cleared). Advertised via /api/status (`joinable`, `phase`, `freeSlots`).
   *
   * Returns true when a reset ran (caller should skip normal leave reconcile).
   */
  private maybeResetEmptyRankedInstance(): boolean {
    if (!this.isRanked()) return false;
    if (this.players.humanCount() > 0) return false;

    const tick = this.players.tick;
    const phaseBefore = this.players.getMatchPhase();
    const scoresBefore = this.players.getScores();

    // A live ranked match can become empty without reaching GameOver. Preserve
    // its sampled cells and departure-snapshotted stats, then clear the tracker
    // so those cells cannot be attributed to the next party.
    if (phaseBefore === "live") {
      this.flushHeatmapsToAuthority();
    }
    this.heatmaps.resetForNewMatch();

    // A draining runtime should retain its phase for release coordination, but
    // its final heatmap batch is still complete and safe to clear in memory.
    if (this.releaseLocked) return false;

    // Drop any leftover autofill bots so the next party does not inherit them.
    this.bots.clear();
    this.clearMapVotes();
    // Allow the next live match to report independently.
    this.lastReportedMatchKey = null;

    // Clean pre-match: zero scores, clear void, lock doors, clear ready votes.
    this.players.enterPrematch(tick, Date.now());
    // Keep bots at 0 while empty (default noBotsOnEmptyServer).
    this.bots.reconcile(this.maxPlayers);

    console.log(
      `[server] Ranked instance empty — reset to clean pre-match` +
        ` (was ${phaseBefore}, scores ${scoresBefore.A}-${scoresBefore.B})` +
        ` · joinable freeSlots=${this.maxPlayers}`,
    );
    return true;
  }

  /**
   * Host / tests: force empty ranked reset if no humans remain.
   * No-op when not ranked or humans are still present.
   */
  public resetEmptyRankedIfNeeded(): boolean {
    return this.maybeResetEmptyRankedInstance();
  }

  /**
   * Free enough non-agent seats for `seats` humans by evicting ordinary bots.
   * Prefer `preferredTeam` (party join side). Grey agents never consume capacity.
   * Returns ok only when this connecting human can obtain a seat; `evicted` is
   * how many bots were removed during this call (admission-wave metrics).
   *
   * Callers pass the remaining reserved party size so a full bot lobby can
   * pre-evict for the whole group (S9-PR3) instead of one-by-one oscillation.
   */
  private ensureHumanJoinSlots(
    seats: number,
    preferredTeam?: TeamId,
  ): { ok: boolean; evicted: number } {
    const want = Math.max(1, Math.floor(seats));
    const free = Math.max(0, this.maxPlayers - this.players.nonAgentCount());
    if (free >= want) return { ok: true, evicted: 0 };
    const need = want - free;
    const evicted = this.bots.tryEvict(need, preferredTeam);
    const freeAfter = free + evicted;
    // This connection only needs one seat; remaining party seats may still
    // free as later members arrive if not every bot could be removed.
    return { ok: freeAfter >= 1, evicted };
  }

  /**
   * Seats still reserved for this party that are not yet on the roster
   * (including the connecting member). Solos → 1.
   */
  private remainingPartySeats(opts: {
    partyId?: string | null;
    partySize?: number | null;
  }): number {
    const size = typeof opts.partySize === "number" && opts.partySize > 0
      ? Math.floor(opts.partySize)
      : 1;
    if (!opts.partyId || size <= 1) return 1;
    const seated = this.players.listPartyMembers(opts.partyId).length;
    return Math.max(1, size - seated);
  }

  /**
   * Whether this join should participate in a deferred bot reconcile wave
   * (multi-member party and/or assignment-bearing open admission batch).
   */
  private shouldBatchBotReconcile(opts: {
    partyId?: string | null;
    partySize?: number | null;
    assignmentId?: string | null;
  }): boolean {
    if (opts.assignmentId) return true;
    const size = typeof opts.partySize === "number" ? opts.partySize : 0;
    return Boolean(opts.partyId) && size > 1;
  }

  /**
   * Close the wave early when every tracked multi-member party is fully seated.
   * Assignment-only solos in the same wave still wait for the settle timer so
   * multi-party batches (Story 6 packing) share one reconcile.
   */
  private allTrackedAdmissionPartiesSeated(): boolean {
    if (this.admissionBotPendingParties.size === 0) return false;
    for (const [partyId, meta] of this.admissionBotPendingParties) {
      if (this.players.listPartyMembers(partyId).length < meta.partySize) {
        return false;
      }
    }
    return true;
  }

  private finishAdmissionBotBatch(
    reason: "party_complete" | "timer" | "leave" | "manual",
  ): void {
    if (this.admissionBotReconcileTimer != null) {
      clearTimeout(this.admissionBotReconcileTimer);
      this.admissionBotReconcileTimer = null;
    }
    this.admissionBotPendingParties.clear();
    if (!this.bots.isAdmissionBatchActive()) return;
    const report = this.bots.finishAdmissionBatch(this.maxPlayers);
    this.logAdmissionBotReconcile(report, reason);
  }

  private logAdmissionBotReconcile(
    report: BotAdmissionReconcileReport,
    reason: string,
  ): void {
    console.log(
      `[server] open admission bot reconcile reason=${reason}` +
        ` humans=${report.humanCount}` +
        ` humanTeams=A${report.humanTeamCounts.A}/B${report.humanTeamCounts.B}` +
        ` teams=A${report.teamCounts.A}/B${report.teamCounts.B}` +
        ` fillBots=${report.fillBotCount}` +
        ` botsEvicted=${report.botsEvicted}` +
        ` balanceBot=${
          report.balanceBot ? `yes:${report.balanceBotTeam ?? "?"}` : "no"
        }`,
    );
  }

  /**
   * After a human is seated: either immediate bot fill (solo) or deferred
   * batch reconcile for party / assignment-bearing admissions (S9-PR3).
   */
  private onHumanSeatedForBots(opts: {
    partyId?: string | null;
    partySize?: number | null;
    assignmentId?: string | null;
    /** Middleware + connect-path bot removals for this seat. */
    botsEvicted?: number;
  }): void {
    // First human this match → start recording from join onward (temp/dev).
    this.noteReplayHumanPresence();
    if (!this.shouldBatchBotReconcile(opts)) {
      // Solo / non-batch: snap fill immediately (existing community/authentic).
      this.bots.onHumanJoined(this.maxPlayers);
      return;
    }

    // Open wave, apply join churn with reconcile deferred, then maybe settle.
    this.bots.startAdmissionBatch();
    if (opts.botsEvicted && opts.botsEvicted > 0) {
      this.bots.noteAdmissionEvictions(opts.botsEvicted);
    }
    const partyId = opts.partyId?.trim() || null;
    const partySize = typeof opts.partySize === "number"
      ? Math.floor(opts.partySize)
      : 0;
    if (partyId && partySize > 1) {
      this.admissionBotPendingParties.set(partyId, { partySize });
    }

    this.bots.onHumanJoined(this.maxPlayers);

    if (this.allTrackedAdmissionPartiesSeated()) {
      this.finishAdmissionBotBatch("party_complete");
      return;
    }

    // Coalesce near-simultaneous multi-party / remaining-member connects.
    if (this.admissionBotReconcileTimer != null) {
      clearTimeout(this.admissionBotReconcileTimer);
    }
    this.admissionBotReconcileTimer = setTimeout(() => {
      this.admissionBotReconcileTimer = null;
      this.finishAdmissionBotBatch("timer");
    }, OPEN_ADMISSION_BOT_RECONCILE_MS);
  }

  /**
   * Resolve the display name for a connecting socket.
   * Ranked: authority-issued join token required (username is the Clerk username).
   * Open official: authority-issued join token required (account or reservation).
   * Community: plain name only.
   * Admin spectate: authority admin action token (cmd=spectate); no player slot.
   */
  private async authenticateJoin(
    authBag: Record<string, unknown>,
  ): Promise<
    | {
      ok: true;
      name: string;
      spectator?: boolean;
      reclaimPlayerId?: string;
      accountUserId?: string;
      partyId?: string;
      partySize?: number;
      /** Open seat reservation id when assignment-bearing admission. */
      assignmentId?: string;
      /** Bots removed during middleware seat free (S9-PR3 metrics). */
      botsEvictedForJoin?: number;
      head?: number;
      visor?: number;
      shoulder?: number;
      body?: number;
      leg?: number;
      hue?: number;
      gunHue?: number;
      bulletHue?: number;
      crosshairColor?: number;
      nameHue?: number;
      pistol?: number;
      rifle?: number;
      shotgun?: number;
      /** Rifle optic 0…4. Omitted joins use Standard. */
      scope?: number;
      crosshair?: number;
      ownedAbilities?: import("../shared/sim/skills.ts").SkillProductId[];
      skillLoadout?: Array<import("../shared/sim/skills.ts").SkillId | null>;
      xp?: number;
      mmsRankId?: import("../shared/progression/mmsRanks.ts").MmsRankId;
      founderBadge?: boolean;
      /** Join-token synthetic claim. False when the claim is absent. */
      synthetic?: boolean;
    }
    | { ok: false; error: string }
  > {
    const auth = authBag ?? {};
    if (Number(auth.proto) !== GAME_PROTO) {
      return { ok: false, error: JoinErrors.ProtocolMismatch };
    }
    if (this.isCommunityHost()) {
      const provided = typeof auth.password === "string" ? auth.password : "";
      if (!this.joinPassword || provided.length === 0) {
        return { ok: false, error: JoinErrors.PasswordRequired };
      }
      if (!joinPasswordsMatch(this.joinPassword, provided)) {
        return { ok: false, error: JoinErrors.PasswordInvalid };
      }
    }
    const wantSpectate = auth.spectate === true ||
      auth.spectate === 1 ||
      auth.spectate === "1" ||
      auth.spectate === "true";

    if (wantSpectate) {
      if (Object.keys(this.authorityTokenPublicKeys).length === 0) {
        return { ok: false, error: JoinErrors.SpectateDenied };
      }
      const adminToken = auth.adminToken ?? auth.spectateToken ?? auth.token;
      const verified = await verifyAdminActionToken(
        adminToken,
        this.authorityTokenPublicKeys,
        this.rankedServerId,
      );
      if (!verified.ok || verified.claims.cmd !== "spectate") {
        return { ok: false, error: JoinErrors.SpectateDenied };
      }
      if (
        !consumeAdminActionJti(verified.claims.jti, verified.claims.exp)
      ) {
        return { ok: false, error: JoinErrors.SpectateDenied };
      }
      return {
        ok: true,
        spectator: true,
        name: "Spectator",
        accountUserId: verified.claims.sub,
      };
    }

    let name: string | null = null;
    let accountUserId: string | undefined;
    let partyId: string | undefined;
    let partySize: number | undefined;
    let head: number | undefined;
    let visor: number | undefined;
    let shoulder: number | undefined;
    let body: number | undefined;
    let leg: number | undefined;
    let hue: number | undefined;
    let gunHue: number | undefined;
    let bulletHue: number | undefined;
    let crosshairColor: number | undefined;
    let nameHue: number | undefined;
    let pistol: number | undefined;
    let rifle: number | undefined;
    let shotgun: number | undefined;
    let scope: number | undefined;
    let crosshair: number | undefined;
    let xp: number | undefined;
    let mmsRankId: import("../shared/progression/mmsRanks.ts").MmsRankId | undefined;
    let founderBadge: boolean | undefined;
    let synthetic = false;
    /** Explicit list when join token present; empty for guests. */
    let ownedAbilities: import("../shared/sim/skills.ts").SkillProductId[] = [];
    let skillLoadout:
      | Array<import("../shared/sim/skills.ts").SkillId | null>
      | undefined;
    let assignmentId: string | undefined;
    let admissionJti: string | undefined;
    let admissionExp: number | undefined;

    const token = auth.joinToken ?? auth.token;
    const requireOpenAssignment = this.openAssignmentRequired;

    if (this.joinMode === "ranked") {
      if (Object.keys(this.authorityTokenPublicKeys).length === 0) {
        return { ok: false, error: JoinErrors.AuthInvalid };
      }
      if (token == null || token === "") {
        return { ok: false, error: JoinErrors.AuthRequired };
      }
      const claims = await verifyRankedJoinToken(
        token,
        this.authorityTokenPublicKeys,
        this.rankedServerId,
      );
      if (!claims) {
        return { ok: false, error: JoinErrors.AuthInvalid };
      }
      name = claims.username;
      accountUserId = claims.sub;
      if (claims.partyId) partyId = claims.partyId;
      if (claims.partySize != null) partySize = claims.partySize;
      if (claims.head != null) head = claims.head;
      if (claims.visor != null) visor = claims.visor;
      if (claims.shoulder != null) shoulder = claims.shoulder;
      if (claims.body != null) body = claims.body;
      if (claims.leg != null) leg = claims.leg;
      if (claims.hue != null) hue = claims.hue;
      if (claims.gunHue != null) gunHue = claims.gunHue;
      if (claims.bulletHue != null) bulletHue = claims.bulletHue;
      if (claims.crosshairColor != null) crosshairColor = claims.crosshairColor;
      if (claims.nameHue != null) nameHue = claims.nameHue;
      if (claims.pistol != null) pistol = claims.pistol;
      if (claims.rifle != null) rifle = claims.rifle;
      if (claims.shotgun != null) shotgun = claims.shotgun;
      if (claims.scope != null) scope = claims.scope;
      if (claims.crosshair != null) crosshair = claims.crosshair;
      ownedAbilities = claims.ownedAbilities ?? [];
      if (Array.isArray(claims.skillLoadout)) {
        skillLoadout = claims.skillLoadout;
      }
      xp = claims.xp;
      mmsRankId = claims.mmsRankId;
      founderBadge = claims.founderBadge;
      synthetic = claims.synthetic === true;
    } else if (
      token != null && token !== "" &&
      Object.keys(this.authorityTokenPublicKeys).length > 0
    ) {
      // Open official: account join for open match/win + kill/door XP.
      // When OPEN_ASSIGNMENT_REQUIRED, the token must carry placement claims.
      const claims = await verifyRankedJoinToken(
        token,
        this.authorityTokenPublicKeys,
        this.rankedServerId,
        { requireOpenAssignment },
      );
      if (!claims) {
        return {
          ok: false,
          error: requireOpenAssignment
            ? JoinErrors.AssignmentRequired
            : JoinErrors.AuthInvalid,
        };
      }
      name = claims.username;
      accountUserId = claims.sub;
      if (claims.partyId) partyId = claims.partyId;
      if (claims.partySize != null) partySize = claims.partySize;
      const tokenIsRaid = claims.matchKind === "raid" ||
        claims.modeId === "raid";
      if (tokenIsRaid !== this.isRaidRuntime()) {
        return { ok: false, error: JoinErrors.AuthInvalid };
      }
      if (tokenIsRaid) {
        if (this.raidPartyTimedOut(claims.partyId)) {
          return { ok: false, error: JoinErrors.AssignmentInvalid };
        }
        if (
          this.raidJoinConflict({
            team: claims.team,
            raidId: claims.raidId,
          })
        ) {
          return { ok: false, error: JoinErrors.AuthInvalid };
        }
        this.activateRaidFromJoin({
          team: claims.team,
          raidId: claims.raidId,
          partySize: claims.partySize,
          soloRaid: claims.soloRaid,
        });
      }
      if (claims.assignmentId) assignmentId = claims.assignmentId;
      if (claims.jti) {
        admissionJti = claims.jti;
        admissionExp = claims.exp;
      }
      if (claims.head != null) head = claims.head;
      if (claims.visor != null) visor = claims.visor;
      if (claims.shoulder != null) shoulder = claims.shoulder;
      if (claims.body != null) body = claims.body;
      if (claims.leg != null) leg = claims.leg;
      if (claims.hue != null) hue = claims.hue;
      if (claims.gunHue != null) gunHue = claims.gunHue;
      if (claims.bulletHue != null) bulletHue = claims.bulletHue;
      if (claims.crosshairColor != null) crosshairColor = claims.crosshairColor;
      if (claims.nameHue != null) nameHue = claims.nameHue;
      if (claims.pistol != null) pistol = claims.pistol;
      if (claims.rifle != null) rifle = claims.rifle;
      if (claims.shotgun != null) shotgun = claims.shotgun;
      if (claims.scope != null) scope = claims.scope;
      if (claims.crosshair != null) crosshair = claims.crosshair;
      ownedAbilities = claims.ownedAbilities ?? [];
      if (Array.isArray(claims.skillLoadout)) {
        skillLoadout = claims.skillLoadout;
      }
      xp = claims.xp;
      mmsRankId = claims.mmsRankId;
      founderBadge = claims.founderBadge;
      synthetic = claims.synthetic === true;
    } else {
      if (this.openOfficial) {
        // Official runtimes only admit authority-issued account/reservation
        // join tokens; a bare name is never enough.
        return {
          ok: false,
          error: requireOpenAssignment
            ? JoinErrors.AssignmentRequired
            : JoinErrors.AuthRequired,
        };
      } else {
        // Community: guest name only (no authority dependency).
        const checked = checkPlayerName(auth.name);
        if (!checked.ok) {
          if (checked.reason === "required") {
            return { ok: false, error: JoinErrors.NameRequired };
          }
          if (checked.reason === "profanity") {
            return { ok: false, error: JoinErrors.NameNotAllowed };
          }
          return { ok: false, error: JoinErrors.NameInvalid };
        }
        name = checked.name;
      }
      // Community name joins own no special abilities.
      ownedAbilities = [];
    }

    // Open assignment-bearing admissions: single-use jti with same-subject reclaim.
    let admissionConsume: "accepted" | "reclaim" | null = null;
    if (admissionJti && admissionExp != null && name) {
      const subject = openAdmissionSubjectKey({ accountUserId, name });
      const consume = consumeOpenAdmissionJti(
        admissionJti,
        admissionExp,
        subject,
      );
      if (consume === "replay") {
        return { ok: false, error: JoinErrors.AdmissionReplay };
      }
      admissionConsume = consume;
    } else if (requireOpenAssignment && this.openOfficial) {
      return { ok: false, error: JoinErrors.AssignmentRequired };
    }

    // Party claim cannot exceed this runtime's supported max (human capacity
    // and absolute claim ceiling). Authority config is validated the same way.
    const supportedParty = this.players.maxPartySize(this.maxPlayers);
    if (partySize != null && partySize > supportedParty) {
      return { ok: false, error: JoinErrors.AssignmentInvalid };
    }

    // Same user already in this match (live socket or connection-issue grace):
    // reclaim / take over their slot instead of NameTaken or a second body.
    const sessionConflict = this.players.findSessionConflict(
      name,
      accountUserId,
    );
    if (sessionConflict) {
      // Reconnect must not re-ack member_connected (would double-count seats).
      // Allowed even while draining so a live match can finish scale-in safely.
      return {
        ok: true,
        name,
        reclaimPlayerId: sessionConflict.id,
        accountUserId,
        partyId,
        partySize,
        assignmentId,
        head,
        visor,
        shoulder,
        body,
        leg,
        hue,
        gunHue,
        bulletHue,
        crosshairColor,
        nameHue,
        pistol,
        rifle,
        shotgun,
        scope,
        crosshair,
        ownedAbilities,
        skillLoadout,
        xp,
        mmsRankId,
        founderBadge,
        synthetic,
      };
    }

    // Scale-in drain or a coordinated release: refuse new admissions
    // (reconnect reclaim above still allowed).
    if (admissionLocked(isRuntimeDraining(), this.releaseLocked)) {
      if (assignmentId) {
        this.reportOpenReservationAck({
          reservationId: assignmentId,
          status: "server_full",
          jti: admissionJti,
        });
      }
      return { ok: false, error: JoinErrors.ServerDraining };
    }

    if (this.players.isNameTaken(name)) {
      return { ok: false, error: JoinErrors.NameTaken };
    }

    // Bots can be evicted to make room for humans (after name validation).
    // Prefer the team the human will join so we do not unbalance the other side.
    // Pre-evict for the remaining reserved party size when known (S9-PR3).
    // Grey agents do not consume join capacity.
    const admissionNowMs = Date.now();
    const preferredTeam = this.players.pickTeamForJoin({
      partyId,
      partySize,
      nowMs: admissionNowMs,
    });
    const seatsNeeded = this.remainingPartySeats({ partyId, partySize });
    // Pre-evict for remaining party seats before the socket is accepted.
    // Admission-wave accounting starts when the human is seated (connect path)
    // so a denied auth cannot leave a dangling batch open.
    const seatFree = this.ensureHumanJoinSlots(seatsNeeded, preferredTeam);
    if (!seatFree.ok) {
      if (assignmentId) {
        this.reportOpenReservationAck({
          reservationId: assignmentId,
          status: "server_full",
          jti: admissionJti,
        });
      }
      return { ok: false, error: JoinErrors.ServerFull };
    }

    // First successful seat only — reconnect reclaim skips this path via jti.
    if (
      assignmentId && admissionJti && admissionConsume === "accepted"
    ) {
      this.reportOpenReservationAck({
        reservationId: assignmentId,
        status: "member_connected",
        jti: admissionJti,
      });
    }

    return {
      ok: true,
      name,
      accountUserId,
      partyId,
      partySize,
      assignmentId,
      botsEvictedForJoin: seatFree.evicted,
      head,
      visor,
      shoulder,
      body,
      leg,
      hue,
      gunHue,
      bulletHue,
      crosshairColor,
      nameHue,
      pistol,
      rifle,
      shotgun,
      scope,
      crosshair,
      ownedAbilities,
      skillLoadout,
      xp,
      mmsRankId,
      founderBadge,
      synthetic,
    };
  }

  /**
   * Best-effort reservation progress to authority. Never blocks admission;
   * seat holds already live in authority reservations.
   */
  private reportOpenReservationAck(input: {
    reservationId: string;
    status: "member_connected" | "completed" | "released" | "server_full";
    jti?: string;
  }): void {
    if (!this.authority.reportOpenReservationAck || !this.authority.enabled) {
      return;
    }
    const body = {
      hostId: Deno.env.get("DOORS_HOST_ID")?.trim() || "local",
      runtimeId: this.rankedServerId,
      serverId: this.rankedServerId,
      reservationId: input.reservationId,
      status: input.status,
      ...(input.jti ? { jti: input.jti } : {}),
    };
    void this.authority.reportOpenReservationAck(body).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[server] open reservation ack failed reservation=${input.reservationId} ` +
          `status=${input.status}: ${message}`,
      );
    });
  }

  public getJoinMode(): ServerJoinMode {
    return this.joinMode;
  }

  /** True when a community join password is enforced. Never returns the secret. */
  public hasJoinPassword(): boolean {
    return this.joinPassword != null;
  }

  public isRanked(): boolean {
    return this.joinMode === "ranked";
  }

  private registerEvents() {
    // Validate display name (open) or ranked join token before the session is
    // fully accepted so a taken name never occupies a player slot.
    // Same-user reclaim / session replace reuses an existing roster slot.
    this.sessions!.authenticate(async (auth) => {
      try {
        const result = await this.authenticateJoin(auth);
        if (!result.ok) return result;
        const data: Partial<SessionData> = { playerName: result.name };
        if (result.spectator) data.isSpectator = true;
        if (result.reclaimPlayerId) data.reclaimPlayerId = result.reclaimPlayerId;
        if (result.accountUserId) data.accountUserId = result.accountUserId;
        if (result.partyId) data.partyId = result.partyId;
        if (result.partySize != null) data.partySize = result.partySize;
        if (result.assignmentId) data.assignmentId = result.assignmentId;
        if (
          result.botsEvictedForJoin != null && result.botsEvictedForJoin > 0
        ) {
          data.botsEvictedForJoin = result.botsEvictedForJoin;
        }
        if (result.head != null) data.head = result.head;
        if (result.visor != null) data.visor = result.visor;
        if (result.shoulder != null) data.shoulder = result.shoulder;
        if (result.body != null) data.body = result.body;
        if (result.leg != null) data.leg = result.leg;
        if (result.hue != null) data.hue = result.hue;
        if (result.gunHue != null) data.gunHue = result.gunHue;
        if (result.bulletHue != null) data.bulletHue = result.bulletHue;
        if (result.crosshairColor != null) {
          data.crosshairColor = result.crosshairColor;
        }
        if (result.nameHue != null) data.nameHue = result.nameHue;
        if (result.pistol != null) data.pistol = result.pistol;
        if (result.rifle != null) data.rifle = result.rifle;
        if (result.shotgun != null) data.shotgun = result.shotgun;
        if (result.scope != null) data.scope = result.scope;
        if (result.crosshair != null) data.crosshair = result.crosshair;
        if (Array.isArray(result.ownedAbilities)) {
          data.ownedAbilities = result.ownedAbilities;
        }
        if (Array.isArray(result.skillLoadout)) {
          data.skillLoadout = result.skillLoadout;
        }
        if (result.xp != null) data.xp = result.xp;
        if (result.mmsRankId) data.mmsRankId = result.mmsRankId;
        if (result.founderBadge) data.founderBadge = true;
        if (result.synthetic) data.synthetic = true;
        return { ok: true, data };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[server] join auth error: ${message}`);
        return { ok: false, error: JoinErrors.AuthInvalid };
      }
    });

    this.sessions!.onConnect((session) => {
      // Admin spectator: full match stream, no roster body / no combat inputs.
      if (session.data.isSpectator) {
        console.log(
          `[server] spectator connected socket=${session.id}` +
            ` user=${
              typeof session.data.accountUserId === "string"
                ? session.data.accountUserId
                : "?"
            }`,
        );
        session.emit(NetEvents.Welcome, this.welcomePayloadSpectator(session.id));
        session.on(NetEvents.Ready, () => {
          session.emit(
            NetEvents.Welcome,
            this.welcomePayloadSpectator(session.id),
          );
          session.emit(
            NetEvents.Snapshot,
            this.stampSnapshot(
              this.ensureClientNetMirror(session.id),
              this.players.createSnapshot(this.loop.tickCount, "full"),
              "catchup",
            ),
          );
        });
        session.on(NetEvents.Leave, () => {
          session.data.intentionalLeave = true;
          session.disconnect();
        });
        session.on(NetEvents.Pong, (raw: unknown) => {
          // Spectators are not on the roster — ignore latency samples.
          void raw;
        });
        session.on(NetEvents.RequestPoseHeartbeat, () => {
          if (!this.loop) return;
          const tick = this.loop.tickCount;
          const mirror = this.ensureClientNetMirror(session.id);
          if (
            !shouldSendReliablePose({
              tick,
              transportWritable: true,
              clientRequested: true,
              lastReliablePoseTick: mirror.lastReliablePoseTick,
            })
          ) {
            return;
          }
          session.emit(
            NetEvents.Snapshot,
            this.stampSnapshot(
              mirror,
              this.players.createSnapshot(tick, "motion"),
              "heartbeat",
            ),
          );
          mirror.lastReliablePoseTick = tick;
          mirror.reliableHeartbeats += 1;
          mirror.clientRequested += 1;
        });
        session.on(NetEvents.Disconnect, () => {
          this.inputRate.forget(session.id);
          this.clientNetMirrors.delete(session.id);
          console.log(`[server] spectator disconnected socket=${session.id}`);
        });
        return;
      }

      const name = String(session.data.playerName ?? "");
      if (!name) {
        session.disconnect();
        return;
      }
      // One transport-boundary timestamp is shared by reconnect, admission,
      // and non-simulation participation metadata for this connection.
      const connectionNowMs = Date.now();

      const reclaimId = typeof session.data.reclaimPlayerId === "string"
        ? session.data.reclaimPlayerId
        : null;

      let player: Player | null = null;
      let reclaimed = false;
      let respawnedOnReclaim = false;

      const equipment = typeof session.data.head === "number" ||
          typeof session.data.visor === "number" ||
          typeof session.data.shoulder === "number" ||
          typeof session.data.body === "number" ||
          typeof session.data.leg === "number" ||
          typeof session.data.hue === "number" ||
          typeof session.data.gunHue === "number" ||
          typeof session.data.bulletHue === "number" ||
          typeof session.data.crosshairColor === "number" ||
          typeof session.data.nameHue === "number" ||
          typeof session.data.pistol === "number" ||
          typeof session.data.rifle === "number" ||
          typeof session.data.shotgun === "number" ||
          typeof session.data.scope === "number" ||
          typeof session.data.crosshair === "number"
        ? {
          head: typeof session.data.head === "number" ? session.data.head : 0,
          visor: typeof session.data.visor === "number" ? session.data.visor : 0,
          shoulder: typeof session.data.shoulder === "number"
            ? session.data.shoulder
            : 0,
          body: typeof session.data.body === "number" ? session.data.body : 0,
          leg: typeof session.data.leg === "number" ? session.data.leg : 0,
          hue: typeof session.data.hue === "number" ? session.data.hue : 0,
          gunHue: typeof session.data.gunHue === "number"
            ? session.data.gunHue
            : 0,
          bulletHue: typeof session.data.bulletHue === "number"
            ? session.data.bulletHue
            : 0,
          crosshairColor: typeof session.data.crosshairColor === "number"
            ? session.data.crosshairColor
            : -1,
          nameHue: typeof session.data.nameHue === "number"
            ? session.data.nameHue
            : 0,
          pistol: typeof session.data.pistol === "number"
            ? session.data.pistol
            : 0,
          rifle: typeof session.data.rifle === "number" ? session.data.rifle : 0,
          shotgun: typeof session.data.shotgun === "number"
            ? session.data.shotgun
            : 0,
          scope: typeof session.data.scope === "number" ? session.data.scope : 0,
          crosshair: typeof session.data.crosshair === "number"
            ? session.data.crosshair
            : 0,
        }
        : null;

      if (reclaimId) {
        // Kick any still-connected prior tab/device for this player first so
        // disconnect does not re-enter connection-issue grace after rebind.
        this.displaceExistingSession(reclaimId);
        const restored = this.players.takeOverConnection(
          reclaimId,
          session.id,
          this.loop.tickCount,
          connectionNowMs,
        );
        if (restored) {
          player = restored.player;
          reclaimed = true;
          respawnedOnReclaim = restored.respawned;
          if (equipment) player.setEquipment(equipment);
          if (Array.isArray(session.data.ownedAbilities)) {
            player.setOwnedAbilities(session.data.ownedAbilities);
          }
          if (Array.isArray(session.data.skillLoadout)) {
            player.setSkillLoadout(session.data.skillLoadout);
          }
          player.setProgression(
            session.data.xp,
            session.data.mmsRankId,
            session.data.founderBadge,
          );
        }
      }

      if (!player) {
        // Fresh join (or takeover raced past a permanent drop).
        // Last-ditch: same user still on roster → displace + take over.
        const lateConflict = this.players.findSessionConflict(
          name,
          typeof session.data.accountUserId === "string"
            ? session.data.accountUserId
            : null,
        );
        if (lateConflict) {
          this.displaceExistingSession(lateConflict.id);
          const restored = this.players.takeOverConnection(
            lateConflict.id,
            session.id,
            this.loop.tickCount,
            connectionNowMs,
          );
          if (restored) {
            player = restored.player;
            reclaimed = true;
            respawnedOnReclaim = restored.respawned;
            if (equipment) player.setEquipment(equipment);
            if (Array.isArray(session.data.ownedAbilities)) {
              player.setOwnedAbilities(session.data.ownedAbilities);
            }
            if (Array.isArray(session.data.skillLoadout)) {
              player.setSkillLoadout(session.data.skillLoadout);
            }
            player.setProgression(
              session.data.xp,
              session.data.mmsRankId,
              session.data.founderBadge,
            );
          }
        }
      }

      if (!player) {
        if (this.players.isNameTaken(name)) {
          session.emit("error", { message: JoinErrors.NameTaken });
          session.disconnect();
          return;
        }
        // Fewest humans → that team; party members share a locked team.
        // Recompute at connection time (roster may have changed since middleware).
        const partyId = typeof session.data.partyId === "string"
          ? session.data.partyId
          : null;
        const partySize = typeof session.data.partySize === "number"
          ? session.data.partySize
          : null;
        const assignmentId = typeof session.data.assignmentId === "string"
          ? session.data.assignmentId
          : null;
        const joinTeam = this.raid
          ? this.raid.humanTeam
          : this.players.pickTeamForJoin({
            partyId,
            partySize,
            nowMs: connectionNowMs,
          });
        // Pre-evict ordinary bots for remaining party seats when the lobby is
        // bot-filled (S9-PR3). Middleware may have already freed seats; this is
        // a last-ditch if the roster changed before connection.
        const seatsNeeded = this.remainingPartySeats({ partyId, partySize });
        const seatFree = this.ensureHumanJoinSlots(seatsNeeded, joinTeam);
        if (!seatFree.ok) {
          session.emit("error", { message: JoinErrors.ServerFull });
          session.disconnect();
          return;
        }
        const preSeatEvicted =
          (typeof session.data.botsEvictedForJoin === "number"
            ? session.data.botsEvictedForJoin
            : 0) + seatFree.evicted;
        const accountUserId = typeof session.data.accountUserId === "string"
          ? session.data.accountUserId
          : null;
        // Guests / missing token data → empty ownership (all abilities locked).
        const ownedAbilities = Array.isArray(session.data.ownedAbilities)
          ? session.data.ownedAbilities
          : [];
        player = this.players.add(session.id, name, joinTeam, {
          accountUserId,
          partyId,
          partySize,
          xp: typeof session.data.xp === "number" ? session.data.xp : 0,
          mmsRankId: session.data.mmsRankId,
          founderBadge: session.data.founderBadge === true,
          synthetic: session.data.synthetic === true,
          equipment,
          ownedAbilities,
          ...(Array.isArray(session.data.skillLoadout)
            ? { skillLoadout: session.data.skillLoadout }
            : {}),
        }, connectionNowMs);
        // Human join → bot fill. Party / assignment batches coalesce one
        // fill+balance reconcile (S9-PR3); solos still snap immediately.
        this.onHumanSeatedForBots({
          partyId,
          partySize,
          assignmentId,
          botsEvicted: preSeatEvicted,
        });
        this.snapshotRaidCredit(player);
        if (this.isRaidRuntime()) {
          const raidOver = this.maybeStartRaid();
          if (raidOver) {
            this.onMatchEnded(raidOver, connectionNowMs);
            this.sessions?.emit(NetEvents.GameOver, raidOver);
          }
        }
        // Human join during pre-match clears ready votes (PlayerManager.add).
        if (this.players.isPrematch()) {
          this.broadcastPrematchState();
        } else if (this.rebalanceVotes.size > 0 || this.pendingRebalance) {
          // Threshold uses human count — re-evaluate vote progress only.
          this.syncRebalanceAfterRosterChange();
        }
      }

      if (reclaimed && this.isRaidRuntime()) {
        const raidOver = this.maybeStartRaid();
        if (raidOver) {
          this.onMatchEnded(raidOver, connectionNowMs);
          this.sessions?.emit(NetEvents.GameOver, raidOver);
        }
      }

      const welcome = this.welcomePayload(player.id)!;
      session.emit(NetEvents.Welcome, welcome);

      if (reclaimed) {
        // Other clients already know this roster id; refresh connection-issue /
        // pose after reclaim or live session takeover (no second PlayerJoined).
        this.sessions!.emit(NetEvents.PlayerConnectionRestored, {
          id: player.id,
          player: player.toSnapshot(
            this.players.tick,
            "full",
            this.players.getCollision(),
          ),
        });
        if (respawnedOnReclaim) {
          this.sessions!.emit(NetEvents.PlayerRespawned, {
            player: player.toSnapshot(
              this.players.tick,
              "full",
              this.players.getCollision(),
            ),
          });
        }
      } else {
        for (const other of this.sessions!.sessions()) {
          if (other.id === session.id) continue;
          other.emit(
            NetEvents.PlayerJoined,
            player.toSnapshot(
              this.players.tick,
              "full",
              this.players.getCollision(),
            ),
          );
        }
      }

      const playerIdFor = (): string | null => {
        return this.players.getBySocket(session.id)?.id ?? null;
      };

      session.on(NetEvents.Ready, () => {
        const id = playerIdFor();
        if (!id) return;
        const payload = this.welcomePayload(id);
        if (!payload) return;
        session.emit(NetEvents.Welcome, payload);
        // Full identity snapshot on catch-up (reconnect). High-rate stream is motion-only.
        session.emit(
          NetEvents.Snapshot,
          this.players.createSnapshot(this.loop.tickCount, "full"),
        );
      });

      // Epic 7.1: all live action intents go through `simIngress` — handlers
      // only resolve playerId and delegate (no direct queue / combat writes).
      session.on(NetEvents.Input, (raw: unknown) => {
        const id = playerIdFor();
        if (!id) return;
        // Drop flood above ~2× tick rate so a laggy client cannot stall the loop.
        ingressMovementInput(
          this.simIngressSinks(),
          this.inputRate,
          session.id,
          id,
          raw,
          this.lastSimNowMs,
        );
      });

      session.on(NetEvents.Shoot, (raw: unknown) => {
        const id = playerIdFor();
        if (!id) return;
        // Epic 4.7: defer to Weapons phase (next tick flush). Association
        // tick = the tick whose weapons phase drains this queue.
        ingressShoot(this.simIngressSinks(), id, raw);
      });

      session.on(NetEvents.Melee, (raw: unknown) => {
        const id = playerIdFor();
        if (!id) return;
        ingressMelee(this.simIngressSinks(), id, raw);
      });

      session.on(NetEvents.Reload, () => {
        const id = playerIdFor();
        if (!id) return;
        ingressReload(this.simIngressSinks(), id, this.loop.tickCount);
      });

      session.on(NetEvents.WeaponSwitch, (raw: unknown) => {
        const id = playerIdFor();
        if (!id) return;
        ingressWeaponSwitch(
          this.simIngressSinks(),
          id,
          raw,
          this.loop.tickCount,
        );
      });

      session.on(NetEvents.Ability, (raw: unknown) => {
        const id = playerIdFor();
        if (!id) return;
        // Do not share Input flood limiter — rare discrete event (like Reload).
        ingressAbility(this.simIngressSinks(), id, raw, this.loop.tickCount);
      });

      // PR-2: My Skills loadout → Ability 1–4 (owned + unique validated).
      // Config channel (not per-tick sim input); still routed via ingress.
      session.on(NetEvents.SkillLoadout, (raw: unknown) => {
        const id = playerIdFor();
        if (!id) return;
        ingressSkillLoadout(this.simIngressSinks(), id, raw);
      });

      // Latency probe reply — stamp was sent on NetEvents.Ping.
      session.on(NetEvents.Pong, (raw: unknown) => {
        const t = raw && typeof raw === "object" && "t" in raw &&
            typeof (raw as PingPacket).t === "number"
          ? (raw as PingPacket).t
          : null;
        if (t == null || !Number.isFinite(t)) return;
        const rtt = Date.now() - t;
        // Ignore stale / clock-skewed samples (probe interval is ~1s).
        if (rtt < 0 || rtt > 15_000) return;
        const p = this.players.getBySocket(session.id);
        if (!p || p.isBot) return;
        p.observeRtt(rtt);
      });

      session.on(NetEvents.MapVote, (raw: unknown) => {
        const id = playerIdFor();
        if (!id) return;
        const mapName = raw && typeof raw === "object" && "mapName" in raw
          ? String((raw as { mapName: unknown }).mapName ?? "")
          : typeof raw === "string"
          ? raw
          : "";
        const state = this.castMapVote(id, mapName);
        if (!state) return;
        this.sessions!.emit(NetEvents.MapVoteState, state);
      });

      // Admin console: authority-signed action token → execute on this server.
      session.on(NetEvents.AdminCommand, (raw: unknown) => {
        void (async () => {
          const reply = (packet: AdminCommandResultPacket) => {
            session.emit(NetEvents.AdminCommandResult, packet);
          };

          if (Object.keys(this.authorityTokenPublicKeys).length === 0) {
            reply({
              ok: false,
              error:
                "Admin commands are unavailable on this server (not an official authentic instance).",
              code: "admin_unavailable",
            });
            return;
          }

          const token = raw && typeof raw === "object" && "token" in raw
            ? (raw as { token: unknown }).token
            : typeof raw === "string"
            ? raw
            : null;

          const verified = await verifyAdminActionToken(
            token,
            this.authorityTokenPublicKeys,
            this.rankedServerId,
          );
          if (!verified.ok) {
            reply({
              ok: false,
              error: verified.error,
              code: verified.code,
            });
            return;
          }

          const accountUserId = typeof session.data.accountUserId === "string"
            ? session.data.accountUserId
            : null;
          if (!accountUserId) {
            reply({
              ok: false,
              error:
                "Join with your account (ranked / official account join) before using admin commands.",
              code: "admin_account_required",
              command: verified.claims.cmd,
              jti: verified.claims.jti,
            });
            return;
          }
          if (accountUserId !== verified.claims.sub) {
            reply({
              ok: false,
              error: "Admin token does not match the connected account.",
              code: "admin_identity_mismatch",
              command: verified.claims.cmd,
              jti: verified.claims.jti,
            });
            return;
          }

          if (
            !consumeAdminActionJti(
              verified.claims.jti,
              verified.claims.exp,
            )
          ) {
            reply({
              ok: false,
              error: "Admin token already used.",
              code: "admin_token_replay",
              command: verified.claims.cmd,
              jti: verified.claims.jti,
            });
            return;
          }

          const result = this.executeAdminCommand(verified.claims);
          console.log(
            `[server] admin cmd=${verified.claims.cmd}` +
              ` user=${verified.claims.sub}` +
              ` player=${playerIdFor() ?? "?"}` +
              ` ok=${result.ok}` +
              (result.ok ? ` msg=${result.message}` : ` err=${result.error}`),
          );
          reply(result);
          if (
            result.ok &&
            verified.claims.cmd === "track_bots" &&
            result.data &&
            typeof result.data.engaged === "boolean"
          ) {
            session.emit(NetEvents.BotHeatmapTracking, {
              engaged: result.data.engaged,
            });
          }
        })();
      });

      // Raid start gate: this client finished building the map.
      session.on(NetEvents.MapLoaded, () => {
        const id = playerIdFor();
        if (!id || !this.raid || this.raid.started) return;
        this.raidLoadedPlayerIds.add(id);
      });

      // Ranked pre-match ready vote (distinct from NetEvents.Ready re-sync).
      session.on(NetEvents.MatchReady, (raw: unknown) => {
        const id = playerIdFor();
        if (!id) return;
        let ready = true;
        if (raw && typeof raw === "object" && "ready" in raw) {
          ready = Boolean((raw as { ready: unknown }).ready);
        } else if (typeof raw === "boolean") {
          ready = raw;
        }
        this.handleMatchReady(id, ready);
      });

      // Open-match team switch (validated against balance / bot fill rules).
      session.on(NetEvents.ChangeTeam, (raw: unknown) => {
        const id = playerIdFor();
        if (!id) {
          session.emit(
            NetEvents.ChangeTeamResult,
            {
              ok: false,
              error: "Not in match.",
            } satisfies ChangeTeamResultPacket,
          );
          return;
        }
        const result = this.handleChangeTeam(id, raw);
        session.emit(NetEvents.ChangeTeamResult, result);
      });

      // Open-match vote to rebalance teams (>1/3 humans → force-swap pipeline).
      session.on(NetEvents.TeamRebalanceVote, (raw: unknown) => {
        const id = playerIdFor();
        if (!id) {
          session.emit(
            NetEvents.TeamRebalanceVoteResult,
            {
              ok: false,
              error: "Not in match.",
            } satisfies TeamRebalanceVoteResultPacket,
          );
          return;
        }
        const result = this.handleTeamRebalanceVote(id, raw);
        session.emit(NetEvents.TeamRebalanceVoteResult, result);
      });

      // Explicit leave skips the connection-issue grace period.
      session.on(NetEvents.Leave, () => {
        session.data.intentionalLeave = true;
        const id = playerIdFor();
        if (id) this.dropPlayer(id);
        session.disconnect();
      });

      // A4: client requests a reliable thin pose after snap silence.
      session.on(NetEvents.RequestPoseHeartbeat, () => {
        if (!this.loop) return;
        const tick = this.loop.tickCount;
        const mirror = this.ensureClientNetMirror(session.id);
        if (
          !shouldSendReliablePose({
            tick,
            transportWritable: true,
            clientRequested: true,
            lastReliablePoseTick: mirror.lastReliablePoseTick,
          })
        ) {
          return;
        }
        session.emit(
          NetEvents.Snapshot,
          this.stampSnapshot(
            mirror,
            this.players.createSnapshot(tick, "motion"),
            "heartbeat",
          ),
        );
        mirror.lastReliablePoseTick = tick;
        mirror.reliableHeartbeats += 1;
        mirror.clientRequested += 1;
      });

      session.on(NetEvents.Disconnect, (reason) => {
        this.inputRate.forget(session.id);
        this.clientNetMirrors.delete(session.id);
        // Already removed via Leave / kick / session replace.
        if (session.data.intentionalLeave) return;

        const player = this.players.getBySocket(session.id);
        if (!player) return;

        // Official Leave + immediate local close can lose the Leave packet.
        // A clean client disconnect() is still an intentional exit — do not
        // park the roster in connection-issue grace (status keeps counting).
        if (isClientInitiatedDisconnect(reason)) {
          this.dropPlayer(player.id);
          return;
        }

        if (this.players.markConnectionIssue(player.id, Date.now())) {
          this.sessions!.emit(NetEvents.PlayerConnectionIssue, {
            id: player.id,
            timeoutSeconds: Math.ceil(CONNECTION_ISSUE_TIMEOUT_MS / 1000),
          });
        }
      });
    });
  }

  private ensureClientNetMirror(socketId: string): ClientNetMirror {
    let m = this.clientNetMirrors.get(socketId);
    if (!m) {
      m = createClientNetMirror();
      this.clientNetMirrors.set(socketId, m);
    }
    return m;
  }

  /** Attach a per-recipient marker without mutating the shared world snapshot. */
  private stampSnapshot(
    mirror: ClientNetMirror,
    snap: ReturnType<PlayerManager["createSnapshot"]>,
    kind: "volatile" | "heartbeat" | "catchup",
  ) {
    return {
      ...snap,
      transport: {
        emitSeq: ++mirror.emitSeq,
        emitAtMs: performance.now(),
        kind,
      },
    };
  }

  /**
   * Per-client pose stream (A4 / C5).
   * - Volatile when transport is writable (latest pose only).
   * - Reliable keyframe when backed up (rate-limited) so clients do not starve.
   */
  private emitPoseStream(
    tick: number,
    snap: ReturnType<PlayerManager["createSnapshot"]>,
  ): void {
    if (!this.sessions) return;
    for (const session of this.sessions.sessions()) {
      const mirror = this.ensureClientNetMirror(session.id);
      const writable = session.isWritable();
      const wbLen = session.writeBufferLength();
      if (wbLen > mirror.peakWriteBuffer) mirror.peakWriteBuffer = wbLen;

      const kind = classifyVolatileEmit(writable);
      if (kind === "send") {
        // This is deliberately stamped per session, immediately before emit.
        // It distinguishes a host production/emit gap from a later delivery
        // or browser scheduling stall without mutating the shared `snap`.
        session.emitVolatile(
          NetEvents.Snapshot,
          this.stampSnapshot(mirror, snap, "volatile"),
        );
        mirror.volatileSent += 1;
      } else {
        mirror.volatileDrops += 1;
        mirror.lastBackedUpTick = tick;
      }

      if (
        shouldSendReliablePose({
          tick,
          transportWritable: writable,
          clientRequested: false,
          lastReliablePoseTick: mirror.lastReliablePoseTick,
        })
      ) {
        session.emit(
          NetEvents.Snapshot,
          this.stampSnapshot(mirror, snap, "heartbeat"),
        );
        mirror.lastReliablePoseTick = tick;
        mirror.reliableHeartbeats += 1;
      }
    }
  }

  /** Pack a sim shoot outcome into a wire combat packet. */
  private toCombatOutcomePacket(outcome: ShootOutcome): CombatOutcomePacket {
    return packCombatOutcomePacket(outcome, this.players);
  }

  /**
   * Broadcast one or more combat outcomes in a single CombatBurst emit.
   * Reduces Socket.IO encode/fan-out when several bots fire the same tick.
   * `packets` must be stamped at weapons time (before agent prune).
   */
  private broadcastCombatBurst(
    outcomes: readonly ShootOutcome[],
    packets?: readonly CombatOutcomePacket[],
  ): void {
    if (!this.sessions || outcomes.length === 0) return;
    const packet: CombatBurstPacket = {
      outcomes: packets
        ? [...packets]
        : outcomes.map((o) => this.toCombatOutcomePacket(o)),
    };
    this.sessions.emit(NetEvents.CombatBurst, packet);
  }

  /** Emit pinned sim events collected by `stepSim` (driver-owned transport). */
  private emitSimTickEvents(tick: number, events: readonly SimTickEvent[]): void {
    if (!this.sessions) return;
    for (const ev of events) {
      switch (ev.type) {
        case "CombatBurst":
          this.broadcastCombatBurst(ev.outcomes, ev.packets);
          break;
        case "PlayerDied":
          this.sessions.emit(NetEvents.PlayerDied, ev.death);
          break;
        case "Score":
          this.sessions.emit(NetEvents.Score, ev.score);
          break;
        case "GameOver":
          this.sessions.emit(NetEvents.GameOver, this.enrichGameOver(ev.gameOver));
          break;
        case "PlayerRespawned":
          this.sessions.emit(NetEvents.PlayerRespawned, {
            player: ev.player.toSnapshot(
              tick,
              "full",
              this.players.getCollision(),
            ),
          });
          break;
      }
    }
  }

  /** Convenience for a single human/bot shot. */
  private broadcastShootOutcome(outcome: ShootOutcome): void {
    this.broadcastCombatBurst([outcome]);
  }

  /**
   * Weapons phase: resolve queued Shoot/Melee — humans queued on packet
   * arrival, bots queued from BotApply (PR 4) — in ascending shooter id
   * before MovePhysics. Packets associate to this tick.
   */
  /**
   * Epic 7.1 — sinks for the singular transport→sim ingress seam.
   * Session handlers must only resolve playerId then call `ingress*` helpers.
   */
  private simIngressSinks(): SimIngressSinks {
    return {
      handleInput: (playerId, input, nowMs) =>
        this.players.handleInput(playerId, input, nowMs),
      enqueueHumanWeapon: (req) => this.pendingWeapons.push(req),
      handleReload: (playerId, tick) =>
        this.players.handleReload(playerId, tick),
      handleWeaponSwitch: (playerId, weapon, tick) =>
        this.players.handleWeaponSwitch(playerId, weapon, tick),
      handleAbility: (playerId, ability, tick) =>
        this.players.handleAbility(playerId, ability, tick),
      handleSkillLoadout: (playerId, slots) =>
        this.players.handleSkillLoadout(playerId, slots),
      volDropPctFor: (playerId) => {
        const p = this.players.get(playerId);
        if (!p?.socketId) return undefined;
        return this.clientNetMirrors.get(p.socketId)?.recentVolDropPct;
      },
    };
  }

  /**
   * Thin wrapper over the shared `flushPendingWeapons` (weaponsQueue.ts):
   * gates bot heatmap facts on `heatmaps.botTrackingEngaged` (humans are
   * always recorded), matching pre-PR-4 behavior now that both flow through
   * one queue.
   */
  private flushPendingWeapons(
    tick: number,
    nowMs: number,
  ): { outcomes: ShootOutcome[]; shootHeatmap: { playerId: string; doorsOpen: boolean }[] } {
    if (this.pendingWeapons.length === 0) {
      return { outcomes: [], shootHeatmap: [] };
    }
    const pending = this.pendingWeapons;
    this.pendingWeapons = [];
    return flushWeaponsQueue(
      pending,
      this.players,
      tick,
      nowMs,
      (shooterId) => {
        const shooter = this.players.get(shooterId);
        return !shooter?.isBot || this.heatmaps.botTrackingEngaged;
      },
    );
  }

  /**
   * Authoritative tick driver (epic 4.7 order + 4.8 isolation).
   *
   * SIM vs adapter boundary: `players/DETERMINISTIC_SIMULATION_ISOLATION.md`.
   * Phase ids: `players/simTickPhases.ts` + `DETERMINISTIC_SYSTEM_ORDERING.md`.
   *
   * SIM (step, Chunk 1+): RaidEncounter → … → Respawn (+ MIXED roster removals).
   * Returns in-memory events; must not call sessions/heatmaps/DOM or read wall-clock/RNG.
   *
   * Adapters (driver): sessions.emit, heatmaps, phaseTiming, participation, pose/ping,
   * AFK kick/rebalance timers, BotThink. Forbid list for SIM modules is in the isolation contract.
   *
   * Canonical order: BotApply → Weapons → MovePhysics → … → Respawn → emit → BotThink.
   * Phase brackets feed /api/status tickTiming.phases. Bot order: apply → sim/emit → think.
   */
  /**
   * Advance one authoritative sim tick and collect wire events (epic 4.8 / 7.1).
   * Does not emit on `sessions` for CombatBurst/PlayerDied/Score/GameOver/
   * PlayerRespawned or connection-timeout PlayerLeft/MapVoteState — the driver
   * calls `emitSimTickEvents` then emits `rosterLeaves` after.
   *
   * NON-SIM participation / heatmap.tick / recordShoot / timing live in the
   * driver after this returns. Shoot heatmap facts use weapons-time doorsOpen.
   * Snapshots (`toSnapshot` / `createSnapshot`) are egress serialization only
   * — never called here as state advancement.
   */
  private stepSim(tick: number, nowMs: number): SimTickResult {
    this.inStepSim = true;
    try {
      return this.stepSimBody(tick, nowMs);
    } finally {
      this.inStepSim = false;
    }
  }

  private stepSimBody(tick: number, nowMs: number): SimTickResult {
    const events: SimTickEvent[] = [];
    const shootHeatmap: { playerId: string; doorsOpen: boolean }[] = [];
    const heatmapDepartures: Player[] = [];
    const rosterLeaves: { playerId: string; hadMapVote: boolean }[] = [];

    // --- SIM: RaidEncounter ---
    this.tickRaidAgentEncounter(tick);

    // --- SIM: BotChurn --- authentic open: occasional bot leave/join (target ±1).
    this.bots.tickChurn(this.maxPlayers, nowMs);

    const collision = this.players.getCollision();
    // --- SIM: BotHousekeeping --- agent door-drops + seed pings; intermission freeze.
    this.bots.tickHousekeeping(tick, collision);

    // --- SIM: BotApply --- ReadyActions from THINK_BUFFER_BOT_TICKS earlier (not this tick's AI).
    // Shot intents enqueue into the shared Weapons queue (PR 4) instead of
    // resolving here; input/weaponSwitch/reload/ability still apply inline.
    this.bots.applyReadyActions(tick, nowMs, (req) => this.pendingWeapons.push(req));

    // --- SIM: Weapons --- deferred Shoot/Melee, bots + humans (pre-move, ascending id).
    const weapons = this.flushPendingWeapons(tick, nowMs);
    if (weapons.outcomes.length > 0) {
      // Stamp kill-feed names now — pruneDeadAgents drops grey agents next.
      events.push({
        type: "CombatBurst",
        outcomes: weapons.outcomes,
        packets: weapons.outcomes.map((o) => this.toCombatOutcomePacket(o)),
      });
    }
    for (const fact of weapons.shootHeatmap) shootHeatmap.push(fact);

    // --- SIM: PruneDeadAgents (post-weapons) ---
    this.pruneDeadAgents(tick);

    // --- SIM: MovePhysics + OverlapDeath ---
    const overlapDeaths = this.players.update(tick, nowMs);
    for (const death of overlapDeaths) {
      events.push({ type: "PlayerDied", death });
    }
    if (overlapDeaths.length > 0) {
      this.pruneDeadAgents(tick);
    }

    // --- MIXED: ConnectionAfkRebalance ---
    const wasPrematch = this.players.isPrematch();
    const expired = this.players.getConnectionIssueExpired(nowMs);
    for (const p of expired) {
      heatmapDepartures.push(p);
      if (!p.isBot) this.handleHumanAbandon(p);
    }
    const timedOut = this.players.processConnectionIssueTimeouts(nowMs);
    let humansLeft = false;
    for (const id of timedOut) {
      const hadVote = this.mapVotes.delete(id);
      // Epic 7.1: collect leave facts; driver emits PlayerLeft / MapVoteState.
      rosterLeaves.push({ playerId: id, hadMapVote: hadVote });
      humansLeft = true;
    }
    if (humansLeft) {
      if (
        this.pendingRebalance &&
        this.pendingRebalance.playerIds.some((id) => timedOut.includes(id))
      ) {
        this.pendingRebalance = null;
      }
      for (const id of timedOut) this.rebalanceVotes.delete(id);
      if (this.maybeResetEmptyRankedInstance()) {
        // Reset handled bots + match state.
      } else {
        this.bots.onHumanLeft(this.maxPlayers);
        if (wasPrematch) {
          this.broadcastPrematchState();
        } else {
          this.syncRebalanceAfterRosterChange();
        }
      }
    }

    if (!this.players.isMatchOver()) {
      const afkKickNow = nowMs;
      const raidLive = Boolean(
        this.raid?.started && !this.raid.ended,
      );
      const raidTickMs = 1000 / TICK_HZ;
      for (const p of this.players.humans()) {
        if (
          raidLive &&
          p.alive &&
          !p.connectionIssue &&
          p.isAfk(afkKickNow)
        ) {
          p.raidAfkAccumMs += raidTickMs;
          if (p.raidAfkAccumMs >= RAID_AFK_MAX_MS) {
            this.kickPlayerForAfk(p);
            continue;
          }
        }
        if (this.raid && !p.alive) continue;
        if (p.shouldKickForAfk(afkKickNow)) {
          this.kickPlayerForAfk(p);
        }
      }
    }

    this.tickPendingRebalance(nowMs);

    // --- SIM: ScoresRules ---
    const scores = this.players.processScores(tick);
    for (const score of scores) {
      events.push({ type: "Score", score });
    }

    // --- SIM: MatchEnd --- (epic 7.2 lifecycle)
    // Pure transitions live on PlayerManager (checkMatchEnd / checkMatchTimeLimit /
    // forceEndMatch → endMatch). Driver side effects stay here: onMatchEnded
    // (reports/heatmaps/lobby) + GameOver facts for emitSimTickEvents.
    if (scores.length > 0) {
      const raidOver = this.handleRaidScores(scores);
      const gameOver = raidOver ?? this.players.checkMatchEnd(tick);
      if (gameOver) {
        this.onMatchEnded(gameOver, nowMs);
        events.push({ type: "GameOver", gameOver });
      }
    }

    if (!this.players.isMatchOver()) {
      const raidFail = this.handleRaidFailConditions();
      if (raidFail) {
        this.onMatchEnded(raidFail, nowMs);
        events.push({ type: "GameOver", gameOver: raidFail });
        if (
          this.raid?.failReason === "empty" &&
          this.players.humanCount() === 0
        ) {
          this.resetIdleRaidRuntime();
        }
      }
    }

    if (!this.players.isMatchOver() && !this.raid) {
      const timeUp = this.players.checkMatchTimeLimit(tick);
      if (timeUp) {
        this.onMatchEnded(timeUp, nowMs);
        events.push({ type: "GameOver", gameOver: timeUp });
      }
    }

    // --- SIM: Intermission --- (epic 7.2 lifecycle)
    // Gate is PlayerManager.isRestartDue; driver finishIntermission owns raid
    // close / release-drain hold / map-vote MapChange / same-map start +
    // beginRuntimeMatchIdentity + MatchStart/Snapshot emits.
    if (this.players.isRestartDue(tick)) {
      this.finishIntermission(tick, nowMs);
    }

    // --- SIM: Respawn ---
    const respawned = this.players.processRespawns(tick);
    for (const player of respawned) {
      events.push({ type: "PlayerRespawned", player });
    }

    return { events, shootHeatmap, heatmapDepartures, rosterLeaves };
  }

  private startGameLoop() {
    this.loop = new GameLoop((tick) => {
      const nowMs = Date.now();
      this.lastSimNowMs = nowMs;
      // Epic 4.7 phases + 4.8 isolation — see DETERMINISTIC_SIMULATION_ISOLATION.md.
      // Driver shape: stepSim → NON-SIM adapters → emit → pose/ping → BotThink → timing.
      const t0 = performance.now();

      const result = this.stepSim(tick, nowMs);
      const tStep = performance.now();

      // --- NON-SIM: Heatmap shoot/departure facts from the step ---
      for (const fact of result.shootHeatmap) {
        const shooter = this.players.get(fact.playerId);
        if (shooter) this.heatmaps.recordShoot(shooter, fact.doorsOpen);
      }
      for (const p of result.heatmapDepartures) {
        this.heatmaps.recordPlayerDeparture(p);
      }

      // --- NON-SIM: Participation ---
      // After the full step (was mid-tick before MIXED). Must not feed sim resolution.
      this.players.sampleParticipation(nowMs);

      // --- NON-SIM: Heatmaps --- spatial sample (humans always; bots when admin engaged).
      this.heatmaps.tick(
        this.players.all(),
        this.players.getMatchPhase(),
        tick,
        this.players.areDoorsOpen(tick),
      );
      const tHeatmap = performance.now();

      // Epic 7.3: unified per-tick authoritative event drain (read-only to live).
      // Drains 5.5 buffer + maps SimTickResult facts; live path does not consume
      // the list. Epic 7.5 fans the drain output to the attached sink (if any)
      // alongside emitSimTickEvents — never rebuild from emit order.
      const authEvents = drainTickAuthoritativeEvents(
        this.players,
        tick,
        result.events,
      );
      // Epic 7.5 fan-out: no-sink fast path skips inputs-map construction.
      this.deliverReplayIntegrationTick(tick, authEvents);

      // Epic 9.2: post-drain matchEnd/Draw notify (final checkpoint + finalize).
      this.flushPendingReplayMatchEnd(tick);

      this.emitSimTickEvents(tick, result.events);

      // --- NON-SIM: Roster leaves (epic 7.1) — was in-step MIXED emit ---
      // Order matches construction in stepSim's connection-timeout loop.
      if (this.sessions && result.rosterLeaves.length > 0) {
        for (const leave of result.rosterLeaves) {
          this.sessions.emit(NetEvents.PlayerLeft, { id: leave.playerId });
          if (leave.hadMapVote && this.mapVotingOpen) {
            this.sessions.emit(NetEvents.MapVoteState, this.getMapVoteState());
          }
        }
      }

      // --- NON-SIM: PoseSnapshot ---
      if (tick % SNAPSHOT_EVERY_TICKS === 0) {
        const snap = this.players.createSnapshot(tick);
        this.emitPoseStream(tick, snap);
      }

      // --- NON-SIM: Ping ---
      if (tick % TICK_HZ === 0) {
        const timing = this.loop?.timing.snapshot();
        const hostMirror = summarizeNetMirrors(this.clientNetMirrors.values());
        const base: PingPacket = { t: Date.now() };
        if (timing && timing.samples1s > 0) {
          base.srv = {
            hz: timing.tickHz,
            avg: Math.round(timing.avgLoad * 10000) / 10000,
            peak: Math.round(timing.peakLoad * 10000) / 10000,
            budgetMs: Math.round(timing.budgetMs * 100) / 100,
          };
        }
        const hRwClamp = this.players.rewindClampTotal;
        for (const session of this.sessions!.sessions()) {
          const m = this.clientNetMirrors.get(session.id);
          if (m) noteMirrorPingInterval(m);
          const p = this.players.getBySocket(session.id);
          const packet: PingPacket = {
            t: base.t,
            srv: base.srv,
            net: {
              vSent: m?.volatileSent ?? 0,
              vDrop: m?.volatileDrops ?? 0,
              hb: m?.reliableHeartbeats ?? 0,
              peakWb: m?.peakWriteBuffer ?? 0,
              hSent: hostMirror.volatileSent,
              hDrop: hostMirror.volatileDrops,
              hPeakWb: hostMirror.peakWriteBuffer,
              hDropClients: hostMirror.clientsWithDrops,
              rwClamp: p?.rewindClampCount ?? 0,
              rwFwd: p?.rewindClampForward ?? 0,
              rwBack: p?.rewindClampBack ?? 0,
              hRwClamp,
            },
          };
          session.emit(NetEvents.Ping, packet);
        }
      }
      const tEmit = performance.now();

      // --- NON-SIM: BotThink --- after sim/emit; AI off critical path.
      const collision = this.players.getCollision();
      this.bots.thinkAll(tick, collision);
      const tBotsThink = performance.now();

      // Timing: stepSim is one bucket (apply+move+mixed+scores). Think stays in bots.
      // Former mid-step heatmap/scores splits folded into sim / heatmap adapters.
      this.phaseTiming.record({
        bots: tBotsThink - tEmit,
        sim: tStep - t0,
        heatmap: tHeatmap - tStep,
        scores: 0,
        emit: tEmit - tHeatmap,
      });
    });
    this.loop.start();
  }

  /**
   * End of intermission: apply winning map vote (if any) and start a new match.
   * Ranked → pre-match warm-up again; open/community → live immediately.
   */
  private finishIntermission(tick: number, nowMs: number): void {
    if (this.isRaidRuntime()) {
      this.closeEndedRaidSession();
      return;
    }
    if (shouldHoldMatchRestart(this.releaseLocked)) {
      console.log(
        "[server] release drain — returning players to menu, not starting next match",
      );
      this.returnHumansToMenuAfterDrain();
      return;
    }
    // Allow the next match to report independently.
    this.lastReportedMatchKey = null;
    this.lastHeatmapReportKey = null;
    // New match session — clear heatmap buffers; bot tracking flag is sticky.
    this.heatmaps.resetForNewMatch();
    const winner = this.resolveMapVoteWinner();
    this.clearMapVotes();

    // Grey agents are match-scoped; drop them before roster respawn.
    this.bots.clearAgents();

    const switchTo = winner &&
        (winner.path !== this.mapPath || winner.name !== this.map.name)
      ? winner
      : null;

    if (switchTo) {
      // Intermission map change is not a draw — start fresh on the voted map.
      this.map = switchTo.map;
      this.mapPath = switchTo.path;
      this.players.setCollision(switchTo.collision);
      const matchStart = this.players.startNewMatch(tick, nowMs);
      this.beginRuntimeMatchIdentity(tick);
      // Map-vote switch skips emitMatchStart — still notify when live.
      this.notifyReplayMatchStart(tick);
      const packet: MapChangePacket = {
        map: this.map,
        scores: matchStart.scores,
        players: matchStart.players,
        doorsOpen: matchStart.doorsOpen,
        doorChangeTick: matchStart.doorChangeTick,
        matchEndTick: matchStart.matchEndTick,
        endedAsDraw: false,
      };
      this.hostChannel?.send({ type: "map-changed", map: this.map.name });
      this.sessions!.emit(NetEvents.MapChange, packet);
      this.sessions!.emit(NetEvents.Snapshot, this.players.createSnapshot(tick));
      if (this.players.isPrematchEnabled()) {
        this.broadcastPrematchState();
      }
      return;
    }

    const matchStart = this.players.startNewMatch(tick, nowMs);
    this.beginRuntimeMatchIdentity(tick);
    this.emitMatchStart(matchStart, tick);
  }

  /**
   * Epic 7.2 — rotate the recorder match key for a new match session.
   * Epic 7.4 reads `runtimeMatchId` only from here — never generates a fallback.
   * Epic 7.5 — also fans out `runtimeMatchIdRotated` + `onMatchInit` when a
   * sink is attached (zero work when detached).
   * Call sites (must stay exhaustive): changeMap, handleMatchReady,
   * activateRaidFromJoin, finishIntermission (map-vote + same-map).
   * Empty-ranked reset and raid idle reset deliberately do NOT rotate.
   */
  private beginRuntimeMatchIdentity(tick: number = this.players.tick): void {
    // Epic 8.1: re-attach after finalize detach so rotation/init notifies land.
    this.replayRecorder?.ensureAttached();
    const previousRuntimeMatchId = this.runtimeMatchId;
    this.runtimeMatchId = crypto.randomUUID();
    this.heatmapBatchId = crypto.randomUUID();
    this.lastReportedMatchKey = null;
    this.lastHeatmapReportKey = null;
    // Skip bot-only and all-synthetic matches. Sticky once a real human
    // has been present. There is no per-account replay library; not opening
    // a row is what keeps a synthetic flood off disk.
    this.replayMatchHadHuman = this.hasRecordableHuman();
    if (!this.replayMatchHadHuman) {
      // Close any prior human-match row without opening a bot-only recording.
      this.replayRecorder?.discardActiveWithoutRecording();
      return;
    }
    this.notifyReplayIdentityRotated(tick, previousRuntimeMatchId);
    this.notifyReplayMatchInit(tick);
  }

  /**
   * Temp/dev: arm recording when the first human seats in a previously
   * bot-only match. Starts from this tick onward (no backfill).
   */
  /** True when a non-synthetic human is on the roster. */
  private hasRecordableHuman(): boolean {
    for (const player of this.players.all()) {
      if (player.isBot || player.isAgent) continue;
      if (!player.synthetic) return true;
    }
    return false;
  }

  private noteReplayHumanPresence(tick: number = this.players.tick): void {
    if (this.replayMatchHadHuman) return;
    // Synthetic joins do not arm recording. A later real human still does.
    if (!this.hasRecordableHuman()) return;
    this.replayMatchHadHuman = true;
    const sink = this.replaySink;
    if (!sink) return;
    // Late start for an already-rotated identity: open a row from this tick
    // (no backfill of prior bot-only ticks).
    this.replayPayloadConstructionCount++;
    const startPayload: ReplayLifecyclePayload = Object.freeze({
      tick,
      runtimeMatchId: this.runtimeMatchId,
      transition: "runtimeMatchIdRotated" as const,
    });
    this.safeReplaySinkCall("runtimeMatchIdRotated", () => {
      sink.onMatchStart(startPayload);
    });
    this.notifyReplayMatchInit(tick);
    if (this.players.isLive()) this.notifyReplayMatchStart(tick);
  }

  /**
   * Epic 7.5 — exception-isolated sink invoke. Throws never reach the tick loop.
   */
  private safeReplaySinkCall(label: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.replaySinkErrorCount++;
      console.error(`[replay-sink] ${label} threw (isolated):`, err);
    }
  }

  /**
   * Epic 7.5 — identity rotation notice.
   * Delivered through `onMatchStart` with `transition: "runtimeMatchIdRotated"`
   * (no dedicated callback on the sink; sinks branch on `payload.transition`).
   */
  private notifyReplayIdentityRotated(
    tick: number,
    previousRuntimeMatchId: string,
  ): void {
    const sink = this.replaySink;
    if (!sink) return;
    this.replayPayloadConstructionCount++;
    const payload: ReplayLifecyclePayload = Object.freeze({
      tick,
      runtimeMatchId: this.runtimeMatchId,
      transition: "runtimeMatchIdRotated" as const,
      previousRuntimeMatchId,
    });
    this.safeReplaySinkCall("runtimeMatchIdRotated", () => {
      sink.onMatchStart(payload);
    });
  }

  private notifyReplayMatchInit(tick: number): void {
    const sink = this.replaySink;
    if (!sink) return;
    this.replayPayloadConstructionCount++;
    const initRaw = this.players.buildMatchInitEvent(tick);
    if (initRaw.kind !== "matchInit") {
      console.error("[replay-sink] buildMatchInitEvent did not return matchInit");
      return;
    }
    const initEvent = initRaw as MatchInitEvent;
    const meta = this.getMatchMetadata(tick);
    if (!meta.ok) {
      console.warn(
        `[replay-sink] getMatchMetadata failed at init tick=${tick}: ${meta.reason}`,
      );
      return;
    }
    this.safeReplaySinkCall("onMatchInit", () => {
      sink.onMatchInit({
        initEvent: Object.freeze({ ...initEvent }),
        metadata: Object.freeze({ ...meta.metadata }),
      });
    });
  }

  /**
   * Epic 7.5 — live-entry lifecycle. Call at driver match-start rows when the
   * match is actually live (not ranked prematch warm-up).
   */
  private notifyReplayMatchStart(tick: number): void {
    const sink = this.replaySink;
    if (!sink || !this.replayMatchHadHuman || !this.players.isLive()) return;
    this.replayPayloadConstructionCount++;
    const payload: ReplayLifecyclePayload = Object.freeze({
      tick,
      runtimeMatchId: this.runtimeMatchId,
      transition: "matchStart" as const,
    });
    this.safeReplaySinkCall("onMatchStart", () => {
      sink.onMatchStart(payload);
    });
  }

  private notifyReplayMatchEnded(packet: GameOverPacket, tick: number): void {
    const sink = this.replaySink;
    if (!sink) return;
    // Bot-only matches never opened a row; recorder beginFinalize no-ops.
    // Still fan out so non-recorder sinks (and tests) observe the end.
    this.replayPayloadConstructionCount++;
    const isDraw = packet.winner === "draw";
    const payload: ReplayLifecyclePayload = Object.freeze({
      tick,
      runtimeMatchId: this.runtimeMatchId,
      transition: isDraw ? "matchDraw" as const : "matchEnd" as const,
    });
    this.safeReplaySinkCall(isDraw ? "onMatchDraw" : "onMatchEnd", () => {
      if (isDraw) sink.onMatchDraw(payload);
      else sink.onMatchEnd(payload);
    });
  }

  /**
   * Epic 9.2 — deliver a match-end sink notify deferred from stepSim so it
   * lands after drain + onTick (empty-drain final checkpoint; end-tick capture).
   */
  private flushPendingReplayMatchEnd(tick: number = this.players.tick): void {
    const packet = this.pendingReplayMatchEnd;
    if (!packet) return;
    this.pendingReplayMatchEnd = null;
    this.notifyReplayMatchEnded(packet, tick);
  }

  /**
   * Epic 7.5 — per-tick fan-out. Builds inputs map + frozen event view only
   * when a sink is attached (no-sink fast path = early return).
   */
  private deliverReplayIntegrationTick(
    tick: number,
    events: ReadonlyArray<AuthoritativeEvent>,
  ): void {
    const sink = this.replaySink;
    if (!sink) return;
    this.replayPayloadConstructionCount++;
    const inputs = new Map<string, TickSelectedInput | null>();
    for (const p of this.players.all()) {
      inputs.set(p.id, p.lastTickInputSelection());
    }
    Object.freeze(inputs);
    // Drain action notes accumulated at handle* since the prior fan-out
    // (includes between-tick immediates stamped with an earlier tick).
    const actions = Object.freeze(this.replayActionEffects.slice());
    this.replayActionEffects = [];
    const eventsView = Object.freeze(events.slice());
    this.safeReplaySinkCall("onTick", () => {
      sink.onTick({
        tick,
        inputs,
        actions,
        events: eventsView,
      });
    });
  }

  /**
   * Remove dead grey agents after death combat was sent.
   * Last agent clear re-opens doors. PlayerLeft via BotManager onBotLeft hooks.
   */
  private pruneDeadAgents(tick?: number): void {
    const removed = this.bots.pruneDeadAgents(tick);
    for (const id of removed) {
      this.mapVotes.delete(id);
    }
  }
}
