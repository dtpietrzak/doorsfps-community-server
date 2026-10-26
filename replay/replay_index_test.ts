/**
 * Epic 10.3 — replay file index (tables, builder, lookups, round-trip).
 *
 * Run from server-community/:
 *   deno test -A replay/replay_index_test.ts
 */

import {
  assertEquals,
  assertThrows,
} from "@std/assert";
import {
  emptyAuthoritativePose,
  emptyAuthoritativeRosterSnapshot,
  makeAgentAddEvent,
  makeAgentRemoveEvent,
  makeCombatBurstEvent,
  makeGameOverEvent,
  makeHumanJoinEvent,
  makeMatchDrawEvent,
  makeMatchEndEvent,
  makeMatchInitEvent,
  makeMatchStartEvent,
  makePlayerDiedEvent,
  makePlayerRemoveEvent,
  makePlayerRespawnedEvent,
  makeScoreEvent,
  type AuthoritativeEvent,
  type MatchInitEvent,
} from "../shared/sim/authoritativeEvent.ts";
import { TICK_HZ, TICK_MS } from "../shared/sim/game.ts";
import { buildMatchMetadata } from "../shared/replay/matchMetadata.ts";
import { CHECKPOINT_SCHEMA_VERSION } from "./authoritativeCheckpoint.ts";
import type { AuthoritativeCheckpoint } from "./authoritativeCheckpoint.ts";
import {
  buildReplayContainer,
  EMPTY_REPLAY_CONTAINER_INDEX,
  validateReplayContainer,
} from "./replayContainer.ts";
import {
  decodeReplayContainer,
  encodeReplayContainer,
} from "./replayEncoding.ts";
import {
  activityForPlayer,
  buildReplayIndex,
  findPriorCheckpointTick,
  findPriorCheckpointTickByTimeMs,
  isEmptyReplayContainerIndex,
  isFilledReplayIndex,
  markersAt,
  markersInRange,
  REPLAY_EVENT_TO_MARKER_KIND,
  REPLAY_INDEX_VERSION,
  ReplayIndexError,
  validateReplayIndex,
  type ReplayIndex,
} from "./replayIndex.ts";
import type { RecordedInitialState } from "./recordedInitialState.ts";
import { deepFreeze } from "./recordedInitialState.ts";
import type { RecordedTickEvents } from "./recordedTickEvents.ts";
import type { RecordedTickInputs } from "./recordedTickInputs.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function pose() {
  return emptyAuthoritativePose();
}

function roster(id: string, over?: { isBot?: boolean; isAgent?: boolean }) {
  return emptyAuthoritativeRosterSnapshot({
    id,
    name: id,
    team: "A",
    isBot: over?.isBot ?? false,
    isAgent: over?.isAgent ?? false,
  });
}

function inputRow(
  tick: number,
  playerIds: string[] = ["p1"],
): RecordedTickInputs {
  return {
    tick,
    movement: playerIds.map((playerId, i) => ({
      tick,
      playerId,
      association: "fresh" as const,
      appliedSequence: i + 1,
      inputHoldTicks: 1,
      selectedInput: {
        sequence: i + 1,
        forward: true,
        backward: false,
        left: false,
        right: false,
        jump: false,
        sprint: false,
        crouch: false,
        meleeLunge: false,
        yaw: 0.5,
        pitch: 0,
      },
    })),
    actions: [],
  };
}

function eventRow(
  tick: number,
  events: AuthoritativeEvent[] = [],
): RecordedTickEvents {
  return { tick, events };
}

function sampleCheckpoint(tick: number): AuthoritativeCheckpoint {
  return deepFreeze({
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    tick,
    runtimeMatchId: "rt-index-1",
    map: { name: "index-map", version: 1 },
    matchSeed: 7,
    rng: {
      damage: 0,
      spread: 0,
      spawn: 0,
      agents: 0,
      collisionSpawn: 0,
    },
    match: {
      scores: { A: 0, B: 0 },
      matchOver: false,
      inPrematch: false,
      restartAtTick: null,
      doorCycleOriginTick: 0,
      doorsPowerUpUntilTick: null,
      raidDoorPolicy: "off",
      debugForceDoorsOpen: false,
      matchEndTick: 1000,
      matchDurationTicks: 1000,
      raid: { active: false },
    },
    players: [],
    projectiles: [],
  }) as AuthoritativeCheckpoint;
}

