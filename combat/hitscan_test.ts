import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { headHitOffsetFromFeet } from "../shared/sim/aimPitchVisual.ts";
import {
  BODY_RADIUS,
  directionFromYawPitch,
  HEAD_RADIUS,
  hitscanPoses,
  normalize,
  PLAYER_EYE_HEIGHT,
  CROUCH_EYE_HEIGHT,
} from "./hitscan.ts";

Deno.test("directionFromYawPitch matches look-forward at zero", () => {
  const d = normalize(directionFromYawPitch(0, 0));
  assertEquals(Math.abs(d.x) < 1e-9, true);
  assertEquals(Math.abs(d.y) < 1e-9, true);
  assertEquals(Math.abs(d.z + 1) < 1e-9, true);
});

Deno.test("hitscan center-mass at eye height hits head (head covers eyes)", () => {
  // Level ray at eye Y intersects the head sphere first (correct geometry).
  const origin = { x: 0, y: PLAYER_EYE_HEIGHT, z: 0 };
  const dir = directionFromYawPitch(0, 0);
  const target = {
    playerId: "t1",
    pose: { x: 0, y: PLAYER_EYE_HEIGHT, z: -5 },
  };
  const hit = hitscanPoses(origin, dir, 80, [target]);
  assertExists(hit);
  assertEquals(hit!.playerId, "t1");
  assertEquals(hit!.zone, "head");
  assertEquals(hit!.distance > 4 && hit!.distance < 6, true);
});

Deno.test("hitscan body hit when aiming at torso", () => {
  const origin = { x: 0, y: PLAYER_EYE_HEIGHT, z: 0 };
  const targetPose = { x: 0, y: PLAYER_EYE_HEIGHT, z: -5 };
  const feetY = targetPose.y - PLAYER_EYE_HEIGHT;
  const torsoY = feetY + 0.9;
  const dir = normalize({
    x: 0,
    y: torsoY - origin.y,
    z: -5,
  });
  const hit = hitscanPoses(origin, dir, 80, [
    { playerId: "t1", pose: targetPose },
  ]);
  assertExists(hit);
  assertEquals(hit!.zone, "body");
});

Deno.test("hitscan headshot looking up at head center", () => {
  // Head center is at visor height; pose y is eye height, so a level shot
  // at PLAYER_EYE_HEIGHT already aims at the visor. Aiming at the authored
  // head landmark still hits the enlarged helmet.
  const origin = { x: 0, y: PLAYER_EYE_HEIGHT, z: 0 };
  const targetPose = { x: 0, y: PLAYER_EYE_HEIGHT, z: -5 };
  const feetY = targetPose.y - PLAYER_EYE_HEIGHT;
  const headY = feetY + 1.55;
  // Aim from origin to head center
  const dx = 0 - origin.x;
  const dy = headY - origin.y;
  const dz = -5 - origin.z;
  const dir = normalize({ x: dx, y: dy, z: dz });
  const hit = hitscanPoses(origin, dir, 80, [
    { playerId: "t1", pose: targetPose },
  ]);
  assertExists(hit);
  assertEquals(hit!.zone, "head");
});

Deno.test("hitscan miss when aiming past body radius", () => {
  const origin = { x: 0, y: PLAYER_EYE_HEIGHT, z: 0 };
  const dir = directionFromYawPitch(0, 0);
  // Offset target in X beyond body radius so the -Z ray misses
  const offset = BODY_RADIUS + 0.15;
  const hit = hitscanPoses(origin, dir, 80, [
    {
      playerId: "t1",
      pose: { x: offset, y: PLAYER_EYE_HEIGHT, z: -5 },
    },
  ]);
  assertEquals(hit, null);
});

Deno.test("hitscan registers near edge of body radius at torso height", () => {
  const origin = { x: 0, y: PLAYER_EYE_HEIGHT, z: 0 };
  const offset = BODY_RADIUS - 0.02;
  const targetPose = { x: offset, y: PLAYER_EYE_HEIGHT, z: -5 };
  const feetY = targetPose.y - PLAYER_EYE_HEIGHT;
  const torsoY = feetY + 0.9;
  const dir = normalize({
    x: offset - origin.x,
    y: torsoY - origin.y,
    z: -5,
  });
  const hit = hitscanPoses(origin, dir, 80, [
    { playerId: "t1", pose: targetPose },
  ]);
  assertExists(hit);
  assertEquals(hit!.zone, "body");
});

