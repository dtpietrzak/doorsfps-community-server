/**
 * Epic 11.2 — Replay simulation runner (arena-only).
 *
 * Owns the session → reconstruction boundary: a private PlayerManager stepped
 * from recorded inputs/events with no bot AI, no sockets, no emits, no I/O.
 *
 * Start state: `initialState.startCheckpoint` when present (recordings arm
 * mid-match); events at `appliedTick <= captureTick` are already in it.
 *
 * Per-tick order (SIM-only subset of live `GameServer.stepSimBody`):
 *   1. Structural applies (join/add/remove/loadout/team) from recorded events
 *   2. Movement re-queue via `handleInput` (recorded packets verbatim;
 *      `queuedInput` on dead rows; held `repeat_missing` never re-arrives)
 *   3. Action replay in recorded ordinal order via `handle*` (between-tick
 *      immediates from T−1 first, with their own tick)
 *   4. pruneDeadAgents (local; no bot-manager import) + deferred agentRemove
 *   5. `players.update` (MovePhysics + OverlapDeath) + deferred playerRemove
 *   6. `processScores`
 *   7. `checkMatchEnd` / `checkMatchTimeLimit`; matchStart SIM-subset
 *   8. `processRespawns`
 *
 * Excluded: RaidEncounter, BotChurn/Think/Apply, NON_SIM (participation /
 * heatmaps / ping), MIXED (connection-timeout / AFK), driver emits/snapshots.
 *
 * Event disposition:
 *   re-apply: humanJoin, botAdd, agentAdd, agentRemove, playerRemove,
 *             loadoutCommit, teamAssign, matchStart (SIM subset)
 *   deferred: agentRemove of a live agent (post-weapons prune phase),
 *             playerRemove of a connection-issue player (post-MovePhysics)
 *   compare-only: combatBurst, playerDied, score, gameOver, playerRespawned,
 *                 matchEnd, matchDraw, matchConfig (loud if match-block disagrees)
 *   ignore: readyVote, connectionStatus
 *   fail-closed: matchInit in-stream, unrecognized kinds
 *
 * Raid sessions (`metadata.raidMatch.active === true`) fail closed at
 * create/reset — arena-only scope (notes/replay.md §29.5).
 *
 * Future raid follow-up will need collision resolved per-tick/event instead of
 * once at construction (map switches); this arena runner injects one collision.
 */

import type {
  AuthoritativeEvent,
  AuthoritativeRosterSnapshot,
  MatchInitEvent,
} from "../shared/sim/authoritativeEvent.ts";
import { TICK_HZ } from "../shared/sim/game.ts";
import type { SkillId } from "../shared/sim/skills.ts";
import type { PlayerManager } from "../players/PlayerManager.ts";
import { PlayerManager as PlayerManagerCtor } from "../players/PlayerManager.ts";
import type { Player } from "../players/Player.ts";
import type {
  GameOverPacket,
  PlayerDiedPacket,
  PlayerInput,
  ScorePacket,
  ShootPacket,
} from "../protocol/network.ts";
import type { MapCollision } from "../world/MapCollision.ts";
import type { AuthoritativeCheckpoint } from "./authoritativeCheckpoint.ts";
import type { CheckpointIndexLookup } from "./checkpointIndex.ts";
import { loadCheckpointState } from "./checkpointLoading.ts";
import type { RecordedInitialState } from "./recordedInitialState.ts";
import type { RecordedActionRow } from "./recordedTickInputs.ts";
import type { RecordedTickInputs } from "./recordedTickInputs.ts";

// ---------------------------------------------------------------------------
// Session contract (11.1 LoadedReplay satisfies later; tests/buffer now)
// ---------------------------------------------------------------------------

/**
 * Minimal session interface for reconstruction. No bytes, no container, no
 * version gate — those stay in 11.1. Dense `inputAt`, sparse `eventsAt`.
 */
