/**
 * Server yaw-pole helpers: shared pure pick + MapCollision LOS / view convenience.
 *
 * Selection logic lives in `shared/world/yawPole.ts` (same as client blue guide).
 */

import {
  pickYawPoleTarget,
  polesForTeam,
  yawPoleBellyY,
  yawPoleLosQuery,
  type YawPoleMap,
  type YawPolePoint,
  type YawPoleScoreWeights,
  type YawPoleTeamId,
} from "../../../../../shared/world/yawPole.ts";
import type { DoorsMap } from "../../../shared/map.ts";
import type { MapCollision } from "../../../world/MapCollision.ts";

export {
  buildYawPoleNoise,
  computeYawPoleCornerRound,
  DEFAULT_YAW_POLE_WEIGHTS,
  enemyDoorMidpoint,
  centerEnemyDoorPole,
  HUNT_DOOR_BIAS_FLIP_RADIUS,
  HUNT_DOOR_DIST_MAX,
  HUNT_DOOR_FOV_HALF_ANGLE,
  HUNT_YAW_POLE_DOOR_FOV_SCORE,
  HUNT_YAW_POLE_MAP_CENTER_MAX,
  HUNT_YAW_POLE_MOVEMENT_FOV_CENTER,
  HUNT_YAW_POLE_MOVEMENT_FOV_EDGE,
  HUNT_YAW_POLE_NOISE_MAX,
  HUNT_YAW_POLE_NOISE_MIN,
  HUNT_YAW_POLE_PLAYER_FOV_CENTER,
  HUNT_YAW_POLE_WEIGHTS,
  isYawPoleArrived,
  isYawPoleLosVisible,
  isYawPoleStickyLocked,
  maxStrafeFromCornerRound,
  movementFovPoleScore,
  ownDoorMidpoint,
  PATH_OWN_DOOR_POLE_EXCLUDE,
  pickNextYawPoleTarget,
  type PickYawPoleInput,
  pickYawPoleTarget,
  playerFovPoleScore,
  polesForTeam,
  resolveGoalYaw,
  resolveYawPoleWeights,
  type ScoredYawPole,
  scoreYawWallPoles,
  splitYawPoles,
  stepStickyYawPole,
  type StickyYawPoleState,
  wishMoveYaw,
  YAW_BELLY_FROM_FEET_CROUCH,
  YAW_BELLY_FROM_FEET_STAND,
  YAW_DOOR_FOV_HALF_ANGLE,
  YAW_MOVEMENT_FOV_HALF_ANGLE,
  YAW_PLAYER_FOV_HALF_ANGLE,
  YAW_POLE_COMMIT_HISTORY_LEN,
  YAW_POLE_HUMAN_HEAT_MAX,
  YAW_POLE_COMMIT_KEYS_KEY,
  YAW_POLE_CORNER_END_DIST,
  YAW_POLE_CORNER_LOOK_BLEND,
  YAW_POLE_CORNER_MAX_STRAFE,
  YAW_POLE_CORNER_MIN_TURN,
  YAW_POLE_CORNER_OVER_STRAFE_MAX,
  YAW_POLE_CORNER_START_DIST,
  YAW_POLE_CORNER_STRAFE_REF_ANGLE,
  YAW_POLE_IGNORE_KEY,
  YAW_POLE_LOS_RANGE_INSET,
  YAW_POLE_NOISE_MAX,
  YAW_POLE_NOISE_MIN,
  YAW_POLE_PINGPONG_CLEARS_REQUIRED,
  YAW_POLE_SKIP_RADIUS,
  YAW_POLE_STICKY_KEY,
  yawFromWorldDir,
  yawInHalfAngle,
  yawPoleBellyY,
  yawPoleCornerApproachT,
  type YawPoleCornerRound,
  yawPoleDoorDistScores,
  yawPoleKey,
  yawPoleKeyIgnored,
  yawPoleLosQuery,
  type YawPoleMap,
  yawPoleMapCenter,
  yawPoleMapCenterScore,
  type YawPolePoint,
  type YawPoleScoreBreakdown,
  type YawPoleScoreWeights,
  yawPoleSignedDelta,
  type YawPoleTeamId,
  yawPoleToward,
  yawTowardEnemyDoor,
  yawTowardPoint,
} from "../../../../../shared/world/yawPole.ts";
export {
  clearStickyYawPole,
  clearYawPolePingPong,
  readStickyYawPole,
  writeStickyYawPole,
  recordYawPoleClear,
  recordYawPoleCommit,
} from "./stickyBag.ts";

/**
 * Full-wall LOS block at navel height (same idea as client blue guide).
 */
export function wallBlocksYawPoleLos(
  collision: MapCollision,
  ox: number,
  oz: number,
  tx: number,
  tz: number,
  opts?: { crouch?: boolean; eyeY?: number },
): boolean {
  const q = yawPoleLosQuery(ox, oz, tx, tz);
  if (!q) return false;
  const bellyY = yawPoleBellyY(opts);
  const hit = collision.raycastFullSolid(
    { x: ox, y: bellyY, z: oz },
    { x: q.dirX, y: 0, z: q.dirZ },
    q.range,
  );
  return hit !== null;
}

/** Convenience: pick pole from a live map + collision view. */
export function pickYawPoleFromView(args: {
  x: number;
  z: number;
  yaw: number;
  /** Horizontal move yaw; omit when not moving. */
  moveYaw?: number | null;
  team: YawPoleTeamId;
  crouch?: boolean;
  eyeY?: number;
  map: DoorsMap | YawPoleMap;
  collision?: MapCollision | null;
  /** Per-bot spawn noise keyed by yawPoleKey; missing keys count as 0. */
  poleNoise?: Readonly<Record<string, number>>;
  goalPoint?: YawPolePoint | null;
  doorDistPoint?: YawPolePoint | null;
  hardPrioritizeDoorPoles?: boolean;
  weights?: Partial<YawPoleScoreWeights> | null;
}): YawPolePoint | null {
  const { wallPoles, enemyDoorPoles } = polesForTeam(args.map, args.team);
  const crouch = Boolean(args.crouch);
  const blocksLos = args.collision
    ? (ox: number, oz: number, tx: number, tz: number) =>
      wallBlocksYawPoleLos(args.collision!, ox, oz, tx, tz, {
        crouch,
        eyeY: args.eyeY,
      })
    : undefined;
  return pickYawPoleTarget({
    x: args.x,
    z: args.z,
    yaw: args.yaw,
    moveYaw: args.moveYaw,
    team: args.team,
    map: args.map,
    wallPoles,
    enemyDoorPoles,
    blocksLos,
    poleNoise: args.poleNoise,
    goalPoint: args.goalPoint,
    doorDistPoint: args.doorDistPoint,
    hardPrioritizeDoorPoles: args.hardPrioritizeDoorPoles,
    weights: args.weights,
  });
}
