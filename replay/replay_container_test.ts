/**
 * Epic 10.1 — replay container shape, validation, and exclusion scans.
 *
 * Run from server-community/:
 *   deno test -A replay/replay_container_test.ts
 */

import {
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertThrows,
} from "@std/assert";
import {
  emptyAuthoritativeRosterSnapshot,
  makeMatchInitEvent,
  makeMatchStartEvent,
  type MatchInitEvent,
} from "../shared/sim/authoritativeEvent.ts";
import { TICK_HZ } from "../shared/sim/game.ts";
import {
  buildMatchMetadata,
  REPLAY_FORMAT_VERSION,
  type MatchMetadata,
} from "../shared/replay/matchMetadata.ts";
import { GAME_PROTO } from "../shared/net/opcodes.ts";
import { PlayerManager } from "../players/PlayerManager.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";
import type { AuthoritativeCheckpoint } from "./authoritativeCheckpoint.ts";
import {
  captureCheckpointState,
  CHECKPOINT_SCHEMA_VERSION,
} from "./authoritativeCheckpoint.ts";
import type { RecordedInitialState } from "./recordedInitialState.ts";
import type { RecordedTickEvents } from "./recordedTickEvents.ts";
import type { RecordedTickInputs } from "./recordedTickInputs.ts";
import {
  buildReplayContainer,
  EMPTY_REPLAY_CONTAINER_INDEX,
  EMPTY_REPLAY_CONTAINER_INTEGRITY,
  REPLAY_CONTAINER_SECTION_ORDER,
  validateReplayContainer,
  type ReplayContainer,
} from "./replayContainer.ts";
import { isEmptyReplayContainerIndex } from "./replayIndex.ts";

const miniMap: DoorsMap = {
  name: "container-map",
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
    map: { name: "container-map", version: 1 },
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
      runtimeMatchId: "rt-container-1",
      serverName: "container-test",
      serverId: "srv-1",
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

function sampleRecordedInit(
  over?: Partial<RecordedInitialState>,
): RecordedInitialState {
  const init = sampleInit();
  const metadata = sampleMetadata(init);
  return {
    runtimeMatchId: metadata.runtimeMatchId,
    captureTick: init.appliedTick,
    init,
    metadata,
    ...over,
  };
}

function inputRow(tick: number): RecordedTickInputs {
  return { tick, movement: [], actions: [] };
}

function eventRow(
  tick: number,
  events: RecordedTickEvents["events"] = [],
): RecordedTickEvents {
  return { tick, events };
}

function sampleCheckpoint(
  tick: number,
  runtimeMatchId = "rt-container-1",
): AuthoritativeCheckpoint {
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    tick,
    runtimeMatchId,
    map: { name: "container-map", version: 1 },
    matchSeed: 42,
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
      doorCycleOriginTick: 10,
      doorsPowerUpUntilTick: null,
      raidDoorPolicy: "off",
      debugForceDoorsOpen: false,
      matchEndTick: 10 + 60 * TICK_HZ,
      matchDurationTicks: 60 * TICK_HZ,
      raid: { active: false },
    },
    players: [],
    projectiles: [],
  };
}

function buildHappy(over?: {
  init?: RecordedInitialState;
  inputs?: RecordedTickInputs[];
  events?: RecordedTickEvents[];
  checkpoints?: AuthoritativeCheckpoint[];
  firstTick?: number;
  lastTick?: number;
}): ReplayContainer {
  const init = over?.init ?? sampleRecordedInit();
  const inputs = over?.inputs ?? [inputRow(10), inputRow(11), inputRow(12)];
  const events = over?.events ?? [
    eventRow(10),
    eventRow(11, [
      makeMatchStartEvent({
        appliedTick: 11,
        phase: "live",
        matchSeed: init.init.matchSeed,
        matchEndTick: init.metadata.matchEndTick,
        doorCycleOriginTick: init.metadata.doorCycleOriginTick,
        scores: init.init.scores,
        roster: init.init.roster,
      }),
    ]),
    eventRow(12),
  ];
  return buildReplayContainer({
    init,
    inputRows: inputs,
    eventRows: events,
    checkpoints: over?.checkpoints ?? [],
    firstTick: over?.firstTick,
    lastTick: over?.lastTick,
  });
}

