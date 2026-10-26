/**
 * Epic 8.1 — ReplayRecorder lifecycle.
 *
 * Run from server-community/:
 *   deno test -A replay/recorder_lifecycle_test.ts
 */

import {
  assertEquals,
  assertExists,
  assertMatch,
} from "@std/assert";
import { GameServer } from "../runtime/GameServer.ts";
import { NoopAuthorityAdapter } from "../authority/adapter.ts";
import { PlayerManager } from "../players/PlayerManager.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";
import type { SimTickResult } from "../players/simTickResult.ts";
import { drainTickAuthoritativeEvents } from "../players/authoritativeEventSource.ts";
import type { AuthoritativeEvent } from "../shared/sim/authoritativeEvent.ts";
import {
  ReplayRecorder,
  REPLAY_RECORDER_TICK_ERROR_THRESHOLD,
  type InMemoryReplayLifecycleClient,
} from "./ReplayRecorder.ts";
import { isReplayRecordingEnabled } from "./recordingEnabled.ts";
import {
  settleRecorder,
  wireReplayRecorder,
  type WireRecorderOptions,
} from "./replayTestHarness.ts";

const miniMap: DoorsMap = {
  name: "replay-lifecycle",
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
  players: PlayerManager;
  sessions: { emit(...args: unknown[]): void } | null;
  runtimeMatchId: string;
  stepSim(tick: number, nowMs: number): SimTickResult;
  deliverReplayIntegrationTick(
    tick: number,
    events: ReadonlyArray<AuthoritativeEvent>,
  ): void;
  beginRuntimeMatchIdentity(tick?: number): void;
  noteReplayHumanPresence(tick?: number): void;
  emitMatchStart(
    matchStart: ReturnType<PlayerManager["beginLiveMatch"]>,
    tick: number,
  ): void;
  onMatchEnded(
    packet: {
      winner: "A" | "B" | "draw";
      scores: { A: number; B: number };
      players: unknown[];
    },
    nowMs?: number,
  ): void;
  replaySink: unknown;
  maybeResetEmptyRankedInstance?: () => void;
};

