/**
 * Epic 4.7 — canonical per-tick phase identities.
 *
 * Stable names for the authoritative GameServer tick callback order.
 * Later epics (#8 recording, #9 checkpoints) may key phase boundaries on
 * these identities. This module does not drive control flow by itself;
 * `GameServer.startGameLoop` is the runtime source of truth and must match.
 *
 * See `DETERMINISTIC_SYSTEM_ORDERING.md`.
 */

/** Whether a phase advances replay-relevant sim state. */
export type SimPhaseKind = "SIM" | "NON_SIM" | "MIXED";

export type SimTickPhaseId =
  | "RaidEncounter"
  | "BotChurn"
  | "BotHousekeeping"
  | "BotApply"
  | "Weapons"
  | "PruneDeadAgents"
  | "MovePhysics"
  | "OverlapDeath"
  | "Participation"
  | "Heatmaps"
  | "ConnectionAfkRebalance"
  | "ScoresRules"
  | "MatchEnd"
  | "Intermission"
  | "Respawn"
  | "PoseSnapshot"
  | "Ping"
  | "BotThink";

export interface SimTickPhase {
  readonly id: SimTickPhaseId;
  readonly kind: SimPhaseKind;
  /** Short note: inputs / outputs / what it must not touch. */
  readonly summary: string;
}

/**
 * Total ordered phase list for one simulation tick.
 * Every sim mutation in `startGameLoop` maps to exactly one phase.
 */
export const SIM_TICK_PHASES: readonly SimTickPhase[] = [
  {
    id: "RaidEncounter",
    kind: "SIM",
    summary: "Raid-only agent spawn check; may add agents to the roster.",
  },
  {
    id: "BotChurn",
    kind: "SIM",
    summary:
      "Bot join/leave roster mutations. Cadence RNG owned by 4.6; order position owned by 4.7.",
  },
  {
    id: "BotHousekeeping",
    kind: "SIM",
    summary: "Agent door-drops, seed pings, intermission freeze.",
  },
  {
    id: "BotApply",
    kind: "SIM",
    summary:
      "Apply ReadyActions thought THINK_BUFFER_BOT_TICKS earlier (input / weapon switch / reload / ability). Shoot intents enqueue into the Weapons queue instead of resolving here (PR 4). Must not run this tick's AI.",
  },
  {
    id: "Weapons",
    kind: "SIM",
    summary:
      "Flush deferred Shoot/Melee — humans queued on packet arrival, bots enqueued from BotApply (PR 4). Ascending shooter id, one shared resolution order. Before MovePhysics.",
  },
  {
    id: "PruneDeadAgents",
    kind: "SIM",
    summary:
      "Remove dead agents after weapons resolution (and again after overlap deaths if needed).",
  },
  {
    id: "MovePhysics",
    kind: "SIM",
    summary:
      "Player.update over simulationRoster (ascending player.id): switch/reload/ability/move/clip.",
  },
  {
    id: "OverlapDeath",
    kind: "SIM",
    summary: "Finalize overlap deaths; emit PlayerDied; prune dead agents again.",
  },
  {
    id: "Participation",
    kind: "NON_SIM",
    summary: "Wall-clock reward participation sampling; must not mutate sim state.",
  },
  {
    id: "Heatmaps",
    kind: "NON_SIM",
    summary: "Spatial heatmap metering; must not feed sim resolution.",
  },
  {
    id: "ConnectionAfkRebalance",
    kind: "MIXED",
    summary:
      "Connection timeout / abandon / AFK kick / pending rebalance. Wall-clock gated; roster removals are authoritative events for #5. 4.8: inject nowMs; keep MIXED in step; emit/heatmap adapters stay in driver (see DETERMINISTIC_SIMULATION_ISOLATION.md).",
  },
  {
    id: "ScoresRules",
    kind: "SIM",
    summary: "processScores over ruleRoster; emit Score.",
  },
  {
    id: "MatchEnd",
    kind: "SIM",
    summary:
      "checkMatchEnd / raid fail / time limit → onMatchEnded + GameOver when applicable.",
  },
  {
    id: "Intermission",
    kind: "SIM",
    summary:
      "isRestartDue → finishIntermission (may startNewMatch this same tick, before Respawn).",
  },
  {
    id: "Respawn",
    kind: "SIM",
    summary:
      "processRespawns; emit PlayerRespawned. Runs even when matchOver (pinned).",
  },
  {
    id: "PoseSnapshot",
    kind: "NON_SIM",
    summary: "Wire pose stream emit; must not mutate sim state.",
  },
  {
    id: "Ping",
    kind: "NON_SIM",
    summary: "~1 Hz latency probes; must not mutate sim state.",
  },
  {
    id: "BotThink",
    kind: "NON_SIM",
    summary:
      "Budgeted AI after sim/emit. Enqueues ReadyActions for apply at thinkTick + THINK_BUFFER only; must not mutate Player combat/pose this tick.",
  },
] as const;

/** Phase ids in execution order (handy for tests / later recorders). */
export const SIM_TICK_PHASE_IDS: readonly SimTickPhaseId[] = SIM_TICK_PHASES.map(
  (p) => p.id,
);

/** Pinned authoritative event emission order within a tick. */
export const SIM_TICK_EVENT_ORDER = [
  "CombatBurst",
  "PlayerDied",
  "Score",
  "GameOver",
  "PlayerRespawned",
] as const;

export type SimTickEventName = (typeof SIM_TICK_EVENT_ORDER)[number];
