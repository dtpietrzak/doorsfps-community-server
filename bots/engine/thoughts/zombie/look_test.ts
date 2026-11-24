import { assertAlmostEquals, assertEquals } from "@std/assert";
import { aimPointOnPlayer } from "../../helpers/combat.ts";
import { pitchToward, yawToward } from "../../navigation/heading.ts";
import type { Player } from "../../players/Player.ts";
import { zombieLookAt } from "./look.ts";

Deno.test("zombieLookAt: yaw on the body, pitch on the chest", () => {
  const self = { x: 0, y: 1.6, z: 0 };
  const target = {
    x: 4,
    y: 1.6,
    z: -2,
    crouch: false,
  } as Player;
  const look = zombieLookAt(self, target);
  const chest = aimPointOnPlayer(target);
  assertEquals(look.yaw, yawToward(self.x, self.z, target.x, target.z));
  assertAlmostEquals(
    look.pitch,
    pitchToward(self.x, self.y, self.z, chest.x, chest.y, chest.z),
    1e-9,
  );
  // Chest sits below the eye, so a level human is a slight look-down.
  assertEquals(look.pitch < 0, true);
});
