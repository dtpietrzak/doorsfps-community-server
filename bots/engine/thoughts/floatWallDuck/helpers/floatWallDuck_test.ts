import { assertAlmostEquals, assertEquals, assertLess } from "@std/assert";
import { SPRINT_DURATION_S } from "../../../../../shared/sim/game.ts";
import type { DoorsMap } from "../../../shared/map.ts";
import {
  CROUCH_COLLISION_HEIGHT,
  MapCollision,
} from "../../../world/MapCollision.ts";
import {
  canSprintFromStamina,
  clearFloatWallDuckState,
  estimateFloatWallFaceYaw,
  firstObstacleAlongDesired,
  FLOAT_WALL_DUCK_ABORT_COOLDOWN_TICKS,
  FLOAT_WALL_DUCK_COMMIT_TICKS,
  FLOAT_WALL_DUCK_FULL_WALL_NEAR,
  FLOAT_WALL_DUCK_HEAD_ON_OPTION,
  FLOAT_WALL_DUCK_MIN_PROGRESS,
  FLOAT_WALL_DUCK_OPTIONS,
  FLOAT_WALL_DUCK_PROBE_FRESH,
  FLOAT_WALL_DUCK_PROBE_TIRED,
  FLOAT_WALL_DUCK_PROGRESS_CHECK_TICKS,
  FLOAT_WALL_DUCK_STAMINA_FRAC,
  floatDuckBlocksStandStill,
  floatWallDuckProbeDist,
  type FloatWallDuckState,
  isCrouchableWithin,
  isFullWallNear,
  isUnderFloatSlab,
  pickFloatWallDuckOption,
  stepFloatWallDuck,
} from "./floatWallDuck.ts";
import { yawAbsDelta } from "../../halfWallVault/helpers/halfWallVault.ts";

function floatWallMap(): DoorsMap {
  return {
    version: 1,
    name: "FloatWallDuck",
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
    walls: [
      {
        id: "f1",
        kind: "float",
        a: { x: -6, z: 0 },
        b: { x: 6, z: 0 },
      },
    ],
  };
}

/** Float ahead + full wall bookend on the left (east when facing north). */
function floatWallWithNearFull(): DoorsMap {
  const m = floatWallMap();
  m.walls = [
    ...(m.walls ?? []),
    {
      id: "bookend",
      kind: "full",
      a: { x: 0.8, z: -2 },
      b: { x: 0.8, z: 2 },
    },
  ];
  return m;
}

/** Float ahead + full wall far enough that 1.5u near-check should miss. */
function floatWallWithFarFull(): DoorsMap {
  const m = floatWallMap();
  m.walls = [
    ...(m.walls ?? []),
    {
      id: "farFull",
      kind: "full",
      a: { x: 4, z: -2 },
      b: { x: 4, z: 2 },
    },
  ];
  return m;
}

function openMap(): DoorsMap {
  return {
    version: 1,
    name: "Open",
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
  };
}

function loadCrossroads(): MapCollision {
  const raw = Deno.readTextFileSync(
    new URL("../../../../maps/competitive/Crossroads.doors.json", import.meta.url),
  );
  return new MapCollision(JSON.parse(raw) as DoorsMap);
}

const FULL = SPRINT_DURATION_S;
const FRESH = FULL * FLOAT_WALL_DUCK_STAMINA_FRAC; // exactly 30%
const TIRED = FULL * FLOAT_WALL_DUCK_STAMINA_FRAC - 1e-6;

Deno.test("canSprintFromStamina: 30% threshold", () => {
  assertEquals(canSprintFromStamina(FULL), true);
  assertEquals(canSprintFromStamina(FRESH), true);
  assertEquals(canSprintFromStamina(TIRED), false);
  assertEquals(canSprintFromStamina(0), false);
});

Deno.test("floatWallDuckProbeDist: fresh stamina vs tired", () => {
  assertEquals(floatWallDuckProbeDist(FULL), FLOAT_WALL_DUCK_PROBE_FRESH);
  assertEquals(floatWallDuckProbeDist(FRESH), FLOAT_WALL_DUCK_PROBE_FRESH);
  assertEquals(floatWallDuckProbeDist(TIRED), FLOAT_WALL_DUCK_PROBE_TIRED);
  assertEquals(floatWallDuckProbeDist(0), FLOAT_WALL_DUCK_PROBE_TIRED);
});

