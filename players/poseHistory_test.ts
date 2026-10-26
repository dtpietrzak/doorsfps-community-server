import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import { Player } from "./Player.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";

/** Minimal empty-ish map for pose-only tests. */
function emptyMap(): DoorsMap {
  return {
    version: 1,
    name: "pose-test",
    bounds: { minX: -50, maxX: 50, minZ: -50, maxZ: 50 },
    gridSize: 1,
    teamA: {
      corners: [0, 1],
      edge: "south",
      doorHalfWidth: 2,
      spawnRadius: 4,
    },
    teamB: {
      corners: [2, 3],
      edge: "north",
      doorHalfWidth: 2,
      spawnRadius: 4,
    },
    walls: [],
  };
}

Deno.test("poseAt interpolates between recorded samples", () => {
  const p = new Player("p1", "Alice", "A", {
    spawn: { x: 0, y: 1.7, z: 0 },
  });
  p.x = 0;
  p.z = 0;
  p.recordPose(10);
  p.x = 10;
  p.z = 0;
  p.recordPose(20);

  const mid = p.poseAt(15);
  assertAlmostEquals(mid.x, 5, 1e-9);
  assertAlmostEquals(mid.z, 0, 1e-9);
});

Deno.test("poseAt clamps to oldest and newest samples", () => {
  const p = new Player("p1", "Alice", "A", {
    spawn: { x: 1, y: 1.7, z: 2 },
  });
  p.x = 1;
  p.z = 2;
  p.recordPose(5);
  p.x = 3;
  p.z = 4;
  p.recordPose(8);

  const before = p.poseAt(0);
  assertEquals(before.x, 1);
  assertEquals(before.z, 2);

  const after = p.poseAt(100);
  assertEquals(after.x, 3);
  assertEquals(after.z, 4);
});

Deno.test("pose ring retains recent history after many ticks", () => {
  const collision = new MapCollision(emptyMap());
  const p = new Player("p1", "Alice", "A", {
    spawn: { x: 0, y: 1.7, z: 0 },
  });

  // Advance many fixed ticks with slight movement via update path.
  for (let tick = 1; tick <= 120; tick++) {
    p.queueInput({
      sequence: tick,
      forward: true,
      backward: false,
      left: false,
      right: false,
      jump: false,
      sprint: false,
      crouch: false,
      yaw: 0,
      pitch: 0,
    });
    p.update(collision, tick);
  }

  // Newest pose is current.
  const now = p.poseAt(120);
  assertAlmostEquals(now.x, p.x, 1e-6);
  assertAlmostEquals(now.z, p.z, 1e-6);

  // A sample ~200ms back (~12 ticks) still interpolates (within pose window).
  const past = p.poseAt(108);
  assertEquals(Number.isFinite(past.x), true);
  assertEquals(Number.isFinite(past.z), true);
  // Should differ from current after walking for 12 ticks.
  assertEquals(Math.hypot(past.x - p.x, past.z - p.z) > 0.01, true);
});

Deno.test("pose ring retains ~1s history for Rewind skill", () => {
  const collision = new MapCollision(emptyMap());
  const p = new Player("p1", "Alice", "A", {
    spawn: { x: 0, y: 1.7, z: 0 },
  });

  const totalTicks = 90; // 1.5s at 60 Hz
  for (let tick = 1; tick <= totalTicks; tick++) {
    p.queueInput({
      sequence: tick,
      forward: true,
      backward: false,
      left: false,
      right: false,
      jump: false,
      sprint: false,
      crouch: false,
      yaw: 0,
      pitch: 0,
    });
    p.update(collision, tick);
  }

  // Sample 1s back should differ from current (outside old 350ms window).
  const past = p.poseAt(totalTicks - 60);
  assertEquals(Math.hypot(past.x - p.x, past.z - p.z) > 0.5, true);
});

Deno.test("poseAt interpolates yaw and pitch for head-hit rewind", () => {
  const p = new Player("p1", "Alice", "A", {
    spawn: { x: 0, y: 1.7, z: 0 },
  });
  p.yaw = 0;
  p.pitch = 0;
  p.recordPose(10);
  p.yaw = Math.PI;
  p.pitch = -0.4;
  p.recordPose(20);

  const mid = p.poseAt(15);
  assertAlmostEquals(mid.yaw, Math.PI / 2, 1e-9);
  assertAlmostEquals(mid.pitch, -0.2, 1e-9);
});

Deno.test("respawn clears pose history", () => {
  const p = new Player("p1", "Alice", "A", {
    spawn: { x: 0, y: 1.7, z: 0 },
  });
  p.x = 5;
  p.recordPose(1);
  p.x = 9;
  p.recordPose(2);
  p.respawn({ x: 0, y: 1.7, z: 0 }, 50);
  const old = p.poseAt(1);
  // After clear+record at respawn, only tick 50 sample exists.
  assertEquals(old.x, p.x);
  assertEquals(old.z, p.z);
});
