// @ts-types="@types/express"
// deno-lint-ignore-file no-import-prefix
import express from "express";
import cors from "cors";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { Server as NodeHttpServer } from "node:http";
import type { Server as NodeHttpsServer } from "node:https";
import type { TlsMaterial } from "../host/tlsConfig.ts";
import { GAME_PROTO } from "../shared/net/index.ts";
import {
  countSessionsByKind,
  createCompositeHub,
} from "../transport/compositeHub.ts";
import { createSocketIoHub } from "../transport/socketIoHub.ts";
import type {
  ClientSession,
  SessionData,
  SessionHub,
} from "../transport/types.ts";
import {
  WEBTRANSPORT_PATH,
  webTransportWanted,
} from "../transport/webTransportConfig.ts";
import {
  createWebTransportHub,
  type WebTransportHub,
} from "../transport/webTransportHub.ts";

import { GameLoop, TICK_HZ } from "./GameLoop.ts";
import {
  buildRuntimeStatus,
  PROCESS_STARTED_AT,
  runtimeHostStatus,
} from "./runtimeStatus.ts";
import { resolveBotThinkRuntime } from "./botThinkRuntime.ts";
import {
  DEFAULT_MAX_PLAYERS,
  type GameServerOptions,
  type MapCatalogEntry,
  type ServerJoinMode,
} from "./gameServerOptions.ts";
import { PhaseTimingBundle, type TickTimingSnapshot } from "./tickTiming.ts";
import { HostChannel } from "../host/channel/server.ts";
import { BotManager } from "../bots/BotManager.ts";
import type { BotDifficulty, BotSnapshotInfo } from "../bots/types.ts";

import type { CompiledBotThinkPipeline } from "../bots/compiled/index.ts";
import { PlayerManager } from "../players/PlayerManager.ts";
import type { ShootOutcome } from "../players/PlayerManager.ts";
import { packCombatOutcomePacket } from "../players/combatOutcomePacket.ts";
import type { Player } from "../players/Player.ts";
import {
  flushPendingWeapons as flushWeaponsQueue,
  type PendingWeapon,
} from "../players/weaponsQueue.ts";
import type { SimIngressSinks } from "../players/simIngress.ts";
import type { SimTickEvent, SimTickResult } from "../players/simTickResult.ts";
import { drainTickAuthoritativeEvents } from "../players/authoritativeEventSource.ts";
import type {
  ReplayIntegrationSink,
  ReplayIntegrationSinkHandle,
} from "../replay/replayIntegration.ts";
import { ReplayRecorder } from "../replay/ReplayRecorder.ts";
import {
  type AuthoritativeCheckpoint,
  type CheckpointRaidState,
} from "../replay/authoritativeCheckpoint.ts";
import type { AuthoritativeEvent } from "../shared/sim/authoritativeEvent.ts";
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

