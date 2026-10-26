/**
 * Epic 8.2 — initial-state recording.
 *
 * Run from server-community/:
 *   deno test -A replay/recorder_initial_state_test.ts
 */

import {
  assertEquals,
  assertExists,
  assertMatch,
  assertNotEquals,
} from "@std/assert";
import { GameServer } from "../runtime/GameServer.ts";
import { NoopAuthorityAdapter } from "../authority/adapter.ts";
import { PlayerManager } from "../players/PlayerManager.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";
import type { SimTickResult } from "../players/simTickResult.ts";
import { drainTickAuthoritativeEvents } from "../players/authoritativeEventSource.ts";
import type { AuthoritativeEvent } from "../shared/sim/authoritativeEvent.ts";
import {
  emptyAuthoritativeRosterSnapshot,
  makeMatchInitEvent,
  type MatchInitEvent,
} from "../shared/sim/authoritativeEvent.ts";
import {
  buildMatchMetadata,
  MATCH_METADATA_INFORMATIONAL_FIELDS,
  MATCH_METADATA_LOAD_BEARING_FIELDS,
  type MatchMetadata,
} from "../shared/replay/matchMetadata.ts";
import { TICK_HZ } from "../shared/sim/game.ts";
import { createMatchSimRngStreams } from "../shared/sim/simRng.ts";
import type { InMemoryReplayLifecycleClient } from "./replayLifecycleClient.ts";
import {
  settleRecorder,
  wireReplayRecorder,
  type WireRecorderOptions,
} from "./replayTestHarness.ts";
import {
  captureRecordedInitialState,
  REPLAY_RNG_CONSTRUCTION_RULE,
  ROSTER_ENTRY_REQUIRED_KEYS,
  WALL_CLOCK_EXCLUDED_KEYS,
} from "./recordedInitialState.ts";

