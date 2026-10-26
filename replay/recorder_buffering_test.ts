/**
 * Epic 8.5 — ReplaySessionBuffer + recorder buffering.
 *
 * Run from server-community/:
 *   deno test -A replay/recorder_buffering_test.ts
 */

import {
  assertEquals,
  assertExists,
  assertMatch,
  assertNotEquals,
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
  MAX_BUFFERED_BYTES_EST,
  MAX_BUFFERED_TICKS,
  MAX_RECORDING_TICKS,
} from "./ReplayRecorder.ts";
import type { InMemoryReplayLifecycleClient } from "./replayLifecycleClient.ts";
import {
  settleRecorder,
  wireReplayRecorder,
  type WireRecorderOptions,
} from "./replayTestHarness.ts";
import {
  estimateEventsBytes,
  estimateInitBytes,
  estimateInputsBytes,
  ReplaySessionBuffer,
} from "./replaySessionBuffer.ts";
import { freezeRecordedTickInputs } from "./recordedTickInputs.ts";
import { freezeRecordedTickEvents } from "./recordedTickEvents.ts";
import type { TickSelectedInput } from "../players/tickAssociation.ts";

const miniMap: DoorsMap = {
  name: "replay-buffering",
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
};

function makeServer(joinMode: "open" | "ranked" = "open"): GameServer {
  return new GameServer({
    name: "replay-buffering",
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


function wireRecorder(
  server: GameServer,
  opts?: WireRecorderOptions,
) {
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
    i.players,
    tick,
    result.events,
  );
  i.deliverReplayIntegrationTick(tick, authEvents);
  return result;
}

function startLive(
  server: GameServer,
  recorder: ReplayRecorder,
): string {
  const i = internals(server);
  stubSessions(server);
  i.players.add("s1", "A1", "A");
  i.players.add("s2", "B1", "B");
  const start = i.players.beginLiveMatch(1, Date.now());
  i.beginRuntimeMatchIdentity(1);
  i.emitMatchStart(start, 1);
  assertEquals(recorder.getActiveRuntimeMatchId(), i.runtimeMatchId);
  return i.runtimeMatchId;
}

function sampleMovement(tick: number, playerId: string): TickSelectedInput {
  return {
    tick,
    playerId,
    selectedInput: {
      sequence: 1,
      forward: true,
      backward: false,
      left: false,
      right: false,
      jump: false,
      sprint: false,
      crouch: false,
      yaw: 0,
      pitch: 0,
    },
    association: "fresh",
    appliedSequence: 1,
    inputHoldTicks: 1,
  };
}

Deno.test("8.5 caps: pinned constants are documented and positive", () => {
  assertEquals(MAX_BUFFERED_TICKS > 0, true);
  assertEquals(MAX_RECORDING_TICKS, MAX_BUFFERED_TICKS);
  assertEquals(MAX_BUFFERED_BYTES_EST > 0, true);
  // 3h @ 60Hz
  assertEquals(MAX_BUFFERED_TICKS, 3 * 60 * 60 * 60);
});

Deno.test("8.5 bound: session at cap holds; cap+1 fails loud + detaches", async () => {
  const server = makeServer();
  const { recorder, lifecycle } = wireRecorder(server, {
    bufferCaps: {
      maxBufferedTicks: 2,
      maxRecordingTicks: 100,
      maxBufferedBytesEst: 64 * 1024 * 1024,
    },
  });
  const matchId = startLive(server, recorder);

  driveTick(server, 2);
  driveTick(server, 3);
  assertEquals(recorder.getActiveRuntimeMatchId(), matchId);
  assertEquals(recorder.getBufferUsage(matchId)?.usageTicks, 2);
  assertExists(recorder.getBufferedSession(matchId));

  driveTick(server, 4); // cap+1
  await settleRecorder(recorder);
  const row = (await (lifecycle as InMemoryReplayLifecycleClient).getByRuntimeMatchId(matchId))!;
  assertEquals(row.status, "failed");
  assertMatch(row.error ?? "", /buffer-cap-exceeded/);
  assertEquals(recorder.isAttached(), false);
  assertEquals(recorder.getBufferedSession(matchId), null);
  assertEquals(recorder.getActiveRuntimeMatchId(), null);
});

Deno.test("8.5 duration: past MAX_RECORDING_TICKS fails recording; live match continues", async () => {
  const server = makeServer();
  stubSessions(server);
  const i = internals(server);
  const { recorder, lifecycle } = wireRecorder(server, {
    bufferCaps: {
      maxRecordingTicks: 2,
      maxBufferedTicks: 100,
      maxBufferedBytesEst: 64 * 1024 * 1024,
    },
  });
  const matchId = startLive(server, recorder);

  driveTick(server, 2);
  driveTick(server, 3);
  assertEquals(recorder.getActiveRuntimeMatchId(), matchId);

  driveTick(server, 4); // duration+1
  await settleRecorder(recorder);
  assertEquals((await (lifecycle as InMemoryReplayLifecycleClient).getByRuntimeMatchId(matchId))!.status, "failed");
  assertMatch(
    (await (lifecycle as InMemoryReplayLifecycleClient).getByRuntimeMatchId(matchId))!.error ?? "",
    /duration-limit/,
  );
  assertEquals(recorder.isAttached(), false);

  // Live sim continues unaffected — further ticks still run, just unrecorded.
  const beforeScores = { ...i.players.getScores() };
  driveTick(server, 5);
  driveTick(server, 6);
  assertEquals(i.players.getScores(), beforeScores);
  assertEquals(i.runtimeMatchId, matchId);

  // Scripted normal end still works for the live game.
  i.onMatchEnded({
    winner: "A",
    scores: { A: 1, B: 0 },
    players: [],
  });
  // Row stays failed — never promoted to finalizing from a truncated buffer.
  await settleRecorder(recorder);
  assertEquals((await (lifecycle as InMemoryReplayLifecycleClient).getByRuntimeMatchId(matchId))!.status, "failed");
});

Deno.test("8.5 fail-loud: pressure/alloc hook → failed + never finalizable", async () => {
  const server = makeServer();
  const { recorder, lifecycle } = wireRecorder(server, {
    bufferBeforeCommit: () => {
      throw new Error("simulated-oom");
    },
  });
  const matchId = startLive(server, recorder);

  driveTick(server, 2);
  await settleRecorder(recorder);
  const row = (await (lifecycle as InMemoryReplayLifecycleClient).getByRuntimeMatchId(matchId))!;
  assertEquals(row.status, "failed");
  assertMatch(row.error ?? "", /alloc-failed/);
  assertEquals(recorder.getBufferedSession(matchId), null);
  assertEquals(recorder.isAttached(), false);
});

Deno.test("8.5/8.6 termination: normal end finalizes via 8.6; buffer discarded", async () => {
  const server = makeServer();
  const i = internals(server);
  const { recorder, lifecycle, blobStore } = wireRecorder(server);
  const matchId = startLive(server, recorder);

  driveTick(server, 2);
  driveTick(server, 3);
  const liveSession = recorder.getBufferedSession(matchId);
  assertExists(liveSession);
  assertEquals(liveSession.status, "recording");
  assertEquals(liveSession.finalizable, false);
  assertEquals(liveSession.usageTicks, 2);
  assertNotEquals(liveSession.inputs.length, 0);

  i.onMatchEnded({
    winner: "A",
    scores: { A: 1, B: 0 },
    players: [],
  });

  // 8.6 runs inline after beginFinalize: row finalized, buffer claimed+discarded.
  await settleRecorder(recorder);
  const row = (await (lifecycle as InMemoryReplayLifecycleClient).getByRuntimeMatchId(matchId))!;
  assertEquals(row.status, "finalized");
  assertExists(row.filePath);
  assertEquals(row.fileSizeBytes != null && row.fileSizeBytes > 0, true);
  assertExists(blobStore);
  assertEquals(blobStore.exists(`${matchId}.replay.json`), true);
  // 8.2–8.4 live accessors miss after detach; parked buffer claimed by 8.6.
  assertEquals(recorder.getInitialState(matchId), null);
  assertEquals(recorder.getInputStream(matchId), null);
  assertEquals(recorder.getBufferedSession(matchId), null);
});

Deno.test("8.5 termination: rotation replaces buffer; reset-without-rotation keeps it", () => {
  // Rotation
  {
    const server = makeServer();
    const i = internals(server);
    const { recorder } = wireRecorder(server);
    const firstId = startLive(server, recorder);
    driveTick(server, 2);
    assertExists(recorder.getBufferedSession(firstId));

    i.beginRuntimeMatchIdentity(50);
    const secondId = i.runtimeMatchId;
    assertNotEquals(firstId, secondId);
    assertEquals(recorder.getBufferedSession(firstId), null);
    assertEquals(recorder.getActiveRuntimeMatchId(), secondId);
    assertExists(recorder.getBufferedSession(secondId));
  }

  // Empty-ranked reset without rotation
  {
    const server = makeServer("ranked");
    const i = internals(server);
    const { recorder } = wireRecorder(server);
    for (const id of ["s1", "s2", "s3", "s4"]) {
      i.players.add(id, id, id === "s2" || id === "s4" ? "B" : "A");
    }
    stubSessions(server);
    const start = i.players.beginLiveMatch(1, Date.now());
    i.beginRuntimeMatchIdentity(1);
    i.emitMatchStart(start, 1);
    const matchId = i.runtimeMatchId;
    driveTick(server, 2);
    const before = recorder.getBufferedSession(matchId);
    assertExists(before);

    for (const id of ["s1", "s2", "s3", "s4"]) {
      i.players.remove(id);
    }
    const reset = (server as unknown as {
      maybeResetEmptyRankedInstance(): boolean;
    }).maybeResetEmptyRankedInstance();
    assertEquals(reset, true);
    assertEquals(i.runtimeMatchId, matchId);
    const after = recorder.getBufferedSession(matchId);
    assertExists(after);
    assertEquals(after.usageTicks, before.usageTicks);
    assertEquals(after.inputs.length, before.inputs.length);
  }
});

Deno.test("8.5 termination: detach/shutdown discards; never finalizable", async () => {
  const server = makeServer();
  const { recorder, lifecycle } = wireRecorder(server);
  const matchId = startLive(server, recorder);
  driveTick(server, 2);
  assertExists(recorder.getBufferedSession(matchId));

  recorder.shutdown();
  assertEquals(recorder.getBufferedSession(matchId), null);
  await settleRecorder(recorder);
  assertEquals((await (lifecycle as InMemoryReplayLifecycleClient).getByRuntimeMatchId(matchId))!.status, "failed");
});

Deno.test("8.5 tail: while recording serves init + streams from start; reads mutate nothing", () => {
  const server = makeServer();
  const { recorder } = wireRecorder(server);
  const matchId = startLive(server, recorder);

  driveTick(server, 2);
  driveTick(server, 3);
  driveTick(server, 4);

  const usageBefore = recorder.getBufferUsage(matchId)!;
  const sessionBefore = recorder.getBufferedSession(matchId)!;

  const tail = recorder.getTailWindow(matchId, 3);
  assertExists(tail);
  assertEquals(tail.runtimeMatchId, matchId);
  assertExists(tail.init);
  assertEquals(tail.inputs.every((r) => r.tick >= 3), true);
  assertEquals(tail.events.every((r) => r.tick >= 3), true);

  // From session start (or earlier) returns full buffered window.
  const full = recorder.getTailWindow(matchId, 0);
  assertExists(full);
  assertEquals(full.inputs.length, sessionBefore.inputs.length);

  // Tail reads do not mutate or evict.
  assertEquals(recorder.getBufferUsage(matchId), usageBefore);
  assertEquals(
    recorder.getBufferedSession(matchId)!.inputs.length,
    sessionBefore.inputs.length,
  );

  // Miss id / after detach
  assertEquals(recorder.getTailWindow("missing", 0), null);
});

Deno.test("8.5/8.6 tail: after finalize session + tail are unavailable", async () => {
  const server = makeServer();
  const i = internals(server);
  const { recorder, lifecycle } = wireRecorder(server);
  const matchId = startLive(server, recorder);
  driveTick(server, 2);

  i.onMatchEnded({
    winner: "draw",
    scores: { A: 0, B: 0 },
    players: [],
  });
  // 8.6 claims+discards the parked buffer; live tail is recording-only.
  await settleRecorder(recorder);
  assertEquals((await (lifecycle as InMemoryReplayLifecycleClient).getByRuntimeMatchId(matchId))!.status, "finalized");
  assertEquals(recorder.getBufferedSession(matchId), null);
  assertEquals(recorder.getTailWindow(matchId, 0), null);
});

Deno.test("8.5 usage: counters agree with 8.1 tick counters and stored rows", () => {
  const server = makeServer();
  const { recorder } = wireRecorder(server);
  const matchId = startLive(server, recorder);

  for (let t = 2; t <= 6; t++) driveTick(server, t);

  const counters = recorder.getActiveCounters()!;
  const usage = recorder.getBufferUsage(matchId)!;
  const session = recorder.getBufferedSession(matchId)!;
  assertEquals(usage.usageTicks, counters.ticksObserved);
  assertEquals(usage.usageTicks, 5);
  assertEquals(session.inputs.length, 5);
  assertEquals(usage.usageBytesEstimate > 0, true);
});

Deno.test("8.5 no-persistence: buffer module has no file/blob/finalized/SQLite writes", async () => {
  const src = await Deno.readTextFile(
    new URL("./replaySessionBuffer.ts", import.meta.url),
  );
  // Import / call sites only — comments may name forbidden APIs as exclusions.
  assertEquals(/Deno\.write(?:File|TextFile)/.test(src), false);
  assertEquals(/status:\s*["']finalized["']/.test(src), false);
  assertEquals(/\bJSON\.stringify\s*\(/.test(src), false);
  assertEquals(/\binsertRecordingRow\b/.test(src), false);
  assertEquals(/\bupdateReplayLifecycle\b/.test(src), false);
  assertEquals(/CREATE TABLE/i.test(src), false);
  // Real await expressions only (comments may say "never awaits").
  assertEquals(/\bawait\s+[A-Za-z_$]/.test(src), false);

  // Buffer module stays free of finalize writes; 8.6 owns finalized.
  assertEquals(/stampReplayFinalized/.test(src), false);
});

Deno.test("8.5 loop-safety: commitTick does no I/O / await; slow consumer does not delay", () => {
  // Unit: many commits with a stalled "consumer" that only reads views.
  const buf = new ReplaySessionBuffer("m-loop", {
    caps: {
      maxBufferedTicks: 10_000,
      maxRecordingTicks: 10_000,
      maxBufferedBytesEst: 64 * 1024 * 1024,
    },
  });
  let consumerSaw = 0;
  const t0 = performance.now();
  for (let tick = 1; tick <= 200; tick++) {
    buf.putInputs(
      freezeRecordedTickInputs(tick, [sampleMovement(tick, "p1")], []),
    );
    const commit = buf.commitTick();
    assertEquals(commit.ok, true);
    // Stalled downstream: repeatedly re-read the whole view (12.7 / 8.6 stub).
    const view = buf.toView();
    consumerSaw += view.inputs.length;
    const tail = buf.getTailWindow(0);
    consumerSaw += tail?.inputs.length ?? 0;
  }
  const elapsed = performance.now() - t0;
  assertEquals(buf.usageTicks, 200);
  assertEquals(consumerSaw > 0, true);
  // Sanity: 200 reference-appends stay well under a generous wall budget.
  assertEquals(elapsed < 500, true, `commit loop took ${elapsed}ms`);
});

Deno.test("8.5 byte estimate: helpers scale with row counts (no serialize)", () => {
  const inputs = freezeRecordedTickInputs(
    1,
    [sampleMovement(1, "a"), sampleMovement(1, "b")],
    [],
  );
  const events = freezeRecordedTickEvents(1, [
    { kind: "playerDied", appliedTick: 1 } as AuthoritativeEvent,
  ]);
  assertEquals(estimateInputsBytes(inputs) > estimateInputsBytes(
    freezeRecordedTickInputs(1, [sampleMovement(1, "a")], []),
  ), true);
  assertEquals(estimateEventsBytes(events) > 0, true);
  assertEquals(typeof estimateInitBytes, "function");
});

Deno.test("8.5 never-finalize-truncated: failed buffer is not handed as finalizable", async () => {
  const server = makeServer();
  const { recorder, lifecycle } = wireRecorder(server, {
    bufferCaps: { maxBufferedTicks: 1, maxRecordingTicks: 100 },
  });
  const matchId = startLive(server, recorder);
  driveTick(server, 2);
  driveTick(server, 3); // fail

  await settleRecorder(recorder);
  assertEquals((await (lifecycle as InMemoryReplayLifecycleClient).getByRuntimeMatchId(matchId))!.status, "failed");
  const session = recorder.getBufferedSession(matchId);
  assertEquals(session, null);
});

Deno.test("8.5 equivalence: buffering on vs tiny-cap-fail still preserves live sim path", () => {
  // Drive the same scripted ticks with recording enabled; after cap-fail the
  // live scores/identity remain coherent (recorder never ends the match).
  const server = makeServer();
  stubSessions(server);
  const i = internals(server);
  const { recorder } = wireRecorder(server, {
    bufferCaps: { maxRecordingTicks: 1, maxBufferedTicks: 100 },
  });
  startLive(server, recorder);
  driveTick(server, 2);
  driveTick(server, 3); // recording fails here
  assertEquals(recorder.isAttached(), false);

  const id = i.runtimeMatchId;
  driveTick(server, 4);
  driveTick(server, 5);
  assertEquals(i.runtimeMatchId, id);
  // Phase still live — recorder did not force end.
  assertEquals(i.players.getMatchPhase(), "live");
});
