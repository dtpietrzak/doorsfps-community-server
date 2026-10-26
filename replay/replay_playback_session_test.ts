/**
 * Epic 11.6 — basic replay start (orchestration).
 *
 * Run from server-community/:
 *   deno test -A replay/replay_playback_session_test.ts
 */

import { assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import { TICK_MS } from "../shared/sim/game.ts";
import { tickToTimeMs } from "./checkpointIndex.ts";
import {
  buildMatchMetadata,
  type MatchMetadata,
} from "../shared/replay/matchMetadata.ts";
import {
  type AuthoritativeEvent,
  emptyAuthoritativePose,
  emptyAuthoritativeRosterSnapshot,
  makeAgentAddEvent,
  makeAgentRemoveEvent,
  makeGameOverEvent,
  makeMatchEndEvent,
  makePlayerDiedEvent,
  makePlayerRespawnedEvent,
  makeScoreEvent,
  type MatchInitEvent,
} from "../shared/sim/authoritativeEvent.ts";
import { PlayerManager } from "../players/PlayerManager.ts";
import type { TickSelectedInput } from "../players/tickAssociation.ts";
import type { DoorsMap } from "../world/map.ts";
import type { PlayerInput, SnapshotPacket } from "../protocol/network.ts";
import { MapCollision } from "../world/MapCollision.ts";
import {
  type AuthoritativeCheckpoint,
  captureCheckpointState,
} from "./authoritativeCheckpoint.ts";
import { buildReplayContainer } from "./replayContainer.ts";
import { buildReplayIndex } from "./replayIndex.ts";
import { encodeReplayContainer } from "./replayEncoding.ts";
import type { RecordedInitialState } from "./recordedInitialState.ts";
import type { RecordedTickEvents } from "./recordedTickEvents.ts";
import type { RecordedTickInputs } from "./recordedTickInputs.ts";
import {
  __replayTickNowMsForTest,
  createReplayRunner,
  ReplayRaidUnsupportedError,
  type ReplayRunSession,
} from "./replaySimulationRunner.ts";
import type { ReplaySpeed } from "./replayClock.ts";
import { ReplayPlaybackSpeedError } from "./replayPlaybackSpeed.ts";
import {
  createReplayPlayback,
  type ReplayPlayback,
  ReplayPlaybackError,
} from "./replayPlaybackSession.ts";
import type { ReplayRenderFeedState } from "./replayStateAccess.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const miniMap: DoorsMap = {
  name: "replay-playback",
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
      runtimeMatchId: "rt-playback-1",
      serverName: "playback-test",
      serverId: "srv-playback",
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

function liveCapturedSession(opts?: {
  seed?: number;
  ticks?: number;
  withBot?: boolean;
}): {
  session: ReplayRunSession;
  collision: MapCollision;
} {
  const seed = opts?.seed ?? 0xb01d;
  const tickCount = opts?.ticks ?? 8;
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

  const inputs = new Map<number, RecordedTickInputs>();
  const events = new Map<number, AuthoritativeEvent[]>();
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
      if (!sel) {
        throw new Error(`missing selection for ${p.id} at tick ${tick}`);
      }
      movement.push(sel);
    }
    inputs.set(tick, { tick, movement, actions: [] });
    events.set(tick, []);

    if (
      tick === firstTick ||
      tick === Math.floor((firstTick + lastTick) / 2) ||
      tick === lastTick
    ) {
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
    eventsAt(tick) {
      return events.get(tick) ?? [];
    },
    checkpointFrameAt(tick) {
      return checkpoints.get(tick) ?? null;
    },
  };

  return { session, collision };
}

function sessionToBytes(session: ReplayRunSession): Uint8Array {
  const inputRows: RecordedTickInputs[] = [];
  const eventRows: RecordedTickEvents[] = [];
  const checkpoints: AuthoritativeCheckpoint[] = [];
  for (let t = session.firstTick; t <= session.lastTick; t++) {
    inputRows.push(session.inputAt(t));
    const evs = session.eventsAt(t);
    if (evs.length > 0) eventRows.push({ tick: t, events: evs });
    const cp = session.checkpointFrameAt?.(t);
    if (cp) checkpoints.push(cp);
  }
  return encodeReplayContainer(
    buildReplayContainer({
      init: session.initialState,
      inputRows,
      eventRows,
      checkpoints,
      firstTick: session.firstTick,
      lastTick: session.lastTick,
    }),
  );
}

