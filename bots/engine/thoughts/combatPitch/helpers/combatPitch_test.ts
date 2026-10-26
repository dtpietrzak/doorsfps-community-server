import {
  assertAlmostEquals,
  assertEquals,
  assertExists,
  assertLess,
} from "@std/assert";
import { Player } from "../../../players/Player.ts";
import { MapCollision } from "../../../world/MapCollision.ts";
import type { DoorsMap } from "../../../shared/map.ts";
import {
  aimPointHead,
  aimPointOnPlayer,
  pickCombatAimPointPreferred,
} from "../../../helpers/combat.ts";
import {
  basePitchForHeight,
  clearCombatPitchState,
  COMBAT_AIM_HEIGHT_FOR_ID_KEY,
  COMBAT_AIM_HEIGHT_KEY,
  COMBAT_PITCH_MICRO_KEY,
  COMBAT_PITCH_TRACK_KEY,
  headAimChance,
  PITCH_NOISE_CAP_RAD,
  rollAimHeight,
  stepCombatPitch,
  stepPitchWander,
} from "./combatPitch.ts";
import { pitchToward } from "../../../helpers/nav.ts";
import { TARGET_ENEMY_STATE_KEY } from "../../targetEnemy/helpers/targetEnemy.ts";
import { BOT_YAW_EASE_DT } from "../../helpers/yawEase.ts";

