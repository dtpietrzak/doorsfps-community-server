/**
 * Live raid slot: the match, wave bots, load gate, credits, and the idle
 * reset. GameServer passes the roster, the bots, and the map / identity /
 * replay / heatmap hooks. The sessions hub is assigned in start(), so that
 * dep is a getter. This file does not import GameServer.
 */

import { BotManager } from "../bots/BotManager.ts";
import { TICK_HZ } from "./GameLoop.ts";
import type { MapCatalogEntry } from "./gameServerOptions.ts";
import { PlayerManager } from "../players/PlayerManager.ts";
import type { Player } from "../players/Player.ts";
import type { CheckpointRaidState } from "../replay/authoritativeCheckpoint.ts";
import type { RaidMatchMetadataState } from "../shared/replay/matchMetadata.ts";
import { RaidMatch } from "../raid/RaidMatch.ts";
import {
  RAID_AFK_MAX_MS,
  RAID_FAIL_RETURN_SECONDS,
  RAID_LOAD_TIMEOUT_PARTY_BLOCK_MS,
  RAID_WIN_RETURN_SECONDS,
} from "../shared/campaign/raids.ts";
import {
  type GameOverPacket,
  type KickedPacket,
  type MapChangePacket,
  NetEvents,
  type TeamId,
} from "../protocol/network.ts";
import type { SessionHub } from "../transport/types.ts";
import type { DoorsMap } from "../world/map.ts";
import type { MapCollision } from "../world/MapCollision.ts";

export type RaidJoinInput = {
  team?: "A" | "B";
  raidId?: string;
  partySize?: number;
  soloRaid?: boolean;
};

export type RaidRuntimeDeps = {
  isRaidRuntime: () => boolean;
  players: PlayerManager;
  bots: BotManager;
  /** Assigned in GameServer.start(). */
  sessions: () => SessionHub | null | undefined;
  map: () => DoorsMap;
  mapPath: () => string | undefined;
  findMapEntry: (name: string) => MapCatalogEntry | null;
  setActiveMap: (entry: {
    map: DoorsMap;
    path?: string;
    collision: MapCollision;
  }) => void;
  beginRuntimeMatchIdentity: (tick: number) => void;
  notifyMatchStart: (tick: number) => void;
  resetHeatmaps: () => void;
  dismissHumanToMenu: (player: Player, packet: KickedPacket) => void;
  kickForAfk: (player: Player) => void;
};

export class RaidRuntime {
  /** Live raid, or null while the slot is idle. */
  match: RaidMatch | null = null;
  private pendingAgentEncounter: {
    wave: number;
    atTick: number;
    count: number;
    doorTeam: TeamId;
  } | null = null;
  /** Account-linked raiders who started or joined, kept after they leave. */
  readonly credits = new Map<string, {
    clerkUserId: string;
    username: string;
    team: TeamId;
    kills: number;
    deaths: number;
    score: number;
  }>();
  /** AFK-kicked raiders do not share a late win. */
  readonly prizeIneligible = new Set<string>();
  /** Raiders whose client reported the map built (NetEvents.MapLoaded). */
  readonly loadedPlayerIds = new Set<string>();
  /**
   * Parties kicked for not loading in time → wall-clock expiry. A straggler's
   * already-issued join token must not reopen the idled slot by themselves.
   */
  private loadTimeoutParties = new Map<string, number>();

  constructor(private readonly deps: RaidRuntimeDeps) {}

  /** Reject a later join whose token disagrees with the live raid instance. */
  joinConflict(input: {
    team?: "A" | "B";
    raidId?: string;
  }): boolean {
    if (!this.match) return false;
    if (input.team && input.team !== this.match.humanTeam) return true;
    if (input.raidId && input.raidId !== this.match.raidId) return true;
    return false;
  }

  public activateFromJoin(input: RaidJoinInput): void {
    if (!this.deps.isRaidRuntime()) return;
    if (this.match) {
      if (typeof input.partySize === "number") {
        this.match.raiseExpectedHumans(input.partySize);
      }
      return;
    }
    if (this.deps.players.isMatchOver()) {
      this.deps.players.startNewMatch(this.deps.players.tick, Date.now());
    }
    // A warm raid slot serves many parties without restarting the process.
    // Give every newly activated raid its own authority/idempotency identity;
    // otherwise later clears replay the previous match receipt and receive no
    // fresh XP, coins, unlock, or match-card claim.
    this.deps.beginRuntimeMatchIdentity(this.deps.players.tick);
    this.deps.notifyMatchStart(this.deps.players.tick);
    this.deps.resetHeatmaps();
    const team = input.team === "B" ? "B" : "A";
    this.credits.clear();
    this.prizeIneligible.clear();
    this.loadedPlayerIds.clear();
    this.match = new RaidMatch({
      humanTeam: team,
      raidId: input.raidId,
      expectedHumans: input.partySize,
      allowSolo: input.soloRaid === true,
    });
    this.switchMap(this.match.planForWave(1).map, false);
    // Match clock starts when the raid starts, not during the party wait.
  }