function sampleRecordedInit(): RecordedInitialState {
  const init: MatchInitEvent = makeMatchInitEvent({
    appliedTick: 0,
    map: { name: "index-map", version: 1 },
    matchSeed: 7,
    matchDurationTicks: 1000,
    prematchEnabled: true,
    phase: "prematch",
    raidDoorPolicy: "off",
    debugForceDoorsOpen: false,
    scores: { A: 0, B: 0 },
    roster: [roster("p1")],
  });
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
      runtimeMatchId: "rt-index-1",
      serverName: "index-test",
      serverId: "srv-i",
      modeId: "standard",
      raidId: null,
      buildSha: "abc",
      raidMatch: { active: false },
    },
    { capturedAtIso: "2026-01-01T00:00:00.000Z" },
  );
  if (!built.ok) throw new Error(built.reason);
  return deepFreeze({
    runtimeMatchId: "rt-index-1",
    captureTick: init.appliedTick,
    init,
    metadata: built.metadata,
  }) as RecordedInitialState;
}

function seasonStreams(): {
  inputs: RecordedTickInputs[];
  events: RecordedTickEvents[];
  checkpoints: AuthoritativeCheckpoint[];
  firstTick: number;
  lastTick: number;
} {
  const firstTick = 10;
  const lastTick = 50;
  // Contiguous input window required by 10.1 container validation.
  const inputs: RecordedTickInputs[] = [];
  for (let t = firstTick; t <= lastTick; t++) {
    const players = t < 15 || t >= 48 ? ["p1"] : ["p1", "p2"];
    inputs.push(inputRow(t, players));
  }
  const events = [
    eventRow(10, [
      makeMatchStartEvent({
        appliedTick: 10,
        phase: "live",
        matchSeed: 7,
        matchEndTick: 1000,
        doorCycleOriginTick: 0,
        scores: { A: 0, B: 0 },
        roster: [roster("p1")],
      }),
    ]),
    eventRow(15, [
      makeHumanJoinEvent({ appliedTick: 15, player: roster("p2") }),
    ]),
    eventRow(22, [
      makePlayerDiedEvent({
        appliedTick: 22,
        victimId: "p2",
        killerId: "p1",
        zone: "body",
        weapon: 1,
        killerName: "p1",
        victimName: "p2",
        killerTeam: "A",
        victimTeam: "B",
      }),
      makeCombatBurstEvent({
        appliedTick: 22,
        outcomes: [],
      }),
    ]),
    eventRow(25, [
      makePlayerRespawnedEvent({
        appliedTick: 25,
        player: roster("p2"),
      }),
    ]),
    eventRow(28, [
      makeScoreEvent({
        appliedTick: 28,
        scorerId: "p1",
        team: "A",
        scores: { A: 1, B: 0 },
        playerPose: pose(),
        playerAlive: true,
      }),
    ]),
    eventRow(32, [
      makeAgentAddEvent({ appliedTick: 32, player: roster("a1", { isAgent: true }) }),
    ]),
    eventRow(35, [
      makeAgentRemoveEvent(35, "a1"),
    ]),
    eventRow(45, [
      makeMatchEndEvent({
        appliedTick: 45,
        winner: "A",
        scheduleRestart: true,
        restartSeconds: 5,
        restartAtTick: 50,
        scores: { A: 1, B: 0 },
      }),
      makeGameOverEvent({
        appliedTick: 45,
        winner: "A",
        scores: { A: 1, B: 0 },
        restartInSeconds: 5,
      }),
    ]),
    eventRow(48, [
      makePlayerRemoveEvent(48, "p2"),
    ]),
  ];
  const checkpoints = [
    sampleCheckpoint(10),
    sampleCheckpoint(30),
    sampleCheckpoint(50),
  ];
  return { inputs, events, checkpoints, firstTick, lastTick };
}

function buildSeasonIndex(): ReplayIndex {
  const s = seasonStreams();
  return buildReplayIndex({
    inputRows: s.inputs,
    eventRows: s.events,
    checkpoints: s.checkpoints,
    firstTick: s.firstTick,
    lastTick: s.lastTick,
    initialPhase: "prematch",
  });
}

// ---------------------------------------------------------------------------
// Version + taxonomy
// ---------------------------------------------------------------------------

