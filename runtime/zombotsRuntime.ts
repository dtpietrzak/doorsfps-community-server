/**
 * Live zombots slot (notes/zombots.md step 11): glue between the pure rules
 * in `shared/zombots/` and the server. It owns one run's rules objects,
 * turns their intents into zombie bots, door opens, arming and packets, and
 * feeds hits, kills, downs, joins and leaves back in. Game rules stay in
 * `shared/zombots/`; nothing here decides how many zombies, how many points
 * or what a press costs.
 *
 * GameServer calls `step` once per tick right after the Weapons phase, so a
 * door bought, a revive or a rack take lands before MovePhysics, the same
 * slot replay rebuilds apply the matching `zombots` facts in. Packets queue
 * here and leave in `flush`, after the sim step. This file does not import
 * GameServer.
 */

import { TICK_HZ } from "./GameLoop.ts";
import type { PlayerManager, ShootOutcome } from "../players/PlayerManager.ts";
import type { Player } from "../players/Player.ts";
import type { ZombotsSimFact } from "../players/simTickResult.ts";
import { ZOMBOTS_SIM_RULES } from "../players/zombotsSimRules.ts";
import type {
  CheckpointZombotsRunState,
} from "../replay/authoritativeCheckpoint.ts";
import {
  type GameOverPacket,
  type InteractPacket,
  type KickedPacket,
  NetEvents,
  type TeamId,
} from "../protocol/network.ts";
import {
  Armory,
  gunRackCost,
  isGunRackEntry,
  withinRackReach,
  ZOMBOTS_RACK_WEAPON_ID,
  type ZombotsRack,
} from "../shared/zombots/armory.ts";
import {
  distractorLurePoint,
  DistractorTracker,
} from "../shared/zombots/distractorRack.ts";
import { tryPowerRecharge } from "../shared/zombots/powerRack.ts";
import { ReviveTracker } from "../shared/zombots/revive.ts";
import type {
  ZombotsEvent,
  ZombotsIntent,
  ZombotsSpawnGate,
  ZombotsSpawnPoint,
} from "../shared/zombots/types.ts";
import { ZombotsDoorState, zombotsRoomGraph } from "../shared/zombots/zombotsDoors.ts";
import {
  buildZombotsHud,
  type ZombotsFeedEvent,
  type ZombotsHudPacket,
} from "../shared/zombots/zombotsHud.ts";
import {
  resolveZombotsInteract,
  type ZombotsInteractRack,
} from "../shared/zombots/zombotsInteract.ts";
import {
  type ZombotsLayout,
  zombotsLayout,
  zombotsSpawnGate,
} from "../shared/zombots/zombotsLayout.ts";
import { ZombotsMatch } from "../shared/zombots/ZombotsMatch.ts";
import { ZOMBOTS_TUNING } from "../shared/zombots/zombotsTuning.ts";
import { ZompointsLedger } from "../shared/zombots/zompoints.ts";
import type { SessionHub } from "../transport/types.ts";
import type { DoorsMap } from "../world/map.ts";
import { MapCollision } from "../world/MapCollision.ts";

/** Humans play on A; zombies are B (the side shots and swings care about). */
export const ZOMBOTS_HUMAN_TEAM: TeamId = "A";
export const ZOMBOTS_ZOMBIE_TEAM: TeamId = "B";

/**
 * A connected human who has not sent MapLoaded by then goes back to the
 * menu. Glue timing, not a rule: the run never waits on them meanwhile.
 */
export const ZOMBOTS_LOAD_TIMEOUT_MS = 60_000;

const TICK_MS = 1000 / TICK_HZ;

/** One zombie the runtime asks BotManager for. */
export type ZombieSpawnSpec = {
  id: string;
  name: string;
  team: TeamId;
  x: number;
  z: number;
  /** Faces this way on arrival (toward the map center). */
  yaw: number;
  maxHealth: number;
  moveSpeedScale: number;
  modelScale?: number;
};

/** The BotManager surface this runtime drives (step 12). */
export type ZombotsBotPort = {
  /** A directed zombie bot standing at the point, or null if it can't join. */
  spawnZombie(spec: ZombieSpawnSpec): Player | null;
  /** Remove one zombie (dead, or cleared). False when unknown. */
  despawnZombie(id: string): boolean;
  /**
   * Drop every zombie, and forget the engine's opened doors: the next run
   * starts on a fresh collision with every door shut.
   */
  clearZombies(): void;
  /** Set or clear the active dis-rack-tor lure point for zombie pathing. */
  setZombieLure?(point: { x: number; z: number } | null): void;
};

