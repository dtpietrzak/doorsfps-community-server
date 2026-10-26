/**
 * Epic 12.1 — player selection.
 *
 * Run from server-community/:
 *   deno test -A replay/spectator_selection_test.ts
 */

import {
  assertEquals,
  assertThrows,
} from "@std/assert";
import { TICK_MS } from "../shared/sim/game.ts";
import {
  buildMatchMetadata,
  type MatchMetadata,
} from "../shared/replay/matchMetadata.ts";
import {
  makePlayerRemoveEvent,
  type AuthoritativeEvent,
  type MatchInitEvent,
} from "../shared/sim/authoritativeEvent.ts";
import { PlayerManager } from "../players/PlayerManager.ts";
import type { TickSelectedInput } from "../players/tickAssociation.ts";
import type { DoorsMap } from "../world/map.ts";
import type { PlayerInput, SnapshotPacket } from "../protocol/network.ts";
import { MapCollision } from "../world/MapCollision.ts";
import {
  captureCheckpointState,
  type AuthoritativeCheckpoint,
} from "./authoritativeCheckpoint.ts";
import type { RecordedInitialState } from "./recordedInitialState.ts";
import type { RecordedTickInputs } from "./recordedTickInputs.ts";
import {
  __replayTickNowMsForTest,
  createReplayRunner,
  ReplayRaidUnsupportedError,
  type ReplayRunSession,
} from "./replaySimulationRunner.ts";
import {
  createReplayPlayback,
  ReplayPlaybackError,
  type ReplayPlayback,
} from "./replayPlaybackSession.ts";
import { ReplayStateAccessError } from "./replayStateAccess.ts";
import {
  createSpectatorState,
  DEFAULT_SPECTATOR_CAMERA_MODE,
  DEFAULT_SPECTATOR_VISIBILITY_FILTER,
  getFocusedPlayerId,
  hasFocus,
  nextPlayer,
  orderSpectatorRoster,
  previousPlayer,
  selectFocusedPlayer,
  SPECTATOR_CYCLE_ORDER,
  SPECTATOR_CYCLE_WRAP,
  SpectatorSelectionError,
  type SpectatorSelectionErrorCode,
  type SpectatorState,
} from "./spectatorSelection.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const miniMap: DoorsMap = {
  name: "replay-selection",
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
      runtimeMatchId: "rt-selection-1",
      serverName: "selection-test",
      serverId: "srv-selection",
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
  leaveAt?: { playerId: string; tick: number };
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
    const tickEvents: AuthoritativeEvent[] = [];
    if (opts?.leaveAt && tick === opts.leaveAt.tick) {
      live.remove(opts.leaveAt.playerId);
      live.drainAuthoritativeEvents();
      tickEvents.push(
        makePlayerRemoveEvent(tick, opts.leaveAt.playerId),
      );
    }

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
    events.set(tick, tickEvents);

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