const miniMap: DoorsMap = {
  name: "replay-init",
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

type ServerInternals = {
  players: PlayerManager;
  sessions: { emit(...args: unknown[]): void } | null;
  runtimeMatchId: string;
  stepSim(tick: number, nowMs: number): SimTickResult;
  deliverReplayIntegrationTick(
    tick: number,
    events: ReadonlyArray<AuthoritativeEvent>,
  ): void;
  beginRuntimeMatchIdentity(tick?: number): void;
  emitMatchStart(
    matchStart: ReturnType<PlayerManager["beginLiveMatch"]>,
    tick: number,
  ): void;
  onMatchEnded(
    packet: {
      winner: "A" | "B" | "draw";
      scores: { A: number; B: number };
      players: unknown[];
    },
    nowMs?: number,
  ): void;
  maybeResetEmptyRankedInstance?: () => void;
};

function makeServer(joinMode: "open" | "ranked" = "open"): GameServer {
  return new GameServer({
    name: "replay-init",
    port: 0,
    host: "127.0.0.1",
    map: miniMap,
    collision: new MapCollision(miniMap),
    autofillBots: 0,
    noBotsOnEmptyServer: true,
    joinMode,
    rankedServerId: joinMode === "ranked" ? "ranked" : "open",
    authorityAdapter: new NoopAuthorityAdapter(),
    botThinkEngine: null,
  });
}

function internals(server: GameServer): ServerInternals {
  return server as unknown as ServerInternals;
}

function stubSessions(server: GameServer): void {
  internals(server).sessions = { emit: () => {} };
}


function wireRecorder(server: GameServer, opts?: WireRecorderOptions) {
  return wireReplayRecorder(
    {
      attachSink: (sink) => server.attachReplaySink(sink),
      detachSink: () => server.detachReplaySink(),
    },
    opts,
  );
}

function driveTick(server: GameServer, tick: number): SimTickResult {
  const i = internals(server);
  const result = i.stepSim(tick, Date.now());
  const authEvents = drainTickAuthoritativeEvents(
    i.players,
    tick,
    result.events,
  );
  i.deliverReplayIntegrationTick(tick, authEvents);
  return result;
}

function sampleRoster() {
  return emptyAuthoritativeRosterSnapshot({
    id: "p1",
    name: "P1",
    team: "A",
  });
}

function sampleInit(
  over?: Partial<Omit<MatchInitEvent, "kind">>,
): MatchInitEvent {
  return makeMatchInitEvent({
    appliedTick: 10,
    map: { name: "replay-init", version: 1 },
    matchSeed: 42,
    matchDurationTicks: 60 * TICK_HZ,
    prematchEnabled: false,
    phase: "live",
    raidDoorPolicy: "off",
    debugForceDoorsOpen: false,
    scores: { A: 0, B: 0 },
    roster: [sampleRoster()],
    ...over,
  });
}

function sampleMetadata(
  init: MatchInitEvent,
  runtimeMatchId = "11111111-1111-1111-1111-111111111111",
  infoOver?: Partial<MatchMetadata>,
): MatchMetadata {
  const built = buildMatchMetadata(
    init.appliedTick,
    {
      matchSeed: init.matchSeed,
      matchDurationTicks: init.matchDurationTicks,
      matchEndTick: init.matchDurationTicks,
      doorCycleOriginTick: 0,
      map: init.map,
      prematchEnabled: init.prematchEnabled,
      raidDoorPolicy: init.raidDoorPolicy,
      debugForceDoorsOpen: init.debugForceDoorsOpen,
      phase: init.phase,
      scores: init.scores,
      roster: init.roster,
    },
    {
      runtimeMatchId,
      serverName: "replay-init",
      serverId: "open",
      modeId: null,
      raidId: null,
      buildSha: "testsha",
      raidMatch: { active: false },
    },
    { capturedAtIso: "2026-01-01T00:00:00.000Z" },
  );
  assertEquals(built.ok, true);
  if (!built.ok) throw new Error(built.reason);
  return { ...built.metadata, ...infoOver };
}

function startLiveRecording(server: GameServer, tick = 10) {
  const i = internals(server);
  i.players.add("s1", "A1", "A");
  i.players.add("s2", "B1", "B");
  const start = i.players.beginLiveMatch(tick, Date.now());
  i.beginRuntimeMatchIdentity(tick);
  i.emitMatchStart(start, tick);
  return i.runtimeMatchId;
}

// ---------------------------------------------------------------------------
// Pure capture unit tests
// ---------------------------------------------------------------------------

Deno.test("8.2 capture: verbatim init+metadata deep-equal sources", () => {
  const runtimeMatchId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const init = sampleInit();
  const metadata = sampleMetadata(init, runtimeMatchId);
  const result = captureRecordedInitialState(
    { initEvent: init, metadata },
    runtimeMatchId,
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.state.runtimeMatchId, runtimeMatchId);
  assertEquals(result.state.captureTick, init.appliedTick);
  assertEquals(result.state.init, init);
  assertEquals(result.state.metadata, metadata);
  const entry = result.state.init.roster[0];
  for (const key of ROSTER_ENTRY_REQUIRED_KEYS) {
    assertEquals(key in entry, true, `missing roster key ${key}`);
  }
  assertExists(entry.pose);
  assertExists(entry.equipment);
  assertEquals(entry.skillLoadout, null);
  assertEquals(entry.ownedAbilities, null);
});

Deno.test("8.2 capture: matchSeed/map/config agreement or fail", () => {
  const id = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const init = sampleInit();
  const metadata = sampleMetadata(init, id);

  const seedMismatch = captureRecordedInitialState(
    { initEvent: init, metadata: { ...metadata, matchSeed: metadata.matchSeed + 1 } },
    id,
  );
  assertEquals(seedMismatch.ok, false);
  if (!seedMismatch.ok) assertMatch(seedMismatch.reason, /matchSeed/);

  const mapMismatch = captureRecordedInitialState(
    {
      initEvent: init,
      metadata: { ...metadata, map: { name: "other", version: 1 } },
    },
    id,
  );
  assertEquals(mapMismatch.ok, false);
  if (!mapMismatch.ok) assertMatch(mapMismatch.reason, /map/);
});

Deno.test("8.2 capture: unsupported map version fails loud", () => {
  const id = "cccccccc-cccc-cccc-cccc-cccccccccccc";
  const init = sampleInit({
    map: { name: "x", version: 99 as 1 },
  });
  // Bypass buildMatchMetadata (which also rejects) — craft metadata manually.
  const metadata = {
    ...sampleMetadata(sampleInit(), id),
    map: { name: "x", version: 99 as 1 },
    matchSeed: init.matchSeed,
    matchDurationTicks: init.matchDurationTicks,
    prematchEnabled: init.prematchEnabled,
    raidDoorPolicy: init.raidDoorPolicy,
    debugForceDoorsOpen: init.debugForceDoorsOpen,
    phase: init.phase,
    scores: init.scores,
    roster: init.roster,
    captureTick: init.appliedTick,
  } as MatchMetadata;
  const result = captureRecordedInitialState(
    { initEvent: init, metadata },
    id,
  );
  assertEquals(result.ok, false);
  if (!result.ok) assertMatch(result.reason, /unsupported map version/);
});

Deno.test("8.2 capture: drop each load-bearing field → loud failure", () => {
  const id = "dddddddd-dddd-dddd-dddd-dddddddddddd";
  const init = sampleInit();
  const metadata = sampleMetadata(init, id);

  for (const field of MATCH_METADATA_LOAD_BEARING_FIELDS) {
    const mangled = { ...metadata } as Record<string, unknown>;
    delete mangled[field];
    const result = captureRecordedInitialState(
      { initEvent: init, metadata: mangled as unknown as MatchMetadata },
      id,
    );
    assertEquals(result.ok, false, `expected fail when dropping ${field}`);
  }

  const noEquipment = captureRecordedInitialState(
    {
      initEvent: {
        ...init,
        roster: init.roster.map((r) => {
          const copy = { ...r } as Record<string, unknown>;
          delete copy.equipment;
          return copy as unknown as typeof r;
        }),
      },
      metadata,
    },
    id,
  );
  assertEquals(noEquipment.ok, false);
  if (!noEquipment.ok) assertMatch(noEquipment.reason, /equipment/);
});

Deno.test("8.2 capture: swap informational fields → still valid", () => {
  const id = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
  const init = sampleInit();
  const metadata = sampleMetadata(init, id, {
    serverName: "swapped-name",
    serverId: "swapped-id",
    modeId: "mode-x",
    raidId: "raid-y",
    buildSha: "deadbeef",
    capturedAtIso: "2099-12-31T23:59:59.000Z",
  });
  const result = captureRecordedInitialState(
    { initEvent: init, metadata },
    id,
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  for (const field of MATCH_METADATA_INFORMATIONAL_FIELDS) {
    if (field === "runtimeMatchId" || field === "gameProto" ||
      field === "replayFormatVersion"
    ) {
      continue;
    }
    assertNotEquals(
      (result.state.metadata as Record<string, unknown>)[field],
      undefined,
    );
  }
  assertEquals(result.state.metadata.serverName, "swapped-name");
});

Deno.test("8.2 capture: freeze — mutating accessor / live objects does not leak", () => {
  const id = "ffffffff-ffff-ffff-ffff-ffffffffffff";
  const init = sampleInit();
  const metadata = sampleMetadata(init, id);
  const result = captureRecordedInitialState(
    { initEvent: init, metadata },
    id,
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;

  assertEquals(Object.isFrozen(result.state), true);
  assertEquals(Object.isFrozen(result.state.init), true);
  assertEquals(Object.isFrozen(result.state.init.roster), true);
  assertEquals(Object.isFrozen(result.state.init.roster[0]), true);
  assertEquals(Object.isFrozen(result.state.metadata), true);

  // Mutating the source after capture must not alter stored state.
  (init.roster[0] as { name: string }).name = "MUTATED";
  init.scores.A = 99;
  assertEquals(result.state.init.roster[0].name, "P1");
  assertEquals(result.state.init.scores.A, 0);

  // Mutating returned object must throw (frozen).
  let threw = false;
  try {
    (result.state.init.scores as { A: number }).A = 7;
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
  assertEquals(result.state.init.scores.A, 0);
});

Deno.test("8.2 capture: wall-clock keys absent", () => {
  const id = "10101010-1010-1010-1010-101010101010";
  const init = sampleInit();
  const metadata = sampleMetadata(init, id);
  const result = captureRecordedInitialState(
    { initEvent: init, metadata },
    id,
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;

  const json = JSON.stringify(result.state);
  for (const key of WALL_CLOCK_EXCLUDED_KEYS) {
    assertEquals(
      json.includes(`"${key}"`),
      false,
      `unexpected wall-clock key ${key}`,
    );
  }

  const poisoned = captureRecordedInitialState(
    {
      initEvent: init,
      metadata: {
        ...metadata,
        // deno-lint-ignore no-explicit-any
        ...( { liveStartedAtMs: 123 } as any ),
      },
    },
    id,
  );
  assertEquals(poisoned.ok, false);
  if (!poisoned.ok) assertMatch(poisoned.reason, /wall-clock/);
});

Deno.test("8.2 RNG construction rule documented; seed rebuilds opening streams", () => {
  assertMatch(REPLAY_RNG_CONSTRUCTION_RULE, /createMatchSimRngStreams/);
  assertMatch(REPLAY_RNG_CONSTRUCTION_RULE, /reseedSpawnRng/);

  const seed = 0xabcdef01;
  const a = createMatchSimRngStreams(seed);
  const b = createMatchSimRngStreams(seed);
  assertEquals(a.matchSeed, b.matchSeed);
  assertEquals(a.damage(), b.damage());
  assertEquals(a.spread(), b.spread());
  assertEquals(a.spawn(), b.spawn());
  assertEquals(a.agents(), b.agents());
});

// ---------------------------------------------------------------------------
// Recorder integration
// ---------------------------------------------------------------------------

Deno.test("8.2 recorder: startRecording+onMatchInit stores frozen capture", () => {
  const server = makeServer();
  stubSessions(server);
  const i = internals(server);
  const { recorder } = wireRecorder(server);

  const matchId = startLiveRecording(server, 10);
  const captured = recorder.getInitialState(matchId);
  assertExists(captured);
  assertEquals(captured.runtimeMatchId, matchId);
  assertEquals(captured.captureTick, 10);
  assertEquals(Object.isFrozen(captured), true);

  // Verbatim vs live owners at capture tick.
  const liveInit = i.players.buildMatchInitEvent(10);
  assertEquals(liveInit.kind, "matchInit");
  if (liveInit.kind === "matchInit") {
    assertEquals(captured.init.matchSeed, liveInit.matchSeed);
    assertEquals(captured.init.map, liveInit.map);
    assertEquals(captured.init.matchDurationTicks, liveInit.matchDurationTicks);
    assertEquals(captured.init.prematchEnabled, liveInit.prematchEnabled);
    assertEquals(captured.init.raidDoorPolicy, liveInit.raidDoorPolicy);
    assertEquals(captured.init.debugForceDoorsOpen, liveInit.debugForceDoorsOpen);
    assertEquals(captured.init.scores, liveInit.scores);
    assertEquals(captured.init.roster.length, liveInit.roster.length);
    for (let r = 0; r < liveInit.roster.length; r++) {
      const a = captured.init.roster[r];
      const b = liveInit.roster[r];
      assertEquals(a.id, b.id);
      assertEquals(a.team, b.team);
      assertEquals(a.pose, b.pose);
      assertEquals(a.equipment, b.equipment);
      assertEquals(a.skillLoadout, b.skillLoadout);
      assertEquals(a.ownedAbilities, b.ownedAbilities);
    }
  }

  assertEquals(
    captured.metadata.matchEndTick,
    i.players.getMatchClockState().matchEndTick,
  );
  assertEquals(
    captured.metadata.doorCycleOriginTick,
    i.players.getDoorCycleOriginTick(),
  );
  assertEquals(recorder.getInitTick(), 10);
});

Deno.test("8.2 identity: new runtimeMatchId replaces capture", () => {
  const server = makeServer();
  stubSessions(server);
  const i = internals(server);
  const { recorder } = wireRecorder(server);

  const firstId = startLiveRecording(server, 5);
  const first = recorder.getInitialState(firstId);
  assertExists(first);

  // Rotate to a new match session.
  i.players.add("s3", "A2", "A");
  const start2 = i.players.beginLiveMatch(20, Date.now());
  i.beginRuntimeMatchIdentity(20);
  i.emitMatchStart(start2, 20);
  const secondId = i.runtimeMatchId;
  assertNotEquals(firstId, secondId);

  assertEquals(recorder.getInitialState(firstId), null);
  const second = recorder.getInitialState(secondId);
  assertExists(second);
  assertEquals(second.runtimeMatchId, secondId);
  assertEquals(second.captureTick, 20);
  assertNotEquals(second.captureTick, first.captureTick);
});

Deno.test("8.2 identity: empty-ranked reset without rotation keeps capture", () => {
  const server = makeServer("ranked");
  stubSessions(server);
  const i = internals(server);
  const { recorder } = wireRecorder(server);

  for (const id of ["s1", "s2", "s3", "s4"]) {
    i.players.add(id, id, id === "s2" || id === "s4" ? "B" : "A");
  }
  const start = i.players.beginLiveMatch(1, Date.now());
  i.beginRuntimeMatchIdentity(1);
  i.emitMatchStart(start, 1);
  const matchId = i.runtimeMatchId;
  const before = recorder.getInitialState(matchId);
  assertExists(before);

  for (const id of ["s1", "s2", "s3", "s4"]) {
    i.players.remove(id);
  }
  const reset = (server as unknown as {
    maybeResetEmptyRankedInstance(): boolean;
  }).maybeResetEmptyRankedInstance();
  assertEquals(reset, true);
  assertEquals(i.runtimeMatchId, matchId);
  assertEquals(recorder.getInitialState(matchId), before);
});

Deno.test("8.2 identity: detach/shutdown discards capture", async () => {
  const server = makeServer();
  stubSessions(server);
  const { recorder, lifecycle } = wireRecorder(server);

  const matchId = startLiveRecording(server, 3);
  assertExists(recorder.getInitialState(matchId));

  recorder.shutdown();
  assertEquals(recorder.getInitialState(matchId), null);
  await settleRecorder(recorder);
  const row = (await (lifecycle as InMemoryReplayLifecycleClient).getByRuntimeMatchId(matchId))!;
  assertEquals(row.status, "failed");
  assertMatch(row.error ?? "", /clean-shutdown/);
});

Deno.test("8.2/8.6 identity: normal end discards in-memory capture (finalized)", async () => {
  const server = makeServer();
  stubSessions(server);
  const i = internals(server);
  const { recorder, lifecycle } = wireRecorder(server);

  const matchId = startLiveRecording(server, 1);
  assertExists(recorder.getInitialState(matchId));

  i.onMatchEnded({
    winner: "A",
    scores: { A: 1, B: 0 },
    players: [],
  });
  assertEquals(recorder.getInitialState(matchId), null);
  await settleRecorder(recorder);
  assertEquals((await (lifecycle as InMemoryReplayLifecycleClient).getByRuntimeMatchId(matchId))?.status, "finalized");
});

Deno.test("8.2 no-persistence: capture module has no snapshot/file/blob/finalized writes", async () => {
  const src = await Deno.readTextFile(
    new URL("./recordedInitialState.ts", import.meta.url),
  );
  // Import / call sites only — comments may name forbidden APIs as exclusions.
  assertEquals(/from\s+["'][^"']*Player(?:Manager)?\.ts["']/.test(src), false);
  assertEquals(/\bcreateSnapshot\s*\(/.test(src), false);
  assertEquals(/\btoSnapshot\s*\(/.test(src), false);
  assertEquals(/Deno\.write(?:File|TextFile)/.test(src), false);
  assertEquals(/status:\s*["']finalized["']/.test(src), false);

  // Capture module stays free of finalize writes; 8.6 owns finalized.
  assertEquals(/stampReplayFinalized/.test(src), false);
});

Deno.test("8.2 live mutation after capture does not leak into stored state", () => {
  const server = makeServer();
  stubSessions(server);
  const i = internals(server);
  const { recorder } = wireRecorder(server);

  const matchId = startLiveRecording(server, 10);
  const captured = recorder.getInitialState(matchId)!;
  const seedAtCapture = captured.init.matchSeed;
  const scoresAtCapture = { ...captured.init.scores };
  const rosterLen = captured.init.roster.length;

  // Advance sim + mutate scores path via more ticks / end.
  for (let t = 11; t <= 15; t++) driveTick(server, t);
  i.players.add("s3", "A2", "A");

  const again = recorder.getInitialState(matchId)!;
  assertEquals(again.init.matchSeed, seedAtCapture);
  assertEquals(again.init.scores, scoresAtCapture);
  assertEquals(again.init.roster.length, rosterLen);
});

Deno.test("8.2 equivalence: sim outcomes identical with capture on vs off", () => {
  function runSeason(withRecorder: boolean): {
    phase: string;
    scores: { A: number; B: number };
  } {
    const server = makeServer();
    stubSessions(server);
    const i = internals(server);
    if (withRecorder) wireRecorder(server);
    i.players.add("s1", "A1", "A");
    i.players.add("s2", "B1", "B");
    const start = i.players.beginLiveMatch(1, Date.now());
    i.beginRuntimeMatchIdentity(1);
    i.emitMatchStart(start, 1);
    for (let t = 2; t <= 6; t++) driveTick(server, t);
    i.onMatchEnded({
      winner: "A",
      scores: { A: 1, B: 0 },
      players: [],
    });
    const out = {
      phase: i.players.getMatchPhase(),
      scores: i.players.getScores(),
    };
    return out;
  }

  assertEquals(runSeason(true), runSeason(false));
});

Deno.test("8.2 coverage: capture at recording start across season variants", () => {
  // Prematch rotation (no live yet) still captures init at identity tick.
  // Human presence is required to open a recording row (temp/dev gate).
  {
    const server = makeServer();
    stubSessions(server);
    const i = internals(server);
    const { recorder } = wireRecorder(server);
    i.players.add("s1", "A1", "A");
    i.beginRuntimeMatchIdentity(0);
    const id = i.runtimeMatchId;
    const cap = recorder.getInitialState(id);
    assertExists(cap);
    assertEquals(cap.captureTick, 0);
    assertEquals(cap.init.phase, i.players.getMatchPhase());
  }

  // Live start with bots.
  {
    const server = makeServer();
    stubSessions(server);
    const i = internals(server);
    const { recorder } = wireRecorder(server);
    i.players.add("s1", "A1", "A");
    i.players.addBot("bot1", "BotOne", { team: "B" });
    i.players.addBot("raid1", "RaidOne", { team: "B", isRaidBot: true });
    const start = i.players.beginLiveMatch(7, Date.now());
    i.beginRuntimeMatchIdentity(7);
    i.emitMatchStart(start, 7);
    const cap = recorder.getInitialState(i.runtimeMatchId)!;
    // Arena fill bots are indistinguishable from humans in the recording;
    // `isBot` records only the raid-bot role.
    assertEquals(cap.init.roster.some((r) => r.id === "bot1"), true);
    assertEquals(cap.init.roster.find((r) => r.id === "bot1")?.isBot, false);
    assertEquals(cap.init.roster.find((r) => r.id === "bot1")?.isAgent, false);
    assertEquals(cap.init.roster.find((r) => r.id === "raid1")?.isBot, true);
    assertEquals(cap.init.roster.find((r) => r.id === "raid1")?.isAgent, false);
    // Rebuild streams from recorded seed — opening draws match.
    const rebuilt = createMatchSimRngStreams(cap.init.matchSeed);
    const live = createMatchSimRngStreams(i.players.getMatchSeed());
    assertEquals(rebuilt.matchSeed, live.matchSeed);
    assertEquals(rebuilt.damage(), live.damage());
  }
});
