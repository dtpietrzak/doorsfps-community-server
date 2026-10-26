/**
 * Score-based sticky yaw-pole pick (client blue guide). Pure pick is
 * stateless; sticky holds until arrival, lost full-wall LOS, or noise
 * re-roll (spawn / mode). Door-camp **travel** uses the same wall/door poles
 * with plant as `goalPoint` so bots route around walls; **arrived** camp
 * freezes on plant only (look owned by doorCampLook). Live **next** is a
 * stand-at-current re-pick for corner-rounding.
 *
 * @kind switch
 * Sticky pole + pole-noise bag across thinks. After navGoal; before
 * pathHeading (needs target/next).
 *
 * **Cadence:** 10 Hz ({@link STEP_CADENCE_PERIOD.yawPole}). Forced on noise
 * re-roll, missing sticky (path/hunt/doorCamp travel), lost sticky lock, or
 * planted camp. Skip holds last target/next while pathHeading still faces it
 * every bot think.
 */

import {
  clearHuntState,
  type NavGoalDecision,
  type YawPoleNavDecision,
} from "../helpers/navLayers.ts";
import { shouldRunCadencedStep } from "../../pipeline/stepCadence.ts";
import type {
  StepResult,
  ThinkContext,
  ThinkStep,
} from "../../pipeline/types.ts";
import { UNSET, type BotBrainState } from "../../types.ts";
import {
  buildYawPoleNoise,
  clearStickyYawPole,
  readStickyYawPole,
  writeStickyYawPole,
  HUNT_YAW_POLE_WEIGHTS,
  isYawPoleArrived,
  isYawPoleLosVisible,
  isYawPoleStickyLocked,
  ownDoorMidpoint,
  PATH_OWN_DOOR_POLE_EXCLUDE,
  pickNextYawPoleTarget,
  pickYawPoleTarget,
  polesForTeam,
  recordYawPoleClear,
  recordYawPoleCommit,
  resolveYawPoleWeights,
  stepStickyYawPole,
  wallBlocksYawPoleLos,
  YAW_POLE_HUMAN_HEAT_MAX,
  yawPoleKey,
  type YawPolePoint,
  type YawPoleScoreWeights,
} from "./helpers/yawPole.ts";
import { JUMP_PROBE_DIST } from "../../helpers/nav.ts";
import { occupiedWallPoleKeys } from "../helpers/playerAvoid.ts";
import {
  applyDwellBreak,
  stepDwellBreak,
} from "../helpers/dwellBreak.ts";
import { playerMoveYawForFov } from "../../players/Player.ts";
import {
  clamp,
  distanceSquared2,
  yawFromWorldDirection,
} from "../../math/index.ts";

export type YawPoleStepOpts = {
  yawPoleNoiseMin: number;
  yawPoleNoiseMax: number;
  huntYawPoleNoiseMin: number;
  huntYawPoleNoiseMax: number;
  pathYawPoleWeights: Partial<YawPoleScoreWeights> | undefined;
  rng: () => number;
  /**
   * Multiplier on {@link YAW_POLE_HUMAN_HEAT_MAX}. Scored only when the
   * frame carries `humanHeatByPole` and this is above 0.
   */
  humanHeatWeight?: number;
};

function mergeIgnoreKeys(
  bagIgnore: Record<string, number>,
  occupied: Readonly<Record<string, number>>,
): Record<string, number> {
  const occupiedKeys = Object.keys(occupied);
  if (occupiedKeys.length === 0) return bagIgnore;
  const out: Record<string, number> = {};
  for (let i = 0; i < occupiedKeys.length; i += 1) {
    out[occupiedKeys[i]!] = 1;
  }
  const ignoreKeys = Object.keys(bagIgnore);
  if (ignoreKeys.length === 0) return out;
  for (let i = 0; i < ignoreKeys.length; i += 1) {
    const k = ignoreKeys[i]!;
    const rem = bagIgnore[k];
    if (typeof rem === "number" && Number.isFinite(rem) && rem > 0) {
      out[k] = rem;
    }
  }
  return out;
}

