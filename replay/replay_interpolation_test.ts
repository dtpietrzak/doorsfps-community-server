/**
 * Epic 11.4 — replay pose interpolation.
 *
 * Run from server-community/:
 *   deno test -A replay/replay_interpolation_test.ts
 */

import {
  assertEquals,
  assertAlmostEquals,
  assertThrows,
  assertNotStrictEquals,
  assertStrictEquals,
} from "@std/assert";
import { TICK_MS } from "../shared/sim/game.ts";
import {
  REPLAY_INTERP_SNAP_DISTANCE,
  ReplayInterpError,
  clampInterpAlpha,
  interpolateReplayPose,
  interpolateReplayRoster,
  type ReplayInterpPose,
} from "./replayInterpolation.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function pose(
  overrides: Partial<ReplayInterpPose> & Pick<ReplayInterpPose, "id">,
): ReplayInterpPose {
  return {
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    pitch: 0,
    alive: true,
    spawnedAtTick: 0,
    diedAtTick: null,
    crouch: false,
    onGround: true,
    ...overrides,
  };
}

function assertPoseExact(actual: ReplayInterpPose, expected: ReplayInterpPose) {
  assertEquals(actual.id, expected.id);
  assertStrictEquals(actual.x, expected.x);
  assertStrictEquals(actual.y, expected.y);
  assertStrictEquals(actual.z, expected.z);
  assertStrictEquals(actual.yaw, expected.yaw);
  assertStrictEquals(actual.pitch, expected.pitch);
  assertEquals(actual.alive, expected.alive);
  assertEquals(actual.spawnedAtTick, expected.spawnedAtTick);
  assertEquals(actual.diedAtTick, expected.diedAtTick);
  assertEquals(actual.crouch, expected.crouch);
  assertEquals(actual.onGround, expected.onGround);
  assertEquals(actual.velocityX, expected.velocityX);
  assertEquals(actual.velocityY, expected.velocityY);
  assertEquals(actual.velocityZ, expected.velocityZ);
}

function assertInterpError(
  fn: () => unknown,
  code: ReplayInterpError["code"],
): ReplayInterpError {
  const err = assertThrows(fn, ReplayInterpError) as ReplayInterpError;
  assertEquals(err.code, code);
  return err;
}

// ---------------------------------------------------------------------------
// clampInterpAlpha
// ---------------------------------------------------------------------------

Deno.test("clampInterpAlpha: identity inside [0,1]", () => {
  assertEquals(clampInterpAlpha(0), 0);
  assertEquals(clampInterpAlpha(1), 1);
  assertEquals(clampInterpAlpha(0.25), 0.25);
  assertEquals(clampInterpAlpha(0.5), 0.5);
});

Deno.test("clampInterpAlpha: out-of-range clamps to endpoints", () => {
  assertEquals(clampInterpAlpha(-0.1), 0);
  assertEquals(clampInterpAlpha(-100), 0);
  assertEquals(clampInterpAlpha(1.01), 1);
  assertEquals(clampInterpAlpha(50), 1);
});

Deno.test("clampInterpAlpha: non-finite fails loud", () => {
  assertInterpError(() => clampInterpAlpha(NaN), "replay-interp-alpha");
  assertInterpError(() => clampInterpAlpha(Infinity), "replay-interp-alpha");
  assertInterpError(() => clampInterpAlpha(-Infinity), "replay-interp-alpha");
});

// ---------------------------------------------------------------------------
// Endpoints + midpoint blend
// ---------------------------------------------------------------------------

Deno.test("interpolateReplayPose: u=0 / u=1 are bit-exact copies of a / b", () => {
  const a = pose({
    id: "p1",
    x: 1,
    y: 2,
    z: 3,
    yaw: 0.1,
    pitch: -0.2,
    velocityX: 1,
    velocityY: 0,
    velocityZ: -1,
  });
  const b = pose({
    id: "p1",
    x: 5,
    y: 6,
    z: 7,
    yaw: 1.1,
    pitch: 0.4,
    crouch: true,
    onGround: false,
    velocityX: 3,
    velocityY: 1,
    velocityZ: 0,
  });

  const at0 = interpolateReplayPose(a, b, 0);
  const at1 = interpolateReplayPose(a, b, 1);
  assertEquals(at0.snapped, false);
  assertEquals(at1.snapped, false);
  assertPoseExact(at0.pose, a);
  assertPoseExact(at1.pose, b);
  // Fresh objects — not identity with inputs.
  assertNotStrictEquals(at0.pose, a);
  assertNotStrictEquals(at1.pose, b);
});