export type ReplayRunSession = {
  readonly initialState: RecordedInitialState;
  readonly firstTick: number;
  readonly lastTick: number;
  inputAt(tick: number): RecordedTickInputs;
  eventsAt(tick: number): ReadonlyArray<AuthoritativeEvent>;
  /** Exact-tick checkpoint frame, or null/undefined on miss (never floors). */
  checkpointFrameAt?(tick: number): AuthoritativeCheckpoint | null | undefined;
  /**
   * 9.5 floor for 14.3 seek. Optional: a miss means start from initial state.
   * The runner never calls this. `checkpointFrameAt` is not a floor.
   */
  findPriorCheckpoint?(tick: number): CheckpointIndexLookup;
};

export type ReplayRunnerOptions = {
  /** Injected collision for the whole run (arena maps never change mid-match). */
  readonly collision: MapCollision;
};

export type ReplayRosterDigestEntry = {
  readonly id: string;
  readonly name: string;
  readonly team: "A" | "B";
  readonly alive: boolean;
  readonly isBot: boolean;
  readonly isAgent: boolean;
  readonly connectionIssue: boolean;
};

/** Per-tick compare facts for 11.5 / 18.x — never emitted on the wire. */
export type ReplayTickOutcome = {
  readonly tick: number;
  readonly overlapDeaths: ReadonlyArray<PlayerDiedPacket>;
  readonly scores: ReadonlyArray<ScorePacket>;
  readonly respawnedIds: ReadonlyArray<string>;
  readonly gameOver: GameOverPacket | null;
  readonly rosterDigest: ReadonlyArray<ReplayRosterDigestEntry>;
  /** Recorded compare-only events at this tick (not applied). */
  readonly recordedOutcomes: ReadonlyArray<AuthoritativeEvent>;
};

export type ReplayRunner = {
  readonly session: ReplayRunSession;
  /** Tick most recently completed by `step` / reset; next step must be +1. */
  readonly currentTick: number;
  readonly firstTick: number;
  readonly lastTick: number;
  /**
   * Private simulation owner. Read for 11.5 projection / 18.x compare;
   * do not drive it outside the runner.
   */
  readonly simulation: PlayerManager;
  resetToInitial(): void;
  resetToCheckpoint(frame: AuthoritativeCheckpoint): void;
  step(tick: number): ReplayTickOutcome;
};

// ---------------------------------------------------------------------------
// Errors (fail-closed, named — mirror checkpoint load style)
// ---------------------------------------------------------------------------

export class ReplayRunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayRunnerError";
  }
}

/** Raid/co-op sessions are out of scope for 11.2 (notes/replay.md §29.5). */
export class ReplayRaidUnsupportedError extends ReplayRunnerError {
  constructor() {
    super(
      "replay raid sessions are not supported (arena-only scope); " +
        "metadata.raidMatch.active === true",
    );
    this.name = "ReplayRaidUnsupportedError";
  }
}

export class ReplayStepOrderError extends ReplayRunnerError {
  readonly expected: number;
  readonly actual: number;
  constructor(expected: number, actual: number) {
    super(
      `replay step out of order: expected tick ${expected}, got ${actual}`,
    );
    this.name = "ReplayStepOrderError";
    this.expected = expected;
    this.actual = actual;
  }
}

export class ReplayInputGapError extends ReplayRunnerError {
  readonly tick: number;
  readonly playerId: string;
  constructor(tick: number, playerId: string) {
    super(
      `replay input gap at tick ${tick}: missing movement row for player ${playerId}`,
    );
    this.name = "ReplayInputGapError";
    this.tick = tick;
    this.playerId = playerId;
  }
}

export class ReplayUnknownPlayerInputError extends ReplayRunnerError {
  readonly tick: number;
  readonly playerId: string;
  constructor(tick: number, playerId: string) {
    super(
      `replay unknown player input at tick ${tick}: player ${playerId} not on roster`,
    );
    this.name = "ReplayUnknownPlayerInputError";
    this.tick = tick;
    this.playerId = playerId;
  }
}

export class ReplayEventDispositionError extends ReplayRunnerError {
  readonly tick: number;
  readonly kind: string;
  constructor(tick: number, kind: string, detail: string) {
    super(`replay event disposition at tick ${tick} kind=${kind}: ${detail}`);
    this.name = "ReplayEventDispositionError";
    this.tick = tick;
    this.kind = kind;
  }
}