Deno.test("10.3 version: filled index carries REPLAY_INDEX_VERSION = 1", () => {
  const index = buildSeasonIndex();
  assertEquals(index.indexVersion, REPLAY_INDEX_VERSION);
  assertEquals(REPLAY_INDEX_VERSION, 1);
  assertEquals(validateReplayIndex(index).ok, true);
});

Deno.test("10.3 taxonomy: closed event→marker map covers replay.md categories", () => {
  assertEquals(REPLAY_EVENT_TO_MARKER_KIND.playerDied, "death");
  assertEquals(REPLAY_EVENT_TO_MARKER_KIND.score, "doorCapture");
  assertEquals(REPLAY_EVENT_TO_MARKER_KIND.matchStart, "phaseChange");
  assertEquals(REPLAY_EVENT_TO_MARKER_KIND.matchEnd, "phaseChange");
  assertEquals(REPLAY_EVENT_TO_MARKER_KIND.matchDraw, "phaseChange");
  assertEquals(REPLAY_EVENT_TO_MARKER_KIND.gameOver, "phaseChange");
  assertEquals(REPLAY_EVENT_TO_MARKER_KIND.humanJoin, "roster");
  assertEquals(REPLAY_EVENT_TO_MARKER_KIND.botAdd, "roster");
  assertEquals(REPLAY_EVENT_TO_MARKER_KIND.playerRemove, "roster");
  assertEquals(REPLAY_EVENT_TO_MARKER_KIND.playerRespawned, "roster");
  assertEquals(REPLAY_EVENT_TO_MARKER_KIND.agentAdd, "agent");
  assertEquals(REPLAY_EVENT_TO_MARKER_KIND.agentRemove, "agent");
  // Budget exclusion: combatBurst is not a marker kind.
  assertEquals(REPLAY_EVENT_TO_MARKER_KIND.combatBurst, undefined);
});

Deno.test("10.3 taxonomy: season markers include death/doorCapture/phase/roster/agent; no combatBurst", () => {
  const index = buildSeasonIndex();
  const kinds = new Set(index.markers.map((m) => m.markerKind));
  assertEquals(kinds.has("death"), true);
  assertEquals(kinds.has("doorCapture"), true);
  assertEquals(kinds.has("phaseChange"), true);
  assertEquals(kinds.has("roster"), true);
  assertEquals(kinds.has("agent"), true);

  assertEquals(index.markers.some((m) => m.eventKind === "combatBurst"), false);
  assertEquals(
    index.markers.filter((m) => m.eventKind === "playerDied").length,
    1,
  );
  assertEquals(
    index.markers.filter((m) => m.eventKind === "score").length,
    1,
  );
  const death = index.markers.find((m) => m.eventKind === "playerDied")!;
  assertEquals(death.tick, 22);
  assertEquals(death.involvedPlayerIds, ["p2", "p1"]);
  const door = index.markers.find((m) => m.eventKind === "score")!;
  assertEquals(door.markerKind, "doorCapture");
  assertEquals(door.involvedPlayerIds, ["p1"]);
});

// ---------------------------------------------------------------------------
// Derivation / rebuildability
// ---------------------------------------------------------------------------

Deno.test("10.3 derivation: checkpoint ticks match section; rebuild deep-equals", () => {
  const s = seasonStreams();
  const index = buildReplayIndex({
    inputRows: s.inputs,
    eventRows: s.events,
    checkpoints: s.checkpoints,
    firstTick: s.firstTick,
    lastTick: s.lastTick,
    initialPhase: "prematch",
  });
  assertEquals(
    [...index.checkpoints],
    s.checkpoints.map((c) => c.tick),
  );

  const rebuilt = buildReplayIndex({
    inputRows: s.inputs,
    eventRows: s.events,
    checkpoints: s.checkpoints,
    firstTick: s.firstTick,
    lastTick: s.lastTick,
    initialPhase: "prematch",
  });
  assertEquals(rebuilt, index);
});

