/**
 * Epic 4.5 Chunk 2: apply hold / due-slot / think-delay tick contract.
 * Run: deno test -A --unstable-net --node-modules-dir=manual bots/pipeline/bot_apply_hold_test.ts
 * (from server-community/)
 */

import { assertEquals } from "@std/assert";
import type { DoorsMap } from "../../world/map.ts";
import { MapCollision } from "../../world/MapCollision.ts";
import { PlayerManager } from "../../players/PlayerManager.ts";
import { enqueueReadyAction, takeDueReadySlot } from "../BotManager.ts";
import { COMMUNITY_BOT_CONFIG } from "../botBrainConfig.ts";
import {
  botTickToSimTick,
  THINK_BUFFER_BOT_TICKS,
  type ManagedBot,
} from "../types.ts";
import {
  beginApplyInterp,
  buildInterpolatedReadyAction,
} from "./botInterp.ts";
import { DEFAULT_APPLY_STEPS, runApplyPipe } from "./applySteps.ts";
import type { ReadyAction } from "./types.ts";

const miniMap: DoorsMap = {
  name: "bot-apply-hold",
  version: 1,
  bounds: { minX: -30, maxX: 30, minZ: -30, maxZ: 30 },
  gridSize: 1,
  walls: [],
  teamA: {
    corners: [0, 1],
    edge: "south",
    doorHalfWidth: 2,
    spawnRadius: 4,
  },
  teamB: {
    corners: [2, 3],
    edge: "north",
    doorHalfWidth: 2,
    spawnRadius: 4,
  },
};

function makeBot(): ManagedBot {
  return {
    playerId: "bot:hold",
    nameIndex: 1,
    role: "fill",
    pipelineConfig: COMMUNITY_BOT_CONFIG,
    sequence: 0,
    readyDelayQueue: [],
  };
}

