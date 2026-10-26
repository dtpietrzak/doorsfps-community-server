/**
 * Unit tests for nav mode / goal / door-camp look layers.
 */

import { assertEquals, assertExists } from "@std/assert";
import type { DoorsMap } from "../../shared/map.ts";
import { MapCollision } from "../../world/MapCollision.ts";
import {
  clearDoorCampState,
  clearHuntState,
  type HeadingDecision,
  type HuntBrainState,
  resolveHuntGoalPoint,
  stepDoorCampLook,
  stepNavGoal,
  stepNavMode,
} from "./navLayers.ts";
import type { StickyYawPoleState } from "../yawPole/helpers/yawPole.ts";
import { yawPoleMapCenter } from "../yawPole/helpers/yawPole.ts";
import { CAMP_MIN_DOOR_DIST, enemyDoorTarget } from "../../helpers/nav.ts";

function tinyMap(): DoorsMap {
  return {
    version: 1,
    name: "NavLayersTest",
    bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 },
    gridSize: 1,
    teamA: {
      corners: [0, 1],
      edge: "south",
      doorHalfWidth: 2.5,
      spawnRadius: 3,
    },
    teamB: {
      corners: [2, 3],
      edge: "north",
      doorHalfWidth: 2.5,
      spawnRadius: 3,
    },
    walls: [],
    wallCorners: [],
  };
}

function rngSeq(...vals: number[]): () => number {
  let i = 0;
  return () => {
    const v = vals[i % vals.length]!;
    i++;
    return v;
  };
}

Deno.test("resolveHuntGoalPoint: live → last → map center", () => {
  const map = tinyMap();
  const live = resolveHuntGoalPoint(
    0,
    0,
    [
      { id: "self", x: 0, z: 0, alive: true, isAgent: false } as never,
      { id: "g1", x: 4, z: 5, alive: true, isAgent: true } as never,
    ],
    "self",
    map,
    { x: 9, z: 9 },
    { isGreyAgent: false },
  );
  assertEquals(live.goal, { x: 4, z: 5 });
  assertEquals(live.lastX, 4);
  assertEquals(live.lastZ, 5);

  const last = resolveHuntGoalPoint(
    0,
    0,
    [{ id: "self", x: 0, z: 0, alive: true, isAgent: false } as never],
    "self",
    map,
    { x: 9, z: 9 },
    { isGreyAgent: false },
  );
  assertEquals(last.goal, { x: 9, z: 9 });

  const center = resolveHuntGoalPoint(
    0,
    0,
    [{ id: "self", x: 0, z: 0, alive: true, isAgent: false } as never],
    "self",
    map,
    {},
    { isGreyAgent: false },
  );
  assertEquals(center.goal, yawPoleMapCenter(map));
});

Deno.test("stepNavMode: doors closed + high aggression → hunt", () => {
  const bag: HuntBrainState & StickyYawPoleState & { yawPoleNoise?: unknown } =
    {};
  const out = stepNavMode({
    doorsOpen: false,
    isGreyAgent: false,
    agentAggression: 0.8,
    bag,
    rng: () => 0.1,
  });
  assertEquals(out.mode, "hunt");
  assertEquals(bag.huntActive, true);
  assertEquals(bag.doorCampActive, undefined);
});

Deno.test("stepNavMode: doors closed + low aggression → doorCamp", () => {
  const bag: HuntBrainState & StickyYawPoleState & { yawPoleNoise?: unknown } =
    {};
  const out = stepNavMode({
    doorsOpen: false,
    isGreyAgent: false,
    agentAggression: 0.2,
    bag,
    rng: () => 0.5,
  });
  assertEquals(out.mode, "doorCamp");
  assertEquals(bag.doorCampActive, true);
  assertEquals(bag.huntActive, undefined);
});

Deno.test("stepNavMode: grey agent always hunts even with low aggression", () => {
  const bag: HuntBrainState & StickyYawPoleState & { yawPoleNoise?: unknown } =
    {};
  const out = stepNavMode({
    doorsOpen: false,
    isGreyAgent: true,
    agentAggression: 0.1,
    bag,
    rng: () => 0.5,
  });
  assertEquals(out.mode, "hunt");
  assertEquals(bag.huntActive, true);
  assertEquals(bag.doorCampActive, undefined);
  assertEquals(bag.huntDoorBias, "enemy");
});

Deno.test("stepNavMode: doors open → path; edge re-roll on close", () => {
  const bag: HuntBrainState & StickyYawPoleState & { yawPoleNoise?: unknown } =
    {
      huntDoorsOpen: true,
    };
  const open = stepNavMode({
    doorsOpen: true,
    isGreyAgent: false,
    agentAggression: 0.8,
    bag,
    rng: () => 0.5,
  });
  assertEquals(open.mode, "path");
  assertEquals(open.forceNoiseReroll, false);

  const closed = stepNavMode({
    doorsOpen: false,
    isGreyAgent: false,
    agentAggression: 0.8,
    bag,
    rng: () => 0.2,
  });
  assertEquals(closed.mode, "hunt");
  assertEquals(closed.forceNoiseReroll, true);
});

