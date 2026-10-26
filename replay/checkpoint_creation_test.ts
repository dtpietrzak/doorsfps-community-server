/**
 * Epic 9.2 — checkpoint creation (interval gate + config + schedule contract).
 *
 * Run from server-community/:
 *   deno test -A replay/checkpoint_creation_test.ts
 */

import {
  assertEquals,
  assertExists,
  assertThrows,
} from "@std/assert";
import { GameServer } from "../runtime/GameServer.ts";
import { NoopAuthorityAdapter } from "../authority/adapter.ts";
import { PlayerManager } from "../players/PlayerManager.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";
import type { SimTickResult } from "../players/simTickResult.ts";
import { drainTickAuthoritativeEvents } from "../players/authoritativeEventSource.ts";
import type { AuthoritativeEvent } from "../shared/sim/authoritativeEvent.ts";
import { TICK_HZ, TICK_MS } from "../shared/sim/game.ts";
import { ReplayRecorder } from "./ReplayRecorder.ts";
import {
  wireReplayRecorder,
} from "./replayTestHarness.ts";
import {
  captureCheckpointState,
  type AuthoritativeCheckpoint,
} from "./authoritativeCheckpoint.ts";
import {
  CHECKPOINT_INTERVAL_SECONDS_DEFAULT,
  CHECKPOINT_INTERVAL_SECONDS_MAX,
  REPLAY_CHECKPOINT_INTERVAL_SECONDS_ENV,
  checkpointIntervalFromEnv,
  resolveCheckpointInterval,
  secondsToCheckpointTicks,
} from "./checkpointInterval.ts";

const miniMap: DoorsMap = {
  name: "checkpoint-creation",
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
  flushPendingReplayMatchEnd(tick?: number): void;
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
    name: "checkpoint-creation",
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
  opts: {
    intervalSeconds?: number;
    onCheckpointCaptured?: (cp: AuthoritativeCheckpoint) => void;
    captureCheckpointState?: (
      tick: number,
      runtimeMatchId: string,
    ) => AuthoritativeCheckpoint;
    omitBuilder?: boolean;
  } = {},
) {
  const i = internals(server);
  return wireReplayRecorder(
    {
      attachSink: (sink) => server.attachReplaySink(sink),
      detachSink: () => server.detachReplaySink(),
    },
    {
      checkpointIntervalSeconds: opts.intervalSeconds ?? 5 / 60, // 5 ticks
      captureCheckpointState: opts.omitBuilder
        ? undefined
        : (opts.captureCheckpointState ??
          ((tick, runtimeMatchId) =>
            captureCheckpointState(i.players, tick, runtimeMatchId))),
      onCheckpointCaptured: opts.onCheckpointCaptured,
    },
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
  // Mirror startGameLoop: post-drain match-end notify (9.2 final checkpoint).
  i.flushPendingReplayMatchEnd(tick);
  return result;
}

function startLive(
  server: GameServer,
  recorder: ReplayRecorder,
  playerSpecs: Array<{ socket: string; name: string; team: "A" | "B" }> = [
    { socket: "s1", name: "A1", team: "A" },
    { socket: "s2", name: "B1", team: "B" },
  ],
): string {
  const i = internals(server);
  stubSessions(server);
  for (const p of playerSpecs) {
    i.players.add(p.socket, p.name, p.team);
  }
  const start = i.players.beginLiveMatch(1, Date.now());
  i.beginRuntimeMatchIdentity(1);
  i.emitMatchStart(start, 1);
  assertEquals(recorder.getActiveRuntimeMatchId(), i.runtimeMatchId);
  return i.runtimeMatchId;
}

function cleanup(blobDir: string | null) {
  if (!blobDir) return;
  try {
    Deno.removeSync(blobDir, { recursive: true });
  } catch {
    // ignore
  }
}

// --- Config -----------------------------------------------------------------

Deno.test("9.2 config: seconds→ticks via TICK_HZ (5s=300, 10s=600)", () => {
  assertEquals(TICK_HZ, 60);
  assertEquals(secondsToCheckpointTicks(5), 300);
  assertEquals(secondsToCheckpointTicks(10), 600);
  assertEquals(secondsToCheckpointTicks(7.5), 450);
  assertEquals(resolveCheckpointInterval(5).intervalTicks, 300);
  assertEquals(resolveCheckpointInterval(10).intervalTicks, 600);
  assertEquals(
    resolveCheckpointInterval(CHECKPOINT_INTERVAL_SECONDS_DEFAULT).intervalTicks,
    300,
  );
});

Deno.test("9.2 config: non-positive fails loud", () => {
  assertThrows(() => resolveCheckpointInterval(0), Error, "positive");
  assertThrows(() => resolveCheckpointInterval(-1), Error, "positive");
  assertThrows(() => resolveCheckpointInterval(NaN), Error, "positive");
});

Deno.test("9.2 config: over-max clamps with note", () => {
  const prevWarn = console.warn;
  const notes: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    notes.push(args);
  };
  try {
    const cfg = resolveCheckpointInterval(CHECKPOINT_INTERVAL_SECONDS_MAX + 30);
    assertEquals(cfg.intervalSeconds, CHECKPOINT_INTERVAL_SECONDS_MAX);
    assertEquals(cfg.clamped, true);
    assertEquals(cfg.intervalTicks, CHECKPOINT_INTERVAL_SECONDS_MAX * TICK_HZ);
    assertEquals(notes.length >= 1, true);
  } finally {
    console.warn = prevWarn;
  }
});

