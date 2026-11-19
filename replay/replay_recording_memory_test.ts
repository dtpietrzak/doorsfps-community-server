/**
 * Epic 19.2 — recording memory cost.
 *
 * Run from server-community/:
 *   deno test -A --unstable-net --node-modules-dir=manual replay/replay_recording_memory_test.ts
 */

import { assertAlmostEquals, assertEquals, assertExists, assertThrows } from "@std/assert";
import { TICK_HZ } from "../shared/sim/game.ts";
import { GameServer } from "../runtime/GameServer.ts";
import { NoopAuthorityAdapter } from "../authority/adapter.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";
import { driveTick, serverInternals } from "../runtime/gameServerTestHarness.ts";
import { captureCheckpointState } from "./authoritativeCheckpoint.ts";
import type { AuthoritativeCheckpoint } from "./authoritativeCheckpoint.ts";
import type { RecordedInitialState } from "./recordedInitialState.ts";
import type { RecordedTickEvents } from "./recordedTickEvents.ts";
import type { RecordedTickInputs } from "./recordedTickInputs.ts";
import {
  estimateCheckpointBytes,
  estimateEventsBytes,
  estimateInitBytes,
  estimateInputsBytes,
  ReplaySessionBuffer,
} from "./replaySessionBuffer.ts";
import {
  REPLAY_RECORDING_MEMORY_IDLE,
  REPLAY_RECORDING_MEMORY_INVALID,
  REPLAY_RECORDING_MEMORY_WINDOW_TICKS,
  ReplayRecordingMemoryError,
  ReplayRecordingMemoryMeter,
  sampleReplayBufferMemory,
  summarizeReplayRecordingMemory,
  type ReplayRecordingMemorySample,
} from "./replayRecordingMemory.ts";
import { settleRecorder, wireReplayRecorder } from "./replayTestHarness.ts";

function heldSample(
  over: Partial<ReplayRecordingMemorySample> = {},
): ReplayRecordingMemorySample {
  return {
    held: true,
    bufferBytes: 0,
    checkpointBytes: 0,
    startCheckpointBytes: 0,
    usageTicks: 0,
    inputRows: 0,
    eventRows: 0,
    checkpointCount: 0,
    capLimitBytes: 1000,
    ...over,
  };
}

Deno.test("19.2 empty summary is the idle level", () => {
  const { current, peak } = summarizeReplayRecordingMemory([]);
  assertEquals(current.held, false);
  assertEquals(current.heldBytes, 0);
  assertEquals(current.capBytes, 0);
  assertEquals(current.capLoad, 0);
  assertEquals(current.checkpointShare, 0);
  assertEquals(current.checkpointMemoryShare, 0);
  assertEquals(current.capBytesPerTick, 0);
  assertEquals(peak, current);
});

Deno.test("19.2 a reading splits the cap from the opening frame", () => {
  const { current } = summarizeReplayRecordingMemory([
    heldSample({
      bufferBytes: 100,
      checkpointBytes: 300,
      startCheckpointBytes: 100,
      usageTicks: 4,
      inputRows: 4,
      eventRows: 1,
      checkpointCount: 2,
      capLimitBytes: 1000,
    }),
  ]);
  assertEquals(current.held, true);
  assertEquals(current.capBytes, 400);
  assertEquals(current.heldBytes, 500);
  assertEquals(current.checkpointMemoryBytes, 400);
  assertEquals(current.capLoad, 0.4);
  assertEquals(current.checkpointShare, 0.75);
  assertEquals(current.checkpointMemoryShare, 0.8);
  assertEquals(current.capBytesPerTick, 100);
  assertEquals(current.inputRows, 4);
  assertEquals(current.eventRows, 1);
  assertEquals(current.checkpointCount, 2);
});

Deno.test("19.2 cap load may pass 1 and a zero tick has no per-tick rate", () => {
  const { current } = summarizeReplayRecordingMemory([
    heldSample({ bufferBytes: 150, capLimitBytes: 100, usageTicks: 0 }),
  ]);
  assertEquals(current.capLoad, 1.5);
  assertEquals(current.capBytesPerTick, 0);
  assertEquals(current.checkpointShare, 0);
});

Deno.test("19.2 peak is the greatest heldBytes and a later tie wins", () => {
  const { current, peak } = summarizeReplayRecordingMemory([
    heldSample({ bufferBytes: 10, usageTicks: 1 }),
    heldSample({ bufferBytes: 10, usageTicks: 4, inputRows: 4 }),
    heldSample({
      bufferBytes: 3,
      checkpointBytes: 4,
      startCheckpointBytes: 1,
      usageTicks: 2,
    }),
    REPLAY_RECORDING_MEMORY_IDLE,
  ]);
  assertEquals(current.held, false);
  assertEquals(current.heldBytes, 0);
  assertEquals(peak.held, true);
  assertEquals(peak.heldBytes, 10);
  assertEquals(peak.usageTicks, 4);
  assertEquals(peak.inputRows, 4);
});

