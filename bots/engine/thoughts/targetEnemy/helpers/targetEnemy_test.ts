import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertExists,
} from "@std/assert";
import { YAW_PLAYER_FOV_HALF_ANGLE } from "../../../../../shared/world/wallCorners.ts";
import { wishMoveYaw } from "../../../../../shared/world/yawPole.ts";
import { Player } from "../../../players/Player.ts";
import type { DoorsMap } from "../../../shared/map.ts";
import { MapCollision } from "../../../world/MapCollision.ts";
import { clearCombatLosCache } from "../../../helpers/combat.ts";
import { enemyDoorTarget, moveKeysForWorldYaw, yawToward } from "../../../helpers/nav.ts";
import {
  agentFirstChanceFromAggression,
  clampLeadVelocity,
  closerToEnemyDoorThanTarget,
  combatAimForClick,
  combatMoveKeysPwm,
  DOOR_AGGRESSION_SUPPRESS_BACKWARD,
  dutyForBlend0to45,
  dutyForBlend45to90,
  enemyInPlayerFov,
  estimateStickyTargetVelocity,
  extrapolateCombatAim,
  applyCombatLead,
  emaLeadVelocity,
  leadEmaAlpha,
  scoreHostileThreat,
  foldAlphaForwardHemisphere,
  pickStandGroundStrafeSide,
  MIN_SEPARATION_HYSTERESIS,
  pickTargetEnemy,
  planOctantPwm,
  rollStandGroundStrafeDepth,
  type SecondaryPwmScratch,
  stepSecondaryPwm,
  shouldSeparateFromTarget,
  stepTargetEnemy,
  TARGET_ENEMY_BACK_S_DUTY_CAP,
  TARGET_ENEMY_HOLD_FOV_HALF_ANGLE,
  TARGET_ENEMY_LEAD_MAX_SPEED,
  TARGET_ENEMY_LEAD_SEC,
  TARGET_ENEMY_MIN_TAP_BOT_TICKS,
  TARGET_ENEMY_SAMPLE_DT_SEC,
  TARGET_ENEMY_STATE_KEY,
  TARGET_STRAFE_DEPTH_DUTY_MAX,
  TARGET_STRAFE_DEPTH_DUTY_MIN,
  TARGET_STRAFE_DEPTH_NONE_P,
  TARGET_STRAFE_EXIT_P,
  TARGET_STRAFE_PAUSE_P,
  TARGET_STRAFE_SIDE_FLIP_P,
  type TargetEnemyState,
  thetaFromDuty0to45,
  worldMoveProgressesToward,
  worldMoveYawFromPrior,
} from "./targetEnemy.ts";

function openMap(): DoorsMap {
  return {
    version: 1,
    name: "TargetEnemy",
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
  };
}

function wallMap(): DoorsMap {
  return {
    ...openMap(),
    name: "TargetEnemyWall",
    walls: [
      {
        id: "full",
        kind: "full",
        a: { x: -10, z: 0 },
        b: { x: 10, z: 0 },
      },
    ],
  };
}

function halfWallMap(): DoorsMap {
  return {
    ...openMap(),
    name: "TargetEnemyHalfWall",
    walls: [
      {
        id: "half",
        kind: "half",
        a: { x: -10, z: 0 },
        b: { x: 10, z: 0 },
      },
    ],
  };
}

function makeBot(
  id: string,
  team: "A" | "B",
  x: number,
  z: number,
  yaw: number,
): Player {
  const p = new Player(id, id, team, { isBot: true });
  p.applySpawn({ x, y: 1.6, z, yaw }, 0);
  p.alive = true;
  return p;
}

Deno.test("enemyInPlayerFov: center / edge / outside", () => {
  // Facing north (yaw 0 → forward −z). Enemy north of self is center.
  assertEquals(enemyInPlayerFov(0, 0, 0, 0, -5), true);
  // At half-angle edge (east of north).
  const edgeX = Math.sin(YAW_PLAYER_FOV_HALF_ANGLE) * 5;
  const edgeZ = -Math.cos(YAW_PLAYER_FOV_HALF_ANGLE) * 5;
  assertEquals(enemyInPlayerFov(0, 0, 0, edgeX, edgeZ), true);
  // Behind (south).
  assertEquals(enemyInPlayerFov(0, 0, 0, 0, 5), false);
});

Deno.test("worldMoveYawFromPrior: pure W matches look", () => {
  const w = worldMoveYawFromPrior(0, {
    forward: true,
    left: false,
    right: false,
  }, 1.23);
  assertAlmostEquals(w, 0, 1e-9);
});

// --- PWM math ----------------------------------------------------------------

Deno.test("dutyForBlend0to45: endpoints and mid invert", () => {
  assertAlmostEquals(dutyForBlend0to45(0), 0, 1e-9);
  assertAlmostEquals(dutyForBlend0to45(Math.PI / 4), 1, 1e-9);
  // Round-trip several angles.
  for (const deg of [5, 10, 15, 20, 30, 40]) {
    const th = (deg * Math.PI) / 180;
    const d = dutyForBlend0to45(th);
    assertAlmostEquals(thetaFromDuty0to45(d), th, 1e-6);
  }
});

Deno.test("dutyForBlend45to90: endpoints", () => {
  assertAlmostEquals(dutyForBlend45to90(Math.PI / 4), 1, 1e-6);
  assertAlmostEquals(dutyForBlend45to90(Math.PI / 2), 0, 1e-6);
});

Deno.test("planOctantPwm: pure axes and 45° hard both", () => {
  const pureW = planOctantPwm(0);
  assertEquals(pureW.hard.forward, true);
  assertEquals(pureW.secondary, null);

  const pureLeft = planOctantPwm(Math.PI / 2);
  assertEquals(pureLeft.hard.left, true);
  assertEquals(pureLeft.secondary, null);

  const pureRight = planOctantPwm(-Math.PI / 2);
  assertEquals(pureRight.hard.right, true);
  assertEquals(pureRight.secondary, null);

  // Pure reverse → pure strafe (never hard-only S / moonwalk).
  const pureS = planOctantPwm(Math.PI);
  assertEquals(pureS.hard.backward, false);
  assertEquals(pureS.hard.forward, false);
  assertEquals(pureS.hard.left, true);
  assertEquals(pureS.secondary, null);

  const pureSNeg = planOctantPwm(-Math.PI);
  assertEquals(pureSNeg.hard.backward, false);
  assertEquals(pureSNeg.hard.forward, false);
  // −π wraps to +π → left peel (stable).
  assertEquals(pureSNeg.hard.left, true);
  assertEquals(pureSNeg.secondary, null);

  // +π/4 = left diagonal (W+A); −π/4 = right (W+D).
  const diagL = planOctantPwm(Math.PI / 4);
  assertEquals(diagL.hard.forward, true);
  assertEquals(diagL.hard.left, true);
  assertEquals(diagL.secondary, null);

  const diagR = planOctantPwm(-Math.PI / 4);
  assertEquals(diagR.hard.forward, true);
  assertEquals(diagR.hard.right, true);
  assertEquals(diagR.secondary, null);

  // Back diagonal 135° left → primary strafe + capped secondary S (not hard both).
  const backDiagL = planOctantPwm((135 * Math.PI) / 180);
  assertEquals(backDiagL.hard.left, true);
  assertEquals(backDiagL.hard.backward, false);
  assertEquals(backDiagL.secondary, "backward");
  assertEquals(backDiagL.duty <= TARGET_ENEMY_BACK_S_DUTY_CAP + 1e-9, true);

  // Near pure reverse (170° left) → primary strafe, secondary S (partial reverse).
  const nearS = planOctantPwm((170 * Math.PI) / 180);
  assertEquals(nearS.hard.left, true);
  assertEquals(nearS.hard.backward, false);
  assertEquals(nearS.secondary, "backward");
  assertEquals(
    nearS.duty > 0.05 && nearS.duty <= TARGET_ENEMY_BACK_S_DUTY_CAP + 1e-9,
    true,
  );

  // +yaw is left in this game; −yaw is right.
  const left = planOctantPwm(Math.PI / 6);
  assertEquals(left.hard.forward, true);
  assertEquals(left.secondary, "left");
  assertEquals(left.duty > 0.2 && left.duty < 0.9, true);

  const right = planOctantPwm(-Math.PI / 6);
  assertEquals(right.hard.forward, true);
  assertEquals(right.secondary, "right");
});

