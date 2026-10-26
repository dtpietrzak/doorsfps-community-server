import {
  clamp,
  distance2,
  fastAtan2,
  fastSinCos,
  max,
  yawFromWorldDirection,
} from "../math/index.ts";

export type MovementKeys = {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
};

export type Point2 = Readonly<{ x: number; z: number }>;

/** Face a world point using the player convention forward=(-sin(yaw),-cos(yaw)). */
export function yawToward(
  fromX: number,
  fromZ: number,
  toX: number,
  toZ: number,
): number {
  return yawFromWorldDirection(toX - fromX, toZ - fromZ);
}

/**
 * Map desired world movement onto WASD relative to look yaw. Diagonals remain
 * available so a bot can face a threat while continuing toward an objective.
 */
export function moveKeysForWorldYaw(
  lookYaw: number,
  moveYaw: number,
  deadZone = 0.28,
): MovementKeys {
  const move = fastSinCos(moveYaw);
  const look = fastSinCos(lookYaw);
  const moveX = -move.sin;
  const moveZ = -move.cos;
  const forwardX = -look.sin;
  const forwardZ = -look.cos;
  const rightX = look.cos;
  const rightZ = -look.sin;
  const forwardAmount = moveX * forwardX + moveZ * forwardZ;
  const rightAmount = moveX * rightX + moveZ * rightZ;
  const threshold = max(0.05, deadZone);
  return {
    forward: forwardAmount > threshold,
    backward: forwardAmount < -threshold,
    left: rightAmount < -threshold,
    right: rightAmount > threshold,
  };
}

/** Pitch from an eye position to a world point. */
export function pitchToward(
  fromX: number,
  fromY: number,
  fromZ: number,
  toX: number,
  toY: number,
  toZ: number,
): number {
  const dx = toX - fromX;
  const dy = toY - fromY;
  const dz = toZ - fromZ;
  const horizontal = distance2(dx, dz);

  // Stacked bodies should not make bots bow at the floor or snap skyward.
  if (horizontal < 0.35) {
    return clamp(fastAtan2(dy, max(horizontal, 0.35)), -0.2, 0.15);
  }
  return fastAtan2(dy, horizontal);
}

/** World point reached by moving forward along player yaw. */
export function pointAlongYaw(
  x: number,
  z: number,
  yaw: number,
  distance: number,
): Point2 {
  const direction = fastSinCos(yaw);
  return {
    x: x - direction.sin * distance,
    z: z - direction.cos * distance,
  };
}
