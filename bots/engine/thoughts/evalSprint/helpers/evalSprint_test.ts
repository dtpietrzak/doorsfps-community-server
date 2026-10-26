import { assertEquals } from "jsr:@std/assert@1";
import { SPRINT_DURATION_S } from "../../../../../shared/sim/game.ts";
import type { BotHint, DoorsMap } from "../../../shared/map.ts";
import { YAW_DOOR_FOV_HALF_ANGLE } from "../../../../../shared/world/wallCorners.ts";
import { MapCollision } from "../../../world/MapCollision.ts";
import { enemyDoorTarget, yawToward } from "../../../helpers/nav.ts";
import {
  canOpenSprintFromStamina,
  isMoveTowardEnemyDoor,
  isMoveTowardEnemyDoorLenient,
  OPEN_SPRINT_MIN_STAMINA_FRAC,
  stepEvalOpenSprint,
  stepEvalSprint,
} from "./evalSprint.ts";

function miniMap(hints: BotHint[] = []): DoorsMap {
  return {
    version: 1,
    name: "evalSprint-test",
    bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 },
    gridSize: 1,
    teamA: {
      corners: [0, 1],
      edge: "south",
      doorHalfWidth: 2,
      spawnRadius: 3,
    },
    teamB: {
      corners: [2, 3],
      edge: "north",
      doorHalfWidth: 2,
      spawnRadius: 3,
    },
    walls: [],
    botHints: hints,
  };
}

/** Large sprint poly covering the southern half (team A side of midfield). */
const SPRINT_A: BotHint = {
  id: "sprint-a",
  kind: "sprint",
  team: "A",
  polygon: [
    { x: -15, z: -15 },
    { x: 15, z: -15 },
    { x: 15, z: 0 },
    { x: -15, z: 0 },
  ],
};

Deno.test("stepEvalSprint: outside zone is false even when running toward door", () => {
  const map = miniMap([SPRINT_A]);
  // North of mid — outside the southern sprint poly.
  const x = 0;
  const z = 5;
  const door = enemyDoorTarget(map, "A");
  const moveYaw = yawToward(x, z, door.x, door.z);
  assertEquals(
    stepEvalSprint({ map, team: "A", x, z, moveYaw }),
    false,
  );
});

Deno.test("stepEvalSprint: in zone + run toward door → true", () => {
  const map = miniMap([SPRINT_A]);
  const x = 0;
  const z = -8;
  const door = enemyDoorTarget(map, "A");
  const moveYaw = yawToward(x, z, door.x, door.z);
  assertEquals(
    stepEvalSprint({ map, team: "A", x, z, moveYaw }),
    true,
  );
});

Deno.test("stepEvalSprint: in zone but run opposite → false", () => {
  const map = miniMap([SPRINT_A]);
  const x = 0;
  const z = -8;
  const door = enemyDoorTarget(map, "A");
  const toward = yawToward(x, z, door.x, door.z);
  // Run away from door (π flip).
  const moveYaw = toward + Math.PI;
  assertEquals(
    stepEvalSprint({ map, team: "A", x, z, moveYaw }),
    false,
  );
});

Deno.test("stepEvalSprint: in zone + lateral run (not toward door) → false", () => {
  const map = miniMap([SPRINT_A]);
  const x = 0;
  const z = -8;
  const door = enemyDoorTarget(map, "A");
  const toward = yawToward(x, z, door.x, door.z);
  // Pure strafe: ±90° from door bearing.
  const moveYaw = toward + Math.PI / 2;
  assertEquals(
    stepEvalSprint({ map, team: "A", x, z, moveYaw }),
    false,
  );
  assertEquals(
    isMoveTowardEnemyDoor({ map, team: "A", x, z, moveYaw }),
    false,
  );
});

Deno.test("stepEvalSprint: far from door still true when running + in zone", () => {
  const map = miniMap([SPRINT_A]);
  // Near own south door — still in zone poly; enemy door is far north.
  const x = 0;
  const z = -14;
  const door = enemyDoorTarget(map, "A");
  const moveYaw = yawToward(x, z, door.x, door.z);
  assertEquals(
    stepEvalSprint({ map, team: "A", x, z, moveYaw }),
    true,
  );
});