Deno.test("stepSecondaryPwm: respects min dwell on flips", () => {
  const min = TARGET_ENEMY_MIN_TAP_BOT_TICKS;
  assertEquals(min >= 2, true);
  const st: SecondaryPwmScratch = {
    acc: 0,
    on: false,
    dwell: min,
    sec: null,
  };
  // Force rapid desire: duty 1 then 0 should still dwell.
  stepSecondaryPwm(st, "right", 1, min);
  assertEquals(st.on, true);
  // Drop duty to 0 — hard path sets off immediately (duty eps).
  stepSecondaryPwm(st, "right", 0, min);
  assertEquals(st.on, false);

  // Mid duty: never flip with dwell < min.
  st.acc = 0;
  st.on = false;
  st.dwell = 0;
  st.sec = "right";
  const edges: number[] = [];
  let prev = false;
  for (let i = 0; i < 40; i++) {
    const on = stepSecondaryPwm(st, "right", 0.5, min);
    if (on !== prev) {
      edges.push(i);
    }
    prev = on;
  }
  // Hold length between edges = gap in tick indices; first hold = edges[0]+1
  // from a virtual edge at -1.
  const starts = [-1, ...edges];
  for (let e = 1; e < starts.length; e++) {
    const hold = starts[e]! - starts[e - 1]!;
    assertEquals(
      hold >= min,
      true,
      `hold ${hold} at edge ${starts[e]} < min ${min} (edges=${
        edges.join(",")
      })`,
    );
  }
  // Must actually PWM (not stuck always off/on).
  assertEquals(edges.length >= 2, true, "expected secondary to toggle");
});

Deno.test("combatMoveKeysPwm: 20° average closer than discrete 45° snap", () => {
  const look = 0;
  // −yaw is right of look (game convention).
  const move = (-20 * Math.PI) / 180;
  const discrete = moveKeysForWorldYaw(look, move);
  // Discrete snaps into W+D → 45° right (−π/4).
  assertEquals(discrete.forward && discrete.right, true);

  let state: TargetEnemyState = {};
  let sumX = 0;
  let sumZ = 0;
  let n = 0;
  for (let i = 0; i < 80; i++) {
    const { keys, pwmPatch } = combatMoveKeysPwm(look, move, state);
    state = { ...state, ...pwmPatch };
    // Instantaneous wish (same normalize basis as moveStep).
    const w = wishMoveYaw(look, keys);
    if (w === null) continue;
    // Accumulate unit vector along wish for mean angle.
    sumX += -Math.sin(w);
    sumZ += -Math.cos(w);
    n++;
  }
  assertEquals(n > 0, true);
  const meanYaw = Math.atan2(-sumX / n, -sumZ / n);
  const errPwm = Math.abs(meanYaw - move);
  const errDiscrete = Math.abs(-Math.PI / 4 - move);
  // PWM long-run mean must beat the bulky diagonal snap.
  assertEquals(
    errPwm < errDiscrete * 0.6,
    true,
    `pwm err ${errPwm} not better than discrete ${errDiscrete} (mean ${meanYaw})`,
  );
  // And within ~8° of target over 80 bot ticks.
  assertEquals(
    errPwm < (8 * Math.PI) / 180,
    true,
    `mean ${meanYaw} too far from ${move}`,
  );
});

Deno.test("stepTargetEnemy: enemy in FOV + LOS → combat lock + remapped keys", () => {
  clearCombatLosCache();
  const col = new MapCollision(openMap());
  // Self at origin facing −z (yaw 0). Enemy straight ahead (−z).
  const me = makeBot("bot:1", "A", 0, 0, 0);
  const enemy = makeBot("enemy:1", "B", 0, -8, Math.PI);
  // Path intent +x (east): yaw = atan2(−1, 0) = −π/2.
  const desiredYaw = -Math.PI / 2;
  const result = stepTargetEnemy({
    self: me,
    players: [me, enemy],
    collision: col,
    worldMoveYaw: desiredYaw,
    state: {},
  });
  assertExists(result.combat);
  assertEquals(result.combat!.enemyId, "enemy:1");
  const expectLook = yawToward(0, 0, 0, -8);
  assertAlmostEquals(result.combat!.lookYaw, expectLook, 1e-9);
  // Looking −z, world move +x → primary right (90°), no need for W.
  assertEquals(result.combat!.right, true);
  assertEquals(result.combat!.left, false);
  assertEquals(result.statePatch[TARGET_ENEMY_STATE_KEY], "enemy:1");
});

Deno.test("stepTargetEnemy: enemy outside FOV → null combat", () => {
  clearCombatLosCache();
  const col = new MapCollision(openMap());
  const me = makeBot("bot:1", "A", 0, 0, 0); // face −z
  const enemy = makeBot("enemy:1", "B", 0, 8, 0); // behind (+z)
  const result = stepTargetEnemy({
    self: me,
    players: [me, enemy],
    collision: col,
    worldMoveYaw: 0,
    state: {},
  });
  assertEquals(result.combat, null);
  assertEquals(result.statePatch[TARGET_ENEMY_STATE_KEY], undefined);
});

Deno.test("stepTargetEnemy: full wall LOS block → null combat", () => {
  clearCombatLosCache();
  const col = new MapCollision(wallMap());
  // Wall along X at z=0. Self south, enemy north — FOV includes north but LOS blocked.
  const me = makeBot("bot:1", "A", 0, -4, 0);
  // Facing toward enemy: enemy at +z from me, so face +z → yaw = π
  me.yaw = Math.PI;
  const enemy = makeBot("enemy:1", "B", 0, 4, 0);
  // Confirm FOV would pass without wall:
  assertEquals(enemyInPlayerFov(me.x, me.z, me.yaw, enemy.x, enemy.z), true);
  const result = stepTargetEnemy({
    self: me,
    players: [me, enemy],
    collision: col,
    worldMoveYaw: Math.PI,
    state: {},
  });
  assertEquals(result.combat, null);
});

Deno.test("pickTargetEnemy: assumeLos skips the wall ray", () => {
  clearCombatLosCache();
  const col = new MapCollision(wallMap());
  const me = makeBot("bot:1", "A", 0, -4, 0);
  me.yaw = Math.PI;
  const enemy = makeBot("enemy:1", "B", 0, 4, 0);
  const blocked = pickTargetEnemy(me, [me, enemy], col, undefined);
  assertEquals(blocked, null);
  const assumed = pickTargetEnemy(me, [me, enemy], col, undefined, {
    hostiles: [enemy],
    assumeLos: true,
  });
  assertEquals(assumed?.player.id, "enemy:1");
});

Deno.test("stepTargetEnemy: standing enemy behind half wall is targetable", () => {
  clearCombatLosCache();
  const col = new MapCollision(halfWallMap());
  // Asymmetric: far shooter, foe just past half wall — torso ray clips, head peeks.
  const me = makeBot("bot:half", "A", 0, -8, Math.PI);
  me.y = 1.7;
  const enemy = makeBot("enemy:half", "B", 0, 1, 0);
  enemy.y = 1.7;
  assertEquals(enemyInPlayerFov(me.x, me.z, me.yaw, enemy.x, enemy.z), true);
  const result = stepTargetEnemy({
    self: me,
    players: [me, enemy],
    collision: col,
    worldMoveYaw: Math.PI,
    state: {},
    ignoreDoorPriority: true,
  });
  assertExists(result.combat);
  assertEquals(result.combat!.enemyId, "enemy:half");
});

