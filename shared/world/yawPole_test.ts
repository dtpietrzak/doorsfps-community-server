import {
  assertAlmostEquals,
  assertEquals,
  assertExists,
} from "jsr:@std/assert@1";
import { MOVE_STAND_EYE } from "../sim/moveStep.ts";
import { computeDoorYawDots } from "./wallCorners.ts";
import {
  buildYawPoleNoise,
  clearStickyYawPole,
  clearYawPolePingPong,
  isYawPoleArrived,
  isYawPoleLosVisible,
  isYawPoleStickyLocked,
  movementFovPoleScore,
  computeYawPoleCornerRound,
  YAW_POLE_CORNER_MAX_STRAFE,
  HUNT_DOOR_DIST_MAX,
  HUNT_YAW_POLE_NOISE_MAX,
  HUNT_YAW_POLE_NOISE_MIN,
  HUNT_YAW_POLE_WEIGHTS,
  centerEnemyDoorPole,
  enemyDoorMidpoint,
  pickNextYawPoleTarget,
  pickYawPoleTarget,
  playerFovPoleScore,
  recordYawPoleClear,
  recordYawPoleCommit,
  yawPoleSignedDelta,
  yawPoleToward,
  polesForTeam,
  scoreYawWallPoles,
  splitYawPoles,
  stepStickyYawPole,
  wishMoveYaw,
  yawPoleBellyY,
  yawPoleDoorDistScores,
  yawPoleKey,
  yawPoleKeyIgnored,
  yawPoleLosQuery,
  yawPoleMapCenterScore,
  YAW_POLE_PINGPONG_CLEARS_REQUIRED,
  YAW_BELLY_FROM_FEET_STAND,
  YAW_MOVEMENT_FOV_HALF_ANGLE,
  PATH_OWN_DOOR_POLE_EXCLUDE,
  YAW_POLE_DOOR_DIST_MAX,
  YAW_POLE_DOOR_FOV_SCORE,
  YAW_POLE_LOS_RANGE_INSET,
  YAW_POLE_MAP_CENTER_MAX,
  YAW_POLE_MOVEMENT_FOV_CENTER,
  YAW_POLE_MOVEMENT_FOV_EDGE,
  YAW_POLE_NOISE_MAX,
  YAW_POLE_NOISE_MIN,
  YAW_POLE_PLAYER_FOV_CENTER,
  YAW_POLE_PLAYER_FOV_EDGE,
  YAW_POLE_PROXIMITY_CLOSEST,
  YAW_POLE_PROXIMITY_SECOND,
  YAW_POLE_SKIP_RADIUS,
  YAW_PLAYER_FOV_HALF_ANGLE,
  type StickyYawPoleState,
  type YawPoleMap,
} from "./yawPole.ts";

function openMap(): YawPoleMap {
  return {
    bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 },
    teamA: {
      edge: "south",
      doorHalfWidth: 2.5,
    },
    teamB: {
      edge: "north",
      doorHalfWidth: 2.5,
    },
    wallCorners: [],
  };
}

Deno.test("polesForTeam: enemy door poles only for team A → B door", () => {
  const map = openMap();
  const all = computeDoorYawDots(map.bounds, map.teamA!, map.teamB!);
  const { enemyDoorPoles, wallPoles } = polesForTeam(map, "A");
  assertEquals(enemyDoorPoles.length, 3);
  assertEquals(enemyDoorPoles[0]!.x, all[3]!.x);
  assertEquals(enemyDoorPoles[0]!.z, all[3]!.z);
  assertEquals(wallPoles.length, 0);
});

Deno.test("splitYawPoles: strips baked door keys from wall list", () => {
  const map = openMap();
  const all = computeDoorYawDots(map.bounds, map.teamA!, map.teamB!);
  map.wallCorners = [
    { x: 1, z: 2 },
    { x: all[0]!.x, z: all[0]!.z },
  ];
  const { wallPoles, doorPolesA, doorPolesB } = splitYawPoles(map);
  assertEquals(doorPolesA.length, 3);
  assertEquals(doorPolesB.length, 3);
  assertEquals(wallPoles.length, 1);
  assertEquals(wallPoles[0]!.x, 1);
  assertEquals(wallPoles[0]!.z, 2);
});

Deno.test("centerEnemyDoorPole: picks the middle of three door dots", () => {
  const map = openMap();
  const { enemyDoorPoles } = polesForTeam(map, "A");
  const mid = enemyDoorMidpoint(map, "A")!;
  const center = centerEnemyDoorPole(enemyDoorPoles, mid);
  assertExists(center);
  assertAlmostEquals(center.x, mid.x, 1e-6);
  assertAlmostEquals(center.z, mid.z, 1e-6);
});

Deno.test("pickYawPoleTarget: hard priority is the center door pole, not nearest side", () => {
  const map = openMap();
  const { enemyDoorPoles, wallPoles } = polesForTeam(map, "A");
  const center = enemyDoorPoles[1]!;
  // Stand closer to the left door pole than the mouth.
  const pick = pickYawPoleTarget({
    x: center.x - 2,
    z: center.z - 4,
    yaw: Math.PI,
    team: "A",
    map,
    wallPoles,
    enemyDoorPoles,
  });
  assertExists(pick);
  assertEquals(pick.x, center.x);
  assertEquals(pick.z, center.z);
});

