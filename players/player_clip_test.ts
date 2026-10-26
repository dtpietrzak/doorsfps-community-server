/**
 * Player–player body clip + interior oof.
 * Run: deno test -A server-community/players/player_clip_test.ts
 */
import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import { PlayerManager } from "./PlayerManager.ts";
import {
  SPAWN_INVULN_TICKS,
  TICK_HZ,
  WALK_SPEED,
} from "../protocol/network.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";
import { PLAYER_CLIP_RADIUS } from "../shared/sim/playerClip.ts";

const MIN_SEP = 2 * PLAYER_CLIP_RADIUS;

const openMap: DoorsMap = {
  name: "clip-open",
  version: 1,
  bounds: { minX: -50, maxX: 50, minZ: -50, maxZ: 50 },
  gridSize: 1,
  walls: [],
  teamA: { corners: [0, 1], edge: "south", doorHalfWidth: 2, spawnRadius: 4 },
  teamB: { corners: [2, 3], edge: "north", doorHalfWidth: 2, spawnRadius: 4 },
};

/** Narrow corridor: map resolve cannot finish a 2r X push, so overlap oofs. */
const corridorMap: DoorsMap = {
  ...openMap,
  name: "clip-corridor",
  walls: [
    { id: "left", a: { x: -0.8, z: -4 }, b: { x: -0.8, z: 4 } },
    { id: "right", a: { x: 0.8, z: -4 }, b: { x: 0.8, z: 4 } },
  ],
};

function place(
  p: { x: number; y: number; z: number; yaw: number; spawnedAtTick: number },
  x: number,
  z: number,
  yaw = 0,
): void {
  p.x = x;
  p.y = 1.7;
  p.z = z;
  p.yaw = yaw;
  p.spawnedAtTick = 0;
}

function runCoincidentOrder(order: readonly string[]) {
  const pm = new PlayerManager(new MapCollision(openMap));
  for (const id of order) pm.add(id, id.toUpperCase(), "A");
  const a = pm.get("a");
  const b = pm.get("b");
  if (!a || !b) throw new Error("test players were not added");
  place(a, 0, 0);
  place(b, 0, 0);
  const obstacleOrder = pm.clipObstaclesExcept("mover").map((p) => p.id);
  pm.update(1);
  return {
    obstacleOrder,
    a: { x: a.x, z: a.z },
    b: { x: b.x, z: b.z },
  };
}

Deno.test("walker stops at teammate hitbox and does not shove them", () => {
  const pm = new PlayerManager(new MapCollision(openMap));
  const a = pm.add("a", "Walker", "A");
  const b = pm.add("b", "Blocker", "A");
  place(a, 0, 2);
  place(b, 0, 0);
  a.queueInput({
    sequence: 1,
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

  const ticks = Math.ceil((2.5 / WALK_SPEED) * TICK_HZ) + 4;
  for (let t = 1; t <= ticks; t++) pm.update(t);

  assertEquals(a.alive, true);
  assertEquals(b.alive, true);
  assertEquals(a.z >= MIN_SEP - 0.02, true);
  assertEquals(a.z < 1.2, true);
  assertAlmostEquals(b.x, 0, 1e-6);
  assertAlmostEquals(b.z, 0, 1e-6);
});

Deno.test("dead players are not obstacles", () => {
  const pm = new PlayerManager(new MapCollision(openMap));
  const a = pm.add("a", "Walker", "A");
  const b = pm.add("b", "Corpse", "B");
  place(a, 0, 2);
  place(b, 0, 0);
  b.dieFromOverlap(1, Date.now());
  a.queueInput({
    sequence: 1,
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
  const ticks = Math.ceil((2.5 / WALK_SPEED) * TICK_HZ) + 4;
  for (let t = 2; t <= ticks + 1; t++) pm.update(t);
  assertEquals(a.alive, true);
  assertEquals(a.z < 0.2, true);
});

Deno.test("center inside a body in a tight corridor oofs the mover", () => {
  const pm = new PlayerManager(new MapCollision(corridorMap));
  const a = pm.add("a", "Stuck", "A");
  const b = pm.add("b", "Blocker", "B");
  place(a, 0, 0);
  place(b, 0, 0);
  const deaths = pm.update(SPAWN_INVULN_TICKS + 10);
  assertEquals(a.alive, false);
  assertEquals(a.deaths, 1);
  assertEquals(b.alive, true);
  assertEquals(b.kills, 0);
  assertEquals(deaths.length, 1);
  assertEquals(deaths[0]?.victimId, "a");
  assertEquals(deaths[0]?.killerId, "a");
});

Deno.test("spawn-protected player still oofs when stuck inside", () => {
  const pm = new PlayerManager(new MapCollision(corridorMap));
  const a = pm.add("a", "Fresh", "A");
  const b = pm.add("b", "Blocker", "B");
  place(a, 0, 0);
  place(b, 0, 0);
  a.spawnedAtTick = 100;
  assertEquals(a.isSpawnProtected(100), true);
  pm.update(100);
  assertEquals(a.alive, false);
  assertEquals(a.deaths, 1);
});

Deno.test("nearby spawn stacks clip apart instead of oofing", () => {
  const pm = new PlayerManager(new MapCollision(openMap));
  const a = pm.add("a", "A", "A");
  const b = pm.add("b", "B", "A");
  place(a, 0, 0);
  place(b, 0, 0);
  pm.update(1);
  assertEquals(a.alive, true);
  assertEquals(b.alive, true);
  const sep = Math.hypot(a.x - b.x, a.z - b.z);
  assertEquals(sep >= MIN_SEP - 1e-6, true);
});

Deno.test("simulation and clipping are join-order independent (ascending id)", () => {
  const ab = runCoincidentOrder(["a", "b"]);
  const abAgain = runCoincidentOrder(["a", "b"]);
  const ba = runCoincidentOrder(["b", "a"]);

  // Obstacle / update order is ascending id, not Map insertion order.
  assertEquals(ab.obstacleOrder, ["a", "b"]);
  assertEquals(ba.obstacleOrder, ["a", "b"]);
  assertEquals(ab, abAgain);
  assertEquals(ab, ba);

  // First mover is always lower id "a"; coincident resolve is join-invariant.
  assertEquals(ab.a.x, MIN_SEP);
  assertEquals(ab.b.x, 0);
  assertEquals(ba.a.x, MIN_SEP);
  assertEquals(ba.b.x, 0);
});

Deno.test("teleport blink stops short of another player's body", () => {
  const pm = new PlayerManager(new MapCollision(openMap));
  const a = pm.add("a", "Blinker", "A");
  const b = pm.add("b", "Wall", "B");
  place(a, 0, 0);
  place(b, 0, -2);
  a.restoreAbilityCharges();
  assertEquals(pm.handleAbility("a", "teleport", 1), true);
  assertEquals(a.z > -2 + PLAYER_CLIP_RADIUS, true);
  assertEquals(a.z < -0.4, true);
  assertEquals(a.alive, true);
  assertEquals(b.alive, true);
});