Deno.test("stepTargetEnemy: crouched enemy behind half wall is not targetable", () => {
  clearCombatLosCache();
  const col = new MapCollision(halfWallMap());
  const me = makeBot("bot:half2", "A", 0, -8, Math.PI);
  me.y = 1.7;
  const enemy = makeBot("enemy:half2", "B", 0, 1, 0);
  enemy.crouch = true;
  enemy.y = 1.05;
  const result = stepTargetEnemy({
    self: me,
    players: [me, enemy],
    collision: col,
    worldMoveYaw: Math.PI,
    state: {},
    ignoreDoorPriority: true,
  });
  assertEquals(result.combat, null);
});

Deno.test("stepTargetEnemy: sticky drops when full wall blocks LOS", () => {
  clearCombatLosCache();
  const open = new MapCollision(openMap());
  const me = makeBot("bot:1", "A", 0, -4, Math.PI);
  const enemy = makeBot("enemy:1", "B", 0, 4, 0);
  const openHit = stepTargetEnemy({
    self: me,
    players: [me, enemy],
    collision: open,
    worldMoveYaw: Math.PI,
    state: {},
  });
  assertExists(openHit.combat);
  assertEquals(openHit.combat!.enemyId, "enemy:1");

  const blocked = stepTargetEnemy({
    self: me,
    players: [me, enemy],
    collision: new MapCollision(wallMap()),
    worldMoveYaw: Math.PI,
    state: { [TARGET_ENEMY_STATE_KEY]: "enemy:1" },
  });
  assertEquals(blocked.combat, null);
  assertEquals(blocked.statePatch[TARGET_ENEMY_STATE_KEY], undefined);
});

Deno.test("stepTargetEnemy: sticky holds first of two FOV enemies", () => {
  clearCombatLosCache();
  const col = new MapCollision(openMap());
  const me = makeBot("bot:1", "A", 0, 0, 0);
  // Both ahead (−z): far and near. Nearest without sticky would be near.
  const far = makeBot("enemy:far", "B", 0, -12, Math.PI);
  const near = makeBot("enemy:near", "B", 0, -5, Math.PI);
  const state: TargetEnemyState = {
    [TARGET_ENEMY_STATE_KEY]: "enemy:far",
  };
  const result = stepTargetEnemy({
    self: me,
    players: [me, far, near],
    collision: col,
    worldMoveYaw: 0,
    state,
  });
  assertExists(result.combat);
  assertEquals(result.combat!.enemyId, "enemy:far");
});

Deno.test("stepTargetEnemy: sticky holds in wider FOV when acquire FOV fails", () => {
  clearCombatLosCache();
  const col = new MapCollision(openMap());
  const me = makeBot("bot:1", "A", 0, 0, 0);
  // Place enemy past acquire half-angle but inside hold half-angle.
  const mid = (YAW_PLAYER_FOV_HALF_ANGLE + TARGET_ENEMY_HOLD_FOV_HALF_ANGLE) /
    2;
  const dist = 8;
  const enemyX = Math.sin(mid) * dist;
  const enemyZ = -Math.cos(mid) * dist;
  const enemy = makeBot("enemy:1", "B", enemyX, enemyZ, Math.PI);

  assertEquals(
    enemyInPlayerFov(0, 0, 0, enemyX, enemyZ, YAW_PLAYER_FOV_HALF_ANGLE),
    false,
  );
  assertEquals(
    enemyInPlayerFov(0, 0, 0, enemyX, enemyZ, TARGET_ENEMY_HOLD_FOV_HALF_ANGLE),
    true,
  );

  // Fresh acquire: outside acquire FOV → null.
  const fresh = stepTargetEnemy({
    self: me,
    players: [me, enemy],
    collision: col,
    worldMoveYaw: 0,
    state: {},
  });
  assertEquals(fresh.combat, null);

  // Sticky hold: still locked.
  const held = stepTargetEnemy({
    self: me,
    players: [me, enemy],
    collision: col,
    worldMoveYaw: 0,
    state: { [TARGET_ENEMY_STATE_KEY]: "enemy:1" },
  });
  assertExists(held.combat);
  assertEquals(held.combat!.enemyId, "enemy:1");
});

Deno.test("pickTargetEnemy: nearest when no sticky", () => {
  clearCombatLosCache();
  const col = new MapCollision(openMap());
  const me = makeBot("bot:1", "A", 0, 0, 0);
  const far = makeBot("enemy:far", "B", 0, -12, Math.PI);
  const near = makeBot("enemy:near", "B", 0, -5, Math.PI);
  const picked = pickTargetEnemy(me, [me, far, near], col, undefined);
  assertExists(picked);
  assertEquals(picked!.player.id, "enemy:near");
});

Deno.test("stepTargetEnemy: remaps pure path east while looking −z", () => {
  clearCombatLosCache();
  const col = new MapCollision(openMap());
  const me = makeBot("bot:1", "A", 0, 0, 0);
  const enemy = makeBot("enemy:1", "B", 0, -6, Math.PI);
  // World move +x: yaw = −π/2.
  const desiredYaw = -Math.PI / 2;
  const result = stepTargetEnemy({
    self: me,
    players: [me, enemy],
    collision: col,
    worldMoveYaw: desiredYaw,
    state: {},
  });
  assertExists(result.combat);
  // Looking ~0 (−z), move +x → right key.
  assertEquals(result.combat!.right, true);
  assertEquals(result.combat!.left, false);
  assertEquals(result.combat!.backward, false);
});

Deno.test("stepTargetEnemy: path behind combat look → strafe peel (no pure S)", () => {
  clearCombatLosCache();
  const col = new MapCollision(openMap());
  // Face −z; enemy ahead (−z); path intent opposite (+z, yaw π).
  // Low doorAggression: A only (strafe primary, not hard-only S).
  const me = makeBot("bot:1", "A", 0, 0, 0);
  const enemy = makeBot("enemy:1", "B", 0, -8, Math.PI);
  const result = stepTargetEnemy({
    self: me,
    players: [me, enemy],
    collision: col,
    worldMoveYaw: Math.PI,
    state: {},
    doorAggression: 0.2,
    standGroundChance: 0,
  });
  assertExists(result.combat);
  assertEquals(result.combat!.backward, false);
  assertEquals(result.combat!.forward, false);
  // Pure reverse peels left (stable) under A.
  assertEquals(result.combat!.left, true);
  assertEquals(result.combat!.right, false);
});

Deno.test("stepTargetEnemy: high doorAggression + door progress suppresses S", () => {
  clearCombatLosCache();
  const col = new MapCollision(openMap());
  // Team A enemy door is north (+z). Move yaw π = +z progress toward door.
  // Look south at foe → without B would be reverse hemisphere.
  const me = makeBot("bot:1", "A", 0, 0, 0);
  const enemy = makeBot("enemy:1", "B", 0, -8, Math.PI);
  const door = enemyDoorTarget(col.map, "A");
  assertEquals(
    worldMoveProgressesToward(me.x, me.z, Math.PI, door),
    true,
  );
  assertEquals(DOOR_AGGRESSION_SUPPRESS_BACKWARD <= 0.75, true);
  const result = stepTargetEnemy({
    self: me,
    players: [me, enemy],
    collision: col,
    worldMoveYaw: Math.PI,
    state: {},
    doorAggression: 0.75,
    standGroundChance: 0,
    enemyDoor: door,
  });
  assertExists(result.combat);
  assertEquals(result.combat!.backward, false);
  // Forward hemisphere fold → pure strafe edge.
  assertEquals(
    result.combat!.left || result.combat!.right,
    true,
  );
});

