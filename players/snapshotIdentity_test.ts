import { assertEquals, assertExists } from "jsr:@std/assert";
import { decodeGamePacket, encodeGamePacket } from "../shared/net/codec.ts";
import { PlayerManager } from "./PlayerManager.ts";
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

Deno.test("createSnapshot includes authoritative XYZ velocity", () => {
  const pm = makeManager();
  const p = pm.add("s1", "Alice", "A");
  p.velocityX = -4.321;
  p.velocityY = 2.346;
  p.velocityZ = 8.764;

  const motion = pm.createSnapshot(60, "motion").players[0]!;
  assertEquals(motion.velocityX, -4.32);
  assertEquals(motion.velocityY, 2.35);
  assertEquals(motion.velocityZ, 8.76);

  const full = pm.createSnapshot(60, "full").players[0]!;
  assertEquals(full.velocityX, -4.321);
  assertEquals(full.velocityY, 2.346);
  assertEquals(full.velocityZ, 8.764);
});

Deno.test("createSnapshot motion omits name and cosmetics", () => {
  const pm = makeManager();
  const p = pm.add("s1", "Alice", "A", {
    equipment: {
      head: 2,
      visor: 1,
      shoulder: 3,
      body: 1,
      leg: 2,
      hue: 0.25,
      gunHue: -0.5,
      bulletHue: 0,
      crosshairColor: -1,
      nameHue: 0,
      pistol: 0,
      rifle: 0,
      shotgun: 0,
      scope: 0,
      crosshair: 3,
    },
  });
  p.score = 3;
  p.kills = 1;
  p.deaths = 2;

  const snap = pm.createSnapshot(60, "motion");
  assertEquals(snap.players.length, 1);
  const row = snap.players[0]!;
  assertEquals(row.id, "s1");
  assertEquals(row.name, undefined);
  assertEquals(row.head, undefined);
  assertEquals(row.visor, undefined);
  assertEquals(row.shoulder, undefined);
  assertEquals(row.body, undefined);
  assertEquals(row.leg, undefined);
  assertEquals(row.hue, undefined);
  assertEquals(row.gunHue, undefined);
  assertEquals(row.scope, undefined);
  assertEquals(row.score, undefined);
  assertEquals(row.kills, undefined);
  assertEquals(row.deaths, undefined);
  assertEquals(row.xp, undefined);
  assertEquals(row.mmsRankId, undefined);
  assertEquals(row.founderBadge, undefined);
});

Deno.test("createSnapshot full includes name, cosmetics, scoreboard", () => {
  const pm = makeManager();
  const p = pm.add("s1", "Alice", "A", {
    xp: 1234,
    mmsRankId: "vanguard",
    founderBadge: true,
    equipment: {
      head: 2,
      visor: 1,
      shoulder: 3,
      body: 1,
      leg: 2,
      hue: 0.5,
      gunHue: -1,
      bulletHue: 0,
      crosshairColor: -1,
      nameHue: 0,
      pistol: 1,
      rifle: 2,
      shotgun: 0,
      scope: 3,
      crosshair: 4,
    },
  });
  p.score = 3;
  p.kills = 1;
  p.deaths = 2;

  const snap = pm.createSnapshot(60, "full");
  assertEquals(snap.players.length, 1);
  const row = snap.players[0]!;
  assertEquals(row.name, "Alice");
  assertEquals(row.head, 2);
  assertEquals(row.visor, 1);
  assertEquals(row.shoulder, 3);
  assertEquals(row.body, 1);
  assertEquals(row.leg, 2);
  assertEquals(row.hue, 0.5);
  assertEquals(row.gunHue, -1);
  assertEquals(row.pistol, 1);
  assertEquals(row.rifle, 2);
  assertEquals(row.crosshair, 4);
  assertEquals(row.scope, 3);
  assertEquals(row.score, 3);
  assertEquals(row.kills, 1);
  assertEquals(row.deaths, 2);
  assertEquals(row.xp, 1234);
  assertEquals(row.mmsRankId, "vanguard");
  assertEquals(row.founderBadge, true);
});

Deno.test("game over preserves progression badges and final alive state", () => {
  const pm = makeManager();
  const p = pm.add("s1", "Alice", "A", {
    xp: 4321,
    mmsRankId: "elite",
    founderBadge: true,
  });
  p.alive = false;

  const over = pm.forceDraw(50);
  assertExists(over);
  assertEquals(over.players[0]?.alive, false);
  assertEquals(over.players[0]?.xp, 4321);
  assertEquals(over.players[0]?.mmsRankId, "elite");
  assertEquals(over.players[0]?.founderBadge, true);
});