Deno.test("pickFloatWallDuckOption: head-on / strafe extremes", () => {
  const face = Math.PI;
  assertEquals(pickFloatWallDuckOption(face, face), 0);
  assertEquals(pickFloatWallDuckOption(face, face - Math.PI / 2), 2);
  assertEquals(pickFloatWallDuckOption(face, face + Math.PI / 4), 3);
});

Deno.test("isFullWallNear: detects full wall within 1.5u, ignores float-only", () => {
  const floatOnly = new MapCollision(floatWallMap());
  const nearFull = new MapCollision(floatWallWithNearFull());
  const farFull = new MapCollision(floatWallWithFarFull());
  const x = 0;
  const z = -0.55;
  assertEquals(isFullWallNear(floatOnly, x, z), false);
  assertEquals(
    isFullWallNear(nearFull, x, z, FLOAT_WALL_DUCK_FULL_WALL_NEAR),
    true,
  );
  assertEquals(
    isFullWallNear(farFull, x, z, FLOAT_WALL_DUCK_FULL_WALL_NEAR),
    false,
  );
  assertEquals(FLOAT_WALL_DUCK_FULL_WALL_NEAR, 1.5);
});

Deno.test(
  "pickFloatWallDuckOption: side wall collapses blocked side only (not ring)",
  () => {
    const col = new MapCollision(floatWallWithNearFull());
    const face = Math.PI; // north
    const x = 0;
    const z = -0.55;
    // Free pick without collision: pure A (−90° from face) → option 2.
    assertEquals(pickFloatWallDuckOption(face, face - Math.PI / 2), 2);
    // Bookend at x=0.8 is within side-clear on the A axis for this face
    // (half-wall vault sideYaw convention). Desired pure-A collapses to W.
    assertEquals(
      pickFloatWallDuckOption(face, face - Math.PI / 2, {
        x,
        z,
        collision: col,
      }),
      FLOAT_WALL_DUCK_HEAD_ON_OPTION,
    );
    // Ring full-near alone must NOT force head-on when the free pick is
    // already head-on (path-aligned duck). Path-aligned desired = face → 0.
    assertEquals(
      pickFloatWallDuckOption(face, face, { x, z, collision: col }),
      FLOAT_WALL_DUCK_HEAD_ON_OPTION,
    );
    // Far bookend map: free A pick is still allowed (no side block within 1u).
    const far = new MapCollision(floatWallWithFarFull());
    assertEquals(
      pickFloatWallDuckOption(face, face - Math.PI / 2, {
        x,
        z,
        collision: far,
      }),
      2,
    );
  },
);

Deno.test(
  "stepFloatWallDuck: path-aligned face (desired yaw), not side-arm normal",
  () => {
    const col = new MapCollision(floatWallMap());
    const desired = Math.PI; // north through the float
    const r = stepFloatWallDuck({
      x: 0,
      z: -0.55,
      desiredYaw: desired,
      sprintStamina: FULL,
      vaultActive: false,
      collision: col,
      simDelta: 1,
      state: {},
    });
    assertEquals(r.active, true);
    assertEquals(r.crouch, true);
    assertEquals(r.forward, true);
    // Path-aligned: face is desired, not an arbitrary wall push.
    assertLess(yawAbsDelta(r.faceYaw!, desired), 1e-6);
  },
);

Deno.test("isCrouchableWithin: detects float at tired and fresh ranges", () => {
  const col = new MapCollision(floatWallMap());
  const yaw = Math.PI;
  assertEquals(
    isCrouchableWithin(col, 0, -1.5, yaw, FLOAT_WALL_DUCK_PROBE_TIRED),
    false,
  );
  assertEquals(
    isCrouchableWithin(col, 0, -1.5, yaw, FLOAT_WALL_DUCK_PROBE_FRESH),
    true,
  );
  assertEquals(
    isCrouchableWithin(col, 0, -0.55, yaw, FLOAT_WALL_DUCK_PROBE_TIRED),
    true,
  );
});

