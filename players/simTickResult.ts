/**
 * Epic 4.8 / 7.1 — in-memory authoritative events returned by `stepSim`.
 *
 * The tick driver (`GameServer.startGameLoop`) owns transport emit.
 * Event order must match `SIM_TICK_EVENT_ORDER` in `simTickPhases.ts`.
 * Roster-leave facts (7.1) are emitted by the driver after sim events.
 *
 * No recording / checkpoint / file format here — handoff surface for #5/#8/#9.
 */

import type {
  CombatOutcomePacket,
  GameOverPacket,
  PlayerDiedPacket,
  ScorePacket,
} from "../protocol/network.ts";
import type { ShootOutcome } from "./PlayerManager.ts";
import type { Player } from "./Player.ts";
import type { SIM_TICK_EVENT_ORDER } from "./simTickPhases.ts";

/** One CombatBurst-worth of outcomes (bots and humans may each produce one). */
export type SimCombatBurstEvent = {
  readonly type: "CombatBurst";
  readonly outcomes: readonly ShootOutcome[];
  /**
   * Wire packets stamped at weapons time, while killer/victim names still
   * resolve. Optional in tests; live `stepSimBody` always sets this before
   * `pruneDeadAgents`.
   */
  readonly packets?: readonly CombatOutcomePacket[];
};

export type SimPlayerDiedEvent = {
  readonly type: "PlayerDied";
  readonly death: PlayerDiedPacket;
};

export type SimScoreEvent = {
  readonly type: "Score";
  readonly score: ScorePacket;
};

export type SimGameOverEvent = {
  readonly type: "GameOver";
  /** Raw packet from match-end checks; driver may `enrichGameOver` before emit. */
  readonly gameOver: GameOverPacket;
};

export type SimPlayerRespawnedEvent = {
  readonly type: "PlayerRespawned";
  readonly player: Player;
};

export type SimTickEvent =
  | SimCombatBurstEvent
  | SimPlayerDiedEvent
  | SimScoreEvent
  | SimGameOverEvent
  | SimPlayerRespawnedEvent;

export type SimTickEventType = (typeof SIM_TICK_EVENT_ORDER)[number];

export interface SimShootHeatmapFact {
  readonly playerId: string;
  /** Door-open flag at weapons time (may differ after agent prune). */
  readonly doorsOpen: boolean;
}

/**
 * Connection-timeout roster leave collected inside MIXED (epic 7.1).
 * Driver emits `PlayerLeft` (+ optional `MapVoteState`) — never `stepSim`.
 * Construction order matches the former in-step emit loop.
 */
export interface SimRosterLeaveFact {
  readonly playerId: string;
  /** True when the leaver held an open map vote (triggers MapVoteState). */
  readonly hadMapVote: boolean;
}

/**
 * Result of one authoritative sim step.
 * Heatmap / participation / roster-leave facts are applied by the driver (NON-SIM).
 */
export interface SimTickResult {
  readonly events: readonly SimTickEvent[];
  /** Shooters to `heatmaps.recordShoot` after the step (weapons-time doorsOpen). */
  readonly shootHeatmap: readonly SimShootHeatmapFact[];
  /** Players to `heatmaps.recordPlayerDeparture` after the step. */
  readonly heatmapDepartures: readonly Player[];
  /**
   * Connection-timeout leaves to emit as `PlayerLeft` / `MapVoteState`
   * after `emitSimTickEvents` (epic 7.1). Order preserved from MIXED loop.
   */
  readonly rosterLeaves: readonly SimRosterLeaveFact[];
}
