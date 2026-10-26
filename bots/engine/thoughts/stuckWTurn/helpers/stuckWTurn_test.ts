import { assertAlmostEquals, assertEquals } from "@std/assert";
import {
  clearStuckWTurnState,
  stepStuckWTurn,
  STUCK_W_COMMIT_TICKS,
  STUCK_W_COOLDOWN_TICKS,
  STUCK_W_SPEED_EPS,
  STUCK_W_WINDOW_TICKS,
  type StuckWTurnState,
} from "./stuckWTurn.ts";

function run(
  state: StuckWTurnState,
  opts: {
    x?: number;
    z?: number;
    yaw?: number;
    holdingW?: boolean;
    simDelta?: number;
    tick?: number;
    rng?: () => number;
    peelYaw?: number;
  } = {},
) {
  const r = stepStuckWTurn({
    x: opts.x ?? 0,
    z: opts.z ?? 0,
    yaw: opts.yaw ?? 0,
    holdingW: opts.holdingW ?? true,
    simDelta: opts.simDelta ?? 1,
    tick: opts.tick ?? 0,
    state,
    rng: opts.rng ?? (() => 0.25),
    peelYaw: opts.peelYaw,
  });
  Object.assign(state, r.statePatch);
  for (const k of Object.keys(r.statePatch)) {
    if ((r.statePatch as Record<string, unknown>)[k] === undefined) {
      delete (state as Record<string, unknown>)[k];
    }
  }
  return r;
}

Deno.test("clearStuckWTurnState wipes watch + commit", () => {
  const patch = clearStuckWTurnState({
    stuckWLastX: 1,
    stuckWLastZ: 2,
    stuckWElapsed: 50,
    stuckWTurnTicksLeft: 10,
    stuckWTurnFaceYaw: 1.5,
    stuckWCooldownUntilTick: 99,
  });
  assertEquals(patch.stuckWLastX, undefined);
  assertEquals(patch.stuckWTurnTicksLeft, undefined);
  assertEquals(patch.stuckWCooldownUntilTick, undefined);
});

Deno.test("stepStuckWTurn: not holding W clears watch", () => {
  const state: StuckWTurnState = {
    stuckWLastX: 0,
    stuckWLastZ: 0,
    stuckWElapsed: 100,
  };
  const r = run(state, { holdingW: false });
  assertEquals(r.active, false);
  assertEquals(state.stuckWElapsed, undefined);
  assertEquals(state.stuckWLastX, undefined);
});

Deno.test("stepStuckWTurn: first W frame samples without triggering", () => {
  const state: StuckWTurnState = {};
  const r = run(state, { x: 3, z: -1, holdingW: true });
  assertEquals(r.active, false);
  assertEquals(state.stuckWLastX, 3);
  assertEquals(state.stuckWLastZ, -1);
  assertEquals(state.stuckWElapsed, 0);
});

Deno.test("stepStuckWTurn: accumulates elapsed while still + holding W", () => {
  const state: StuckWTurnState = {};
  run(state, { holdingW: true, simDelta: 1, tick: 0 });
  const r = run(state, { holdingW: true, simDelta: 5, tick: 5 });
  assertEquals(r.active, false);
  assertEquals(state.stuckWElapsed, 5);
});

Deno.test("stepStuckWTurn: speed above eps re-anchors and resets elapsed", () => {
  const state: StuckWTurnState = {};
  run(state, { x: 0, z: 0, holdingW: true, simDelta: 1 });
  for (let i = 0; i < 20; i++) {
    run(state, { x: 0, z: 0, holdingW: true, simDelta: 1, tick: i + 1 });
  }
  assertEquals((state.stuckWElapsed ?? 0) > 0, true);

  const jump = STUCK_W_SPEED_EPS * 3;
  const r = run(state, {
    x: jump,
    z: 0,
    holdingW: true,
    simDelta: 1,
    tick: 100,
  });
  assertEquals(r.active, false);
  assertEquals(state.stuckWLastX, jump);
  assertEquals(state.stuckWElapsed, 0);
});

