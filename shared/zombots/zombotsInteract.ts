/**
 * Zombots interact resolve (notes/zombots.md step 13): one E / right click
 * becomes a revive press, a door buy or a rack take. Pure, so the server
 * runtime and the client prompt (Phase 5) pick the same target.
 *
 * Order: a downed body in sight wins (the glue raycasts it), then the
 * closest-to-the-crosshair closed door or rack in reach and in front. A rack
 * counts only from the side it faces. Reach is planar and inclusive.
 * Uses `shared/math`, not global `Math`.
 */

import { distanceSquared2 } from "../math/distance.ts";
import { withinRackReach, type ZombotsGunRack } from "./armory.ts";
import { withinDoorReach, type ZombotsDoor } from "./zombotsDoors.ts";
import type { ZombotsPlayerId } from "./types.ts";

type Vec2 = { x: number; z: number };

export type ZombotsInteractTarget =
  | { kind: "revive"; targetId: ZombotsPlayerId }
  | { kind: "door"; doorId: string }
  | { kind: "rack"; rackId: string };

/** A rack and the wall normal pointing into its player closure. */
export type ZombotsInteractRack = {
  rack: ZombotsGunRack;
  /** Null when the layout could not tell (the rack is then never offered). */
  facing: Vec2 | null;
};

export type ZombotsInteractInput = {
  /** Eye position on the floor plane. */
  eye: Vec2;
  /** Horizontal look direction; any length, zero means "no direction". */
  look: Vec2;
  /** Downed body the glue found in sight and in revive reach, or null. */
  downedInSight: ZombotsPlayerId | null;
  doors: readonly ZombotsDoor[];
  isDoorOpen: (doorId: string) => boolean;
  racks: readonly ZombotsInteractRack[];
};

export function resolveZombotsInteract(
  input: ZombotsInteractInput,
): ZombotsInteractTarget | null {
  if (input.downedInSight !== null) {
    return { kind: "revive", targetId: input.downedInSight };
  }
  let best: ZombotsInteractTarget | null = null;
  let bestScore = 0;
  for (const door of input.doors) {
    if (input.isDoorOpen(door.id) || !withinDoorReach(door, input.eye)) continue;
    const score = facingScore(input.eye, input.look, door.reachPoint);
    // Doors win ties: a door and its own phase's rack can share a wall.
    if (score > bestScore) {
      best = { kind: "door", doorId: door.id };
      bestScore = score;
    }
  }
  for (const entry of input.racks) {
    const { rack, facing } = entry;
    if (!facing || !withinRackReach(rack.center, input.eye)) continue;
    // Behind the wall: the rack is on the other room's side.
    const sx = input.eye.x - rack.center.x;
    const sz = input.eye.z - rack.center.z;
    if (sx * facing.x + sz * facing.z <= 0) continue;
    const score = facingScore(input.eye, input.look, rack.center);
    if (score > bestScore) {
      best = { kind: "rack", rackId: rack.id };
      bestScore = score;
    }
  }
  return best;
}

/**
 * Cosine-like score in (0, 1] for a target in front of the look, else 0.
 * Standing on the target counts as dead ahead.
 */
function facingScore(eye: Vec2, look: Vec2, target: Vec2): number {
  const dx = target.x - eye.x;
  const dz = target.z - eye.z;
  const d2 = distanceSquared2(dx, dz);
  const l2 = distanceSquared2(look.x, look.z);
  if (l2 <= 0) return 0;
  if (d2 <= 1e-12) return 1;
  const dot = dx * look.x + dz * look.z;
  if (dot <= 0) return 0;
  // dot² / (|d|²|l|²) keeps the order of the cosine without a square root.
  return (dot * dot) / (d2 * l2);
}
