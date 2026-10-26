/**
 * Player.update integration contract for deterministic movement.
 * Run: deno test -A server-community/players/deterministic_player_simulation_test.ts
 */

import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import { DT, type PlayerInput, TICK_HZ } from "../protocol/network.ts";
import type { DoorsMap, Wall } from "../world/map.ts";
import { MapCollision } from "../world/MapCollision.ts";
import { MOVE_CROUCH_EYE } from "../shared/sim/moveStep.ts";
import { Player, PLAYER_HEIGHT } from "./Player.ts";

function mapWithWalls(walls: Wall[] = []): DoorsMap {
  return {
    name: "deterministic-pawn-movement",
    version: 1,
    bounds: { minX: -30, maxX: 30, minZ: -30, maxZ: 30 },
    gridSize: 1,
    walls,
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
  };
}

function input(
  sequence: number,
  overrides: Partial<PlayerInput> = {},
): PlayerInput {
  return {
    sequence,
    forward: false,
    backward: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
    crouch: false,
    yaw: Math.PI,
    pitch: 0,
    ...overrides,
  };
}

function simState(p: Player) {
  return {
    x: p.x,
    y: p.y,
    z: p.z,
    yaw: p.yaw,
    pitch: p.pitch,
    velocityX: p.velocityX,
    velocityY: p.velocityY,
    velocityZ: p.velocityZ,
    onGround: p.onGround,
    crouch: p.crouch,
    sprintStamina: p.sprintStamina,
    slideRemaining: p.slideRemaining,
    slideDirX: p.slideDirX,
    slideDirZ: p.slideDirZ,
    slideForceCrouch: p.slideForceCrouch,
    health: p.health,
    alive: p.alive,
    spawnedAtTick: p.spawnedAtTick,
    diedAtTick: p.diedAtTick,
    connectionIssue: p.connectionIssue,
    lastSequence: p.lastSequence,
    lastShotAtTick: p.lastShotAtTick,
    lastMeleeAtTick: p.lastMeleeAtTick,
    weaponId: p.weaponId,
    reloadEndsAtTick: p.reloadEndsAtTick,
    weaponSwitchEndsAtTick: p.weaponSwitchEndsAtTick,
    abilityEndsAtTick: { ...p.abilityEndsAtTick },
    abilityGlobalLockEndsAtTick: p.abilityGlobalLockEndsAtTick,
    abilityBarRegenEndsAtTick: p.abilityBarRegenEndsAtTick,
    abilityDoorRegenEndsAtTick: p.abilityDoorRegenEndsAtTick,
  };
}

function runScript() {
  const p = new Player("scripted", "Scripted", "A", {
    spawn: { x: -2, z: -4, yaw: Math.PI },
  });
  const collision = new MapCollision(mapWithWalls());
  const moved: boolean[] = [];

  for (let tick = 1; tick <= TICK_HZ * 2; tick += 1) {
    // Tick one deliberately exercises the no-input path.
    if (tick > 1) {
      const turning = tick >= 35 && tick < 60;
      const crouching = tick >= 65 && tick < 90;
      p.queueInput(
        input(tick, {
          forward: tick < 105,
          left: turning,
          right: !turning && tick >= 105,
          jump: tick === 20,
          sprint: tick < 16,
          crouch: crouching,
          yaw: turning ? Math.PI / 2 : Math.PI,
          pitch: (tick % 7) * 0.01,
        }),
      );
    }
    moved.push(p.update(collision, tick));
  }

  return { state: simState(p), moved };
}

Deno.test("Player.update scripted inputs are bit-identical across runs", () => {
  assertEquals(runScript(), runScript());
});

Deno.test("Player.update applies direct look and derives horizontal velocity", () => {
  const p = new Player("look", "Look", "A");
  const collision = new MapCollision(mapWithWalls());

  p.queueInput(input(1, { forward: true, yaw: 0 }));
  p.update(collision, 1);
  const beforeX = p.x;
  const beforeZ = p.z;

  p.queueInput(input(2, { forward: true, yaw: Math.PI }));
  p.update(collision, 2);

  assertEquals(p.yaw, Math.PI);
  assertEquals(p.pitch, 0);
  assertEquals(p.z > beforeZ, true);
  assertEquals(p.velocityX, (p.x - beforeX) / DT);
  assertEquals(p.velocityZ, (p.z - beforeZ) / DT);
});

Deno.test("Player.update keeps crouch under a floating wall", () => {
  const collision = new MapCollision(
    mapWithWalls([{
      id: "low-ceiling",
      kind: "float",
      a: { x: -3, z: 0 },
      b: { x: 3, z: 0 },
    }]),
  );
  const p = new Player("tunnel", "Tunnel", "A", {
    spawn: { x: 0, z: 0, yaw: Math.PI },
  });
  p.crouch = true;
  p.y = MOVE_CROUCH_EYE;
  p.onGround = true;

  p.queueInput(input(1, { crouch: false }));
  p.update(collision, 1);

  assertEquals(p.crouch, true);
  assertAlmostEquals(p.y, MOVE_CROUCH_EYE, 1e-9);
});

Deno.test("Player.update connection issue is a deterministic sitting duck", () => {
  const p = new Player("connection", "Connection", "A");
  const collision = new MapCollision(mapWithWalls());
  p.queueInput(input(1, { forward: true }));
  p.update(collision, 1);
  const before = { x: p.x, y: p.y, z: p.z };

  p.markConnectionIssue(1_000);
  p.queueInput(input(2, { forward: true, yaw: 0 }));
  assertEquals(p.update(collision, 2), false);

  assertEquals({ x: p.x, y: p.y, z: p.z }, before);
  assertEquals(p.velocityX, 0);
  assertEquals(p.velocityZ, 0);
});

Deno.test("Player.update dead body falls and rests at PLAYER_HEIGHT", () => {
  const p = new Player("corpse", "Corpse", "A");
  const collision = new MapCollision(mapWithWalls());
  p.alive = false;
  p.y = PLAYER_HEIGHT + 1;
  p.velocityY = 0;

  for (let tick = 1; tick <= TICK_HZ * 2; tick += 1) {
    p.update(collision, tick);
  }

  assertEquals(p.y, PLAYER_HEIGHT);
  assertEquals(p.velocityY, 0);
  assertEquals(p.onGround, true);
});