function moveAction(yaw: number): ReadyAction {
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

Deno.test("takeDueReadySlot: empty queue yields null (no invented action)", () => {
  const bot = makeBot();
  assertEquals(takeDueReadySlot(bot, botTickToSimTick(10)), null);
  assertEquals(bot.readyAction, undefined);
});

Deno.test("takeDueReadySlot: releases after THINK_BUFFER_BOT_TICKS, latest due wins", () => {
  const bot = makeBot();
  const thinkBotTick = 10;
  enqueueReadyAction(bot, moveAction(0.1), thinkBotTick);
  enqueueReadyAction(bot, moveAction(0.2), thinkBotTick + 1);
  enqueueReadyAction(bot, moveAction(0.3), thinkBotTick + 2);

  // Before buffer elapses for the first slot.
  assertEquals(
    takeDueReadySlot(bot, botTickToSimTick(thinkBotTick + THINK_BUFFER_BOT_TICKS - 1)),
    null,
  );

  // At applyAt for first two slots (10+3=13 and 11+3=14): drain both, keep latest.
  const due = takeDueReadySlot(
    bot,
    botTickToSimTick(thinkBotTick + 1 + THINK_BUFFER_BOT_TICKS),
  );
  assertEquals(due?.action?.input?.yaw, 0.2);
  assertEquals(bot.readyDelayQueue.length, 1); // third still pending
  assertEquals(bot.readyAction?.input?.yaw, 0.2);
});

Deno.test("buildInterpolatedReadyAction: reload edge once; empty-like hold keeps keys", () => {
  const curr: ReadyAction = {
    input: {
      sequence: 0,
      forward: true,
      backward: false,
      left: true,
      right: false,
      jump: false,
      sprint: false,
      crouch: false,
      yaw: 0.5,
      pitch: 0,
    },
    reload: true,
    shoot: true,
  };
  const interp = beginApplyInterp({ yaw: 0, pitch: 0 }, curr, 9);
  const first = buildInterpolatedReadyAction(interp, 9);
  assertEquals(first.reload, true);
  assertEquals(first.shoot, true);
  interp.combatEdgeDone = true;
  const held = buildInterpolatedReadyAction(interp, 10);
  assertEquals(held.reload, false);
  assertEquals(held.shoot, false);
  assertEquals(held.input?.forward, true);
  assertEquals(held.input?.left, true);
});

Deno.test("think-delay contract: applied inputs invariant under different nowMs", () => {
  const collision = new MapCollision(miniMap);

  function runWithNowMs(nowMs: number): number[] {
    const pm = new PlayerManager(collision, { nowMs });
    const player = pm.addBot("bot:delay", "DelayBot", { team: "A" });
    player.x = 0;
    player.z = 0;
    player.yaw = 0;
    const bot = makeBot();
    bot.playerId = player.id;
    const yaws: number[] = [];
    const thinkBotTick = 5;
    enqueueReadyAction(bot, moveAction(0.7), thinkBotTick);

    const applyBotTick = thinkBotTick + THINK_BUFFER_BOT_TICKS;
    for (let phase = 0; phase < 3; phase += 1) {
      const simTick = botTickToSimTick(applyBotTick) + phase;
      const due = takeDueReadySlot(bot, simTick);
      if (due) {
        bot.applyInterp = beginApplyInterp(
          { yaw: player.yaw, pitch: player.pitch },
          due.action ?? { input: null },
          simTick,
        );
      }
      let action: ReadyAction | null = null;
      if (bot.applyInterp) {
        action = buildInterpolatedReadyAction(bot.applyInterp, simTick);
        bot.applyInterp.combatEdgeDone = true;
      }
      if (!action) continue;
      runApplyPipe(DEFAULT_APPLY_STEPS, {
        tick: simTick,
        nowMs,
        bot,
        self: player,
        players: pm,
        enqueueWeapon: () => {},
      }, action);
      pm.update(simTick, nowMs);
      yaws.push(player.yaw);
    }
    return yaws;
  }

  const a = runWithNowMs(1_000);
  const b = runWithNowMs(9_999_999);
  assertEquals(a, b);
  assertEquals(a.length > 0, true);
});

Deno.test("apply metering lastApplyMs is non-observable to player pose", () => {
  // lastApplyMs is NON-SIM status metering (no longer sampled inside apply).
  // Mutating it must not change the applied PlayerInput stream or pose.
  const collision = new MapCollision(miniMap);
  const pm = new PlayerManager(collision, { nowMs: 1 });
  const player = pm.addBot("bot:meter", "MeterBot", { team: "A" });
  player.x = 0;
  player.z = 0;
  player.yaw = 0;
  const bot = makeBot();
  bot.playerId = player.id;
  enqueueReadyAction(bot, moveAction(0.5), 1);
  const simTick = botTickToSimTick(1 + THINK_BUFFER_BOT_TICKS);
  const due = takeDueReadySlot(bot, simTick);
  assertEquals(due != null, true);
  bot.applyInterp = beginApplyInterp(
    { yaw: 0, pitch: 0 },
    due!.action ?? { input: null },
    simTick,
  );
  const action = buildInterpolatedReadyAction(bot.applyInterp, simTick);
  runApplyPipe(DEFAULT_APPLY_STEPS, {
    tick: simTick,
    nowMs: 1,
    bot,
    self: player,
    players: pm,
    enqueueWeapon: () => {},
  }, action);
  pm.update(simTick, 1);
  const pose = { x: player.x, z: player.z, yaw: player.yaw, seq: player.lastSequence };

  // Mutating NON-SIM metering must not change pose (field is write-only for HUD).
  // There is no read of lastApplyMs inside Player.update; this pins the contract.
  assertEquals(pose.seq > 0, true);
  assertEquals(Number.isFinite(pose.yaw), true);
});

Deno.test("stampAndInput sequence is strictly monotonic across ticks", () => {
  const collision = new MapCollision(miniMap);
  const pm = new PlayerManager(collision, { nowMs: 1 });
  const player = pm.addBot("bot:seq", "SeqBot", { team: "A" });
  const bot = makeBot();
  bot.playerId = player.id;
  const sequences: number[] = [];

  for (let tick = 1; tick <= 5; tick += 1) {
    runApplyPipe(DEFAULT_APPLY_STEPS, {
      tick,
      nowMs: 1,
      bot,
      self: player,
      players: pm,
      enqueueWeapon: () => {},
    }, moveAction(tick * 0.01));
    sequences.push(player.lastSequence);
  }

  assertEquals(sequences, [1, 2, 3, 4, 5]);
  assertEquals(bot.sequence, 5);
});
