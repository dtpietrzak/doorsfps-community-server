/**
 * Pure derivation shims: live Player / PlayerManager state → AuthoritativeEvent.
 * Replay epic 5.5 — side-effect-free; does not mutate sim state.
 *
 * Call sites construct via these helpers and push into
 * `PlayerManager.drainAuthoritativeEvents()` for later 7.5 / 8.4 consumers.
 */

import type { Player } from "./Player.ts";
import type { PlayerEquipment } from "../shared/sim/game.ts";
import type { SkillLoadout, SkillProductId } from "../shared/sim/skills.ts";
import {
  makeAgentAddEvent,
  makeAgentRemoveEvent,
  makeBotAddEvent,
  makeConnectionStatusEvent,
  makeHumanJoinEvent,
  makeLoadoutCommitEvent,
  makeMatchConfigEvent,
  makeMatchDrawEvent,
  makeMatchEndEvent,
  makeMatchInitEvent,
  makeMatchStartEvent,
  makePlayerRemoveEvent,
  makeReadyVoteEvent,
  makeTeamAssignEvent,
  type AuthoritativeEvent,
  type AuthoritativeMapIdentity,
  type AuthoritativeMatchPhase,
  type AuthoritativeMatchWinner,
  type AuthoritativePose,
  type AuthoritativeRaidDoorPolicy,
  type AuthoritativeRosterSnapshot,
  type AuthoritativeTeamId,
  type AuthoritativeTeamScores,
  type TeamAssignEvent,
} from "../shared/sim/authoritativeEvent.ts";

/** Snapshot equipment fields from a live Player. */
export function equipmentFromPlayer(player: Player): PlayerEquipment {
  return {
    head: player.headType,
    visor: player.visorType,
    shoulder: player.shoulderType,
    body: player.bodyType,
    leg: player.legType,
    hue: player.hue,
    gunHue: player.gunHue,
    bulletHue: player.bulletHue,
    crosshairColor: player.crosshairColor,
    nameHue: player.nameHue,
    pistol: player.pistolType,
    rifle: player.rifleType,
    shotgun: player.shotgunType,
    scope: player.scopeType,
    crosshair: player.crosshairType,
  };
}

/** Snapshot pose from a live Player (always finite after spawn). */
export function poseFromPlayer(player: Player): AuthoritativePose {
  return {
    x: player.x,
    y: player.y,
    z: player.z,
    yaw: player.yaw,
    pitch: player.pitch,
  };
}

/**
 * Sim-relevant roster snapshot (Decision 3).
 * Excludes AFK / participation / party / wall-clock deadlines.
 */
export function rosterSnapshotFromPlayer(
  player: Player,
): AuthoritativeRosterSnapshot {
  const owned = player.snapshotOwnedAbilities();
  return {
    id: player.id,
    name: player.name,
    team: player.team as AuthoritativeTeamId,
    // Roster/checkpoint `isBot` is the raid-bot *role*, not "AI-controlled" —
    // see the keys-only note. Arena fill bots record isBot: false,
    // same as humans.
    isBot: player.isRaidBot,
    isAgent: player.isAgent,
    isBalanceBot: false,
    alive: player.alive,
    connectionIssue: player.connectionIssue,
    unlimitedAmmo: player.unlimitedAmmo,
    maxHealth: player.maxHealth,
    modelScale: player.modelScale,
    moveSpeedScale: player.moveSpeedScale,
    pose: poseFromPlayer(player),
    equipment: equipmentFromPlayer(player),
    skillLoadout: player.snapshotSkillLoadout(),
    ownedAbilities: owned as SkillProductId[] | null,
  };
}

export function deriveHumanJoin(
  appliedTick: number,
  player: Player,
): AuthoritativeEvent {
  return makeHumanJoinEvent({
    appliedTick,
    player: rosterSnapshotFromPlayer(player),
  });
}

export function deriveBotAdd(
  appliedTick: number,
  player: Player,
): AuthoritativeEvent {
  return makeBotAddEvent({
    appliedTick,
    player: rosterSnapshotFromPlayer(player),
  });
}

export function deriveAgentAdd(
  appliedTick: number,
  player: Player,
): AuthoritativeEvent {
  return makeAgentAddEvent({
    appliedTick,
    player: rosterSnapshotFromPlayer(player),
  });
}

export function deriveAgentRemove(
  appliedTick: number,
  playerId: string,
): AuthoritativeEvent {
  return makeAgentRemoveEvent(appliedTick, playerId);
}

export function derivePlayerRemove(
  appliedTick: number,
  playerId: string,
): AuthoritativeEvent {
  return makePlayerRemoveEvent(appliedTick, playerId);
}