Deno.test("pickYawPoleTarget: walkableTo false skips door hard priority", () => {
  const map = openMap();
  const { enemyDoorPoles } = polesForTeam(map, "A");
  const wall = { x: 0, z: 5 };
  const pick = pickYawPoleTarget({
    x: 0,
    z: 0,
    yaw: Math.PI,
    team: "A",
    map,
    wallPoles: [wall],
    enemyDoorPoles,
    walkableTo: () => false,
  });
  assertExists(pick);
  assertEquals(pick.x, wall.x);
  assertEquals(pick.z, wall.z);
});

Deno.test("pickYawPoleTarget: prefers nearest enemy door pole on open map", () => {
  const map = openMap();
  const { enemyDoorPoles, wallPoles } = polesForTeam(map, "A");
  const pick = pickYawPoleTarget({
    x: 0,
    z: 0,
    yaw: 0,
    team: "A",
    map,
    wallPoles,
    enemyDoorPoles,
  });
  assertExists(pick);
  const mid = enemyDoorPoles[1]!;
  assertEquals(pick.x, mid.x);
  assertEquals(pick.z, mid.z);
});

Deno.test("pickYawPoleTarget: skip radius ignores pole underfoot", () => {
  const map = openMap();
  const pick = pickYawPoleTarget({
    x: 0,
    z: 0,
    yaw: Math.PI, // facing +Z (north)
    team: "A",
    map,
    wallPoles: [
      { x: 0, z: 0.1 }, // underfoot (+Z)
      { x: 0, z: 5 }, // ahead north
    ],
    enemyDoorPoles: [],
  });
  assertExists(pick);
  assertEquals(pick.z, 5);
  assertEquals(Math.hypot(pick.x, pick.z) > YAW_POLE_SKIP_RADIUS, true);
});

Deno.test("pickYawPoleTarget: excludeNearOwnDoorDist skips lip poles (score-home)", () => {
  const map = openMap();
  // Team A own door at z = -20. After home, nearest wall tip is often ~2u in.
  // Without exclude, proximity + door FOV sticky-locks that tip forever.
  const pick = pickYawPoleTarget({
    x: 0,
    z: -19.5,
    yaw: Math.PI, // face north (into map / enemy door)
    team: "A",
    map,
    wallPoles: [
      { x: 0, z: -18 }, // 2u from own door mid — lip trap
      { x: 0, z: -10 }, // further into map — leave-home progress
    ],
    enemyDoorPoles: [], // LOS to enemy door blocked
    hardPrioritizeDoorPoles: false,
    excludeNearOwnDoorDist: PATH_OWN_DOOR_POLE_EXCLUDE,
  });
  assertExists(pick);
  assertEquals(pick.z, -10);
  assertEquals(
    Math.hypot(pick.x - 0, pick.z - (-20)) >= PATH_OWN_DOOR_POLE_EXCLUDE,
    true,
  );
});

Deno.test("pickYawPoleTarget: LOS callback rejects occluded door pole", () => {
  const map = openMap();
  const { enemyDoorPoles } = polesForTeam(map, "A");
  const blocked = new Set(
    enemyDoorPoles.map((p) => `${p.x.toFixed(3)},${p.z.toFixed(3)}`),
  );
  const wallPoles = [{ x: 0, z: 5 }]; // north, in door FOV for team A
  const pick = pickYawPoleTarget({
    x: 0,
    z: 0,
    yaw: Math.PI,
    team: "A",
    map,
    wallPoles,
    enemyDoorPoles,
    blocksLos: (_ox, _oz, tx, tz) =>
      blocked.has(`${tx.toFixed(3)},${tz.toFixed(3)}`),
  });
  assertExists(pick);
  assertEquals(pick.x, 0);
  assertEquals(pick.z, 5);
});

Deno.test("scoreYawWallPoles: FOV filter runs before LOS", () => {
  const map = openMap();
  const behind = { x: 0, z: -8 }; // south — outside door + north facing
  const ahead = { x: 0, z: 8 };
  const los: Array<{ tx: number; tz: number }> = [];
  const scored = scoreYawWallPoles({
    x: 0,
    z: 0,
    yaw: Math.PI, // facing north
    team: "A",
    map,
    wallPoles: [behind, ahead],
    enemyDoorPoles: [],
    blocksLos: (_ox, _oz, tx, tz) => {
      los.push({ tx, tz });
      return false;
    },
  });
  assertEquals(scored.length, 1);
  assertEquals(scored[0]!.pole.z, 8);
  assertEquals(los.length, 1);
  assertEquals(los[0]!.tz, 8);
});

