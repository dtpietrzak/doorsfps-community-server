/**
 * Sprint when running toward the enemy door:
 * 1. **Force** (`config.sprint`) — door FOV cone, no zone/chance.
 * 2. **Zone** — map-hint sprint poly + door FOV cone + `sprintChance` latch.
 * 3. **Open** — clear lane ahead + lenient door-run (any N/S progress toward
 *    the score door) + stamina &gt; 50% + same `sprintChance` latch (separate
 *    open entry latch). ≤ half bar → no open sprint (zone/force/slide ok).
 *
 * Never sprint while move has no progress toward the door. Duck still forces
 * sprint false in navigate.
 *
 * @kind switch
 * Chance latches (`sprintChanceLatched` / `openSprintChanceLatched`). After
 * combat decision; before navigate pack.
 */

import {
  isMoveTowardEnemyDoor,
  OPEN_SPRINT_CHANCE_SCALE,
  stepEvalOpenSprint,
  stepEvalSprint,
} from "./helpers/evalSprint.ts";
import type {
  StepResult,
  ThinkContext,
  ThinkStep,
} from "../../pipeline/types.ts";
import type {
  AfterSprintDecision,
  AfterTargetDecision,
} from "../helpers/types.ts";
import {
  OPEN_SPRINT_CHANCE_LATCH_KEY,
  SPRINT_CHANCE_LATCH_KEY,
} from "../helpers/stateKeys.ts";
import { clamp01 } from "../../math/index.ts";
import type { BotBrainState } from "../../types.ts";

export type EvalSprintStepOpts = {
  sprint: boolean;
  sprintChance: number;
  rng: () => number;
};

function rollChanceLatch(
  bag: BotBrainState,
  key: typeof SPRINT_CHANCE_LATCH_KEY | typeof OPEN_SPRINT_CHANCE_LATCH_KEY,
  sprintChance: number,
  rng: () => number,
): boolean {
  if (sprintChance >= 1) return true;
  if (sprintChance <= 0) return false;
  if (key === SPRINT_CHANCE_LATCH_KEY) {
    if (!bag.sprintChanceHasLatch) {
      bag.sprintChanceLatched = rng() < sprintChance;
      bag.sprintChanceHasLatch = true;
    }
    return bag.sprintChanceLatched === true;
  }
  if (!bag.openSprintChanceHasLatch) {
    bag.openSprintChanceLatched = rng() < sprintChance;
    bag.openSprintChanceHasLatch = true;
  }
  return bag.openSprintChanceLatched === true;
}

export function runEvalSprintStep(
  ctx: ThinkContext,
  prior: AfterTargetDecision,
  draftState: BotBrainState,
  sprint: boolean,
  sprintChance: number,
  rng: () => number,
): StepResult<AfterSprintDecision> {
  const openChance = clamp01(sprintChance * OPEN_SPRINT_CHANCE_SCALE);
      const me = ctx.view.self;
      const bag = draftState;
      const doorRun = {
        map: ctx.view.map,
        team: me.team,
        x: me.x,
        z: me.z,
        // Path / wish move — not body look (combat aim, reverse, stand).
        moveYaw: prior.moveYaw,
        enemyDoor: ctx.perception?.enemyDoor,
      };
      const towardDoor = isMoveTowardEnemyDoor(doorRun);
      // Zone + strict door FOV.
      const zoneWant = stepEvalSprint(doorRun);
      // Open lane + lenient door-run + stamina gate (zone/force ignore this).
      const openWant = Boolean(ctx.view.collision) &&
        stepEvalOpenSprint({
          ...doorRun,
          collision: ctx.view.collision!,
          sprintStamina: me.sprintStamina,
        });

      let wantSprint = false;
      if (sprint && towardDoor) {
        // Force: skip zone/open + chance; still requires door FOV run.
        bag.sprintChanceLatched = false;
        bag.sprintChanceHasLatch = false;
        bag.openSprintChanceLatched = false;
        bag.openSprintChanceHasLatch = false;
        wantSprint = true;
      } else if (zoneWant) {
        bag.openSprintChanceLatched = false;
        bag.openSprintChanceHasLatch = false;
        wantSprint = rollChanceLatch(
          bag,
          SPRINT_CHANCE_LATCH_KEY,
          sprintChance,
          rng,
        );
      } else if (openWant) {
        bag.sprintChanceLatched = false;
        bag.sprintChanceHasLatch = false;
        // Open ground: lower chance than zone (heatmap B2).
        wantSprint = rollChanceLatch(
          bag,
          OPEN_SPRINT_CHANCE_LATCH_KEY,
          openChance,
          rng,
        );
      } else {
        bag.sprintChanceLatched = false;
        bag.sprintChanceHasLatch = false;
        bag.openSprintChanceLatched = false;
        bag.openSprintChanceHasLatch = false;
        wantSprint = false;
      }

      return {
        out: {
          ...prior,
          sprint: wantSprint,
        },
      };
}

export function createEvalSprintStep(
  opts: EvalSprintStepOpts,
) {
  const { sprint, sprintChance, rng } = opts;
  return {
    id: "evalSprint",
    kind: "switch",
    run(ctx, prior, draftState) {
      return runEvalSprintStep(
        ctx,
        prior,
        draftState,
        sprint,
        sprintChance,
        rng,
      );
    },
  } satisfies ThinkStep<AfterTargetDecision, AfterSprintDecision>;
}
