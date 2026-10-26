/**
 * After targetEnemy: sticky head/torso aim from shoot skill + vertical arc
 * on large yaw swings + continuous pitch micro/track wander. Rewrites
 * combat.lookPitch only; yaw/keys unchanged.
 *
 * @kind switch
 * Latches aim height + swing + wander state for the combat lock. After
 * targetEnemy; before evalSprint / navigate / humanize / click.
 */

import type {
  StepResult,
  ThinkContext,
  ThinkStep,
} from "../../pipeline/types.ts";
import {
  clearCombatPitchState,
  type CombatPitchState,
  stepCombatPitch,
} from "./helpers/combatPitch.ts";
import { type BotBrainState, viewSimDelta } from "../../types.ts";
import { BOT_YAW_EASE_DT } from "../helpers/yawEase.ts";
import type { AfterTargetDecision } from "../helpers/types.ts";

export type CombatPitchStepOpts = {
  /** Click miss-gate skill (swing-arc sloppiness). */
  hitChance: number;
  /** P(latch head vs torso). Split from hitChance. */
  headAim: number;
  /** Combat lead horizon (seconds). */
  leadSec: number;
  /** Continuous pitch micro-wander amplitude (rad). */
  microNoiseAmp: number;
  /** Continuous pitch track-error kick scale (rad). */
  trackErrorAmp: number;
  rng: () => number;
};

function commitCombatPitchState(
  target: BotBrainState,
  patch: CombatPitchState,
): void {
  target.combatPitchMicro =
    typeof patch.combatPitchMicro === "number" &&
      Number.isFinite(patch.combatPitchMicro)
      ? patch.combatPitchMicro
      : Number.NaN;
  target.combatPitchTrack =
    typeof patch.combatPitchTrack === "number" &&
      Number.isFinite(patch.combatPitchTrack)
      ? patch.combatPitchTrack
      : Number.NaN;
  if (typeof patch.combatAimHeightForId === "string") {
    target.combatAimHeightForId = patch.combatAimHeightForId;
  }
  if (typeof patch.combatAimHeight === "string") {
    target.combatAimHeight = patch.combatAimHeight;
  }
}

export function runCombatPitchStep(
  ctx: ThinkContext,
  prior: AfterTargetDecision,
  draftState: BotBrainState,
  hitChance: number,
  headAim: number,
  leadSec: number,
  microNoiseAmp: number,
  trackErrorAmp: number,
  rng: () => number,
): StepResult<AfterTargetDecision> {
      const combat = prior.combat;
      if (!combat) {
        commitCombatPitchState(draftState, clearCombatPitchState());
        return {
          out: prior,
        };
      }

      const enemy = ctx.view.players.find((p) => p.id === combat.enemyId);
      if (!enemy || !enemy.alive) {
        commitCombatPitchState(draftState, clearCombatPitchState());
        return {
          out: prior,
        };
      }

      const bag = draftState;
      const dtSec = viewSimDelta(ctx.view) * BOT_YAW_EASE_DT;
      const result = stepCombatPitch({
        self: ctx.view.self,
        enemy,
        collision: ctx.view.collision,
        lookYaw: combat.lookYaw,
        lookPitch: combat.lookPitch,
        hitChance,
        headAim,
        leadSec,
        dtSec,
        microNoiseAmp,
        trackErrorAmp,
        state: bag,
        rng,
      });

      // Keep draft bag warm so click can read height this same think.
      bag.combatAimHeight = result.aimHeight;
      commitCombatPitchState(bag, result.statePatch);

      return {
        out: {
          ...prior,
          combat: {
            ...combat,
            lookPitch: result.lookPitch,
            compiledPitchInput: result.motorInput,
          },
        },
      };
}

export function createCombatPitchStep(
  opts: CombatPitchStepOpts,
) {
  const { hitChance, headAim, leadSec, microNoiseAmp, trackErrorAmp, rng } =
    opts;
  return {
    id: "combatPitch",
    kind: "switch",
    run(ctx, prior, draftState) {
      return runCombatPitchStep(
        ctx,
        prior,
        draftState,
        hitChance,
        headAim,
        leadSec,
        microNoiseAmp,
        trackErrorAmp,
        rng,
      );
    },
  } satisfies ThinkStep<AfterTargetDecision, AfterTargetDecision>;
}
