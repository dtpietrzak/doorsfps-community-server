import { assertEquals } from "@std/assert";
import {
  decodeBotThinkPipelineRequestFrame,
  encodeBotThinkPipelineRequestFrame,
} from "@doors/bot-spec/protocol";
import type { ThinkFrame } from "@doors/bot-spec/model";
import {
  stepNavGoal,
  stepNavMode,
} from "./engine/thoughts/helpers/navLayers.ts";
import { emptyBotBrainState } from "./engine/pipeline/state.ts";
import { MapCollision } from "./engine/world/MapCollision.ts";
import { enemyDoorTarget, ownDoorTarget } from "./engine/helpers/nav.ts";
import type { DoorsMap } from "./engine/shared/map.ts";
import {
  captureBotCountFor,
  computePlayerKd,
  computeTeamObjectiveDirectives,
  doorPushFor,
  DYNAMIC_ARENA_TIER_CONFIGS,
  DynamicArenaDirector,
  type DynamicArenaPlayerInput,
  rankCaptureCandidates,
  stepCombatDelayMs,
  topTwoAverageKd,
} from "./dynamicArenaDifficulty.ts";

function makePlayer(
  overrides: Partial<DynamicArenaPlayerInput> & { id: string },
): DynamicArenaPlayerInput {
  return {
    team: "A",
    isBot: false,
    isAgent: false,
    kills: 0,
    deaths: 0,
    spawnedAtTick: 0,
    ...overrides,
  };
}

Deno.test("computePlayerKd clamps negative kills and floors deaths at 1", () => {
  assertEquals(computePlayerKd(0, 0), 0);
  assertEquals(computePlayerKd(-2, 0), 0);
  assertEquals(computePlayerKd(5, 0), 5);
  assertEquals(computePlayerKd(6, 2), 3);
});

Deno.test("topTwoAverageKd handles 0, 1, 2, and 3+ players", () => {
  assertEquals(topTwoAverageKd([]), null);
  assertEquals(topTwoAverageKd([{ kills: 4, deaths: 2 }]), 2);
  assertEquals(
    topTwoAverageKd([
      { kills: 4, deaths: 2 }, // 2.0
      { kills: 2, deaths: 2 }, // 1.0
    ]),
    1.5,
  );
  assertEquals(
    topTwoAverageKd([
      { kills: 1, deaths: 5 }, // 0.2 (ignored)
      { kills: 6, deaths: 2 }, // 3.0
      { kills: 4, deaths: 2 }, // 2.0
    ]),
    2.5,
  );
});

Deno.test("tiered adaptivity: Breezeway > Midway > Terminal", () => {
  const easy = DYNAMIC_ARENA_TIER_CONFIGS.easy;
  const medium = DYNAMIC_ARENA_TIER_CONFIGS.medium;
  const hard = DYNAMIC_ARENA_TIER_CONFIGS.hard;

  assertEquals(easy.maxCombatDelayMs > medium.maxCombatDelayMs, true);
  assertEquals(medium.maxCombatDelayMs > hard.maxCombatDelayMs, true);
  assertEquals(easy.stepUpMs > medium.stepUpMs, true);
  assertEquals(medium.stepUpMs > hard.stepUpMs, true);

  // One step when bots exceed human K/D by 0.5
  assertEquals(stepCombatDelayMs(0, 2.0, 1.5, easy), easy.stepUpMs);
  assertEquals(stepCombatDelayMs(0, 2.0, 1.5, medium), medium.stepUpMs);
  assertEquals(stepCombatDelayMs(0, 2.0, 1.5, hard), hard.stepUpMs);

  // Never drops below 0
  assertEquals(stepCombatDelayMs(0, 0.5, 3.0, easy), 0);
  // Clamps at tier max
  assertEquals(
    stepCombatDelayMs(hard.maxCombatDelayMs, 5.0, 0.2, hard),
    hard.maxCombatDelayMs,
  );
});

