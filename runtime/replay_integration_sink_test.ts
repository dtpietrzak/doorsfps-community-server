/**
 * Epic 7.5 — replay integration sink fan-out.
 *
 * Run from server-community/:
 *   deno test -A replay_integration_sink_test.ts
 *
 * Locks: attach/detach, five-family delivery, no-sink fast path, read-only
 * payloads, exception isolation, single-source forwarding, and live-path
 * equivalence with/without a sink.
 */

import {
  assertEquals,
  assertExists,
  assertNotEquals,
} from "@std/assert";
import { GameServer } from "./GameServer.ts";
import { NoopAuthorityAdapter } from "../authority/adapter.ts";
import { PlayerManager } from "../players/PlayerManager.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";
import type { SimTickResult } from "../players/simTickResult.ts";
import { drainTickAuthoritativeEvents } from "../players/authoritativeEventSource.ts";
import type {
  ReplayCheckpointPayload,
  ReplayIntegrationSink,
  ReplayLifecyclePayload,
  ReplayMatchInitPayload,
  ReplayTickPayload,
} from "../replay/replayIntegration.ts";
import type { AuthoritativeEvent } from "../shared/sim/authoritativeEvent.ts";

const miniMap: DoorsMap = {
  name: "replay-sink",
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
  handleMatchReady(playerId: string, ready: boolean): void;
  onMatchEnded(
    packet: { winner: "A" | "B" | "draw"; scores: { A: number; B: number }; players: unknown[] },
    nowMs?: number,
  ): void;
  replaySink: ReplayIntegrationSink | null;
  replayPayloadConstructionCount: number;
};

