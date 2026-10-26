/**
 * Shared yaw helpers for bot think motors.
 *
 * **Nav / intent** ({@link stepYawIntent}): pass-through of raw path look —
 * no pre-target low-pass. Sticky poles + the post-target look motor own
 * thrash control.
 *
 * **Look / mouse** ({@link stepBotYawHumanize} in yawHumanize.ts): planned
 * ballistic overshoot + accel/decel toward the plan target.
 * {@link BOT_YAW_LOOK_TAU_SEC} is the default responsiveness dial for that
 * motor (maps to peak speed / accel, not a low-pass τ).
 *
 * {@link stepBotYawEase} remains available as a pure first-order helper for
 * tests / legacy call sites; the live nav channel no longer uses it.
 *
 * Not used in apply — brains own all look motion.
 */

import { abs, decayAlpha, PI, TWO_PI } from "../../math/index.ts";

/**
 * Look-motor responsiveness dial (seconds). Smaller → snappier peak speed /
 * accel on the accel/decel mouse motor. Historical name kept for config.
 */
export const BOT_YAW_LOOK_TAU_SEC = 0.05;

/**
 * @deprecated Nav intent is pass-through (no low-pass). Kept so tier configs
 * and call sites that still pass `yawNavTauSec` compile; ignored at runtime.
 */
export const BOT_YAW_NAV_TAU_SEC = 0.10;

/**
 * @deprecated Prefer {@link BOT_YAW_LOOK_TAU_SEC}. Alias kept for call sites
 * that still name the single historical τ.
 */
export const BOT_YAW_TAU_SEC = BOT_YAW_LOOK_TAU_SEC;

/**
 * Wall-clock seconds for a bot to mostly complete a full 180° turn under a
 * first-order ease of {@link BOT_YAW_LOOK_TAU_SEC} (≈ 3τ). Settle windows /
 * tests may size off this; the live look motor is accel/decel instead.
 */
export const BOT_YAW_180_TURN_SEC = BOT_YAW_LOOK_TAU_SEC * 3;

/** Sim dt used when the caller does not pass one (one 60 Hz simulation tick). */
export const BOT_YAW_EASE_DT = 1 / 60;

/**
 * Bot-state key for the nav-channel look intent (raw path desired yaw).
 * Cleared on death; always equals the latest raw look (pass-through).
 */
export const YAW_INTENT_STATE_KEY = "smoothedDesiredYaw" as const;

/** Arrived / dead-zone (radians). Below this, snap to target. */
const YAW_ARRIVE_EPS = 1e-4;

/** Signed shortest yaw delta from `from` to `to` in (−π, π]. */
export function yawSignedDelta(from: number, to: number): number {
  let d = to - from;
  while (d > PI) d -= TWO_PI;
  while (d <= -PI) d += TWO_PI;
  return d;
}

/**
 * Per-bot yaw helper state (opaque bag). Kept so call sites can clear the bag
 * on death without caring about fields.
 */
export type BotYawEaseState = object;

/**
 * Advance bot yaw one sim step toward `desiredYaw` with a first-order low-pass:
 *
 *   y' = y + (1 − e^(−dt/τ)) · shortestDelta(y, desired)
 *
 * Exponential smoothing is critically overdamped for a constant target (no
 * oscillation). Available as a pure helper; **live nav intent does not use
 * this** (pass-through via {@link stepYawIntent}).
 *
 * @param tauSec Time constant. ≤0 → instant snap to desired.
 * @returns Filtered yaw sample for this step.
 */
export function stepBotYawEase(
  _state: BotYawEaseState,
  currentYaw: number,
  desiredYaw: number,
  dt: number = BOT_YAW_EASE_DT,
  tauSec: number = BOT_YAW_LOOK_TAU_SEC,
): number {
  if (!(dt > 0) || !(tauSec > 0)) {
    return desiredYaw;
  }

  const remaining = yawSignedDelta(currentYaw, desiredYaw);
  if (abs(remaining) < YAW_ARRIVE_EPS) {
    return desiredYaw;
  }

  // α = 1 − e^(−dt/τ) ∈ (0, 1] — exact discrete exponential smooth.
  const alpha = decayAlpha(dt, tauSec);
  return currentYaw + remaining * alpha;
}

/**
 * Nav-channel step: **pass-through** of raw path desired yaw (no low-pass).
 *
 * Mutates `state` with the raw value under {@link YAW_INTENT_STATE_KEY}; also
 * returns it. `dt` / `tauSec` are ignored (kept for call-site compatibility).
 */
export function stepYawIntent(
  state: BotBrainYawIntentState,
  rawDesired: number,
  _dt: number = BOT_YAW_EASE_DT,
  _tauSec: number = BOT_YAW_NAV_TAU_SEC,
): number {
  state[YAW_INTENT_STATE_KEY] = rawDesired;
  return rawDesired;
}

/** Minimal bag that holds {@link YAW_INTENT_STATE_KEY}. */
export type BotBrainYawIntentState = {
  [YAW_INTENT_STATE_KEY]?: number;
};
