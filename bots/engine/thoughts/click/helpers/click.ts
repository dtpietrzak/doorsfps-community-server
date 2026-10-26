/**
 * Pure bot click / shoot gate: fire while a hostile sits inside a tiny
 * ±1° box (yaw + pitch) centered on the eye camera.
 *
 * Pipeline: after {@code yawHumanize} so the spring / humanized look sample is
 * what we test. Hold-fire is automatic — re-check every think; stop when the
 * enemy leaves the box.
 *
 * Preferred combat lock uses the same aim **lead** as targetEnemy (sticky
 * velocity on brain bag) so hitscan track stays coherent with combat look.
 */

import { SHOOT_AIM_FOV_HALF_ANGLE } from "../../../../../shared/world/wallCorners.ts";
import { yawAbsDelta } from "../../../../../shared/world/yawPole.ts";
import { msToTicks, type PlayerInput } from "../../../shared/network.ts";
import type { Player } from "../../../players/Player.ts";
import type { MapCollision } from "../../../world/MapCollision.ts";
import {
  abs,
  distanceSquared2,
  max,
  min,
  radians,
} from "../../../math/index.ts";
import {
  areHostile,
  type CombatAimHeight,
  isHiddenByGlitch,
  pickCombatAimPoint,
  pickCombatAimPointPreferred,
} from "../../../helpers/combat.ts";
import { pitchToward, yawToward } from "../../../helpers/nav.ts";
import {
  combatAimForClick,
  type TargetEnemyState,
} from "../../targetEnemy/helpers/targetEnemy.ts";

/** Re-export for brains / tests. */
export { SHOOT_AIM_FOV_HALF_ANGLE };

/** Any WASD held — walk/sprint bloom unless crouched or Hawkeyes. */
export function inputHorizMoving(
  input: Pick<PlayerInput, "forward" | "backward" | "left" | "right">,
): boolean {
  return input.forward || input.backward || input.left || input.right;
}

/**
 * Hitscan cone is stance-based (rifle walk 1.15°, sprint 2°; planted 0°).
 * Allow the click when Hawkeyes is up, already crouched, or planted.
 */
export function botShotStanceOk(
  input: Pick<
    PlayerInput,
    "forward" | "backward" | "left" | "right" | "crouch"
  >,
  hawkeyesActive: boolean,
): boolean {
  if (hawkeyesActive) return true;
  if (input.crouch) return true;
  return !inputHorizMoving(input);
}

/**
 * Zero WASD + sprint so this think's hitscan uses the still cone.
 * Does not touch look, jump, or crouch (vault/duck keep body ownership;
 * forcing crouch made bots duck the whole gunfight).
 */
export function plantInputForShot(input: PlayerInput): PlayerInput {
  return {
    sequence: input.sequence,
    forward: false,
    backward: false,
    left: false,
    right: false,
    jump: input.jump,
    sprint: false,
    crouch: input.crouch,
    yaw: input.yaw,
    pitch: input.pitch,
  };
}

/** True when weapon CD + extra interval have elapsed since last real shot. */
export function weaponReadyForShot(
  lastShotAtTick: number,
  tick: number,
  fireCooldownMs: number,
  extraIntervalMs = 0,
): boolean {
  if (!Number.isFinite(lastShotAtTick)) return true;
  const extra = Number.isFinite(extraIntervalMs) && extraIntervalMs > 0
    ? extraIntervalMs
    : 0;
  const cd = Number.isFinite(fireCooldownMs) && fireCooldownMs > 0
    ? fireCooldownMs
    : 0;
  const gapTicks = max(1, msToTicks(cd + extra));
  return tick - lastShotAtTick >= gapTicks;
}

/**
 * Cap on the pursuit-trail box allowance (rad, ~4°) — matches the aim
 * planner's pursuit band; anything wider is a stroke, not tracking.
 */
const PURSUIT_TRAIL_CAP_RAD = radians(4);

/**
 * Angle (rad) a pursuit-lagged hand trails the lead point: the larger of the
 * yaw / pitch bearing deltas between `aim` and `aim − v·lagSec` from the eye.
 * Without it a tight tier box (hard 1°) sits inside the planner's own
 * designed trail, so a bot tracking any mover never clicks.
 */
export function pursuitTrailAllowance(
  eye: { x: number; y: number; z: number },
  aim: { x: number; y: number; z: number },
  state: TargetEnemyState | undefined,
  lagSec: number,
): number {
  if (!state || !(lagSec > 0)) return 0;
  const vx = Number.isFinite(state.targetEnemyVx) ? state.targetEnemyVx! : 0;
  const vy = Number.isFinite(state.targetEnemyVy) ? state.targetEnemyVy! : 0;
  const vz = Number.isFinite(state.targetEnemyVz) ? state.targetEnemyVz! : 0;
  if (vx === 0 && vy === 0 && vz === 0) return 0;
  const tx = aim.x - vx * lagSec;
  const ty = aim.y - vy * lagSec;
  const tz = aim.z - vz * lagSec;
  const dYaw = yawAbsDelta(
    yawToward(eye.x, eye.z, aim.x, aim.z),
    yawToward(eye.x, eye.z, tx, tz),
  );
  const dPitch = abs(
    pitchToward(eye.x, eye.y, eye.z, aim.x, aim.y, aim.z) -
      pitchToward(eye.x, eye.y, eye.z, tx, ty, tz),
  );
  const trail = max(dYaw, dPitch);
  return Number.isFinite(trail) ? min(PURSUIT_TRAIL_CAP_RAD, trail) : 0;
}

/**
 * True when the aim point sits inside the rectangular shoot FOV centered on
 * camera yaw/pitch (both axes use the same half-angle).
 */
