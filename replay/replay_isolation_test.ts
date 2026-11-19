/**
 * Epic 20.1 — replay isolation.
 *
 * Run from server-community/:
 *   deno test -A --unstable-net --node-modules-dir=manual replay/replay_isolation_test.ts
 */

import { assertEquals, assertThrows } from "@std/assert";
import { PlayerManager } from "../players/PlayerManager.ts";
import { GameServer } from "../runtime/GameServer.ts";
import { serverInternals } from "../runtime/gameServerTestHarness.ts";
import { NoopAuthorityAdapter } from "../authority/adapter.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";
import { captureCheckpointState } from "./authoritativeCheckpoint.ts";
import {
  CheckpointVersionMismatch,
  loadCheckpointState,
  type CheckpointLoadInit,
} from "./checkpointLoading.ts";
import {
  assertReplayMayWrite,
  claimLiveAuthoritative,
  isLiveAuthoritative,
  releaseLiveAuthoritative,
  REPLAY_ISOLATION_INVALID,
  REPLAY_ISOLATION_VIOLATION,
  ReplayIsolationError,
} from "./replayIsolation.ts";

const miniMap: DoorsMap = {
  name: "replay-isolation",
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

function makeManager(seed = 0x201): PlayerManager {
  return new PlayerManager(new MapCollision(miniMap), { matchSeed: seed });
}

function anchorFor(
  pm: PlayerManager,
  runtimeMatchId = "rt-iso",
): CheckpointLoadInit {
  const initEvent = pm.buildMatchInitEvent(pm.tick);
  if (initEvent.kind !== "matchInit") throw new Error("expected matchInit");
  return {
    runtimeMatchId,
    init: {
      map: initEvent.map,
      matchSeed: initEvent.matchSeed,
      roster: initEvent.roster.map((row) => ({ id: row.id, name: row.name })),
    },
  };
}

Deno.test("20.1 a claim is identity, idempotent, and releasable", () => {
  const live = makeManager();
  const other = makeManager(0x202);
  assertEquals(isLiveAuthoritative(live), false);
  assertReplayMayWrite(live);
  claimLiveAuthoritative(live);
  claimLiveAuthoritative(live);
  assertEquals(isLiveAuthoritative(live), true);
  assertEquals(isLiveAuthoritative(other), false);
  assertReplayMayWrite(other);
  const blocked = assertThrows(
    () => assertReplayMayWrite(live),
    ReplayIsolationError,
  );
  assertEquals(blocked.code, REPLAY_ISOLATION_VIOLATION);
  releaseLiveAuthoritative(live);
  assertEquals(isLiveAuthoritative(live), false);
  assertReplayMayWrite(live);
  releaseLiveAuthoritative(other);
  assertEquals(isLiveAuthoritative(other), false);
});

Deno.test("20.1 a bad argument is not a live match", () => {
  const cases: Array<[string, () => void]> = [
    ["claim null", () => claimLiveAuthoritative(null as unknown as object)],
    ["release null", () => releaseLiveAuthoritative(null as unknown as object)],
    ["write null", () => assertReplayMayWrite(null as unknown as object)],
  ];
  for (const [label, run] of cases) {
    const err = assertThrows(run, ReplayIsolationError, undefined, label);
    assertEquals(err.code, REPLAY_ISOLATION_INVALID, label);
  }
  assertEquals(isLiveAuthoritative(null as unknown as object), false);
});

Deno.test("20.1 a claimed match rejects a valid checkpoint and keeps its pose", () => {
  const live = makeManager();
  const human = live.add("h1", "Human", "A");
  live.drainAuthoritativeEvents();
  human.x = 1.25;
  const checkpoint = captureCheckpointState(live, live.tick, "rt-iso");
  const anchor = anchorFor(live);
  human.x = 9;
  claimLiveAuthoritative(live);
  try {
    const blocked = assertThrows(
      () => loadCheckpointState(live, checkpoint, { expectedInit: anchor }),
      ReplayIsolationError,
    );
    assertEquals(blocked.code, REPLAY_ISOLATION_VIOLATION);
    assertEquals(live.get("h1")!.x, 9);

    const fresh = makeManager();
    loadCheckpointState(fresh, checkpoint, { expectedInit: anchor });
    assertEquals(fresh.get("h1")!.x, 1.25);
    assertEquals(live.get("h1")!.x, 9);

    releaseLiveAuthoritative(live);
    loadCheckpointState(live, checkpoint, { expectedInit: anchor });
    assertEquals(live.get("h1")!.x, 1.25);
  } finally {
    releaseLiveAuthoritative(live);
  }
});

Deno.test("20.1 a bad checkpoint still fails validation on a claimed match", () => {
  const live = makeManager();
  const human = live.add("h1", "Human", "A");
  live.drainAuthoritativeEvents();
  human.x = 4;
  const checkpoint = {
    ...structuredClone(captureCheckpointState(live, live.tick, "rt-iso")),
    schemaVersion: 0,
  } as unknown as ReturnType<typeof captureCheckpointState>;
  const anchor = anchorFor(live);
  claimLiveAuthoritative(live);
  try {
    assertThrows(
      () => loadCheckpointState(live, checkpoint, { expectedInit: anchor }),
      CheckpointVersionMismatch,
    );
    assertEquals(live.get("h1")!.x, 4);
    assertEquals(isLiveAuthoritative(live), true);
  } finally {
    releaseLiveAuthoritative(live);
  }
});

Deno.test("20.1 GameServer claims the match it constructs", async () => {
  const server = new GameServer({
    name: "replay-isolation",
    port: 0,
    host: "127.0.0.1",
    map: miniMap,
    collision: new MapCollision(miniMap),
    autofillBots: 0,
    noBotsOnEmptyServer: true,
    joinMode: "open",
    rankedServerId: "open",
    authorityAdapter: new NoopAuthorityAdapter(),
    botThinkEngine: null,
  });
  try {
    const players = serverInternals(server).players;
    assertEquals(isLiveAuthoritative(players), true);
    const blocked = assertThrows(
      () => assertReplayMayWrite(players),
      ReplayIsolationError,
    );
    assertEquals(blocked.code, REPLAY_ISOLATION_VIOLATION);
  } finally {
    await server.stop();
  }
});

Deno.test("20.1 the write doors check the claim and the runner builds its own manager", async () => {
  const loader = await Deno.readTextFile(
    new URL("./checkpointLoading.ts", import.meta.url),
  );
  const loaderCode = loader
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  const loadFn = loaderCode.slice(
    loaderCode.indexOf("export function loadCheckpointState"),
    loaderCode.indexOf("export function validateCheckpointLoad"),
  );
  const guard = loadFn.indexOf("assertReplayMayWrite(manager)");
  const restore = loadFn.indexOf("manager.restoreFromCheckpoint(");
  assertEquals(guard > 0, true);
  assertEquals(restore > guard, true);

  const runner = await Deno.readTextFile(
    new URL("./replaySimulationRunner.ts", import.meta.url),
  );
  const runnerCode = runner
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  const guards = runnerCode.match(/assertReplayMayWrite\(this\.manager\)/g) ?? [];
  assertEquals(guards.length, 3);
  assertEquals(runnerCode.includes("new PlayerManagerCtor("), true);
  const options = runnerCode.slice(
    runnerCode.indexOf("export type ReplayRunnerOptions"),
    runnerCode.indexOf("export type ReplayRosterDigestEntry"),
  );
  assertEquals(options.includes("PlayerManager"), false);
  assertEquals(options.includes("collision"), true);

  const server = await Deno.readTextFile(
    new URL("../runtime/GameServer.ts", import.meta.url),
  );
  const serverCode = server
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  const constructed = serverCode.indexOf("this.players = new PlayerManager(");
  const claimed = serverCode.indexOf("claimLiveAuthoritative(this.players)");
  assertEquals(constructed > 0, true);
  assertEquals(claimed > constructed, true);

  const isolation = await Deno.readTextFile(
    new URL("./replayIsolation.ts", import.meta.url),
  );
  const isolationCode = isolation
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  assertEquals(/\bDeno\./.test(isolationCode), false);
  assertEquals(/\bperformance\.now\b/.test(isolationCode), false);
  assertEquals(/\bJSON\.stringify\s*\(/.test(isolationCode), false);
  assertEquals(/from\s+["']/.test(isolationCode), false);
  assertEquals(isolationCode.includes("GameServer"), false);
});
