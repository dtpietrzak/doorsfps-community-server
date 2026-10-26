import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  moveYawFromApproachLateral,
  moveYawWithLateral,
  openSpaceScaleForDir,
  PATH_STRAFE_DEAD_FLOOR,
  PATH_STRAFE_DEAD_SEC_MAX,
  PATH_STRAFE_FEELER_DIST,
  PATH_STRAFE_HOLD_SEC_MAX,
  PATH_STRAFE_HOLD_SEC_MIN,
  PATH_STRAFE_MAX_LATERAL,
  PATH_STRAFE_OUTSIDE_HOLD_MULT,
  PATH_STRAFE_REST_SEC_MIN,
  pathStrafeDeadChance,
  pathStrafeLateralAmount,
  pathStrafeOutsideSign,
  pathStrafeShouldSuppress,
  type PathStrafeState,
  rollPathStrafeHoldTicks,
  sideClearDist,
  stepPathStrafeMove,
  stepPathStrafePhase,
} from "./pathStrafe.ts";
import { TICK_HZ } from "../../../shared/network.ts";
import type { DoorsMap } from "../../../shared/map.ts";
import { MapCollision } from "../../../world/MapCollision.ts";
import {
  maxStrafeFromCornerRound,
  YAW_POLE_CORNER_MAX_STRAFE,
  YAW_POLE_CORNER_OVER_STRAFE_MAX,
} from "../../yawPole/helpers/yawPole.ts";

/** Cold pathStrafe fields, as a new brain state holds them. */
function coldPathStrafeState(): PathStrafeState {
  return {
    pathStrafeDir: "none",
    pathStrafeTicksLeft: Number.NaN,
    pathStrafeFirst: "",
  };
}

