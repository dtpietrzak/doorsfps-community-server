/** Public build: no raid bot temperament; every step passes its input through. */

import type {
  ReadyAction,
  StepResult,
  ThinkContext,
  ThinkStep,
} from "../../pipeline/types.ts";
import type { BotBrainState } from "../../types.ts";

export type RaidTemperamentStepOpts = {
  isRaidBot: boolean;
  allowRandomStops: boolean;
  rng: () => number;
};

export function runRaidTemperamentStep(
  _ctx: ThinkContext,
  prior: ReadyAction,
  _draftState: BotBrainState,
  _isRaidBot: boolean,
  _allowRandomStops: boolean,
  _rng: () => number,
): StepResult<ReadyAction> {
  return { out: prior };
}

export function createRaidTemperamentStep(opts: RaidTemperamentStepOpts) {
  return {
    id: "raidTemperament",
    kind: "impure",
    run(ctx, prior, draftState) {
      return runRaidTemperamentStep(
        ctx,
        prior,
        draftState,
        opts.isRaidBot,
        opts.allowRandomStops,
        opts.rng,
      );
    },
  } satisfies ThinkStep<ReadyAction, ReadyAction>;
}