function sessionBytesWithEvents(
  session: ReplayRunSession,
  eventRows: RecordedTickEvents[],
): Uint8Array {
  const inputRows: RecordedTickInputs[] = [];
  const checkpoints: AuthoritativeCheckpoint[] = [];
  for (let t = session.firstTick; t <= session.lastTick; t++) {
    inputRows.push(session.inputAt(t));
    const cp = session.checkpointFrameAt?.(t);
    if (cp) checkpoints.push(cp);
  }
  const index = buildReplayIndex({
    inputRows,
    eventRows,
    checkpoints,
    firstTick: session.firstTick,
    lastTick: session.lastTick,
    initialPhase: session.initialState.metadata.phase,
  });
  return encodeReplayContainer(
    buildReplayContainer({
      init: session.initialState,
      inputRows,
      eventRows,
      checkpoints,
      index,
      firstTick: session.firstTick,
      lastTick: session.lastTick,
    }),
  );
}

function isSnapshotPacketShaped(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.tick === "number" &&
    Array.isArray(p.players) &&
    Array.isArray(p.projectiles) &&
    p.scores !== null &&
    typeof p.scores === "object"
  );
}

function isRenderFeedShaped(value: unknown): value is ReplayRenderFeedState {
  if (value === null || typeof value !== "object") return false;
  const f = value as Record<string, unknown>;
  const xyz = (v: unknown) =>
    v !== null &&
    typeof v === "object" &&
    typeof (v as { x: unknown }).x === "number" &&
    typeof (v as { y: unknown }).y === "number" &&
    typeof (v as { z: unknown }).z === "number";
  if (!xyz(f.localSim) || !xyz(f.prevSim) || !xyz(f.viewOffset)) return false;
  return (
    typeof f.localSimAccum === "number" && typeof f.localSimDt === "number"
  );
}

function emptyLiveInit(): {
  initialState: RecordedInitialState;
  collision: MapCollision;
} {
  const collision = makeCollision();
  const live = new PlayerManager(collision, {
    matchSeed: 1,
    matchDurationSeconds: 60,
    enablePrematch: false,
    nowMs: __replayTickNowMsForTest(0),
  });
  live.add("h1", "Human", "A", undefined, __replayTickNowMsForTest(0));
  live.beginLiveMatch(0, __replayTickNowMsForTest(0));
  live.drainAuthoritativeEvents();
  const initRaw = live.buildMatchInitEvent(0);
  if (initRaw.kind !== "matchInit") throw new Error("expected matchInit");
  const metadata = sampleMetadata(initRaw);
  return {
    collision,
    initialState: {
      runtimeMatchId: metadata.runtimeMatchId,
      captureTick: 0,
      init: initRaw,
      metadata,
    },
  };
}

function sessionFromParts(
  initialState: RecordedInitialState,
  firstTick: number,
  lastTick: number,
  inputAt: (tick: number) => RecordedTickInputs,
): ReplayRunSession {
  return {
    initialState,
    firstTick,
    lastTick,
    inputAt,
    eventsAt: () => [],
  };
}

// ---------------------------------------------------------------------------
// Start rows
// ---------------------------------------------------------------------------

Deno.test("11.6 start: session input starts at firstTick with seam-shaped initial project", () => {
  const { session, collision } = liveCapturedSession({ ticks: 4 });
  const playback = createReplayPlayback(session, { collision });
  assertEquals(playback.state.started, false);
  assertEquals(playback.feeders.state(), null);
  assertEquals(playback.feeders.render(), null);

  playback.start();
  assertEquals(playback.state.started, true);
  assertEquals(playback.state.currentTick, session.firstTick);
  assertEquals(playback.state.isEnded, false);
  assertEquals(playback.state.isPaused, false);
  assertEquals(playback.state.speed, 1);
  assertEquals(playback.state.focusedPlayerId, "h1");

  const snap = playback.feeders.state();
  const feed = playback.feeders.render();
  assertEquals(isSnapshotPacketShaped(snap), true);
  assertEquals(isRenderFeedShaped(feed), true);
  // Pre-first-step: single-view exact (nextView null).
  assertEquals(feed!.localSim.x, feed!.prevSim.x);
  assertEquals(feed!.localSimAccum, 0);
});

Deno.test("11.6 start: bytes input loads once and matches session start", () => {
  const { session, collision } = liveCapturedSession({ ticks: 4 });
  const bytes = sessionToBytes(session);

  const fromSession = createReplayPlayback(session, {
    collision,
    focusedPlayerId: "h1",
  });
  fromSession.start();
  const sessionSnap = structuredClone(fromSession.feeders.state());

  const fromBytes = createReplayPlayback(bytes, {
    collision: makeCollision(),
    focusedPlayerId: "h1",
  });
  fromBytes.start();
  const bytesSnap = fromBytes.feeders.state();

  assertEquals(bytesSnap?.tick, sessionSnap?.tick);
  assertEquals(bytesSnap?.players.length, sessionSnap?.players.length);
  assertEquals(fromBytes.state.focusedPlayerId, "h1");
});