Deno.test("10.1 shape: section order constant locks seven+reserved layout", () => {
  assertEquals([...REPLAY_CONTAINER_SECTION_ORDER], [
    "header",
    "metadata",
    "initialState",
    "inputStream",
    "eventStream",
    "checkpoints",
    "index",
    "integrity",
  ]);
});

Deno.test("10.1 shape: happy container carries version 1 + reserved slots", () => {
  const c = buildHappy();
  assertEquals(c.header.replayFormatVersion, REPLAY_FORMAT_VERSION);
  assertEquals(c.header.replayFormatVersion, 1);
  assertEquals(c.header.tickRate, TICK_HZ);
  assertEquals(c.header.tickRate, 60);
  assertEquals(c.header.firstTick, 10);
  assertEquals(c.header.lastTick, 12);
  assertEquals(c.header.captureTick, 10);
  assertEquals(c.header.matchSeed, 42);
  assertEquals(c.header.map, { name: "container-map", version: 1 });
  assertEquals(c.metadata.gameProto, GAME_PROTO);
  assertEquals(c.metadata.capturedAtIso, "2026-01-01T00:00:00.000Z");
  assertEquals(c.initialState.init.kind, "matchInit");
  assertEquals(c.inputStream.length, 3);
  assertEquals(c.eventStream.length, 3);
  assertEquals(c.checkpoints, []);
  assertEquals(c.index, EMPTY_REPLAY_CONTAINER_INDEX);
  assertEquals(c.integrity, EMPTY_REPLAY_CONTAINER_INTEGRITY);
  assertEquals(isEmptyReplayContainerIndex(c.index), true);
  if (isEmptyReplayContainerIndex(c.index)) {
    assertEquals(c.index.entries.length, 0);
  }
  assertEquals(c.integrity.digest, null);
});

Deno.test("10.1 shape: checkpoints slot accepts ordered frames", () => {
  const c = buildHappy({
    checkpoints: [sampleCheckpoint(10), sampleCheckpoint(12)],
  });
  assertEquals(c.checkpoints.map((cp) => cp.tick), [10, 12]);
});

Deno.test("10.1 tick anchors: input rows cover every tick in range", () => {
  const c = buildHappy();
  assertEquals(c.inputStream.map((r) => r.tick), [10, 11, 12]);
  for (const row of c.eventStream) {
    for (const ev of row.events) {
      assertEquals(ev.appliedTick >= c.header.firstTick, true);
      assertEquals(ev.appliedTick <= c.header.lastTick, true);
    }
  }
});

Deno.test("10.1 freeze: mutating inputs after build does not alter container", () => {
  const inputs = [inputRow(10), inputRow(11)];
  const c = buildHappy({ inputs, events: [eventRow(10), eventRow(11)] });
  assertThrows(() => {
    (inputs as RecordedTickInputs[]).push(inputRow(12));
  });
  assertEquals(c.inputStream.length, 2);
  assertThrows(() => {
    (c.header as { lastTick: number }).lastTick = 99;
  });
});

Deno.test("10.1 verbatim: owner float precision preserved (not quantized)", () => {
  const pm = new PlayerManager(new MapCollision(miniMap), { matchSeed: 42 });
  const human = pm.add("h1", "Human", "A");
  pm.beginLiveMatch(10, 1_000);
  pm.drainAuthoritativeEvents();
  human.x = 1.234567890123;
  human.sprintStamina = 3.141592653589793;
  const cp = captureCheckpointState(pm, 10, "rt-container-1");
  // Align map name with sample init (capture uses collision map name).
  const init = sampleRecordedInit({
    init: sampleInit({ map: cp.map }),
    metadata: sampleMetadata(sampleInit({ map: cp.map })),
  });
  // Keep runtime ids aligned after metadata rebuild.
  const aligned: RecordedInitialState = {
    runtimeMatchId: "rt-container-1",
    captureTick: init.captureTick,
    init: { ...init.init, map: cp.map, matchSeed: cp.matchSeed },
    metadata: {
      ...init.metadata,
      runtimeMatchId: "rt-container-1",
      map: cp.map,
      matchSeed: cp.matchSeed,
    },
  };
  const c = buildHappy({
    init: aligned,
    inputs: [inputRow(10)],
    events: [eventRow(10)],
    checkpoints: [cp],
  });
  const player = c.checkpoints[0]!.players.find((p) => p.id === human.id)!;
  assertEquals(player.x, 1.234567890123);
  assertEquals(player.sprintStamina, 3.141592653589793);
  // Quantized snapshot path would typically round to fewer decimals.
  assertNotEquals(player.x, Math.round(player.x * 100) / 100);
});