Deno.test("stepFloatWallDuck: dormant far / open map", () => {
  const floatCol = new MapCollision(floatWallMap());
  const openCol = new MapCollision(openMap());
  assertEquals(
    stepFloatWallDuck({
      x: 0,
      z: -8,
      desiredYaw: Math.PI,
      sprintStamina: FULL,
      vaultActive: false,
      collision: floatCol,
      simDelta: 1,
      state: {},
    }).active,
    false,
  );
  assertEquals(
    stepFloatWallDuck({
      x: 0,
      z: -0.55,
      desiredYaw: Math.PI,
      sprintStamina: FULL,
      vaultActive: false,
      collision: openCol,
      simDelta: 1,
      state: {},
    }).active,
    false,
  );
});

Deno.test("stepFloatWallDuck: low stamina only triggers within tired probe", () => {
  const col = new MapCollision(floatWallMap());
  const far = stepFloatWallDuck({
    x: 0,
    z: -1.5,
    desiredYaw: Math.PI,
    sprintStamina: TIRED,
    vaultActive: false,
    collision: col,
    simDelta: 1,
    state: {},
  });
  assertEquals(far.active, false);

  const near = stepFloatWallDuck({
    x: 0,
    z: -0.55,
    desiredYaw: Math.PI,
    sprintStamina: TIRED,
    vaultActive: false,
    collision: col,
    simDelta: 1,
    state: {},
  });
  assertEquals(near.active, true);
  assertEquals(near.crouch, true);
  assertEquals(near.forward, true);
  assertEquals(near.left, false);
  assertEquals(near.right, false);
  assertEquals(
    near.statePatch.floatWallDuckTicksLeft,
    FLOAT_WALL_DUCK_COMMIT_TICKS,
  );
});

Deno.test("stepFloatWallDuck: ≥30% stamina triggers within fresh probe", () => {
  const col = new MapCollision(floatWallMap());
  const r = stepFloatWallDuck({
    x: 0,
    z: -1.5,
    desiredYaw: Math.PI,
    sprintStamina: FRESH,
    vaultActive: false,
    collision: col,
    simDelta: 1,
    state: {},
  });
  assertEquals(r.active, true);
  assertEquals(r.crouch, true);
  assertEquals(typeof r.faceYaw, "number");
  assertLess(yawAbsDelta(r.faceYaw!, Math.PI), 0.5);
});

Deno.test("stepFloatWallDuck: vaultActive blocks start and clears state", () => {
  const col = new MapCollision(floatWallMap());
  const r = stepFloatWallDuck({
    x: 0,
    z: -0.55,
    desiredYaw: Math.PI,
    sprintStamina: FULL,
    vaultActive: true,
    collision: col,
    simDelta: 1,
    state: {
      floatWallDuckTicksLeft: 20,
      floatWallDuckFaceYaw: Math.PI,
      floatWallDuckOption: 0,
    },
  });
  assertEquals(r.active, false);
  assertEquals(r.statePatch.floatWallDuckTicksLeft, undefined);
});