Deno.test("11.6 start: double-start restarts identically (idempotent reset)", () => {
  const { session, collision } = liveCapturedSession({ ticks: 6 });
  const playback = createReplayPlayback(session, {
    collision,
    focusedPlayerId: "h1",
  });
  playback.start();
  // Advance a few ticks.
  for (let i = 0; i < 3; i++) playback.frame(TICK_MS);
  assertEquals(playback.state.currentTick > session.firstTick, true);

  playback.start();
  assertEquals(playback.state.currentTick, session.firstTick);
  assertEquals(playback.state.isEnded, false);
  assertEquals(playback.state.carryMs, 0);

  // First frame after restart still steps firstTick (virgin clock).
  const r = playback.frame(TICK_MS);
  assertEquals(r.fromTick, session.firstTick);
  assertEquals(r.steps, 1);
});

Deno.test("11.6 start: after start runner is pre-first-step (clock virgin)", () => {
  const { session, collision } = liveCapturedSession({ ticks: 4 });
  const direct = createReplayRunner(session, { collision });
  direct.resetToInitial();
  assertEquals(direct.currentTick, session.firstTick - 1);

  const playback = createReplayPlayback(session, {
    collision: makeCollision(),
    focusedPlayerId: "h1",
  });
  playback.start();
  // Clock displays firstTick while virgin; first frame still steps firstTick.
  assertEquals(playback.state.currentTick, session.firstTick);
  const r1 = playback.frame(TICK_MS);
  assertEquals(r1.steps, 1);
  assertEquals(r1.fromTick, session.firstTick);
  assertEquals(r1.toTick, session.firstTick + 1);
  assertEquals(playback.state.currentTick, session.firstTick);
});

Deno.test("14.1 timeline: presents the span and follows the cursor", () => {
  const { session, collision } = liveCapturedSession({ ticks: 4 });
  const playback = createReplayPlayback(session, {
    collision,
    focusedPlayerId: "h1",
  });

  const before = playback.timeline;
  assertEquals(before.start.tick, session.firstTick);
  assertEquals(before.end.tick, session.lastTick);
  assertEquals(before.position.tick, session.firstTick);
  assertEquals(before.position.fraction, 0);
  assertEquals(before.progress, 0);
  assertEquals(before.isEnded, false);
  assertEquals(
    before.durationMs,
    tickToTimeMs(session.lastTick - session.firstTick + 1),
  );
  assertEquals(playback.state.started, false);

  playback.start();
  const started = playback.timeline;
  assertEquals(started.position.tick, session.firstTick);
  assertEquals(started.progress, 0);

  const tickBefore = playback.state.currentTick;
  playback.frame(TICK_MS * 0.25);
  const mid = playback.timeline;
  assertEquals(mid.position.tick, tickBefore);
  assertEquals(playback.state.currentTick, tickBefore);
  assertAlmostEquals(mid.position.fraction, 0.25, 1e-9);
  assertAlmostEquals(mid.position.elapsedMs, TICK_MS * 0.25, 1e-9);

  while (!playback.state.isEnded) playback.frame(TICK_MS);
  const ended = playback.timeline;
  const cursor = playback.state.currentTick;
  assertEquals(ended.isEnded, true);
  assertEquals(ended.position.tick, session.lastTick);
  assertEquals(ended.progress, 1);
  assertEquals(ended.position.fraction, 0);
  assertEquals(
    ended.position.elapsedMs,
    tickToTimeMs(session.lastTick - session.firstTick),
  );
  const again = playback.timeline;
  assertEquals(again.position.tick, ended.position.tick);
  assertEquals(playback.state.currentTick, cursor);
});

Deno.test("14.2 event markers: a buffer session presents nothing", () => {
  const { session, collision } = liveCapturedSession({ ticks: 4 });
  const playback = createReplayPlayback(session, {
    collision,
    focusedPlayerId: "h1",
  });
  const before = playback.state;
  const pins = playback.eventMarkers;
  assertEquals(pins.markers, []);
  assertEquals(pins.kills, []);
  assertEquals(pins.deaths, []);
  assertEquals(pins.doorCaptures, []);
  assertEquals(pins.agentAppearances, []);
  assertEquals(pins.matchEvents, []);
  assertEquals(playback.state, before);
});

