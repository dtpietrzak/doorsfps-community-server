/**
 * Epic 13 — killcams (death identity, window, killer camera, bounded play, exit).
 *
 * Run from server-community/:
 *   deno test -A replay/killcam_test.ts
 */

import {
  assertEquals,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { RESPAWN_DELAY_MS, TICK_HZ, TICK_MS } from "../shared/sim/game.ts";
import {
  buildMatchMetadata,
  type MatchMetadata,
} from "../shared/replay/matchMetadata.ts";
import {
  emptyAuthoritativeRosterSnapshot,
  makePlayerDiedEvent,
  makePlayerRemoveEvent,
  makePlayerRespawnedEvent,
  type AuthoritativeEvent,
  type MatchInitEvent,
  type PlayerDiedEvent,
} from "../shared/sim/authoritativeEvent.ts";
import { PlayerManager } from "../players/PlayerManager.ts";
import type { TickSelectedInput } from "../players/tickAssociation.ts";
import type { DoorsMap } from "../world/map.ts";
import type { PlayerInput } from "../protocol/network.ts";
import { MapCollision } from "../world/MapCollision.ts";
import {
  captureCheckpointState,
  type AuthoritativeCheckpoint,
  type CheckpointPlayerState,
} from "./authoritativeCheckpoint.ts";
import {
  frameKillcamWindow,
  killcamFocusPlayerId,
  KILLCAM_POST_MS,
  KILLCAM_POST_TICKS,
  KILLCAM_PRE_MS,
  KILLCAM_PRE_TICKS,
  KillcamError,
  type KillcamErrorCode,
  resolveKillcamDeath,
  victimRespawnedInEvents,
} from "./killcam.ts";
import {
  enterKillcamFocus,
  killcamSessionFromBuffer,
  startKillcam,
  startKillcamFromBuffer,
} from "./killcamPlayback.ts";
import type { RecordedInitialState } from "./recordedInitialState.ts";
import type { RecordedTickInputs } from "./recordedTickInputs.ts";
import { MAX_STEPS_PER_ADVANCE } from "./replayClock.ts";
import {
  createReplayPlayback,
  type ReplayPlayback,
} from "./replayPlaybackSession.ts";
import { ReplaySessionBuffer } from "./replaySessionBuffer.ts";
import {
  __replayTickNowMsForTest,
  ReplayRaidUnsupportedError,
  type ReplayRunSession,
} from "./replaySimulationRunner.ts";
import {
  firstPersonCamera,
  thirdPersonCamera,
  type CameraPose,
} from "./spectatorCamera.ts";
import {
  createSpectatorState,
  selectFocusedPlayer,
} from "./spectatorSelection.ts";
import {
  applyVisibilityFilter,
  setVisibilityFilter,
} from "./spectatorFilter.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const miniMap: DoorsMap = {
  name: "replay-killcam",
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
      runtimeMatchId: "rt-killcam-1",
      serverName: "killcam-test",
      serverId: "srv-killcam",
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

function died(
  over: Pick<PlayerDiedEvent, "appliedTick" | "victimId" | "killerId"> &
    Partial<PlayerDiedEvent>,
): PlayerDiedEvent {
  return makePlayerDiedEvent({
    appliedTick: over.appliedTick,
    victimId: over.victimId,
    killerId: over.killerId,
    zone: over.zone ?? "body",
    weapon: over.weapon ?? 0,
    killerName: over.killerName ?? over.killerId,
    victimName: over.victimName ?? over.victimId,
    killerTeam: over.killerTeam ?? "B",
    victimTeam: over.victimTeam ?? "A",
  });
}

function liveCapturedSession(opts?: {
  seed?: number;
  ticks?: number;
  withBot?: boolean;
  extraEvents?: ReadonlyMap<number, readonly AuthoritativeEvent[]>;
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
      tickEvents.push(makePlayerRemoveEvent(tick, opts.leaveAt.playerId));
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
      if (!sel) throw new Error(`missing selection for ${p.id} at tick ${tick}`);
      movement.push(sel);
    }
    inputs.set(tick, { tick, movement, actions: [] });
    const extra = opts?.extraEvents?.get(tick) ?? [];
    events.set(tick, [...tickEvents, ...extra]);

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

function sessionToBuffer(session: ReplayRunSession): ReplaySessionBuffer {
  const buffer = new ReplaySessionBuffer(session.initialState.runtimeMatchId);
  buffer.setInit(session.initialState);
  for (let tick = session.firstTick; tick <= session.lastTick; tick++) {
    buffer.putInputs(session.inputAt(tick));
    const ev = session.eventsAt(tick);
    if (ev.length > 0) {
      buffer.putEvents({ tick, events: ev });
    }
    const committed = buffer.commitTick();
    if (!committed.ok) throw new Error(`commit failed: ${committed.reason}`);
  }
  return buffer;
}

function assertKillcamCode(
  fn: () => unknown,
  code: KillcamErrorCode,
): KillcamError {
  const err = assertThrows(fn, KillcamError);
  assertEquals(err.code, code);
  return err;
}

function noHit(): null {
  return null;
}

function clockSlice(playback: ReplayPlayback): {
  currentTick: number;
  carryMs: number;
  speed: number;
  isPaused: boolean;
  isEnded: boolean;
} {
  const s = playback.state;
  return {
    currentTick: s.currentTick,
    carryMs: s.carryMs,
    speed: s.speed,
    isPaused: s.isPaused,
    isEnded: s.isEnded,
  };
}

function filterRow(
  over: Pick<CheckpointPlayerState, "id" | "team"> & { isAgent?: boolean },
): CheckpointPlayerState {
  return {
    id: over.id,
    team: over.team,
    isBot: false,
    isAgent: over.isAgent ?? false,
  } as CheckpointPlayerState;
}

// ---------------------------------------------------------------------------
// 13.1 Death identity
// ---------------------------------------------------------------------------

Deno.test("13.1 pins: pre/post defaults and tick conversion", () => {
  assertEquals(KILLCAM_PRE_MS, 3000);
  assertEquals(KILLCAM_POST_MS, 2000);
  assertEquals(KILLCAM_PRE_TICKS, 180);
  assertEquals(KILLCAM_POST_TICKS, 120);
  assertEquals((KILLCAM_PRE_MS * TICK_HZ) / 1000, 180);
});

Deno.test("13.2 invariant: doors-open respawn lands as the killcam ends", () => {
  // Die → 3 s before the kill → 2 s after → respawn. A live spawn ends the
  // rewind: shorter clips the kill, longer leaves a "Respawning…" gap.
  assertEquals(RESPAWN_DELAY_MS, KILLCAM_PRE_MS + KILLCAM_POST_MS);
});

Deno.test("13.1 exact-tick: deathTick is appliedTick verbatim", () => {
  const event = died({
    appliedTick: 47,
    victimId: "h1",
    killerId: "b1",
    victimName: "Human",
    killerName: "BotOne",
  });
  const death = resolveKillcamDeath([event], {
    victimId: "h1",
    deathTick: 47,
  });
  assertEquals(death.deathTick, 47);
  assertEquals(death.deathTick, event.appliedTick);
  assertEquals(death.victimId, "h1");
  assertEquals(death.killerId, "b1");
  assertEquals(death.victimName, "Human");
  assertEquals(death.killerName, "BotOne");
});

Deno.test("13.1 same-tick double-death: victims resolve independently", () => {
  const a = died({
    appliedTick: 10,
    victimId: "h1",
    killerId: "b1",
    killerName: "BotOne",
    victimName: "Human",
  });
  const b = died({
    appliedTick: 10,
    victimId: "b1",
    killerId: "h1",
    killerName: "Human",
    victimName: "BotOne",
    killerTeam: "A",
    victimTeam: "B",
  });
  const deathA = resolveKillcamDeath([a, b], { victimId: "h1", deathTick: 10 });
  const deathB = resolveKillcamDeath([a, b], { victimId: "b1", deathTick: 10 });
  assertEquals(deathA.killerId, "b1");
  assertEquals(deathB.killerId, "h1");
  assertEquals(deathA.victimId, "h1");
  assertEquals(deathB.victimId, "b1");
});

Deno.test("13.1 eventPlayerId trap: killer is event.killerId, not victimId", () => {
  const event = died({
    appliedTick: 3,
    victimId: "h1",
    killerId: "b1",
  });
  // eventPlayerId(playerDied) === victimId. A caller that used it for the
  // killer would chase the corpse. Resolve must read killerId.
  const death = resolveKillcamDeath([event], { victimId: "h1", deathTick: 3 });
  assertEquals(death.killerId, event.killerId);
  assertEquals(death.killerId === event.victimId, false);
  assertEquals(killcamFocusPlayerId(death), "b1");
});

Deno.test("13.1 unknown-death: no matching victim at that tick", () => {
  const event = died({ appliedTick: 5, victimId: "h1", killerId: "b1" });
  assertKillcamCode(
    () => resolveKillcamDeath([event], { victimId: "h1", deathTick: 6 }),
    "replay-killcam-unknown-death",
  );
  assertKillcamCode(
    () => resolveKillcamDeath([event], { victimId: "nope", deathTick: 5 }),
    "replay-killcam-unknown-death",
  );
});

Deno.test("13.1 search window: near only when searchTicks is explicit", () => {
  const event = died({ appliedTick: 10, victimId: "h1", killerId: "b1" });
  assertKillcamCode(
    () => resolveKillcamDeath([event], { victimId: "h1", deathTick: 12 }),
    "replay-killcam-unknown-death",
  );
  const found = resolveKillcamDeath([event], {
    victimId: "h1",
    deathTick: 12,
    searchTicks: 2,
  });
  assertEquals(found.deathTick, 10);
});

Deno.test("13.1 empty-source: null / non-stream fails loud", () => {
  assertKillcamCode(
    () => resolveKillcamDeath(null, { victimId: "h1", deathTick: 1 }),
    "replay-killcam-empty-source",
  );
  assertKillcamCode(
    () =>
      resolveKillcamDeath({} as never, { victimId: "h1", deathTick: 1 }),
    "replay-killcam-empty-source",
  );
});

Deno.test("13.1 session eventsAt: exact tick, not nearest", () => {
  const events = new Map<number, AuthoritativeEvent[]>([
    [4, [died({ appliedTick: 4, victimId: "h1", killerId: "b1" })]],
    [8, [died({ appliedTick: 8, victimId: "h1", killerId: "x" })]],
  ]);
  const source = {
    firstTick: 1,
    lastTick: 10,
    eventsAt: (tick: number) => events.get(tick) ?? [],
  };
  const death = resolveKillcamDeath(source, { victimId: "h1", deathTick: 4 });
  assertEquals(death.killerId, "b1");
  assertKillcamCode(
    () => resolveKillcamDeath(source, { victimId: "h1", deathTick: 5 }),
    "replay-killcam-unknown-death",
  );
});

// ---------------------------------------------------------------------------
// 13.2 Window
// ---------------------------------------------------------------------------

Deno.test("13.2 window: default lead/tail around an interior death", () => {
  const window = frameKillcamWindow(400, { firstTick: 1, lastTick: 2000 });
  assertEquals(window.startTick, 400 - KILLCAM_PRE_TICKS);
  assertEquals(window.endTick, 400 + KILLCAM_POST_TICKS);
  assertEquals(window.deathTick, 400);
});

Deno.test("13.2 lead clamps at match start; never negative", () => {
  const window = frameKillcamWindow(10, { firstTick: 1, lastTick: 500 });
  assertEquals(window.startTick, 1);
  assertEquals(window.endTick, 10 + KILLCAM_POST_TICKS);
  assertEquals(window.startTick >= 1, true);
});

Deno.test("13.2 tail clamps at session end", () => {
  const window = frameKillcamWindow(495, { firstTick: 1, lastTick: 500 });
  assertEquals(window.startTick, 495 - 180);
  assertEquals(window.endTick, 500);
});

Deno.test("13.2 custom pre/post and single-tick window", () => {
  const window = frameKillcamWindow(20, {
    firstTick: 1,
    lastTick: 40,
    preMs: 0,
    postMs: 0,
  });
  assertEquals(window.startTick, 20);
  assertEquals(window.endTick, 20);
});

Deno.test("13.2 bad-window: non-finite, inverted bounds, empty clamp", () => {
  assertKillcamCode(
    () => frameKillcamWindow(Number.NaN, { firstTick: 1, lastTick: 10 }),
    "replay-killcam-bad-window",
  );
  assertKillcamCode(
    () => frameKillcamWindow(-1, { firstTick: 0, lastTick: 10 }),
    "replay-killcam-bad-window",
  );
  assertKillcamCode(
    () => frameKillcamWindow(5, { firstTick: 10, lastTick: 4 }),
    "replay-killcam-bad-window",
  );
  assertKillcamCode(
    () =>
      frameKillcamWindow(5, {
        firstTick: 1,
        lastTick: 10,
        preMs: -1,
      }),
    "replay-killcam-bad-window",
  );
});

// ---------------------------------------------------------------------------
// 13.3 Killer camera
// ---------------------------------------------------------------------------

Deno.test("13.3 self-kill: focus stays on the victim", () => {
  const death = resolveKillcamDeath(
    [died({ appliedTick: 4, victimId: "h1", killerId: "h1" })],
    { victimId: "h1", deathTick: 4 },
  );
  assertEquals(killcamFocusPlayerId(death), "h1");
  const { session, collision } = liveCapturedSession({
    ticks: 8,
    extraEvents: new Map([
      [4, [died({ appliedTick: 4, victimId: "h1", killerId: "h1" })]],
    ]),
  });
  const cam = startKillcam(session, death, {
    collision,
    preMs: 0,
    postMs: 0,
  });
  assertEquals(cam.playback.state.focusedPlayerId, "h1");
});

Deno.test("13.3 unknown-killer wraps 12.1 focus-unknown", () => {
  const extra = new Map<number, AuthoritativeEvent[]>([
    [3, [died({ appliedTick: 3, victimId: "h1", killerId: "ghost" })]],
  ]);
  const { session, collision } = liveCapturedSession({
    ticks: 6,
    extraEvents: extra,
  });
  const err = assertKillcamCode(
    () =>
      startKillcam(session, { victimId: "h1", deathTick: 3 }, {
        collision,
        preMs: 0,
        postMs: 0,
      }),
    "replay-killcam-unknown-killer",
  );
  assertEquals(err.cause instanceof Error, true);
});

Deno.test("13.3 enterKillcamFocus is slot-only (clock unchanged)", () => {
  const { session, collision } = liveCapturedSession({ ticks: 6 });
  const playback = createReplayPlayback(session, {
    collision,
    focusedPlayerId: "h1",
  });
  playback.start();
  playback.frame(TICK_MS);
  playback.frame(TICK_MS);
  const before = clockSlice(playback);
  enterKillcamFocus(
    playback,
    resolveKillcamDeath(
      [died({ appliedTick: 3, victimId: "h1", killerId: "b1" })],
      { victimId: "h1", deathTick: 3 },
    ),
  );
  assertEquals(playback.state.focusedPlayerId, "b1");
  assertEquals(clockSlice(playback), before);
});

Deno.test("13.3 focus ⊥ filter: killer outside filter still drives pose", () => {
  const spec = setVisibilityFilter(createSpectatorState(), "blue");
  const focused = selectFocusedPlayer(spec, "b1", ["h1", "b1"]);
  assertEquals(focused.visibilityFilter, "blue");
  assertEquals(focused.focusedPlayerId, "b1");
  const subset = applyVisibilityFilter(
    [filterRow({ id: "h1", team: "A" }), filterRow({ id: "b1", team: "B" })],
    "blue",
  );
  assertEquals(subset.map((row) => row.id), ["h1"]);

  const { session, collision } = liveCapturedSession({
    ticks: 8,
    extraEvents: new Map([
      [4, [died({ appliedTick: 4, victimId: "h1", killerId: "b1" })]],
    ]),
  });
  const cam = startKillcam(session, { victimId: "h1", deathTick: 4 }, {
    collision,
    preMs: 0,
    postMs: 0,
  });
  assertEquals(cam.playback.state.focusedPlayerId, "b1");
  const feed = cam.playback.feeders.render();
  if (feed == null) throw new Error("expected killer feed");
  const pose = firstPersonCamera({ kind: "feed", feed });
  assertEquals(cam.state().focusedPlayerId, "b1");
  assertEquals(pose.yaw, feed.yaw);
});

Deno.test("13.3 FP pose equals firstPersonCamera on the same feed", () => {
  const { session, collision } = liveCapturedSession({
    ticks: 8,
    extraEvents: new Map([
      [4, [died({ appliedTick: 4, victimId: "h1", killerId: "b1" })]],
    ]),
  });
  const cam = startKillcam(session, { victimId: "h1", deathTick: 4 }, {
    collision,
    preMs: 0,
    postMs: 0,
  });
  const frame = cam.frame(TICK_MS);
  const feed = cam.playback.feeders.render();
  if (feed == null || frame.pose == null) throw new Error("expected pose");
  const expected = firstPersonCamera({ kind: "feed", feed });
  assertEquals(frame.pose, expected);
});

Deno.test("13.3 3P pose equals thirdPersonCamera on the same display", () => {
  const { session, collision } = liveCapturedSession({
    ticks: 8,
    extraEvents: new Map([
      [4, [died({ appliedTick: 4, victimId: "h1", killerId: "b1" })]],
    ]),
  });
  const cam = startKillcam(session, { victimId: "h1", deathTick: 4 }, {
    collision,
    camera: "third-person",
    raycast: noHit,
    preMs: 0,
    postMs: 0,
  });
  const frame = cam.frame(TICK_MS);
  const feed = cam.playback.feeders.render();
  const display = cam.playback.focusedDisplay();
  if (feed == null || display == null || frame.pose == null) {
    throw new Error("expected 3P pose");
  }
  const expected = thirdPersonCamera(
    {
      kind: "pose",
      pose: display.pose,
      snapped: display.snapped,
      eye: feed.viewOffset,
    },
    { raycast: noHit },
  );
  assertEquals(frame.pose, expected);
});

Deno.test("13.3 killer-dead eliminated: FP presence passthrough", () => {
  const { session, collision } = liveCapturedSession({ ticks: 4 });
  const playback = createReplayPlayback(session, {
    collision,
    focusedPlayerId: "b1",
  });
  playback.start();
  playback.frame(TICK_MS);
  const feed = playback.feeders.render();
  if (feed == null) throw new Error("expected feed");
  const deadFeed = { ...feed, alive: false };
  const pose = firstPersonCamera({ kind: "feed", feed: deadFeed });
  assertEquals(pose.presence, "eliminated");
  assertEquals(pose.x, firstPersonCamera({ kind: "feed", feed }).x);
});

Deno.test("13.3 killer-absent: hold-last, never auto-switch, never zero-pose", () => {
  const deathEv = died({ appliedTick: 2, victimId: "h1", killerId: "b1" });
  const { session, collision } = liveCapturedSession({
    ticks: 8,
    extraEvents: new Map([[2, [deathEv]]]),
    leaveAt: { playerId: "b1", tick: 4 },
  });
  const cam = startKillcam(session, { victimId: "h1", deathTick: 2 }, {
    collision,
    preMs: 0,
    postMs: 1000,
  });
  assertEquals(cam.playback.state.focusedPlayerId, "b1");
  let lastPresent: CameraPose | null = null;
  let sawAbsent = false;
  for (let i = 0; i < 8; i++) {
    const frame = cam.frame(TICK_MS);
    if (frame.exited) break;
    if (frame.pose?.presence === "absent") {
      sawAbsent = true;
      assertEquals(cam.playback.state.focusedPlayerId, "b1");
      if (lastPresent) {
        assertStrictEquals(frame.pose.x, lastPresent.x);
        assertStrictEquals(frame.pose.y, lastPresent.y);
        assertStrictEquals(frame.pose.z, lastPresent.z);
      }
      assertEquals(frame.pose.x === 0 && frame.pose.y === 0, false);
    } else if (frame.pose) {
      lastPresent = frame.pose;
    }
  }
  assertEquals(sawAbsent, true);
});

// ---------------------------------------------------------------------------
// 13.4 Playback
// ---------------------------------------------------------------------------

Deno.test("13.4 open-window re-step bound is startTick - firstTick", () => {
  const deathTick = 30;
  const { session, collision } = liveCapturedSession({
    ticks: 40,
    extraEvents: new Map([
      [deathTick, [died({
        appliedTick: deathTick,
        victimId: "h1",
        killerId: "b1",
      })]],
    ]),
  });
  const cam = startKillcam(session, { victimId: "h1", deathTick }, {
    collision,
    preMs: 200,
    postMs: 50,
  });
  assertEquals(cam.openSteps, cam.window.startTick - session.firstTick);
  assertEquals(cam.openSteps <= MAX_STEPS_PER_ADVANCE, true);
  assertEquals(cam.playback.state.speed, 1);
  assertEquals(cam.playback.state.currentTick, cam.window.startTick - 1);
});

Deno.test("13.4 1× drive never steps past endTick", () => {
  const { session, collision } = liveCapturedSession({
    ticks: 12,
    extraEvents: new Map([
      [6, [died({ appliedTick: 6, victimId: "h1", killerId: "b1" })]],
    ]),
  });
  const cam = startKillcam(session, { victimId: "h1", deathTick: 6 }, {
    collision,
    preMs: 50,
    postMs: 50,
  });
  let last = cam.frame(10_000);
  while (!last.exited) {
    last = cam.frame(10_000);
  }
  assertEquals(last.exitReason, "window-end");
  assertEquals(cam.playback.state.currentTick, cam.window.endTick);
  assertEquals(cam.playback.state.currentTick <= cam.window.endTick, true);
});

Deno.test("13.4 skip is an exit, not a seek", () => {
  const { session, collision } = liveCapturedSession({
    ticks: 10,
    extraEvents: new Map([
      [5, [died({ appliedTick: 5, victimId: "h1", killerId: "b1" })]],
    ]),
  });
  const cam = startKillcam(session, { victimId: "h1", deathTick: 5 }, {
    collision,
    preMs: 0,
    postMs: 500,
  });
  cam.frame(TICK_MS);
  const before = clockSlice(cam.playback);
  const skipped = cam.skip();
  assertEquals(skipped.exited, true);
  assertEquals(skipped.exitReason, "skip");
  const after = clockSlice(cam.playback);
  assertEquals(after.currentTick, before.currentTick);
  assertEquals(after.carryMs, before.carryMs);
  assertEquals(after.speed, before.speed);
  assertEquals(after.isEnded, before.isEnded);
  assertEquals(cam.playback.state.focusedPlayerId, "h1");
});

Deno.test("13.4 live buffer source uses the same window type", () => {
  const { session, collision } = liveCapturedSession({
    ticks: 8,
    extraEvents: new Map([
      [4, [died({ appliedTick: 4, victimId: "h1", killerId: "b1" })]],
    ]),
  });
  const buffer = sessionToBuffer(session);
  const fromBuf = killcamSessionFromBuffer(buffer);
  assertEquals(fromBuf.firstTick, session.firstTick);
  assertEquals(fromBuf.lastTick, session.lastTick);
  const cam = startKillcamFromBuffer(buffer, {
    victimId: "h1",
    deathTick: 4,
  }, { collision, preMs: 0, postMs: 0 });
  assertEquals(cam.window.deathTick, 4);
  assertEquals(cam.window.startTick, 4);
  assertEquals(cam.window.endTick, 4);
  const frame = cam.frame(TICK_MS);
  assertEquals(frame.exited, true);
  assertEquals(frame.exitReason, "window-end");
});

// ---------------------------------------------------------------------------
// 13.5 Exit
// ---------------------------------------------------------------------------

Deno.test("13.5 window-end restores victim focus; cursor unchanged by restore", () => {
  const { session, collision } = liveCapturedSession({
    ticks: 8,
    extraEvents: new Map([
      [4, [died({ appliedTick: 4, victimId: "h1", killerId: "b1" })]],
    ]),
  });
  const cam = startKillcam(session, { victimId: "h1", deathTick: 4 }, {
    collision,
    restoreFocusId: "h1",
    preMs: 0,
    postMs: 0,
  });
  assertEquals(cam.playback.state.focusedPlayerId, "b1");
  const frame = cam.frame(TICK_MS);
  assertEquals(frame.exited, true);
  assertEquals(frame.exitReason, "window-end");
  assertEquals(cam.playback.state.focusedPlayerId, "h1");
  assertEquals(cam.playback.state.currentTick, 4);
});

Deno.test("13.5 victim respawn preempts the window", () => {
  const respawn = makePlayerRespawnedEvent({
    appliedTick: 5,
    player: emptyAuthoritativeRosterSnapshot({ id: "h1", name: "Human" }),
  });
  const { session, collision } = liveCapturedSession({
    ticks: 10,
    extraEvents: new Map([
      [4, [died({ appliedTick: 4, victimId: "h1", killerId: "b1" })]],
      [5, [respawn]],
    ]),
  });
  assertEquals(victimRespawnedInEvents([respawn], "h1"), true);
  const cam = startKillcam(session, { victimId: "h1", deathTick: 4 }, {
    collision,
    preMs: 0,
    postMs: 500,
  });
  let last = cam.frame(TICK_MS);
  while (!last.exited) last = cam.frame(TICK_MS);
  assertEquals(last.exitReason, "victim-respawned");
  assertEquals(cam.playback.state.focusedPlayerId, "h1");
  assertEquals(cam.playback.state.currentTick < cam.window.endTick, true);
});

Deno.test("13.5 skip restores victim; further frames stay exited", () => {
  const { session, collision } = liveCapturedSession({
    ticks: 8,
    extraEvents: new Map([
      [3, [died({ appliedTick: 3, victimId: "h1", killerId: "b1" })]],
    ]),
  });
  const cam = startKillcam(session, { victimId: "h1", deathTick: 3 }, {
    collision,
    preMs: 0,
    postMs: 200,
  });
  cam.skip();
  const again = cam.frame(TICK_MS);
  assertEquals(again.exited, true);
  assertEquals(again.exitReason, "skip");
  assertEquals(cam.playback.state.focusedPlayerId, "h1");
});

// ---------------------------------------------------------------------------
// Raid + source-scan
// ---------------------------------------------------------------------------

Deno.test("13 raid: startKillcam surfaces runner named raid error", () => {
  const { session, collision } = liveCapturedSession({ ticks: 2 });
  const raidMeta = sampleMetadata(session.initialState.init, {
    raidMatch: {
      active: true,
      raidId: "raid-1",
      humanTeam: "A",
      goal: 10,
      maxTimeSeconds: 600,
      respawnMs: 5000,
      initialMap: "replay-killcam",
      expectedHumans: 1,
      startWaitSeconds: 30,
      started: true,
      ended: false,
      wave: 1,
      failReason: null,
    },
  });
  const raidSession: ReplayRunSession = {
    ...session,
    initialState: { ...session.initialState, metadata: raidMeta },
  };
  assertThrows(
    () =>
      startKillcam(raidSession, { victimId: "h1", deathTick: 1 }, {
        collision,
      }),
    ReplayRaidUnsupportedError,
  );
});

Deno.test("13 source-scan: policy module stays pure", async () => {
  const src = await Deno.readTextFile(new URL("./killcam.ts", import.meta.url));
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const banned of [
    "Date.now",
    "performance.now",
    "requestAnimationFrame",
    "setInterval",
    "setTimeout",
    "THREE",
    "document",
    "createReplayPlayback",
    "createReplayRunner",
    "createReplayClock",
    "firstPersonCamera",
    "thirdPersonCamera",
    "freeCamera",
    "resetToCheckpoint",
    "loadCheckpointState",
    "delayedLiveTail",
    "ReplayBlobStore",
    "node:fs",
  ]) {
    assertEquals(code.includes(banned), false, `banned token present: ${banned}`);
  }
});

Deno.test("13 source-scan: driver has no wall-clock / io / checkpoint jump / 12.7 delay", async () => {
  const src = await Deno.readTextFile(
    new URL("./killcamPlayback.ts", import.meta.url),
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
    "delayedLiveTail",
    "DELAYED_LIVE_DELAY_MS",
    "resetToCheckpoint",
    "loadCheckpointState",
    "findPriorOrEqual",
    "CheckpointIndex",
    "freeCamera",
    "interpolateReplayPose",
    "putInputs",
    "putEvents",
    "commitTick",
    "setInit",
    "ReplayBlobStore",
    "node:fs",
    "socket.io",
  ]) {
    assertEquals(code.includes(banned), false, `banned token present: ${banned}`);
  }
  assertEquals(src.includes("createReplayPlayback"), true);
  assertEquals(src.includes("firstPersonCamera"), true);
  assertEquals(src.includes("setFocusedPlayerId"), true);
});