Deno.test("combatMoveKeysPwm: suppressBackward never emits S", () => {
  const state: TargetEnemyState = {};
  let sawBackward = false;
  let sawAny = false;
  for (let i = 0; i < 40; i++) {
    const { keys, pwmPatch } = combatMoveKeysPwm(0, Math.PI, state, {
      suppressBackward: true,
    });
    Object.assign(state, pwmPatch);
    if (keys.backward) sawBackward = true;
    if (keys.forward || keys.left || keys.right || keys.backward) sawAny = true;
  }
  assertEquals(sawBackward, false);
  assertEquals(sawAny, true);
});

Deno.test("foldAlphaForwardHemisphere: clamps back half to ±π/2", () => {
  assertAlmostEquals(foldAlphaForwardHemisphere(Math.PI), Math.PI / 2, 1e-12);
  // −π wraps to +π before clamp → +π/2 (same peel as pure reverse).
  assertAlmostEquals(foldAlphaForwardHemisphere(-Math.PI), Math.PI / 2, 1e-12);
  assertAlmostEquals(foldAlphaForwardHemisphere(-2.5), -Math.PI / 2, 1e-12);
  assertAlmostEquals(foldAlphaForwardHemisphere(2.5), Math.PI / 2, 1e-12);
  assertAlmostEquals(foldAlphaForwardHemisphere(0.3), 0.3, 1e-12);
});

Deno.test("closerToEnemyDoorThanTarget: near door vs mid-map", () => {
  const col = new MapCollision(openMap());
  // Team A enemy door is near +z (north). Near the door, a far south foe loses.
  const nearDoor = makeBot("bot:1", "A", 0, 35, Math.PI);
  const farFoe = makeBot("enemy:1", "B", 0, 10, 0);
  assertEquals(closerToEnemyDoorThanTarget(nearDoor, farFoe, col), true);
  const door = enemyDoorTarget(col.map, "A");
  assertEquals(
    Math.hypot(nearDoor.x - door.x, nearDoor.z - door.z) <
      Math.hypot(farFoe.x - nearDoor.x, farFoe.z - nearDoor.z),
    true,
  );

  // Mid-map with close foe ahead: still combat-worthy.
  const mid = makeBot("bot:2", "A", 0, 0, 0);
  const closeFoe = makeBot("enemy:2", "B", 0, -6, Math.PI);
  assertEquals(closerToEnemyDoorThanTarget(mid, closeFoe, col), false);
});

Deno.test("closerToEnemyDoorThanTarget: trailing ratio drops more often", () => {
  const col = new MapCollision(openMap());
  // Mid-map: door farther than a mid-range foe at default ratio → fight.
  const me = makeBot("bot:1", "A", 0, 0, 0);
  const foe = makeBot("enemy:1", "B", 0, 12, Math.PI);
  const door = enemyDoorTarget(col.map, "A");
  const distDoor = Math.hypot(me.x - door.x, me.z - door.z);
  const distEnemy = Math.hypot(foe.x - me.x, foe.z - me.z);
  // Ensure default would fight (enemy closer than door).
  assertEquals(distEnemy < distDoor, true);
  assertEquals(closerToEnemyDoorThanTarget(me, foe, col), false);
  // Tight trailing ratio: only duel when foe is well inside door range.
  assertEquals(
    closerToEnemyDoorThanTarget(me, foe, col, undefined, undefined, {
      doorPriorityRatio: 0.55,
    }),
    distDoor * 0.55 < distEnemy,
  );
});

Deno.test("stepTargetEnemy: unlock sticky when closer to enemy door than target", () => {
  clearCombatLosCache();
  const col = new MapCollision(openMap());
  // Near team-A enemy door (+z); foe further south; face −z toward them.
  const me = makeBot("bot:1", "A", 0, 35, 0);
  const enemy = makeBot("enemy:1", "B", 0, 10, Math.PI);
  assertEquals(closerToEnemyDoorThanTarget(me, enemy, col), true);
  assertEquals(enemyInPlayerFov(me.x, me.z, me.yaw, enemy.x, enemy.z), true);

  const result = stepTargetEnemy({
    self: me,
    players: [me, enemy],
    collision: col,
    worldMoveYaw: 0,
    state: { [TARGET_ENEMY_STATE_KEY]: "enemy:1" },
  });
  assertEquals(result.combat, null);
  assertEquals(result.statePatch[TARGET_ENEMY_STATE_KEY], undefined);
});

Deno.test("stepTargetEnemy: no fresh lock when closer to door than foe", () => {
  clearCombatLosCache();
  const col = new MapCollision(openMap());
  const me = makeBot("bot:1", "A", 0, 35, 0);
  const enemy = makeBot("enemy:1", "B", 0, 10, Math.PI);
  const result = stepTargetEnemy({
    self: me,
    players: [me, enemy],
    collision: col,
    worldMoveYaw: 0,
    state: {},
  });
  assertEquals(result.combat, null);
});

Deno.test("stepTargetEnemy: low doorPriorityRatio skips mid-range duel", () => {
  clearCombatLosCache();
  const col = new MapCollision(openMap());
  // Yaw 0 faces −z (north). Team A enemy door is on the north edge.
  const me = makeBot("bot:1", "A", 0, 0, 0);
  // Foe toward the door, still closer than door, but outside the trailing
  // 0.55× door band so score anxiety should drop combat.
  const enemy = makeBot("enemy:1", "B", 0, -25, Math.PI);
  const door = enemyDoorTarget(col.map, "A");
  const distDoor = Math.hypot(me.x - door.x, me.z - door.z);
  const distEnemy = Math.hypot(enemy.x - me.x, enemy.z - me.z);
  assertEquals(enemyInPlayerFov(me.x, me.z, me.yaw, enemy.x, enemy.z), true);
  // Default ratio would fight; trailing ratio should drop.
  assertEquals(distEnemy < distDoor, true);
  assertEquals(distDoor * 0.55 < distEnemy, true);

  const defaultLock = stepTargetEnemy({
    self: me,
    players: [me, enemy],
    collision: col,
    worldMoveYaw: 0,
    state: {},
  });
  assertExists(defaultLock.combat);

  const trailing = stepTargetEnemy({
    self: me,
    players: [me, enemy],
    collision: col,
    worldMoveYaw: 0,
    state: {},
    doorPriorityRatio: 0.55,
  });
  assertEquals(trailing.combat, null);
});

Deno.test("stepTargetEnemy: ignoreDoorPriority keeps lock near enemy door", () => {
  clearCombatLosCache();
  const col = new MapCollision(openMap());
  const me = makeBot("bot:1", "A", 0, 35, 0);
  const enemy = makeBot("enemy:1", "B", 0, 10, Math.PI);
  assertEquals(closerToEnemyDoorThanTarget(me, enemy, col), true);
  const result = stepTargetEnemy({
    self: me,
    players: [me, enemy],
    collision: col,
    worldMoveYaw: 0,
    state: { [TARGET_ENEMY_STATE_KEY]: "enemy:1" },
    ignoreDoorPriority: true,
  });
  assertExists(result.combat);
  assertEquals(result.combat!.enemyId, "enemy:1");
});

Deno.test("agentFirstChanceFromAggression: 0→0, 0.25→0.5, 0.5→1, 1→1", () => {
  assertEquals(agentFirstChanceFromAggression(0), 0);
  assertEquals(agentFirstChanceFromAggression(0.25), 0.5);
  assertEquals(agentFirstChanceFromAggression(0.5), 1);
  assertEquals(agentFirstChanceFromAggression(0.75), 1);
  assertEquals(agentFirstChanceFromAggression(1), 1);
});

