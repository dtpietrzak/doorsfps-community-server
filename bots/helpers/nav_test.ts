import { assertEquals } from "@std/assert";
import {
  botLateralBias,
  CAMP_OCCUPY_RADIUS,
  enemyDoorTarget,
  estimateHalfWallFaceYaw,
  hasAdjacentWallCover,
  hasCampLineOfSight,
  hasOpenSpaceAhead,
  isFullWallAhead,
  isLookIntoFullWall,
  isNearCampClaim,
  minDistToClaims,
  moveKeysForWorldYaw,
  ownDoorTarget,
  pickCoverDoorCamp,
  pitchToward,
  yawToward,
} from "./nav.ts";
import { MapCollision } from "../../world/MapCollision.ts";
import type { DoorsMap } from "../../world/map.ts";

function halfWallMap(): DoorsMap {
  return {
    version: 1,
    name: "HalfWallNav",
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
    walls: [
      {
        id: "h1",
        kind: "half",
        a: { x: -6, z: 0 },
        b: { x: 6, z: 0 },
      },
    ],
  };
}

function fullWallMap(): DoorsMap {
  return {
    version: 1,
    name: "FullWallNav",
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
    walls: [
      {
        id: "w1",
        kind: "full",
        a: { x: -4, z: 0 },
        b: { x: 4, z: 0 },
      },
    ],
  };
}

/** South door with a pillar/offset wall on the home half for cover camping. */
function coverCampMap(): DoorsMap {
  return {
    version: 1,
    name: "CoverCamp",
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
    walls: [
      {
        id: "cover_L",
        kind: "full",
        a: { x: -5.5, z: -14 },
        b: { x: -5.5, z: -8 },
      },
      {
        id: "cover_R",
        kind: "full",
        a: { x: 5.5, z: 8 },
        b: { x: 5.5, z: 14 },
      },
    ],
  };
}

Deno.test("pickCoverDoorCamp: keeps door LOS, avoids door mouth, prefers cover", () => {
  const col = new MapCollision(coverCampMap());
  const door = ownDoorTarget(col.map, "A"); // south door ~ (0, -20)

  // Run several picks — randomness should still honor hard constraints.
  for (let i = 0; i < 12; i++) {
    const camp = pickCoverDoorCamp(col as never, door, { preferTight: false });
    const doorDist = Math.hypot(camp.x - door.x, camp.z - door.z);
    // Not planted on the capture lip / right in front of the door.
    assertEquals(doorDist >= 3.2, true);
    // On the interior (north of south door).
    assertEquals(camp.z > door.z + 2.5, true);
    // Can still see the door.
    assertEquals(hasCampLineOfSight(col as never, camp.x, camp.z, door.x, door.z), true);
    assertEquals(col.classifyProbe(camp.x, camp.z), "clear");
  }

  // With cover geometry available, at least one of several picks should sit
  // next to a wall (scoring heavily prefers adjacent cover).
  let sawCover = false;
  for (let i = 0; i < 20; i++) {
    const camp = pickCoverDoorCamp(col as never, door);
    if (hasAdjacentWallCover(col as never, camp.x, camp.z)) {
      sawCover = true;
      break;
    }
  }
  assertEquals(sawCover, true);
});

