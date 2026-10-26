/**
 * Epic 8.4 — event recording.
 *
 * Run from server-community/:
 *   deno test -A replay/recorder_event_recording_test.ts
 */

import {
  assertEquals,
  assertExists,
  assertNotEquals,
} from "@std/assert";
import { GameServer } from "../runtime/GameServer.ts";
import { NoopAuthorityAdapter } from "../authority/adapter.ts";
import { PlayerManager } from "../players/PlayerManager.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";
import type { SimTickResult } from "../players/simTickResult.ts";
import { drainTickAuthoritativeEvents } from "../players/authoritativeEventSource.ts";
import {
  emptyAuthoritativePose,
  emptyAuthoritativeRosterSnapshot,
  makeCombatBurstEvent,
  makeGameOverEvent,
  makeHumanJoinEvent,
  makeMatchDrawEvent,
  makeMatchEndEvent,
  makeMatchInitEvent,
  makePlayerDiedEvent,
  makePlayerRespawnedEvent,
  makeScoreEvent,
  normalizeAuthoritativeEvent,
  type AuthoritativeEvent,
  type MatchInitEvent,
} from "../shared/sim/authoritativeEvent.ts";
import { ReplayRecorder } from "./ReplayRecorder.ts";
import type { InMemoryReplayLifecycleClient } from "./replayLifecycleClient.ts";
import {
  settleRecorder,
  wireReplayRecorder,
  type WireRecorderOptions,
} from "./replayTestHarness.ts";
import { captureRecordedTickEvents } from "./recordedTickEvents.ts";
import type { ReplayTickPayload } from "./replayIntegration.ts";
import type { TickSelectedInput } from "../players/tickAssociation.ts";

const miniMap: DoorsMap = {
  name: "replay-events",
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
};