Deno.test("14.2 event markers: an empty file index presents nothing", () => {
  const { session } = liveCapturedSession({ ticks: 4 });
  const playback = createReplayPlayback(sessionToBytes(session), {
    collision: makeCollision(),
    focusedPlayerId: "h1",
  });
  const before = playback.state;
  assertEquals(playback.eventMarkers.markers, []);
  assertEquals(playback.state, before);
});

Deno.test("14.2 event markers: a filled file index places the exposed kinds", () => {
  const { session } = liveCapturedSession({ ticks: 8 });
  const human = emptyAuthoritativeRosterSnapshot({
    id: "h1",
    name: "Human",
    team: "A",
  });
  const agent = emptyAuthoritativeRosterSnapshot({
    id: "ag",
    name: "Ag",
    team: "A",
    isAgent: true,
  });
  const bytes = sessionBytesWithEvents(session, [
    {
      tick: 2,
      events: [
        makePlayerDiedEvent({
          appliedTick: 2,
          victimId: "h1",
          killerId: "b1",
          zone: "body",
          weapon: 1,
          killerName: "BotOne",
          victimName: "Human",
          killerTeam: "B",
          victimTeam: "A",
        }),
      ],
    },
    {
      tick: 3,
      events: [
        makeScoreEvent({
          appliedTick: 3,
          scorerId: "b1",
          team: "B",
          scores: { A: 0, B: 1 },
          playerPose: emptyAuthoritativePose(),
          playerAlive: true,
        }),
      ],
    },
    {
      tick: 4,
      events: [
        makeAgentAddEvent({ appliedTick: 4, player: agent }),
        makeAgentRemoveEvent(4, "ag"),
      ],
    },
    {
      tick: 5,
      events: [
        makePlayerRespawnedEvent({ appliedTick: 5, player: human }),
      ],
    },
    {
      tick: 7,
      events: [
        makeMatchEndEvent({
          appliedTick: 7,
          winner: "B",
          scheduleRestart: false,
          restartSeconds: 0,
          restartAtTick: null,
          scores: { A: 0, B: 1 },
        }),
        makeGameOverEvent({
          appliedTick: 7,
          winner: "B",
          scores: { A: 0, B: 1 },
          restartInSeconds: 0,
        }),
      ],
    },
  ]);
  const playback = createReplayPlayback(bytes, {
    collision: makeCollision(),
    focusedPlayerId: "h1",
  });
  const before = playback.state;
  const pins = playback.eventMarkers;
  assertEquals(playback.state, before);
  assertEquals(pins.markers.map((pin) => pin.kind), [
    "death",
    "kill",
    "doorCapture",
    "agentAppearance",
    "matchEvent",
    "matchEvent",
  ]);
  assertEquals(pins.kills[0]!.killerId, "b1");
  assertEquals(pins.kills[0]!.victimId, "h1");
  assertEquals(pins.deaths[0]!.tick, 2);
  assertEquals(pins.doorCaptures[0]!.scorerId, "b1");
  assertEquals(pins.doorCaptures[0]!.team, "B");
  assertEquals(pins.agentAppearances[0]!.playerId, "ag");
  assertEquals(pins.matchEvents.map((pin) => pin.eventKind), [
    "matchEnd",
    "gameOver",
  ]);
  assertEquals(
    pins.markers.some((pin) => pin.eventKind === "playerRespawned"),
    false,
  );
  assertEquals(
    pins.markers.some((pin) => pin.eventKind === "agentRemove"),
    false,
  );

  playback.start();
  const cursor = playback.state.currentTick;
  const again = playback.eventMarkers;
  assertEquals(
    again.markers.map((pin) => pin.tick),
    pins.markers.map((pin) => pin.tick),
  );
  assertEquals(playback.state.currentTick, cursor);
});

// ---------------------------------------------------------------------------
// Frame rows
// ---------------------------------------------------------------------------

Deno.test("11.6 frame: 1x scripted dt advances tick-for-tick", () => {
  const { session, collision } = liveCapturedSession({ ticks: 8 });
  const playback = createReplayPlayback(session, {
    collision,
    focusedPlayerId: "h1",
  });
  playback.start();

  const direct = createReplayRunner(session, { collision: makeCollision() });
  direct.resetToInitial();

  for (let tick = session.firstTick; tick <= session.lastTick; tick++) {
    const result = playback.frame(TICK_MS);
    assertEquals(result.steps, 1);
    assertEquals(result.fromTick, tick);
    assertEquals(result.toTick, tick + 1);
    direct.step(tick);
    assertEquals(playback.state.currentTick, direct.currentTick);
    assertEquals(isSnapshotPacketShaped(result.snapshot), true);
    assertEquals(isRenderFeedShaped(result.feed), true);
  }
  assertEquals(playback.state.isEnded, true);
});