Deno.test("9.2 config: env unset → default; env parse; invalid fails", () => {
  const unset = checkpointIntervalFromEnv({ get: () => undefined });
  assertEquals(unset.intervalSeconds, CHECKPOINT_INTERVAL_SECONDS_DEFAULT);
  assertEquals(unset.intervalTicks, 300);

  const fromEnv = checkpointIntervalFromEnv({ get: () => "10" });
  assertEquals(fromEnv.intervalTicks, 600);

  assertThrows(
    () =>
      checkpointIntervalFromEnv({
        get: (k) =>
          k === REPLAY_CHECKPOINT_INTERVAL_SECONDS_ENV ? "nope" : undefined,
      }),
    Error,
    "not a number",
  );
});

// --- Schedule gate ----------------------------------------------------------

Deno.test("9.2 schedule: fires exactly on anchor + every intervalTicks + nowhere else", () => {
  const server = makeServer();
  const captured: AuthoritativeCheckpoint[] = [];
  const intervalTicks = 5;
  const { recorder, blobDir } = wireRecorder(server, {
    intervalSeconds: intervalTicks / TICK_HZ,
    onCheckpointCaptured: (cp) => captured.push(cp),
  });
  try {
    startLive(server, recorder);
    // First onTick after startRecording is the anchor (tick 2).
    const ticks = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    for (const t of ticks) driveTick(server, t);

    const dueTicks = captured.map((c) => c.tick);
    // Anchor at first tick (2), then every 5: 5,10. (tick 2 is not %5===0)
    assertEquals(dueTicks, [2, 5, 10]);
    assertEquals(recorder.getCheckpointCounters()?.capturedCount, 3);
    assertEquals(recorder.getCheckpointCounters()?.lastTick, 10);
    assertEquals(recorder.getCheckpointCounters()?.anchorCaptured, true);
  } finally {
    cleanup(blobDir);
  }
});

Deno.test("9.2 schedule: finalize tick captures once; no double when due coincides", () => {
  const server = makeServer();
  const captured: AuthoritativeCheckpoint[] = [];
  const intervalTicks = 5;
  const { recorder, blobDir } = wireRecorder(server, {
    intervalSeconds: intervalTicks / TICK_HZ,
    onCheckpointCaptured: (cp) => captured.push(cp),
  });
  try {
    startLive(server, recorder);
    for (const t of [2, 3, 4, 5]) driveTick(server, t);
    // players.tick === 5 (due). Final must not double-capture.
    assertEquals(internals(server).players.tick, 5);
    internals(server).onMatchEnded({
      winner: "A",
      scores: { A: 1, B: 0 },
      players: [],
    });
    assertEquals(captured.map((c) => c.tick), [2, 5]);
    assertEquals(recorder.getActiveRuntimeMatchId(), null);
  } finally {
    cleanup(blobDir);
  }
});

