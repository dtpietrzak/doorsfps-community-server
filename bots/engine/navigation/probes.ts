import {
  abs,
  angleDelta,
  distanceSquared2,
  fastAtan2,
  HALF_PI,
  PI,
} from "../math/index.ts";
import { pointAlongYaw } from "./heading.ts";
import type { MapCollision } from "../world/MapCollision.ts";

export type ForwardProbeKind =
  | "clear"
  | "crouchable"
  | "jumpable"
  | "blocked";

/** Minimal collision surface needed by hot bot navigation probes. */
export interface ForwardCollision {
  classifyForward(
    x: number,
    z: number,
    yaw: number,
    distance: number,
    radius: number,
  ): ForwardProbeKind;
}

/** Additional surface required to estimate a half-wall face normal. */
export interface ResolvingForwardCollision extends ForwardCollision {
  resolvePosition(
    x: number,
    z: number,
    radius: number,
    feetY: number,
    headY: number,
    halfWallEndInset: number,
  ): Readonly<{ x: number; z: number }>;
}

export const DEFAULT_SPRINT_OPEN_DISTANCE = 2;
export const DEFAULT_PLAYER_RADIUS = 0.35;
export const DEFAULT_STAND_COLLISION_HEIGHT = 1.7;

const WALL_AHEAD_DISTANCE = 0.85;
const WALL_CONTACT_LOOK_DISTANCE = 0.7;
const WALL_SEE_AHEAD_DISTANCES: readonly number[] = [0.55, 1, 1.6, 2.4];
const JUMP_PROBE_DISTANCES: readonly number[] = [0.5, 0.75, 0.95, 1.2, 1.45];
const HALF_WALL_FACE_OFFSETS: readonly number[] = [
  0,
  0.15,
  -0.15,
  0.3,
  -0.3,
  0.5,
  -0.5,
  0.75,
  -0.75,
  1,
  -1,
  1.25,
  -1.25,
  HALF_PI,
  -HALF_PI,
  PI * 0.75,
  -PI * 0.75,
  PI,
];

/** Dense forward samples prevent thin wall segments from being skipped. */
export function hasOpenSpaceAhead(
  collision: MapCollision,
  x: number,
  z: number,
  yaw: number,
  distance = DEFAULT_SPRINT_OPEN_DISTANCE,
  playerRadius = DEFAULT_PLAYER_RADIUS,
): boolean {
  const step = 0.4;
  for (let sample = step; sample <= distance + 0.000001; sample += step) {
    if (
      collision.classifyForward(x, z, yaw, sample, playerRadius) !== "clear"
    ) {
      return false;
    }
  }
  return collision.classifyForward(x, z, yaw, distance, playerRadius) ===
    "clear";
}

/** True when look yaw immediately enters a full wall. */
export function isLookIntoFullWall(
  collision: MapCollision,
  x: number,
  z: number,
  yaw: number,
  maxDistance = WALL_CONTACT_LOOK_DISTANCE,
  playerRadius = DEFAULT_PLAYER_RADIUS,
): boolean {
  const samples = [0.35, 0.5, maxDistance];
  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i]!;
    if (sample > maxDistance + 0.000001) break;
    if (
      collision.classifyForward(x, z, yaw, sample, playerRadius) === "blocked"
    ) {
      return true;
    }
  }
  return false;
}

function isWallBlockingAhead(
  collision: MapCollision,
  x: number,
  z: number,
  yaw: number,
  playerRadius: number,
): boolean {
  if (
    collision.classifyForward(
      x,
      z,
      yaw,
      WALL_AHEAD_DISTANCE,
      playerRadius,
    ) === "blocked"
  ) {
    return true;
  }
  return collision.classifyForward(x, z, yaw, 0.55, playerRadius) ===
    "blocked";
}

/** Start circling before the bot's body contacts a full wall. */
export function isFullWallAhead(
  collision: MapCollision,
  x: number,
  z: number,
  yaw: number,
  maxDistance = 2.4,
  playerRadius = DEFAULT_PLAYER_RADIUS,
): boolean {
  for (let i = 0; i < WALL_SEE_AHEAD_DISTANCES.length; i += 1) {
    const sample = WALL_SEE_AHEAD_DISTANCES[i]!;
    if (sample > maxDistance + 0.000001) break;
    if (
      collision.classifyForward(x, z, yaw, sample, playerRadius) === "blocked"
    ) {
      return true;
    }
  }
  if (maxDistance > 2.4) {
    for (let sample = 2.8; sample <= maxDistance + 0.000001; sample += 0.55) {
      if (
        collision.classifyForward(x, z, yaw, sample, playerRadius) === "blocked"
      ) {
        return true;
      }
    }
  }
  return isWallBlockingAhead(collision, x, z, yaw, playerRadius);
}

function faceYawFromJumpableProbe(
  collision: MapCollision,
  x: number,
  z: number,
  yaw: number,
  probeDistance: number,
  playerRadius: number,
  standCollisionHeight: number,
): number | null {
  const target = pointAlongYaw(x, z, yaw, probeDistance);
  const resolved = collision.resolvePosition(
    target.x,
    target.z,
    playerRadius,
    0,
    standCollisionHeight,
    0,
  );
  const offsetX = resolved.x - target.x;
  const offsetZ = resolved.z - target.z;
  if (distanceSquared2(offsetX, offsetZ) < 0.00000001) return null;

  // Into wall is opposite the collision push. With player yaw conventions this
  // is atan2(pushX, pushZ), matching the original navigation implementation.
  return fastAtan2(offsetX, offsetZ);
}

/** Estimate a nearby half-wall's inward face normal for head-on vault setup. */
export function estimateHalfWallFaceYaw(
  collision: MapCollision,
  x: number,
  z: number,
  seedYaw: number,
  playerRadius = DEFAULT_PLAYER_RADIUS,
  standCollisionHeight = DEFAULT_STAND_COLLISION_HEIGHT,
): number | null {
  let bestFace: number | null = null;
  let bestScore = Infinity;

  for (let oi = 0; oi < HALF_WALL_FACE_OFFSETS.length; oi += 1) {
    const yaw = seedYaw + HALF_WALL_FACE_OFFSETS[oi]!;
    for (let di = 0; di < JUMP_PROBE_DISTANCES.length; di += 1) {
      const probeDistance = JUMP_PROBE_DISTANCES[di]!;
      if (
        collision.classifyForward(
          x,
          z,
          yaw,
          probeDistance,
          playerRadius,
        ) !== "jumpable"
      ) {
        continue;
      }
      const face = faceYawFromJumpableProbe(
        collision,
        x,
        z,
        yaw,
        probeDistance,
        playerRadius,
        standCollisionHeight,
      );
      if (face === null) continue;
      const score = probeDistance + abs(angleDelta(yaw, face)) * 0.35;
      if (score < bestScore) {
        bestScore = score;
        bestFace = face;
      }
      break;
    }
  }
  return bestFace;
}
