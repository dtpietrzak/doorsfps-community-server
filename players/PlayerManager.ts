import {
  normalizePlayerPartyId,
  normalizePlayerPartySize,
  Player,
  PLAYER_HEIGHT,
  type SpawnPose,
} from "./Player.ts";
import {
  directionFromYawPitch,
  hitscanPoses,
  normalize,
  type HitPose,
} from "../combat/hitscan.ts";
import {
  aimSpreadRad,
  spreadDirectionFromYawPitch,
} from "../combat/aimSpread.ts";
import {
  buildLagCompTicks,
  LAG_COMP_RTT_WINDOW,
  resolveLagCompWindow,
} from "../combat/lagComp.ts";
import {
  isSkillId,
  type SkillId,
  type SkillLoadout,
  type SkillProductId,
} from "../shared/sim/skills.ts";
import { rollDamageVariation } from "../shared/sim/game.ts";
import {
  createMatchSimRngStreams,
  generateMatchSeed,
  type MatchSimRngStreams,
} from "../shared/sim/simRng.ts";
import type {
  SimActionEffect,
  SimActionEffectObserver,
} from "./simActionEffect.ts";
import type { AuthoritativeCheckpoint } from "../replay/authoritativeCheckpoint.ts";
import { DEFAULT_OPEN_SEAT_RESERVATION_LEASE_MS } from "../shared/fleet/openPlacement.ts";
import {
  compareRebalanceGroupPreference,
  movingGroupImprovesBalance,
  pickTeamForGroupSize,
  runtimeMaxPartySize,
} from "../shared/social/partyTeamBalance.ts";
import {
  agentPlayerEquipment,
  AUTO_REBALANCE_MIN_HUMAN_DIFF,
  CONNECTION_ISSUE_TIMEOUT_MS,
  DOOR_CAPTURE_DWELL_TICKS,
  DOOR_FULL_CYCLE_TICKS,
  DOOR_OPEN_TICKS,
  DOOR_POWER_UP_TICKS,
  type DoorCycleState,
  type GameOverPacket,
  isWeaponId,
  MATCH_DURATION_SECONDS,
  MATCH_RESTART_SECONDS,
  type MatchClockState,
  type MatchPhase,
  type MatchStartPacket,
  type MeleePacket,
  type PlayerDiedPacket,
  type PlayerInput,
  playerNameKey,
  PREMATCH_CONFIG,
  RAID_RESPAWN_DELAY_TICKS,
  type PrematchStatePacket,
  RESPAWN_DELAY_CLOSED_TICKS,
  RESPAWN_DELAY_TICKS,
  SCORE_COOLDOWN_TICKS,
  type ScorePacket,
  SHOOT_ORIGIN_MAX_ERROR,
  type ShootPacket,
  type ShotFiredPacket,
  type ShotPellet,
  type SnapshotPacket,
  type SnapshotPlayerMode,
  type TeamId,
  type TeamScores,
  TICK_HZ,
  WIN_BY_MARGIN,
  WIN_SCORE,
} from "../protocol/network.ts";
import type { MapCollision } from "../world/MapCollision.ts";
import type { PlayerClipPose } from "../shared/sim/playerClip.ts";
import {
  clampHitDamage,
  HAWKEYES_PELLET_CONE_SCALE,
  shotBaseDamage,
} from "../shared/sim/weapons.ts";
import { pelletDirections } from "../shared/sim/pellets.ts";
import {
  normalizeAuthoritativeEvent,
  type AuthoritativeEvent,
  type AuthoritativeMapIdentity,
  type AuthoritativeRosterSnapshot,
} from "../shared/sim/authoritativeEvent.ts";
import {
  deriveAgentAdd,
  deriveAgentRemove,
  deriveConnectionStatus,
  deriveHumanJoin,
  deriveLoadoutCommit,
  deriveMatchConfig,
  deriveMatchDraw,
  deriveMatchEnd,
  deriveMatchInit,
  deriveMatchStart,
  derivePlayerRemove,
  deriveReadyVote,
  deriveReadyVoteClearAll,
  deriveTeamAssign,
} from "./authoritativeEventDerive.ts";

export type DamageOutcome = {
  targetId: string;
  shooterId: string;
  damage: number;
  health: number;
  zone: "head" | "body";
  alive: boolean;
  killed: boolean;
  critical: boolean;
  hitSlowStacks?: number;
  hitSlowEndsAtTick?: number;
};

export type ShootOutcome = {
  shot: ShotFiredPacket;
  /**
   * Damage events from this shot. Usually one (victim). Team hits also
   * append a second event for the same amount applied to the shooter.
   */
  damages?: DamageOutcome[];
  /** True when Leech passive healed the shooter from this shot. */
  leech?: boolean;
};

export type PlayerManagerOptions = {
  /** Live match length in seconds (default: shared MATCH_DURATION_SECONDS). */
  matchDurationSeconds?: number;
  /**
   * Initial wall-clock timestamp for non-simulation participation metadata.
   * This never affects tick advancement or gameplay rules.
   */
  nowMs?: number;
  /**
   * Ranked servers: start in pre-match warm-up (doors locked, vote-to-start).
   * Community / open servers leave this false and begin live immediately.
   */
  enablePrematch?: boolean;
  /**
   * Injectable damage-domain RNG (epic 4.6). Live default is the match
   * `damage` stream. When set without {@link spreadRandom}, spread also uses
   * this override (4.4 single-stream test compat).
   * Per-shot order: spread → damage → raid-scale (melee: damage → raid-scale);
   * raid-scale is drawn only for raid-bot attackers.
   */
  damageRandom?: () => number;
  /**
   * Injectable spread-domain RNG. Live default is the match `spread` stream.
   * Omit to share {@link damageRandom} when that override is set.
   */
  spreadRandom?: () => number;
  /**
   * Per-match sim RNG seed (epic 4.6). When omitted, a crypto seed is
   * generated at construct / reseed. Exposed for later recording (#8) — not
   * persisted here.
   */
  matchSeed?: number;
};

/**
 * Raid bots (wave / boss characters) deal 10–20% of rolled damage — the only
 * sim rule keyed on a bot role (the keys-only note). Arena bots are
 * plain players: full damage, no extra draw.
 */
function scaleRaidBotDamage(damage: number, rawSample: number): number {
  const sample = Number.isFinite(rawSample)
    ? Math.max(0, Math.min(1, rawSample))
    : 0.5;
  return Math.round(damage * (0.1 + sample * 0.1));
}

export class PlayerManager {
  /** Stable session id → player (id does not change on reconnect). */
  private readonly players = new Map<string, Player>();
  /** Live socket.id → stable player id (absent while connection-issue). */
  private readonly socketToPlayer = new Map<string, string>();
  /**
   * Cached roster array for hot paths (bot AI). Rebuilt on add/remove only —
   * avoids `[...players.all()]` every sim tick.
   */
  private rosterCache: Player[] = [];
  private rosterCacheDirty = true;
  private collision: MapCollision;
  private scores: TeamScores = { A: 0, B: 0 };
  /** Last sim tick advanced by update(); used to stamp mid-tick events (e.g. shoot). */
  private simTick = 0;
  /**
   * Drainable buffer of normalized authoritative events (replay epic 5.5).
   * Mutations push here; epic 7.3 clears via `drainTickAuthoritativeEvents`
   * each driver tick (result unused by live play). 7.5/8.4 consume that
   * unified list — never this buffer alone.
   */
  private authoritativeEvents: AuthoritativeEvent[] = [];
  /**
   * Optional 8.3 action-effect observer (set only while a 7.5 replay sink is
   * attached). Notes fire at the handle* seam so humans and bots share one tap.
   */
  private actionEffectObserver: SimActionEffectObserver | null = null;
  /** Last pose-snapshot tick actually emitted (20 Hz grid or reliable keyframe). */
  public lastSnapshotTick = 0;
  /** Host total rewind-window clamps (hitch HUD). */
  public rewindClampTotal = 0;
  /** True after a team wins until the automatic match restart. */
  private matchOver = false;
  /** Sim tick when the next match should begin (only set while matchOver). */
  private restartAtTick: number | null = null;
  /** Frozen end-of-match payload for late joiners. */
  private gameOverSnapshot: GameOverPacket | null = null;
  /**
   * Sim tick when the current door cycle began (doors open).
   * Reset on each new match so every game starts with open doors.
   */
  private doorCycleOriginTick = 0;
  /**
   * While set, doors stay closed until this tick (post-agent power-up), then
   * a fresh open phase starts at that tick. Null when not powering.
   */
  private doorsPowerUpUntilTick: number | null = null;
  /**
   * Admin yaw-dot / bot-test debug: when true, doors stay open through every
   * phase (prematch, agents, power-up, closed cycle) so bots keep moving.
   * Sticky until toggled off; does not clear on match restart.
   */
  private debugForceDoorsOpen = false;
  /** Co-op raid: idle locks doors; open is only interrupted by scripted agents. */
  private raidDoorPolicy: "off" | "idle" | "open" = "off";
  /** Full match length in sim ticks (from host config). Restored by 9.3. */
  private matchDurationTicks: number;
  /**
   * Sim tick when the current match time limit expires.
   * Reset on each new match (default: full duration from tick 0).
   */
  private matchEndTick: number;
  /** When true, ranked pre-match lobby rules apply between matches. */
  private readonly prematchEnabled: boolean;
  /**
   * True while ranked session is in pre-match (warm-up). False for open servers
   * and after unanimous ready starts a live match.
   */
  private inPrematch: boolean;
  /** Human player ids that have voted ready (only meaningful in prematch). */
  private readonly readyVotes = new Set<string>();
  /**
   * True after the first human abandon voids a live ranked match.
   * Cleared when a new prematch/live session begins.
   * Remaining players may leave without further ranking penalties.
   */
  private liveMatchVoided = false;
  /** Stable session id of the human who first abandoned (if any). */
  private abandonedByPlayerId: string | null = null;
  /**
   * Wall-clock when the current live match began (`beginLiveMatch`).
   * Null during prematch / intermission / before first live start.
   */
  private liveStartedAtMs: number | null = null;
  /** Damage-domain draws (and legacy shared override when spreadRandom omitted). */
  private readonly damageRandom: () => number;
  /** Spread-domain draws on the authoritative shoot path. */
  private readonly spreadRandom: () => number;
  /**
   * Per-match seed + domain streams (epic 4.6). Combat uses damage/spread
   * streams; spawn/agents wire in Chunk 4.
   */
  private matchSeed: number;
  private simRng: MatchSimRngStreams;
  private simRngReseedListener:
    | ((matchSeed: number, streams: MatchSimRngStreams) => void)
    | null = null;

  constructor(collision: MapCollision, options?: PlayerManagerOptions) {
    this.collision = collision;
    const seconds = options?.matchDurationSeconds ?? MATCH_DURATION_SECONDS;
    this.matchDurationTicks = Math.max(1, Math.ceil(seconds * TICK_HZ));
    this.matchEndTick = this.matchDurationTicks;
    this.prematchEnabled = options?.enablePrematch === true;
    this.inPrematch = this.prematchEnabled;
    // Match seed first so domain-stream closures close over a live simRng.
    this.matchSeed = 0;
    this.simRng = createMatchSimRngStreams(0);
    this.reseedSimRng(options?.matchSeed);
    // Live defaults: per-domain match streams. damageRandom-only override also
    // feeds spread (4.4 single-injectable test compat).
    const damageOverride = options?.damageRandom;
    this.damageRandom = damageOverride ?? (() => this.simRng.damage());
    this.spreadRandom = options?.spreadRandom ?? damageOverride ??
      (() => this.simRng.spread());
    // Prematch: freeze the clock far ahead so time-limit checks never fire.
    if (this.inPrematch) {
      this.matchEndTick = Number.MAX_SAFE_INTEGER;
    } else {
      // Open / non-ranked: already live from boot (no vote-to-start).
      // This is participation metadata, not simulation state.
      this.liveStartedAtMs = options?.nowMs ?? Date.now();
    }
  }

  /** Per-match sim RNG seed (future #8 initial-state field). */
  public getMatchSeed(): number {
    return this.matchSeed;
  }

  /**
   * Epic 7.4 — door-cycle origin tick owned by lifecycle starts.
   * Read-only for match metadata; never a second mutable store.
   */
  public getDoorCycleOriginTick(): number {
    return this.doorCycleOriginTick;
  }

  /** Epic 7.4 — configured match length in sim ticks (constructor owner). */
  public getMatchDurationTicks(): number {
    return this.matchDurationTicks;
  }

  /** Epic 7.4 — current raid door policy (matchConfig owner). */
  public getRaidDoorPolicy(): "off" | "idle" | "open" {
    return this.raidDoorPolicy;
  }

  /** Epic 9.1 — raw prematch flag (not combined with matchOver). */
  public getInPrematchFlag(): boolean {
    return this.inPrematch;
  }

  /** Epic 9.1 — scheduled restart tick while matchOver, else null. */
  public getRestartAtTick(): number | null {
    return this.restartAtTick;
  }

  /** Epic 9.1 — post-agent door power-up hold end tick, else null. */
  public getDoorsPowerUpUntilTick(): number | null {
    return this.doorsPowerUpUntilTick;
  }

  /** Epic 9.1 — admin/debug force-doors-open override. */
  public getDebugForceDoorsOpen(): boolean {
    return this.debugForceDoorsOpen;
  }

  /**
   * Epic 9.3 — restore match/RNG/roster/tick from a frozen checkpoint.
   * Called only by `loadCheckpointState` after anchor validation.
   * Clear-first, event-free, no `update()`, no RNG draws/reseeds.
   */
  public restoreFromCheckpoint(
    checkpoint: AuthoritativeCheckpoint,
    names: ReadonlyMap<string, string> = new Map(),
  ): void {
    const match = checkpoint.match;

    // Match block (owner writes).
    this.scores = { A: match.scores.A, B: match.scores.B };
    this.matchOver = match.matchOver;
    this.inPrematch = match.inPrematch;
    this.restartAtTick = match.restartAtTick;
    this.doorCycleOriginTick = match.doorCycleOriginTick;
    this.doorsPowerUpUntilTick = match.doorsPowerUpUntilTick;
    this.raidDoorPolicy = match.raidDoorPolicy;
    this.debugForceDoorsOpen = match.debugForceDoorsOpen;
    this.matchEndTick = match.matchEndTick;
    this.matchDurationTicks = match.matchDurationTicks;
    // Egress / lobby scratch — not in the frame; must not leak across loads.
    this.gameOverSnapshot = null;
    this.readyVotes.clear();
    this.liveMatchVoided = false;
    this.abandonedByPlayerId = null;

    // RNG words via setState only (no reseed, no draws).
    this.matchSeed = checkpoint.matchSeed;
    const streams = this.simRng;
    streams.damage.setState(checkpoint.rng.damage);
    streams.spread.setState(checkpoint.rng.spread);
    streams.spawn.setState(checkpoint.rng.spawn);
    streams.agents.setState(checkpoint.rng.agents);
    this.collision.setSpawnRngState(checkpoint.rng.collisionSpawn);

    // Roster: clear-first, event-free insert (dead + agents verbatim).
    this.players.clear();
    this.socketToPlayer.clear();
    this.invalidateRosterCache();
    for (const row of checkpoint.players) {
      const name = names.get(row.id) ?? row.id;
      const player = new Player(row.id, name, row.team, {
        isBot: row.isBot,
        isAgent: row.isAgent,
        maxHealth: row.maxHealth,
        equipment: row.equipment,
        ...(row.ownedAbilities !== undefined
          ? { ownedAbilities: row.ownedAbilities }
          : {}),
        ...(row.skillLoadout !== undefined
          ? { skillLoadout: row.skillLoadout }
          : {}),
      });
      player.restoreFromCheckpoint(row);
      this.players.set(player.id, player);
      if (!player.isBot && player.socketId) {
        this.socketToPlayer.set(player.socketId, player.id);
      }
    }
    this.invalidateRosterCache();

    // Tick stamp + buffer / per-tick scratch clear.
    this.simTick = checkpoint.tick;
    this.authoritativeEvents = [];
    shootSeenScratch.clear();
  }

