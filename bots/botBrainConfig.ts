/**
 * Built-in brain configs. Official Easy / Medium / Hard numbers stay in the
 * private engine; this package re-exports the public ones.
 */
export {
  AGENT_BOT_CONFIG,
  AGENT_BOT_CONFIGS,
  agentBrainConfigFor,
  BALANCE_BOT_CONFIG,
  COMMUNITY_BOT_CONFIG,
  RAID_BOT_CONFIG,
  RAID_NO_STOPS_BOT_CONFIG,
} from "@doors/bot-spec/config";
export type { BotBrainConfig } from "@doors/bot-spec/config";
