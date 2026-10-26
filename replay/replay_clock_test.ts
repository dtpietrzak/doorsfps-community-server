/**
 * Epic 11.3 — replay clock.
 *
 * Run from server-community/:
 *   deno test -A replay/replay_clock_test.ts
 */

import {
  assertEquals,
  assertAlmostEquals,
  assertThrows,
} from "@std/assert";
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
  tickToTimeMs,
  tickToTimeSec,
  timeMsToTick,
} from "./checkpointIndex.ts";
import type { RecordedInitialState } from "./recordedInitialState.ts";
import type { RecordedTickInputs } from "./recordedTickInputs.ts";
import {
  __replayTickNowMsForTest,
  createReplayRunner,
  type ReplayRunSession,
} from "./replaySimulationRunner.ts";
import {
  createReplayClock,
  DEFAULT_REPLAY_SPEED,
  isReplaySpeed,
  MAX_STEPS_PER_ADVANCE,
  REPLAY_SPEEDS,
  ReplayClockRangeError,
  ReplayClockSpeedError,
  ReplayClockTickError,
  ReplayClockTimeDeltaError,
  type ReplaySpeed,
} from "./replayClock.ts";

// ---------------------------------------------------------------------------
// Fixtures (lockstep only)
// ---------------------------------------------------------------------------

const miniMap: DoorsMap = {
  name: "replay-clock",
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
      runtimeMatchId: "rt-clock-1",
      serverName: "clock-test",
      serverId: "srv-clock",
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

function liveCapturedSession(tickCount = 8): ReplayRunSession {
  const seed = 0xc10c;
  const collision = makeCollision();
  const live = new PlayerManager(collision, {
    matchSeed: seed,
    matchDurationSeconds: 120,
    enablePrematch: false,
    nowMs: __replayTickNowMsForTest(0),
  });

  live.add("h1", "Human", "A", undefined, __replayTickNowMsForTest(0));
  live.addBot("b1", "BotOne", { team: "B" });
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
    for (const p of live.all()) {
      const sel = p.lastTickInputSelection();
      if (!sel) throw new Error(`missing selection for ${p.id} at ${tick}`);
      movement.push(sel);
    }
    inputs.set(tick, { tick, movement, actions: [] });
    live.drainAuthoritativeEvents();
  }

  return {
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
    checkpointFrameAt() {
      return null;
    },
  };
}

function driveSteps(
  clock: ReturnType<typeof createReplayClock>,
  runner: ReturnType<typeof createReplayRunner>,
  dtWallMs: number,
): void {
  const result = clock.advance(dtWallMs);
  for (let t = result.fromTick; t < result.toTick; t++) {
    runner.step(t);
  }
  assertEquals(
    runner.currentTick,
    clock.currentTick,
    `lockstep broken: runner=${runner.currentTick} clock=${clock.currentTick}`,
  );
}

// ---------------------------------------------------------------------------
// Construction / state
// ---------------------------------------------------------------------------

Deno.test("11.3 construct: default speed 1, unpaused, virgin at firstTick", () => {
  const clock = createReplayClock({ firstTick: 10, lastTick: 100 });
  assertEquals(clock.firstTick, 10);
  assertEquals(clock.lastTick, 100);
  assertEquals(clock.currentTick, 10);
  assertEquals(clock.speed, DEFAULT_REPLAY_SPEED);
  assertEquals(clock.speed, 1);
  assertEquals(clock.isPaused, false);
  assertEquals(clock.isEnded, false);
  assertEquals(clock.carryMs, 0);
  assertEquals(clock.replayTimeMs, tickToTimeMs(10));
  assertEquals(clock.replayTimeSec, tickToTimeSec(10));
  assertEquals(clock.durationMs, tickToTimeMs(100 - 10 + 1));
});

Deno.test("11.3 construct: range validation + tickRate gate", () => {
  assertThrows(
    () => createReplayClock({ firstTick: 5, lastTick: 4 }),
    ReplayClockRangeError,
  );
  assertThrows(
    () => createReplayClock({ firstTick: -1, lastTick: 4 }),
    ReplayClockRangeError,
  );
  assertThrows(
    () => createReplayClock({ firstTick: 1.5, lastTick: 4 }),
    ReplayClockRangeError,
  );
  assertThrows(
    () => createReplayClock({ firstTick: 0, lastTick: 10, tickRate: 30 }),
    ReplayClockRangeError,
  );
  const ok = createReplayClock({ firstTick: 0, lastTick: 0, tickRate: TICK_HZ });
  assertEquals(ok.firstTick, 0);
  assertEquals(ok.lastTick, 0);
});

