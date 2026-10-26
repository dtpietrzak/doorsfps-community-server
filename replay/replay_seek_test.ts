/**
 * Epic 14.3 — checkpoint-based seeking.
 *
 * Run from server-community/:
 *   deno test -A replay/replay_seek_test.ts
 */

import { assertEquals, assertThrows } from "@std/assert";
import {
  type AuthoritativeEvent,
  makePlayerDiedEvent,
  type MatchInitEvent,
  type PlayerDiedEvent,
} from "../shared/sim/authoritativeEvent.ts";
import {
  buildMatchMetadata,
  type MatchMetadata,
} from "../shared/replay/matchMetadata.ts";
import { TICK_MS } from "../shared/sim/game.ts";
import { PlayerManager } from "../players/PlayerManager.ts";
import type { TickSelectedInput } from "../players/tickAssociation.ts";
import type { DoorsMap } from "../world/map.ts";
import type { PlayerInput } from "../protocol/network.ts";
import { MapCollision } from "../world/MapCollision.ts";
import {
  type AuthoritativeCheckpoint,
  captureCheckpointState,
} from "./authoritativeCheckpoint.ts";
import { type CheckpointIndexLookup, tickToTimeMs } from "./checkpointIndex.ts";
import { compareSimulationState } from "./checkpointValidation.ts";
import type { RecordedInitialState } from "./recordedInitialState.ts";
import type { RecordedTickInputs } from "./recordedTickInputs.ts";
import { startKillcam } from "./killcamPlayback.ts";
import {
  createReplayPlayback,
  ReplayPlaybackError,
} from "./replayPlaybackSession.ts";
import {
  __replayTickNowMsForTest,
  createReplayRunner,
  type ReplayRunSession,
} from "./replaySimulationRunner.ts";
import {
  executeReplaySeek,
  floorFromCheckpointFrames,
  planReplaySeek,
  ReplaySeekError,
  type ReplaySeekPlan,
  resolveReplaySeekTick,
} from "./replaySeek.ts";