  /**
   * Replay-only roster insert: place a recorded snapshot at its pose.
   * Event-free, no spawn RNG. Agents keep isAgent for grey-dome render;
   * fill-bot identity is never reconstructed (everyone else is a player).
   */
  public insertFromAuthoritativeRoster(
    entry: AuthoritativeRosterSnapshot,
  ): Player {
    const existing = this.players.get(entry.id);
    if (existing) {
      this.applyAuthoritativeRosterPose(entry);
      return existing;
    }

    const isAgent = entry.isAgent === true;
    const player = new Player(entry.id, entry.name, entry.team, {
      // Roster/checkpoint `isBot` is the raid-bot role (see
      // rosterSnapshotFromPlayer); `Player.isBot` (non-sim bookkeeping) comes
      // from isAgent here — arena fill bots reconstruct as plain players.
      isBot: isAgent,
      isAgent,
      isBalanceBot: false,
      isRaidBot: entry.isBot === true,
      maxHealth: entry.maxHealth,
      modelScale: entry.modelScale,
      moveSpeedScale: entry.moveSpeedScale,
      equipment: isAgent ? agentPlayerEquipment() : entry.equipment,
      ...(entry.ownedAbilities !== undefined
        ? { ownedAbilities: entry.ownedAbilities }
        : {}),
      ...(entry.skillLoadout !== undefined
        ? { skillLoadout: entry.skillLoadout }
        : {}),
    });
    player.applySpawn(
      {
        x: entry.pose.x,
        y: entry.pose.y,
        z: entry.pose.z,
        yaw: entry.pose.yaw,
        pitch: entry.pose.pitch,
      },
      this.simTick,
    );
    player.unlimitedAmmo = entry.unlimitedAmmo || isAgent;
    if (entry.connectionIssue) {
      player.markConnectionIssue(Number.MAX_SAFE_INTEGER);
    }
    if (!entry.alive) {
      player.alive = false;
      player.health = 0;
    }
    this.players.set(player.id, player);
    if (!player.isBot && player.socketId) {
      this.socketToPlayer.set(player.socketId, player.id);
    }
    this.invalidateRosterCache();
    return player;
  }

  /** Move/update an existing replay roster row to a recorded pose (no RNG). */
  public applyAuthoritativeRosterPose(
    entry: AuthoritativeRosterSnapshot,
  ): void {
    const player = this.players.get(entry.id);
    if (!player) {
      this.insertFromAuthoritativeRoster(entry);
      return;
    }
    player.team = entry.team;
    player.applySpawn(
      {
        x: entry.pose.x,
        y: entry.pose.y,
        z: entry.pose.z,
        yaw: entry.pose.yaw,
        pitch: entry.pose.pitch,
      },
      this.simTick,
    );
    player.unlimitedAmmo = entry.unlimitedAmmo || player.isAgent;
    if (!entry.alive) {
      player.alive = false;
      player.health = 0;
    }
  }

  /**
   * Push a normalized authoritative event into the drainable buffer.
   * Invalid / null events are dropped. Does not affect live sim behavior.
   */
  private recordAuthoritativeEvent(
    event: AuthoritativeEvent | null | undefined,
  ): void {
    if (!event) return;
    const normalized = normalizeAuthoritativeEvent(event);
    if (normalized) this.authoritativeEvents.push(normalized);
  }

  /**
   * Drain and clear buffered authoritative events (7.5 / 8.4 handoff).
   * Returns events in construction order; callers may
   * `sortAuthoritativeEvents` for canonical same-tick order.
   */
  public drainAuthoritativeEvents(): AuthoritativeEvent[] {
    const out = this.authoritativeEvents;
    this.authoritativeEvents = [];
    return out;
  }

  /** Peek without clearing (tests / diagnostics). */
  public peekAuthoritativeEvents(): readonly AuthoritativeEvent[] {
    return this.authoritativeEvents;
  }

  /**
   * Unbuffered match-init snapshot (epic 5.5; 8.2 / 11.1 shape).
   * Does not push to the buffer — caller decides when to record.
   * Epic 7.4 metadata reads map/seed/config/roster through this derivation —
   * never a second map registry.
   */
  public buildMatchInitEvent(
    appliedTick: number = this.simTick,
  ): AuthoritativeEvent {
    const map = this.collision.map;
    const mapId: AuthoritativeMapIdentity = {
      name: map.name,
      version: map.version,
    };
    return deriveMatchInit(appliedTick, {
      map: mapId,
      matchSeed: this.matchSeed,
      matchDurationTicks: this.matchDurationTicks,
      prematchEnabled: this.prematchEnabled,
      phase: this.getMatchPhase(),
      raidDoorPolicy: this.raidDoorPolicy,
      debugForceDoorsOpen: this.debugForceDoorsOpen,
      scores: this.getScores(),
      roster: [...this.players.values()],
    });
  }

  /** Domain streams for the current match seed (tests / later wiring). */
  public getSimRngStreams(): MatchSimRngStreams {
    return this.simRng;
  }

  /**
   * Notify non-PlayerManager sim RNG consumers (e.g. BotManager agents stream)
   * when the match seed is reseeded. GameServer registers this after construct.
   */
  public setSimRngReseedListener(
    listener:
      | ((matchSeed: number, streams: MatchSimRngStreams) => void)
      | null,
  ): void {
    this.simRngReseedListener = listener;
  }

  /**
   * Reseed all domain streams from `seed` (or a fresh crypto seed). Called on
   * construct and every match start / restart. Also reseeds MapCollision spawn.
   */
  public reseedSimRng(seed?: number): void {
    const next = seed !== undefined ? seed : generateMatchSeed();
    this.simRng = createMatchSimRngStreams(next);
    this.matchSeed = this.simRng.matchSeed;
    this.collision.reseedSpawnRng(this.simRng.spawn);
    this.simRngReseedListener?.(this.matchSeed, this.simRng);
  }

  /** Swap the active map collision (host map change). Spawns use the new map. */
  public setCollision(collision: MapCollision): void {
    this.collision = collision;
    // New collision must inherit the current match spawn stream (no history leak
    // from the previous map's process-lifetime RNG).
    this.collision.reseedSpawnRng(this.simRng.spawn);
  }

  /** Re-seat living raid players after an in-raid map transition. */
  public relocateRaidSurvivors(tick: number): Player[] {
    const moved: Player[] = [];
    for (const player of this.players.values()) {
      if (!player.alive || player.isAgent) continue;
      const home = this.spawnFor(player.team);
      player.sendHomeAfterScore(
        {
          x: home.x,
          y: home.y,
          z: home.z,
          yaw: home.yaw,
          pitch: player.pitch,
        },
        tick,
      );
      moved.push(player);
    }
    return moved;
  }

  /** Active map collision (bots / queries). */
  public getCollision(): MapCollision {
    return this.collision;
  }

  public get size(): number {
    return this.players.size;
  }

  /** Current sim tick (updated each loop step). */
  public get tick(): number {
    return this.simTick;
  }

  public getScores(): TeamScores {
    return { ...this.scores };
  }

  /**
   * Lobby/browse ranking: doors + max(0, kills − deaths).
   * KD contribution never goes negative.
   */
  public static playerRating(
    kills: number,
    score: number,
    deaths: number,
  ): number {
    return score + Math.max(0, kills - deaths);
  }