Deno.test("scaled raid boss uses the enlarged authoritative hit volume", () => {
  const scale = 1.15;
  const origin = { x: 0, y: 1.55 * scale, z: 0 };
  const dir = directionFromYawPitch(0, 0);
  const pose = {
    x: HEAD_RADIUS + 0.02,
    y: PLAYER_EYE_HEIGHT,
    z: -5,
  };
  assertEquals(
    hitscanPoses(origin, dir, 80, [{ playerId: "normal", pose }]),
    null,
  );
  const bossHit = hitscanPoses(origin, dir, 80, [{
    playerId: "boss",
    pose: { ...pose, scale },
  }]);
  assertExists(bossHit);
  assertEquals(bossHit.zone, "head");
});

Deno.test("hitscan closest of two targets wins", () => {
  const origin = { x: 0, y: PLAYER_EYE_HEIGHT, z: 0 };
  const dir = directionFromYawPitch(0, 0);
  const hit = hitscanPoses(origin, dir, 80, [
    { playerId: "far", pose: { x: 0, y: PLAYER_EYE_HEIGHT, z: -10 } },
    { playerId: "near", pose: { x: 0, y: PLAYER_EYE_HEIGHT, z: -4 } },
  ]);
  assertExists(hit);
  assertEquals(hit!.playerId, "near");
});

Deno.test("near body still blocks a farther head — no ghosting through players", () => {
  const origin = { x: 0, y: PLAYER_EYE_HEIGHT, z: 0 };
  const nearPose = { x: 0, y: PLAYER_EYE_HEIGHT, z: -4 };
  const feetY = nearPose.y - PLAYER_EYE_HEIGHT;
  const torsoY = feetY + 0.9;
  const dir = normalize({
    x: 0,
    y: torsoY - origin.y,
    z: -4,
  });
  const farZ = -8;
  const tFar = (farZ - origin.z) / dir.z;
  const off = headHitOffsetFromFeet({ yaw: 0, pitch: 0 });
  const farPose = {
    x: origin.x + dir.x * tFar - off.x,
    y: origin.y + dir.y * tFar + PLAYER_EYE_HEIGHT - off.y,
    z: origin.z + dir.z * tFar - off.z,
  };
  const farOnly = hitscanPoses(origin, dir, 80, [
    { playerId: "far", pose: farPose },
  ]);
  assertExists(farOnly);
  assertEquals(farOnly!.zone, "head");
  const nearOnly = hitscanPoses(origin, dir, 80, [
    { playerId: "near", pose: nearPose },
  ]);
  assertExists(nearOnly);
  assertEquals(nearOnly!.zone, "body");
  const both = hitscanPoses(origin, dir, 80, [
    { playerId: "far", pose: farPose },
    { playerId: "near", pose: nearPose },
  ]);
  assertExists(both);
  assertEquals(both!.playerId, "near");
  assertEquals(both!.zone, "body");
});

Deno.test("near body-and-head overlap is a headshot, not the far player", () => {
  const origin = { x: 0, y: PLAYER_EYE_HEIGHT, z: 0 };
  const dir = directionFromYawPitch(0, 0);
  const hit = hitscanPoses(origin, dir, 80, [
    { playerId: "far", pose: { x: 0, y: PLAYER_EYE_HEIGHT, z: -10 } },
    { playerId: "near", pose: { x: 0, y: PLAYER_EYE_HEIGHT, z: -4 } },
  ]);
  assertExists(hit);
  assertEquals(hit!.playerId, "near");
  assertEquals(hit!.zone, "head");
});

Deno.test("HEAD_RADIUS and BODY_RADIUS are honest-ish vs mesh", () => {
  // Mesh: body 0.28, head 0.22 — pad should stay modest vs authored mesh.
  // Head includes PLAYER_HEAD_SCALE, so the ceiling sits above the raw mesh.
  assertEquals(BODY_RADIUS <= 0.35, true);
  assertEquals(HEAD_RADIUS <= 0.40, true);
  assertEquals(BODY_RADIUS >= 0.28, true);
  assertEquals(HEAD_RADIUS >= 0.22, true);
});

Deno.test("crouch head is lower — standing-height ray misses crouch target", () => {
  // Level ray at standing visor height should clear a crouched visor.
  const origin = { x: 0, y: PLAYER_EYE_HEIGHT, z: 0 };
  const dir = directionFromYawPitch(0, 0);
  const hit = hitscanPoses(origin, dir, 80, [
    {
      playerId: "duck",
      pose: { x: 0, y: CROUCH_EYE_HEIGHT, z: -5, crouch: true },
    },
  ]);
  assertEquals(hit, null);
});

