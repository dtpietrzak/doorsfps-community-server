/**
 * Dormant while vault is active. Otherwise crouch-under a float slab on
 * the desired path (stamina-based probe, path-aligned transit). Side A/D
 * collapses only when that side is blocked. Under-slab always owns crouch
 * + exit. Skipped only while planted on the door-camp lip (travel still ducks).
 *
 * @kind impure (sub: commit)
 * Multi-tick crouch-under — countdown + face/WASD override while under slab.
 * After vault; before targetEnemy so float blocks combat stand-still.
 */

import { shouldRunExpensiveNavProbes } from "../../helpers/combat.ts";
import { isAtDoorCampPlant } from "../helpers/doorCamp.ts";
import {
  type FloatWallDuckState,
  stepFloatWallDuck,
} from "./helpers/floatWallDuck.ts";
import type { HuntBrainState } from "../helpers/navLayers.ts";
import type {
  StepResult,
  ThinkContext,
  ThinkStep,
} from "../../pipeline/types.ts";
import { applyFloatWallDuckPatch, type BotBrainState, viewSimDelta } from "../../types.ts";
import type { AfterVaultDecision, NavDecision } from "../helpers/types.ts";

export function runFloatWallDuckStep(
  ctx: ThinkContext,
  prior: AfterVaultDecision,
  draftState: BotBrainState,
): StepResult<NavDecision> {
      const me = ctx.view.self;
      const bag = draftState as HuntBrainState;
      // Planted camp only — travel to plant still needs float crouch-under.
      const campPlanted = Boolean(
        bag.doorCampActive &&
          Number.isFinite(bag.doorCampPlantX) &&
          Number.isFinite(bag.doorCampPlantZ) &&
          isAtDoorCampPlant(
            me.x,
            me.z,
            bag.doorCampPlantX,
            bag.doorCampPlantZ,
          ),
      );
      if (campPlanted) {
        return {
          out: {
            target: prior.target,
            next: prior.next,
            desiredYaw: prior.desiredYaw,
            moveYaw: prior.moveYaw,
            nudgeDir: prior.nudgeDir,
            vault: prior.vault,
            duck: null,
          },
        };
      }
      const duckBag = draftState as FloatWallDuckState & {
        stuckWElapsed?: number;
        stuckWTurnTicksLeft?: number;
        halfWallVaultTicksLeft?: number;
      };
      if (
        !prior.vault &&
        !shouldRunExpensiveNavProbes(
          duckBag,
          ctx.view.tick,
          me.id,
        )
      ) {
        return {
          out: {
            target: prior.target,
            next: prior.next,
            desiredYaw: prior.desiredYaw,
            moveYaw: prior.moveYaw,
            nudgeDir: prior.nudgeDir,
            vault: prior.vault,
            duck: null,
          },
        };
      }
      const result = stepFloatWallDuck({
        x: me.x,
        z: me.z,
        desiredYaw: prior.moveYaw,
        sprintStamina: me.sprintStamina,
        vaultActive: prior.vault !== null,
        collision: ctx.view.collision,
        simDelta: viewSimDelta(ctx.view),
        tick: ctx.view.tick,
        state: draftState as FloatWallDuckState,
      });

      applyFloatWallDuckPatch(draftState, result.statePatch);
      if (
        prior.vault ||
        !result.active ||
        typeof result.faceYaw !== "number"
      ) {
        const out: NavDecision = {
          target: prior.target,
          next: prior.next,
          desiredYaw: prior.desiredYaw,
          moveYaw: prior.moveYaw,
          nudgeDir: prior.nudgeDir,
          vault: prior.vault,
          duck: null,
        };
        return {
          out,
        };
      }
      const out: NavDecision = {
        target: prior.target,
        next: prior.next,
        desiredYaw: prior.desiredYaw,
        moveYaw: prior.moveYaw,
        nudgeDir: prior.nudgeDir,
        vault: null,
        duck: {
          faceYaw: result.faceYaw,
          forward: Boolean(result.forward),
          left: Boolean(result.left),
          right: Boolean(result.right),
        },
      };
      return {
        out,
      };
}

export function createFloatWallDuckStep() {
  return {
    id: "floatWallDuck",
    kind: "impure",
    run: runFloatWallDuckStep,
  } satisfies ThinkStep<AfterVaultDecision, NavDecision>;
}
