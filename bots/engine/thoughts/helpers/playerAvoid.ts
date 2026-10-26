/**
 * Cheap body-aware local steer for bot nav.
 *
 * `playerClip` makes teammates / enemies solid after map resolve. Probes and
 * poles still treat those cylinders as empty, so same-pole / door-mouth stacks
 * become wall-ram. These helpers offset move yaw away from a nearby body and
 * collect wall poles another player is already sitting on.
 */

import { PLAYER_CLIP_RADIUS } from "../../../../shared/sim/playerClip.ts";
import {
  yawPoleKey,
  type YawPolePoint,
} from "../../../../shared/world/yawPole.ts";
import { clamp01, distance2, fastSinCos } from "../../math/index.ts";

/** Feeler range: clip diameter + a step of slack. */
export const PLAYER_AVOID_DIST = 2 * PLAYER_CLIP_RADIUS + 0.56;

/** Skip a wall pole another body is already occupying. */
export const YAW_POLE_BODY_OCCUPY_RADIUS = 2 * PLAYER_CLIP_RADIUS + 0.36;

/** Max yaw peel away from a body dead-ahead (rad). ~26°. */
export const PLAYER_AVOID_YAW_MAX = 0.45;

export type BodyPose = {
  id?: string;
  x: number;
  z: number;
};

/**
 * Wall-pole keys that already have another body sitting on them.
 * Door poles are not included — the mouth must stay pickable.
 */
export function occupiedWallPoleKeys(
  poles: readonly YawPolePoint[],
  others: readonly BodyPose[],
  radius: number = YAW_POLE_BODY_OCCUPY_RADIUS,
): Record<string, number> {
  const r = radius > 0 ? radius : YAW_POLE_BODY_OCCUPY_RADIUS;
  const r2 = r * r;
  const out: Record<string, number> = {};
  if (poles.length === 0 || others.length === 0) return out;
  for (const pole of poles) {
    if (!Number.isFinite(pole.x) || !Number.isFinite(pole.z)) continue;
    for (const o of others) {
      if (!Number.isFinite(o.x) || !Number.isFinite(o.z)) continue;
      const dx = pole.x - o.x;
      const dz = pole.z - o.z;
      if (dx * dx + dz * dz < r2) {
        out[yawPoleKey(pole.x, pole.z)] = 1;
        break;
      }
    }
  }
  return out;
}

/**
 * Shift `moveYaw` away from the nearest body in the forward hemisphere.
 * No-op when nobody is inside {@link PLAYER_AVOID_DIST} ahead.
 */
export function bodyAvoidMoveYaw(
  x: number,
  z: number,
  moveYaw: number,
  others: readonly BodyPose[],
  opts?: {
    selfId?: string;
    maxDist?: number;
  },
): number {
  if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(moveYaw)) {
    return moveYaw;
  }
  const maxDist = opts?.maxDist ?? PLAYER_AVOID_DIST;
  if (!(maxDist > 0) || others.length === 0) return moveYaw;

  const direction = fastSinCos(moveYaw);
  const fx = -direction.sin;
  const fz = -direction.cos;
  const selfId = opts?.selfId;
  let best: BodyPose | null = null;
  let bestDist = maxDist;
  let bestCross = 0;

  for (const o of others) {
    if (selfId && o.id === selfId) continue;
    if (!Number.isFinite(o.x) || !Number.isFinite(o.z)) continue;
    const dx = o.x - x;
    const dz = o.z - z;
    const dist = distance2(dx, dz);
    if (!(dist < bestDist) || dist < 1e-6) continue;
    const ahead = fx * dx + fz * dz;
    if (ahead <= 0) continue;
    best = o;
    bestDist = dist;
    // 2d cross of forward × to-body: >0 means body is on the left.
    bestCross = fx * dz - fz * dx;
  }

  if (!best) return moveYaw;
  const t = 1 - bestDist / maxDist;
  const mag = PLAYER_AVOID_YAW_MAX * clamp01(t);
  const sign = bestCross >= 0 ? 1 : -1;
  return moveYaw + sign * mag;
}
