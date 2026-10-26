/**
 * Multi-pellet shot pattern (shotgun). Pure and shared: the server, online
 * prediction, offline and campaign all build pellet directions here.
 *
 * Pattern: one centre pellet on the aim direction plus `pellets - 1` pellets
 * on a ring at {@link PELLET_RING_RADIUS_FRAC} of the cone half-angle.
 *
 * - Normal: the ring is rotated by one `rng` draw, then each ring pellet takes
 *   two jitter draws (radius, then angle). Draw order: rotation, then ring
 *   pellets in index order.
 * - Uniform (Hawkeyes): a fixed, evenly spaced ring with no draws at all.
 *
 * The draw count depends only on the weapon and the mode
 * ({@link pelletDrawCount}), never on the aim or the cone size, so the sim
 * `spread` stream stays deterministic. Single-pellet weapons return the aim
 * direction and draw nothing.
 *
 * Movement bloom is applied by the caller, once, to `aimDir` before this runs.
 */

import type { HitVec3 as Vec3 } from "./playerHitVolumes.ts";
import type { WeaponDef } from "./weapons.ts";

/** Ring pellets sit at this fraction of the cone half-angle. */
export const PELLET_RING_RADIUS_FRAC = 0.65;
/** Normal mode: max radial jitter (± fraction of the cone half-angle). */
export const PELLET_JITTER_RADIUS_FRAC = 0.15;
/** Normal mode: max angular jitter (± fraction of one ring slot). */
export const PELLET_JITTER_SLOT_FRAC = 0.25;
/** Uniform ring starts straight up so the Hawkeyes pattern is symmetric on screen. */
const UNIFORM_RING_START_RAD = Math.PI / 2;

export type PelletPatternOpts = {
  /** Hawkeyes: evenly spaced ring, no rotation or jitter draws. */
  uniform?: boolean;
  /** Multiplier on `pelletSpreadDeg` (Hawkeyes passes 0.5). Default 1. */
  coneScale?: number;
};

/** Pellets fired per shot (at least 1). */
export function pelletCount(weapon: WeaponDef): number {
  return Math.max(1, Math.floor(weapon.pellets ?? 1));
}

/** Number of `rng` draws {@link pelletDirections} consumes for this weapon + mode. */
export function pelletDrawCount(weapon: WeaponDef, uniform: boolean): number {
  const ring = pelletCount(weapon) - 1;
  if (ring <= 0 || uniform) return 0;
  return 1 + ring * 2;
}

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

/**
 * Unit directions for every pellet of one shot. Index 0 is the centre pellet
 * (exactly `aimDir`, normalized). Same right/up basis as `applyAimSpread`.
 */
export function pelletDirections(
  aimDir: Vec3,
  weapon: WeaponDef,
  opts: PelletPatternOpts,
  rng: () => number,
): Vec3[] {
  const dir = normalize(aimDir);
  const count = pelletCount(weapon);
  if (count <= 1) return [dir];

  let right: Vec3 = { x: dir.z, y: 0, z: -dir.x };
  let rLen = Math.hypot(right.x, right.z);
  if (rLen < 1e-6) {
    // Looking straight up/down — pick an arbitrary horizontal right.
    right = { x: 1, y: 0, z: 0 };
    rLen = 1;
  }
  right = { x: right.x / rLen, y: 0, z: right.z / rLen };
  const up = normalize({
    x: right.y * dir.z - right.z * dir.y,
    y: right.z * dir.x - right.x * dir.z,
    z: right.x * dir.y - right.y * dir.x,
  });

  const halfAngle = Math.max(0, weapon.pelletSpreadDeg ?? 0) *
    Math.max(0, opts.coneScale ?? 1) * (Math.PI / 180);
  const ring = count - 1;
  const slot = (Math.PI * 2) / ring;
  const uniform = opts.uniform === true;
  const rotation = uniform ? UNIFORM_RING_START_RAD : rng() * Math.PI * 2;

  const out: Vec3[] = [dir];
  for (let i = 0; i < ring; i++) {
    let radiusFrac = PELLET_RING_RADIUS_FRAC;
    let theta = rotation + i * slot;
    if (!uniform) {
      radiusFrac += (rng() * 2 - 1) * PELLET_JITTER_RADIUS_FRAC;
      theta += (rng() * 2 - 1) * PELLET_JITTER_SLOT_FRAC * slot;
    }
    const angle = halfAngle * radiusFrac;
    const sinA = Math.sin(angle);
    const cosA = Math.cos(angle);
    const ox = Math.cos(theta) * sinA;
    const oy = Math.sin(theta) * sinA;
    out.push(normalize({
      x: dir.x * cosA + right.x * ox + up.x * oy,
      y: dir.y * cosA + right.y * ox + up.y * oy,
      z: dir.z * cosA + right.z * ox + up.z * oy,
    }));
  }
  return out;
}