Deno.test("10.1 boundary: missing header / initialState → loud failure", () => {
  const c = buildHappy();
  const noHeader = { ...c, header: undefined };
  const r1 = validateReplayContainer(noHeader);
  assertEquals(r1.ok, false);
  if (!r1.ok) assertMatch(r1.reason, /header/);

  const noInit = { ...c, initialState: undefined };
  const r2 = validateReplayContainer(noInit);
  assertEquals(r2.ok, false);
  if (!r2.ok) assertMatch(r2.reason, /initialState/);
});

Deno.test("10.1 boundary: empty checkpoints + empty index accepted", () => {
  const c = buildHappy({ checkpoints: [] });
  const r = validateReplayContainer(c);
  assertEquals(r.ok, true);
  assertEquals(isEmptyReplayContainerIndex(c.index), true);
  if (isEmptyReplayContainerIndex(c.index)) {
    assertEquals(c.index.entries.length, 0);
  }
});

Deno.test("10.1 boundary: unknown version → loud failure", () => {
  const c = buildHappy();
  const bad = {
    ...c,
    header: { ...c.header, replayFormatVersion: 99 as 1 },
  };
  const r = validateReplayContainer(bad);
  assertEquals(r.ok, false);
  if (!r.ok) assertMatch(r.reason, /replayFormatVersion/);
});

Deno.test("10.1 boundary: unsupported map version → loud failure", () => {
  const c = buildHappy();
  const bad = {
    ...c,
    header: {
      ...c.header,
      map: { name: "container-map", version: 9999 as 1 },
    },
  };
  const r = validateReplayContainer(bad);
  assertEquals(r.ok, false);
  if (!r.ok) assertMatch(r.reason, /map version/);
});

Deno.test("10.1 boundary: negative / non-integer tick → loud failure", () => {
  const c = buildHappy();
  const badFirst = {
    ...c,
    header: { ...c.header, firstTick: -1 },
  };
  const r1 = validateReplayContainer(badFirst);
  assertEquals(r1.ok, false);

  const badGap = buildHappy();
  const gap = {
    ...badGap,
    inputStream: [inputRow(10), inputRow(12)],
    eventStream: [eventRow(10), eventRow(12)],
    header: { ...badGap.header, lastTick: 12 },
  };
  const r2 = validateReplayContainer(gap);
  assertEquals(r2.ok, false);
  if (!r2.ok) assertMatch(r2.reason, /gap|cover/);
});

Deno.test("10.1 boundary: missing seed → loud failure", () => {
  const c = buildHappy();
  const bad = {
    ...c,
    header: { ...c.header, matchSeed: Number.NaN },
  };
  const r = validateReplayContainer(bad);
  assertEquals(r.ok, false);
  if (!r.ok) assertMatch(r.reason, /matchSeed/);
});

Deno.test("10.1 boundary: location fields rejected (SQL/blob separation)", () => {
  const c = buildHappy();
  for (const key of ["filePath", "url", "rowId"] as const) {
    const bad = { ...c, [key]: "/tmp/x.replay.json" };
    const r = validateReplayContainer(bad);
    assertEquals(r.ok, false);
    if (!r.ok) assertMatch(r.reason, /location/);
  }
});

Deno.test("10.1 boundary: empty inputs only for degenerate firstTick===lastTick", () => {
  const init = sampleRecordedInit();
  const c = buildReplayContainer({
    init,
    inputRows: [],
    eventRows: [],
    checkpoints: [],
    firstTick: init.captureTick,
    lastTick: init.captureTick,
  });
  assertEquals(c.inputStream.length, 0);
  assertEquals(c.header.firstTick, c.header.lastTick);

  assertThrows(() =>
    buildReplayContainer({
      init,
      inputRows: [],
      eventRows: [],
      firstTick: 10,
      lastTick: 12,
    })
  );
});

Deno.test("10.1 degenerate: build without overrides uses captureTick window", () => {
  const init = sampleRecordedInit();
  const c = buildReplayContainer({
    init,
    inputRows: [],
    eventRows: [],
  });
  assertEquals(c.header.firstTick, init.captureTick);
  assertEquals(c.header.lastTick, init.captureTick);
});

