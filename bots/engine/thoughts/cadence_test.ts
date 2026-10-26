/**
 * Multi-rate step cadence: skip holds decisions; force on edges re-runs.
 */
import { assertEquals } from "@std/assert";
import { rehydrateNavModeDecision, shouldForceNavMode } from "./navMode/index.ts";
import { rehydrateNavGoalDecision, shouldForceNavGoal } from "./navGoal/index.ts";
import { rehydrateYawPoleDecision, shouldForceYawPole } from "./yawPole/index.ts";
import {
  resetStepCadencePeriodsForTests,
  setStepCadencePeriodsForTests,
  shouldRunCadencedStep,
  STEP_CADENCE_PERIOD,
} from "../pipeline/index.ts";
import { SIM_TICKS_PER_BOT_TICK } from "../types.ts";
import { botCadenceWorkTick, botWorkSlot } from "../helpers/combat.ts";
import {
  CADENCE_NAV_GOAL_CACHE_KEY,
  CADENCE_YAW_POLE_CACHE_KEY,
} from "./helpers/stateKeys.ts";
import type {
  HuntBrainState,
  NavGoalDecision,
  NavModeDecision,
} from "./helpers/navLayers.ts";

function simAtBot(botTick: number): number {
  return botTick * SIM_TICKS_PER_BOT_TICK;
}

Deno.test("shouldForceNavMode: first think and doors edge", () => {
  const bag: HuntBrainState = {};
  assertEquals(shouldForceNavMode(bag, true), true);
  bag.huntDoorsOpen = true;
  assertEquals(shouldForceNavMode(bag, true), false);
  assertEquals(shouldForceNavMode(bag, false), true);
  bag.huntDoorsOpen = false;
  assertEquals(shouldForceNavMode(bag, false), false);
});

Deno.test("rehydrateNavModeDecision: from bag flags", () => {
  assertEquals(rehydrateNavModeDecision({}), {
    mode: "path",
    forceNoiseReroll: false,
  });
  assertEquals(rehydrateNavModeDecision({ huntActive: true }), {
    mode: "hunt",
    forceNoiseReroll: false,
  });
  assertEquals(rehydrateNavModeDecision({ doorCampActive: true }), {
    mode: "doorCamp",
    forceNoiseReroll: false,
  });
});

Deno.test("shouldForceNavGoal: missing cache / mode mismatch / noise", () => {
  const prior: NavModeDecision = { mode: "path", forceNoiseReroll: false };
  const bag: HuntBrainState & {
    [CADENCE_NAV_GOAL_CACHE_KEY]?: NavGoalDecision;
  } = {};
  assertEquals(shouldForceNavGoal(prior, bag), true);
  bag[CADENCE_NAV_GOAL_CACHE_KEY] = {
    mode: "path",
    goal: { x: 1, z: 2 },
    doorDistPoint: null,
    campArrived: false,
    forceNoiseReroll: false,
  };
  assertEquals(shouldForceNavGoal(prior, bag), false);
  assertEquals(
    shouldForceNavGoal({ mode: "hunt", forceNoiseReroll: false }, bag),
    true,
  );
  assertEquals(
    shouldForceNavGoal({ mode: "path", forceNoiseReroll: true }, bag),
    true,
  );
});

Deno.test("rehydrateNavGoalDecision: holds goal, refreshes campArrived", () => {
  const prior: NavModeDecision = { mode: "doorCamp", forceNoiseReroll: false };
  const bag: HuntBrainState & {
    [CADENCE_NAV_GOAL_CACHE_KEY]?: NavGoalDecision;
  } = {
    doorCampPlantX: 5,
    doorCampPlantZ: 5,
    [CADENCE_NAV_GOAL_CACHE_KEY]: {
      mode: "doorCamp",
      goal: { x: 5, z: 5 },
      doorDistPoint: null,
      campArrived: false,
      forceNoiseReroll: false,
    },
  };
  const far = rehydrateNavGoalDecision(prior, bag, 0, 0);
  assertEquals(far?.campArrived, false);
  assertEquals(far?.goal, { x: 5, z: 5 });
  // Standing on plant → arrived.
  const near = rehydrateNavGoalDecision(prior, bag, 5, 5);
  assertEquals(near?.campArrived, true);
});