export function enemyInShootAimBox(
  eyeX: number,
  eyeY: number,
  eyeZ: number,
  cameraYaw: number,
  cameraPitch: number,
  aimX: number,
  aimY: number,
  aimZ: number,
  halfAngle: number = SHOOT_AIM_FOV_HALF_ANGLE,
): boolean {
  const dx = aimX - eyeX;
  const dy = aimY - eyeY;
  const dz = aimZ - eyeZ;
  const horizSquared = distanceSquared2(dx, dz);
  // Stacked on the target — treat as dead center.
  if (horizSquared < 1e-12 && abs(dy) < 1e-6) return true;

  const bearingYaw = yawToward(eyeX, eyeZ, aimX, aimZ);
  const bearingPitch = pitchToward(eyeX, eyeY, eyeZ, aimX, aimY, aimZ);
  if (yawAbsDelta(bearingYaw, cameraYaw) > halfAngle + 1e-9) return false;
  if (abs(bearingPitch - cameraPitch) > halfAngle + 1e-9) return false;
  return true;
}

export type StepClickInput = {
  self: Player;
  players: readonly Player[];
  collision: MapCollision;
  /** Final look sample after yawHumanize. */
  yaw: number;
  pitch: number;
  /**
   * Prefer the combat-locked id when set so we don't spray a different body
   * that happens to graze the crosshair. Falls back to any hostile in-box.
   */
  preferredEnemyId?: string | null;
  /**
   * Shoot aim half-angle in radians (yaw + pitch box).
   * Defaults to {@link SHOOT_AIM_FOV_HALF_ANGLE} (1°). Tiers pass wider boxes.
   */
  halfAngle?: number;
  /**
   * Pre-filtered hostiles from perception. When set, scan this list instead
   * of all players (still rechecks aim box + combat LOS at final eye).
   */
  hostiles?: readonly Player[];
  /**
   * Sticky combat bag (velocity samples) so preferred lock uses the same
   * lead as targetEnemy. Optional — without it, aim is current-body only.
   */
  targetEnemyState?: TargetEnemyState;
  /**
   * Sticky head/torso preference from combatPitch. When set, preferred-lock
   * aim box uses the same height as combat look (avoids head-aim + torso-box
   * silent no-shoot on tight half-angles).
   */
  preferAimHeight?: CombatAimHeight;
  /** Combat lead horizon (seconds). Omit → {@link TARGET_ENEMY_LEAD_SEC}. */
  leadSec?: number;
  /**
   * Aim planner smooth-pursuit lag (seconds). The hand trails a mover's lead
   * point by about velocity × this, so the preferred lock's box widens by that
   * angle (capped at {@link PURSUIT_TRAIL_CAP_RAD}). 0 / omit → no allowance.
   */
  pursuitLagSec?: number;
  /** Sim tick for Glitch hide checks (omit only in unit tests). */
  tick?: number;
};

/**
 * Pure click decision: any hostile (prefer sticky lock) inside the shoot aim
 * box with clear combat LOS (torso, else head over half cover) ⇒ hold shoot.
 * Half-angle defaults to 1°. Preferred lock leads with targetEnemy velocity.
 */
export function stepClick(input: StepClickInput): boolean {
  const { self, collision, yaw, pitch } = input;
  const halfAngle = input.halfAngle ?? SHOOT_AIM_FOV_HALF_ANGLE;
  const eye = { x: self.x, y: self.y, z: self.z };
  const pref = typeof input.preferredEnemyId === "string" &&
      input.preferredEnemyId.length > 0
    ? input.preferredEnemyId
    : null;

  const pool = input.hostiles ?? input.players;

  // Prefer locked target first so multi-body crosshair noise stays stable.
  const ordered = pref
    ? [
      ...pool.filter((p) => p.id === pref),
      ...pool.filter((p) => p.id !== pref),
    ]
    : pool;

  for (const other of ordered) {
    if (!other.alive || other.id === self.id) continue;
    if (!areHostile(self, other)) continue;
    if (
      typeof input.tick === "number" &&
      isHiddenByGlitch(other)
    ) {
      continue;
    }
    // Preferred lock: same lead + height as combat look; others stay live body.
    const isPref = pref !== null && other.id === pref;
    const aim = isPref
      ? combatAimForClick(
        self,
        other,
        collision,
        input.targetEnemyState,
        input.leadSec,
        input.preferAimHeight,
      )
      : pickCombatAimPoint(collision, eye, other);
    if (!aim) continue;
    const boxHalfAngle = isPref
      ? halfAngle +
        pursuitTrailAllowance(
          eye,
          aim,
          input.targetEnemyState,
          input.pursuitLagSec ?? 0,
        )
      : halfAngle;
    if (
      enemyInShootAimBox(
        eye.x,
        eye.y,
        eye.z,
        yaw,
        pitch,
        aim.x,
        aim.y,
        aim.z,
        boxHalfAngle,
      )
    ) {
      return true;
    }
    // A hand fires with the crosshair on the body it sees, too: on an ADAD
    // reversal the lead point flips across the body faster than the planner
    // re-strokes, so a lead-only box starves tight tiers of every shot.
    if (!isPref) continue;
    const live = input.preferAimHeight
      ? pickCombatAimPointPreferred(collision, eye, other, input.preferAimHeight)
      : pickCombatAimPoint(collision, eye, other);
    if (
      live &&
      enemyInShootAimBox(
        eye.x,
        eye.y,
        eye.z,
        yaw,
        pitch,
        live.x,
        live.y,
        live.z,
        halfAngle,
      )
    ) {
      return true;
    }
  }
  return false;
}