Deno.test("11.6 frame: 0.25x re-projects same pair with growing u", () => {
  const { session, collision } = liveCapturedSession({ ticks: 4 });
  const playback = createReplayPlayback(session, {
    collision,
    focusedPlayerId: "h1",
  });
  playback.start();
  playback.setSpeed(0.25);

  // First whole tick needs 4 × TICK_MS of wall at 0.25x.
  const a = playback.frame(TICK_MS);
  assertEquals(a.steps, 0);
  const tickAfterA = playback.state.currentTick;
  const feedA = a.feed!;

  const b = playback.frame(TICK_MS);
  assertEquals(b.steps, 0);
  assertEquals(playback.state.currentTick, tickAfterA);
  // Growing carry → growing blend toward next completed pair once we have two views.
  // Before first step, single-view exact; after enough frames we step once.
  const c = playback.frame(TICK_MS);
  assertEquals(c.steps, 0);

  const d = playback.frame(TICK_MS);
  assertEquals(d.steps, 1);
  assertEquals(playback.state.currentTick, session.firstTick);

  // Between ticks: three zero-step frames with growing carry.
  const e1 = playback.frame(TICK_MS);
  const e2 = playback.frame(TICK_MS);
  assertEquals(e1.steps, 0);
  assertEquals(e2.steps, 0);
  assertEquals(playback.state.currentTick, session.firstTick);
  assertAlmostEquals(
    playback.state.carryMs,
    TICK_MS * 0.25 * 2,
    1e-6,
  );
  // Same tick pair: body should move with u (or stay if snapped).
  assertEquals(isRenderFeedShaped(e1.feed), true);
  assertEquals(isRenderFeedShaped(e2.feed), true);
  void feedA;
});

Deno.test("11.6 frame: 4x steps up to 4 per frame projecting last two", () => {
  const { session, collision } = liveCapturedSession({ ticks: 8 });
  const playback = createReplayPlayback(session, {
    collision,
    focusedPlayerId: "h1",
  });
  playback.start();
  playback.setSpeed(4);

  const result = playback.frame(TICK_MS);
  assertEquals(result.steps, 4);
  assertEquals(result.fromTick, session.firstTick);
  assertEquals(result.toTick, session.firstTick + 4);
  assertEquals(playback.state.currentTick, session.firstTick + 3);
  assertEquals(isSnapshotPacketShaped(result.snapshot), true);
  assertEquals(isRenderFeedShaped(result.feed), true);
  // Snapshot tick matches newest completed view.
  assertEquals(result.snapshot!.tick, session.firstTick + 3);
});

Deno.test("11.6 frame: paused steps zero and banks no carry", () => {
  const { session, collision } = liveCapturedSession({ ticks: 4 });
  const playback = createReplayPlayback(session, {
    collision,
    focusedPlayerId: "h1",
  });
  playback.start();
  playback.frame(TICK_MS);
  const tick = playback.state.currentTick;
  playback.setPaused(true);
  const paused = playback.frame(TICK_MS * 10);
  assertEquals(paused.steps, 0);
  assertEquals(playback.state.currentTick, tick);
  assertEquals(playback.state.carryMs, 0);
  assertEquals(playback.state.isPaused, true);
});

Deno.test("11.6 frame: setSpeed mid-stream clears carry; paused×4 resumes at 4", () => {
  const { session, collision } = liveCapturedSession({ ticks: 8 });
  const playback = createReplayPlayback(session, {
    collision,
    focusedPlayerId: "h1",
  });
  playback.start();
  playback.frame(TICK_MS / 2); // fractional carry
  assertEquals(playback.state.carryMs > 0, true);
  playback.setSpeed(4);
  assertEquals(playback.state.speed, 4);
  assertEquals(playback.state.carryMs, 0);

  playback.setPaused(true);
  playback.setSpeed(4);
  assertEquals(playback.state.isPaused, true);
  assertEquals(playback.state.speed, 4);
  playback.setPaused(false);
  const r = playback.frame(TICK_MS);
  assertEquals(r.steps, 4);
});

Deno.test("11.6 frame: before start fails loud", () => {
  const { session, collision } = liveCapturedSession({ ticks: 2 });
  const playback = createReplayPlayback(session, { collision });
  assertThrows(
    () => playback.frame(TICK_MS),
    ReplayPlaybackError,
    "before start",
  );
});