Deno.test("shouldForceYawPole: locked sticky can skip; unlock forces", () => {
  const prior: NavGoalDecision = {
    mode: "path",
    goal: { x: 0, z: 10 },
    doorDistPoint: null,
    campArrived: false,
    forceNoiseReroll: false,
  };
  const bag = {
    yawPoleNoise: { a: 1 },
    yawPoleNoiseSpawnedAtTick: 0,
    stickyYawPole: { x: 0, z: -8 },
  };
  // Far from sticky → locked when visible.
  assertEquals(
    shouldForceYawPole(prior, bag, 0, -6.5, true, 0),
    false,
  );
  // Lost LOS → force.
  assertEquals(
    shouldForceYawPole(prior, bag, 0, -6.5, false, 0),
    true,
  );
  // Missing noise → force.
  assertEquals(
    shouldForceYawPole(
      prior,
      { stickyYawPole: bag.stickyYawPole },
      0,
      -6.5,
      true,
      0,
    ),
    true,
  );
});

Deno.test("shouldForceYawPole: doorCamp travel uses sticky cadence; planted forces", () => {
  const bag = {
    yawPoleNoise: { a: 1 },
    yawPoleNoiseSpawnedAtTick: 0,
    stickyYawPole: { x: 0, z: -8 },
  };
  const travel: NavGoalDecision = {
    mode: "doorCamp",
    goal: { x: 0, z: 18 },
    doorDistPoint: null,
    campArrived: false,
    forceNoiseReroll: false,
  };
  // Travel with locked sticky → can skip (pole path, not plant bee-line).
  assertEquals(shouldForceYawPole(travel, bag, 0, -6.5, true, 0), false);
  const planted: NavGoalDecision = {
    ...travel,
    campArrived: true,
  };
  assertEquals(shouldForceYawPole(planted, bag, 0, 18, true, 0), true);
});

Deno.test("rehydrateYawPoleDecision: needs cache for path/hunt", () => {
  const prior: NavGoalDecision = {
    mode: "path",
    goal: { x: 0, z: 10 },
    doorDistPoint: null,
    campArrived: false,
    forceNoiseReroll: false,
  };
  assertEquals(
    rehydrateYawPoleDecision(prior, { stickyYawPole: { x: 1, z: 2 } }),
    null,
  );
  const bag = {
    stickyYawPole: { x: 1, z: 2 },
    [CADENCE_YAW_POLE_CACHE_KEY]: {
      mode: "path" as const,
      goal: prior.goal,
      campArrived: false,
      target: { x: 1, z: 2 },
      next: { x: 3, z: 4 },
    },
  };
  const out = rehydrateYawPoleDecision(prior, bag);
  assertEquals(out?.target, { x: 1, z: 2 });
  assertEquals(out?.next, { x: 3, z: 4 });
});

Deno.test("rehydrateYawPoleDecision: doorCamp travel holds poles; planted uses plant", () => {
  const plant = { x: 0, z: 18 };
  const travelPrior: NavGoalDecision = {
    mode: "doorCamp",
    goal: plant,
    doorDistPoint: null,
    campArrived: false,
    forceNoiseReroll: false,
  };
  const bag = {
    stickyYawPole: { x: 4, z: -2 },
    [CADENCE_YAW_POLE_CACHE_KEY]: {
      mode: "doorCamp" as const,
      goal: plant,
      campArrived: false,
      target: { x: 4, z: -2 },
      next: { x: 6, z: 2 },
    },
  };
  const travel = rehydrateYawPoleDecision(travelPrior, bag);
  assertEquals(travel?.target, { x: 4, z: -2 });
  assertEquals(travel?.next, { x: 6, z: 2 });
  assertEquals(travel?.campArrived, false);

  const planted = rehydrateYawPoleDecision(
    { ...travelPrior, campArrived: true },
    bag,
  );
  assertEquals(planted?.target, plant);
  assertEquals(planted?.next, null);
  assertEquals(planted?.campArrived, true);
});

Deno.test("cadence skip path does not require rng for slot math", () => {
  const id = "bot-stable";
  const period = STEP_CADENCE_PERIOD.navMode;
  const slot = botWorkSlot(id, period);
  let runs = 0;
  for (let t = 0; t < period * 3; t++) {
    const sim = simAtBot(t);
    if (shouldRunCadencedStep("navMode", sim, id)) {
      assertEquals(botCadenceWorkTick(sim) % period, slot);
      runs++;
    }
  }
  assertEquals(runs, 3);
});

Deno.test("period override forces always-run for tests", () => {
  setStepCadencePeriodsForTests({ navMode: 1, navGoal: 1, yawPole: 1 });
  try {
    for (let t = 0; t < 20; t++) {
      assertEquals(shouldRunCadencedStep("navMode", simAtBot(t), "any"), true);
      assertEquals(shouldRunCadencedStep("yawPole", simAtBot(t), "any"), true);
    }
  } finally {
    resetStepCadencePeriodsForTests();
  }
});