Deno.test("10.1 exclusion scan: container module has no net/fs/codec imports", async () => {
  const src = await Deno.readTextFile(
    new URL("./replayContainer.ts", import.meta.url),
  );
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assertEquals(/from\s+["'][^"']*\/net\//.test(code), false);
  assertEquals(/from\s+["'][^"']*shared\/network/.test(code), false);
  assertEquals(/Deno\.(read|write|open|mkdir|rename)/.test(code), false);
  assertEquals(/compress|deflate|gzip|brotli/i.test(code), false);
  assertEquals(/ReplayBlobStore|createStore|sqlite/i.test(code), false);
  // Encoding libs / binary codecs stay in 10.2.
  assertEquals(/from\s+["'][^"']*msgpack/.test(code), false);
});

Deno.test("10.1 exclusion: wire/wall-clock/location keys absent from sections", () => {
  const c = buildHappy();
  const json = JSON.stringify(c);
  for (const banned of [
    "PlayerInput",
    "ShootPacket",
    "MeleePacket",
    "liveStartedAtMs",
    "lastSequence",
    "filePath",
    "blobUrl",
  ]) {
    assertEquals(json.includes(banned), false, banned);
  }
});

Deno.test("10.1 version: REPLAY_FORMAT_VERSION reused (no second constant)", async () => {
  const src = await Deno.readTextFile(
    new URL("./replayContainer.ts", import.meta.url),
  );
  assertMatch(src, /REPLAY_FORMAT_VERSION/);
  assertMatch(src, /isSupportedReplayFormatVersion/);
  assertEquals(/REPLAY_CONTAINER_SCHEMA_VERSION/.test(src), false);
});

Deno.test("10.1 header/init agreement: drift fails validation", () => {
  const c = buildHappy();
  const bad = {
    ...c,
    header: { ...c.header, matchSeed: 999 },
  };
  const r = validateReplayContainer(bad);
  assertEquals(r.ok, false);
  if (!r.ok) assertMatch(r.reason, /matchSeed/);
});

Deno.test("10.1 integrity: non-null digest rejected in 10.1", () => {
  const c = buildHappy();
  const bad = {
    ...c,
    integrity: { schemaNote: "reserved-for-10.4" as const, digest: "abc" },
  };
  const r = validateReplayContainer(bad);
  assertEquals(r.ok, false);
  if (!r.ok) assertMatch(r.reason, /digest/);
});

Deno.test("10.1 appliedTick may precede input-stream firstTick", () => {
  const init = sampleRecordedInit();
  const c = buildReplayContainer({
    init,
    inputRows: [inputRow(10), inputRow(11)],
    eventRows: [
      eventRow(10, [
        {
          kind: "humanJoin",
          appliedTick: 0,
          playerId: "p1",
          name: "P1",
          team: "A",
          isBot: false,
          roster: init.init.roster,
        } as never,
      ]),
      eventRow(11),
    ],
  });
  assertEquals(c.header.firstTick, 10);
  assertEquals(c.eventStream[0]!.events[0]!.appliedTick, 0);
});

Deno.test("10.1 equivalence: building container does not change sim outcomes", () => {
  function run(buildEveryTick: boolean): { phase: string; scores: { A: number; B: number } } {
    const pm = new PlayerManager(new MapCollision(miniMap), { matchSeed: 7 });
    pm.add("h1", "H", "A");
    pm.beginLiveMatch(1, 1000);
    for (let t = 2; t <= 6; t++) {
      pm.drainAuthoritativeEvents();
      if (buildEveryTick) {
        const init = sampleRecordedInit({
          runtimeMatchId: "eq-1",
          captureTick: 1,
          init: sampleInit({ appliedTick: 1, matchSeed: 7 }),
          metadata: sampleMetadata(sampleInit({ appliedTick: 1, matchSeed: 7 }), {
            runtimeMatchId: "eq-1",
            matchSeed: 7,
            captureTick: 1,
          }),
        });
        // Pure build — read-only to live owners.
        buildReplayContainer({
          init,
          inputRows: [inputRow(t)],
          eventRows: [eventRow(t)],
          firstTick: t,
          lastTick: t,
        });
      }
    }
    return { phase: pm.getMatchPhase(), scores: pm.getScores() };
  }
  assertEquals(run(false), run(true));
});
