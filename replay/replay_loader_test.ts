/**
 * Epic 11.1 — replay loader: load, accessors, density, floor, rejection, freeze.
 *
 * Run from server-community/:
 *   deno test -A replay/replay_loader_test.ts
 */

import {
  assertEquals,
  assertNotEquals,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import {
  emptyAuthoritativeRosterSnapshot,
  makeMatchInitEvent,
  makeMatchStartEvent,
  type MatchInitEvent,
} from "../shared/sim/authoritativeEvent.ts";
import { TICK_HZ, TICK_MS } from "../shared/sim/game.ts";
import {
  buildMatchMetadata,
  type MatchMetadata,
} from "../shared/replay/matchMetadata.ts";
import {
  REPLAY_FORMAT_VERSION,
  ReplayFormatVersionError,
} from "../shared/replay/replayFormatVersion.ts";
import type { AuthoritativeCheckpoint } from "./authoritativeCheckpoint.ts";
import { CHECKPOINT_SCHEMA_VERSION } from "./authoritativeCheckpoint.ts";
import {
  CheckpointIndex,
  tickToTimeMs,
  timeMsToTick,
} from "./checkpointIndex.ts";
import type { RecordedInitialState } from "./recordedInitialState.ts";
import { REPLAY_RNG_CONSTRUCTION_RULE } from "./recordedInitialState.ts";
import { EMPTY_RECORDED_EVENTS } from "./recordedTickEvents.ts";
import type { RecordedTickEvents } from "./recordedTickEvents.ts";
import type { RecordedTickInputs } from "./recordedTickInputs.ts";
import {
  buildReplayContainer,
  EMPTY_REPLAY_CONTAINER_INDEX,
  EMPTY_REPLAY_CONTAINER_INTEGRITY,
  type ReplayContainer,
} from "./replayContainer.ts";
import {
  encodeReplayContainer,
  ReplayEncodingError,
} from "./replayEncoding.ts";
import {
  buildReplayIndex,
  isEmptyReplayContainerIndex,
} from "./replayIndex.ts";
import {
  isLoadedReplay,
  loadReplay,
} from "./replayLoader.ts";
import { parseProvisionalReplayFile } from "./serializeReplaySession.ts";

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
    map: { name: "loader-map", version: 1 },
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
      runtimeMatchId: "rt-loader-1",
      serverName: "loader-test",
      serverId: "srv-loader",
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

function inputRow(tick: number, yaw = 1.234567890123): RecordedTickInputs {
  return {
    tick,
    movement: [
      {
        tick,
        playerId: "p1",
        association: "fresh",
        appliedSequence: 1,
        inputHoldTicks: 1,
        selectedInput: {
          sequence: 1,
          forward: true,
          backward: false,
          left: false,
          right: false,
          jump: false,
          sprint: false,
          crouch: false,
          meleeLunge: false,
          yaw,
          pitch: -0.125,
        },
      },
    ],
    actions: [],
  };
}

function eventRow(
  tick: number,
  events: RecordedTickEvents["events"] = [],
): RecordedTickEvents {
  return { tick, events };
}

function sampleCheckpoint(tick: number): AuthoritativeCheckpoint {
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    tick,
    runtimeMatchId: "rt-loader-1",
    map: { name: "loader-map", version: 1 },
    matchSeed: 42,
    rng: {
      damage: 1,
      spread: 2,
      spawn: 3,
      agents: 4,
      collisionSpawn: 5,
    },
    match: {
      scores: { A: 1, B: 0 },
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
  withIndex?: boolean;
}): ReplayContainer {
  const init = over?.init ?? sampleRecordedInit();
  const inputs = over?.inputs ?? [inputRow(10), inputRow(11), inputRow(12)];
  const events = over?.events ?? [
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
  ];
  const checkpoints = over?.checkpoints ?? [
    sampleCheckpoint(10),
    sampleCheckpoint(12),
  ];
  const firstTick = over?.firstTick;
  const lastTick = over?.lastTick;
  const container = buildReplayContainer({
    init,
    inputRows: inputs,
    eventRows: events,
    checkpoints,
    firstTick,
    lastTick,
  });
  if (!over?.withIndex) return container;
  const index = buildReplayIndex({
    inputRows: inputs,
    eventRows: events,
    checkpoints,
    firstTick: container.header.firstTick,
    lastTick: container.header.lastTick,
    initialPhase: container.header.phase,
  });
  return buildReplayContainer({
    init,
    inputRows: inputs,
    eventRows: events,
    checkpoints,
    index,
    firstTick: container.header.firstTick,
    lastTick: container.header.lastTick,
  });
}

function loadHappy(
  over?: Parameters<typeof buildHappy>[0],
): ReturnType<typeof loadReplay> {
  return loadReplay(encodeReplayContainer(buildHappy(over)));
}

function assertEncodingError(
  fn: () => unknown,
  code: ReplayEncodingError["code"],
): ReplayEncodingError {
  const err = assertThrows(fn, ReplayEncodingError) as ReplayEncodingError;
  assertEquals(err.code, code);
  return err;
}

function assertVersionMismatch(fn: () => unknown): void {
  try {
    fn();
    throw new Error("expected version mismatch");
  } catch (e) {
    if (e instanceof ReplayFormatVersionError) {
      assertEquals(e.code, "replay-version-mismatch");
      return;
    }
    if (e instanceof ReplayEncodingError) {
      assertEquals(e.code, "replay-version-mismatch");
      return;
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Load / section accessors
// ---------------------------------------------------------------------------

Deno.test("11.1 load: every section reachable with documented types", () => {
  const session = loadHappy({ withIndex: true });
  assertEquals(isLoadedReplay(session), true);
  assertEquals(session.header.replayFormatVersion, REPLAY_FORMAT_VERSION);
  assertEquals(session.header.runtimeMatchId, "rt-loader-1");
  assertEquals(session.firstTick, 10);
  assertEquals(session.lastTick, 12);
  assertEquals(session.tickRate, TICK_HZ);
  assertEquals(session.header.tickRate, 60);
  assertEquals(session.header.matchSeed, 42);
  assertEquals(session.header.map, { name: "loader-map", version: 1 });
  assertEquals(session.initialState.captureTick, 10);
  assertEquals(session.initialState.init.appliedTick, session.initialState.captureTick);
  assertEquals(session.rngConstructionRule, REPLAY_RNG_CONSTRUCTION_RULE);
  assertEquals(session.integrityStatus, "unverified");
  assertEquals(session.integrity, EMPTY_REPLAY_CONTAINER_INTEGRITY);
  assertEquals(session.metadata.serverName, "loader-test");
  assertEquals(session.container.header, session.header);
});

Deno.test("11.1 load: dense inputs cover every tick; events preserve drain order", () => {
  const session = loadHappy();
  for (let t = session.firstTick; t <= session.lastTick; t++) {
    const row = session.inputAt(t);
    assertEquals(row.tick, t);
    assertEquals(row.movement.length, 1);
    assertEquals(row.movement[0]!.playerId, "p1");
  }
  // Sparse: tick 10 has no events row → shared empty.
  const empty = session.eventsAt(10);
  assertStrictEquals(empty, EMPTY_RECORDED_EVENTS);
  assertEquals(empty.length, 0);
  // Tick 11 has matchStart in drain order.
  const at11 = session.eventsAt(11);
  assertEquals(at11.length, 1);
  assertEquals(at11[0]!.kind, "matchStart");
  assertEquals(at11[0]!.appliedTick, 11);
});

Deno.test("11.1 load: checkpoints ordered; index deep-equals file index", () => {
  const container = buildHappy({ withIndex: true });
  const session = loadReplay(encodeReplayContainer(container));
  assertEquals(session.index, container.index);
  assertEquals(isEmptyReplayContainerIndex(session.index), false);

  const emptySession = loadHappy({ withIndex: false });
  assertEquals(isEmptyReplayContainerIndex(emptySession.index), true);
  assertEquals(emptySession.markersAt(10), []);
  assertEquals(emptySession.findPriorCheckpointTick(10), {
    kind: "miss",
    reason: "empty",
  });
});

Deno.test("11.1 load: empty-reserved index accepted", () => {
  const session = loadHappy({ checkpoints: [] });
  assertEquals(session.index, EMPTY_REPLAY_CONTAINER_INDEX);
  assertEquals(session.findPriorCheckpoint(10).kind, "miss");
});

// ---------------------------------------------------------------------------
// Density asymmetry
// ---------------------------------------------------------------------------

Deno.test("11.1 density: punched input tick → loud load failure naming the tick", () => {
  const base = JSON.parse(
    new TextDecoder().decode(encodeReplayContainer(buildHappy())),
  ) as Record<string, unknown>;
  // Drop middle input tick 11; leave first/last so gap is obvious.
  base.inputStream = [inputRow(10), inputRow(12)];
  const err = assertEncodingError(
    () => loadReplay(new TextEncoder().encode(JSON.stringify(base))),
    "replay-bad-tick",
  );
  assertEquals(/11/.test(err.message) || /gap|cover/i.test(err.message), true);
});

Deno.test("11.1 density: event-sparse tick → shared frozen empty, not an error", () => {
  const session = loadHappy({
    events: [eventRow(12, [])], // only last tick stored; 10 and 11 sparse
  });
  const a = session.eventsAt(10);
  const b = session.eventsAt(11);
  assertStrictEquals(a, EMPTY_RECORDED_EVENTS);
  assertStrictEquals(b, EMPTY_RECORDED_EVENTS);
  assertEquals(session.eventsAt(12), []);
});

Deno.test("11.1 density: out-of-range accessor queries fail loud", () => {
  const session = loadHappy();
  assertEncodingError(() => session.inputAt(9), "replay-bad-tick");
  assertEncodingError(() => session.inputAt(13), "replay-bad-tick");
  assertEncodingError(() => session.eventsAt(-1), "replay-bad-tick");
  assertEncodingError(() => session.inputAt(10.5), "replay-bad-tick");
});

// ---------------------------------------------------------------------------
// Checkpoint floor (9.5 parity)
// ---------------------------------------------------------------------------

Deno.test("11.1 floor: exact → self; mid → prior; before-first → miss; at/after-last → last", () => {
  const session = loadHappy({
    checkpoints: [sampleCheckpoint(10), sampleCheckpoint(12)],
  });

  const exact = session.findPriorCheckpoint(10);
  assertEquals(exact.kind, "hit");
  if (exact.kind === "hit") assertEquals(exact.frame.tick, 10);

  const mid = session.findPriorCheckpoint(11);
  assertEquals(mid.kind, "hit");
  if (mid.kind === "hit") assertEquals(mid.frame.tick, 10);

  const before = session.findPriorCheckpoint(9);
  assertEquals(before, { kind: "miss", reason: "before-first" });

  const atLast = session.findPriorCheckpoint(12);
  assertEquals(atLast.kind, "hit");
  if (atLast.kind === "hit") assertEquals(atLast.frame.tick, 12);

  const afterLast = session.findPriorCheckpoint(100);
  assertEquals(afterLast.kind, "hit");
  if (afterLast.kind === "hit") assertEquals(afterLast.frame.tick, 12);

  // Exact accessor never floors.
  assertEquals(session.checkpointAt(11), { kind: "miss", reason: "not-found" });
  const exact12 = session.checkpointAt(12);
  assertEquals(exact12.kind, "hit");
});

Deno.test("11.1 floor: empty checkpoints → miss empty", () => {
  const session = loadHappy({ checkpoints: [] });
  assertEquals(session.findPriorCheckpoint(10), {
    kind: "miss",
    reason: "empty",
  });
});

Deno.test("11.1 floor: time-based query matches tick query via timeMsToTick", () => {
  const session = loadHappy({
    checkpoints: [sampleCheckpoint(10), sampleCheckpoint(12)],
  });
  const byTick = session.findPriorCheckpoint(11);
  const byTime = session.findPriorCheckpointByTimeMs(tickToTimeMs(11));
  assertEquals(byTime, byTick);

  // Parity with a fresh 9.5 CheckpointIndex over the same frames.
  const idx = new CheckpointIndex();
  idx.insert(sampleCheckpoint(10));
  idx.insert(sampleCheckpoint(12));
  assertEquals(session.findPriorCheckpoint(11), idx.findPriorOrEqual(11));
  assertEquals(
    session.findPriorCheckpointByTimeMs(tickToTimeMs(11)),
    idx.findPriorOrEqualByTimeMs(tickToTimeMs(11)),
  );
});

Deno.test("11.1 tick↔time helpers match checkpointIndex", () => {
  const session = loadHappy();
  assertEquals(session.tickToTimeMs(10), tickToTimeMs(10));
  assertEquals(session.tickToTimeMs(10), 10 * TICK_MS);
  assertEquals(session.timeMsToTick(10 * TICK_MS + 1), timeMsToTick(10 * TICK_MS + 1));
});

// ---------------------------------------------------------------------------
// Version-first
// ---------------------------------------------------------------------------

Deno.test("11.1 version: missing / 0 / 2 / string → replay-version-mismatch before stream work", () => {
  const base = JSON.parse(
    new TextDecoder().decode(encodeReplayContainer(buildHappy())),
  ) as Record<string, unknown>;
  const enc = new TextEncoder();

  const noVersion = structuredClone(base);
  delete (noVersion.header as Record<string, unknown>).replayFormatVersion;
  assertVersionMismatch(() =>
    loadReplay(enc.encode(JSON.stringify(noVersion)))
  );

  for (const bad of [0, 2, "1"]) {
    const v = structuredClone(base);
    (v.header as Record<string, unknown>).replayFormatVersion = bad;
    assertVersionMismatch(() => loadReplay(enc.encode(JSON.stringify(v))));
  }

  // Adversarial streams + bad version → version error only (check-first).
  const adversarial = structuredClone(base);
  (adversarial.header as Record<string, unknown>).replayFormatVersion = 99;
  adversarial.inputStream = [{ tick: -1, inputs: [] }];
  adversarial.eventStream = "not-an-array";
  assertVersionMismatch(() =>
    loadReplay(enc.encode(JSON.stringify(adversarial)))
  );
});

// ---------------------------------------------------------------------------
// Rejection taxonomy
// ---------------------------------------------------------------------------

Deno.test("11.1 rejection: truncated / bad utf-8 / bad json / bad shape", () => {
  assertEncodingError(() => loadReplay(new Uint8Array(0)), "replay-truncated");
  assertEncodingError(
    () => loadReplay(new Uint8Array([0x61, 0x80, 0x62])),
    "replay-bad-utf8",
  );
  assertEncodingError(
    () => loadReplay(new TextEncoder().encode("{not-json")),
    "replay-bad-json",
  );
  assertEncodingError(
    () => loadReplay(new TextEncoder().encode("[]")),
    "replay-bad-shape",
  );
});

Deno.test("11.1 rejection: missing section / bad tick / unsupported map / missing seed", () => {
  const enc = new TextEncoder();
  const base = JSON.parse(
    new TextDecoder().decode(encodeReplayContainer(buildHappy())),
  ) as Record<string, unknown>;

  const missing = structuredClone(base);
  delete missing.inputStream;
  assertEncodingError(
    () => loadReplay(enc.encode(JSON.stringify(missing))),
    "replay-missing-section",
  );

  const badTick = structuredClone(base);
  (badTick.inputStream as Array<{ tick: number }>)[0]!.tick = -1;
  assertEncodingError(
    () => loadReplay(enc.encode(JSON.stringify(badTick))),
    "replay-bad-tick",
  );

  const badMap = structuredClone(base);
  ((badMap.header as Record<string, unknown>).map as Record<string, unknown>)
    .version = 999;
  (((badMap.initialState as Record<string, unknown>).metadata as Record<
    string,
    unknown
  >).map as Record<string, unknown>).version = 999;
  (((badMap.initialState as Record<string, unknown>).init as Record<
    string,
    unknown
  >).map as Record<string, unknown>).version = 999;
  assertEncodingError(
    () => loadReplay(enc.encode(JSON.stringify(badMap))),
    "replay-unsupported-map",
  );

  const badSeed = structuredClone(base);
  (badSeed.header as Record<string, unknown>).matchSeed = null;
  assertEncodingError(
    () => loadReplay(enc.encode(JSON.stringify(badSeed))),
    "replay-missing-seed",
  );
});

Deno.test("11.1 tolerant: unknown informational Metadata key loads", () => {
  const base = JSON.parse(
    new TextDecoder().decode(encodeReplayContainer(buildHappy())),
  ) as Record<string, unknown>;
  (base.metadata as Record<string, unknown>).futureInfo = "ok-to-ignore";
  const session = loadReplay(new TextEncoder().encode(JSON.stringify(base)));
  assertEquals(session.header.runtimeMatchId, "rt-loader-1");
  // Unknown key projected away by decode — must not appear on session metadata.
  assertEquals(
    (session.metadata as unknown as Record<string, unknown>).futureInfo,
    undefined,
  );
});

Deno.test("11.1 strict: unknown load-bearing top-level section rejected", () => {
  const base = JSON.parse(
    new TextDecoder().decode(encodeReplayContainer(buildHappy())),
  ) as Record<string, unknown>;
  base.extraSection = { nope: true };
  assertEncodingError(
    () => loadReplay(new TextEncoder().encode(JSON.stringify(base))),
    "replay-bad-shape",
  );
});

// ---------------------------------------------------------------------------
// Integrity opaque
// ---------------------------------------------------------------------------

Deno.test("11.1 integrity: empty trailer loads as unverified", () => {
  const session = loadHappy();
  assertEquals(session.integrityStatus, "unverified");
  assertEquals(session.integrity.schemaNote, "reserved-for-10.4");
  assertEquals(session.integrity.digest, null);
});

// ---------------------------------------------------------------------------
// Freeze / no owner refs
// ---------------------------------------------------------------------------

Deno.test("11.1 freeze: mutating input bytes / accessor results does not alter session", () => {
  const container = buildHappy();
  const bytes = encodeReplayContainer(container);
  const session = loadReplay(bytes);

  // Mutate source bytes after load.
  bytes[0] = 0x20;
  assertEquals(session.header.runtimeMatchId, "rt-loader-1");
  assertEquals(session.inputAt(10).tick, 10);

  // Accessor returns frozen row reference — mutation must throw or be ignored.
  const row = session.inputAt(10);
  assertEquals(Object.isFrozen(row), true);
  assertThrows(() => {
    (row as { tick: number }).tick = 999;
  });
  assertEquals(session.inputAt(10).tick, 10);

  // Session shell is frozen.
  assertEquals(Object.isFrozen(session), true);
  assertThrows(() => {
    (session as { firstTick: number }).firstTick = 0;
  });
});

Deno.test("11.1 freeze: verbatim float identity (no quantization)", () => {
  const yaw = 1.2345678901234567;
  const session = loadHappy({
    inputs: [inputRow(10, yaw), inputRow(11, yaw), inputRow(12, yaw)],
  });
  const loadedYaw = session.inputAt(10).movement[0]!.selectedInput!.yaw;
  assertEquals(loadedYaw, yaw);
  assertNotEquals(loadedYaw, Number(yaw.toFixed(3)));
});

Deno.test("11.1 exclusion: session holds no owner/path/url fields", () => {
  const session = loadHappy();
  const json = JSON.stringify({
    header: session.header,
    metadata: session.metadata,
    initialState: session.initialState,
    integrity: session.integrity,
  });
  for (const banned of [
    "filePath",
    "file_path",
    "blobUrl",
    "rowId",
    "row_id",
    "PlayerManager",
    "MapCollision",
  ]) {
    assertEquals(json.includes(banned), false, `leaked ${banned}`);
  }
});

Deno.test("11.1 exclusion scan: loader module has no fs/blob/store/sim/net imports", async () => {
  const src = await Deno.readTextFile(new URL("./replayLoader.ts", import.meta.url));
  const importLines = src
    .split("\n")
    .filter((l) => /^\s*import\s/.test(l) || /^\s*from\s+["']/.test(l));
  const joined = importLines.join("\n");
  for (const banned of [
    "node:fs",
    "deno.land/std/fs",
    "ReplayBlobStore",
    "storeFactory",
    "PlayerManager",
    "MapCollision",
    "GameServer",
    "/net/",
    "compress",
    "createHash",
    "crypto",
    "signature",
  ]) {
    assertEquals(
      joined.includes(banned),
      false,
      `loader import scan hit banned token: ${banned}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 8.6 alias + import scan surface
// ---------------------------------------------------------------------------

Deno.test("11.1 alias: parseProvisionalReplayFile delegates through loadReplay", () => {
  const bytes = encodeReplayContainer(buildHappy());
  const viaAlias = parseProvisionalReplayFile(bytes);
  const viaLoader = loadReplay(bytes);
  assertEquals(viaAlias, viaLoader.container);
});

Deno.test("11.1 index selectors: markersAt / activityForPlayer when filled", () => {
  const session = loadHappy({ withIndex: true });
  if (!("markers" in session.index)) {
    throw new Error("expected filled index");
  }
  const markers = session.markersAt(11);
  assertEquals(markers.some((m) => m.markerKind === "phaseChange"), true);
  assertEquals(session.activityForPlayer("p1") !== null, true);
  assertEquals(session.activityForPlayer("missing"), null);
});