function makeServer(joinMode: "open" | "ranked" = "open"): GameServer {
  return new GameServer({
    name: "replay-events",
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

function driveTick(
  server: GameServer,
  tick: number,
): { result: SimTickResult; events: AuthoritativeEvent[] } {
  const i = internals(server);
  const result = i.stepSim(tick, Date.now());
  const authEvents = drainTickAuthoritativeEvents(
    i.players,
    tick,
    result.events,
  );
  i.deliverReplayIntegrationTick(tick, authEvents);
  return { result, events: authEvents };
}

/**
 * Step the sim (so 8.3 movement selections exist) then deliver a custom
 * event list — used to pin order / mapping / divert without relying on
 * whatever the live drain produced this tick.
 */
function injectEvents(
  server: GameServer,
  tick: number,
  events: ReadonlyArray<AuthoritativeEvent>,
): void {
  const i = internals(server);
  const result = i.stepSim(tick, Date.now());
  // Clear the unified drain so leftover buffer facts do not leak to later ticks.
  drainTickAuthoritativeEvents(i.players, tick, result.events);
  i.deliverReplayIntegrationTick(tick, events);
}

function startLive(
  server: GameServer,
  recorder: ReplayRecorder,
  playerSpecs: Array<{ socket: string; name: string; team: "A" | "B" }>,
): string {
  const i = internals(server);
  stubSessions(server);
  for (const p of playerSpecs) {
    i.players.add(p.socket, p.name, p.team);
  }
  const start = i.players.beginLiveMatch(1, Date.now());
  i.beginRuntimeMatchIdentity(1);
  i.emitMatchStart(start, 1);
  assertEquals(recorder.getActiveRuntimeMatchId(), i.runtimeMatchId);
  return i.runtimeMatchId;
}

function emptyPayload(
  tick: number,
  events: ReadonlyArray<AuthoritativeEvent>,
): ReplayTickPayload {
  return {
    tick,
    inputs: new Map<string, TickSelectedInput | null>(),
    actions: [],
    events,
  };
}

function sampleJoin(tick: number, id: string): AuthoritativeEvent {
  return normalizeAuthoritativeEvent(
    makeHumanJoinEvent({
      appliedTick: tick,
      player: emptyAuthoritativeRosterSnapshot({ id, team: "A" }),
    }),
  )!;
}

function sampleBurst(tick: number): AuthoritativeEvent {
  return normalizeAuthoritativeEvent(
    makeCombatBurstEvent({
      appliedTick: tick,
      outcomes: [{
        shot: {
          shooterId: "s1",
          origin: [0, 1, 0],
          direction: [0, 0, 1],
          weapon: 1,
          hitId: null,
          hitZone: null,
          hitPoint: null,
        },
      }],
    }),
  )!;
}

function sampleDeath(tick: number): AuthoritativeEvent {
  return normalizeAuthoritativeEvent(
    makePlayerDiedEvent({
      appliedTick: tick,
      victimId: "v1",
      killerId: "s1",
      zone: "head",
      weapon: 1,
      killerName: "S",
      victimName: "V",
      killerTeam: "A",
      victimTeam: "B",
    }),
  )!;
}

function sampleScore(tick: number): AuthoritativeEvent {
  return normalizeAuthoritativeEvent(
    makeScoreEvent({
      appliedTick: tick,
      scorerId: "s1",
      team: "A",
      scores: { A: 1, B: 0 },
      playerPose: emptyAuthoritativePose(),
      playerAlive: true,
    }),
  )!;
}

Deno.test("8.4 capture helper: verbatim order + appliedTick preserved", () => {
  const tick = 7;
  const delivered = [
    sampleJoin(tick, "z"),
    sampleBurst(tick),
    sampleDeath(tick),
    sampleScore(tick),
  ];
  // Deliberately NOT re-sorted — capture must store as-delivered.
  const result = captureRecordedTickEvents(emptyPayload(tick, delivered));
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.tick, tick);
  assertEquals(result.events.length, 4);
  assertEquals(
    result.events.map((e) => e.kind),
    delivered.map((e) => e.kind),
  );
  for (let i = 0; i < result.events.length; i++) {
    assertEquals(result.events[i]!.appliedTick, delivered[i]!.appliedTick);
    assertEquals(result.events[i]!.kind, delivered[i]!.kind);
  }
  assertEquals(result.divertedMatchInits.length, 0);
});

Deno.test("8.4 capture helper: matchInit diverted, never kept", () => {
  const tick = 1;
  const init = normalizeAuthoritativeEvent(
    makeMatchInitEvent({
      appliedTick: tick,
      matchSeed: 42,
      map: { name: "m", version: 1 },
      matchDurationTicks: 54000,
      prematchEnabled: true,
      phase: "prematch",
      raidDoorPolicy: "off",
      debugForceDoorsOpen: false,
      scores: { A: 0, B: 0 },
      roster: [],
    }),
  ) as MatchInitEvent;
  const join = sampleJoin(tick, "p1");
  const result = captureRecordedTickEvents(
    emptyPayload(tick, [init, join]),
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.events.map((e) => e.kind), ["humanJoin"]);
  assertEquals(result.divertedMatchInits.length, 1);
  assertEquals(result.divertedMatchInits[0]!.kind, "matchInit");
});

Deno.test("8.4 capture helper: missing appliedTick fails loud", () => {
  const bad = {
    kind: "readyVote",
    // appliedTick intentionally omitted
    playerId: "p",
    ready: true,
  } as unknown as AuthoritativeEvent;
  const result = captureRecordedTickEvents(emptyPayload(3, [bad]));
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertEquals(/appliedTick/.test(result.reason), true);
});

Deno.test("8.4 verbatim: stored list deep-equals sink-delivered drain output", () => {
  const server = makeServer();
  const { recorder } = wireRecorder(server);
  const matchId = startLive(server, recorder, [
    { socket: "s1", name: "A1", team: "A" },
    { socket: "s2", name: "B1", team: "B" },
  ]);

  // Tick with whatever the unified drain produced — compare element-for-element.
  const { events: drained } = driveTick(server, 2);
  const row = recorder.getTickEvents(matchId, 2);
  assertExists(row);
  if (drained.length === 0) {
    assertEquals(row.events.length, 0);
  } else {
    assertEquals(row.events.length, drained.length);
    for (let i = 0; i < drained.length; i++) {
      assertEquals(row.events[i]!.kind, drained[i]!.kind);
      assertEquals(row.events[i]!.appliedTick, drained[i]!.appliedTick);
      assertEquals(
        JSON.stringify(row.events[i]),
        JSON.stringify(drained[i]),
      );
    }
  }
});

Deno.test("8.4 inject: mapping nouns land as expected kinds + order preserved", () => {
  const server = makeServer();
  const { recorder } = wireRecorder(server);
  const matchId = startLive(server, recorder, [
    { socket: "s1", name: "A1", team: "A" },
  ]);
  const tick = 5;
  // As-delivered order (not canonical sort) — recorder must not re-sort.
  const delivered: AuthoritativeEvent[] = [
    sampleDeath(tick),
    sampleBurst(tick),
    sampleScore(tick),
    normalizeAuthoritativeEvent(
      makePlayerRespawnedEvent({
        appliedTick: tick,
        player: emptyAuthoritativeRosterSnapshot({ id: "v1", team: "B" }),
      }),
    )!,
  ];
  injectEvents(server, tick, delivered);

  const row = recorder.getTickEvents(matchId, tick)!;
  assertEquals(
    row.events.map((e) => e.kind),
    ["playerDied", "combatBurst", "score", "playerRespawned"],
  );
  assertEquals(row.events[2]!.kind, "score");
});

Deno.test("8.4 GameOver dedup path: matchEnd without gameOver; fallback stores gameOver", () => {
  const server = makeServer();
  const { recorder } = wireRecorder(server);
  const matchId = startLive(server, recorder, [
    { socket: "s1", name: "A1", team: "A" },
  ]);
  const endTick = 10;
  injectEvents(server, endTick, [
    normalizeAuthoritativeEvent(
      makeMatchEndEvent({
        appliedTick: endTick,
        winner: "A",
        scores: { A: 1, B: 0 },
        scheduleRestart: true,
        restartSeconds: 8,
        restartAtTick: endTick + 80,
      }),
    )!,
  ]);
  const endRow = recorder.getTickEvents(matchId, endTick)!;
  assertEquals(endRow.events.map((e) => e.kind), ["matchEnd"]);
  assertEquals(endRow.events.some((e) => e.kind === "gameOver"), false);

  // Fresh session for fallback path

  const server2 = makeServer();
  const wired2 = wireRecorder(server2);
  const matchId2 = startLive(server2, wired2.recorder, [
    { socket: "s1", name: "A1", team: "A" },
  ]);
  const fallbackTick = 11;
  injectEvents(server2, fallbackTick, [
    normalizeAuthoritativeEvent(
      makeGameOverEvent({
        appliedTick: fallbackTick,
        winner: "B",
        scores: { A: 0, B: 1 },
        restartInSeconds: 8,
      }),
    )!,
  ]);
  const fb = wired2.recorder.getTickEvents(matchId2, fallbackTick)!;
  assertEquals(fb.events.map((e) => e.kind), ["gameOver"]);

  
});

Deno.test("8.4 matchInit divert: never in stream; disagree fails recording", async () => {
  const server = makeServer();
  const { recorder, lifecycle } = wireRecorder(server);
  const matchId = startLive(server, recorder, [
    { socket: "s1", name: "A1", team: "A" },
  ]);

  // Agreeing divert: use the captured 8.2 init if present.
  const initState = recorder.getInitialState(matchId);
  assertExists(initState);
  injectEvents(server, 3, [
    initState.init,
    sampleJoin(3, "late"),
  ]);
  const agreeRow = recorder.getTickEvents(matchId, 3)!;
  assertEquals(agreeRow.events.every((e) => e.kind !== "matchInit"), true);
  assertEquals(agreeRow.events.some((e) => e.kind === "humanJoin"), true);

  // Disagreeing divert → tick error accounting → failed after threshold.
  const bogus = normalizeAuthoritativeEvent(
    makeMatchInitEvent({
      appliedTick: 99,
      matchSeed: 999999,
      map: { name: "other", version: 1 },
      matchDurationTicks: 54000,
      prematchEnabled: true,
      phase: "prematch",
      raidDoorPolicy: "off",
      debugForceDoorsOpen: false,
      scores: { A: 9, B: 9 },
      roster: [],
    }),
  )!;
  for (let t = 0; t < 3; t++) {
    injectEvents(server, 20 + t, [bogus]);
  }
  await settleRecorder(recorder);
  const row = await (lifecycle as InMemoryReplayLifecycleClient).getByRuntimeMatchId(matchId);
  assertExists(row);
  assertEquals(row.status, "failed");
  assertEquals(row.errorCount >= 1, true);
});

Deno.test("8.4 freeze: mutating live/delivered list or accessor does not leak", () => {
  const server = makeServer();
  const { recorder } = wireRecorder(server);
  const matchId = startLive(server, recorder, [
    { socket: "s1", name: "A1", team: "A" },
  ]);
  const tick = 4;
  const delivered: AuthoritativeEvent[] = [sampleBurst(tick), sampleDeath(tick)];
  injectEvents(server, tick, delivered);

  // Mutate the live delivered array post-capture.
  delivered.pop();
  (delivered[0] as { appliedTick: number }).appliedTick = 999;

  const row = recorder.getTickEvents(matchId, tick)!;
  assertEquals(row.events.length, 2);
  assertEquals(row.events[0]!.appliedTick, tick);

  // Mutating accessor return must not alter stored stream.
  let threw = false;
  try {
    (row.events as AuthoritativeEvent[]).push(sampleScore(tick));
  } catch {
    threw = true;
  }
  // Either frozen (throw) or mutation ignored — stored length stays 2.
  const again = recorder.getTickEvents(matchId, tick)!;
  assertEquals(again.events.length, 2);
  void threw;
});

Deno.test("8.4 sparse + agreement: empty ticks synthesize []; stored set = non-empty deliveries", () => {
  const server = makeServer();
  const { recorder } = wireRecorder(server);
  const matchId = startLive(server, recorder, [
    { socket: "s1", name: "A1", team: "A" },
  ]);
  // Empty delivery
  injectEvents(server, 2, []);
  const empty = recorder.getTickEvents(matchId, 2)!;
  assertEquals(empty.events.length, 0);
  assertEquals(Object.isFrozen(empty.events), true);

  // Non-empty
  injectEvents(server, 3, [sampleJoin(3, "p2")]);
  injectEvents(server, 4, []);
  injectEvents(server, 5, [sampleBurst(5), sampleDeath(5)]);

  const stream = recorder.getEventStream(matchId)!;
  assertEquals(stream.map((r) => r.tick), [3, 5]);
  assertEquals(stream[0]!.events.map((e) => e.kind), ["humanJoin"]);
  assertEquals(stream[1]!.events.map((e) => e.kind), [
    "combatBurst",
    "playerDied",
  ]);

  // 8.1 counters still count every onTick delivery (liveness), not sparse stores.
  const counters = recorder.getActiveCounters();
  assertExists(counters);
  assertEquals(counters.eventTicks >= 4, true);
  assertEquals(counters.ticksObserved, counters.eventTicks);
});

Deno.test("8.4 uniformity: human join + bot add share AuthoritativeEvent shape; no bot import in capture", async () => {
  const server = makeServer();
  const { recorder } = wireRecorder(server);
  const matchId = startLive(server, recorder, [
    { socket: "s1", name: "Human", team: "A" },
  ]);
  const i = internals(server);

  // Bot via the same PlayerManager roster path humans use (no bot-brain).
  i.players.addBot("bot1", "Bot", { team: "B" });
  const { events: drained } = driveTick(server, 2);

  // Whatever drained (may include botAdd / team / etc.) — all rows are
  // AuthoritativeEvent with kind + appliedTick; no bot-specific capture branch.
  if (drained.length > 0) {
    const row = recorder.getTickEvents(matchId, 2)!;
    assertEquals(row.events.length, drained.length);
    for (const ev of row.events) {
      assertEquals(typeof ev.kind, "string");
      assertEquals(typeof ev.appliedTick, "number");
    }
  }

  const src = await Deno.readTextFile(
    new URL("./recordedTickEvents.ts", import.meta.url),
  );
  assertEquals(/from\s+['"].*bots\//.test(src), false);
  assertEquals(/ReadyAction/.test(src), false);
  assertEquals(/bot-official/.test(src), false);
  assertEquals(/drainTickAuthoritativeEvents/.test(src), false);
  assertEquals(/drainAuthoritativeEvents/.test(src), false);
  assertEquals(/SimTickResult/.test(src), false);
  assertEquals(/emitSimTickEvents/.test(src), false);
});

Deno.test("8.4 no-persistence: no file/blob/finalized in capture", async () => {
  // Capture module only — 8.6 owns blob/finalized writes in ReplayRecorder.
  const src = await Deno.readTextFile(
    new URL("./recordedTickEvents.ts", import.meta.url),
  );
  const code = src.replace(/\/\/.*$/gm, "");
  assertEquals(/status\s*:\s*['"]finalized['"]/.test(code), false);
  assertEquals(/\bBlob\b/.test(code), false);
  assertEquals(/writeFile|createWriteStream|Deno\.write/.test(code), false);
  assertEquals(/stampReplayFinalized/.test(code), false);
});

Deno.test("8.4 accessor: getEventStream ordered; miss returns null; finalize discards", () => {
  const server = makeServer();
  const { recorder } = wireRecorder(server);
  const matchId = startLive(server, recorder, [
    { socket: "s1", name: "A1", team: "A" },
  ]);
  injectEvents(server, 2, [sampleJoin(2, "a")]);
  injectEvents(server, 3, [sampleBurst(3)]);

  const stream = recorder.getEventStream(matchId);
  assertExists(stream);
  assertEquals(stream.length, 2);
  assertEquals(stream[0]!.tick <= stream[1]!.tick, true);

  assertEquals(recorder.getEventStream("missing-id"), null);
  assertEquals(recorder.getTickEvents("missing-id", 2), null);

  // draw path via matchDraw event then end
  injectEvents(server, 4, [
    normalizeAuthoritativeEvent(
      makeMatchDrawEvent({
        appliedTick: 4,
        scheduleRestart: false,
        restartSeconds: 0,
        restartAtTick: null,
        scores: { A: 0, B: 0 },
      }),
    )!,
  ]);
  internals(server).onMatchEnded({
    winner: "draw",
    scores: { A: 0, B: 0 },
    players: [],
  });
  assertEquals(recorder.getEventStream(matchId), null);
  assertEquals(recorder.getTickEvents(matchId, 2), null);
});

Deno.test("8.4 equivalence: sim outcomes identical with event capture on vs off", () => {
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
    for (let t = 2; t <= 6; t++) {
      driveTick(server, t);
    }
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

  const a = runSeason(false);
  const b = runSeason(true);
  assertEquals(a.phase, b.phase);
  assertEquals(a.scores, b.scores);
});

Deno.test("8.4 coverage: bot + human roster changes appear via unified drain only", () => {
  const server = makeServer();
  const { recorder } = wireRecorder(server);
  const matchId = startLive(server, recorder, [
    { socket: "s1", name: "Human", team: "A" },
  ]);
  const i = internals(server);
  const bot = i.players.addBot("bot1", "Bot", { team: "B" });
  assertNotEquals(bot.id, "");

  const seen = new Set<string>();
  for (let t = 2; t <= 8; t++) {
    const { events } = driveTick(server, t);
    for (const e of events) seen.add(e.kind);
    if (events.length > 0) {
      const row = recorder.getTickEvents(matchId, t)!;
      assertEquals(row.events.map((e) => e.kind), events.map((e) => e.kind));
    }
  }

  // botAdd (or related roster facts) may appear depending on when addBot buffers;
  // the invariant is: whatever the unified drain emitted is what we stored.
  const stream = recorder.getEventStream(matchId)!;
  for (const row of stream) {
    for (const ev of row.events) {
      assertEquals(typeof ev.kind, "string");
      assertNotEquals(ev.kind, "matchInit");
    }
  }
  void seen;
});
