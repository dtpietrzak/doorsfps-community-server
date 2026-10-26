/**
 * Late protection catch: if the packed ReadyAction intends locomotion but
 * tick-to-tick speed stays under {@link STUCK_MOVE_EPS} for ~1.8s, peel:
 * ban the sticky pole, face a detour (hint stuck disc or smart detour),
 * and walk W for a short commit. Then re-engage standard ops (FOV changes).
 *
 * @kind impure (sub: commit)
 * After navigate (sees final move intent); before yawHumanize so the spring
 * tracks the commit face; before click so aim uses the turned eye.
 */

import { YAW_POLE_DWELL_BAN_CLEARS } from "../helpers/dwellBreak.ts";
import { applyHintMoveYaw, sampleBotHintInfluence } from "../helpers/hints.ts";
import { JUMP_PROBE_DIST, smartDetourYawOffset } from "../../helpers/nav.ts";
import type {
  ReadyAction,
  StepResult,
  ThinkContext,
  ThinkStep,
} from "../../pipeline/types.ts";
import { stepStuckWTurn, type StuckWTurnState } from "./helpers/stuckWTurn.ts";
import { applyStuckWTurnPatch, type BotBrainState, viewSimDelta } from "../../types.ts";
import {
  clearStickyYawPole,
  readStickyYawPole,
  yawPoleKey,
} from "../yawPole/helpers/yawPole.ts";
import { max } from "../../math/index.ts";
import { pointAlongYaw } from "../../navigation/index.ts";

export type StuckWTurnStepOpts = {
  rng: () => number;
};

function intendsMove(input: NonNullable<ReadyAction["input"]>): boolean {
  return Boolean(
    input.forward || input.backward || input.left || input.right,
  );
}

export function runStuckWTurnStep(
  ctx: ThinkContext,
  prior: ReadyAction,
  draftState: BotBrainState,
  rng: () => number,
): StepResult<ReadyAction> {
      if (!prior.input) {
        return { out: prior };
      }

      const me = ctx.view.self;
      const holdingW = intendsMove(prior.input);
      const stickyBag = draftState;
      const sticky = readStickyYawPole(stickyBag);
      const hint = sampleBotHintInfluence(
        ctx.view.map,
        me.team,
        me.x,
        me.z,
      );
      let peelYaw: number | undefined;
      if (typeof hint.stuckYaw === "number" && Number.isFinite(hint.stuckYaw)) {
        peelYaw = applyHintMoveYaw(me.yaw, hint);
      } else if (holdingW) {
        const goal = sticky &&
            Number.isFinite(sticky.x) &&
            Number.isFinite(sticky.z)
          ? sticky
          : pointAlongYaw(me.x, me.z, me.yaw, 1);
        const offset = smartDetourYawOffset(
          ctx.view.collision,
          me.x,
          me.z,
          me.yaw,
          goal.x,
          goal.z,
          JUMP_PROBE_DIST,
          rng,
        );
        peelYaw = me.yaw + offset;
      }

      const result = stepStuckWTurn({
        x: me.x,
        z: me.z,
        yaw: me.yaw,
        holdingW,
        simDelta: viewSimDelta(ctx.view),
        tick: ctx.view.tick,
        state: draftState as StuckWTurnState,
        rng,
        peelYaw,
      });

      if (result.active) {
        applyStuckWTurnPatch(draftState, result.statePatch);
        if (result.justTriggered && sticky) {
          const key = yawPoleKey(sticky.x, sticky.z);
          const ignore = { ...stickyBag.yawPoleIgnore };
          ignore[key] = max(
            ignore[key] ?? 0,
            YAW_POLE_DWELL_BAN_CLEARS,
          );
          stickyBag.yawPoleIgnore = ignore;
        }
        clearStickyYawPole(stickyBag);
        const faceYaw = typeof result.faceYaw === "number"
          ? result.faceYaw
          : me.yaw;
        const ready: ReadyAction = {
          ...prior,
          input: {
            ...prior.input,
            forward: true,
            backward: false,
            left: false,
            right: false,
            jump: false,
            sprint: false,
            yaw: faceYaw,
          },
        };
        return { out: ready };
      }

      applyStuckWTurnPatch(draftState, result.statePatch);
      return { out: prior };
}

export function createStuckWTurnStep(
  opts: StuckWTurnStepOpts,
) {
  const { rng } = opts;
  return {
    id: "stuckWTurn",
    kind: "impure",
    run(ctx, prior, draftState) {
      return runStuckWTurnStep(ctx, prior, draftState, rng);
    },
  } satisfies ThinkStep<ReadyAction, ReadyAction>;
}
