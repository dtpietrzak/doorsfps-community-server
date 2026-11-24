/**
 * Inputs for `resolveZombotsInteract` that both sides build the same way
 * (notes/zombots.md step 24): the rack list with its facing from the layout,
 * and the downed body under the crosshair. The server glue and the client
 * prompt call these so the prompt names what the server will resolve.
 *
 * Pure: no raycasts against walls here. The caller passes the wall distance
 * (or the reach when nothing is in the way).
 */

import {
  getPlayerHitVolumes,
  hitPlayerVolumes,
  type HitVec3,
  type PlayerHitPose,
} from "../sim/playerHitVolumes.ts";
import type { ZombotsInteractRack } from "./zombotsInteract.ts";
import type { ZombotsLayout, ZombotsLayoutMap } from "./zombotsLayout.ts";
import type { ZombotsPlayerId } from "./types.ts";

/**
 * Every gun rack in map order with the side it faces. A rack the layout
 * could not place gets `facing: null`, which the resolver never offers.
 */
export function zombotsInteractRacks(
  map: Pick<ZombotsLayoutMap, "gunRacks">,
  layout: Pick<ZombotsLayout, "rackPhase">,
): ZombotsInteractRack[] {
  const racks: ZombotsInteractRack[] = [];
  for (const rack of map.gunRacks ?? []) {
    const placed = layout.rackPhase.find((r) => r.rackId === rack.id);
    racks.push({
      rack: {
        id: rack.id,
        weapon: rack.weapon,
        center: { x: rack.center.x, z: rack.center.z },
      },
      facing: placed?.facing ? { x: placed.facing.x, z: placed.facing.z } : null,
    });
  }
  return racks;
}

export type ZombotsDownedBody = { playerId: ZombotsPlayerId; pose: PlayerHitPose };

/**
 * The closest downed body the ray hits within `range`, or null. `direction`
 * must be unit length. `range` is the revive reach, cut short by the first
 * wall. Equal distances keep the earlier body, like the shot hitscan.
 */
export function downedBodyAlongRay(
  origin: HitVec3,
  direction: HitVec3,
  range: number,
  bodies: readonly ZombotsDownedBody[],
): ZombotsPlayerId | null {
  if (!(range > 0)) return null;
  let best: ZombotsPlayerId | null = null;
  let bestDistance = 0;
  for (const body of bodies) {
    const hit = hitPlayerVolumes(origin, direction, range, getPlayerHitVolumes(body.pose));
    if (!hit || (best !== null && hit.distance >= bestDistance)) continue;
    best = body.playerId;
    bestDistance = hit.distance;
  }
  return best;
}
