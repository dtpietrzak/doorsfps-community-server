/**
 * Extension surface for the one bot engine. Third parties may pass one too.
 *
 * `createBotThinkEngine` takes the object once. It covers every pawn on that
 * engine and rides on `ThinkContext`; thoughts read it from there. Omitted
 * fields keep the public behavior. Parameters carry no official numbers and
 * no motor code.
 *
 * Residual pole heat is not a hook. The yaw-pole step scores it when the
 * frame carries `humanHeatByPole` and `humanHeatWeight` is above 0.
 */

import {
  AGENT_BOT_CONFIGS,
  BALANCE_BOT_CONFIG,
  type BotBrainConfig,
  COMMUNITY_BOT_CONFIG,
  RAID_BOT_CONFIG,
  RAID_NO_STOPS_BOT_CONFIG,
} from "./config.ts";
import type { Player } from "./players/Player.ts";
import type { BotBrainState } from "./pipeline/state.ts";
import type {
  ReadyAction,
  StepResult,
  ThinkContext,
} from "./pipeline/types.ts";
import type { BotWorldView } from "./types.ts";
import {
  resetPublicLookLife,
  runPublicLookStep,
} from "./thoughts/publicLook.ts";

/**
 * Aim-planner knobs the look step may read. A Fitts pair of 0 is instant
 * look. `primaryGainMean` stays 1 on the public configs and is unused then.
 * The numbers live on the config, not in this type.
 */
export type LookAimKnobs = {
  fittsASec: number;
  fittsBSec: number;
  pathWidthDeg: number;
  primaryGainMean: number;
  primaryGainSpread: number;
  correctionDelayMs: number;
  maxCorrections: number;
  curvature: number;
  pursuitLagMs: number;
  combatWidthRad: number;
};

/**
 * Look step. The default is `runPublicLookStep`, which ignores every knob
 * past the look-reaction pair. A motor installed in their place reads them.
 */
export type LookStep = (
  ctx: ThinkContext,
  prior: ReadyAction,
  draftState: BotBrainState,
  lookReactionBaseMs: number,
  lookReactionVarianceMs: number,
  rng: () => number,
  yawLookTauSec: number,
  overshootMinFrac: number,
  overshootMaxFrac: number,
  microNoiseAmp: number,
  trackErrorAmp: number,
  aim: LookAimKnobs,
) => StepResult<ReadyAction>;

/**
 * Knobs the target-enemy step has already set for camp, grey agents, and
 * vault or duck. A hook may change them before the duel.
 *
 * `doorPriorityRatio` 1 drops the duel when the door is closer. Lower favors
 * the door. `ignoreDoorPriority` is set when hunt already ignores the door.
 */
export type CombatBiasKnobs = {
  doorAggression: number;
  standGroundChance: number;
  ignoreDoorPriority: boolean;
  doorPriorityRatio: number;
};

/**
 * What the target-enemy step already decided this think. Read-only. A hook
 * cannot work these out from the view: camp plant is brain state.
 */
export type CombatBiasSituation = {
  /** Standing on this pawn's door-camp plant. */
  campPlanted: boolean;
  /** Closed-door hunt is steering this pawn. */
  huntActive: boolean;
};

export type BrainHooks = {
  look: LookStep;
  /**
   * Called from the target-enemy step after the mobility knobs are set, and
   * only when the pawn can fight. The default returns `knobs`.
   */
  combatBias: (
    me: Player,
    view: BotWorldView,
    knobs: CombatBiasKnobs,
    situation: CombatBiasSituation,
  ) => CombatBiasKnobs;
  /**
   * Config lookup when a definition carries no explicit config. The default
   * maps `agent` and `balance-bot`, and otherwise uses the community config.
   * An explicit `config` wins and does not call this.
   */
  resolveConfig: (profile: string) => BotBrainConfig;
  /**
   * Death and new-life clear of the look chain. The default drops the public
   * servo. A motor installed in its place also drops its own latches.
   */
  resetLookLife: (state: BotBrainState) => void;
};

function publicCombatBias(
  _me: Player,
  _view: BotWorldView,
  knobs: CombatBiasKnobs,
  _situation: CombatBiasSituation,
): CombatBiasKnobs {
  return knobs;
}

/**
 * Public profile lookup. An in-process `BotDefinition.config` is applied
 * first; over the wire the profile is all the engine has, so every config the
 * host spawns has a name here.
 */
export function publicResolveConfig(profile: string): BotBrainConfig {
  switch (profile) {
    case "agent":
    case "agent-easy":
      return AGENT_BOT_CONFIGS.easy;
    case "agent-medium":
      return AGENT_BOT_CONFIGS.medium;
    case "agent-hard":
      return AGENT_BOT_CONFIGS.hard;
    case "balance-bot":
      return BALANCE_BOT_CONFIG;
    case "raid":
      return RAID_BOT_CONFIG;
    case "raid-no-stops":
      return RAID_NO_STOPS_BOT_CONFIG;
    default:
      return COMMUNITY_BOT_CONFIG;
  }
}

const PUBLIC_HOOKS: BrainHooks = {
  look: runPublicLookStep,
  combatBias: publicCombatBias,
  resolveConfig: publicResolveConfig,
  resetLookLife: resetPublicLookLife,
};

/** The public look step, unchanged combat knobs, and {@link publicResolveConfig}. */
export function defaultBrainHooks(): BrainHooks {
  return PUBLIC_HOOKS;
}

/** Fill any omitted hook with the public default. One object per engine. */
export function resolveBrainHooks(overrides?: Partial<BrainHooks>): BrainHooks {
  if (overrides === undefined) return PUBLIC_HOOKS;
  const look = overrides.look;
  const combatBias = overrides.combatBias;
  const resolveConfig = overrides.resolveConfig;
  const resetLookLife = overrides.resetLookLife;
  if (
    look === undefined &&
    combatBias === undefined &&
    resolveConfig === undefined &&
    resetLookLife === undefined
  ) {
    return PUBLIC_HOOKS;
  }
  return {
    look: look ?? PUBLIC_HOOKS.look,
    combatBias: combatBias ?? PUBLIC_HOOKS.combatBias,
    resolveConfig: resolveConfig ?? PUBLIC_HOOKS.resolveConfig,
    resetLookLife: resetLookLife ?? PUBLIC_HOOKS.resetLookLife,
  };
}
