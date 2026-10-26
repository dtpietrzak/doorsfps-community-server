/**
 * Near open doors: force a straight walk into the enemy door mouth.
 *
 * Side door poles + ADAD often pull bots past the frame; the center pole is
 * the walkable mouth of the score door. Within
 * {@link DOOR_CENTER_BLINE_COMMIT_DIST} the commit ignores look FOV so a
 * side-pole face still walks the gap. Own door is never a bline target —
 * after score-home bots stand in their portal, and facing it would trap them
 * walking back into the gap.
 */

import type { DoorsMap } from "../../../shared/map.ts";
import type { TeamId } from "../../../shared/network.ts";
import { YAW_PLAYER_FOV_HALF_ANGLE } from "../../../../../shared/world/wallCorners.ts";
import { distance2, min } from "../../../math/index.ts";
import {
  enemyDoorMidpoint,
  yawInHalfAngle,
  type YawPolePoint,
  yawTowardPoint,
} from "../../yawPole/helpers/yawPole.ts";

/**
 * Horizontal range (world units) from a door center pole that arms the
 * straight-through commit when the center sits in front vision.
 */
export const DOOR_CENTER_BLINE_DIST = 5;

/**
 * Inside this range the mouth is a commit regardless of look FOV.
 * Side-pole + ADAD often face the frame at ~3–4u; requiring vision
 * here is what produced DOOR-DANCE / DOOR-REFUSE.
 */
export const DOOR_CENTER_BLINE_COMMIT_DIST = 4;

/**
 * Front-vision half-angle for the center pole check (player FOV wedge).
 * Same green wedge used by yaw-pole player FOV scoring.
 */
export const DOOR_CENTER_BLINE_FOV_HALF = YAW_PLAYER_FOV_HALF_ANGLE;

export type DoorCenterBlineInput = {
  x: number;
  z: number;
  /** Body look yaw — "front vision" is centered on this. */
  faceYaw: number;
  map: DoorsMap;
  team: TeamId;
  /** Only while doors are open (closed mouths are solid). */
  doorsOpen: boolean;
  maxDist?: number;
  fovHalfAngle?: number;
};

/**
 * If the bot should walk straight into the **enemy** door mouth, return that
 * door's center yaw-pole. Own door never qualifies (score-home trap).
 *
 * Arms when doors are open and either:
 * - feet are within {@link DOOR_CENTER_BLINE_COMMIT_DIST} (any facing), or
 * - feet are within {@link DOOR_CENTER_BLINE_DIST} **and** the center pole
 *   sits in front vision.
 *
 * Returns null when doors are closed or the enemy center is not eligible.
 */
export function pickDoorCenterBlineTarget(
  input: DoorCenterBlineInput,
): YawPolePoint | null {
  if (!input.doorsOpen) return null;
  const maxDist = input.maxDist ?? DOOR_CENTER_BLINE_DIST;
  const half = input.fovHalfAngle ?? DOOR_CENTER_BLINE_FOV_HALF;
  if (!(maxDist > 0) || !(half > 0)) return null;

  const { x, z, faceYaw, map, team } = input;
  if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(faceYaw)) {
    return null;
  }

  const enemy = enemyDoorMidpoint(map, team);
  if (!enemy) return null;

  const d = distance2(enemy.x - x, enemy.z - z);
  if (!(d <= maxDist) || !(d > 1e-6)) return null;
  const bearing = yawTowardPoint(x, z, enemy.x, enemy.z);
  if (bearing === null) return null;
  const commitDist = min(DOOR_CENTER_BLINE_COMMIT_DIST, maxDist);
  if (d <= commitDist) return enemy;
  if (!yawInHalfAngle(faceYaw, bearing, half)) return null;
  return enemy;
}
