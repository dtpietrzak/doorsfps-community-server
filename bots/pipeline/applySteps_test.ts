import { assertAlmostEquals, assertEquals } from "@std/assert";
import { DEFAULT_APPLY_STEPS, runApplyPipe } from "./applySteps.ts";
import type { ApplyContext, ReadyAction } from "./types.ts";
import { COMMUNITY_BOT_CONFIG } from "../botBrainConfig.ts";
import type { ManagedBot } from "../types.ts";
import type { Player } from "../../players/Player.ts";
import type { PlayerManager } from "../../players/PlayerManager.ts";
import type { PendingWeapon } from "../../players/weaponsQueue.ts";
import type { PlayerInput } from "../../protocol/network.ts";
function makeBot(overrides: Partial<ManagedBot> = {}): ManagedBot {
  return {
    playerId: "bot:1",
    nameIndex: 1,
    role: "fill",
    pipelineConfig: COMMUNITY_BOT_CONFIG,
    sequence: 0,
    readyDelayQueue: [],
    ...overrides,
  };
}

function makeSelf(): Player {
  return {
    id: "bot:1",
    isBot: true,
    yaw: 0.5,
    pitch: -0.1,
  } as Player;
}

type FakePM =
  & {
    inputs: PlayerInput[];
    reloads: number[];
    weaponSwitches: { weapon: unknown; tick: number }[];
    abilities: { ability: unknown; tick: number }[];
  }
  & Pick<
    PlayerManager,
    | "handleInput"
    | "handleReload"
    | "handleWeaponSwitch"
    | "handleAbility"
  >;

function makePlayers(): FakePM {
  const fake: FakePM = {
    inputs: [],
    reloads: [],
    weaponSwitches: [],
    abilities: [],
    handleInput(_id, input) {
      fake.inputs.push(input);
    },
    handleReload(_id, tick) {
      fake.reloads.push(tick);
      return true;
    },
    handleWeaponSwitch(_id, weapon, tick) {
      fake.weaponSwitches.push({ weapon, tick });
      return true;
    },
    handleAbility(_id, ability, tick) {
      fake.abilities.push({ ability, tick });
      return true;
    },
  };
  return fake;
}

function applyCtx(
  bot: ManagedBot,
  players: FakePM,
): ApplyContext & { weapons: PendingWeapon[] } {
  const weapons: PendingWeapon[] = [];
  return {
    tick: 10,
    nowMs: 10_000,
    bot,
    self: makeSelf(),
    players: players as unknown as PlayerManager,
    enqueueWeapon: (req) => weapons.push(req),
    weapons,
  };
}

const stillInput: PlayerInput = {
  sequence: 0,
  forward: false,
  backward: false,
  left: false,
  right: false,
  jump: false,
  sprint: false,
  crouch: false,
  yaw: 1.2,
  pitch: -0.2,
};

Deno.test("runApplyPipe null action is a no-op", () => {
  const bot = makeBot();
  const pm = makePlayers();
  const ctx = applyCtx(bot, pm);
  runApplyPipe(DEFAULT_APPLY_STEPS, ctx, null);
  assertEquals(pm.inputs.length, 0);
  assertEquals(ctx.weapons.length, 0);
});

Deno.test("runApplyPipe stamps sequence and passes packet through literally", () => {
  const bot = makeBot({ sequence: 4 });
  const pm = makePlayers();
  const ctx = applyCtx(bot, pm);
  // self.yaw is 0.5 — apply must NOT ease toward 1.2; brain already eased.
  const action: ReadyAction = {
    input: {
      ...stillInput,
      forward: true,
      crouch: false,
      yaw: 1.2,
      pitch: -0.2,
    },
  };
  runApplyPipe(DEFAULT_APPLY_STEPS, ctx, action);
  assertEquals(bot.sequence, 5);
  assertEquals(pm.inputs.length, 1);
  assertEquals(pm.inputs[0]!.sequence, 5);
  assertAlmostEquals(pm.inputs[0]!.yaw, 1.2, 1e-12);
  assertEquals(pm.inputs[0]!.forward, true);
  assertEquals(pm.inputs[0]!.crouch, false);
});

