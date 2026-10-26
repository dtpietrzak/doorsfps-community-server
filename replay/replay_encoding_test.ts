/**
 * Epic 10.2 — canonical JSON encoding round-trip, rejection, determinism.
 *
 * Run from server-community/:
 *   deno test -A replay/replay_encoding_test.ts
 */

import {
  assertEquals,
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
  type MatchMetadata,
} from "../shared/replay/matchMetadata.ts";
import { REPLAY_FORMAT_VERSION } from "../shared/replay/replayFormatVersion.ts";
import type { AuthoritativeCheckpoint } from "./authoritativeCheckpoint.ts";
import { CHECKPOINT_SCHEMA_VERSION } from "./authoritativeCheckpoint.ts";
import type { RecordedInitialState } from "./recordedInitialState.ts";
import type { RecordedTickEvents } from "./recordedTickEvents.ts";
import type { RecordedTickInputs } from "./recordedTickInputs.ts";
import {
  buildReplayContainer,
  EMPTY_REPLAY_CONTAINER_INDEX,
  EMPTY_REPLAY_CONTAINER_INTEGRITY,
  REPLAY_CONTAINER_SECTION_ORDER,
  type ReplayContainer,
} from "./replayContainer.ts";
import {
  decodeReplayContainer,
  encodeReplayContainer,
  getReplayFormatVersionFromBytes,
  REPLAY_HEADER_FIELD_ORDER,
  REPLAY_METADATA_FIELD_ORDER,
  ReplayEncodingError,
} from "./replayEncoding.ts";
import { isEmptyReplayContainerIndex } from "./replayIndex.ts";

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
    map: { name: "encoding-map", version: 1 },
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
      runtimeMatchId: "rt-encoding-1",
      serverName: "encoding-test",
      serverId: "srv-enc",
      modeId: "standard",
      raidId: null,
      buildSha: "cafebabe",
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
    runtimeMatchId: "rt-encoding-1",
    map: { name: "encoding-map", version: 1 },
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
    checkpoints: over?.checkpoints ?? [sampleCheckpoint(12)],
    firstTick: over?.firstTick,
    lastTick: over?.lastTick,
  });
}

