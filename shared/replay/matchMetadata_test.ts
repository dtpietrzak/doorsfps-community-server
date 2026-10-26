/**
 * Epic 7.4 — MatchMetadata contract (shared).
 *
 * Run from repo root:
 *   deno test -A shared/replay/matchMetadata_test.ts
 */

import {
  assertEquals,
  assertNotEquals,
} from "jsr:@std/assert@1";
import { TICK_HZ } from "../sim/game.ts";
import { GAME_PROTO } from "../net/opcodes.ts";
import { defaultPlayerEquipment } from "../sim/game.ts";
import { emptyAuthoritativePose } from "../sim/authoritativeEvent.ts";
import {
  buildMatchMetadata,
  loadBearingSubset,
  MATCH_METADATA_EXCLUDED_WALL_CLOCK_KEYS,
  MATCH_METADATA_FIELD_SPECS,
  MATCH_METADATA_INFORMATIONAL_FIELDS,
  MATCH_METADATA_LOAD_BEARING_FIELDS,
  normalizeMatchMetadata,
  REPLAY_FORMAT_VERSION,
  type MatchMetadata,
  type MatchMetadataIdentitySource,
  type MatchMetadataSimSource,
} from "./matchMetadata.ts";

function sampleSim(over?: Partial<MatchMetadataSimSource>): MatchMetadataSimSource {
  return {
    matchSeed: 42,
    matchDurationTicks: 60 * TICK_HZ,
    matchEndTick: 60 * TICK_HZ,
    doorCycleOriginTick: 0,
    map: { name: "meta-test", version: 2 },
    prematchEnabled: false,
    raidDoorPolicy: "off",
    debugForceDoorsOpen: false,
    phase: "live",
    scores: { A: 1, B: 0 },
    roster: [
      {
        id: "p1",
        name: "P1",
        team: "A",
        isBot: false,
        isAgent: false,
        isBalanceBot: false,
        alive: true,
        connectionIssue: false,
        unlimitedAmmo: false,
        maxHealth: 100,
        modelScale: 1,
        moveSpeedScale: 1,
        pose: emptyAuthoritativePose(),
        equipment: defaultPlayerEquipment(),
        skillLoadout: null,
        ownedAbilities: null,
      },
    ],
    ...over,
  };
}

function sampleIdentity(
  over?: Partial<MatchMetadataIdentitySource>,
): MatchMetadataIdentitySource {
  return {
    runtimeMatchId: "11111111-1111-1111-1111-111111111111",
    serverName: "meta-server",
    serverId: "open",
    modeId: null,
    raidId: null,
    buildSha: "abc123",
    raidMatch: { active: false },
    ...over,
  };
}

Deno.test("7.4 shape: every MatchMetadata key is classified exactly once", () => {
  const built = buildMatchMetadata(10, sampleSim(), sampleIdentity(), {
    capturedAtIso: "2026-01-01T00:00:00.000Z",
  });
  assertEquals(built.ok, true);
  if (!built.ok) return;
  const keys = Object.keys(built.metadata).sort();
  const specKeys = Object.keys(MATCH_METADATA_FIELD_SPECS).sort();
  assertEquals(keys, specKeys);
  for (const key of specKeys) {
    const spec = MATCH_METADATA_FIELD_SPECS[
      key as keyof typeof MATCH_METADATA_FIELD_SPECS
    ];
    assertEquals(
      spec.class === "loadBearing" || spec.class === "informational",
      true,
    );
  }
  assertEquals(
    MATCH_METADATA_LOAD_BEARING_FIELDS.length +
      MATCH_METADATA_INFORMATIONAL_FIELDS.length,
    specKeys.length,
  );
});

Deno.test("7.4 shape: constants pin tickRate / GAME_PROTO / format version", () => {
  const built = buildMatchMetadata(0, sampleSim(), sampleIdentity(), {
    capturedAtIso: "2026-01-01T00:00:00.000Z",
  });
  assertEquals(built.ok, true);
  if (!built.ok) return;
  assertEquals(built.metadata.tickRate, TICK_HZ);
  assertEquals(built.metadata.gameProto, GAME_PROTO);
  assertEquals(built.metadata.replayFormatVersion, REPLAY_FORMAT_VERSION);
  assertEquals(REPLAY_FORMAT_VERSION, 1);
});

Deno.test("7.4 shape: unsupported map version rejected (never defaulted)", () => {
  const bad = buildMatchMetadata(
    0,
    sampleSim({ map: { name: "x", version: 99 as 1 } }),
    sampleIdentity(),
    { capturedAtIso: "2026-01-01T00:00:00.000Z" },
  );
  assertEquals(bad.ok, false);
  if (bad.ok) return;
  assertEquals(bad.reason.includes("map identity"), true);
});

Deno.test("7.4 shape: missing matchSeed / empty runtimeMatchId fail loudly", () => {
  assertEquals(
    buildMatchMetadata(
      0,
      sampleSim({ matchSeed: Number.NaN }),
      sampleIdentity(),
      { capturedAtIso: "2026-01-01T00:00:00.000Z" },
    ).ok,
    false,
  );
  assertEquals(
    buildMatchMetadata(0, sampleSim(), sampleIdentity({ runtimeMatchId: "" }), {
      capturedAtIso: "2026-01-01T00:00:00.000Z",
    }).ok,
    false,
  );
});