Deno.test("pickTargetEnemy: agentFirstChance prefers agent over closer team enemy", () => {
  clearCombatLosCache();
  const col = new MapCollision(openMap());
  const me = makeBot("bot:1", "A", 0, 0, 0);
  // Closer team enemy south.
  const foe = makeBot("enemy:1", "B", 0, -6, Math.PI);
  // Farther agent also south in FOV.
  const agent = new Player("agent:1", "agent", "A", {
    isBot: true,
    isAgent: true,
  });
  agent.applySpawn({ x: 0, y: 1.6, z: -12, yaw: Math.PI }, 0);
  agent.alive = true;

  const preferAgent = pickTargetEnemy(me, [me, foe, agent], col, undefined, {
    agentFirstChance: 1,
    rng: () => 0,
  });
  assertExists(preferAgent);
  assertEquals(preferAgent.player.id, "agent:1");

  const preferEnemy = pickTargetEnemy(me, [me, foe, agent], col, undefined, {
    agentFirstChance: 0,
    rng: () => 0,
  });
  assertExists(preferEnemy);
  assertEquals(preferEnemy.player.id, "enemy:1");
});

Deno.test("stepTargetEnemy: standGroundChance roll plants when ADAD is zero", () => {
  clearCombatLosCache();
  const col = new MapCollision(openMap());
  const me = makeBot("bot:1", "A", 0, 0, 0);
  const enemy = makeBot("enemy:1", "B", 0, -8, Math.PI);
  // Path intent east — without stand-ground would press right.
  const result = stepTargetEnemy({
    self: me,
    players: [me, enemy],
    collision: col,
    worldMoveYaw: -Math.PI / 2,
    state: {},
    standGroundChance: 0.5,
    strafeAvgMs: 0,
    strafePauseAvgMs: 0,
    strafeVariation: 0,
    rng: () => 0.1, // 0.1 < 0.5 → stand-ground plant
  });
  assertExists(result.combat);
  assertEquals(result.combat!.enemyId, "enemy:1");
  assertEquals(result.combat!.forward, false);
  assertEquals(result.combat!.backward, false);
  assertEquals(result.combat!.left, false);
  assertEquals(result.combat!.right, false);
  assertEquals(result.statePatch.targetEnemyStandGround, true);
  assertEquals(result.statePatch[TARGET_ENEMY_STATE_KEY], "enemy:1");
});

Deno.test("stepTargetEnemy: stand-ground sticky until lock clears", () => {
  clearCombatLosCache();
  const col = new MapCollision(openMap());
  const me = makeBot("bot:1", "A", 0, 0, 0);
  const enemy = makeBot("enemy:1", "B", 0, -8, Math.PI);

  const held = stepTargetEnemy({
    self: me,
    players: [me, enemy],
    collision: col,
    worldMoveYaw: -Math.PI / 2,
    state: {
      [TARGET_ENEMY_STATE_KEY]: "enemy:1",
      targetEnemyStandGround: true,
      targetEnemyStrafePhase: "pause",
      targetEnemyStrafeTicksLeft: 5,
    },
    // Chance / rng must not re-roll while sticky.
    standGroundChance: 0,
    strafeAvgMs: 0,
    rng: () => 0.99,
  });
  assertExists(held.combat);
  assertEquals(held.combat!.forward, false);
  assertEquals(held.combat!.right, false);
  assertEquals(held.statePatch.targetEnemyStandGround, true);

  // Enemy dead → unlock clears stand-ground.
  enemy.alive = false;
  const unlocked = stepTargetEnemy({
    self: me,
    players: [me, enemy],
    collision: col,
    worldMoveYaw: 0,
    state: {
      [TARGET_ENEMY_STATE_KEY]: "enemy:1",
      targetEnemyStandGround: true,
    },
    standGroundChance: 1,
    rng: () => 0,
  });
  assertEquals(unlocked.combat, null);
  assertEquals(unlocked.statePatch[TARGET_ENEMY_STATE_KEY], undefined);
  assertEquals(unlocked.statePatch.targetEnemyStandGround, undefined);
});

Deno.test("stepTargetEnemy: miss standGroundChance keeps PWM move keys", () => {
  clearCombatLosCache();
  const col = new MapCollision(openMap());
  const me = makeBot("bot:1", "A", 0, 0, 0);
  const enemy = makeBot("enemy:1", "B", 0, -8, Math.PI);
  const result = stepTargetEnemy({
    self: me,
    players: [me, enemy],
    collision: col,
    worldMoveYaw: -Math.PI / 2,
    state: {},
    standGroundChance: 0.5,
    rng: () => 0.9, // 0.9 < 0.5 is false
  });
  assertExists(result.combat);
  assertEquals(result.statePatch.targetEnemyStandGround, false);
  // Looking −z, world move +x → primary right.
  assertEquals(result.combat!.right, true);
});

Deno.test("stepTargetEnemy: stand-ground ADAD presses pure A/D", () => {
  clearCombatLosCache();
  const col = new MapCollision(openMap());
  const me = makeBot("bot:1", "A", 0, 0, 0);
  const enemy = makeBot("enemy:1", "B", 0, -8, Math.PI);
  // Fixed rng: stand-ground hits, then side pick uses same stream (0.1 < 0.5 → left).
  const result = stepTargetEnemy({
    self: me,
    players: [me, enemy],
    collision: col,
    worldMoveYaw: -Math.PI / 2,
    state: {},
    standGroundChance: 1,
    strafeAvgMs: 500,
    strafePauseAvgMs: 500,
    strafeVariation: 0,
    rng: () => 0.1,
  });
  assertExists(result.combat);
  assertEquals(result.statePatch.targetEnemyStandGround, true);
  assertEquals(result.statePatch.targetEnemyStrafePhase, "strafe");
  assertEquals(result.combat!.forward, false);
  assertEquals(result.combat!.backward, false);
  assertEquals(result.combat!.left, true);
  assertEquals(result.combat!.right, false);
  assertEquals(result.statePatch.targetEnemyStrafeDir, "left");
  // 500ms @ 20Hz → 10 ticks.
  assertEquals(result.statePatch.targetEnemyStrafeTicksLeft, 10);
});

Deno.test("stepTargetEnemy: stand-ground ADAD flips to pause after hold", () => {
  clearCombatLosCache();
  const col = new MapCollision(openMap());
  const me = makeBot("bot:1", "A", 0, 0, 0);
  const enemy = makeBot("enemy:1", "B", 0, -8, Math.PI);
  const afterStrafe = stepTargetEnemy({
    self: me,
    players: [me, enemy],
    collision: col,
    worldMoveYaw: 0,
    state: {
      [TARGET_ENEMY_STATE_KEY]: "enemy:1",
      targetEnemyStandGround: true,
      targetEnemyStrafePhase: "strafe",
      targetEnemyStrafeTicksLeft: 1,
      targetEnemyStrafeDir: "left",
    },
    standGroundChance: 1,
    strafeAvgMs: 500,
    strafePauseAvgMs: 400,
    strafeVariation: 0,
    rng: () => 0.5,
  });
  assertExists(afterStrafe.combat);
  assertEquals(afterStrafe.statePatch.targetEnemyStrafePhase, "pause");
  assertEquals(afterStrafe.combat!.left, false);
  assertEquals(afterStrafe.combat!.right, false);
  // 400ms @ 20Hz → 8 ticks.
  assertEquals(afterStrafe.statePatch.targetEnemyStrafeTicksLeft, 8);
});