Deno.test("pickYawPoleTarget: FOV filter drops poles outside all wedges", () => {
  const map = openMap();
  // Team A faces north door (doorYaw ~π). Facing south (yaw 0) → south pole
  // is in player FOV; a far-east pole with facing north is outside both if
  // we face south and pole is east-only.
  // Pole behind and off to the side: south of player while door FOV is north.
  const behind = { x: 0, z: -8 }; // south — door FOV is north, not in door
  // Facing north (π): behind is opposite facing → filtered out.
  // No moveYaw → movement FOV also closed.
  const pick = pickYawPoleTarget({
    x: 0,
    z: 0,
    yaw: Math.PI,
    team: "A",
    map,
    wallPoles: [behind],
    enemyDoorPoles: [],
  });
  assertEquals(pick, null);
});

Deno.test("pickYawPoleTarget: movement FOV alone admits a pole", () => {
  const map = openMap();
  // South pole: outside door FOV (north) and outside facing (north).
  // Move yaw south (0) → movement FOV admits it.
  const behind = { x: 0, z: -8 };
  const pick = pickYawPoleTarget({
    x: 0,
    z: 0,
    yaw: Math.PI, // facing north
    moveYaw: 0, // moving south
    team: "A",
    map,
    wallPoles: [behind],
    enemyDoorPoles: [],
  });
  assertExists(pick);
  assertEquals(pick.z, -8);
});

Deno.test("pickNextYawPoleTarget: null current → null", () => {
  const map = openMap();
  const { enemyDoorPoles, wallPoles } = polesForTeam(map, "A");
  assertEquals(
    pickNextYawPoleTarget(
      {
        x: 0,
        z: 0,
        yaw: 0,
        team: "A",
        map,
        wallPoles,
        enemyDoorPoles,
      },
      null,
    ),
    null,
  );
});

Deno.test("pickNextYawPoleTarget: pretends to stand at current, skips underfoot", () => {
  const map = openMap();
  // Two wall poles south of origin; no door poles so wall scoring wins.
  // Facing south (yaw 0) admits both via player FOV.
  const near = { x: 0, z: -8 };
  const far = { x: 0, z: -16 };
  const input = {
    x: 0,
    z: 0,
    yaw: 0,
    team: "A" as const,
    map,
    wallPoles: [near, far],
    enemyDoorPoles: [] as Array<{ x: number; z: number }>,
  };
  const current = pickYawPoleTarget(input);
  assertExists(current);
  assertEquals(yawPoleKey(current.x, current.z), yawPoleKey(near.x, near.z));

  const next = pickNextYawPoleTarget(input, current);
  assertExists(next);
  assertEquals(yawPoleKey(next.x, next.z), yawPoleKey(far.x, far.z));
});

Deno.test("pickNextYawPoleTarget: sole pole has no further next", () => {
  const map = openMap();
  const only = { x: 0, z: -8 };
  const next = pickNextYawPoleTarget(
    {
      x: 0,
      z: 0,
      yaw: 0,
      team: "A",
      map,
      wallPoles: [only],
      enemyDoorPoles: [],
    },
    only,
  );
  assertEquals(next, null);
});

Deno.test("computeYawPoleCornerRound: null without next or tiny turn", () => {
  const current = { x: 0, z: -8 };
  assertEquals(
    computeYawPoleCornerRound({
      x: 0,
      z: 0,
      current,
      next: null,
    }),
    null,
  );
  // Nearly collinear next — below min turn.
  assertEquals(
    computeYawPoleCornerRound({
      x: 0,
      z: 0,
      current,
      next: { x: 0.05, z: -16 },
    }),
    null,
  );
});

Deno.test("computeYawPoleCornerRound: next right → strafe left; look pre-rotates", () => {
  // Approach south (−z). Next is east of current → turn right → strafe left.
  const current = { x: 0, z: -8 };
  const next = { x: 8, z: -8 };
  const far = computeYawPoleCornerRound({
    x: 0,
    z: 0,
    current,
    next,
    startDist: 7,
    endDist: 1.5,
  });
  // At dist 8 ≥ start 7 → approachT ~0, still may return with zero effect.
  assertExists(far);
  assertEquals(far.approachT, 0);
  assertEquals(far.strafeAmount, 0);

  const near = computeYawPoleCornerRound({
    x: 0,
    z: -6.5, // dist 1.5 to current → full approach
    current,
    next,
    startDist: 7,
    endDist: 1.5,
  });
  assertExists(near);
  assertAlmostEquals(near.approachT, 1, 1e-6);
  // Next is to the right of approach (south) → strafe left (−1).
  assertEquals(near.strafeSign, -1);
  assertEquals(near.strafeAmount > 0.5, true);

  // Full look blend: face exit heading (current → next = east ⇒ yaw −π/2).
  const approach = yawPoleToward(0, -6.5, current.x, current.z);
  const exit = yawPoleToward(current.x, current.z, next.x, next.z);
  assertAlmostEquals(near.lookYaw, exit, 1e-6);
  // Strafe left of south approach = west = +π/2 from yaw 0.
  const moveVsApproach = yawPoleSignedDelta(approach, near.moveYaw);
  assertEquals(moveVsApproach > 0, true);

  // Far look still pure approach.
  assertAlmostEquals(far.lookYaw, yawPoleToward(0, 0, current.x, current.z), 1e-6);
});