Deno.test("stepFloatWallDuck: commit holds then clears", () => {
  const col = new MapCollision(floatWallMap());
  const start = stepFloatWallDuck({
    x: 0,
    z: -0.55,
    desiredYaw: Math.PI,
    sprintStamina: FULL,
    vaultActive: false,
    collision: col,
    simDelta: 1,
    state: {},
  });
  assertEquals(start.active, true);
  const state: FloatWallDuckState = { ...start.statePatch };

  // Mid-commit with progress so watchdog does not abort: move north a bit.
  const mid = stepFloatWallDuck({
    x: 0,
    z: -0.3,
    desiredYaw: Math.PI,
    sprintStamina: FULL,
    vaultActive: false,
    collision: col,
    simDelta: 5,
    state,
  });
  assertEquals(mid.active, true);
  assertEquals(mid.crouch, true);
  Object.assign(state, mid.statePatch);
  // Drop undefineds from clear patches
  for (const k of Object.keys(state) as (keyof FloatWallDuckState)[]) {
    if (state[k] === undefined) delete state[k];
  }

  const left = state.floatWallDuckTicksLeft ?? 0;
  const end = stepFloatWallDuck({
    x: 0,
    z: 2, // past the float — clear north
    desiredYaw: Math.PI,
    sprintStamina: FULL,
    vaultActive: false,
    collision: col,
    simDelta: Math.max(left, FLOAT_WALL_DUCK_PROGRESS_CHECK_TICKS) + 5,
    tick: 100,
    state: {
      ...state,
      floatWallDuckStartX: 0,
      floatWallDuckStartZ: -0.55,
      floatWallDuckElapsed: FLOAT_WALL_DUCK_PROGRESS_CHECK_TICKS + 10,
    },
  });
  // Either timer exhausted or path cleared → inactive.
  assertEquals(end.active, false);
  assertEquals(end.statePatch.floatWallDuckTicksLeft, undefined);
});

Deno.test("stepFloatWallDuck: zero progress aborts with cooldown", () => {
  const col = new MapCollision(floatWallMap());
  // Pin against a full wall so move makes no progress.
  const map: DoorsMap = {
    ...floatWallMap(),
    walls: [
      {
        id: "fullBlock",
        kind: "full",
        a: { x: -4, z: 0 },
        b: { x: 4, z: 0 },
      },
    ],
  };
  const blocked = new MapCollision(map);
  // Desired north into full wall first → should not start.
  const noStart = stepFloatWallDuck({
    x: 0,
    z: -1,
    desiredYaw: Math.PI,
    sprintStamina: FULL,
    vaultActive: false,
    collision: blocked,
    simDelta: 1,
    state: {},
  });
  assertEquals(noStart.active, false);

  // Manually start a commit then stall at same pose past progress check.
  const stalled = stepFloatWallDuck({
    x: 0,
    z: -1,
    desiredYaw: Math.PI,
    sprintStamina: FULL,
    vaultActive: false,
    collision: col,
    simDelta: 5,
    tick: 50,
    state: {
      floatWallDuckTicksLeft: 40,
      floatWallDuckFaceYaw: Math.PI,
      floatWallDuckOption: 0,
      floatWallDuckStartX: 0,
      floatWallDuckStartZ: -1,
      floatWallDuckElapsed: FLOAT_WALL_DUCK_PROGRESS_CHECK_TICKS,
    },
  });
  assertEquals(stalled.active, false);
  assertEquals(
    stalled.statePatch.floatWallDuckCooldownUntilTick,
    50 + FLOAT_WALL_DUCK_ABORT_COOLDOWN_TICKS,
  );
  assertEquals(FLOAT_WALL_DUCK_MIN_PROGRESS > 0, true);
});

Deno.test("stepFloatWallDuck: under slab forces crouch + exit", () => {
  const col = new MapCollision(floatWallMap());
  // Under the E–W float at origin.
  assertEquals(isUnderFloatSlab(col, 0, 0), true);
  const r = stepFloatWallDuck({
    x: 0,
    z: 0,
    desiredYaw: Math.PI,
    sprintStamina: FULL,
    vaultActive: false,
    collision: col,
    simDelta: 3,
    state: {},
  });
  assertEquals(r.active, true);
  assertEquals(r.crouch, true);
  assertEquals(r.forward, true);
  assertEquals(typeof r.faceYaw, "number");

  // Simulate a few exit steps — should leave overhead.
  let x = 0;
  let z = 0;
  const state: FloatWallDuckState = { ...r.statePatch };
  for (let i = 0; i < 25; i++) {
    const step = stepFloatWallDuck({
      x,
      z,
      desiredYaw: Math.PI,
      sprintStamina: FULL,
      vaultActive: false,
      collision: col,
      simDelta: 3,
      tick: i * 3,
      state,
    });
    for (const [k, v] of Object.entries(step.statePatch)) {
      if (v === undefined) delete (state as Record<string, unknown>)[k];
      else (state as Record<string, unknown>)[k] = v;
    }
    if (!step.active || typeof step.faceYaw !== "number") break;
    const face = step.faceYaw;
    const spd = 3 * 0.5 * (3 / 60);
    x += -Math.sin(face) * spd;
    z += -Math.cos(face) * spd;
    const res = col.resolvePosition(x, z, 0.35, 0, CROUCH_COLLISION_HEIGHT);
    x = res.x;
    z = res.z;
  }
  assertEquals(isUnderFloatSlab(col, x, z), false);
});