export function deriveConnectionStatus(
  appliedTick: number,
  player: Player,
  opts: { connectionIssue: boolean; respawned: boolean },
): AuthoritativeEvent {
  return makeConnectionStatusEvent({
    appliedTick,
    playerId: player.id,
    connectionIssue: opts.connectionIssue,
    socketId: player.socketId,
    respawned: opts.respawned,
    player: rosterSnapshotFromPlayer(player),
  });
}

export function deriveTeamAssign(
  appliedTick: number,
  player: Player,
  opts: {
    reason: TeamAssignEvent["reason"];
    from: AuthoritativeTeamId;
    to: AuthoritativeTeamId;
  },
): AuthoritativeEvent {
  return makeTeamAssignEvent({
    appliedTick,
    reason: opts.reason,
    playerId: player.id,
    from: opts.from,
    to: opts.to,
    player: rosterSnapshotFromPlayer(player),
  });
}

export function deriveLoadoutCommit(
  appliedTick: number,
  playerId: string,
  loadout: SkillLoadout | null,
): AuthoritativeEvent {
  return makeLoadoutCommitEvent({ appliedTick, playerId, loadout });
}

export function deriveReadyVote(
  appliedTick: number,
  playerId: string,
  ready: boolean,
): AuthoritativeEvent {
  return makeReadyVoteEvent({ appliedTick, playerId, ready });
}

export function deriveReadyVoteClearAll(
  appliedTick: number,
): AuthoritativeEvent {
  return makeReadyVoteEvent({
    appliedTick,
    ready: false,
    clearAll: true,
  });
}

export function deriveMatchConfig(
  appliedTick: number,
  patch: {
    raidDoorPolicy?: AuthoritativeRaidDoorPolicy;
    debugForceDoorsOpen?: boolean;
  },
): AuthoritativeEvent {
  return makeMatchConfigEvent({ appliedTick, ...patch });
}

export function deriveMatchStart(
  appliedTick: number,
  opts: {
    phase: "prematch" | "live";
    matchSeed: number;
    matchEndTick: number;
    doorCycleOriginTick: number;
    scores: AuthoritativeTeamScores;
    roster: readonly Player[];
  },
): AuthoritativeEvent {
  return makeMatchStartEvent({
    appliedTick,
    phase: opts.phase,
    matchSeed: opts.matchSeed,
    matchEndTick: opts.matchEndTick,
    doorCycleOriginTick: opts.doorCycleOriginTick,
    scores: { ...opts.scores },
    roster: opts.roster.map(rosterSnapshotFromPlayer),
  });
}

export function deriveMatchEnd(
  appliedTick: number,
  opts: {
    winner: AuthoritativeMatchWinner;
    scheduleRestart: boolean;
    restartSeconds: number;
    restartAtTick: number | null;
    scores: AuthoritativeTeamScores;
  },
): AuthoritativeEvent {
  return makeMatchEndEvent({
    appliedTick,
    winner: opts.winner,
    scheduleRestart: opts.scheduleRestart,
    restartSeconds: opts.restartSeconds,
    restartAtTick: opts.restartAtTick,
    scores: { ...opts.scores },
  });
}

export function deriveMatchDraw(
  appliedTick: number,
  opts: {
    scheduleRestart: boolean;
    restartSeconds: number;
    restartAtTick: number | null;
    scores: AuthoritativeTeamScores;
  },
): AuthoritativeEvent {
  return makeMatchDrawEvent({
    appliedTick,
    scheduleRestart: opts.scheduleRestart,
    restartSeconds: opts.restartSeconds,
    restartAtTick: opts.restartAtTick,
    scores: { ...opts.scores },
  });
}

export function deriveMatchInit(
  appliedTick: number,
  opts: {
    map: AuthoritativeMapIdentity;
    matchSeed: number;
    matchDurationTicks: number;
    prematchEnabled: boolean;
    phase: AuthoritativeMatchPhase;
    raidDoorPolicy: AuthoritativeRaidDoorPolicy;
    debugForceDoorsOpen: boolean;
    scores: AuthoritativeTeamScores;
    roster: readonly Player[];
  },
): AuthoritativeEvent {
  return makeMatchInitEvent({
    appliedTick,
    map: opts.map,
    matchSeed: opts.matchSeed,
    matchDurationTicks: opts.matchDurationTicks,
    prematchEnabled: opts.prematchEnabled,
    phase: opts.phase,
    raidDoorPolicy: opts.raidDoorPolicy,
    debugForceDoorsOpen: opts.debugForceDoorsOpen,
    scores: { ...opts.scores },
    roster: opts.roster.map(rosterSnapshotFromPlayer),
  });
}
