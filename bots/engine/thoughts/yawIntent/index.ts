/**
 * Nav-channel look intent: pass-through of raw path look (no low-pass).
 * Pole thrash / heading changes are owned by upstream sticky poles + the
 * post-target look motor (accel/decel in yawHumanize) — not a pre-filter.
 *
 * @kind impure (sub: motor)
 * Writes {@link YAW_INTENT_STATE_KEY} for bag bookkeeping. After raw look;
 * before multi-tick commits that probe along `moveYaw`.
 */

import type { HeadingDecision } from "../helpers/navLayers.ts";
import type {
  StepResult,
  ThinkContext,
  ThinkStep,
} from "../../pipeline/types.ts";
import type { BotBrainState } from "../../types.ts";
import type { YawIntentDecision } from "../helpers/types.ts";

export type YawIntentStepOpts = {
  /**
   * @deprecated Nav low-pass removed — intent is raw look. Kept so config
   * wiring stays stable; ignored.
   */
  yawNavTauSec?: number;
};

export function runYawIntentStep(
  _ctx: ThinkContext,
  prior: HeadingDecision,
  draftState: BotBrainState,
): StepResult<YawIntentDecision> {
  // No pre-target low-pass: look intent is the raw path desired.
  const desiredYaw = prior.rawLook;
  draftState.smoothedDesiredYaw = desiredYaw;
  // Planted camp: idle move yaw tracks look (navigate zeros keys).
  const moveYaw = prior.campArrived ? desiredYaw : prior.moveYaw;
  const out: YawIntentDecision = {
    target: prior.target,
    next: prior.next,
    desiredYaw,
    moveYaw,
    nudgeDir: prior.nudgeDir,
  };
  return { out };
}

export function createYawIntentStep(
  _opts: YawIntentStepOpts = {},
) {
  return {
    id: "yawIntent",
    kind: "impure",
    run: runYawIntentStep,
  } satisfies ThinkStep<HeadingDecision, YawIntentDecision>;
}
