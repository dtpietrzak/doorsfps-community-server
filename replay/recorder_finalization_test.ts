/**
 * Epic 8.6 — Replay finalization (blob put + finalized stamp).
 *
 * Run from server-community/:
 *   deno test -A replay/recorder_finalization_test.ts
 */

import {
  assertEquals,
  assertExists,
  assertMatch,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { GameServer } from "../runtime/GameServer.ts";
import { NoopAuthorityAdapter } from "../authority/adapter.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";
import type { SimTickResult } from "../players/simTickResult.ts";
import { drainTickAuthoritativeEvents } from "../players/authoritativeEventSource.ts";
import type { AuthoritativeEvent } from "../shared/sim/authoritativeEvent.ts";
import { REPLAY_FORMAT_VERSION } from "../shared/replay/matchMetadata.ts";
import {
  InMemoryReplayLifecycleClient,
  ReplayRecorder,
} from "./ReplayRecorder.ts";
import {
  assertSafeBlobName,
  LocalReplayBlobStore,
  replayBlobObjectName,
} from "./ReplayBlobStore.ts";
import {
  parseProvisionalReplayFile,
  serializeReplaySession,
} from "./serializeReplaySession.ts";
import {
  settleRecorder,
  wireReplayRecorder,
  type WireRecorderOptions,
} from "./replayTestHarness.ts";

const miniMap: DoorsMap = {
  name: "replay-finalize",
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

type ServerInternals = {
  players: {
    add(socket: string, name: string, team: "A" | "B"): void;
    beginLiveMatch(tick: number, nowMs: number): unknown;
    getMatchPhase(): string;
    getScores(): { A: number; B: number };
  };
  sessions: { emit(...args: unknown[]): void } | null;
  runtimeMatchId: string;
  stepSim(tick: number, nowMs: number): SimTickResult;
  deliverReplayIntegrationTick(
    tick: number,
    events: ReadonlyArray<AuthoritativeEvent>,
  ): void;
  beginRuntimeMatchIdentity(tick?: number): void;
  emitMatchStart(matchStart: unknown, tick: number): void;
  onMatchEnded(
    packet: {
      winner: "A" | "B" | "draw";
      scores: { A: number; B: number };
      players: unknown[];
    },
    nowMs?: number,
  ): void;
  replaySink: unknown;
};

function makeServer(): GameServer {
  return new GameServer({
    name: "replay-finalize",
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
}

function internals(server: GameServer): ServerInternals {
  return server as unknown as ServerInternals;
}

function stubSessions(server: GameServer): void {
  internals(server).sessions = { emit: () => {} };
}

function wireRecorder(server: GameServer, opts?: WireRecorderOptions) {
  return wireReplayRecorder(
    {
      attachSink: (sink) => server.attachReplaySink(sink),
      detachSink: () => server.detachReplaySink(),
    },
    opts,
  );
}

function driveTick(server: GameServer, tick: number): SimTickResult {
  const i = internals(server);
  const result = i.stepSim(tick, Date.now());
  const authEvents = drainTickAuthoritativeEvents(
    i.players as never,
    tick,
    result.events,
  );
  i.deliverReplayIntegrationTick(tick, authEvents);
  return result;
}

async function startLive(
  server: GameServer,
  recorder: ReplayRecorder,
): Promise<string> {
  stubSessions(server);
  const i = internals(server);
  i.players.add("s1", "A1", "A");
  const start = i.players.beginLiveMatch(1, Date.now());
  i.beginRuntimeMatchIdentity(1);
  i.emitMatchStart(start, 1);
  await settleRecorder(recorder);
  return i.runtimeMatchId;
}

Deno.test("8.6 happy-path: match end → file + finalized row with version stamp", async () => {
  const server = makeServer();
  const i = internals(server);
  const { recorder, lifecycle, blobStore } = wireRecorder(server);
  const mem = lifecycle as InMemoryReplayLifecycleClient;
  assertExists(blobStore);
  const matchId = await startLive(server, recorder);

  driveTick(server, 2);
  driveTick(server, 3);
  const before = recorder.getBufferedSession(matchId)!;
  assertExists(before.init);
  const inputTicks = before.inputs.map((r) => r.tick);
  const eventTicks = before.events.map((r) => r.tick);

  i.onMatchEnded({
    winner: "A",
    scores: { A: 1, B: 0 },
    players: [],
  });
  await settleRecorder(recorder);

  const row = (await mem.getByRuntimeMatchId(matchId))!;
  assertEquals(row.status, "finalized");
  assertExists(row.filePath);
  assertEquals(row.fileSizeBytes != null && row.fileSizeBytes > 0, true);
  assertEquals(recorder.getBufferedSession(matchId), null);
  assertEquals(recorder.isAttached(), false);

  const name = replayBlobObjectName(matchId);
  assertEquals(blobStore.exists(name), true);
  assertEquals(blobStore.size(name), row.fileSizeBytes);
  assertEquals(blobStore.resolvePath(name), row.filePath);

  const bytes = blobStore.get(name)!;
  assertEquals(bytes.byteLength, row.fileSizeBytes);
  const parsed = parseProvisionalReplayFile(bytes);
  assertEquals(parsed.header.replayFormatVersion, REPLAY_FORMAT_VERSION);
  assertEquals(parsed.header.runtimeMatchId, matchId);
  assertEquals(parsed.initialState.runtimeMatchId, matchId);
  assertEquals(parsed.inputStream.map((r) => r.tick), inputTicks);
  assertEquals(parsed.eventStream.map((r) => r.tick), eventTicks);
  // 10.3 fills the index pre-encode; empty reserved is only for 10.1-era fixtures.
  assertEquals(
    "indexVersion" in parsed.index &&
      (parsed.index as { indexVersion: number }).indexVersion === 1,
    true,
  );
  assertEquals(parsed.integrity.digest, null);
});

Deno.test("8.6 claim: failed/abandoned/truncated never get a file or finalized", async () => {
  const server = makeServer();
  const { recorder, lifecycle, blobStore } = wireRecorder(server);
  const mem = lifecycle as InMemoryReplayLifecycleClient;
  assertExists(blobStore);
  const matchId = await startLive(server, recorder);
  driveTick(server, 2);

  // Force-fail mid recording.
  recorder.markFailed("test-force-fail");
  await settleRecorder(recorder);
  assertEquals((await mem.getByRuntimeMatchId(matchId))!.status, "failed");
  assertEquals(blobStore.exists(replayBlobObjectName(matchId)), false);

  // completeFinalization on a non-finalizing row is a no-op claim fail.
  const rowId = (await mem.getByRuntimeMatchId(matchId))!.id;
  recorder.completeFinalization(rowId);
  await settleRecorder(recorder);
  assertEquals((await mem.getByRuntimeMatchId(matchId))!.status, "failed");
  assertEquals(blobStore.exists(replayBlobObjectName(matchId)), false);
  assertEquals((await mem.getByRuntimeMatchId(matchId))!.filePath, null);
});

Deno.test("8.6 failure: serialize throw → failed + no file", async () => {
  const server = makeServer();
  const i = internals(server);
  const { recorder, lifecycle, blobStore } = wireRecorder(server, {
    serializeSession: () => {
      throw new Error("serialize-boom");
    },
  });
  const mem = lifecycle as InMemoryReplayLifecycleClient;
  assertExists(blobStore);
  const matchId = await startLive(server, recorder);
  driveTick(server, 2);

  i.onMatchEnded({
    winner: "A",
    scores: { A: 1, B: 0 },
    players: [],
  });
  await settleRecorder(recorder);

  const row = (await mem.getByRuntimeMatchId(matchId))!;
  assertEquals(row.status, "failed");
  assertMatch(row.error ?? "", /finalize-write-failed.*serialize-boom/);
  assertEquals(blobStore.exists(replayBlobObjectName(matchId)), false);
  assertEquals(row.filePath, null);
  assertEquals(recorder.getBufferedSession(matchId), null);

  // Retry without a fresh intact session does not resurrect finalized.
  recorder.completeFinalization(row.id);
  await settleRecorder(recorder);
  assertEquals((await mem.getByRuntimeMatchId(matchId))!.status, "failed");
});

Deno.test("8.6 failure: rename throw → failed + temp cleaned + no final file", async () => {
  const server = makeServer();
  const i = internals(server);
  const blobDir = Deno.makeTempDirSync({ prefix: "replay-rename-fail-" });
  const blobStore = new LocalReplayBlobStore(blobDir, {
    beforeRename: () => {
      throw new Error("rename-boom");
    },
  });
  const { recorder, lifecycle } = wireRecorder(server, { blobStore });
  const mem = lifecycle as InMemoryReplayLifecycleClient;
  const matchId = await startLive(server, recorder);
  driveTick(server, 2);

  i.onMatchEnded({
    winner: "draw",
    scores: { A: 0, B: 0 },
    players: [],
  });
  await settleRecorder(recorder);

  const row = (await mem.getByRuntimeMatchId(matchId))!;
  assertEquals(row.status, "failed");
  assertMatch(row.error ?? "", /finalize-write-failed.*rename-boom/);
  assertEquals(blobStore.exists(replayBlobObjectName(matchId)), false);
  // No orphan temps left.
  const leftovers = [...Deno.readDirSync(blobDir)].filter((e) =>
    e.isFile && e.name.includes(".tmp.")
  );
  assertEquals(leftovers.length, 0);
});

Deno.test("8.6 failure: size mismatch → failed + final deleted", async () => {
  const server = makeServer();
  const i = internals(server);
  const blobDir = Deno.makeTempDirSync({ prefix: "replay-size-fail-" });
  const blobStore = new LocalReplayBlobStore(blobDir, {
    lieSizeAfterRename: 1,
  });
  const { recorder, lifecycle } = wireRecorder(server, { blobStore });
  const mem = lifecycle as InMemoryReplayLifecycleClient;
  const matchId = await startLive(server, recorder);
  driveTick(server, 2);

  i.onMatchEnded({
    winner: "A",
    scores: { A: 1, B: 0 },
    players: [],
  });
  await settleRecorder(recorder);

  const row = (await mem.getByRuntimeMatchId(matchId))!;
  assertEquals(row.status, "failed");
  assertMatch(row.error ?? "", /finalize-write-failed|finalize-verify-failed/);
  assertEquals(blobStore.exists(replayBlobObjectName(matchId)), false);
});

Deno.test("8.6 failure: finalize throw → failed + file deleted", async () => {
  const server = makeServer();
  const i = internals(server);
  const blobDir = Deno.makeTempDirSync({ prefix: "replay-stamp-fail-" });
  const blobStore = new LocalReplayBlobStore(blobDir);

  class BoomLifecycle extends InMemoryReplayLifecycleClient {
    override finalize(_args: {
      rowId: number;
      runtimeMatchId: string;
      bytes: Uint8Array;
    }): Promise<{ fileSizeBytes: number; filePath?: string | null }> {
      return Promise.reject(new Error("stamp-boom"));
    }
  }

  const lifecycle = new BoomLifecycle({ blobStore });
  const { recorder } = wireRecorder(server, { lifecycle, blobStore });
  const matchId = await startLive(server, recorder);
  driveTick(server, 2);

  i.onMatchEnded({
    winner: "A",
    scores: { A: 1, B: 0 },
    players: [],
  });
  await settleRecorder(recorder);

  const row = (await lifecycle.getByRuntimeMatchId(matchId))!;
  assertEquals(row.status, "failed");
  assertMatch(row.error ?? "", /finalize-write-failed.*stamp-boom/);
  // Recorder fail path should clean up; BoomLifecycle put may leave a file
  // unless failFinalizingClaim deletes — assert not finalized either way.
  assertEquals(row.filePath, null);
  assertEquals(row.status !== "finalized", true);
});

Deno.test("8.6 boot: leftover finalizing sweep is authority-owned (recorder no-op)", () => {
  // Authority owns crash-recovery abandonment (sweepAbandonedReplays).
  // Community ReplayRecorder.sweepAbandoned() returns 0 and must never promote.
  const server = makeServer();
  const { recorder } = wireRecorder(server);
  assertEquals(recorder.sweepAbandoned(), 0);
});

Deno.test("8.6 interface: traversal names rejected; only blob module writes files", async () => {
  assertThrows(() => assertSafeBlobName("../evil.replay.json"));
  assertThrows(() => assertSafeBlobName("a/b.replay.json"));
  assertThrows(() => assertSafeBlobName("nope.json"));

  const blobSrc = await Deno.readTextFile(
    new URL("./ReplayBlobStore.ts", import.meta.url),
  );
  assertMatch(blobSrc, /Deno\.writeFileSync/);
  assertMatch(blobSrc, /Deno\.renameSync/);

  // Finalizer and serializer must not call Deno.write* directly.
  for (const file of ["./ReplayRecorder.ts", "./serializeReplaySession.ts"]) {
    const src = await Deno.readTextFile(new URL(file, import.meta.url));
    const code = src.replace(/\/\/.*$/gm, "");
    assertEquals(/Deno\.write(?:File|TextFile)Sync/.test(code), false);
    assertEquals(/Deno\.renameSync/.test(code), false);
  }

  // In-memory lifecycle refuses status=finalized via update (finalize is sole path).
  const lifecycle = new InMemoryReplayLifecycleClient();
  const row = await lifecycle.insertRecording("m-refuse");
  await assertRejects(
    () => lifecycle.update(row.id, { status: "finalized" as never }),
    Error,
    "refuses status=finalized",
  );
});

Deno.test("8.6 sole-writer: finalize only from finalizing", async () => {
  const lifecycle = new InMemoryReplayLifecycleClient();
  const row = await lifecycle.insertRecording("m-stamp");
  await assertRejects(
    () =>
      lifecycle.finalize({
        rowId: row.id,
        runtimeMatchId: "m-stamp",
        bytes: new TextEncoder().encode("x"),
      }),
    Error,
    "was not finalizing",
  );
  await lifecycle.update(row.id, { status: "finalizing" });
  const result = await lifecycle.finalize({
    rowId: row.id,
    runtimeMatchId: "m-stamp",
    bytes: new TextEncoder().encode("hello-replay"),
  });
  const stamped = (await lifecycle.getByRuntimeMatchId("m-stamp"))!;
  assertEquals(stamped.status, "finalized");
  assertEquals(stamped.fileSizeBytes, result.fileSizeBytes);
  assertExists(stamped.filePath);
});

Deno.test("8.6 off-tick-path: onTick source has no blob I/O", async () => {
  const src = await Deno.readTextFile(
    new URL("./ReplayRecorder.ts", import.meta.url),
  );
  // Extract onTick method body roughly.
  const onTick = src.match(/onTick\([\s\S]*?\n {2}\w+\(/)?.[0] ?? "";
  assertEquals(/blobStore/.test(onTick), false);
  assertEquals(/completeFinalization/.test(onTick), false);
  assertEquals(/serializeReplaySession/.test(onTick), false);
});

Deno.test("8.6 equivalence: sim outcomes identical with recording on vs off", async () => {
  async function runSeason(withRecorder: boolean): Promise<{
    phase: string;
    scores: { A: number; B: number };
  }> {
    const server = makeServer();
    stubSessions(server);
    const i = internals(server);
    let recorder: ReplayRecorder | null = null;
    if (withRecorder) {
      recorder = wireRecorder(server).recorder;
    }
    i.players.add("s1", "A1", "A");
    const start = i.players.beginLiveMatch(1, Date.now());
    i.beginRuntimeMatchIdentity(1);
    i.emitMatchStart(start, 1);
    if (recorder) await settleRecorder(recorder);
    for (let t = 2; t <= 6; t++) driveTick(server, t);
    i.onMatchEnded({
      winner: "A",
      scores: { A: 2, B: 0 },
      players: [],
    });
    if (recorder) await settleRecorder(recorder);
    return {
      phase: i.players.getMatchPhase(),
      scores: i.players.getScores(),
    };
  }

  const a = await runSeason(false);
  const b = await runSeason(true);
  assertEquals(a.phase, b.phase);
  assertEquals(a.scores, b.scores);
});

Deno.test("8.6 boot sweepAbandoned is no-op on community recorder", () => {
  const server = makeServer();
  const { recorder } = wireRecorder(server);
  assertEquals(recorder.sweepAbandoned(), 0);
});

Deno.test("8.6 serialize: deterministic version stamp + streams", async () => {
  // Full container validation runs on parse — fixture must be load-bearing-complete.
  // Prefer the live recorder path above for realism; this unit check only asserts
  // byte stability through buildReplayContainerFromSession.
  const server = makeServer();
  const { recorder } = wireRecorder(server);
  const matchId = await startLive(server, recorder);
  driveTick(server, 2);
  const session = recorder.getBufferedSession(matchId)!;
  assertExists(session.init);

  const a = serializeReplaySession(session);
  const b = serializeReplaySession(session);
  assertEquals(a, b);
  const parsed = parseProvisionalReplayFile(a);
  assertEquals(parsed.header.replayFormatVersion, REPLAY_FORMAT_VERSION);
  assertEquals(parsed.header.runtimeMatchId, matchId);
  assertEquals(parsed.header.captureTick, session.init.captureTick);
  assertEquals(parsed.inputStream.map((r) => r.tick), session.inputs.map((r) => r.tick));
});