Deno.test("floatDuckBlocksStandStill: active commit or under slab", () => {
  const col = new MapCollision(floatWallMap());
  assertEquals(floatDuckBlocksStandStill({}, col, 0, -5), false);
  assertEquals(
    floatDuckBlocksStandStill({ floatWallDuckTicksLeft: 10 }, col, 0, -5),
    true,
  );
  assertEquals(floatDuckBlocksStandStill({}, col, 0, 0), true);
});

Deno.test("estimateFloatWallFaceYaw: points into E–W float from south", () => {
  const col = new MapCollision(floatWallMap());
  const face = estimateFloatWallFaceYaw(col, 0, -1.0, Math.PI);
  assertEquals(face !== null, true);
  assertLess(yawAbsDelta(face!, Math.PI), 0.5);
});

Deno.test("clearFloatWallDuckState wipes commit fields", () => {
  const patch = clearFloatWallDuckState({
    floatWallDuckTicksLeft: 10,
    floatWallDuckFaceYaw: 1,
    floatWallDuckOption: 2,
    floatWallDuckStartX: 1,
    floatWallDuckStartZ: 2,
    floatWallDuckElapsed: 5,
  });
  assertEquals(patch.floatWallDuckTicksLeft, undefined);
  assertEquals(patch.floatWallDuckFaceYaw, undefined);
  assertEquals(patch.floatWallDuckOption, undefined);
  assertEquals(patch.floatWallDuckStartX, undefined);
  assertEquals(patch.floatWallDuckStartZ, undefined);
  assertEquals(patch.floatWallDuckElapsed, undefined);
});

Deno.test("FLOAT_WALL_DUCK_OPTIONS match half-wall key geometry", () => {
  assertAlmostEquals(FLOAT_WALL_DUCK_OPTIONS[0]!.moveOffset, 0, 1e-9);
  assertAlmostEquals(
    FLOAT_WALL_DUCK_OPTIONS[2]!.moveOffset,
    -Math.PI / 2,
    1e-9,
  );
  assertEquals(FLOAT_WALL_DUCK_OPTIONS[0]!.keys.forward, true);
  assertEquals(FLOAT_WALL_DUCK_OPTIONS[2]!.keys.left, true);
  assertEquals(FLOAT_WALL_DUCK_OPTIONS[2]!.keys.forward, false);
});

Deno.test("firstObstacleAlongDesired: crouchable before blocked on open float", () => {
  const col = new MapCollision(floatWallMap());
  const first = firstObstacleAlongDesired(col, 0, -2, Math.PI, 4);
  assertEquals(first?.kind, "crouchable");
});

// ---------------------------------------------------------------------------
// Crossroads regression — the mid-map stuck that motivated the rewrite
// ---------------------------------------------------------------------------

Deno.test("Crossroads: south approach path-aligns north (not west into spine)", () => {
  const col = loadCrossroads();
  const north = Math.PI;
  // Historic fail pose: x=1.2, z≈-2.2 faced west (~1.4) and rammed the spine.
  const r = stepFloatWallDuck({
    x: 1.2,
    z: -2.2,
    desiredYaw: north,
    sprintStamina: FULL,
    vaultActive: false,
    collision: col,
    simDelta: 3,
    tick: 100,
    state: {},
  });
  assertEquals(r.active, true);
  assertEquals(r.crouch, true);
  // Must face path (north), not side-arm (~π/2 west).
  assertLess(yawAbsDelta(r.faceYaw!, north), 0.2);
  assertEquals(r.forward, true);
  assertEquals(r.left, false);
  assertEquals(r.right, false);
});

