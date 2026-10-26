/**
 * Public browser/Deno surface: one persistent, complete thought pipeline.
 * Individual thoughts and implementation helpers intentionally stay internal.
 */
export {
  createBotThinkEngine,
  PersistentBotThinkEngine,
} from "./engine/batch.ts";
export type { BotThinkEngineOptions } from "./engine/batch.ts";
export {
  defaultBrainHooks,
  publicResolveConfig,
  resolveBrainHooks,
} from "./hooks.ts";
export type {
  BrainHooks,
  CombatBiasKnobs,
  CombatBiasSituation,
  LookAimKnobs,
  LookStep,
} from "./hooks.ts";
export {
  AGENT_BOT_CONFIG,
  AGENT_BOT_CONFIGS,
  agentBrainConfigFor,
  BALANCE_BOT_CONFIG,
  COMMUNITY_BOT_CONFIG,
} from "./config.ts";
export type { BotBrainConfig } from "./config.ts";
export { createBotBrain } from "./pipeline/brain.ts";
export {
  BotBrainState,
  emptyBotBrainState,
  isSetNumber,
  UNSET,
} from "./pipeline/state.ts";
export type {
  BotDecision,
  BotDefinition,
  BotInputIntent,
  BotLookSample,
  BotMapDefinition,
  BotThinkEngine,
  PlayerSnapshot,
  ReadyAction,
  ThinkBatchBot,
  ThinkBatchDecision,
  ThinkBatchInput,
  ThinkBatchOutput,
  ThinkFrame,
} from "./model/index.ts";