export class ReplayResetSelfCheckError extends ReplayRunnerError {
  constructor(detail: string) {
    super(`replay resetToInitial self-check failed: ${detail}`);
    this.name = "ReplayResetSelfCheckError";
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tickNowMs(tick: number): number {
  return (tick * 1000) / TICK_HZ;
}

function assertArenaSession(initial: RecordedInitialState): void {
  if (initial.metadata.raidMatch.active === true) {
    throw new ReplayRaidUnsupportedError();
  }
}

function rosterDigest(manager: PlayerManager): ReplayRosterDigestEntry[] {
  return [...manager.all()].map((p) => ({
    id: p.id,
    name: p.name,
    team: p.team,
    alive: p.alive,
    isBot: p.isBot,
    isAgent: p.isAgent,
    connectionIssue: p.connectionIssue,
  }));
}

function poseClose(
  a: { x: number; y: number; z: number; yaw: number; pitch: number },
  b: { x: number; y: number; z: number; yaw: number; pitch: number },
  eps = 1e-6,
): boolean {
  return (
    Math.abs(a.x - b.x) <= eps &&
    Math.abs(a.y - b.y) <= eps &&
    Math.abs(a.z - b.z) <= eps &&
    Math.abs(a.yaw - b.yaw) <= eps &&
    Math.abs(a.pitch - b.pitch) <= eps
  );
}

function firePacketFromAim(aim: RecordedActionRow & { kind: "fire" }): ShootPacket {
  const packet: ShootPacket = {
    yaw: aim.aim.yaw,
    pitch: aim.aim.pitch,
  };
  if (aim.aim.origin) packet.origin = aim.aim.origin;
  if (aim.aim.clientTick !== undefined) packet.clientTick = aim.aim.clientTick;
  if (aim.aim.lastAppliedSnapshotTick !== undefined) {
    packet.lastAppliedSnapshotTick = aim.aim.lastAppliedSnapshotTick;
  }
  return packet;
}

function applyConnectionAssociation(
  player: Player,
  association: string,
): void {
  if (association === "connection_issue") {
    // Sitting-duck condition live sets before stepping (Decision 4).
    // Player.markConnectionIssue — no authoritative event (informational only).
    if (!player.isBot && !player.connectionIssue) {
      player.markConnectionIssue(Number.MAX_SAFE_INTEGER);
    }
    return;
  }
  if (player.connectionIssue) {
    player.connectionIssue = false;
    player.connectionIssueDeadlineMs = null;
  }
}

/**
 * Place a recorded roster row at its recorded pose.
 * Agents keep isAgent for grey-dome render; fill-bot vs human is irrelevant —
 * both are simulated players fed recorded inputs. No add/addBot spawn RNG.
 */
function insertRosterEntry(
  manager: PlayerManager,
  entry: AuthoritativeRosterSnapshot,
  _nowMs: number,
): void {
  manager.insertFromAuthoritativeRoster(entry);
}

/**
 * Advance spawn RNG the way live did for a virgin-seed start:
 * one draw per roster row at join, then one per row at beginLiveMatch respawn.
 * Poses themselves come from the recording — these draws only keep the stream
 * cursor aligned for later mid-match joins on fixture-style captures.
 */
function advanceSpawnStreamForRecordedLiveStart(
  manager: PlayerManager,
  roster: readonly AuthoritativeRosterSnapshot[],
): void {
  for (const entry of roster) {
    void manager.spawnFor(entry.team);
  }
  for (const entry of roster) {
    void manager.spawnFor(entry.team);
  }
}

/**
 * SIM subset of `beginLiveMatch`: score/door/clock reset without RNG respawns.
 * When `roster` is provided (init or matchStart event), poses are applied from
 * the recording after the match-block write.
 */
function applyMatchStartSimSubset(
  manager: PlayerManager,
  tick: number,
  nowMs: number,
  roster?: readonly AuthoritativeRosterSnapshot[],
): void {
  if (roster && roster.length > 0) {
    advanceSpawnStreamForRecordedLiveStart(manager, roster);
  }
  manager.beginLiveMatch(tick, nowMs, { respawnRoster: false });
  if (roster) {
    for (const entry of roster) {
      manager.applyAuthoritativeRosterPose(entry);
    }
  }
}

function applyTeamFromEvent(
  manager: PlayerManager,
  playerId: string,
  to: "A" | "B",
): void {
  const player = manager.get(playerId);
  if (!player) {
    throw new ReplayEventDispositionError(
      manager.tick,
      "teamAssign",
      `player ${playerId} missing`,
    );
  }
  if (player.team === to) return;
  // Mirror live setter mutation (changeTeam / forceChangeTeam / botRebalance):
  // team write + spawn draw. Bypass gate checks — assignment already happened.
  player.team = to;
  player.respawn(manager.spawnFor(to), manager.tick);
}

function pruneDeadAgentsLocal(manager: PlayerManager, tick: number): void {
  const agents = [...manager.all()].filter((p) => p.isAgent);
  if (agents.length === 0) return;
  const hadAgents = agents.length > 0;
  for (const agent of agents) {
    if (agent.alive) continue;
    manager.remove(agent.id);
  }
  if (hadAgents && manager.agentCount() === 0) {
    manager.reopenDoorsAfterAgentsCleared(tick);
  }
}

function assertMatchConfigAgrees(
  manager: PlayerManager,
  event: Extract<AuthoritativeEvent, { kind: "matchConfig" }>,
): void {
  if (
    event.raidDoorPolicy !== undefined &&
    event.raidDoorPolicy !== manager.getRaidDoorPolicy()
  ) {
    throw new ReplayEventDispositionError(
      event.appliedTick,
      "matchConfig",
      `raidDoorPolicy disagree: running=${manager.getRaidDoorPolicy()} event=${event.raidDoorPolicy}`,
    );
  }
  if (
    event.debugForceDoorsOpen !== undefined &&
    event.debugForceDoorsOpen !== manager.getDebugForceDoorsOpen()
  ) {
    throw new ReplayEventDispositionError(
      event.appliedTick,
      "matchConfig",
      `debugForceDoorsOpen disagree: running=${manager.getDebugForceDoorsOpen()} event=${event.debugForceDoorsOpen}`,
    );
  }
}

function applyStructuralEvent(
  manager: PlayerManager,
  event: AuthoritativeEvent,
  nowMs: number,
): "applied" | "compare" | "ignored" | "deferPostWeapons" | "deferPostMove" {
  switch (event.kind) {
    case "humanJoin": {
      insertRosterEntry(manager, event.player, nowMs);
      return "applied";
    }
    case "botAdd": {
      insertRosterEntry(manager, event.player, nowMs);
      return "applied";
    }
    case "agentAdd": {
      insertRosterEntry(manager, event.player, nowMs);
      return "applied";
    }
    case "agentRemove": {
      // Live prunes dead agents *after* weapons; the drain can't say which
      // phase a removal came from. An agent still alive here is removed at
      // its live phase (post-weapons prune) instead of before weapons.
      if (manager.get(event.playerId)?.alive) return "deferPostWeapons";
      manager.remove(event.playerId);
      return "applied";
    }
    case "playerRemove": {
      // Connection-timeout removals run after MovePhysics (MIXED phase).
      if (manager.get(event.playerId)?.connectionIssue) {
        return "deferPostMove";
      }
      manager.remove(event.playerId);
      return "applied";
    }
    case "loadoutCommit": {
      const raw = event.loadout ?? [];
      manager.handleSkillLoadout(event.playerId, raw);
      return "applied";
    }
    case "teamAssign": {
      applyTeamFromEvent(manager, event.playerId, event.to);
      return "applied";
    }
    case "matchStart": {
      applyMatchStartSimSubset(
        manager,
        event.appliedTick,
        nowMs,
        event.roster,
      );
      return "applied";
    }
    case "combatBurst":
    case "playerDied":
    case "score":
    case "gameOver":
    case "playerRespawned":
    case "matchEnd":
    case "matchDraw":
      return "compare";
    case "matchConfig": {
      assertMatchConfigAgrees(manager, event);
      return "compare";
    }
    case "readyVote":
    case "connectionStatus":
      return "ignored";
    case "matchInit":
      throw new ReplayEventDispositionError(
        event.appliedTick,
        "matchInit",
        "matchInit must not appear in the tick event stream (diverted by 8.2)",
      );
    default: {
      const kind = (event as { kind: string }).kind;
      throw new ReplayEventDispositionError(
        (event as { appliedTick: number }).appliedTick,
        kind,
        "unclassified authoritative event kind",
      );
    }
  }
}

function replayActions(
  manager: PlayerManager,
  tick: number,
  actions: ReadonlyArray<RecordedActionRow>,
  nowMs: number,
): void {
  // Ordinals already encode live effect order — never re-sort. Rows may carry
  // the prior tick: between-tick immediates that ran live after that tick's
  // MovePhysics, recorded in this envelope and applied with their own tick.
  for (const row of actions) {
    if (row.tick !== tick && row.tick !== tick - 1) {
      throw new ReplayRunnerError(
        `action row tick ${row.tick} not in envelope tick ${tick} (or ${tick - 1})`,
      );
    }
    const effectTick = row.tick;
    switch (row.kind) {
      case "fire": {
        const packet = firePacketFromAim(row);
        const opts = row.rewindStamp !== undefined
          ? { nowMs, recordedRewindStamp: row.rewindStamp }
          : { nowMs };
        if (row.fireKind === "melee") {
          manager.handleMelee(row.playerId, effectTick, packet, opts);
        } else {
          manager.handleShoot(row.playerId, effectTick, packet, opts);
        }
        break;
      }
      case "reload":
        manager.handleReload(row.playerId, effectTick);
        break;
      case "weaponSelect":
        manager.handleWeaponSwitch(row.playerId, row.weapon, effectTick);
        break;
      case "ability":
        manager.handleAbility(row.playerId, row.ability as SkillId, effectTick);
        break;
      default: {
        const kind = (row as { kind: string }).kind;
        throw new ReplayRunnerError(`unclassified action kind: ${kind}`);
      }
    }
  }
}

function queueMovement(
  manager: PlayerManager,
  tick: number,
  inputs: RecordedTickInputs,
  nowMs: number,
  removedThisTick: ReadonlySet<string>,
): void {
  const roster = [...manager.all()];
  const byId = new Map(inputs.movement.map((row) => [row.playerId, row]));

  for (const player of roster) {
    const row = byId.get(player.id);
    // Removed later this tick in live (deferred remove): no end-of-tick row.
    if (!row && removedThisTick.has(player.id)) continue;
    if (!row) {
      throw new ReplayInputGapError(tick, player.id);
    }
    byId.delete(player.id);
    applyConnectionAssociation(player, row.association);
    // No selection but a live arrival: dead look-only, or killed after
    // queueing — live still ran queueInput before weapons.
    if (row.association === "repeat_missing" && row.selectedInput != null) {
      // No arrival live: keep look written since (shots), keep the held packet.
      player.restoreHeldInput({ ...(row.selectedInput as PlayerInput) });
      continue;
    }
    const queued = row.selectedInput ?? row.queuedInput ?? null;
    if (queued != null) {
      // Recorded inputs are deep-frozen; Player.update clears one-shot
      // jump/meleeLunge on the live packet via consumeWireMovementEdges.
      manager.handleInput(
        player.id,
        { ...(queued as PlayerInput) },
        nowMs,
      );
    }
  }

  for (const leftover of byId.keys()) {
    throw new ReplayUnknownPlayerInputError(tick, leftover);
  }
}

function selfCheckAgainstInit(
  manager: PlayerManager,
  init: MatchInitEvent,
): void {
  const scores = manager.getScores();
  if (scores.A !== init.scores.A || scores.B !== init.scores.B) {
    throw new ReplayResetSelfCheckError(
      `scores expected ${JSON.stringify(init.scores)} got ${JSON.stringify(scores)}`,
    );
  }
  const live = [...manager.all()];
  if (live.length !== init.roster.length) {
    throw new ReplayResetSelfCheckError(
      `roster size expected ${init.roster.length} got ${live.length}`,
    );
  }
  for (let i = 0; i < init.roster.length; i++) {
    const expected = init.roster[i]!;
    const actual = live[i]!;
    if (actual.id !== expected.id) {
      throw new ReplayResetSelfCheckError(
        `roster order at ${i}: expected ${expected.id} got ${actual.id}`,
      );
    }
    if (actual.team !== expected.team) {
      throw new ReplayResetSelfCheckError(
        `roster ${expected.id} team expected ${expected.team} got ${actual.team}`,
      );
    }
    const pose = {
      x: actual.x,
      y: actual.y,
      z: actual.z,
      yaw: actual.yaw,
      pitch: actual.pitch,
    };
    if (!poseClose(pose, expected.pose)) {
      throw new ReplayResetSelfCheckError(
        `roster ${expected.id} pose mismatch: expected ${JSON.stringify(expected.pose)} got ${JSON.stringify(pose)}`,
      );
    }
  }
}

function buildManager(
  collision: MapCollision,
  init: MatchInitEvent,
): PlayerManager {
  const durationSeconds = init.matchDurationTicks / TICK_HZ;
  const manager = new PlayerManagerCtor(collision, {
    matchSeed: init.matchSeed,
    matchDurationSeconds: durationSeconds,
    enablePrematch: init.prematchEnabled,
    // Tick-derived placeholder — never wall-clock on runner paths.
    nowMs: tickNowMs(init.appliedTick),
  });
  if (init.raidDoorPolicy !== "off") {
    manager.setRaidDoorPolicy(init.raidDoorPolicy);
  }
  if (init.debugForceDoorsOpen) {
    manager.setDebugForceDoorsOpen(true);
  }
  return manager;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

class ReplayRunnerImpl implements ReplayRunner {
  readonly session: ReplayRunSession;
  readonly firstTick: number;
  readonly lastTick: number;
  private readonly collision: MapCollision;
  private manager: PlayerManager;
  private _currentTick: number;

  constructor(session: ReplayRunSession, collision: MapCollision) {
    assertArenaSession(session.initialState);
    if (
      !Number.isInteger(session.firstTick) ||
      !Number.isInteger(session.lastTick) ||
      session.lastTick < session.firstTick
    ) {
      throw new ReplayRunnerError(
        `invalid session tick range [${session.firstTick}, ${session.lastTick}]`,
      );
    }
    this.session = session;
    this.firstTick = session.firstTick;
    this.lastTick = session.lastTick;
    this.collision = collision;
    this.manager = buildManager(collision, session.initialState.init);
    this._currentTick = session.firstTick - 1;
    this.resetToInitial();
  }

  get currentTick(): number {
    return this._currentTick;
  }

  get simulation(): PlayerManager {
    return this.manager;
  }

  resetToInitial(): void {
    assertArenaSession(this.session.initialState);
    const { init, captureTick, startCheckpoint } = this.session.initialState;
    const nowMs = tickNowMs(captureTick);

    this.manager = buildManager(this.collision, init);

    if (startCheckpoint) {
      // Full state at captureTick — recordings usually start mid-match, where
      // init.roster + beginLiveMatch would reset the clock/doors and lose
      // health, ammo, stamina, and ability timers.
      loadCheckpointState(this.manager, startCheckpoint, {
        expectedInit: this.session.initialState,
      });
      this.manager.drainAuthoritativeEvents();
      this._currentTick = this.firstTick - 1;
      return;
    }

    // Recorded poses are authoritative — do not re-derive via addBot/add spawn RNG.
    for (const entry of init.roster) {
      insertRosterEntry(this.manager, entry, nowMs);
    }

    if (init.phase === "live") {
      // Match clock/doors/scores from live start; poses stay from init.roster.
      applyMatchStartSimSubset(this.manager, captureTick, nowMs, init.roster);
    }

    this.manager.drainAuthoritativeEvents();
    selfCheckAgainstInit(this.manager, init);
    this._currentTick = this.firstTick - 1;
  }

  resetToCheckpoint(frame: AuthoritativeCheckpoint): void {
    assertArenaSession(this.session.initialState);
    loadCheckpointState(this.manager, frame, {
      expectedInit: this.session.initialState,
    });
    this.manager.drainAuthoritativeEvents();
    this._currentTick = frame.tick;
  }

  step(tick: number): ReplayTickOutcome {
    const expected = this._currentTick + 1;
    if (tick !== expected) {
      throw new ReplayStepOrderError(expected, tick);
    }
    if (tick < this.firstTick || tick > this.lastTick) {
      throw new ReplayRunnerError(
        `step tick ${tick} outside session range [${this.firstTick}, ${this.lastTick}]`,
      );
    }

    const nowMs = tickNowMs(tick);
    const recordedOutcomes: AuthoritativeEvent[] = [];

    // 1. Structural applies at churn position (drain order).
    const captureTick = this.session.initialState.captureTick;
    const removePostWeapons: string[] = [];
    const removePostMove: string[] = [];
    for (const event of this.session.eventsAt(tick)) {
      // Facts at or before the capture instant are already in the initial
      // state (e.g. the humanJoin that armed a mid-match recording).
      if (
        this.session.initialState.startCheckpoint &&
        event.appliedTick <= captureTick
      ) {
        continue;
      }
      const disposition = applyStructuralEvent(this.manager, event, nowMs);
      if (disposition === "compare") recordedOutcomes.push(event);
      if (disposition === "deferPostWeapons" || disposition === "deferPostMove") {
        const id = (event as { playerId: string }).playerId;
        (disposition === "deferPostWeapons" ? removePostWeapons : removePostMove)
          .push(id);
      }
      // Scratch events from add*/beginLiveMatch/loadout — drain, never expose.
      this.manager.drainAuthoritativeEvents();
    }

    // 2. Movement re-queue.
    const inputs = this.session.inputAt(tick);
    if (inputs.tick !== tick) {
      throw new ReplayRunnerError(
        `inputAt(${tick}) returned row for tick ${inputs.tick}`,
      );
    }
    queueMovement(
      this.manager,
      tick,
      inputs,
      nowMs,
      new Set([...removePostWeapons, ...removePostMove]),
    );

    // 3. Action replay in ordinal order.
    replayActions(this.manager, tick, inputs.actions, nowMs);

    // 4. Prune dead agents (post-weapons).
    pruneDeadAgentsLocal(this.manager, tick);
    for (const id of removePostWeapons) {
      if (this.manager.get(id)) this.manager.remove(id);
    }

    // 5. MovePhysics + OverlapDeath.
    const overlapDeaths = this.manager.update(tick, nowMs);
    if (overlapDeaths.length > 0) {
      pruneDeadAgentsLocal(this.manager, tick);
    }
    for (const id of removePostMove) {
      if (this.manager.get(id)) this.manager.remove(id);
    }

    // 6. Scores.
    const scores = this.manager.processScores(tick);

    // 7. Match end / time limit (arena; raid fail paths excluded by scope).
    let gameOver: GameOverPacket | null = null;
    if (scores.length > 0) {
      gameOver = this.manager.checkMatchEnd(tick);
    }
    if (!gameOver && !this.manager.isMatchOver()) {
      gameOver = this.manager.checkMatchTimeLimit(tick);
    }
    // matchStart structural apply already handled in step 1 when present.

    // 8. Respawns.
    const respawned = this.manager.processRespawns(tick);

    this.manager.drainAuthoritativeEvents();
    this._currentTick = tick;

    return {
      tick,
      overlapDeaths,
      scores,
      respawnedIds: respawned.map((p) => p.id),
      gameOver,
      rosterDigest: rosterDigest(this.manager),
      recordedOutcomes,
    };
  }
}

/**
 * Create a SIM-only replay runner over a session + injected collision.
 * Fails closed on raid sessions. Calls `resetToInitial` before returning.
 */
export function createReplayRunner(
  session: ReplayRunSession,
  options: ReplayRunnerOptions,
): ReplayRunner {
  return new ReplayRunnerImpl(session, options.collision);
}

/** @internal test aid — tick-derived time helper (never wall-clock). */
export function __replayTickNowMsForTest(tick: number): number {
  return tickNowMs(tick);
}
