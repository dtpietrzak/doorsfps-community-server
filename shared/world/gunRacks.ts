/**
 * Zombots gun racks: thin wall props a player takes a gun from. Mounted on a
 * wall the way sliding doors are (`wallId` + `center` on that wall). No
 * collision in v1, the same as the training-ground racks.
 *
 * Every map loader (server, client, mapBuilder import) runs
 * {@link normalizeGunRacks} so a bad entry is dropped rather than failing the
 * whole map.
 */
import type { ZombotsRackWeapon } from "../zombots/types.ts";
import { wallMountOffset } from "./slidingDoors.ts";

/** Most gun racks one zombots map may carry. */
export const MAX_GUN_RACKS = 16;

/** Rack board width along the wall. Matches the training-ground rack. */
export const GUN_RACK_WIDTH = 1.2;

/** Wire order too: index is the weapon byte in `mapBin.ts`. */
export const GUN_RACK_WEAPONS: readonly ZombotsRackWeapon[] = [
  "pistol",
  "rifle",
  "shotgun",
];

export type GunRack = {
  id: string;
  wallId: string;
  center: { x: number; z: number };
  weapon: ZombotsRackWeapon;
  /**
   * Which side of its wall the rack hangs on: 1 faces the wall's left normal
   * (`(-uz, ux)` for the unit direction a→b), -1 the right. Left out, the
   * layout picks the side with a player closure, which only works when just
   * one side has one. Needed on a wall between two player closures.
   */
  face?: GunRackFace;
};

export type GunRackFace = 1 | -1;

export function isGunRackFace(value: unknown): value is GunRackFace {
  return value === 1 || value === -1;
}

type RackHostWall = {
  id: string;
  a: { x: number; z: number };
  b: { x: number; z: number };
  kind?: string;
};

export function isGunRackWeapon(value: unknown): value is ZombotsRackWeapon {
  return value === "pistol" || value === "rifle" || value === "shotgun";
}

/**
 * Racks that are fit to use, in authoring order. Empty outside zombots.
 * Drops entries with a bad shape, an unknown weapon, a repeated id, a missing
 * or non-full wall, or a center off its wall (same tolerance as doors) or too
 * close to an end for the board to fit. Keeps at most {@link MAX_GUN_RACKS}.
 */
export function normalizeGunRacks(map: {
  mirrorMode?: string;
  walls: readonly RackHostWall[];
  gunRacks?: unknown;
}): GunRack[] {
  if (map.mirrorMode !== "zombots" || !Array.isArray(map.gunRacks)) return [];
  const walls = new Map<string, RackHostWall>();
  for (const wall of map.walls) walls.set(wall.id, wall);
  const seen = new Set<string>();
  const out: GunRack[] = [];
  const half = GUN_RACK_WIDTH / 2;
  for (const item of map.gunRacks as unknown[]) {
    if (out.length >= MAX_GUN_RACKS) break;
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const id = raw.id;
    const wallId = raw.wallId;
    const center = raw.center as { x?: unknown; z?: unknown } | null;
    if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
    if (typeof wallId !== "string" || !isGunRackWeapon(raw.weapon)) continue;
    if (!center || typeof center !== "object") continue;
    const x = center.x;
    const z = center.z;
    if (typeof x !== "number" || typeof z !== "number") continue;
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    const wall = walls.get(wallId);
    // Half and float walls have no face at hand height to hang a board on.
    if (!wall || (wall.kind !== undefined && wall.kind !== "full")) continue;
    const mount = wallMountOffset(wall.a, wall.b, { x, z });
    if (!mount) continue;
    if (mount.s - half < -1e-3 || mount.s + half > mount.len + 1e-3) continue;
    seen.add(id);
    out.push({
      id,
      wallId,
      center: { x, z },
      weapon: raw.weapon,
      ...(isGunRackFace(raw.face) ? { face: raw.face } : {}),
    });
  }
  return out;
}
