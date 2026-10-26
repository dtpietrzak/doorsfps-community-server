/**
 * Latch path | hunt | doorCamp from doors open/closed + personality.
 * Grey agents always hunt; team bots camp when agentAggression &lt; 0.5.
 * Writes bag flags used by targetEnemy / navigate; clears sticky on edges.
 *
 * @kind switch
 * Durable mode latch + door-edge noise re-roll. Keep before navGoal /
 * yawPole / doorCampLook consumers of hunt/camp flags.
 *
 * **Cadence:** 2 Hz ({@link STEP_CADENCE_PERIOD.navMode}), forced on first
 * think and doors open/closed edges so strategic flips stay snappy.
 */

import {
  type HuntBrainState,
  type NavMode,
  type NavModeDecision,
  stepNavMode,
} from "../helpers/navLayers.ts";
import {
  isDwellForceHuntActive,
} from "../helpers/dwellBreak.ts";
import { shouldRunCadencedStep } from "../../pipeline/stepCadence.ts";
import type {
  StepResult,
  ThinkContext,
  ThinkStep,
} from "../../pipeline/types.ts";
import type { BotBrainState } from "../../types.ts";

export type NavModeStepOpts = {
  agentAggression: number;
  rng: () => number;
};

/** Mode from durable bag flags (no bag writes). */
export function navModeFromBag(bag: HuntBrainState): NavMode {
  if (bag.doorCampActive) return "doorCamp";
  if (bag.huntActive) return "hunt";
  return "path";
}

/** Rehydrate prior-chain out without re-running stepNavMode. */
export function rehydrateNavModeDecision(
  bag: HuntBrainState,
): NavModeDecision {
  return {
    mode: navModeFromBag(bag),
    forceNoiseReroll: false,
  };
}

/**
 * Force a full navMode run: first think (no last doors sample), doors edge,
 * or camp dwell-break force-hunt while still latched on doorCamp.
 */
export function shouldForceNavMode(
  bag: HuntBrainState,
  doorsOpen: boolean,
  tick?: number,
): boolean {
  if (!bag.huntDoorsSampled) return true;
  if (bag.huntDoorsOpen !== doorsOpen) return true;
  if (
    typeof tick === "number" &&
    isDwellForceHuntActive(bag, tick) &&
    bag.doorCampActive
  ) {
    return true;
  }
  return false;
}

export function runNavModeStep(
  ctx: ThinkContext,
  _prior: null,
  draftState: BotBrainState,
  agentAggression: number,
  rng: () => number,
): StepResult<NavModeDecision> {
      const me = ctx.view.self;
      const bag = draftState;
      const doorsOpen = Boolean(ctx.view.doorsOpen);
      const tick = ctx.view.tick;
      const force = shouldForceNavMode(bag, doorsOpen, tick);
      if (
        !shouldRunCadencedStep("navMode", tick, me.id, { force })
      ) {
        return { out: rehydrateNavModeDecision(bag) };
      }
      const out = stepNavMode({
        doorsOpen,
        isGreyAgent: Boolean(me.isAgent),
        agentAggression,
        bag,
        rng,
        tick,
      });
      return { out };
}

export function createNavModeStep(
  opts: NavModeStepOpts,
) {
  const { agentAggression, rng } = opts;
  return {
    id: "navMode",
    kind: "switch",
    run(ctx, prior, draftState) {
      return runNavModeStep(ctx, prior, draftState, agentAggression, rng);
    },
  } satisfies ThinkStep<null, NavModeDecision>;
}