function readPoleCache(bag: BotBrainState): YawPoleNavDecision | undefined {
  if (!bag.cadenceYawPoleValid) return undefined;
  const mode = bag.cadenceYawPoleMode;
  if (mode !== "path" && mode !== "hunt" && mode !== "doorCamp") {
    return undefined;
  }
  if (!Number.isFinite(bag.cadenceYawPoleGoalX) || !Number.isFinite(bag.cadenceYawPoleGoalZ)) {
    return undefined;
  }
  const target = bag.cadenceYawPoleHasTarget &&
      Number.isFinite(bag.cadenceYawPoleTargetX) &&
      Number.isFinite(bag.cadenceYawPoleTargetZ)
    ? { x: bag.cadenceYawPoleTargetX, z: bag.cadenceYawPoleTargetZ }
    : null;
  const next = bag.cadenceYawPoleHasNext &&
      Number.isFinite(bag.cadenceYawPoleNextX) &&
      Number.isFinite(bag.cadenceYawPoleNextZ)
    ? { x: bag.cadenceYawPoleNextX, z: bag.cadenceYawPoleNextZ }
    : null;
  return {
    mode,
    goal: { x: bag.cadenceYawPoleGoalX, z: bag.cadenceYawPoleGoalZ },
    campArrived: bag.cadenceYawPoleCampArrived,
    target,
    next,
  };
}

function writePoleCache(bag: BotBrainState, out: YawPoleNavDecision): void {
  bag.cadenceYawPoleValid = true;
  bag.cadenceYawPoleMode = out.mode;
  bag.cadenceYawPoleGoalX = out.goal.x;
  bag.cadenceYawPoleGoalZ = out.goal.z;
  bag.cadenceYawPoleCampArrived = out.campArrived;
  if (out.target) {
    bag.cadenceYawPoleHasTarget = true;
    bag.cadenceYawPoleTargetX = out.target.x;
    bag.cadenceYawPoleTargetZ = out.target.z;
  } else {
    bag.cadenceYawPoleHasTarget = false;
    bag.cadenceYawPoleTargetX = UNSET;
    bag.cadenceYawPoleTargetZ = UNSET;
  }
  if (out.next) {
    bag.cadenceYawPoleHasNext = true;
    bag.cadenceYawPoleNextX = out.next.x;
    bag.cadenceYawPoleNextZ = out.next.z;
  } else {
    bag.cadenceYawPoleHasNext = false;
    bag.cadenceYawPoleNextX = UNSET;
    bag.cadenceYawPoleNextZ = UNSET;
  }
}

/**
 * Force full yawPole re-score: mode/spawn noise re-roll, missing noise,
 * unlocked sticky (arrival / lost LOS / no sticky), or planted door-camp
 * (plant is sole target; no sticky cadence hold).
 */
export function shouldForceYawPole(
  prior: NavGoalDecision,
  bag: BotBrainState,
  selfX: number,
  selfZ: number,
  stillVisible: boolean,
  spawnedAtTick: number,
): boolean {
  if (prior.forceNoiseReroll) return true;
  // Planted camp: always re-emit plant (no sticky poles while frozen).
  if (prior.mode === "doorCamp" && prior.campArrived) return true;
  if (!bag.yawPoleNoiseReady) return true;
  if (bag.yawPoleNoiseSpawnedAtTick !== spawnedAtTick) return true;
  if (
    !isYawPoleStickyLocked(
      selfX,
      selfZ,
      readStickyYawPole(bag),
      false,
      stillVisible,
    )
  ) {
    return true;
  }
  return false;
}

/**
 * Hold last pole decision; refresh goal/mode/campArrived from prior.
 * Requires a prior full-run cache for path/hunt/doorCamp-travel so `next`
 * (corner-round) is not silently dropped to null. Planted camp rehydrates
 * to plant with no next.
 */
