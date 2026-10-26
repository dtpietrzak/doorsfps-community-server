/**
 * Epic 12.7 — delayed live spectating.
 *
 * Run from server-community/:
 *   deno test -A replay/delayed_live_tail_test.ts
 */

import {
  assertEquals,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import {
  buildMatchMetadata,
  type MatchMetadata,
} from "../shared/replay/matchMetadata.ts";
import type {
  AuthoritativeEvent,
  MatchInitEvent,
} from "../shared/sim/authoritativeEvent.ts";
import { TICK_HZ, TICK_MS } from "../shared/sim/game.ts";
import { PlayerManager } from "../players/PlayerManager.ts";
import type { TickSelectedInput } from "../players/tickAssociation.ts";
import type { DoorsMap } from "../world/map.ts";
import type { PlayerInput } from "../protocol/network.ts";
import { MapCollision } from "../world/MapCollision.ts";
import {
  captureCheckpointState,
  type CheckpointPlayerState,
} from "./authoritativeCheckpoint.ts";
import {
  DELAYED_LIVE_DELAY_MS,
  computeTargetTailTick,
  createDelayedLiveSession,
  createDelayedLiveTail,
  delayTicksFromMs,
  DelayedLiveError,
  type DelayedLiveErrorCode,
  type DelayedLivePollResult,
} from "./delayedLiveTail.ts";
import type { RecordedInitialState } from "./recordedInitialState.ts";
import type { RecordedTickInputs } from "./recordedTickInputs.ts";
import {
  REPLAY_INDEX_VERSION,
  type ReplayIndex,
} from "./replayIndex.ts";
import { createReplayPlayback } from "./replayPlaybackSession.ts";
import { ReplaySessionBuffer } from "./replaySessionBuffer.ts";
import {
  __replayTickNowMsForTest,
  createReplayRunner,
  ReplayRaidUnsupportedError,
  type ReplayRunSession,
  type ReplayTickOutcome,
} from "./replaySimulationRunner.ts";
import {
  projectReplayRenderFeed,
  type ReplayViewState,
} from "./replayStateAccess.ts";
import {
  firstPersonCamera,
  freeCamera,
  spawnFreeCamera,
  thirdPersonCamera,
  type CameraPose,
} from "./spectatorCamera.ts";
import { projectSpectatorContext } from "./spectatorContext.ts";
import { applyVisibilityFilter } from "./spectatorFilter.ts";

const TEST_DELAY_MS = 50; // 50 * 60 / 1000 = 3 ticks
const TEST_DELAY_TICKS = 3;

const miniMap: DoorsMap = {
  name: "replay-delayed-live",
  version: 1,
  bounds: { minX: -40, maxX: 40, minZ: -40, maxZ: 40 },
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

function makeCollision(): MapCollision {
  return new MapCollision(miniMap);
}

function sampleMetadata(
  init: MatchInitEvent,
  over?: Partial<MatchMetadata>,
): MatchMetadata {
  const built = buildMatchMetadata(
    init.appliedTick,
    {
      matchSeed: init.matchSeed,
      matchDurationTicks: init.matchDurationTicks,
      matchEndTick: init.appliedTick + init.matchDurationTicks,
      doorCycleOriginTick: init.appliedTick,
      map: init.map,
      prematchEnabled: init.prematchEnabled,
      raidDoorPolicy: init.raidDoorPolicy,
      debugForceDoorsOpen: init.debugForceDoorsOpen,
      phase: init.phase,
      scores: init.scores,
      roster: init.roster,
    },
    {
      runtimeMatchId: "rt-delayed-live-1",
      serverName: "delayed-live-test",
      serverId: "srv-delayed-live",
      modeId: "standard",
      raidId: null,
      buildSha: "deadbeef",
      raidMatch: { active: false },
    },
    { capturedAtIso: "2026-01-01T00:00:00.000Z" },
  );
  if (!built.ok) throw new Error(built.reason);
  return { ...built.metadata, ...over };
}

function emptyIndex(): ReplayIndex {
  return {
    indexVersion: REPLAY_INDEX_VERSION,
    checkpoints: [],
    markers: [],
    phases: [],
    playerActivity: [],
  };
}

function assertCode(
  fn: () => unknown,
  code: DelayedLiveErrorCode,
): DelayedLiveError {
  const err = assertThrows(fn, DelayedLiveError);
  assertEquals(err.code, code);
  return err;
}

function digestOf(out: ReplayTickOutcome) {
  return {
    tick: out.tick,
    overlapDeaths: out.overlapDeaths,
    scores: out.scores,
    respawnedIds: out.respawnedIds,
    gameOver: out.gameOver,
    rosterDigest: out.rosterDigest,
  };
}

function viewFromRunner(runner: {
  currentTick: number;
  simulation: PlayerManager;
  session: ReplayRunSession;
}): ReplayViewState {
  const sim = runner.simulation;
  const tick = runner.currentTick;
  const checkpoint = captureCheckpointState(
    sim,
    tick,
    runner.session.initialState.runtimeMatchId,
  );
  const doors = sim.getDoorCycleState(tick);
  return {
    tick,
    players: checkpoint.players,
    scores: { ...sim.getScores() },
    phase: sim.getMatchPhase(),
    doorsOpen: doors.doorsOpen,
    doorChangeTick: doors.doorChangeTick,
    matchEndTick: checkpoint.match.matchEndTick,
    projectiles: checkpoint.projectiles,
  };
}

function isFeedShaped(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const f = value as Record<string, unknown>;
  return (
    typeof f.yaw === "number" &&
    typeof f.pitch === "number" &&
    typeof f.alive === "boolean" &&
    f.localSim != null &&
    f.viewOffset != null
  );
}

function poseModes(view: ReplayViewState, focusId: string): {
  fp: CameraPose;
  tp: CameraPose;
  free: CameraPose;
} {
  const feed = projectReplayRenderFeed(view, null, focusId, 0);
  if (feed == null || !isFeedShaped(feed)) throw new Error("feed not seam-shaped");
  const fp = firstPersonCamera({ kind: "feed", feed });
  const tp = thirdPersonCamera(
    {
      kind: "pose",
      pose: {
        x: feed.localSim.x,
        y: feed.localSim.y,
        z: feed.localSim.z,
        yaw: feed.yaw,
        pitch: feed.pitch,
        alive: feed.alive,
      },
      snapped: false,
      eye: feed.viewOffset,
    },
    { raycast: () => null },
  );
  const free = freeCamera(spawnFreeCamera(fp), new Set(), fp.yaw, fp.pitch, 0);
  return { fp, tp, free };
}

type LiveCapture = {
  buffer: ReplaySessionBuffer;
  collision: MapCollision;
  initialState: RecordedInitialState;
  firstTick: number;
  lastTick: number;
  inputs: Map<number, RecordedTickInputs>;
  events: Map<number, AuthoritativeEvent[]>;
};

function captureLive(opts?: {
  seed?: number;
  ticks?: number;
  withBot?: boolean;
  skipInputTicks?: ReadonlySet<number>;
  caps?: { maxRecordingTicks?: number; maxBufferedTicks?: number };
  beforeCommit?: () => void;
}): LiveCapture {
  const seed = opts?.seed ?? 0xa11e;
  const tickCount = opts?.ticks ?? 12;
  const collision = makeCollision();
  const live = new PlayerManager(collision, {
    matchSeed: seed,
    matchDurationSeconds: 120,
    enablePrematch: false,
    nowMs: __replayTickNowMsForTest(0),
  });
  live.add("h1", "Human", "A", undefined, __replayTickNowMsForTest(0));
  if (opts?.withBot !== false) {
    live.addBot("b1", "BotOne", { team: "B" });
  }
  const captureTick = 0;
  live.beginLiveMatch(captureTick, __replayTickNowMsForTest(captureTick));
  live.drainAuthoritativeEvents();

  const initRaw = live.buildMatchInitEvent(captureTick);
  if (initRaw.kind !== "matchInit") throw new Error("expected matchInit");
  const init = initRaw;
  const metadata = sampleMetadata(init);
  const initialState: RecordedInitialState = {
    runtimeMatchId: metadata.runtimeMatchId,
    captureTick,
    init,
    metadata,
  };

  const buffer = new ReplaySessionBuffer(initialState.runtimeMatchId, {
    caps: opts?.caps,
    beforeCommit: opts?.beforeCommit,
  });
  buffer.setInit(initialState);

  const inputs = new Map<number, RecordedTickInputs>();
  const events = new Map<number, AuthoritativeEvent[]>();
  const firstTick = 1;
  const lastTick = tickCount;
  const skip = opts?.skipInputTicks ?? new Set();

  for (let tick = firstTick; tick <= lastTick; tick++) {
    const nowMs = __replayTickNowMsForTest(tick);
    const human = live.get("h1");
    if (human?.alive) {
      const packet: PlayerInput = {
        sequence: tick,
        forward: tick % 2 === 0,
        backward: false,
        left: tick % 3 === 0,
        right: false,
        jump: false,
        sprint: tick % 5 === 0,
        crouch: false,
        meleeLunge: false,
        yaw: 0.1 * tick,
        pitch: -0.05,
      };
      live.handleInput("h1", packet, nowMs);
    }
    live.update(tick, nowMs);
    live.processScores(tick);
    live.checkMatchEnd(tick);
    live.checkMatchTimeLimit(tick);
    live.processRespawns(tick);

    const movement: TickSelectedInput[] = [];
    for (const p of live.all()) {
      const sel = p.lastTickInputSelection();
      if (!sel) throw new Error(`missing selection for ${p.id} at tick ${tick}`);
      movement.push(sel);
    }
    const row: RecordedTickInputs = { tick, movement, actions: [] };
    inputs.set(tick, row);
    events.set(tick, []);
    live.drainAuthoritativeEvents();

    if (!skip.has(tick)) {
      buffer.putInputs(row);
      buffer.commitTick();
    }
  }

  if (buffer.getInputs(firstTick) !== undefined) {
    buffer.putCheckpoint(
      captureCheckpointState(live, firstTick, initialState.runtimeMatchId),
    );
  }

  return {
    buffer,
    collision,
    initialState,
    firstTick,
    lastTick,
    inputs,
    events,
  };
}

function mapSession(cap: LiveCapture): ReplayRunSession {
  return {
    initialState: cap.initialState,
    firstTick: cap.firstTick,
    lastTick: cap.lastTick,
    inputAt(tick) {
      const row = cap.inputs.get(tick);
      if (!row) throw new Error(`no inputs for ${tick}`);
      return row;
    },
    eventsAt(tick) {
      return cap.events.get(tick) ?? [];
    },
  };
}

function makeTail(cap: LiveCapture, over?: {
  delayMs?: number;
  liveLatestCommittedTick?: () => number;
  fromTick?: number;
  terminalReason?: () => "buffer-cap-exceeded" | "duration-limit" | "alloc-failed" | null;
}) {
  return createDelayedLiveTail({
    buffer: cap.buffer,
    collision: cap.collision,
    delayMs: over?.delayMs ?? TEST_DELAY_MS,
    liveLatestCommittedTick: over?.liveLatestCommittedTick,
    fromTick: over?.fromTick,
    terminalReason: over?.terminalReason,
  });
}

function trackingTick(result: DelayedLivePollResult): number {
  if (result.status !== "tracking") {
    throw new Error(`expected tracking, got ${result.status} target=${result.targetTailTick}`);
  }
  return result.currentTick;
}

// ---------------------------------------------------------------------------
// Delay config
// ---------------------------------------------------------------------------

Deno.test("12.7 delay: default DELAY_MS = 5_000 → 300 ticks", () => {
  assertEquals(DELAYED_LIVE_DELAY_MS, 5_000);
  assertEquals(delayTicksFromMs(), 300);
  assertEquals(delayTicksFromMs(DELAYED_LIVE_DELAY_MS), (5_000 * TICK_HZ) / 1000);
  assertEquals(computeTargetTailTick(2_000, 1_800), 200);
});

Deno.test("12.7 delay: custom integral DELAY_MS round-trips", () => {
  assertEquals(delayTicksFromMs(TEST_DELAY_MS), TEST_DELAY_TICKS);
  assertEquals(delayTicksFromMs(1_000), 60);
  assertEquals((TEST_DELAY_TICKS * 1000) / TICK_HZ, TEST_DELAY_MS);
});

Deno.test("12.7 delay: non-integral / non-positive config fails loud", () => {
  const a = assertCode(() => delayTicksFromMs(1), "replay-delayed-live-bad-delay");
  assertEquals(a.detail?.includes("delayMs=1"), true);
  assertCode(() => delayTicksFromMs(0), "replay-delayed-live-bad-delay");
  assertCode(() => delayTicksFromMs(-50), "replay-delayed-live-bad-delay");
  assertCode(() => delayTicksFromMs(50.5), "replay-delayed-live-bad-delay");
  assertCode(
    () => createDelayedLiveTail({
      buffer: new ReplaySessionBuffer("x"),
      collision: makeCollision(),
      delayMs: 1,
    }),
    "replay-delayed-live-bad-delay",
  );
});

// ---------------------------------------------------------------------------
// Adapter conformance
// ---------------------------------------------------------------------------

Deno.test("12.7 adapter: ReplayRunSession shape over a live buffer", () => {
  const cap = captureLive({ ticks: 8 });
  const session = createDelayedLiveSession(cap.buffer, {
    lastTickMode: "committed",
  });
  assertStrictEquals(session.initialState, cap.buffer.init);
  assertEquals(session.firstTick, 1);
  assertEquals(session.lastTick, 8);
  assertEquals(session.checkpointFrameAt, undefined);
  for (let tick = 1; tick <= 8; tick++) {
    const row = session.inputAt(tick);
    assertEquals(row.tick, tick);
    assertEquals(row, cap.buffer.getInputs(tick));
    assertEquals(session.eventsAt(tick), []);
  }
  const window = cap.buffer.getTailWindow(1);
  if (window == null) throw new Error("expected tail window");
  assertEquals(window.checkpoints.length > 0, true);
  assertEquals("checkpointFrameAt" in session, false);

  const runner = createReplayRunner(session, { collision: cap.collision });
  const out = runner.step(1);
  assertEquals(out.tick, 1);
});

Deno.test("12.7 adapter: createReplayPlayback start+frame projects seam-shaped feeds", () => {
  const cap = captureLive({ ticks: 6 });
  const session = createDelayedLiveSession(cap.buffer, {
    lastTickMode: "committed",
  });
  const playback = createReplayPlayback(session, {
    collision: cap.collision,
    focusedPlayerId: "h1",
  });
  playback.start();
  const frame = playback.frame(TICK_MS);
  assertEquals(frame.ended, false);
  assertEquals(isFeedShaped(frame.feed), true);
  const fp = firstPersonCamera({ kind: "feed", feed: frame.feed! });
  assertEquals(Number.isFinite(fp.x), true);
});

Deno.test("12.7 adapter: ceiling lastTick does not freeze at attach committed max", () => {
  const cap = captureLive({ ticks: 4 });
  const session = createDelayedLiveSession(cap.buffer, {
    lastTickMode: "ceiling",
  });
  assertEquals(session.firstTick, 1);
  assertEquals(
    session.lastTick,
    1 + cap.buffer.caps.maxRecordingTicks - 1,
  );
  assertEquals(session.lastTick >= 4, true);
});

// ---------------------------------------------------------------------------
// Delay exactness / warm-up
// ---------------------------------------------------------------------------

Deno.test("12.7 delay exactness: tail holds at live - DELAY_TICKS once warm", () => {
  const cap = captureLive({ ticks: 10 });
  const tail = makeTail(cap);
  const result = tail.poll();
  assertEquals(result.status, "tracking");
  assertEquals(result.targetTailTick, 10 - TEST_DELAY_TICKS);
  assertEquals(trackingTick(result), 7);
  assertEquals(tail.runner?.currentTick, 7);

  const again = tail.poll();
  assertEquals(again.status, "tracking");
  if (again.status !== "tracking") throw new Error("tracking");
  assertEquals(again.currentTick, 7);
  assertEquals(again.outcome, null);
});

Deno.test("12.7 warm-up: live tick < DELAY_TICKS waits; never shows tick 0 as live", () => {
  const cap = captureLive({ ticks: 2 });
  const tail = makeTail(cap);
  const result = tail.poll();
  assertEquals(result.status, "waiting");
  assertEquals(result.targetTailTick, 2 - TEST_DELAY_TICKS);
  assertEquals(tail.runner?.currentTick, 0);
});

Deno.test("12.7 live advance: each newly committed tick moves the tail by one", () => {
  const cap = captureLive({ ticks: 6 });
  let liveTick = 6;
  const tail = makeTail(cap, { liveLatestCommittedTick: () => liveTick });
  assertEquals(trackingTick(tail.poll()), 3);

  const human = cap.buffer.getInputs(6);
  if (!human) throw new Error("missing row");
  for (const tick of [7, 8]) {
    cap.buffer.putInputs({ ...human, tick });
    cap.buffer.commitTick();
    liveTick = tick;
    assertEquals(trackingTick(tail.poll()), tick - TEST_DELAY_TICKS);
  }
});

// ---------------------------------------------------------------------------
// Committed-gate
// ---------------------------------------------------------------------------

Deno.test("12.7 committed-gate: supplier ahead of buffer waits; does not step incomplete", () => {
  const cap = captureLive({ ticks: 6 });
  let liveTick = 6;
  const tail = makeTail(cap, { liveLatestCommittedTick: () => liveTick });
  assertEquals(trackingTick(tail.poll()), 3);

  liveTick = 10;
  const waiting = tail.poll();
  assertEquals(waiting.status, "waiting");
  assertEquals(waiting.targetTailTick, 7);
  assertEquals(tail.runner?.currentTick, 6);

  const template = cap.buffer.getInputs(6);
  if (!template) throw new Error("missing row");
  for (const tick of [7, 8, 9, 10]) {
    cap.buffer.putInputs({ ...template, tick });
    cap.buffer.commitTick();
  }
  assertEquals(trackingTick(tail.poll()), 7);
});

Deno.test("12.7 committed-gate: sparse event-free ticks step normally", () => {
  const cap = captureLive({ ticks: 8 });
  assertEquals(cap.buffer.getEvents(5), undefined);
  const tail = makeTail(cap);
  assertEquals(trackingTick(tail.poll()), 5);
});

// ---------------------------------------------------------------------------
// Underrun
// ---------------------------------------------------------------------------

Deno.test("12.7 underrun: target below fromTick fails loud; no jump", () => {
  const cap = captureLive({ ticks: 10 });
  const tail = makeTail(cap, { fromTick: 9 });
  const err = assertCode(() => tail.poll(), "replay-delayed-live-underrun");
  assertEquals(err.detail?.includes("targetTailTick=7"), true);
  assertEquals(err.detail?.includes("fromTick=9"), true);
  assertEquals(tail.runner, null);
});

Deno.test("12.7 underrun: contiguity gap fails loud; never skip", () => {
  const cap = captureLive({
    ticks: 10,
    skipInputTicks: new Set([4]),
  });
  const tail = makeTail(cap);
  const err = assertCode(() => tail.poll(), "replay-delayed-live-underrun");
  assertEquals(err.detail?.includes("missingTick=4"), true);
});

// ---------------------------------------------------------------------------
// Close / cap-terminal
// ---------------------------------------------------------------------------

Deno.test("12.7 match end: freezeForFinalize closes; later poll stays closed", () => {
  const cap = captureLive({ ticks: 8 });
  const tail = makeTail(cap);
  assertEquals(trackingTick(tail.poll()), 5);
  cap.buffer.freezeForFinalize();
  assertCode(() => tail.poll(), "replay-delayed-live-closed");
  assertCode(() => tail.poll(), "replay-delayed-live-closed");
});

Deno.test("12.7 match end: markFailed and discard close (not underrun)", () => {
  const failed = captureLive({ ticks: 8 });
  const t1 = makeTail(failed);
  t1.poll();
  failed.buffer.markFailed();
  const e1 = assertCode(() => t1.poll(), "replay-delayed-live-closed");
  assertEquals(e1.detail?.includes("window=null"), true);

  const discarded = captureLive({ ticks: 8 });
  const t2 = makeTail(discarded);
  t2.poll();
  discarded.buffer.discard();
  assertCode(() => t2.poll(), "replay-delayed-live-closed");
});

Deno.test("12.7 cap-terminal: alloc-failed surfaces as failed with buffer reason", () => {
  let blow = false;
  const cap = captureLive({
    ticks: 6,
    beforeCommit: () => {
      if (blow) throw new Error("alloc");
    },
  });
  let reason: "alloc-failed" | null = null;
  const tail = makeTail(cap, { terminalReason: () => reason });
  assertEquals(trackingTick(tail.poll()), 3);

  blow = true;
  const commit = cap.buffer.commitTick();
  assertEquals(commit.ok, false);
  if (commit.ok) throw new Error("expected fail");
  assertEquals(commit.reason, "alloc-failed");
  cap.buffer.markFailed();
  reason = "alloc-failed";
  const err = assertCode(() => tail.poll(), "replay-delayed-live-failed");
  assertEquals(err.detail, "reason=alloc-failed");
});

Deno.test("12.7 cap-terminal: small maxRecordingTicks duration-limit", () => {
  const cap = captureLive({
    ticks: 3,
    caps: { maxRecordingTicks: 3, maxBufferedTicks: 3 },
  });
  const template = cap.buffer.getInputs(3);
  if (!template) throw new Error("missing");
  cap.buffer.putInputs({ ...template, tick: 4 });
  const commit = cap.buffer.commitTick();
  assertEquals(commit.ok, false);
  if (commit.ok) throw new Error("expected fail");
  assertEquals(commit.reason, "duration-limit");
  cap.buffer.markFailed();
  const tail = makeTail(cap, {
    terminalReason: () => "duration-limit",
  });
  const err = assertCode(() => tail.poll(), "replay-delayed-live-failed");
  assertEquals(err.detail, "reason=duration-limit");
});

// ---------------------------------------------------------------------------
// Raid
// ---------------------------------------------------------------------------

Deno.test("12.7 raid: runner named guard fires at arm, before any tail frame", () => {
  const cap = captureLive({ ticks: 4 });
  const raidMeta = sampleMetadata(cap.initialState.init, {
    raidMatch: {
      active: true,
      raidId: "raid-1",
      humanTeam: "A",
      goal: 10,
      maxTimeSeconds: 600,
      respawnMs: 5000,
      initialMap: "replay-delayed-live",
      expectedHumans: 1,
      startWaitSeconds: 30,
      started: true,
      ended: false,
      wave: 1,
      failReason: null,
    },
  });
  cap.buffer.init = { ...cap.initialState, metadata: raidMeta };
  const tail = makeTail(cap, { delayMs: TEST_DELAY_MS });
  assertThrows(() => tail.poll(), ReplayRaidUnsupportedError);
  assertEquals(tail.runner, null);
});

// ---------------------------------------------------------------------------
// Never-blocks-live
// ---------------------------------------------------------------------------

Deno.test("12.7 never-blocks-live: commits without polls all land; tail stays at full delay", () => {
  const cap = captureLive({ ticks: 4 });
  const tail = makeTail(cap);
  for (let tick = 5; tick <= 12; tick++) {
    const template = cap.buffer.getInputs(4);
    if (!template) throw new Error("missing");
    cap.buffer.putInputs({ ...template, tick });
    const commit = cap.buffer.commitTick();
    assertEquals(commit.ok, true);
  }
  assertEquals(cap.buffer.getInputs(12)?.tick, 12);
  assertEquals(trackingTick(tail.poll()), 12 - TEST_DELAY_TICKS);
});

// ---------------------------------------------------------------------------
// Runner equivalence + cameras / filter / context / focus
// ---------------------------------------------------------------------------

Deno.test("12.7 runner equivalence: tail outcomes match map-session stepping", () => {
  const cap = captureLive({ ticks: 10 });
  const expected: ReturnType<typeof digestOf>[] = [];
  const control = createReplayRunner(mapSession(cap), {
    collision: cap.collision,
  });
  const target = 10 - TEST_DELAY_TICKS;
  for (let tick = 1; tick <= target; tick++) {
    expected.push(digestOf(control.step(tick)));
  }

  const tail = makeTail(cap);
  const result = tail.poll();
  assertEquals(result.status, "tracking");
  if (result.status !== "tracking") throw new Error("tracking");
  assertEquals(digestOf(result.outcome!), expected[expected.length - 1]);
  assertEquals(tail.runner?.currentTick, target);
  assertEquals(
    tail.runner?.simulation.allCached().map((p) => p.id).sort(),
    control.simulation.allCached().map((p) => p.id).sort(),
  );
});

Deno.test("12.7 cameras: FP + 3P + free pose every tail tick; focus switch does not reset", () => {
  const cap = captureLive({ ticks: 10 });
  const tail = makeTail(cap);
  const result = tail.poll();
  const runner = tail.runner;
  if (result.status !== "tracking" || runner == null) {
    throw new Error("expected armed tracking tail");
  }
  const tickBefore = runner.currentTick;
  const view = viewFromRunner(runner);
  const h = poseModes(view, "h1");
  const b = poseModes(view, "b1");
  assertEquals(Number.isFinite(h.fp.x), true);
  assertEquals(Number.isFinite(h.tp.x), true);
  assertEquals(Number.isFinite(h.free.x), true);
  assertEquals(Number.isFinite(b.fp.x), true);
  assertEquals(runner.currentTick, tickBefore);

  const red = applyVisibilityFilter(view.players, "red");
  assertEquals(red.every((p: CheckpointPlayerState) => p.team === "B"), true);
  assertEquals(red.some((p) => p.id === "h1"), false);

  const names = new Map([
    ["h1", "Human"],
    ["b1", "BotOne"],
  ]);
  const ctx = projectSpectatorContext(view, emptyIndex(), "h1", "red", names);
  assertEquals(ctx?.focus?.nameplate, "Human");
  assertEquals(ctx?.replayTimeMs, tickBefore * TICK_MS);
});

Deno.test("12.7 non-interference: posing observers does not write the buffer", () => {
  const cap = captureLive({ ticks: 10 });
  const inputCount = cap.buffer.inputs.size;
  const usage = cap.buffer.usageTicks;
  const tail = makeTail(cap);
  tail.poll();
  const runner = tail.runner;
  if (runner == null) throw new Error("expected runner");
  const view = viewFromRunner(runner);
  poseModes(view, "h1");
  poseModes(view, "b1");
  applyVisibilityFilter(view.players, "agents");
  assertEquals(cap.buffer.inputs.size, inputCount);
  assertEquals(cap.buffer.usageTicks, usage);
  assertEquals(cap.buffer.status, "recording");
});

Deno.test("12.7 shifted-wall-clock: identical poll output", () => {
  const cap = captureLive({ ticks: 8, seed: 0x1111 });
  const cap2 = captureLive({ ticks: 8, seed: 0x1111 });
  const a = trackingTick(makeTail(cap).poll());
  const b = trackingTick(makeTail(cap2).poll());
  assertEquals(a, b);
  assertEquals(a, 8 - TEST_DELAY_TICKS);
});

// ---------------------------------------------------------------------------
// Purity / isolation source scan
// ---------------------------------------------------------------------------

Deno.test("12.7 source-scan: no THREE/DOM/clock/io/loader/buffer-writes/camera math", async () => {
  const src = await Deno.readTextFile(
    new URL("./delayedLiveTail.ts", import.meta.url),
  );
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const banned of [
    "Date.now",
    "performance.now",
    "requestAnimationFrame",
    "setInterval",
    "setTimeout",
    "THREE",
    "document",
    "keyboard",
    "loadReplay",
    "decodeReplayContainer",
    "putInputs",
    "putEvents",
    "commitTick",
    "setInit",
    "resetToCheckpoint",
    "firstPersonCamera",
    "thirdPersonCamera",
    "freeCamera",
    "applyVisibilityFilter",
    "projectSpectatorContext",
    "interpolateReplayPose",
    "applyCameraPose",
    "Deno.",
    "node:fs",
    "ReplayBlobStore",
    "createStore",
    'from "../net/',
    'from "./net/',
    "socket.io",
    "fetch(",
  ]) {
    assertEquals(code.includes(banned), false, `banned token present: ${banned}`);
  }
});
