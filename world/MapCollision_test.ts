import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  CROUCH_COLLISION_HEIGHT,
  FLOAT_WALL_Y_MAX,
  FLOAT_WALL_Y_MIN,
  HALF_WALL_HEIGHT,
  JUMPABLE_HALF_WALL_END_INSET,
  MapCollision,
  PLAYER_RADIUS,
  STAND_COLLISION_HEIGHT,
  WALL_HALF_THICK,
  WALL_HEIGHT,
} from "./MapCollision.ts";
import type { DoorsMap } from "./map.ts";
import { DOOR_POST_WIDTH, DOOR_WALK_IN } from "../shared/sim/game.ts";

function testMap(walls: DoorsMap["walls"] = []): DoorsMap {
  return {
    version: 1,
    name: "test",
    bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 },
    gridSize: 1,
    walls,
    teamA: {
      corners: [0, 1],
      edge: "south",
      doorHalfWidth: 1.5,
      spawnRadius: 3,
    },
    teamB: {
      corners: [2, 3],
      edge: "north",
      doorHalfWidth: 1.5,
      spawnRadius: 3,
    },
  };
}

Deno.test("raycastSolid hits interior wall face-on", () => {
  // Wall along X at z = -5, from x=-2 to x=2
  const col = new MapCollision(
    testMap([
      {
        id: "w1",
        a: { x: -2, z: -5 },
        b: { x: 2, z: -5 },
      },
    ]),
  );
  const origin = { x: 0, y: 1.5, z: 0 };
  const dir = { x: 0, y: 0, z: -1 };
  const t = col.raycastSolid(origin, dir, 80);
  assertExists(t);
  // Front face of wall at z = -5 + halfThick
  const expected = 5 - WALL_HALF_THICK;
  assertEquals(Math.abs(t! - expected) < 0.02, true);
});

Deno.test("raycastSolid blocks player-range past wall", () => {
  const col = new MapCollision(
    testMap([
      {
        id: "w1",
        a: { x: -3, z: -4 },
        b: { x: 3, z: -4 },
      },
    ]),
  );
  const origin = { x: 0, y: 1.5, z: 0 };
  const dir = { x: 0, y: 0, z: -1 };
  const wallT = col.raycastSolid(origin, dir, 80);
  assertExists(wallT);
  // Target would be at z=-10; wall must be closer
  assertEquals(wallT! < 10, true);
  assertEquals(wallT! > 3, true);
});

Deno.test("raycastSolid misses when aiming past wall end", () => {
  const col = new MapCollision(
    testMap([
      {
        id: "w1",
        a: { x: -2, z: -5 },
        b: { x: 2, z: -5 },
      },
    ]),
  );
  // Aim far to the side of the wall segment
  const origin = { x: 10, y: 1.5, z: 0 };
  const dir = { x: 0, y: 0, z: -1 };
  const t = col.raycastSolid(origin, dir, 80);
  // May still hit outer perimeter at z=-20; must NOT hit interior wall (~5)
  if (t !== null) {
    assertEquals(t > 10, true);
  }
});

Deno.test("raycastSolid misses shots above wall height", () => {
  const col = new MapCollision(
    testMap([
      {
        id: "w1",
        a: { x: -4, z: -5 },
        b: { x: 4, z: -5 },
      },
    ]),
  );
  // Start above wall top and shoot level — clears the slab
  const origin = { x: 0, y: WALL_HEIGHT + 0.5, z: 0 };
  const dir = { x: 0, y: 0, z: -1 };
  const t = col.raycastSolid(origin, dir, 80);
  // Only possible hit is far perimeter; interior wall must not register ~5
  if (t !== null) {
    assertEquals(t > 10, true);
  }
});

Deno.test("raycastSolid hits wall at grazing angle", () => {
  const col = new MapCollision(
    testMap([
      {
        id: "w1",
        a: { x: -1, z: -6 },
        b: { x: 1, z: -6 },
      },
    ]),
  );
  const origin = { x: -3, y: 1.2, z: 0 };
  // Aim toward center of wall
  const dir = { x: 3, y: 0, z: -6 };
  const t = col.raycastSolid(origin, dir, 80);
  assertExists(t);
  assertEquals(t! > 0 && t! < 10, true);
});