export type ZombotsRuntimeDeps = {
  isZombotsRuntime: () => boolean;
  players: PlayerManager;
  bots: ZombotsBotPort;
  /** Assigned in GameServer.start(). */
  sessions: () => SessionHub | null | undefined;
  map: () => DoorsMap;
  mapPath: () => string | undefined;
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

export type ZombotsStepResult = {
  /** Authoritative facts, in the order they changed the sim. */
  facts: ZombotsSimFact[];
  /** Set on the tick the run ends. GameServer reports and emits it. */
  gameOver: GameOverPacket | null;
};

/** Map-derived data that never changes within a map. */
type MapPlan = {
  map: DoorsMap;
  layout: ZombotsLayout;
  /** Door id → the phases it joins, low first; absent when not on the chain. */
  doorPhases: Map<string, readonly [number, number]>;
  racks: ZombotsInteractRack[];
};

/** One run's rules objects. Replaced whole by a new run. */
type Run = {
  match: ZombotsMatch;
  ledger: ZompointsLedger;
  revive: ReviveTracker;
  armory: Armory;
  doors: ZombotsDoorState;
  distractor: DistractorTracker;
};

/** Per-zombie stuck-detection state for soft relocate + timeout kill. */
type ZombieWatch = {
  spawnedAtTick: number;
  anchorX: number;
  anchorZ: number;
  lastProgressTick: number;
  stagnantSinceTick: number;
  lastHealth: number;
  relocates: number;
};

export class ZombotsRuntime {
  private plan: MapPlan | null = null;
  private run: Run | null = null;
  /** Events for the next `match.tick` (spawn confirmations, kills, …). */
  private pendingEvents: ZombotsEvent[] = [];
  /** One interact per player per tick; the first one counts. */
  private pendingInteracts = new Map<string, InteractPacket>();
  /** Live zombie bot ids, spawn order. */
  private readonly zombies = new Set<string>();
  /** Per-zombie progress watch for stuck recovery. */
  private readonly zombieWatch = new Map<string, ZombieWatch>();
  private zombieSeq = 0;
  /** Humans whose client built the map (NetEvents.MapLoaded). */
  readonly loadedPlayerIds = new Set<string>();
  /** First time each unloaded human was seen (wall clock, load gate). */
  private readonly firstSeenMs = new Map<string, number>();
  /** Fixed when an intermission starts so the HUD never ticks on its own. */
  private nextWaveAtTick = 0;
  private lastPhase: ZombotsMatch["phase"] = "waiting";
  /** Rules events since the last flushed HUD block. */
  private feed: ZombotsFeedEvent[] = [];
  private lastHudKey = "";
  private hudDirty = false;
  /**
   * The run's first human has joined and the run has its own match identity.
   * A warm slot serves many parties: each one needs a fresh identity, or its
   * match report replays the previous party's receipt (same as raids).
   */
  private runIdentityBegun = false;

  constructor(private readonly deps: ZombotsRuntimeDeps) {}

  get active(): boolean {
    return this.deps.isZombotsRuntime();
  }

  /** Configure the slot at boot: sim rules on, a run ready for the first join. */
  activate(): void {
    if (!this.active) return;
    this.deps.players.setZombotsRules({ ...ZOMBOTS_SIM_RULES });
    this.freshRun();
  }

  // ── session-facing ───────────────────────────────────────────────────────

  /** Load gate: this human's client built the map. */
  markLoaded(playerId: string): void {
    if (!this.active) return;
    this.loadedPlayerIds.add(playerId);
    this.firstSeenMs.delete(playerId);
  }

  /** Queue an E / right click for the next step. Bad payloads are dropped. */
  queueInteract(playerId: string, raw: unknown): void {
    if (!this.active || !this.run) return;
    if (this.pendingInteracts.has(playerId)) return;
    if (!raw || typeof raw !== "object") return;
    const o = raw as Record<string, unknown>;
    if (typeof o.yaw !== "number" || typeof o.pitch !== "number") return;
    this.pendingInteracts.set(playerId, { yaw: o.yaw, pitch: o.pitch });
  }

  /** Current HUD block (Welcome, GameOver). No feed events. */
  hud(): ZombotsHudPacket | null {
    const run = this.run;
    if (!run) return null;
    return this.buildHud(run);
  }

  /** NON-SIM: send the HUD block when it changed this tick. */
  flush(): void {
    if (!this.hudDirty) return;
    this.hudDirty = false;
    const run = this.run;
    const sessions = this.deps.sessions();
    if (!run) {
      this.feed = [];
      return;
    }
    const packet = this.buildHud(run, this.feed);
    this.feed = [];
    sessions?.emit(NetEvents.ZombotsState, packet);
  }

  private buildHud(run: Run, events?: readonly ZombotsFeedEvent[]): ZombotsHudPacket {
    const activeDistractor = run.distractor.activeAt(this.deps.players.tick);
    return buildZombotsHud({
      match: run.match,
      ledger: run.ledger,
      revive: run.revive,
      openDoorIds: run.doors.openIds(),
      doorPaid: run.doors.paidDoors(),
      nextWaveAtTick: this.nextWaveAtTick,
      ...(events ? { events } : {}),
      distractorUses: run.distractor.uses,
      ...(activeDistractor
        ? {
          distractorEndsAtTick: activeDistractor.endsAtTick,
          distractorRackId: activeDistractor.rackId,
        }
        : {}),
    });
  }

  // ── sim ──────────────────────────────────────────────────────────────────

  /**
   * One tick of rules, right after Weapons. `outcomes` are this tick's shot
   * and swing results; their wire packets are already stamped, so dead
   * zombies can leave the roster here.
   */
  step(tick: number, outcomes: readonly ShootOutcome[], nowMs: number): ZombotsStepResult {
    const result: ZombotsStepResult = { facts: [], gameOver: null };
    const run = this.run;
    if (!this.active || !run) return result;
    const players = this.deps.players;
    if (players.isMatchOver()) {
      this.pendingInteracts.clear();
      return result;
    }

    const events = this.pendingEvents;
    this.pendingEvents = [];
    this.syncRoster(run, events);
    if (run.match.humans.size > 0 && players.humanCount() === 0) {
      // Everyone timed out at once: nothing to report, just idle the slot.
      this.resetIdle();
      return result;
    }
    if (run.distractor.expire(tick)) {
      this.deps.bots.setZombieLure?.(null);
      this.hudDirty = true;
    }
    this.collectCombat(run, outcomes, events, tick);
    this.collectDowns(run, events);
    this.observeLooks(run);
    this.resolveInteracts(run, tick, nowMs, result.facts);

    const gate = zombotsSpawnGate(this.plan!.layout, this.unlockedPhases(run));
    this.watchStuckZombies(run, gate, tick, events);
    const intents = run.match.tick(TICK_MS, events, gate);
    for (const intent of intents) {
      const over = this.applyIntent(run, intent, tick);
      if (over) result.gameOver = over;
    }
    this.trackPhase(run, tick);
    this.markHudIfChanged();
    return result;
  }

  /**
   * AFK and the load gate, in the MIXED phase. Downed players can't move,
   * so they never count as AFK.
   */
  afkTick(nowMs: number): void {
    if (!this.active) return;
    const players = this.deps.players;
    const late: Player[] = [];
    const afk: Player[] = [];
    for (const p of players.humans()) {
      if (!this.loadedPlayerIds.has(p.id)) {
        const seen = this.firstSeenMs.get(p.id);
        if (seen === undefined) this.firstSeenMs.set(p.id, nowMs);
        else if (nowMs - seen >= ZOMBOTS_LOAD_TIMEOUT_MS && !p.connectionIssue) {
          late.push(p);
        }
        continue;
      }
      if (players.isMatchOver() || !p.alive || p.downed) continue;
      if (p.shouldKickForAfk(nowMs)) afk.push(p);
    }
    for (const p of late) {
      this.firstSeenMs.delete(p.id);
      this.deps.dismissHumanToMenu(p, {
        reason: "return_to_menu",
        message: "Zombots: your game didn't finish loading in time.",
      });
    }
    for (const p of afk) this.deps.kickForAfk(p);
  }

  /**
   * GameServer's intermission end, like a raid's sit: every human goes back
   * to the menu and the slot idles for the next party. A run never restarts
   * in place; doors shut again because {@link resetIdle} builds a fresh
   * collision.
   */
  closeEnded(): void {
    if (!this.active) return;
    for (const player of [...this.deps.players.humans()]) {
      this.deps.dismissHumanToMenu(player, {
        reason: "return_to_menu",
        message: "Returning to main menu.",
      });
    }
    this.resetIdle();
  }

  /** Last human left: idle the slot so the next party starts clean. */
  resetIdle(): void {
    if (!this.active) return;
    this.loadedPlayerIds.clear();
    this.firstSeenMs.clear();
    this.freshRun();
    const players = this.deps.players;
    players.clearScheduledRestart();
    players.startNewMatch(players.tick, Date.now());
  }

  /** GameOver decoration: the final HUD block. Null when not zombots. */
  decorateGameOver(packet: GameOverPacket): GameOverPacket | null {
    if (!this.active) return null;
    const hud = this.hud();
    return {
      ...packet,
      // Like raids: the sit ends in the menu, never a new run (closeEnded).
      returnToMenu: true,
      matchKind: "zombots",
      ...(hud ? { zombots: hud } : {}),
    };
  }

  /** Wave reached for the match report, or null with no run. */
  waveReached(): number | null {
    return this.run ? this.run.match.wave : null;
  }

  /** Rules objects for an authoritative checkpoint (step 14). */
  checkpointState(): CheckpointZombotsRunState | undefined {
    const run = this.run;
    if (!run) return undefined;
    const humans = [...run.match.humans];
    return {
      phase: run.match.phase,
      wave: run.match.wave,
      zombiesLeft: run.match.zombiesLeft,
      msUntilNextWave: run.match.msUntilNextWave,
      humans,
      downed: [...run.match.downed],
      purses: humans.map((id) => ({ id, points: run.ledger.get(id) })),
      revives: humans.flatMap((id) => {
        const row = run.revive.progress(id);
        return row ? [{ reviverId: id, targetId: row.targetId, presses: row.presses }] : [];
      }),
      armed: humans.map((id) => ({ id, weapons: run.armory.armedWeapons(id) })),
      doorPaid: run.doors.paidDoors(),
      zombies: [...this.zombies],
    };
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** Rules objects, zombies, collision and armed sets for a new run. */
  private freshRun(): void {
    this.deps.bots.clearZombies();
    this.deps.bots.setZombieLure?.(null);
    this.zombies.clear();
    this.zombieWatch.clear();
    this.zombieSeq = 0;
    this.pendingEvents = [];
    this.pendingInteracts.clear();
    this.feed = [];
    this.nextWaveAtTick = 0;
    this.lastPhase = "waiting";
    const map = zombotsPadMap(this.deps.map());
    if (!this.plan || this.plan.map.name !== map.name) {
      this.plan = buildMapPlan(map);
    }
    // The only way doors shut again: a collision built from the map.
    this.deps.setActiveMap({
      map,
      path: this.deps.mapPath(),
      collision: new MapCollision(map),
    });
    // Re-applying the rules empties every armed set and re-arms downing.
    this.deps.players.setZombotsRules({ ...ZOMBOTS_SIM_RULES });
    const players = this.deps.players;
    this.run = {
      match: new ZombotsMatch({
        zombieSpawns: map.zombieSpawns ?? [],
        // The agents stream: zombots has no grey agents, and checkpoints
        // already carry its cursor.
        rng: () => players.getSimRngStreams().agents(),
      }),
      ledger: new ZompointsLedger(),
      revive: new ReviveTracker(),
      armory: new Armory(),
      doors: new ZombotsDoorState(map),
      distractor: new DistractorTracker(),
    };
    this.hudDirty = true;
    this.lastHudKey = "";
    this.runIdentityBegun = false;
  }

  /** Joins and leaves, from the roster itself so every leave path counts. */
  private syncRoster(run: Run, events: ZombotsEvent[]): void {
    const present = new Set<string>();
    for (const p of this.deps.players.humans()) {
      present.add(p.id);
      if (!this.loadedPlayerIds.has(p.id) || run.match.humans.has(p.id)) continue;
      // A rejoin mid-run is a new living human with a fresh purse.
      if (p.downed) continue;
      if (!this.runIdentityBegun) this.beginRunIdentity();
      events.push({ kind: "playerJoined", playerId: p.id });
      const seeded = run.ledger.join(p.id);
      if (seeded) this.feed.push(seeded);
      run.armory.join(p.id);
    }
    for (const id of [...run.match.humans]) {
      if (present.has(id)) continue;
      events.push({ kind: "playerLeft", playerId: id });
      run.ledger.leave(id);
      run.armory.leave(id);
      run.revive.leave(id);
      this.loadedPlayerIds.delete(id);
    }
    for (const id of [...this.loadedPlayerIds]) {
      if (!present.has(id)) this.loadedPlayerIds.delete(id);
    }
  }

  /** A new party's run: its own match identity, replay start and heatmaps. */
  private beginRunIdentity(): void {
    this.runIdentityBegun = true;
    const tick = this.deps.players.tick;
    this.deps.beginRuntimeMatchIdentity(tick);
    this.deps.notifyMatchStart(tick);
    this.deps.resetHeatmaps();
  }

  /** Hits and kills on zombies by humans in the run pay points. */
  private collectCombat(
    run: Run,
    outcomes: readonly ShootOutcome[],
    events: ZombotsEvent[],
    tick: number,
  ): void {
    for (const outcome of outcomes) {
      for (const d of outcome.damages ?? []) {
        if (d.damage > 0 && this.zombies.has(d.shooterId)) {
          this.markZombieProgress(d.shooterId, tick);
        }
        if (!this.zombies.has(d.targetId)) continue;
        const by = run.match.humans.has(d.shooterId) ? d.shooterId : null;
        if (by && d.damage > 0) {
          this.markZombieProgress(d.targetId, tick);
          events.push({ kind: "zombieHit", by, zombieId: d.targetId });
          this.feed.push(run.ledger.award(by, "hit"));
        }
        if (d.killed) {
          events.push({ kind: "zombieKilled", by, zombieId: d.targetId });
          if (by) this.feed.push(run.ledger.award(by, "kill"));
          this.removeZombie(d.targetId);
        }
      }
    }
    // Anything else that left a zombie dead (or gone) still ends it.
    for (const id of [...this.zombies]) {
      const p = this.deps.players.get(id);
      if (p && p.alive) continue;
      events.push({ kind: "zombieKilled", by: null, zombieId: id });
      this.removeZombie(id);
    }
  }

  private markZombieProgress(id: string, tick: number): void {
    const w = this.zombieWatch.get(id);
    if (!w) return;
    w.lastProgressTick = tick;
    w.stagnantSinceTick = tick;
    const p = this.deps.players.get(id);
    if (p) w.lastHealth = p.health;
  }

  private removeZombie(id: string): void {
    this.zombieWatch.delete(id);
    if (!this.zombies.delete(id)) return;
    this.deps.bots.despawnZombie(id);
  }

  /**
   * Stuck-zombie safety net:
   * - Relocate after `relocateAfterMs` of no progress (up to `maxRelocates`).
   * - Auto-kill (no points) after `killAfterMs` of continuous no progress.
   * - Hard auto-kill ceiling at `maxLifetimeMs` so a wave can never soft-lock.
   */
  private watchStuckZombies(
    run: Run,
    gate: ZombotsSpawnGate,
    tick: number,
    events: ZombotsEvent[],
  ): void {
    if (this.zombies.size === 0) return;
    const {
      progressRadius,
      relocateAfterMs,
      maxRelocates,
      killAfterMs,
      maxLifetimeMs,
    } = ZOMBOTS_TUNING.stuck;
    const progressRadius2 = progressRadius * progressRadius;
    const map = this.deps.map();
    const cx = (map.bounds.minX + map.bounds.maxX) / 2;
    const cz = (map.bounds.minZ + map.bounds.maxZ) / 2;

    const activeLure = run.distractor.activeAt(tick)?.point ?? null;
    // Zombies gathered around an active dis-rack-tor are intentionally holding.
    const lureHoldRadius2 = 4.5 * 4.5;

    for (const id of [...this.zombies]) {
      const p = this.deps.players.get(id);
      if (!p || !p.alive) continue;
      let w = this.zombieWatch.get(id);
      if (!w) {
        w = {
          spawnedAtTick: tick,
          anchorX: p.x,
          anchorZ: p.z,
          lastProgressTick: tick,
          stagnantSinceTick: tick,
          lastHealth: p.health,
          relocates: 0,
        };
        this.zombieWatch.set(id, w);
        continue;
      }

      if (activeLure !== null) {
        const ldx = p.x - activeLure.x;
        const ldz = p.z - activeLure.z;
        if (ldx * ldx + ldz * ldz <= lureHoldRadius2) {
          w.lastProgressTick = tick;
          w.stagnantSinceTick = tick;
          w.lastHealth = p.health;
          continue;
        }
      }

      const lifetimeMs = (tick - w.spawnedAtTick) * TICK_MS;
      if (lifetimeMs >= maxLifetimeMs) {
        this.logStuck("kill:lifetime", run, id, p, tick, w);
        events.push({ kind: "zombieKilled", by: null, zombieId: id });
        this.removeZombie(id);
        continue;
      }

      const dx = p.x - w.anchorX;
      const dz = p.z - w.anchorZ;
      if (dx * dx + dz * dz >= progressRadius2) {
        w.anchorX = p.x;
        w.anchorZ = p.z;
        w.lastProgressTick = tick;
        w.stagnantSinceTick = tick;
      } else if (p.health < w.lastHealth) {
        w.lastProgressTick = tick;
        w.stagnantSinceTick = tick;
      }
      w.lastHealth = p.health;

      const noProgressMs = (tick - w.lastProgressTick) * TICK_MS;
      if (noProgressMs >= killAfterMs) {
        this.logStuck("kill:stagnant", run, id, p, tick, w);
        events.push({ kind: "zombieKilled", by: null, zombieId: id });
        this.removeZombie(id);
        continue;
      }

      const stagnantMs = (tick - w.stagnantSinceTick) * TICK_MS;
      if (stagnantMs >= relocateAfterMs && w.relocates < maxRelocates) {
        const spawn = this.pickRelocateSpawn(gate, p.x, p.z, w.relocates, progressRadius2);
        if (!spawn) continue;
        const oldPos = { x: p.x, z: p.z };
        const yaw = Math.atan2(-(cx - spawn.p.x), -(cz - spawn.p.z));
        p.applySpawn({ x: spawn.p.x, z: spawn.p.z, yaw }, tick);
        w.anchorX = spawn.p.x;
        w.anchorZ = spawn.p.z;
        w.stagnantSinceTick = tick;
        w.relocates += 1;
        this.logStuck("relocate", run, id, oldPos, tick, w, spawn.id);
      }
    }
  }

  private pickRelocateSpawn(
    gate: ZombotsSpawnGate,
    x: number,
    z: number,
    relocates: number,
    minDist2: number,
  ): ZombotsSpawnPoint | null {
    const all = this.deps.map().zombieSpawns ?? [];
    if (all.length === 0) return null;
    const open = all.filter((s) => gate(s.id));
    const pool = open.length > 0 ? open : all;
    const far = pool.filter((s) => {
      const dx = s.p.x - x;
      const dz = s.p.z - z;
      return dx * dx + dz * dz >= minDist2;
    });
    const base = far.length > 0 ? far : pool;
    const clear = base.filter((s) => {
      for (const zid of this.zombies) {
        const other = this.deps.players.get(zid);
        if (!other || !other.alive) continue;
        const dx = s.p.x - other.x;
        const dz = s.p.z - other.z;
        if (dx * dx + dz * dz < 2.25) return false;
      }
      for (const human of this.deps.players.humans()) {
        if (!human.alive) continue;
        const dx = s.p.x - human.x;
        const dz = s.p.z - human.z;
        if (dx * dx + dz * dz < 2.25) return false;
      }
      return true;
    });
    const candidates = clear.length > 0 ? clear : base;
    return candidates[(this.zombieSeq + relocates) % candidates.length]!;
  }

  private logStuck(
    action: "relocate" | "kill:stagnant" | "kill:lifetime",
    run: Run,
    zombieId: string,
    pos: { x: number; z: number },
    tick: number,
    watch: ZombieWatch,
    toSpawnId?: string,
  ): void {
    const mapName = this.deps.map().name;
    const room = this.plan?.layout.roomOf(pos);
    const noProgressS = ((tick - watch.lastProgressTick) * TICK_MS / 1000).toFixed(1);
    const ageS = ((tick - watch.spawnedAtTick) * TICK_MS / 1000).toFixed(1);
    const dest = toSpawnId ? ` -> spawn=${toSpawnId}` : "";
    console.warn(
      `[zombots] stuck ${action} map=${mapName} wave=${run.match.wave} id=${zombieId}` +
        ` pos=(${pos.x.toFixed(2)},${pos.z.toFixed(2)}) room=${room ?? "wall"}` +
        ` noProgress=${noProgressS}s age=${ageS}s relocates=${watch.relocates}${dest}`,
    );
  }

  private collectDowns(run: Run, events: ZombotsEvent[]): void {
    for (const id of run.match.humans) {
      if (run.match.downed.has(id)) continue;
      if (!this.deps.players.isDowned(id)) continue;
      events.push({ kind: "playerDowned", playerId: id });
      run.revive.leave(id);
      this.feed.push({ kind: "playerDowned", playerId: id });
    }
  }

  /** Revive look-at for every standing human: looking away drops the count. */
  private observeLooks(run: Run): void {
    const anyDowned = run.match.downed.size > 0;
    for (const id of run.match.humans) {
      if (run.match.downed.has(id)) continue;
      const before = run.revive.progress(id);
      const target = anyDowned
        ? this.deps.players.downedBodyInSight(id, ZOMBOTS_TUNING.revive.reach)
        : null;
      run.revive.observeLook(id, target);
      const after = run.revive.progress(id);
      if ((before?.presses ?? 0) > 0 && (after?.presses ?? 0) === 0) {
        this.hudDirty = true;
      }
    }
  }

  /** Interacts in ascending player id, the Weapons queue's order. */
  private resolveInteracts(
    run: Run,
    tick: number,
    nowMs: number,
    facts: ZombotsSimFact[],
  ): void {
    if (this.pendingInteracts.size === 0) return;
    const queued = [...this.pendingInteracts].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    this.pendingInteracts.clear();
    const players = this.deps.players;
    for (const [id, look] of queued) {
      const p = players.get(id);
      if (!p || !p.alive || p.downed || !run.match.humans.has(id)) continue;
      const yaw = Number.isFinite(look.yaw) ? look.yaw : p.yaw;
      const eye = { x: p.x, z: p.z };
      const downedInSight = run.match.downed.size > 0
        ? players.downedBodyInSight(id, ZOMBOTS_TUNING.revive.reach)
        : null;
      const target = resolveZombotsInteract({
        eye,
        look: { x: -Math.sin(yaw), z: -Math.cos(yaw) },
        downedInSight,
        doors: run.doors.all(),
        isDoorOpen: (doorId) => run.doors.isOpen(doorId),
        racks: this.plan!.racks,
      });
      if (!target) continue;
      switch (target.kind) {
        case "revive":
          this.pressRevive(run, id, downedInSight, nowMs, facts);
          break;
        case "door":
          this.buyDoor(run, id, target.doorId, eye, facts);
          break;
        case "rack":
          this.takeRack(run, id, target.rackId, eye, tick, facts);
          break;
      }
    }
  }

  private pressRevive(
    run: Run,
    reviverId: string,
    inSight: string | null,
    nowMs: number,
    facts: ZombotsSimFact[],
  ): void {
    run.revive.observeLook(reviverId, inSight);
    const row = run.revive.progress(reviverId);
    const result = run.revive.press(reviverId, {
      // "Alive" for revive.ts means still in the run, downed or not.
      isAlive: (id) => run.match.humans.has(id),
      isDowned: (id) => run.match.downed.has(id),
      trySpend: (id, cost) => {
        const spent = run.ledger.trySpend(id, cost, "revivePress");
        if (spent.ok) this.feed.push(spent.intent);
        return spent.ok;
      },
      inReach: row !== null && row.targetId === inSight,
    });
    if (result.kind === "refused") return;
    this.hudDirty = true;
    if (result.kind !== "revived") return;
    const revived = this.deps.players.revivePlayer(result.targetId, result.health, nowMs);
    if (!revived) return;
    run.match.markRevived(result.targetId);
    this.feed.push(result.intent);
    facts.push({
      op: "revived",
      playerId: result.targetId,
      by: reviverId,
      healthFraction: result.health,
    });
  }

  private buyDoor(
    run: Run,
    playerId: string,
    doorId: string,
    eye: { x: number; z: number },
    facts: ZombotsSimFact[],
  ): void {
    const paid: ZombotsFeedEvent[] = [];
    const bought = run.doors.tryOpenDoor(playerId, doorId, eye, (cost) => {
      const spent = run.ledger.trySpend(playerId, cost, "door");
      if (spent.ok) paid.push(spent.intent);
      return { ok: spent.ok, points: spent.points };
    });
    if (!bought.ok) return;
    this.feed.push(...paid);
    this.hudDirty = true;
    // A charge short of the cost: the HUD shows the door's progress.
    if (!bought.intent) return;
    this.feed.push(bought.intent);
    // Both server collisions: the sim's here, the bot engine's through the
    // open-door list in its next think frame.
    this.deps.players.getCollision().openSlidingDoor(doorId);
    facts.push({ op: "doorOpened", doorId, by: playerId });
  }

  private takeRack(
    run: Run,
    playerId: string,
    rackId: string,
    eye: { x: number; z: number },
    tick: number,
    facts: ZombotsSimFact[],
  ): void {
    const entry = this.plan!.racks.find((r) => r.rack.id === rackId);
    if (!entry) return;
    const rack = entry.rack;
    if (!isGunRackEntry(rack)) {
      if (rack.weapon === "distractor") {
        this.useDistractorRack(run, playerId, entry, eye, tick);
      } else {
        this.usePowerRack(run, playerId, rack, eye, facts);
      }
      return;
    }
    // Pre-checks the armory repeats, so nothing is charged for a refusal.
    const downed = run.match.downed.has(playerId);
    if (downed || !withinRackReach(rack.center, eye)) return;
    const weaponId = ZOMBOTS_RACK_WEAPON_ID[rack.weapon];
    const players = this.deps.players;
    const armed = run.armory.isArmed(playerId, weaponId);
    const cost = gunRackCost(weaponId, armed, players.spareClipsFor(playerId, weaponId));
    if (players.hasFullSpareClips(playerId, weaponId) || cost <= 0) {
      this.feed.push({ kind: "rackRefused", playerId, rackId });
      this.hudDirty = true;
      return;
    }
    const spent = run.ledger.trySpend(playerId, cost, "gunRack");
    if (!spent.ok) return;
    this.feed.push(spent.intent);
    const taken = run.armory.tryTakeFromRack(
      playerId,
      rack,
      eye,
      run.match.downed.has(playerId),
    );
    if (taken.kind !== "ok") return;
    if (taken.firstTake) {
      if (!players.armPlayer(playerId, taken.weaponId)) return;
    } else if (!players.refillPlayerAmmo(playerId, taken.weaponId)) {
      return;
    }
    if (taken.intent) {
      this.feed.push(taken.intent);
      this.hudDirty = true;
    }
    facts.push({
      op: "armed",
      playerId,
      weaponId: taken.weaponId,
      refill: !taken.firstTake,
    });
  }

  /**
   * Power recharge rack: pay `racks.powerCost` and start the skill-charge
   * regen a door capture would. Nothing is debited when nothing is spent.
   */
  private usePowerRack(
    run: Run,
    playerId: string,
    rack: ZombotsRack,
    eye: { x: number; z: number },
    facts: ZombotsSimFact[],
  ): void {
    const players = this.deps.players;
    const paid: ZombotsFeedEvent[] = [];
    const result = tryPowerRecharge({
      rackCenter: rack.center,
      eye,
      isDowned: run.match.downed.has(playerId),
      canRecharge: players.canPowerRecharge(playerId),
      trySpend: (cost) => {
        const spent = run.ledger.trySpend(playerId, cost, "powerRecharge");
        if (spent.ok) paid.push(spent.intent);
        return spent;
      },
    });
    if (result.kind !== "ok") return;
    this.feed.push(...paid);
    players.powerRechargePlayer(playerId);
    facts.push({ op: "powerRecharged", playerId });
    this.hudDirty = true;
  }

  /**
   * Dis-rack-tor rack: pay escalating zompoints (2000 + 500 per prior use)
   * and lure every zombie to the floor in front of this rack for 1 minute.
   */
  private useDistractorRack(
    run: Run,
    playerId: string,
    entry: ZombotsInteractRack,
    eye: { x: number; z: number },
    tick: number,
  ): void {
    const paid: ZombotsFeedEvent[] = [];
    const result = run.distractor.tryActivate({
      rackId: entry.rack.id,
      rackCenter: entry.rack.center,
      lurePoint: distractorLurePoint(entry.rack.center, entry.facing),
      eye,
      isDowned: run.match.downed.has(playerId),
      tick,
      durationTicks: Math.round(ZOMBOTS_TUNING.racks.distractorDurationMs / TICK_MS),
      trySpend: (cost) => {
        const spent = run.ledger.trySpend(playerId, cost, "distractor");
        if (spent.ok) paid.push(spent.intent);
        return spent;
      },
    });
    if (result.kind !== "ok") return;
    this.feed.push(...paid);
    this.deps.bots.setZombieLure?.(result.point);
    this.hudDirty = true;
  }

  /**
   * Phases the players can reach: 1, then one more for each opened door on
   * the phase chain. A door only counts once the phase before it is open.
   */
  private unlockedPhases(run: Run): number {
    const open = run.doors.openIds();
    const plan = this.plan!;
    if (!plan.layout.phases) return Math.min(3, 1 + open.length);
    let unlocked = 1;
    let grew = true;
    while (grew) {
      grew = false;
      for (const id of open) {
        const pair = plan.doorPhases.get(id);
        if (pair && pair[0] <= unlocked && pair[1] > unlocked) {
          unlocked = pair[1];
          grew = true;
        }
      }
    }
    return unlocked;
  }

  private applyIntent(run: Run, intent: ZombotsIntent, tick: number): GameOverPacket | null {
    switch (intent.kind) {
      case "spawnZombie":
        this.spawnZombie(intent, tick);
        return null;
      case "waveStart":
        this.feed.push(intent);
        return null;
      case "waveCleared": {
        this.feed.push(intent);
        const living = [...run.match.humans].filter((id) => !run.match.downed.has(id));
        for (const paid of run.ledger.awardWaveSurvived(living)) this.feed.push(paid);
        return null;
      }
      case "runOver":
        return this.endRun(intent, tick);
      default:
        // playerDowned / playerRevived / pointsChanged / doorOpened /
        // weaponTaken come from the glue's own calls, not the wave machine.
        return null;
    }
  }

  private spawnZombie(
    intent: Extract<ZombotsIntent, { kind: "spawnZombie" }>,
    tick: number,
  ): void {
    this.zombieSeq += 1;
    const n = this.zombieSeq;
    const map = this.deps.map();
    const cx = (map.bounds.minX + map.bounds.maxX) / 2;
    const cz = (map.bounds.minZ + map.bounds.maxZ) / 2;
    const spawned = this.deps.bots.spawnZombie({
      id: `bot:zombie-${n}`,
      name: n === 1 ? "zombie" : `zombie${n}`,
      team: ZOMBOTS_ZOMBIE_TEAM,
      x: intent.p.x,
      z: intent.p.z,
      // Player yaw: forward is (-sin, -cos).
      yaw: Math.atan2(-(cx - intent.p.x), -(cz - intent.p.z)),
      maxHealth: intent.health,
      moveSpeedScale: intent.speedScale,
      modelScale: intent.modelScale,
    });
    if (!spawned) {
      console.warn(`[zombots] zombie ${n} could not join; the wave may stall`);
      return;
    }
    this.deps.players.setMeleeDamageOverride(spawned.id, intent.meleeDamage);
    this.zombies.add(spawned.id);
    this.zombieWatch.set(spawned.id, {
      spawnedAtTick: tick,
      anchorX: spawned.x,
      anchorZ: spawned.z,
      lastProgressTick: tick,
      stagnantSinceTick: tick,
      lastHealth: spawned.health,
      relocates: 0,
    });
    this.pendingEvents.push({
      kind: "zombieSpawned",
      zombieId: spawned.id,
      spawnId: intent.spawnId,
    });
  }

  private endRun(
    intent: Extract<ZombotsIntent, { kind: "runOver" }>,
    tick: number,
  ): GameOverPacket | null {
    this.feed.push(intent);
    this.hudDirty = true;
    this.deps.bots.setZombieLure?.(null);
    for (const id of [...this.zombies]) this.removeZombie(id);
    // Zombies win a wipe. Restart seconds are the default intermission.
    return this.deps.players.forceEndMatch(tick, ZOMBOTS_ZOMBIE_TEAM, {
      scheduleRestart: true,
    });
  }

  private trackPhase(run: Run, tick: number): void {
    const phase = run.match.phase;
    if (phase === "intermission" && this.lastPhase !== "intermission") {
      this.nextWaveAtTick = tick + Math.round(run.match.msUntilNextWave / TICK_MS);
    }
    if (phase !== "intermission") this.nextWaveAtTick = 0;
    this.lastPhase = phase;
  }

  private markHudIfChanged(): void {
    const run = this.run;
    if (!run) return;
    if (this.feed.length > 0) this.hudDirty = true;
    const hud = this.buildHud(run);
    const key = JSON.stringify(hud);
    if (key !== this.lastHudKey) {
      this.lastHudKey = key;
      this.hudDirty = true;
    }
  }
}

/**
 * Humans spawn on the one pad at `spawnCorner`. Arena maps pick between two
 * team corners; a zombots map's other corner can sit in a zombie closure.
 * Returns the same map when it already has one corner.
 */
export function zombotsPadMap(map: DoorsMap): DoorsMap {
  const corner = map.spawnCorner;
  if (corner === undefined) return map;
  const [a, b] = map.teamA.corners;
  if (a === corner && b === corner) return map;
  return { ...map, teamA: { ...map.teamA, corners: [corner, corner] } };
}

function buildMapPlan(map: DoorsMap): MapPlan {
  const layout = zombotsLayout(map);
  const doorPhases = new Map<string, readonly [number, number]>();
  if (layout.phases) {
    const phaseOfRoom = new Map<number, number>();
    layout.phases.forEach((room, i) => phaseOfRoom.set(room, i + 1));
    for (const door of zombotsRoomGraph(map).doorRooms) {
      if (!door.rooms) continue;
      const a = phaseOfRoom.get(door.rooms[0]);
      const b = phaseOfRoom.get(door.rooms[1]);
      if (a === undefined || b === undefined) continue;
      doorPhases.set(door.doorId, a < b ? [a, b] : [b, a]);
    }
  }
  const racks: ZombotsInteractRack[] = [];
  for (const rack of map.gunRacks ?? []) {
    const placed = layout.rackPhase.find((r) => r.rackId === rack.id);
    const entry: ZombotsRack = {
      id: rack.id,
      weapon: rack.weapon,
      center: { x: rack.center.x, z: rack.center.z },
    };
    racks.push({ rack: entry, facing: placed?.facing ?? null });
  }
  if (layout.errors.length > 0) {
    console.warn(
      `[zombots] map "${map.name}" layout has ${layout.errors.length} error(s): ${layout.errors[0]}`,
    );
  }
  return { map, layout, doorPhases, racks };
}