function makeServer(joinMode: "open" | "ranked" = "open"): GameServer {
  return new GameServer({
    name: "replay-lifecycle",
    port: 0,
    host: "127.0.0.1",
    map: miniMap,
    collision: new MapCollision(miniMap),
    autofillBots: 0,
    noBotsOnEmptyServer: true,
    joinMode,
    rankedServerId: joinMode === "ranked" ? "ranked" : "open",
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

async function rowFor(
  lifecycle: InMemoryReplayLifecycleClient | { getByRuntimeMatchId: InMemoryReplayLifecycleClient["getByRuntimeMatchId"] },
  matchId: string,
) {
  return await lifecycle.getByRuntimeMatchId(matchId);
}

function driveTick(server: GameServer, tick: number): SimTickResult {
  const i = internals(server);
  const result = i.stepSim(tick, Date.now());
  const authEvents = drainTickAuthoritativeEvents(
    i.players,
    tick,
    result.events,
  );
  i.deliverReplayIntegrationTick(tick, authEvents);
  return result;
}

Deno.test("8.1 kill-switch: default on; 0/false/off/no disable", () => {
  assertEquals(isReplayRecordingEnabled({ get: () => undefined }), true);
  assertEquals(isReplayRecordingEnabled({ get: () => "" }), true);
  assertEquals(isReplayRecordingEnabled({ get: () => "1" }), true);
  assertEquals(isReplayRecordingEnabled({ get: () => "true" }), true);
  for (const v of ["0", "false", "off", "no", "FALSE", " Off "]) {
    assertEquals(
      isReplayRecordingEnabled({ get: () => v }),
      false,
      `expected disabled for ${JSON.stringify(v)}`,
    );
  }
});

Deno.test("8.1 start: fresh runtimeMatchId → recording row; duplicate is no-op", async () => {
  const server = makeServer();
  stubSessions(server);
  const i = internals(server);
  const { recorder, lifecycle } = wireRecorder(server);

  i.players.add("s1", "A1", "A");
  const start = i.players.beginLiveMatch(10, Date.now());
  i.beginRuntimeMatchIdentity(10);
  i.emitMatchStart(start, 10);

  const id = i.runtimeMatchId;
  await settleRecorder(recorder);
  const row = await rowFor(lifecycle as InMemoryReplayLifecycleClient, id);
  assertExists(row);
  assertEquals(row.status, "recording");
  assertEquals(recorder.getActiveRuntimeMatchId(), id);

  const dupBefore = recorder.getDuplicateStartCount();
  i.emitMatchStart(start, 10);
  assertEquals(recorder.getDuplicateStartCount() > dupBefore, true);
  await settleRecorder(recorder);
  assertEquals(
    (lifecycle as InMemoryReplayLifecycleClient).listAll().filter((r) =>
      r.status === "recording"
    ).length,
    1,
  );
});

Deno.test("8.1 ticks: N scripted ticks → counters == N", async () => {
  const server = makeServer();
  stubSessions(server);
  const i = internals(server);
  const { recorder } = wireRecorder(server);

  i.players.add("s1", "A1", "A");
  i.players.add("s2", "B1", "B");
  const start = i.players.beginLiveMatch(1, Date.now());
  i.beginRuntimeMatchIdentity(1);
  i.emitMatchStart(start, 1);
  await settleRecorder(recorder);

  for (let t = 2; t <= 6; t++) driveTick(server, t);

  const counters = recorder.getActiveCounters();
  assertExists(counters);
  assertEquals(counters.ticksObserved, 5);
  assertEquals(counters.inputTicks, 5);
  assertEquals(counters.eventTicks, 5);
  assertExists(recorder.getInitTick());
});

Deno.test("8.1/8.6 normal end: score-end and draw → finalized + sink detached", async () => {
  for (const winner of ["A", "draw"] as const) {
    const server = makeServer();
    stubSessions(server);
    const i = internals(server);
    const { recorder, lifecycle } = wireRecorder(server);
    const mem = lifecycle as InMemoryReplayLifecycleClient;

    i.players.add("s1", "A1", "A");
    const start = i.players.beginLiveMatch(1, Date.now());
    i.beginRuntimeMatchIdentity(1);
    i.emitMatchStart(start, 1);
    await settleRecorder(recorder);
    const matchId = i.runtimeMatchId;
    driveTick(server, 2);

    i.onMatchEnded({
      winner,
      scores: { A: 3, B: 1 },
      players: [],
    });
    await settleRecorder(recorder);

    const row = await rowFor(mem, matchId);
    assertExists(row);
    assertEquals(row.status, "finalized");
    assertExists(row.filePath);
    assertEquals(row.fileSizeBytes != null && row.fileSizeBytes > 0, true);
    assertEquals(recorder.isAttached(), false);
    assertEquals(i.replaySink, null);
    assertEquals(recorder.getActiveRuntimeMatchId(), null);
    assertEquals(recorder.getBufferedSession(matchId), null);

    // Further ticks uncounted (no sink).
    const observed = row.ticksObserved;
    driveTick(server, 3);
    await settleRecorder(recorder);
    assertEquals((await rowFor(mem, matchId))!.ticksObserved, observed);
  }
});

Deno.test("8.1 fail: end-without-start is a counted no-op", () => {
  const server = makeServer();
  stubSessions(server);
  const { recorder } = wireRecorder(server);
  const before = recorder.getNoopCount();
  recorder.beginFinalize(1, "matchEnd");
  assertEquals(recorder.getNoopCount(), before + 1);
});

Deno.test("8.1 fail: tick errors past threshold → failed", async () => {
  const server = makeServer();
  stubSessions(server);
  const i = internals(server);

  class BoomRecorder extends ReplayRecorder {
    protected override recordInputs(): void {
      throw new Error("boom-inputs");
    }
  }

  const wired = wireRecorder(server);
  // Replace with boom subclass sharing the same lifecycle/blobStore.
  const recorder = new BoomRecorder({
    lifecycle: wired.lifecycle,
    attachSink: (sink) => server.attachReplaySink(sink),
    detachSink: () => server.detachReplaySink(),
  });
  recorder.ensureAttached();
  const mem = wired.lifecycle as InMemoryReplayLifecycleClient;

  i.players.add("s1", "A1", "A");
  const start = i.players.beginLiveMatch(1, Date.now());
  i.beginRuntimeMatchIdentity(1);
  i.emitMatchStart(start, 1);
  await settleRecorder(recorder);
  const matchId = i.runtimeMatchId;

  for (let t = 0; t < REPLAY_RECORDER_TICK_ERROR_THRESHOLD; t++) {
    driveTick(server, 2 + t);
  }
  await settleRecorder(recorder);

  const row = await rowFor(mem, matchId);
  assertExists(row);
  assertEquals(row.status, "failed");
  assertMatch(row.error ?? "", /boom-inputs/);
  assertEquals(recorder.isAttached(), false);
});

Deno.test("8.1 abandon: recorder.sweepAbandoned is authority-owned no-op", () => {
  // Crash-recovery abandonment lives on authority (sweepAbandonedReplays /
  // replayRuntimeApi). Community ReplayRecorder.sweepAbandoned() is a no-op.
  const server = makeServer();
  const { recorder } = wireRecorder(server);
  assertEquals(recorder.sweepAbandoned(), 0);
});

Deno.test("8.1 identity: new runtimeMatchId closes old + opens new", async () => {
  const server = makeServer();
  stubSessions(server);
  const i = internals(server);
  const { recorder, lifecycle } = wireRecorder(server);
  const mem = lifecycle as InMemoryReplayLifecycleClient;

  i.players.add("s1", "A1", "A");
  const start = i.players.beginLiveMatch(1, Date.now());
  i.beginRuntimeMatchIdentity(1);
  i.emitMatchStart(start, 1);
  await settleRecorder(recorder);
  const firstId = i.runtimeMatchId;
  driveTick(server, 2);

  // New match session (e.g. intermission restart / map change).
  i.beginRuntimeMatchIdentity(50);
  await settleRecorder(recorder);
  const secondId = i.runtimeMatchId;
  assertEquals(firstId === secondId, false);

  const old = await rowFor(mem, firstId);
  assertExists(old);
  // Reached live → interrupted → failed.
  assertEquals(old.status, "failed");
  assertMatch(old.error ?? "", /interrupted-by-new-match/);

  const neu = await rowFor(mem, secondId);
  assertExists(neu);
  assertEquals(neu.status, "recording");
  assertEquals(recorder.getActiveRuntimeMatchId(), secondId);
});

Deno.test("8.1 identity: empty-ranked enterPrematch without rotation keeps row", async () => {
  const server = makeServer("ranked");
  stubSessions(server);
  const i = internals(server);
  const { recorder, lifecycle } = wireRecorder(server);
  const mem = lifecycle as InMemoryReplayLifecycleClient;

  // Seed a live recording session.
  for (const id of ["s1", "s2", "s3", "s4"]) {
    i.players.add(id, id, id === "s2" || id === "s4" ? "B" : "A");
  }
  const start = i.players.beginLiveMatch(1, Date.now());
  i.beginRuntimeMatchIdentity(1);
  i.emitMatchStart(start, 1);
  await settleRecorder(recorder);
  const matchId = i.runtimeMatchId;
  assertEquals((await rowFor(mem, matchId))?.status, "recording");

  // Drop humans so empty-ranked reset can fire; it must NOT rotate identity.
  for (const id of ["s1", "s2", "s3", "s4"]) {
    i.players.remove(id);
  }
  const reset = (server as unknown as {
    maybeResetEmptyRankedInstance(): boolean;
  }).maybeResetEmptyRankedInstance();
  assertEquals(reset, true);
  assertEquals(i.runtimeMatchId, matchId);
  await settleRecorder(recorder);
  assertEquals((await rowFor(mem, matchId))?.status, "recording");
  assertEquals(recorder.getActiveRuntimeMatchId(), matchId);
});

Deno.test("8.1 identity: new id before live → old abandoned", async () => {
  const server = makeServer();
  stubSessions(server);
  const i = internals(server);
  const { recorder, lifecycle } = wireRecorder(server);
  const mem = lifecycle as InMemoryReplayLifecycleClient;

  // Human required to open a recording row (temp/dev human-presence gate).
  i.players.add("s1", "A1", "A");
  // Rotation only (prematch) — no live matchStart.
  i.beginRuntimeMatchIdentity(1);
  await settleRecorder(recorder);
  const firstId = i.runtimeMatchId;
  assertExists(await rowFor(mem, firstId));

  i.beginRuntimeMatchIdentity(2);
  await settleRecorder(recorder);
  const old = (await rowFor(mem, firstId))!;
  assertEquals(old.status, "abandoned");
  assertMatch(old.error ?? "", /never-reached-live/);
});

Deno.test("human gate: bot-only identity rotation opens no row", async () => {
  const server = makeServer();
  stubSessions(server);
  const i = internals(server);
  const { recorder, lifecycle } = wireRecorder(server);
  const mem = lifecycle as InMemoryReplayLifecycleClient;

  i.beginRuntimeMatchIdentity(1);
  await settleRecorder(recorder);
  const matchId = i.runtimeMatchId;
  assertEquals(await rowFor(mem, matchId), null);
  assertEquals(recorder.getActiveRuntimeMatchId(), null);

  // Ticks may still fan out to the sink, but with no active row the recorder
  // no-ops (nothing persisted).
  driveTick(server, 2);
  await settleRecorder(recorder);
  assertEquals(recorder.getActiveRuntimeMatchId(), null);
  assertEquals(await rowFor(mem, matchId), null);
});

Deno.test("human gate: late human join starts recording from that point", async () => {
  const server = makeServer();
  stubSessions(server);
  const i = internals(server);
  const { recorder, lifecycle } = wireRecorder(server);
  const mem = lifecycle as InMemoryReplayLifecycleClient;

  i.beginRuntimeMatchIdentity(1);
  await settleRecorder(recorder);
  const matchId = i.runtimeMatchId;
  assertEquals(await rowFor(mem, matchId), null);

  // First human seats mid-match → open row for current identity.
  i.players.add("s1", "A1", "A");
  i.noteReplayHumanPresence(5);
  await settleRecorder(recorder);
  assertExists(await rowFor(mem, matchId));
  assertEquals(recorder.getActiveRuntimeMatchId(), matchId);

  // Sticky: dropping the human does not stop recording for this match.
  i.players.remove("s1");
  assertEquals(i.players.humanCount(), 0);
  driveTick(server, 6);
  assertEquals(recorder.getActiveRuntimeMatchId(), matchId);
  assertEquals(
    (recorder.getActiveCounters()?.ticksObserved ?? 0) > 0,
    true,
  );
});

Deno.test("human gate: synthetic-only humans open no row", async () => {
  const server = makeServer();
  stubSessions(server);
  const i = internals(server);
  const { recorder, lifecycle } = wireRecorder(server);
  const mem = lifecycle as InMemoryReplayLifecycleClient;

  i.players.add("s1", "LL_1", "A", {
    synthetic: true,
    accountUserId: "itest_alpha_1",
  });
  i.beginRuntimeMatchIdentity(1);
  await settleRecorder(recorder);
  const matchId = i.runtimeMatchId;
  assertEquals(await rowFor(mem, matchId), null);
  assertEquals(recorder.getActiveRuntimeMatchId(), null);

  i.players.add("s2", "Real", "B", { accountUserId: "user_real" });
  i.noteReplayHumanPresence(5);
  await settleRecorder(recorder);
  assertExists(await rowFor(mem, matchId));
  assertEquals(recorder.getActiveRuntimeMatchId(), matchId);
});

Deno.test("8.1 shutdown: clean shutdown mid-match → failed", async () => {
  const server = makeServer();
  stubSessions(server);
  const i = internals(server);
  const { recorder, lifecycle } = wireRecorder(server);
  const mem = lifecycle as InMemoryReplayLifecycleClient;

  i.players.add("s1", "A1", "A");
  const start = i.players.beginLiveMatch(1, Date.now());
  i.beginRuntimeMatchIdentity(1);
  i.emitMatchStart(start, 1);
  await settleRecorder(recorder);
  const matchId = i.runtimeMatchId;

  recorder.shutdown();
  await settleRecorder(recorder);
  const row = (await rowFor(mem, matchId))!;
  assertEquals(row.status, "failed");
  assertMatch(row.error ?? "", /clean-shutdown/);
  assertEquals(recorder.isAttached(), false);
});

Deno.test("8.1 kill-switch path: disabled → startReplayRecorder returns null", () => {
  const prev = Deno.env.get("REPLAY_RECORDING_ENABLED");
  Deno.env.set("REPLAY_RECORDING_ENABLED", "0");
  try {
    const server = makeServer();
    // NoopAuthorityAdapter has no lifecycle client; disabled env short-circuits first.
    assertEquals(server.startReplayRecorder(), null);
    assertEquals(server.getReplayRecorder(), null);
  } finally {
    if (prev === undefined) Deno.env.delete("REPLAY_RECORDING_ENABLED");
    else Deno.env.set("REPLAY_RECORDING_ENABLED", prev);
  }
});

Deno.test("8.1 kill-switch + Noop: enabled still returns null without lifecycle client", () => {
  const server = makeServer();
  assertEquals(server.startReplayRecorder(), null);
  assertEquals(server.getReplayRecorder(), null);
});

Deno.test("8.1 equivalence: sim outcomes identical with recorder on vs off", async () => {
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
    i.players.add("s2", "B1", "B");
    const start = i.players.beginLiveMatch(1, Date.now());
    i.beginRuntimeMatchIdentity(1);
    i.emitMatchStart(start, 1);
    if (recorder) await settleRecorder(recorder);
    for (let t = 2; t <= 6; t++) driveTick(server, t);
    i.onMatchEnded({
      winner: "A",
      scores: { A: 1, B: 0 },
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

Deno.test("8.1/8.6 source-scan: only completeFinalizationAsync → lifecycle.finalize", async () => {
  const src = await Deno.readTextFile(
    new URL("./ReplayRecorder.ts", import.meta.url),
  );
  // Strip line comments so doc mentions of the terminal status do not trip the scan.
  const code = src.replace(/\/\/.*$/gm, "");
  // Must not pass finalized through lifecycle.update (refuses it).
  assertEquals(
    /lifecycle\.update\s*\([\s\S]*?['"]finalized['"]/.test(code),
    false,
  );
  // Sole writer: lifecycle.finalize from completeFinalizationAsync.
  assertMatch(code, /lifecycle\.finalize/);
  assertMatch(code, /completeFinalizationAsync/);
  // 9.2 may import authoritativeCheckpoint + checkpointInterval; 9.5 may
  // import checkpointIndex; #10 file-format still banned.
  assertEquals(/from\s+['"].*file-format/i.test(code), false);
  const checkpointImports = [
    ...code.matchAll(/from\s+['"]([^'"]*checkpoint[^'"]*)['"]/gi),
  ].map((m) => m[1]!);
  for (const imp of checkpointImports) {
    assertEquals(
      /authoritativeCheckpoint|checkpointInterval|checkpointIndex/.test(imp),
      true,
      `unexpected checkpoint import: ${imp}`,
    );
  }
});
