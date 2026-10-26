import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import type { DoorsMap } from "../../../shared/map.ts";
import {
  DOOR_CENTER_BLINE_COMMIT_DIST,
  DOOR_CENTER_BLINE_DIST,
  DOOR_CENTER_BLINE_FOV_HALF,
  pickDoorCenterBlineTarget,
} from "./doorCenterBline.ts";
import { enemyDoorMidpoint, yawTowardPoint } from "../../yawPole/helpers/yawPole.ts";

function openMap(): DoorsMap {
  return {
    version: 1,
    name: "DoorCenterBline",
    bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 },
    gridSize: 1,
    teamA: {
      corners: [0, 1],
      edge: "south",
      doorHalfWidth: 2.5,
      spawnRadius: 3,
    },
    teamB: {
      corners: [2, 3],
      edge: "north",
      doorHalfWidth: 2.5,
      spawnRadius: 3,
    },
    walls: [],
  };
}

Deno.test("DOOR_CENTER_BLINE_DIST is 5u", () => {
  assertEquals(DOOR_CENTER_BLINE_DIST, 5);
});

Deno.test("DOOR_CENTER_BLINE_COMMIT_DIST is 4u", () => {
  assertEquals(DOOR_CENTER_BLINE_COMMIT_DIST, 4);
});

Deno.test("pickDoorCenterBlineTarget: null when doors closed", () => {
  const map = openMap();
  const door = enemyDoorMidpoint(map, "A")!;
  // Just south of north (enemy for A) door.
  const z = door.z - 3;
  const face = yawTowardPoint(0, z, door.x, door.z)!;
  assertEquals(
    pickDoorCenterBlineTarget({
      x: 0,
      z,
      faceYaw: face,
      map,
      team: "A",
      doorsOpen: false,
    }),
    null,
  );
});

Deno.test("pickDoorCenterBlineTarget: null when farther than 5u", () => {
  const map = openMap();
  const door = enemyDoorMidpoint(map, "A")!;
  const z = door.z - (DOOR_CENTER_BLINE_DIST + 0.5);
  const face = yawTowardPoint(0, z, door.x, door.z)!;
  assertEquals(
    pickDoorCenterBlineTarget({
      x: 0,
      z,
      faceYaw: face,
      map,
      team: "A",
      doorsOpen: true,
    }),
    null,
  );
});

Deno.test("pickDoorCenterBlineTarget: facing away still commits inside 4u", () => {
  const map = openMap();
  const door = enemyDoorMidpoint(map, "A")!;
  const z = door.z - 3;
  // Face away from door (south). Dist 3 ≤ commit 4 → still the mouth.
  const faceAway = 0;
  const hit = pickDoorCenterBlineTarget({
    x: 0,
    z,
    faceYaw: faceAway,
    map,
    team: "A",
    doorsOpen: true,
  });
  assert(hit !== null);
  assertAlmostEquals(hit!.x, door.x, 1e-9);
  assertAlmostEquals(hit!.z, door.z, 1e-9);
});

Deno.test("pickDoorCenterBlineTarget: null when center outside front FOV past commit", () => {
  const map = openMap();
  const door = enemyDoorMidpoint(map, "A")!;
  // Between commit (4) and vision-arm (5): FOV still required.
  const z = door.z - 4.5;
  const faceAway = 0;
  assertEquals(
    pickDoorCenterBlineTarget({
      x: 0,
      z,
      faceYaw: faceAway,
      map,
      team: "A",
      doorsOpen: true,
    }),
    null,
  );
  const faceSide = Math.PI / 2;
  assertEquals(
    pickDoorCenterBlineTarget({
      x: 0,
      z,
      faceYaw: faceSide,
      map,
      team: "A",
      doorsOpen: true,
    }),
    null,
  );
});

Deno.test("pickDoorCenterBlineTarget: returns center when near + in FOV", () => {
  const map = openMap();
  const door = enemyDoorMidpoint(map, "A")!;
  const z = door.z - 3;
  const face = yawTowardPoint(0, z, door.x, door.z)!;
  const hit = pickDoorCenterBlineTarget({
    x: 0,
    z,
    faceYaw: face,
    map,
    team: "A",
    doorsOpen: true,
  });
  assert(hit !== null);
  assertAlmostEquals(hit!.x, door.x, 1e-9);
  assertAlmostEquals(hit!.z, door.z, 1e-9);
});

Deno.test("pickDoorCenterBlineTarget: works at FOV edge within half-angle", () => {
  const map = openMap();
  const door = enemyDoorMidpoint(map, "A")!;
  const z = door.z - 3;
  const bearing = yawTowardPoint(0, z, door.x, door.z)!;
  // Rotate face so center sits just inside the FOV edge.
  const face = bearing + DOOR_CENTER_BLINE_FOV_HALF * 0.95;
  const hit = pickDoorCenterBlineTarget({
    x: 0,
    z,
    faceYaw: face,
    map,
    team: "A",
    doorsOpen: true,
  });
  assert(hit !== null);
  assertAlmostEquals(hit!.x, door.x, 1e-9);
});

Deno.test("pickDoorCenterBlineTarget: just outside FOV rejects past commit", () => {
  const map = openMap();
  const door = enemyDoorMidpoint(map, "A")!;
  const z = door.z - 4.5;
  const bearing = yawTowardPoint(0, z, door.x, door.z)!;
  const face = bearing + DOOR_CENTER_BLINE_FOV_HALF + 0.05;
  assertEquals(
    pickDoorCenterBlineTarget({
      x: 0,
      z,
      faceYaw: face,
      map,
      team: "A",
      doorsOpen: true,
    }),
    null,
  );
});

Deno.test("pickDoorCenterBlineTarget: off-center bot still aims door mid", () => {
  // Bot near left of door mouth — would have sticky-locked a side pole before.
  const map = openMap();
  const door = enemyDoorMidpoint(map, "A")!;
  const x = -1.8;
  const z = door.z - 2.5;
  const face = yawTowardPoint(x, z, door.x, door.z)!;
  const hit = pickDoorCenterBlineTarget({
    x,
    z,
    faceYaw: face,
    map,
    team: "A",
    doorsOpen: true,
  });
  assert(hit !== null);
  assertAlmostEquals(hit!.x, door.x, 1e-9);
  assertAlmostEquals(hit!.z, door.z, 1e-9);
});

Deno.test("pickDoorCenterBlineTarget: own door never qualifies (score-home trap)", () => {
  const map = openMap();
  // Team A own door is south (z = minZ = -20). After capture home bots stand
  // here; walking into the own gap must not arm center-bline.
  const z = -20 + 2.5;
  const face = yawTowardPoint(0, z, 0, -20)!; // look south at own door
  assertEquals(
    pickDoorCenterBlineTarget({
      x: 0,
      z,
      faceYaw: face,
      map,
      team: "A",
      doorsOpen: true,
    }),
    null,
  );
});