export function rehydrateYawPoleDecision(
  prior: NavGoalDecision,
  bag: BotBrainState,
): YawPoleNavDecision | null {
  if (prior.mode === "doorCamp" && prior.campArrived) {
    return {
      mode: prior.mode,
      goal: prior.goal,
      campArrived: true,
      target: prior.goal,
      next: null,
    };
  }
  const cache = readPoleCache(bag);
  if (!cache || cache.mode !== prior.mode) return null;
  return {
    mode: prior.mode,
    goal: prior.goal,
    campArrived: prior.campArrived,
    // Prefer live sticky so arrival/clear from other steps stays visible.
    target: readStickyYawPole(bag) ?? cache.target,
    next: cache.next,
  };
}

export function runYawPoleStep(
  ctx: ThinkContext,
  prior: NavGoalDecision,
  draftState: BotBrainState,
  yawPoleNoiseMin: number,
  yawPoleNoiseMax: number,
  huntYawPoleNoiseMin: number,
  huntYawPoleNoiseMax: number,
  pathYawPoleWeights: Partial<YawPoleScoreWeights> | undefined,
  rng: () => number,
  humanHeatWeight: number,
): StepResult<YawPoleNavDecision> {
      const me = ctx.view.self;
      const bag = draftState;
      const perc = ctx.perception;
      const collision = ctx.view.collision;
      const blocksLos = perc?.blocksYawPoleLos
        ? perc.blocksYawPoleLos
        : collision
        ? (ox: number, oz: number, tx: number, tz: number) =>
          wallBlocksYawPoleLos(collision, ox, oz, tx, tz, {
            crouch: me.crouch,
            eyeY: me.y,
          })
        : undefined;

      // Pre-clear sticky only for cadence force/skip decision.
      const stickyForForce = readStickyYawPole(bag);
      const stillVisibleForForce = stickyForForce
        ? isYawPoleLosVisible(me.x, me.z, stickyForForce, blocksLos)
        : true;
      const force = shouldForceYawPole(
        prior,
        bag,
        me.x,
        me.z,
        stillVisibleForForce,
        me.spawnedAtTick,
      );

      if (
        !shouldRunCadencedStep("yawPole", ctx.view.tick, me.id, { force })
      ) {
        const held = rehydrateYawPoleDecision(prior, bag);
        if (held) return { out: held };
      }

      const huntActive = prior.mode === "hunt";
      const doorCampActive = prior.mode === "doorCamp";
      // Travel to plant uses path-style poles; planted freezes on plant only.
      const doorCampTravel = doorCampActive && !prior.campArrived;
      const noiseOpts = huntActive
        ? { min: huntYawPoleNoiseMin, max: huntYawPoleNoiseMax }
        : { min: yawPoleNoiseMin, max: yawPoleNoiseMax };

      const poles = perc
        ? { wallPoles: perc.wallPoles, enemyDoorPoles: perc.enemyDoorPoles }
        : polesForTeam(ctx.view.map, me.team);

      // Death respawn + door-capture home both bump spawnedAtTick.
      // Mode open/close also forces a re-roll (hunt band vs path band).
      if (
        prior.forceNoiseReroll ||
        !bag.yawPoleNoiseReady ||
        bag.yawPoleNoiseSpawnedAtTick !== me.spawnedAtTick
      ) {
        bag.yawPoleNoise = buildYawPoleNoise(poles.wallPoles, rng, noiseOpts);
        bag.yawPoleNoiseReady = true;
        bag.yawPoleNoiseSpawnedAtTick = me.spawnedAtTick;
        clearStickyYawPole(bag);
      }

      const dwellBag = bag;
      const inCombat = bag.targetEnemyId.length > 0;

      // Planted door camp: sole target is the plant — unless dwell-break fires.
      if (doorCampActive && prior.campArrived) {
        const plant = prior.goal;
        const campDwell = stepDwellBreak(dwellBag, {
          x: me.x,
          z: me.z,
          tick: ctx.view.tick,
          inCombat,
          sticky: null,
          campPlant: plant,
          campArrived: true,
        });
        applyDwellBreak(dwellBag, campDwell, { tick: ctx.view.tick });
        if (!campDwell.breakKey) {
          const out: YawPoleNavDecision = {
            mode: prior.mode,
            goal: prior.goal,
            campArrived: true,
            target: plant,
            next: null,
          };
          writePoleCache(bag, out);
          writeStickyYawPole(bag, null);
          clearHuntState(bag);
          bag.doorCampActive = true;
          bag.doorCampPlantX = plant.x;
          bag.doorCampPlantZ = plant.z;
          return { out };
        }
        // Break: plant cleared + force-hunt scheduled; fall through to poles.
      }

      // Sticky after noise re-roll clear (matches pre-cadence step order).
      let sticky = readStickyYawPole(bag);
      const stillVisible = sticky
        ? isYawPoleLosVisible(me.x, me.z, sticky, blocksLos)
        : true;
      // Arrival clear for ping-pong unban (before sticky drops).
      const arrivedSticky = sticky !== undefined &&
        Number.isFinite(sticky.x) &&
        Number.isFinite(sticky.z) &&
        isYawPoleArrived(me.x, me.z, sticky);

      // Dwell anti-stick: linger near sticky without combat → ban + replan.
      const stickyDwell = stepDwellBreak(dwellBag, {
        x: me.x,
        z: me.z,
        tick: ctx.view.tick,
        inCombat,
        sticky,
        campPlant: null,
        campArrived: false,
      });
      applyDwellBreak(dwellBag, stickyDwell, { tick: ctx.view.tick });
      if (stickyDwell.breakKey) {
        sticky = undefined;
      }

      const moveYawFov = playerMoveYawForFov(me);
      const heatW = Number.isFinite(humanHeatWeight)
        ? clamp(humanHeatWeight, 0, 2)
        : 1;
      const heatTable = ctx.view.humanHeatByPole;
      const scoreHeat = heatTable !== undefined && heatW > 0;
      const heatMax = scoreHeat
        ? YAW_POLE_HUMAN_HEAT_MAX * heatW
        : 0;
      const baseWeights = huntActive
        ? HUNT_YAW_POLE_WEIGHTS
        : resolveYawPoleWeights(pathYawPoleWeights);
      const weights = { ...baseWeights, humanHeatMax: heatMax };
      // Path + doorCamp travel: hard door poles when LOS clear.
      // Hunt: wall scores with agent goal (no door hard priority).
      // DoorCamp travel: plant as goalPoint so door-FOV pulls toward camp site.
      // Path / camp travel: ban wall poles on the scorer's own door lip so
      // score-home (and any pose near the home portal) cannot sticky-lock the
      // nearest triangle tip and walk back into their own door.
      const excludeNearOwnDoorDist = huntActive
        ? undefined
        : PATH_OWN_DOOR_POLE_EXCLUDE;
      if (excludeNearOwnDoorDist && sticky) {
        const ownMid = ownDoorMidpoint(ctx.view.map, me.team);
        if (ownMid) {
          const ownDx = sticky.x - ownMid.x;
          const ownDz = sticky.z - ownMid.z;
          if (
            distanceSquared2(ownDx, ownDz) <
              excludeNearOwnDoorDist * excludeNearOwnDoorDist
          ) sticky = undefined;
        }
      }
      const occupied = occupiedWallPoleKeys(
        poles.wallPoles,
        ctx.view.players.filter((p) => p.alive && p.id !== me.id),
      );
      const ignorePoleKeys = mergeIgnoreKeys(bag.yawPoleIgnore, occupied);
      const walkableTo = (tx: number, tz: number): boolean => {
        const dx = tx - me.x;
        const dz = tz - me.z;
        if (dx * dx + dz * dz < 1e-8) return true;
        const yaw = yawFromWorldDirection(dx, dz);
        return collision.classifyForward(
          me.x,
          me.z,
          yaw,
          JUMP_PROBE_DIST,
        ) !== "blocked";
      };

      const pickInput = {
        x: me.x,
        z: me.z,
        yaw: me.yaw,
        moveYaw: moveYawFov,
        team: me.team,
        map: ctx.view.map,
        wallPoles: poles.wallPoles,
        enemyDoorPoles: poles.enemyDoorPoles,
        blocksLos,
        poleNoise: bag.yawPoleNoise,
        goalPoint: huntActive || doorCampTravel ? prior.goal : undefined,
        doorDistPoint: huntActive ? prior.doorDistPoint : undefined,
        hardPrioritizeDoorPoles: huntActive ? false : true,
        excludeNearOwnDoorDist,
        weights,
        // A→B→A / dwell bans + wall poles another body is sitting on.
        ignorePoleKeys,
        walkableTo,
        // Present table and a positive weight. O(1) lookup into the prior.
        humanHeatByPole: scoreHeat ? heatTable : undefined,
      };

      let newPick: YawPolePoint | null = null;
      if (!isYawPoleStickyLocked(me.x, me.z, sticky, false, stillVisible)) {
        newPick = pickYawPoleTarget(pickInput);
      }

      const stepped = stepStickyYawPole({
        x: me.x,
        z: me.z,
        sticky,
        newPick,
        stillVisible,
      });

      // Ping-pong memory: clear-count on arrival; commit when a new sticky locks.
      if (arrivedSticky && sticky && stepped.unlocked) {
        recordYawPoleClear(bag, yawPoleKey(sticky.x, sticky.z));
      }
      if (stepped.sticky) {
        const commitKey = yawPoleKey(stepped.sticky.x, stepped.sticky.z);
        const prevKey = sticky && Number.isFinite(sticky.x) &&
            Number.isFinite(sticky.z)
          ? yawPoleKey(sticky.x, sticky.z)
          : null;
        // First lock, or unlock → new pole (arrival / LOS / clear).
        if (prevKey === null || (stepped.unlocked && commitKey !== prevKey)) {
          recordYawPoleCommit(bag, commitKey);
        }
      }

      let next: YawPolePoint | null = null;
      if (stepped.target) {
        const prevCache = readPoleCache(bag);
        const prevTarget = prevCache?.target;
        const sameTarget = Boolean(
          prevTarget &&
            yawPoleKey(prevTarget.x, prevTarget.z) ===
              yawPoleKey(stepped.target.x, stepped.target.z),
        );
        // Locked current: reuse last stand-at-current next (same FOV/LOS
        // inputs). Re-score only when the sticky target changes.
        next = sameTarget
          ? (prevCache?.next ?? null)
          : pickNextYawPoleTarget(pickInput, stepped.target);
      }

      const out: YawPoleNavDecision = {
        mode: prior.mode,
        goal: prior.goal,
        campArrived: prior.campArrived,
        target: stepped.target,
        next,
      };
      writePoleCache(bag, out);
      writeStickyYawPole(bag, stepped.sticky);
      if (!huntActive) clearHuntState(bag);
      if (doorCampTravel) {
        bag.doorCampActive = true;
        bag.doorCampPlantX = prior.goal.x;
        bag.doorCampPlantZ = prior.goal.z;
      }
      return { out };
}

export function createYawPoleStep(
  opts: YawPoleStepOpts,
) {
  const {
    yawPoleNoiseMin,
    yawPoleNoiseMax,
    huntYawPoleNoiseMin,
    huntYawPoleNoiseMax,
    pathYawPoleWeights,
    rng,
    humanHeatWeight = 1,
  } = opts;
  return {
    id: "yawPole",
    kind: "switch",
    run(ctx, prior, draftState) {
      return runYawPoleStep(
        ctx,
        prior,
        draftState,
        yawPoleNoiseMin,
        yawPoleNoiseMax,
        huntYawPoleNoiseMin,
        huntYawPoleNoiseMax,
        pathYawPoleWeights,
        rng,
        humanHeatWeight,
      );
    },
  } satisfies ThinkStep<NavGoalDecision, YawPoleNavDecision>;
}
