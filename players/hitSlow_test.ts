import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import {
  HIT_SLOW_DURATION_TICKS,
  TICK_HZ,
  WALK_SPEED,
} from "../protocol/network.ts";
import type { DoorsMap } from "../world/map.ts";
import { MapCollision } from "../world/MapCollision.ts";
import { Player } from "./Player.ts";

const map: DoorsMap = {
  name: "hit-slow-test",
  version: 1,
  bounds: { minX: -50, maxX: 50, minZ: -50, maxZ: 50 },
  gridSize: 1,
  walls: [],
  teamA: { corners: [0, 1], edge: "south", doorHalfWidth: 2, spawnRadius: 4 },
  teamB: { corners: [2, 3], edge: "north", doorHalfWidth: 2, spawnRadius: 4 },
};

function makePlayer(): Player {
  return new Player("slow", "Slow Tester", "A", {
    spawn: { x: 0, z: 0, yaw: Math.PI },
  });
}

Deno.test("bullet-hit slow stacks, caps, refreshes, and expires", () => {
  const p = makePlayer();
  const firstTick = 100;
  p.applyBulletHitSlow(firstTick);
  assertEquals(p.activeHitSlowStacks(firstTick), 1);

  const secondTick = firstTick + HIT_SLOW_DURATION_TICKS - 1;
  p.applyBulletHitSlow(secondTick);
  p.applyBulletHitSlow(secondTick + 1);
  p.applyBulletHitSlow(secondTick + 2);
  assertEquals(p.activeHitSlowStacks(secondTick + 2), 3);

  const refreshedEnd = secondTick + 2 + HIT_SLOW_DURATION_TICKS;
  assertEquals(p.activeHitSlowStacks(refreshedEnd - 1), 3);
  assertEquals(p.activeHitSlowStacks(refreshedEnd), 0);

  p.applyBulletHitSlow(refreshedEnd);
  assertEquals(p.activeHitSlowStacks(refreshedEnd), 1);
  assertEquals(p.toSnapshot(refreshedEnd).hitSlowStacks, 1);
  assertEquals(
    p.toSnapshot(refreshedEnd).hitSlowEndsAtTick,
    refreshedEnd + HIT_SLOW_DURATION_TICKS,
  );
});

Deno.test("bullet-hit slow reduces authoritative horizontal movement", () => {
  const p = makePlayer();
  const tick = 100;
  p.applyBulletHitSlow(tick);
  p.queueInput({
    sequence: 1,
    forward: true,
    backward: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
    crouch: false,
    yaw: Math.PI,
    pitch: 0,
  });

  p.update(new MapCollision(map), tick);
  assertAlmostEquals(p.z, WALK_SPEED * 0.95 / TICK_HZ, 1e-9);
});

Deno.test("spawn clears bullet-hit slow", () => {
  const p = makePlayer();
  p.applyBulletHitSlow(100);
  p.respawn({ x: 1, z: 2, yaw: 0 }, 101);
  assertEquals(p.activeHitSlowStacks(101), 0);
  assertEquals(p.toSnapshot(101).hitSlowStacks, undefined);
});

Deno.test("door return preserves bullet-hit slow until its timer expires", () => {
  const p = makePlayer();
  p.applyBulletHitSlow(100);
  p.sendHomeAfterScore({ x: 4, z: 5, yaw: 0 }, 101);
  assertEquals(p.activeHitSlowStacks(101), 1);
});