Deno.test("raycastSolid hits half wall at crouch eye height", () => {
  const col = new MapCollision(
    testMap([
      {
        id: "h1",
        kind: "half",
        a: { x: -2, z: -5 },
        b: { x: 2, z: -5 },
      },
    ]),
  );
  // Crouch eye sits under the half wall (height 1.2)
  const origin = { x: 0, y: 1.05, z: 0 };
  const dir = { x: 0, y: 0, z: -1 };
  const t = col.raycastSolid(origin, dir, 80);
  assertExists(t);
  const expected = 5 - WALL_HALF_THICK;
  assertEquals(Math.abs(t! - expected) < 0.02, true);
});

Deno.test("raycastSolid clears half wall when aiming above it", () => {
  const col = new MapCollision(
    testMap([
      {
        id: "h1",
        kind: "half",
        a: { x: -4, z: -5 },
        b: { x: 4, z: -5 },
      },
    ]),
  );
  // Standing eye height (1.7) shooting level clears half wall (1.2)
  const origin = { x: 0, y: 1.7, z: 0 };
  const dir = { x: 0, y: 0, z: -1 };
  const t = col.raycastSolid(origin, dir, 80);
  // Only possible hit is far perimeter; half wall must not register ~5
  if (t !== null) {
    assertEquals(t > 10, true);
  }
  // Sanity: half wall top is below standing eye
  assertEquals(HALF_WALL_HEIGHT < 1.7, true);
  assertEquals(HALF_WALL_HEIGHT > 1.0, true);
});

Deno.test("legacy walls without kind default to full height", () => {
  const col = new MapCollision(
    testMap([
      {
        id: "w1",
        a: { x: -2, z: -5 },
        b: { x: 2, z: -5 },
      },
    ]),
  );
  // Above half height but below full — still hits full wall
  const origin = { x: 0, y: HALF_WALL_HEIGHT + 0.3, z: 0 };
  const dir = { x: 0, y: 0, z: -1 };
  const t = col.raycastSolid(origin, dir, 80);
  assertExists(t);
  assertEquals(t! < 10, true);
});

Deno.test("resolvePosition blocks half wall on the ground", () => {
  const col = new MapCollision(
    testMap([
      {
        id: "h1",
        kind: "half",
        a: { x: -3, z: -2 },
        b: { x: 3, z: -2 },
      },
    ]),
  );
  // Walk into the wall from z=0 toward z=-4
  const r = col.resolvePosition(0, -2, 0.35, 0);
  // Should be pushed off the slab (not sit inside half-thick + radius)
  assertEquals(Math.abs(r.z + 2) >= WALL_HALF_THICK + 0.35 - 0.01, true);
});

Deno.test("resolvePosition allows jump over half wall when feet clear top", () => {
  const col = new MapCollision(
    testMap([
      {
        id: "h1",
        kind: "half",
        a: { x: -3, z: -2 },
        b: { x: 3, z: -2 },
      },
    ]),
  );
  // Feet at/above half-wall height — pass through
  const r = col.resolvePosition(0, -2, 0.35, HALF_WALL_HEIGHT);
  assertEquals(r.x, 0);
  assertEquals(r.z, -2);
});

Deno.test("resolvePosition still blocks full wall when airborne over half height", () => {
  const col = new MapCollision(
    testMap([
      {
        id: "w1",
        kind: "full",
        a: { x: -3, z: -2 },
        b: { x: 3, z: -2 },
      },
    ]),
  );
  const r = col.resolvePosition(0, -2, 0.35, HALF_WALL_HEIGHT);
  assertEquals(Math.abs(r.z + 2) >= WALL_HALF_THICK + 0.35 - 0.01, true);
});