Deno.test("getFullPlayerRoster returns identity for all players", () => {
  const pm = makeManager();
  pm.add("s1", "Alice", "A", {
    equipment: {
      head: 1,
      visor: 0,
      shoulder: 0,
      body: 0,
      leg: 0,
      hue: 0,
      gunHue: 0,
      bulletHue: 0,
      crosshairColor: -1,
      nameHue: 0,
      pistol: 0,
      rifle: 0,
      shotgun: 0,
      scope: 0,
      crosshair: 0,
    },
  });
  pm.add("s2", "Bob", "B", {
    equipment: {
      head: 3,
      visor: 2,
      shoulder: 1,
      body: 2,
      leg: 1,
      hue: -0.1,
      gunHue: 0.5,
      bulletHue: 0,
      crosshairColor: -1,
      nameHue: 0,
      pistol: 2,
      rifle: 1,
      shotgun: 0,
      scope: 0,
      crosshair: 1,
    },
  });

  const roster = pm.getFullPlayerRoster(0);
  assertEquals(roster.length, 2);
  const alice = roster.find((r) => r.id === "s1");
  const bob = roster.find((r) => r.id === "s2");
  assertExists(alice);
  assertExists(bob);
  assertEquals(alice.name, "Alice");
  assertEquals(alice.head, 1);
  assertEquals(bob.name, "Bob");
  assertEquals(bob.head, 3);
  assertEquals(bob.visor, 2);
});

Deno.test("createSnapshot motion keeps grey-agent name and dome fit", () => {
  const pm = makeManager();
  pm.add("s1", "Alice", "A");
  pm.addBot("bot:1", "bot1");
  const agent = pm.addAgent("agent:1-test", "agent1", "A", {
    x: 1.25,
    y: 1.7,
    z: -2.5,
    yaw: 0.4,
  });
  agent.score = 9;
  agent.kills = 4;
  agent.deaths = 1;

  const snap = pm.createSnapshot(60, "motion");
  const human = snap.players.find((p) => p.id === "s1");
  const bot = snap.players.find((p) => p.id === "bot:1");
  const row = snap.players.find((p) => p.id === "agent:1-test");
  assertExists(human);
  assertExists(bot);
  assertExists(row);
  assertEquals(human.name, undefined);
  assertEquals(human.head, undefined);
  assertEquals(human.isAgent, undefined);
  assertEquals(bot.name, undefined);
  assertEquals(bot.head, undefined);
  assertEquals(row.name, "agent1");
  assertEquals(row.isAgent, true);
  assertEquals(row.head, 4);
  assertEquals(row.visor, 4);
  assertEquals(row.shoulder, 4);
  assertEquals(row.body, 4);
  assertEquals(row.leg, 4);
  assertEquals(row.pistol, 4);
  assertEquals(row.rifle, 4);
  assertEquals(row.shotgun, 4);
  assertEquals(row.crosshair, 4);
  assertEquals(row.scope, 0);
  assertEquals(row.score, undefined);
  assertEquals(row.kills, undefined);
  assertEquals(row.deaths, undefined);

  const buf = encodeGamePacket("snapshot", snap);
  assertExists(buf);
  const decoded = decodeGamePacket(buf);
  assertExists(decoded);
  const back = decoded.payload as typeof snap;
  const wireHuman = back.players.find((p) => p.id === "s1");
  const wireAgent = back.players.find((p) => p.id === "agent:1-test");
  assertExists(wireHuman);
  assertExists(wireAgent);
  assertEquals(wireHuman.name, undefined);
  assertEquals(wireHuman.head, undefined);
  assertEquals(wireAgent.name, "agent1");
  assertEquals(wireAgent.isAgent, true);
  assertEquals(wireAgent.head, 4);
  assertEquals(wireAgent.body, 4);
  assertEquals(wireAgent.rifle, 4);
  assertEquals(wireAgent.scope, 0);
  assertEquals(wireAgent.score, undefined);
  // Name selects float32 pose bytes. The value is already motion-quantized;
  // float32 is within a fraction of a millimeter of that milli value.
  assertEquals(Math.abs(wireAgent.x - row.x) < 1e-4, true);
  assertEquals(Math.abs(wireAgent.y - row.y) < 1e-4, true);
  assertEquals(Math.abs(wireAgent.z - row.z) < 1e-4, true);
});

Deno.test("createSnapshot defaults to motion mode", () => {
  const pm = makeManager();
  pm.add("s1", "Alice");
  const snap = pm.createSnapshot(0);
  assertEquals(snap.players[0]!.name, undefined);
});

Deno.test("createSnapshot full includes ping when pingMs set (pool pawns)", () => {
  const pm = makeManager();
  const bot = pm.addBot("bot:seed", "SeedOne");
  bot.pingMs = 42;
  const full = pm.createSnapshot(0, "full");
  assertEquals(full.players[0]!.ping, 42);

  // Motion ships ping on 2 Hz ticks only (tick 0 is a sample).
  const motion = pm.createSnapshot(0, "motion");
  assertEquals(motion.players[0]!.ping, 42);

  // Community bots with pingMs 0 stay omitted.
  const plain = pm.addBot("bot:plain", "bot1");
  assertEquals(plain.pingMs, 0);
  const full2 = pm.createSnapshot(0, "full");
  const plainRow = full2.players.find((r) => r.id === "bot:plain");
  assertExists(plainRow);
  assertEquals(plainRow.ping, undefined);
});
