import { assertEquals, assertStrictEquals } from "@std/assert";
import { brainProfile } from "./BotManager.ts";
import {
  AGENT_BOT_CONFIGS,
  BALANCE_BOT_CONFIG,
  COMMUNITY_BOT_CONFIG,
  RAID_BOT_CONFIG,
  RAID_NO_STOPS_BOT_CONFIG,
} from "./botBrainConfig.ts";
import { publicResolveConfig } from "./engine/hooks.ts";
import type { ManagedBot } from "./types.ts";

function managed(
  role: ManagedBot["role"],
  pipelineConfig: ManagedBot["pipelineConfig"],
  profile?: string,
): ManagedBot {
  return {
    playerId: "p",
    nameIndex: 0,
    role,
    pipelineConfig,
    sequence: 0,
    readyDelayQueue: [],
    profile,
  };
}

// Over the wire the engine only has the profile, so it must give back the
// exact config the host spawned (codec, compiled, and shadow modes).
Deno.test("every config the host spawns resolves back from its profile", () => {
  const cases: Array<[ManagedBot, string]> = [
    [managed("fill", COMMUNITY_BOT_CONFIG), "community"],
    [managed("balance", BALANCE_BOT_CONFIG), "balance-bot"],
    [managed("agent", AGENT_BOT_CONFIGS.easy), "agent-easy"],
    [managed("agent", AGENT_BOT_CONFIGS.medium), "agent-medium"],
    [managed("agent", AGENT_BOT_CONFIGS.hard), "agent-hard"],
    [managed("raid", RAID_BOT_CONFIG), "raid"],
    [managed("raid", RAID_NO_STOPS_BOT_CONFIG), "raid-no-stops"],
  ];
  for (const [bot, profile] of cases) {
    assertEquals(brainProfile(bot), profile);
    assertStrictEquals(publicResolveConfig(profile), bot.pipelineConfig);
  }
});

Deno.test("a pool pawn keeps the profile its spawner gave it", () => {
  assertEquals(
    brainProfile(managed("pool", COMMUNITY_BOT_CONFIG, "hard")),
    "hard",
  );
});