Deno.test("computeYawPoleCornerRound: next left → strafe right", () => {
  const current = { x: 0, z: -8 };
  const next = { x: -8, z: -8 }; // west of current
  const near = computeYawPoleCornerRound({
    x: 0,
    z: -6.5,
    current,
    next,
    startDist: 7,
    endDist: 1.5,
  });
  assertExists(near);
  assertEquals(near.strafeSign, 1); // opposite of left next
  assertEquals(near.strafeAmount > 0.5, true);
});

Deno.test("computeYawPoleCornerRound: over-round maxStrafe exceeds full normal", () => {
  const current = { x: 0, z: -8 };
  const next = { x: 8, z: -8 };
  const full = computeYawPoleCornerRound({
    x: 0,
    z: -6.5,
    current,
    next,
    startDist: 7,
    endDist: 1.5,
    maxStrafe: YAW_POLE_CORNER_MAX_STRAFE,
  });
  const over = computeYawPoleCornerRound({
    x: 0,
    z: -6.5,
    current,
    next,
    startDist: 7,
    endDist: 1.5,
    maxStrafe: YAW_POLE_CORNER_MAX_STRAFE * 1.5,
  });
  assertExists(full);
  assertExists(over);
  assertEquals(over.strafeAmount > full.strafeAmount, true);
  assertEquals(over.strafeAmount > YAW_POLE_CORNER_MAX_STRAFE, true);
});

Deno.test("playerFovPoleScore: center / edge / outside", () => {
  const facing = 0;
  assertAlmostEquals(
    playerFovPoleScore(facing, facing),
    YAW_POLE_PLAYER_FOV_CENTER,
    1e-9,
  );
  assertAlmostEquals(
    playerFovPoleScore(facing, facing + YAW_PLAYER_FOV_HALF_ANGLE),
    YAW_POLE_PLAYER_FOV_EDGE,
    1e-6,
  );
  assertEquals(
    playerFovPoleScore(facing, facing + YAW_PLAYER_FOV_HALF_ANGLE + 0.05),
    0,
  );
  const mid = playerFovPoleScore(
    facing,
    facing + YAW_PLAYER_FOV_HALF_ANGLE * 0.5,
  );
  assertAlmostEquals(
    mid,
    (YAW_POLE_PLAYER_FOV_CENTER + YAW_POLE_PLAYER_FOV_EDGE) / 2,
    1e-6,
  );
});

Deno.test("movementFovPoleScore: center / edge / outside curve", () => {
  const move = Math.PI;
  assertAlmostEquals(
    movementFovPoleScore(move, move),
    YAW_POLE_MOVEMENT_FOV_CENTER,
    1e-9,
  );
  assertAlmostEquals(
    movementFovPoleScore(move, move + YAW_MOVEMENT_FOV_HALF_ANGLE),
    YAW_POLE_MOVEMENT_FOV_EDGE,
    1e-6,
  );
  assertEquals(
    movementFovPoleScore(move, move + YAW_MOVEMENT_FOV_HALF_ANGLE + 0.05),
    0,
  );
});

Deno.test("wishMoveYaw: forward / strafe / idle", () => {
  const look = 0; // facing −Z
  assertAlmostEquals(wishMoveYaw(look, { forward: true })!, 0, 1e-9);
  // Strafe right: right = (cos 0, −sin 0) = (1, 0) → yaw = atan2(-1, 0) = −π/2
  assertAlmostEquals(wishMoveYaw(look, { right: true })!, -Math.PI / 2, 1e-9);
  assertEquals(wishMoveYaw(look, {}), null);
});

Deno.test("scoreYawWallPoles: movement FOV awards same as player FOV", () => {
  const map = openMap();
  // East pole: outside door FOV (north) and outside facing north.
  // moveYaw east admits + scores like player FOV center.
  const pole = { x: 8, z: 0 };
  // Facing east: yaw = atan2(-1, 0) = −π/2; forward = (−sin(−π/2), −cos(−π/2)) = (1, 0)
  const eastYaw = -Math.PI / 2;
  const scored = scoreYawWallPoles({
    x: 0,
    z: 0,
    yaw: Math.PI, // facing north — player FOV misses east
    moveYaw: eastYaw,
    team: "A",
    map,
    wallPoles: [pole],
    enemyDoorPoles: [],
  });
  assertEquals(scored.length, 1);
  assertAlmostEquals(
    scored[0]!.score.movementFov,
    YAW_POLE_MOVEMENT_FOV_CENTER,
    1e-6,
  );
  assertEquals(scored[0]!.score.playerFov, 0);
  assertEquals(scored[0]!.score.doorFov, 0);
});

Deno.test("scoreYawWallPoles: door FOV awards +10", () => {
  const map = openMap();
  // North pole for team A → in door FOV toward enemy north door.
  const pole = { x: 0, z: 8 };
  const scored = scoreYawWallPoles({
    x: 0,
    z: 0,
    yaw: Math.PI, // facing north
    team: "A",
    map,
    wallPoles: [pole],
    enemyDoorPoles: [],
  });
  assertEquals(scored.length, 1);
  assertEquals(scored[0]!.score.doorFov, YAW_POLE_DOOR_FOV_SCORE);
});