Deno.test("DynamicArenaDirector steps per bot spawn symmetrically and resets on match start", () => {
  const director = new DynamicArenaDirector("easy");
  // Initial tick-0 spawn does not step
  const roster = [
    makePlayer({ id: "hA1", team: "A", isBot: false, kills: 1, deaths: 4 }), // K/D 0.25
    makePlayer({ id: "bB1", team: "B", isBot: true, kills: 6, deaths: 2 }), // K/D 3.0
    makePlayer({ id: "bB2", team: "B", isBot: true, kills: 4, deaths: 2 }), // K/D 2.0
  ];
  director.onTick(roster, { A: 0, B: 0 }, false);
  assertEquals(director.getCombatDelayMs("A"), 0);
  assertEquals(director.getCombatDelayMs("B"), 0);

  // Team B bot respawns -> Team B slows down; Team A (no humans on B) unchanged
  const afterRespawn = [
    roster[0]!,
    { ...roster[1]!, spawnedAtTick: 180 },
    roster[2]!,
  ];
  director.onTick(afterRespawn, { A: 0, B: 0 }, false);
  assertEquals(director.getCombatDelayMs("B") > 0, true);
  assertEquals(director.getCombatDelayMs("A"), 0);

  // Match reset restores both teams to 0
  director.reset();
  assertEquals(director.getCombatDelayMs("A"), 0);
  assertEquals(director.getCombatDelayMs("B"), 0);
});

Deno.test("DynamicArenaDirector ignores grey agents for K/D and directives", () => {
  const director = new DynamicArenaDirector("medium");
  const roster = [
    makePlayer({ id: "hA1", team: "A", isBot: false, kills: 0, deaths: 5 }),
    makePlayer({
      id: "agent:1",
      team: "B",
      isBot: true,
      isAgent: true,
      kills: 20,
      deaths: 0,
      spawnedAtTick: 120,
    }),
  ];
  director.onTick(roster, { A: 0, B: 2 }, false);
  assertEquals(director.getCombatDelayMs("B"), 0);
  assertEquals(director.getDirective("agent:1"), undefined);
});

Deno.test("objective allocation keeps >= 1 capture bot and shifts with door deficit & tier", () => {
  const bots = ["b1", "b2", "b3", "b4"];

  // Always >= 1 capture bot across all difficulties and leads
  for (const diff of ["easy", "medium", "hard"] as const) {
    for (const lead of [-3, -1, 0, 1, 3]) {
      const count = captureBotCountFor(bots.length, lead, diff);
      assertEquals(count >= 1 && count <= bots.length, true);
    }
  }

  // Breezeway leading by +1 peels down to 1 capture bot, 1 defend, 2 slay
  const easyLead = computeTeamObjectiveDirectives(bots, 1, "easy");
  assertEquals([...easyLead.values()], ["capture", "defend", "slay", "slay"]);

  // Terminal leading by +1 still keeps 2 bots on capture (less adaptive)
  const hardLead1 = computeTeamObjectiveDirectives(bots, 1, "hard");
  assertEquals(
    [...hardLead1.values()].filter((d) => d === "capture").length,
    2,
  );

  // Midway trailing by -2 sends all 4 bots to capture
  const medBehind = computeTeamObjectiveDirectives(bots, -2, "medium");
  assertEquals([...medBehind.values()], [
    "capture",
    "capture",
    "capture",
    "capture",
  ]);
});

Deno.test("pipeline wire codec round-trips combatDelayMsA/B and objectiveDirective", () => {
  const frame: ThinkFrame = {
    tick: 120,
    simDelta: 3,
    mapRevision: "test:1:00000000",
    doorsOpen: true,
    doorChangeTick: 600,
    teamScoreA: 2,
    teamScoreB: 1,
    combatDelayMsA: 180,
    combatDelayMsB: 45,
    doorPushA: 0.39,
    doorPushB: 0,
    players: [
      {
        id: "bot:1",
        kind: "bot",
        team: "A",
        alive: true,
        health: 100,
        score: 1,
        spawnedAtTick: 60,
        x: 0,
        y: 1.75,
        z: 0,
        velocityX: 0,
        velocityY: 0,
        velocityZ: 0,
        yaw: 0,
        pitch: 0,
        crouch: false,
        onGround: true,
        objectiveDirective: "defend",
        weapon: {
          id: 0,
          ammoInMagazine: 10,
          spareClips: 3,
          reloading: false,
          lastShotTick: -100,
        },
        skills: [],
      },
      {
        id: "bot:2",
        kind: "bot",
        team: "A",
        alive: true,
        health: 100,
        score: 0,
        spawnedAtTick: 60,
        x: 2,
        y: 1.75,
        z: 0,
        velocityX: 0,
        velocityY: 0,
        velocityZ: 0,
        yaw: 0,
        pitch: 0,
        crouch: false,
        onGround: true,
        objectiveDirective: "slay",
        weapon: {
          id: 0,
          ammoInMagazine: 10,
          spareClips: 3,
          reloading: false,
          lastShotTick: -100,
        },
        skills: [],
      },
    ],
  };

  const encoded = encodeBotThinkPipelineRequestFrame({
    type: "pipeline-think-batch",
    requestId: 7,
    input: {
      frame,
      applyTick: 126,
      bots: [{ botId: "bot:1", spawnedAtTick: 60 }],
    },
  });
  const decoded = decodeBotThinkPipelineRequestFrame(encoded);
  assertEquals(decoded.type, "pipeline-think-batch");
  if (decoded.type === "pipeline-think-batch") {
    assertEquals(decoded.input.frame.combatDelayMsA, 180);
    assertEquals(decoded.input.frame.combatDelayMsB, 45);
    assertEquals(decoded.input.frame.doorPushA, 0.39);
    assertEquals(decoded.input.frame.doorPushB, 0);
    assertEquals(decoded.input.frame.players[0]?.objectiveDirective, "defend");
    assertEquals(decoded.input.frame.players[1]?.objectiveDirective, "slay");
  }
});

