import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { yawPoleKey } from "../../../../shared/world/yawPole.ts";
import {
  bodyAvoidMoveYaw,
  occupiedWallPoleKeys,
  PLAYER_AVOID_DIST,
  PLAYER_AVOID_YAW_MAX,
  YAW_POLE_BODY_OCCUPY_RADIUS,
} from "./playerAvoid.ts";

Deno.test("occupiedWallPoleKeys: empty when nobody sits on a pole", () => {
  const keys = occupiedWallPoleKeys(
    [{ x: 0, z: 5 }],
    [{ id: "a", x: 10, z: 10 }],
  );
  assertEquals(keys.size, 0);
});

Deno.test("occupiedWallPoleKeys: flags a pole another body occupies", () => {
  const pole = { x: 2, z: -4 };
  const keys = occupiedWallPoleKeys(
    [pole, { x: 8, z: 8 }],
    [{ id: "bot:2", x: pole.x + 0.1, z: pole.z }],
  );
  assertEquals(keys.has(yawPoleKey(pole.x, pole.z)), true);
  assertEquals(keys.has(yawPoleKey(8, 8)), false);
  assert(YAW_POLE_BODY_OCCUPY_RADIUS > 0.6);
});

Deno.test("bodyAvoidMoveYaw: no-op when lane is empty", () => {
  const yaw = 0;
  assertEquals(
    bodyAvoidMoveYaw(0, 0, yaw, [{ id: "far", x: 10, z: 10 }]),
    yaw,
  );
});

Deno.test("bodyAvoidMoveYaw: peels away from a body ahead", () => {
  // yaw 0 faces −z. Body ahead-left (+x, −z) → peel right (positive yaw).
  const yaw = 0;
  const out = bodyAvoidMoveYaw(0, 0, yaw, [{
    id: "left",
    x: 0.4,
    z: -0.6,
  }]);
  assert(out > yaw);
  assert(out <= yaw + PLAYER_AVOID_YAW_MAX + 1e-9);
});

Deno.test("bodyAvoidMoveYaw: ignores bodies behind and self", () => {
  const yaw = 0;
  assertEquals(
    bodyAvoidMoveYaw(0, 0, yaw, [{ id: "back", x: 0, z: 0.8 }], {
      selfId: "me",
    }),
    yaw,
  );
  assertEquals(
    bodyAvoidMoveYaw(0, 0, yaw, [{ id: "me", x: 0.2, z: -0.4 }], {
      selfId: "me",
    }),
    yaw,
  );
});

Deno.test("bodyAvoidMoveYaw: closer bodies peel more", () => {
  const yaw = 0;
  const near = bodyAvoidMoveYaw(0, 0, yaw, [{ x: 0.2, z: -0.3 }]);
  const far = bodyAvoidMoveYaw(0, 0, yaw, [{
    x: 0.2,
    z: -(PLAYER_AVOID_DIST - 0.15),
  }]);
  assertAlmostEquals(Math.sign(near), Math.sign(far), 1e-9);
  assert(Math.abs(near - yaw) > Math.abs(far - yaw));
});