Deno.test("resolvePosition blocks floating wall when standing", () => {
  const col = new MapCollision(
    testMap([
      {
        id: "f1",
        kind: "float",
        a: { x: -3, z: -2 },
        b: { x: 3, z: -2 },
      },
    ]),
  );
  const r = col.resolvePosition(
    0,
    -2,
    0.35,
    0,
    STAND_COLLISION_HEIGHT,
  );
  assertEquals(Math.abs(r.z + 2) >= WALL_HALF_THICK + 0.35 - 0.01, true);
  // Float top-aligned with full walls; underside below stand height.
  assertEquals(FLOAT_WALL_Y_MAX, WALL_HEIGHT);
  assertEquals(FLOAT_WALL_Y_MIN < STAND_COLLISION_HEIGHT, true);
  assertEquals(FLOAT_WALL_Y_MAX - FLOAT_WALL_Y_MIN > HALF_WALL_HEIGHT, true);
  // Standing silhouette intersects the slab (crouch required).
  assertEquals(STAND_COLLISION_HEIGHT >= FLOAT_WALL_Y_MIN, true);
});

Deno.test("resolvePosition allows crouch under floating wall", () => {
  const col = new MapCollision(
    testMap([
      {
        id: "f1",
        kind: "float",
        a: { x: -3, z: -2 },
        b: { x: 3, z: -2 },
      },
    ]),
  );
  const r = col.resolvePosition(
    0,
    -2,
    0.35,
    0,
    CROUCH_COLLISION_HEIGHT,
  );
  assertEquals(r.x, 0);
  assertEquals(r.z, -2);
  // Crouch / slide only just clears the float underside (~0.1u).
  assertEquals(CROUCH_COLLISION_HEIGHT < FLOAT_WALL_Y_MIN, true);
  assertEquals(
    Math.abs(FLOAT_WALL_Y_MIN - CROUCH_COLLISION_HEIGHT - 0.1) < 1e-9,
    true,
  );
});

Deno.test("resolvePosition still blocks floating wall when airborne over half height", () => {
  const col = new MapCollision(
    testMap([
      {
        id: "f1",
        kind: "float",
        a: { x: -3, z: -2 },
        b: { x: 3, z: -2 },
      },
    ]),
  );
  // Jump apex: feet clear half-wall top but body still intersects floating slab
  const feetY = HALF_WALL_HEIGHT + 0.05;
  const r = col.resolvePosition(
    0,
    -2,
    0.35,
    feetY,
    feetY + STAND_COLLISION_HEIGHT,
  );
  assertEquals(Math.abs(r.z + 2) >= WALL_HALF_THICK + 0.35 - 0.01, true);
});

Deno.test("raycastFullSolid hits full wall, ignores half and float", () => {
  const col = new MapCollision(
    testMap([
      {
        id: "full",
        a: { x: -2, z: -5 },
        b: { x: 2, z: -5 },
      },
      {
        id: "half",
        kind: "half",
        a: { x: -2, z: -8 },
        b: { x: 2, z: -8 },
      },
      {
        id: "float",
        kind: "float",
        a: { x: -2, z: -11 },
        b: { x: 2, z: -11 },
      },
    ]),
  );
  const origin = { x: 0, y: 1.0, z: 0 };
  const dir = { x: 0, y: 0, z: -1 };
  const fullT = col.raycastFullSolid(origin, dir, 80);
  assertExists(fullT);
  assertEquals(Math.abs(fullT! - (5 - WALL_HALF_THICK)) < 0.02, true);

  // Behind full wall, half and float must not count for full-only rays.
  const fromPastFull = { x: 0, y: 1.0, z: -6 };
  assertEquals(col.raycastFullSolid(fromPastFull, dir, 80), null);
  // raycastSolid still sees half at navel height.
  assertExists(col.raycastSolid(fromPastFull, dir, 80));
});

Deno.test("raycastSolid hits floating wall above standing eye", () => {
  const col = new MapCollision(
    testMap([
      {
        id: "f1",
        kind: "float",
        a: { x: -2, z: -5 },
        b: { x: 2, z: -5 },
      },
    ]),
  );
  // Mid-slab height (float is half-wall tall, top at full wall)
  const origin = { x: 0, y: FLOAT_WALL_Y_MIN + HALF_WALL_HEIGHT * 0.5, z: 0 };
  const dir = { x: 0, y: 0, z: -1 };
  const t = col.raycastSolid(origin, dir, 80);
  assertExists(t);
  const expected = 5 - WALL_HALF_THICK;
  assertEquals(Math.abs(t! - expected) < 0.02, true);
});

