import { assertEquals } from "@std/assert";
import { STAND_EYE_HEIGHT } from "../sim/playerHitVolumes.ts";
import { downedBodyAlongRay, zombotsInteractRacks } from "./zombotsInteractSight.ts";

Deno.test("racks keep map order and take the layout's facing", () => {
  const racks = zombotsInteractRacks(
    {
      gunRacks: [
        { id: "r1", wallId: "w", center: { x: 1, z: 2 }, weapon: "pistol" },
        { id: "r2", wallId: "w", center: { x: 3, z: 4 }, weapon: "rifle" },
      ],
    },
    {
      rackPhase: [
        { rackId: "r2", weapon: "rifle", playerRoom: 1, phase: 2, facing: { x: 0, z: 1 } },
        { rackId: "r1", weapon: "pistol", playerRoom: null, phase: null, facing: null },
      ],
    },
  );
  assertEquals(racks, [
    { rack: { id: "r1", weapon: "pistol", center: { x: 1, z: 2 } }, facing: null },
    { rack: { id: "r2", weapon: "rifle", center: { x: 3, z: 4 } }, facing: { x: 0, z: 1 } },
  ]);
  assertEquals(zombotsInteractRacks({}, { rackPhase: [] }), []);
});

const eye = { x: 0, y: STAND_EYE_HEIGHT, z: 0 };
const ahead = { x: 0, y: 0, z: -1 };
const body = (playerId: string, z: number) => ({
  playerId,
  pose: { x: 0, y: STAND_EYE_HEIGHT, z },
});

Deno.test("the closest downed body in range wins", () => {
  assertEquals(downedBodyAlongRay(eye, ahead, 2, [body("far", -1.8), body("near", -1.2)]), "near");
  assertEquals(downedBodyAlongRay(eye, ahead, 2, [body("near", -1.2), body("far", -1.8)]), "near");
});

Deno.test("out of range, behind, or a wall in the way is no body", () => {
  assertEquals(downedBodyAlongRay(eye, ahead, 2, [body("a", -4)]), null);
  assertEquals(downedBodyAlongRay(eye, ahead, 2, [body("a", 1.5)]), null);
  // A wall at 0.5 cuts the range short.
  assertEquals(downedBodyAlongRay(eye, ahead, 0.5, [body("a", -1.5)]), null);
  assertEquals(downedBodyAlongRay(eye, ahead, 0, [body("a", -1)]), null);
  assertEquals(downedBodyAlongRay(eye, ahead, 2, []), null);
});