import {
  type CombatBurstPacket,
  type CombatOutcomePacket,
  type GameOverPacket,
  JoinErrors,
  type KickedPacket,
  type MapChangePacket,
  type MatchStartPacket,
  type MatchVoidedPacket,
  NetEvents,
  type SessionReplacedPacket,
  SNAPSHOT_EVERY_TICKS,
  type TeamId,
} from "../protocol/network.ts";
import { MapVote } from "./mapVote.ts";
import { PoseStream } from "./poseStream.ts";
import { AdmissionBotWave } from "./admissionBotWave.ts";
import {
  type AdmittedJoin,
  applyReclaimProfile,
  equipmentFromSessionData,
  type VerifiedPlayerJoin,
  verifyJoinIdentity,
} from "./joinAuth.ts";
import { TeamRebalance } from "./teamRebalance.ts";
import {
  type AbandonHuman,
  AuthorityReporter,
  buildAbandonReport,
  buildMatchReport,
  type MatchReportActor,
} from "./matchReports.ts";
import type { AdminCommandHost } from "./adminCommands.ts";
import { ReplayTap } from "./replayTap.ts";
import type { DoorsMap } from "../world/map.ts";
import type { MapCollision } from "../world/MapCollision.ts";
import { isOpenOfficialServerId } from "../authority/rankedAuth.ts";
import {
  consumeOpenAdmissionJti,
  openAdmissionSubjectKey,
} from "../authority/openAdmission.ts";
import type { AuthorityPublicKeys } from "../shared/authority/authorityTokens.ts";
import {
  type AuthorityAdapter,
  createAuthorityAdapter,
  loadAuthorityUrlFromEnv,
} from "../authority/adapter.ts";
import { HeatmapTracker } from "../heatmaps/HeatmapTracker.ts";
import { poolBrainCommandFromEnv } from "../bots/poolCommand.ts";
import { rankedSessionStatus } from "./rankedSession.ts";
import { InputRateLimiter } from "../transport/inputRateLimit.ts";
import { isRuntimeDraining } from "../shared/fleet/runtimeDrain.ts";
import {
  admissionLocked,
  authorityStatusUrl,
  shouldHoldMatchRestart,
  startReleaseLockPoll,
} from "./releaseLock.ts";
import type { RaidMatch } from "../raid/RaidMatch.ts";
import { RAIDS } from "../shared/campaign/raids.ts";
import { RaidRuntime } from "./raidRuntime.ts";
import {
  registerSessionEvents,
  type SeatedPlayer,
  type SessionEventHost,
} from "./sessionEvents.ts";

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
  private releasePollStop: (() => void) | null = null;
  private readonly authorityStatusUrl: string | null;
  /**
   * Live raid slot. Owns the match, credits, prize block, and load gate.
   * The getters below keep the test harness on the old names.
   */
  private readonly raidRuntime: RaidRuntime;

  private get raid(): RaidMatch | null {
    return this.raidRuntime.match;
  }

  private get raidCredits(): RaidRuntime["credits"] {
    return this.raidRuntime.credits;
  }

  private get raidPrizeIneligible(): Set<string> {
    return this.raidRuntime.prizeIneligible;
  }

  private get raidLoadedPlayerIds(): Set<string> {
    return this.raidRuntime.loadedPlayerIds;
  }

  private readonly authority: AuthorityAdapter;
  /** Match, abandon, heatmap, and reservation reports. Owns the dedup keys. */
  private readonly reports: AuthorityReporter;
  private map: DoorsMap;
  private mapPath?: string;
  private readonly mapCatalog: MapCatalogEntry[];
  private readonly players: PlayerManager;
  private readonly bots: BotManager;
  private hostChannel: HostChannel | null = null;
  private readonly compiledBotThinkEngine: CompiledBotThinkPipeline | null;

  /** Prevent double-report if endMatch is observed twice. */
  private get lastReportedMatchKey(): string | null {
    return this.reports.lastReportedMatchKey;
  }

  private set lastReportedMatchKey(value: string | null) {
    this.reports.lastReportedMatchKey = value;
  }

  /** Immutable delivery identity for the current live match. */
  private runtimeMatchId = crypto.randomUUID();
  /** Immutable id for the current match's additive heatmap batch. */
  private heatmapBatchId = crypto.randomUUID();
  /**
   * Replay sink fan-out and recorder lifecycle. The getters below keep the
   * test harness on the old names.
   */
  private readonly replay: ReplayTap;

  private get replaySink(): ReplayIntegrationSink | null {
    return this.replay.sink;
  }

  private set replaySink(value: ReplayIntegrationSink | null) {
    this.replay.sink = value;
  }

  private get replayRecorder(): ReplayRecorder | null {
    return this.replay.recorder;
  }

  private set replayRecorder(value: ReplayRecorder | null) {
    this.replay.recorder = value;
  }

  private get pendingReplayMatchEnd(): GameOverPacket | null {
    return this.replay.pendingMatchEnd;
  }

  private set pendingReplayMatchEnd(value: GameOverPacket | null) {
    this.replay.pendingMatchEnd = value;
  }

  private get replayPayloadConstructionCount(): number {
    return this.replay.payloadConstructionCount;
  }

  private set replayPayloadConstructionCount(value: number) {
    this.replay.payloadConstructionCount = value;
  }

  /** In-match human/bot heatmap sampling (server-side only). */
  private readonly heatmaps = new HeatmapTracker({ tickHz: TICK_HZ });

  /** Dedup key so flush is not double-posted on the same end path. */
  private get lastHeatmapReportKey(): string | null {
    return this.reports.lastHeatmapReportKey;
  }

  private set lastHeatmapReportKey(value: string | null) {
    this.reports.lastHeatmapReportKey = value;
  }

  /**
   * Post-match map vote. Owns the ballots and the open flag.
   * `mapVotes` stays on this object so the test harness can plant a ballot.
   */
  private readonly mapVote = new MapVote({
    catalog: () => this.mapCatalog,
    raidRuntime: () => this.isRaidRuntime(),
    hasPlayer: (playerId) => this.players.get(playerId) != null,
    playerSimBots: {
      voteSeedPolicy: () => this.bots.voteSeedPolicy(),
      poolPawnIds: () => this.bots.poolPawnIds(),
    },
  });

  private get mapVotes(): Map<string, string> {
    return this.mapVote.ballots;
  }

  /**
   * Open-match team switch and rebalance votes. Owns the ballots and the
   * pending swap. Sessions are assigned in start(), so that dep is a getter.
   */
  private readonly teamRebalance: TeamRebalance;

  /**
   * Open-admission bot fill wave. Owns the settle timer and the pending
   * parties. The getters below keep the test harness on the old names.
   */
  private readonly admissionBots: AdmissionBotWave;

  private get admissionBotReconcileTimer():
    | ReturnType<typeof setTimeout>
    | null {
    return this.admissionBots.admissionBotReconcileTimer;
  }

  private get admissionBotPendingParties(): Map<string, { partySize: number }> {
    return this.admissionBots.admissionBotPendingParties;
  }

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
  /** Per-socket pose stream (A4 / C5). Owns the net mirrors. */
  private readonly poses = new PoseStream();

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
    this.reports = new AuthorityReporter({
      authority: this.authority,
      sessions: () => this.sessions ?? null,
      humans: () =>
        this.players.humans().map((p) => ({
          id: p.id,
          accountUserId: p.accountUserId,
          socketId: p.socketId,
        })),
      heatmaps: this.heatmaps,
      mapName: () => this.map.name,
      serverId: () => this.rankedServerId,
      runtimeMatchId: () => this.runtimeMatchId,
      heatmapBatchId: () => this.heatmapBatchId,
      players: () => this.players.all(),
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
    this.replay = new ReplayTap({
      players: this.players,
      runtimeMatchId: () => this.runtimeMatchId,
      raidCheckpointState: () => this.getRaidCheckpointState(),
      matchMetadata: (tick) => this.getMatchMetadata(tick),
      createReplayLifecycleClient: () =>
        this.authority.createReplayLifecycleClient?.() ?? null,
    });
    const fill: { minPlayers?: number; noBotsOnEmptyServer?: boolean } = {};
    if (options.autofillBots !== undefined) {
      fill.minPlayers = options.autofillBots;
    }
    if (options.noBotsOnEmptyServer !== undefined) {
      fill.noBotsOnEmptyServer = options.noBotsOnEmptyServer;
    }
    const think = resolveBotThinkRuntime({
      botThinkEngine: options.botThinkEngine,
      compiledBotThinkEngine: options.compiledBotThinkEngine,
      compiledBotThinkMode: options.compiledBotThinkMode,
    }, Deno.env.get("DOORS_BOT_THINK_RUNTIME"));
    this.compiledBotThinkEngine = think.compiledBotThinkEngine;
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
        this.mapVote.forget(playerId);
        this.sessions.emit(NetEvents.PlayerLeft, { id: playerId });
      },
    }, {
      fill: Object.keys(fill).length > 0 ? fill : undefined,
      difficulty: options.botDifficulty,
      brain: options.botBrain,
      poolBrain: options.poolBrain ?? poolBrainCommandFromEnv(),
      thoughtEngine: think.botManagerOptions.thoughtEngine,
      thoughtCodecLoop: think.botManagerOptions.thoughtCodecLoop,
      compiledThoughtEngine: think.botManagerOptions.compiledThoughtEngine,
      compiledThoughtMode: think.botManagerOptions.compiledThoughtMode,
      compiledThoughtHost: think.botManagerOptions.compiledThoughtHost,
    });
    this.bots.setPoolCap(this.maxPlayers);
    this.teamRebalance = new TeamRebalance({
      players: this.players,
      sessions: () => this.sessions,
      isRanked: () => this.isRanked(),
      isRaid: () => this.isRaidRuntime(),
      reconcileBots: () => {
        this.bots.reconcile(this.maxPlayers);
      },
      autofillBots: () => this.getAutofillBots(),
    });
    this.admissionBots = new AdmissionBotWave({
      players: this.players,
      bots: this.bots,
      maxPlayers: () => this.maxPlayers,
    });
    this.bots.setPoolListener((event) => {
      this.hostChannel?.send(event);
    });
    if (this.isRaidRuntime()) {
      // The public community build ships an empty raid catalog.
      if ((RAIDS as readonly unknown[]).length === 0) {
        throw new Error(
          "Raid mode is not available in the community server. Unset DOORS_MODE_ID and RANKED_SERVER_ID.",
        );
      }
      this.bots.setRaidMode(true);
      this.players.setRaidDoorPolicy("idle");
    }
    this.raidRuntime = new RaidRuntime({
      isRaidRuntime: () => this.isRaidRuntime(),
      players: this.players,
      bots: this.bots,
      sessions: () => this.sessions,
      map: () => this.map,
      mapPath: () => this.mapPath,
      findMapEntry: (name) => this.mapVote.findEntry(name),
      setActiveMap: (entry) => this.setActiveMap(entry),
      beginRuntimeMatchIdentity: (tick) => this.beginRuntimeMatchIdentity(tick),
      notifyMatchStart: (tick) => this.replay.notifyMatchStart(tick),
      resetHeatmaps: () => this.heatmaps.resetForNewMatch(),
      dismissHumanToMenu: (player, packet) => {
        this.dismissHumanToMenu(player, packet);
      },
      kickForAfk: (player) => this.kickPlayerForAfk(player),
    });
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
      res.json(buildRuntimeStatus({
        hostIdEnv: Deno.env.get("DOORS_HOST_ID"),
        runtimeIdEnv: Deno.env.get("DOORS_RUNTIME_ID"),
        rankedServerId: this.rankedServerId,
        modeId: this.modeId,
        instanceIdEnv: Deno.env.get("DOORS_INSTANCE_ID"),
        generationEnv: Deno.env.get("DOORS_GENERATION"),
        buildShaEnv: Deno.env.get("DOORS_BUILD_SHA"),
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
        maxPartySize: this.players.maxPartySize(this.maxPlayers),
        map: this.map.name,
        tick: this.players.tick,
        scores: this.players.getScores(),
        maps: this.mapVote.voteCatalog().map((m) => m.name),
        matchOver: matchTime.matchOver,
        matchSecondsRemaining: matchTime.matchSecondsRemaining,
        restartSecondsRemaining: matchTime.restartSecondsRemaining,
        phase: matchTime.phase,
        matchVoided: this.players.isLiveMatchVoided(),
        sessionFreeSlots: session.freeSlots,
        sessionJoinable: session.joinable,
        raidRuntime: this.isRaidRuntime(),
        raidActive: this.raid != null,
        draining,
        joinMode: this.joinMode,
        passwordRequired: this.joinPassword != null,
        board,
        prematch,
        topPlayer: top,
        tickTiming: this.loop
          ? {
            ...this.loop.timing.snapshot(),
            phases: this.phaseTiming.snapshot(),
            skippedDeficitTicks: this.loop.skippedDeficitTicks,
          }
          : null,
        botThink: this.bots.getBotThinkMetrics({ consumeSnapshot: true }),
        heatmap: this.heatmaps.getRuntimeStats(this.players.getMatchPhase()),
        netMirror: {
          ...this.poses.summary(),
          ...countSessionsByKind(this.sessions),
          players: this.players.inputHealth(),
        },
        webTransport: {
          enabled: this.wantWebTransport,
          listening: this.webTransportListening,
          port: this.webTransportListenPort ?? this.port,
          path: this.wtHub?.path ?? WEBTRANSPORT_PATH,
          proto: GAME_PROTO,
        },
        protocolVersion: GAME_PROTO,
      }));
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
    this.admissionBots.cancel();
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
    return this.raidRuntime.metadataState();
  }

  private getRaidCheckpointState(): CheckpointRaidState {
    return this.raidRuntime.checkpointState();
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
    this.replay.attach(sink);
  }

  /** Epic 7.5 — detach the recorder sink; live game continues unchanged. */
  public detachReplaySink(): void {
    this.replay.detach();
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
  public startReplayRecorder(): ReplayRecorder | null {
    return this.replay.startRecorder();
  }

  /** Epic 8.1 — fail open row (clean shutdown) and detach. */
  public stopReplayRecorder(): void {
    this.replay.stopRecorder();
  }

  /** Epic 7.5 test/observability: contained sink-throw count. */
  public getReplaySinkErrorCount(): number {
    return this.replay.sinkErrorCount;
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
    return this.replay.captureCheckpoint(tick);
  }

  private startReleasePoll(): void {
    if (!this.authorityStatusUrl || this.releasePollStop) return;
    this.releasePollStop = startReleaseLockPoll(
      this.authorityStatusUrl,
      (locked) => {
        this.releaseLocked = locked;
      },
    );
  }

  private stopReleasePoll(): void {
    this.releasePollStop?.();
    this.releasePollStop = null;
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
    return this.poses.summary();
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
  /**
   * Point the live match at a map. Shared by host map changes, the
   * intermission vote, and raid stage swaps.
   */
  private setActiveMap(entry: {
    map: DoorsMap;
    path?: string;
    collision: MapCollision;
  }): void {
    this.map = entry.map;
    this.mapPath = entry.path;
    this.players.setCollision(entry.collision);
  }

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

    this.mapVote.clear();
    this.setActiveMap({
      map: options.map,
      path: options.mapPath,
      collision: options.collision,
    });

    // Map swap starts a new match session — flush any live samples first.
    if (wasLive) this.reports.flushHeatmapsToAuthority();
    this.heatmaps.resetForNewMatch();
    const matchStart = this.players.startNewMatch(tick, Date.now());
    this.beginRuntimeMatchIdentity(tick);
    // Map-change open path skips emitMatchStart — still notify live entry.
    this.replay.notifyMatchStart(tick);
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
          rebalanceVote: this.teamRebalance.voteStateFor(playerId),
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

  /** Broadcast current ranked lobby state to all clients. */
  private broadcastPrematchState(): void {
    if (!this.sessions || !this.players.isPrematchEnabled()) return;
    this.sessions.emit(
      NetEvents.PrematchState,
      this.players.getPrematchState(),
    );
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
    this.replay.notifyMatchStart(tick);
    if (!this.sessions) return;
    this.sessions.emit(NetEvents.MatchStart, matchStart);
    this.sessions.emit(NetEvents.Snapshot, this.players.createSnapshot(tick));
    if (this.players.isPrematchEnabled()) {
      this.broadcastPrematchState();
    }
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

  private adminCommandHost(): AdminCommandHost {
    return {
      findMap: (query) => this.mapVote.findEntry(query),
      mapNames: () => this.mapCatalog.map((entry) => entry.name),
      currentMap: () => ({ name: this.map.name, path: this.mapPath }),
      changeMap: (entry) => {
        const result = this.changeMap({
          map: entry.map,
          collision: entry.collision,
          mapPath: entry.path,
        });
        return { endedAsDraw: result.endedAsDraw };
      },
      toggleBotTracking: () => this.heatmaps.toggleBotTracking(),
      forceDoors: (enabled) =>
        typeof enabled === "boolean"
          ? this.players.setDebugForceDoorsOpen(enabled)
          : this.players.toggleDebugForceDoorsOpen(),
      findPlayer: (name) => this.players.findByName(name) ?? null,
      kickBot: (id) => this.bots.kickBot(id),
      removeHuman: (target) => {
        const socketId = target.socketId;
        if (socketId && this.sessions) {
          const session = this.sessions.get(socketId);
          if (session) session.data.intentionalLeave = true;
        }
        this.dropPlayer(target.id);
        if (socketId && this.sessions) {
          this.sessions.get(socketId)?.disconnect();
        }
      },
      forgetSilently: (ids) => this.teamRebalance.forgetSilently(ids),
      syncAfterRosterChange: () => {
        this.teamRebalance.syncAfterRosterChange();
      },
      isLive: () => this.players.isLive(),
    };
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
    const raidDecorated = this.raidRuntime.decorateGameOver(
      packet,
      () => this.gameOverXpMode(),
    );
    if (raidDecorated) return raidDecorated;
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
      mapVote: this.mapVote.state(),
      ...(xpMode ? { xpMode } : {}),
    };
  }

  private enrichGameOver(packet: GameOverPacket): GameOverPacket {
    if (!this.raid && !shouldHoldMatchRestart(this.releaseLocked)) {
      this.mapVote.begin();
    }
    return this.decorateGameOver(packet);
  }

  private raidJoinConflict(input: {
    team?: "A" | "B";
    raidId?: string;
  }): boolean {
    return this.raidRuntime.joinConflict(input);
  }

  private activateRaidFromJoin(input: {
    team?: "A" | "B";
    raidId?: string;
    partySize?: number;
    soloRaid?: boolean;
  }): void {
    this.raidRuntime.activateFromJoin(input);
  }

  /**
   * Seat-time raid gate. Auth already rejected a conflict it could see.
   * Two members can both pass auth before either is seated, so check again
   * here. A refusal emits and disconnects, and does not activate.
   */
  private commitRaidJoin(session: {
    data: SessionData;
    emit(event: string, payload?: unknown): void;
    disconnect(): void;
  }): boolean {
    const raidJoin = session.data.raidJoin;
    if (!raidJoin) return true;
    if (
      this.raidJoinConflict({
        team: raidJoin.team,
        raidId: raidJoin.raidId,
      })
    ) {
      session.emit("error", { message: JoinErrors.AuthInvalid });
      session.disconnect();
      return false;
    }
    this.activateRaidFromJoin(raidJoin);
    return true;
  }

  private tickRaidAgentEncounter(tick: number): void {
    this.raidRuntime.tickAgentEncounter(tick);
  }

  private maybeStartRaid(): GameOverPacket | null {
    return this.raidRuntime.maybeStart();
  }

  private handleRaidScores(
    scores: { team: TeamId }[],
  ): GameOverPacket | null {
    return this.raidRuntime.handleScores(scores);
  }

  private handleRaidFailConditions(): GameOverPacket | null {
    return this.raidRuntime.handleFailConditions();
  }

  private raidPartyTimedOut(
    partyId: string | undefined,
    nowMs?: number,
  ): boolean {
    return this.raidRuntime.partyTimedOut(partyId, nowMs);
  }

  private snapshotRaidCredit(player: Player): void {
    this.raidRuntime.snapshotCredit(player);
  }

  private resetIdleRaidRuntime(): void {
    this.raidRuntime.resetIdle();
  }

  private closeEndedRaidSession(): void {
    this.raidRuntime.closeEnded();
  }

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
    this.replay.deferMatchEnd(packet);
    this.raidRuntime.clearPendingEncounter();
    // Drop any mid-match rebalance; phase is no longer live.
    this.teamRebalance.onMatchOver();
    // Live match ended — lobby phase becomes intermission (for ranked UI).
    if (this.players.isPrematchEnabled()) {
      this.broadcastPrematchState();
    }
    // Flush heatmaps even when progression report is skipped (void / no accounts),
    // as long as authority is configured — samples already collected in memory.
    this.reports.flushHeatmapsToAuthority();

    // Already reported no_score for this live session — do not also score it.
    // Participation sampling finalizes active time, so it stays below these returns.
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
    const actors: MatchReportActor[] = [];
    for (const row of packet.players) {
      const p = this.players.get(row.id);
      if (!p) continue;
      actors.push({
        id: p.id,
        accountUserId: p.accountUserId,
        name: p.name,
        team: p.team,
        kills: p.kills,
        deaths: p.deaths,
        score: p.score,
        isBot: p.isBot,
        poolAccount: p.poolAccount,
        synthetic: p.synthetic,
        afk: p.isAfk(endedAtMs),
      });
    }
    const built = buildMatchReport({
      ranked,
      authorityEnabled: true,
      voided: false,
      winner: packet.winner,
      scores: packet.scores,
      actors,
      participation,
      endedAtMs,
      raid: this.raid
        ? { humanTeam: this.raid.humanTeam, raidId: this.raid.raidId }
        : null,
      raidCredits: this.raidCredits.values(),
      raidPrizeIneligible: this.raidPrizeIneligible,
      runtimeMatchId: this.runtimeMatchId,
      serverId: this.rankedServerId,
      modeId: this.modeId,
      mapName: this.map.name,
    });
    if ("skip" in built) {
      // Guests have nothing to grant. Authority would also grant nothing to
      // a pawn-only report, so do not post one.
      if (built.skip === "no_accounts" && ranked) {
        console.warn(
          "[server] Ranked match ended with no account-linked humans — skip report",
        );
      }
      return;
    }
    this.reports.reportMatch(built, packet);
  }

  private handleHumanAbandon(leaver: Player): void {
    if (!this.isRanked()) return;
    if (leaver.isBot) return;
    // Only scored live play can be abandoned (not prematch warm-up / intermission).
    if (!this.players.isLive()) return;
    if (!this.players.markLiveMatchVoided(leaver.id)) {
      // Already voided — free leave for everyone else.
      return;
    }

    const humans: AbandonHuman[] = this.players.humans().map((p) => ({
      id: p.id,
      name: p.name,
      team: p.team,
      kills: p.kills,
      deaths: p.deaths,
      score: p.score,
      accountUserId: p.accountUserId,
      synthetic: p.synthetic,
    }));

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

    this.reports.reportAbandon(buildAbandonReport({
      leaver: {
        id: leaver.id,
        name: leaver.name,
        accountUserId: leaver.accountUserId,
      },
      humans,
      scores: this.players.getScores(),
      runtimeMatchId: this.runtimeMatchId,
      serverId: this.rankedServerId,
      modeId: this.modeId,
      mapName: this.map.name,
      endedAt: new Date().toISOString(),
    }));
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
    this.raidRuntime.markPrizeIneligible(player);
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

    // Group member left — cancel without packets (partial group invalid).
    const hadRebalanceVote = this.teamRebalance.forgetSilently([playerId]);

    const hadVote = this.mapVote.forget(playerId);
    const wasPrematch = this.players.isPrematch();
    this.players.remove(playerId);
    this.sessions!.emit(NetEvents.PlayerLeft, { id: playerId });
    if (hadVote && this.mapVote.isOpen) {
      this.sessions!.emit(NetEvents.MapVoteState, this.mapVote.state());
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
    if (this.admissionBots.isActive()) {
      this.admissionBots.finish("leave");
    }
    this.bots.onHumanLeft(this.maxPlayers);
    if (wasPrematch) {
      this.broadcastPrematchState();
    } else if (
      hadRebalanceVote ||
      this.teamRebalance.voteCount > 0 ||
      this.teamRebalance.hasPending
    ) {
      this.teamRebalance.syncAfterRosterChange();
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
      this.reports.flushHeatmapsToAuthority();
    }
    this.heatmaps.resetForNewMatch();

    // A draining runtime should retain its phase for release coordination, but
    // its final heatmap batch is still complete and safe to clear in memory.
    if (this.releaseLocked) return false;

    // Drop any leftover autofill bots so the next party does not inherit them.
    this.bots.clear();
    this.mapVote.clear();
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
   * After a human is seated: either immediate bot fill (solo) or deferred
   * batch reconcile for party / assignment-bearing admissions (S9-PR3).
   * Recording starts here; the wave itself does not know about replays.
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
    this.admissionBots.onHumanSeated(opts);
  }

  /**
   * Resolve the display name for a connecting socket, then admit the seat.
   * Identity (password, spectate, token, guest name, raid activation) is
   * verifyJoinIdentity. Seat policy stays here.
   */
  private async authenticateJoin(
    authBag: Record<string, unknown>,
  ): Promise<AdmittedJoin | { ok: false; error: string }> {
    const verified = await verifyJoinIdentity(authBag, {
      isCommunityHost: this.isCommunityHost(),
      joinPassword: this.joinPassword,
      authorityTokenPublicKeys: this.authorityTokenPublicKeys,
      rankedServerId: this.rankedServerId,
      joinMode: this.joinMode,
      openAssignmentRequired: this.openAssignmentRequired,
      openOfficial: this.openOfficial,
      isRaidRuntime: this.isRaidRuntime(),
      raidPartyTimedOut: (partyId) => this.raidPartyTimedOut(partyId),
      raidJoinConflict: (input) => this.raidJoinConflict(input),
    });
    if (!verified.ok) return verified;
    if (verified.spectator) {
      return {
        ok: true,
        spectator: true,
        name: verified.name,
        accountUserId: verified.accountUserId,
      };
    }
    return this.admitJoin(verified);
  }

  /**
   * Seat policy after identity verification: jti consume, party cap,
   * session-conflict reclaim, drain lock, name taken, seat freeing,
   * reservation acks.
   */
  private admitJoin(
    verified: VerifiedPlayerJoin,
  ): AdmittedJoin | { ok: false; error: string } {
    const {
      name,
      accountUserId,
      partyId,
      partySize,
      assignmentId,
      admissionJti,
      admissionExp,
      raidJoin,
      profile,
    } = verified;

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
    } else if (this.openAssignmentRequired && this.openOfficial) {
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
        ...(raidJoin ? { raidJoin } : {}),
        ...profile,
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
    const seatsNeeded = this.admissionBots.remainingPartySeats({
      partyId,
      partySize,
    });
    // Pre-evict for remaining party seats before the socket is accepted.
    // Admission-wave accounting starts when the human is seated (connect path)
    // so a denied auth cannot leave a dangling batch open.
    const seatFree = this.admissionBots.ensureHumanJoinSlots(
      seatsNeeded,
      preferredTeam,
    );
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
      ...(raidJoin ? { raidJoin } : {}),
      ...profile,
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
    this.reports.reportOpenReservationAck(input);
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

  private seatPlayer(session: ClientSession): SeatedPlayer | null {
    const name = String(session.data.playerName ?? "");
    if (!name) {
      session.disconnect();
      return null;
    }
    // Before reclaim or a fresh seat, so joinTeam can read raid.humanTeam.
    if (!this.commitRaidJoin(session)) return null;
    // One transport-boundary timestamp is shared by reconnect, admission,
    // and non-simulation participation metadata for this connection.
    const connectionNowMs = Date.now();

    const reclaimId = typeof session.data.reclaimPlayerId === "string"
      ? session.data.reclaimPlayerId
      : null;

    let player: Player | null = null;
    let reclaimed = false;
    let respawnedOnReclaim = false;

    const equipment = equipmentFromSessionData(session.data);

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
        applyReclaimProfile(player, session.data);
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
        return null;
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
      const seatsNeeded = this.admissionBots.remainingPartySeats({
        partyId,
        partySize,
      });
      const seatFree = this.admissionBots.ensureHumanJoinSlots(
        seatsNeeded,
        joinTeam,
      );
      if (!seatFree.ok) {
        session.emit("error", { message: JoinErrors.ServerFull });
        session.disconnect();
        return null;
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
      } else if (
        this.teamRebalance.voteCount > 0 || this.teamRebalance.hasPending
      ) {
        // Threshold uses human count — re-evaluate vote progress only.
        this.teamRebalance.syncAfterRosterChange();
      }
    }

    if (reclaimed && this.isRaidRuntime()) {
      const raidOver = this.maybeStartRaid();
      if (raidOver) {
        this.onMatchEnded(raidOver, connectionNowMs);
        this.sessions?.emit(NetEvents.GameOver, raidOver);
      }
    }
    return { player, reclaimed, respawnedOnReclaim };
  }

  private registerEvents() {
    registerSessionEvents(this.sessions!, this.sessionEventHost());
  }

  private sessionEventHost(): SessionEventHost {
    return {
      authenticateJoin: (auth) => this.authenticateJoin(auth),
      welcomePayloadSpectator: (socketId) =>
        this.welcomePayloadSpectator(socketId),
      welcomePayload: (playerId) => this.welcomePayload(playerId),
      seatPlayer: (session) => this.seatPlayer(session),
      tickCount: () => this.loop.tickCount,
      loopReady: () => Boolean(this.loop),
      simNowMs: () => this.lastSimNowMs,
      players: this.players,
      poses: this.poses,
      inputRate: this.inputRate,
      ingressSinks: () => this.simIngressSinks(),
      mapVote: this.mapVote,
      teamRebalance: this.teamRebalance,
      authorityTokenPublicKeys: this.authorityTokenPublicKeys,
      rankedServerId: this.rankedServerId,
      adminCommandHost: () => this.adminCommandHost(),
      raid: () => this.raid,
      raidLoadedPlayerIds: () => this.raidLoadedPlayerIds,
      handleMatchReady: (playerId, ready) =>
        this.handleMatchReady(playerId, ready),
      dropPlayer: (playerId) => this.dropPlayer(playerId),
    };
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
  private emitSimTickEvents(
    tick: number,
    events: readonly SimTickEvent[],
  ): void {
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
          this.sessions.emit(
            NetEvents.GameOver,
            this.enrichGameOver(ev.gameOver),
          );
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

  /**
   * Epic 7.1 — sinks for the singular transport→sim ingress seam.
   * Session handlers in sessionEvents.ts resolve playerId then call `ingress*`.
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
        return this.poses.volDropPct(p.socketId);
      },
    };
  }

  /**
   * Weapons phase: resolve queued Shoot/Melee — humans queued on packet
   * arrival, bots queued from BotApply (PR 4) — in ascending shooter id
   * before MovePhysics. Packets associate to this tick.
   *
   * Thin wrapper over the shared `flushPendingWeapons` (weaponsQueue.ts):
   * gates bot heatmap facts on `heatmaps.botTrackingEngaged` (humans are
   * always recorded), matching pre-PR-4 behavior now that both flow through
   * one queue.
   */
  private flushPendingWeapons(
    tick: number,
    nowMs: number,
  ): {
    outcomes: ShootOutcome[];
    shootHeatmap: { playerId: string; doorsOpen: boolean }[];
  } {
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
    this.replay.enterStep();
    try {
      return this.stepSimBody(tick, nowMs);
    } finally {
      this.replay.exitStep();
    }
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
    this.bots.applyReadyActions(
      tick,
      nowMs,
      (req) => this.pendingWeapons.push(req),
    );

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
      const hadVote = this.mapVote.forget(id);
      // Epic 7.1: collect leave facts; driver emits PlayerLeft / MapVoteState.
      rosterLeaves.push({ playerId: id, hadMapVote: hadVote });
      humansLeft = true;
    }
    if (humansLeft) {
      // Timed-out members leave the pending group without a cancel packet.
      this.teamRebalance.forgetSilently(timedOut);
      if (this.maybeResetEmptyRankedInstance()) {
        // Reset handled bots + match state.
      } else {
        this.bots.onHumanLeft(this.maxPlayers);
        if (wasPrematch) {
          this.broadcastPrematchState();
        } else {
          this.teamRebalance.syncAfterRosterChange();
        }
      }
    }

    this.raidRuntime.afkTick(nowMs);

    this.teamRebalance.tick(nowMs);

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
          if (leave.hadMapVote && this.mapVote.isOpen) {
            this.sessions.emit(NetEvents.MapVoteState, this.mapVote.state());
          }
        }
      }

      // --- NON-SIM: PoseSnapshot ---
      if (tick % SNAPSHOT_EVERY_TICKS === 0) {
        const snap = this.players.createSnapshot(tick);
        this.poses.emitTick(this.sessions, tick, snap);
      }

      // --- NON-SIM: Ping ---
      if (tick % TICK_HZ === 0) {
        const timing = this.loop?.timing.snapshot();
        this.poses.emitPings(this.sessions!, this.players, timing);
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
    const winner = this.mapVote.resolveWinner();
    this.mapVote.clear();

    // Grey agents are match-scoped; drop them before roster respawn.
    this.bots.clearAgents();

    const switchTo = winner &&
        (winner.path !== this.mapPath || winner.name !== this.map.name)
      ? winner
      : null;

    if (switchTo) {
      // Intermission map change is not a draw — start fresh on the voted map.
      this.setActiveMap({
        map: switchTo.map,
        path: switchTo.path,
        collision: switchTo.collision,
      });
      const matchStart = this.players.startNewMatch(tick, nowMs);
      this.beginRuntimeMatchIdentity(tick);
      // Map-vote switch skips emitMatchStart — still notify when live.
      this.replay.notifyMatchStart(tick);
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
      this.sessions!.emit(
        NetEvents.Snapshot,
        this.players.createSnapshot(tick),
      );
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
   * finishIntermission (map-vote + same-map), and
   * RaidRuntime.activateFromJoin. Empty-ranked reset and raid idle reset
   * deliberately do NOT rotate.
   */
  private beginRuntimeMatchIdentity(tick: number = this.players.tick): void {
    const previousRuntimeMatchId = this.runtimeMatchId;
    this.runtimeMatchId = crypto.randomUUID();
    this.heatmapBatchId = crypto.randomUUID();
    this.lastReportedMatchKey = null;
    this.lastHeatmapReportKey = null;
    this.replay.onIdentityRotated(previousRuntimeMatchId, tick);
  }

  private noteReplayHumanPresence(tick: number = this.players.tick): void {
    this.replay.noteHumanPresence(tick);
  }

  /**
   * Epic 9.2 — deliver a match-end sink notify deferred from stepSim so it
   * lands after drain + onTick (empty-drain final checkpoint; end-tick capture).
   */
  private flushPendingReplayMatchEnd(tick: number = this.players.tick): void {
    this.replay.flushPendingEnd(tick);
  }

  /**
   * Epic 7.5 — per-tick fan-out. Builds inputs map + frozen event view only
   * when a sink is attached (no-sink fast path = early return).
   */
  private deliverReplayIntegrationTick(
    tick: number,
    events: ReadonlyArray<AuthoritativeEvent>,
  ): void {
    this.replay.deliverTick(tick, events);
  }

  /**
   * Remove dead grey agents after death combat was sent.
   * Last agent clear re-opens doors. PlayerLeft via BotManager onBotLeft hooks.
   */
  private pruneDeadAgents(tick?: number): void {
    const removed = this.bots.pruneDeadAgents(tick);
    for (const id of removed) {
      this.mapVote.forget(id);
    }
  }
}
