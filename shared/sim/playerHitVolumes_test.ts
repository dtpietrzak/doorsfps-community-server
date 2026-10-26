/**
 * Head/body overlap resolution for hitscan.
 *
 * Run with: deno test -A shared/sim/playerHitVolumes_test.ts
 */
import {
  assertAlmostEquals,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  getPlayerHitVolumes,
  hitPlayerVolumes,
  playerHitAnimation,
  playerLandingHitAmount,
  rayHitVolume,
  type HitVec3,
  type HitVolume,
} from "./playerHitVolumes.ts";
import { MOVE_CROUCH_EYE, MOVE_JUMP_VELOCITY } from "./moveStep.ts";
import { PLAYER_CROUCH_HEAD_TOP_Y } from "./playerModelDimensions.ts";

const origin: HitVec3 = { x: 0, y: 0, z: 10 };
const dir: HitVec3 = { x: 0, y: 0, z: -1 };
const RANGE = 100;

function sphere(center: HitVec3, radius: number): HitVolume {
  return {
    center,
    xAxis: { x: radius, y: 0, z: 0 },
    yAxis: { x: 0, y: radius, z: 0 },
    zAxis: { x: 0, y: 0, z: radius },
  };
}

function cylinder(center: HitVec3, radius: number, halfHeight: number): HitVolume {
  return {
    center,
    xAxis: { x: radius, y: 0, z: 0 },
    yAxis: { x: 0, y: halfHeight, z: 0 },
    zAxis: { x: 0, y: 0, z: radius },
  };
}

function hit(head: HitVolume, body: HitVolume) {
  return hitPlayerVolumes(origin, dir, RANGE, { head, body });
}

Deno.test("body in front of head is still a headshot at first contact", () => {
  const head = sphere({ x: 0, y: 0, z: -2 }, 0.4);
  const body = cylinder({ x: 0, y: 0, z: 0 }, 0.5, 1);
  const bodyT = rayHitVolume(origin, dir, body, "body", RANGE);
  const headT = rayHitVolume(origin, dir, head, "head", RANGE);
  const result = hit(head, body);
  assertEquals(bodyT !== null && headT !== null && bodyT < headT, true);
  assertEquals(result?.zone, "head");
  assertAlmostEquals(result!.distance, bodyT!, 1e-9);
});

Deno.test("head in front of body is a headshot at the head surface", () => {
  const head = sphere({ x: 0, y: 0, z: 0 }, 0.3);
  const body = cylinder({ x: 0, y: 0, z: -3 }, 0.5, 1);
  const headT = rayHitVolume(origin, dir, head, "head", RANGE);
  const result = hit(head, body);
  assertEquals(result?.zone, "head");
  assertAlmostEquals(result!.distance, headT!, 1e-9);
});

Deno.test("body only is a body shot", () => {
  const head = sphere({ x: 2, y: 0, z: 0 }, 0.3);
  const body = cylinder({ x: 0, y: 0, z: 0 }, 0.5, 1);
  const bodyT = rayHitVolume(origin, dir, body, "body", RANGE);
  const result = hit(head, body);
  assertEquals(result?.zone, "body");
  assertAlmostEquals(result!.distance, bodyT!, 1e-9);
});

Deno.test("head only is a headshot", () => {
  const head = sphere({ x: 0, y: 0, z: 0 }, 0.3);
  const body = cylinder({ x: 2, y: 0, z: 0 }, 0.5, 1);
  const headT = rayHitVolume(origin, dir, head, "head", RANGE);
  const result = hit(head, body);
  assertEquals(result?.zone, "head");
  assertAlmostEquals(result!.distance, headT!, 1e-9);
});

Deno.test("head inside the body cylinder is a headshot, not body", () => {
  const head = sphere({ x: 0, y: 0, z: 0 }, 0.5);
  const body = cylinder({ x: 0, y: 0, z: 0 }, 2, 2);
  const bodyT = rayHitVolume(origin, dir, body, "body", RANGE);
  const headT = rayHitVolume(origin, dir, head, "head", RANGE);
  const result = hit(head, body);
  assertEquals(bodyT !== null && headT !== null && bodyT < headT, true);
  assertEquals(result?.zone, "head");
  assertAlmostEquals(result!.distance, bodyT!, 1e-9);
});

