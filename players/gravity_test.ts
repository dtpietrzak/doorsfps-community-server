/**
 * Fixed-tick dead-body gravity regression.
 * Run: deno test -A server-community/players/gravity_test.ts
 */

import { assertEquals } from "jsr:@std/assert@1";
import { DT } from "../protocol/network.ts";
import { MOVE_GRAVITY } from "../shared/sim/moveStep.ts";
import { Player, PLAYER_HEIGHT } from "./Player.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";

const miniMap: DoorsMap = {
  name: "gravity-test",
  version: 1,
  bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 },
  gridSize: 1,
  walls: [],
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

Deno.test("dead-body gravity uses the shared fixed step", () => {
  const player = new Player("dead", "Dead", "A");
  const collision = new MapCollision(miniMap);
  player.alive = false;
  player.y = PLAYER_HEIGHT + 1;
  player.velocityY = 0;

  player.update(collision, 1);

  assertEquals(player.velocityY, -MOVE_GRAVITY * DT);
  assertEquals(player.y, PLAYER_HEIGHT + 1 - MOVE_GRAVITY * DT * DT);
});

Deno.test("dead-body gravity settles at the shared player height", () => {
  const player = new Player("dead", "Dead", "A");
  const collision = new MapCollision(miniMap);
  player.alive = false;
  player.y = PLAYER_HEIGHT + 1;
  player.velocityY = 0;

  for (let tick = 1; tick <= 120; tick += 1) {
    player.update(collision, tick);
  }

  assertEquals(player.y, PLAYER_HEIGHT);
  assertEquals(player.velocityY, 0);
  assertEquals(player.onGround, true);
});