Deno.test("stepTargetEnemy: pause avg 0 can still pause after a hold", () => {
  clearCombatLosCache();
  const col = new MapCollision(openMap());
  const me = makeBot("bot:1", "A", 0, 0, 0);
  const enemy = makeBot("enemy:1", "B", 0, -8, Math.PI);
  // exit miss, pause hit, default-band u, duration u, scale u.
  const seq = [
    (TARGET_STRAFE_EXIT_P + 1) / 2,
    TARGET_STRAFE_PAUSE_P * 0.5,
    0.5,
    0.5,
    0.5,
  ];
  let i = 0;
  const next = stepTargetEnemy({
    self: me,
    players: [me, enemy],
    collision: col,
    worldMoveYaw: 0,
    state: {
      [TARGET_ENEMY_STATE_KEY]: "enemy:1",
      targetEnemyStandGround: true,
      targetEnemyStrafePhase: "strafe",
      targetEnemyStrafeTicksLeft: 1,
      targetEnemyStrafeDir: "left",
    },
    standGroundChance: 1,
    strafeAvgMs: 200,
    strafePauseAvgMs: 0,
    strafeVariation: 0,
    rng: () => seq[Math.min(i++, seq.length - 1)]!,
  });
  assertExists(next.combat);
  assertEquals(next.statePatch.targetEnemyStrafePhase, "pause");
  assertEquals(next.statePatch.targetEnemyStrafeStopped, undefined);
  assertEquals(next.combat!.left, false);
  assertEquals(next.combat!.right, false);
});

Deno.test("stepTargetEnemy: ADAD can chain another strafe without pausing", () => {
  clearCombatLosCache();
  const col = new MapCollision(openMap());
  const me = makeBot("bot:1", "A", 0, 0, 0);
  const enemy = makeBot("enemy:1", "B", 0, -8, Math.PI);
  // exit miss, pause miss, duration, soft-flip (< flip P → right), depth none.
  const seq = [0.99, 0.99, 0.5, 0.5, 0.05];
  let i = 0;
  const next = stepTargetEnemy({
    self: me,
    players: [me, enemy],
    collision: col,
    worldMoveYaw: 0,
    state: {
      [TARGET_ENEMY_STATE_KEY]: "enemy:1",
      targetEnemyStandGround: true,
      targetEnemyStrafePhase: "strafe",
      targetEnemyStrafeTicksLeft: 1,
      targetEnemyStrafeDir: "left",
    },
    standGroundChance: 1,
    strafeAvgMs: 200,
    strafePauseAvgMs: 0,
    strafeVariation: 0,
    rng: () => seq[Math.min(i++, seq.length - 1)]!,
  });
  assertExists(next.combat);
  assertEquals(next.statePatch.targetEnemyStrafePhase, "strafe");
  assertEquals(next.statePatch.targetEnemyStrafeDir, "right");
  assertEquals(next.combat!.right, true);
  assertEquals(next.combat!.left, false);
});

Deno.test("stepTargetEnemy: ADAD exit plants for the rest of the lock", () => {
  clearCombatLosCache();
  const col = new MapCollision(openMap());
  const me = makeBot("bot:1", "A", 0, 0, 0);
  const enemy = makeBot("enemy:1", "B", 0, -8, Math.PI);
  const exited = stepTargetEnemy({
    self: me,
    players: [me, enemy],
    collision: col,
    worldMoveYaw: 0,
    state: {
      [TARGET_ENEMY_STATE_KEY]: "enemy:1",
      targetEnemyStandGround: true,
      targetEnemyStrafePhase: "strafe",
      targetEnemyStrafeTicksLeft: 1,
      targetEnemyStrafeDir: "left",
    },
    standGroundChance: 1,
    strafeAvgMs: 200,
    strafePauseAvgMs: 400,
    strafeVariation: 0,
    rng: () => 0,
  });
  assertExists(exited.combat);
  assertEquals(exited.statePatch.targetEnemyStrafeStopped, true);
  assertEquals(exited.statePatch.targetEnemyStrafePhase, "pause");
  assertEquals(exited.combat!.left, false);
  assertEquals(exited.combat!.right, false);
  assertEquals(exited.statePatch.targetEnemyStandGround, true);

  const held = stepTargetEnemy({
    self: me,
    players: [me, enemy],
    collision: col,
    worldMoveYaw: 0,
    state: {
      [TARGET_ENEMY_STATE_KEY]: "enemy:1",
      targetEnemyStandGround: true,
      targetEnemyStrafeStopped: true,
      targetEnemyStrafePhase: "pause",
      targetEnemyStrafeTicksLeft: 0,
    },
    standGroundChance: 1,
    strafeAvgMs: 200,
    strafePauseAvgMs: 400,
    strafeVariation: 0,
    rng: () => 0.99,
  });
  assertExists(held.combat);
  assertEquals(held.statePatch.targetEnemyStrafeStopped, true);
  assertEquals(held.combat!.left, false);
  assertEquals(held.combat!.right, false);
  assertEquals(held.combat!.forward, false);
});

Deno.test("pickStandGroundStrafeSide: soft flip vs keep", () => {
  assertEquals(pickStandGroundStrafeSide(undefined, () => 0.1), "left");
  assertEquals(pickStandGroundStrafeSide(undefined, () => 0.9), "right");
  assertEquals(pickStandGroundStrafeSide("left", () => 0), "right");
  assertEquals(
    pickStandGroundStrafeSide("left", () => TARGET_STRAFE_SIDE_FLIP_P),
    "left",
  );
  assertEquals(pickStandGroundStrafeSide("right", () => 0), "left");
});

Deno.test("rollStandGroundStrafeDepth: none / forward / back + duty band", () => {
  assertEquals(rollStandGroundStrafeDepth(() => 0).depth, undefined);
  assertEquals(rollStandGroundStrafeDepth(() => 0).duty, 0);

  // Just above none → forward half; duty uses second roll.
  let n = 0;
  const midForward = TARGET_STRAFE_DEPTH_NONE_P + 0.01;
  const depthFwd = rollStandGroundStrafeDepth(() => {
    n += 1;
    return n === 1 ? midForward : 0;
  });
  assertEquals(depthFwd.depth, "forward");
  assertAlmostEquals(depthFwd.duty, TARGET_STRAFE_DEPTH_DUTY_MIN, 1e-9);

  n = 0;
  const depthBack = rollStandGroundStrafeDepth(() => {
    n += 1;
    return n === 1 ? 0.99 : 1;
  });
  assertEquals(depthBack.depth, "backward");
  assertAlmostEquals(depthBack.duty, TARGET_STRAFE_DEPTH_DUTY_MAX, 1e-9);
});

Deno.test("stepTargetEnemy: stand-ground soft-flip can keep same side", () => {
  clearCombatLosCache();
  const col = new MapCollision(openMap());
  const me = makeBot("bot:1", "A", 0, 0, 0);
  const enemy = makeBot("enemy:1", "B", 0, -8, Math.PI);
  // Sequence: exit miss, pause miss, duration, side-flip (>= flip P → keep left),
  // depth none (no duty).
  const seq = [0.99, 0.99, 0.5, 0.95, 0.05];
  let i = 0;
  const next = stepTargetEnemy({
    self: me,
    players: [me, enemy],
    collision: col,
    worldMoveYaw: 0,
    state: {
      [TARGET_ENEMY_STATE_KEY]: "enemy:1",
      targetEnemyStandGround: true,
      targetEnemyStrafePhase: "strafe",
      targetEnemyStrafeTicksLeft: 1,
      targetEnemyStrafeDir: "left",
    },
    standGroundChance: 1,
    strafeAvgMs: 200,
    strafePauseAvgMs: 0,
    strafeVariation: 0,
    rng: () => seq[Math.min(i++, seq.length - 1)]!,
  });
  assertExists(next.combat);
  assertEquals(next.statePatch.targetEnemyStrafeDir, "left");
  assertEquals(next.combat!.left, true);
  assertEquals(next.combat!.right, false);
  assertEquals(next.combat!.forward, false);
  assertEquals(next.combat!.backward, false);
});

