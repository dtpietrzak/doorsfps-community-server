/**
 * Zombots window rule through Player.update (notes/zombots.md steps 9a and
 * 12c): a plain body meets a zombots window as wall, one with
 * `climbsWindows` jumps through it. The flag rides the zombots state.
 */
import { assertEquals } from "jsr:@std/assert@1";
import type { PlayerInput } from "../protocol/network.ts";
import type { DoorsMap } from "../world/map.ts";
import { MapCollision } from "../world/MapCollision.ts";
import { Player } from "./Player.ts";

function windowMap(zombots: boolean): DoorsMap {
  return {
    name: "zombots-window",
    version: 1,
    bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 },
    gridSize: 1,
    walls: [{ id: "w", a: { x: -5, z: 0 }, b: { x: 5, z: 0 }, kind: "full" }],
    windows: [{ id: "win", wallId: "w", center: { x: 0, z: 0 } }],
    teamA: { corners: [0, 1], edge: "south", doorHalfWidth: 2, spawnRadius: 4 },
    teamB: { corners: [2, 3], edge: "north", doorHalfWidth: 2, spawnRadius: 4 },
    ...(zombots
      ? { mirrorMode: "zombots" as const, spawnCorner: 1 as const }
      : {}),
  };
}

function input(
  sequence: number,
  crouch: boolean,
  jump = true,
): PlayerInput {
  return {
    sequence,
    forward: true,
    backward: false,
    left: false,
    right: false,
    jump,
    sprint: false,
    crouch,
    yaw: 0,
    pitch: 0,
  };
}

/** Two seconds of forward (+ optional jump/crouch) at the window from 1.2 m north of it. */
function run(
  zombots: boolean,
  climbs: boolean,
  crouch: boolean,
  jump = true,
): number {
  const collision = new MapCollision(windowMap(zombots));
  const p = new Player("p", "P", "A", { spawn: { x: 0, z: 1.2, yaw: 0 } });
  p.climbsWindows = climbs;
  let minZ = p.z;
  for (let tick = 1; tick <= 120; tick++) {
    p.queueInput(input(tick, crouch, jump));
    p.update(collision, tick);
    minZ = Math.min(minZ, p.z);
  }
  return minZ;
}

Deno.test("a zombots window stops a plain body and lets a window climber crawl through without jumping or crouching", () => {
  for (const crouch of [false, true]) {
    assertEquals(
      run(true, false, crouch, true) > 0.5,
      true,
      `human crouch=${crouch}`,
    );
  }
  // Plain forward walk (jump=false, crouch=false) triggers hardcoded window crawl.
  assertEquals(run(true, true, false, false) < -1, true);
});

Deno.test("window crawl sets variant (1..3) and progress on snapshots, then returns to normal on the inside", () => {
  const collision = new MapCollision(windowMap(true));
  const p = new Player("z-crawl", "Z", "B", { spawn: { x: 0, z: 1.0, yaw: 0 } });
  p.climbsWindows = true;

  let sawCrawl = false;
  let variant = 0;
  let maxProgress = 0;
  for (let tick = 1; tick <= 120; tick++) {
    p.queueInput(input(tick, false, false));
    p.update(collision, tick);
    if (p.isWindowCrawling()) {
      sawCrawl = true;
      variant = p.windowCrawlVariant();
      maxProgress = Math.max(maxProgress, p.windowCrawlProgress());
      const snap = p.toSnapshot(tick, "motion", null, 0);
      assertEquals(snap.windowCrawlVariant, variant);
      assertEquals(typeof snap.windowCrawlProgress, "number");
    }
  }
  assertEquals(sawCrawl, true);
  assertEquals(variant === 1 || variant === 2 || variant === 3, true);
  assertEquals(maxProgress > 0.8, true);
  // Finished back normal on the inside (other side of the window).
  assertEquals(p.isWindowCrawling(), false);
  assertEquals(p.onGround, true);
  assertEquals(p.crouch, false);
  assertEquals(p.z < -1, true);
  const afterSnap = p.toSnapshot(121, "motion", null, 0);
  assertEquals(afterSnap.windowCrawlVariant, undefined);
  assertEquals(afterSnap.windowCrawlProgress, undefined);
});

Deno.test("off zombots the flag changes nothing", () => {
  for (const crouch of [false, true]) {
    assertEquals(run(false, true, crouch), run(false, false, crouch));
  }
  // An arena window still takes a crouch jump.
  assertEquals(run(false, false, true) < -1, true);
});

Deno.test("climbsWindows round-trips through the zombots state", () => {
  const p = new Player("p", "P", "A");
  p.climbsWindows = true;
  const saved = p.zombotsState();
  const q = new Player("q", "Q", "A");
  q.restoreZombotsState(saved);
  assertEquals(q.climbsWindows, true);
});
