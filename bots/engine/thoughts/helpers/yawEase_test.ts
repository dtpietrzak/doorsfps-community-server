import { assertAlmostEquals, assertEquals, assertLess } from "@std/assert";
import {
  BOT_YAW_180_TURN_SEC,
  BOT_YAW_EASE_DT,
  BOT_YAW_LOOK_TAU_SEC,
  BOT_YAW_NAV_TAU_SEC,
  BOT_YAW_TAU_SEC,
  type BotYawEaseState,
  stepBotYawEase,
  stepYawIntent,
  YAW_INTENT_STATE_KEY,
  yawSignedDelta,
} from "./yawEase.ts";

Deno.test("yawSignedDelta wraps across ±π", () => {
  assertAlmostEquals(
    yawSignedDelta(3, -3),
    yawSignedDelta(3, -3 + Math.PI * 2),
    1e-12,
  );
  assertLess(Math.abs(yawSignedDelta(Math.PI - 0.1, -Math.PI + 0.1)), 0.25);
});

Deno.test("stepBotYawEase: settles near target within ~3τ", () => {
  const state: BotYawEaseState = {};
  const start = 0;
  const goal = Math.PI;
  const dt = BOT_YAW_EASE_DT;
  const ticks = Math.ceil(BOT_YAW_180_TURN_SEC / dt);

  let yaw = start;
  for (let i = 0; i < ticks; i++) {
    yaw = stepBotYawEase(state, yaw, goal, dt, BOT_YAW_LOOK_TAU_SEC);
  }
  // 3τ leaves ~5% residual for a step input; allow a bit of slack.
  assertLess(Math.abs(yawSignedDelta(yaw, goal)), 0.2);
});

Deno.test("stepBotYawEase: monotonic toward a fixed goal (no reverse)", () => {
  const state: BotYawEaseState = {};
  const goal = 1.2;
  const dt = BOT_YAW_EASE_DT;
  let yaw = 0;
  let prevRem = Math.abs(yawSignedDelta(yaw, goal));
  for (let i = 0; i < 60; i++) {
    yaw = stepBotYawEase(state, yaw, goal, dt);
    const rem = Math.abs(yawSignedDelta(yaw, goal));
    assertEquals(rem <= prevRem + 1e-12, true);
    prevRem = rem;
  }
});

Deno.test("stepBotYawEase: already on target holds", () => {
  const state: BotYawEaseState = {};
  const out = stepBotYawEase(state, 0.5, 0.5, BOT_YAW_EASE_DT);
  assertEquals(out, 0.5);
});

Deno.test("stepBotYawEase: larger τ moves less per tick", () => {
  const dt = BOT_YAW_EASE_DT;
  const goal = 1.0;
  const a = stepBotYawEase({}, 0, goal, dt, BOT_YAW_LOOK_TAU_SEC);
  const b = stepBotYawEase({}, 0, goal, dt, BOT_YAW_LOOK_TAU_SEC * 3);
  assertLess(Math.abs(b), Math.abs(a));
});

Deno.test("stepBotYawEase: nav τ is heavier than look τ", () => {
  const dt = BOT_YAW_EASE_DT;
  const goal = 1.0;
  const look = stepBotYawEase({}, 0, goal, dt, BOT_YAW_LOOK_TAU_SEC);
  const nav = stepBotYawEase({}, 0, goal, dt, BOT_YAW_NAV_TAU_SEC);
  assertLess(Math.abs(nav), Math.abs(look));
  assertEquals(BOT_YAW_TAU_SEC, BOT_YAW_LOOK_TAU_SEC);
  assertEquals(BOT_YAW_NAV_TAU_SEC > BOT_YAW_LOOK_TAU_SEC, true);
});

Deno.test("stepBotYawEase: jittery desired is damped on nav channel", () => {
  // Nav τ is the thrash damper; look τ is intentionally snappy.
  const state: BotYawEaseState = {};
  const dt = BOT_YAW_EASE_DT;
  const center = 0.8;
  let yaw = 0;
  for (let i = 0; i < 90; i++) {
    yaw = stepBotYawEase(state, yaw, center, dt, BOT_YAW_NAV_TAU_SEC);
  }

  let maxAbsStep = 0;
  for (let i = 0; i < 40; i++) {
    const desired = center + (i % 2 === 0 ? 0.08 : -0.08);
    const prev = yaw;
    yaw = stepBotYawEase(state, yaw, desired, dt, BOT_YAW_NAV_TAU_SEC);
    maxAbsStep = Math.max(maxAbsStep, Math.abs(yawSignedDelta(prev, yaw)));
  }

  // α ≈ 1−e^(−dt/0.15) ≈ 0.1 → steps well under the ±0.08 jitter.
  assertLess(maxAbsStep, 0.04);
  assertLess(Math.abs(yawSignedDelta(center, yaw)), 0.15);
});

Deno.test("stepYawIntent: pass-through stores raw desired", () => {
  const state: Record<string, unknown> = {};
  const raw = 1.25;
  const out = stepYawIntent(state, raw, BOT_YAW_EASE_DT);
  assertEquals(out, raw);
  assertEquals(state[YAW_INTENT_STATE_KEY], raw);
});

Deno.test("stepYawIntent: retarget is pass-through (no pre-target low-pass)", () => {
  const state: Record<string, unknown> = {};
  const a = 0;
  const b = 1.0;
  const dt = BOT_YAW_EASE_DT;
  stepYawIntent(state, a, dt);
  const next = stepYawIntent(state, b, dt);
  // No smoothing: intent jumps to the new raw desired immediately.
  assertEquals(next, b);
  assertEquals(state[YAW_INTENT_STATE_KEY], b);
});
