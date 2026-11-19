/**
 * Epic 19.4 — playback CPU cost.
 *
 * Run from server-community/:
 *   deno test -A --unstable-net --node-modules-dir=manual replay/replay_playback_cost_test.ts
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
import {
  type AuthoritativeCheckpoint,
  captureCheckpointState,
} from "./authoritativeCheckpoint.ts";
import type { RecordedInitialState } from "./recordedInitialState.ts";
import type { RecordedTickInputs } from "./recordedTickInputs.ts";
import {
  __replayTickNowMsForTest,
  type ReplayRunSession,
} from "./replaySimulationRunner.ts";
import { createReplayPlayback } from "./replayPlaybackSession.ts";
import {
  REPLAY_PLAYBACK_COST_INVALID,
  REPLAY_PLAYBACK_COST_WINDOW_TICKS,
  ReplayPlaybackCostError,
  ReplayPlaybackCostMeter,
  summarizeReplayPlaybackCost,
  type ReplayPlaybackCostSample,
} from "./replayPlaybackCost.ts";

const BUDGET = 1000 / TICK_HZ;

Deno.test("19.4 empty summary is a zero bucket", () => {
  const bucket = summarizeReplayPlaybackCost([]);
  assertEquals(bucket.samples, 0);
  assertEquals(bucket.totalMs, 0);
  assertEquals(bucket.meanMs, 0);
  assertEquals(bucket.rmsMs, 0);
  assertEquals(bucket.peakMs, 0);
  assertEquals(bucket.meanLoad, 0);
  assertEquals(bucket.peakLoad, 0);
});

Deno.test("19.4 a step sample reports mean, rms, peak, and load", () => {
  const bucket = summarizeReplayPlaybackCost([
    { simMs: 3 },
    { simMs: 4 },
  ]);
  assertEquals(bucket.samples, 2);
  assertEquals(bucket.totalMs, 7);
  assertAlmostEquals(bucket.meanMs, 3.5, 1e-12);
  assertAlmostEquals(bucket.rmsMs, Math.sqrt(12.5), 1e-12);
  assertEquals(bucket.peakMs, 4);
  assertAlmostEquals(bucket.meanLoad, 3.5 / BUDGET, 1e-12);
  assertAlmostEquals(bucket.peakLoad, 4 / BUDGET, 1e-12);
  assertAlmostEquals(BUDGET, TICK_MS, 1e-12);
});

Deno.test("19.4 rejects a bad sample and a bad tick rate", () => {
  const cases: ReplayPlaybackCostSample[][] = [
    [{ simMs: -1 }],
    [{ simMs: Number.NaN }],
    [{ simMs: Number.POSITIVE_INFINITY }],
  ];
  for (const samples of cases) {
    const err = assertThrows(
      () => summarizeReplayPlaybackCost(samples),
      ReplayPlaybackCostError,
    );
    assertEquals(err.code, REPLAY_PLAYBACK_COST_INVALID);
  }
  assertThrows(
    () => summarizeReplayPlaybackCost([], 0),
    ReplayPlaybackCostError,
  );
  assertThrows(
    () => summarizeReplayPlaybackCost([], 1.5),
    ReplayPlaybackCostError,
  );
});

Deno.test("19.4 summarize does not mutate its input", () => {
  const sample = Object.freeze({ simMs: 1.25 });
  const samples = Object.freeze([sample]);
  const bucket = summarizeReplayPlaybackCost(samples);
  assertEquals(bucket.meanMs, 1.25);
  assertEquals(samples[0], sample);
});

Deno.test("19.4 meter window drops the oldest step; lifetime keeps it", () => {
  const meter = new ReplayPlaybackCostMeter({ capacity: 3 });
  meter.note(1);
  meter.note(2);
  meter.note(3);
  meter.note(4);
  const report = meter.report();
  assertEquals(report.tickHz, TICK_HZ);
  assertAlmostEquals(report.budgetMs, BUDGET, 1e-12);
  assertEquals(report.recent.samples, 3);
  assertAlmostEquals(report.recent.meanMs, 3, 1e-12);
  assertEquals(report.recent.totalMs, 9);
  assertEquals(report.recent.peakMs, 4);
  assertEquals(report.lifetime.samples, 4);
  assertEquals(report.lifetime.totalMs, 10);
  assertEquals(report.lifetime.peakMs, 4);
  assertAlmostEquals(report.lifetime.rmsMs, Math.sqrt(7.5), 1e-12);

  const again = meter.report();
  assertEquals(again.lifetime.samples, report.lifetime.samples);
  assertEquals(again.recent.totalMs, report.recent.totalMs);
});

Deno.test("19.4 default window is 30 seconds of simulated ticks", () => {
  assertEquals(REPLAY_PLAYBACK_COST_WINDOW_TICKS, 30 * TICK_HZ);
  const meter = new ReplayPlaybackCostMeter();
  assertEquals(meter.report().recent.samples, 0);
  assertEquals(meter.report().lifetime.samples, 0);
});

Deno.test("19.4 measure uses the injected clock and still notes a throw", () => {
  let t = 10;
  const meter = new ReplayPlaybackCostMeter({ nowMs: () => t });
  const value = meter.measure(() => {
    t += 2.5;
    return "ok";
  });
  assertEquals(value, "ok");
  assertEquals(meter.report().recent.samples, 1);
  assertEquals(meter.report().recent.meanMs, 2.5);
  assertEquals(meter.report().lifetime.samples, 1);

  assertThrows(
    () =>
      meter.measure(() => {
        t += 1;
        throw new Error("boom");
      }),
    Error,
    "boom",
  );
  const after = meter.report();
  assertEquals(after.recent.samples, 2);
  assertAlmostEquals(after.recent.totalMs, 3.5, 1e-12);
  assertEquals(after.lifetime.samples, 2);
});

Deno.test("19.4 a backwards clock stores 0 and does not throw", () => {
  let t = 5;
  const meter = new ReplayPlaybackCostMeter({ nowMs: () => t });
  meter.measure(() => {
    t = 1;
  });
  const report = meter.report();
  assertEquals(report.recent.samples, 1);
  assertEquals(report.recent.meanMs, 0);
  assertEquals(report.lifetime.samples, 1);
});

Deno.test("19.4 note and capacity reject bad values", () => {
  const meter = new ReplayPlaybackCostMeter({ capacity: 2 });
  for (const ms of [-0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const err = assertThrows(
      () => meter.note(ms),
      ReplayPlaybackCostError,
    );
    assertEquals(err.code, REPLAY_PLAYBACK_COST_INVALID);
  }
  assertEquals(meter.report().lifetime.samples, 0);
  assertThrows(
    () => new ReplayPlaybackCostMeter({ capacity: 0 }),
    ReplayPlaybackCostError,
  );
  assertThrows(
    () => new ReplayPlaybackCostMeter({ capacity: 1.5 }),
    ReplayPlaybackCostError,
  );
});

Deno.test("19.4 report tick rate is validated", () => {
  const meter = new ReplayPlaybackCostMeter({ capacity: 1 });
  meter.note(1);
  assertThrows(() => meter.report(0), ReplayPlaybackCostError);
});

Deno.test("19.4 noting stores the duration, not the caller's object", () => {
  const meter = new ReplayPlaybackCostMeter({ capacity: 2 });
  const sample = { simMs: 4 };
  meter.note(sample.simMs);
  sample.simMs = 1;
  assertEquals(meter.report().recent.meanMs, 4);
  assertEquals(meter.report().lifetime.samples, 1);
});

Deno.test("19.4 cost module reads the clock only as the meter default", async () => {
  const src = await Deno.readTextFile(
    new URL("./replayPlaybackCost.ts", import.meta.url),
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
  name: "playback-cost",
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
      runtimeMatchId: "rt-playback-cost",
      serverName: "playback-cost",
      serverId: "srv-playback-cost",
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

function shortSession(tickCount: number): {
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
  const checkpoints = new Map<number, AuthoritativeCheckpoint>();
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
    if (tick === firstTick || tick === lastTick) {
      live.drainAuthoritativeEvents();
      checkpoints.set(
        tick,
        captureCheckpointState(live, tick, initialState.runtimeMatchId),
      );
    }
    live.drainAuthoritativeEvents();
  }
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
      return checkpoints.get(tick) ?? null;
    },
  };
  return { session, collision };
}

Deno.test("19.4 playback counts frame steps, skips pause and seek, and a read adds nothing", () => {
  const { session, collision } = shortSession(8);
  const playback = createReplayPlayback(session, { collision });
  playback.start();
  assertEquals(playback.getPlaybackCost().lifetime.samples, 0);

  playback.setPaused(true);
  const held = playback.frame(TICK_MS);
  assertEquals(held.steps, 0);
  assertEquals(playback.getPlaybackCost().lifetime.samples, 0);

  playback.setPaused(false);
  const partial = playback.frame(TICK_MS / 4);
  assertEquals(partial.steps, 0);
  assertEquals(playback.getPlaybackCost().recent.samples, 0);

  const one = playback.frame(TICK_MS);
  assertEquals(one.steps, 1);
  const afterOne = playback.getPlaybackCost();
  assertEquals(afterOne.lifetime.samples, 1);
  assertEquals(afterOne.recent.samples, 1);
  assertEquals(afterOne.tickHz, TICK_HZ);
  assertEquals(afterOne.budgetMs, BUDGET);
  assertEquals(Number.isFinite(afterOne.recent.meanMs), true);
  assertEquals(afterOne.recent.meanMs >= 0, true);
  assertAlmostEquals(
    afterOne.recent.meanLoad,
    afterOne.recent.meanMs / afterOne.budgetMs,
    1e-12,
  );
  const tickAfterOne = playback.state.currentTick;

  const again = playback.getPlaybackCost();
  assertEquals(again.lifetime.samples, 1);
  assertEquals(playback.state.currentTick, tickAfterOne);

  const landed = playback.seek(3);
  assertEquals(landed.steps > 0, true);
  assertEquals(playback.getPlaybackCost().lifetime.samples, 1);
  assertEquals(playback.state.currentTick, 3);

  playback.setSpeed(4);
  const fast = playback.frame(TICK_MS);
  assertEquals(fast.steps, 4);
  const afterFast = playback.getPlaybackCost();
  assertEquals(afterFast.lifetime.samples, 5);
  assertEquals(afterFast.recent.samples, 5);
  assertEquals(playback.state.currentTick, 7);

  playback.start();
  assertEquals(playback.getPlaybackCost().lifetime.samples, 5);
  assertEquals(playback.state.currentTick < 7, true);
});

Deno.test("19.4 a thrown playback step still leaves a sample", () => {
  const { session, collision } = shortSession(4);
  const original = session.inputAt.bind(session);
  session.inputAt = (tick) => {
    if (tick === 2) throw new Error("step-boom");
    return original(tick);
  };
  const playback = createReplayPlayback(session, { collision });
  playback.start();
  const first = playback.frame(TICK_MS);
  assertEquals(first.steps, 1);
  assertThrows(() => playback.frame(TICK_MS), Error, "step-boom");
  const report = playback.getPlaybackCost();
  assertEquals(report.lifetime.samples, 2);
  assertEquals(report.recent.samples, 2);
  assertEquals(report.recent.meanMs >= 0, true);
});

Deno.test("19.4 frame times the step and seek does not", async () => {
  const src = await Deno.readTextFile(
    new URL("./replayPlaybackSession.ts", import.meta.url),
  );
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  assertEquals(/performance\.now\s*\(/.test(stripped), false);
  assertEquals(/[^\/\*]Date\.now\s*\(/.test(stripped), false);
  assertEquals(stripped.split("this.playbackCost.measure(").length - 1, 1);
  assertEquals(stripped.includes("return this.playbackCost.report()"), true);

  const frameStart = stripped.indexOf(
    "frame(dtWallMs: number): ReplayPlaybackFrameResult {",
  );
  const frameEnd = stripped.indexOf(
    "getPlaybackCost(): ReplayPlaybackCostReport {",
    frameStart,
  );
  const frameBody = stripped.slice(frameStart, frameEnd);
  const measureAt = frameBody.indexOf("this.playbackCost.measure(");
  const stepAt = frameBody.indexOf("this.runner.step(tick)");
  const viewAt = frameBody.indexOf("viewFromRunner");
  assertEquals(measureAt > 0, true);
  assertEquals(stepAt > measureAt, true);
  assertEquals(viewAt > stepAt, true);

  const seekStart = stripped.indexOf("private seekResolved(");
  const seekEnd = stripped.indexOf("setFocusedPlayerId(", seekStart);
  const seekBody = stripped.slice(seekStart, seekEnd);
  assertEquals(seekBody.includes("playbackCost"), false);
  assertEquals(seekBody.includes("executeReplayScrub"), true);
});
