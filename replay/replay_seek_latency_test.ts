/**
 * Epic 19.5 — seek latency.
 *
 * Run from server-community/:
 *   deno test -A --unstable-net --node-modules-dir=manual replay/replay_seek_latency_test.ts
 */

import { assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import { TICK_HZ, TICK_MS } from "../shared/sim/game.ts";
import {
  buildMatchMetadata,
  type MatchMetadata,
} from "../shared/replay/matchMetadata.ts";
import type { MatchInitEvent } from "../shared/sim/authoritativeEvent.ts";
import { PlayerManager } from "../players/PlayerManager.ts";
import type { TickSelectedInput } from "../players/tickAssociation.ts";
import type { DoorsMap } from "../world/map.ts";
import type { PlayerInput } from "../protocol/network.ts";
import { MapCollision } from "../world/MapCollision.ts";
import { tickToTimeMs } from "./checkpointIndex.ts";
import {
  type AuthoritativeCheckpoint,
  captureCheckpointState,
} from "./authoritativeCheckpoint.ts";
import type { RecordedInitialState } from "./recordedInitialState.ts";
import type { RecordedTickInputs } from "./recordedTickInputs.ts";
import { floorFromCheckpointFrames } from "./replaySeek.ts";
import {
  __replayTickNowMsForTest,
  type ReplayRunSession,
} from "./replaySimulationRunner.ts";
import { createReplayPlayback } from "./replayPlaybackSession.ts";
import {
  REPLAY_SEEK_LATENCY_INVALID,
  REPLAY_SEEK_LATENCY_WINDOW,
  ReplaySeekLatencyError,
  ReplaySeekLatencyMeter,
  summarizeReplaySeekLatency,
  type ReplaySeekLatencySample,
} from "./replaySeekLatency.ts";

const BUDGET = 1000 / TICK_HZ;

Deno.test("19.5 empty summary is a zero split", () => {
  const split = summarizeReplaySeekLatency([]);
  for (const bucket of [split.all, split.reloaded, split.resumed]) {
    assertEquals(bucket.samples, 0);
    assertEquals(bucket.totalMs, 0);
    assertEquals(bucket.meanMs, 0);
    assertEquals(bucket.rmsMs, 0);
    assertEquals(bucket.peakMs, 0);
    assertEquals(bucket.totalSteps, 0);
    assertEquals(bucket.meanSteps, 0);
    assertEquals(bucket.peakSteps, 0);
    assertEquals(bucket.msPerStep, 0);
    assertEquals(bucket.meanLoad, 0);
    assertEquals(bucket.peakLoad, 0);
    assertEquals(bucket.stepLoad, 0);
    assertEquals(bucket.slowest, null);
  }
});

Deno.test("19.5 a long forward and a slow reload stay distinct", () => {
  const split = summarizeReplaySeekLatency([
    { wallMs: 10, steps: 2, resumed: false },
    { wallMs: 100, steps: 0, resumed: false },
    { wallMs: 3, steps: 300, resumed: true },
  ]);
  assertEquals(split.all.samples, 3);
  assertEquals(split.all.totalMs, 113);
  assertAlmostEquals(split.all.meanMs, 113 / 3, 1e-12);
  assertAlmostEquals(split.all.rmsMs, Math.sqrt((100 + 10000 + 9) / 3), 1e-12);
  assertEquals(split.all.peakMs, 100);
  assertEquals(split.all.totalSteps, 302);
  assertAlmostEquals(split.all.meanSteps, 302 / 3, 1e-12);
  assertEquals(split.all.peakSteps, 300);
  // The 0-step load is not in the ratio. 10 + 3 over 2 + 300.
  assertAlmostEquals(split.all.msPerStep, 13 / 302, 1e-12);
  assertAlmostEquals(split.all.meanLoad, (113 / 3) / BUDGET, 1e-12);
  assertAlmostEquals(split.all.peakLoad, 100 / BUDGET, 1e-12);
  assertAlmostEquals(split.all.stepLoad, (13 / 302) / BUDGET, 1e-12);
  assertEquals(split.all.slowest, {
    wallMs: 100,
    steps: 0,
    resumed: false,
  });

  assertEquals(split.reloaded.samples, 2);
  assertEquals(split.reloaded.totalSteps, 2);
  assertEquals(split.reloaded.peakSteps, 2);
  assertAlmostEquals(split.reloaded.msPerStep, 5, 1e-12);
  assertEquals(split.reloaded.slowest?.steps, 0);
  assertEquals(split.reloaded.slowest?.resumed, false);

  assertEquals(split.resumed.samples, 1);
  assertEquals(split.resumed.peakSteps, 300);
  assertEquals(split.resumed.peakMs, 3);
  assertEquals(split.resumed.slowest, {
    wallMs: 3,
    steps: 300,
    resumed: true,
  });
  assertAlmostEquals(BUDGET, TICK_MS, 1e-12);
});

Deno.test("19.5 a later equal wall time becomes the slowest", () => {
  const split = summarizeReplaySeekLatency([
    { wallMs: 4, steps: 10, resumed: false },
    { wallMs: 4, steps: 2, resumed: true },
  ]);
  assertEquals(split.all.slowest, { wallMs: 4, steps: 2, resumed: true });
  assertEquals(split.all.peakSteps, 10);
  assertEquals(split.reloaded.slowest?.steps, 10);
  assertEquals(split.resumed.slowest?.steps, 2);
});

Deno.test("19.5 loads use the caller tick rate", () => {
  const split = summarizeReplaySeekLatency(
    [{ wallMs: 20, steps: 2, resumed: false }],
    10,
  );
  assertAlmostEquals(split.all.meanLoad, 20 / 100, 1e-12);
  assertAlmostEquals(split.all.msPerStep, 10, 1e-12);
  assertAlmostEquals(split.all.stepLoad, 10 / 100, 1e-12);
});

Deno.test("19.5 rejects a bad sample and a bad tick rate", () => {
  const cases: ReplaySeekLatencySample[] = [
    { wallMs: -1, steps: 0, resumed: false },
    { wallMs: Number.NaN, steps: 0, resumed: false },
    { wallMs: Number.POSITIVE_INFINITY, steps: 0, resumed: false },
    { wallMs: 1, steps: -1, resumed: false },
    { wallMs: 1, steps: 1.5, resumed: false },
    { wallMs: 1, steps: -0, resumed: false },
    { wallMs: 1, steps: Number.NaN, resumed: false },
    {
      wallMs: 1,
      steps: 0,
      resumed: 1 as unknown as boolean,
    },
  ];
  for (const sample of cases) {
    const err = assertThrows(
      () => summarizeReplaySeekLatency([sample]),
      ReplaySeekLatencyError,
    );
    assertEquals(err.code, REPLAY_SEEK_LATENCY_INVALID);
  }
  assertThrows(
    () => summarizeReplaySeekLatency([], 0),
    ReplaySeekLatencyError,
  );
  assertThrows(
    () => summarizeReplaySeekLatency([], 1.5),
    ReplaySeekLatencyError,
  );
});

Deno.test("19.5 summarize does not mutate its input", () => {
  const sample = Object.freeze({ wallMs: 1.25, steps: 4, resumed: false });
  const samples = Object.freeze([sample]);
  const split = summarizeReplaySeekLatency(samples);
  assertEquals(split.all.meanMs, 1.25);
  assertEquals(split.all.totalSteps, 4);
  assertEquals(samples[0], sample);
});

Deno.test("19.5 meter window drops the oldest seek; lifetime keeps it", () => {
  const meter = new ReplaySeekLatencyMeter({ capacity: 2 });
  meter.note({ wallMs: 4, steps: 10, resumed: false });
  meter.note({ wallMs: 4, steps: 2, resumed: true });
  meter.note({ wallMs: 1, steps: 0, resumed: false });
  const report = meter.report();
  assertEquals(report.tickHz, TICK_HZ);
  assertAlmostEquals(report.budgetMs, BUDGET, 1e-12);
  assertEquals(report.recent.all.samples, 2);
  assertEquals(report.recent.all.totalMs, 5);
  assertAlmostEquals(report.recent.all.rmsMs, Math.sqrt(8.5), 1e-12);
  assertEquals(report.recent.all.peakMs, 4);
  assertEquals(report.recent.all.peakSteps, 2);
  assertEquals(report.recent.all.slowest, {
    wallMs: 4,
    steps: 2,
    resumed: true,
  });
  assertEquals(report.recent.resumed.samples, 1);
  assertEquals(report.recent.reloaded.samples, 1);
  assertEquals(report.recent.reloaded.totalSteps, 0);

  assertEquals(report.lifetime.all.samples, 3);
  assertEquals(report.lifetime.all.totalMs, 9);
  assertEquals(report.lifetime.all.totalSteps, 12);
  assertEquals(report.lifetime.all.peakSteps, 10);
  assertEquals(report.lifetime.all.slowest, {
    wallMs: 4,
    steps: 2,
    resumed: true,
  });
  assertEquals(report.lifetime.reloaded.samples, 2);
  assertEquals(report.lifetime.reloaded.peakSteps, 10);
  assertAlmostEquals(report.lifetime.all.msPerStep, 8 / 12, 1e-12);

  const again = meter.report();
  assertEquals(again.lifetime.all.samples, report.lifetime.all.samples);
  assertEquals(again.recent.all.totalMs, report.recent.all.totalMs);
});

Deno.test("19.5 default window is the playback-cost seek bound", () => {
  assertEquals(REPLAY_SEEK_LATENCY_WINDOW, 30 * TICK_HZ);
  const meter = new ReplaySeekLatencyMeter();
  assertEquals(meter.report().recent.all.samples, 0);
  assertEquals(meter.report().lifetime.all.samples, 0);
  assertEquals(meter.report().lifetime.all.slowest, null);
});

Deno.test("19.5 measure uses the injected clock and still notes a throw", () => {
  let t = 10;
  const meter = new ReplaySeekLatencyMeter({ nowMs: () => t });
  const value = meter.measure({ steps: 3, resumed: false }, () => {
    t += 2.5;
    return "ok";
  });
  assertEquals(value, "ok");
  assertEquals(meter.report().recent.all.samples, 1);
  assertEquals(meter.report().recent.all.meanMs, 2.5);
  assertEquals(meter.report().recent.all.totalSteps, 3);
  assertEquals(meter.report().recent.reloaded.samples, 1);
  assertEquals(meter.report().lifetime.all.samples, 1);

  assertThrows(
    () =>
      meter.measure({ steps: 1, resumed: true }, () => {
        t += 1;
        throw new Error("boom");
      }),
    Error,
    "boom",
  );
  const after = meter.report();
  assertEquals(after.recent.all.samples, 2);
  assertAlmostEquals(after.recent.all.totalMs, 3.5, 1e-12);
  assertEquals(after.recent.all.totalSteps, 4);
  assertEquals(after.recent.resumed.samples, 1);
  assertEquals(after.lifetime.all.samples, 2);
});

Deno.test("19.5 a backwards clock stores 0 and keeps the plan", () => {
  let t = 5;
  const meter = new ReplaySeekLatencyMeter({ nowMs: () => t });
  meter.measure({ steps: 7, resumed: true }, () => {
    t = 1;
  });
  const report = meter.report();
  assertEquals(report.recent.all.samples, 1);
  assertEquals(report.recent.all.meanMs, 0);
  assertEquals(report.recent.all.totalSteps, 7);
  assertEquals(report.recent.resumed.samples, 1);
  assertEquals(report.recent.resumed.slowest?.resumed, true);
  assertEquals(report.recent.reloaded.samples, 0);
  assertEquals(report.lifetime.all.samples, 1);
});

Deno.test("19.5 a bad plan does not run the scrub", () => {
  const meter = new ReplaySeekLatencyMeter({ capacity: 2 });
  let called = false;
  assertThrows(
    () =>
      meter.measure({ steps: -1, resumed: false }, () => {
        called = true;
        return 1;
      }),
    ReplaySeekLatencyError,
  );
  assertEquals(called, false);
  assertThrows(
    () =>
      meter.measure(
        { steps: 1, resumed: "yes" as unknown as boolean },
        () => {
          called = true;
          return 1;
        },
      ),
    ReplaySeekLatencyError,
  );
  assertEquals(called, false);
  assertEquals(meter.report().lifetime.all.samples, 0);
});

Deno.test("19.5 note and capacity reject bad values", () => {
  const meter = new ReplaySeekLatencyMeter({ capacity: 2 });
  const bad: ReplaySeekLatencySample[] = [
    { wallMs: -0.1, steps: 0, resumed: false },
    { wallMs: Number.NaN, steps: 0, resumed: false },
    { wallMs: Number.POSITIVE_INFINITY, steps: 1, resumed: true },
    { wallMs: 1, steps: -0, resumed: false },
  ];
  for (const sample of bad) {
    const err = assertThrows(
      () => meter.note(sample),
      ReplaySeekLatencyError,
    );
    assertEquals(err.code, REPLAY_SEEK_LATENCY_INVALID);
  }
  assertEquals(meter.report().lifetime.all.samples, 0);
  assertThrows(
    () => new ReplaySeekLatencyMeter({ capacity: 0 }),
    ReplaySeekLatencyError,
  );
  assertThrows(
    () => new ReplaySeekLatencyMeter({ capacity: 1.5 }),
    ReplaySeekLatencyError,
  );
});

Deno.test("19.5 report tick rate is validated", () => {
  const meter = new ReplaySeekLatencyMeter({ capacity: 1 });
  meter.note({ wallMs: 1, steps: 1, resumed: false });
  assertThrows(() => meter.report(0), ReplaySeekLatencyError);
});

Deno.test("19.5 noting stores the numbers, not the caller's object", () => {
  const meter = new ReplaySeekLatencyMeter({ capacity: 2 });
  const sample = { wallMs: 4, steps: 3, resumed: false };
  meter.note(sample);
  sample.wallMs = 1;
  sample.steps = 9;
  sample.resumed = true;
  const report = meter.report();
  assertEquals(report.recent.all.meanMs, 4);
  assertEquals(report.recent.all.totalSteps, 3);
  assertEquals(report.recent.reloaded.samples, 1);
  assertEquals(report.recent.resumed.samples, 0);
  assertEquals(report.lifetime.all.samples, 1);
});

Deno.test("19.5 latency module reads the clock only as the meter default", async () => {
  const src = await Deno.readTextFile(
    new URL("./replaySeekLatency.ts", import.meta.url),
  );
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  const clocks = stripped.match(/performance\.now/g) ?? [];
  assertEquals(clocks.length, 1);
  assertEquals(/Deno\.write(?:File|TextFile)/.test(stripped), false);
  assertEquals(/\bJSON\.stringify\s*\(/.test(stripped), false);
  assertEquals(/executeReplayScrub/.test(stripped), false);
  assertEquals(/ReplayPlayback/.test(stripped), false);
});

const miniMap: DoorsMap = {
  name: "seek-latency",
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

function sampleMetadata(init: MatchInitEvent): MatchMetadata {
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
      runtimeMatchId: "rt-seek-latency",
      serverName: "seek-latency",
      serverId: "srv-seek-latency",
      modeId: "standard",
      raidId: null,
      buildSha: "deadbeef",
      raidMatch: { active: false },
    },
    { capturedAtIso: "2026-01-01T00:00:00.000Z" },
  );
  if (!built.ok) throw new Error(built.reason);
  return built.metadata;
}

function capturedSession(
  tickCount: number,
  checkpointTicks: readonly number[],
): {
  session: ReplayRunSession;
  collision: MapCollision;
} {
  const collision = new MapCollision(miniMap);
  const live = new PlayerManager(collision, {
    matchSeed: 0xb44c,
    matchDurationSeconds: 120,
    enablePrematch: false,
    nowMs: __replayTickNowMsForTest(0),
  });
  live.add("h1", "Human", "A", undefined, __replayTickNowMsForTest(0));
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
  const inputs = new Map<number, RecordedTickInputs>();
  const checkpoints: AuthoritativeCheckpoint[] = [];
  const wanted = new Set(checkpointTicks);
  const firstTick = 1;
  const lastTick = tickCount;
  for (let tick = firstTick; tick <= lastTick; tick++) {
    const nowMs = __replayTickNowMsForTest(tick);
    const human = live.get("h1");
    if (human?.alive) {
      const packet: PlayerInput = {
        sequence: tick,
        forward: tick % 2 === 0,
        backward: false,
        left: false,
        right: false,
        jump: false,
        sprint: false,
        crouch: false,
        meleeLunge: false,
        yaw: 0.05 * tick,
        pitch: 0,
      };
      live.handleInput("h1", packet, nowMs);
    }
    live.update(tick, nowMs);
    live.processScores(tick);
    live.checkMatchEnd(tick);
    live.checkMatchTimeLimit(tick);
    live.processRespawns(tick);
    const movement: TickSelectedInput[] = [];
    for (const player of live.all()) {
      const selected = player.lastTickInputSelection();
      if (!selected) throw new Error(`missing selection for ${player.id}`);
      movement.push(selected);
    }
    inputs.set(tick, { tick, movement, actions: [] });
    if (wanted.has(tick)) {
      live.drainAuthoritativeEvents();
      checkpoints.push(
        captureCheckpointState(live, tick, initialState.runtimeMatchId),
      );
    }
    live.drainAuthoritativeEvents();
  }
  const findPriorCheckpoint = floorFromCheckpointFrames(checkpoints);
  const session: ReplayRunSession = {
    initialState,
    firstTick,
    lastTick,
    inputAt(tick) {
      const row = inputs.get(tick);
      if (!row) throw new Error(`no inputs for ${tick}`);
      return row;
    },
    eventsAt() {
      return [];
    },
    checkpointFrameAt(tick) {
      return checkpoints.find((frame) => frame.tick === tick) ?? null;
    },
    findPriorCheckpoint,
  };
  return { session, collision };
}

Deno.test("19.5 playback times seeks, not frames, and a deep seek stays on the gap", () => {
  const { session, collision } = capturedSession(24, [10, 20]);
  const playback = createReplayPlayback(session, { collision });
  assertEquals(playback.getSeekLatency().lifetime.all.samples, 0);
  assertThrows(() => playback.seek(12), Error, "before start");
  assertEquals(playback.getSeekLatency().lifetime.all.samples, 0);

  playback.start();
  playback.setPaused(true);
  const held = playback.frame(TICK_MS);
  assertEquals(held.steps, 0);
  assertEquals(playback.getSeekLatency().lifetime.all.samples, 0);
  assertEquals(playback.getPlaybackCost().lifetime.samples, 0);

  const to12 = playback.seek(12);
  assertEquals(to12.steps, 2);
  assertEquals(to12.resumed, false);
  assertEquals(to12.anchorTick, 10);
  assertEquals(playback.state.currentTick, 12);
  assertEquals(playback.state.isPaused, true);
  const after12 = playback.getSeekLatency();
  assertEquals(after12.lifetime.all.samples, 1);
  assertEquals(after12.lifetime.all.totalSteps, 2);
  assertEquals(after12.lifetime.reloaded.samples, 1);
  assertEquals(after12.lifetime.resumed.samples, 0);
  assertEquals(after12.recent.all.peakSteps, 2);
  assertEquals(after12.lifetime.all.peakSteps < session.lastTick, true);
  assertEquals(Number.isFinite(after12.recent.all.meanMs), true);
  assertEquals(after12.recent.all.meanMs >= 0, true);
  assertEquals(playback.getPlaybackCost().lifetime.samples, 0);

  const to16 = playback.seek(16);
  assertEquals(to16.steps, 4);
  assertEquals(to16.resumed, true);
  const after16 = playback.getSeekLatency();
  assertEquals(after16.lifetime.all.samples, 2);
  assertEquals(after16.lifetime.all.totalSteps, 6);
  assertEquals(after16.lifetime.resumed.samples, 1);
  assertEquals(after16.lifetime.resumed.peakSteps, 4);

  const to22 = playback.seek(22);
  assertEquals(to22.steps, 2);
  assertEquals(to22.resumed, false);
  assertEquals(to22.anchorTick, 20);
  const after22 = playback.getSeekLatency();
  assertEquals(after22.lifetime.all.samples, 3);
  assertEquals(after22.lifetime.all.totalSteps, 8);
  assertEquals(after22.lifetime.reloaded.samples, 2);
  assertEquals(after22.lifetime.all.peakSteps, 4);
  assertEquals(after22.lifetime.all.totalSteps < session.lastTick, true);

  const exact = playback.seek(20);
  assertEquals(exact.steps, 0);
  assertEquals(exact.resumed, false);
  const afterExact = playback.getSeekLatency();
  assertEquals(afterExact.lifetime.all.samples, 4);
  assertEquals(afterExact.lifetime.all.totalSteps, 8);
  assertEquals(afterExact.lifetime.reloaded.samples, 3);
  assertEquals(playback.state.currentTick, 20);

  const again = playback.getSeekLatency();
  assertEquals(again.lifetime.all.samples, 4);
  assertEquals(playback.state.currentTick, 20);

  playback.setPaused(false);
  const played = playback.frame(TICK_MS);
  assertEquals(played.steps, 1);
  assertEquals(playback.getSeekLatency().lifetime.all.samples, 4);
  assertEquals(playback.getPlaybackCost().lifetime.samples, 1);
  assertEquals(playback.state.currentTick, 21);

  playback.start();
  assertEquals(playback.getSeekLatency().lifetime.all.samples, 4);
  assertEquals(playback.state.currentTick < 21, true);
});

Deno.test("19.5 seekToTimeMs is the same sample as a tick seek", () => {
  const { session, collision } = capturedSession(24, [10, 20]);
  const playback = createReplayPlayback(session, { collision });
  playback.start();
  const landed = playback.seekToTimeMs(tickToTimeMs(12));
  assertEquals(landed.targetTick, 12);
  assertEquals(landed.steps, 2);
  assertEquals(landed.resumed, false);
  const report = playback.getSeekLatency();
  assertEquals(report.lifetime.all.samples, 1);
  assertEquals(report.lifetime.all.totalSteps, 2);
  assertEquals(report.lifetime.reloaded.samples, 1);
});

Deno.test("19.5 a thrown seek still leaves a sample", () => {
  const { session, collision } = capturedSession(16, [10]);
  const original = session.inputAt.bind(session);
  session.inputAt = (tick) => {
    if (tick === 12) throw new Error("seek-boom");
    return original(tick);
  };
  const playback = createReplayPlayback(session, { collision });
  playback.start();
  assertThrows(() => playback.seek(12), Error, "seek-boom");
  const report = playback.getSeekLatency();
  assertEquals(report.lifetime.all.samples, 1);
  assertEquals(report.lifetime.all.totalSteps, 2);
  assertEquals(report.recent.all.meanMs >= 0, true);
  assertEquals(playback.getPlaybackCost().lifetime.samples, 0);
});

Deno.test("19.5 seek times the scrub and a frame does not", async () => {
  const src = await Deno.readTextFile(
    new URL("./replayPlaybackSession.ts", import.meta.url),
  );
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  assertEquals(/performance\.now\s*\(/.test(stripped), false);
  assertEquals(/[^\/\*]Date\.now\s*\(/.test(stripped), false);
  assertEquals(stripped.split("this.seekLatency.measure(").length - 1, 1);
  assertEquals(stripped.includes("return this.seekLatency.report()"), true);

  const frameStart = stripped.indexOf(
    "frame(dtWallMs: number): ReplayPlaybackFrameResult {",
  );
  const frameEnd = stripped.indexOf(
    "getPlaybackCost(): ReplayPlaybackCostReport {",
    frameStart,
  );
  const frameBody = stripped.slice(frameStart, frameEnd);
  assertEquals(frameBody.includes("seekLatency"), false);
  assertEquals(frameBody.includes("this.playbackCost.measure("), true);

  const seekStart = stripped.indexOf("private seekResolved(");
  const seekEnd = stripped.indexOf("setFocusedPlayerId(", seekStart);
  const seekBody = stripped.slice(seekStart, seekEnd);
  const planAt = seekBody.indexOf("planReplaySeek");
  const scrubPlanAt = seekBody.indexOf("planReplayScrub");
  const measureAt = seekBody.indexOf("this.seekLatency.measure(");
  const scrubAt = seekBody.indexOf("executeReplayScrub");
  const resetAt = seekBody.indexOf("clock.resetTo");
  const projectAt = seekBody.indexOf("this.projectCurrent");
  assertEquals(planAt > 0, true);
  assertEquals(scrubPlanAt > planAt, true);
  assertEquals(measureAt > scrubPlanAt, true);
  assertEquals(scrubAt > measureAt, true);
  assertEquals(resetAt > scrubAt, true);
  assertEquals(projectAt > resetAt, true);
  assertEquals(seekBody.includes("playbackCost"), false);
});