Deno.test("scoreYawWallPoles: proximity ranks closest +10, next +5", () => {
  const map = openMap();
  const near = { x: 0, z: 4 };
  const far = { x: 0, z: 10 };
  const scored = scoreYawWallPoles({
    x: 0,
    z: 0,
    yaw: Math.PI,
    team: "A",
    map,
    wallPoles: [far, near],
    enemyDoorPoles: [],
  });
  assertEquals(scored.length, 2);
  const byKey = new Map(
    scored.map((s) => [yawPoleKey(s.pole.x, s.pole.z), s.score]),
  );
  assertEquals(
    byKey.get(yawPoleKey(near.x, near.z))!.proximity,
    YAW_POLE_PROXIMITY_CLOSEST,
  );
  assertEquals(
    byKey.get(yawPoleKey(far.x, far.z))!.proximity,
    YAW_POLE_PROXIMITY_SECOND,
  );
});

Deno.test("scoreYawWallPoles: center-of-FOV outranks edge when other equal", () => {
  const map = openMap();
  // Both at same distance, same door FOV (both north-ish), different lateral angle.
  // Facing north (π). Center pole on +Z; edge pole at half-angle off.
  const dist = 8;
  const center = { x: 0, z: dist };
  const half = YAW_PLAYER_FOV_HALF_ANGLE;
  // Bearing = facing + half ≈ edge. Forward = (−sin yaw, −cos yaw).
  // yaw = π → forward (0, 1). Edge left: yaw = π - half →
  // dirX = -sin(π-half)= -sin(half)? wait sin(π-h)=sin(h), so -sin = -sin(h)
  // dirZ = -cos(π-h) = -(-cos(h)) = cos(h)
  const edgeYaw = Math.PI - half;
  const edge = {
    x: -Math.sin(edgeYaw) * dist,
    z: -Math.cos(edgeYaw) * dist,
  };
  const scored = scoreYawWallPoles({
    x: 0,
    z: 0,
    yaw: Math.PI,
    team: "A",
    map,
    wallPoles: [edge, center],
    enemyDoorPoles: [],
    // Zero map terms that could differ: noise none; doorDist may differ slightly
  });
  assertEquals(scored.length, 2);
  // Center should have higher playerFov and win overall if noise/map similar.
  const centerScore = scored.find(
    (s) => Math.abs(s.pole.x - center.x) < 1e-6,
  )!.score;
  const edgeScore = scored.find(
    (s) => Math.abs(s.pole.x - edge.x) < 1e-3,
  )!.score;
  assertAlmostEquals(centerScore.playerFov, YAW_POLE_PLAYER_FOV_CENTER, 1e-6);
  assertAlmostEquals(edgeScore.playerFov, YAW_POLE_PLAYER_FOV_EDGE, 0.05);
  assertEquals(centerScore.playerFov > edgeScore.playerFov, true);
});

Deno.test("yawPoleDoorDistScores: closest 10, farthest 0", () => {
  const map = openMap();
  // Enemy door for A is north (z=+20 mid).
  const nearDoor = { x: 0, z: 15 };
  const farDoor = { x: 0, z: -15 };
  const scores = yawPoleDoorDistScores(map, "A", [nearDoor, farDoor]);
  assertAlmostEquals(
    scores.get(yawPoleKey(nearDoor.x, nearDoor.z))!,
    YAW_POLE_DOOR_DIST_MAX,
    1e-9,
  );
  assertAlmostEquals(
    scores.get(yawPoleKey(farDoor.x, farDoor.z))!,
    0,
    1e-9,
  );
});

Deno.test("yawPoleMapCenterScore: center higher than edge", () => {
  const map = openMap();
  // N/S doors → lateral X
  const center = { x: 0, z: 5 };
  const edge = { x: 20, z: 5 };
  const c = yawPoleMapCenterScore(map, "A", center);
  const e = yawPoleMapCenterScore(map, "A", edge);
  assertAlmostEquals(c, YAW_POLE_MAP_CENTER_MAX, 1e-9);
  assertAlmostEquals(e, 0, 1e-9);
  assertEquals(c > e, true);
});

Deno.test("scoreYawWallPoles: humanHeat residual can change winner", () => {
  const map = openMap();
  // Two poles both in player FOV facing -Z (yaw 0); same door/map terms.
  const wallPoles = [
    { x: 0, z: -8 },
    { x: 2, z: -8 },
  ];
  const base = {
    x: 0,
    z: 0,
    yaw: 0,
    team: "A" as const,
    map,
    wallPoles,
    enemyDoorPoles: [] as { x: number; z: number }[],
    weights: {
      doorFov: 0,
      doorDistMax: 0,
      mapCenterMax: 0,
      proximityClosest: 0,
      proximitySecond: 0,
      humanHeatMax: 8,
    },
  };
  const plain = scoreYawWallPoles(base);
  assertEquals(plain.length >= 1, true);

  const heated = scoreYawWallPoles({
    ...base,
    humanHeatByPole: {
      [yawPoleKey(2, -8)]: 1,
      [yawPoleKey(0, -8)]: 0,
    },
  });
  const best = heated[0]!.pole;
  assertEquals(best.x, 2);
  assertEquals(heated[0]!.score.humanHeat, 8);
});

