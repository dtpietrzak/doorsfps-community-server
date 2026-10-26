/**
 * Epic 4.8 Chunk 4: sim advances on stable player id / isBot / connectionIssue —
 * not transport socketId. Socket rebind or absent socket must not alter outcomes
 * when connectionIssue is unchanged.
 *
 * Run from server-community/:
 *   deno test -A players/sim_identity_isolation_test.ts
 */

import { assertEquals } from "@std/assert";
import type { DoorsMap } from "../world/map.ts";
import { MapCollision } from "../world/MapCollision.ts";
import { Player } from "./Player.ts";
import { PlayerManager } from "./PlayerManager.ts";
import type { PlayerInput } from "../protocol/network.ts";

const map: DoorsMap = {
  name: "sim-identity-isolation",
  version: 1,
  bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 },
  gridSize: 1,
  walls: [],
  teamA: { corners: [0, 1], edge: "south", doorHalfWidth: 2.5, spawnRadius: 3 },
  teamB: { corners: [2, 3], edge: "north", doorHalfWidth: 2.5, spawnRadius: 3 },
};

function moveInput(sequence: number): PlayerInput {
  return {
    sequence,
    forward: true,
    backward: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
    crouch: false,
    yaw: 0,
    pitch: 0,
  };
}

function poseOf(p: Player) {
  return { x: p.x, z: p.z, yaw: p.yaw, seq: p.lastSequence };
}

Deno.test("absent socketId without connectionIssue does not freeze movement", () => {
  const collision = new MapCollision(map);
  const a = new Player("human-a", "A", "A");
  const b = new Player("human-b", "B", "A");
  a.x = 0;
  a.z = 0;
  a.onGround = true;
  b.x = 0;
  b.z = 0;
  b.onGround = true;

  // Simulate transport rebind bookkeeping without raising connectionIssue.
  a.socketId = "sock-1";
  b.socketId = null;
  assertEquals(a.connectionIssue, false);
  assertEquals(b.connectionIssue, false);

  a.queueInput(moveInput(1), 1);
  b.queueInput(moveInput(1), 1);
  a.update(collision, 1);
  b.update(collision, 1);

  assertEquals(poseOf(a), poseOf(b));
  assertEquals(a.lastSequence > 0, true);
});

Deno.test("connectionIssue freezes regardless of socketId presence", () => {
  const collision = new MapCollision(map);
  const frozen = new Player("frozen", "Frozen", "A");
  frozen.x = 0;
  frozen.z = 0;
  frozen.onGround = true;
  frozen.socketId = "still-bound"; // adapter may lag; sim must ignore
  frozen.connectionIssue = true;
  frozen.queueInput(moveInput(1), 1);
  const moved = frozen.update(collision, 1);
  assertEquals(moved, false);
  assertEquals(frozen.x, 0);
  assertEquals(frozen.z, 0);
});

Deno.test("PlayerManager.update does not require getBySocket; roster keys on player.id", () => {
  const pm = new PlayerManager(new MapCollision(map), {
    damageRandom: () => 0.5,
    nowMs: 1_000,
  });
  const human = pm.add("sock-join", "Human", "A", undefined, 1_000);
  const bot = pm.addBot("bot-1", "Bot", { team: "B" });
  const humanId = human.id;

  // Rebind transport handle via adapter API; stable id unchanged.
  const rebound = pm.takeOverConnection(humanId, "sock-rebound", 1, 1_000);
  assertEquals(rebound != null, true);
  assertEquals(human.id, humanId);
  assertEquals(human.socketId, "sock-rebound");
  assertEquals(pm.get(humanId), human);
  assertEquals(pm.getBySocket("sock-rebound"), human);
  assertEquals(pm.getBySocket("sock-join"), undefined);

  human.queueInput(moveInput(1), 1_000);
  bot.queueInput(moveInput(1), 1_000);
  const deaths = pm.update(1, 1_000);
  assertEquals(Array.isArray(deaths), true);
  assertEquals(human.lastSequence > 0, true);
  assertEquals(bot.lastSequence > 0, true);
});

Deno.test("humans() filters isBot, not socketId", () => {
  const pm = new PlayerManager(new MapCollision(map), { nowMs: 1_000 });
  const human = pm.add("sock-h", "H", "A", undefined, 1_000);
  pm.addBot("bot-h", "B", { team: "B" });
  human.socketId = null;
  const humans = pm.humans();
  assertEquals(humans.length, 1);
  assertEquals(humans[0]!.id, human.id);
  assertEquals(humans[0]!.isBot, false);
});