// ---------------------------------------------------------------------------
// Pause / resume / carry hygiene
// ---------------------------------------------------------------------------

Deno.test("11.3 pause: discards wall-dt, clears carry, preserves speed", () => {
  const clock = createReplayClock({ firstTick: 1, lastTick: 100 });
  // Partial tick at 1x
  clock.advance(TICK_MS * 0.5);
  assertAlmostEquals(clock.carryMs, TICK_MS * 0.5, 1e-9);

  clock.setSpeed(4);
  assertEquals(clock.carryMs, 0); // setSpeed clears
  clock.advance(TICK_MS * 0.1);
  assertAlmostEquals(clock.carryMs, TICK_MS * 0.1 * 4, 1e-9);

  clock.pause();
  assertEquals(clock.isPaused, true);
  assertEquals(clock.speed, 4);
  assertEquals(clock.carryMs, 0);

  const paused = clock.advance(TICK_MS * 10);
  assertEquals(paused.steps, 0);
  assertEquals(clock.carryMs, 0);

  clock.resume();
  assertEquals(clock.isPaused, false);
  assertEquals(clock.speed, 4);
  // Fresh wall time required post-resume
  const tiny = clock.advance(TICK_MS * 0.1);
  assertEquals(tiny.steps, 0);
  assertAlmostEquals(clock.carryMs, TICK_MS * 0.1 * 4, 1e-9);
});

Deno.test("11.3 pause×speed matrix: each armed speed stays paused", () => {
  for (const speed of REPLAY_SPEEDS) {
    const clock = createReplayClock({ firstTick: 1, lastTick: 50 });
    clock.setSpeed(speed);
    clock.pause();
    const r = clock.advance(TICK_MS * 100);
    assertEquals(r.steps, 0, `paused@${speed}`);
    assertEquals(clock.speed, speed);
    assertEquals(clock.carryMs, 0);
  }
});

// ---------------------------------------------------------------------------
// Speed set
// ---------------------------------------------------------------------------

Deno.test("11.3 speed: closed set advances at exact ratios", () => {
  for (const speed of REPLAY_SPEEDS) {
    const clock = createReplayClock({ firstTick: 1, lastTick: 10_000 });
    clock.setSpeed(speed);
    // 600 frames × TICK_MS wall → speed * 600 ticks
    let totalSteps = 0;
    for (let i = 0; i < 600; i++) {
      totalSteps += clock.advance(TICK_MS).steps;
    }
    assertEquals(totalSteps, speed * 600, `speed ${speed}`);
  }
});

Deno.test("11.3 speed: invalid values fail loud", () => {
  const clock = createReplayClock({ firstTick: 1, lastTick: 10 });
  for (const bad of [0, -1, NaN, Infinity, 3, "1", 1.5, null]) {
    assertThrows(
      () => clock.setSpeed(bad as ReplaySpeed),
      ReplayClockSpeedError,
    );
  }
  assertEquals(isReplaySpeed(1), true);
  assertEquals(isReplaySpeed(0), false);
  assertEquals(isReplaySpeed(3), false);
});

Deno.test("11.3 speed: setSpeed while paused stays paused", () => {
  const clock = createReplayClock({ firstTick: 1, lastTick: 10 });
  clock.pause();
  clock.setSpeed(2);
  assertEquals(clock.isPaused, true);
  assertEquals(clock.speed, 2);
  assertEquals(clock.advance(TICK_MS).steps, 0);
});

// ---------------------------------------------------------------------------
// Accumulator
// ---------------------------------------------------------------------------

Deno.test("11.3 accumulator: 0.25x emits 1 tick per 4 frames; 4x emits 4 per frame", () => {
  const slow = createReplayClock({ firstTick: 1, lastTick: 1000 });
  slow.setSpeed(0.25);
  for (let i = 0; i < 3; i++) {
    assertEquals(slow.advance(TICK_MS).steps, 0);
  }
  assertEquals(slow.advance(TICK_MS).steps, 1);
  assertEquals(slow.currentTick, 1);

  const fast = createReplayClock({ firstTick: 1, lastTick: 1000 });
  fast.setSpeed(4);
  const r = fast.advance(TICK_MS);
  assertEquals(r.steps, 4);
  assertEquals(r.fromTick, 1);
  assertEquals(r.toTick, 5);
  assertEquals(fast.currentTick, 4);
});

