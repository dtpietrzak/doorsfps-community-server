/**
 * Epic 12.5 — visibility filter.
 *
 * Run from server-community/:
 *   deno test -A replay/spectator_filter_test.ts
 */

import {
  assertEquals,
  assertNotStrictEquals,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { TICK_MS } from "../shared/sim/game.ts";
import {
  buildMatchMetadata,
  type MatchMetadata,
} from "../shared/replay/matchMetadata.ts";
import type {
  AuthoritativeEvent,
  MatchInitEvent,
} from "../shared/sim/authoritativeEvent.ts";
import { PlayerManager } from "../players/PlayerManager.ts";
import type { TickSelectedInput } from "../players/tickAssociation.ts";
import type { DoorsMap } from "../world/map.ts";
import type { PlayerInput, SnapshotPacket } from "../protocol/network.ts";
import { MapCollision } from "../world/MapCollision.ts";
import {
  captureCheckpointState,
  type AuthoritativeCheckpoint,
  type CheckpointPlayerState,
} from "./authoritativeCheckpoint.ts";
import type { RecordedInitialState } from "./recordedInitialState.ts";
import type { RecordedTickInputs } from "./recordedTickInputs.ts";
import {
  __replayTickNowMsForTest,
  createReplayRunner,
  type ReplayRunSession,
} from "./replaySimulationRunner.ts";
import {
  createReplayPlayback,
  type ReplayPlayback,
} from "./replayPlaybackSession.ts";
import {
  createSpectatorState,
  selectFocusedPlayer,
  type SpectatorVisibilityFilter,
} from "./spectatorSelection.ts";
import {
  applyVisibilityFilter,
  isSpectatorVisibilityFilter,
  setVisibilityFilter,
  SPECTATOR_FILTER_BLUE_TEAM_ID,
  SPECTATOR_FILTER_RED_TEAM_ID,
  SPECTATOR_VISIBILITY_FILTERS,
  SpectatorFilterError,
  type SpectatorFilterErrorCode,
} from "./spectatorFilter.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const miniMap: DoorsMap = {
  name: "replay-filter",
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
      runtimeMatchId: "rt-filter-1",
      serverName: "filter-test",
      serverId: "srv-filter",
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
  const seed = opts?.seed ?? 0xf11e;
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
  const metadata = sampleMetadata(initRaw);
  const initialState: RecordedInitialState = {
    runtimeMatchId: metadata.runtimeMatchId,
    captureTick,
    init: initRaw,
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

function playerRow(
  overrides: Partial<CheckpointPlayerState> & Pick<CheckpointPlayerState, "id">,
): CheckpointPlayerState {
  return {
    team: "A",
    isBot: false,
    isAgent: false,
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    pitch: 0,
    velocityX: 0,
    velocityY: 0,
    velocityZ: 0,
    onGround: true,
    crouch: false,
    sprintStamina: 3,
    slideRemaining: 0,
    slideDirX: 0,
    slideDirZ: 0,
    slideForceCrouch: false,
    prevInputCrouch: false,
    lastLandedAtTick: null,
    poseHistory: [],
    health: 100,
    maxHealth: 100,
    alive: true,
    spawnedAtTick: 0,
    diedAtTick: null,
    enemyDoorSinceTick: null,
    hitSlowStacks: 0,
    hitSlowEndsAtTick: 0,
    weaponId: 0,
    weaponLoadouts: [
      { weaponId: 0, ammoInMag: 12, spareClips: 3 },
      { weaponId: 1, ammoInMag: 30, spareClips: 2 },
    ],
    reloadEndsAtTick: null,
    weaponSwitchEndsAtTick: null,
    lastShotAtTick: null,
    lastMeleeAtTick: null,
    pausedReloadRemainingTicks: {},
    unlimitedAmmo: false,
    abilityEndsAtTick: {},
    abilityFxOrigin: {},
    abilitySpent: {},
    abilityGlobalLockEndsAtTick: null,
    abilityBarRegenEndsAtTick: null,
    abilityDoorRegenEndsAtTick: null,
    abilityNoSpendOnEnd: {},
    equipment: {
      head: 0,
      visor: 0,
      shoulder: 0,
      body: 0,
      leg: 0,
      hue: 0,
      gunHue: 0,
      bulletHue: 0,
      crosshairColor: -1,
      nameHue: 0,
      scope: 0,
      pistol: 0,
      rifle: 0,
      shotgun: 0,
      crosshair: 0,
    },
    skillLoadout: null,
    ownedAbilities: null,
    score: 0,
    kills: 0,
    deaths: 0,
    xp: 0,
    ...overrides,
  };
}

/** Mixed A/B, agents on both teams, isBot ≠ isAgent in both directions. */
const MIXED: readonly CheckpointPlayerState[] = [
  playerRow({ id: "b-human", team: "B", isAgent: false, isBot: false }),
  playerRow({ id: "a-agent", team: "A", isAgent: true, isBot: false }),
  playerRow({ id: "a-bot", team: "A", isAgent: false, isBot: true }),
  playerRow({ id: "b-agent", team: "B", isAgent: true, isBot: false }),
  playerRow({ id: "a-human", team: "A", isAgent: false, isBot: false }),
  playerRow({ id: "a-both", team: "A", isAgent: true, isBot: true }),
];

function assertFilterCode(
  fn: () => unknown,
  code: SpectatorFilterErrorCode,
): SpectatorFilterError {
  const err = assertThrows(fn, SpectatorFilterError);
  assertEquals(err.code, code);
  return err;
}

function idsOf(
  roster: readonly CheckpointPlayerState[],
): readonly string[] {
  return roster.map((row) => row.id);
}

function assertSubset(
  roster: readonly CheckpointPlayerState[],
  filter: SpectatorVisibilityFilter,
  expectedIds: readonly string[],
): readonly CheckpointPlayerState[] {
  const subset = applyVisibilityFilter(roster, filter);
  assertEquals(idsOf(subset), expectedIds);
  assertEquals(Object.isFrozen(subset), true);
  assertNotStrictEquals(subset, roster);
  for (let i = 0; i < subset.length; i++) {
    const src = roster.find((row) => row.id === subset[i].id);
    assertEquals(src !== undefined, true, `missing source row ${subset[i].id}`);
    assertStrictEquals(subset[i], src);
  }
  return subset;
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

function outcomeDigest(
  session: ReplayRunSession,
  collision: MapCollision,
  observe?: (tick: number, players: readonly CheckpointPlayerState[]) => void,
): string[] {
  const runner = createReplayRunner(session, { collision });
  runner.resetToInitial();
  const digest: string[] = [];
  for (let tick = session.firstTick; tick <= session.lastTick; tick++) {
    const out = runner.step(tick);
    if (observe) {
      const cp = captureCheckpointState(
        runner.simulation,
        tick,
        session.initialState.runtimeMatchId,
      );
      observe(tick, cp.players);
    }
    digest.push(JSON.stringify({
      tick: out.tick,
      scores: out.scores,
      roster: out.rosterDigest,
      deaths: out.overlapDeaths.length,
      respawned: out.respawnedIds,
      gameOver: out.gameOver,
    }));
  }
  return digest;
}

const FILTERS: readonly SpectatorVisibilityFilter[] = [
  "all",
  "red",
  "blue",
  "agents",
];

// ---------------------------------------------------------------------------
// Pins / HUD mapping
// ---------------------------------------------------------------------------

Deno.test("12.5 pins: vocabulary, HUD A=Blue / B=Red, default all", () => {
  assertEquals(SPECTATOR_VISIBILITY_FILTERS, ["all", "red", "blue", "agents"]);
  assertEquals(SPECTATOR_FILTER_BLUE_TEAM_ID, "A");
  assertEquals(SPECTATOR_FILTER_RED_TEAM_ID, "B");
  assertEquals(isSpectatorVisibilityFilter("all"), true);
  assertEquals(isSpectatorVisibilityFilter("red"), true);
  assertEquals(isSpectatorVisibilityFilter("blue"), true);
  assertEquals(isSpectatorVisibilityFilter("agents"), true);
  assertEquals(isSpectatorVisibilityFilter("Red"), false);
  assertEquals(isSpectatorVisibilityFilter("player:h1"), false);
  assertEquals(isSpectatorVisibilityFilter(""), false);
  const state = createSpectatorState();
  assertEquals(state.visibilityFilter, "all");
});

// ---------------------------------------------------------------------------
// Subset exactness
// ---------------------------------------------------------------------------

Deno.test("12.5 subset: mixed roster exact ids, order, same-refs", () => {
  assertSubset(MIXED, "all", [
    "b-human",
    "a-agent",
    "a-bot",
    "b-agent",
    "a-human",
    "a-both",
  ]);
  assertSubset(MIXED, "red", ["b-human", "b-agent"]);
  assertSubset(MIXED, "blue", ["a-agent", "a-bot", "a-human", "a-both"]);
  assertSubset(MIXED, "agents", ["a-agent", "b-agent", "a-both"]);
});

Deno.test("12.5 isAgent-not-isBot: agents follow isAgent exactly", () => {
  const agents = applyVisibilityFilter(MIXED, "agents");
  assertEquals(agents.every((row) => row.isAgent === true), true);
  assertEquals(agents.some((row) => row.isBot === false), true);
  assertEquals(agents.some((row) => row.isBot === true), true);
  assertEquals(idsOf(agents).includes("a-bot"), false);
  assertEquals(idsOf(applyVisibilityFilter(MIXED, "blue")).includes("a-bot"), true);
});

Deno.test("12.5 single-team roster: opposite color is explicit-empty", () => {
  const onlyA = MIXED.filter((row) => row.team === "A");
  assertSubset(onlyA, "blue", ["a-agent", "a-bot", "a-human", "a-both"]);
  assertSubset(onlyA, "red", []);
  const onlyB = MIXED.filter((row) => row.team === "B");
  assertSubset(onlyB, "red", ["b-human", "b-agent"]);
  assertSubset(onlyB, "blue", []);
});

Deno.test("12.5 malformed team does not match red or blue", () => {
  const weird = playerRow({
    id: "x",
    team: "C" as CheckpointPlayerState["team"],
    isAgent: false,
  });
  assertSubset([weird], "red", []);
  assertSubset([weird], "blue", []);
  assertSubset([weird], "all", ["x"]);
});

// ---------------------------------------------------------------------------
// Loud values / explicit-empty
// ---------------------------------------------------------------------------

Deno.test("12.5 unknown filter is loud from both functions; input untouched", () => {
  const state = createSpectatorState({
    focusedPlayerId: "a-human",
    cameraMode: "free",
    visibilityFilter: "all",
  });
  const unknowns = ["Red", "ALL", "player:h1", "", "A", "B", "agent"];
  for (const value of unknowns) {
    const filter = value as SpectatorVisibilityFilter;
    const err = assertFilterCode(
      () => applyVisibilityFilter(MIXED, filter),
      "replay-spectator-filter-unknown",
    );
    assertEquals(err.detail, value);
    const setErr = assertFilterCode(
      () => setVisibilityFilter(state, filter),
      "replay-spectator-filter-unknown",
    );
    assertEquals(setErr.detail, value);
  }
  assertEquals(idsOf(MIXED).length, 6);
  assertEquals(state.visibilityFilter, "all");
  assertEquals(state.focusedPlayerId, "a-human");
  assertEquals(state.cameraMode, "free");
});

Deno.test("12.5 explicit-empty: no match and empty roster return []", () => {
  const noAgents = MIXED.filter((row) => row.isAgent !== true);
  const emptyAgents = applyVisibilityFilter(noAgents, "agents");
  assertEquals(idsOf(emptyAgents), []);
  assertEquals(Object.isFrozen(emptyAgents), true);
  const emptyAll = applyVisibilityFilter([], "all");
  const emptyRed = applyVisibilityFilter([], "red");
  const emptyBlue = applyVisibilityFilter([], "blue");
  const emptyAgents2 = applyVisibilityFilter([], "agents");
  assertEquals(idsOf(emptyAll), []);
  assertEquals(idsOf(emptyRed), []);
  assertEquals(idsOf(emptyBlue), []);
  assertEquals(idsOf(emptyAgents2), []);
  assertNotStrictEquals(emptyAll, emptyRed);
});

// ---------------------------------------------------------------------------
// Setter / focus ⊥ filter
// ---------------------------------------------------------------------------

Deno.test("12.5 setVisibilityFilter copies focus and cameraMode", () => {
  const state = createSpectatorState({
    focusedPlayerId: "b-human",
    cameraMode: "third-person",
    visibilityFilter: "all",
  });
  for (const filter of FILTERS) {
    const next = setVisibilityFilter(state, filter);
    assertEquals(next.visibilityFilter, filter);
    assertEquals(next.focusedPlayerId, "b-human");
    assertEquals(next.cameraMode, "third-person");
    assertEquals(Object.isFrozen(next), true);
    assertEquals(state.visibilityFilter, "all");
  }
});

Deno.test("12.5 focus⊥filter: 12.1 select never writes the filter field", () => {
  const filtered = setVisibilityFilter(
    createSpectatorState({ visibilityFilter: "all" }),
    "red",
  );
  const focused = selectFocusedPlayer(filtered, "a-human", [
    "a-human",
    "b-human",
  ]);
  assertEquals(focused.focusedPlayerId, "a-human");
  assertEquals(focused.visibilityFilter, "red");
});

Deno.test("12.5 focus⊥filter: Blue focus + red filter; feed still Blue", () => {
  const { session, collision } = liveCapturedSession({ ticks: 4 });
  const playback = createReplayPlayback(session, {
    collision,
    focusedPlayerId: "h1",
  });
  playback.start();
  assertFeedMatchesFocus(playback, "h1");
  playback.frame(TICK_MS);
  assertEquals(playback.state.focusedPlayerId, "h1");
  assertEquals(
    playback.feeders.state()?.players.some((p) => p.id === "h1"),
    true,
  );

  const spectator = setVisibilityFilter(
    createSpectatorState({
      focusedPlayerId: "h1",
      visibilityFilter: "all",
    }),
    "red",
  );
  assertEquals(spectator.focusedPlayerId, "h1");
  assertEquals(spectator.visibilityFilter, "red");

  const roster = session.checkpointFrameAt?.(session.firstTick)?.players;
  if (!roster) throw new Error("missing first-tick checkpoint");
  const h1 = roster.find((row) => row.id === "h1");
  const b1 = roster.find((row) => row.id === "b1");
  assertEquals(h1?.team, SPECTATOR_FILTER_BLUE_TEAM_ID);
  assertEquals(b1?.team, SPECTATOR_FILTER_RED_TEAM_ID);
  assertSubset(roster, "red", ["b1"]);
  assertSubset(roster, "blue", ["h1"]);
  assertEquals(playback.state.focusedPlayerId, "h1");
});

Deno.test("12.5 end-hold: final checkpoint subset is stable", () => {
  const { session, collision } = liveCapturedSession({ ticks: 4 });
  const playback = createReplayPlayback(session, {
    collision,
    focusedPlayerId: "h1",
  });
  playback.start();
  while (!playback.state.isEnded) playback.frame(TICK_MS);
  assertEquals(playback.state.isEnded, true);
  const last = session.checkpointFrameAt?.(session.lastTick)?.players;
  if (!last) throw new Error("missing last-tick checkpoint");
  const a = applyVisibilityFilter(last, "red");
  const b = applyVisibilityFilter(last, "red");
  assertEquals(idsOf(a), idsOf(b));
  assertEquals(idsOf(a), ["b1"]);
  assertSubset(last, "blue", ["h1"]);
  assertSubset(last, "all", ["h1", "b1"]);
});

// ---------------------------------------------------------------------------
// Sim-untouched / non-interference
// ---------------------------------------------------------------------------

Deno.test("12.5 sim-untouched: per-tick filter vs never-filtered", () => {
  const ticks = 6;
  const observed = liveCapturedSession({ ticks, seed: 0x51e5 });
  const control = liveCapturedSession({ ticks, seed: 0x51e5 });
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
  let spectator = createSpectatorState({
    focusedPlayerId: "h1",
    visibilityFilter: "all",
  });
  for (let i = 0; i < ticks; i++) {
    watching.frame(TICK_MS);
    quiet.frame(TICK_MS);
    if (i % 2 === 0) watching.setFocusedPlayerId("b1");
    else watching.setFocusedPlayerId("h1");
    spectator = setVisibilityFilter(spectator, FILTERS[i % FILTERS.length]);
    applyVisibilityFilter(MIXED, spectator.visibilityFilter);
    watched.push(snapshotFingerprint(watching.feeders.state()));
    untouched.push(snapshotFingerprint(quiet.feeders.state()));
  }
  assertEquals(watched, untouched);

  const digest = outcomeDigest(
    control.session,
    makeCollision(),
  );
  const digestObserved = outcomeDigest(
    observed.session,
    makeCollision(),
    (tick, players) => {
      applyVisibilityFilter(players, FILTERS[(tick - 1) % FILTERS.length]);
    },
  );
  assertEquals(digest, digestObserved);
});

Deno.test("12.5 shifted-wall-clock: identical subset and state", () => {
  const a = applyVisibilityFilter(MIXED, "agents");
  const b = applyVisibilityFilter(MIXED, "agents");
  assertEquals(idsOf(a), idsOf(b));
  const s0 = createSpectatorState({ focusedPlayerId: "x", cameraMode: "free" });
  assertEquals(setVisibilityFilter(s0, "blue"), setVisibilityFilter(s0, "blue"));
});

// ---------------------------------------------------------------------------
// Purity / isolation / containment
// ---------------------------------------------------------------------------

Deno.test("12.5 source-scan: pure module has no THREE/DOM/clock/sim/io", async () => {
  const src = await Deno.readTextFile(
    new URL("./spectatorFilter.ts", import.meta.url),
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
    "window",
    "keyboard",
    "ReplayPlayback",
    "createReplayPlayback",
    "replayPlaybackSession",
    "runner.step",
    "PlayerManager",
    "BotManager",
    "GameServer",
    "MapCollision",
    "interpolateReplayPose",
    "projectReplayRenderFeed",
    "CameraPose",
    "firstPersonCamera",
    "selectFocusedPlayer",
    "Deno.",
    "node:fs",
    "ReplayBlobStore",
    "createStore",
    'from "../net/',
    'from "./net/',
    "socket.io",
  ]) {
    assertEquals(code.includes(banned), false, `banned token present: ${banned}`);
  }
  assertEquals(src.includes("applyVisibilityFilter"), true);
  assertEquals(src.includes("setVisibilityFilter"), true);
  assertEquals(src.includes("isSpectatorVisibilityFilter"), true);
});

Deno.test("12.5 containment: filter vocabulary does not leak into sim layers", async () => {
  const files = [
    "authoritativeCheckpoint.ts",
    "replaySimulationRunner.ts",
    "replayPlaybackSession.ts",
    "replayStateAccess.ts",
    "spectatorSelection.ts",
    "spectatorCamera.ts",
  ];
  for (const name of files) {
    const src = await Deno.readTextFile(new URL(`./${name}`, import.meta.url));
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assertEquals(
      code.includes('team === "red"'),
      false,
      `${name} compares team to red`,
    );
    assertEquals(
      code.includes('team === "blue"'),
      false,
      `${name} compares team to blue`,
    );
    assertEquals(
      code.includes("SPECTATOR_FILTER_RED_TEAM_ID"),
      false,
      `${name} imported filter mapping`,
    );
    assertEquals(
      code.includes("SPECTATOR_FILTER_BLUE_TEAM_ID"),
      false,
      `${name} imported filter mapping`,
    );
  }
});

Deno.test("12.5 12.1 purity scan still bans applyVisibilityFilter in selection", async () => {
  const src = await Deno.readTextFile(
    new URL("./spectatorSelection.ts", import.meta.url),
  );
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assertEquals(code.includes("applyVisibilityFilter"), false);
  assertEquals(code.includes("setVisibilityFilter"), false);
});
