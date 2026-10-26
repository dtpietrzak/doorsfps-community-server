/**
 * Planted enemy-door camp: sweep look between spawn corners via own door.
 * Pass-through otherwise.
 *
 * @kind switch
 * Latches look index / viaOwn / nextSwitchAt while planted. After pathHeading
 * (needs raw look shell); before yawIntent low-pass.
 */

import {
  type HeadingDecision,
  type HuntBrainState,
  stepDoorCampLook,
} from "../helpers/navLayers.ts";
import type {
  StepResult,
  ThinkContext,
  ThinkStep,
} from "../../pipeline/types.ts";
import type { BotBrainState } from "../../types.ts";

export type DoorCampLookStepOpts = {
  campingAnxiety: number;
  rng: () => number;
};

export function runDoorCampLookStep(
  ctx: ThinkContext,
  prior: HeadingDecision,
  draftState: BotBrainState,
  campingAnxiety: number,
  rng: () => number,
): StepResult<HeadingDecision> {
      const me = ctx.view.self;
      const bag = draftState as HuntBrainState;
      const out = stepDoorCampLook({
        prior,
        selfYaw: me.yaw,
        team: me.team,
        map: ctx.view.map,
        tick: ctx.view.tick,
        campingAnxiety,
        bag,
        rng,
      });
      return { out };
}

export function createDoorCampLookStep(
  opts: DoorCampLookStepOpts,
) {
  const { campingAnxiety, rng } = opts;
  return {
    id: "doorCampLook",
    kind: "switch",
    run(ctx, prior, draftState) {
      return runDoorCampLookStep(
        ctx,
        prior,
        draftState,
        campingAnxiety,
        rng,
      );
    },
  } satisfies ThinkStep<HeadingDecision, HeadingDecision>;
}