Deno.test("stepTargetEnemy: stand-ground strafe can PWM slight forward", () => {
  clearCombatLosCache();
  const col = new MapCollision(openMap());
  const me = makeBot("bot:1", "A", 0, 0, 0);
  const enemy = makeBot("enemy:1", "B", 0, -8, Math.PI);
  // duration, first side (left), depth forward band, high duty.
  // noneP=0.2, half remaining → forward in (0.2, 0.6); use 0.3 + duty u=1 → max duty.
  const seq = [0.5, 0.1, 0.3, 1];
  let i = 0;
  const next = stepTargetEnemy({
    self: me,
    players: [me, enemy],
    collision: col,
    worldMoveYaw: 0,
    state: {},
    standGroundChance: 1,
    strafeAvgMs: 500,
    strafePauseAvgMs: 500,
    strafeVariation: 0,
    rng: () => seq[Math.min(i++, seq.length - 1)]!,
  });
  assertExists(next.combat);
  assertEquals(next.statePatch.targetEnemyStandGround, true);
  assertEquals(next.statePatch.targetEnemyStrafePhase, "strafe");
  assertEquals(next.statePatch.targetEnemyStrafeDir, "left");
  assertEquals(next.statePatch.targetEnemyStrafeDepth, "forward");
  assertEquals(next.combat!.left, true);
  assertEquals(next.combat!.right, false);
  // High duty + free first dwell → secondary W on this tick.
  assertEquals(next.combat!.forward, true);
  assertEquals(next.combat!.backward, false);
});

Deno.test("stepTargetEnemy: stand-ground pause clears depth keys", () => {
  clearCombatLosCache();
  const col = new MapCollision(openMap());
  const me = makeBot("bot:1", "A", 0, 0, 0);
  const enemy = makeBot("enemy:1", "B", 0, -8, Math.PI);
  const afterStrafe = stepTargetEnemy({
    self: me,
    players: [me, enemy],
    collision: col,
    worldMoveYaw: 0,
    state: {
      [TARGET_ENEMY_STATE_KEY]: "enemy:1",
      targetEnemyStandGround: true,
      targetEnemyStrafePhase: "strafe",
      targetEnemyStrafeTicksLeft: 1,
      targetEnemyStrafeDir: "left",
      targetEnemyStrafeDepth: "forward",
      targetEnemyStrafeDepthDuty: 0.4,
      targetEnemyPwmOn: true,
      targetEnemyPwmSec: "forward",
    },
    standGroundChance: 1,
    strafeAvgMs: 500,
    strafePauseAvgMs: 400,
    strafeVariation: 0,
    rng: () => 0.5,
  });
  assertExists(afterStrafe.combat);
  assertEquals(afterStrafe.statePatch.targetEnemyStrafePhase, "pause");
  assertEquals(afterStrafe.statePatch.targetEnemyStrafeDepth, undefined);
  assertEquals(afterStrafe.combat!.forward, false);
  assertEquals(afterStrafe.combat!.backward, false);
  assertEquals(afterStrafe.combat!.left, false);
  assertEquals(afterStrafe.combat!.right, false);
});

// ---------------------------------------------------------------------------
// Aim lead (sticky future-position extrapolation)
// ---------------------------------------------------------------------------

Deno.test("extrapolateCombatAim: identity at zero lead / zero vel", () => {
  const aim = { x: 1, y: 2, z: 3 };
  assertEquals(
    extrapolateCombatAim(aim, { vx: 0, vy: 0, vz: 0 }, TARGET_ENEMY_LEAD_SEC),
    aim,
  );
  assertEquals(
    extrapolateCombatAim(aim, { vx: 10, vy: 0, vz: 0 }, 0),
    aim,
  );
});

Deno.test("extrapolateCombatAim: straight-line lead", () => {
  const led = extrapolateCombatAim(
    { x: 0, y: 1, z: -8 },
    { vx: 6, vy: 0, vz: 0 },
    0.15,
  );
  assertAlmostEquals(led.x, 0.9, 1e-9);
  assertAlmostEquals(led.y, 1, 1e-9);
  assertAlmostEquals(led.z, -8, 1e-9);
});

Deno.test("clampLeadVelocity: caps sprint-scale teleports", () => {
  const raw = clampLeadVelocity(100, 0);
  assertAlmostEquals(raw.vx, TARGET_ENEMY_LEAD_MAX_SPEED, 1e-9);
  assertAlmostEquals(raw.vz, 0, 1e-9);
});

Deno.test("estimateStickyTargetVelocity: new lock seeds zero vel", () => {
  const enemy = makeBot("enemy:1", "B", 2, -8, Math.PI);
  const { vel, samplePatch } = estimateStickyTargetVelocity(
    {},
    enemy,
    true,
  );
  assertEquals(vel.vx, 0);
  assertEquals(vel.vz, 0);
  assertEquals(samplePatch.targetEnemySampleX, 2);
  assertEquals(samplePatch.targetEnemySampleZ, -8);
  assertEquals(samplePatch.targetEnemyVx, 0);
});

Deno.test("estimateStickyTargetVelocity: sticky samples → EMA velocity", () => {
  const enemy = makeBot("enemy:1", "B", 3, -8, Math.PI);
  // Prior sample at x=2 one bot-tick ago → +1u / 0.05s = 20 u/s → clamp, then EMA from 0.
  const { vel, samplePatch } = estimateStickyTargetVelocity(
    { targetEnemySampleX: 2, targetEnemySampleZ: -8 },
    enemy,
    false,
  );
  const a = leadEmaAlpha();
  assertAlmostEquals(vel.vx, a * TARGET_ENEMY_LEAD_MAX_SPEED, 1e-6);
  assertAlmostEquals(vel.vz, 0, 1e-6);
  assertEquals(samplePatch.targetEnemySampleX, 3);
  assertAlmostEquals(
    samplePatch.targetEnemyVx!,
    a * TARGET_ENEMY_LEAD_MAX_SPEED,
    1e-6,
  );

  // Mild strafe: +0.3u per bot tick → 6 u/s instant → EMA from 0.
  const mild = makeBot("enemy:2", "B", 0.3, -8, Math.PI);
  const mildVel = estimateStickyTargetVelocity(
    { targetEnemySampleX: 0, targetEnemySampleZ: -8 },
    mild,
    false,
  );
  const inst = 0.3 / TARGET_ENEMY_SAMPLE_DT_SEC;
  assertAlmostEquals(mildVel.vel.vx, a * inst, 1e-6);
});

Deno.test("stepTargetEnemy: new lock aims at current body (no lead)", () => {
  clearCombatLosCache();
  const col = new MapCollision(openMap());
  const me = makeBot("bot:1", "A", 0, 0, 0);
  const enemy = makeBot("enemy:1", "B", 0, -8, Math.PI);
  const result = stepTargetEnemy({
    self: me,
    players: [me, enemy],
    collision: col,
    worldMoveYaw: 0,
    state: {},
    standGroundChance: 0,
  });
  assertExists(result.combat);
  const pure = yawToward(me.x, me.z, enemy.x, enemy.z);
  assertAlmostEquals(result.combat!.lookYaw, pure, 1e-6);
  assertEquals(result.statePatch.targetEnemySampleX, enemy.x);
  assertEquals(result.statePatch.targetEnemyVx, 0);
});

Deno.test("stepTargetEnemy: sticky mover leads look ahead of body", () => {
  clearCombatLosCache();
  const col = new MapCollision(openMap());
  const me = makeBot("bot:1", "A", 0, 0, 0);
  // Enemy at (+0.3, -8): strafe +x vs prior sample at (0, -8).
  const enemy = makeBot("enemy:1", "B", 0.3, -8, Math.PI);
  const pureYaw = yawToward(me.x, me.z, enemy.x, enemy.z);

  const result = stepTargetEnemy({
    self: me,
    players: [me, enemy],
    collision: col,
    worldMoveYaw: 0,
    state: {
      [TARGET_ENEMY_STATE_KEY]: "enemy:1",
      targetEnemyStandGround: false,
      targetEnemySampleX: 0,
      targetEnemySampleZ: -8,
    },
    standGroundChance: 0,
  });
  assertExists(result.combat);
  // Lead should push look toward +x (game: −yaw is right when facing −z).
  // Bearing to body is slightly right of −z; lead further right → more negative yaw.
  assert(
    result.combat!.lookYaw < pureYaw - 1e-4,
    `expected lead yaw ${result.combat!.lookYaw} < pure ${pureYaw}`,
  );
  const inst = 0.3 / TARGET_ENEMY_SAMPLE_DT_SEC;
  const vx = emaLeadVelocity(0, 0, inst, 0).vx;
  const expectedLedX = enemy.x + vx * TARGET_ENEMY_LEAD_SEC;
  const expectedYaw = yawToward(me.x, me.z, expectedLedX, enemy.z);
  assertAlmostEquals(result.combat!.lookYaw, expectedYaw, 1e-4);
  assertAlmostEquals(result.statePatch.targetEnemyVx!, vx, 1e-6);
});

