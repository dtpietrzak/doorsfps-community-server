/**
 * One sideways strafe so a horde does not collapse onto one point.
 * One pass over the think roster. Other living bots count as zombies;
 * humans are the thing being chased, so they do not push.
 */

import { ZOMBOTS_TUNING } from "../../../../shared/zombots/zombotsTuning.ts";
import { distanceSquared2, fastSinCos } from "../../math/index.ts";

/**
 * World units. A bit wider than two bodies so the push starts before
 * the crowd is fully stacked.
 */
export const ZOMBIE_SEPARATION_RADIUS = 1.25;

export type ZombieCrowdBody = {
  id: string;
  x: number;
  z: number;
  alive: boolean;
  isBot: boolean;
};

/**
 * Strafe away from nearby zombies, relative to `yaw` (the way this
 * zombie is about to face). "right" is the player's right.
 */
export function zombieSeparationStrafe(
  self: { id: string; x: number; z: number },
  yaw: number,
  players: readonly ZombieCrowdBody[],
): "left" | "right" | "none" {
  if (
    !Number.isFinite(yaw) ||
    !Number.isFinite(self.x) ||
    !Number.isFinite(self.z)
  ) {
    return "none";
  }
  const look = fastSinCos(yaw);
  // Player right: (cos(yaw), -sin(yaw)). Forward is (-sin, -cos).
  const rightX = look.cos;
  const rightZ = -look.sin;
  const radius2 = ZOMBIE_SEPARATION_RADIUS * ZOMBIE_SEPARATION_RADIUS;
  let rightAccum = 0;

  for (let i = 0; i < players.length; i++) {
    const other = players[i]!;
    if (other.id === self.id) continue;
    if (!other.alive || !other.isBot) continue;
    if (!Number.isFinite(other.x) || !Number.isFinite(other.z)) continue;
    const awayX = self.x - other.x;
    const awayZ = self.z - other.z;
    const d2 = distanceSquared2(awayX, awayZ);
    if (d2 > radius2) continue;
    if (d2 <= 1e-8) {
      // Same point has no direction. Split by id so the pair still peels.
      rightAccum += self.id < other.id ? 1 : -1;
      continue;
    }
    const lateral = awayX * rightX + awayZ * rightZ;
    rightAccum += lateral * (radius2 - d2);
  }

  if (rightAccum > 0) return "right";
  if (rightAccum < 0) return "left";
  return "none";
}

/**
 * Inside this planar distance of its target a zombie stops walking in and
 * just swings. Inside the bite reach, so it is already on the target when
 * it holds. Without a hold the horde presses onto one point (there's no
 * pawn-vs-pawn collision in the sim).
 */
export const ZOMBIE_STANDOFF = ZOMBOTS_TUNING.zombie.meleeRange * 0.6;

/** How close a zombie ahead has to be before this one waits behind it. */
export const ZOMBIE_YIELD_RADIUS = 0.9;

/**
 * True when this zombie should not press forward this think: it's already in
 * swing range, or another zombie stands just ahead of it and nearer the target
 * (so the crowd forms a ring instead of a pile).
 */
export function zombieHoldsForward(
  self: { id: string; x: number; z: number },
  target: { x: number; z: number },
  players: readonly ZombieCrowdBody[],
): boolean {
  const toX = target.x - self.x;
  const toZ = target.z - self.z;
  const selfD2 = distanceSquared2(toX, toZ);
  if (!Number.isFinite(selfD2)) return false;
  if (selfD2 <= ZOMBIE_STANDOFF * ZOMBIE_STANDOFF) return true;
  const yield2 = ZOMBIE_YIELD_RADIUS * ZOMBIE_YIELD_RADIUS;
  for (let i = 0; i < players.length; i++) {
    const other = players[i]!;
    if (other.id === self.id || !other.alive || !other.isBot) continue;
    const dx = other.x - self.x;
    const dz = other.z - self.z;
    const d2 = distanceSquared2(dx, dz);
    if (!(d2 <= yield2)) continue;
    // Ahead means toward the target, not beside or behind.
    if (dx * toX + dz * toZ <= 0) continue;
    const otherD2 = distanceSquared2(target.x - other.x, target.z - other.z);
    // Ties split by id so two equal zombies don't both stop.
    if (otherD2 < selfD2 || (otherD2 === selfD2 && other.id < self.id)) {
      return true;
    }
  }
  return false;
}