Deno.test("interpolateReplayPose: u=0.5 midpoint is exact linear / shortest-arc", () => {
  // Displacement must stay under REPLAY_INTERP_SNAP_DISTANCE or the segment snaps.
  const a = pose({ id: "p1", x: 0, y: 0, z: 0, yaw: 0, pitch: -0.4 });
  const b = pose({ id: "p1", x: 1, y: 0.4, z: -0.2, yaw: Math.PI / 2, pitch: 0.4 });
  const mid = interpolateReplayPose(a, b, 0.5);
  assertEquals(mid.snapped, false);
  assertAlmostEquals(mid.pose.x, 0.5);
  assertAlmostEquals(mid.pose.y, 0.2);
  assertAlmostEquals(mid.pose.z, -0.1);
  assertAlmostEquals(mid.pose.yaw, Math.PI / 4);
  assertAlmostEquals(mid.pose.pitch, 0);
  // Discrete mirrors b.
  assertEquals(mid.pose.alive, b.alive);
  assertEquals(mid.pose.crouch, b.crouch);
  assertEquals(mid.pose.onGround, b.onGround);
  assertEquals(mid.pose.spawnedAtTick, b.spawnedAtTick);
  assertEquals(mid.pose.diedAtTick, b.diedAtTick);
});

Deno.test("interpolateReplayPose: yaw shortest-arc both directions + exact-π tie", () => {
  // Cross +π boundary: 3 → -3 is shorter wrapping positive? 3 to -3 delta = -6;
  // wrap: -6 + 2π ≈ 0.283 → short positive arc from 3 toward -3+2π.
  const aPos = pose({ id: "p1", yaw: 3 });
  const bNeg = pose({ id: "p1", yaw: -3 });
  const midCross = interpolateReplayPose(aPos, bNeg, 0.5);
  let d = -3 - 3;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  assertAlmostEquals(midCross.pose.yaw, 3 + d * 0.5);

  // Opposite direction.
  const midCross2 = interpolateReplayPose(bNeg, aPos, 0.5);
  let d2 = 3 - (-3);
  while (d2 > Math.PI) d2 -= Math.PI * 2;
  while (d2 < -Math.PI) d2 += Math.PI * 2;
  assertAlmostEquals(midCross2.pose.yaw, -3 + d2 * 0.5);

  // Exact +π delta: post-wrap signed delta stays +π (documented tie).
  const a0 = pose({ id: "p1", yaw: 0 });
  const bPi = pose({ id: "p1", yaw: Math.PI });
  const midPi = interpolateReplayPose(a0, bPi, 0.5);
  assertAlmostEquals(midPi.pose.yaw, Math.PI / 2);

  // Exact -π delta: post-wrap signed delta stays -π.
  const bNegPi = pose({ id: "p1", yaw: -Math.PI });
  const midNegPi = interpolateReplayPose(a0, bNegPi, 0.5);
  assertAlmostEquals(midNegPi.pose.yaw, -Math.PI / 2);
});

Deno.test("interpolateReplayPose: velocity linear when both sides present", () => {
  const a = pose({
    id: "p1",
    velocityX: 0,
    velocityY: 0,
    velocityZ: 0,
  });
  const b = pose({
    id: "p1",
    velocityX: 10,
    velocityY: -4,
    velocityZ: 2,
  });
  const mid = interpolateReplayPose(a, b, 0.5);
  assertAlmostEquals(mid.pose.velocityX!, 5);
  assertAlmostEquals(mid.pose.velocityY!, -2);
  assertAlmostEquals(mid.pose.velocityZ!, 1);
});

Deno.test("interpolateReplayPose: discrete fields always mirror b mid-blend", () => {
  const a = pose({
    id: "p1",
    crouch: false,
    onGround: true,
    diedAtTick: null,
  });
  const b = pose({
    id: "p1",
    crouch: true,
    onGround: false,
    diedAtTick: null,
    // same alive + same spawnedAtTick + small move → blend, not snap
    x: 0.1,
  });
  const mid = interpolateReplayPose(a, b, 0.5);
  assertEquals(mid.snapped, false);
  assertEquals(mid.pose.crouch, true);
  assertEquals(mid.pose.onGround, false);
  assertEquals(mid.pose.diedAtTick, null);
});

