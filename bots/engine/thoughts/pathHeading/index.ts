/**
 * Raw look + world move from poles / goal.
 * Face `target ?? goal` (goal already mode-correct from navGoal).
 * Corner-round + pathStrafe on path / hunt / doorCamp **travel**. Arrived
 * door-camp leaves a plant placeholder for doorCampLook to override (no
 * corner/pathStrafe while frozen).
 *
 * **Grey agents** (`isAgent`): never path-ADAD or corner race-line — pure walk
 * toward the pole/goal even if brain config knobs are non-zero.
 *
 * Near open doors: b-line the enemy door center (commit within 4u regardless
 * of look FOV; vision-arm within 5u). See doorCenterBline. Authored Nudge
 * lines reuse path-ADAD timing as literal A/D; stuck discs still mix escape
 * yaw into travel.
 *
 * @kind impure (sub: motor-ish)
 * Path-strafe phase ticks live in the bag (multi-think ADAD). Reads vault/
 * duck tick leftovers to suppress strafe. After pole; before yawIntent.
 */

import type { DoorsMap } from "../../shared/map.ts";
import type { TeamId } from "../../shared/network.ts";
import { pickDoorCenterBlineTarget } from "./helpers/doorCenterBline.ts";
import {
  applyHintMoveYaw,
  sampleBotHintInfluence,
  sampleNudgeStrafe,
} from "../helpers/hints.ts";
import {
  pathStrafeShouldSuppress,
  type PathStrafeState,
  stepPathStrafeMove,
} from "./helpers/pathStrafe.ts";
import { bodyAvoidMoveYaw } from "../helpers/playerAvoid.ts";
import type { FloatWallDuckState } from "../floatWallDuck/helpers/floatWallDuck.ts";
import type { HalfWallVaultState } from "../halfWallVault/helpers/halfWallVault.ts";
import { yawToward } from "../../helpers/nav.ts";
import {
  type HeadingDecision,
  type YawPoleNavDecision,
} from "../helpers/navLayers.ts";
import type {
  StepResult,
  ThinkContext,
  ThinkStep,
} from "../../pipeline/types.ts";
import { type BotBrainState, viewSimDelta } from "../../types.ts";
import {
  computeYawPoleCornerRound,
  maxStrafeFromCornerRound,
} from "../yawPole/helpers/yawPole.ts";

export type PathHeadingStepOpts = {
  pathStrafe: number;
  nudgeStrafe: number;
  cornerRound: number;
  rng: () => number;
};

function mixTravelMoveYaw(
  x: number,
  z: number,
  moveYaw: number,
  opts: {
    selfId: string;
    map: DoorsMap;
    team: TeamId;
    others: ReadonlyArray<{ id?: string; x: number; z: number }>;
    applyStuckHint: boolean;
  },
): number {
  let yaw = bodyAvoidMoveYaw(x, z, moveYaw, opts.others, {
    selfId: opts.selfId,
  });
  if (opts.applyStuckHint) {
    const hint = sampleBotHintInfluence(opts.map, opts.team, x, z);
    yaw = applyHintMoveYaw(yaw, hint);
  }
  return yaw;
}