// ---------------------------------------------------------------------------
// Focus rows
// ---------------------------------------------------------------------------

Deno.test("11.6 focus: default is first roster id in runner order", () => {
  const { session, collision } = liveCapturedSession({ ticks: 2 });
  const playback = createReplayPlayback(session, { collision });
  playback.start();
  assertEquals(playback.state.focusedPlayerId, "h1");
  const feed = playback.feeders.render()!;
  // Eyes match h1 pose in snapshot.
  const snap = playback.feeders.state()!;
  const h1 = snap.players.find((p) => p.id === "h1")!;
  assertEquals(feed.localSim.x, h1.x);
  assertEquals(feed.localSim.z, h1.z);
});

Deno.test("11.6 focus: unknown id surfaces 11.5 named error", () => {
  const { session, collision } = liveCapturedSession({ ticks: 2 });
  const playback = createReplayPlayback(session, {
    collision,
    focusedPlayerId: "missing-player",
  });
  assertThrows(
    () => playback.start(),
    Error,
    "unknown focus",
  );
});

Deno.test("11.6 focus: explicit id drives feed eyes", () => {
  const { session, collision } = liveCapturedSession({ ticks: 2 });
  const playback = createReplayPlayback(session, {
    collision,
    focusedPlayerId: "b1",
  });
  playback.start();
  assertEquals(playback.state.focusedPlayerId, "b1");
  const snap = playback.feeders.state()!;
  const b1 = snap.players.find((p) => p.id === "b1")!;
  const feed = playback.feeders.render()!;
  assertEquals(feed.localSim.x, b1.x);
  assertEquals(feed.localSim.z, b1.z);
});

// ---------------------------------------------------------------------------
// End rows
// ---------------------------------------------------------------------------

Deno.test("11.6 end: clamps, projects newest exactly, further frames step zero", () => {
  const { session, collision } = liveCapturedSession({ ticks: 3 });
  const playback = createReplayPlayback(session, {
    collision,
    focusedPlayerId: "h1",
  });
  playback.start();
  while (!playback.state.isEnded) {
    playback.frame(TICK_MS);
  }
  assertEquals(playback.state.currentTick, session.lastTick);
  assertEquals(playback.state.isEnded, true);

  const endedFeed = playback.feeders.render()!;
  // Exact newest: localSim === prevSim, accum 0.
  assertEquals(endedFeed.localSim.x, endedFeed.prevSim.x);
  assertEquals(endedFeed.localSim.y, endedFeed.prevSim.y);
  assertEquals(endedFeed.localSim.z, endedFeed.prevSim.z);
  assertEquals(endedFeed.localSimAccum, 0);

  const further = playback.frame(TICK_MS * 5);
  assertEquals(further.steps, 0);
  assertEquals(further.ended, true);
  assertEquals(playback.state.currentTick, session.lastTick);

  // start() clears ended and restarts.
  playback.start();
  assertEquals(playback.state.isEnded, false);
  assertEquals(playback.state.currentTick, session.firstTick);
});

// ---------------------------------------------------------------------------
// Raid row
// ---------------------------------------------------------------------------

Deno.test("11.6 raid: createReplayPlayback surfaces runner named raid error", () => {
  const { initialState, collision } = emptyLiveInit();
  const raidMeta = sampleMetadata(initialState.init, {
    raidMatch: {
      active: true,
      raidId: "raid-1",
      humanTeam: "A",
      goal: 10,
      maxTimeSeconds: 600,
      respawnMs: 5000,
      initialMap: "replay-playback",
      expectedHumans: 1,
      startWaitSeconds: 30,
      started: true,
      ended: false,
      wave: 1,
      failReason: null,
    },
  });
  const session = sessionFromParts(
    { ...initialState, metadata: raidMeta },
    1,
    1,
    () => ({ tick: 1, movement: [], actions: [] }),
  );
  assertThrows(
    () => createReplayPlayback(session, { collision }),
    ReplayRaidUnsupportedError,
  );
});

// ---------------------------------------------------------------------------
// Seam + equivalence
// ---------------------------------------------------------------------------

Deno.test("11.6 seams: every frame snapshot/feed stay shaped; feeders match frame", () => {
  const { session, collision } = liveCapturedSession({ ticks: 5 });
  const playback = createReplayPlayback(session, {
    collision,
    focusedPlayerId: "h1",
  });
  playback.start();
  assertEquals(isSnapshotPacketShaped(playback.feeders.state()), true);
  assertEquals(isRenderFeedShaped(playback.feeders.render()), true);

  while (!playback.state.isEnded) {
    const result = playback.frame(TICK_MS);
    assertEquals(isSnapshotPacketShaped(result.snapshot), true);
    assertEquals(isRenderFeedShaped(result.feed), true);
    assertEquals(playback.feeders.state(), result.snapshot);
    assertEquals(playback.feeders.render(), result.feed);
  }
});

