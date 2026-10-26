/**
 * Player–player body clip. Horizontal radius matches hitscan BODY_RADIUS
 * (server-community/combat/hitscan.ts, client hitVolumes.ts). Not map radius.
 */

import { distance2, max } from "../math/index.ts";
import {
  MOVE_CROUCH_COLLISION_H,
  MOVE_CROUCH_EYE,
  MOVE_STAND_EYE,
  moveCollisionHeight,
  moveEyeHeight,
  type MoveCollision,
} from "./moveStep.ts";

/** Hitscan body cylinder radius — keep in sync with hitscan / hitVolumes. */
export const PLAYER_CLIP_RADIUS = 0.32;

/** Standing / crouch body slab from feet — keep in sync with hitscan. */
export const CLIP_BODY_MIN_Y = 0.08;
export const CLIP_BODY_MAX_Y = 1.34;
export const CLIP_CROUCH_BODY_MAX_Y = 0.85;

export type PlayerClipPose = {
  id?: string;
  x: number;
  y: number;
  z: number;
  crouch?: boolean;
};

export type PlayerClipResult = {
  x: number;
  z: number;
  /** True when the mover center is still inside an obstacle body cylinder. */
  inside: boolean;
};

export function bodyYRange(
  eyeY: number,
  crouch: boolean,
): { min: number; max: number } {
  const feetY = eyeY - moveEyeHeight(crouch);
  return {
    min: feetY + CLIP_BODY_MIN_Y,
    max: feetY + (crouch ? CLIP_CROUCH_BODY_MAX_Y : CLIP_BODY_MAX_Y),
  };
}

export function bodyHitboxesOverlapY(
  aY: number,
  aCrouch: boolean,
  b: PlayerClipPose,
): boolean {
  const a = bodyYRange(aY, aCrouch);
  const o = bodyYRange(b.y, Boolean(b.crouch));
  return a.min < o.max && o.min < a.max;
}

/**
 * Push `mover` out of other body cylinders (static obstacles).
 * Coincident centers: deterministic +X / −X from id order.
 */
export function clipMoverAgainstObstacles(
  mover: PlayerClipPose,
  obstacles: readonly PlayerClipPose[],
): PlayerClipResult {
  let x = mover.x;
  let z = mover.z;
  const r = PLAYER_CLIP_RADIUS;
  const minSep = 2 * r;
  const moverCrouch = Boolean(mover.crouch);

  for (const other of obstacles) {
    if (other.id && mover.id && other.id === mover.id) continue;
    if (!bodyHitboxesOverlapY(mover.y, moverCrouch, other)) continue;
    const dx = x - other.x;
    const dz = z - other.z;
    const dist = distance2(dx, dz);
    if (!(dist < minSep)) continue;
    if (dist < 1e-8) {
      const dir = coincidentPushSign(mover.id, other.id);
      x = other.x + dir * minSep;
      z = other.z;
      continue;
    }
    const scale = minSep / dist;
    x = other.x + dx * scale;
    z = other.z + dz * scale;
  }

  return {
    x,
    z,
    inside: moverCenterInside({ ...mover, x, z }, obstacles),
  };
}

/** True when the mover's XZ center is inside another body cylinder. */
export function moverCenterInside(
  mover: PlayerClipPose,
  obstacles: readonly PlayerClipPose[],
): boolean {
  const r = PLAYER_CLIP_RADIUS;
  const moverCrouch = Boolean(mover.crouch);
  for (const other of obstacles) {
    if (other.id && mover.id && other.id === mover.id) continue;
    if (!bodyHitboxesOverlapY(mover.y, moverCrouch, other)) continue;
    if (distance2(mover.x - other.x, mover.z - other.z) < r) return true;
  }
  return false;
}

/**
 * Clip then re-resolve against the map so a player-push cannot sink into a wall.
 * `inside` is measured after the map resolve.
 */
export function applyPlayerClip(
  collision: MoveCollision,
  mover: PlayerClipPose,
  obstacles: readonly PlayerClipPose[],
): PlayerClipResult {
  if (obstacles.length === 0) {
    return { x: mover.x, z: mover.z, inside: false };
  }
  const clip = clipMoverAgainstObstacles(mover, obstacles);
  const crouch = Boolean(mover.crouch);
  const groundEye = moveEyeHeight(crouch);
  const feetY = max(0, mover.y - groundEye);
  const headY = feetY + moveCollisionHeight(crouch);
  const resolved = collision.resolvePosition(
    clip.x,
    clip.z,
    undefined,
    feetY,
    headY,
  );
  return {
    x: resolved.x,
    z: resolved.z,
    inside: moverCenterInside(
      { ...mover, x: resolved.x, z: resolved.z },
      obstacles,
    ),
  };
}

/**
 * Decorate map collision so resolvePosition also treats other players as solids.
 * Used by teleport blink (and optional client prediction wrappers).
 * When feetY/headY are passed, Y overlap uses that silhouette (post-jump).
 */
export function withPlayerObstacles(
  base: MoveCollision,
  mover: Pick<PlayerClipPose, "id" | "y" | "crouch">,
  obstacles: readonly PlayerClipPose[],
): MoveCollision {
  if (obstacles.length === 0) return base;
  return {
    resolvePosition(x, z, radius?, feetY?, headY?) {
      const mapped = base.resolvePosition(x, z, radius, feetY, headY);
      const pose = poseForResolve(mapped.x, mapped.z, mover, feetY, headY);
      const clip = clipMoverAgainstObstacles(pose, obstacles);
      if (clip.x === mapped.x && clip.z === mapped.z) return mapped;
      return base.resolvePosition(clip.x, clip.z, radius, feetY, headY);
    },
    hasHeadroom(x, z, feetY?, headY?, radius?) {
      return base.hasHeadroom(x, z, feetY, headY, radius);
    },
    floorYAt: base.floorYAt
      ? (x, z) => base.floorYAt!(x, z)
      : undefined,
    ceilingYAt: base.ceilingYAt
      ? (x, z) => base.ceilingYAt!(x, z)
      : undefined,
  };
}

function poseForResolve(
  x: number,
  z: number,
  mover: Pick<PlayerClipPose, "id" | "y" | "crouch">,
  feetY?: number,
  headY?: number,
): PlayerClipPose {
  if (typeof feetY === "number" && typeof headY === "number") {
    const crouch = headY - feetY <= MOVE_CROUCH_COLLISION_H + 0.05;
    return {
      id: mover.id,
      x,
      y: feetY + (crouch ? MOVE_CROUCH_EYE : MOVE_STAND_EYE),
      z,
      crouch,
    };
  }
  return { id: mover.id, x, y: mover.y, z, crouch: mover.crouch };
}

function coincidentPushSign(
  moverId: string | undefined,
  otherId: string | undefined,
): 1 | -1 {
  const a = moverId ?? "";
  const b = otherId ?? "";
  return a < b ? 1 : a > b ? -1 : 1;
}
