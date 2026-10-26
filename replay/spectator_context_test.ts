/**
 * Epic 12.6 — spectator context.
 *
 * Run from server-community/:
 *   deno test -A replay/spectator_context_test.ts
 */

import {
  assertEquals,
  assertNotEquals,
  assertNotStrictEquals,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import type {
  AuthoritativeEvent,
  MatchInitEvent,
} from "../shared/sim/authoritativeEvent.ts";
import { TICK_MS } from "../shared/sim/game.ts";
import {
  buildMatchMetadata,
  type MatchMetadata,
} from "../shared/replay/matchMetadata.ts";
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
import { tickToTimeMs } from "./checkpointIndex.ts";
import type { RecordedInitialState } from "./recordedInitialState.ts";
import type { RecordedTickInputs } from "./recordedTickInputs.ts";
import {
  activityForPlayer,
  markersAt,
  REPLAY_INDEX_VERSION,
  type ReplayIndex,
  type ReplayIndexMarker,
  type ReplayIndexPlayerSpan,
} from "./replayIndex.ts";
import {
  __replayTickNowMsForTest,
  createReplayRunner,
  type ReplayRunSession,
} from "./replaySimulationRunner.ts";
import { createReplayPlayback } from "./replayPlaybackSession.ts";
import type { ReplayViewState } from "./replayStateAccess.ts";
import {
  applyVisibilityFilter,
  SpectatorFilterError,
  SPECTATOR_VISIBILITY_FILTERS,
} from "./spectatorFilter.ts";
import type { SpectatorVisibilityFilter } from "./spectatorSelection.ts";
import {
  projectSpectatorContext,
  SPECTATOR_PRESENCE_NOTE,
  type SpectatorContext,
  type SpectatorTeamRow,
} from "./spectatorContext.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const miniMap: DoorsMap = {
  name: "replay-context",
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
      runtimeMatchId: "rt-context-1",
      serverName: "context-test",
      serverId: "srv-context",
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
  const seed = opts?.seed ?? 0xc0a1;
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

function view(
  overrides: Partial<ReplayViewState> & {
    players?: readonly CheckpointPlayerState[];
  } = {},
): ReplayViewState {
  return {
    tick: 10,
    players: overrides.players ?? [playerRow({ id: "h1" })],
    scores: { A: 1, B: 2 },
    phase: "live",
    doorsOpen: true,
    doorChangeTick: 100,
    matchEndTick: 1000,
    projectiles: [],
    ...overrides,
  };
}

function emptyIndex(over?: Partial<ReplayIndex>): ReplayIndex {
  return {
    indexVersion: REPLAY_INDEX_VERSION,
    checkpoints: [],
    markers: [],
    phases: [],
    playerActivity: [],
    ...over,
  };
}

function marker(
  over: Partial<ReplayIndexMarker> & Pick<ReplayIndexMarker, "tick">,
): ReplayIndexMarker {
  return {
    markerKind: "death",
    eventKind: "playerDied",
    involvedPlayerIds: ["h1"],
    ...over,
  };
}

function span(
  over: Partial<ReplayIndexPlayerSpan> & Pick<ReplayIndexPlayerSpan, "playerId">,
): ReplayIndexPlayerSpan {
  return {
    firstTick: 1,
    lastTick: 40,
    ticksPresent: 30,
    ...over,
  };
}

const MIXED: readonly CheckpointPlayerState[] = [
  playerRow({ id: "b-human", team: "B", isAgent: false, isBot: false }),
  playerRow({ id: "a-agent", team: "A", isAgent: true, isBot: false }),
  playerRow({ id: "a-bot", team: "A", isAgent: false, isBot: true }),
  playerRow({ id: "b-agent", team: "B", isAgent: true, isBot: false, alive: false }),
  playerRow({ id: "a-human", team: "A", isAgent: false, isBot: false }),
  playerRow({ id: "a-both", team: "A", isAgent: true, isBot: true }),
];

const NAMES: ReadonlyMap<string, string> = new Map([
  ["h1", "Human"],
  ["b1", "BotOne"],
  ["b-human", "RedHuman"],
  ["a-agent", "BlueAgent"],
  ["a-bot", "BlueBot"],
  ["b-agent", "RedAgent"],
  ["a-human", "BlueHuman"],
  ["a-both", "BlueBoth"],
  ["gone", "Departed"],
]);

function project(
  v: ReplayViewState | null,
  opts?: {
    index?: ReplayIndex;
    focusedPlayerId?: string | null;
    filter?: SpectatorVisibilityFilter;
    rosterNames?: ReadonlyMap<string, string>;
  },
): SpectatorContext | null {
  return projectSpectatorContext(
    v,
    opts?.index ?? emptyIndex(),
    opts?.focusedPlayerId === undefined ? "h1" : opts.focusedPlayerId,
    opts?.filter ?? "all",
    opts?.rosterNames ?? NAMES,
  );
}

function idsOf(rows: readonly SpectatorTeamRow[]): readonly string[] {
  return rows.map((row) => row.id);
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

function viewFromRunner(
  session: ReplayRunSession,
  collision: MapCollision,
): ReplayViewState {
  const runner = createReplayRunner(session, { collision });
  runner.resetToInitial();
  for (let tick = session.firstTick; tick <= session.lastTick; tick++) {
    runner.step(tick);
  }
  const sim = runner.simulation;
  const tick = runner.currentTick;
  const checkpoint = captureCheckpointState(
    sim,
    tick,
    session.initialState.runtimeMatchId,
  );
  const doors = sim.getDoorCycleState(tick);
  return {
    tick,
    players: checkpoint.players,
    scores: { ...sim.getScores() },
    phase: sim.getMatchPhase(),
    doorsOpen: doors.doorsOpen,
    doorChangeTick: doors.doorChangeTick,
    matchEndTick: checkpoint.match.matchEndTick,
    projectiles: checkpoint.projectiles,
  };
}

// ---------------------------------------------------------------------------
// Pins / provenance
// ---------------------------------------------------------------------------

Deno.test("12.6 pins: presence-note templates and null-view feeder shape", () => {
  assertEquals(SPECTATOR_PRESENCE_NOTE.present, "{name}");
  assertEquals(SPECTATOR_PRESENCE_NOTE.eliminated, "{name} — eliminated");
  assertEquals(SPECTATOR_PRESENCE_NOTE.absent, "{name-or-id} — absent");
  assertEquals(SPECTATOR_PRESENCE_NOTE.empty, "No players in view");
  assertEquals(project(null), null);
});

Deno.test("12.6 provenance: time/scores/phase/doors equal recorded sources", () => {
  const v = view({
    tick: 24,
    scores: { A: 7, B: 3 },
    phase: "intermission",
    doorsOpen: false,
    doorChangeTick: 18,
  });
  const ctx = project(v, { focusedPlayerId: null })!;
  assertEquals(ctx.replayTimeMs, tickToTimeMs(24));
  assertEquals(ctx.replayTimeMs, 24 * TICK_MS);
  assertEquals(ctx.scores, { A: 7, B: 3 });
  assertNotStrictEquals(ctx.scores, v.scores);
  assertEquals(ctx.phase, "intermission");
  assertEquals(ctx.doors, { open: false, changeTick: 18 });
  assertEquals(ctx.focus, null);
  assertEquals(Object.isFrozen(ctx), true);
  assertEquals(Object.isFrozen(ctx.scores), true);
  assertEquals(Object.isFrozen(ctx.doors), true);
  assertEquals(Object.isFrozen(ctx.teams), true);
});

Deno.test("12.6 provenance: replayTimeMs at tick 0 and match-end tick", () => {
  assertEquals(project(view({ tick: 0 }), { focusedPlayerId: null })!.replayTimeMs, 0);
  assertEquals(
    project(view({ tick: 1800 }), { focusedPlayerId: null })!.replayTimeMs,
    tickToTimeMs(1800),
  );
});

Deno.test("12.6 provenance: team rows match 12.5 subset ids/order/names", () => {
  const v = view({ players: MIXED });
  for (const filter of SPECTATOR_VISIBILITY_FILTERS) {
    const ctx = project(v, { filter, focusedPlayerId: null })!;
    const visible = applyVisibilityFilter(MIXED, filter);
    const red = applyVisibilityFilter(visible, "red");
    const blue = applyVisibilityFilter(visible, "blue");
    assertEquals(idsOf(ctx.teams.red), red.map((row) => row.id));
    assertEquals(idsOf(ctx.teams.blue), blue.map((row) => row.id));
    for (const row of [...ctx.teams.red, ...ctx.teams.blue]) {
      assertEquals(row.name, NAMES.get(row.id) ?? row.id);
      assertEquals(row.team === "red" || row.team === "blue", true);
    }
  }
});

Deno.test("12.6 provenance: markers/activity are identical selector refs", () => {
  const now = marker({ tick: 10, involvedPlayerIds: ["h1"] });
  const alsoNow = marker({
    tick: 10,
    markerKind: "phaseChange",
    eventKind: "matchStart",
    involvedPlayerIds: [],
  });
  const later = marker({ tick: 11, involvedPlayerIds: ["b1"] });
  const hSpan = span({ playerId: "h1", firstTick: 1, lastTick: 12 });
  const bSpan = span({ playerId: "b1" });
  const index = emptyIndex({
    markers: [now, later, alsoNow],
    playerActivity: [hSpan, bSpan],
  });
  const ctx = project(view({ tick: 10, players: MIXED }), {
    index,
    focusedPlayerId: "h1",
  })!;
  const direct = markersAt(index, 10);
  assertEquals(ctx.markers.length, 2);
  assertStrictEquals(ctx.markers[0], now);
  assertStrictEquals(ctx.markers[1], alsoNow);
  assertStrictEquals(ctx.markers[0], direct[0]);
  assertStrictEquals(ctx.markers[1], direct[1]);
  assertStrictEquals(ctx.focusActivity, hSpan);
  assertStrictEquals(ctx.focusActivity, activityForPlayer(index, "h1"));
});

Deno.test("12.6 names: listed lookup, unlisted raw id, empty-string verbatim", () => {
  const names = new Map<string, string>([
    ["h1", "Human"],
    ["blank", ""],
  ]);
  const v = view({
    players: [
      playerRow({ id: "h1" }),
      playerRow({ id: "blank", team: "B" }),
      playerRow({ id: "mystery", team: "B" }),
    ],
  });
  const ctx = project(v, { focusedPlayerId: "mystery", rosterNames: names })!;
  assertEquals(ctx.teams.blue[0].name, "Human");
  assertEquals(ctx.teams.red.find((r) => r.id === "blank")?.name, "");
  assertEquals(ctx.teams.red.find((r) => r.id === "mystery")?.name, "mystery");
  assertEquals(ctx.focus?.nameplate, "mystery");
});

// ---------------------------------------------------------------------------
// Presence / null / empty
// ---------------------------------------------------------------------------

Deno.test("12.6 presence: alive present, dead eliminated, missing absent", () => {
  const v = view({
    players: [
      playerRow({ id: "h1", alive: true }),
      playerRow({ id: "b1", team: "B", alive: false }),
    ],
  });
  const present = project(v, { focusedPlayerId: "h1" })!;
  assertEquals(present.focus, { nameplate: "Human", presence: "present" });
  const dead = project(v, { focusedPlayerId: "b1" })!;
  assertEquals(dead.focus, { nameplate: "BotOne", presence: "eliminated" });
  assertEquals(dead.teams.red[0].presence, "eliminated");
  const missing = project(v, { focusedPlayerId: "gone" })!;
  assertEquals(missing.focus, { nameplate: "Departed", presence: "absent" });
  const unlisted = project(v, { focusedPlayerId: "never-seen" })!;
  assertEquals(unlisted.focus, { nameplate: "never-seen", presence: "absent" });
  assertNotEquals(unlisted, null);
});

Deno.test("12.6 null focus: focus facts null, teams and markers intact", () => {
  const now = marker({ tick: 10 });
  const ctx = project(view({ players: MIXED }), {
    focusedPlayerId: null,
    index: emptyIndex({ markers: [now] }),
  })!;
  assertEquals(ctx.focus, null);
  assertEquals(ctx.focusActivity, null);
  assertEquals(ctx.teams.blue.length > 0, true);
  assertEquals(ctx.teams.red.length > 0, true);
  assertStrictEquals(ctx.markers[0], now);
});

Deno.test("12.6 empty players: empty team rows, other facts intact", () => {
  const ctx = project(view({
    players: [],
    scores: { A: 4, B: 5 },
    phase: "prematch",
    doorsOpen: true,
    doorChangeTick: 0,
    tick: 3,
  }), { focusedPlayerId: null })!;
  assertEquals(ctx.teams.red, []);
  assertEquals(ctx.teams.blue, []);
  assertEquals(ctx.scores, { A: 4, B: 5 });
  assertEquals(ctx.phase, "prematch");
  assertEquals(ctx.doors, { open: true, changeTick: 0 });
  assertEquals(ctx.replayTimeMs, tickToTimeMs(3));
});

Deno.test("12.6 empty index: empty markers, missing activity span is null", () => {
  const ctx = project(view({ players: MIXED }), { focusedPlayerId: "h1" })!;
  assertEquals(ctx.markers, []);
  assertEquals(ctx.focusActivity, null);
});

Deno.test("12.6 unknown filter surfaces 12.5 named error; no context invented", () => {
  const err = assertThrows(
    () =>
      projectSpectatorContext(
        view(),
        emptyIndex(),
        "h1",
        "Red" as SpectatorVisibilityFilter,
        NAMES,
      ),
    SpectatorFilterError,
  );
  assertEquals(err.code, "replay-spectator-filter-unknown");
});

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

Deno.test("12.6 filter: each value matches direct 12.5 subset; isAgent not isBot", () => {
  const v = view({ players: MIXED });
  const all = project(v, { filter: "all", focusedPlayerId: null })!;
  assertEquals(idsOf(all.teams.blue), ["a-agent", "a-bot", "a-human", "a-both"]);
  assertEquals(idsOf(all.teams.red), ["b-human", "b-agent"]);

  const red = project(v, { filter: "red", focusedPlayerId: null })!;
  assertEquals(idsOf(red.teams.red), ["b-human", "b-agent"]);
  assertEquals(red.teams.blue, []);

  const blue = project(v, { filter: "blue", focusedPlayerId: null })!;
  assertEquals(idsOf(blue.teams.blue), ["a-agent", "a-bot", "a-human", "a-both"]);
  assertEquals(blue.teams.red, []);

  const agents = project(v, { filter: "agents", focusedPlayerId: null })!;
  assertEquals(idsOf(agents.teams.blue), ["a-agent", "a-both"]);
  assertEquals(idsOf(agents.teams.red), ["b-agent"]);
  assertEquals(idsOf(agents.teams.blue).includes("a-bot"), false);
});

Deno.test("12.6 filter: Blue focus + red filter keeps Blue focus facts", () => {
  const v = view({
    players: [
      playerRow({ id: "h1", team: "A" }),
      playerRow({ id: "b1", team: "B" }),
    ],
  });
  const ctx = project(v, { filter: "red", focusedPlayerId: "h1" })!;
  assertEquals(ctx.focus, { nameplate: "Human", presence: "present" });
  assertEquals(idsOf(ctx.teams.red), ["b1"]);
  assertEquals(ctx.teams.blue, []);
});

Deno.test("12.6 filter: markers are not subsetted by visibility", () => {
  const blueDeath = marker({
    tick: 10,
    involvedPlayerIds: ["h1"],
  });
  const v = view({
    players: [
      playerRow({ id: "h1", team: "A" }),
      playerRow({ id: "b1", team: "B" }),
    ],
  });
  const ctx = project(v, {
    filter: "red",
    focusedPlayerId: "h1",
    index: emptyIndex({ markers: [blueDeath] }),
  })!;
  assertEquals(idsOf(ctx.teams.red), ["b1"]);
  assertStrictEquals(ctx.markers[0], blueDeath);
});

Deno.test("12.6 malformed TeamId in all is omitted from both groups", () => {
  const weird = playerRow({
    id: "x1",
    team: "C" as CheckpointPlayerState["team"],
  });
  const ctx = project(
    view({ players: [playerRow({ id: "h1" }), weird] }),
    { focusedPlayerId: null },
  )!;
  assertEquals(idsOf(ctx.teams.blue), ["h1"]);
  assertEquals(ctx.teams.red, []);
});

// ---------------------------------------------------------------------------
// Transitions / purity
// ---------------------------------------------------------------------------

Deno.test("12.6 transitions: focus switch and filter change re-derive immediately", () => {
  const v = view({
    players: [
      playerRow({ id: "h1", team: "A" }),
      playerRow({ id: "b1", team: "B", alive: false }),
    ],
  });
  const a = project(v, { focusedPlayerId: "h1", filter: "all" })!;
  const b = project(v, { focusedPlayerId: "b1", filter: "all" })!;
  assertEquals(a.focus?.nameplate, "Human");
  assertEquals(b.focus?.presence, "eliminated");
  const filtered = project(v, { focusedPlayerId: "h1", filter: "red" })!;
  assertEquals(filtered.focus, a.focus);
  assertEquals(filtered.teams.blue, []);
  assertEquals(idsOf(filtered.teams.red), ["b1"]);
});

Deno.test("12.6 stateless: repeated calls on the same view return identical facts", () => {
  const v = view({ players: MIXED, tick: 40 });
  const index = emptyIndex({
    markers: [marker({ tick: 40 })],
    playerActivity: [span({ playerId: "a-human" })],
  });
  const a = project(v, { index, focusedPlayerId: "a-human", filter: "agents" })!;
  const b = project(v, { index, focusedPlayerId: "a-human", filter: "agents" })!;
  assertEquals(JSON.stringify(a), JSON.stringify(b));
});

Deno.test("12.6 scores copy is independent of later view mutation", () => {
  const scores = { A: 1, B: 2 };
  const v = view({ scores });
  const ctx = project(v, { focusedPlayerId: null })!;
  scores.A = 99;
  assertEquals(ctx.scores.A, 1);
});

Deno.test("12.6 end-hold: runner final view shapes identically on repeat", () => {
  const { session, collision } = liveCapturedSession({ ticks: 4 });
  const finalView = viewFromRunner(session, collision);
  const names = new Map<string, string>([
    ["h1", "Human"],
    ["b1", "BotOne"],
  ]);
  const a = projectSpectatorContext(
    finalView,
    emptyIndex(),
    "h1",
    "all",
    names,
  )!;
  const b = projectSpectatorContext(
    finalView,
    emptyIndex(),
    "h1",
    "all",
    names,
  )!;
  assertEquals(JSON.stringify(a), JSON.stringify(b));
  assertEquals(a.replayTimeMs, tickToTimeMs(finalView.tick));
  assertEquals(a.scores, finalView.scores);
  assertEquals(a.phase, finalView.phase);
  assertEquals(a.doors.open, finalView.doorsOpen);
  assertEquals(a.doors.changeTick, finalView.doorChangeTick);
  assertEquals(a.focus?.nameplate, "Human");
});

Deno.test("12.6 sim-untouched: per-tick context vs never-observed", () => {
  const ticks = 6;
  const observed = liveCapturedSession({ ticks, seed: 0x51c6 });
  const control = liveCapturedSession({ ticks, seed: 0x51c6 });
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

  const names = new Map<string, string>([
    ["h1", "Human"],
    ["b1", "BotOne"],
  ]);
  const watched: string[] = [];
  const untouched: string[] = [];
  for (let i = 0; i < ticks; i++) {
    watching.frame(TICK_MS);
    quiet.frame(TICK_MS);
    if (i % 2 === 0) watching.setFocusedPlayerId("b1");
    else watching.setFocusedPlayerId("h1");
    const v = view({
      tick: i + 1,
      players: MIXED,
      scores: { A: 0, B: 0 },
    });
    projectSpectatorContext(
      v,
      emptyIndex(),
      watching.state.focusedPlayerId,
      SPECTATOR_VISIBILITY_FILTERS[i % SPECTATOR_VISIBILITY_FILTERS.length],
      names,
    );
    watched.push(snapshotFingerprint(watching.feeders.state()));
    untouched.push(snapshotFingerprint(quiet.feeders.state()));
  }
  assertEquals(watched, untouched);

  const digest = outcomeDigest(control.session, makeCollision());
  const digestObserved = outcomeDigest(
    observed.session,
    makeCollision(),
    (tick, players) => {
      projectSpectatorContext(
        view({ tick, players }),
        emptyIndex(),
        "h1",
        SPECTATOR_VISIBILITY_FILTERS[(tick - 1) % SPECTATOR_VISIBILITY_FILTERS.length],
        names,
      );
    },
  );
  assertEquals(digest, digestObserved);
});

Deno.test("12.6 omission: serialized facts contain no banned substrings", () => {
  const ctx = project(view({ players: MIXED }), {
    focusedPlayerId: "h1",
    index: emptyIndex({
      markers: [marker({ tick: 10 })],
      playerActivity: [span({ playerId: "h1" })],
    }),
  })!;
  const serialized = JSON.stringify(ctx).toLowerCase();
  for (const banned of [
    "ping",
    "cosmetic",
    "account",
    "email",
    "wallhack",
    "yawdots",
    "password",
    "token",
  ]) {
    assertEquals(serialized.includes(banned), false, `banned in output: ${banned}`);
  }
});

Deno.test("12.6 source-scan: pure module has no THREE/DOM/clock/sim/io", async () => {
  const src = await Deno.readTextFile(
    new URL("./spectatorContext.ts", import.meta.url),
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
    "thirdPersonCamera",
    "freeCamera",
    "selectFocusedPlayer",
    "markersInRange",
    "getDoorCycleState",
    "ReplayClock",
    "replayClock",
    "isBot",
    "Deno.",
    "node:fs",
    "ReplayBlobStore",
    "createStore",
    'from "../net/',
    'from "./net/',
    "socket.io",
    "SpectateBanner",
    "ReplayDevFpsPlayer",
    "spectatorDriver",
  ]) {
    assertEquals(code.includes(banned), false, `banned token present: ${banned}`);
  }
  assertEquals(src.includes("projectSpectatorContext"), true);
  assertEquals(src.includes("import type { CameraPresence }"), true);
  assertEquals(code.includes("applyVisibilityFilter"), true);
  assertEquals(code.includes("tickToTimeMs"), true);
  assertEquals(code.includes("markersAt"), true);
  assertEquals(code.includes("activityForPlayer"), true);
});
