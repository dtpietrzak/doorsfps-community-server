/**
 * BrainHooks: a hook that is passed is called, and the public defaults
 * match an engine constructed with no hooks.
 */
import { assertEquals } from "@std/assert";
import { type BotBrainConfig, COMMUNITY_BOT_CONFIG } from "./config.ts";
import {
  type BotThinkEngineOptions,
  createBotThinkEngine,
  defaultBrainHooks,
} from "./index.ts";
import type { PlayerSnapshot, ThinkBatchInput } from "./model/index.ts";
import { runPublicLookStep } from "./thoughts/publicLook.ts";
import { courtyardProbeMapDefinition } from "./world/courtyardProbeMap.ts";

const MAP = courtyardProbeMapDefinition();

function pawn(id: string): PlayerSnapshot {
  return {
    id,
    kind: "bot",
    team: "A",
    alive: true,
    health: 100,
    score: 0,
    spawnedAtTick: 10,
    x: 1.25,
    y: 1.7,
    z: -8.5,
    velocityX: 0.1,
    velocityY: 0,
    velocityZ: -0.2,
    yaw: 1.1,
    pitch: -0.15,
    crouch: false,
    onGround: true,
    sprintStamina: 1,
    moveYaw: null,
    matchPlayer: false,
    unlimitedAmmo: false,
    weapons: [
      { id: 0, ammoInMagazine: 7, spareClips: 2 },
      { id: 1, ammoInMagazine: 3, spareClips: 2 },
    ],
    glitchState: "inactive",
    weapon: {
      id: 1,
      ammoInMagazine: 3,
      spareClips: 2,
      reloading: false,
      lastShotTick: 0,
    },
    skills: [{
      id: "quick",
      equipped: true,
      charge: 0.5,
      activeUntilTick: null,
      canActivate: true,
    }],
  };
}

function batchInput(): ThinkBatchInput {
  const foe: PlayerSnapshot = {
    ...pawn("foe"),
    team: "B",
    kind: "human",
    x: 3.2,
    z: 5.5,
    yaw: -1.4,
  };
  return {
    frame: {
      tick: 30,
      simDelta: 3,
      mapRevision: MAP.revision,
      doorsOpen: true,
      doorChangeTick: 1,
      teamScoreA: 0,
      teamScoreB: 0,
      matchOver: false,
      players: [pawn("pawn"), foe],
    },
    applyTick: 39,
    bots: [{ botId: "pawn", spawnedAtTick: 10 }],
  };
}

function openEngine(
  options?: BotThinkEngineOptions,
  config: BotBrainConfig = COMMUNITY_BOT_CONFIG,
) {
  const engine = createBotThinkEngine(options);
  engine.loadMap(MAP);
  engine.synchronizeBots([{
    id: "pawn",
    role: "fill",
    profile: "fill",
    randomSeed: 11,
    config,
  }]);
  return engine;
}

function actionOf(
  options: BotThinkEngineOptions | undefined,
  input: ThinkBatchInput,
) {
  const output = openEngine(options).thinkBatch(input);
  return output.decisions[0]!.action;
}

Deno.test("a passed brain hook is called", () => {
  const profiles: string[] = [];
  let looks = 0;
  const situations: { campPlanted: boolean; huntActive: boolean }[] = [];
  const engine = createBotThinkEngine({
    hooks: {
      resolveConfig(profile) {
        profiles.push(profile);
        return COMMUNITY_BOT_CONFIG;
      },
      look(
        ctx,
        prior,
        draft,
        lookReactionBaseMs,
        lookReactionVarianceMs,
        rng,
        _yawLookTauSec,
        _overshootMinFrac,
        _overshootMaxFrac,
        _microNoiseAmp,
        _trackErrorAmp,
        _aim,
      ) {
        looks += 1;
        return runPublicLookStep(
          ctx,
          prior,
          draft,
          lookReactionBaseMs,
          lookReactionVarianceMs,
          rng,
        );
      },
      combatBias(_me, _view, knobs, situation) {
        situations.push(situation);
        return knobs;
      },
    },
  });
  engine.loadMap(MAP);
  engine.synchronizeBots([{
    id: "pawn",
    role: "fill",
    profile: "fill",
    randomSeed: 11,
  }]);
  assertEquals(profiles, ["fill"]);

  const input = batchInput();
  const output = engine.thinkBatch(input);
  assertEquals(looks, 1);
  assertEquals(situations, [{ campPlanted: false, huntActive: false }]);
  assertEquals(output.decisions[0]!.action, actionOf(undefined, input));

  engine.synchronizeBots([{
    id: "named",
    role: "agent",
    profile: "agent",
    randomSeed: 3,
    config: COMMUNITY_BOT_CONFIG,
  }]);
  assertEquals(profiles, ["fill"]);
});

Deno.test("default brain hooks match an engine with no hooks", () => {
  const input = batchInput();
  const baseline = actionOf(undefined, input);
  assertEquals(actionOf({ hooks: defaultBrainHooks() }, input), baseline);
  assertEquals(actionOf({ hooks: {} }, input), baseline);

  assertEquals(actionOf(undefined, withHeat(input, countReads())), baseline);
});

/** Heat table that counts lookups. Any pole key reads as full heat. */
function countReads() {
  const counter = { reads: 0 };
  const table = new Proxy({} as Record<string, number>, {
    get(_target, key) {
      if (typeof key === "string") counter.reads += 1;
      return 1;
    },
  });
  return { counter, table };
}

function withHeat(
  input: ThinkBatchInput,
  heat: { table: Record<string, number> },
): ThinkBatchInput {
  return { ...input, frame: { ...input.frame, humanHeatByPole: heat.table } };
}

Deno.test("pole heat is read only when the frame has it and the weight is above 0", () => {
  const input = batchInput();
  const off = countReads();
  openEngine(undefined).thinkBatch(withHeat(input, off));
  assertEquals(off.counter.reads, 0);

  const on = countReads();
  openEngine(undefined, { ...COMMUNITY_BOT_CONFIG, humanHeatWeight: 1 })
    .thinkBatch(withHeat(input, on));
  assertEquals(on.counter.reads > 0, true);
});

Deno.test("resetLookLife runs on death, not while alive", () => {
  let resets = 0;
  const engine = openEngine({
    hooks: {
      resetLookLife(state) {
        resets += 1;
        defaultBrainHooks().resetLookLife(state);
      },
    },
  });
  const input = batchInput();
  engine.thinkBatch(input);
  assertEquals(resets, 0);

  const [self, ...others] = input.frame.players;
  engine.thinkBatch({
    ...input,
    frame: {
      ...input.frame,
      tick: input.frame.tick + 3,
      players: [{ ...self!, alive: false }, ...others],
    },
    applyTick: input.applyTick + 3,
  });
  assertEquals(resets, 1);
});