Deno.test("7.4 classification: drop each load-bearing field → normalize fails", () => {
  const built = buildMatchMetadata(5, sampleSim(), sampleIdentity(), {
    capturedAtIso: "2026-01-01T00:00:00.000Z",
  });
  assertEquals(built.ok, true);
  if (!built.ok) return;
  for (const field of MATCH_METADATA_LOAD_BEARING_FIELDS) {
    const clone = { ...built.metadata } as Record<string, unknown>;
    delete clone[field];
    const result = normalizeMatchMetadata(clone);
    assertEquals(result.ok, false, `expected fail when dropping ${field}`);
    if (!result.ok) {
      assertEquals(result.reason.includes(field), true);
    }
  }
});

Deno.test("7.4 classification: informational mutation keeps load-bearing subset", () => {
  const a = buildMatchMetadata(7, sampleSim(), sampleIdentity(), {
    capturedAtIso: "2026-01-01T00:00:00.000Z",
  });
  const b = buildMatchMetadata(
    7,
    sampleSim(),
    sampleIdentity({
      runtimeMatchId: "22222222-2222-2222-2222-222222222222",
      serverName: "other-name",
      serverId: "ranked",
      modeId: "raid",
      raidId: "raid-1",
      buildSha: "zzzz",
    }),
    { capturedAtIso: "2099-12-31T23:59:59.000Z" },
  );
  assertEquals(a.ok && b.ok, true);
  if (!a.ok || !b.ok) return;
  assertEquals(loadBearingSubset(a.metadata), loadBearingSubset(b.metadata));
  assertNotEquals(a.metadata.runtimeMatchId, b.metadata.runtimeMatchId);
  assertNotEquals(a.metadata.serverName, b.metadata.serverName);
  assertNotEquals(a.metadata.capturedAtIso, b.metadata.capturedAtIso);
});

Deno.test("7.4 exclusion: wall-clock operational keys rejected on normalize", () => {
  const built = buildMatchMetadata(1, sampleSim(), sampleIdentity(), {
    capturedAtIso: "2026-01-01T00:00:00.000Z",
  });
  assertEquals(built.ok, true);
  if (!built.ok) return;
  for (const key of MATCH_METADATA_EXCLUDED_WALL_CLOCK_KEYS) {
    const clone = {
      ...built.metadata,
      [key]: 12345,
    } as MatchMetadata & Record<string, unknown>;
    const result = normalizeMatchMetadata(clone);
    assertEquals(result.ok, false, `expected reject for ${key}`);
  }
});

Deno.test("29.2 raid: active raid state builds, round-trips through normalize, and is load-bearing", () => {
  const activeRaid: MatchMetadataIdentitySource["raidMatch"] = {
    active: true,
    raidId: "crossroads",
    humanTeam: "A",
    goal: 10,
    maxTimeSeconds: 1800,
    respawnMs: 3000,
    initialMap: "Crossroads",
    expectedHumans: 2,
    startWaitSeconds: 15,
    started: true,
    ended: false,
    wave: 3,
    failReason: null,
  };
  const built = buildMatchMetadata(
    5,
    sampleSim(),
    sampleIdentity({ raidId: "crossroads", raidMatch: activeRaid }),
    { capturedAtIso: "2026-01-01T00:00:00.000Z" },
  );
  assertEquals(built.ok, true);
  if (!built.ok) return;
  assertEquals(built.metadata.raidMatch, activeRaid);

  // Round-trips through normalize (the deserialize path a loader would use).
  const normalized = normalizeMatchMetadata(built.metadata);
  assertEquals(normalized.ok, true);
  if (!normalized.ok) return;
  assertEquals(normalized.metadata.raidMatch, activeRaid);

  // Load-bearing: dropping it fails (covered generically by the classification
  // test above too, but this pins the reason text for this specific field).
  const clone = { ...built.metadata } as Record<string, unknown>;
  delete clone.raidMatch;
  const dropped = normalizeMatchMetadata(clone);
  assertEquals(dropped.ok, false);
  if (dropped.ok) return;
  assertEquals(dropped.reason.includes("raidMatch"), true);
});

Deno.test("29.2 raid: malformed active raid state is rejected, never defaulted", () => {
  const bad = buildMatchMetadata(
    0,
    sampleSim(),
    sampleIdentity({
      raidMatch: { active: true, raidId: "x" } as unknown as MatchMetadataIdentitySource["raidMatch"],
    }),
    { capturedAtIso: "2026-01-01T00:00:00.000Z" },
  );
  assertEquals(bad.ok, false);
  if (bad.ok) return;
  assertEquals(bad.reason.includes("raidMatch"), true);
});

Deno.test("7.4 exclusion: roster snapshots carry no liveStartedAtMs-class keys", () => {
  const built = buildMatchMetadata(1, sampleSim(), sampleIdentity(), {
    capturedAtIso: "2026-01-01T00:00:00.000Z",
  });
  assertEquals(built.ok, true);
  if (!built.ok) return;
  const json = JSON.stringify(built.metadata);
  for (const key of MATCH_METADATA_EXCLUDED_WALL_CLOCK_KEYS) {
    assertEquals(json.includes(`"${key}"`), false, `leaked ${key}`);
  }
});
