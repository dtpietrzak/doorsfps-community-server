/**
 * Movement-based aim cone. Stance rules live here; degree tables live in
 * shared/sim/weapons.ts (keep client/src/game/aimSpread.ts math in sync).
 *
 * Stance rules:
 * - crouch or standing still → still
 * - walking → walk
 * - sprinting → sprint
 * - airborne (jump/fall) or crouch-slide → air
 */

import {
  aimSpreadDegForWeapon,
  type AimSpreadStance,
  crosshairSpreadMultFromDeg,
  WEAPON_RIFLE,
} from "../shared/sim/weapons.ts";
import { directionFromYawPitch, normalize, type Vec3 } from "./hitscan.ts";

export type { AimSpreadStance };

export type AimMovementState = {
  onGround: boolean;
  crouch: boolean;
  /** Any horizontal move intent (WASD). */
  moving: boolean;
  /** Sprint held and not crouching. */
  sprint: boolean;
  /** Crouch-slide burst — same bloom as airborne. */
  sliding?: boolean;
};

export function aimSpreadStance(state: AimMovementState): AimSpreadStance {
  if (!state.onGround) return "air";
  if (state.sliding) return "air";
  // Crouch always uses baseline accuracy (even while strafing).
  if (state.crouch) return "still";
  if (!state.moving) return "still";
  if (state.sprint) return "sprint";
  return "walk";
}

/** Optional aim overrides (Hawkeyes → perfectAccuracy). */
export type AimSpreadOpts = {
  /**
   * When true: cone half-angle is 0 (laser / rifle-still accuracy for both
   * weapons). Client also forces the rifle-tight crosshair base px.
   */
  perfectAccuracy?: boolean;
};

export function aimSpreadRad(
  state: AimMovementState,
  weaponId: number = WEAPON_RIFLE,
  opts?: AimSpreadOpts,
): number {
  if (opts?.perfectAccuracy) return 0;
  const deg = aimSpreadDegForWeapon(weaponId, aimSpreadStance(state));
  return (deg * Math.PI) / 180;
}

export function crosshairSpreadMult(
  state: AimMovementState,
  weaponId: number = WEAPON_RIFLE,
  opts?: AimSpreadOpts,
): number {
  if (opts?.perfectAccuracy) return 1;
  const deg = aimSpreadDegForWeapon(weaponId, aimSpreadStance(state));
  return crosshairSpreadMultFromDeg(weaponId, deg);
}

/**
 * Uniform sample inside a cone of half-angle `maxAngleRad` around `direction`.
 * Returns a unit vector. When maxAngleRad ≤ 0, returns the normalized aim
 * without calling `rng`.
 *
 * When the cone is open, consumes exactly two unit samples (radius, then
 * theta). The authoritative server shoot path must pass an injected `rng`
 * (PlayerManager.spreadRandom). The Math.random default is for non-sim /
 * client-preview callers only.
 */
export function applyAimSpread(
  direction: Vec3,
  maxAngleRad: number,
  rng: () => number = Math.random,
): Vec3 {
  const dir = normalize(direction);
  if (!(maxAngleRad > 0)) return dir;

  // Orthonormal basis: right, up relative to look direction.
  let right: Vec3 = {
    x: dir.z,
    y: 0,
    z: -dir.x,
  };
  let rLen = Math.hypot(right.x, right.z);
  if (rLen < 1e-6) {
    // Looking straight up/down — pick an arbitrary horizontal right.
    right = { x: 1, y: 0, z: 0 };
    rLen = 1;
  }
  right = { x: right.x / rLen, y: 0, z: right.z / rLen };

  const up: Vec3 = {
    x: right.y * dir.z - right.z * dir.y,
    y: right.z * dir.x - right.x * dir.z,
    z: right.x * dir.y - right.y * dir.x,
  };
  const upLen = Math.hypot(up.x, up.y, up.z) || 1;
  up.x /= upLen;
  up.y /= upLen;
  up.z /= upLen;

  // Uniform in disc: radius uses sqrt so density is even on the cone base.
  const angle = maxAngleRad * Math.sqrt(rng());
  const theta = rng() * Math.PI * 2;
  const sinA = Math.sin(angle);
  const cosA = Math.cos(angle);
  const ox = Math.cos(theta) * sinA;
  const oy = Math.sin(theta) * sinA;

  return normalize({
    x: dir.x * cosA + right.x * ox + up.x * oy,
    y: dir.y * cosA + right.y * ox + up.y * oy,
    z: dir.z * cosA + right.z * ox + up.z * oy,
  });
}

/** Convenience: look angles → spread unit direction. */
export function spreadDirectionFromYawPitch(
  yaw: number,
  pitch: number,
  maxAngleRad: number,
  rng: () => number = Math.random,
): Vec3 {
  return applyAimSpread(directionFromYawPitch(yaw, pitch), maxAngleRad, rng);
}
