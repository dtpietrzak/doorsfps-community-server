/**
 * Epic 9.5 — checkpoint indexing (tick/time helpers + CheckpointIndex).
 *
 * Run from server-community/:
 *   deno test -A replay/checkpoint_index_test.ts
 */

import {
  assertEquals,
  assertExists,
  assertStrictEquals,
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
import {
  wireReplayRecorder,
} from "./replayTestHarness.ts";
import { TICK_HZ, TICK_MS } from "../shared/sim/game.ts";
import { ReplayRecorder } from "./ReplayRecorder.ts";
import {
  captureCheckpointState,
  CHECKPOINT_SCHEMA_VERSION,
  type AuthoritativeCheckpoint,
} from "./authoritativeCheckpoint.ts";
import {
  CheckpointIndex,
  CheckpointIndexCrossMatchError,
  CheckpointIndexDuplicateTickError,
  CheckpointIndexOutOfOrderError,
  tickToTimeMs,
  tickToTimeSec,
  timeMsToTick,
} from "./checkpointIndex.ts";
import { deepFreeze } from "./recordedInitialState.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MATCH_A = "match-index-a";
const MATCH_B = "match-index-b";

/** Minimal frozen frame — index reads only tick + runtimeMatchId. */
function frozenFrame(
  tick: number,
  runtimeMatchId: string = MATCH_A,
): AuthoritativeCheckpoint {
  return deepFreeze({
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    tick,
    runtimeMatchId,
    map: { name: "index-fixture", version: 1 },
    matchSeed: 1,
    rng: {
      damage: 0,
      spread: 0,
      spawn: 0,
      agents: 0,
      collisionSpawn: 0,
    },
    match: {
      scores: { A: 0, B: 0 },
      matchOver: false,
      inPrematch: false,
      restartAtTick: null,
      doorCycleOriginTick: 0,
      doorsPowerUpUntilTick: null,
      raidDoorPolicy: "off",
      debugForceDoorsOpen: false,
      matchEndTick: 0,
      matchDurationTicks: 0,
      raid: { active: false },
    },
    players: [],
    projectiles: [],
  }) as AuthoritativeCheckpoint;
}

function snapshotIndex(index: CheckpointIndex): {
  size: number;
  ticks: readonly number[];
} {
  return { size: index.size, ticks: index.ticks() };
}

// ---------------------------------------------------------------------------
// Tick / time helpers
// ---------------------------------------------------------------------------

Deno.test("9.5 helpers: tickToTimeMs / timeMsToTick use shared TICK_MS (floor)", () => {
  assertEquals(TICK_HZ, 60);
  assertEquals(tickToTimeMs(0), 0);
  assertEquals(tickToTimeMs(1), TICK_MS);
  assertEquals(tickToTimeMs(300), 300 * TICK_MS);
  assertEquals(tickToTimeMs(450), 450 * TICK_MS);
  assertEquals(tickToTimeMs(600), 600 * TICK_MS);

  assertEquals(timeMsToTick(0), 0);
  assertEquals(timeMsToTick(TICK_MS), 1);
  assertEquals(timeMsToTick(300 * TICK_MS), 300);
  // Sub-tick offsets floor — never select a later tick.
  assertEquals(timeMsToTick(TICK_MS / 2), 0);
  assertEquals(timeMsToTick(TICK_MS + TICK_MS / 2), 1);
  assertEquals(timeMsToTick(300 * TICK_MS + TICK_MS / 2), 300);

  // Round-trip for schedule ticks.
  for (const t of [0, 1, 300, 450, 600, 10_000]) {
    assertEquals(timeMsToTick(tickToTimeMs(t)), t);
  }
  assertEquals(tickToTimeSec(60), tickToTimeMs(60) / 1000);
  // 60 ticks ≈ 1s at TICK_HZ=60 (float-safe check).
  assertEquals(Math.abs(tickToTimeSec(60) - 1) < 1e-12, true);
});

Deno.test("9.5 helpers: source uses shared TICK_MS — no local 60", async () => {
  const src = await Deno.readTextFile(
    new URL("./checkpointIndex.ts", import.meta.url),
  );
  assertEquals(/from \"\.\.\/shared\/sim\/game\.ts\"/.test(src), true);
  assertEquals(/TICK_MS/.test(src), true);
  // No local tick-rate literal (shared constant is the only source).
  assertEquals(/\b60\b/.test(src), false);
});

// ---------------------------------------------------------------------------
// Insert + introspection
// ---------------------------------------------------------------------------

Deno.test("9.5 insert: anchor + periodics + final land in order", () => {
  const index = new CheckpointIndex();
  const frames = [2, 302, 602, 750].map((t) => frozenFrame(t));
  for (const f of frames) index.insert(f);

  assertEquals(index.size, 4);
  assertEquals(index.firstTick, 2);
  assertEquals(index.lastTick, 750);
  assertEquals(index.ticks(), [2, 302, 602, 750]);
  assertEquals(index.matchId, MATCH_A);
});

Deno.test("9.5 insert: schedule-scale at 300 and 600 tick intervals", () => {
  for (const interval of [300, 600]) {
    const index = new CheckpointIndex();
    const anchor = 10;
    const final = anchor + interval * 20 + 17; // mid-interval final
    index.insert(frozenFrame(anchor));
    for (let t = anchor + interval; t <= anchor + interval * 20; t += interval) {
      index.insert(frozenFrame(t));
    }
    index.insert(frozenFrame(final));

    const expected: number[] = [anchor];
    for (let t = anchor + interval; t <= anchor + interval * 20; t += interval) {
      expected.push(t);
    }
    expected.push(final);
    assertEquals(index.ticks(), expected);
    assertEquals(index.size, expected.length);

    // Mid-interval floor → prior periodic.
    const mid = anchor + interval + Math.floor(interval / 2);
    const prior = index.findPriorOrEqual(mid);
    assertEquals(prior.kind, "hit");
    if (prior.kind === "hit") {
      assertEquals(prior.frame.tick, anchor + interval);
    }
    // Post-final → last.
    const post = index.findPriorOrEqual(final + 1);
    assertEquals(post.kind, "hit");
    if (post.kind === "hit") {
      assertEquals(post.frame.tick, final);
    }
  }
});

// ---------------------------------------------------------------------------
// Exact + floor lookup
// ---------------------------------------------------------------------------

Deno.test("9.5 lookup: exact hits return identity-equal frame refs", () => {
  const index = new CheckpointIndex();
  const a = frozenFrame(100);
  const b = frozenFrame(400);
  const c = frozenFrame(700);
  index.insert(a);
  index.insert(b);
  index.insert(c);

  for (const frame of [a, b, c]) {
    const hit = index.findExact(frame.tick);
    assertEquals(hit.kind, "hit");
    if (hit.kind === "hit") {
      assertStrictEquals(hit.frame, frame);
    }
    const floor = index.findPriorOrEqual(frame.tick);
    assertEquals(floor.kind, "hit");
    if (floor.kind === "hit") {
      assertStrictEquals(floor.frame, frame);
    }
  }
});

Deno.test("9.5 lookup: mid-interval floors to nearest prior", () => {
  const index = new CheckpointIndex();
  const anchor = frozenFrame(100);
  const p1 = frozenFrame(400);
  const p2 = frozenFrame(700);
  index.insert(anchor);
  index.insert(p1);
  index.insert(p2);

  const cases: Array<[number, AuthoritativeCheckpoint]> = [
    [101, anchor],
    [399, anchor],
    [400, p1],
    [401, p1],
    [699, p1],
    [700, p2],
    [701, p2],
    [10_000, p2],
  ];
  for (const [tick, expected] of cases) {
    const hit = index.findPriorOrEqual(tick);
    assertEquals(hit.kind, "hit", `tick ${tick}`);
    if (hit.kind === "hit") {
      assertStrictEquals(hit.frame, expected, `tick ${tick}`);
    }
  }
});

Deno.test("9.5 lookup: pre-first / empty → miss; post-last → last", () => {
  const empty = new CheckpointIndex();
  assertEquals(empty.findPriorOrEqual(0), { kind: "miss", reason: "empty" });
  assertEquals(empty.findExact(0), { kind: "miss", reason: "empty" });

  const index = new CheckpointIndex();
  const anchor = frozenFrame(100);
  const last = frozenFrame(500);
  index.insert(anchor);
  index.insert(last);

  assertEquals(index.findPriorOrEqual(99), {
    kind: "miss",
    reason: "before-first",
  });
  assertEquals(index.findExact(99), { kind: "miss", reason: "before-first" });
  const exactMid = index.findExact(250);
  assertEquals(exactMid.kind, "miss");
  if (exactMid.kind === "miss") {
    assertEquals(exactMid.reason, "not-found");
  }

  const post = index.findPriorOrEqual(999);
  assertEquals(post.kind, "hit");
  if (post.kind === "hit") assertStrictEquals(post.frame, last);

  const atAnchor = index.findPriorOrEqual(100);
  assertEquals(atAnchor.kind, "hit");
  if (atAnchor.kind === "hit") assertStrictEquals(atAnchor.frame, anchor);
});

Deno.test("9.5 lookup: time-based converts then floors identically", () => {
  const index = new CheckpointIndex();
  const a = frozenFrame(100);
  const b = frozenFrame(400);
  index.insert(a);
  index.insert(b);

  // Exact tick time → same as tick query.
  const exact = index.findPriorOrEqualByTimeMs(tickToTimeMs(400));
  assertEquals(exact.kind, "hit");
  if (exact.kind === "hit") assertStrictEquals(exact.frame, b);

  // Mid-tick offset must not select a later frame.
  const mid = index.findPriorOrEqualByTimeMs(tickToTimeMs(100) + TICK_MS / 2);
  assertEquals(mid.kind, "hit");
  if (mid.kind === "hit") assertStrictEquals(mid.frame, a);

  const between = index.findPriorOrEqualByTimeMs(
    tickToTimeMs(250) + TICK_MS / 2,
  );
  assertEquals(between.kind, "hit");
  if (between.kind === "hit") assertStrictEquals(between.frame, a);

  const pre = index.findPriorOrEqualByTimeMs(tickToTimeMs(50));
  assertEquals(pre, { kind: "miss", reason: "before-first" });
});

// ---------------------------------------------------------------------------
// Insert guards
// ---------------------------------------------------------------------------

Deno.test("9.5 guards: duplicate tick fails loud; index unmodified", () => {
  const index = new CheckpointIndex();
  const a = frozenFrame(100);
  index.insert(a);
  const before = snapshotIndex(index);

  assertThrows(
    () => index.insert(frozenFrame(100)),
    CheckpointIndexDuplicateTickError,
  );
  assertEquals(snapshotIndex(index), before);
  const still = index.findExact(100);
  assertEquals(still.kind, "hit");
  if (still.kind === "hit") assertStrictEquals(still.frame, a);
});

Deno.test("9.5 guards: out-of-order tick fails loud; index unmodified", () => {
  const index = new CheckpointIndex();
  index.insert(frozenFrame(200));
  const before = snapshotIndex(index);

  assertThrows(
    () => index.insert(frozenFrame(199)),
    CheckpointIndexOutOfOrderError,
  );
  assertEquals(snapshotIndex(index), before);
});

Deno.test("9.5 guards: cross-match fails loud; index unmodified", () => {
  const index = new CheckpointIndex();
  index.insert(frozenFrame(100, MATCH_A));
  const before = snapshotIndex(index);

  assertThrows(
    () => index.insert(frozenFrame(200, MATCH_B)),
    CheckpointIndexCrossMatchError,
  );
  assertEquals(snapshotIndex(index), before);
  assertEquals(index.matchId, MATCH_A);
});

// ---------------------------------------------------------------------------
// Reference / freeze survival
// ---------------------------------------------------------------------------

Deno.test("9.5 reference: returned frame is inserted object; freeze survives", () => {
  const index = new CheckpointIndex();
  const frame = frozenFrame(50);
  index.insert(frame);

  const hit = index.findPriorOrEqual(50);
  assertEquals(hit.kind, "hit");
  if (hit.kind !== "hit") return;
  assertStrictEquals(hit.frame, frame);
  assertEquals(Object.isFrozen(hit.frame), true);
  assertThrows(() => {
    // deno-lint-ignore no-explicit-any
    (hit.frame as any).tick = 999;
  });
  assertEquals(hit.frame.tick, 50);
});

// ---------------------------------------------------------------------------
// Source scan
// ---------------------------------------------------------------------------

Deno.test("9.5 source-scan: index imports checkpoint type only — no loader/harness/store/fs/bot AI", async () => {
  const src = await Deno.readTextFile(
    new URL("./checkpointIndex.ts", import.meta.url),
  );
  assertEquals(/from \"\.\/authoritativeCheckpoint\.ts\"/.test(src), true);
  for (const forbidden of [
    "toSnapshot",
    "createSnapshot",
    "quantizePos",
    "quantizeAngle",
    "checkpointLoading",
    "checkpointValidation",
    "loadCheckpointState",
    "validateCheckpointAt",
    "compareSimulationState",
    "storeFactory",
    "replays.ts",
    "Deno.write",
    "Deno.create",
    "BotManager",
    "botThink",
    "Date.now",
    "setInterval",
    "setTimeout",
  ]) {
    assertEquals(
      src.includes(forbidden),
      false,
      `checkpointIndex must not reference ${forbidden}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Feed line (recorder integration)
// ---------------------------------------------------------------------------

const miniMap: DoorsMap = {
  name: "checkpoint-index",
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
};

function makeServer(): GameServer {
  return new GameServer({
    name: "checkpoint-index",
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

function wireRecorder(
  server: GameServer,
  intervalSeconds: number,
) {
  const i = internals(server);
  return wireReplayRecorder(
    {
      attachSink: (sink) => server.attachReplaySink(sink),
      detachSink: () => server.detachReplaySink(),
    },
    {
      checkpointIntervalSeconds: intervalSeconds,
      captureCheckpointState: (tick, runtimeMatchId) =>
        captureCheckpointState(i.players, tick, runtimeMatchId),
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
  i.flushPendingReplayMatchEnd(tick);
  return result;
}

function startLive(server: GameServer, recorder: ReplayRecorder): string {
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

function cleanup(blobDir: string | null) {
  if (!blobDir) return;
  try {
    Deno.removeSync(blobDir, { recursive: true });
  } catch {
    // ignore
  }
}

Deno.test("9.5 feed: recorder handoff indexes captured frames (identity with stream)", () => {
  const server = makeServer();
  // interval = 5 ticks
  const { recorder, blobDir } = wireRecorder(server, 5 / TICK_HZ);
  try {
    const id = startLive(server, recorder);
    for (const t of [2, 3, 4, 5, 6, 7]) driveTick(server, t);

    const index = recorder.getCheckpointIndex(id);
    assertExists(index);
    assertEquals(index.ticks(), [2, 5]);
    assertEquals(index.size, 2);

    const stream = recorder.getCheckpointStream(id);
    assertExists(stream);
    assertEquals(stream.length, 2);
    // Index holds the same frozen references the buffer stores.
    const hit2 = index.findExact(2);
    const hit5 = index.findExact(5);
    assertEquals(hit2.kind, "hit");
    assertEquals(hit5.kind, "hit");
    if (hit2.kind === "hit" && hit5.kind === "hit") {
      assertStrictEquals(hit2.frame, stream[0]);
      assertStrictEquals(hit5.frame, stream[1]);
    }

    // Floor mid-interval.
    const mid = index.findPriorOrEqual(4);
    assertEquals(mid.kind, "hit");
    if (mid.kind === "hit") assertEquals(mid.frame.tick, 2);

    // Exact buffer miss still floors via index.
    assertEquals(recorder.getCheckpoint(id, 4), null);
  } finally {
    cleanup(blobDir);
  }
});

Deno.test("9.5 feed: disabled builder → empty index (no inserts)", () => {
  const server = makeServer();
  const { recorder, blobDir } = wireReplayRecorder(
    {
      attachSink: (sink) => server.attachReplaySink(sink),
      detachSink: () => server.detachReplaySink(),
    },
    {
      checkpointIntervalSeconds: 5 / TICK_HZ,
      // omit builder
    },
  );
  try {
    const id = startLive(server, recorder);
    for (const t of [2, 3, 4, 5]) driveTick(server, t);
    const index = recorder.getCheckpointIndex(id);
    assertExists(index);
    assertEquals(index.size, 0);
    assertEquals(index.findPriorOrEqual(5), {
      kind: "miss",
      reason: "empty",
    });
  } finally {
    cleanup(blobDir);
  }
});

Deno.test("9.5 equivalence: index fed-but-never-queried vs absent — identical sim outcomes", () => {
  function runSeason(withIndex: boolean): {
    phase: string;
    scores: { A: number; B: number };
    indexed: number;
  } {
    const server = makeServer();
    stubSessions(server);
    const i = internals(server);
    let indexed = 0;
    let storeClose: (() => void) | null = null;
    if (withIndex) {
      const wired = wireRecorder(server, 2 / TICK_HZ);
      storeClose = () => cleanup(wired.blobDir);
      const id = startLive(server, wired.recorder);
      for (let t = 2; t <= 12; t++) driveTick(server, t);
      indexed = wired.recorder.getCheckpointIndex(id)?.size ?? 0;
      const out = {
        phase: i.players.getMatchPhase(),
        scores: { ...i.players.getScores() },
        indexed,
      };
      storeClose();
      return out;
    }
    i.players.add("s1", "A1", "A");
    i.players.add("s2", "B1", "B");
    const start = i.players.beginLiveMatch(1, Date.now());
    i.beginRuntimeMatchIdentity(1);
    i.emitMatchStart(start, 1);
    for (let t = 2; t <= 12; t++) driveTick(server, t);
    return {
      phase: i.players.getMatchPhase(),
      scores: { ...i.players.getScores() },
      indexed: 0,
    };
  }

  const a = runSeason(false);
  const b = runSeason(true);
  assertEquals(a.phase, b.phase);
  assertEquals(a.scores, b.scores);
  assertEquals(a.indexed, 0);
  assertEquals(b.indexed > 0, true);
});