Deno.test("stepEvalSprint: wrong team zone does not match", () => {
  const map = miniMap([
    {
      id: "sprint-b",
      kind: "sprint",
      team: "B",
      polygon: [
        { x: -15, z: -15 },
        { x: 15, z: -15 },
        { x: 15, z: 0 },
        { x: -15, z: 0 },
      ],
    },
  ]);
  const x = 0;
  const z = -8;
  const door = enemyDoorTarget(map, "A");
  const moveYaw = yawToward(x, z, door.x, door.z);
  assertEquals(
    stepEvalSprint({ map, team: "A", x, z, moveYaw }),
    false,
  );
});

Deno.test("stepEvalSprint: just outside door FOV half-angle → false", () => {
  const map = miniMap([SPRINT_A]);
  const x = 0;
  const z = -8;
  const door = enemyDoorTarget(map, "A");
  const toward = yawToward(x, z, door.x, door.z);
  const moveYaw = toward + YAW_DOOR_FOV_HALF_ANGLE + 0.05;
  assertEquals(
    stepEvalSprint({ map, team: "A", x, z, moveYaw }),
    false,
  );
});

Deno.test("stepEvalSprint: no sprint hints → false", () => {
  const map = miniMap([]);
  const x = 0;
  const z = -8;
  const door = enemyDoorTarget(map, "A");
  const moveYaw = yawToward(x, z, door.x, door.z);
  assertEquals(
    stepEvalSprint({ map, team: "A", x, z, moveYaw }),
    false,
  );
});

Deno.test("isMoveTowardEnemyDoor: true outside zone when running at door", () => {
  const map = miniMap([SPRINT_A]);
  const x = 0;
  const z = 5;
  const door = enemyDoorTarget(map, "A");
  const moveYaw = yawToward(x, z, door.x, door.z);
  assertEquals(
    isMoveTowardEnemyDoor({ map, team: "A", x, z, moveYaw }),
    true,
  );
});

Deno.test("isMoveTowardEnemyDoorLenient: going north counts for team A", () => {
  const map = miniMap();
  const x = 0;
  const z = -8;
  // yaw π → forward +z (north), enemy door is north for team A.
  const moveYaw = Math.PI;
  assertEquals(
    isMoveTowardEnemyDoorLenient({ map, team: "A", x, z, moveYaw }),
    true,
  );
  // yaw 0 → south — retreat for team A.
  assertEquals(
    isMoveTowardEnemyDoorLenient({ map, team: "A", x, z, moveYaw: 0 }),
    false,
  );
});

Deno.test("isMoveTowardEnemyDoorLenient: diagonal NE counts; pure east does not", () => {
  const map = miniMap();
  const x = 0;
  const z = -8;
  // NE: between north (π) and east (−π/2) in this yaw system.
  // east: yaw = -π/2 → fx = 1, fz = 0 (pure east, no N/S progress).
  const pureEast = -Math.PI / 2;
  assertEquals(
    isMoveTowardEnemyDoorLenient({ map, team: "A", x, z, moveYaw: pureEast }),
    false,
  );
  // 45° east of north: still some +z component toward north door.
  const northEast = Math.PI - Math.PI / 4;
  assertEquals(
    isMoveTowardEnemyDoorLenient({ map, team: "A", x, z, moveYaw: northEast }),
    true,
  );
  // Strict FOV would reject a large offset; lenient still accepts hemisphere.
  const door = enemyDoorTarget(map, "A");
  const toward = yawToward(x, z, door.x, door.z);
  const outsideFov = toward + YAW_DOOR_FOV_HALF_ANGLE + 0.2;
  assertEquals(
    isMoveTowardEnemyDoor({ map, team: "A", x, z, moveYaw: outsideFov }),
    false,
  );
  assertEquals(
    isMoveTowardEnemyDoorLenient({
      map,
      team: "A",
      x,
      z,
      moveYaw: outsideFov,
    }),
    true,
  );
});