Deno.test("11.6 equivalence: session-driven frames ≡ direct runner tick loop", () => {
  const { session, collision } = liveCapturedSession({ ticks: 6 });
  const playback = createReplayPlayback(session, {
    collision,
    focusedPlayerId: "h1",
  });
  playback.start();

  const direct = createReplayRunner(session, { collision: makeCollision() });
  direct.resetToInitial();

  const playbackOutcomes: number[] = [];
  const directOutcomes: number[] = [];

  for (let tick = session.firstTick; tick <= session.lastTick; tick++) {
    playback.frame(TICK_MS);
    const out = direct.step(tick);
    playbackOutcomes.push(playback.state.currentTick);
    directOutcomes.push(out.tick);
    assertEquals(
      playback.feeders.state()!.players.length,
      direct.simulation.allCached().length,
    );
  }
  assertEquals(playbackOutcomes, directOutcomes);
  assertEquals(playback.state.currentTick, session.lastTick);
});

Deno.test("11.6 determinism: shifted wall origin yields identical frames", () => {
  const { session } = liveCapturedSession({ ticks: 4 });

  function run(originShift: number): Array<{
    steps: number;
    tick: number;
    snap: SnapshotPacket | null;
  }> {
    const playback = createReplayPlayback(session, {
      collision: makeCollision(),
      focusedPlayerId: "h1",
    });
    playback.start();
    const rows: Array<{
      steps: number;
      tick: number;
      snap: SnapshotPacket | null;
    }> = [];
    // originShift is unused by the module (no wall reads) — documents the contract.
    void originShift;
    for (let i = 0; i < 6; i++) {
      const r = playback.frame(TICK_MS);
      rows.push({
        steps: r.steps,
        tick: playback.state.currentTick,
        snap: structuredClone(r.snapshot),
      });
    }
    return rows;
  }

  assertEquals(run(0), run(1_000_000));
});

// ---------------------------------------------------------------------------
// 14.4 speed
// ---------------------------------------------------------------------------

Deno.test("14.4 playback: before start presents 1\u00d7 and controls fail", () => {
  const { session, collision } = liveCapturedSession({ ticks: 4 });
  const playback = createReplayPlayback(session, { collision });
  assertEquals(playback.playbackSpeed.speed, 1);
  assertEquals(playback.playbackSpeed.label, "1\u00d7");
  assertEquals(playback.playbackSpeed.scrubbing, false);
  assertThrows(() => playback.faster(), ReplayPlaybackError, "before start");
  assertThrows(
    () => playback.beginScrub(),
    ReplayPlaybackError,
    "before start",
  );
});

Deno.test("14.4 playback: faster and slower step the ladder", () => {
  const { session, collision } = liveCapturedSession({ ticks: 12 });
  const playback = createReplayPlayback(session, {
    collision,
    focusedPlayerId: "h1",
  });
  playback.start();
  assertEquals(playback.faster(), 2);
  assertEquals(playback.playbackSpeed.index, 3);
  assertEquals(playback.playbackSpeed.label, "2\u00d7");
  const fast = playback.frame(TICK_MS);
  assertEquals(fast.steps, 2);

  assertEquals(playback.slower(), 1);
  playback.setSpeed(0.25);
  const partial = playback.frame(TICK_MS);
  assertEquals(partial.steps, 0);
  assertEquals(playback.state.carryMs > 0, true);
  assertEquals(playback.slower(), 4);
  assertEquals(playback.state.speed, 4);
  assertEquals(playback.state.carryMs, 0);
  assertEquals(playback.playbackSpeed.label, "4\u00d7");

  playback.setPaused(true);
  playback.setSpeed(2);
  assertEquals(playback.state.isPaused, true);
  assertEquals(playback.playbackSpeed.speed, 2);
  assertEquals(playback.playbackSpeed.paused, true);

  assertThrows(
    () => playback.setSpeed(3 as ReplaySpeed),
    ReplayPlaybackSpeedError,
  );
  assertEquals(playback.state.speed, 2);
});