Deno.test("miss both volumes", () => {
  const head = sphere({ x: 3, y: 0, z: 0 }, 0.3);
  const body = cylinder({ x: -3, y: 0, z: 0 }, 0.5, 1);
  assertEquals(hit(head, body), null);
});

Deno.test("locomotion hit pose follows walk, sprint, and strafe layers", () => {
  const walk = playerHitAnimation({
    x: 0,
    y: 1.7,
    z: 0,
    yaw: 0,
    velocityX: 0,
    velocityY: 0,
    velocityZ: -6,
    onGround: true,
  });
  assertAlmostEquals(walk.upperPitch, -0.025, 1e-9);
  assertAlmostEquals(walk.rootPitch, 0, 1e-9);
  assertEquals(walk.gaitReach > 0.32, true);

  const sprint = playerHitAnimation({
    x: 0,
    y: 1.7,
    z: 0,
    yaw: 0,
    velocityX: 0,
    velocityY: 0,
    velocityZ: -9,
    onGround: true,
  });
  assertAlmostEquals(sprint.rootPitch, -0.105, 1e-9);
  assertAlmostEquals(sprint.upperPitch, 0, 1e-9);
  assertEquals(sprint.gaitReach > walk.gaitReach, true);

  const strafe = playerHitAnimation({
    x: 0,
    y: 1.7,
    z: 0,
    yaw: 0,
    velocityX: 6,
    velocityY: 0,
    velocityZ: 0,
    onGround: true,
  });
  assertAlmostEquals(strafe.upperRoll, -0.035, 1e-9);
  assertAlmostEquals(strafe.rootRoll, 0, 1e-9);
});

Deno.test("crouched rest head top stays at 1.0 under half-walls", () => {
  const volumes = getPlayerHitVolumes({
    x: 0,
    y: MOVE_CROUCH_EYE,
    z: 0,
    crouch: true,
  });
  const top = volumes.head.center.y + Math.abs(volumes.head.yAxis.y);
  assertEquals(top <= PLAYER_CROUCH_HEAD_TOP_Y + 1e-4, true);
  assertEquals(top > PLAYER_CROUCH_HEAD_TOP_Y - 0.08, true);
});

Deno.test("jump and landing compression move the shared head volume", () => {
  const rest = getPlayerHitVolumes({ x: 0, y: 1.7, z: 0 });
  const takeoffPose = {
    x: 0,
    y: 1.7,
    z: 0,
    velocityY: MOVE_JUMP_VELOCITY,
    onGround: false,
  };
  const takeoffAnimation = playerHitAnimation(takeoffPose);
  assertAlmostEquals(takeoffAnimation.crouchAmount, 0.5, 1e-9);
  const takeoff = getPlayerHitVolumes(takeoffPose);
  assertEquals(takeoff.head.center.y < rest.head.center.y - 0.2, true);

  assertAlmostEquals(playerLandingHitAmount(0), 0.5, 1e-9);
  assertEquals(playerLandingHitAmount(0.09) > 0, true);
  assertAlmostEquals(playerLandingHitAmount(0.18), 0, 1e-9);
  const landed = getPlayerHitVolumes({
    x: 0,
    y: 1.7,
    z: 0,
    onGround: true,
    landingAmount: 0.5,
  });
  assertEquals(landed.head.center.y < rest.head.center.y - 0.2, true);
});

Deno.test("explicit preview transforms override derived locomotion lean", () => {
  const animation = playerHitAnimation({
    x: 0,
    y: 1.7,
    z: 0,
    velocityZ: -9,
    onGround: true,
    rootPitch: 0.2,
    rootRoll: -0.1,
    upperPitch: 0.15,
    upperRoll: 0.08,
    rigOffset: { x: 1, y: 2, z: 3 },
  });
  assertAlmostEquals(animation.rootPitch, 0.2, 1e-9);
  assertAlmostEquals(animation.rootRoll, -0.1, 1e-9);
  assertAlmostEquals(animation.upperPitch, 0.15, 1e-9);
  assertAlmostEquals(animation.upperRoll, 0.08, 1e-9);
  assertEquals(animation.rigOffset, { x: 1, y: 2, z: 3 });
});