  /** Swap a raid stage map without resetting scores, clock, or progression. */
  switchMap(mapName: string, emit: boolean = true): boolean {
    const entry = this.deps.findMapEntry(mapName);
    if (!entry) {
      console.warn(`[raid] required map "${mapName}" is not preloaded`);
      return false;
    }
    const map = this.deps.map();
    if (entry.path === this.deps.mapPath() && entry.name === map.name) {
      return true;
    }

    this.deps.setActiveMap({
      map: entry.map,
      path: entry.path,
      collision: entry.collision,
    });

    if (!emit) return true;
    const players = this.deps.players;
    const tick = players.tick;
    players.relocateRaidSurvivors(tick);
    const door = players.getDoorCycleState(tick);
    const plan = this.match?.planForWave(this.match.wave);
    const active = this.deps.map();
    const packet: MapChangePacket = {
      map: active,
      scores: players.getScores(),
      players: players.getFullPlayerRoster(tick),
      doorsOpen: door.doorsOpen,
      doorChangeTick: door.doorChangeTick,
      matchEndTick: players.getMatchClockState().matchEndTick,
      endedAsDraw: false,
      raidStage: true,
      ...(plan?.prevMap ? { prevMap: plan.prevMap } : {}),
      ...(plan?.nextMap ? { nextMap: plan.nextMap } : {}),
    };
    const sessions = this.deps.sessions();
    sessions?.emit(NetEvents.MapChange, packet);
    sessions?.emit(NetEvents.Snapshot, players.createSnapshot(tick));
    return true;
  }