Deno.test("crouch headshot aims at lowered head center", () => {
  const origin = { x: 0, y: PLAYER_EYE_HEIGHT, z: 0 };
  const targetPose = { x: 0, y: CROUCH_EYE_HEIGHT, z: -5, crouch: true };
  const headY = CROUCH_EYE_HEIGHT;
  const dir = normalize({
    x: 0,
    y: headY - origin.y,
    z: -5,
  });
  const hit = hitscanPoses(origin, dir, 80, [
    { playerId: "duck", pose: targetPose },
  ]);
  assertExists(hit);
  assertEquals(hit!.zone, "head");
});

Deno.test("crouch body hit at shortened torso", () => {
  const origin = { x: 0, y: PLAYER_EYE_HEIGHT, z: 0 };
  const targetPose = { x: 0, y: CROUCH_EYE_HEIGHT, z: -5, crouch: true };
  // Mid crouch torso ~0.45 from feet
  const torsoY = 0.45;
  const dir = normalize({
    x: 0,
    y: torsoY - origin.y,
    z: -5,
  });
  const hit = hitscanPoses(origin, dir, 80, [
    { playerId: "duck", pose: targetPose },
  ]);
  assertExists(hit);
  assertEquals(hit!.zone, "body");
});

Deno.test("looking down slides the head off the rest-pose center", () => {
  const origin = { x: 0, y: PLAYER_EYE_HEIGHT, z: 0 };
  // Face +X so looking down moves the head along −X, off the shot axis.
  const targetPose = {
    x: 0,
    y: PLAYER_EYE_HEIGHT,
    z: -5,
    yaw: Math.PI / 2,
    pitch: -40 * Math.PI / 180,
  };
  const feetY = targetPose.y - PLAYER_EYE_HEIGHT;
  // +X side of the rest sphere — a headshot if the head stayed on the spine,
  // a miss once it slides the other way (offset ≈ 0.23, radius 0.26).
  const dir = normalize({
    x: 0.20,
    y: feetY + 1.55 - origin.y,
    z: -5,
  });
  const hit = hitscanPoses(origin, dir, 80, [
    { playerId: "t1", pose: targetPose },
  ]);
  assertEquals(hit, null);
});

Deno.test("looking down: ray through the pitched head center is a headshot", () => {
  const origin = { x: 0, y: PLAYER_EYE_HEIGHT, z: 0 };
  const targetPose = {
    x: 0,
    y: PLAYER_EYE_HEIGHT,
    z: -5,
    yaw: 0,
    pitch: -40 * Math.PI / 180,
  };
  const off = headHitOffsetFromFeet({
    yaw: targetPose.yaw,
    pitch: targetPose.pitch,
  });
  const feetY = targetPose.y - PLAYER_EYE_HEIGHT;
  const dir = normalize({
    x: off.x,
    y: feetY + off.y - origin.y,
    z: -5 + off.z,
  });
  const hit = hitscanPoses(origin, dir, 80, [
    { playerId: "t1", pose: targetPose },
  ]);
  assertExists(hit);
  assertEquals(hit!.zone, "head");
});

Deno.test("equidistant targets: earlier entry wins (id-order when sorted)", () => {
  const origin = { x: 0, y: PLAYER_EYE_HEIGHT, z: 0 };
  const dir = directionFromYawPitch(0, 0);
  const pose = { x: 0, y: PLAYER_EYE_HEIGHT, z: -5 };
  // Same pose → equal distance. Ascending id order → "a" before "z".
  const sorted = hitscanPoses(origin, dir, 80, [
    { playerId: "a", pose },
    { playerId: "z", pose },
  ]);
  assertExists(sorted);
  assertEquals(sorted!.playerId, "a");

  // Reversed array → earlier entry is "z" (caller's responsibility to sort).
  const reversed = hitscanPoses(origin, dir, 80, [
    { playerId: "z", pose },
    { playerId: "a", pose },
  ]);
  assertExists(reversed);
  assertEquals(reversed!.playerId, "z");
});

Deno.test("hitscan limit truncates to the prefix of the supplied order", () => {
  const origin = { x: 0, y: PLAYER_EYE_HEIGHT, z: 0 };
  const dir = directionFromYawPitch(0, 0);
  // Only the far target is in the limit=1 prefix; near is truncated out.
  const hit = hitscanPoses(
    origin,
    dir,
    80,
    [
      { playerId: "far", pose: { x: 0, y: PLAYER_EYE_HEIGHT, z: -10 } },
      { playerId: "near", pose: { x: 0, y: PLAYER_EYE_HEIGHT, z: -4 } },
    ],
    1,
  );
  assertExists(hit);
  assertEquals(hit!.playerId, "far");
});