Deno.test("navMode and navGoal honor defend (own door) and slay (roam) while doors are open", () => {
  const map: DoorsMap = {
    version: 1,
    name: "TestArena",
    gridSize: 1,
    bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 },
    teamA: {
      edge: "south",
      corners: [0, 1],
      doorHalfWidth: 3,
      spawnRadius: 4,
    },
    teamB: {
      edge: "north",
      corners: [2, 3],
      doorHalfWidth: 3,
      spawnRadius: 4,
    },
    walls: [],
  };
  const collision = new MapCollision(map);
  const ownDoorA = ownDoorTarget(map, "A");
  const enemyDoorA = enemyDoorTarget(map, "A");

  // Defend directive while doors are open -> doorCamp anchored near own door
  const defendBag = emptyBotBrainState();
  const defendMode = stepNavMode({
    doorsOpen: true,
    isGreyAgent: false,
    agentAggression: 1,
    bag: defendBag,
    rng: () => 0.5,
    tick: 120,
    objectiveDirective: "defend",
  });
  assertEquals(defendMode.mode, "doorCamp");
  const defendGoal = stepNavGoal({
    mode: defendMode.mode,
    forceNoiseReroll: defendMode.forceNoiseReroll,
    selfX: 0,
    selfZ: 0,
    selfId: "bot:defend",
    team: "A",
    isGreyAgent: false,
    map,
    players: [],
    collision,
    bag: defendBag,
    rng: () => 0.5,
    tick: 120,
    objectiveDirective: "defend",
  });
  const distToOwn = Math.hypot(
    defendGoal.goal.x - ownDoorA.x,
    defendGoal.goal.z - ownDoorA.z,
  );
  const distToEnemy = Math.hypot(
    defendGoal.goal.x - enemyDoorA.x,
    defendGoal.goal.z - enemyDoorA.z,
  );
  assertEquals(distToOwn < distToEnemy, true);

  // Slay directive while doors are open -> hunt mode (roaming, not rushing enemy door)
  const slayBag = emptyBotBrainState();
  const slayMode = stepNavMode({
    doorsOpen: true,
    isGreyAgent: false,
    agentAggression: 0,
    bag: slayBag,
    rng: () => 0.5,
    tick: 120,
    objectiveDirective: "slay",
  });
  assertEquals(slayMode.mode, "hunt");

  // Capture directive while doors are open -> path to enemy door
  const capBag = emptyBotBrainState();
  const capMode = stepNavMode({
    doorsOpen: true,
    isGreyAgent: false,
    agentAggression: 0,
    bag: capBag,
    rng: () => 0.5,
    tick: 120,
    objectiveDirective: "capture",
  });
  assertEquals(capMode.mode, "path");
});

Deno.test("doorPushFor scales tier strength by door deficit", () => {
  assertEquals(doorPushFor(0, "hard"), 0);
  assertEquals(doorPushFor(2, "hard"), 0);
  assertEquals(doorPushFor(-1, "hard"), 0.6);
  assertEquals(doorPushFor(-3, "hard"), 1);
  assertEquals(doorPushFor(-2, "medium"), 0.65);
  assertEquals(doorPushFor(-2, "easy"), 0.3);
  assertEquals(doorPushFor(-1, "easy") < doorPushFor(-1, "medium"), true);
});