Deno.test("14.4 playback: scrub holds speed and restores pause", () => {
  const { session, collision } = liveCapturedSession({ ticks: 16 });
  const playback = createReplayPlayback(session, {
    collision,
    focusedPlayerId: "h1",
  });
  playback.start();
  playback.setSpeed(2);
  // Half a tick of sim time: at 2× that is a quarter frame of wall time.
  playback.frame(TICK_MS / 4);
  assertEquals(playback.state.carryMs > 0, true);

  playback.beginScrub();
  assertEquals(playback.state.isPaused, true);
  assertEquals(playback.state.carryMs, 0);
  assertEquals(playback.state.speed, 2);
  assertEquals(playback.playbackSpeed.scrubbing, true);
  playback.beginScrub();
  const held = playback.frame(TICK_MS * 5);
  assertEquals(held.steps, 0);
  assertEquals(playback.state.currentTick, session.firstTick);

  assertEquals(playback.faster(), 4);
  assertEquals(playback.state.isPaused, true);
  playback.endScrub();
  assertEquals(playback.playbackSpeed.scrubbing, false);
  assertEquals(playback.state.isPaused, false);
  assertEquals(playback.state.speed, 4);
  const resumed = playback.frame(TICK_MS);
  assertEquals(resumed.steps, 4);
});

Deno.test("14.4 playback: setPaused during scrub arms the release", () => {
  const { session, collision } = liveCapturedSession({ ticks: 8 });
  const playback = createReplayPlayback(session, { collision });
  playback.start();
  playback.setPaused(true);
  playback.beginScrub();
  playback.setPaused(false);
  assertEquals(playback.state.isPaused, true);
  const held = playback.frame(TICK_MS);
  assertEquals(held.steps, 0);
  playback.endScrub();
  assertEquals(playback.state.isPaused, false);
  assertEquals(playback.state.speed, 1);
});

Deno.test("14.4 playback: restart clears scrub and speed", () => {
  const { session, collision } = liveCapturedSession({ ticks: 4 });
  const playback = createReplayPlayback(session, { collision });
  playback.start();
  playback.setSpeed(4);
  playback.beginScrub();
  playback.start();
  assertEquals(playback.state.speed, 1);
  assertEquals(playback.state.isPaused, false);
  assertEquals(playback.playbackSpeed.scrubbing, false);
  const frame = playback.frame(TICK_MS);
  assertEquals(frame.steps, 1);
});

// ---------------------------------------------------------------------------
// Delegation / exclusion scan
// ---------------------------------------------------------------------------

Deno.test("11.6 source-scan: no wall-clock / fs / blob / store / net / lerp / validator", async () => {
  const src = await Deno.readTextFile(
    new URL("./replayPlaybackSession.ts", import.meta.url),
  );
  // Call-site / import scan (header comments may name excluded owners).
  assertEquals(/[^\/\*]Date\.now\s*\(/.test(src), false);
  assertEquals(/performance\.now\s*\(/.test(src), false);
  assertEquals(/requestAnimationFrame\s*\(/.test(src), false);
  assertEquals(/setInterval\s*\(/.test(src), false);
  assertEquals(/setTimeout\s*\(/.test(src), false);
  assertEquals(/from\s+["'][^"']*\/fs["']/.test(src), false);
  assertEquals(/from\s+["'].*ReplayBlobStore/.test(src), false);
  assertEquals(/from\s+["'].*storeFactory/.test(src), false);
  assertEquals(/from\s+["'].*\/net\//.test(src), false);
  assertEquals(/interpolateReplayPose/.test(src), false);
  assertEquals(/lerpAngle/.test(src), false);
  assertEquals(/decodeReplayContainer/.test(src), false);
  assertEquals(/validateReplayContainer/.test(src), false);
  assertEquals(/buildReplayIndex/.test(src), false);
  assertEquals(/CheckpointIndex/.test(src), false);
  assertEquals(/findPriorCheckpoint/.test(src), false);
  assertEquals(/loadCheckpointState/.test(src), false);
  assertEquals(/new\s+PlayerManager/.test(src), false);
  assertEquals(/BotManager/.test(src), false);
  assertEquals(/beginLiveMatch/.test(src), false);
  assertEquals(/GameServer/.test(src), false);
  // Allowed owners only via public imports.
  assertEquals(src.includes("loadReplay"), true);
  assertEquals(src.includes("createReplayRunner"), true);
  assertEquals(src.includes("createReplayClock"), true);
  assertEquals(src.includes("replayTimeline"), true);
  assertEquals(src.includes("projectReplaySnapshot"), true);
  assertEquals(src.includes("projectReplayRenderFeed"), true);
  assertEquals(src.includes("projectReplayFocusedDisplay"), true);
});

void (0 as unknown as ReplayPlayback);
