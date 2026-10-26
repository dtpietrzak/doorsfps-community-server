/**
 * Always-defined world goal for this think.
 * path → enemy door mid; hunt → agent / last / map center + doorDist bias;
 * doorCamp → deconflicted plant (+ campArrived).
 * Hunt “no pole” fallback is resolved here once — not in yawIntent.
 *
 * @kind switch
 * Latches plant XZ, hunt door-bias / last agent. Depends on navMode; keep
 * before yawPole and pathHeading.
 *
 * **Cadence:** 5 Hz ({@link STEP_CADENCE_PERIOD.navGoal}). Forced on
 * {@link NavModeDecision.forceNoiseReroll}, missing cache, or camp without
 * plant. Personality plant deconflict only runs on full replans.
 */

import { isAtDoorCampPlant } from "../helpers/doorCamp.ts";
import {
  type HuntBrainState,
  type NavGoalDecision,
  type NavModeDecision,
  stepNavGoal,
} from "../helpers/navLayers.ts";
import { shouldRunCadencedStep } from "../../pipeline/stepCadence.ts";
import type {
  StepResult,
  ThinkContext,
  ThinkStep,
} from "../../pipeline/types.ts";
import { hasDoorCampPlant, type BotBrainState } from "../../types.ts";
import type { YawPolePoint } from "../helpers/navLayers.ts";

export type NavGoalStepOpts = {
  rng: () => number;
  /** Door-rusher personality — high values plant on the capture lip. */
  doorAggression: number;
};

function readCache(bag: BotBrainState): NavGoalDecision | undefined {
  if (!bag.cadenceNavGoalValid) return undefined;
  if (!Number.isFinite(bag.cadenceNavGoalX) || !Number.isFinite(bag.cadenceNavGoalZ)) {
    return undefined;
  }
  const goal: YawPolePoint = {
    x: bag.cadenceNavGoalX,
    z: bag.cadenceNavGoalZ,
  };
  let doorDistPoint: YawPolePoint | null = null;
  if (
    bag.cadenceNavGoalHasDoorDist &&
    Number.isFinite(bag.cadenceNavGoalDoorDistX) &&
    Number.isFinite(bag.cadenceNavGoalDoorDistZ)
  ) {
    doorDistPoint = {
      x: bag.cadenceNavGoalDoorDistX,
      z: bag.cadenceNavGoalDoorDistZ,
    };
  }
  const mode = bag.cadenceNavGoalMode;
  if (mode !== "path" && mode !== "hunt" && mode !== "doorCamp") {
    return undefined;
  }
  return {
    mode,
    goal,
    doorDistPoint,
    campArrived: bag.cadenceNavGoalCampArrived,
    forceNoiseReroll: bag.cadenceNavGoalForceNoiseReroll,
  };
}

function writeCache(bag: BotBrainState, out: NavGoalDecision): void {
  bag.cadenceNavGoalValid = true;
  bag.cadenceNavGoalMode = out.mode;
  bag.cadenceNavGoalX = out.goal.x;
  bag.cadenceNavGoalZ = out.goal.z;
  if (out.doorDistPoint) {
    bag.cadenceNavGoalHasDoorDist = true;
    bag.cadenceNavGoalDoorDistX = out.doorDistPoint.x;
    bag.cadenceNavGoalDoorDistZ = out.doorDistPoint.z;
  } else {
    bag.cadenceNavGoalHasDoorDist = false;
    bag.cadenceNavGoalDoorDistX = Number.NaN;
    bag.cadenceNavGoalDoorDistZ = Number.NaN;
  }
  bag.cadenceNavGoalCampArrived = out.campArrived;
  bag.cadenceNavGoalForceNoiseReroll = out.forceNoiseReroll;
}

/**
 * Force full navGoal: mode/spawn re-roll, no cache, mode mismatch, or camp
 * missing a plant (must pick).
 */
export function shouldForceNavGoal(
  prior: NavModeDecision,
  bag: HuntBrainState,
): boolean {
  if (prior.forceNoiseReroll) return true;
  const cache = readCache(bag);
  if (!cache) return true;
  if (cache.mode !== prior.mode) return true;
  if (prior.mode === "doorCamp" && !hasDoorCampPlant(bag)) {
    return true;
  }
  return false;
}

/**
 * Hold last goal; refresh cheap campArrived from live pose. No RNG / plant pick.
 */
export function rehydrateNavGoalDecision(
  prior: NavModeDecision,
  bag: HuntBrainState,
  selfX: number,
  selfZ: number,
): NavGoalDecision | null {
  const cache = readCache(bag);
  if (!cache || cache.mode !== prior.mode) return null;

  let campArrived = false;
  if (
    prior.mode === "doorCamp" &&
    hasDoorCampPlant(bag)
  ) {
    campArrived = isAtDoorCampPlant(
      selfX,
      selfZ,
      bag.doorCampPlantX,
      bag.doorCampPlantZ,
    );
  }

  return {
    mode: prior.mode,
    goal: cache.goal,
    doorDistPoint: cache.doorDistPoint,
    campArrived,
    forceNoiseReroll: false,
  };
}

export function runNavGoalStep(
  ctx: ThinkContext,
  prior: NavModeDecision,
  draftState: BotBrainState,
  rng: () => number,
  doorAggression: number,
): StepResult<NavGoalDecision> {
      const me = ctx.view.self;
      const bag = draftState;
      const force = shouldForceNavGoal(prior, bag);

      if (
        !shouldRunCadencedStep("navGoal", ctx.view.tick, me.id, { force })
      ) {
        const held = rehydrateNavGoalDecision(prior, bag, me.x, me.z);
        if (held) return { out: held };
        // Fall through to full run if rehydrate failed.
      }

      const perc = ctx.perception;
      const out = stepNavGoal({
        mode: prior.mode,
        forceNoiseReroll: prior.forceNoiseReroll,
        selfX: me.x,
        selfZ: me.z,
        selfId: me.id,
        team: me.team,
        isGreyAgent: Boolean(me.isAgent),
        map: ctx.view.map,
        players: ctx.view.players,
        collision: ctx.view.collision,
        bag,
        rng,
        enemyDoor: perc?.enemyDoor,
        nearestHuntGoal: perc
          ? perc.nearestHuntGoal
            ? { x: perc.nearestHuntGoal.x, z: perc.nearestHuntGoal.z }
            : null
          : undefined,
        doorAggression,
        tick: ctx.view.tick,
        doorChangeTick: ctx.view.doorChangeTick,
        teammateCamps: ctx.view.teammateCamps,
      });

      writeCache(bag, out);

      return { out };
}

export function createNavGoalStep(
  opts: NavGoalStepOpts,
) {
  const { rng, doorAggression } = opts;
  return {
    id: "navGoal",
    kind: "switch",
    run(ctx, prior, draftState) {
      return runNavGoalStep(ctx, prior, draftState, rng, doorAggression);
    },
  } satisfies ThinkStep<NavModeDecision, NavGoalDecision>;
}