function isRenderFeedShaped(value: unknown): boolean {
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

function assertSelectionCode(
  fn: () => unknown,
  code: SpectatorSelectionErrorCode,
): SpectatorSelectionError {
  const err = assertThrows(fn, SpectatorSelectionError);
  assertEquals(err.code, code);
  return err;
}

function clockSlice(playback: ReplayPlayback) {
  return {
    currentTick: playback.state.currentTick,
    firstTick: playback.state.firstTick,
    lastTick: playback.state.lastTick,
    isEnded: playback.state.isEnded,
    isPaused: playback.state.isPaused,
    speed: playback.state.speed,
    replayTimeMs: playback.state.replayTimeMs,
    carryMs: playback.state.carryMs,
  };
}

function assertFeedMatchesFocus(
  playback: ReplayPlayback,
  playerId: string,
): void {
  assertEquals(playback.state.focusedPlayerId, playerId);
  const snap = playback.feeders.state()!;
  const row = snap.players.find((p) => p.id === playerId);
  if (!row) throw new Error(`snapshot missing ${playerId}`);
  const feed = playback.feeders.render()!;
  assertEquals(feed.localSim.x, row.x);
  assertEquals(feed.localSim.z, row.z);
}

function snapshotFingerprint(packet: SnapshotPacket | null): string {
  if (!packet) return "null";
  return JSON.stringify({
    tick: packet.tick,
    scores: packet.scores,
    players: packet.players.map((p) => ({
      id: p.id,
      x: p.x,
      y: p.y,
      z: p.z,
      yaw: p.yaw,
      pitch: p.pitch,
      health: p.health,
      alive: p.alive,
    })),
  });
}

const ROSTER = ["c3", "a1", "b2"] as const;

// ---------------------------------------------------------------------------
// Pins
// ---------------------------------------------------------------------------

Deno.test("12.1 pins: cycle order is ascending-id with wrap", () => {
  assertEquals(SPECTATOR_CYCLE_ORDER, "ascending-id");
  assertEquals(SPECTATOR_CYCLE_WRAP, "wrap");
  assertEquals(orderSpectatorRoster(ROSTER), ["a1", "b2", "c3"]);
  assertEquals(orderSpectatorRoster(["b", "a", "b", ""]), ["a", "b"]);
});

Deno.test("12.1 createSpectatorState: reserved defaults; focus null", () => {
  const state = createSpectatorState();
  assertEquals(state.focusedPlayerId, null);
  assertEquals(state.cameraMode, DEFAULT_SPECTATOR_CAMERA_MODE);
  assertEquals(state.visibilityFilter, DEFAULT_SPECTATOR_VISIBILITY_FILTER);
  assertEquals(hasFocus(state), false);
  assertEquals(getFocusedPlayerId(state), null);
  assertEquals(Object.isFrozen(state), true);
});

// ---------------------------------------------------------------------------
// Select rows
// ---------------------------------------------------------------------------

Deno.test("12.1 select: unknown id fails loud; never silent", () => {
  const state = createSpectatorState();
  const err = assertSelectionCode(
    () => selectFocusedPlayer(state, "missing", ROSTER),
    "replay-spectator-focus-unknown",
  );
  assertEquals(err.detail, "missing");
  assertEquals(state.focusedPlayerId, null);
});

Deno.test("12.1 select: empty roster fails loud", () => {
  const state = createSpectatorState();
  assertSelectionCode(
    () => selectFocusedPlayer(state, "a1", []),
    "replay-spectator-focus-empty",
  );
  assertSelectionCode(
    () => selectFocusedPlayer(state, "a1", ["", ""]),
    "replay-spectator-focus-empty",
  );
});

Deno.test("12.1 select: valid id sets slot; reserved fields copied", () => {
  const state = createSpectatorState({
    cameraMode: "free",
    visibilityFilter: "red",
  });
  const next = selectFocusedPlayer(state, "b2", ROSTER);
  assertEquals(next.focusedPlayerId, "b2");
  assertEquals(next.cameraMode, "free");
  assertEquals(next.visibilityFilter, "red");
  assertEquals(hasFocus(next), true);
  assertEquals(state.focusedPlayerId, null);
  assertEquals(Object.isFrozen(next), true);
});

Deno.test("12.1 select: re-select same id is no-op success", () => {
  const state = selectFocusedPlayer(createSpectatorState(), "a1", ROSTER);
  const again = selectFocusedPlayer(state, "a1", ROSTER);
  assertEquals(again.focusedPlayerId, "a1");
  assertEquals(again.visibilityFilter, state.visibilityFilter);
  assertEquals(again.cameraMode, state.cameraMode);
});

Deno.test("12.1 select: valid select drives 11.5/11.6 feed eyes", () => {
  const { session, collision } = liveCapturedSession({ ticks: 2 });
  const playback = createReplayPlayback(session, {
    collision,
    focusedPlayerId: "h1",
  });
  playback.start();
  assertFeedMatchesFocus(playback, "h1");
  playback.setFocusedPlayerId("b1");
  assertFeedMatchesFocus(playback, "b1");
});

// ---------------------------------------------------------------------------
// Order rows
// ---------------------------------------------------------------------------

Deno.test("12.1 next/previous: walk ascending id and wrap", () => {
  let state = selectFocusedPlayer(createSpectatorState(), "a1", ROSTER);
  state = nextPlayer(state, ROSTER);
  assertEquals(state.focusedPlayerId, "b2");
  state = nextPlayer(state, ROSTER);
  assertEquals(state.focusedPlayerId, "c3");
  state = nextPlayer(state, ROSTER);
  assertEquals(state.focusedPlayerId, "a1");
  state = previousPlayer(state, ROSTER);
  assertEquals(state.focusedPlayerId, "c3");
  state = previousPlayer(state, ROSTER);
  assertEquals(state.focusedPlayerId, "b2");
  state = previousPlayer(state, ROSTER);
  assertEquals(state.focusedPlayerId, "a1");
});

Deno.test("12.1 next/previous: null focus picks first / last", () => {
  const state = createSpectatorState();
  assertEquals(nextPlayer(state, ROSTER).focusedPlayerId, "a1");
  assertEquals(previousPlayer(state, ROSTER).focusedPlayerId, "c3");
});

Deno.test("12.1 next/previous: single-id roster is a no-op round-trip", () => {
  const roster = ["solo"];
  const state = selectFocusedPlayer(createSpectatorState(), "solo", roster);
  assertEquals(nextPlayer(state, roster).focusedPlayerId, "solo");
  assertEquals(previousPlayer(state, roster).focusedPlayerId, "solo");
});

Deno.test("12.1 next/previous: absent ids keep cycle slots (no compact)", () => {
  // Identity roster still lists c3 even though they are "absent" from play.
  const identity = ["c3", "a1", "b2"];
  let state = selectFocusedPlayer(createSpectatorState(), "a1", identity);
  state = nextPlayer(state, identity);
  assertEquals(state.focusedPlayerId, "b2");
  state = nextPlayer(state, identity);
  assertEquals(state.focusedPlayerId, "c3");
  state = nextPlayer(state, identity);
  assertEquals(state.focusedPlayerId, "a1");
});

Deno.test("12.1 next/previous: compacted roster that drops focus fails loud", () => {
  const state = selectFocusedPlayer(createSpectatorState(), "c3", ROSTER);
  assertSelectionCode(
    () => nextPlayer(state, ["a1", "b2"]),
    "replay-spectator-focus-unknown",
  );
  assertEquals(state.focusedPlayerId, "c3");
});

Deno.test("12.1 next/previous: empty roster fails loud", () => {
  const state = createSpectatorState();
  assertSelectionCode(() => nextPlayer(state, []), "replay-spectator-focus-empty");
  assertSelectionCode(
    () => previousPlayer(state, []),
    "replay-spectator-focus-empty",
  );
});

Deno.test("12.1 playback cycle: next from h1 wraps to b1 (ascending)", () => {
  const { session, collision } = liveCapturedSession({ ticks: 2 });
  const playback = createReplayPlayback(session, {
    collision,
    focusedPlayerId: "h1",
  });
  playback.start();
  const before = clockSlice(playback);
  playback.selectNextPlayer();
  assertEquals(playback.state.focusedPlayerId, "b1");
  assertEquals(clockSlice(playback), before);
  assertFeedMatchesFocus(playback, "b1");
  playback.selectPreviousPlayer();
  assertEquals(playback.state.focusedPlayerId, "h1");
  assertEquals(clockSlice(playback), before);
});

// ---------------------------------------------------------------------------
// Switch rows (Open Question 2A)
// ---------------------------------------------------------------------------

Deno.test("12.1 switch: mid-stream re-projects without reset / re-step / clock change", () => {
  const { session, collision } = liveCapturedSession({ ticks: 6 });
  const playback = createReplayPlayback(session, {
    collision,
    focusedPlayerId: "h1",
  });
  playback.start();
  for (let i = 0; i < 3; i++) playback.frame(TICK_MS);
  const before = clockSlice(playback);
  const snapTick = playback.feeders.state()!.tick;
  playback.setFocusedPlayerId("b1");
  assertEquals(clockSlice(playback), before);
  assertEquals(playback.feeders.state()!.tick, snapTick);
  assertFeedMatchesFocus(playback, "b1");
  assertEquals(isSnapshotPacketShaped(playback.feeders.state()), true);
  assertEquals(isRenderFeedShaped(playback.feeders.render()), true);
});

Deno.test("12.1 switch: double-switch and switch-back", () => {
  const { session, collision } = liveCapturedSession({ ticks: 4 });
  const playback = createReplayPlayback(session, {
    collision,
    focusedPlayerId: "h1",
  });
  playback.start();
  playback.frame(TICK_MS);
  playback.frame(TICK_MS);
  const before = clockSlice(playback);
  playback.setFocusedPlayerId("b1");
  playback.setFocusedPlayerId("h1");
  playback.setFocusedPlayerId("b1");
  assertEquals(clockSlice(playback), before);
  assertFeedMatchesFocus(playback, "b1");
});

Deno.test("12.1 switch: unknown id fails loud and leaves prior slot intact", () => {
  const { session, collision } = liveCapturedSession({ ticks: 3 });
  const playback = createReplayPlayback(session, {
    collision,
    focusedPlayerId: "h1",
  });
  playback.start();
  playback.frame(TICK_MS);
  const before = clockSlice(playback);
  const priorFocus = playback.state.focusedPlayerId;
  const priorFeed = playback.feeders.render();
  assertSelectionCode(
    () => playback.setFocusedPlayerId("ghost"),
    "replay-spectator-focus-unknown",
  );
  assertEquals(playback.state.focusedPlayerId, priorFocus);
  assertEquals(clockSlice(playback), before);
  assertEquals(playback.feeders.render(), priorFeed);
});

Deno.test("12.1 switch: before start fails loud (not-started)", () => {
  const { session, collision } = liveCapturedSession({ ticks: 2 });
  const playback = createReplayPlayback(session, { collision });
  assertThrows(
    () => playback.setFocusedPlayerId("h1"),
    ReplayPlaybackError,
    "before start",
  );
});

Deno.test("12.1 switch: start() restores construction focus (full restart)", () => {
  const { session, collision } = liveCapturedSession({ ticks: 3 });
  const playback = createReplayPlayback(session, {
    collision,
    focusedPlayerId: "h1",
  });
  playback.start();
  playback.frame(TICK_MS);
  playback.setFocusedPlayerId("b1");
  playback.start();
  assertEquals(playback.state.focusedPlayerId, "h1");
  assertEquals(playback.state.currentTick, session.firstTick);
});

// ---------------------------------------------------------------------------
// Absence rows (Decision 9)
// ---------------------------------------------------------------------------

Deno.test("12.1 absence: valid-then-absent keeps slot; projection surfaces 11.5", () => {
  const { session, collision } = liveCapturedSession({
    ticks: 6,
    leaveAt: { playerId: "b1", tick: 4 },
  });
  const playback = createReplayPlayback(session, {
    collision,
    focusedPlayerId: "b1",
  });
  playback.start();
  playback.frame(TICK_MS); // tick 1
  playback.frame(TICK_MS); // tick 2
  playback.frame(TICK_MS); // tick 3
  playback.frame(TICK_MS); // tick 4: leave; 11.5 holds exact-T (prev still has b1)
  assertEquals(playback.state.focusedPlayerId, "b1");
  const err = assertThrows(
    () => playback.frame(TICK_MS), // tick 5: prev also missing b1 → 11.5 unknown
    ReplayStateAccessError,
  );
  assertEquals(err.code, "replay-state-focus-unknown");
  assertEquals(playback.state.focusedPlayerId, "b1");
});

Deno.test("12.1 absence: switching still works while current focus is absent", () => {
  const { session, collision } = liveCapturedSession({
    ticks: 6,
    leaveAt: { playerId: "b1", tick: 4 },
  });
  const playback = createReplayPlayback(session, {
    collision,
    focusedPlayerId: "b1",
  });
  playback.start();
  playback.frame(TICK_MS);
  playback.frame(TICK_MS);
  playback.frame(TICK_MS);
  playback.frame(TICK_MS); // leave tick — still projectable from prev view
  assertThrows(() => playback.frame(TICK_MS), ReplayStateAccessError);
  assertEquals(playback.state.focusedPlayerId, "b1");
  // Identity roster still lists b1 (init ∪ cache ∪ view-at-start).
  assertEquals(playback.focusRoster().includes("b1"), true);
  const before = clockSlice(playback);
  playback.setFocusedPlayerId("h1");
  assertEquals(clockSlice(playback), before);
  assertFeedMatchesFocus(playback, "h1");
});

Deno.test("12.1 absence: cycle keeps absent id in order", () => {
  const { session, collision } = liveCapturedSession({
    ticks: 6,
    leaveAt: { playerId: "b1", tick: 4 },
  });
  const playback = createReplayPlayback(session, {
    collision,
    focusedPlayerId: "h1",
  });
  playback.start();
  playback.frame(TICK_MS);
  playback.frame(TICK_MS);
  playback.frame(TICK_MS);
  playback.frame(TICK_MS); // h1 still present; b1 gone from sim
  assertEquals(playback.focusRoster(), ["b1", "h1"]);
  playback.selectPreviousPlayer(); // h1 → b1 (wrap/prev)
  assertEquals(playback.state.focusedPlayerId, "b1");
});

// ---------------------------------------------------------------------------
// Focus ⊥ filter
// ---------------------------------------------------------------------------

Deno.test("12.1 focus⊥filter: stub filter change leaves focus unchanged", () => {
  const state = selectFocusedPlayer(
    createSpectatorState({ visibilityFilter: "all" }),
    "b2",
    ROSTER,
  );
  const filtered: SpectatorState = Object.freeze({
    ...state,
    visibilityFilter: "red" as const,
  });
  assertEquals(filtered.focusedPlayerId, "b2");
  assertEquals(filtered.visibilityFilter, "red");
});

Deno.test("12.1 focus⊥filter: select never writes the filter field", () => {
  const state = createSpectatorState({ visibilityFilter: "blue" });
  const next = selectFocusedPlayer(state, "a1", ROSTER);
  assertEquals(next.visibilityFilter, "blue");
  assertEquals(next.focusedPlayerId, "a1");
});

Deno.test("12.1 focus⊥filter: focus outside stub filter still drives feed", () => {
  // Focus Blue bot while a stub "red" filter would hide them — 12.1 does not
  // consult the filter; the 11.6 feed still shows b1.
  const { session, collision } = liveCapturedSession({ ticks: 2 });
  const playback = createReplayPlayback(session, {
    collision,
    focusedPlayerId: "h1",
  });
  playback.start();
  const spectator = selectFocusedPlayer(
    createSpectatorState({ visibilityFilter: "red" }),
    "b1",
    playback.focusRoster(),
  );
  assertEquals(spectator.visibilityFilter, "red");
  assertEquals(spectator.focusedPlayerId, "b1");
  playback.setFocusedPlayerId(spectator.focusedPlayerId!);
  assertFeedMatchesFocus(playback, "b1");
});

// ---------------------------------------------------------------------------
// Raid surfaces runner error unchanged
// ---------------------------------------------------------------------------

Deno.test("12.1 raid: createReplayPlayback surfaces runner named raid error", () => {
  const { initialState, collision } = emptyLiveInit();
  const raidMeta = sampleMetadata(initialState.init, {
    raidMatch: {
      active: true,
      raidId: "raid-1",
      humanTeam: "A",
      goal: 10,
      maxTimeSeconds: 600,
      respawnMs: 5000,
      initialMap: "replay-selection",
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
// Seams + non-interference
// ---------------------------------------------------------------------------

Deno.test("12.1 seams: selection + switching never unshapes snapshot/feed", () => {
  const { session, collision } = liveCapturedSession({ ticks: 5 });
  const playback = createReplayPlayback(session, {
    collision,
    focusedPlayerId: "h1",
  });
  playback.start();
  assertEquals(isSnapshotPacketShaped(playback.feeders.state()), true);
  assertEquals(isRenderFeedShaped(playback.feeders.render()), true);
  for (let i = 0; i < 4; i++) {
    playback.frame(TICK_MS);
    if (i % 2 === 0) playback.setFocusedPlayerId("b1");
    else playback.setFocusedPlayerId("h1");
    assertEquals(isSnapshotPacketShaped(playback.feeders.state()), true);
    assertEquals(isRenderFeedShaped(playback.feeders.render()), true);
  }
});

Deno.test("12.1 non-interference: switching every N ticks ≡ never-observed snapshots", () => {
  const ticks = 6;
  const observed = liveCapturedSession({ ticks, seed: 0x51e1 });
  const control = liveCapturedSession({ ticks, seed: 0x51e1 });

  const watching = createReplayPlayback(observed.session, {
    collision: observed.collision,
    focusedPlayerId: "h1",
  });
  const quiet = createReplayPlayback(control.session, {
    collision: control.collision,
    focusedPlayerId: "h1",
  });
  watching.start();
  quiet.start();

  const watched: string[] = [];
  const untouched: string[] = [];
  for (let i = 0; i < ticks; i++) {
    watching.frame(TICK_MS);
    quiet.frame(TICK_MS);
    if (i % 2 === 0) watching.setFocusedPlayerId("b1");
    else watching.setFocusedPlayerId("h1");
    watched.push(snapshotFingerprint(watching.feeders.state()));
    untouched.push(snapshotFingerprint(quiet.feeders.state()));
  }
  assertEquals(watched, untouched);

  const direct = createReplayRunner(control.session, {
    collision: makeCollision(),
  });
  direct.resetToInitial();
  const digest: string[] = [];
  for (let tick = control.session.firstTick; tick <= control.session.lastTick; tick++) {
    const out = direct.step(tick);
    digest.push(JSON.stringify({
      tick: out.tick,
      scores: out.scores,
      roster: out.rosterDigest,
      deaths: out.overlapDeaths.length,
      respawned: out.respawnedIds,
      gameOver: out.gameOver,
    }));
  }
  const direct2 = createReplayRunner(observed.session, {
    collision: makeCollision(),
  });
  direct2.resetToInitial();
  const digest2: string[] = [];
  for (let tick = observed.session.firstTick; tick <= observed.session.lastTick; tick++) {
    const out = direct2.step(tick);
    digest2.push(JSON.stringify({
      tick: out.tick,
      scores: out.scores,
      roster: out.rosterDigest,
      deaths: out.overlapDeaths.length,
      respawned: out.respawnedIds,
      gameOver: out.gameOver,
    }));
  }
  assertEquals(digest, digest2);
});

Deno.test("12.1 shifted-wall-clock: identical selection output", () => {
  const state = createSpectatorState();
  const a = selectFocusedPlayer(state, "b2", ROSTER);
  const b = selectFocusedPlayer(state, "b2", ROSTER);
  assertEquals(a, b);
  assertEquals(nextPlayer(a, ROSTER), nextPlayer(b, ROSTER));
});

// ---------------------------------------------------------------------------
// Purity / isolation source scan
// ---------------------------------------------------------------------------

Deno.test("12.1 source-scan: pure module has no THREE/DOM/clock/sim/io", async () => {
  const src = await Deno.readTextFile(
    new URL("./spectatorSelection.ts", import.meta.url),
  );
  // Call-site / import scan (header comments may name excluded owners).
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const banned of [
    "Date.now",
    "performance.now",
    "requestAnimationFrame",
    "setInterval",
    "setTimeout",
    "THREE",
    "document",
    "window",
    "keyboard",
    "replaySimulationRunner",
    "replayClock",
    "replayPlaybackSession",
    "createReplayPlayback",
    "ReplayPlayback",
    "PlayerManager",
    "BotManager",
    "GameServer",
    "MapCollision",
    "interpolateReplayPose",
    "projectReplayRenderFeed",
    "applyVisibilityFilter",
    "CameraPose",
    "Deno.",
    "node:fs",
    "ReplayBlobStore",
    "createStore",
    "from \"../net/",
    "from \"./net/",
    "socket.io",
  ]) {
    assertEquals(code.includes(banned), false, `banned token present: ${banned}`);
  }
  assertEquals(src.includes("selectFocusedPlayer"), true);
  assertEquals(src.includes("nextPlayer"), true);
  assertEquals(src.includes("previousPlayer"), true);
});