Deno.test("scoreYawWallPoles: noise can change winner", () => {
  const map = openMap();
  // Two poles at same range, both on centerline north — nearly equal base.
  const a = { x: -0.5, z: 8 };
  const b = { x: 0.5, z: 8 };
  const keyA = yawPoleKey(a.x, a.z);
  const keyB = yawPoleKey(b.x, b.z);
  const without = pickYawPoleTarget({
    x: 0,
    z: 0,
    yaw: Math.PI,
    team: "A",
    map,
    wallPoles: [a, b],
    enemyDoorPoles: [],
  });
  assertExists(without);
  // Heavy noise on the other pole flips the pick.
  const otherKey = yawPoleKey(without.x, without.z) === keyA ? keyB : keyA;
  const winnerKey = yawPoleKey(without.x, without.z) === keyA ? keyA : keyB;
  const flipped = pickYawPoleTarget({
    x: 0,
    z: 0,
    yaw: Math.PI,
    team: "A",
    map,
    wallPoles: [a, b],
    enemyDoorPoles: [],
    poleNoise: {
      [winnerKey]: -5,
      [otherKey]: 5,
    },
  });
  assertExists(flipped);
  assertEquals(yawPoleKey(flipped.x, flipped.z), otherKey);
});

Deno.test("buildYawPoleNoise: keys all poles in default noise range", () => {
  const poles = [
    { x: 1, z: 2 },
    { x: 3, z: 4 },
  ];
  let i = 0;
  const seq = [0, 1];
  const noise = buildYawPoleNoise(poles, () => seq[i++] ?? 0.5);
  assertEquals(Object.keys(noise).length, 2);
  assertEquals(noise[yawPoleKey(1, 2)], YAW_POLE_NOISE_MIN);
  assertEquals(noise[yawPoleKey(3, 4)], YAW_POLE_NOISE_MAX);
});

Deno.test("buildYawPoleNoise: hunt range override ±15", () => {
  const poles = [{ x: 1, z: 2 }];
  const noise = buildYawPoleNoise(poles, () => 0, {
    min: HUNT_YAW_POLE_NOISE_MIN,
    max: HUNT_YAW_POLE_NOISE_MAX,
  });
  assertEquals(noise[yawPoleKey(1, 2)], HUNT_YAW_POLE_NOISE_MIN);
  const hi = buildYawPoleNoise(poles, () => 1, {
    min: HUNT_YAW_POLE_NOISE_MIN,
    max: HUNT_YAW_POLE_NOISE_MAX,
  });
  assertEquals(hi[yawPoleKey(1, 2)], HUNT_YAW_POLE_NOISE_MAX);
});

Deno.test("pickYawPoleTarget: hardPrioritizeDoorPoles false skips door hard priority", () => {
  const map = openMap();
  const { enemyDoorPoles } = polesForTeam(map, "A");
  // Wall pole in facing FOV south of origin; door poles are north.
  const wall = { x: 0, z: -8 };
  const withHard = pickYawPoleTarget({
    x: 0,
    z: 0,
    yaw: 0,
    team: "A",
    map,
    wallPoles: [wall],
    enemyDoorPoles,
    hardPrioritizeDoorPoles: true,
  });
  assertExists(withHard);
  // Hard priority picks a door pole.
  assertEquals(
    enemyDoorPoles.some(
      (p) =>
        yawPoleKey(p.x, p.z) === yawPoleKey(withHard.x, withHard.z),
    ),
    true,
  );

  const noHard = pickYawPoleTarget({
    x: 0,
    z: 0,
    yaw: 0,
    team: "A",
    map,
    wallPoles: [wall],
    enemyDoorPoles,
    hardPrioritizeDoorPoles: false,
    goalPoint: { x: 0, z: -15 },
    weights: HUNT_YAW_POLE_WEIGHTS,
  });
  assertExists(noHard);
  assertEquals(yawPoleKey(noHard.x, noHard.z), yawPoleKey(wall.x, wall.z));
});

Deno.test("scoreYawWallPoles: goalPoint relocates door FOV band", () => {
  const map = openMap();
  // Agent south; pole south should get doorFov, pole north should not.
  const south = { x: 0, z: -10 };
  const north = { x: 0, z: 10 };
  const scored = scoreYawWallPoles({
    x: 0,
    z: 0,
    yaw: 0,
    team: "A",
    map,
    wallPoles: [south, north],
    enemyDoorPoles: [],
    goalPoint: { x: 0, z: -20 },
    hardPrioritizeDoorPoles: false,
    weights: { doorFovHalfAngle: Math.PI / 2, doorFov: 20 },
  });
  const byKey = new Map(
    scored.map((s) => [yawPoleKey(s.pole.x, s.pole.z), s.score]),
  );
  assertEquals(byKey.get(yawPoleKey(south.x, south.z))!.doorFov, 20);
  // North pole may still appear via player FOV if facing allows — facing yaw 0 is −z (south).
  const northScore = byKey.get(yawPoleKey(north.x, north.z));
  if (northScore) {
    assertEquals(northScore.doorFov, 0);
  }
});