Deno.test("runApplyPipe does not rewrite keys from leftover brain state", () => {
  const bot = makeBot({ sequence: 1 });
  const pm = makePlayers();
  const ctx = applyCtx(bot, pm);

  runApplyPipe(DEFAULT_APPLY_STEPS, ctx, {
    input: {
      ...stillInput,
      forward: true,
      jump: false,
      sprint: true,
      crouch: false,
      yaw: 0.25,
    },
  });
  const in0 = pm.inputs[0]!;
  assertEquals(in0.forward, true);
  assertEquals(in0.jump, false);
  assertEquals(in0.sprint, true);
  assertEquals(in0.crouch, false);
  assertAlmostEquals(in0.yaw, 0.25, 1e-12);
});

Deno.test("runApplyPipe reload when flagged", () => {
  const bot = makeBot();
  const pm = makePlayers();
  const ctx = applyCtx(bot, pm);
  runApplyPipe(DEFAULT_APPLY_STEPS, ctx, { input: null, reload: true });
  assertEquals(pm.reloads, [10]);
});

Deno.test("runApplyPipe weapon switch when flagged", () => {
  const bot = makeBot();
  const pm = makePlayers();
  const ctx = applyCtx(bot, pm);
  runApplyPipe(DEFAULT_APPLY_STEPS, ctx, { input: null, weapon: 1 });
  assertEquals(pm.weaponSwitches, [{ weapon: 1, tick: 10 }]);
});

Deno.test("runApplyPipe shoot enqueues a weapon request with input aim (PR 4: no inline handleShoot)", () => {
  const bot = makeBot();
  const pm = makePlayers();
  const ctx = applyCtx(bot, pm);
  runApplyPipe(DEFAULT_APPLY_STEPS, ctx, {
    input: { ...stillInput, yaw: 1.2 },
    shoot: true,
  });
  assertEquals(ctx.weapons.length, 1);
  const req = ctx.weapons[0]!;
  assertEquals(req.kind, "shoot");
  assertEquals(req.shooterId, "bot:1");
  assertAlmostEquals(req.packet!.yaw, 1.2, 1e-9);
  assertEquals(req.packet!.pitch, -0.2);
});

Deno.test("runApplyPipe enqueues shoot immediately when brain sets shoot (no ease gate, no apply-time cap)", () => {
  // Apply used to wait until yawEaseTo cleared; brain owns aim now. PR 4
  // deleted the per-tick shot budget too — every intent enqueues.
  const bot = makeBot();
  const pm = makePlayers();
  const ctx = applyCtx(bot, pm);
  runApplyPipe(DEFAULT_APPLY_STEPS, ctx, {
    input: { ...stillInput, yaw: 0.1 },
    shoot: true,
  });
  assertEquals(ctx.weapons.length, 1);
  assertAlmostEquals(ctx.weapons[0]!.packet!.yaw, 0.1, 1e-9);
});

Deno.test("runApplyPipe does not enqueue when action.shoot is falsy", () => {
  const bot = makeBot();
  const pm = makePlayers();
  const ctx = applyCtx(bot, pm);
  runApplyPipe(DEFAULT_APPLY_STEPS, ctx, {
    input: { ...stillInput, yaw: 1.2 },
  });
  assertEquals(ctx.weapons.length, 0);
});

Deno.test("runApplyPipe ability calls handleAbility", () => {
  const bot = makeBot();
  const pm = makePlayers();
  const ctx = applyCtx(bot, pm);
  runApplyPipe(DEFAULT_APPLY_STEPS, ctx, {
    input: null,
    ability: "quick",
  });
  assertEquals(pm.abilities, [{ ability: "quick", tick: 10 }]);
});