const miniMap: DoorsMap = {
  name: "replay-seek",
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
      runtimeMatchId: "rt-seek-1",
      serverName: "seek-test",
      serverId: "srv-seek",
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

function liveCapturedSession(tickCount = 16): {
  session: ReplayRunSession;
  collision: MapCollision;
  checkpoints: AuthoritativeCheckpoint[];
} {
  const collision = new MapCollision(miniMap);
  const live = new PlayerManager(collision, {
    matchSeed: 0x5eec,
    matchDurationSeconds: 120,
    enablePrematch: false,
    nowMs: __replayTickNowMsForTest(0),
  });
  live.add("h1", "Human", "A", undefined, __replayTickNowMsForTest(0));
  live.addBot("b1", "BotOne", { team: "B" });
  live.beginLiveMatch(0, __replayTickNowMsForTest(0));
  live.drainAuthoritativeEvents();
  const initRaw = live.buildMatchInitEvent(0);
  if (initRaw.kind !== "matchInit") throw new Error("expected matchInit");
  const metadata = sampleMetadata(initRaw);
  const initialState: RecordedInitialState = {
    runtimeMatchId: metadata.runtimeMatchId,
    captureTick: 0,
    init: initRaw,
    metadata,
  };

  const inputs = new Map<number, RecordedTickInputs>();
  const events = new Map<number, AuthoritativeEvent[]>();
  const checkpoints: AuthoritativeCheckpoint[] = [];
  const firstTick = 1;
  const lastTick = tickCount;
  const mid = Math.floor((firstTick + lastTick) / 2);

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
        sprint: false,
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
      if (!sel) throw new Error(`missing selection for ${p.id} at ${tick}`);
      movement.push(sel);
    }
    inputs.set(tick, { tick, movement, actions: [] });
    events.set(tick, []);

    if (tick === firstTick || tick === mid || tick === lastTick) {
      live.drainAuthoritativeEvents();
      checkpoints.push(
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
    eventsAt(tick) {
      return events.get(tick) ?? [];
    },
    checkpointFrameAt(tick) {
      return checkpoints.find((frame) => frame.tick === tick) ?? null;
    },
  };
  return { session, collision, checkpoints };
}

function withFloor(
  session: ReplayRunSession,
  checkpoints: readonly AuthoritativeCheckpoint[],
): ReplayRunSession {
  const findPriorCheckpoint = floorFromCheckpointFrames(checkpoints);
  return { ...session, findPriorCheckpoint };
}

function frameAt(tick: number): AuthoritativeCheckpoint {
  return { tick } as AuthoritativeCheckpoint;
}

function floorOf(ticks: readonly number[]): {
  find: (tick: number) => CheckpointIndexLookup;
  calls: () => readonly number[];
} {
  const sorted = [...ticks].sort((a, b) => a - b);
  const seen: number[] = [];
  return {
    calls: () => seen,
    find(tick: number): CheckpointIndexLookup {
      seen.push(tick);
      if (sorted.length === 0) return { kind: "miss", reason: "empty" };
      let hit: number | null = null;
      for (const candidate of sorted) {
        if (candidate <= tick) hit = candidate;
        else break;
      }
      if (hit === null) return { kind: "miss", reason: "before-first" };
      return { kind: "hit", frame: frameAt(hit) };
    },
  };
}

function playTo(
  session: ReplayRunSession,
  collision: MapCollision,
  tick: number,
) {
  const playback = createReplayPlayback(session, { collision });
  playback.start();
  const steps = tick - session.firstTick + 1;
  const frame = playback.frame(steps * TICK_MS);
  assertEquals(frame.droppedSteps, 0);
  assertEquals(playback.state.currentTick, tick);
  return playback;
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

Deno.test("14.3 floor: exact checkpoint steps nothing", () => {
  const floor = floorOf([4, 8]);
  const plan = planReplaySeek(8, 1, 16, floor.find);
  assertEquals(floor.calls(), [8]);
  assertEquals(plan.anchor.kind, "checkpoint");
  assertEquals(plan.steps, 0);
  assertEquals(plan.stepFrom, 9);
  if (plan.anchor.kind === "checkpoint") {
    assertEquals(plan.anchor.frame.tick, 8);
  }
});

Deno.test("14.3 floor: mid-interval uses the nearest prior checkpoint", () => {
  const floor = floorOf([4, 8, 12]);
  const plan = planReplaySeek(10, 1, 16, floor.find);
  assertEquals(floor.calls(), [10]);
  assertEquals(plan.anchor.kind, "checkpoint");
  assertEquals(plan.steps, 2);
  assertEquals(plan.stepFrom, 9);
});

Deno.test("14.3 floor: after the last checkpoint still uses that frame", () => {
  const plan = planReplaySeek(15, 1, 16, floorOf([4, 8]).find);
  assertEquals(plan.steps, 7);
  if (plan.anchor.kind === "checkpoint") {
    assertEquals(plan.anchor.frame.tick, 8);
  }
});

Deno.test("14.3 miss: empty and before-first start from initial state", () => {
  const empty = planReplaySeek(5, 1, 16, floorOf([]).find);
  assertEquals(empty.anchor.kind, "initial");
  assertEquals(empty.stepFrom, 1);
  assertEquals(empty.steps, 5);

  const early = planReplaySeek(3, 1, 16, floorOf([4, 8]).find);
  assertEquals(early.anchor.kind, "initial");
  assertEquals(early.steps, 3);
});

Deno.test("14.3 miss: a checkpoint before the session is not the anchor", () => {
  const plan = planReplaySeek(3, 1, 16, () => ({
    kind: "hit",
    frame: frameAt(0),
  }));
  assertEquals(plan.anchor.kind, "initial");
  assertEquals(plan.steps, 3);
});

Deno.test("14.3 floor is consulted once and never clamps forward", () => {
  let calls = 0;
  const plan = planReplaySeek(5, 1, 16, (tick) => {
    calls++;
    assertEquals(tick, 5);
    return { kind: "miss", reason: "before-first" };
  });
  assertEquals(calls, 1);
  assertEquals(plan.anchor.kind, "initial");
});

Deno.test("14.3 a floor that returns a later checkpoint fails loud", () => {
  assertThrows(
    () => planReplaySeek(5, 1, 16, () => ({ kind: "hit", frame: frameAt(9) })),
    ReplaySeekError,
    "after the target",
  );
});

Deno.test("14.3 time floors to the tick and out-of-range targets clamp", () => {
  assertEquals(resolveReplaySeekTick({ tick: 6 }, 1, 16), 6);
  assertEquals(resolveReplaySeekTick({ tick: -4 }, 1, 16), 1);
  assertEquals(resolveReplaySeekTick({ tick: 40 }, 1, 16), 16);
  assertEquals(
    resolveReplaySeekTick({ timeMs: tickToTimeMs(6) + TICK_MS / 2 }, 1, 16),
    6,
  );
  assertEquals(
    resolveReplaySeekTick({ timeMs: tickToTimeMs(17) }, 1, 16),
    16,
  );
  assertThrows(
    () => resolveReplaySeekTick({ tick: 1.5 }, 1, 16),
    ReplaySeekError,
    "integer",
  );
  assertThrows(
    () => resolveReplaySeekTick({ timeMs: Number.NaN }, 1, 16),
    ReplaySeekError,
    "finite",
  );
  assertThrows(
    () => planReplaySeek(0, 1, 16, floorOf([]).find),
    ReplaySeekError,
    "outside",
  );
});

// ---------------------------------------------------------------------------
// Runner parity
// ---------------------------------------------------------------------------

function runPlan(
  session: ReplayRunSession,
  collision: MapCollision,
  plan: ReplaySeekPlan,
) {
  const runner = createReplayRunner(session, { collision });
  executeReplaySeek(runner, plan, {
    onAnchored() {},
    onStepped() {},
  });
  return runner;
}

Deno.test("14.3 parity: checkpoint seek matches replay from the initial state", () => {
  const { session, collision, checkpoints } = liveCapturedSession();
  const floor = floorFromCheckpointFrames(checkpoints);
  const target = 12;
  const plan = planReplaySeek(
    target,
    session.firstTick,
    session.lastTick,
    floor,
  );
  assertEquals(plan.anchor.kind, "checkpoint");
  assertEquals(
    plan.steps > 0 && plan.steps < target - session.firstTick + 1,
    true,
  );

  const sought = runPlan(session, collision, plan);
  const full = createReplayRunner(session, { collision });
  full.resetToInitial();
  for (let tick = session.firstTick; tick <= target; tick++) full.step(tick);

  assertEquals(sought.currentTick, target);
  assertEquals(full.currentTick, target);
  const diff = compareSimulationState(
    full.simulation,
    sought.simulation,
    target,
    session.initialState.runtimeMatchId,
  );
  assertEquals(diff, null);
});

Deno.test("14.3 parity: exact checkpoint land matches a full replay", () => {
  const { session, collision, checkpoints } = liveCapturedSession();
  const mid = checkpoints[1]!;
  const plan = planReplaySeek(
    mid.tick,
    session.firstTick,
    session.lastTick,
    floorFromCheckpointFrames(checkpoints),
  );
  assertEquals(plan.steps, 0);
  const sought = runPlan(session, collision, plan);
  const full = createReplayRunner(session, { collision });
  full.resetToInitial();
  for (let tick = session.firstTick; tick <= mid.tick; tick++) full.step(tick);
  assertEquals(
    compareSimulationState(
      full.simulation,
      sought.simulation,
      mid.tick,
      session.initialState.runtimeMatchId,
    ),
    null,
  );
});

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

Deno.test("14.3 playback seek lands completed, then the next frame continues", () => {
  const { session, collision, checkpoints } = liveCapturedSession();
  const floored = withFloor(session, checkpoints);
  const playback = createReplayPlayback(floored, {
    collision,
    focusedPlayerId: "h1",
  });
  assertThrows(
    () => playback.seek(8),
    ReplayPlaybackError,
    "before start",
  );

  playback.start();
  playback.setSpeed(2);
  playback.setPaused(true);
  const target = 12;
  const result = playback.seek(target);
  assertEquals(result.targetTick, target);
  assertEquals(result.anchorKind, "checkpoint");
  assertEquals(result.anchorTick !== null && result.anchorTick < target, true);
  assertEquals(result.steps, target - result.anchorTick!);
  assertEquals(result.ended, false);
  assertEquals(playback.state.currentTick, target);
  assertEquals(playback.state.carryMs, 0);
  assertEquals(playback.state.speed, 2);
  assertEquals(playback.state.isPaused, true);
  assertEquals(playback.state.focusedPlayerId, "h1");
  assertEquals(playback.timeline.position.tick, target);
  assertEquals(playback.timeline.position.fraction, 0);

  const played = playTo(session, collision, target);
  assertEquals(playback.feeders.state(), played.feeders.state());

  playback.setPaused(false);
  playback.setSpeed(1);
  const frame = playback.frame(TICK_MS);
  assertEquals(frame.steps, 1);
  assertEquals(frame.fromTick, target + 1);
  assertEquals(playback.state.currentTick, target + 1);
});

Deno.test("14.5 seek continues across the gap already simulated", () => {
  const { session, collision, checkpoints } = liveCapturedSession();
  const playback = createReplayPlayback(withFloor(session, checkpoints), {
    collision,
  });
  playback.start();
  playback.setSpeed(2);
  playback.setPaused(true);
  playback.setPaused(false);
  playback.setSpeed(1);
  playback.frame(10 * TICK_MS);
  assertEquals(playback.state.currentTick, 10);
  const result = playback.seek(12);
  assertEquals(result.resumed, true);
  assertEquals(result.anchorKind, "checkpoint");
  assertEquals(result.anchorTick, 8);
  assertEquals(result.steps, 2);
  assertEquals(playback.state.currentTick, 12);
  assertEquals(playback.state.speed, 1);
  assertEquals(playback.state.isPaused, false);
  const played = playTo(session, collision, 12);
  assertEquals(playback.feeders.state(), played.feeders.state());
});

Deno.test("14.5 seek behind the cursor reloads the floor", () => {
  const { session, collision, checkpoints } = liveCapturedSession();
  const playback = createReplayPlayback(withFloor(session, checkpoints), {
    collision,
  });
  playback.start();
  playback.frame(12 * TICK_MS);
  const result = playback.seek(9);
  assertEquals(result.resumed, false);
  assertEquals(result.anchorTick, 8);
  assertEquals(result.steps, 1);
  assertEquals(playback.state.currentTick, 9);
  const played = playTo(session, collision, 9);
  assertEquals(playback.feeders.state(), played.feeders.state());
});

Deno.test("14.5 seek does not walk past a later checkpoint", () => {
  const { session, collision, checkpoints } = liveCapturedSession();
  const playback = createReplayPlayback(withFloor(session, checkpoints), {
    collision,
  });
  playback.start();
  playback.frame(3 * TICK_MS);
  assertEquals(playback.state.currentTick, 3);
  const result = playback.seek(12);
  assertEquals(result.resumed, false);
  assertEquals(result.anchorTick, 8);
  assertEquals(result.steps, 4);
  const played = playTo(session, collision, 12);
  assertEquals(playback.feeders.state(), played.feeders.state());
});

Deno.test("14.5 seek to the current tick does not resimulate", () => {
  const { session, collision, checkpoints } = liveCapturedSession();
  const playback = createReplayPlayback(withFloor(session, checkpoints), {
    collision,
  });
  playback.start();
  playback.frame(10 * TICK_MS);
  const result = playback.seek(10);
  assertEquals(result.resumed, true);
  assertEquals(result.steps, 0);
  assertEquals(playback.state.currentTick, 10);
  const played = playTo(session, collision, 10);
  assertEquals(playback.feeders.state(), played.feeders.state());
});

Deno.test("14.3 seek to the last tick ends the clock", () => {
  const { session, collision, checkpoints } = liveCapturedSession();
  const playback = createReplayPlayback(withFloor(session, checkpoints), {
    collision,
  });
  playback.start();
  const result = playback.seekToTimeMs(tickToTimeMs(session.lastTick + 1));
  assertEquals(result.targetTick, session.lastTick);
  assertEquals(result.ended, true);
  assertEquals(playback.state.isEnded, true);
  assertEquals(playback.timeline.isEnded, true);
  assertEquals(playback.timeline.progress, 1);
  const frame = playback.frame(TICK_MS);
  assertEquals(frame.steps, 0);
});

Deno.test("14.3 session without a floor still reaches the target", () => {
  const { session, collision } = liveCapturedSession();
  const playback = createReplayPlayback(session, { collision });
  playback.start();
  const result = playback.seek(6);
  assertEquals(result.anchorKind, "initial");
  assertEquals(result.anchorTick, null);
  assertEquals(result.steps, 6);
  assertEquals(playback.state.currentTick, 6);
  const played = playTo(session, collision, 6);
  assertEquals(playback.feeders.state(), played.feeders.state());
});

Deno.test("14.3 killcam open still arms the tick before the window", () => {
  const deathTick = 12;
  const died: PlayerDiedEvent = makePlayerDiedEvent({
    appliedTick: deathTick,
    victimId: "h1",
    killerId: "b1",
    zone: "body",
    weapon: 0,
    killerName: "b1",
    victimName: "h1",
    killerTeam: "B",
    victimTeam: "A",
  });
  const { session, collision, checkpoints } = liveCapturedSession();
  session.eventsAt = (tick) => (tick === deathTick ? [died] : []);
  const plain = startKillcam(session, { victimId: "h1", deathTick }, {
    collision,
    preMs: 50,
    postMs: 50,
  });
  const floored = startKillcam(
    withFloor(session, checkpoints),
    { victimId: "h1", deathTick },
    { collision, preMs: 50, postMs: 50 },
  );
  assertEquals(plain.openSteps, plain.window.startTick - session.firstTick);
  assertEquals(floored.openSteps, plain.openSteps);
  assertEquals(plain.playback.state.currentTick, plain.window.startTick - 1);
  assertEquals(
    floored.playback.state.currentTick,
    plain.playback.state.currentTick,
  );
  assertEquals(
    floored.playback.feeders.state(),
    plain.playback.feeders.state(),
  );
});

Deno.test("14.3 source-scan: seek owns the floor and the step, not the clock", async () => {
  const src = await Deno.readTextFile(
    new URL("./replaySeek.ts", import.meta.url),
  );
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (
    const banned of [
      "Date.now",
      "performance.now",
      "requestAnimationFrame",
      "replayClock",
      "replayPlaybackSession",
      "createReplayClock",
      "THREE",
      "document",
      "ReplayBlobStore",
      "node:fs",
    ]
  ) {
    assertEquals(
      code.includes(banned),
      false,
      `banned token present: ${banned}`,
    );
  }
  assertEquals(code.includes("resetToCheckpoint"), true);
  assertEquals(code.includes("resetToInitial"), true);
  assertEquals(code.includes("findPriorOrEqual"), true);
});