function assertEncodingError(
  fn: () => unknown,
  code: ReplayEncodingError["code"],
): ReplayEncodingError {
  const err = assertThrows(fn, ReplayEncodingError) as ReplayEncodingError;
  assertEquals(err.code, code);
  return err;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

Deno.test("10.2 round-trip: decode(encode(c)) deep-equals c", () => {
  const c = buildHappy();
  const decoded = decodeReplayContainer(encodeReplayContainer(c));
  assertEquals(decoded, c);
  assertEquals(decoded.index, EMPTY_REPLAY_CONTAINER_INDEX);
  assertEquals(decoded.integrity, EMPTY_REPLAY_CONTAINER_INTEGRITY);
  assertEquals(decoded.checkpoints.length, 1);
});

Deno.test("10.2 round-trip: empty Index/Integrity preserved, not dropped", () => {
  const c = buildHappy({ checkpoints: [] });
  const text = new TextDecoder().decode(encodeReplayContainer(c));
  assertEquals(/"index"\s*:/.test(text), true);
  assertEquals(/"integrity"\s*:/.test(text), true);
  assertEquals(/"entries"\s*:\s*\[\]/.test(text), true);
  assertEquals(/"digest"\s*:\s*null/.test(text), true);
  const decoded = decodeReplayContainer(encodeReplayContainer(c));
  assertEquals(isEmptyReplayContainerIndex(decoded.index), true);
  if (isEmptyReplayContainerIndex(decoded.index)) {
    assertEquals(decoded.index.entries.length, 0);
  }
  assertEquals(decoded.integrity.digest, null);
});

Deno.test("10.2 verbatim: floats bit-equal after round-trip (not quantized)", () => {
  const yaw = 1.2345678901234567;
  const c = buildHappy({
    inputs: [inputRow(10, yaw), inputRow(11, yaw), inputRow(12, yaw)],
  });
  const ownerYaw = c.inputStream[0]!.movement[0]!.selectedInput!.yaw;
  assertEquals(ownerYaw, yaw);

  const decoded = decodeReplayContainer(encodeReplayContainer(c));
  const roundTripYaw = decoded.inputStream[0]!.movement[0]!.selectedInput!.yaw;
  assertEquals(roundTripYaw, ownerYaw);
  // Presentation quantizer (e.g. toFixed) would diverge — prove negative.
  const quantized = Number(yaw.toFixed(3));
  assertNotEquals(roundTripYaw, quantized);
});

Deno.test("10.2 determinism: encode twice → byte-identical", () => {
  const c = buildHappy();
  const a = encodeReplayContainer(c);
  const b = encodeReplayContainer(c);
  assertEquals(bytesEqual(a, b), true);
});

Deno.test("10.2 determinism: reordered section/key ambient order → same bytes", () => {
  const c = buildHappy();
  // Rebuild a structurally equal container with shuffled own-key insertion order.
  const shuffled: Record<string, unknown> = {};
  const reverseSections = [...REPLAY_CONTAINER_SECTION_ORDER].reverse();
  for (const name of reverseSections) {
    shuffled[name] = c[name];
  }
  // Encoder accepts ReplayContainer; pass through encode after forcing key order
  // via a second object that still validates as the same value when read by name.
  const a = encodeReplayContainer(c);
  const b = encodeReplayContainer(shuffled as unknown as ReplayContainer);
  assertEquals(bytesEqual(a, b), true);

  // Header field ambient order must not affect bytes either.
  const headerShuffled: Record<string, unknown> = {};
  for (const k of [...REPLAY_HEADER_FIELD_ORDER].reverse()) {
    headerShuffled[k] = (c.header as unknown as Record<string, unknown>)[k];
  }
  const withHeaderShuffle = {
    ...c,
    header: headerShuffled,
  } as unknown as ReplayContainer;
  const d = encodeReplayContainer(withHeaderShuffle);
  assertEquals(bytesEqual(a, d), true);
});

Deno.test("10.2 form: compact UTF-8 JSON, section order, no BOM", () => {
  const bytes = encodeReplayContainer(buildHappy());
  assertEquals(bytes[0], "{".charCodeAt(0)); // no BOM (EF BB BF)
  const text = new TextDecoder().decode(bytes);
  assertEquals(/\n/.test(text), false);
  assertEquals(/:\s/.test(text), false); // no pretty spaces after colon

  // Top-level keys appear in section order in the JSON text.
  let prev = -1;
  for (const section of REPLAY_CONTAINER_SECTION_ORDER) {
    const idx = text.indexOf(`"${section}":`);
    assertEquals(idx > prev, true, `section ${section} out of order`);
    prev = idx;
  }

  // Header version is the first field inside header.
  const headerStart = text.indexOf('"header":{');
  const versionIdx = text.indexOf('"replayFormatVersion":', headerStart);
  const nextField = text.indexOf('"runtimeMatchId":', headerStart);
  assertEquals(versionIdx > headerStart, true);
  assertEquals(versionIdx < nextField, true);
});

Deno.test("10.2 version pre-check: returns 1 without needing full decode semantics", () => {
  const bytes = encodeReplayContainer(buildHappy());
  assertEquals(getReplayFormatVersionFromBytes(bytes), REPLAY_FORMAT_VERSION);
});

Deno.test("10.2 version: missing / wrong / non-int → replay-version-mismatch", () => {
  const base = JSON.parse(
    new TextDecoder().decode(encodeReplayContainer(buildHappy())),
  ) as Record<string, unknown>;

  const enc = new TextEncoder();

  const noVersion = structuredClone(base);
  delete (noVersion.header as Record<string, unknown>).replayFormatVersion;
  assertEncodingError(
    () => decodeReplayContainer(enc.encode(JSON.stringify(noVersion))),
    "replay-version-mismatch",
  );

  const v2 = structuredClone(base);
  (v2.header as Record<string, unknown>).replayFormatVersion = 2;
  assertEncodingError(
    () => decodeReplayContainer(enc.encode(JSON.stringify(v2))),
    "replay-version-mismatch",
  );
  // Pre-check still surfaces the numeric major for policy callers.
  assertEquals(
    getReplayFormatVersionFromBytes(enc.encode(JSON.stringify(v2))),
    2,
  );

  const v0 = structuredClone(base);
  (v0.header as Record<string, unknown>).replayFormatVersion = 0;
  assertEncodingError(
    () => decodeReplayContainer(enc.encode(JSON.stringify(v0))),
    "replay-version-mismatch",
  );

  const vStr = structuredClone(base);
  (vStr.header as Record<string, unknown>).replayFormatVersion = "1";
  assertEncodingError(
    () => decodeReplayContainer(enc.encode(JSON.stringify(vStr))),
    "replay-version-mismatch",
  );

  const noHeader = structuredClone(base);
  delete noHeader.header;
  assertEncodingError(
    () => decodeReplayContainer(enc.encode(JSON.stringify(noHeader))),
    "replay-version-mismatch",
  );
});

Deno.test("10.5 check-first: bad version fails before stream validation", () => {
  const base = JSON.parse(
    new TextDecoder().decode(encodeReplayContainer(buildHappy())),
  ) as Record<string, unknown>;
  const enc = new TextEncoder();

  // Otherwise-fatal stream content + unsupported version → version error only.
  const adversarial = structuredClone(base);
  (adversarial.header as Record<string, unknown>).replayFormatVersion = 99;
  adversarial.inputStream = [{ tick: -1, inputs: [] }];
  adversarial.eventStream = "not-an-array";

  const err = assertThrows(
    () => decodeReplayContainer(enc.encode(JSON.stringify(adversarial))),
    ReplayEncodingError,
  ) as ReplayEncodingError;
  assertEquals(err.code, "replay-version-mismatch");
  assertEquals(err.section, "header");
});

Deno.test("10.2 rejection: truncated / bad utf-8 / bad json / bad shape", () => {
  assertEncodingError(
    () => decodeReplayContainer(new Uint8Array(0)),
    "replay-truncated",
  );

  // Invalid UTF-8 continuation.
  assertEncodingError(
    () => decodeReplayContainer(new Uint8Array([0x61, 0x80, 0x62])),
    "replay-bad-utf8",
  );

  assertEncodingError(
    () => decodeReplayContainer(new TextEncoder().encode("{not-json")),
    "replay-bad-json",
  );

  assertEncodingError(
    () => decodeReplayContainer(new TextEncoder().encode("[]")),
    "replay-bad-shape",
  );

  assertEncodingError(
    () => decodeReplayContainer(new TextEncoder().encode("null")),
    "replay-bad-shape",
  );
});

Deno.test("10.2 rejection: missing required section", () => {
  const base = JSON.parse(
    new TextDecoder().decode(encodeReplayContainer(buildHappy())),
  ) as Record<string, unknown>;
  delete base.inputStream;
  // Version still present — deep validate maps missing section.
  const err = assertEncodingError(
    () => decodeReplayContainer(new TextEncoder().encode(JSON.stringify(base))),
    "replay-missing-section",
  );
  assertEquals(err.section, "inputStream");
});

Deno.test("10.2 rejection: bad tick / unsupported map / missing seed", () => {
  const enc = new TextEncoder();
  const base = JSON.parse(
    new TextDecoder().decode(encodeReplayContainer(buildHappy())),
  ) as Record<string, unknown>;

  const badTick = structuredClone(base);
  (badTick.inputStream as Array<{ tick: number }>)[0]!.tick = -1;
  assertEncodingError(
    () => decodeReplayContainer(enc.encode(JSON.stringify(badTick))),
    "replay-bad-tick",
  );

  const badMap = structuredClone(base);
  ((badMap.header as Record<string, unknown>).map as Record<string, unknown>)
    .version = 999;
  // Keep init in sync so we hit map-version check (not header/init disagreement).
  (((badMap.initialState as Record<string, unknown>).metadata as Record<
    string,
    unknown
  >).map as Record<string, unknown>).version = 999;
  (((badMap.initialState as Record<string, unknown>).init as Record<
    string,
    unknown
  >).map as Record<string, unknown>).version = 999;
  assertEncodingError(
    () => decodeReplayContainer(enc.encode(JSON.stringify(badMap))),
    "replay-unsupported-map",
  );

  const badSeed = structuredClone(base);
  (badSeed.header as Record<string, unknown>).matchSeed = -1;
  assertEncodingError(
    () => decodeReplayContainer(enc.encode(JSON.stringify(badSeed))),
    "replay-missing-seed",
  );
});

Deno.test("10.2 tolerant-vs-strict: unknown Metadata key ignored; unknown section/header rejected", () => {
  const enc = new TextEncoder();
  const base = JSON.parse(
    new TextDecoder().decode(encodeReplayContainer(buildHappy())),
  ) as Record<string, unknown>;

  const withDebug = structuredClone(base);
  (withDebug.metadata as Record<string, unknown>).debugNote = "ignore-me";
  const decoded = decodeReplayContainer(enc.encode(JSON.stringify(withDebug)));
  assertEquals(
    "debugNote" in (decoded.metadata as unknown as Record<string, unknown>),
    false,
  );
  for (const key of REPLAY_METADATA_FIELD_ORDER) {
    assertEquals(
      key in (decoded.metadata as unknown as Record<string, unknown>),
      true,
    );
  }

  const unknownSection = structuredClone(base);
  unknownSection.extraStream = [];
  assertEncodingError(
    () => decodeReplayContainer(enc.encode(JSON.stringify(unknownSection))),
    "replay-bad-shape",
  );

  const unknownHeader = structuredClone(base);
  (unknownHeader.header as Record<string, unknown>).wireOpcode = 7;
  assertEncodingError(
    () => decodeReplayContainer(enc.encode(JSON.stringify(unknownHeader))),
    "replay-bad-shape",
  );
});

Deno.test("10.2 freeze: encoding never mutates input; decoded result frozen", () => {
  const c = buildHappy();
  const before = structuredClone(c);
  const bytes = encodeReplayContainer(c);
  assertEquals(c, before);

  const decoded = decodeReplayContainer(bytes);
  assertEquals(Object.isFrozen(decoded), true);
  assertEquals(Object.isFrozen(decoded.header), true);
  assertThrows(() => {
    (decoded as { header: { runtimeMatchId: string } }).header.runtimeMatchId =
      "mutated";
  });
});

Deno.test("10.2 exclusion: emitted JSON has no wire/wall-clock/location/hash substrings", () => {
  const text = new TextDecoder().decode(encodeReplayContainer(buildHappy()));
  for (const banned of [
    "filePath",
    "file_path",
    "blobUrl",
    "rowId",
    "row_id",
    "lastSequence",
    "ShootPacket",
    "MeleePacket",
    "liveStartedAtMs",
    "sha256",
    "checksum",
  ]) {
    assertEquals(text.includes(banned), false, `banned substring ${banned}`);
  }
});

Deno.test("10.2 exclusion scan: codec module has no fs/blob/store/hash/net imports", async () => {
  const src = await Deno.readTextFile(
    new URL("./replayEncoding.ts", import.meta.url),
  );
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assertEquals(/\bDeno\./.test(code), false);
  assertEquals(/from\s+["'].*ReplayBlobStore/.test(code), false);
  assertEquals(/from\s+["'].*\/db\//.test(code), false);
  assertEquals(/from\s+["'].*\/net\//.test(code), false);
  assertEquals(/createHash|crypto\.subtle|CompressionStream/.test(code), false);
  assertEquals(/JSON\.stringify|TextEncoder|TextDecoder/.test(code), true);
});

Deno.test("10.2 coverage: season-like containers round-trip (sizes recorded)", () => {
  const sizes: Array<{ label: string; bytes: number }> = [];

  const live = buildHappy();
  sizes.push({ label: "live-short", bytes: encodeReplayContainer(live).byteLength });
  assertEquals(decodeReplayContainer(encodeReplayContainer(live)), live);

  const degenerate = buildReplayContainer({
    init: sampleRecordedInit(),
    inputRows: [],
    eventRows: [],
    checkpoints: [],
    firstTick: 10,
    lastTick: 10,
  });
  sizes.push({
    label: "degenerate",
    bytes: encodeReplayContainer(degenerate).byteLength,
  });
  assertEquals(
    decodeReplayContainer(encodeReplayContainer(degenerate)),
    degenerate,
  );

  const agentHeavyInputs: RecordedTickInputs[] = [];
  for (let t = 10; t <= 20; t++) {
    agentHeavyInputs.push({
      tick: t,
      movement: Array.from({ length: 8 }, (_, i) => ({
        tick: t,
        playerId: `p${i}`,
        association: "fresh" as const,
        appliedSequence: i + 1,
        inputHoldTicks: 1,
        selectedInput: {
          sequence: i + 1,
          forward: i % 2 === 0,
          backward: false,
          left: false,
          right: i % 3 === 0,
          jump: false,
          sprint: false,
          crouch: false,
          meleeLunge: false,
          yaw: i * 0.1 + t * 0.001,
          pitch: 0,
        },
      })),
      actions: [],
    });
  }
  const heavy = buildReplayContainer({
    init: sampleRecordedInit(),
    inputRows: agentHeavyInputs,
    eventRows: agentHeavyInputs.map((r) => eventRow(r.tick)),
    checkpoints: [sampleCheckpoint(20)],
  });
  sizes.push({
    label: "agent-heavy-11t",
    bytes: encodeReplayContainer(heavy).byteLength,
  });
  assertEquals(decodeReplayContainer(encodeReplayContainer(heavy)), heavy);

  // Unasserted measurements for 19.3 — keep visible in test output via assert on length > 0.
  for (const row of sizes) {
    assertEquals(row.bytes > 0, true, row.label);
  }
});

Deno.test("10.2 errors never leak raw SyntaxError", () => {
  try {
    decodeReplayContainer(new TextEncoder().encode("{"));
    throw new Error("expected throw");
  } catch (err) {
    assertEquals(err instanceof ReplayEncodingError, true);
    assertEquals(err instanceof SyntaxError, false);
  }
});