function emptyMap(): DoorsMap {
  return {
    version: 1,
    name: "CombatPitchTest",
    bounds: { minX: -40, maxX: 40, minZ: -40, maxZ: 40 },
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

Deno.test("headAimChance: 0 → 5%, ≥0.9 → always head, ramp in between", () => {
  assertAlmostEquals(headAimChance(0), 0.05, 1e-12);
  assertAlmostEquals(headAimChance(0.9), 1, 1e-12);
  assertAlmostEquals(headAimChance(1), 1, 1e-12);
  assertAlmostEquals(headAimChance(-1), 0.05, 1e-12);
  // mid: 0.45 skill → 0.05 + 0.95 * 0.5 = 0.525
  assertAlmostEquals(headAimChance(0.45), 0.525, 1e-12);
  // easy default hitChance 0.3
  assertAlmostEquals(
    headAimChance(0.3),
    0.05 + 0.95 * (0.3 / 0.9),
    1e-12,
  );
});

Deno.test("rollAimHeight: skill ≥ 0.9 always head without rng", () => {
  let calls = 0;
  const height = rollAimHeight(0.9, () => {
    calls++;
    return 0.99;
  });
  assertEquals(height, "head");
  assertEquals(calls, 0);
  assertEquals(rollAimHeight(1, () => 0.99), "head");
});

Deno.test("rollAimHeight: skill 0 is 5% head (rng threshold)", () => {
  assertEquals(rollAimHeight(0, () => 0.049), "head");
  assertEquals(rollAimHeight(0, () => 0.05), "torso");
  assertEquals(rollAimHeight(0, () => 0.9), "torso");
});

Deno.test("pickCombatAimPointPreferred: head vs torso heights", () => {
  const col = new MapCollision(emptyMap());
  const enemy = new Player("e", "e", "B", {
    spawn: { x: 0, y: 1.7, z: 10 },
  });
  const eye = { x: 0, y: 1.7, z: 0 };
  const head = pickCombatAimPointPreferred(col, eye, enemy, "head");
  const torso = pickCombatAimPointPreferred(col, eye, enemy, "torso");
  assertExists(head);
  assertExists(torso);
  assertAlmostEquals(head.y, aimPointHead(enemy).y, 1e-12);
  assertAlmostEquals(torso.y, aimPointOnPlayer(enemy).y, 1e-12);
  assertEquals(head.y > torso.y, true);
});

Deno.test("stepCombatPitch: sticky head raises pitch vs torso", () => {
  const col = new MapCollision(emptyMap());
  const self = new Player("bot", "b", "A", {
    isBot: true,
    spawn: { x: 0, y: 1.7, z: 0 },
  });
  self.yaw = 0;
  const enemy = new Player("e", "e", "B", {
    spawn: { x: 0, y: 1.7, z: 12 },
  });
  // Force head via high skill.
  const head = stepCombatPitch({
    self,
    enemy,
    collision: col,
    lookYaw: 0,
    lookPitch: 0,
    hitChance: 1,
    state: { [TARGET_ENEMY_STATE_KEY]: enemy.id },
    rng: () => 0.5,
  });
  assertEquals(head.aimHeight, "head");
  // Force torso via low skill + rng above 5%.
  const torso = stepCombatPitch({
    self,
    enemy,
    collision: col,
    lookYaw: 0,
    lookPitch: 0,
    hitChance: 0,
    state: { [TARGET_ENEMY_STATE_KEY]: enemy.id },
    rng: () => 0.5,
  });
  assertEquals(torso.aimHeight, "torso");
  assertEquals(head.lookPitch > torso.lookPitch, true);

  const expectHead = basePitchForHeight(
    self,
    enemy,
    col,
    "head",
    { vx: 0, vy: 0, vz: 0 },
    0,
  );
  assertAlmostEquals(head.lookPitch, expectHead, 1e-9);
});

Deno.test("stepCombatPitch: aim height sticky across thinks", () => {
  const col = new MapCollision(emptyMap());
  const self = new Player("bot", "b", "A", {
    isBot: true,
    spawn: { x: 0, y: 1.7, z: 0 },
  });
  self.yaw = 0;
  const enemy = new Player("e", "e", "B", {
    spawn: { x: 0, y: 1.7, z: 12 },
  });
  // First roll: torso (rng high).
  const first = stepCombatPitch({
    self,
    enemy,
    collision: col,
    lookYaw: 0,
    lookPitch: 0,
    hitChance: 0.3,
    state: {},
    rng: () => 0.99,
  });
  assertEquals(first.aimHeight, "torso");
  // Second think: rng would pick head, but latch sticks to torso.
  const second = stepCombatPitch({
    self,
    enemy,
    collision: col,
    lookYaw: 0,
    lookPitch: 0,
    hitChance: 0.3,
    state: {
      ...first.statePatch,
      [TARGET_ENEMY_STATE_KEY]: enemy.id,
    },
    rng: () => 0,
  });
  assertEquals(second.aimHeight, "torso");
  assertEquals(second.statePatch[COMBAT_AIM_HEIGHT_FOR_ID_KEY], enemy.id);
  assertEquals(second.statePatch[COMBAT_AIM_HEIGHT_KEY], "torso");
});

Deno.test("stepCombatPitch: pitch tracks the aim point (no swing arc)", () => {
  const col = new MapCollision(emptyMap());
  const self = new Player("bot", "b", "A", {
    isBot: true,
    spawn: { x: 0, y: 1.7, z: 0 },
  });
  // Face east; combat wants north → large |Δyaw|, which used to arm a
  // one-shot vertical arc. The aim planner bows the 2D stroke instead.
  self.yaw = Math.PI / 2;
  const enemy = new Player("e", "e", "B", {
    spawn: { x: 0, y: 1.7, z: 12 },
  });
  const stepped = stepCombatPitch({
    self,
    enemy,
    collision: col,
    lookYaw: 0,
    lookPitch: 0,
    hitChance: 1,
    state: { [TARGET_ENEMY_STATE_KEY]: enemy.id },
    rng: () => 0.5,
  });
  const base = basePitchForHeight(
    self,
    enemy,
    col,
    stepped.aimHeight,
    undefined,
    0,
    0,
  );
  assertAlmostEquals(stepped.lookPitch, base, 1e-6);
});

Deno.test("clearCombatPitchState wipes latch keys", () => {
  const patch = clearCombatPitchState();
  assertEquals(patch[COMBAT_AIM_HEIGHT_FOR_ID_KEY], undefined);
  assertEquals(patch[COMBAT_AIM_HEIGHT_KEY], undefined);
  assertEquals(patch[COMBAT_PITCH_MICRO_KEY], undefined);
  assertEquals(patch[COMBAT_PITCH_TRACK_KEY], undefined);
});

Deno.test("stepPitchWander: amp 0 keeps offset near zero", () => {
  const w = stepPitchWander({}, 0.05, 0, 0, () => 0.9);
  assertAlmostEquals(w.offset, 0, 1e-12);
  assertAlmostEquals(w.micro, 0, 1e-12);
  assertAlmostEquals(w.track, 0, 1e-12);
});

Deno.test("stepPitchWander: continuous kicks produce non-zero offset", () => {
  let state: Record<string, unknown> = {};
  let sawNonZero = false;
  // Alternating high/low so kicks don't cancel to zero forever.
  let n = 0;
  const rng = () => {
    n += 1;
    return n % 2 === 0 ? 0.05 : 0.95;
  };
  for (let i = 0; i < 20; i++) {
    const w = stepPitchWander(state, BOT_YAW_EASE_DT * 3, 0.12, 0.09, rng);
    state = {
      [COMBAT_PITCH_MICRO_KEY]: w.micro,
      [COMBAT_PITCH_TRACK_KEY]: w.track,
    };
    if (Math.abs(w.offset) > 0.01) sawNonZero = true;
    assertEquals(Math.abs(w.offset) <= PITCH_NOISE_CAP_RAD + 1e-9, true);
  }
  assertEquals(sawNonZero, true);
});

Deno.test("stepCombatPitch: micro/track wander offsets settled aim", () => {
  const col = new MapCollision(emptyMap());
  const self = new Player("bot", "b", "A", {
    isBot: true,
    spawn: { x: 0, y: 1.7, z: 0 },
  });
  self.yaw = 0;
  const enemy = new Player("e", "e", "B", {
    spawn: { x: 0, y: 1.7, z: 12 },
  });
  const base = basePitchForHeight(
    self,
    enemy,
    col,
    "head",
    { vx: 0, vy: 0, vz: 0 },
    0,
  );

  // Deterministic: first unit01 for micro kick high, second for track kick high.
  // With latched head height, rollAimHeight is not called.
  let n = 0;
  const rng = () => {
    const seq = [0.95, 0.95, 0.95, 0.95];
    return seq[n++] ?? 0.95;
  };

  let state: Record<string, unknown> = {
    [TARGET_ENEMY_STATE_KEY]: enemy.id,
    [COMBAT_AIM_HEIGHT_FOR_ID_KEY]: enemy.id,
    [COMBAT_AIM_HEIGHT_KEY]: "head",
  };

  let lastPitch = base;
  let moved = false;
  for (let i = 0; i < 8; i++) {
    const r = stepCombatPitch({
      self,
      enemy,
      collision: col,
      lookYaw: 0,
      lookPitch: 0,
      hitChance: 1,
      dtSec: BOT_YAW_EASE_DT * 3,
      microNoiseAmp: 0.12,
      trackErrorAmp: 0.09,
      state: state as never,
      rng,
    });
    state = { ...state, ...r.statePatch };
    lastPitch = r.lookPitch;
    if (Math.abs(r.lookPitch - base) > 0.01) moved = true;
  }
  assertEquals(moved, true);
  assertEquals(Math.abs(lastPitch - base) > 1e-6, true);
  assertExists(state[COMBAT_PITCH_MICRO_KEY]);
  assertExists(state[COMBAT_PITCH_TRACK_KEY]);
});

Deno.test("basePitchForHeight: head pitch matches pitchToward head point", () => {
  const col = new MapCollision(emptyMap());
  const self = new Player("bot", "b", "A", {
    isBot: true,
    spawn: { x: 0, y: 1.7, z: 0 },
  });
  const enemy = new Player("e", "e", "B", {
    spawn: { x: 0, y: 1.7, z: 10 },
  });
  const headPt = aimPointHead(enemy);
  const expect = pitchToward(
    self.x,
    self.y,
    self.z,
    headPt.x,
    headPt.y,
    headPt.z,
  );
  const got = basePitchForHeight(
    self,
    enemy,
    col,
    "head",
    { vx: 0, vy: 0, vz: 0 },
    0,
  );
  assertAlmostEquals(got, expect, 1e-12);
  assertLess(0, Math.abs(expect)); // non-level at this geometry
});