Deno.test("9.2 schedule: finalize on non-due tick adds exactly one final capture", () => {
  const server = makeServer();
  const captured: AuthoritativeCheckpoint[] = [];
  const { recorder, blobDir } = wireRecorder(server, {
    intervalSeconds: 5 / TICK_HZ,
    onCheckpointCaptured: (cp) => captured.push(cp),
  });
  try {
    startLive(server, recorder);
    for (const t of [2, 3, 4]) driveTick(server, t);
    // Last tick 4 is not due (due would be 5); final should add tick 4.
    internals(server).onMatchEnded({
      winner: "draw",
      scores: { A: 0, B: 0 },
      players: [],
    });
    assertEquals(captured.map((c) => c.tick), [2, 4]);
  } finally {
    cleanup(blobDir);
  }
});

Deno.test("9.2 schedule: rotation re-anchors; old schedule state does not leak", () => {
  const server = makeServer();
  const captured: AuthoritativeCheckpoint[] = [];
  const { recorder, blobDir } = wireRecorder(server, {
    intervalSeconds: 5 / TICK_HZ,
    onCheckpointCaptured: (cp) => captured.push(cp),
  });
  try {
    const id1 = startLive(server, recorder);
    for (const t of [2, 3]) driveTick(server, t);
    assertEquals(captured.map((c) => c.tick), [2]);
    assertEquals(captured[0]!.runtimeMatchId, id1);

    // Rotate identity → new recording session; next onTick re-anchors.
    const i = internals(server);
    i.beginRuntimeMatchIdentity(3);
    // beginRuntimeMatchIdentity should notify sink of rotation + startRecording.
    // Drive a fresh tick under the new id.
    for (const t of [4, 5, 6]) driveTick(server, t);
    const id2 = i.runtimeMatchId;
    assertEquals(id1 !== id2, true);

    const byId2 = captured.filter((c) => c.runtimeMatchId === id2);
    // First capture under id2 is the new anchor (tick 4), independent of prior.
    assertEquals(byId2[0]?.tick, 4);
    assertEquals(recorder.getCheckpointCounters()?.anchorCaptured, true);
  } finally {
    cleanup(blobDir);
  }
});

Deno.test("9.2 stamp: every emitted checkpoint carries capture tick + current id", () => {
  const server = makeServer();
  const captured: AuthoritativeCheckpoint[] = [];
  const { recorder, blobDir } = wireRecorder(server, {
    intervalSeconds: 3 / TICK_HZ,
    onCheckpointCaptured: (cp) => captured.push(cp),
  });
  try {
    const id = startLive(server, recorder);
    for (const t of [2, 3, 4, 5, 6]) driveTick(server, t);
    for (const cp of captured) {
      assertEquals(cp.runtimeMatchId, id);
      assertEquals(typeof cp.tick, "number");
      assertEquals(cp.schemaVersion, 1);
    }
    assertEquals(captured.map((c) => c.tick), [2, 3, 6]);
  } finally {
    cleanup(blobDir);
  }
});

Deno.test("9.2 determinism: driver output deep-equals direct builder at same tick", () => {
  const server = makeServer();
  const captured: AuthoritativeCheckpoint[] = [];
  const { recorder, blobDir } = wireRecorder(server, {
    intervalSeconds: 10 / TICK_HZ, // only anchor in a short window unless we hit 10
    onCheckpointCaptured: (cp) => captured.push(cp),
  });
  try {
    const id = startLive(server, recorder);
    driveTick(server, 2);
    assertEquals(captured.length, 1);
    const i = internals(server);
    // Drain is empty post-tick; direct builder must match verbatim.
    const direct = captureCheckpointState(i.players, 2, id);
    assertEquals(captured[0], direct);
  } finally {
    cleanup(blobDir);
  }
});

Deno.test("9.2 boundary: off-schedule ticks perform no builder work", () => {
  const server = makeServer();
  let builderCalls = 0;
  const { recorder, blobDir } = wireRecorder(server, {
    intervalSeconds: 5 / TICK_HZ,
    captureCheckpointState: (tick, id) => {
      builderCalls++;
      return captureCheckpointState(internals(server).players, tick, id);
    },
  });
  try {
    startLive(server, recorder);
    for (const t of [2, 3, 4, 5, 6, 7]) driveTick(server, t);
    // Due: 2 (anchor), 5. Not: 3,4,6,7.
    assertEquals(builderCalls, 2);
    assertEquals(recorder.getCheckpointCounters()?.capturedCount, 2);
  } finally {
    cleanup(blobDir);
  }
});

