/**
 * Epic 7.4 — match metadata boundary (server).
 *
 * Run from server-community/:
 *   deno test -A players/match_metadata_test.ts
 *
 * Locks: owner coverage across lifecycle transitions, runtimeMatchId rotation,
 * informational-vs-load-bearing cut, wall-clock exclusion, and live-path
 * non-consumption (builder is read-only to emits/reports).
 */

import { assertEquals, assertExists, assertNotEquals } from "@std/assert";
import { PlayerManager } from "./PlayerManager.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";
import { TICK_HZ } from "../protocol/network.ts";
import { GameServer } from "../runtime/GameServer.ts";
import { NoopAuthorityAdapter } from "../authority/adapter.ts";
import {
  getMatchMetadata,
  readMatchMetadataSimSource,
} from "./matchMetadata.ts";
import {
  MATCH_METADATA_EXCLUDED_WALL_CLOCK_KEYS,
  MATCH_METADATA_LOAD_BEARING_FIELDS,
  REPLAY_FORMAT_VERSION,
} from "../shared/replay/matchMetadata.ts";
import { GAME_PROTO } from "../shared/net/opcodes.ts";

const miniMap: DoorsMap = {
  name: "meta-boundary",
  version: 2,
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

const PACKAGE_ROOT = new URL("../", import.meta.url);

async function readRepo(rel: string): Promise<string> {
  return await Deno.readTextFile(new URL(rel, PACKAGE_ROOT));
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function makeServer(over?: {
  name?: string;
  joinMode?: "open" | "ranked";
  rankedServerId?: string;
  modeId?: string | null;
  map?: DoorsMap;
}): GameServer {
  const map = over?.map ?? miniMap;
  return new GameServer({
    name: over?.name ?? "meta-boundary",
    port: 0,
    host: "127.0.0.1",
    map,
    collision: new MapCollision(map),
    autofillBots: 0,
    noBotsOnEmptyServer: true,
    joinMode: over?.joinMode ?? "open",
    rankedServerId: over?.rankedServerId ?? "open",
    modeId: over?.modeId,
    authorityAdapter: new NoopAuthorityAdapter(),
    botThinkEngine: null,
  });
}

function internals(server: GameServer): {
  runtimeMatchId: string;
  players: PlayerManager;
  sessions: { emit(...args: unknown[]): void } | null;
  beginRuntimeMatchIdentity(): void;
  handleMatchReady(playerId: string, ready: boolean): void;
} {
  return server as unknown as {
    runtimeMatchId: string;
    players: PlayerManager;
    sessions: { emit(...args: unknown[]): void } | null;
    beginRuntimeMatchIdentity(): void;
    handleMatchReady(playerId: string, ready: boolean): void;
  };
}

Deno.test("7.4 coverage: getMatchMetadata matches owners at capture tick", () => {
  const server = makeServer({ name: "owner-check" });
  const { players, runtimeMatchId } = internals(server);
  players.add("p1", "Alpha", "A");
  players.add("p2", "Bravo", "B");

  const tick = 42;
  const result = server.getMatchMetadata(tick, {
    capturedAtIso: "2026-06-01T12:00:00.000Z",
  });
  assertEquals(result.ok, true);
  if (!result.ok) return;
  const meta = result.metadata;

  assertEquals(meta.captureTick, tick);
  assertEquals(meta.matchSeed, players.getMatchSeed());
  assertEquals(meta.matchDurationTicks, players.getMatchDurationTicks());
  assertEquals(meta.matchEndTick, players.getMatchClockState().matchEndTick);
  assertEquals(meta.doorCycleOriginTick, players.getDoorCycleOriginTick());
  assertEquals(meta.prematchEnabled, players.isPrematchEnabled());
  assertEquals(meta.raidDoorPolicy, players.getRaidDoorPolicy());
  assertEquals(meta.debugForceDoorsOpen, players.isDebugForceDoorsOpen());
  assertEquals(meta.phase, players.getMatchPhase());
  assertEquals(meta.scores, players.getScores());
  assertEquals(meta.map.name, miniMap.name);
  assertEquals(meta.map.version, miniMap.version);
  assertEquals(meta.tickRate, TICK_HZ);
  assertEquals(meta.gameProto, GAME_PROTO);
  assertEquals(meta.replayFormatVersion, REPLAY_FORMAT_VERSION);
  assertEquals(meta.runtimeMatchId, runtimeMatchId);
  assertEquals(meta.serverName, "owner-check");
  assertEquals(meta.roster.length, 2);
  assertEquals(meta.roster.map((r) => r.id).sort(), ["p1", "p2"]);
});

Deno.test("7.4 coverage: prematch → live → score-end → restart captures owners", () => {
  const server = makeServer({
    joinMode: "ranked",
    rankedServerId: "ranked",
  });
  const box = internals(server);
  box.sessions = { emit: () => {} };
  const pm = box.players;
  assertEquals(pm.getMatchPhase(), "prematch");

  const pre = server.requireMatchMetadata(0, {
    capturedAtIso: "2026-01-01T00:00:00.000Z",
  });
  assertEquals(pre.phase, "prematch");
  assertEquals(pre.prematchEnabled, true);
  const idPrematch = pre.runtimeMatchId;

  for (const id of ["s1", "s2", "s3", "s4"]) pm.add(id, id);
  for (const id of ["s1", "s2", "s3"]) box.handleMatchReady(id, true);
  assertEquals(box.runtimeMatchId, idPrematch);
  box.handleMatchReady("s4", true);
  assertEquals(pm.getMatchPhase(), "live");

  const live = server.requireMatchMetadata(10, {
    capturedAtIso: "2026-01-01T00:00:01.000Z",
  });
  assertEquals(live.phase, "live");
  assertEquals(live.matchSeed, pm.getMatchSeed());
  assertEquals(live.doorCycleOriginTick, pm.getDoorCycleOriginTick());
  assertNotEquals(live.runtimeMatchId, idPrematch);

  assertExists(pm.forceDraw(50));
  const inter = server.requireMatchMetadata(50, {
    capturedAtIso: "2026-01-01T00:00:02.000Z",
  });
  assertEquals(inter.phase, "intermission");

  const idBeforeRestart = inter.runtimeMatchId;
  pm.startNewMatch(100);
  box.beginRuntimeMatchIdentity();
  const next = server.requireMatchMetadata(100, {
    capturedAtIso: "2026-01-01T00:00:03.000Z",
  });
  assertEquals(next.phase, "prematch");
  assertNotEquals(next.runtimeMatchId, idBeforeRestart);
  assertEquals(next.matchSeed, pm.getMatchSeed());
  assertEquals(next.doorCycleOriginTick, pm.getDoorCycleOriginTick());
});

Deno.test("7.4 coverage: map-change rotates identity and refreshes map name", () => {
  const server = makeServer();
  const before = server.requireMatchMetadata(0, {
    capturedAtIso: "2026-01-01T00:00:00.000Z",
  });
  const packet = server.changeMap({
    map: { ...miniMap, name: "meta-b" },
    collision: new MapCollision({ ...miniMap, name: "meta-b" }),
    mapPath: "meta-b",
  });
  assertEquals(packet.endedAsDraw, true);
  const after = server.requireMatchMetadata(0, {
    capturedAtIso: "2026-01-01T00:00:01.000Z",
  });
  assertNotEquals(after.runtimeMatchId, before.runtimeMatchId);
  assertEquals(after.map.name, "meta-b");
  assertEquals(after.matchSeed, internals(server).players.getMatchSeed());
});

Deno.test("7.4 exclusion: metadata JSON has no wall-clock operational keys", () => {
  const server = makeServer();
  internals(server).players.add("p1", "P", "A");
  const meta = server.requireMatchMetadata(1, {
    capturedAtIso: "2026-01-01T00:00:00.000Z",
  });
  const json = JSON.stringify(meta);
  for (const key of MATCH_METADATA_EXCLUDED_WALL_CLOCK_KEYS) {
    assertEquals(json.includes(`"${key}"`), false, `leaked ${key}`);
  }
  // capturedAtIso is the only timestamp and stays informational.
  assertEquals(typeof meta.capturedAtIso, "string");
});

Deno.test("7.4 live path: getMatchMetadata is unused by GameServer behavior paths", async () => {
  const src = stripComments(await readRepo("runtime/GameServer.ts"));

  function methodBody(name: string): string {
    // Match `public|private name(` then scan to the body `{` (allows TS return types).
    const re = new RegExp(`(?:public|private)\\s+${name}\\s*\\(`);
    const m = re.exec(src);
    assertEquals(m != null, true, `missing method ${name}`);
    let i = m!.index + m![0].length; // after '('
    let depth = 1; // param-list paren depth
    while (i < src.length && depth > 0) {
      const ch = src[i++];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
    }
    while (i < src.length && src[i] !== "{") i++;
    assertEquals(src[i] === "{", true, `no body for ${name}`);
    const start = i;
    depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (depth === 0) return src.slice(start, i + 1);
      }
    }
    return "";
  }

  for (
    const method of [
      "startGameLoop",
      "emitSimTickEvents",
      "onMatchEnded",
      "emitMatchStart",
      "welcomePayload",
      "flushHeatmapsToAuthority",
      "stepSim",
    ]
  ) {
    const body = methodBody(method);
    assertEquals(body.includes("getMatchMetadata"), false, method);
    assertEquals(body.includes("buildMatchMetadataFromOwners"), false, method);
    assertEquals(body.includes("requireMatchMetadata"), false, method);
  }

  // Public read exists; only its own body may call the pure builder.
  const readBody = methodBody("getMatchMetadata");
  assertEquals(readBody.includes("buildMatchMetadataFromOwners"), true);
  void MATCH_METADATA_LOAD_BEARING_FIELDS;
});

Deno.test("7.4 sim source: readMatchMetadataSimSource tracks config mid-match", () => {
  const pm = new PlayerManager(new MapCollision(miniMap), { matchSeed: 7 });
  pm.setRaidDoorPolicy("idle");
  pm.setDebugForceDoorsOpen(true);
  const simResult = readMatchMetadataSimSource(pm, 20);
  assertEquals(simResult.ok, true);
  if (!simResult.ok) return;
  assertEquals(simResult.sim.raidDoorPolicy, "idle");
  assertEquals(simResult.sim.debugForceDoorsOpen, true);
  assertEquals(simResult.sim.matchSeed, 7);

  const result = getMatchMetadata(
    20,
    pm,
    {
      getMatchMetadataIdentity: () => ({
        runtimeMatchId: "33333333-3333-3333-3333-333333333333",
        serverName: "cfg",
        serverId: null,
        modeId: null,
        raidId: null,
        buildSha: null,
        raidMatch: { active: false },
      }),
    },
    { capturedAtIso: "2026-01-01T00:00:00.000Z" },
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.metadata.raidDoorPolicy, "idle");
  assertEquals(result.metadata.debugForceDoorsOpen, true);
});
