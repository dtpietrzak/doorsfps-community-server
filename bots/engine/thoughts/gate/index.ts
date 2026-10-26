/**
 * Alive gate: clear per-life brain state and short-circuit when dead.
 * Also short-circuits to idle keys once the match is over — the sole
 * server-authored-input exception (PR5 keys-only) is removed by making
 * even match-over idle come from think, never from apply-time synthesis.
 *
 * @kind switch (sub: clear)
 * Must stay first. Death wipes vault/duck/stuckW/sticky/hunt/camp/strafe/
 * target/sprint/reaction latches — not free to reorder past any bag consumers.
 */

import {
  clearDoorCampState,
  clearHuntState,
} from "../helpers/navLayers.ts";
import type { ReadyAction, ThinkContext } from "../../pipeline/types.ts";
import { UNSET, type BotBrainState } from "../../types.ts";
import { idleInput } from "../navigate/helpers/inputs.ts";
import { clearPathStrafeState } from "../pathHeading/helpers/pathStrafe.ts";
import { clearTargetEnemyState } from "../targetEnemy/helpers/targetEnemy.ts";
import { clearStickyYawPole } from "../yawPole/helpers/yawPole.ts";

import {
  plannedLookPitch,
  plannedLookYaw,
} from "../publicLook.ts";

type GateStep = {
  id: "gate";
  kind: "switch";
  run(
    ctx: ThinkContext,
    prior: null,
    draftState: BotBrainState,
  ): {
    out: null;
    statePatch: undefined;
    done: boolean;
    ready: ReadyAction | null;
  };
};

export function runGateStep(
  ctx: ThinkContext,
  _prior: null,
  draftState: BotBrainState,
) {
      if (ctx.view.matchOver === true) {
        return {
          out: null,
          statePatch: undefined,
          done: true,
          ready: {
            // Hold the last planned look (the live body still trails it by
            // the think buffer).
            input: idleInput(
              plannedLookYaw(draftState, ctx.view.self.yaw),
              plannedLookPitch(draftState, ctx.view.self.pitch),
            ),
          },
        };
      }
      if (!ctx.view.self.alive) {
        const bag = draftState;
        bag.halfWallVaultTicksLeft = UNSET;
        bag.halfWallVaultFaceYaw = UNSET;
        bag.halfWallVaultOption = UNSET;
        bag.halfWallVaultJumpHoldTicksLeft = UNSET;
        bag.halfWallVaultConsecCount = UNSET;
        bag.halfWallVaultConsecX = UNSET;
        bag.halfWallVaultConsecZ = UNSET;
        bag.halfWallVaultConsecTick = UNSET;
        bag.floatWallDuckTicksLeft = UNSET;
        bag.floatWallDuckFaceYaw = UNSET;
        bag.floatWallDuckOption = UNSET;
        bag.floatWallDuckStartX = UNSET;
        bag.floatWallDuckStartZ = UNSET;
        bag.floatWallDuckElapsed = UNSET;
        bag.floatWallDuckCooldownUntilTick = UNSET;
        bag.stuckWElapsed = UNSET;
        bag.stuckWTurnTicksLeft = UNSET;
        bag.stuckWTurnFaceYaw = UNSET;
        bag.stuckWCooldownUntilTick = UNSET;
        bag.smoothedDesiredYaw = UNSET;
        ctx.hooks.resetLookLife(bag);
        clearTargetEnemyState(bag);
        // Sticky pole is per-life; clear on death so respawn re-picks.
        clearStickyYawPole(bag);
        clearDoorCampState(bag);
        clearHuntState(bag);
        clearPathStrafeState(bag);
        bag.sprintChanceLatched = false;
        bag.sprintChanceHasLatch = false;
        bag.openSprintChanceLatched = false;
        bag.openSprintChanceHasLatch = false;
        bag.reactionForEnemyId = "";
        bag.reactionReadyAtTick = UNSET;
        return {
          out: null,
          statePatch: undefined,
          done: true,
          ready: null,
        };
      }
      return {
        out: null,
        statePatch: undefined,
        done: false,
        ready: null,
      };
}

export function createGateStep(): GateStep {
  return {
    id: "gate",
    kind: "switch",
    run: runGateStep,
  };
}
