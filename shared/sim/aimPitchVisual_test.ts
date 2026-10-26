/**
 * Spine vs arm share of third-person look pitch, and head-sphere offset.
 *
 * Run with: deno test -A shared/sim/aimPitchVisual_test.ts
 */
import {
  assertAlmostEquals,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  AIM_PITCH_LIMIT,
  BODY_AIM_PITCH_LIMIT,
  CROUCH_HEAD_CENTER_Y,
  SPINE_PIVOT_Y,
  STAND_HEAD_CENTER_Y,
  headHitOffsetFromFeet,
  splitLookAimPitch,
} from "./aimPitchVisual.ts";

const DEG = Math.PI / 180;
const LEVER = STAND_HEAD_CENTER_Y - SPINE_PIVOT_Y;

Deno.test("splitLookAimPitch: level look is zero on both", () => {
  const { body, arms } = splitLookAimPitch(0);
  assertEquals(body, 0);
  assertEquals(arms, 0);
});

Deno.test("splitLookAimPitch: under the cap, body and arms each take half", () => {
  const look = 30 * DEG;
  const { body, arms } = splitLookAimPitch(look);
  assertAlmostEquals(body, 15 * DEG, 1e-9);
  assertAlmostEquals(arms, 15 * DEG, 1e-9);
  assertAlmostEquals(body + arms, look, 1e-9);
});

Deno.test("splitLookAimPitch: looking down mirrors looking up", () => {
  const up = splitLookAimPitch(30 * DEG);
  const down = splitLookAimPitch(-30 * DEG);
  assertAlmostEquals(down.body, -up.body, 1e-9);
  assertAlmostEquals(down.arms, -up.arms, 1e-9);
});

Deno.test("splitLookAimPitch: body caps at ~20°; arms take the rest", () => {
  const look = 80 * DEG;
  const { body, arms } = splitLookAimPitch(look);
  assertAlmostEquals(body, BODY_AIM_PITCH_LIMIT, 1e-9);
  assertAlmostEquals(arms, look - BODY_AIM_PITCH_LIMIT, 1e-9);
  assertEquals(Math.abs(body) <= BODY_AIM_PITCH_LIMIT + 1e-12, true);
});

Deno.test("splitLookAimPitch: arms have no extra cap at full look", () => {
  const { body, arms } = splitLookAimPitch(AIM_PITCH_LIMIT);
  assertAlmostEquals(body, BODY_AIM_PITCH_LIMIT, 1e-9);
  assertAlmostEquals(arms, AIM_PITCH_LIMIT - BODY_AIM_PITCH_LIMIT, 1e-9);
  assertEquals(Math.abs(arms) > BODY_AIM_PITCH_LIMIT, true);
});

Deno.test("splitLookAimPitch: body + arms still equals clamped look", () => {
  for (const look of [-2, -Math.PI / 2, -50 * DEG, 0, 40 * DEG, Math.PI]) {
    const { body, arms } = splitLookAimPitch(look);
    const clamped = Math.max(-AIM_PITCH_LIMIT, Math.min(AIM_PITCH_LIMIT, look));
    assertAlmostEquals(body + arms, clamped, 1e-9);
  }
});

Deno.test("headHitOffsetFromFeet: level look stays on the spine", () => {
  const o = headHitOffsetFromFeet({ yaw: 0, pitch: 0 });
  assertAlmostEquals(o.x, 0, 1e-9);
  assertAlmostEquals(o.y, STAND_HEAD_CENTER_Y, 1e-9);
  assertAlmostEquals(o.z, 0, 1e-9);
});

Deno.test("headHitOffsetFromFeet: looking down moves the head forward (−Z)", () => {
  const o = headHitOffsetFromFeet({ yaw: 0, pitch: -40 * DEG });
  const body = splitLookAimPitch(-40 * DEG).body;
  assertAlmostEquals(o.x, 0, 1e-3);
  assertEquals(o.z < 0, true);
  assertAlmostEquals(o.z, LEVER * Math.sin(body), 1e-3);
  assertAlmostEquals(o.y, SPINE_PIVOT_Y + LEVER * Math.cos(body), 1e-3);
});

Deno.test("headHitOffsetFromFeet: looking up moves the head backward (+Z)", () => {
  const down = headHitOffsetFromFeet({ yaw: 0, pitch: -40 * DEG });
  const up = headHitOffsetFromFeet({ yaw: 0, pitch: 40 * DEG });
  assertAlmostEquals(up.x, 0, 1e-9);
  assertAlmostEquals(up.z, -down.z, 1e-9);
  assertEquals(up.z > 0, true);
  assertAlmostEquals(up.y, down.y, 1e-9);
});

Deno.test("headHitOffsetFromFeet: yaw swings the same lever around Y", () => {
  const pitch = -40 * DEG;
  const alongNegZ = headHitOffsetFromFeet({ yaw: 0, pitch });
  const alongNegX = headHitOffsetFromFeet({ yaw: Math.PI / 2, pitch });
  assertAlmostEquals(alongNegX.x, alongNegZ.z, 1e-3);
  assertAlmostEquals(alongNegX.z, 0, 1e-3);
  assertAlmostEquals(alongNegX.y, alongNegZ.y, 1e-3);
});

Deno.test("headHitOffsetFromFeet: body cap stops the head at ±20° spine", () => {
  const atCap = headHitOffsetFromFeet({ yaw: 0, pitch: 40 * DEG });
  const pastCap = headHitOffsetFromFeet({ yaw: 0, pitch: AIM_PITCH_LIMIT });
  assertAlmostEquals(atCap.x, pastCap.x, 1e-9);
  assertAlmostEquals(atCap.y, pastCap.y, 1e-9);
  assertAlmostEquals(atCap.z, pastCap.z, 1e-9);
});

Deno.test("headHitOffsetFromFeet: crouch drops height, keeps authored F/B lever", () => {
  const stand = headHitOffsetFromFeet({ yaw: 0, pitch: -40 * DEG });
  const crouch = headHitOffsetFromFeet({
    yaw: 0,
    pitch: -40 * DEG,
    crouch: true,
  });
  const scale = CROUCH_HEAD_CENTER_Y / STAND_HEAD_CENTER_Y;
  assertAlmostEquals(crouch.z, stand.z, 1e-9);
  assertAlmostEquals(crouch.y, stand.y * scale, 1e-9);
});
