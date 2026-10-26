/**
 * Intent: walk along world move yaw (corner-round may strafe), unless vault
 * / duck / combat override is active. `input.yaw` is the *desired* look;
 * yawHumanize springs path/vault/duck/combat aim (no hard combat snap).
 * Door-camp plant: zero WASD for v1 (future: ADAD for skilled shooters).
 *
 * Pitch: combat uses combatPitch’s head/torso + swing arc; once the lock
 * ends (escape / kill / LOS / death clear / empty mags / door priority),
 * path/vault/duck look returns to level (0) so the bot is not stuck staring
 * at the last aim elevation.
 *
 * Crouch while reversing: never arm a crouch-slide (W/A/D + crouch rising
 * edge). If combat is already on S, keep reverse keys and only hold crouch.
 *
 * @kind impure (sub: pack)
 * Builds ReadyAction. Override priority:
 * **vault body → duck body → combat body → camp idle → path**.
 * Combat still owns look when locked; vault/duck own WASD/jump/crouch so
 * bots do not hop in place or freeze mid half/float wall while aiming.
 * Keep near end; humanize/click refine after.
 */

import { isAtDoorCampPlant } from "../helpers/doorCamp.ts";
import { isUnderFloatSlab } from "../floatWallDuck/helpers/floatWallDuck.ts";
import { moveKeysForWorldYaw } from "../../helpers/nav.ts";
import type { HuntBrainState } from "../helpers/navLayers.ts";
import type {
  ReadyAction,
  StepResult,
  ThinkContext,
  ThinkStep,
} from "../../pipeline/types.ts";
import type { BotBrainState } from "../../types.ts";
import { worldMoveYawFromPrior } from "../targetEnemy/helpers/targetEnemy.ts";
import {
  combatMoveInput,
  duckInput,
  vaultInput,
  walkInput,
} from "./helpers/inputs.ts";
import type { AfterSprintDecision } from "../helpers/types.ts";

export function runNavigateStep(
  ctx: ThinkContext,
  prior: AfterSprintDecision,
  draftState: BotBrainState,
): StepResult<ReadyAction> {
      const me = ctx.view.self;
      const weapon = prior.weapon;
      const reload = prior.reload;
      const wantSprint = prior.sprint;
      const bag = draftState as HuntBrainState;
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
      // Level pitch when not aiming a combat lock (straight forward).
      const pathPitch = 0;

      // Vault owns body while committed. With combat lock: keep combat look
      // but remap WASD so world move still tracks vault face+keys.
      if (prior.vault && !campPlanted) {
        if (prior.combat) {
          const worldMove = worldMoveYawFromPrior(
            prior.vault.faceYaw,
            {
              forward: prior.vault.forward,
              backward: false,
              left: prior.vault.left,
              right: prior.vault.right,
            },
            prior.moveYaw,
          );
          const keys = moveKeysForWorldYaw(prior.combat.lookYaw, worldMove);
          const ready: ReadyAction = {
            input: combatMoveInput(
              prior.combat.lookYaw,
              prior.combat.lookPitch,
              wantSprint,
              false,
              prior.vault.jump,
              keys,
            ),
            weapon,
            reload,
            compiledPitchInput: prior.combat.compiledPitchInput,
          };
          return { out: ready };
        }
        const ready: ReadyAction = {
          input: vaultInput(prior.vault.faceYaw, pathPitch, wantSprint, {
            forward: prior.vault.forward,
            left: prior.vault.left,
            right: prior.vault.right,
            jump: prior.vault.jump,
          }),
          weapon,
          reload,
        };
        return { out: ready };
      }
      // Duck owns body under float / crouch commit. Combat look + remapped WASD.
      if (prior.duck && !campPlanted) {
        if (prior.combat) {
          const worldMove = worldMoveYawFromPrior(
            prior.duck.faceYaw,
            {
              forward: prior.duck.forward,
              backward: false,
              left: prior.duck.left,
              right: prior.duck.right,
            },
            prior.moveYaw,
          );
          const keys = moveKeysForWorldYaw(prior.combat.lookYaw, worldMove);
          const ready: ReadyAction = {
            input: combatMoveInput(
              prior.combat.lookYaw,
              prior.combat.lookPitch,
              false,
              true,
              false,
              {
                forward: keys.forward,
                backward: keys.backward,
                left: keys.left,
                right: keys.right,
              },
            ),
            weapon,
            reload,
            compiledPitchInput: prior.combat.compiledPitchInput,
          };
          return { out: ready };
        }
        const ready: ReadyAction = {
          input: duckInput(prior.duck.faceYaw, pathPitch, {
            forward: prior.duck.forward,
            left: prior.duck.left,
            right: prior.duck.right,
          }),
          weapon,
          reload,
        };
        return { out: ready };
      }
      if (prior.combat) {
        const underFloat = Boolean(
          ctx.view.collision &&
            isUnderFloatSlab(ctx.view.collision, me.x, me.z),
        );
        const crouch = underFloat;
        const jump = false;
        let keys = campPlanted
          ? {
            forward: false,
            backward: false,
            left: false,
            right: false,
          }
          : {
            forward: prior.combat.forward,
            backward: prior.combat.backward,
            left: prior.combat.left,
            right: prior.combat.right,
          };
        // Already reversing + crouch: do not add/keep W for a slide entry.
        // Physics never slides on S; keep reverse (and optional A/D), crouch only.
        if (crouch && keys.backward) {
          keys = {
            forward: false,
            backward: true,
            left: keys.left,
            right: keys.right,
          };
        }
        const ready: ReadyAction = {
          input: combatMoveInput(
            prior.combat.lookYaw,
            prior.combat.lookPitch,
            wantSprint,
            crouch,
            jump,
            keys,
          ),
          weapon,
          reload,
          compiledPitchInput: prior.combat.compiledPitchInput,
        };
        return { out: ready };
      }
      if (campPlanted) {
        // Idle hold on the capture lip. ADAD strafe may land later.
        const ready: ReadyAction = {
          input: walkInput(prior.desiredYaw, pathPitch, false, {
            forward: false,
            backward: false,
            left: false,
            right: false,
          }),
          weapon,
          reload,
        };
        return { out: ready };
      }
      // Map under look intent so straight runs stay pure W; corners add opposite strafe.
      const keys = moveKeysForWorldYaw(prior.desiredYaw, prior.moveYaw);
      // Nudge hints use the path-ADAD phase clock but press literal A/D, so
      // authored guidance never steals the bot's normal forward steering yaw.
      if (prior.nudgeDir === "left") {
        keys.left = true;
        keys.right = false;
      } else if (prior.nudgeDir === "right") {
        keys.left = false;
        keys.right = true;
      }
      const ready: ReadyAction = {
        input: walkInput(prior.desiredYaw, pathPitch, wantSprint, keys),
        weapon,
        reload,
      };
      return { out: ready };
}

export function createNavigateStep() {
  return {
    id: "navigate",
    kind: "impure",
    run: runNavigateStep,
  } satisfies ThinkStep<AfterSprintDecision, ReadyAction>;
}