Deno.test("interpolateReplayPose: out-of-range u clamps to a / b", () => {
  const a = pose({ id: "p1", x: 1 });
  const b = pose({ id: "p1", x: 9 });
  assertPoseExact(interpolateReplayPose(a, b, -1).pose, a);
  assertPoseExact(interpolateReplayPose(a, b, 2).pose, b);
});

Deno.test("interpolateReplayPose: non-finite alpha / field fails loud", () => {
  const a = pose({ id: "p1" });
  const b = pose({ id: "p1", x: 1 });
  assertInterpError(() => interpolateReplayPose(a, b, NaN), "replay-interp-alpha");
  assertInterpError(
    () => interpolateReplayPose(pose({ id: "p1", x: NaN }), b, 0.5),
    "replay-interp-field",
  );
  assertInterpError(
    () => interpolateReplayPose(a, pose({ id: "p1", yaw: Infinity }), 0.5),
    "replay-interp-field",
  );
  assertInterpError(
    () => interpolateReplayPose(a, pose({ id: "other", x: 1 }), 0.5),
    "replay-interp-id",
  );
});

// ---------------------------------------------------------------------------
// Snap rules
// ---------------------------------------------------------------------------

Deno.test("snap: distance just under threshold still blends", () => {
  const d = REPLAY_INTERP_SNAP_DISTANCE - 1e-6;
  const a = pose({ id: "p1", x: 0 });
  const b = pose({ id: "p1", x: d });
  const mid = interpolateReplayPose(a, b, 0.5);
  assertEquals(mid.snapped, false);
  assertAlmostEquals(mid.pose.x, d / 2, 1e-9);
});

Deno.test("snap: distance just over threshold → b + snapped", () => {
  const d = REPLAY_INTERP_SNAP_DISTANCE + 1e-6;
  const a = pose({ id: "p1", x: 0 });
  const b = pose({ id: "p1", x: d, y: 1, yaw: 0.5 });
  const mid = interpolateReplayPose(a, b, 0.5);
  assertEquals(mid.snapped, true);
  assertPoseExact(mid.pose, b);
});

Deno.test("snap: alive toggle either direction → b + snapped", () => {
  const alive = pose({ id: "p1", alive: true, x: 0.05 });
  const dead = pose({
    id: "p1",
    alive: false,
    x: 0.05,
    diedAtTick: 42,
  });
  const death = interpolateReplayPose(alive, dead, 0.5);
  assertEquals(death.snapped, true);
  assertPoseExact(death.pose, dead);

  const revive = interpolateReplayPose(dead, alive, 0.5);
  assertEquals(revive.snapped, true);
  assertPoseExact(revive.pose, alive);
});

Deno.test("snap: spawnedAtTick change at identical xyz → b (no false glide)", () => {
  const a = pose({ id: "p1", x: 5, y: 0, z: 5, spawnedAtTick: 10, alive: true });
  const b = pose({ id: "p1", x: 5, y: 0, z: 5, spawnedAtTick: 120, alive: true });
  const mid = interpolateReplayPose(a, b, 0.5);
  assertEquals(mid.snapped, true);
  assertPoseExact(mid.pose, b);
});

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

Deno.test("roster: id-matched blending + join/leave snap", () => {
  const prev = {
    poses: [
      pose({ id: "stay", x: 0 }),
      pose({ id: "leave", x: 3 }),
    ],
    projectiles: [{ id: "old-proj" }],
  };
  const next = {
    poses: [
      pose({ id: "stay", x: 1.0 }),
      pose({ id: "join", x: 7 }),
    ],
    projectiles: [{ id: "new-proj" }, { id: "new-proj-2" }],
  };

  const result = interpolateReplayRoster(prev, next, 0.5);
  assertEquals(result.poses.length, 3);

  const byId = new Map(result.poses.map((r) => [r.pose.id, r]));
  const stay = byId.get("stay")!;
  assertEquals(stay.snapped, false);
  assertAlmostEquals(stay.pose.x, 0.5);

  const leave = byId.get("leave")!;
  assertEquals(leave.snapped, true);
  assertPoseExact(leave.pose, prev.poses[1]!);

  const join = byId.get("join")!;
  assertEquals(join.snapped, true);
  assertPoseExact(join.pose, next.poses[1]!);

  // Projectiles verbatim from next — no lerp.
  assertEquals(result.projectiles, [{ id: "new-proj" }, { id: "new-proj-2" }]);
});

