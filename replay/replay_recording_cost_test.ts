/**
 * Epic 19.1 — recording CPU cost.
 *
 * Run from server-community/:
 *   deno test -A --unstable-net --node-modules-dir=manual replay/replay_recording_cost_test.ts
 */

import { assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import { TICK_HZ, TICK_MS } from "../shared/sim/game.ts";
import { GameServer } from "../runtime/GameServer.ts";
import { NoopAuthorityAdapter } from "../authority/adapter.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";
import { driveTick, serverInternals } from "../runtime/gameServerTestHarness.ts";
import { ReplayRecorder } from "./ReplayRecorder.ts";
import {
  REPLAY_RECORDING_COST_INVALID,
  REPLAY_RECORDING_COST_WINDOW_TICKS,
  ReplayRecordingCostError,
  ReplayRecordingCostMeter,
  summarizeReplayRecordingCost,
  type ReplayRecordingCostSample,
} from "./replayRecordingCost.ts";
import { settleRecorder, wireReplayRecorder } from "./replayTestHarness.ts";

const BUDGET = 1000 / TICK_HZ;

Deno.test("19.1 empty summary is a zero span", () => {
  const span = summarizeReplayRecordingCost([]);
  assertEquals(span.recording.samples, 0);
  assertEquals(span.idle.samples, 0);
  assertEquals(span.overheadMs, 0);
  assertEquals(span.overheadLoad, 0);
  assertEquals(span.comparedToIdle, false);
  assertEquals(span.recording.meanMs, 0);
  assertEquals(span.recording.rmsMs, 0);
});

Deno.test("19.1 recording-only cost is the absolute mean", () => {
  const span = summarizeReplayRecordingCost([
    { recordMs: 3, recording: true },
    { recordMs: 4, recording: true },
  ]);
  assertEquals(span.recording.samples, 2);
  assertEquals(span.recording.totalMs, 7);
  assertAlmostEquals(span.recording.meanMs, 3.5, 1e-12);
  assertAlmostEquals(span.recording.rmsMs, Math.sqrt(12.5), 1e-12);
  assertEquals(span.recording.peakMs, 4);
  assertAlmostEquals(span.recording.meanLoad, 3.5 / BUDGET, 1e-12);
  assertAlmostEquals(span.recording.peakLoad, 4 / BUDGET, 1e-12);
  assertEquals(span.idle.samples, 0);
  assertEquals(span.comparedToIdle, false);
  assertAlmostEquals(span.overheadMs, 3.5, 1e-12);
  assertAlmostEquals(span.overheadLoad, 3.5 / BUDGET, 1e-12);
  assertAlmostEquals(BUDGET, TICK_MS, 1e-12);
});

Deno.test("19.1 overhead is recording mean minus idle mean", () => {
  const span = summarizeReplayRecordingCost([
    { recordMs: 1, recording: false },
    { recordMs: 5, recording: true },
    { recordMs: 3, recording: false },
    { recordMs: 7, recording: true },
  ]);
  assertEquals(span.recording.samples, 2);
  assertEquals(span.idle.samples, 2);
  assertAlmostEquals(span.recording.meanMs, 6, 1e-12);
  assertAlmostEquals(span.idle.meanMs, 2, 1e-12);
  assertEquals(span.comparedToIdle, true);
  assertAlmostEquals(span.overheadMs, 4, 1e-12);
  assertAlmostEquals(span.overheadLoad, 4 / BUDGET, 1e-12);
});

Deno.test("19.1 a quieter recording path may report a negative overhead", () => {
  const span = summarizeReplayRecordingCost([
    { recordMs: 4, recording: false },
    { recordMs: 1, recording: true },
  ]);
  assertEquals(span.comparedToIdle, true);
  assertAlmostEquals(span.overheadMs, -3, 1e-12);
});

Deno.test("19.1 idle-only overhead is zero", () => {
  const span = summarizeReplayRecordingCost([
    { recordMs: 2, recording: false },
  ]);
  assertEquals(span.recording.samples, 0);
  assertEquals(span.overheadMs, 0);
  assertEquals(span.comparedToIdle, false);
});

Deno.test("19.1 rejects a bad sample and a bad tick rate", () => {
  const bad: ReplayRecordingCostSample[] = [
    { recordMs: -1, recording: true },
  ];
  const nan: ReplayRecordingCostSample[] = [
    { recordMs: Number.NaN, recording: true },
  ];
  const inf: ReplayRecordingCostSample[] = [
    { recordMs: Number.POSITIVE_INFINITY, recording: false },
  ];
  for (const samples of [bad, nan, inf]) {
    const err = assertThrows(
      () => summarizeReplayRecordingCost(samples),
      ReplayRecordingCostError,
    );
    assertEquals(err.code, REPLAY_RECORDING_COST_INVALID);
  }
  assertThrows(
    () => summarizeReplayRecordingCost([], 0),
    ReplayRecordingCostError,
  );
  assertThrows(
    () => summarizeReplayRecordingCost([], 1.5),
    ReplayRecordingCostError,
  );
});

Deno.test("19.1 summarize does not mutate its input", () => {
  const sample = Object.freeze({ recordMs: 1.25, recording: true });
  const samples = Object.freeze([sample]);
  const span = summarizeReplayRecordingCost(samples);
  assertEquals(span.recording.meanMs, 1.25);
  assertEquals(samples[0], sample);
});

Deno.test("19.1 meter window drops the oldest sample; lifetime keeps it", () => {
  const meter = new ReplayRecordingCostMeter({ capacity: 3 });
  meter.note(1, true);
  meter.note(2, true);
  meter.note(3, false);
  meter.note(4, true);
  const report = meter.report();
  assertEquals(report.tickHz, TICK_HZ);
  assertAlmostEquals(report.budgetMs, BUDGET, 1e-12);
  assertEquals(report.recent.recording.samples, 2);
  assertEquals(report.recent.idle.samples, 1);
  assertAlmostEquals(report.recent.recording.meanMs, 3, 1e-12);
  assertEquals(report.recent.recording.peakMs, 4);
  assertEquals(report.recent.idle.meanMs, 3);
  assertEquals(report.lifetime.recording.samples, 3);
  assertEquals(report.lifetime.idle.samples, 1);
  assertAlmostEquals(report.lifetime.recording.totalMs, 7, 1e-12);
  assertEquals(report.lifetime.recording.peakMs, 4);
  assertAlmostEquals(report.lifetime.recording.rmsMs, Math.sqrt((1 + 4 + 16) / 3), 1e-12);
});

Deno.test("19.1 default window is 30 seconds of ticks", () => {
  assertEquals(REPLAY_RECORDING_COST_WINDOW_TICKS, 30 * TICK_HZ);
  const meter = new ReplayRecordingCostMeter();
  assertEquals(meter.report().recent.recording.samples, 0);
  assertEquals(meter.report().lifetime.recording.samples, 0);
});

Deno.test("19.1 measure uses the injected clock and still notes a throw", () => {
  let t = 10;
  const meter = new ReplayRecordingCostMeter({
    nowMs: () => t,
  });
  const value = meter.measure(true, () => {
    t += 2.5;
    return "ok";
  });
  assertEquals(value, "ok");
  assertEquals(meter.report().recent.recording.samples, 1);
  assertEquals(meter.report().recent.recording.meanMs, 2.5);
  assertEquals(meter.report().lifetime.recording.samples, 1);

  assertThrows(
    () =>
      meter.measure(true, () => {
        t += 1;
        throw new Error("boom");
      }),
    Error,
    "boom",
  );
  const after = meter.report();
  assertEquals(after.recent.recording.samples, 2);
  assertAlmostEquals(after.recent.recording.totalMs, 3.5, 1e-12);
  assertEquals(after.lifetime.recording.samples, 2);
});

Deno.test("19.1 a backwards clock stores 0 and does not throw", () => {
  let t = 5;
  const meter = new ReplayRecordingCostMeter({
    nowMs: () => t,
  });
  meter.measure(false, () => {
    t = 1;
  });
  const report = meter.report();
  assertEquals(report.recent.idle.samples, 1);
  assertEquals(report.recent.idle.meanMs, 0);
  assertEquals(report.recent.overheadMs, 0);
});

Deno.test("19.1 note and capacity reject bad values", () => {
  const meter = new ReplayRecordingCostMeter({ capacity: 2 });
  for (const ms of [-0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const err = assertThrows(
      () => meter.note(ms, true),
      ReplayRecordingCostError,
    );
    assertEquals(err.code, REPLAY_RECORDING_COST_INVALID);
  }
  assertEquals(meter.report().lifetime.recording.samples, 0);
  assertThrows(
    () => new ReplayRecordingCostMeter({ capacity: 0 }),
    ReplayRecordingCostError,
  );
  assertThrows(
    () => new ReplayRecordingCostMeter({ capacity: 1.5 }),
    ReplayRecordingCostError,
  );
});

Deno.test("19.1 report tick rate is validated", () => {
  const meter = new ReplayRecordingCostMeter({ capacity: 1 });
  meter.note(1, true);
  assertThrows(() => meter.report(0), ReplayRecordingCostError);
});

Deno.test("19.1 cost module reads the clock only as the meter default", async () => {
  const src = await Deno.readTextFile(
    new URL("./replayRecordingCost.ts", import.meta.url),
  );
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  const clocks = stripped.match(/performance\.now/g) ?? [];
  assertEquals(clocks.length, 1);
  assertEquals(/Deno\.write(?:File|TextFile)/.test(stripped), false);
  assertEquals(/\bJSON\.stringify\s*\(/.test(stripped), false);
});

const miniMap: DoorsMap = {
  name: "recording-cost",
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

Deno.test("19.1 recorder onTick fills idle then recording and does not change capture", async () => {
  const server = new GameServer({
    name: "recording-cost",
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
  const internals = serverInternals(server);
  internals.sessions = { emit: () => {} };
  const { recorder } = wireReplayRecorder({
    attachSink: (sink) => server.attachReplaySink(sink),
    detachSink: () => server.detachReplaySink(),
  });

  recorder.onTick({
    tick: 1,
    inputs: new Map(),
    actions: [],
    events: [],
  });
  const before = recorder.getRecordingCost();
  assertEquals(before.recent.idle.samples, 1);
  assertEquals(before.recent.recording.samples, 0);
  assertEquals(before.recent.comparedToIdle, false);
  assertEquals(before.lifetime.idle.samples, 1);

  internals.players.add("s1", "A1", "A");
  internals.players.add("s2", "B1", "B");
  const start = internals.players.beginLiveMatch(1, 1_000);
  internals.beginRuntimeMatchIdentity(1);
  internals.emitMatchStart(start, 1);
  await settleRecorder(recorder);

  for (let t = 2; t <= 6; t++) driveTick(server, t, 1_000 + t);

  const counters = recorder.getActiveCounters();
  assertEquals(counters?.ticksObserved, 5);
  assertEquals(counters?.inputTicks, 5);
  const after = recorder.getRecordingCost();
  assertEquals(after.recent.idle.samples, 1);
  assertEquals(after.recent.recording.samples, 5);
  assertEquals(after.lifetime.recording.samples, 5);
  assertEquals(after.recent.comparedToIdle, true);
  assertEquals(Number.isFinite(after.recent.overheadMs), true);
  assertEquals(after.recent.recording.meanMs >= 0, true);
  assertEquals(after.budgetMs, 1000 / TICK_HZ);

  const again = recorder.getRecordingCost();
  assertEquals(again.lifetime.recording.samples, after.lifetime.recording.samples);
  assertEquals(recorder.getActiveCounters()?.ticksObserved, 5);
  assertEquals(recorder.getTickInputs(internals.runtimeMatchId, 6) != null, true);

  const recorderSrc = await Deno.readTextFile(
    new URL("./ReplayRecorder.ts", import.meta.url),
  );
  const stripped = recorderSrc
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  assertEquals(/performance\.now/.test(stripped), false);
  assertEquals(stripped.includes("this.recordingCost.measure("), true);
});

Deno.test("19.1 a failed onTick is still a recording sample", async () => {
  const server = new GameServer({
    name: "recording-cost-fail",
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
  const internals = serverInternals(server);
  internals.sessions = { emit: () => {} };
  const { recorder } = wireReplayRecorder({
    attachSink: (sink) => server.attachReplaySink(sink),
    detachSink: () => server.detachReplaySink(),
  });
  internals.players.add("s1", "A1", "A");
  const start = internals.players.beginLiveMatch(1, 1_000);
  internals.beginRuntimeMatchIdentity(1);
  internals.emitMatchStart(start, 1);
  await settleRecorder(recorder);

  recorder.onTick({
    tick: 4,
    inputs: new Map([["s1", null]]),
    actions: [],
    events: [],
  });
  const report = recorder.getRecordingCost();
  assertEquals(report.recent.recording.samples, 1);
  assertEquals(report.lifetime.recording.samples, 1);
  assertEquals(recorder.getActiveCounters()?.errorCount, 1);
  assertEquals(recorder instanceof ReplayRecorder, true);
});
