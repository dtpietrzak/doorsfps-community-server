/**
 * Epic 4.7 Chunk 5: think(T) → apply(T + THINK_BUFFER) despite intervening sim.
 * Run from server-community/:
 *   deno test -A bots/bot_think_apply_order_test.ts
 */

import { assertEquals } from "@std/assert";
import {
  enqueueReadyAction,
  takeDueReadySlot,
} from "./BotManager.ts";
import { COMMUNITY_BOT_CONFIG } from "./botBrainConfig.ts";
import {
  botTickToSimTick,
  THINK_BUFFER_BOT_TICKS,
  type ManagedBot,
} from "./types.ts";
import type { ReadyAction } from "./pipeline/types.ts";
import { SIM_TICK_PHASE_IDS } from "../players/simTickPhases.ts";

function makeBot(): ManagedBot {
  return {
    playerId: "bot:order",
    nameIndex: 1,
    role: "fill",
    pipelineConfig: COMMUNITY_BOT_CONFIG,
    sequence: 0,
    readyDelayQueue: [],
  };
}

function yawAction(yaw: number): ReadyAction {
  return {
    input: {
      sequence: 0,
      forward: true,
      backward: false,
      left: false,
      right: false,
      jump: false,
      sprint: false,
      crouch: false,
      yaw,
      pitch: 0,
    },
  };
}

Deno.test("BotApply precedes BotThink in the canonical phase list", () => {
  const apply = SIM_TICK_PHASE_IDS.indexOf("BotApply");
  const think = SIM_TICK_PHASE_IDS.indexOf("BotThink");
  assertEquals(apply >= 0, true);
  assertEquals(think >= 0, true);
  assertEquals(apply < think, true);
  assertEquals(SIM_TICK_PHASE_IDS.at(-1), "BotThink");
});

Deno.test(
  "think(T) applies at T+BUFFER even after intervening sim ticks",
  () => {
    const bot = makeBot();
    const thinkBotTick = 20;
    enqueueReadyAction(bot, yawAction(1.25), thinkBotTick);

    // Simulate intervening PlayerManager.update / scores / respawns by only
    // advancing sim ticks without touching the delay queue.
    const earlySim = botTickToSimTick(thinkBotTick + THINK_BUFFER_BOT_TICKS - 1);
    assertEquals(takeDueReadySlot(bot, earlySim), null);
    assertEquals(bot.readyDelayQueue.length, 1);

    for (let t = thinkBotTick; t < thinkBotTick + THINK_BUFFER_BOT_TICKS; t++) {
      // No-op stand-in for intervening sim activity.
      assertEquals(bot.readyDelayQueue[0]?.applyAt, thinkBotTick + THINK_BUFFER_BOT_TICKS);
    }

    const dueSim = botTickToSimTick(thinkBotTick + THINK_BUFFER_BOT_TICKS);
    const due = takeDueReadySlot(bot, dueSim);
    assertEquals(due?.action?.input?.yaw, 1.25);
    assertEquals(bot.readyDelayQueue.length, 0);
  },
);