Deno.test("raycastSolid clears under floating wall at crouch eye", () => {
  const col = new MapCollision(
    testMap([
      {
        id: "f1",
        kind: "float",
        a: { x: -4, z: -5 },
        b: { x: 4, z: -5 },
      },
    ]),
  );
  // Crouch eye and just-under-slab must clear; standing eye is inside the slab.
  for (const eyeY of [1.05, FLOAT_WALL_Y_MIN - 0.05]) {
    const origin = { x: 0, y: eyeY, z: 0 };
    const dir = { x: 0, y: 0, z: -1 };
    const t = col.raycastSolid(origin, dir, 80);
    if (t !== null) {
      assertEquals(t > 10, true);
    }
  }
  assertEquals(FLOAT_WALL_Y_MIN > 1.05, true);
});

Deno.test("hasHeadroom false under floating wall when standing", () => {
  const col = new MapCollision(
    testMap([
      {
        id: "f1",
        kind: "float",
        a: { x: -3, z: -2 },
        b: { x: 3, z: -2 },
      },
    ]),
  );
  assertEquals(col.hasHeadroom(0, -2, 0, STAND_COLLISION_HEIGHT), false);
  assertEquals(col.hasHeadroom(0, -2, 0, CROUCH_COLLISION_HEIGHT), true);
});

Deno.test("classifyProbe marks floating wall crouchable not jumpable", () => {
  const col = new MapCollision(
    testMap([
      {
        id: "f1",
        kind: "float",
        a: { x: -3, z: -2 },
        b: { x: 3, z: -2 },
      },
    ]),
  );
  assertEquals(col.classifyProbe(0, -2), "crouchable");
  // Airborne still blocked by the slab (cannot jump over).
  const airFeet = HALF_WALL_HEIGHT + 0.05;
  const air = col.resolvePosition(
    0,
    -2,
    0.35,
    airFeet,
    airFeet + STAND_COLLISION_HEIGHT,
  );
  assertEquals(Math.abs(air.z + 2) >= WALL_HALF_THICK + 0.35 - 0.01, true);
});

Deno.test("classifyProbe: half-wall core is jumpable, ends are not", () => {
  // 5u E–W half wall → vault core is centered 3u after 1u inset each end.
  const col = new MapCollision(
    testMap([
      {
        id: "h1",
        kind: "half",
        a: { x: -2.5, z: 0 },
        b: { x: 2.5, z: 0 },
      },
    ]),
  );
  assertEquals(JUMPABLE_HALF_WALL_END_INSET, 1);

  // Center of wall: jump over.
  assertEquals(col.classifyProbe(0, 0), "jumpable");
  // Just inside the core (±1.5 from center for a 5u wall with 1u ends).
  assertEquals(col.classifyProbe(1.2, 0), "jumpable");
  assertEquals(col.classifyProbe(-1.2, 0), "jumpable");

  // Lip / end zone (within 1u of each tip): standing still blocked, not vaultable.
  assertEquals(col.classifyProbe(2.0, 0), "blocked");
  assertEquals(col.classifyProbe(-2.0, 0), "blocked");
  assertEquals(col.classifyProbe(2.4, 0), "blocked");
  assertEquals(col.classifyProbe(-2.4, 0), "blocked");

  // Approach samples south of the wall (bot vault probes).
  assertEquals(col.classifyForward(0, -0.8, Math.PI, 0.8), "jumpable");
  assertEquals(col.classifyForward(2.1, -0.8, Math.PI, 0.8), "blocked");
});

Deno.test("classifyProbe: short half-wall (< 2·inset) is never jumpable", () => {
  // 1.5u wall — after 1u each end, no vault core remains.
  const col = new MapCollision(
    testMap([
      {
        id: "h1",
        kind: "half",
        a: { x: -0.75, z: 0 },
        b: { x: 0.75, z: 0 },
      },
    ]),
  );
  assertEquals(col.classifyProbe(0, 0), "blocked");
  assertEquals(col.classifyForward(0, -0.8, Math.PI, 0.8), "blocked");
});

Deno.test("resolvePosition allows walk-in past door plane in the gap", () => {
  const col = new MapCollision(testMap());
  col.doorWalkInEnabled = true;
  // South door at z = -20, center x = 0. Push outward past the plane.
  const out = col.resolvePosition(0, -20 - 0.3);
  assertEquals(out.z < -20, true);
  assertEquals(out.z >= -20 - 0.45 - 0.01, true);
  // Still in capture stadium.
  assertEquals(col.isInDoorZone(out.x, out.z, col.map.teamA), true);
});