Deno.test("rankCaptureCandidates: alive first, nearest the enemy door, then id", () => {
  const door = { x: 0, z: 10 };
  const ranked = rankCaptureCandidates([
    makePlayer({ id: "far", isBot: true, alive: true, x: 0, z: -10 }),
    makePlayer({ id: "dead", isBot: true, alive: false, x: 0, z: 9 }),
    makePlayer({ id: "near", isBot: true, alive: true, x: 0, z: 8 }),
    makePlayer({ id: "noPose", isBot: true }),
  ], door);
  assertEquals(ranked, ["near", "far", "noPose", "dead"]);
  // No door → id order (alive still first).
  assertEquals(
    rankCaptureCandidates([
      makePlayer({ id: "b", isBot: true }),
      makePlayer({ id: "a", isBot: true }),
    ], undefined),
    ["a", "b"],
  );
});

Deno.test("computeTeamObjectiveDirectives gives capture to captureOrder head", () => {
  const bots = ["b1", "b2", "b3", "b4"];
  // Breezeway +1: 1 capture. The nearest bot (b4) gets it; rest keep id order.
  const out = computeTeamObjectiveDirectives(bots, 1, "easy", [
    "b4",
    "b2",
    "b1",
    "b3",
  ]);
  assertEquals(out.get("b4"), "capture");
  assertEquals(out.get("b1"), "defend");
  assertEquals(out.get("b2"), "slay");
  assertEquals(out.get("b3"), "slay");
});

Deno.test("DynamicArenaDirector: doorPush per team and capture re-ranked when doors open", () => {
  const director = new DynamicArenaDirector("hard");
  const enemyDoors = { A: { x: 0, z: 10 }, B: { x: 0, z: -10 } };
  const near = (z: number) => [
    makePlayer({ id: "bA1", team: "A", isBot: true, alive: true, x: 0, z: -9 }),
    makePlayer({ id: "bA2", team: "A", isBot: true, alive: true, x: 0, z }),
    makePlayer({ id: "bA3", team: "A", isBot: true, alive: true, x: 0, z: -8 }),
    makePlayer({ id: "hB1", team: "B", isBot: false }),
  ];
  // Hard +1 lead with 3 bots → floor(3 × 0.5) = 1 capture, so ranking shows.
  director.onTick(near(-5), { A: 2, B: 1 }, false, {
    doorsOpen: false,
    enemyDoors,
  });
  assertEquals(director.getDoorPush("A"), 0);
  assertEquals(director.getDirective("bA2"), "capture");
  // bA3 moves nearest; no re-rank while doors stay closed and score holds.
  const moved = near(-5);
  moved[2] = { ...moved[2]!, z: 9 };
  director.onTick(moved, { A: 2, B: 1 }, false, {
    doorsOpen: false,
    enemyDoors,
  });
  assertEquals(director.getDirective("bA2"), "capture");
  // Doors drop → re-rank: bA3 is now the capturer.
  director.onTick(moved, { A: 2, B: 1 }, false, {
    doorsOpen: true,
    enemyDoors,
  });
  assertEquals(director.getDirective("bA3"), "capture");
  assertEquals(director.getDirective("bA2") === "capture", false);
  // Team A falls behind → push on A only.
  director.onTick(moved, { A: 2, B: 4 }, false, {
    doorsOpen: true,
    enemyDoors,
  });
  assertEquals(director.getDoorPush("A"), 1);
  assertEquals(director.getDoorPush("B"), 0);
  director.reset();
  assertEquals(director.getDoorPush("A"), 0);
});

Deno.test("stepNavMode: trailing capture bot camps the enemy door instead of hunting", () => {
  const fresh = stepNavMode({
    doorsOpen: false,
    isGreyAgent: false,
    agentAggression: 0.9,
    bag: emptyBotBrainState(),
    rng: () => 0.1,
    objectiveDirective: "capture",
    pushCapture: true,
  });
  assertEquals(fresh.mode, "doorCamp");

  // Already hunting this closed phase, then the score drops behind.
  const bag = emptyBotBrainState();
  const hunt = stepNavMode({
    doorsOpen: false,
    isGreyAgent: false,
    agentAggression: 0.9,
    bag,
    rng: () => 0.1,
    objectiveDirective: "capture",
  });
  assertEquals(hunt.mode, "hunt");
  const camp = stepNavMode({
    doorsOpen: false,
    isGreyAgent: false,
    agentAggression: 0.9,
    bag,
    rng: () => 0.1,
    objectiveDirective: "capture",
    pushCapture: true,
  });
  assertEquals(camp.mode, "doorCamp");
  assertEquals(bag.doorCampActive, true);
  assertEquals(bag.huntActive, false);
});
