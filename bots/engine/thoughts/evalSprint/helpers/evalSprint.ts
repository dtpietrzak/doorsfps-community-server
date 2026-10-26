/**
 * Pure evalSprint helpers:
 * - **Zone sprint** — map-hint sprint polygon + move inside door FOV cone.
 * - **Open sprint** — clear lane ahead + move with any progress toward the
 *   enemy door (lenient hemisphere / N–S for standard maps) + stamina &gt; 50%.
 *
 * Zone / force sprint ignore the open-stamina gate (slides also unchanged).
 * "Running toward the door" uses path/move yaw, not body look.
 *
 * Pipeline: after {@code targetEnemy}, before {@code navigate}. Navigate reads
 * the boolean onto {@code input.sprint} (duck/crouch still force false).
 */

import { SPRINT_DURATION_S } from "../../../../../shared/sim/game.ts";
import { YAW_DOOR_FOV_HALF_ANGLE } from "../../../../../shared/world/wallCorners.ts";
import { yawInHalfAngle } from "../../../../../shared/world/yawPole.ts";
import type { DoorsMap } from "../../../shared/map.ts";
import type { TeamId } from "../../../shared/network.ts";
import type { MapCollision } from "../../../world/MapCollision.ts";
import { fastSinCos } from "../../../math/index.ts";
import { inSprintZone } from "../../helpers/hints.ts";
import {
  enemyDoorTarget,
  hasOpenSpaceAhead,
  SPRINT_OPEN_DIST,
  yawToward,
} from "../../../helpers/nav.ts";

/**
 * Open-lane sprint only when remaining bar is strictly above this fraction
 * of capacity (≤ this → walk / regen). Zone + force sprint ignore this.
 * Raised above 0.5 so bots over-sprint less vs humans (heatmap sprint/walk).
 */
export const OPEN_SPRINT_MIN_STAMINA_FRAC = 0.58;

/**
 * Open-lane uses a lower chance than zone sprint (mid-map free sprint was
 * over-firing vs human heatmaps). Zone latch still uses full `sprintChance`.
 */
export const OPEN_SPRINT_CHANCE_SCALE = 0.75;

/** Re-export the cone used for zone door-run sprint (same as yellow door FOV). */
export { YAW_DOOR_FOV_HALF_ANGLE };

export type DoorRunInput = {
  map: DoorsMap;
  team: TeamId;
  x: number;
  z: number;
  /**
   * World move / run yaw ({@code prior.moveYaw}), not body look.
   */
  moveYaw: number;
  /** @deprecated Use {@link moveYaw}. Accepted as alias for older call sites. */
  facingYaw?: number;
  /** Precomputed enemy door mid; omit to call {@link enemyDoorTarget}. */
  enemyDoor?: { x: number; z: number };
};

export type StepEvalSprintInput = DoorRunInput & {
  /** Override door-run half-angle; default {@link YAW_DOOR_FOV_HALF_ANGLE}. */
  halfAngle?: number;
};

function resolveMoveYaw(input: DoorRunInput): number | null {
  const runYaw = Number.isFinite(input.moveYaw)
    ? input.moveYaw
    : input.facingYaw;
  if (typeof runYaw !== "number" || !Number.isFinite(runYaw)) return null;
  return runYaw;
}

/**
 * True when world move yaw points at the enemy door midpoint within the
 * door FOV cone (from anywhere on the map). Does not require a sprint zone.
 */
export function isMoveTowardEnemyDoor(input: StepEvalSprintInput): boolean {
  const runYaw = resolveMoveYaw(input);
  if (runYaw === null) return false;
  const door = input.enemyDoor ?? enemyDoorTarget(input.map, input.team);
  const bearing = yawToward(input.x, input.z, door.x, door.z);
  const half = input.halfAngle ?? YAW_DOOR_FOV_HALF_ANGLE;
  return yawInHalfAngle(bearing, runYaw, half);
}

/**
 * Lenient door-run: any world-move component that progresses toward the enemy
 * door (open half-plane). On N–S maps this is essentially "going north" for
 * team A and "going south" for team B — diagonals count; pure east/west or
 * retreat does not.
 */
export function isMoveTowardEnemyDoorLenient(input: DoorRunInput): boolean {
  const runYaw = resolveMoveYaw(input);
  if (runYaw === null) return false;
  const door = input.enemyDoor ?? enemyDoorTarget(input.map, input.team);
  const dx = door.x - input.x;
  const dz = door.z - input.z;
  // Forward from yaw (matches moveStep / nav probe convention).
  const direction = fastSinCos(runYaw);
  const fx = -direction.sin;
  const fz = -direction.cos;
  // Strictly some progress toward the door (not pure lateral / reverse).
  return fx * dx + fz * dz > 1e-6;
}

/**
 * True when the bot is inside a team sprint-hint polygon **and** world move
 * is inside the door FOV cone.
 */
export function stepEvalSprint(input: StepEvalSprintInput): boolean {
  if (!inSprintZone(input.map, input.team, input.x, input.z)) return false;
  return isMoveTowardEnemyDoor(input);
}

export type StepEvalOpenSprintInput = DoorRunInput & {
  collision: MapCollision;
  /** Remaining sprint stamina (bar units). */
  sprintStamina: number;
  /** Full bar capacity; default {@link SPRINT_DURATION_S}. */
  maxSprintStamina?: number;
  /** Clear-lane probe distance; default {@link SPRINT_OPEN_DIST}. */
  openDist?: number;
};

/**
 * True when open-lane sprint is allowed from energy: strictly more than half
 * a bar remaining. At 50% or below, open sprint is off (zone/force still ok).
 */
export function canOpenSprintFromStamina(
  sprintStamina: number,
  maxStamina: number = SPRINT_DURATION_S,
): boolean {
  if (!(maxStamina > 0) || !Number.isFinite(sprintStamina)) return false;
  return sprintStamina > maxStamina * OPEN_SPRINT_MIN_STAMINA_FRAC;
}

/**
 * True when the lane along move yaw is open, move has any progress toward the
 * enemy door (lenient hemisphere), **and** stamina is over half. No zone
 * required. Force/zone paths do not use this helper.
 */
export function stepEvalOpenSprint(input: StepEvalOpenSprintInput): boolean {
  if (
    !canOpenSprintFromStamina(
      input.sprintStamina,
      input.maxSprintStamina ?? SPRINT_DURATION_S,
    )
  ) {
    return false;
  }
  if (!isMoveTowardEnemyDoorLenient(input)) return false;
  const runYaw = resolveMoveYaw(input);
  if (runYaw === null) return false;
  return hasOpenSpaceAhead(
    input.collision,
    input.x,
    input.z,
    runYaw,
    input.openDist ?? SPRINT_OPEN_DIST,
  );
}