  beginWave(wave: number): GameOverPacket | null {
    if (!this.match || this.match.ended) return null;
    const plan = this.match.planForWave(wave);
    this.pendingAgentEncounter = null;
    this.deps.bots.clearRaidBots();
    if (!this.switchMap(plan.map)) {
      this.match.onTimeout();
      return this.deps.players.forceEndMatch(
        this.deps.players.tick,
        this.match.enemyTeam,
        this.failEndOpts(),
      );
    }

    const bossEncounter = plan.bossEncounter;
    const miniEncounter = plan.miniEncounter;
    if (miniEncounter) {
      this.deps.bots.setRaidMixedWave(this.match.enemyTeam, {
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
      this.deps.bots.setRaidBossWave(
        bossEncounter.count,
        this.match.enemyTeam,
        {
          maxHealth: bossEncounter.maxHealth,
          modelScale: bossEncounter.scale,
          moveSpeedScale: bossEncounter.moveSpeedScale,
        },
      );
    } else {
      this.deps.bots.setRaidWave(plan.botCount, this.match.enemyTeam);
    }

    if (plan.agentEncounter) {
      this.pendingAgentEncounter = {
        wave: plan.wave,
        atTick: this.deps.players.tick + Math.ceil(
          plan.agentEncounter.delaySeconds * TICK_HZ,
        ),
        count: plan.agentEncounter.count,
        doorTeam: this.match.humanTeam,
      };
      if (plan.agentEncounter.delaySeconds > 0) {
        this.deps.players.setRaidDoorPolicy("idle");
      }
      this.tickAgentEncounter(this.deps.players.tick);
    }
    return null;
  }

  tickAgentEncounter(tick: number): void {
    const encounter = this.pendingAgentEncounter;
    if (!encounter || tick < encounter.atTick) return;
    this.pendingAgentEncounter = null;
    if (
      !this.match || !this.match.started || this.match.ended ||
      this.match.wave !== encounter.wave || this.deps.players.isMatchOver()
    ) return;
    this.deps.bots.spawnAgentsAtDoor(
      encounter.count,
      this.deps.players.getCollision(),
      encounter.doorTeam,
    );
    this.deps.players.setRaidDoorPolicy("open");
  }

  clearPendingEncounter(): void {
    this.pendingAgentEncounter = null;
  }

  maybeStart(): GameOverPacket | null {
    if (!this.match || this.match.started || this.match.ended) return null;
    const humans = this.deps.players.humans().filter((p) =>
      p.team === this.match!.humanTeam
    );
    // Connected is not enough: a slow loader would join a fight already
    // underway. Hold doors and bots until every client has built the map.
    const loaded = humans.filter((p) => this.loadedPlayerIds.has(p.id));
    if (!this.match.tryStart(loaded.length)) return null;
    for (const human of humans) human.raidAfkAccumMs = 0;
    this.deps.players.setRaidDoorPolicy("open");
    this.deps.players.setMatchClock(this.deps.players.tick, this.match.maxTimeSeconds);
    return this.beginWave(1);
  }

  handleScores(
    scores: { team: TeamId }[],
  ): GameOverPacket | null {
    if (!this.match || !this.match.started || this.match.ended) return null;
    // Same tick as a bot capture: the house wins. Do not start the next wave
    // and then fail — and do not ignore the enemy score.
    if (scores.some((ev) => ev.team !== this.match!.humanTeam)) {
      this.match.onEnemyCapture();
      return this.deps.players.forceEndMatch(
        this.deps.players.tick,
        this.match.enemyTeam,
        this.failEndOpts(),
      );
    }
    for (const ev of scores) {
      if (ev.team !== this.match.humanTeam) continue;
      const humanScore = this.deps.players.getScores()[this.match.humanTeam];
      const result = this.match.onHumanCapture(humanScore);
      if (result === "win") {
        return this.deps.players.forceEndMatch(
          this.deps.players.tick,
          this.match.humanTeam,
          this.winEndOpts(),
        );
      }
      const over = this.beginWave(this.match.wave);
      if (over) return over;
    }
    return null;
  }

  handleFailConditions(): GameOverPacket | null {
    if (!this.match || this.match.ended) return null;
    if (!this.match.started) {
      const startedOver = this.maybeStart();
      if (startedOver) return startedOver;
      if (this.match.started || this.match.ended) return null;
      const waiting = this.deps.players.humans().filter((p) =>
        p.team === this.match!.humanTeam
      );
      if (waiting.length === 0) {
        this.match.onEmpty();
        return this.deps.players.forceEndMatch(
          this.deps.players.tick,
          this.match.enemyTeam,
        );
      }
      if (this.match.startWaitElapsed()) this.kickPartyForLoadTimeout();
      return null;
    }
    const humans = this.deps.players.humans();
    const ours = humans.filter((p) => p.team === this.match!.humanTeam);
    if (ours.length === 0) {
      this.match.onEmpty();
      return this.deps.players.forceEndMatch(
        this.deps.players.tick,
        this.match.enemyTeam,
      );
    }
    if (this.match.allHumansDead(ours)) {
      this.match.onWipe();
      return this.deps.players.forceEndMatch(
        this.deps.players.tick,
        this.match.enemyTeam,
        this.failEndOpts(),
      );
    }
    if (this.deps.players.isMatchTimeExpired()) {
      this.match.onTimeout();
      return this.deps.players.forceEndMatch(
        this.deps.players.tick,
        this.match.enemyTeam,
        this.failEndOpts(),
      );
    }
    return null;
  }

  /**
   * Raid AFK accumulation, then the shared AFK kick. Called from stepSimBody
   * after connection timeouts and before team rebalance.
   */
  afkTick(nowMs: number): void {
    if (this.deps.players.isMatchOver()) return;
    const raidLive = Boolean(
      this.match?.started && !this.match.ended,
    );
    const raidTickMs = 1000 / TICK_HZ;
    for (const p of this.deps.players.humans()) {
      if (
        raidLive &&
        p.alive &&
        !p.connectionIssue &&
        p.isAfk(nowMs)
      ) {
        p.raidAfkAccumMs += raidTickMs;
        if (p.raidAfkAccumMs >= RAID_AFK_MAX_MS) {
          this.deps.kickForAfk(p);
          continue;
        }
      }
      if (this.match && !p.alive) continue;
      if (p.shouldKickForAfk(nowMs)) {
        this.deps.kickForAfk(p);
      }
    }
  }

  snapshotCredit(player: Player): void {
    if (!this.match || player.isBot || !player.accountUserId) return;
    this.credits.set(player.accountUserId, {
      clerkUserId: player.accountUserId,
      username: player.name,
      team: player.team,
      kills: player.kills,
      deaths: player.deaths,
      score: player.score,
    });
  }

  /** AFK-kicked raiders do not share a late win. */
  markPrizeIneligible(player: Player): void {
    if (this.match && player.accountUserId) {
      this.prizeIneligible.add(player.accountUserId);
    }
  }

  resetIdle(): void {
    if (!this.deps.isRaidRuntime()) return;
    this.match = null;
    this.pendingAgentEncounter = null;
    this.credits.clear();
    this.prizeIneligible.clear();
    this.loadedPlayerIds.clear();
    this.deps.bots.clearRaidBots();
    this.deps.bots.setRaidMode(true);
    this.deps.players.setRaidDoorPolicy("idle");
    this.deps.players.clearScheduledRestart();
    // Last party can leave during the win/fail sit. Clearing only the restart
    // timer left matchOver + gameOverSnapshot armed, so the next join walked
    // into an already-lost raid.
    this.deps.players.startNewMatch(this.deps.players.tick, Date.now());
  }

  /** Raid win/fail sit elapsed: boot remaining humans and idle the slot. */
  closeEnded(): void {
    for (const player of [...this.deps.players.humans()]) {
      this.deps.dismissHumanToMenu(player, {
        reason: "return_to_menu",
        message: "Returning to main menu.",
      });
    }
    this.resetIdle();
  }

  partyTimedOut(
    partyId: string | undefined,
    nowMs?: number,
  ): boolean {
    if (!partyId) return false;
    const now = nowMs ?? Date.now();
    const expiresAtMs = this.loadTimeoutParties.get(partyId);
    if (expiresAtMs == null) return false;
    if (expiresAtMs > now) return true;
    this.loadTimeoutParties.delete(partyId);
    return false;
  }

  /**
   * Full `RaidMatch` snapshot for recording (metadata/init) — genuine dynamic
   * sim state, not config: wave/started/ended/failReason change during
   * `stepSimBody` (`tickAgentEncounter` / `handleScores` /
   * `handleFailConditions`). `{ active: false }` off-raid, never `null`,
   * so this stays a load-bearing field without a special-cased presence check.
   * See notes/replay.md §29.2 item 2.
   */
  metadataState(): RaidMatchMetadataState {
    const raid = this.match;
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
  checkpointState(): CheckpointRaidState {
    const raid = this.match;
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
   * Raid game-over decoration. Returns null when no raid is live so the
   * caller can apply the release-lock and map-vote branches.
   */
  decorateGameOver(
    packet: GameOverPacket,
    xpMode: () => GameOverPacket["xpMode"],
  ): GameOverPacket | null {
    if (!this.match) return null;
    const mode = xpMode();
    const humanScore = packet.scores[this.match.humanTeam];
    const won = packet.winner === this.match.humanTeam;
    const remaining = Math.max(0, Math.ceil(packet.restartInSeconds || 0));
    return {
      ...packet,
      restartInSeconds: remaining > 0
        ? remaining
        : (won ? RAID_WIN_RETURN_SECONDS : RAID_FAIL_RETURN_SECONDS),
      returnToMenu: true,
      matchKind: "raid",
      raid: this.match.hud(humanScore),
      ...(mode ? { xpMode: mode } : {}),
    };
  }

  private kickPartyForLoadTimeout(nowMs: number = Date.now()): void {
    const humans = [...this.deps.players.humans()];
    const loaded = humans.filter((p) => this.loadedPlayerIds.has(p.id))
      .length;
    console.log(
      `[raid] load timeout: ${loaded}/${this.match?.expectedHumans ?? 0} ` +
        `loaded (${humans.length} connected); kicking party`,
    );
    for (const [partyId, expiresAtMs] of this.loadTimeoutParties) {
      if (expiresAtMs <= nowMs) this.loadTimeoutParties.delete(partyId);
    }
    for (const player of humans) {
      if (player.partyId) {
        this.loadTimeoutParties.set(
          player.partyId,
          nowMs + RAID_LOAD_TIMEOUT_PARTY_BLOCK_MS,
        );
      }
      this.deps.dismissHumanToMenu(player, {
        reason: "raid_load_timeout",
        message: "Raid cancelled: not everyone in your party loaded in time.",
      });
    }
    this.resetIdle();
  }

  private failEndOpts(): { scheduleRestart: true; restartSeconds: number } {
    return {
      scheduleRestart: true,
      restartSeconds: RAID_FAIL_RETURN_SECONDS,
    };
  }

  private winEndOpts(): { scheduleRestart: true; restartSeconds: number } {
    return {
      scheduleRestart: true,
      restartSeconds: RAID_WIN_RETURN_SECONDS,
    };
  }
}
