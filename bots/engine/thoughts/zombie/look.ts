/**
 * Face the sticky human's chest. Level pitch is for when there is no
 * target; the brain leaves that to the nav look.
 */

import { aimPointOnPlayer } from "../../helpers/combat.ts";
import { pitchToward, yawToward } from "../../navigation/heading.ts";
import type { Player } from "../../players/Player.ts";

export function zombieLookAt(
  self: { x: number; y: number; z: number },
  target: Player,
): { yaw: number; pitch: number } {
  const chest = aimPointOnPlayer(target);
  return {
    yaw: yawToward(self.x, self.z, target.x, target.z),
    pitch: pitchToward(
      self.x,
      self.y,
      self.z,
      chest.x,
      chest.y,
      chest.z,
    ),
  };
}