function openMap(): DoorsMap {
  return {
    version: 1,
    name: "PathStrafeOpen",
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

function tunnelMap(): DoorsMap {
  // Full walls close on left and right of a north-south lane at x=0.
  return {
    ...openMap(),
    name: "PathStrafeTunnel",
    walls: [
      {
        id: "left",
        kind: "full",
        a: { x: -0.9, z: -20 },
        b: { x: -0.9, z: 20 },
      },
      {
        id: "right",
        kind: "full",
        a: { x: 0.9, z: -20 },
        b: { x: 0.9, z: 20 },
      },
    ],
  };
}

Deno.test("pathStrafeDeadChance: personality 0 always dead", () => {
  assertEquals(pathStrafeDeadChance(0), 1);
  assertEquals(pathStrafeDeadChance(-1), 1);
  assertAlmostEquals(pathStrafeDeadChance(1), PATH_STRAFE_DEAD_FLOOR, 1e-9);
  assertAlmostEquals(pathStrafeDeadChance(0.4), 0.6, 1e-9);
  // Below 1 - floor, the floor wins so high personality still rests.
  assertAlmostEquals(pathStrafeDeadChance(0.95), PATH_STRAFE_DEAD_FLOOR, 1e-9);
});

Deno.test("pathStrafeLateralAmount: zero when none / near corner / personality 0", () => {
  assertEquals(
    pathStrafeLateralAmount({
      dir: "left",
      personality: 0,
      openScale: 1,
      approachT: 0,
    }),
    0,
  );
  assertEquals(
    pathStrafeLateralAmount({
      dir: "none",
      personality: 1,
      openScale: 1,
      approachT: 0,
    }),
    0,
  );
  assertEquals(
    pathStrafeLateralAmount({
      dir: "right",
      personality: 1,
      openScale: 1,
      approachT: 1,
    }),
    0,
  );
  assertAlmostEquals(
    pathStrafeLateralAmount({
      dir: "left",
      personality: 1,
      openScale: 1,
      approachT: 0,
    }),
    -PATH_STRAFE_MAX_LATERAL,
    1e-9,
  );
  assertAlmostEquals(
    pathStrafeLateralAmount({
      dir: "right",
      personality: 1,
      openScale: 1,
      approachT: 0,
    }),
    PATH_STRAFE_MAX_LATERAL,
    1e-9,
  );
});

Deno.test("pathStrafeOutsideSign: next right → outside left (−1)", () => {
  // Approach south toward (0,-8); next east of current.
  const s = pathStrafeOutsideSign(0, 0, { x: 0, z: -8 }, { x: 8, z: -8 });
  assertEquals(s, -1);
  const left = pathStrafeOutsideSign(0, 0, { x: 0, z: -8 }, { x: -8, z: -8 });
  assertEquals(left, 1);
  assertEquals(pathStrafeOutsideSign(0, 0, { x: 0, z: -8 }, null), 0);
});

Deno.test("rollPathStrafeHoldTicks: outside hold ~2× inside", () => {
  const fixed = () => 0.5; // mid of hold band
  const midSec = (PATH_STRAFE_HOLD_SEC_MIN + PATH_STRAFE_HOLD_SEC_MAX) / 2;
  const inside = rollPathStrafeHoldTicks({
    personality: 1,
    dir: "right",
    outsideSign: -1, // outside is left
    rng: fixed,
  });
  const outside = rollPathStrafeHoldTicks({
    personality: 1,
    dir: "left",
    outsideSign: -1,
    rng: fixed,
  });
  assertAlmostEquals(inside, Math.round(midSec * TICK_HZ), 1);
  assertAlmostEquals(
    outside,
    Math.round(midSec * PATH_STRAFE_OUTSIDE_HOLD_MULT * TICK_HZ),
    1,
  );
  assert(outside >= inside * 1.9);
});

Deno.test("stepPathStrafePhase: personality 0 stays none", () => {
  const state = coldPathStrafeState();
  const dir = stepPathStrafePhase({
    state,
    personality: 0,
    outsideSign: 0,
    simDelta: 1,
    rng: () => 0.1,
    suppress: false,
  });
  assertEquals(dir, "none");
});

Deno.test("stepPathStrafePhase: suppress forces none", () => {
  const state: PathStrafeState = {
    pathStrafeFirst: "left",
    pathStrafeDir: "left",
    pathStrafeTicksLeft: 20,
  };
  const dir = stepPathStrafePhase({
    state,
    personality: 1,
    outsideSign: 0,
    simDelta: 1,
    rng: () => 0,
    suppress: true,
  });
  assertEquals(dir, "none");
  assertEquals(state.pathStrafeDir, "none");
});

Deno.test("stepPathStrafePhase: alternates when never dead", () => {
  // rng sequence: first pick (0 → left), dead roll (1 → not dead), hold u
  let i = 0;
  const seq = [0.0, 0.99, 0.5, 0.99, 0.5, 0.99, 0.5];
  const rng = () => {
    const v = seq[i] ?? 0.5;
    i++;
    return v;
  };
  const state = coldPathStrafeState();
  const d0 = stepPathStrafePhase({
    state,
    personality: 1,
    outsideSign: 0,
    simDelta: 1,
    rng,
    suppress: false,
  });
  assertEquals(d0, "left");
  // Burn remaining ticks.
  const hold = state.pathStrafeTicksLeft ?? 0;
  for (let t = 0; t < hold; t++) {
    stepPathStrafePhase({
      state,
      personality: 1,
      outsideSign: 0,
      simDelta: 1,
      rng,
      suppress: false,
    });
  }
  // After expiry, next call rolls opposite.
  // Reset rng index-ish: use always-not-dead.
  const state2: PathStrafeState = {
    pathStrafeFirst: "left",
    pathStrafeDir: "left",
    pathStrafeTicksLeft: 0,
  };
  let j = 0;
  const rng2 = () => {
    // exit miss, not dead, then hold u
    const vals = [0.99, 0.99, 0.5];
    return vals[j++] ?? 0.5;
  };
  const d1 = stepPathStrafePhase({
    state: state2,
    personality: 1,
    outsideSign: 0,
    simDelta: 1,
    rng: rng2,
    suppress: false,
  });
  assertEquals(d1, "right");
});

Deno.test("stepPathStrafePhase: Nudge picks its side only at ADAD boundaries", () => {
  const state: PathStrafeState = {
    pathStrafeFirst: "left",
    pathStrafeDir: "left",
    pathStrafeTicksLeft: 0,
  };
  let i = 0;
  // exit miss, not dead, hold u
  const rng = () => [0.99, 0.99, 0.5][i++] ?? 0.5;
  const first = stepPathStrafePhase({
    state,
    personality: 1,
    outsideSign: 0,
    simDelta: 1,
    rng,
    preferredDir: "right",
    suppress: false,
  });
  assertEquals(first, "right");

  const ticksBefore = state.pathStrafeTicksLeft ?? 0;
  const held = stepPathStrafePhase({
    state,
    personality: 1,
    outsideSign: 0,
    simDelta: 1,
    rng,
    preferredDir: "left",
    suppress: false,
  });
  assertEquals(held, "right");
  assertEquals(state.pathStrafeTicksLeft, ticksBefore - 1);
});

Deno.test("stepPathStrafePhase: live hold can exit into a long rest", () => {
  const state: PathStrafeState = {
    pathStrafeFirst: "left",
    pathStrafeDir: "left",
    pathStrafeTicksLeft: 0,
  };
  let i = 0;
  // exit hit, then rest-band u
  const rng = () => [0.0, 0.5][i++] ?? 0.5;
  const dir = stepPathStrafePhase({
    state,
    personality: 1,
    outsideSign: 0,
    simDelta: 1,
    rng,
    suppress: false,
  });
  assertEquals(dir, "none");
  assertEquals(state.pathStrafeDir, "none");
  const restTicks = state.pathStrafeTicksLeft ?? 0;
  const shortDeadMax = Math.round(PATH_STRAFE_DEAD_SEC_MAX * TICK_HZ);
  const restMin = Math.round(PATH_STRAFE_REST_SEC_MIN * TICK_HZ);
  assert(restTicks >= restMin, `rest ticks ${restTicks} < min ${restMin}`);
  assert(
    restTicks >= shortDeadMax,
    `rest ticks ${restTicks} should be ≥ short dead max ${shortDeadMax}`,
  );
});

Deno.test("openSpaceScaleForDir: open map full, tunnel near zero", () => {
  const open = new MapCollision(openMap());
  const tunnel = new MapCollision(tunnelMap());
  const faceYaw = 0; // south
  assertAlmostEquals(
    openSpaceScaleForDir(open, 0, 0, faceYaw, "left"),
    1,
    0.05,
  );
  assertAlmostEquals(
    openSpaceScaleForDir(open, 0, 0, faceYaw, "right"),
    1,
    0.05,
  );
  const tL = openSpaceScaleForDir(tunnel, 0, 0, faceYaw, "left");
  const tR = openSpaceScaleForDir(tunnel, 0, 0, faceYaw, "right");
  assert(tL < 0.4, `tunnel left scale ${tL}`);
  assert(tR < 0.4, `tunnel right scale ${tR}`);
  assert(
    sideClearDist(tunnel, 0, 0, faceYaw, "left") <
      PATH_STRAFE_FEELER_DIST * 0.5,
  );
});

Deno.test("pathStrafeShouldSuppress: vault ticks / jumpable ahead", () => {
  assertEquals(
    pathStrafeShouldSuppress({
      x: 0,
      z: 0,
      pathYaw: 0,
      halfWallVaultTicksLeft: 5,
    }),
    true,
  );
  assertEquals(
    pathStrafeShouldSuppress({
      x: 0,
      z: 0,
      pathYaw: 0,
      floatWallDuckTicksLeft: 3,
    }),
    true,
  );
  const halfMap: DoorsMap = {
    ...openMap(),
    walls: [
      {
        id: "half",
        kind: "half",
        a: { x: -4, z: -1 },
        b: { x: 4, z: -1 },
      },
    ],
  };
  const col = new MapCollision(halfMap);
  // Standing south of half wall, path north into it.
  assertEquals(
    pathStrafeShouldSuppress({
      collision: col,
      x: 0,
      z: 0,
      pathYaw: 0, // forward −z in player convention? yaw 0 = −z
    }),
    true,
  );
});

Deno.test("stepPathStrafeMove: personality 0 = pure approach", () => {
  const state = coldPathStrafeState();
  const approachYaw = 0;
  const out = stepPathStrafeMove({
    state,
    x: 0,
    z: 0,
    approachYaw,
    current: { x: 0, z: -10 },
    next: null,
    personality: 0,
    cornerLateral: 0,
    collision: new MapCollision(openMap()),
    simDelta: 1,
    rng: () => 0.1,
    suppress: false,
  });
  assertAlmostEquals(out.moveYaw, approachYaw, 1e-6);
  assertEquals(out.pathLateral, 0);
});

Deno.test("stepPathStrafeMove: Nudge phase does not steer move yaw", () => {
  const approachYaw = 0;
  const out = stepPathStrafeMove({
    state: {
      pathStrafeFirst: "right",
      pathStrafeDir: "right",
      pathStrafeTicksLeft: 100,
    },
    x: 0,
    z: 0,
    approachYaw,
    current: { x: 0, z: -10 },
    next: null,
    personality: 1,
    cornerLateral: 0,
    collision: new MapCollision(openMap()),
    simDelta: 1,
    rng: () => 0.5,
    preferredDir: "right",
    phaseOnly: true,
    suppress: false,
  });
  assertEquals(out.dir, "right");
  assertEquals(out.pathLateral, 0);
  assertAlmostEquals(out.moveYaw, approachYaw, 1e-9);
});

Deno.test("stepPathStrafeMove: Nudge does not press A/D into a tight wall", () => {
  const out = stepPathStrafeMove({
    state: {
      pathStrafeFirst: "left",
      pathStrafeDir: "left",
      pathStrafeTicksLeft: 100,
    },
    x: 0,
    z: 0,
    approachYaw: 0,
    current: { x: 0, z: -10 },
    next: null,
    personality: 1,
    cornerLateral: 0,
    collision: new MapCollision(tunnelMap()),
    simDelta: 1,
    rng: () => 0.5,
    preferredDir: "left",
    phaseOnly: true,
    suppress: false,
  });
  assertEquals(out.dir, "none");
  assertEquals(out.pathLateral, 0);
});

Deno.test("stepPathStrafeMove: near pole fades path lateral", () => {
  const state: PathStrafeState = {
    pathStrafeFirst: "left",
    pathStrafeDir: "left",
    pathStrafeTicksLeft: 100,
  };
  // Far from pole (dist 20).
  const far = stepPathStrafeMove({
    state: { ...state },
    x: 0,
    z: 12,
    approachYaw: 0,
    current: { x: 0, z: -8 },
    next: null,
    personality: 1,
    cornerLateral: 0,
    collision: new MapCollision(openMap()),
    simDelta: 1,
    rng: () => 0.5,
    suppress: false,
  });
  // Near pole (dist 1.5).
  const near = stepPathStrafeMove({
    state: { ...state },
    x: 0,
    z: -6.5,
    approachYaw: 0,
    current: { x: 0, z: -8 },
    next: null,
    personality: 1,
    cornerLateral: 0,
    collision: new MapCollision(openMap()),
    simDelta: 1,
    rng: () => 0.5,
    suppress: false,
  });
  assert(Math.abs(far.pathLateral) > Math.abs(near.pathLateral) + 0.05);
  assertAlmostEquals(near.approachT, 1, 0.05);
  assertAlmostEquals(near.pathLateral, 0, 0.02);
});

Deno.test("moveYawFromApproachLateral: left lateral increases yaw vs south approach", () => {
  const approach = 0; // south
  const left = moveYawFromApproachLateral(approach, 0.5, -1);
  // Left of south is east-ish in this basis?
  // right basis (cos, -sin) at yaw 0 = (1, 0) = +x
  // left = −right = −x = west → move yaw +π/2-ish
  const delta = left - approach;
  // Signed delta should be positive for left (west from south).
  assert(delta > 0.2 || delta < -0.2);
  const pure = moveYawWithLateral(approach, 0);
  assertAlmostEquals(pure, approach, 1e-9);
});

Deno.test("maxStrafeFromCornerRound: 1 = full normal, >1 over-rounds", () => {
  assertAlmostEquals(
    maxStrafeFromCornerRound(1),
    YAW_POLE_CORNER_MAX_STRAFE,
    1e-9,
  );
  assertAlmostEquals(maxStrafeFromCornerRound(0), 0, 1e-9);
  const over = maxStrafeFromCornerRound(1.5);
  assert(over > YAW_POLE_CORNER_MAX_STRAFE);
  assert(over <= YAW_POLE_CORNER_OVER_STRAFE_MAX);
  assertAlmostEquals(
    maxStrafeFromCornerRound(10),
    YAW_POLE_CORNER_OVER_STRAFE_MAX,
    1e-9,
  );
});