function makeServer(joinMode: "open" | "ranked" = "open"): GameServer {
  return new GameServer({
    name: "replay-sink",
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

type Recorded = {
  inits: ReplayMatchInitPayload[];
  starts: ReplayLifecyclePayload[];
  ends: ReplayLifecyclePayload[];
  draws: ReplayLifecyclePayload[];
  ticks: ReplayTickPayload[];
  checkpoints: ReplayCheckpointPayload[];
};

function emptyRecorded(): Recorded {
  return {
    inits: [],
    starts: [],
    ends: [],
    draws: [],
    ticks: [],
    checkpoints: [],
  };
}

function makeRecordingSink(
  recorded: Recorded,
  opts?: { throwOnTick?: boolean; mutateTickInputs?: boolean },
): ReplayIntegrationSink {
  return {
    onMatchInit(payload) {
      recorded.inits.push(payload);
    },
    onMatchStart(payload) {
      recorded.starts.push(payload);
    },
    onMatchEnd(payload) {
      recorded.ends.push(payload);
    },
    onMatchDraw(payload) {
      recorded.draws.push(payload);
    },
    onTick(payload) {
      if (opts?.mutateTickInputs) {
        (payload.inputs as Map<string, unknown>).set("__mutated__", null);
      }
      if (opts?.throwOnTick) {
        throw new Error("sink boom");
      }
      recorded.ticks.push(payload);
    },
    onCheckpoint(payload) {
      recorded.checkpoints.push(payload);
    },
  };
}

function driveTick(server: GameServer, tick: number): SimTickResult {
  const i = internals(server);
  const result = i.stepSim(tick, Date.now());
  const authEvents = drainTickAuthoritativeEvents(i.players, tick, result.events);
  i.deliverReplayIntegrationTick(tick, authEvents);
  return result;
}

Deno.test("7.5 attach: sink receives init/rotation/start/tick/end families", () => {
  const server = makeServer("open");
  stubSessions(server);
  const i = internals(server);
  const recorded = emptyRecorded();
  server.attachReplaySink(makeRecordingSink(recorded));

  const pA = i.players.add("s1", "A1", "A");
  const pB = i.players.add("s2", "B1", "B");
  assertExists(pA);
  assertExists(pB);

  const beforeId = i.runtimeMatchId;
  const startPacket = i.players.beginLiveMatch(10, Date.now());
  i.beginRuntimeMatchIdentity(10);
  i.emitMatchStart(startPacket, 10);
  assertNotEquals(i.runtimeMatchId, beforeId);

  driveTick(server, 11);
  driveTick(server, 12);

  i.onMatchEnded({
    winner: "A",
    scores: { A: 5, B: 0 },
    players: [],
  });

  assertEquals(recorded.inits.length >= 1, true);
  assertEquals(
    recorded.starts.some((s) => s.transition === "runtimeMatchIdRotated"),
    true,
  );
  assertEquals(
    recorded.starts.some((s) => s.transition === "matchStart"),
    true,
  );
  assertEquals(recorded.ticks.length, 2);
  assertEquals(recorded.ticks[0]!.tick, 11);
  assertEquals(recorded.ticks[1]!.tick, 12);
  assertEquals(recorded.ends.length, 1);
  assertEquals(recorded.ends[0]!.transition, "matchEnd");
  assertEquals(recorded.draws.length, 0);
});

Deno.test("7.5 attach: draw uses onMatchDraw", () => {
  const server = makeServer("open");
  stubSessions(server);
  const recorded = emptyRecorded();
  server.attachReplaySink(makeRecordingSink(recorded));

  internals(server).onMatchEnded({
    winner: "draw",
    scores: { A: 3, B: 3 },
    players: [],
  });

  assertEquals(recorded.draws.length, 1);
  assertEquals(recorded.draws[0]!.transition, "matchDraw");
  assertEquals(recorded.ends.length, 0);
});

Deno.test("7.5 detach mid-match stops callbacks; live continues", () => {
  const server = makeServer("open");
  stubSessions(server);
  const i = internals(server);
  const recorded = emptyRecorded();
  server.attachReplaySink(makeRecordingSink(recorded));

  i.players.add("s1", "A1", "A");
  const startPacket = i.players.beginLiveMatch(5, Date.now());
  i.beginRuntimeMatchIdentity(5);
  i.emitMatchStart(startPacket, 5);
  driveTick(server, 6);
  const ticksBefore = recorded.ticks.length;

  server.detachReplaySink();
  const constructionsBefore = server.getReplayPayloadConstructionCount();
  driveTick(server, 7);
  driveTick(server, 8);

  assertEquals(recorded.ticks.length, ticksBefore);
  assertEquals(server.getReplayPayloadConstructionCount(), constructionsBefore);
  assertEquals(i.players.isLive(), true);
  assertEquals(i.replaySink, null);
});

Deno.test("7.5 no-sink: zero payload construction across ticks", () => {
  const server = makeServer("open");
  stubSessions(server);
  const i = internals(server);
  i.players.add("s1", "A1", "A");
  i.players.beginLiveMatch(1, Date.now());

  assertEquals(server.getReplayPayloadConstructionCount(), 0);
  driveTick(server, 2);
  driveTick(server, 3);
  driveTick(server, 4);
  assertEquals(server.getReplayPayloadConstructionCount(), 0);
});

Deno.test("7.5 read-only: mutating sink payload does not alter sim selection", () => {
  const server = makeServer("open");
  stubSessions(server);
  const i = internals(server);
  const recorded = emptyRecorded();
  server.attachReplaySink(
    makeRecordingSink(recorded, { mutateTickInputs: true }),
  );

  const p = i.players.add("s1", "A1", "A");
  i.players.beginLiveMatch(1, Date.now());
  driveTick(server, 2);

  assertEquals(recorded.ticks.length, 1);
  const afterTick = p.lastTickInputSelection();
  // Sink map is a defensive copy — mutating it must not touch Player state.
  assertEquals(recorded.ticks[0]!.inputs.has("__mutated__"), true);
  assertEquals(p.lastTickInputSelection(), afterTick);
  assertEquals(recorded.ticks[0]!.inputs.get(p.id), afterTick);
});

Deno.test("7.5 isolation: throwing sink does not break subsequent ticks", () => {
  const server = makeServer("open");
  stubSessions(server);
  const i = internals(server);
  const recorded = emptyRecorded();
  server.attachReplaySink(makeRecordingSink(recorded, { throwOnTick: true }));

  i.players.add("s1", "A1", "A");
  i.players.beginLiveMatch(1, Date.now());

  driveTick(server, 2);
  driveTick(server, 3);

  assertEquals(recorded.ticks.length, 0); // throw prevented push
  assertEquals(server.getReplaySinkErrorCount() >= 2, true);
  // Live sim still advances.
  assertEquals(i.players.isLive(), true);
});

Deno.test("7.5 single-source: tick events deep-equal unified drain output", () => {
  const server = makeServer("open");
  stubSessions(server);
  const i = internals(server);
  const recorded = emptyRecorded();
  server.attachReplaySink(makeRecordingSink(recorded));

  i.players.add("s1", "A1", "A");
  i.players.beginLiveMatch(1, Date.now());

  const tick = 10;
  const result = i.stepSim(tick, Date.now());
  const authEvents = drainTickAuthoritativeEvents(i.players, tick, result.events);
  // Drain already consumed the buffer — reconstruct expected by re-mapping
  // only SimTickResult facts (buffer empty). Compare shapes via second drive
  // is awkward; instead deliver the captured list and assert identity of
  // length/order against what the sink recorded.
  i.deliverReplayIntegrationTick(tick, authEvents);

  assertEquals(recorded.ticks.length, 1);
  assertEquals(recorded.ticks[0]!.events.length, authEvents.length);
  for (let idx = 0; idx < authEvents.length; idx++) {
    assertEquals(recorded.ticks[0]!.events[idx], authEvents[idx]);
  }

  // Inputs: every roster player present.
  for (const p of i.players.all()) {
    assertEquals(recorded.ticks[0]!.inputs.has(p.id), true);
    assertEquals(
      recorded.ticks[0]!.inputs.get(p.id),
      p.lastTickInputSelection(),
    );
  }
});

Deno.test("7.5/9.1 checkpoint: captureCheckpoint notifies sink with authoritative checkpoint", () => {
  const server = makeServer("open");
  stubSessions(server);
  const i = internals(server);
  const recorded = emptyRecorded();
  server.attachReplaySink(makeRecordingSink(recorded));

  i.players.add("s1", "A1", "A");
  i.players.beginLiveMatch(1, Date.now());
  // 9.1 boundary: capture is post-drain only.
  i.players.drainAuthoritativeEvents();

  const checkpoint = server.captureCheckpoint(5);
  assertExists(checkpoint);
  assertEquals(checkpoint.schemaVersion, 1);
  assertEquals(checkpoint.tick, 5);
  assertEquals(checkpoint.runtimeMatchId, i.runtimeMatchId);
  assertEquals(recorded.checkpoints.length, 1);
  assertEquals(recorded.checkpoints[0]!.tick, 5);
  assertEquals(recorded.checkpoints[0]!.checkpoint, checkpoint);
});

Deno.test("7.5/9.1 checkpoint: no sink → capture still returns checkpoint, no construction", () => {
  const server = makeServer("open");
  stubSessions(server);
  const i = internals(server);
  i.players.beginLiveMatch(1, Date.now());
  i.players.drainAuthoritativeEvents();
  const before = server.getReplayPayloadConstructionCount();
  const checkpoint = server.captureCheckpoint(3);
  assertExists(checkpoint);
  assertEquals(checkpoint.tick, 3);
  assertEquals(server.getReplayPayloadConstructionCount(), before);
});

Deno.test("7.5 equivalence: sim phase/scores identical with and without sink", () => {
  function runSeason(withSink: boolean): {
    phase: string;
    scores: { A: number; B: number };
    constructions: number;
  } {
    const server = makeServer("open");
    stubSessions(server);
    const i = internals(server);
    if (withSink) {
      server.attachReplaySink(makeRecordingSink(emptyRecorded()));
    }
    i.players.add("s1", "A1", "A");
    i.players.add("s2", "B1", "B");
    const start = i.players.beginLiveMatch(1, Date.now());
    i.beginRuntimeMatchIdentity(1);
    i.emitMatchStart(start, 1);
    for (let t = 2; t <= 6; t++) driveTick(server, t);
    return {
      phase: i.players.getMatchPhase(),
      scores: i.players.getScores(),
      constructions: server.getReplayPayloadConstructionCount(),
    };
  }

  const a = runSeason(false);
  const b = runSeason(true);
  assertEquals(a.phase, b.phase);
  assertEquals(a.scores, b.scores);
  assertEquals(a.constructions, 0);
  assertEquals(b.constructions > 0, true);
});

Deno.test("7.5 backpressure-absence: slow sink runs inline (no hidden queue)", () => {
  const server = makeServer("open");
  stubSessions(server);
  const i = internals(server);
  let entered = 0;
  let left = 0;
  server.attachReplaySink({
    onMatchInit() {},
    onMatchStart() {},
    onMatchEnd() {},
    onMatchDraw() {},
    onTick() {
      entered++;
      // Busy-wait briefly to prove inline delivery (no async queue).
      const start = performance.now();
      while (performance.now() - start < 2) {
        // spin
      }
      left++;
    },
    onCheckpoint() {},
  });

  i.players.add("s1", "A1", "A");
  i.players.beginLiveMatch(1, Date.now());
  driveTick(server, 2);
  // If a hidden queue existed, left could lag entered; with inline fan-out
  // they match immediately after the call returns.
  assertEquals(entered, 1);
  assertEquals(left, 1);
});

Deno.test("7.5 ranked ready-start: rotation + live matchStart; prematch restart skips live start", () => {
  const server = makeServer("ranked");
  stubSessions(server);
  const i = internals(server);
  const recorded = emptyRecorded();
  server.attachReplaySink(makeRecordingSink(recorded));

  for (const id of ["s1", "s2", "s3", "s4"]) {
    i.players.add(id, id, id === "s2" || id === "s4" ? "B" : "A");
  }
  // Ready three via manager; the fourth goes through handleMatchReady so the
  // driver rotation + emitMatchStart path runs (duplicate ready is a no-op).
  for (const id of ["s1", "s2", "s3"]) {
    i.players.setMatchReady(id, true);
  }
  i.handleMatchReady("s4", true);

  assertEquals(i.players.getMatchPhase(), "live");
  assertEquals(recorded.inits.length >= 1, true);
  assertEquals(
    recorded.starts.some((s) => s.transition === "matchStart"),
    true,
  );

  // Simulate intermission → ranked prematch restart (startNewMatch → prematch).
  const recorded2 = emptyRecorded();
  server.attachReplaySink(makeRecordingSink(recorded2));
  const pre = i.players.startNewMatch(100, Date.now());
  assertEquals(i.players.getMatchPhase(), "prematch");
  i.beginRuntimeMatchIdentity(100);
  i.emitMatchStart(pre, 100);
  assertEquals(
    recorded2.starts.some((s) => s.transition === "matchStart"),
    false,
  );
  assertEquals(
    recorded2.starts.some((s) => s.transition === "runtimeMatchIdRotated"),
    true,
  );
  assertEquals(recorded2.inits.length, 1);
});
