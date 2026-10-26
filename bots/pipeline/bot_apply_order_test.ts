/**
 * Epic 4.5 Chunk 3 / keys-only PR 4: ascending-id apply order for input/
 * reload/switch/ability, and ascending-id enqueue order for shoot intents
 * (resolution itself now happens later in the shared Weapons-phase flush —
 * see weapons_order_test.ts / GameServer.flushPendingWeapons).
 * Run from server-community/:
 *   deno test -A --unstable-net --node-modules-dir=manual bots/pipeline/bot_apply_order_test.ts
 */

import { assertEquals } from "@std/assert";
import { collectApplyRoster } from "../BotManager.ts";
import { COMMUNITY_BOT_CONFIG } from "../botBrainConfig.ts";
import type { ManagedBot } from "../types.ts";
import { DEFAULT_APPLY_STEPS, runApplyPipe } from "./applySteps.ts";
import type { ApplyContext, ReadyAction } from "./types.ts";
import type { Player } from "../../players/Player.ts";
import type { PlayerManager } from "../../players/PlayerManager.ts";
import type { PendingWeapon } from "../../players/weaponsQueue.ts";

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

Deno.test("collectApplyRoster sorts bots+agents by ascending playerId", () => {
  const bots = [makeBot("bot:z"), makeBot("bot:a"), makeBot("bot:m")];
  const agents = [makeBot("agent:b"), makeBot("agent:a")];
  // Opposite insertion within each collection.
  const ids = collectApplyRoster(bots, agents).map((b) => b.playerId);
  assertEquals(ids, [
    "agent:a",
    "agent:b",
    "bot:a",
    "bot:m",
    "bot:z",
  ]);
});

Deno.test("collectApplyRoster is join-order independent", () => {
  const forward = collectApplyRoster(
    [makeBot("c"), makeBot("a"), makeBot("b")],
    [makeBot("z")],
  ).map((b) => b.playerId);
  const reverse = collectApplyRoster(
    [makeBot("b"), makeBot("a"), makeBot("c")],
    [makeBot("z")],
  ).map((b) => b.playerId);
  assertEquals(forward, reverse);
  assertEquals(forward, ["a", "b", "c", "z"]);
});

type FakePM = Pick<
  PlayerManager,
  | "handleInput"
  | "handleReload"
  | "handleWeaponSwitch"
  | "handleAbility"
>;

function makePlayers(): FakePM {
  return {
    handleInput() {},
    handleReload() {
      return true;
    },
    handleWeaponSwitch() {
      return true;
    },
    handleAbility() {
      return true;
    },
  };
}

function shootAction(): ReadyAction {
  return {
    input: {
      sequence: 0,
      forward: false,
      backward: false,
      left: false,
      right: false,
      jump: false,
      sprint: false,
      crouch: false,
      yaw: 0,
      pitch: 0,
    },
    shoot: true,
  };
}

Deno.test("shoot enqueues follow ascending id apply order (no apply-time cap, PR 4)", () => {
  const players = makePlayers();

  function fireAll(insertion: string[]): string[] {
    const weapons: PendingWeapon[] = [];
    const roster = collectApplyRoster(insertion.map(makeBot));
    for (const bot of roster) {
      const self = { id: bot.playerId, isBot: true, yaw: 0, pitch: 0 } as Player;
      const ctx: ApplyContext = {
        tick: 100,
        nowMs: 1,
        bot,
        self,
        players: players as unknown as PlayerManager,
        enqueueWeapon: (req) => weapons.push(req),
      };
      runApplyPipe(DEFAULT_APPLY_STEPS, ctx, shootAction());
    }
    return weapons.map((w) => w.shooterId);
  }

  const a = fireAll(["bot:d", "bot:a", "bot:c", "bot:b", "bot:e"]);
  const b = fireAll(["bot:e", "bot:b", "bot:c", "bot:a", "bot:d"]);
  assertEquals(a, b);
  // Every bot enqueues — no per-tick truncation since MAX_BOT_SHOTS_PER_TICK
  // was deleted; ordering still matches ascending-id apply iteration.
  assertEquals(a, ["bot:a", "bot:b", "bot:c", "bot:d", "bot:e"]);
});
