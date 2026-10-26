/**
 * Dormant until a half wall is within probe range on the desired path.
 * Then overrides face + WASD + jump for a short commit window.
 * Skipped only while planted on the enemy-door camp lip (travel still vaults).
 *
 * @kind impure (sub: commit)
 * Multi-tick jump vault — countdown + face/WASD/jump override until clear.
 * After yawIntent; before floatWallDuck (vault wins if both active).
 */

import { shouldRunExpensiveNavProbes } from "../../helpers/combat.ts";
import { isAtDoorCampPlant } from "../helpers/doorCamp.ts";
import {
  type HalfWallVaultState,
  stepHalfWallVault,
} from "./helpers/halfWallVault.ts";
import type { HuntBrainState } from "../helpers/navLayers.ts";
import type {
  StepResult,
  ThinkContext,
  ThinkStep,
} from "../../pipeline/types.ts";
import { applyHalfWallVaultPatch, type BotBrainState, viewSimDelta } from "../../types.ts";
import type { AfterVaultDecision, YawIntentDecision } from "../helpers/types.ts";

export function runHalfWallVaultStep(
  ctx: ThinkContext,
  prior: YawIntentDecision,
  draftState: BotBrainState,
): StepResult<AfterVaultDecision> {
      const me = ctx.view.self;
      const bag = draftState as HuntBrainState;
      // Planted camp only — travel to plant still needs half-wall jumps.
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
            vault: null,
          },
        };
      }
      const vaultBag = draftState as HalfWallVaultState & {
        stuckWElapsed?: number;
        stuckWTurnTicksLeft?: number;
        floatWallDuckTicksLeft?: number;
      };
      if (
        !shouldRunExpensiveNavProbes(
          vaultBag,
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
            vault: null,
          },
        };
      }
      // Probe along world move (corner path), not pre-rotated look.
      const result = stepHalfWallVault({
        x: me.x,
        z: me.z,
        desiredYaw: prior.moveYaw,
        onGround: me.onGround,
        collision: ctx.view.collision,
        simDelta: viewSimDelta(ctx.view),
        tick: ctx.view.tick,
        state: draftState as HalfWallVaultState,
      });

      applyHalfWallVaultPatch(draftState, result.statePatch);
      if (!result.active || typeof result.faceYaw !== "number") {
        const out: AfterVaultDecision = {
          target: prior.target,
          next: prior.next,
          desiredYaw: prior.desiredYaw,
          moveYaw: prior.moveYaw,
          nudgeDir: prior.nudgeDir,
          vault: null,
        };
        return {
          out,
        };
      }
      const out: AfterVaultDecision = {
        target: prior.target,
        next: prior.next,
        desiredYaw: prior.desiredYaw,
        moveYaw: prior.moveYaw,
        nudgeDir: prior.nudgeDir,
        vault: {
          faceYaw: result.faceYaw,
          forward: Boolean(result.forward),
          left: Boolean(result.left),
          right: Boolean(result.right),
          jump: Boolean(result.jump),
        },
      };
      return {
        out,
      };
}

export function createHalfWallVaultStep() {
  return {
    id: "halfWallVault",
    kind: "impure",
    run: runHalfWallVaultStep,
  } satisfies ThinkStep<YawIntentDecision, AfterVaultDecision>;
}
