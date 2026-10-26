import { assertEquals } from "jsr:@std/assert";
import { PlayerManager } from "./PlayerManager.ts";
import { CONNECTION_ISSUE_TIMEOUT_MS } from "../protocol/network.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";

const miniMap: DoorsMap = {
  name: "test",
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

function makeManager(): PlayerManager {
  return new PlayerManager(new MapCollision(miniMap));
}

Deno.test("connection issue: mark, reclaim, keep id and damage", () => {
  const pm = makeManager();
  const p = pm.add("sock-1", "Alice");
  p.health = 40;
  p.x = 3;
  p.z = 4;

  assertEquals(pm.markConnectionIssue(p.id, 1000), true);
  assertEquals(p.connectionIssue, true);
  assertEquals(p.socketId, null);
  assertEquals(pm.getBySocket("sock-1"), undefined);
  assertEquals(pm.findReclaimableByName("alice")?.id, p.id);

  // Name is reserved for reclaim, not free for a new join.
  assertEquals(pm.isNameTaken("Alice"), true);

  const restored = pm.restoreConnection(p.id, "sock-2", 10);
  assertEquals(restored?.respawned, false);
  assertEquals(restored?.player.id, "sock-1");
  assertEquals(restored?.player.health, 40);
  assertEquals(restored?.player.x, 3);
  assertEquals(restored?.player.connectionIssue, false);
  assertEquals(pm.getBySocket("sock-2")?.id, "sock-1");
});

Deno.test("connection issue: dead player respawns on reclaim", () => {
  const pm = makeManager();
  const p = pm.add("sock-1", "Bob");
  // Past spawn protection so damage can kill.
  const killTick = 120;
  assertEquals(p.takeDamage(200, "body", killTick, Date.now()), true);
  assertEquals(p.alive, false);

  pm.markConnectionIssue(p.id, 1000);
  // Auto-respawn held while connection-issue (even after the normal delay).
  assertEquals(p.shouldRespawn(killTick + 10_000), false);

  const restored = pm.restoreConnection(p.id, "sock-2", killTick + 10);
  assertEquals(restored?.respawned, true);
  assertEquals(restored?.player.alive, true);
  assertEquals(restored?.player.health, 100);
});

Deno.test("connection issue: timeout drops the player", () => {
  const pm = makeManager();
  const p = pm.add("sock-1", "Cara");
  const now = 5_000;
  pm.markConnectionIssue(p.id, now);

  assertEquals(pm.processConnectionIssueTimeouts(now + 1).length, 0);
  assertEquals(pm.size, 1);

  const dropped = pm.processConnectionIssueTimeouts(
    now + CONNECTION_ISSUE_TIMEOUT_MS,
  );
  assertEquals(dropped, [p.id]);
  assertEquals(pm.size, 0);
  assertEquals(pm.findReclaimableByName("Cara"), undefined);
});

Deno.test("session conflict: same guest name (live or grace)", () => {
  const pm = makeManager();
  const p = pm.add("sock-1", "Dana");
  assertEquals(pm.findSessionConflict("dana")?.id, p.id);
  assertEquals(pm.findSessionConflict("Dana")?.id, p.id);

  pm.markConnectionIssue(p.id, 1000);
  assertEquals(pm.findSessionConflict("Dana")?.id, p.id);
});

Deno.test("session conflict: prefers account id over name", () => {
  const pm = makeManager();
  const a = pm.add("sock-a", "Alice", undefined, { accountUserId: "user_a" });
  pm.add("sock-b", "Bob", undefined, { accountUserId: "user_b" });

  assertEquals(pm.findSessionConflict("Alice", "user_a")?.id, a.id);
  // Same account, even if display name in the join handshake differs.
  assertEquals(pm.findSessionConflict("AliceAlt", "user_a")?.id, a.id);
  // Different account, same display name → not the same user.
  assertEquals(pm.findSessionConflict("Alice", "user_other"), undefined);
  // Guest must not take over an account-held name.
  assertEquals(pm.findSessionConflict("Alice"), undefined);
});

Deno.test("takeOverConnection: live session replace keeps id and pose", () => {
  const pm = makeManager();
  const p = pm.add("sock-1", "Eve", undefined, { accountUserId: "user_e" });
  p.health = 55;
  p.x = 7;
  p.z = -2;
  assertEquals(p.connectionIssue, false);

  const result = pm.takeOverConnection(p.id, "sock-2", 20);
  assertEquals(result?.previousSocketId, "sock-1");
  assertEquals(result?.wasConnectionIssue, false);
  assertEquals(result?.player.id, "sock-1");
  assertEquals(result?.player.health, 55);
  assertEquals(result?.player.x, 7);
  assertEquals(result?.player.socketId, "sock-2");
  assertEquals(pm.getBySocket("sock-1"), undefined);
  assertEquals(pm.getBySocket("sock-2")?.id, "sock-1");
  assertEquals(pm.size, 1);
});

Deno.test("takeOverConnection: connection-issue reclaim still works", () => {
  const pm = makeManager();
  const p = pm.add("sock-1", "Frank");
  p.health = 40;
  pm.markConnectionIssue(p.id, 1000);

  const result = pm.takeOverConnection(p.id, "sock-2", 10);
  assertEquals(result?.previousSocketId, null);
  assertEquals(result?.wasConnectionIssue, true);
  assertEquals(result?.player.connectionIssue, false);
  assertEquals(result?.player.health, 40);
  assertEquals(pm.getBySocket("sock-2")?.id, "sock-1");
});