Deno.test("resolvePosition keeps the walk-in pocket clear of door posts", () => {
  const col = new MapCollision(testMap());
  col.doorWalkInEnabled = true;
  const centerLimit = 1.5 - DOOR_POST_WIDTH * 0.5 - PLAYER_RADIUS;

  // Near the right jamb, prediction clamps the player center to the true
  // opening between the 0.5u post and the mirrored player radius.
  const nearPost = col.resolvePosition(1.2, -20 - 0.3);
  assertEquals(nearPost.x <= centerLimit + 1e-6, true);
  assertEquals(nearPost.z < -20, true);

  // A center aimed through the post is treated as perimeter, not walk-in.
  const throughPost = col.resolvePosition(1.5, -20 - 0.3);
  assertEquals(throughPost.z > -20, true);
});

Deno.test("resolvePosition blocks walk-in when doors closed (walk-in disabled)", () => {
  const col = new MapCollision(testMap());
  col.doorWalkInEnabled = false;
  const out = col.resolvePosition(0, -20 - 0.3);
  // No past-plane pocket while sealed; door gap uses closed standoff (~1u).
  assertEquals(out.z > -20, true);
  assertEquals(out.z >= -20 + 1.0 - 0.01, true);
});

Deno.test("resolvePosition keeps ~1u standoff from sealed door in the gap", () => {
  const col = new MapCollision(testMap());
  col.doorWalkInEnabled = false;
  // Press into the south door mouth (plane at z = -20).
  const out = col.resolvePosition(0, -20 + 0.2);
  assertEquals(out.z >= -20 + 1.0 - 0.01, true);
  assertEquals(out.z <= -20 + 1.0 + 0.05, true);
  // Beside the door (outside half-width) still uses normal radius clamp /
  // perimeter push — not the full 1u standoff.
  const beside = col.resolvePosition(8, -20 + 0.2);
  assertEquals(beside.z < -20 + 1.0 - 0.05, true);
});

Deno.test("resolvePosition blocks walk-out past wall (not door gap)", () => {
  const col = new MapCollision(testMap());
  col.doorWalkInEnabled = true;
  // South edge but outside door half-width (doorHalfWidth 1.5 → |x| > 1.5).
  const out = col.resolvePosition(8, -20 - 0.3);
  // Must stay inside the map (no walk-in pocket). Perimeter half-thick +
  // player radius parks the center around minZ + ~0.57.
  assertEquals(out.z > -20, true);
  assertEquals(out.z < -20 + 1.0, true);
});

Deno.test("homeFromEnemyDoor maps capture offset to own door", () => {
  const col = new MapCollision(testMap());
  // Team A scores at north door (team B). Capture slightly east of center, inside map.
  const captureX = 0.8;
  const captureZ = 20 - 0.5; // maxZ - depth
  const home = col.homeFromEnemyDoor(
    captureX,
    captureZ,
    col.map.teamA,
    col.map.teamB,
  );

  // Same along-door offset (X). Interior capture flips to the home walk-in pocket.
  assertEquals(Math.abs(home.x - captureX) < 0.05, true);
  assertEquals(home.z < -20, true);
  assertEquals(home.z > -20 - DOOR_WALK_IN - 0.05, true);
  // No capture yaw → face into the map from south (yaw ≈ π).
  assertEquals(Math.abs(Math.abs(home.yaw) - Math.PI) < 0.05, true);
  // Landed in own door zone, not enemy.
  assertEquals(col.isInDoorZone(home.x, home.z, col.map.teamA, 1.2), true);
  assertEquals(col.isInDoorZone(home.x, home.z, col.map.teamB, 1.2), false);
});