Deno.test("stepTargetEnemy: unlock clears lead samples", () => {
  clearCombatLosCache();
  const col = new MapCollision(openMap());
  const me = makeBot("bot:1", "A", 0, 0, 0);
  const enemy = makeBot("enemy:1", "B", 0, -8, Math.PI);
  enemy.alive = false;
  const unlocked = stepTargetEnemy({
    self: me,
    players: [me, enemy],
    collision: col,
    worldMoveYaw: 0,
    state: {
      [TARGET_ENEMY_STATE_KEY]: "enemy:1",
      targetEnemySampleX: 0,
      targetEnemySampleZ: -8,
      targetEnemyVx: 6,
    },
    standGroundChance: 0,
  });
  assertEquals(unlocked.combat, null);
  assertEquals(unlocked.statePatch.targetEnemySampleX, undefined);
  assertEquals(unlocked.statePatch.targetEnemyVx, undefined);
});

Deno.test("combatAimForClick: leads preferred sticky id", () => {
  clearCombatLosCache();
  const col = new MapCollision(openMap());
  const me = makeBot("bot:1", "A", 0, 0, 0);
  const enemy = makeBot("enemy:1", "B", 0, -8, Math.PI);
  const live = combatAimForClick(me, enemy, col, {
    [TARGET_ENEMY_STATE_KEY]: "enemy:1",
    targetEnemyVx: 6,
    targetEnemyVz: 0,
    targetEnemyVy: 0,
  });
  assertExists(live);
  assertAlmostEquals(live!.x, 6 * TARGET_ENEMY_LEAD_SEC, 1e-6);
  // Wrong / missing sticky → no lead.
  const raw = combatAimForClick(me, enemy, col, {
    [TARGET_ENEMY_STATE_KEY]: "other",
    targetEnemyVx: 6,
  });
  assertExists(raw);
  assertAlmostEquals(raw!.x, enemy.x, 1e-6);
});

Deno.test("shouldSeparateFromTarget: start inside minSeparation, hold through slack", () => {
  assertEquals(shouldSeparateFromTarget(1.0, 2.0, false), true);
  assertEquals(shouldSeparateFromTarget(2.1, 2.0, false), false);
  assertEquals(
    shouldSeparateFromTarget(2.0 + MIN_SEPARATION_HYSTERESIS * 0.5, 2.0, true),
    true,
  );
  assertEquals(
    shouldSeparateFromTarget(2.0 + MIN_SEPARATION_HYSTERESIS + 0.05, 2.0, true),
    false,
  );
  assertEquals(shouldSeparateFromTarget(0.5, 0, false), false);
});

Deno.test("stepTargetEnemy: minSeparation plants S when face-hugging", () => {
  clearCombatLosCache();
  const col = new MapCollision(openMap());
  const me = makeBot("bot:1", "A", 0, 0, 0);
  const enemy = makeBot("enemy:1", "B", 0, -0.8, Math.PI);
  const result = stepTargetEnemy({
    self: me,
    players: [me, enemy],
    collision: col,
    worldMoveYaw: 0,
    state: {},
    standGroundChance: 1,
    strafeAvgMs: 0,
    minSeparation: 2.0,
    rng: () => 0,
  });
  assertExists(result.combat);
  assertEquals(result.combat!.forward, false);
  assertEquals(result.combat!.backward, true);
  assertEquals(result.statePatch.targetEnemySeparating, true);
});

Deno.test("stepTargetEnemy: minSeparation does not back off at range", () => {
  clearCombatLosCache();
  const col = new MapCollision(openMap());
  const me = makeBot("bot:1", "A", 0, 0, 0);
  const enemy = makeBot("enemy:1", "B", 0, -8, Math.PI);
  const result = stepTargetEnemy({
    self: me,
    players: [me, enemy],
    collision: col,
    worldMoveYaw: 0,
    state: {},
    standGroundChance: 1,
    strafeAvgMs: 0,
    minSeparation: 2.0,
    rng: () => 0,
  });
  assertExists(result.combat);
  assertEquals(result.combat!.backward, false);
  assertEquals(result.statePatch.targetEnemySeparating, undefined);
});

Deno.test("stepTargetEnemy: leadSec 0 aims at live body", () => {
  clearCombatLosCache();
  const col = new MapCollision(openMap());
  const me = makeBot("bot:1", "A", 0, 0, 0);
  const enemy = makeBot("enemy:1", "B", 0.3, -8, Math.PI);
  const result = stepTargetEnemy({
    self: me,
    players: [me, enemy],
    collision: col,
    worldMoveYaw: 0,
    state: {
      [TARGET_ENEMY_STATE_KEY]: "enemy:1",
      targetEnemyStandGround: false,
      targetEnemySampleX: 0,
      targetEnemySampleZ: -8,
    },
    standGroundChance: 0,
    leadSec: 0,
  });
  assertExists(result.combat);
  const pureYaw = yawToward(me.x, me.z, enemy.x, enemy.z);
  assertAlmostEquals(result.combat!.lookYaw, pureYaw, 1e-6);
});

Deno.test("applyCombatLead: rejects lead with no LOS", () => {
  const col = new MapCollision(wallMap());
  const eye = { x: 0, y: 1.7, z: -4 };
  const aim = { x: 0, y: 1.7, z: -1 };
  const led = applyCombatLead(
    eye,
    aim,
    { vx: 0, vy: 0, vz: 20 },
    0.15,
    col,
  );
  assertEquals(led.x, aim.x);
  assertEquals(led.z, aim.z);
});

Deno.test("scoreHostileThreat: wounded beats equal-range healthy", () => {
  const self = { x: 0, z: 0 };
  const healthy = { x: 0, z: -8, health: 100, lastShotAtTick: -1e9 };
  const wounded = { x: 0, z: -8, health: 20, lastShotAtTick: -1e9 };
  assert(
    scoreHostileThreat(self, wounded, 8) >
      scoreHostileThreat(self, healthy, 8),
  );
});

Deno.test("pickTargetEnemy: wounded slightly farther beats healthy nearer", () => {
  clearCombatLosCache();
  const col = new MapCollision(openMap());
  const me = makeBot("bot:1", "A", 0, 0, 0);
  const near = makeBot("enemy:near", "B", 0, -8, Math.PI);
  near.health = 100;
  const far = makeBot("enemy:far", "B", 0, -10, Math.PI);
  far.health = 20;
  const picked = pickTargetEnemy(me, [me, near, far], col, undefined);
  assertExists(picked);
  assertEquals(picked!.player.id, "enemy:far");
});

Deno.test("pickTargetEnemy: sticky holds against a slightly better fresh lock", () => {
  clearCombatLosCache();
  const col = new MapCollision(openMap());
  const me = makeBot("bot:1", "A", 0, 0, 0);
  const sticky = makeBot("enemy:sticky", "B", 0, -10, Math.PI);
  sticky.health = 100;
  const near = makeBot("enemy:near", "B", 0, -8, Math.PI);
  near.health = 100;
  const picked = pickTargetEnemy(
    me,
    [me, sticky, near],
    col,
    "enemy:sticky",
  );
  assertExists(picked);
  assertEquals(picked!.player.id, "enemy:sticky");
});