Deno.test("Crossroads: approach from south clears past origin while ducking", () => {
  const col = loadCrossroads();
  const north = Math.PI;
  let x = 1.2;
  let z = -5;
  const state: FloatWallDuckState = {};
  let maxZ = z;
  let stuckAtSpine = false;

  for (let i = 0; i < 80; i++) {
    const r = stepFloatWallDuck({
      x,
      z,
      desiredYaw: north,
      sprintStamina: FULL,
      vaultActive: false,
      collision: col,
      simDelta: 3,
      tick: i * 3,
      state,
    });
    for (const [k, v] of Object.entries(r.statePatch)) {
      if (v === undefined) delete (state as Record<string, unknown>)[k];
      else (state as Record<string, unknown>)[k] = v;
    }

    const crouch = r.active || isUnderFloatSlab(col, x, z);
    const head = crouch ? CROUCH_COLLISION_HEIGHT : 1.7;
    if (r.active && typeof r.faceYaw === "number") {
      let mx = 0;
      let mz = 0;
      if (r.forward) {
        mx += -Math.sin(r.faceYaw);
        mz += -Math.cos(r.faceYaw);
      }
      if (r.left) {
        mx += -Math.cos(r.faceYaw);
        mz += Math.sin(r.faceYaw);
      }
      if (r.right) {
        mx += Math.cos(r.faceYaw);
        mz += -Math.sin(r.faceYaw);
      }
      const len = Math.hypot(mx, mz) || 1;
      const spd = 3 * 0.5 * (3 / 60); // crouch walk
      x += (mx / len) * spd;
      z += (mz / len) * spd;
    } else {
      const spd = 5 * (3 / 60); // walk
      x += -Math.sin(north) * spd;
      z += -Math.cos(north) * spd;
    }
    const res = col.resolvePosition(x, z, 0.35, 0, head);
    x = res.x;
    z = res.z;
    maxZ = Math.max(maxZ, z);

    // Historic stuck band: x≈0.57, z≈-2.2 thrashing.
    if (
      Math.abs(x - 0.57) < 0.25 && z > -2.6 && z < -1.8 && i > 30
    ) {
      stuckAtSpine = true;
    }
    if (z > 3) break;
  }

  assertEquals(
    stuckAtSpine,
    false,
    `stuck on spine at (${x.toFixed(2)},${z.toFixed(2)})`,
  );
  assertEquals(
    maxZ > 1.5,
    true,
    `failed to clear mid — maxZ=${maxZ.toFixed(2)} final=(${x.toFixed(2)},${
      z.toFixed(2)
    })`,
  );
});

Deno.test("Crossroads: under float cross exits without releasing crouch early", () => {
  const col = loadCrossroads();
  assertEquals(isUnderFloatSlab(col, 0, 0), true);
  let x = 0;
  let z = 0;
  const state: FloatWallDuckState = {};
  let releasedWhileUnder = false;

  for (let i = 0; i < 40; i++) {
    const underBefore = isUnderFloatSlab(col, x, z);
    const r = stepFloatWallDuck({
      x,
      z,
      desiredYaw: Math.PI,
      sprintStamina: FULL,
      vaultActive: false,
      collision: col,
      simDelta: 3,
      tick: i * 3,
      state,
    });
    for (const [k, v] of Object.entries(r.statePatch)) {
      if (v === undefined) delete (state as Record<string, unknown>)[k];
      else (state as Record<string, unknown>)[k] = v;
    }
    if (underBefore && !r.crouch && !r.active) {
      releasedWhileUnder = true;
    }
    if (r.active && typeof r.faceYaw === "number") {
      const spd = 3 * 0.5 * (3 / 60);
      x += -Math.sin(r.faceYaw) * spd;
      z += -Math.cos(r.faceYaw) * spd;
      const res = col.resolvePosition(x, z, 0.35, 0, CROUCH_COLLISION_HEIGHT);
      x = res.x;
      z = res.z;
    }
    if (!isUnderFloatSlab(col, x, z) && i > 2) break;
  }

  assertEquals(releasedWhileUnder, false);
  assertEquals(isUnderFloatSlab(col, x, z), false);
});