Deno.test("19.2 rejects a bad sample", () => {
  const cases: ReplayRecordingMemorySample[] = [
    heldSample({ bufferBytes: -1 }),
    heldSample({ checkpointBytes: 1.5 }),
    heldSample({ startCheckpointBytes: Number.NaN }),
    heldSample({ usageTicks: Number.POSITIVE_INFINITY }),
    { ...REPLAY_RECORDING_MEMORY_IDLE, bufferBytes: 1 },
    { ...heldSample(), held: "yes" as unknown as boolean },
  ];
  for (const sample of cases) {
    const err = assertThrows(
      () => summarizeReplayRecordingMemory([sample]),
      ReplayRecordingMemoryError,
    );
    assertEquals(err.code, REPLAY_RECORDING_MEMORY_INVALID);
  }
});

Deno.test("19.2 summarize does not mutate its input", () => {
  const sample = Object.freeze(heldSample({ bufferBytes: 12, usageTicks: 3 }));
  const samples = Object.freeze([sample]);
  const { current } = summarizeReplayRecordingMemory(samples);
  assertEquals(current.bufferBytes, 12);
  assertEquals(samples[0], sample);
});

Deno.test("19.2 meter window drops the oldest note; lifetime keeps the peak", () => {
  const meter = new ReplayRecordingMemoryMeter({ capacity: 2 });
  meter.note(heldSample({ bufferBytes: 100, checkpointBytes: 20, usageTicks: 1 }));
  meter.note(heldSample({ bufferBytes: 10, usageTicks: 2 }));
  meter.note(REPLAY_RECORDING_MEMORY_IDLE);
  const report = meter.report();
  assertEquals(report.recentSamples, 2);
  assertEquals(report.lifetimeSamples, 3);
  assertEquals(report.current.held, false);
  assertEquals(report.recentPeak.heldBytes, 10);
  assertEquals(report.recentPeak.bufferBytes, 10);
  assertEquals(report.peak.heldBytes, 120);
  assertEquals(report.peak.bufferBytes, 100);
  assertEquals(report.peak.checkpointBytes, 20);
  assertEquals(report.peak.usageTicks, 1);
});

Deno.test("19.2 a note copies its fields", () => {
  const meter = new ReplayRecordingMemoryMeter({ capacity: 1 });
  const sample = {
    held: true,
    bufferBytes: 5,
    checkpointBytes: 0,
    startCheckpointBytes: 0,
    usageTicks: 0,
    inputRows: 0,
    eventRows: 0,
    checkpointCount: 0,
    capLimitBytes: 10,
  };
  meter.note(sample);
  sample.bufferBytes = 99;
  const report = meter.report();
  assertEquals(report.current.bufferBytes, 5);
  assertEquals(report.peak.bufferBytes, 5);
  assertEquals(report.current.capLoad, 0.5);
});

Deno.test("19.2 default window is 30 seconds of notes", () => {
  assertEquals(REPLAY_RECORDING_MEMORY_WINDOW_TICKS, 30 * TICK_HZ);
  const meter = new ReplayRecordingMemoryMeter();
  const report = meter.report();
  assertEquals(report.recentSamples, 0);
  assertEquals(report.lifetimeSamples, 0);
  assertEquals(report.current.held, false);
  assertEquals(report.peak.held, false);
});

Deno.test("19.2 note and capacity reject bad values", () => {
  const meter = new ReplayRecordingMemoryMeter({ capacity: 2 });
  const err = assertThrows(
    () => meter.note(heldSample({ eventRows: -1 })),
    ReplayRecordingMemoryError,
  );
  assertEquals(err.code, REPLAY_RECORDING_MEMORY_INVALID);
  assertEquals(meter.report().lifetimeSamples, 0);
  assertThrows(
    () => new ReplayRecordingMemoryMeter({ capacity: 0 }),
    ReplayRecordingMemoryError,
  );
  assertThrows(
    () => new ReplayRecordingMemoryMeter({ capacity: 1.5 }),
    ReplayRecordingMemoryError,
  );
});