Deno.test("11.3 accumulator: non-multiple dt leaves exact remainder carry", () => {
  const clock = createReplayClock({ firstTick: 1, lastTick: 100 });
  const r = clock.advance(TICK_MS * 2.25);
  assertEquals(r.steps, 2);
  assertAlmostEquals(clock.carryMs, TICK_MS * 0.25, 1e-9);
});

// ---------------------------------------------------------------------------
// Cap
// ---------------------------------------------------------------------------

Deno.test("11.3 cap: huge dt clamps to MAX_STEPS_PER_ADVANCE and counts drops", () => {
  const clock = createReplayClock({ firstTick: 1, lastTick: 100_000 });
  const hugeDt = TICK_MS * (MAX_STEPS_PER_ADVANCE + 100);
  const r = clock.advance(hugeDt);
  assertEquals(r.steps, MAX_STEPS_PER_ADVANCE);
  assertEquals(r.droppedSteps, 100);
  assertEquals(clock.currentTick, MAX_STEPS_PER_ADVANCE);
  // Cap surplus not banked — only fractional residue (none here)
  assertAlmostEquals(clock.carryMs, 0, 1e-9);
});

// ---------------------------------------------------------------------------
// End clamp
// ---------------------------------------------------------------------------

Deno.test("11.3 end: clamps to lastTick, zeroes carry, further advances are 0", () => {
  const clock = createReplayClock({ firstTick: 1, lastTick: 5 });
  const r = clock.advance(TICK_MS * 100);
  assertEquals(r.steps, 5);
  assertEquals(r.fromTick, 1);
  assertEquals(r.toTick, 6);
  assertEquals(r.ended, true);
  assertEquals(clock.currentTick, 5);
  assertEquals(clock.isEnded, true);
  assertEquals(clock.carryMs, 0);

  const again = clock.advance(TICK_MS * 10);
  assertEquals(again.steps, 0);
  assertEquals(again.ended, true);
  assertEquals(clock.currentTick, 5);
});

Deno.test("11.3 end: resetTo off the end clears isEnded", () => {
  const clock = createReplayClock({ firstTick: 1, lastTick: 5 });
  clock.advance(TICK_MS * 100);
  assertEquals(clock.isEnded, true);
  clock.resetTo(3);
  assertEquals(clock.isEnded, false);
  assertEquals(clock.currentTick, 3);
  assertEquals(clock.carryMs, 0);
  // Next step is 4
  const r = clock.advance(TICK_MS);
  assertEquals(r.fromTick, 4);
  assertEquals(r.toTick, 5);
  assertEquals(clock.currentTick, 4);
});

// ---------------------------------------------------------------------------
// resetTo
// ---------------------------------------------------------------------------

Deno.test("11.3 resetTo: in-range sets position; one-past clamps; bad ticks fail", () => {
  const clock = createReplayClock({ firstTick: 10, lastTick: 20 });
  clock.advance(TICK_MS * 3);
  clock.resetTo(15);
  assertEquals(clock.currentTick, 15);
  assertEquals(clock.carryMs, 0);
  assertEquals(clock.isEnded, false);

  clock.resetTo(21); // one past → clamp
  assertEquals(clock.currentTick, 20);
  assertEquals(clock.isEnded, true);

  clock.resetTo(0); // below → clamp
  assertEquals(clock.currentTick, 10);
  assertEquals(clock.isEnded, false);

  assertThrows(() => clock.resetTo(1.5), ReplayClockTickError);
  assertThrows(() => clock.resetTo(NaN), ReplayClockTickError);
  assertThrows(() => clock.resetTo(Infinity), ReplayClockTickError);
});

// ---------------------------------------------------------------------------
// Tick ↔ time (floor, never msToTicks ceil)
// ---------------------------------------------------------------------------

Deno.test("11.3 tick↔time: resetTo(timeMsToTick(ms)) round-trips via floor", () => {
  const clock = createReplayClock({ firstTick: 0, lastTick: 1000 });
  const ms = TICK_MS * 42 + TICK_MS * 0.75;
  const tick = timeMsToTick(ms);
  assertEquals(tick, 42); // floor, not ceil
  clock.resetTo(tick);
  assertEquals(clock.replayTimeMs, tickToTimeMs(42));
  assertEquals(timeMsToTick(clock.replayTimeMs), 42);
});