Deno.test("roster: empty vs full sets", () => {
  const full = { poses: [pose({ id: "a", x: 1 }), pose({ id: "b", x: 2 })] };
  const empty = { poses: [] as ReplayInterpPose[] };

  const joinAll = interpolateReplayRoster(empty, full, 0.3);
  assertEquals(joinAll.poses.length, 2);
  for (const r of joinAll.poses) assertEquals(r.snapped, true);

  const leaveAll = interpolateReplayRoster(full, empty, 0.7);
  assertEquals(leaveAll.poses.length, 2);
  for (const r of leaveAll.poses) assertEquals(r.snapped, true);

  const bothEmpty = interpolateReplayRoster(empty, empty, 0.5);
  assertEquals(bothEmpty.poses.length, 0);
  assertEquals(bothEmpty.projectiles.length, 0);
});

// ---------------------------------------------------------------------------
// Purity / isolation
// ---------------------------------------------------------------------------

Deno.test("purity: inputs unmutated; outputs frozen fresh objects", () => {
  const a = pose({ id: "p1", x: 0, yaw: 0.1 });
  const b = pose({ id: "p1", x: 2, yaw: 0.5, crouch: true });
  const aSnap = structuredClone(a);
  const bSnap = structuredClone(b);

  const r1 = interpolateReplayPose(a, b, 0.25);
  const r2 = interpolateReplayPose(a, b, 0.25);
  assertEquals(a, aSnap);
  assertEquals(b, bSnap);
  assertNotStrictEquals(r1.pose, r2.pose);
  assertEquals(Object.isFrozen(r1), true);
  assertEquals(Object.isFrozen(r1.pose), true);

  // Mutating result must throw in strict mode / be a no-op on frozen.
  assertThrows(() => {
    (r1.pose as { x: number }).x = 999;
  });
});

Deno.test("purity: wall-clock shift does not change blend output", () => {
  const a = pose({ id: "p1", x: 0, z: 0 });
  const b = pose({ id: "p1", x: 1, z: 2 });
  // Caller-supplied alpha — no Date/performance read inside the module.
  const u = 12.5 / TICK_MS; // fractional carry shape from 11.3
  const before = interpolateReplayPose(a, b, u);
  // "Shift wall clock" — if the module secretly read Date.now the test couldn't
  // prove it here, but identical inputs must yield identical numeric outputs.
  const after = interpolateReplayPose(a, b, u);
  assertPoseExact(after.pose, before.pose);
  assertEquals(after.snapped, before.snapped);
});

Deno.test("source scan: no wall-clock / sim-owner / render / net / remoteInterp imports", async () => {
  const src = await Deno.readTextFile(
    new URL("./replayInterpolation.ts", import.meta.url),
  );
  // Scan import lines only — comments may name excluded modules for documentation.
  const importLines = src
    .split("\n")
    .filter((line) => /^\s*import\b/.test(line));
  const importBlock = importLines.join("\n");
  const forbiddenImports = [
    "remoteInterp",
    "AuthoritativeCheckpoint",
    "PlayerManager",
    "BotManager",
    "replayClock",
    "replaySimulationRunner",
    "../players/",
    "../../client/",
    "../net/",
  ];
  for (const needle of forbiddenImports) {
    assertEquals(
      importBlock.includes(needle),
      false,
      `replayInterpolation.ts must not import ${JSON.stringify(needle)}`,
    );
  }
  const forbiddenBody = [
    "Date.now",
    "performance.now",
    "requestAnimationFrame",
    "Deno.read",
    "Deno.write",
    "fetch(",
  ];
  for (const needle of forbiddenBody) {
    assertEquals(
      src.includes(needle),
      false,
      `replayInterpolation.ts must not contain ${JSON.stringify(needle)}`,
    );
  }
  // Module must stay import-free of Deno/Node deps (stdlib-only + own types).
  assertEquals(importLines.length, 0, "replayInterpolation.ts must have zero imports");
});