Deno.test("isMoveTowardEnemyDoorLenient: team B needs going south", () => {
  const map = miniMap();
  const x = 0;
  const z = 8;
  // South (yaw 0) toward team A door for team B.
  assertEquals(
    isMoveTowardEnemyDoorLenient({ map, team: "B", x, z, moveYaw: 0 }),
    true,
  );
  assertEquals(
    isMoveTowardEnemyDoorLenient({ map, team: "B", x, z, moveYaw: Math.PI }),
    false,
  );
});

Deno.test("stepEvalOpenSprint: open lane + door-run + fresh stamina → true outside zone", () => {
  const map = miniMap([]); // no sprint hints
  const collision = new MapCollision(map);
  const x = 0;
  const z = 0;
  const door = enemyDoorTarget(map, "A");
  const moveYaw = yawToward(x, z, door.x, door.z);
  assertEquals(
    stepEvalOpenSprint({
      map,
      team: "A",
      x,
      z,
      moveYaw,
      collision,
      sprintStamina: SPRINT_DURATION_S,
    }),
    true,
  );
  // Zone path still false without hints.
  assertEquals(
    stepEvalSprint({ map, team: "A", x, z, moveYaw }),
    false,
  );
});

Deno.test("stepEvalOpenSprint: reverse or wall blocks → false", () => {
  const map = miniMap([]);
  // Full bar just north of origin — blocks open lane for team A door-run.
  const walled: DoorsMap = {
    ...map,
    walls: [
      {
        id: "bar",
        kind: "full",
        a: { x: -20, z: 1.2 },
        b: { x: 20, z: 1.2 },
      },
    ],
  };
  const collision = new MapCollision(walled);
  const x = 0;
  const z = 0;
  const door = enemyDoorTarget(walled, "A");
  const north = yawToward(x, z, door.x, door.z);
  assertEquals(
    stepEvalOpenSprint({
      map: walled,
      team: "A",
      x,
      z,
      moveYaw: north,
      collision,
      sprintStamina: SPRINT_DURATION_S,
    }),
    false,
  );
  // Clear map but reverse: still false.
  const openCol = new MapCollision(map);
  assertEquals(
    stepEvalOpenSprint({
      map,
      team: "A",
      x,
      z,
      moveYaw: north + Math.PI,
      collision: openCol,
      sprintStamina: SPRINT_DURATION_S,
    }),
    false,
  );
});

Deno.test("canOpenSprintFromStamina: only above OPEN_SPRINT_MIN_STAMINA_FRAC", () => {
  assertEquals(canOpenSprintFromStamina(SPRINT_DURATION_S), true);
  assertEquals(
    canOpenSprintFromStamina(
      SPRINT_DURATION_S * (OPEN_SPRINT_MIN_STAMINA_FRAC + 0.01),
    ),
    true,
  );
  assertEquals(
    canOpenSprintFromStamina(SPRINT_DURATION_S * OPEN_SPRINT_MIN_STAMINA_FRAC),
    false,
  );
  assertEquals(
    canOpenSprintFromStamina(
      SPRINT_DURATION_S * (OPEN_SPRINT_MIN_STAMINA_FRAC - 0.01),
    ),
    false,
  );
  assertEquals(canOpenSprintFromStamina(0), false);
});

Deno.test("stepEvalOpenSprint: at stamina gate refuses; just above allows", () => {
  const map = miniMap([]);
  const collision = new MapCollision(map);
  const x = 0;
  const z = 0;
  const door = enemyDoorTarget(map, "A");
  const moveYaw = yawToward(x, z, door.x, door.z);
  assertEquals(
    stepEvalOpenSprint({
      map,
      team: "A",
      x,
      z,
      moveYaw,
      collision,
      sprintStamina: SPRINT_DURATION_S * OPEN_SPRINT_MIN_STAMINA_FRAC,
    }),
    false,
  );
  assertEquals(
    stepEvalOpenSprint({
      map,
      team: "A",
      x,
      z,
      moveYaw,
      collision,
      sprintStamina: SPRINT_DURATION_S * OPEN_SPRINT_MIN_STAMINA_FRAC + 1e-6,
    }),
    true,
  );
});