Deno.test("pickCoverDoorCamp: open map falls back off centerline", () => {
  const open: DoorsMap = {
    version: 1,
    name: "Open",
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
  const col = new MapCollision(open);
  const door = ownDoorTarget(open, "A");
  const camp = pickCoverDoorCamp(col as never, door);
  assertEquals(Math.hypot(camp.x - door.x, camp.z - door.z) >= 3.0, true);
  assertEquals(hasCampLineOfSight(col as never, camp.x, camp.z, door.x, door.z), true);
});

Deno.test("pickCoverDoorCamp: avoid radius keeps teammates apart", () => {
  const col = new MapCollision(coverCampMap());
  const door = ownDoorTarget(col.map, "A");
  const first = pickCoverDoorCamp(col as never, door, {
    preferTight: false,
    rng: () => 0.5,
  });
  let minDist = Infinity;
  for (let i = 0; i < 15; i++) {
    const second = pickCoverDoorCamp(col as never, door, {
      preferTight: false,
      avoid: [first],
      avoidRadius: CAMP_OCCUPY_RADIUS,
      pickMode: "nextBest",
      rng: () => (i + 0.5) / 15,
      lateralBias: i % 2 === 0 ? 1 : -1,
    });
    const d = Math.hypot(second.x - first.x, second.z - first.z);
    if (d < minDist) minDist = d;
    assertEquals(
      isNearCampClaim(second.x, second.z, [first], CAMP_OCCUPY_RADIUS),
      false,
    );
  }
  assertEquals(minDist >= CAMP_OCCUPY_RADIUS * 0.9, true);
});

Deno.test("botLateralBias is stable and in [-1, 1]", () => {
  const a = botLateralBias("pool_account_42");
  const b = botLateralBias("pool_account_42");
  assertEquals(a, b);
  assertEquals(a >= -1 && a <= 1, true);
  const c = botLateralBias("pool_account_60");
  // Different ids almost always differ (hash).
  assertEquals(a !== c, true);
});

Deno.test("pickCoverDoorCamp: lateralBias prefers opposite sides", () => {
  const col = new MapCollision(coverCampMap());
  const door = ownDoorTarget(col.map, "A");
  const left = pickCoverDoorCamp(col as never, door, {
    preferTight: false,
    lateralBias: -1,
    rng: () => 0.5,
  });
  const right = pickCoverDoorCamp(col as never, door, {
    preferTight: false,
    lateralBias: 1,
    rng: () => 0.5,
  });
  // With opposite bias, picks should not be the same cell.
  const d = Math.hypot(left.x - right.x, left.z - right.z);
  assertEquals(d > 0.5, true);
});

Deno.test("pickCoverDoorCamp: three avoids still finds a free or distant spot", () => {
  const col = new MapCollision(coverCampMap());
  const door = ownDoorTarget(col.map, "A");
  const a = pickCoverDoorCamp(col as never, door, { rng: () => 0.1, lateralBias: -1 });
  const b = pickCoverDoorCamp(col as never, door, {
    avoid: [a],
    pickMode: "nextBest",
    rng: () => 0.4,
    lateralBias: 1,
  });
  const c = pickCoverDoorCamp(col as never, door, {
    avoid: [a, b],
    pickMode: "spread",
    rng: () => 0.7,
    lateralBias: 0.2,
  });
  assertEquals(isNearCampClaim(b.x, b.z, [a], CAMP_OCCUPY_RADIUS), false);
  assertEquals(isNearCampClaim(c.x, c.z, [a], CAMP_OCCUPY_RADIUS), false);
  assertEquals(isNearCampClaim(c.x, c.z, [b], CAMP_OCCUPY_RADIUS), false);
  assertEquals(
    minDistToClaims(c.x, c.z, [a, b]) >= CAMP_OCCUPY_RADIUS * 0.9,
    true,
  );
});

Deno.test("pickCoverDoorCamp: farFromEnemy is further from enemy door", () => {
  const col = new MapCollision(coverCampMap());
  const door = ownDoorTarget(col.map, "A");
  const enemy = enemyDoorTarget(col.map, "A");
  let bestEnemyDist = 0;
  let farEnemyDist = 0;
  const n = 20;
  for (let i = 0; i < n; i++) {
    const best = pickCoverDoorCamp(col as never, door, {
      preferTight: false,
      pickMode: "best",
      enemyDoor: enemy,
    });
    const far = pickCoverDoorCamp(col as never, door, {
      preferTight: false,
      pickMode: "farFromEnemy",
      enemyDoor: enemy,
    });
    bestEnemyDist += Math.hypot(best.x - enemy.x, best.z - enemy.z);
    farEnemyDist += Math.hypot(far.x - enemy.x, far.z - enemy.z);
  }
  // Downstream should not on average sit closer to the enemy door than best.
  assertEquals(farEnemyDist / n >= bestEnemyDist / n - 0.5, true);
});

Deno.test("hasOpenSpaceAhead: open lane vs wall", () => {
  const col = new MapCollision(halfWallMap());
  const north = Math.PI; // +z
  assertEquals(hasOpenSpaceAhead(col as never, 0, -12, north), true);
  assertEquals(hasOpenSpaceAhead(col as never, 0, -1.5, north), false);
});

Deno.test("isLookIntoFullWall / isFullWallAhead: nose on full bar", () => {
  const col = new MapCollision(fullWallMap());
  const north = Math.PI;
  assertEquals(isLookIntoFullWall(col as never, 0, -0.55, north), true);
  assertEquals(isFullWallAhead(col as never, 0, -2.0, north), true);
  assertEquals(isLookIntoFullWall(col as never, 0, -12, north), false);
});

Deno.test("pitchToward: stacked (tiny horiz) stays near level, not floor bow", () => {
  const p = pitchToward(0, 1.7, 0, 0.05, 1.1, 0.05);
  assertEquals(p > -0.25, true);
  assertEquals(p < 0.2, true);
  const p0 = pitchToward(0, 1.7, 0, 0, 1.1, 0);
  assertEquals(p0 > -0.25, true);
});

Deno.test("moveKeysForWorldYaw: face threat, cut toward door with strafe", () => {
  const lookNorth = 0;
  const moveNE = yawToward(0, 0, 5, -5); // +x −z from origin
  const keys = moveKeysForWorldYaw(lookNorth, moveNE);
  assertEquals(keys.forward, true);
  assertEquals(keys.right, true);
  assertEquals(keys.backward, false);
  assertEquals(keys.left, false);
});

Deno.test("estimateHalfWallFaceYaw: faces into E-W half-wall from south", () => {
  const col = new MapCollision(halfWallMap());
  const face = estimateHalfWallFaceYaw(col as never, 0, -1.2, Math.PI);
  if (face === null) throw new Error("expected face yaw");
  const err = Math.min(
    Math.abs(face - Math.PI),
    Math.abs(face + Math.PI),
    Math.abs(Math.abs(face) - Math.PI),
  );
  assertEquals(err < 0.25, true, `face ${face} should be ~π`);
});