Deno.test("19.2 reading the report twice adds no note", () => {
  const meter = new ReplayRecordingMemoryMeter({ capacity: 2 });
  meter.note(heldSample({ bufferBytes: 4 }));
  const first = meter.report();
  const second = meter.report();
  assertEquals(second.lifetimeSamples, first.lifetimeSamples);
  assertEquals(second.current.heldBytes, first.current.heldBytes);
});

Deno.test("19.2 buffer split keeps the cap total and names the opening frame", () => {
  const buffer = new ReplaySessionBuffer("m-mem");
  const state = {
    runtimeMatchId: "m-mem",
    captureTick: 1,
    init: { roster: [{}, {}] },
    metadata: {},
    startCheckpoint: { players: [{}, {}] },
  } as unknown as RecordedInitialState;
  buffer.setInit(state);
  assertEquals(buffer.usageBytesEstimate, estimateInitBytes(state));
  assertEquals(buffer.checkpointBytesEstimate, 0);
  const opened = sampleReplayBufferMemory(buffer);
  assertEquals(opened.held, true);
  assertEquals(opened.bufferBytes, estimateInitBytes(state));
  assertEquals(opened.checkpointBytes, 0);
  assertEquals(
    opened.startCheckpointBytes,
    estimateCheckpointBytes(state.startCheckpoint!),
  );
  assertEquals(opened.startCheckpointBytes > 0, true);

  const inputs = {
    tick: 1,
    movement: [{}],
    actions: [{}],
  } as unknown as RecordedTickInputs;
  const events = {
    tick: 1,
    events: [{}],
  } as unknown as RecordedTickEvents;
  buffer.putInputs(inputs);
  buffer.putEvents(events);
  const stream = buffer.usageBytesEstimate;
  assertEquals(
    stream,
    estimateInitBytes(state) + estimateInputsBytes(inputs) +
      estimateEventsBytes(events),
  );

  const wide = { tick: 1, players: [{}, {}] } as unknown as AuthoritativeCheckpoint;
  const narrow = { tick: 1, players: [{}] } as unknown as AuthoritativeCheckpoint;
  assertEquals(buffer.putCheckpoint(wide).ok, true);
  assertEquals(buffer.checkpointBytesEstimate, estimateCheckpointBytes(wide));
  assertEquals(buffer.usageBytesEstimate, stream + estimateCheckpointBytes(wide));
  assertEquals(buffer.putCheckpoint(narrow).ok, true);
  assertEquals(buffer.checkpointBytesEstimate, estimateCheckpointBytes(narrow));
  assertEquals(
    buffer.usageBytesEstimate,
    stream + estimateCheckpointBytes(narrow),
  );

  assertEquals(buffer.commitTick().ok, true);
  const sample = sampleReplayBufferMemory(buffer);
  assertEquals(sample.usageTicks, 1);
  assertEquals(sample.inputRows, 1);
  assertEquals(sample.eventRows, 1);
  assertEquals(sample.checkpointCount, 1);
  assertEquals(sample.bufferBytes, stream);
  assertEquals(sample.checkpointBytes, estimateCheckpointBytes(narrow));
  assertEquals(
    sample.bufferBytes + sample.checkpointBytes,
    buffer.usageBytesEstimate,
  );

  buffer.markFailed();
  assertEquals(sampleReplayBufferMemory(buffer).held, true);
  assertEquals(sampleReplayBufferMemory(buffer).bufferBytes, stream);
  buffer.discard();
  assertEquals(buffer.checkpointBytesEstimate, 0);
  assertEquals(buffer.usageBytesEstimate, 0);
  assertEquals(sampleReplayBufferMemory(buffer), REPLAY_RECORDING_MEMORY_IDLE);
});