Deno.test("stepNavGoal: path uses enemy door; hunt uses resolve chain", () => {
  const map = tinyMap();
  const bag: HuntBrainState = {};
  const path = stepNavGoal({
    mode: "path",
    forceNoiseReroll: false,
    selfX: 0,
    selfZ: -8,
    selfId: "bot",
    team: "A",
    isGreyAgent: false,
    map,
    players: [],
    collision: null,
    bag,
    rng: () => 0.5,
  });
  assertEquals(path.goal, enemyDoorTarget(map, "A"));
  assertEquals(path.doorDistPoint, null);

  bag.huntDoorBias = "own";
  const hunt = stepNavGoal({
    mode: "hunt",
    forceNoiseReroll: false,
    selfX: 0,
    selfZ: 0,
    selfId: "bot",
    team: "A",
    isGreyAgent: false,
    map,
    players: [
      { id: "bot", x: 0, z: 0, alive: true, isAgent: false } as never,
      { id: "g", x: 3, z: 4, alive: true, isAgent: true } as never,
    ],
    collision: null,
    bag,
    rng: () => 0.5,
  });
  assertEquals(hunt.goal, { x: 3, z: 4 });
  assertEquals(bag.huntLastAgentX, 3);
  assertEquals(bag.huntLastAgentZ, 4);
  assertExists(hunt.doorDistPoint);
});

Deno.test("stepNavGoal: doorCamp rolls plant and reports campArrived", () => {
  const map = tinyMap();
  const collision = new MapCollision(map);
  const bag: HuntBrainState = { doorCampActive: true };
  const out = stepNavGoal({
    mode: "doorCamp",
    forceNoiseReroll: false,
    selfX: 0,
    selfZ: -18,
    selfId: "bot",
    team: "A",
    isGreyAgent: false,
    map,
    players: [],
    collision,
    bag,
    rng: rngSeq(0.5, 0.5, 0.5),
  });
  assertEquals(typeof bag.doorCampPlantX, "number");
  assertEquals(typeof bag.doorCampPlantZ, "number");
  assertEquals(out.goal.x, bag.doorCampPlantX);
  assertEquals(out.goal.z, bag.doorCampPlantZ);
  assertEquals(out.campArrived, false);

  const arrived = stepNavGoal({
    mode: "doorCamp",
    forceNoiseReroll: false,
    selfX: bag.doorCampPlantX!,
    selfZ: bag.doorCampPlantZ!,
    selfId: "bot",
    team: "A",
    isGreyAgent: false,
    map,
    players: [],
    collision,
    bag,
    rng: () => 0.5,
  });
  assertEquals(arrived.campArrived, true);
  const door = enemyDoorTarget(map, "A");
  const coverDist = Math.hypot(
    bag.doorCampPlantX! - door.x,
    bag.doorCampPlantZ! - door.z,
  );
  assertEquals(coverDist >= CAMP_MIN_DOOR_DIST - 0.05, true);
});

Deno.test("stepNavGoal: high doorAggression plants on the lip", () => {
  const map = tinyMap();
  const collision = new MapCollision(map);
  const bag: HuntBrainState = { doorCampActive: true };
  const out = stepNavGoal({
    mode: "doorCamp",
    forceNoiseReroll: false,
    selfX: 0,
    selfZ: -18,
    selfId: "bot",
    team: "A",
    isGreyAgent: false,
    map,
    players: [],
    collision,
    bag,
    rng: rngSeq(0.5, 0.5, 0.5),
    doorAggression: 0.9,
  });
  const door = enemyDoorTarget(map, "A");
  const dist = Math.hypot(out.goal.x - door.x, out.goal.z - door.z);
  assertEquals(dist < CAMP_MIN_DOOR_DIST, true);
  assertEquals(bag.doorCampWantLip, true);
});

Deno.test("stepDoorCampLook: pass-through when not planted", () => {
  const map = tinyMap();
  const prior: HeadingDecision = {
    mode: "path",
    goal: { x: 0, z: 0 },
    campArrived: false,
    target: null,
    next: null,
    rawLook: 1.2,
    moveYaw: 0.5,
  };
  const bag: HuntBrainState = {};
  const out = stepDoorCampLook({
    prior,
    selfYaw: 0,
    team: "A",
    map,
    tick: 10,
    campingAnxiety: 0.5,
    bag,
    rng: () => 0.5,
  });
  assertEquals(out, prior);
});

Deno.test("stepDoorCampLook: planted schedules hold and sets rawLook", () => {
  const map = tinyMap();
  const plant = enemyDoorTarget(map, "A");
  const prior: HeadingDecision = {
    mode: "doorCamp",
    goal: plant,
    campArrived: true,
    target: plant,
    next: null,
    rawLook: 0,
    moveYaw: 0,
  };
  const bag: HuntBrainState = {
    doorCampActive: true,
    doorCampPlantX: plant.x,
    doorCampPlantZ: plant.z,
  };
  const out = stepDoorCampLook({
    prior,
    selfYaw: 0,
    team: "A",
    map,
    tick: 100,
    campingAnxiety: 0.5,
    bag,
    rng: rngSeq(0.0, 0.5), // lookIndex 0, hold mid-band
  });
  assertEquals(typeof out.rawLook, "number");
  assertEquals(typeof bag.doorCampNextSwitchAt, "number");
  assertEquals(
    bag.doorCampLookIndex === 0 || bag.doorCampLookIndex === 1,
    true,
  );
});

Deno.test("clearDoorCampState / clearHuntState wipe keys", () => {
  const bag: HuntBrainState = {
    doorCampActive: true,
    doorCampPlantX: 1,
    doorCampPlantZ: 2,
    doorCampLookIndex: 1,
    huntActive: true,
    huntDoorBias: "enemy",
    huntLastAgentX: 3,
  };
  clearDoorCampState(bag);
  assertEquals(bag.doorCampActive, undefined);
  assertEquals(bag.doorCampPlantX, undefined);
  clearHuntState(bag);
  assertEquals(bag.huntActive, undefined);
  assertEquals(bag.huntLastAgentX, undefined);
});