  /**
   * Condensed roster for browse /api/status leaderboard.
   * Sorted by doors (score), then kills, then name within each team.
   */
  public getStatusBoard(): Array<{
    name: string;
    team: TeamId;
    kills: number;
    deaths: number;
    score: number;
    isBot: boolean;
  }> {
    const rows: Array<{
      name: string;
      team: TeamId;
      kills: number;
      deaths: number;
      score: number;
      isBot: boolean;
    }> = [];
    for (const p of this.players.values()) {
      rows.push({
        name: p.name,
        team: p.team,
        kills: p.kills,
        deaths: p.deaths,
        score: p.score,
        isBot: p.isBot,
      });
    }
    rows.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      if (a.kills !== b.kills) return b.kills - a.kills;
      if (a.deaths !== b.deaths) return a.deaths - b.deaths;
      return a.name.localeCompare(b.name);
    });
    return rows;
  }

  /**
   * Highest-rated connected player for /api/status (or null if empty).
   * Ties break on kills, then score, then name.
   */
  public getTopPlayer(): {
    id: string;
    name: string;
    team: TeamId;
    kills: number;
    deaths: number;
    score: number;
    rating: number;
    isBot: boolean;
  } | null {
    let best: {
      id: string;
      name: string;
      team: TeamId;
      kills: number;
      deaths: number;
      score: number;
      rating: number;
      isBot: boolean;
    } | null = null;

    for (const p of this.players.values()) {
      const rating = PlayerManager.playerRating(p.kills, p.score, p.deaths);
      const row = {
        id: p.id,
        name: p.name,
        team: p.team,
        kills: p.kills,
        deaths: p.deaths,
        score: p.score,
        rating,
        isBot: p.isBot,
      };
      if (!best) {
        best = row;
        continue;
      }
      if (rating > best.rating) {
        best = row;
        continue;
      }
      if (rating < best.rating) continue;
      if (p.kills > best.kills) {
        best = row;
        continue;
      }
      if (p.kills < best.kills) continue;
      if (p.score > best.score) {
        best = row;
        continue;
      }
      if (p.score < best.score) continue;
      if (p.name.localeCompare(best.name) < 0) best = row;
    }
    return best;
  }

  public isMatchOver(): boolean {
    return this.matchOver;
  }

  /** Whether this manager was constructed with ranked pre-match enabled. */
  public isPrematchEnabled(): boolean {
    return this.prematchEnabled;
  }

  /** True during ranked warm-up lobby (doors locked, unscored, vote-to-start). */
  public isPrematch(): boolean {
    return this.inPrematch && !this.matchOver;
  }

  /** True during a scored live match (not prematch, not intermission). */
  public isLive(): boolean {
    return !this.matchOver && !this.inPrematch;
  }

  /**
   * True after the first human abandon during a live match.
   * Subsequent leaves are free (no second no_score report).
   */
  public isLiveMatchVoided(): boolean {
    return this.liveMatchVoided;
  }

  /** Stable id of the first abandoner, or null. */
  public getAbandonedByPlayerId(): string | null {
    return this.abandonedByPlayerId;
  }

  /**
   * Mark the current live match as voided by `leaverId`.
   * Returns true only on the first void (caller should report to authority once).
   * No-op when not live or already voided.
   */
  public markLiveMatchVoided(leaverId: string): boolean {
    if (!this.isLive()) return false;
    if (this.liveMatchVoided) return false;
    this.liveMatchVoided = true;
    this.abandonedByPlayerId = leaverId;
    return true;
  }

  private clearLiveMatchVoid(): void {
    this.liveMatchVoided = false;
    this.abandonedByPlayerId = null;
  }

  /**
   * Epic 7.2 — single phase reader for the match lifecycle boundary.
   * Closed set: prematch | live | intermission (drain hold stays intermission).
   * Writers of matchOver / inPrematch are only endMatch / enterPrematch /
   * beginLiveMatch (+ construct). See notes/replay/07-server-responsibilities/
   * 07-02-match-lifecycle-boundary.md.
   */
  public getMatchPhase(): MatchPhase {
    if (this.matchOver) return "intermission";
    if (this.inPrematch) return "prematch";
    return "live";
  }

  /**
   * Authoritative door phase at `tick`. Starts open at origin, then alternates
   * open (DOOR_OPEN_TICKS) and closed (DOOR_CLOSED_TICKS).
   * During pre-match, doors stay forced closed.
   * While grey agents are alive, doors stay sealed. After the last agent dies,
   * {@link DOOR_POWER_UP_TICKS} of closed "powering" then a fresh open phase.
   * Admin debug ({@link setDebugForceDoorsOpen}) overrides all of the above.
   */
  public getDoorCycleState(tick: number = this.simTick): DoorCycleState {
    // Precedence is part of the rules contract: debug override, raid policy,
    // prematch lock, agent seal, power-up hold, then the normal cycle.
    // Admin bot-test / yaw-dot debug: never close doors.
    if (this.debugForceDoorsOpen) {
      return {
        doorsOpen: true,
        doorChangeTick: tick + this.matchDurationTicks,
      };
    }
    if (this.raidDoorPolicy === "open") {
      if (this.agentCount() > 0) {
        return {
          doorsOpen: false,
          doorChangeTick: tick + this.matchDurationTicks,
        };
      }
      if (this.doorsPowerUpUntilTick !== null) {
        if (tick < this.doorsPowerUpUntilTick) {
          return {
            doorsOpen: false,
            doorChangeTick: this.doorsPowerUpUntilTick,
          };
        }
        this.doorsPowerUpUntilTick = null;
      }
      return {
        doorsOpen: true,
        doorChangeTick: tick + this.matchDurationTicks,
      };
    }
    if (this.raidDoorPolicy === "idle") {
      return {
        doorsOpen: false,
        doorChangeTick: tick + this.matchDurationTicks,
      };
    }
    if (this.isPrematch() && PREMATCH_CONFIG.doorsLockedClosed) {
      // Far-future change tick so the client timer does not count down to open.
      return {
        doorsOpen: false,
        doorChangeTick: tick + this.matchDurationTicks,
      };
    }
    // Agents in the field: stay closed (no open countdown).
    if (this.agentCount() > 0) {
      return {
        doorsOpen: false,
        doorChangeTick: tick + this.matchDurationTicks,
      };
    }
    // Post-agent power-up: closed until doorsPowerUpUntilTick, then open.
    if (this.doorsPowerUpUntilTick !== null) {
      if (tick < this.doorsPowerUpUntilTick) {
        return {
          doorsOpen: false,
          doorChangeTick: this.doorsPowerUpUntilTick,
        };
      }
      // Power-up finished — open phase originates at the scheduled open tick.
      this.doorCycleOriginTick = this.doorsPowerUpUntilTick;
      this.doorsPowerUpUntilTick = null;
    }
    return doorCycleAt(tick, this.doorCycleOriginTick);
  }

  public setRaidDoorPolicy(policy: "off" | "idle" | "open"): void {
    this.raidDoorPolicy = policy;
    this.recordAuthoritativeEvent(
      deriveMatchConfig(this.simTick, { raidDoorPolicy: policy }),
    );
  }

  /** True when captures are allowed. */
  public areDoorsOpen(tick: number = this.simTick): boolean {
    return this.getDoorCycleState(tick).doorsOpen;
  }

  /**
   * Admin debug: force doors open (no closed cycle / agent seal / power-up).
   * Used by yaw-dot (Y) mode so bots keep moving during nav tests.
   */
  public setDebugForceDoorsOpen(on: boolean): boolean {
    this.debugForceDoorsOpen = on;
    this.recordAuthoritativeEvent(
      deriveMatchConfig(this.simTick, { debugForceDoorsOpen: on }),
    );
    return this.debugForceDoorsOpen;
  }

  /** Toggle {@link setDebugForceDoorsOpen}; returns the new value. */
  public toggleDebugForceDoorsOpen(): boolean {
    return this.setDebugForceDoorsOpen(!this.debugForceDoorsOpen);
  }

  public isDebugForceDoorsOpen(): boolean {
    return this.debugForceDoorsOpen;
  }

  /**
   * After the last grey agent dies: keep doors closed for
   * {@link DOOR_POWER_UP_TICKS}, then open a fresh open phase.
   */
  public reopenDoorsAfterAgentsCleared(tick: number): void {
    if (this.isPrematch() || this.matchOver) return;
    if (this.agentCount() > 0) return;
    this.doorsPowerUpUntilTick = tick + DOOR_POWER_UP_TICKS;
  }

  /** Clear agent power-up hold (new match / prematch). */
  private clearDoorPowerUp(): void {
    this.doorsPowerUpUntilTick = null;
  }

  /** Match clock: when the 15-minute limit ends. */
  public getMatchClockState(): MatchClockState {
    return { matchEndTick: this.matchEndTick };
  }

  /** Arm the live clock from this tick (raid duration override). */
  public setMatchClock(tick: number, durationSeconds: number): void {
    const seconds = Math.max(1, Math.floor(durationSeconds));
    this.matchEndTick = tick + Math.max(1, Math.ceil(seconds * TICK_HZ));
  }

  public isMatchTimeExpired(tick: number = this.simTick): boolean {
    if (this.matchOver || this.inPrematch) return false;
    return tick >= this.matchEndTick;
  }

  /**
   * Browse/status helper: seconds left on the match clock, or intermission
   * countdown after game over.
   */
  public getMatchTimeStatus(tick: number = this.simTick): {
    matchOver: boolean;
    /** Seconds remaining in the live match (0 when over / expired / prematch). */
    matchSecondsRemaining: number;
    /** Seconds until next match when in intermission; null while live/prematch. */
    restartSecondsRemaining: number | null;
    phase: MatchPhase;
  } {
    if (this.matchOver) {
      return {
        matchOver: true,
        matchSecondsRemaining: 0,
        restartSecondsRemaining: this.restartSecondsRemaining(tick),
        phase: "intermission",
      };
    }
    if (this.inPrematch) {
      return {
        matchOver: false,
        matchSecondsRemaining: 0,
        restartSecondsRemaining: null,
        phase: "prematch",
      };
    }
    const ticksLeft = Math.max(0, this.matchEndTick - tick);
    return {
      matchOver: false,
      matchSecondsRemaining: Math.max(0, Math.ceil(ticksLeft / TICK_HZ)),
      restartSecondsRemaining: null,
      phase: "live",
    };
  }

  /**
   * Live game-over payload with remaining restart countdown, or null if the
   * match is still in progress.
   */
  public getGameOverForJoin(): GameOverPacket | null {
    if (!this.matchOver || !this.gameOverSnapshot) return null;
    return {
      ...this.gameOverSnapshot,
      restartInSeconds: this.restartSecondsRemaining(this.simTick),
    };
  }

  private restartSecondsRemaining(tick: number): number {
    if (this.restartAtTick === null) return 0;
    const ticksLeft = Math.max(0, this.restartAtTick - tick);
    return Math.max(0, Math.ceil(ticksLeft / TICK_HZ));
  }

  /** Drop a scheduled rematch / return-to-menu so the tick loop stops firing. */
  public clearScheduledRestart(): void {
    this.restartAtTick = null;
  }

  /** Count of living + dead players currently on each team. */
  public teamCounts(): { A: number; B: number } {
    let A = 0;
    let B = 0;
    for (const p of this.players.values()) {
      // Grey agents are free-for-all and never count toward A/B balance.
      if (p.isAgent) continue;
      if (p.team === "A") A++;
      else B++;
    }
    return { A, B };
  }

  /** Humans + team bots only (excludes grey agents). Used for join capacity. */
  public nonAgentCount(): number {
    let n = 0;
    for (const p of this.players.values()) {
      if (!p.isAgent) n++;
    }
    return n;
  }

  /** Living + dead grey agent bots. */
  public agentCount(): number {
    let n = 0;
    for (const p of this.players.values()) {
      if (p.isAgent) n++;
    }
    return n;
  }

  /** Count of human (non-bot) players on each team. */
  public humanTeamCounts(): { A: number; B: number } {
    let A = 0;
    let B = 0;
    for (const p of this.players.values()) {
      if (p.isBot) continue;
      if (p.team === "A") A++;
      else B++;
    }
    return { A, B };
  }

  /**
   * Humans + official pool pawns per team (open-match "real players").
   * Excludes community fill bots, balance bot, and agents.
   * Used for join team pick and voted rebalance — not for autofill quotas.
   */
  public matchPlayerTeamCounts(): { A: number; B: number } {
    let A = 0;
    let B = 0;
    for (const p of this.players.values()) {
      if (!p.isMatchPlayer()) continue;
      if (p.team === "A") A++;
      else B++;
    }
    return { A, B };
  }

  /** Humans + official pool pawns currently on the roster. */
  public matchPlayerCount(): number {
    let n = 0;
    for (const p of this.players.values()) {
      if (p.isMatchPlayer()) n++;
    }
    return n;
  }

  /**
   * Team for a new bot: fewer total players (humans + bots).
   * Tie → Team A (stable default).
   */
  public pickBalancedTeam(): TeamId {
    const { A, B } = this.teamCounts();
    if (B < A) return "B";
    return "A";
  }

  /**
   * Whether an open-match human may switch to `toTeam` under the balance rules:
   * - Target team currently has fewer total players (humans + bots), or
   * - Still within the bot auto-fill regime (`humanCount < autofillBots`) so
   *   bots can rebalance after the flip (move/spawn).
   *
   * `autofillBots` is the desired total humans+bots fill target (0 = no bot fill).
   * Normal open lobbies sit *at* the fill cap (e.g. 1 human + 3 bots = 4) —
   * that still counts as within threshold because bots are filling slots.
   */
  public canChangeTeam(
    playerId: string,
    toTeam: TeamId,
    autofillBots: number,
  ): { ok: true } | { ok: false; error: string } {
    const player = this.players.get(playerId);
    if (!player || player.isBot) {
      return { ok: false, error: "Not in match." };
    }
    if (player.connectionIssue) {
      return { ok: false, error: "Reconnect before changing teams." };
    }
    // Active open-party session: refuse solo switches so cohesion cannot split.
    if (player.partyId) {
      return {
        ok: false,
        error: "Party members cannot switch teams while the party is active.",
      };
    }
    if (toTeam !== "A" && toTeam !== "B") {
      return { ok: false, error: "Invalid team." };
    }
    if (player.team === toTeam) {
      return { ok: false, error: "Already on that team." };
    }

    const counts = this.teamCounts();
    const fromCount = player.team === "A" ? counts.A : counts.B;
    const toCount = toTeam === "A" ? counts.A : counts.B;
    if (toCount < fromCount) return { ok: true };

    // Bot-fill regime: humans still below the autofill target (bots occupy the
    // rest). Allows switches even when the roster is already at total capacity.
    const fill = Math.max(0, Math.floor(autofillBots));
    if (fill > 0 && this.humanCount() < fill) return { ok: true };

    if (toCount > fromCount) {
      return {
        ok: false,
        error: "Join the smaller team, or wait until bots can rebalance.",
      };
    }
    return {
      ok: false,
      error:
        "Teams are even — only the smaller team can be joined when full of humans.",
    };
  }

  /**
   * Switch a human to the other team (or an explicit `team`), respawning them
   * on the new side. Caller should rebalance bots + reconcile fill after success.
   * Open-match only — GameServer gates ranked.
   */
  public changeTeam(
    playerId: string,
    opts: { autofillBots: number; team?: TeamId },
  ):
    | { ok: true; player: Player; from: TeamId; to: TeamId }
    | { ok: false; error: string } {
    const player = this.players.get(playerId);
    if (!player || player.isBot) {
      return { ok: false, error: "Not in match." };
    }
    const to: TeamId = opts.team === "A" || opts.team === "B"
      ? opts.team
      : player.team === "A"
      ? "B"
      : "A";
    const allowed = this.canChangeTeam(playerId, to, opts.autofillBots);
    if (!allowed.ok) return allowed;

    const from = player.team;
    player.team = to;
    player.respawn(this.spawnFor(to), this.simTick);
    this.recordAuthoritativeEvent(
      deriveTeamAssign(this.simTick, player, {
        reason: "switch",
        from,
        to,
      }),
    );
    return { ok: true, player, from, to };
  }

  /**
   * True when match-player teams (humans + pool pawns) differ by at least
   * {@link AUTO_REBALANCE_MIN_HUMAN_DIFF}. Community/balance bots ignored.
   * Caller gates ranked + match phase.
   */
  public needsHumanRebalance(
    minDiff = AUTO_REBALANCE_MIN_HUMAN_DIFF,
  ): boolean {
    const { A, B } = this.matchPlayerTeamCounts();
    return Math.abs(A - B) >= minDiff;
  }

  /**
   * Heavy/light match-player sides when rebalance is needed, else null.
   */
  public humanRebalanceSides(
    minDiff = AUTO_REBALANCE_MIN_HUMAN_DIFF,
  ): { heavy: TeamId; light: TeamId } | null {
    const { A, B } = this.matchPlayerTeamCounts();
    if (Math.abs(A - B) < minDiff) return null;
    if (A > B) return { heavy: "A", light: "B" };
    return { heavy: "B", light: "A" };
  }

  /**
   * Pick the worst match player on `heavy` for voted rebalance
   * (real humans + official pool pawns).
   * Prefers AFK, then lowest scoreboard rating, then fewer kills, more deaths, name.
   * Skips community/balance bots, agents, and connection-issue humans.
   *
   * When `opts.soloOnly` is true (default for group-aware callers), skips any
   * human who still has an active multi-member party on this team so cohesion
   * is preserved. Prefer {@link pickGroupForRebalance} for the full path.
   */
  public pickWorstHumanForRebalance(
    heavy: TeamId,
    opts?: {
      excludeIds?: ReadonlySet<string> | readonly string[];
      /** When true, only size-1 groups (solos + seeds + lone party members). */
      soloOnly?: boolean;
    },
  ): Player | null {
    const exclude = opts?.excludeIds
      ? opts.excludeIds instanceof Set
        ? opts.excludeIds
        : new Set(opts.excludeIds)
      : null;
    const soloOnly = opts?.soloOnly === true;

    let best: Player | null = null;
    let bestAfk = false;
    let bestRating = Infinity;
    let bestKills = Infinity;
    let bestDeaths = -Infinity;

    for (const p of this.players.values()) {
      if (!p.isMatchPlayer() || p.team !== heavy) continue;
      if (p.connectionIssue) continue;
      if (exclude?.has(p.id)) continue;
      if (soloOnly && this.partyCohortOnTeam(p, heavy).length > 1) continue;

      const afk = p.isAfk();
      const rating = PlayerManager.playerRating(p.kills, p.score, p.deaths);
      const worse = !best ||
        (afk && !bestAfk) ||
        (afk === bestAfk &&
          (rating < bestRating ||
            (rating === bestRating &&
              (p.kills < bestKills ||
                (p.kills === bestKills &&
                  (p.deaths > bestDeaths ||
                    (p.deaths === bestDeaths &&
                      p.name.localeCompare(best.name) < 0)))))));

      if (worse) {
        best = p;
        bestAfk = afk;
        bestRating = rating;
        bestKills = p.kills;
        bestDeaths = p.deaths;
      }
    }
    return best;
  }

  /**
   * Match-player cohort that must move together for cohesion.
   * Solos / seeds / single seated party members → [self].
   * Multi-member parties on the same team → every seated party mate on that team.
   */
  public partyCohortOnTeam(player: Player, team: TeamId): Player[] {
    if (!player.isMatchPlayer() || player.team !== team) return [];
    if (!player.partyId || player.isBot) return [player];
    const mates: Player[] = [];
    for (const p of this.players.values()) {
      if (p.isBot || !p.isMatchPlayer()) continue;
      if (p.partyId !== player.partyId || p.team !== team) continue;
      if (p.connectionIssue) continue;
      mates.push(p);
    }
    return mates.length > 0 ? mates : [player];
  }

  /**
   * Voted rebalance victim: whole group on `heavy` that improves |A−B| when
   * moved to `light`. Prefers size-1 (solos/seeds), then multi-member parties
   * only when no solo move helps. Never returns a partial party.
   */
  public pickGroupForRebalance(
    heavy: TeamId,
    light: TeamId,
    opts?: { excludeIds?: ReadonlySet<string> | readonly string[] },
  ): { memberIds: string[]; size: number; anchor: Player } | null {
    if (light === heavy) return null;
    const exclude = opts?.excludeIds
      ? opts.excludeIds instanceof Set
        ? opts.excludeIds
        : new Set(opts.excludeIds)
      : null;

    const counts = this.matchPlayerTeamCounts();
    const seenParty = new Set<string>();
    type Cand = {
      id: string;
      size: number;
      memberIds: string[];
      anchor: Player;
      anchorRating: number;
      anchorAfk: boolean;
    };
    const candidates: Cand[] = [];

    for (const p of this.players.values()) {
      if (!p.isMatchPlayer() || p.team !== heavy) continue;
      if (p.connectionIssue) continue;
      if (exclude?.has(p.id)) continue;

      if (p.partyId && !p.isBot) {
        if (seenParty.has(p.partyId)) continue;
        seenParty.add(p.partyId);
        const cohort = this.partyCohortOnTeam(p, heavy);
        if (cohort.some((m) => exclude?.has(m.id))) continue;
        const size = cohort.length;
        if (!movingGroupImprovesBalance(size, heavy, counts)) continue;
        // Worst member as anchor for preference.
        let anchor = cohort[0]!;
        let worstRating = PlayerManager.playerRating(
          anchor.kills,
          anchor.score,
          anchor.deaths,
        );
        let worstAfk = anchor.isAfk();
        for (const m of cohort) {
          const rating = PlayerManager.playerRating(m.kills, m.score, m.deaths);
          const afk = m.isAfk();
          const worse = (afk && !worstAfk) ||
            (afk === worstAfk &&
              (rating < worstRating ||
                (rating === worstRating &&
                  m.name.localeCompare(anchor.name) < 0)));
          if (worse) {
            anchor = m;
            worstRating = rating;
            worstAfk = afk;
          }
        }
        candidates.push({
          id: p.partyId,
          size,
          memberIds: cohort.map((m) => m.id),
          anchor,
          anchorRating: worstRating,
          anchorAfk: worstAfk,
        });
        continue;
      }

      // Solo human or pool pawn.
      if (!movingGroupImprovesBalance(1, heavy, counts)) continue;
      const rating = PlayerManager.playerRating(p.kills, p.score, p.deaths);
      candidates.push({
        id: p.id,
        size: 1,
        memberIds: [p.id],
        anchor: p,
        anchorRating: rating,
        anchorAfk: p.isAfk(),
      });
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) =>
      compareRebalanceGroupPreference(
        {
          size: a.size,
          anchorRating: a.anchorRating,
          anchorAfk: a.anchorAfk,
          id: a.id,
        },
        {
          size: b.size,
          anchorRating: b.anchorRating,
          anchorAfk: b.anchorAfk,
          id: b.id,
        },
      )
    );
    const best = candidates[0]!;
    return {
      memberIds: best.memberIds,
      size: best.size,
      anchor: best.anchor,
    };
  }

  /**
   * Force a match player (human or pool pawn) onto `toTeam` and respawn.
   * No balance eligibility checks. Open-match voted rebalance; ranked gated by caller.
   * Refuses to move a single member of a multi-member party cohort (use
   * {@link forceChangeTeamGroup}).
   */
  public forceChangeTeam(
    playerId: string,
    toTeam: TeamId,
  ):
    | { ok: true; player: Player; from: TeamId; to: TeamId }
    | { ok: false; error: string } {
    const player = this.players.get(playerId);
    if (!player || !player.isMatchPlayer()) {
      return { ok: false, error: "Not in match." };
    }
    if (player.connectionIssue) {
      return { ok: false, error: "Reconnect before changing teams." };
    }
    if (toTeam !== "A" && toTeam !== "B") {
      return { ok: false, error: "Invalid team." };
    }
    if (player.team === toTeam) {
      return { ok: false, error: "Already on that team." };
    }
    const cohort = this.partyCohortOnTeam(player, player.team);
    if (cohort.length > 1) {
      return {
        ok: false,
        error: "Cannot rebalance a single party member; move the whole party.",
      };
    }

    const from = player.team;
    player.team = toTeam;
    player.respawn(this.spawnFor(toTeam), this.simTick);
    this.recordAuthoritativeEvent(
      deriveTeamAssign(this.simTick, player, {
        reason: "votedRebalance",
        from,
        to: toTeam,
      }),
    );
    return { ok: true, player, from, to: toTeam };
  }

  /**
   * Force an indivisible group (party cohort or solo) onto `toTeam`.
   * All members must currently share the same from-team and be match players.
   */
  public forceChangeTeamGroup(
    playerIds: readonly string[],
    toTeam: TeamId,
  ):
    | { ok: true; moved: Player[]; from: TeamId; to: TeamId }
    | { ok: false; error: string } {
    if (toTeam !== "A" && toTeam !== "B") {
      return { ok: false, error: "Invalid team." };
    }
    if (playerIds.length === 0) {
      return { ok: false, error: "Empty rebalance group." };
    }

    const members: Player[] = [];
    let from: TeamId | null = null;
    for (const id of playerIds) {
      const p = this.players.get(id);
      if (!p || !p.isMatchPlayer()) {
        return { ok: false, error: "Not in match." };
      }
      if (p.connectionIssue) {
        return { ok: false, error: "Reconnect before changing teams." };
      }
      if (p.team === toTeam) {
        return { ok: false, error: "Already on that team." };
      }
      if (from == null) from = p.team;
      else if (p.team !== from) {
        return { ok: false, error: "Rebalance group is split across teams." };
      }
      members.push(p);
    }

    // If any member is in a multi-party cohort, the group must be exactly that cohort.
    for (const p of members) {
      const cohort = this.partyCohortOnTeam(p, p.team);
      if (cohort.length <= 1) continue;
      const cohortIds = new Set(cohort.map((m) => m.id));
      if (
        members.length !== cohort.length ||
        members.some((m) => !cohortIds.has(m.id))
      ) {
        return {
          ok: false,
          error: "Cannot rebalance a partial party; move the whole party.",
        };
      }
    }

    for (const p of members) {
      const memberFrom = p.team;
      p.team = toTeam;
      p.respawn(this.spawnFor(toTeam), this.simTick);
      this.recordAuthoritativeEvent(
        deriveTeamAssign(this.simTick, p, {
          reason: "forceGroup",
          from: memberFrom,
          to: toTeam,
        }),
      );
    }
    return { ok: true, moved: members, from: from!, to: toTeam };
  }

  /**
   * Move community fill bots (not pool pawns) from heavy → light until totals
   * differ by at most 1. Seeds count as real players and are not shuffled here.
   * Used after a team switch so fill-cap lobbies rebalance without a free slot.
   */
  public rebalanceBotTeams(): Player[] {
    const moved: Player[] = [];
    const maxMoves = this.botCount();
    for (let i = 0; i < maxMoves; i++) {
      const { A, B } = this.teamCounts();
      if (Math.abs(A - B) <= 1) break;
      const heavy: TeamId = A > B ? "A" : "B";
      const light: TeamId = heavy === "A" ? "B" : "A";

      // Prefer community fill bots; never move pool pawns or agents.
      // Balance bot only as last resort.
      let bot: Player | null = null;
      for (const p of this.players.values()) {
        if (!p.isBot || p.isAgent || p.team !== heavy || p.isBalanceBot) {
          continue;
        }
        if (p.isMatchPlayer()) continue; // pool pawn — treat as real
        if (!bot || p.id > bot.id) bot = p;
      }
      if (!bot) {
        for (const p of this.players.values()) {
          if (!p.isBot || p.isAgent || p.team !== heavy) continue;
          if (p.isMatchPlayer()) continue;
          if (!bot || p.id > bot.id) bot = p;
        }
      }
      if (!bot) break;

      const from = bot.team;
      bot.team = light;
      bot.respawn(this.spawnFor(light), this.simTick);
      this.recordAuthoritativeEvent(
        deriveTeamAssign(this.simTick, bot, {
          reason: "botRebalance",
          from,
          to: light,
        }),
      );
      moved.push(bot);
    }
    return moved;
  }

  /**
   * Team for a joining human: fewer match players (humans + pool pawns).
   * Community fill / balance bots ignored. Tie → Team A.
   */
  public pickTeamForHuman(): TeamId {
    const { A, B } = this.matchPlayerTeamCounts();
    if (B < A) return "B";
    return "A";
  }

  /**
   * How long a pre-roster party team lock lives after the first member is
   * assigned a team. Aligned with the open seat reservation connection lease so
   * remaining members can still connect onto the same side.
   * Once any party member is seated, {@link pickTeamForJoin} prefers their
   * roster team over this temporary lock.
   */
  private static readonly PARTY_TEAM_LOCK_MS =
    DEFAULT_OPEN_SEAT_RESERVATION_LEASE_MS;
  /** partyId → locked team while the party is still connecting. */
  private readonly partyTeams = new Map<
    string,
    { team: TeamId; expiresAt: number }
  >();

  private expirePartyTeams(now: number): void {
    for (const [id, entry] of this.partyTeams) {
      if (now >= entry.expiresAt) this.partyTeams.delete(id);
    }
  }

  private refreshPartyTeamLock(
    partyId: string,
    team: TeamId,
    now: number,
  ): void {
    this.partyTeams.set(partyId, {
      team,
      expiresAt: now + PlayerManager.PARTY_TEAM_LOCK_MS,
    });
  }

  /**
   * Prefer the side with fewer match players (humans + seeds) after seating
   * the whole party (minimizes |A−B|); ties → lighter team, then A.
   */
  public pickTeamForParty(partySize: number): TeamId {
    const size = normalizePlayerPartySize(partySize) ?? 1;
    return pickTeamForGroupSize(size, this.matchPlayerTeamCounts());
  }

  /**
   * First human already on the roster for this party (including connection-issue
   * grace). Their team is the cohesion source after admission.
   */
  public findPartyMember(
    partyId: string | null | undefined,
  ): Player | undefined {
    const id = normalizePlayerPartyId(partyId);
    if (!id) return undefined;
    for (const p of this.players.values()) {
      if (p.isBot) continue;
      if (p.partyId === id) return p;
    }
    return undefined;
  }

  /** All non-bot humans currently on the roster for this party. */
  public listPartyMembers(partyId: string | null | undefined): Player[] {
    const id = normalizePlayerPartyId(partyId);
    if (!id) return [];
    const out: Player[] = [];
    for (const p of this.players.values()) {
      if (p.isBot) continue;
      if (p.partyId === id) out.push(p);
    }
    return out;
  }

  /**
   * Runtime-supported max party size for this instance's human seat capacity.
   * Authority `OPEN_PARTY_MAX_SIZE` must not exceed this value.
   */
  public maxPartySize(humanCapacity: number): number {
    return runtimeMaxPartySize(humanCapacity);
  }

  /**
   * Team for a human join.
   * 1. Seated party members (including disconnect grace) force the same team.
   * 2. Else a short connect-window lock (reservation lease) covers concurrent
   *    first-wave joins before anyone is on the roster.
   * 3. Else pick a balanced team for the whole party size and lock it.
   */
  public pickTeamForJoin(opts?: {
    partyId?: string | null;
    partySize?: number | null;
    /** Non-simulation admission timestamp used for party-lock expiry. */
    nowMs?: number;
  }): TeamId {
    const nowMs = opts?.nowMs ?? Date.now();
    this.expirePartyTeams(nowMs);
    const partyId = normalizePlayerPartyId(opts?.partyId);
    if (!partyId) return this.pickTeamForHuman();

    const seated = this.findPartyMember(partyId);
    if (seated) {
      this.refreshPartyTeamLock(partyId, seated.team, nowMs);
      return seated.team;
    }

    const existing = this.partyTeams.get(partyId);
    if (existing) {
      // Refresh lease while remaining members are still connecting.
      this.refreshPartyTeamLock(partyId, existing.team, nowMs);
      return existing.team;
    }

    const size = normalizePlayerPartySize(opts?.partySize) ?? 1;
    const team = this.pickTeamForParty(size);
    this.refreshPartyTeamLock(partyId, team, nowMs);
    return team;
  }

  /** Test helper: clear party team locks. */
  public clearPartyTeamsForTests(): void {
    this.partyTeams.clear();
  }

  /** Test helper: force-expire connect locks (roster cohesion still applies). */
  public expirePartyTeamsForTests(now = Date.now()): void {
    for (const entry of this.partyTeams.values()) {
      entry.expiresAt = now - 1;
    }
    this.expirePartyTeams(now);
  }

  public add(
    socketId: string,
    name: string,
    team?: TeamId,
    opts?: {
      accountUserId?: string | null;
      partyId?: string | null;
      partySize?: number | null;
      xp?: number;
      mmsRankId?: import("../shared/progression/mmsRanks.ts").MmsRankId;
      founderBadge?: boolean;
      /** Join-token synthetic claim. Default false. */
      synthetic?: boolean;
      equipment?: import("../protocol/network.ts").PlayerEquipment | null;
      ownedAbilities?: readonly SkillProductId[] | null;
      /** PR-2 match loadout; omit for default / unrestricted equip. */
      skillLoadout?: readonly (SkillId | null | string)[] | null;
    },
    /** Non-simulation join timestamp for participation and party metadata. */
    nowMs = Date.now(),
  ): Player {
    const existing = this.players.get(socketId);
    if (existing) return existing;

    const assigned = team ?? this.pickTeamForHuman();

    const side = assigned === "A"
      ? this.collision.map.teamA
      : this.collision.map.teamB;
    const spawn = this.collision.randomSpawn(side);
    // Stable session id starts as the first socket id and never changes.
    const player = new Player(socketId, name, assigned, {
      accountUserId: opts?.accountUserId ?? null,
      partyId: opts?.partyId ?? null,
      partySize: opts?.partySize ?? null,
      xp: opts?.xp,
      mmsRankId: opts?.mmsRankId,
      founderBadge: opts?.founderBadge,
      synthetic: opts?.synthetic === true,
      equipment: opts?.equipment ?? null,
      ownedAbilities: opts?.ownedAbilities,
      skillLoadout: opts?.skillLoadout,
    });
    player.applySpawn(
      { x: spawn.x, y: PLAYER_HEIGHT, z: spawn.z, yaw: spawn.yaw },
      this.simTick,
    );
    player.unlimitedAmmo = this.isPrematch() && PREMATCH_CONFIG.unlimitedAmmo;
    // Mid-match join: only credit time from now until match end.
    if (this.isLive()) {
      player.resetMatchParticipation(nowMs);
    }
    this.players.set(socketId, player);
    this.socketToPlayer.set(socketId, socketId);
    // Keep connect lock aligned with the seated party team for late members.
    if (player.partyId) {
      this.refreshPartyTeamLock(player.partyId, player.team, nowMs);
    }
    this.invalidateRosterCache();
    // Human roster changed during pre-match → clear ready votes.
    if (this.isPrematch() && PREMATCH_CONFIG.clearReadyOnRosterChange) {
      this.clearReadyVotes();
      this.recordAuthoritativeEvent(deriveReadyVoteClearAll(this.simTick));
    }
    this.recordAuthoritativeEvent(deriveHumanJoin(this.simTick, player));
    return player;
  }

  /**
   * Spawn a server-driven bot player (no socket). Caller owns AI / lifecycle.
   * `id` must be unique and must not collide with live socket ids.
   */
  public addBot(
    id: string,
    name: string,
    opts?: {
      equipment?: import("../protocol/network.ts").PlayerEquipment | null;
      accountUserId?: string | null;
      /** Pool identity carried an account id. See {@link Player.poolAccount}. */
      poolAccount?: boolean;
      xp?: number;
      mmsRankId?: import("../shared/progression/mmsRanks.ts").MmsRankId;
      founderBadge?: boolean;
      /** Force team (e.g. balance bot on the lighter side). */
      team?: TeamId;
      /** Temporary uneven-team filler named "bot". */
      isBalanceBot?: boolean;
      /** Raid wave / boss enemy (sim role: raid damage drop). */
      isRaidBot?: boolean;
      maxHealth?: number;
      modelScale?: number;
      moveSpeedScale?: number;
      /**
       * Skill products owned (level-gated). Omit → unrestricted (tests).
       * Match bots pass `ownedSkillsForLevel` or `[]` for balance filler.
       */
      ownedAbilities?:
        | readonly import("../shared/sim/skills.ts").SkillProductId[]
        | null;
      /** Favorite 4-slot loadout (owned + unique). */
      skillLoadout?:
        | readonly (
          | import("../shared/sim/skills.ts").SkillId
          | null
          | string
        )[]
        | null;
    },
  ): Player {
    const existing = this.players.get(id);
    if (existing) return existing;

    const team = opts?.team === "A" || opts?.team === "B"
      ? opts.team
      : this.pickBalancedTeam();
    const side = team === "A"
      ? this.collision.map.teamA
      : this.collision.map.teamB;
    const spawn = this.collision.randomSpawn(side);
    const player = new Player(id, name, team, {
      isBot: true,
      isBalanceBot: opts?.isBalanceBot === true,
      isRaidBot: opts?.isRaidBot === true,
      equipment: opts?.equipment ?? null,
      accountUserId: opts?.accountUserId ?? null,
      poolAccount: opts?.poolAccount === true,
      xp: opts?.xp,
      mmsRankId: opts?.mmsRankId,
      founderBadge: opts?.founderBadge,
      maxHealth: opts?.maxHealth,
      modelScale: opts?.modelScale,
      moveSpeedScale: opts?.moveSpeedScale,
      ...(opts?.ownedAbilities !== undefined
        ? { ownedAbilities: opts.ownedAbilities }
        : {}),
      ...(opts?.skillLoadout !== undefined
        ? { skillLoadout: opts.skillLoadout }
        : {}),
    });
    player.applySpawn(
      { x: spawn.x, y: PLAYER_HEIGHT, z: spawn.z, yaw: spawn.yaw },
      this.simTick,
    );
    player.unlimitedAmmo = this.isPrematch() && PREMATCH_CONFIG.unlimitedAmmo;
    this.players.set(id, player);
    this.invalidateRosterCache();
    // Record as a normal join — fill-bot identity is not a wire/replay fact.
    this.recordAuthoritativeEvent(deriveHumanJoin(this.simTick, player));
    return player;
  }

  /**
   * Spawn a grey free-for-all agent at the given team's door (into the map).
   * `doorTeam` is only the drop door; agents are hostile to both colors.
   * Caller owns AI / lifecycle (no respawn — remove on death).
   */
  public addAgent(
    id: string,
    name: string,
    doorTeam: TeamId,
    spawn: SpawnPose,
    opts?: {
      ownedAbilities?:
        | readonly import("../shared/sim/skills.ts").SkillProductId[]
        | null;
      skillLoadout?:
        | readonly (
          | import("../shared/sim/skills.ts").SkillId
          | null
          | string
        )[]
        | null;
    },
  ): Player {
    const existing = this.players.get(id);
    if (existing) return existing;

    const player = new Player(id, name, doorTeam, {
      isBot: true,
      isAgent: true,
      // All agents share the dome mesh set (head/body/guns).
      equipment: agentPlayerEquipment(),
      ...(opts?.ownedAbilities !== undefined
        ? { ownedAbilities: opts.ownedAbilities }
        : {}),
      ...(opts?.skillLoadout !== undefined
        ? { skillLoadout: opts.skillLoadout }
        : {}),
    });
    player.applySpawn(
      {
        x: spawn.x,
        y: spawn.y ?? PLAYER_HEIGHT,
        z: spawn.z,
        yaw: spawn.yaw,
      },
      this.simTick,
    );
    // Agents keep unlimited ammo for the full match (constructor also sets this).
    player.unlimitedAmmo = true;
    this.players.set(id, player);
    this.invalidateRosterCache();
    this.recordAuthoritativeEvent(deriveAgentAdd(this.simTick, player));
    return player;
  }

  public remove(id: string): void {
    const player = this.players.get(id);
    const wasHuman = player ? !player.isBot : false;
    const wasAgent = player?.isAgent === true;
    if (player?.socketId) {
      this.socketToPlayer.delete(player.socketId);
    }
    // Also drop any stale socket index that still pointed here.
    for (const [socketId, playerId] of this.socketToPlayer) {
      if (playerId === id) this.socketToPlayer.delete(socketId);
    }
    this.players.delete(id);
    this.invalidateRosterCache();
    this.readyVotes.delete(id);
    if (player) {
      this.recordAuthoritativeEvent(
        wasAgent
          ? deriveAgentRemove(this.simTick, id)
          : derivePlayerRemove(this.simTick, id),
      );
    }
    // Human roster changed during pre-match → clear all ready votes.
    if (
      wasHuman &&
      this.isPrematch() &&
      PREMATCH_CONFIG.clearReadyOnRosterChange
    ) {
      this.clearReadyVotes();
      this.recordAuthoritativeEvent(deriveReadyVoteClearAll(this.simTick));
    }
  }

  /** Human (non-bot) players currently in the match. */
  public humanCount(): number {
    let n = 0;
    for (const p of this.players.values()) {
      if (!p.isBot) n++;
    }
    return n;
  }

  /** Server bots currently in the match. */
  public botCount(): number {
    let n = 0;
    for (const p of this.players.values()) {
      if (p.isBot) n++;
    }
    return n;
  }

  public bots(): Player[] {
    return [...this.players.values()].filter((p) => p.isBot);
  }

  public humans(): Player[] {
    return [...this.players.values()].filter((p) => !p.isBot);
  }

  /** Case-insensitive display-name collision check for this server only. */
  public isNameTaken(name: string): boolean {
    const key = playerNameKey(name);
    for (const p of this.players.values()) {
      if (playerNameKey(p.name) === key) return true;
    }
    return false;
  }

  /**
   * A dropped player who can reclaim this name (connection-issue grace).
   * Connected players with the same name are not reclaimable.
   */
  public findReclaimableByName(name: string): Player | undefined {
    const key = playerNameKey(name);
    for (const p of this.players.values()) {
      if (p.connectionIssue && playerNameKey(p.name) === key) return p;
    }
    return undefined;
  }

  /**
   * Human already on this server who is the same user as the joining client.
   * Prefer Clerk account id; fall back to display name for guests.
   * Does not match bots. Different accounts that share a display name are not
   * treated as the same user (caller should reject with NameTaken).
   */
  public findSessionConflict(
    name: string,
    accountUserId?: string | null,
  ): Player | undefined {
    const uid = typeof accountUserId === "string" && accountUserId.trim()
      ? accountUserId.trim()
      : null;

    if (uid) {
      for (const p of this.players.values()) {
        if (p.isBot) continue;
        if (p.accountUserId === uid) return p;
      }
    }

    const key = playerNameKey(name);
    for (const p of this.players.values()) {
      if (p.isBot) continue;
      if (playerNameKey(p.name) !== key) continue;
      // Account holder vs different guest/account → not the same session.
      if (uid && p.accountUserId && p.accountUserId !== uid) continue;
      if (!uid && p.accountUserId) continue;
      return p;
    }
    return undefined;
  }

  public get(id: string): Player | undefined {
    return this.players.get(id);
  }

  /**
   * First roster match by display name (case-insensitive).
   * Used by admin kick; humans and bots share the same name space.
   */
  public findByName(name: string): Player | undefined {
    const key = playerNameKey(name);
    if (!key) return undefined;
    for (const p of this.players.values()) {
      if (playerNameKey(p.name) === key) return p;
    }
    return undefined;
  }

  /**
   * Resolve the stable player for a live transport socket.
   * Adapter-only (epic 4.8) — sim step must key on `player.id`, not sockets.
   */
  public getBySocket(socketId: string): Player | undefined {
    const playerId = this.socketToPlayer.get(socketId);
    if (!playerId) return undefined;
    return this.players.get(playerId);
  }

  public all(): IterableIterator<Player> {
    return this.players.values();
  }

  /** Mark the hot-path roster array stale (call after map of players mutates). */
  private invalidateRosterCache(): void {
    this.rosterCacheDirty = true;
  }

  /**
   * Stable roster for per-tick AI. Rebuilds only when players are added/removed.
   * Do not mutate the returned array.
   */
  public allCached(): readonly Player[] {
    if (this.rosterCacheDirty) {
      this.rosterCache = [...this.players.values()];
      this.rosterCacheDirty = false;
    }
    return this.rosterCache;
  }

  /**
   * Flag a connected player as connection-issue (sitting duck). Returns false
   * if already flagged or unknown.
   */
  public markConnectionIssue(playerId: string, nowMs = Date.now()): boolean {
    const player = this.players.get(playerId);
    if (!player || player.connectionIssue) return false;
    if (player.socketId) {
      this.socketToPlayer.delete(player.socketId);
    }
    player.markConnectionIssue(nowMs + CONNECTION_ISSUE_TIMEOUT_MS);
    this.recordAuthoritativeEvent(
      deriveConnectionStatus(this.simTick, player, {
        connectionIssue: true,
        respawned: false,
      }),
    );
    return true;
  }

  /**
   * Rebind a new socket to a connection-issue player.
   * If they died while down and doors are open, respawn immediately—except in
   * raids, where death is permanent for the session.
   * While doors are closed they stay dead until the next open phase.
   * Returns the restored player, or null if reclaim failed.
   */
  public restoreConnection(
    playerId: string,
    newSocketId: string,
    tick: number,
    nowMs = Date.now(),
  ): { player: Player; respawned: boolean } | null {
    const result = this.takeOverConnection(playerId, newSocketId, tick, nowMs);
    if (!result) return null;
    return { player: result.player, respawned: result.respawned };
  }

  /**
   * Bind a new transport socket to an existing human (connection-issue reclaim
   * or live session replace when the same user joins again).
   *
   * Caller is responsible for kicking `previousSocketId` (emit + disconnect)
   * when it is non-null — do that before or after this rebind; mappings for the
   * old socket are cleared here so its disconnect path will not re-flag grace.
   */
  public takeOverConnection(
    playerId: string,
    newSocketId: string,
    tick: number,
    nowMs = Date.now(),
  ): {
    player: Player;
    respawned: boolean;
    previousSocketId: string | null;
    wasConnectionIssue: boolean;
  } | null {
    const player = this.players.get(playerId);
    if (!player || player.isBot) return null;

    // New socket must not already own a different player.
    const existingOwner = this.socketToPlayer.get(newSocketId);
    if (existingOwner && existingOwner !== playerId) return null;

    const wasConnectionIssue = player.connectionIssue;
    const previousSocketId = player.socketId && player.socketId !== newSocketId
      ? player.socketId
      : null;

    if (previousSocketId) {
      this.socketToPlayer.delete(previousSocketId);
    }
    // Drop any other stale transport indexes that still point at this player.
    for (const [socketId, id] of this.socketToPlayer) {
      if (id === playerId && socketId !== newSocketId) {
        this.socketToPlayer.delete(socketId);
      }
    }

    player.clearConnectionIssue(newSocketId, nowMs);
    this.socketToPlayer.set(newSocketId, playerId);

    let respawned = false;
    if (
      !player.alive && this.raidDoorPolicy === "off" &&
      this.areDoorsOpen(tick)
    ) {
      player.respawn(this.spawnFor(player.team), tick);
      respawned = true;
    }
    this.recordAuthoritativeEvent(
      deriveConnectionStatus(tick, player, {
        connectionIssue: false,
        respawned,
      }),
    );
    return { player, respawned, previousSocketId, wasConnectionIssue };
  }

  /**
   * Humans (and bots) whose connection-issue grace has expired, still in roster.
   * Caller may inspect for abandon before processConnectionIssueTimeouts removes them.
   */
  public getConnectionIssueExpired(nowMs = Date.now()): Player[] {
    const expired: Player[] = [];
    for (const player of this.players.values()) {
      if (!player.connectionIssue) continue;
      const deadline = player.connectionIssueDeadlineMs;
      if (deadline === null || nowMs < deadline) continue;
      expired.push(player);
    }
    return expired;
  }

  /**
   * Drop players whose connection-issue grace period has expired.
   * Returns the removed player ids.
   */
  public processConnectionIssueTimeouts(nowMs = Date.now()): string[] {
    const dropped = this.getConnectionIssueExpired(nowMs).map((p) => p.id);
    for (const id of dropped) {
      this.remove(id);
    }
    return dropped;
  }

  public handleInput(
    id: string,
    input: PlayerInput,
    nowMs = Date.now(),
  ): void {
    const player = this.players.get(id);
    if (!player) return;
    player.queueInput(input, nowMs);
  }

  /**
   * Epic 8.3 / 7.5 — attach or clear the action-effect observer.
   * GameServer enables this only while a replay sink is attached (zero cost otherwise).
   */
  public setActionEffectObserver(
    observer: SimActionEffectObserver | null,
  ): void {
    this.actionEffectObserver = observer;
  }

  private noteActionEffect(
    effect: Parameters<SimActionEffectObserver>[0],
  ): void {
    this.actionEffectObserver?.(effect);
  }

  public handleReload(id: string, tick: number): boolean {
    const player = this.players.get(id);
    if (!player) return false;
    this.noteActionEffect({ kind: "reload", tick, playerId: id });
    return player.tryBeginReload(tick);
  }

  /**
   * Equip a specific weapon, or cycle if weapon is omitted / invalid.
   * Returns true when the active weapon changed (starts holster+draw window).
   */
  public handleWeaponSwitch(
    id: string,
    weapon: unknown,
    tick: number,
  ): boolean {
    const player = this.players.get(id);
    if (!player) return false;
    if (isWeaponId(weapon)) {
      const ok = player.trySwitchWeapon(weapon, tick);
      if (ok) {
        this.noteActionEffect({
          kind: "weaponSelect",
          tick,
          playerId: id,
          weapon,
        });
      }
      return ok;
    }
    const before = player.weaponId;
    const ok = player.tryCycleWeapon(tick);
    if (ok && player.weaponId !== before) {
      this.noteActionEffect({
        kind: "weaponSelect",
        tick,
        playerId: id,
        weapon: player.weaponId,
      });
    }
    return ok;
  }

  /**
   * Activate a skill family (timed / instant). Passives are rejected.
   * Returns true when the skill started. Silent no-op when denied.
   * Team heal walks the roster (same team, alive, non-agent) then commits charge.
   * PR-2: skill must be in the player's match loadout (unless unrestricted).
   */
  public handleAbility(
    id: string,
    ability: unknown,
    tick: number,
  ): boolean {
    const player = this.players.get(id);
    if (!player) return false;
    if (typeof ability !== "string" || !isSkillId(ability)) return false;
    this.noteActionEffect({
      kind: "ability",
      tick,
      playerId: id,
      ability,
    });
    if (ability === "teamHeal") {
      return this.tryActivateTeamHeal(player, tick);
    }
    // Teleport needs map collision + other bodies for the horizontal sweep.
    return player.tryActivateAbility(
      ability,
      tick,
      this.collision,
      this.clipObstaclesExcept(player.id),
    );
  }

  /**
   * PR-2: apply the client's My Skills loadout (validated owned + unique).
   * Non-array payloads are ignored (no unrestricted-equip escape hatch).
   * Returns the loadout stored on the player after the call.
   */
  public handleSkillLoadout(
    id: string,
    raw: unknown,
  ): SkillLoadout | null {
    const player = this.players.get(id);
    if (!player) return null;
    // Non-array payloads are ignored (no commit event).
    if (!Array.isArray(raw)) return player.snapshotSkillLoadout();
    player.setSkillLoadout(raw);
    const loadout = player.snapshotSkillLoadout();
    this.recordAuthoritativeEvent(
      deriveLoadoutCommit(this.simTick, id, loadout),
    );
    return loadout;
  }

  /**
   * Skill B — Team heal: restore tier HP (15 / 25) to every alive teammate
   * except the caster. Excludes grey agents (FFA). Denies when no teammate
   * would gain HP so the charge is not wasted.
   */
  private tryActivateTeamHeal(caster: Player, tick: number): boolean {
    if (!caster.canActivateAbility("teamHeal", tick)) return false;
    const amount = caster.skillValue("teamHeal");
    if (amount <= 0) return false;

    let healedAny = false;
    for (const p of this.players.values()) {
      if (p.id === caster.id) continue;
      if (p.team !== caster.team) continue;
      if (!p.alive || p.isAgent) continue;
      if (p.heal(amount) > 0) healedAny = true;
    }
    if (!healedAny) return false;
    return caster.commitInstantSkill("teamHeal", tick);
  }

  public handleShoot(
    shooterId: string,
    tick: number,
    packet: ShootPacket | null,
    opts?: {
      volDropPct?: number;
      nowMs?: number;
      /** Replay only: recorded RTT lag-comp stamp (see SimActionEffect). */
      recordedRewindStamp?: number | null;
    },
  ): ShootOutcome | null {
    // NON-SIM fallback for direct callers outside the tick loop. Production
    // passes the tick-loop timestamp through opts.nowMs.
    const deathNowMs = opts?.nowMs ?? Date.now();
    const shooter = this.players.get(shooterId);
    if (!shooter) return null;
    // 8.3: note at the unified handle* seam (human flush + bot apply).
    const fireEffect: SimActionEffect & { kind: "fire" } = {
      kind: "fire",
      tick,
      playerId: shooterId,
      fireKind: "shoot",
      packet,
    };
    this.noteActionEffect(fireEffect);
    // Shell guns: a press during loading only interrupts + pumps, never fires.
    if (shooter.tryInterruptShellReload(tick)) return null;
    if (!shooter.canShoot(tick)) return null;

    const weapon = shooter.weapon;
    shooter.markShot(tick);

    if (
      packet && Number.isFinite(packet.yaw) && Number.isFinite(packet.pitch)
    ) {
      shooter.yaw = packet.yaw;
      shooter.pitch = clamp(
        packet.pitch,
        -Math.PI / 2 + 0.01,
        Math.PI / 2 - 0.01,
      );
    }

    // Prefer the client's eye (what they aimed from). Soft-clamp toward the
    // server eye so desync can't invent a free teleport, but never silently
    // swap to a completely different origin (that was a major miss source).
    const serverEye = { x: shooter.x, y: shooter.y, z: shooter.z };
    const origin = resolveShootOrigin(serverEye, packet?.origin ?? null);

    // Authoritative bloom from movement stance + weapon table
    // (shared/sim/weapons WEAPON_AIM_SPREAD_DEG). Client mirrors for tracer/crosshair.
    // Hawkeyes: perfect accuracy — cone half-angle forced to 0 (look direction),
    // plus a half-size, uniform pellet ring (no pattern draws).
    // Epic 4.6: spread samples from the `spread` domain stream; damage/bot-scale
    // from `damage`. Order: bloom → pellet pattern → per-victim damage →
    // bot-scale. Bloom moves the whole pattern once; single-pellet guns draw
    // nothing for the pattern.
    const hawkeyes = shooter.isAbilityActive("hawkeyes", tick);
    const bloomed = spreadDirectionFromYawPitch(
      shooter.yaw,
      shooter.pitch,
      aimSpreadRad(shooter.aimMovementState(), shooter.weaponId, {
        perfectAccuracy: hawkeyes,
      }),
      this.spreadRandom,
    );
    const directions = pelletDirections(
      bloomed,
      weapon,
      hawkeyes
        ? { uniform: true, coneScale: HAWKEYES_PELLET_CONE_SCALE }
        : {},
      this.spreadRandom,
    );
    const rewindTicks = this.resolveRewindTicks(
      shooter,
      tick,
      packet,
      opts,
      fireEffect,
    );
    // Targets are collected once per shot; every pellet tests the same poses.
    const targetCount = this.collectLagCompTargets(shooterId, rewindTicks);

    const pellets: ShotPellet[] = [];
    /** Per-victim base damage (post-falloff, pre-roll) summed over pellets. */
    const pelletHits = new Map<string, { base: number; head: boolean }>();
    for (const direction of directions) {
      // Walls block bullets: clamp range to the first solid hit so players
      // behind cover cannot be damaged (and tracers stop at the impact).
      const wallDist = this.collision.raycastSolid(
        origin,
        direction,
        weapon.maxRange,
      );
      const range = wallDist ?? weapon.maxRange;
      const hit = hitscanPoses(
        origin,
        direction,
        range,
        shootTargetScratch,
        targetCount,
      );
      const dirN = normalize(direction);
      const wallPoint: [number, number, number] | null = wallDist !== null
        ? [
          origin.x + dirN.x * wallDist,
          origin.y + dirN.y * wallDist,
          origin.z + dirN.z * wallDist,
        ]
        : null;
      pellets.push({
        direction: [dirN.x, dirN.y, dirN.z],
        hitId: hit?.playerId ?? null,
        hitZone: hit?.zone ?? null,
        hitPoint: hit ? [hit.point.x, hit.point.y, hit.point.z] : wallPoint,
      });
      if (!hit) continue;
      const head = hit.zone === "head";
      // Distance falloff scales the base before the ±5 roll (no extra draws).
      const base = shotBaseDamage(weapon, head, hit.distance);
      const acc = pelletHits.get(hit.playerId);
      if (acc) {
        acc.base += base;
        acc.head ||= head;
      } else {
        pelletHits.set(hit.playerId, { base, head });
      }
    }

    // Top-level fields are the centre pellet so single-tracer consumers work.
    const centre = pellets[0]!;
    const shot: ShotFiredPacket = {
      shooterId,
      origin: [origin.x, origin.y, origin.z],
      direction: centre.direction,
      weapon: weapon.id,
      hitId: centre.hitId,
      hitZone: centre.hitZone,
      hitPoint: centre.hitPoint,
    };
    if (pellets.length > 1) shot.pellets = pellets;

    // One damage outcome per victim, stable ascending id order (determinism:
    // one damage roll + optional raid-scale draw per victim, in this order).
    const victimIds = [...pelletHits.keys()].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0
    );
    const damages: DamageOutcome[] = [];
    let leech = false;
    for (const victimId of victimIds) {
      const victim = this.players.get(victimId);
      if (!victim || !victim.alive) continue;
      // Spawn protect / Force Field: hit for tracers, but no damage outcomes.
      if (victim.isInvulnerable(tick)) continue;
      const { base, head } = pelletHits.get(victimId)!;
      const zone: "head" | "body" = head ? "head" : "body";
      if (
        this.applyShotDamage(shooter, victim, base, zone, tick, deathNowMs, damages)
      ) {
        leech = true;
      }
    }

    if (damages.length === 0) return { shot };
    return leech ? { shot, damages, leech: true } : { shot, damages };
  }

  /**
   * Resolve one victim's summed shot damage: ±5 roll, raid-bot scale, the
   * ≥1 clamp, One-shot, kills, Leech and the teamfire mirror. Appends the
   * victim outcome (and the mirrored self-hit) to `damages`. Returns true
   * when Leech healed the shooter.
   */
  private applyShotDamage(
    shooter: Player,
    victim: Player,
    baseDamage: number,
    zone: "head" | "body",
    tick: number,
    deathNowMs: number,
    damages: DamageOutcome[],
  ): boolean {
    const shooterId = shooter.id;
    const damageRoll = rollDamageVariation(baseDamage, this.damageRandom());
    let damage = damageRoll.damage;
    if (shooter.isRaidBot) {
      damage = scaleRaidBotDamage(damage, this.damageRandom());
    }
    // No hard range cutoff: a real hit always lands for at least 1.
    damage = clampHitDamage(damage);
    // Skill H — One-shot: while active, any hit that would deal >0 damage is
    // lethal. Invulnerable targets are skipped by the caller (spawn / Force Field).
    // Teamfire keeps normal mirror rules (same damage amount on shooter).
    if (damage > 0 && shooter.isAbilityActive("oneShot", tick)) {
      damage = Math.max(damage, victim.health);
    }
    // Agents are hostile to both teams; only true A↔A / B↔B is teamfire.
    const isTeamHit = !shooter.isAgent && !victim.isAgent &&
      shooter.team === victim.team;
    const healthBefore = victim.health;
    const killed = victim.takeDamage(damage, zone, tick, deathNowMs);
    if (!killed) victim.applyBulletHitSlow(tick);
    // Actual HP removed (no overkill) — used for Leech lifesteal.
    const appliedDamage = Math.max(0, healthBefore - victim.health);
    if (killed) {
      // Teamkill penalty: −2 kills. Enemy kill: +1.
      if (isTeamHit) {
        shooter.kills -= 2;
      } else {
        shooter.kills += 1;
      }
      victim.deaths += 1;
    }

    damages.push({
      targetId: victim.id,
      shooterId,
      damage,
      health: victim.health,
      zone,
      alive: victim.alive,
      killed,
      critical: damageRoll.critical,
      hitSlowStacks: victim.activeHitSlowStacks(tick) || undefined,
      hitSlowEndsAtTick: victim.activeHitSlowEndsAtTick(tick),
    });

    // Skill D — Leech (passive): heal floor(damageDealt * fraction) on enemy
    // damage only. No lifesteal on teamfire (victim or mirrored self-hit).
    // PR-2: must be equipped in the match loadout (unrestricted equip for bots).
    let leech = false;
    if (
      !isTeamHit &&
      appliedDamage > 0 &&
      shooter.alive &&
      shooter.hasSkillEquipped("leech")
    ) {
      const fraction = shooter.skillValue("leech");
      if (fraction > 0) {
        const leechHeal = Math.floor(appliedDamage * fraction);
        if (leechHeal > 0) {
          shooter.heal(leechHeal);
          leech = true;
        }
      }
    }

    // Friendly fire: mirror the same damage onto the shooter (punishes team hits).
    // Suicide-by-teamfire only adds a death — no extra kill score change.
    if (isTeamHit && shooter.alive && shooter.id !== victim.id) {
      const selfKilled = shooter.takeDamage(
        damage,
        zone,
        tick,
        deathNowMs,
      );
      if (!selfKilled) shooter.applyBulletHitSlow(tick);
      if (selfKilled) {
        shooter.deaths += 1;
      }
      damages.push({
        targetId: shooter.id,
        shooterId,
        damage,
        health: shooter.health,
        zone,
        alive: shooter.alive,
        killed: selfKilled,
        critical: damageRoll.critical,
        hitSlowStacks: shooter.activeHitSlowStacks(tick) || undefined,
        hitSlowEndsAtTick: shooter.activeHitSlowEndsAtTick(tick),
      });
    }
    return leech;
  }

  /**
   * Server-owned rewind band for one aim packet (shots + melee swings).
   * Shared so melee hit-reg matches the delayed remote mesh like shots do.
   */
  private resolveRewindTicks(
    shooter: Player,
    tick: number,
    packet: ShootPacket | MeleePacket | null,
    opts?: { volDropPct?: number; recordedRewindStamp?: number | null },
    fireEffect?: SimActionEffect & { kind: "fire" },
  ): number[] {
    // Replay: reuse the recorded RTT-window decision verbatim.
    if (opts?.recordedRewindStamp !== undefined) {
      return buildLagCompTicks(tick, opts.recordedRewindStamp ?? undefined, {
        resolved: true,
      });
    }
    const useRttWindow = LAG_COMP_RTT_WINDOW;
    let rewindStamp = packet?.clientTick;
    let resolved = false;
    if (useRttWindow) {
      const window = resolveLagCompWindow({
        simTick: tick,
        clientTick: packet?.clientTick,
        lastSnapTick: this.lastSnapshotTick,
        lastAppliedSnapshotTick: packet?.lastAppliedSnapshotTick,
        pingEwmaMs: shooter.pingFilter.ewmaMs,
        pingJitterMs: shooter.pingFilter.jitterMs,
        pingReady: shooter.pingReady,
        volDropPct: opts?.volDropPct,
      });
      rewindStamp = window.tick;
      resolved = true;
      // Effect objects are projected at tick delivery, after this runs.
      if (fireEffect) fireEffect.rewindStamp = rewindStamp ?? null;
      if (window.clamped) {
        // NON-SIM metering (hitch HUD). Never feeds back into resolution.
        shooter.recordRewindClamp(window.clampDir);
        this.rewindClampTotal += 1;
      }
    }
    return buildLagCompTicks(tick, rewindStamp, { resolved });
  }

  /**
   * Fill the shared lag-comp target pool with deduped poses for every living
   * player except `excludeId`. Returns the filled slot count.
   *
   * Enumeration order is stable ascending player/session id (epic 4.4),
   * matching {@link ruleRoster}. Equidistant hitscan tie-breaks and any
   * `limit` truncation therefore follow id order, not Map join order.
   */
  private collectLagCompTargets(
    excludeId: string,
    rewindTicks: readonly number[],
  ): number {
    // Reuse module-level pool to cut per-shot GC (hot path).
    // Count-based so prior slot objects are retained across shots.
    let targetCount = 0;
    for (const p of this.ruleRoster()) {
      if (p.id === excludeId || !p.alive) continue;
      // Dedup identical poses so multi-sample doesn't inflate work.
      shootSeenScratch.clear();
      for (let ri = 0; ri < rewindTicks.length; ri++) {
        const t = rewindTicks[ri]!;
        const pose = p.poseAt(t);
        const key = `${pose.x.toFixed(3)},${pose.y.toFixed(3)},${
          pose.z.toFixed(3)
        },${pose.crouch ? 1 : 0},${pose.slide ? 1 : 0},${pose.yaw.toFixed(2)},${pose.pitch.toFixed(2)},${pose.velocityX.toFixed(2)},${pose.velocityY.toFixed(2)},${pose.velocityZ.toFixed(2)},${pose.onGround ? 1 : 0},${pose.landingAmount.toFixed(2)}`;
        if (shootSeenScratch.has(key)) continue;
        shootSeenScratch.add(key);
        let slot = shootTargetScratch[targetCount];
        if (!slot) {
          slot = {
            playerId: "",
            pose: { x: 0, y: 0, z: 0, crouch: false, yaw: 0, pitch: 0 },
          };
          shootTargetScratch[targetCount] = slot;
        }
        slot.playerId = p.id;
        slot.pose.x = pose.x;
        slot.pose.y = pose.y;
        slot.pose.z = pose.z;
        slot.pose.crouch = pose.crouch;
        slot.pose.slide = pose.slide;
        slot.pose.yaw = pose.yaw;
        slot.pose.pitch = pose.pitch;
        slot.pose.velocityX = pose.velocityX;
        slot.pose.velocityY = pose.velocityY;
        slot.pose.velocityZ = pose.velocityZ;
        slot.pose.onGround = pose.onGround;
        slot.pose.landingAmount = pose.landingAmount;
        slot.pose.scale = p.modelScale;
        targetCount += 1;
      }
    }
    return targetCount;
  }

  /**
   * Melee swing (pistol-whip, shotgun stock bash) with the equipped weapon's
   * `melee` stats: short range, flat ±5 damage roll off `baseDamage` (no
   * headshot multiplier, no ammo). Weapons without `melee` can't swing. Returns an outcome with `melee: true`
   * on the shot so clients swing + thwack instead of tracer + gunshot —
   * including misses, so observers see every swing.
   */
  public handleMelee(
    attackerId: string,
    tick: number,
    packet: MeleePacket | null,
    opts?: {
      volDropPct?: number;
      nowMs?: number;
      /** Replay only: recorded RTT lag-comp stamp (see SimActionEffect). */
      recordedRewindStamp?: number | null;
    },
  ): ShootOutcome | null {
    // NON-SIM fallback for direct callers outside the tick loop. Production
    // passes the tick-loop timestamp through opts.nowMs.
    const deathNowMs = opts?.nowMs ?? Date.now();
    const attacker = this.players.get(attackerId);
    if (!attacker) return null;
    const fireEffect: SimActionEffect & { kind: "fire" } = {
      kind: "fire",
      tick,
      playerId: attackerId,
      fireKind: "melee",
      packet,
    };
    this.noteActionEffect(fireEffect);
    if (!attacker.canMelee(tick)) return null;
    // canMelee guarantees the equipped weapon has melee stats.
    const weapon = attacker.weapon;
    const melee = weapon.melee!;
    attacker.markMelee(tick);

    if (
      packet && Number.isFinite(packet.yaw) && Number.isFinite(packet.pitch)
    ) {
      attacker.yaw = packet.yaw;
      attacker.pitch = clamp(
        packet.pitch,
        -Math.PI / 2 + 0.01,
        Math.PI / 2 - 0.01,
      );
    }

    const serverEye = { x: attacker.x, y: attacker.y, z: attacker.z };
    const origin = resolveShootOrigin(serverEye, packet?.origin ?? null);
    // No bloom: the swing connects along the look direction within melee.range.
    const direction = directionFromYawPitch(attacker.yaw, attacker.pitch);

    const rewindTicks = this.resolveRewindTicks(
      attacker,
      tick,
      packet,
      opts,
      fireEffect,
    );
    const targetCount = this.collectLagCompTargets(attackerId, rewindTicks);

    // Walls block the swing: clamp to the first solid hit within melee range.
    const wallDist = this.collision.raycastSolid(
      origin,
      direction,
      melee.range,
    );
    const range = wallDist ?? melee.range;
    const hit = hitscanPoses(
      origin,
      direction,
      range,
      shootTargetScratch,
      targetCount,
    );
    const dirN = normalize(direction);
    const shot: ShotFiredPacket = {
      shooterId: attackerId,
      origin: [origin.x, origin.y, origin.z],
      direction: [dirN.x, dirN.y, dirN.z],
      weapon: weapon.id,
      hitId: hit?.playerId ?? null,
      hitZone: hit?.zone ?? null,
      hitPoint: hit ? [hit.point.x, hit.point.y, hit.point.z] : null,
      melee: true,
    };

    if (!hit) return { shot };

    const victim = this.players.get(hit.playerId);
    if (!victim || !victim.alive) return { shot };
    // Spawn protect / Force Field: swing for animation, but no damage outcomes.
    if (victim.isInvulnerable(tick)) return { shot };

    // Flat roll off melee.baseDamage — the hit zone only drives feedback.
    const damageRoll = rollDamageVariation(
      melee.baseDamage,
      this.damageRandom(),
    );
    let damage = damageRoll.damage;
    if (attacker.isRaidBot) {
      damage = scaleRaidBotDamage(damage, this.damageRandom());
    }
    // Skill H — One-shot: while active, any hit that would deal >0 damage is
    // lethal. Invulnerable targets already returned above.
    if (damage > 0 && attacker.isAbilityActive("oneShot", tick)) {
      damage = Math.max(damage, victim.health);
    }
    const isTeamHit = !attacker.isAgent && !victim.isAgent &&
      attacker.team === victim.team;
    const healthBefore = victim.health;
    const killed = victim.takeDamage(damage, hit.zone, tick, deathNowMs);
    if (!killed) victim.applyBulletHitSlow(tick);
    const appliedDamage = Math.max(0, healthBefore - victim.health);
    if (killed) {
      if (isTeamHit) {
        attacker.kills -= 2;
      } else {
        attacker.kills += 1;
      }
      victim.deaths += 1;
    }

    const damages: DamageOutcome[] = [
      {
        targetId: victim.id,
        shooterId: attackerId,
        damage,
        health: victim.health,
        zone: hit.zone,
        alive: victim.alive,
        killed,
        critical: damageRoll.critical,
        hitSlowStacks: victim.activeHitSlowStacks(tick) || undefined,
        hitSlowEndsAtTick: victim.activeHitSlowEndsAtTick(tick),
      },
    ];

    // Skill D — Leech: same enemy-damage lifesteal as shots.
    let leech = false;
    if (
      !isTeamHit &&
      appliedDamage > 0 &&
      attacker.alive &&
      attacker.hasSkillEquipped("leech")
    ) {
      const fraction = attacker.skillValue("leech");
      if (fraction > 0) {
        const leechHeal = Math.floor(appliedDamage * fraction);
        if (leechHeal > 0) {
          attacker.heal(leechHeal);
          leech = true;
        }
      }
    }

    // Friendly fire: mirror the same damage onto the attacker.
    if (isTeamHit && attacker.alive && attacker.id !== victim.id) {
      const selfKilled = attacker.takeDamage(
        damage,
        hit.zone,
        tick,
        deathNowMs,
      );
      if (!selfKilled) attacker.applyBulletHitSlow(tick);
      if (selfKilled) {
        attacker.deaths += 1;
      }
      damages.push({
        targetId: attacker.id,
        shooterId: attackerId,
        damage,
        health: attacker.health,
        zone: hit.zone,
        alive: attacker.alive,
        killed: selfKilled,
        critical: damageRoll.critical,
        hitSlowStacks: attacker.activeHitSlowStacks(tick) || undefined,
        hitSlowEndsAtTick: attacker.activeHitSlowEndsAtTick(tick),
      });
    }

    return leech ? { shot, damages, leech: true } : { shot, damages };
  }

  public processRespawns(tick: number): Player[] {
    // Pre-match warm-up: short delay even with locked doors.
    // Live open: short delay. Live closed (agents in the field): long delay.
    const doorsOpen = this.areDoorsOpen(tick);
    const prematch = this.isPrematch();
    const delayTicks = this.raidDoorPolicy !== "off"
      ? RAID_RESPAWN_DELAY_TICKS
      : doorsOpen || prematch
      ? RESPAWN_DELAY_TICKS
      : RESPAWN_DELAY_CLOSED_TICKS;

    const respawned: Player[] = [];
    for (const player of this.ruleRoster()) {
      // Agents never respawn — BotManager removes them on death.
      if (player.isAgent) continue;
      if (!player.shouldRespawn(tick, delayTicks)) continue;
      player.respawn(this.spawnFor(player.team), tick);
      respawned.push(player);
    }
    return respawned;
  }

  /**
   * Check door captures. Scorer gets a point, ammo is resupplied, and they are
   * teleported through their own door (same along-door slot, flipped depth,
   * remapped yaw, copied pitch — not a corner spawn).
   * In co-op raids, a capture instead respawns every surviving teammate at
   * their door so they begin the next shared capture together.
   * No scoring during the post-match intermission or ranked pre-match warm-up.
   */
  public processScores(tick: number): ScorePacket[] {
    if (this.matchOver) return [];
    if (this.isPrematch() && PREMATCH_CONFIG.unscored) return [];
    // Closed doors: walk-in still works physically, but captures are disabled.
    if (!this.areDoorsOpen(tick)) {
      // Drop any in-progress dwell so re-open requires a fresh walk-in.
      for (const player of this.ruleRoster()) {
        player.enemyDoorSinceTick = null;
      }
      return [];
    }

    const events: ScorePacket[] = [];
    for (const player of this.ruleRoster()) {
      if (!player.alive || player.connectionIssue) {
        player.enemyDoorSinceTick = null;
        continue;
      }
      // Grey agents never capture doors.
      if (player.isAgent) continue;
      if (tick - player.lastScoreAtTick < SCORE_COOLDOWN_TICKS) {
        player.enemyDoorSinceTick = null;
        continue;
      }

      const ownSide = player.team === "A"
        ? this.collision.map.teamA
        : this.collision.map.teamB;
      const enemySide = player.team === "A"
        ? this.collision.map.teamB
        : this.collision.map.teamA;

      if (!this.collision.isInDoorZone(player.x, player.z, enemySide)) {
        player.enemyDoorSinceTick = null;
        continue;
      }

      // Dwell in the enemy door before the capture counts (walk-in feel +
      // remote viewers see the body at the portal first).
      if (player.enemyDoorSinceTick === null) {
        player.enemyDoorSinceTick = tick;
      }
      if (tick - player.enemyDoorSinceTick < DOOR_CAPTURE_DWELL_TICKS) {
        continue;
      }

      this.scores[player.team] += 1;
      player.score += 1;
      player.lastScoreAtTick = tick;
      player.enemyDoorSinceTick = null;

      let resetPlayers: Player[] | undefined;
      if (this.raidDoorPolicy !== "off") {
        // A raid door belongs to the whole co-op team. Send every living,
        // non-agent teammate home so the next door starts with the survivors
        // together, but preserve their current health. Eliminated teammates
        // stay dead and spectate.
        resetPlayers = this.ruleRoster().filter((teammate) =>
          teammate.team === player.team && !teammate.isAgent && teammate.alive
        );
        for (const teammate of resetPlayers) {
          const home = this.collision.homeFromEnemyDoor(
            teammate.x,
            teammate.z,
            ownSide,
            enemySide,
            teammate.yaw,
          );
          teammate.enemyDoorSinceTick = null;
          teammate.sendHomeAfterScore(
            {
              x: home.x,
              y: PLAYER_HEIGHT,
              z: home.z,
              yaw: home.yaw,
              pitch: teammate.pitch,
            },
            tick,
          );
        }
      } else {
        // PvP: only the scorer exits through their own door. Keep health and
        // sprint; corner spawns remain reserved for join / death respawns.
        const home = this.collision.homeFromEnemyDoor(
          player.x,
          player.z,
          ownSide,
          enemySide,
          player.yaw,
        );
        player.sendHomeAfterScore(
          {
            x: home.x,
            y: PLAYER_HEIGHT,
            z: home.z,
            yaw: home.yaw,
            pitch: player.pitch,
          },
          tick,
        );
      }

      events.push({
        scorerId: player.id,
        team: player.team,
        scores: this.getScores(),
        player: player.toSnapshot(tick, "full", this.collision),
        ...(resetPlayers
          ? {
            resetPlayers: resetPlayers.map((teammate) =>
              teammate.toSnapshot(tick, "full", this.collision)
            ),
          }
          : {}),
      });
    }
    return events;
  }

  /**
   * After scores change, end the match if a team hit WIN_SCORE with WIN_BY_MARGIN.
   * Returns the game-over packet once (caller should broadcast).
   */
  public checkMatchEnd(tick: number): GameOverPacket | null {
    if (this.raidDoorPolicy !== "off") return null;
    if (this.matchOver || this.isPrematch()) return null;
    const winner = winningTeam(this.scores);
    if (!winner) return null;
    return this.endMatch(tick, winner);
  }

  /**
   * End the match when the wall-clock time limit is reached.
   * Leading team wins; tied scores → draw.
   */
  public checkMatchTimeLimit(tick: number): GameOverPacket | null {
    if (this.matchOver || this.isPrematch()) return null;
    if (tick < this.matchEndTick) return null;
    const { A, B } = this.scores;
    if (A > B) return this.endMatch(tick, "A");
    if (B > A) return this.endMatch(tick, "B");
    return this.endMatch(tick, "draw");
  }

  /**
   * Force the current match to end as a draw (e.g. host map change mid-game).
   * No-op if the match is already over (intermission). Does not schedule a
   * restart — caller is expected to start a new match immediately after.
   * During pre-match there is no scored match to draw — no-op.
   */
  public forceDraw(tick: number): GameOverPacket | null {
    if (this.matchOver) return null;
    if (this.isPrematch()) return null;
    return this.endMatch(tick, "draw", { scheduleRestart: false });
  }

  /** Force a scored end (raid win / fail). No rematch unless explicitly scheduled. */
  public forceEndMatch(
    tick: number,
    winner: GameOverPacket["winner"],
    opts: { scheduleRestart?: boolean; restartSeconds?: number } = {},
  ): GameOverPacket | null {
    if (this.matchOver) return null;
    return this.endMatch(tick, winner, {
      scheduleRestart: opts.scheduleRestart === true,
      restartSeconds: opts.restartSeconds,
    });
  }

  private endMatch(
    tick: number,
    winner: GameOverPacket["winner"],
    opts: { scheduleRestart?: boolean; restartSeconds?: number } = {},
  ): GameOverPacket {
    const scheduleRestart = opts.scheduleRestart !== false;
    const restartSeconds = Math.max(
      0,
      Math.trunc(opts.restartSeconds ?? MATCH_RESTART_SECONDS),
    );
    this.matchOver = true;
    this.inPrematch = false;
    this.clearReadyVotes();
    this.applyUnlimitedAmmo(false);
    this.restartAtTick = scheduleRestart
      ? tick + Math.max(1, Math.round(restartSeconds * TICK_HZ))
      : null;
    const packet: GameOverPacket = {
      winner,
      scores: this.getScores(),
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        team: p.team,
        score: p.score,
        kills: p.kills,
        deaths: p.deaths,
        alive: p.alive,
        xp: p.xp,
        mmsRankId: p.mmsRankId,
        founderBadge: p.founderBadge,
      })),
      restartInSeconds: scheduleRestart ? restartSeconds : 0,
    };
    this.gameOverSnapshot = packet;
    if (winner === "draw") {
      this.recordAuthoritativeEvent(
        deriveMatchDraw(tick, {
          scheduleRestart,
          restartSeconds,
          restartAtTick: this.restartAtTick,
          scores: packet.scores,
        }),
      );
    } else {
      this.recordAuthoritativeEvent(
        deriveMatchEnd(tick, {
          winner,
          scheduleRestart,
          restartSeconds,
          restartAtTick: this.restartAtTick,
          scores: packet.scores,
        }),
      );
    }
    return packet;
  }

  /** True when the post-match timer has elapsed and a new match should begin. */
  public isRestartDue(tick: number): boolean {
    if (!this.matchOver || this.restartAtTick === null) return false;
    return tick >= this.restartAtTick;
  }

  /**
   * When the intermission elapses, zero scores/stats, respawn everyone, and
   * return a match-start packet for broadcast. Null while still counting down.
   * Ranked servers re-enter pre-match; open servers start live immediately.
   */
  public maybeRestartMatch(tick: number): MatchStartPacket | null {
    if (!this.isRestartDue(tick)) return null;
    return this.startNewMatch(tick);
  }

  /**
   * Reset scores, K/D, personal captures; full heal + spawn everyone.
   * Ranked: enters pre-match warm-up (vote-to-start). Open: starts live.
   */
  public startNewMatch(
    tick: number,
    nowMs = Date.now(),
  ): MatchStartPacket {
    if (this.prematchEnabled) {
      return this.enterPrematch(tick, nowMs);
    }
    return this.beginLiveMatch(tick, nowMs);
  }

  /**
   * Ranked pre-match warm-up: doors locked, unlimited ammo, unscored, ready
   * votes cleared. Everyone respawns at team spawns.
   */
  public enterPrematch(
    tick: number,
    nowMs = Date.now(),
  ): MatchStartPacket {
    // Fresh match seed at each prematch session (ranked warm-up → later live).
    this.reseedSimRng();
    this.matchOver = false;
    this.restartAtTick = null;
    this.gameOverSnapshot = null;
    this.inPrematch = true;
    this.liveStartedAtMs = null;
    this.clearLiveMatchVoid();
    this.clearReadyVotes();
    this.scores = { A: 0, B: 0 };
    // Prematch has no door cycle / match clock.
    this.doorCycleOriginTick = tick;
    this.clearDoorPowerUp();
    this.matchEndTick = Number.MAX_SAFE_INTEGER;
    this.applyUnlimitedAmmo(PREMATCH_CONFIG.unlimitedAmmo);

    for (const player of this.players.values()) {
      player.resetMatchStats();
      player.resetMatchParticipation(nowMs);
      player.participationLastSampleMs = null;
      player.participationWasActive = false;
      player.lastScoreAtTick = Number.NEGATIVE_INFINITY;
      // Fresh AFK clock so sitting through endgame does not carry into kick.
      if (!player.isBot) player.touchActivity(nowMs);
      player.respawn(this.spawnFor(player.team), tick);
    }

    this.recordAuthoritativeEvent(
      deriveMatchStart(tick, {
        phase: "prematch",
        matchSeed: this.matchSeed,
        matchEndTick: this.matchEndTick,
        doorCycleOriginTick: this.doorCycleOriginTick,
        scores: this.getScores(),
        roster: [...this.players.values()],
      }),
    );

    return {
      scores: this.getScores(),
      players: [...this.players.values()].map((p) =>
        p.toSnapshot(tick, "full", this.collision, nowMs)
      ),
      phase: "prematch",
      ...this.getDoorCycleState(tick),
      ...this.getMatchClockState(),
    };
  }

  /**
   * Transition pre-match → live after unanimous ready (or open-server start).
   * Normal doors, ammo limits, scoring, and match clock.
   */
  public beginLiveMatch(
    tick: number,
    nowMs = Date.now(),
    opts?: { respawnRoster?: boolean },
  ): MatchStartPacket {
    // One seed per match session:
    // - keep the prematch seed when going live (ranked);
    // - keep the construct/test matchSeed on the first live start;
    // - reseed when starting a new live match after matchOver (open restart).
    if (!this.inPrematch && this.matchOver) this.reseedSimRng();
    this.matchOver = false;
    this.restartAtTick = null;
    this.gameOverSnapshot = null;
    this.inPrematch = false;
    // Participation metadata only; the authoritative match clock remains
    // tick-based via matchEndTick.
    this.liveStartedAtMs = nowMs;
    this.clearLiveMatchVoid();
    this.clearReadyVotes();
    this.scores = { A: 0, B: 0 };
    // Live match starts with doors open and a fresh clock.
    this.doorCycleOriginTick = tick;
    this.clearDoorPowerUp();
    this.matchEndTick = tick + this.matchDurationTicks;
    this.applyUnlimitedAmmo(false);

    // Replay reset applies recorded poses and passes respawnRoster: false so we
    // do not draw spawn RNG over the snapshot.
    const respawnRoster = opts?.respawnRoster !== false;

    for (const player of this.players.values()) {
      player.resetMatchStats();
      player.resetMatchParticipation(nowMs);
      player.lastScoreAtTick = Number.NEGATIVE_INFINITY;
      // Fresh AFK clock so sitting through endgame does not carry into kick.
      if (!player.isBot) player.touchActivity(nowMs);
      if (respawnRoster) {
        player.respawn(this.spawnFor(player.team), tick);
      }
    }

    this.recordAuthoritativeEvent(
      deriveMatchStart(tick, {
        phase: "live",
        matchSeed: this.matchSeed,
        matchEndTick: this.matchEndTick,
        doorCycleOriginTick: this.doorCycleOriginTick,
        scores: this.getScores(),
        roster: [...this.players.values()],
      }),
    );

    return {
      scores: this.getScores(),
      players: [...this.players.values()].map((p) =>
        p.toSnapshot(tick, "full", this.collision, nowMs)
      ),
      phase: "live",
      ...this.getDoorCycleState(tick),
      ...this.getMatchClockState(),
    };
  }

  /** Clear all ready votes (human join/leave or phase change). */
  public clearReadyVotes(): void {
    this.readyVotes.clear();
  }

  /**
   * Set a human's ready vote during pre-match. Returns true when lobby state
   * changed. No-op when not in pre-match or player is a bot / missing.
   */
  public setMatchReady(playerId: string, ready: boolean): boolean {
    if (!this.isPrematch()) return false;
    const player = this.players.get(playerId);
    if (!player || player.isBot) return false;

    const had = this.readyVotes.has(playerId);
    if (ready) {
      if (had) return false;
      this.readyVotes.add(playerId);
      this.recordAuthoritativeEvent(
        deriveReadyVote(this.simTick, playerId, true),
      );
      return true;
    }
    if (!had) return false;
    this.readyVotes.delete(playerId);
    this.recordAuthoritativeEvent(
      deriveReadyVote(this.simTick, playerId, false),
    );
    return true;
  }

  /**
   * Gates for vote-to-start: enough humans, even teams (if required).
   * Bots never count toward these thresholds.
   */
  public canStartFromPrematch(): boolean {
    if (!this.isPrematch()) return false;
    const humans = this.humanCount();
    if (humans < PREMATCH_CONFIG.minHumans) return false;
    if (PREMATCH_CONFIG.requireEvenTeams) {
      const { A, B } = this.humanTeamCounts();
      if (A !== B || A === 0) return false;
    }
    return true;
  }

  /**
   * If pre-match gates pass and every human is ready, start the live match.
   * Returns the match-start packet, or null if not ready to start.
   */
  public tryStartLiveFromReady(tick: number): MatchStartPacket | null {
    if (!this.canStartFromPrematch()) return null;
    if (!PREMATCH_CONFIG.requireUnanimousReady) {
      return this.beginLiveMatch(tick);
    }
    const humans = this.humans();
    if (humans.length === 0) return null;
    for (const h of humans) {
      if (!this.readyVotes.has(h.id)) return null;
    }
    return this.beginLiveMatch(tick);
  }

  /** Snapshot of ranked lobby state for Welcome / PrematchState broadcasts. */
  public getPrematchState(): PrematchStatePacket {
    const teamHumans = this.humanTeamCounts();
    const humanCount = this.humanCount();
    // Drop stale ready votes for players who left.
    for (const id of [...this.readyVotes]) {
      const p = this.players.get(id);
      if (!p || p.isBot) this.readyVotes.delete(id);
    }
    return {
      phase: this.getMatchPhase(),
      humanCount,
      humansReady: this.readyVotes.size,
      minHumans: PREMATCH_CONFIG.minHumans,
      canVote: this.canStartFromPrematch(),
      readyPlayerIds: [...this.readyVotes],
      teamHumans,
      requireEvenTeams: PREMATCH_CONFIG.requireEvenTeams,
    };
  }

  private applyUnlimitedAmmo(enabled: boolean): void {
    for (const player of this.players.values()) {
      // Agents always have infinite ammo; prematch only toggles everyone else.
      player.unlimitedAmmo = player.isAgent || enabled;
      if (enabled) {
        // Top up so warm-up always starts full.
        player.restoreLoadouts();
      }
    }
  }

  /**
   * Advance every player by one authoritative simulation tick (MovePhysics).
   *
   * SIM surface (epic 4.8): mutates player pose/combat via `Player.update` over
   * `simulationRoster`. Part of the future `stepSim` — see
   * `DETERMINISTIC_SIMULATION_ISOLATION.md`.
   *
   * Supplies tick, injected `nowMs` (overlap death stamps), collision, and
   * player-clip obstacles. Must not emit transport packets, write heatmaps,
   * sample participation, or read wall-clock/RNG directly inside this method
   * beyond the optional `nowMs` default for non-tick callers.
   *
   * Adapters (not this method): `sampleParticipation`, snapshot builders called
   * from `GameServer` driver, sessions.emit, socket maps.
   */
  public update(
    tick: number,
    // NON-SIM fallback for direct callers outside the tick loop.
    nowMs = Date.now(),
  ): PlayerDiedPacket[] {
    this.simTick = tick;
    // Portal walk-in only while doors are open (no clipping into sealed doors).
    this.collision.doorWalkInEnabled = this.areDoorsOpen(tick);
    const deaths: PlayerDiedPacket[] = [];
    for (const player of this.simulationRoster()) {
      const obstacles = player.alive
        ? this.clipObstaclesExcept(player.id)
        : [];
      player.update(this.collision, tick, obstacles);
      if (player.lastOverlapOof && player.dieFromOverlap(tick, nowMs)) {
        player.deaths += 1;
        deaths.push(this.overlapDeathPacket(player));
      }
    }
    return deaths;
  }

  /**
   * Sample wall-clock participation outside the deterministic sim update.
   * These reward/AFK meters are non-sim state and must not affect physics or
   * any future replay state hash.
   */
  public sampleParticipation(nowMs = Date.now()): void {
    if (!this.isLive()) return;
    for (const player of this.players.values()) {
      if (!player.isBot) player.sampleParticipation(nowMs);
    }
  }

  /** Alive players other than `id` — static obstacles for the current mover. */
  public clipObstaclesExcept(id: string): PlayerClipPose[] {
    const out: PlayerClipPose[] = [];
    for (const p of this.simulationRoster()) {
      if (p.id === id || !p.alive) continue;
      out.push({
        id: p.id,
        x: p.x,
        y: p.y,
        z: p.z,
        crouch: p.crouch,
      });
    }
    return out;
  }

  /**
   * Authoritative player evaluation order for one simulation tick (epic 4.7).
   *
   * Stable ascending `player.id` — same policy as {@link ruleRoster} and bot
   * `collectApplyRoster`. Join/insertion order must not change move/clip
   * outcomes (`clipObstaclesExcept` sees already-moved lower ids first).
   */
  private simulationRoster(): readonly Player[] {
    return [...this.players.values()].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    );
  }

  /**
   * Canonical order for multi-player rule passes (scores, respawns, hitscan fill).
   * Ascending session id so join order cannot alter rule outcomes or shared
   * spawn-RNG consumption. Same comparator as {@link simulationRoster}.
   */
  private ruleRoster(): Player[] {
    return [...this.players.values()].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    );
  }

  private overlapDeathPacket(player: Player): PlayerDiedPacket {
    return {
      victimId: player.id,
      killerId: player.id,
      zone: "body",
      weapon: player.weaponId,
      killerName: player.name,
      victimName: player.name,
      killerTeam: player.team,
      victimTeam: player.team,
      killerIsAgent: player.isAgent || undefined,
      victimIsAgent: player.isAgent || undefined,
    };
  }

  /**
   * Wall-clock when the current live match started, or null if not live /
   * never started.
   */
  public getLiveStartedAtMs(): number | null {
    return this.liveStartedAtMs;
  }

  /**
   * Live match duration and per-player active ms for reward participation.
   * Finalizes each human's sample window at `nowMs`.
   */
  public getMatchParticipation(nowMs = Date.now()): {
    matchDurationMs: number;
    liveStartedAtMs: number | null;
    byPlayerId: Map<string, number>;
  } {
    const started = this.liveStartedAtMs;
    const matchDurationMs = started != null ? Math.max(0, nowMs - started) : 0;
    const byPlayerId = new Map<string, number>();
    for (const player of this.players.values()) {
      if (player.isBot) continue;
      byPlayerId.set(player.id, player.finalizeParticipation(nowMs));
    }
    return { matchDurationMs, liveStartedAtMs: started, byPlayerId };
  }

  /**
   * 0..1 engagement fraction for a player (activeMs / matchDurationMs).
   * Defaults to 1 when duration is unknown (should not happen on live end).
   */
  public participationForPlayer(
    playerId: string,
    nowMs = Date.now(),
  ): number {
    const { matchDurationMs, byPlayerId } = this.getMatchParticipation(nowMs);
    const active = byPlayerId.get(playerId) ?? 0;
    if (!(matchDurationMs > 0)) return 1;
    return Math.min(1, Math.max(0, active / matchDurationMs));
  }

  /**
   * Build a snapshot for the wire.
   * @param mode `motion` (default) for the 20 Hz pose stream — omits name /
   *   cosmetics / scoreboard. `full` for join Welcome / Ready catch-up so a
   *   newly connected client can cache identity + equipment once.
   */
  public createSnapshot(
    tick: number,
    mode: SnapshotPlayerMode = "motion",
  ): SnapshotPacket {
    if (tick > this.lastSnapshotTick) this.lastSnapshotTick = tick;
    const n = this.players.size;
    const players = new Array<ReturnType<Player["toSnapshot"]>>(n);
    let i = 0;
    for (const p of this.players.values()) {
      players[i++] = p.toSnapshot(tick, mode, this.collision);
    }
    // Intermission has no AFK hard-kick — don't show a countdown on the endgame UI.
    this.stripAfkKickCountdownIfIntermission(players);
    return {
      tick,
      players,
      // Hitscan-only (epic 4.4): no simulated projectile entities. Keep empty
      // until a future epic adds a real projectile sim; see SnapshotProjectile.
      projectiles: [],
      scores: this.getScores(),
      phase: this.getMatchPhase(),
      ...this.getDoorCycleState(tick),
      ...this.getMatchClockState(),
    };
  }

  /** Full-identity roster for Welcome / Ready (names, cosmetics, scoreboard). */
  public getFullPlayerRoster(tick: number): ReturnType<Player["toSnapshot"]>[] {
    const n = this.players.size;
    const players = new Array<ReturnType<Player["toSnapshot"]>>(n);
    let i = 0;
    for (const p of this.players.values()) {
      players[i++] = p.toSnapshot(tick, "full", this.collision);
    }
    this.stripAfkKickCountdownIfIntermission(players);
    return players;
  }

  /**
   * AFK hard-kick is suspended during intermission; omit the countdown so
   * clients do not show "AFK Kicked In" on the endgame / map-vote screen.
   */
  private stripAfkKickCountdownIfIntermission(
    players: Array<{ afkKickIn?: number }>,
  ): void {
    if (!this.matchOver) return;
    for (const p of players) {
      delete p.afkKickIn;
    }
  }

  public spawnFor(team: TeamId): SpawnPose {
    const side = team === "A"
      ? this.collision.map.teamA
      : this.collision.map.teamB;
    const s = this.collision.randomSpawn(side);
    return { x: s.x, y: PLAYER_HEIGHT, z: s.z, yaw: s.yaw };
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/** First to WIN_SCORE, must lead by WIN_BY_MARGIN (e.g. 21–19 wins, 21–20 does not). */
export function winningTeam(scores: TeamScores): TeamId | null {
  const { A, B } = scores;
  if (A >= WIN_SCORE && A - B >= WIN_BY_MARGIN) return "A";
  if (B >= WIN_SCORE && B - A >= WIN_BY_MARGIN) return "B";
  return null;
}

/**
 * Door phase from a cycle origin (doors open at origin).
 * Each cycle: open for DOOR_OPEN_TICKS, then closed for DOOR_CLOSED_TICKS.
 */
export function doorCycleAt(
  tick: number,
  originTick: number,
): DoorCycleState {
  const elapsed = Math.max(0, tick - originTick);
  const cycleIndex = Math.floor(elapsed / DOOR_FULL_CYCLE_TICKS);
  const cycleStart = originTick + cycleIndex * DOOR_FULL_CYCLE_TICKS;
  const intoCycle = tick - cycleStart;
  if (intoCycle < DOOR_OPEN_TICKS) {
    return {
      doorsOpen: true,
      doorChangeTick: cycleStart + DOOR_OPEN_TICKS,
    };
  }
  return {
    doorsOpen: false,
    doorChangeTick: cycleStart + DOOR_FULL_CYCLE_TICKS,
  };
}

/**
 * Use client origin when close to server eye; if farther, pull it onto the
 * max-error sphere around the server eye (never discard and replace entirely).
 */
function resolveShootOrigin(
  serverEye: { x: number; y: number; z: number },
  clientOrigin: [number, number, number] | null,
): { x: number; y: number; z: number } {
  if (!clientOrigin) return { ...serverEye };
  const [ox, oy, oz] = clientOrigin;
  if (!Number.isFinite(ox) || !Number.isFinite(oy) || !Number.isFinite(oz)) {
    return { ...serverEye };
  }
  const dx = ox - serverEye.x;
  const dy = oy - serverEye.y;
  const dz = oz - serverEye.z;
  const err = Math.hypot(dx, dy, dz);
  if (err <= SHOOT_ORIGIN_MAX_ERROR) {
    return { x: ox, y: oy, z: oz };
  }
  if (err < 1e-8) return { ...serverEye };
  const s = SHOOT_ORIGIN_MAX_ERROR / err;
  return {
    x: serverEye.x + dx * s,
    y: serverEye.y + dy * s,
    z: serverEye.z + dz * s,
  };
}

/** Scratch for lag-comp target list (mutated only inside handleShoot). */
const shootTargetScratch: {
  playerId: string;
  pose: HitPose;
}[] = [];
const shootSeenScratch = new Set<string>();