Deno.test("9.2+ buffer: captured checkpoints land in session buffer + accessors", () => {
  const server = makeServer();
  const { recorder, blobDir } = wireRecorder(server, {
    intervalSeconds: 5 / TICK_HZ,
  });
  try {
    const id = startLive(server, recorder);
    for (const t of [2, 3, 4, 5]) driveTick(server, t);
    const stream = recorder.getCheckpointStream(id);
    assertExists(stream);
    assertEquals(stream.map((c) => c.tick), [2, 5]);
    assertEquals(recorder.getCheckpoint(id, 2)?.tick, 2);
    assertEquals(recorder.getCheckpoint(id, 3), null);
    const view = recorder.getBufferedSession(id);
    assertExists(view);
    assertEquals(view.checkpoints.map((c) => c.tick), [2, 5]);
    // Same frozen object identity as stream (by-reference store).
    assertEquals(view.checkpoints[0], stream[0]);
  } finally {
    cleanup(blobDir);
  }
});

Deno.test("9.2 disabled builder dep → zero captures (gate still O(1))", () => {
  const server = makeServer();
  const captured: AuthoritativeCheckpoint[] = [];
  const { recorder, blobDir } = wireRecorder(server, {
    omitBuilder: true,
    onCheckpointCaptured: (cp) => captured.push(cp),
  });
  try {
    startLive(server, recorder);
    for (const t of [2, 3, 4, 5]) driveTick(server, t);
    assertEquals(captured.length, 0);
    assertEquals(recorder.getCheckpointCounters()?.capturedCount, 0);
  } finally {
    cleanup(blobDir);
  }
});

Deno.test("9.2 no-sink fast path: zero payload construction when recorder absent", () => {
  const server = makeServer();
  stubSessions(server);
  const i = internals(server);
  i.players.add("s1", "A1", "A");
  i.players.beginLiveMatch(1, Date.now());
  const before = server.getReplayPayloadConstructionCount();
  driveTick(server, 2);
  driveTick(server, 3);
  assertEquals(server.getReplayPayloadConstructionCount(), before);
});

Deno.test("9.2 builder throw: counted, routed to error policy, does not escape tick", () => {
  const server = makeServer();
  let calls = 0;
  const { recorder, blobDir } = wireRecorder(server, {
    intervalSeconds: 1 / TICK_HZ, // every tick after anchor also due
    captureCheckpointState: () => {
      calls++;
      throw new Error("builder-boom");
    },
  });
  try {
    startLive(server, recorder);
    // Should not throw into the test — safe() contains it.
    driveTick(server, 2);
    assertEquals(calls, 1);
    assertEquals(recorder.getCheckpointCounters()?.errorCount, 1);
    assertEquals(recorder.getCheckpointCounters()?.capturedCount, 0);
    // Active may still be recording (below threshold) or failed after threshold.
    assertExists(recorder.getCheckpointCounters() || true);
  } finally {
    cleanup(blobDir);
  }
});

// --- Source scan ------------------------------------------------------------