// ---------------------------------------------------------------------------
// Invalid dt
// ---------------------------------------------------------------------------

Deno.test("11.3 advance: invalid dtWallMs fails loud", () => {
  const clock = createReplayClock({ firstTick: 1, lastTick: 10 });
  for (const bad of [-1, NaN, Infinity, -Infinity]) {
    assertThrows(() => clock.advance(bad), ReplayClockTimeDeltaError);
  }
});

// ---------------------------------------------------------------------------
// Determinism / frozen clock
// ---------------------------------------------------------------------------

Deno.test("11.3 determinism: shifted wall origin yields identical step sequences", () => {
  const seq = (originShift: number): number[] => {
    const clock = createReplayClock({ firstTick: 1, lastTick: 50 });
    clock.setSpeed(2);
    const steps: number[] = [];
    // Fake frame deltas independent of Date.now — originShift unused in math
    // on purpose (proves purity); both runs feed the same dt stream.
    void originShift;
    for (const dt of [16.67, 16.67, 33.34, 8.33, 16.67, 50, 16.67]) {
      steps.push(clock.advance(dt).steps);
    }
    return steps;
  };
  assertEquals(seq(0), seq(1_000_000));
});

// ---------------------------------------------------------------------------
// Source exclusion scan
// ---------------------------------------------------------------------------

Deno.test("11.3 source-scan: no wall-clock / runner / fs / net imports", async () => {
  const src = await Deno.readTextFile(
    new URL("./replayClock.ts", import.meta.url),
  );
  for (const banned of [
    "Date.now",
    "performance.now",
    "requestAnimationFrame",
    "setInterval",
    "setTimeout",
    "replaySimulationRunner",
    "replayLoader",
    "GameLoop.ts",
    "PlayerManager",
    "BotManager",
    "Deno.",
    "node:fs",
    "ReplayBlobStore",
    "createStore",
    "from \"../net/",
    "from \"./net/",
  ]) {
    assertEquals(
      src.includes(banned),
      false,
      `banned token present: ${banned}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Runner lockstep + equivalence (clock-driven vs direct tick loop)
// ---------------------------------------------------------------------------

Deno.test("11.3 lockstep: clock advance + runner.step stay aligned at 1x and 4x", () => {
  for (const speed of [1, 4] as const) {
    const session = liveCapturedSession(8);
    const runner = createReplayRunner(session, { collision: makeCollision() });
    runner.resetToInitial();
    assertEquals(runner.currentTick, session.firstTick - 1);

    const clock = createReplayClock({
      firstTick: session.firstTick,
      lastTick: session.lastTick,
    });
    clock.setSpeed(speed);

    while (!clock.isEnded) {
      driveSteps(clock, runner, TICK_MS);
    }
    assertEquals(runner.currentTick, session.lastTick);
    assertEquals(clock.currentTick, session.lastTick);
  }
});

Deno.test("11.3 equivalence: clock-driven stepping ≡ direct tick loop outcomes", () => {
  const session = liveCapturedSession(6);

  const direct = createReplayRunner(session, { collision: makeCollision() });
  direct.resetToInitial();
  const directOver: Array<{ tick: number; digest: string }> = [];
  for (let t = session.firstTick; t <= session.lastTick; t++) {
    const out = direct.step(t);
    directOver.push({
      tick: out.tick,
      digest: JSON.stringify(out.rosterDigest),
    });
  }

  const viaClock = createReplayRunner(session, { collision: makeCollision() });
  viaClock.resetToInitial();
  const clock = createReplayClock({
    firstTick: session.firstTick,
    lastTick: session.lastTick,
  });
  const clockOver: Array<{ tick: number; digest: string }> = [];
  while (!clock.isEnded) {
    const result = clock.advance(TICK_MS);
    for (let t = result.fromTick; t < result.toTick; t++) {
      const out = viaClock.step(t);
      clockOver.push({
        tick: out.tick,
        digest: JSON.stringify(out.rosterDigest),
      });
    }
    assertEquals(viaClock.currentTick, clock.currentTick);
  }

  assertEquals(clockOver, directOver);
});