Deno.test("19.2 memory module does not read a clock or write a file", async () => {
  const src = await Deno.readTextFile(
    new URL("./replayRecordingMemory.ts", import.meta.url),
  );
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  assertEquals(stripped.includes("performance.now"), false);
  assertEquals(/Deno\.write(?:File|TextFile)/.test(stripped), false);
  assertEquals(/\bJSON\.stringify\s*\(/.test(stripped), false);
});

const miniMap: DoorsMap = {
  name: "recording-memory",
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

Deno.test("19.2 recorder notes idle, then buffer and checkpoint bytes, and release returns to idle", async () => {
  const server = new GameServer({
    name: "recording-memory",
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
  const { recorder, blobDir } = wireReplayRecorder(
    {
      attachSink: (sink) => server.attachReplaySink(sink),
      detachSink: () => server.detachReplaySink(),
    },
    {
      captureCheckpointState: (tick, runtimeMatchId) =>
        captureCheckpointState(internals.players, tick, runtimeMatchId),
      captureStartState: (tick, runtimeMatchId) =>
        captureCheckpointState(
          internals.players,
          tick,
          runtimeMatchId,
          { active: false },
          { allowPendingEvents: true },
        ),
    },
  );
  try {
    recorder.onTick({
      tick: 1,
      inputs: new Map(),
      actions: [],
      events: [],
    });
    const idle = recorder.getRecordingMemory();
    assertEquals(idle.current.held, false);
    assertEquals(idle.lifetimeSamples, 1);
    assertEquals(idle.peak.heldBytes, 0);

    internals.players.add("s1", "A1", "A");
    internals.players.add("s2", "B1", "B");
    const start = internals.players.beginLiveMatch(1, 1_000);
    internals.beginRuntimeMatchIdentity(1);
    internals.emitMatchStart(start, 1);
    await settleRecorder(recorder);

    const opened = recorder.getRecordingMemory();
    assertEquals(opened.current.held, true);
    assertEquals(opened.current.startCheckpointBytes > 0, true);
    assertEquals(opened.current.checkpointCount, 0);
    assertEquals(opened.lifetimeSamples > idle.lifetimeSamples, true);

    for (let t = 2; t <= 6; t++) driveTick(server, t, 1_000 + t);

    const id = internals.runtimeMatchId;
    const frames = recorder.getCheckpointStream(id);
    assertExists(frames);
    assertEquals(frames.length, 1);
    const init = recorder.getInitialState(id);
    assertExists(init);
    assertExists(init.startCheckpoint);
    const usage = recorder.getBufferUsage(id);
    assertExists(usage);
    const live = recorder.getRecordingMemory();
    assertEquals(live.current.checkpointCount, 1);
    assertEquals(live.current.usageTicks, 5);
    assertEquals(live.current.inputRows, 5);
    assertEquals(
      live.current.checkpointBytes,
      estimateCheckpointBytes(frames[0]!),
    );
    assertEquals(
      live.current.startCheckpointBytes,
      estimateCheckpointBytes(init.startCheckpoint),
    );
    assertEquals(live.current.capBytes, usage.usageBytesEstimate);
    assertEquals(
      live.current.bufferBytes + live.current.checkpointBytes,
      live.current.capBytes,
    );
    assertEquals(
      live.current.heldBytes,
      live.current.capBytes + live.current.startCheckpointBytes,
    );
    assertEquals(live.current.bufferBytes > 0, true);
    assertEquals(live.current.checkpointBytes > 0, true);
    assertEquals(live.peak.heldBytes, live.current.heldBytes);
    assertAlmostEquals(
      live.current.checkpointShare,
      live.current.checkpointBytes / live.current.capBytes,
      1e-12,
    );
    assertEquals(recorder.getActiveCounters()?.ticksObserved, 5);

    const again = recorder.getRecordingMemory();
    assertEquals(again.lifetimeSamples, live.lifetimeSamples);
    assertEquals(recorder.getActiveCounters()?.ticksObserved, 5);

    recorder.shutdown();
    const done = recorder.getRecordingMemory();
    assertEquals(done.current.held, false);
    assertEquals(done.current.heldBytes, 0);
    assertEquals(done.current.checkpointBytes, 0);
    assertEquals(done.peak.heldBytes, live.peak.heldBytes);
    assertEquals(done.peak.checkpointBytes, live.current.checkpointBytes);
    assertEquals(done.peak.startCheckpointBytes, live.current.startCheckpointBytes);
    assertEquals(done.lifetimeSamples, live.lifetimeSamples + 2);
    assertEquals(recorder.getBufferUsage(id), null);
  } finally {
    if (blobDir) {
      try {
        Deno.removeSync(blobDir, { recursive: true });
      } catch {
        // temp dir already gone
      }
    }
  }
});

Deno.test("19.2 recorder notes memory outside the CPU sample and discards in one place", async () => {
  const src = await Deno.readTextFile(
    new URL("./ReplayRecorder.ts", import.meta.url),
  );
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  const measureStart = stripped.indexOf("this.recordingCost.measure(");
  const measureEnd = stripped.indexOf("});", measureStart);
  assertEquals(measureStart > 0, true);
  assertEquals(measureEnd > measureStart, true);
  assertEquals(
    stripped.slice(measureStart, measureEnd).includes("noteRecordingMemory"),
    false,
  );
  assertEquals(
    stripped.indexOf("this.noteRecordingMemory()", measureEnd) > measureEnd,
    true,
  );
  assertEquals(stripped.match(/\.discard\(\)/g)?.length, 1);
  assertEquals(stripped.includes("getRecordingMemory("), true);
});