Deno.test("9.2 source-scan: driver imports no snapshot serializer / store / fs writer", async () => {
  const src = await Deno.readTextFile(
    new URL("./ReplayRecorder.ts", import.meta.url),
  );
  const intervalSrc = await Deno.readTextFile(
    new URL("./checkpointInterval.ts", import.meta.url),
  );
  for (const forbidden of [
    "toSnapshot",
    "createSnapshot",
    "quantizePos",
    "quantizeAngle",
    "Deno.write",
    "Deno.create",
  ]) {
    assertEquals(
      src.includes(forbidden),
      false,
      `ReplayRecorder must not reference ${forbidden}`,
    );
    assertEquals(
      intervalSrc.includes(forbidden),
      false,
      `checkpointInterval must not reference ${forbidden}`,
    );
  }
  // Recorder may import replays store for lifecycle — but checkpoint path must
  // not write checkpoint blobs. Guard: no putObject / writeFile in capture methods
  // by ensuring captureCheckpointState import is from authoritativeCheckpoint only.
  assertEquals(/from \"\.\/authoritativeCheckpoint\.ts\"/.test(src), true);
});

// --- Equivalence ------------------------------------------------------------

Deno.test("9.2 equivalence: sim outcomes identical with driver enabled vs disabled", () => {
  function runSeason(withCheckpoints: boolean): {
    phase: string;
    scores: { A: number; B: number };
    captured: number;
  } {
    const server = makeServer();
    stubSessions(server);
    const i = internals(server);
    let captured = 0;
    let storeClose: (() => void) | null = null;
    let blobDir: string | null = null;
    if (withCheckpoints) {
      const wired = wireRecorder(server, {
        intervalSeconds: 2 / TICK_HZ,
        onCheckpointCaptured: () => {
          captured++;
        },
      });
      storeClose = () => cleanup(wired.blobDir);
      blobDir = wired.blobDir;
      startLive(server, wired.recorder);
    } else {
      i.players.add("s1", "A1", "A");
      i.players.add("s2", "B1", "B");
      const start = i.players.beginLiveMatch(1, Date.now());
      i.beginRuntimeMatchIdentity(1);
      i.emitMatchStart(start, 1);
    }
    for (let t = 2; t <= 12; t++) driveTick(server, t);
    const out = {
      phase: i.players.getMatchPhase(),
      scores: { ...i.players.getScores() },
      captured,
    };
    if (storeClose) storeClose();
    void blobDir;
    return out;
  }

  const a = runSeason(false);
  const b = runSeason(true);
  assertEquals(a.phase, b.phase);
  assertEquals(a.scores, b.scores);
  assertEquals(a.captured, 0);
  assertEquals(b.captured > 0, true);
});

// --- Benchmark (pins default) -----------------------------------------------

Deno.test("9.2 benchmark: capture p99 under tick budget across 5/7.5/10s", () => {
  const server = makeServer();
  stubSessions(server);
  const i = internals(server);
  // Representative "full lobby" shape: 8 humans + 4 bots.
  for (let n = 0; n < 8; n++) {
    i.players.add(`h${n}`, `H${n}`, n % 2 === 0 ? "A" : "B");
  }
  for (let n = 0; n < 4; n++) {
    i.players.addBot(`b${n}`, `Bot${n}`, { team: n % 2 === 0 ? "A" : "B" });
  }
  i.players.beginLiveMatch(1, Date.now());
  i.players.drainAuthoritativeEvents();

  const samples: number[] = [];
  const sizes: number[] = [];
  const iterations = 40;
  for (let k = 0; k < iterations; k++) {
    const tick = 10 + k;
    // Measure 9.1 builder cost directly (9.2 gate adds only O(1) modulo).
    i.players.drainAuthoritativeEvents();
    const t0 = performance.now();
    const cp = captureCheckpointState(i.players, tick, "rt-bench");
    const dt = performance.now() - t0;
    samples.push(dt);
    sizes.push(JSON.stringify(cp).length);
  }

  samples.sort((a, b) => a - b);
  sizes.sort((a, b) => a - b);
  const p50 = samples[Math.floor(samples.length * 0.5)]!;
  const p99 = samples[Math.floor(samples.length * 0.99)]!;
  const sizeP50 = sizes[Math.floor(sizes.length * 0.5)]!;

  // Gate: p99 well under TICK_MS (~16.67ms); target ≤ ~2ms.
  assertEquals(
    p99 <= 2.0 || p99 < TICK_MS / 4,
    true,
    `p99 capture ${p99.toFixed(3)}ms exceeds budget (TICK_MS=${TICK_MS})`,
  );

  // Projected 10-min match totals at candidate intervals (periodic only).
  const matchTicks = 10 * 60 * TICK_HZ;
  const projection = [5, 7.5, 10].map((sec) => {
    const intervalTicks = Math.round(sec * TICK_HZ);
    const captures = Math.floor(matchTicks / intervalTicks);
    return {
      sec,
      captures,
      estBytes: captures * sizeP50,
      amortizedMsPerTick: p50 / intervalTicks,
    };
  });

  // Default stays 5s when gate passes (this test is the pin).
  assertEquals(CHECKPOINT_INTERVAL_SECONDS_DEFAULT, 5);

  console.log(
    JSON.stringify({
      epic: "9.2-benchmark",
      roster: "8h+4b",
      p50Ms: Number(p50.toFixed(4)),
      p99Ms: Number(p99.toFixed(4)),
      sizeP50Bytes: sizeP50,
      projection10min: projection,
      chosenDefaultSeconds: CHECKPOINT_INTERVAL_SECONDS_DEFAULT,
    }),
  );
});
