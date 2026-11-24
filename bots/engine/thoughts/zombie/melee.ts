/**
 * One melee lunge when the sticky human is inside the bite reach and
 * the body is already roughly facing them. Guns are never this step's
 * job. Time is the think tick, compared to the latched ready tick.
 */

import { ZOMBOTS_TUNING } from "../../../../shared/zombots/zombotsTuning.ts";
import {
  abs,
  angleDelta,
  distanceSquared2,
  radians,
} from "../../math/index.ts";
import { yawToward } from "../../navigation/heading.ts";
import { isSetNumber } from "../../pipeline/state.ts";
import type { Player } from "../../players/Player.ts";

/** Body must already be within 30° of the target bearing to swing. */
export const ZOMBIE_MELEE_YAW_TOLERANCE = radians(30);

export function zombieMeleeLunge(args: {
  self: { x: number; y: number; z: number; yaw: number };
  target: Player;
  tick: number;
  /** Sim tick the next swing is allowed. NaN means ready now. */
  readyAtTick: number;
}): boolean {
  // Planar centers, same reach the sim uses for a zombie bite. Eye-to-chest
  // distance made a short reach miss while the bodies were already touching.
  const reach = ZOMBOTS_TUNING.zombie.meleeRange;
  const dist2 = distanceSquared2(
    args.self.x - args.target.x,
    args.self.z - args.target.z,
  );
  if (dist2 > reach * reach) return false;
  const bearing = yawToward(
    args.self.x,
    args.self.z,
    args.target.x,
    args.target.z,
  );
  if (abs(angleDelta(bearing, args.self.yaw)) > ZOMBIE_MELEE_YAW_TOLERANCE) {
    return false;
  }
  if (isSetNumber(args.readyAtTick) && args.tick < args.readyAtTick) {
    return false;
  }
  return true;
}