Deno.test("homeFromEnemyDoor preserves left/right for team B capture", () => {
  const col = new MapCollision(testMap());
  // Team B scores at south door; enter left side inside the post-clear mouth.
  const captureX = -0.8;
  const captureZ = -20 + 0.45;
  const home = col.homeFromEnemyDoor(
    captureX,
    captureZ,
    col.map.teamB,
    col.map.teamA,
  );
  assertEquals(Math.abs(home.x - captureX) < 0.05, true);
  assertEquals(home.z > 20, true); // home walk-in pocket past north bound
  assertEquals(home.z < 20 + DOOR_WALK_IN + 0.05, true);
  // No capture yaw → face into the map from north (yaw ≈ 0).
  assertEquals(Math.abs(home.yaw) < 0.05, true);
});

Deno.test("homeFromEnemyDoor remaps yaw through the portal (opposite doors)", () => {
  const col = new MapCollision(testMap());
  const captureX = 0.4;
  const captureZ = 20 - 0.4;
  // Straight north and a slight left-of-north heading both survive the N→S portal.
  const straight = col.homeFromEnemyDoor(
    captureX,
    captureZ,
    col.map.teamA,
    col.map.teamB,
    Math.PI,
  );
  assertEquals(Math.abs(Math.abs(straight.yaw) - Math.PI) < 0.05, true);

  const angled = Math.PI - 0.3;
  const home = col.homeFromEnemyDoor(
    captureX,
    captureZ,
    col.map.teamA,
    col.map.teamB,
    angled,
  );
  assertEquals(Math.abs(home.yaw - angled) < 0.05, true);
  assertEquals(Math.abs(home.x - captureX) < 0.05, true);
});

Deno.test("homeFromEnemyDoor flips past-plane depth onto own interior", () => {
  const col = new MapCollision(testMap());
  col.doorWalkInEnabled = true;
  // 0.3 past the north plane → 0.3 inside the south door.
  const captureX = 0.2;
  const captureZ = 20 + 0.3;
  const home = col.homeFromEnemyDoor(
    captureX,
    captureZ,
    col.map.teamA,
    col.map.teamB,
    Math.PI,
  );
  assertEquals(Math.abs(home.x - captureX) < 0.05, true);
  assertEquals(Math.abs(home.z - (-20 + 0.3)) < 0.08, true);
  assertEquals(home.z > -20, true);
  assertEquals(Math.abs(Math.abs(home.yaw) - Math.PI) < 0.05, true);
});

Deno.test("ownDoorEntryPose seats just inside the team door facing in", () => {
  const col = new MapCollision(testMap());
  const home = col.ownDoorEntryPose(col.map.teamA);
  assertEquals(home.z > col.map.bounds.minZ, true);
  assertEquals(Math.abs(home.x) < 0.5, true);
  // Facing into the map from the south door ≈ ±π.
  assertEquals(Math.abs(Math.abs(home.yaw) - Math.PI) < 0.05, true);
});

Deno.test("portalFromEnemyDoor keeps along slot and remapped yaw across maps", () => {
  const from = new MapCollision(testMap());
  const to = new MapCollision(testMap());
  const captureX = 0.6;
  const captureZ = 20 + 0.2;
  const captureYaw = Math.PI;
  const home = to.portalFromEnemyDoor(
    {
      map: from.map,
      enemySide: from.map.teamB,
      x: captureX,
      z: captureZ,
      yaw: captureYaw,
    },
    to.map.teamA,
  );
  assertEquals(Math.abs(home.x - captureX) < 1e-6, true);
  assertEquals(home.z > to.map.bounds.minZ, true);
  assertEquals(Math.abs(Math.abs(home.yaw) - Math.PI) < 0.05, true);
});

Deno.test("portalFromEnemyDoor does not clamp along when dest door is narrower", () => {
  const wide = testMap();
  wide.teamB.doorHalfWidth = 3;
  wide.teamA.doorHalfWidth = 3;
  const narrow = testMap();
  narrow.teamA.doorHalfWidth = 1.5;
  narrow.teamB.doorHalfWidth = 1.5;
  const from = new MapCollision(wide);
  const to = new MapCollision(narrow);
  const captureX = 2.2; // past dest half-width 1.5
  const captureZ = 20 + 0.2;
  const home = to.portalFromEnemyDoor(
    {
      map: from.map,
      enemySide: from.map.teamB,
      x: captureX,
      z: captureZ,
      yaw: Math.PI,
    },
    to.map.teamA,
  );
  assertEquals(Math.abs(home.x - captureX) < 1e-6, true);
});
