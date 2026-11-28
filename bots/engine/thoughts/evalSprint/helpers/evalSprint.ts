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

// ── Door rush (doors open) ─────────────────────────────────────────────────

/**
 * Doors-open rush: added to the tier `sprintChance` for the once-per-window
 * roll (Easy 0.22 → 0.67, Medium 0.42 → 0.87, Hard 0.65 → 1). Humans sprint
 * nearly every door window; the old open-lane roll (0.75× chance, top 42% of
 * the bar, re-rolled on every stamina dip) left bots jogging at the door.
 */
export const DOOR_RUSH_SPRINT_CHANCE_BONUS = 0.45;

/**
 * Rush sprints the bar down to this fraction (a jump's worth stays in
 * reserve), then walks until {@link DOOR_RUSH_RESUME_STAMINA_FRAC}.
 */
export const DOOR_RUSH_MIN_STAMINA_FRAC = 0.12;

/** Winded rusher resumes sprinting once the bar refills to this fraction. */
export const DOOR_RUSH_RESUME_STAMINA_FRAC = 0.45;

/** Rush floor / resume at full trailing door push (see §3.4 in the notes). */
export const DOOR_PUSH_RUSH_MIN_STAMINA_FRAC = 0.04;
export const DOOR_PUSH_RUSH_RESUME_STAMINA_FRAC = 0.3;

function clampPush(push: number | undefined): number {
  if (typeof push !== "number" || !Number.isFinite(push) || push <= 0) return 0;
  return push >= 1 ? 1 : push;
}

/**
 * Per-window rush roll. `push` (trailing capture bot, 0..1) closes the gap
 * to 1: `c + push × (1 − c)`.
 */
export function doorRushSprintChance(sprintChance: number, push = 0): number {
  const base = sprintChance + DOOR_RUSH_SPRINT_CHANCE_BONUS;
  const c = base >= 1 ? 1 : base <= 0 ? 0 : base;
  const p = clampPush(push);
  return c + p * (1 - c);
}

/** Rush stamina floor / resume fractions, lerped by trailing push. */
export function doorRushStaminaFracs(
  push = 0,
): { min: number; resume: number } {
  const p = clampPush(push);
  return {
    min: DOOR_RUSH_MIN_STAMINA_FRAC +
      p * (DOOR_PUSH_RUSH_MIN_STAMINA_FRAC - DOOR_RUSH_MIN_STAMINA_FRAC),
    resume: DOOR_RUSH_RESUME_STAMINA_FRAC +
      p * (DOOR_PUSH_RUSH_RESUME_STAMINA_FRAC - DOOR_RUSH_RESUME_STAMINA_FRAC),
  };
}

export type StepEvalDoorRushInput = DoorRunInput & {
  collision: MapCollision;
  sprintStamina: number;
  /** Winded latch from the previous think (hit the floor, still refilling). */
  winded: boolean;
  /** Trailing capture push (0..1): lower floor / resume. */
  push?: number;
  maxSprintStamina?: number;
  openDist?: number;
};

/**
 * Doors-open rush. Caller gates on doors open + path mode (no hunt / camp).
 * Returns whether the lane wants a sprint and the next winded latch.
 * Unlike open-lane sprint it drains the bar nearly empty, with hysteresis so
 * a winded bot walks a beat instead of flickering sprint on every regen tick.
 */
export function stepEvalDoorRushSprint(
  input: StepEvalDoorRushInput,
): { want: boolean; winded: boolean } {
  const max = input.maxSprintStamina ?? SPRINT_DURATION_S;
  const stamina = input.sprintStamina;
  if (!(max > 0) || !Number.isFinite(stamina)) {
    return { want: false, winded: input.winded };
  }
  const fracs = doorRushStaminaFracs(input.push);
  let winded = input.winded;
  if (winded) {
    if (stamina >= max * fracs.resume) winded = false;
  } else if (stamina <= max * fracs.min) {
    winded = true;
  }
  if (winded) return { want: false, winded };
  if (!isMoveTowardEnemyDoorLenient(input)) return { want: false, winded };
  const runYaw = resolveMoveYaw(input);
  if (runYaw === null) return { want: false, winded };
  const open = hasOpenSpaceAhead(
    input.collision,
    input.x,
    input.z,
    runYaw,
    input.openDist ?? SPRINT_OPEN_DIST,
  );
  return { want: open, winded };
}
