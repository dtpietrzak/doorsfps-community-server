import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import {
  nearestClosedSlidingDoor,
  slidingDoorPlacement,
  slidingDoorYaw,
  trySpendZompoints,
  ZOMBOTS_DOOR_REACH,
} from "./slidingDoors.ts";

Deno.test("door yaw lays local +Z along an east-west wall", () => {
  const yaw = slidingDoorYaw({ x: 0, z: 0 }, { x: 4, z: 0 });
  assertAlmostEquals(yaw, Math.PI / 2);
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  // rotation.y sends local +Z to (sin, 0, cos) and local +X to (cos, 0, -sin).
  assertAlmostEquals(sin, 1, 1e-6);
  assertAlmostEquals(cos, 0, 1e-6);
  assertAlmostEquals(-sin, -1, 1e-6);
});

Deno.test("door yaw lays local +Z along a north-south wall", () => {
  const yaw = slidingDoorYaw({ x: 0, z: 0 }, { x: 0, z: 4 });
  assertAlmostEquals(yaw, 0);
  assertAlmostEquals(Math.sin(yaw), 0);
  assertAlmostEquals(Math.cos(yaw), 1);
});

Deno.test("placement span is the clear opening on the wall", () => {
  const place = slidingDoorPlacement(
    { x: -4, z: 0 },
    { x: 4, z: 0 },
    { x: 0, z: 0 },
  );
  assert(place);
  assertAlmostEquals(place.a.x, -0.925);
  assertAlmostEquals(place.b.x, 0.925);
  assertEquals(place.mid, { x: 0, z: 0 });
  assertEquals(
    slidingDoorPlacement({ x: -4, z: 0 }, { x: 4, z: 0 }, { x: 0, z: 2 }),
    null,
  );
});

Deno.test("zompoints spend only when the purse covers the door", () => {
  assertEquals(trySpendZompoints(500, 500), { ok: true, points: 0 });
  assertEquals(trySpendZompoints(499, 500), { ok: false, points: 499 });
  const doors = [
    { id: "far", cost: 500, x: 10, z: 0, open: false },
    { id: "near", cost: 500, x: 1, z: 0, open: false },
    { id: "open", cost: 500, x: 0, z: 0, open: true },
  ];
  assertEquals(nearestClosedSlidingDoor(doors, 0, 0)?.id, "near");
  assertEquals(
    nearestClosedSlidingDoor(doors, 0, 0, ZOMBOTS_DOOR_REACH - 2),
    null,
  );
});