Deno.test("10.3 order: checkpoints ascending; markers drain-ordered; phases gapless", () => {
  const index = buildSeasonIndex();
  for (let i = 1; i < index.checkpoints.length; i++) {
    assertEquals(index.checkpoints[i]! > index.checkpoints[i - 1]!, true);
  }
  for (let i = 1; i < index.markers.length; i++) {
    assertEquals(index.markers[i]!.tick >= index.markers[i - 1]!.tick, true);
  }
  // Same-tick drain order at 45: matchEnd then gameOver.
  const at45 = markersAt(index, 45);
  assertEquals(at45.map((m) => m.eventKind), ["matchEnd", "gameOver"]);

  assertEquals(index.phases.length >= 1, true);
  for (let i = 1; i < index.phases.length; i++) {
    assertEquals(
      index.phases[i]!.startTick,
      index.phases[i - 1]!.endTick + 1,
    );
  }
  assertEquals(index.phases[0]!.startTick, 10);
  assertEquals(index.phases[index.phases.length - 1]!.endTick, 50);
});

Deno.test("10.3 phases: prematch→live→gameOver (matchEnd+gameOver same tick)", () => {
  const index = buildSeasonIndex();
  // matchStart at 10 with initialPhase prematch but firstTick=10 → live from 10
  // (same-tick replace of prematch→live at span start).
  const phases = index.phases.map((p) => p.phase);
  assertEquals(phases.includes("live"), true);
  assertEquals(phases.includes("gameOver"), true);
  // Terminal phase starts at matchEnd/gameOver tick 45.
  const terminal = index.phases.find((p) => p.phase === "gameOver")!;
  assertEquals(terminal.startTick, 45);
  assertEquals(terminal.endTick, 50);
});

Deno.test("10.3 phases: draw variant from matchDraw", () => {
  const index = buildReplayIndex({
    inputRows: [inputRow(0), inputRow(10)],
    eventRows: [
      eventRow(0, [
        makeMatchStartEvent({
          appliedTick: 0,
          phase: "live",
          matchSeed: 1,
          matchEndTick: 100,
          doorCycleOriginTick: 0,
          scores: { A: 0, B: 0 },
          roster: [roster("p1")],
        }),
      ]),
      eventRow(10, [
        makeMatchDrawEvent({
          appliedTick: 10,
          scheduleRestart: false,
          restartSeconds: 0,
          restartAtTick: null,
          scores: { A: 0, B: 0 },
        }),
      ]),
    ],
    checkpoints: [],
    firstTick: 0,
    lastTick: 10,
    initialPhase: "live",
  });
  assertEquals(index.phases.map((p) => p.phase), ["live", "draw"]);
  assertEquals(index.phases[1]!.startTick, 10);
});

// ---------------------------------------------------------------------------
// Player activity
// ---------------------------------------------------------------------------

Deno.test("10.3 activity: input presence + roster/agent events; never-input agent", () => {
  const index = buildSeasonIndex();
  const p1 = activityForPlayer(index, "p1")!;
  assertEquals(p1.ticksPresent > 0, true);
  assertEquals(p1.firstTick, 10);
  assertEquals(p1.lastTick, 50);

  const p2 = activityForPlayer(index, "p2")!;
  assertEquals(p2.firstTick, 15); // join event before first input
  assertEquals(p2.ticksPresent >= 1, true);

  const a1 = activityForPlayer(index, "a1")!;
  assertEquals(a1.ticksPresent, 0); // agent never in input rows
  assertEquals(a1.firstTick, 32);
  assertEquals(a1.lastTick, 35);

  assertEquals(activityForPlayer(index, "missing"), null);
});

// ---------------------------------------------------------------------------
// Floor / lookups (9.5 parity)
// ---------------------------------------------------------------------------

Deno.test("10.3 floor: exact / mid / before-first / after-last / empty", () => {
  const index = buildSeasonIndex();
  assertEquals(findPriorCheckpointTick(index, 10), { kind: "hit", tick: 10 });
  assertEquals(findPriorCheckpointTick(index, 30), { kind: "hit", tick: 30 });
  assertEquals(findPriorCheckpointTick(index, 35), { kind: "hit", tick: 30 });
  assertEquals(findPriorCheckpointTick(index, 50), { kind: "hit", tick: 50 });
  assertEquals(findPriorCheckpointTick(index, 999), { kind: "hit", tick: 50 });
  assertEquals(findPriorCheckpointTick(index, 9), {
    kind: "miss",
    reason: "before-first",
  });

  const empty = buildReplayIndex({
    inputRows: [],
    eventRows: [],
    checkpoints: [],
    firstTick: 0,
    lastTick: 0,
  });
  assertEquals(findPriorCheckpointTick(empty, 0), {
    kind: "miss",
    reason: "empty",
  });
});

