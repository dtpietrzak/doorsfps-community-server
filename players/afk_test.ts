/**
 * AFK detection: look activity, freeze while dead, 10s timeout, 60s kick.
 * Intermission suspends hard-kick countdown on snapshots; new match refreshes activity.
 *   cd server-community && deno test -A players/afk_test.ts
 */

import { assertEquals, assertExists } from "jsr:@std/assert";
import { AFK_KICK_MS, AFK_TIMEOUT_MS } from "../protocol/network.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";
import { Player } from "./Player.ts";
import { PlayerManager } from "./PlayerManager.ts";

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

Deno.test("AFK_TIMEOUT_MS is 10 seconds", () => {
  assertEquals(AFK_TIMEOUT_MS, 10_000);
});

Deno.test("AFK_KICK_MS is 60 seconds", () => {
  assertEquals(AFK_KICK_MS, 60_000);
});

Deno.test("Player: mouse look counts as activity", () => {
  const p = new Player("h1", "Alice", "A");
  const t0 = Date.now() - AFK_TIMEOUT_MS - 5_000;
  p.touchActivity(t0);
  assertEquals(p.isAfk(Date.now()), true);

  p.queueInput({
    sequence: 1,
    forward: false,
    backward: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
    crouch: false,
    yaw: p.yaw + 0.05,
    pitch: p.pitch,
  });
  assertEquals(p.isAfk(Date.now()), false);
});

/** Past spawn invuln so takeDamage can kill. */
const PAST_SPAWN = 10_000;

Deno.test("Player: death freezes non-AFK status (closed-door wait)", () => {
  const p = new Player("h1", "Alice", "A");
  p.touchActivity(Date.now());
  assertEquals(p.isAfk(), false);

  assertEquals(p.takeDamage(999, "body", PAST_SPAWN, Date.now()), true);
  assertEquals(p.alive, false);
  assertEquals(p.afkWhileDead, false);

  // Long after AFK timeout — still not AFK while dead.
  assertEquals(p.isAfk(Date.now() + AFK_TIMEOUT_MS + 60_000), false);
});

Deno.test("Player: death freezes AFK status when already AFK", () => {
  const p = new Player("h1", "Bob", "B");
  p.touchActivity(Date.now() - AFK_TIMEOUT_MS - 1_000);
  assertEquals(p.isAfk(), true);

  assertEquals(p.takeDamage(999, "body", PAST_SPAWN, Date.now()), true);
  assertEquals(p.afkWhileDead, true);
  assertEquals(p.isAfk(Date.now() + 60_000), true);
});

Deno.test("Player: look while dead clears frozen AFK", () => {
  const p = new Player("h1", "Carol", "A");
  p.touchActivity(Date.now() - AFK_TIMEOUT_MS - 1_000);
  assertEquals(p.takeDamage(999, "body", PAST_SPAWN, Date.now()), true);
  assertEquals(p.isAfk(), true);

  p.queueInput({
    sequence: 1,
    forward: false,
    backward: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
    crouch: false,
    yaw: p.yaw + 0.1,
    pitch: p.pitch,
  });
  assertEquals(p.afkWhileDead, false);
  assertEquals(p.isAfk(), false);
});

Deno.test("Player: respawn after non-AFK death does not immediately AFK", () => {
  const p = new Player("h1", "Dave", "B");
  p.touchActivity(Date.now());
  assertEquals(p.takeDamage(999, "body", PAST_SPAWN, Date.now()), true);
  // Simulate long wait with doors closed.
  p.lastActivityAtMs = Date.now() - AFK_TIMEOUT_MS - 30_000;
  assertEquals(p.isAfk(), false); // frozen

  p.respawn({ x: 0, z: 0, yaw: 0 }, PAST_SPAWN + 500);
  assertEquals(p.alive, true);
  assertEquals(p.afkWhileDead, null);
  assertEquals(p.isAfk(), false);
});

Deno.test("Player: death path uses explicit time without reading Date.now", () => {
  const p = new Player("clock-free", "ClockFree", "A");
  const originalNow = Date.now;
  let reads = 0;
  Date.now = () => {
    reads += 1;
    throw new Error("death path read Date.now");
  };
  try {
    assertEquals(p.takeDamage(999, "body", PAST_SPAWN, 1_000_000), true);
  } finally {
    Date.now = originalNow;
  }
  assertEquals(reads, 0);
  assertEquals(p.alive, false);
  assertEquals(p.diedAtTick, PAST_SPAWN);
});

