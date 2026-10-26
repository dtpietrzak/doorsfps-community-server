/**
 * Look interpolation between 20 Hz bot ready actions for 60 Hz apply.
 *
 * Discrete keys (WASD/jump/…) hold from the current ReadyAction.
 * Look plays the action's per-sim-tick `lookSamples` (think steps the mouse
 * motor at sim rate); without samples, yaw/pitch lerp from the previous ready
 * look to the current over one bot period.
 * Shoot/reload are edge-only (first sim tick of a newly due slot).
 */

import { SIM_TICKS_PER_BOT_TICK } from "../types.ts";
import type { BotApplyInterp, BotLookSample } from "../types.ts";
import type { ReadyAction } from "./types.ts";

/** Signed shortest yaw delta in (−π, π]. */
export function yawSignedDelta(from: number, to: number): number {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d <= -Math.PI) d += Math.PI * 2;
  return d;
}

/** Shortest-path yaw lerp. */
export function lerpAngle(from: number, to: number, t: number): number {
  const u = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return from + yawSignedDelta(from, to) * u;
}

export function lerpPitch(from: number, to: number, t: number): number {
  const u = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return from + (to - from) * u;
}

/**
 * Progress 0…1 through the bot period starting at `startSimTick`.
 * Uses (elapsed+1)/N so the last sim tick of the period reaches 1.
 */
export function botInterpAlpha(
  simTick: number,
  startSimTick: number,
  period: number = SIM_TICKS_PER_BOT_TICK,
): number {
  if (!(period > 0)) return 1;
  const elapsed = simTick - startSimTick;
  if (elapsed < 0) return 0;
  return Math.min(1, (elapsed + 1) / period);
}

/** Look sample for interp endpoints. */
export type LookSample = BotLookSample;

/**
 * Look for `simTick` from the slot's samples: sample k on the k-th sim tick
 * since release, holding the last. Null when the slot has no samples.
 */
export function lookFromSamples(
  samples: readonly LookSample[] | undefined,
  simTick: number,
  startSimTick: number,
): LookSample | null {
  if (!samples || samples.length === 0) return null;
  const elapsed = simTick - startSimTick;
  const index = elapsed <= 0
    ? 0
    : elapsed >= samples.length
    ? samples.length - 1
    : elapsed;
  return samples[index]!;
}

export function lookFromAction(
  action: ReadyAction | null | undefined,
  fallback: LookSample,
): LookSample {
  const input = action?.input;
  if (!input) return fallback;
  return {
    yaw: typeof input.yaw === "number" ? input.yaw : fallback.yaw,
    pitch: typeof input.pitch === "number" ? input.pitch : fallback.pitch,
  };
}

/**
 * Build the ReadyAction to feed the apply pipe this sim tick.
 * - Discrete keys from `interp.curr`
 * - Look from `curr.lookSamples` for this tick, else lerped prev → curr
 * - Shoot/reload only when `!interp.combatEdgeDone` (caller marks done after)
 */
export function buildInterpolatedReadyAction(
  interp: BotApplyInterp,
  simTick: number,
): ReadyAction {
  const curr = interp.curr;
  const sampled = curr.input
    ? lookFromSamples(curr.lookSamples, simTick, interp.startSimTick)
    : null;
  let yaw: number;
  let pitch: number;
  if (sampled) {
    yaw = sampled.yaw;
    pitch = sampled.pitch;
  } else {
    const alpha = botInterpAlpha(simTick, interp.startSimTick);
    const to = lookFromAction(curr, {
      yaw: interp.prevYaw,
      pitch: interp.prevPitch,
    });
    yaw = lerpAngle(interp.prevYaw, to.yaw, alpha);
    pitch = lerpPitch(interp.prevPitch, to.pitch, alpha);
  }

  const input = curr.input
    ? {
      ...curr.input,
      yaw,
      pitch,
    }
    : null;

  const onCombatEdge = !interp.combatEdgeDone;
  return {
    input,
    shoot: onCombatEdge ? curr.shoot : false,
    reload: onCombatEdge ? curr.reload : false,
    weapon: onCombatEdge ? curr.weapon : undefined,
    ability: onCombatEdge ? curr.ability : undefined,
    ...(curr.observedTick === undefined
      ? {}
      : { observedTick: curr.observedTick }),
  };
}

/** Start a new interp segment when a ReadyAction becomes due. */
export function beginApplyInterp(
  prev: LookSample,
  curr: ReadyAction,
  startSimTick: number,
): BotApplyInterp {
  return {
    prevYaw: prev.yaw,
    prevPitch: prev.pitch,
    curr,
    startSimTick,
    combatEdgeDone: false,
  };
}