Deno.test("stepStuckWTurn: triggers after window with +90° when rng < 0.5", () => {
  const state: StuckWTurnState = {};
  run(state, { x: 0, z: 0, yaw: 0, holdingW: true, simDelta: 1, tick: 0 });

  let tick = 1;
  let r = run(state, {
    holdingW: true,
    simDelta: STUCK_W_WINDOW_TICKS - 1,
    tick,
    yaw: 0,
    rng: () => 0.25,
  });
  assertEquals(r.active, false);

  tick += STUCK_W_WINDOW_TICKS;
  r = run(state, {
    holdingW: true,
    simDelta: 1,
    tick,
    yaw: 0,
    rng: () => 0.25,
  });
  assertEquals(r.active, true);
  assertEquals(r.justTriggered, true);
  assertAlmostEquals(r.faceYaw ?? 0, Math.PI / 2, 1e-9);
  assertEquals(state.stuckWTurnTicksLeft, STUCK_W_COMMIT_TICKS);
  assertEquals(state.stuckWElapsed, undefined);
});

Deno.test("stepStuckWTurn: triggers with −90° when rng ≥ 0.5", () => {
  const state: StuckWTurnState = {
    stuckWLastX: 0,
    stuckWLastZ: 0,
    stuckWElapsed: STUCK_W_WINDOW_TICKS - 1,
  };
  const r = run(state, {
    x: 0,
    z: 0,
    yaw: 1,
    holdingW: true,
    simDelta: 1,
    tick: 50,
    rng: () => 0.75,
  });
  assertEquals(r.active, true);
  assertAlmostEquals(r.faceYaw ?? 0, 1 - Math.PI / 2, 1e-9);
});

Deno.test("stepStuckWTurn: peelYaw wins over random ±90", () => {
  const state: StuckWTurnState = {
    stuckWLastX: 0,
    stuckWLastZ: 0,
    stuckWElapsed: STUCK_W_WINDOW_TICKS - 1,
  };
  const r = run(state, {
    x: 0,
    z: 0,
    yaw: 0,
    holdingW: true,
    simDelta: 1,
    tick: 50,
    peelYaw: 0.33,
    rng: () => 0.25,
  });
  assertEquals(r.active, true);
  assertAlmostEquals(r.faceYaw ?? 0, 0.33, 1e-9);
});

Deno.test("stepStuckWTurn: commit drains then sets cooldown", () => {
  const face = Math.PI / 2;
  const state: StuckWTurnState = {
    stuckWTurnTicksLeft: 3,
    stuckWTurnFaceYaw: face,
  };
  let r = run(state, { holdingW: true, simDelta: 1, tick: 10 });
  assertEquals(r.active, true);
  assertEquals(state.stuckWTurnTicksLeft, 2);

  r = run(state, { holdingW: true, simDelta: 2, tick: 12 });
  assertEquals(r.active, false);
  assertEquals(state.stuckWTurnTicksLeft, undefined);
  assertEquals(state.stuckWCooldownUntilTick, 12 + STUCK_W_COOLDOWN_TICKS);
});

Deno.test("stepStuckWTurn: cooldown blocks re-arm even while holding W", () => {
  const state: StuckWTurnState = {
    stuckWCooldownUntilTick: 100,
  };
  const r = run(state, {
    holdingW: true,
    simDelta: 1,
    tick: 50,
  });
  assertEquals(r.active, false);
  assertEquals(state.stuckWLastX, undefined);
  assertEquals(state.stuckWCooldownUntilTick, 100);
});

Deno.test("stepStuckWTurn: sub-eps slide keeps accumulating", () => {
  const state: StuckWTurnState = {};
  run(state, { x: 0, z: 0, holdingW: true, simDelta: 1, tick: 0 });
  run(state, {
    x: STUCK_W_SPEED_EPS * 0.4,
    z: -STUCK_W_SPEED_EPS * 0.4,
    holdingW: true,
    simDelta: 1,
    tick: 1,
  });
  assertEquals((state.stuckWElapsed ?? 0) > 0, true);
});