Deno.test("10.3 floor: timeMs converts then floors identically", () => {
  const index = buildSeasonIndex();
  // tick 35 → prior cp 30; time for tick 35 = 35 * TICK_MS
  const byTick = findPriorCheckpointTick(index, 35);
  const byTime = findPriorCheckpointTickByTimeMs(index, 35 * TICK_MS);
  assertEquals(byTime, byTick);
  // Sub-tick time still floors to same tick.
  const mid = findPriorCheckpointTickByTimeMs(
    index,
    35 * TICK_MS + (TICK_MS - 1),
  );
  assertEquals(mid, byTick);
  assertEquals(TICK_HZ, 60);
});

Deno.test("10.3 lookups: markersAt / markersInRange / loud bad ticks", () => {
  const index = buildSeasonIndex();
  assertEquals(markersAt(index, 22).map((m) => m.eventKind), ["playerDied"]);
  const range = markersInRange(index, 20, 30);
  assertEquals(range.some((m) => m.eventKind === "playerDied"), true);
  assertEquals(range.some((m) => m.eventKind === "score"), true);
  assertEquals(range.some((m) => m.tick > 30), false);

  assertThrows(
    () => findPriorCheckpointTick(index, -1),
    ReplayIndexError,
  );
  assertThrows(
    () => findPriorCheckpointTick(index, 1.5),
    ReplayIndexError,
  );
  assertThrows(
    () => markersInRange(index, 10, 5),
    ReplayIndexError,
  );
});

// ---------------------------------------------------------------------------
// Empty-valid + freeze + exclusions
// ---------------------------------------------------------------------------

Deno.test("10.3 empty-valid: no checkpoints / no events / single-tick", () => {
  const a = buildReplayIndex({
    inputRows: [],
    eventRows: [],
    checkpoints: [],
    firstTick: 0,
    lastTick: 0,
  });
  assertEquals(a.checkpoints.length, 0);
  assertEquals(a.markers.length, 0);
  assertEquals(a.phases, [{ phase: "prematch", startTick: 0, endTick: 0 }]);
  assertEquals(validateReplayIndex(a).ok, true);

  const b = buildReplayIndex({
    inputRows: [inputRow(5)],
    eventRows: [],
    checkpoints: [],
    firstTick: 5,
    lastTick: 5,
    initialPhase: "live",
  });
  assertEquals(b.phases, [{ phase: "live", startTick: 5, endTick: 5 }]);
  assertEquals(activityForPlayer(b, "p1")?.ticksPresent, 1);
});

Deno.test("10.3 freeze: mutating inputs after build does not alter index", () => {
  const inputs = [inputRow(1, ["p1"])];
  const events: RecordedTickEvents[] = [
    eventRow(1, [
      makeHumanJoinEvent({ appliedTick: 1, player: roster("p2") }),
    ]),
  ];
  const checkpoints = [sampleCheckpoint(1)];
  const index = buildReplayIndex({
    inputRows: inputs,
    eventRows: events,
    checkpoints,
    firstTick: 1,
    lastTick: 1,
  });
  const before = structuredClone(index);
  (inputs as RecordedTickInputs[]).push(inputRow(2, ["p1"]));
  (events as RecordedTickEvents[]).push(
    eventRow(2, [
      makePlayerDiedEvent({
        appliedTick: 2,
        victimId: "p1",
        killerId: "p2",
        zone: "head",
        weapon: 0,
        killerName: "p2",
        victimName: "p1",
        killerTeam: "B",
        victimTeam: "A",
      }),
    ]),
  );
  assertEquals(index, before);
  assertEquals(Object.isFrozen(index), true);
  assertThrows(() => {
    (index as unknown as { checkpoints: number[] }).checkpoints.push(99);
  });
});