Deno.test("Player: AFK kick countdown starts after AFK flag", () => {
  const p = new Player("h1", "Eve", "A");
  const t0 = 1_000_000;
  p.touchActivity(t0);

  // Just before AFK flag: no countdown, no kick.
  assertEquals(p.isAfk(t0 + AFK_TIMEOUT_MS - 1), false);
  assertEquals(p.afkKickInSeconds(t0 + AFK_TIMEOUT_MS - 1), undefined);
  assertEquals(p.shouldKickForAfk(t0 + AFK_TIMEOUT_MS - 1), false);

  // Flag just started: full 60s remaining.
  assertEquals(p.isAfk(t0 + AFK_TIMEOUT_MS), true);
  assertEquals(p.afkKickInSeconds(t0 + AFK_TIMEOUT_MS), 60);
  assertEquals(p.shouldKickForAfk(t0 + AFK_TIMEOUT_MS), false);

  // Halfway through kick window.
  const mid = t0 + AFK_TIMEOUT_MS + 30_000;
  assertEquals(p.afkKickInSeconds(mid), 30);
  assertEquals(p.shouldKickForAfk(mid), false);

  // Kick due at AFK_TIMEOUT + AFK_KICK.
  const kickAt = t0 + AFK_TIMEOUT_MS + AFK_KICK_MS;
  assertEquals(p.shouldKickForAfk(kickAt), true);
  assertEquals(p.afkKickInSeconds(kickAt), 0);
});

Deno.test("Player: activity clears AFK kick countdown", () => {
  const p = new Player("h1", "Frank", "B");
  const t0 = 2_000_000;
  p.touchActivity(t0);
  assertEquals(p.isAfk(t0 + AFK_TIMEOUT_MS + 5_000), true);
  assertEquals(
    typeof p.afkKickInSeconds(t0 + AFK_TIMEOUT_MS + 5_000),
    "number",
  );

  p.touchActivity(t0 + AFK_TIMEOUT_MS + 5_000);
  assertEquals(p.isAfk(t0 + AFK_TIMEOUT_MS + 5_000), false);
  assertEquals(p.afkKickInSeconds(t0 + AFK_TIMEOUT_MS + 5_000), undefined);
  assertEquals(p.shouldKickForAfk(t0 + AFK_TIMEOUT_MS + AFK_KICK_MS), false);
});

Deno.test("Player: bots never AFK-kick", () => {
  const p = new Player("b1", "Bot", "A", { isBot: true });
  p.touchActivity(Date.now() - AFK_TIMEOUT_MS - AFK_KICK_MS - 1_000);
  assertEquals(p.isAfk(), true);
  assertEquals(p.shouldKickForAfk(), false);
});

Deno.test("intermission: snapshot omits afkKickIn (no endgame kick countdown)", () => {
  const pm = new PlayerManager(new MapCollision(miniMap));
  // Open servers start live; force a human into AFK then end the match.
  const p = pm.add("h1", "Idle");
  p.touchActivity(Date.now() - AFK_TIMEOUT_MS - 15_000);
  assertEquals(p.isAfk(), true);
  assertEquals(typeof p.afkKickInSeconds(), "number");

  assertExists(pm.forceDraw(100));
  assertEquals(pm.getMatchPhase(), "intermission");

  const snap = pm.createSnapshot(100, "full");
  const me = snap.players.find((s) => s.id === "h1");
  assertExists(me);
  assertEquals(me.afk, true);
  assertEquals(me.afkKickIn, undefined);
});

Deno.test("new match: sitting through intermission does not carry AFK kick debt", () => {
  const pm = new PlayerManager(new MapCollision(miniMap));
  const p = pm.add("h1", "Idle");
  // Already past full AFK kick threshold before match ends.
  p.touchActivity(Date.now() - AFK_TIMEOUT_MS - AFK_KICK_MS - 5_000);
  assertEquals(p.shouldKickForAfk(), true);

  assertExists(pm.forceDraw(50));
  // Still kickable on the player object — GameServer skips kick during intermission.
  assertEquals(p.shouldKickForAfk(), true);

  pm.startNewMatch(200);
  // Fresh activity so next match is not an instant hard-kick.
  assertEquals(p.isAfk(), false);
  assertEquals(p.shouldKickForAfk(), false);
});