Deno.test("yawPoleDoorDistScores: custom mid and maxScore", () => {
  const map = openMap();
  const nearOwn = { x: 0, z: -15 }; // near south (own for A)
  const farOwn = { x: 0, z: 15 };
  const ownMid = { x: 0, z: -20 };
  const scores = yawPoleDoorDistScores(map, "A", [nearOwn, farOwn], {
    mid: ownMid,
    maxScore: HUNT_DOOR_DIST_MAX,
  });
  assertAlmostEquals(
    scores.get(yawPoleKey(nearOwn.x, nearOwn.z))!,
    HUNT_DOOR_DIST_MAX,
    1e-9,
  );
  assertAlmostEquals(
    scores.get(yawPoleKey(farOwn.x, farOwn.z))!,
    0,
    1e-9,
  );
});

Deno.test("yawPoleBellyY: standing from feet vs eye", () => {
  assertEquals(yawPoleBellyY(), YAW_BELLY_FROM_FEET_STAND);
  // Standing eye at visor height → navel 1.0 from feet
  assertEquals(yawPoleBellyY({ eyeY: MOVE_STAND_EYE }), YAW_BELLY_FROM_FEET_STAND);
});

Deno.test("yawPoleLosQuery: insets range and rejects tiny segments", () => {
  const q = yawPoleLosQuery(0, 0, 0, 10);
  assertExists(q);
  assertAlmostEquals(q.range, 10 - YAW_POLE_LOS_RANGE_INSET, 1e-4);
  assertEquals(yawPoleLosQuery(0, 0, 0, 0.05), null);
});

Deno.test("stepStickyYawPole: locks first pick and ignores thrashing newPick", () => {
  const a = { x: 5, z: 0 };
  const b = { x: -5, z: 0 };
  const first = stepStickyYawPole({
    x: 0,
    z: 0,
    sticky: null,
    newPick: a,
  });
  assertEquals(first.target, a);
  assertEquals(first.sticky, a);
  assertEquals(first.unlocked, false);

  const held = stepStickyYawPole({
    x: 0,
    z: 0,
    sticky: first.sticky,
    newPick: b, // would win pure pick this tick — sticky wins
  });
  assertEquals(held.target?.x, a.x);
  assertEquals(held.target?.z, a.z);
  assertEquals(held.sticky?.x, a.x);
  assertEquals(held.unlocked, false);
  assertEquals(isYawPoleStickyLocked(0, 0, held.sticky), true);
});

Deno.test("stepStickyYawPole: arriving unlocks and adopts newPick", () => {
  const locked = { x: 5, z: 0 };
  const next = { x: 10, z: 2 };
  // Inside skip radius of locked pole.
  assertEquals(isYawPoleArrived(5, 0.1, locked), true);
  const stepped = stepStickyYawPole({
    x: 5,
    z: 0.1,
    sticky: locked,
    newPick: next,
  });
  assertEquals(stepped.unlocked, true);
  assertEquals(stepped.target?.x, next.x);
  assertEquals(stepped.target?.z, next.z);
  assertEquals(stepped.sticky?.x, next.x);
});

Deno.test("stepStickyYawPole: clear force-unlocks without needing arrival", () => {
  const locked = { x: 5, z: 0 };
  const next = { x: 1, z: 1 };
  const cleared = stepStickyYawPole({
    x: 0,
    z: 0,
    sticky: locked,
    newPick: next,
    clear: true,
  });
  assertEquals(cleared.unlocked, true);
  assertEquals(cleared.target?.x, next.x);
  assertEquals(cleared.sticky?.x, next.x);
});

Deno.test("stepStickyYawPole: lost visibility unlocks and adopts newPick", () => {
  const locked = { x: 5, z: 0 };
  const next = { x: -5, z: 0 };
  assertEquals(isYawPoleStickyLocked(0, 0, locked, false, false), false);
  const stepped = stepStickyYawPole({
    x: 0,
    z: 0,
    sticky: locked,
    newPick: next,
    stillVisible: false,
  });
  assertEquals(stepped.unlocked, true);
  assertEquals(stepped.target?.x, next.x);
  assertEquals(stepped.target?.z, next.z);
  assertEquals(stepped.sticky?.x, next.x);
});

Deno.test("stepStickyYawPole: stillVisible true keeps lock against thrashing newPick", () => {
  const locked = { x: 5, z: 0 };
  const thrash = { x: -5, z: 0 };
  const held = stepStickyYawPole({
    x: 0,
    z: 0,
    sticky: locked,
    newPick: thrash,
    stillVisible: true,
  });
  assertEquals(held.unlocked, false);
  assertEquals(held.sticky?.x, locked.x);
  assertEquals(held.target?.z, locked.z);
});

Deno.test("isYawPoleLosVisible: clear without blocksLos; blocked when ray hits", () => {
  const pole = { x: 10, z: 0 };
  assertEquals(isYawPoleLosVisible(0, 0, pole), true);
  assertEquals(
    isYawPoleLosVisible(0, 0, pole, () => true),
    false,
  );
  assertEquals(
    isYawPoleLosVisible(0, 0, pole, () => false),
    true,
  );
  // Coincident origin counts as visible (same as pure pick).
  assertEquals(
    isYawPoleLosVisible(10, 0, pole, () => true),
    true,
  );
});