Deno.test("10.3 exclusion: no byte-offset/hash/location fields; module import scan", async () => {
  const index = buildSeasonIndex();
  const json = JSON.stringify(index);
  for (const banned of [
    "byteOffset",
    "byte_offset",
    "filePath",
    "blobUrl",
    "sha256",
    "checksum",
    "lastSequence",
    "liveStartedAtMs",
  ]) {
    assertEquals(json.includes(banned), false, banned);
  }

  const src = await Deno.readTextFile(
    new URL("./replayIndex.ts", import.meta.url),
  );
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assertEquals(/\bDeno\./.test(code), false);
  assertEquals(/from\s+["'].*ReplayBlobStore/.test(code), false);
  assertEquals(/from\s+["'].*\/db\//.test(code), false);
  assertEquals(/from\s+["'].*\/net\//.test(code), false);
  assertEquals(/createHash|CompressionStream|encodeReplayContainer/.test(code), false);
});

Deno.test("10.3 version: unknown indexVersion → loud failure", () => {
  const index = buildSeasonIndex();
  const bad = { ...index, indexVersion: 99 };
  const r = validateReplayIndex(bad);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(/indexVersion/.test(r.reason), true);
});

// ---------------------------------------------------------------------------
// Container + codec round-trip
// ---------------------------------------------------------------------------

Deno.test("10.3 round-trip: container with filled index survives decode(encode)", () => {
  const s = seasonStreams();
  const init = sampleRecordedInit();
  const index = buildReplayIndex({
    inputRows: s.inputs,
    eventRows: s.events,
    checkpoints: s.checkpoints,
    firstTick: s.firstTick,
    lastTick: s.lastTick,
    initialPhase: "prematch",
  });
  const c = buildReplayContainer({
    init,
    inputRows: s.inputs,
    eventRows: s.events,
    checkpoints: s.checkpoints,
    index,
    firstTick: s.firstTick,
    lastTick: s.lastTick,
  });
  assertEquals(isFilledReplayIndex(c.index), true);
  const decoded = decodeReplayContainer(encodeReplayContainer(c));
  assertEquals(decoded, c);
  assertEquals(decoded.index, index);

  // Rebuild-dropped-index deep-equals.
  const rebuilt = buildReplayIndex({
    inputRows: decoded.inputStream,
    eventRows: decoded.eventStream,
    checkpoints: decoded.checkpoints,
    firstTick: decoded.header.firstTick,
    lastTick: decoded.header.lastTick,
    initialPhase: decoded.header.phase,
  });
  assertEquals(rebuilt, decoded.index);
});

Deno.test("10.3 round-trip: 10.1 empty-index files still accepted", () => {
  const init = sampleRecordedInit();
  const c = buildReplayContainer({
    init,
    inputRows: [inputRow(0)],
    eventRows: [],
    checkpoints: [],
    index: EMPTY_REPLAY_CONTAINER_INDEX,
    firstTick: 0,
    lastTick: 0,
  });
  assertEquals(isEmptyReplayContainerIndex(c.index), true);
  const r = validateReplayContainer(c);
  assertEquals(r.ok, true);
  const decoded = decodeReplayContainer(encodeReplayContainer(c));
  assertEquals(isEmptyReplayContainerIndex(decoded.index), true);
  assertEquals(decoded.index, EMPTY_REPLAY_CONTAINER_INDEX);
});

Deno.test("10.3 container validate: filled index checkpoint mismatch rejected", () => {
  const init = sampleRecordedInit();
  const inputs = [inputRow(10), inputRow(11), inputRow(12)];
  const cps = [sampleCheckpoint(10), sampleCheckpoint(12)];
  const index = buildReplayIndex({
    inputRows: inputs,
    eventRows: [],
    checkpoints: cps,
    firstTick: 10,
    lastTick: 12,
  });
  const badIndex = deepFreeze({
    ...index,
    checkpoints: [10, 99],
  }) as ReplayIndex;
  const r = validateReplayContainer({
    ...buildReplayContainer({
      init,
      inputRows: inputs,
      eventRows: [],
      checkpoints: cps,
      firstTick: 10,
      lastTick: 12,
    }),
    index: badIndex,
  });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(/checkpoints/.test(r.reason), true);
});

Deno.test("10.3 equivalence probe: building index does not alter stream payloads", () => {
  const s = seasonStreams();
  const inputsBefore = structuredClone(s.inputs);
  const eventsBefore = structuredClone(s.events);
  buildReplayIndex({
    inputRows: s.inputs,
    eventRows: s.events,
    checkpoints: s.checkpoints,
    firstTick: s.firstTick,
    lastTick: s.lastTick,
  });
  buildReplayIndex({
    inputRows: s.inputs,
    eventRows: s.events,
    checkpoints: s.checkpoints,
    firstTick: s.firstTick,
    lastTick: s.lastTick,
  });
  assertEquals(s.inputs, inputsBefore);
  assertEquals(s.events, eventsBefore);
});
