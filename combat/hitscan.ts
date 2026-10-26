import {
  getPlayerHitVolumes,
  hitPlayerVolumes,
  type HitVec3 as Vec3,
  type PlayerHitPose as HitPose,
} from "../shared/sim/playerHitVolumes.ts";
import type { HitZone } from "../protocol/network.ts";

export {
  BODY_MAX_Y, BODY_MIN_Y, BODY_RADIUS, CROUCH_BODY_MAX_Y, CROUCH_BODY_MIN_Y,
  CROUCH_EYE_HEIGHT, CROUCH_HEAD_OFFSET_Y, HEAD_OFFSET_Y, HEAD_RADIUS,
  PLAYER_EYE_HEIGHT, STAND_EYE_HEIGHT, bodyMaxY, bodyMinY, eyeHeight,
  headOffsetY, raySphere, rayVerticalCapsule,
} from "../shared/sim/playerHitVolumes.ts";
export type { Vec3, HitPose };

export type HitResult = {
  playerId: string;
  zone: HitZone;
  distance: number;
  point: Vec3;
};

export function directionFromYawPitch(yaw: number, pitch: number): Vec3 {
  const cosPitch = Math.cos(pitch);
  return {
    x: -Math.sin(yaw) * cosPitch,
    y: Math.sin(pitch),
    z: -Math.cos(yaw) * cosPitch,
  };
}

export function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

/**
 * The same transformed sphere/cylinder used by client picking and overlays.
 * Multiple lag-compensated samples are allowed; the closest surface wins.
 *
 * Equal-distance tie-break keeps the earlier entry (`>=` skips the later
 * hit). Callers that need join-order-independent results (authoritative
 * shoot path) must supply `targets` in stable ascending player/session id
 * order; `limit` truncates that prefix.
 */
export function hitscanPoses(
  origin: Vec3,
  direction: Vec3,
  maxRange: number,
  targets: readonly { playerId: string; pose: HitPose }[],
  limit?: number,
): HitResult | null {
  const dir = normalize(direction);
  let best: HitResult | null = null;
  const n = typeof limit === "number" && Number.isFinite(limit)
    ? Math.min(Math.max(0, Math.floor(limit)), targets.length)
    : targets.length;
  for (let i = 0; i < n; i++) {
    const target = targets[i]!;
    const hit = hitPlayerVolumes(origin, dir, maxRange, getPlayerHitVolumes(target.pose));
    if (!hit || (best && hit.distance >= best.distance)) continue;
    best = {
      playerId: target.playerId,
      zone: hit.zone,
      distance: hit.distance,
      point: {
        x: origin.x + dir.x * hit.distance,
        y: origin.y + dir.y * hit.distance,
        z: origin.z + dir.z * hit.distance,
      },
    };
  }
  return best;
}