Deno.test("stepStickyYawPole: unlock with null newPick leaves sticky empty", () => {
  const locked = { x: 0.2, z: 0 }; // underfoot
  const stepped = stepStickyYawPole({
    x: 0,
    z: 0,
    sticky: locked,
    newPick: null,
  });
  assertEquals(stepped.unlocked, true);
  assertEquals(stepped.target, null);
  assertEquals(stepped.sticky, null);
});

Deno.test("clearStickyYawPole: drops bag field", () => {
  const bag: StickyYawPoleState = { stickyYawPole: { x: 1, z: 2 } };
  clearStickyYawPole(bag);
  assertEquals(bag.stickyYawPole, undefined);
});

Deno.test("recordYawPoleCommit: A→B→A bans B", () => {
  const bag: StickyYawPoleState = {};
  const a = yawPoleKey(1, 0);
  const b = yawPoleKey(2, 0);
  recordYawPoleCommit(bag, a);
  recordYawPoleCommit(bag, b);
  recordYawPoleCommit(bag, a);
  assertEquals(bag.yawPoleIgnore?.[b], YAW_POLE_PINGPONG_CLEARS_REQUIRED);
  assertEquals(yawPoleKeyIgnored(bag.yawPoleIgnore, b), true);
  assertEquals(yawPoleKeyIgnored(bag.yawPoleIgnore, a), false);
});

Deno.test("recordYawPoleCommit: consecutive same key does not ban", () => {
  const bag: StickyYawPoleState = {};
  const a = yawPoleKey(1, 0);
  recordYawPoleCommit(bag, a);
  recordYawPoleCommit(bag, a);
  recordYawPoleCommit(bag, a);
  assertEquals(bag.yawPoleIgnore, undefined);
  assertEquals(bag.yawPoleCommitKeys, [a]);
});

Deno.test("recordYawPoleClear: two other poles unban B; arriving on B does not", () => {
  const bag: StickyYawPoleState = {};
  const a = yawPoleKey(1, 0);
  const b = yawPoleKey(2, 0);
  const c = yawPoleKey(3, 0);
  const d = yawPoleKey(4, 0);
  recordYawPoleCommit(bag, a);
  recordYawPoleCommit(bag, b);
  recordYawPoleCommit(bag, a);
  assertEquals(yawPoleKeyIgnored(bag.yawPoleIgnore, b), true);

  recordYawPoleClear(bag, b); // does not count
  assertEquals(bag.yawPoleIgnore?.[b], YAW_POLE_PINGPONG_CLEARS_REQUIRED);

  recordYawPoleClear(bag, c);
  assertEquals(bag.yawPoleIgnore?.[b], 1);
  recordYawPoleClear(bag, d);
  assertEquals(bag.yawPoleIgnore, undefined);
});

Deno.test("pickYawPoleTarget: ignorePoleKeys skips banned wall pole", () => {
  // Open map; place two wall poles in forward FOV with self at origin facing −z.
  const map = openMap();
  const a = { x: 0, z: -8 };
  const b = { x: 2, z: -8 };
  const bKey = yawPoleKey(b.x, b.z);
  const pickedOpen = pickYawPoleTarget({
    x: 0,
    z: 0,
    yaw: 0,
    team: "A",
    map,
    wallPoles: [a, b],
    enemyDoorPoles: [],
    hardPrioritizeDoorPoles: false,
  });
  assertExists(pickedOpen);

  const picked = pickYawPoleTarget({
    x: 0,
    z: 0,
    yaw: 0,
    team: "A",
    map,
    wallPoles: [a, b],
    enemyDoorPoles: [],
    hardPrioritizeDoorPoles: false,
    ignorePoleKeys: { [bKey]: 2 },
  });
  assertExists(picked);
  assertEquals(yawPoleKey(picked.x, picked.z) === bKey, false);
});

Deno.test("clearStickyYawPole: also drops ping-pong memory", () => {
  const bag: StickyYawPoleState = {
    stickyYawPole: { x: 1, z: 2 },
    yawPoleCommitKeys: ["a", "b"],
    yawPoleIgnore: { b: 2 },
  };
  clearStickyYawPole(bag);
  assertEquals(bag.stickyYawPole, undefined);
  assertEquals(bag.yawPoleCommitKeys, undefined);
  assertEquals(bag.yawPoleIgnore, undefined);
});

Deno.test("clearYawPolePingPong: leaves sticky lock", () => {
  const bag: StickyYawPoleState = {
    stickyYawPole: { x: 1, z: 2 },
    yawPoleCommitKeys: ["a"],
    yawPoleIgnore: { b: 1 },
  };
  clearYawPolePingPong(bag);
  assertEquals(bag.stickyYawPole?.x, 1);
  assertEquals(bag.yawPoleCommitKeys, undefined);
  assertEquals(bag.yawPoleIgnore, undefined);
});
