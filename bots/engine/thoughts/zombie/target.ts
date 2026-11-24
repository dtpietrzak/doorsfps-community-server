/**
 * Sticky nearest living human. Downed bodies stay in the world but are
 * not prey. The think frame has no downed flag yet, so a missing
 * `isDowned` means standing.
 */

import { isHiddenByGlitch } from "../../helpers/combat.ts";
import { distanceSquared2, fastSqrt } from "../../math/index.ts";
import type { Player } from "../../players/Player.ts";

/**
 * Another human must be this many world units closer than the sticky
 * target before the zombie switches. Stops two people standing together
 * from swapping the lock every think.
 */
export const ZOMBIE_TARGET_SWITCH_MARGIN = 1.5;

export type ZombiePlayerView = Player & { isDowned?: boolean };

/** True only when the snapshot says this body is down. Missing means up. */
export function readZombieIsDowned(player: { isDowned?: boolean }): boolean {
  return player.isDowned === true;
}

/**
 * Living human the horde may chase. Bots and agents are not humans.
 * Team is ignored: zombots does not rely on arena hostility.
 */
export function isZombiePrey(
  selfId: string,
  player: ZombiePlayerView,
): boolean {
  if (player.id === selfId) return false;
  if (!player.alive) return false;
  if (player.isBot || player.isAgent) return false;
  if (readZombieIsDowned(player)) return false;
  if (isHiddenByGlitch(player)) return false;
  if (!Number.isFinite(player.x) || !Number.isFinite(player.z)) return false;
  return true;
}

/**
 * Sticky nearest prey. `currentId` empty, dead, down, or gone → the
 * nearest remaining human, or null. Ties break to the smaller id.
 */
export function pickZombieTarget(
  self: { id: string; x: number; z: number },
  players: readonly ZombiePlayerView[],
  currentId: string,
): ZombiePlayerView | null {
  let best: ZombiePlayerView | null = null;
  let bestD2 = 0;
  let current: ZombiePlayerView | null = null;

  for (let i = 0; i < players.length; i++) {
    const player = players[i]!;
    if (!isZombiePrey(self.id, player)) continue;
    const d2 = distanceSquared2(player.x - self.x, player.z - self.z);
    if (currentId !== "" && player.id === currentId) {
      current = player;
    }
    if (
      best === null ||
      d2 < bestD2 ||
      (d2 === bestD2 && player.id < best.id)
    ) {
      best = player;
      bestD2 = d2;
    }
  }

  if (!current) return best;
  if (!best || best.id === current.id) return current;

  const currentD2 = distanceSquared2(current.x - self.x, current.z - self.z);
  const margin = ZOMBIE_TARGET_SWITCH_MARGIN;
  // (best + margin)^2 < current^2. fastSqrt(100) is a hair over 10, so
  // comparing the roots treats an exact margin as already closer.
  const expanded = bestD2 + margin * margin + 2 * margin * fastSqrt(bestD2);
  if (expanded < currentD2) return best;
  return current;
}
