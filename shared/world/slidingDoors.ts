/**
 * Arena sliding doors. The mesh is the campaign walking-tunnel door
 * (`client/src/game/campaign/campaignSlidingDoor.ts`); this module is the
 * one placement both that mesh and collision read.
 *
 * Local door frame, after {@link slidingDoorYaw}: local +Z runs along the
 * wall (the clear opening), local +X is the thickness. Three.js
 * `rotation.y` sends local +Z to `(sin yaw, 0, cos yaw)`.
 * A wall along +X has yaw π/2, so local +Z lands on world +X and local +X
 * lands on world −Z.
 */

/** Clear opening. Matches `CAMPAIGN_SLIDING_DOOR.width`. */
export const SLIDING_DOOR_WIDTH = 1.85;

/** Default zompoints a closed door costs. */
export const SLIDING_DOOR_COST = 500;

/** Playtest purse, enough to open one default door. */
export const ZOMBOTS_STARTING_POINTS = 500;

/** How close a player must stand to spend points on a door (world units). */
export const ZOMBOTS_DOOR_REACH = 2.2;

/**
 * Panel height inside an arena wall. The campaign door is 5.3 and slides
 * into a tall ceiling; arena walls are 3.45, so the kit is scaled to that.
 * Keep equal to `WALL_HEIGHT` in MapCollision.
 */
export const SLIDING_DOOR_HEIGHT = 3.45;

/** Editor corner 0 is the bottom-left (SW) pad, before the export X mirror. */
export const ZOMBOTS_EDITOR_SPAWN_CORNER = 0 as const;

/** How far a stored center may sit off its wall and still count. */
const CENTER_ON_WALL = 0.25;

export type SlidingDoorRef = {
  wallId: string;
  center: { x: number; z: number };
};

export type SlidingDoorPlacement = {
  a: { x: number; z: number };
  b: { x: number; z: number };
  mid: { x: number; z: number };
  /** `Object3D.rotation.y` for a door whose local +Z lies along the wall. */
  yaw: number;
};

export function doorCentersOnWall(
  wallId: string,
  doors: readonly SlidingDoorRef[] | undefined,
): { x: number; z: number }[] {
  if (!doors || doors.length === 0) return [];
  const centers: { x: number; z: number }[] = [];
  for (const door of doors) {
    if (door.wallId === wallId) centers.push(door.center);
  }
  return centers;
}

/** Yaw that lays the door's local +Z along `a` → `b`. */
export function slidingDoorYaw(
  a: { x: number; z: number },
  b: { x: number; z: number },
): number {
  return Math.atan2(b.x - a.x, b.z - a.z);
}

/**
 * Closed-door span on a full wall. `null` when the center is off the wall,
 * the wall is too short to host the opening, or the wall is not full height.
 */
export function slidingDoorPlacement(
  a: { x: number; z: number },
  b: { x: number; z: number },
  center: { x: number; z: number },
): SlidingDoorPlacement | null {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) return null;
  const ux = dx / len;
  const uz = dz / len;
  const s = (center.x - a.x) * ux + (center.z - a.z) * uz;
  const px = a.x + ux * s;
  const pz = a.z + uz * s;
  if (Math.hypot(center.x - px, center.z - pz) > CENTER_ON_WALL) return null;
  const half = SLIDING_DOOR_WIDTH / 2;
  if (s - half < -1e-3 || s + half > len + 1e-3) return null;
  const at = (t: number) => ({ x: a.x + ux * t, z: a.z + uz * t });
  return {
    a: at(s - half),
    b: at(s + half),
    mid: at(s),
    yaw: slidingDoorYaw(a, b),
  };
}

export function slidingDoorBlock(
  wall: { a: { x: number; z: number }; b: { x: number; z: number }; kind?: string },
  center: { x: number; z: number },
): { a: { x: number; z: number }; b: { x: number; z: number } } | null {
  if (wall.kind === "half" || wall.kind === "float") return null;
  const place = slidingDoorPlacement(wall.a, wall.b, center);
  if (!place) return null;
  return { a: place.a, b: place.b };
}

export type ZombotsDoorOffer = {
  id: string;
  cost: number;
  x: number;
  z: number;
  open: boolean;
};

/** Nearest still-closed door inside `reach`, or null. */
export function nearestClosedSlidingDoor(
  doors: readonly ZombotsDoorOffer[],
  x: number,
  z: number,
  reach = ZOMBOTS_DOOR_REACH,
): ZombotsDoorOffer | null {
  let best: ZombotsDoorOffer | null = null;
  let bestDist = reach;
  for (const door of doors) {
    if (door.open) continue;
    const dist = Math.hypot(door.x - x, door.z - z);
    if (dist <= bestDist) {
      best = door;
      bestDist = dist;
    }
  }
  return best;
}

/** Spend `cost` when the purse covers it. The purse is unchanged on failure. */
export function trySpendZompoints(
  points: number,
  cost: number,
): { ok: boolean; points: number } {
  if (!Number.isFinite(points) || !Number.isFinite(cost) || cost < 0) {
    return { ok: false, points };
  }
  if (points < cost) return { ok: false, points };
  return { ok: true, points: points - cost };
}
