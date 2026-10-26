/**
 * Epic 4.5: human handleInput path vs bot stampAndInput apply path.
 * Same PlayerInput stream → identical queued / integrated sim state.
 * Run: deno test -A server-community/bots/pipeline/bot_input_equivalence_test.ts
 */

import { assertEquals } from "@std/assert";
import type { DoorsMap } from "../../world/map.ts";
import type { PlayerInput } from "../../protocol/network.ts";
import { MapCollision } from "../../world/MapCollision.ts";
import { PlayerManager } from "../../players/PlayerManager.ts";
import type { Player } from "../../players/Player.ts";
import { COMMUNITY_BOT_CONFIG } from "../botBrainConfig.ts";
import type { ManagedBot } from "../types.ts";
import { DEFAULT_APPLY_STEPS, runApplyPipe } from "./applySteps.ts";
import type { ApplyContext, ReadyAction } from "./types.ts";

const miniMap: DoorsMap = {
  name: "bot-input-equivalence",
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

const stampAndInput = DEFAULT_APPLY_STEPS[0]!;

function baseInput(
  sequence: number,
  overrides: Partial<PlayerInput> = {},
): PlayerInput {
  return {
    sequence,
    forward: false,
    backward: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
    crouch: false,
    yaw: Math.PI,
    pitch: 0,
    ...overrides,
  };
}

function makeBot(playerId: string): ManagedBot {
  return {
    playerId,
    nameIndex: 1,
    role: "fill",
    pipelineConfig: COMMUNITY_BOT_CONFIG,
    sequence: 0,
    readyDelayQueue: [],
  };
}

function place(p: Player, x: number, z: number, yaw: number): void {
  p.x = x;
  p.z = z;
  p.yaw = yaw;
  p.pitch = 0;
  p.velocityX = 0;
  p.velocityY = 0;
  p.velocityZ = 0;
}

function snap(p: Player) {
  return {
    x: p.x,
    y: p.y,
    z: p.z,
    yaw: p.yaw,
    pitch: p.pitch,
    lastSequence: p.lastSequence,
    alive: p.alive,
    velocityX: p.velocityX,
    velocityY: p.velocityY,
    velocityZ: p.velocityZ,
  };
}

function scriptFrames(): Array<Partial<PlayerInput>> {
  const out: Array<Partial<PlayerInput>> = [];
  for (let tick = 1; tick <= 40; tick += 1) {
    out.push({
      forward: tick < 25,
      left: tick >= 10 && tick < 20,
      jump: tick === 5,
      sprint: tick < 8,
      crouch: tick >= 28 && tick < 35,
      yaw: tick >= 10 && tick < 20 ? Math.PI / 2 : Math.PI,
      pitch: (tick % 5) * 0.02,
      meleeLunge: tick === 12 ? true : undefined,
    });
  }
  return out;
}

Deno.test("stampAndInput and handleInput yield identical live trajectories", () => {
  const collision = new MapCollision(miniMap);
  const humanPm = new PlayerManager(collision, { nowMs: 1_000 });
  const botPm = new PlayerManager(collision, { nowMs: 1_000 });

  const human = humanPm.add("human", "Human", "A", undefined, 1_000);
  const botPlayer = botPm.add("bot-path", "BotPath", "A", undefined, 1_000);
  place(human, -2, -4, Math.PI);
  place(botPlayer, -2, -4, Math.PI);
  // Both players come from add() (isBot=false) so inventoried assists match.

  const bot = makeBot(botPlayer.id);
  const frames = scriptFrames();
  const nowMs = 1_000;

  for (let i = 0; i < frames.length; i += 1) {
    const tick = i + 1;
    const seq = i + 1;
    humanPm.handleInput(human.id, baseInput(seq, frames[i]!), nowMs);

    const action: ReadyAction = {
      input: baseInput(0, frames[i]!),
    };
    const ctx: ApplyContext = {
      tick,
      nowMs,
      bot,
      self: botPlayer,
      players: botPm,
      enqueueWeapon: () => {},
    };
    stampAndInput.run(ctx, action);

    humanPm.update(tick, nowMs);
    botPm.update(tick, nowMs);
  }

  assertEquals(snap(human), snap(botPlayer));
  assertEquals(bot.sequence, frames.length);
});

Deno.test("stale sequence is dropped on both human and stampAndInput paths", () => {
  const collision = new MapCollision(miniMap);
  const humanPm = new PlayerManager(collision, { nowMs: 1_000 });
  const botPm = new PlayerManager(collision, { nowMs: 1_000 });
  const human = humanPm.add("h", "H", "A", undefined, 1_000);
  const botPlayer = botPm.add("b", "B", "A", undefined, 1_000);
  place(human, 0, 0, Math.PI);
  place(botPlayer, 0, 0, Math.PI);
  const bot = makeBot(botPlayer.id);
  const nowMs = 1_000;

  humanPm.handleInput(human.id, baseInput(5, { forward: true }), nowMs);
  stampAndInput.run(
    {
      tick: 1,
      nowMs,
      bot,
      self: botPlayer,
      players: botPm,
      enqueueWeapon: () => {},
    },
    { input: baseInput(0, { forward: true }) },
  );

  assertEquals(human.lastSequence, 5);
  assertEquals(botPlayer.lastSequence, 1);
  assertEquals(bot.sequence, 1);

  humanPm.handleInput(human.id, baseInput(4, { forward: true, yaw: 1 }), nowMs);
  botPm.handleInput(botPlayer.id, baseInput(0, { forward: true, yaw: 1 }), nowMs);

  assertEquals(human.yaw, Math.PI);
  assertEquals(human.lastSequence, 5);
  assertEquals(botPlayer.lastSequence, 1);
  assertEquals(botPlayer.yaw, Math.PI);
});

Deno.test("dead-player look-only matches across handleInput and stampAndInput", () => {
  const collision = new MapCollision(miniMap);
  const humanPm = new PlayerManager(collision, { nowMs: 1_000 });
  const botPm = new PlayerManager(collision, { nowMs: 1_000 });
  const human = humanPm.add("h", "H", "A", undefined, 1_000);
  const botPlayer = botPm.add("b", "B", "A", undefined, 1_000);
  place(human, 0, 0, 0);
  place(botPlayer, 0, 0, 0);
  const bot = makeBot(botPlayer.id);
  const nowMs = 1_000;

  human.alive = false;
  botPlayer.alive = false;
  const beforeHX = human.x;
  const beforeBX = botPlayer.x;

  humanPm.handleInput(
    human.id,
    baseInput(1, { forward: true, yaw: 1.25, pitch: -0.2 }),
    nowMs,
  );
  stampAndInput.run(
    {
      tick: 1,
      nowMs,
      bot,
      self: botPlayer,
      players: botPm,
      enqueueWeapon: () => {},
    },
    { input: baseInput(0, { forward: true, yaw: 1.25, pitch: -0.2 }) },
  );

  humanPm.update(1, nowMs);
  botPm.update(1, nowMs);

  assertEquals(human.yaw, 1.25);
  assertEquals(human.pitch, -0.2);
  assertEquals(botPlayer.yaw, 1.25);
  assertEquals(botPlayer.pitch, -0.2);
  assertEquals(human.x, beforeHX);
  assertEquals(botPlayer.x, beforeBX);
  assertEquals(human.velocityX, 0);
  assertEquals(botPlayer.velocityX, 0);
});

Deno.test("full apply pipe stampAndInput matches direct handleInput for movement keys", () => {
  const collision = new MapCollision(miniMap);
  const humanPm = new PlayerManager(collision, { nowMs: 1_000 });
  const botPm = new PlayerManager(collision, { nowMs: 1_000 });
  const human = humanPm.add("h", "H", "A", undefined, 1_000);
  const botPlayer = botPm.add("b", "B", "A", undefined, 1_000);
  place(human, 1, 1, 0);
  place(botPlayer, 1, 1, 0);
  const bot = makeBot(botPlayer.id);
  const nowMs = 1_000;
  const body = {
    forward: true,
    right: true,
    sprint: true,
    yaw: 0.4,
    pitch: 0.1,
  };

  humanPm.handleInput(human.id, baseInput(1, body), nowMs);
  runApplyPipe(
    DEFAULT_APPLY_STEPS,
    {
      tick: 1,
      nowMs,
      bot,
      self: botPlayer,
      players: botPm,
      enqueueWeapon: () => {},
    },
    { input: baseInput(0, body) },
  );

  humanPm.update(1, nowMs);
  botPm.update(1, nowMs);

  assertEquals(snap(human), snap(botPlayer));
});
