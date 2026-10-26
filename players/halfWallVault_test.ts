import { assertEquals } from "jsr:@std/assert@1";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";
import { Player } from "./Player.ts";

function halfWallMap(): DoorsMap {
  return {
    version: 1,
    name: "HalfWallVault",
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

/**
 * Human jump + hold crouch the whole time (including mid-air).
 * Must still clear half-walls — airborne crouch must not half horizontal speed.
 */
Deno.test("human crouch-jump clears half wall while holding crouch", () => {
  const col = new MapCollision(halfWallMap());
  const p = new Player("h", "Human", "A", {
    spawn: { x: 0, z: -2.5, yaw: Math.PI },
  });
  p.spawnedAtTick = 0;
  // Jump costs stamina; keep a full bar so vault path is not gated by energy.

  let crossed = false;
  for (let tick = 0; tick < 200; tick++) {
    const shouldJump = p.onGround && p.z > -1.8 && p.z < -0.2;
    p.queueInput({
      sequence: tick + 1,
      forward: true,
      backward: false,
      left: false,
      right: false,
      jump: shouldJump,
      sprint: false,
      crouch: true,
      yaw: Math.PI,
      pitch: 0,
    });
    p.update(col, tick);
    if (p.z > 1.0) {
      crossed = true;
      break;
    }
  }
  assertEquals(crossed, true);
  assertEquals(p.crouch, true);
});

/** Stand-jump then duck mid-air — still clears. */
Deno.test("human jump then crouch mid-air clears half wall", () => {
  const col = new MapCollision(halfWallMap());
  const p = new Player("h", "Human", "A", {
    spawn: { x: 0, z: -2.5, yaw: Math.PI },
  });
  p.spawnedAtTick = 0;
  // Jump costs stamina; keep a full bar so vault path is not gated by energy.

  let crossed = false;
  let wasAirborne = false;
  for (let tick = 0; tick < 200; tick++) {
    const shouldJump = p.onGround && p.z > -1.8 && p.z < -0.2;
    if (!p.onGround) wasAirborne = true;
    p.queueInput({
      sequence: tick + 1,
      forward: true,
      backward: false,
      left: false,
      right: false,
      jump: shouldJump,
      sprint: false,
      // Duck only once airborne (classic crouch mid-jump).
      crouch: wasAirborne || !p.onGround,
      yaw: Math.PI,
      pitch: 0,
    });
    p.update(col, tick);
    if (p.z > 1.0) {
      crossed = true;
      break;
    }
  }
  assertEquals(crossed, true);
});

function openMap(): DoorsMap {
  return {
    version: 1,
    name: "OpenSlide",
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

/** Slide needs real energy — no free slide grant (bots included). */
Deno.test("human crouch while moving does not slide at 0 stamina", () => {
  const col = new MapCollision(openMap());
  const human = new Player("h", "Human", "A", {
    spawn: { x: 0, z: 0, yaw: 0 },
  });
  human.spawnedAtTick = 0;
  human.onGround = true;
  human.sprintStamina = 0;
  human.crouch = false;

  human.queueInput({
    sequence: 1,
    forward: true,
    backward: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
    crouch: true,
    yaw: 0,
    pitch: 0,
  });
  human.update(col, 1);

  assertEquals(human.isSliding(), false);
  assertEquals(human.crouch, true);
});