export function runPathHeadingStep(
  ctx: ThinkContext,
  prior: YawPoleNavDecision,
  draftState: BotBrainState,
  pathStrafe: number,
  nudgeStrafe: number,
  cornerRound: number,
  rng: () => number,
): StepResult<HeadingDecision> {
      const me = ctx.view.self;
      // Grey free-for-all agents: no random path ADAD / no corner outside cut.
      // Authored Nudge lines use their separate cadence below.
      const effectivePathStrafe = me.isAgent ? 0 : pathStrafe;
      const effectiveCornerRound = me.isAgent ? 0 : cornerRound;

      // Planted door camp: freeze-facing plant; doorCampLook owns look.
      // Travel uses the same pole path as path/hunt (below) so walls are routed.
      if (prior.mode === "doorCamp" && prior.campArrived) {
        const toPlant = yawToward(
          me.x,
          me.z,
          prior.goal.x,
          prior.goal.z,
        );
        const out: HeadingDecision = {
          mode: prior.mode,
          goal: prior.goal,
          campArrived: true,
          target: prior.target,
          next: null,
          rawLook: toPlant,
          moveYaw: toPlant,
          nudgeDir: "none",
        };
        return { out };
      }

      // Open-door center commit: side poles + pathStrafe shimmy past the gap.
      // Within 5u of a door with center pole in front vision → pure forward.
      const doorCenter = pickDoorCenterBlineTarget({
        x: me.x,
        z: me.z,
        faceYaw: me.yaw,
        map: ctx.view.map,
        team: me.team,
        doorsOpen: Boolean(ctx.view.doorsOpen),
      });
      if (doorCenter) {
        const toCenter = yawToward(me.x, me.z, doorCenter.x, doorCenter.z);
        const pathBag = draftState as PathStrafeState;
        // Freeze ADAD while committed through the mouth; keep pattern seed.
        pathBag.pathStrafeDir = "none";
        pathBag.pathStrafeTicksLeft = 0;
        // Sidestep a body in the mouth; do not honor stuck discs (they'd peel
        // off the gap).
        const moveYaw = mixTravelMoveYaw(me.x, me.z, toCenter, {
          selfId: me.id,
          map: ctx.view.map,
          team: me.team,
          others: ctx.view.players.filter((p) => p.alive),
          applyStuckHint: false,
        });
        const out: HeadingDecision = {
          mode: prior.mode,
          goal: prior.goal,
          campArrived: prior.campArrived,
          target: doorCenter,
          next: null,
          rawLook: toCenter,
          moveYaw,
          nudgeDir: "none",
        };
        return { out };
      }

      const goal = prior.target ?? prior.goal;
      const toGoal = yawToward(me.x, me.z, goal.x, goal.z);

      let rawLook = toGoal;
      const approachYaw = toGoal;
      let cornerLateral = 0;
      if (prior.target && prior.next && effectiveCornerRound > 0) {
        const corner = computeYawPoleCornerRound({
          x: me.x,
          z: me.z,
          current: prior.target,
          next: prior.next,
          maxStrafe: maxStrafeFromCornerRound(effectiveCornerRound),
        });
        if (corner) {
          rawLook = corner.lookYaw;
          cornerLateral = corner.strafeAmount * corner.strafeSign;
        }
      }

      const nudge = sampleNudgeStrafe(
        ctx.view.map,
        me.team,
        me.x,
        me.z,
        rawLook,
      );
      const activePathStrafe = nudge ? nudgeStrafe : effectivePathStrafe;

      const vaultBag = draftState as HalfWallVaultState & FloatWallDuckState;
      const suppressPath = pathStrafeShouldSuppress({
        collision: ctx.view.collision,
        x: me.x,
        z: me.z,
        pathYaw: approachYaw,
        halfWallVaultTicksLeft: vaultBag.halfWallVaultTicksLeft,
        floatWallDuckTicksLeft: vaultBag.floatWallDuckTicksLeft,
      });

      const pathBag = draftState as PathStrafeState;
      const pathStep = stepPathStrafeMove({
        state: pathBag,
        x: me.x,
        z: me.z,
        approachYaw,
        current: prior.target,
        next: prior.next,
        personality: activePathStrafe,
        cornerLateral,
        collision: ctx.view.collision,
        simDelta: viewSimDelta(ctx.view),
        rng,
        preferredDir: nudge?.dir,
        phaseOnly: nudge !== null,
        suppress: suppressPath,
      });

      const moveYaw = mixTravelMoveYaw(me.x, me.z, pathStep.moveYaw, {
        selfId: me.id,
        map: ctx.view.map,
        team: me.team,
        others: ctx.view.players.filter((p) => p.alive),
        applyStuckHint: true,
      });

      const out: HeadingDecision = {
          mode: prior.mode,
          goal: prior.goal,
          campArrived: prior.campArrived,
          target: prior.target,
          next: prior.next,
          rawLook,
          moveYaw,
          nudgeDir: nudge ? pathStep.dir : "none",
      };
      return { out };
}

export function createPathHeadingStep(
  opts: PathHeadingStepOpts,
) {
  const { pathStrafe, nudgeStrafe, cornerRound, rng } = opts;
  return {
    id: "pathHeading",
    kind: "impure",
    run(ctx, prior, draftState) {
      return runPathHeadingStep(
        ctx,
        prior,
        draftState,
        pathStrafe,
        nudgeStrafe,
        cornerRound,
        rng,
      );
    },
  } satisfies ThinkStep<YawPoleNavDecision, HeadingDecision>;
}
