/**
 * Epic 7.4 — authoritative match metadata contract.
 *
 * Small, fixed, versioned shape a future recorder (7.5 / #8) and file format
 * (#10) consume. Pure data only — no store, cache, or live emit path.
 *
 * Classification (enforced by test):
 * - load-bearing: sim resumption depends on the value
 * - informational: identification / debugging only; never alters sim outcomes
 *
 * Metadata vs initial state (Decision 2):
 * - Header metadata: identity, versions, seed, clock, config flags, map id
 * - Initial-state companions (scores + full roster with poses): still part of
 *   the unified read so 8.2 does not dig into manager internals, but they are
 *   snapshot-shaped and recorded verbatim by 8.2 — not stuffed into #10 as
 *   "header-only" bytes beyond what the format needs for validation.
 *
 * Wall-clock exclusion: participation / AFK / party expiry / connection-grace
 * / `liveStartedAtMs` never enter this struct. `capturedAtIso` is the only
 * timestamp and is informational-only.
 *
 * #14 expands replay-format version policy; this file only plants the constant.
 */

import { TICK_HZ } from "../sim/game.ts";
import { GAME_PROTO } from "../net/opcodes.ts";
import {
  isSupportedMapFormatVersion,
  type MapFormatVersion,
} from "../world/doorsMapFormat.ts";
import type {
  AuthoritativeMapIdentity,
  AuthoritativeMatchPhase,
  AuthoritativeRaidDoorPolicy,
  AuthoritativeRosterSnapshot,
  AuthoritativeTeamId,
  AuthoritativeTeamScores,
} from "../sim/authoritativeEvent.ts";
import {
  normalizeAuthoritativeRosterSnapshot,
  normalizeAuthoritativeTeamId,
} from "../sim/authoritativeEvent.ts";

/**
 * Minimal replay-file format version. Planted here for #10 headers.
 * Strict accept/reject gate: `shared/replay/replayFormatVersion.ts` (epic 10.5).
 * Full compatibility policy (migration / historical sims / support windows)
 * expands in epic #17 — lineage: 7.4 plant → 10.5 gate → #17 policy.
 */
export const REPLAY_FORMAT_VERSION = 1 as const;

export type ReplayFormatVersion = typeof REPLAY_FORMAT_VERSION;

/**
 * Mirrors `server-community/raid/RaidMatch.RaidFailReason` (a server-only
 * module `shared/` must not import). Keep in sync by hand; both are narrow,
 * rarely-changed literal unions.
 */
export type RaidMatchFailReason = "wipe" | "enemy_capture" | "empty" | "timeout";

/**
 * Dynamic + static `RaidMatch` state needed to reconstruct a raid match.
 * Absent (`active: false`) for non-raid matches — never `null`, so this field
 * can be load-bearing without tripping the generic "present and non-null"
 * load-bearing check every other field goes through.
 */
export type RaidMatchMetadataState =
  | { readonly active: false }
  | {
    readonly active: true;
    readonly raidId: string;
    readonly humanTeam: AuthoritativeTeamId;
    readonly goal: number;
    readonly maxTimeSeconds: number;
    readonly respawnMs: number;
    readonly initialMap: string;
    readonly expectedHumans: number;
    readonly startWaitSeconds: number;
    readonly started: boolean;
    readonly ended: boolean;
    readonly wave: number;
    readonly failReason: RaidMatchFailReason | null;
  };

export type MatchMetadataFieldClass = "loadBearing" | "informational";

/** Whether a load-bearing field is header metadata or 8.2 initial-state. */
export type MatchMetadataFieldRole = "header" | "initialState";

export type MatchMetadataFieldSpec = {
  class: MatchMetadataFieldClass;
  role: MatchMetadataFieldRole;
  /** Human-readable single source (module / owner). */
  source: string;
};

/**
 * Exhaustive field inventory. Every `MatchMetadata` key must appear here;
 * tests fail on unclassified additions.
 */
export const MATCH_METADATA_FIELD_SPECS = {
  captureTick: {
    class: "loadBearing",
    role: "header",
    source: "builder argument (named capture tick)",
  },
  matchSeed: {
    class: "loadBearing",
    role: "header",
    source: "PlayerManager.matchSeed / getMatchSeed()",
  },
  tickRate: {
    class: "loadBearing",
    role: "header",
    source: "server-community/shared/sim/game.ts TICK_HZ",
  },
  matchDurationTicks: {
    class: "loadBearing",
    role: "header",
    source: "PlayerManager.matchDurationTicks (constructor)",
  },
  matchEndTick: {
    class: "loadBearing",
    role: "header",
    source: "PlayerManager.matchEndTick via getMatchClockState()",
  },
  doorCycleOriginTick: {
    class: "loadBearing",
    role: "header",
    source: "PlayerManager.doorCycleOriginTick (7.2 ownership)",
  },
  map: {
    class: "loadBearing",
    role: "header",
    source: "collision.map name+version (via buildMatchInitEvent derivation)",
  },
  prematchEnabled: {
    class: "loadBearing",
    role: "header",
    source: "PlayerManager.prematchEnabled",
  },
  raidDoorPolicy: {
    class: "loadBearing",
    role: "header",
    source: "PlayerManager.raidDoorPolicy",
  },
  debugForceDoorsOpen: {
    class: "loadBearing",
    role: "header",
    source: "PlayerManager.debugForceDoorsOpen",
  },
  phase: {
    class: "loadBearing",
    role: "header",
    source: "PlayerManager.getMatchPhase()",
  },
  scores: {
    class: "loadBearing",
    role: "initialState",
    source: "PlayerManager.getScores() — 8.2 records verbatim",
  },
  roster: {
    class: "loadBearing",
    role: "initialState",
    source: "PlayerManager roster snapshots — 8.2 records verbatim",
  },
  raidMatch: {
    class: "loadBearing",
    role: "initialState",
    source: "GameServer.raid (via getMatchMetadataIdentity) — {active:false} off-raid",
  },
  runtimeMatchId: {
    class: "informational",
    role: "header",
    source: "GameServer.beginRuntimeMatchIdentity only",
  },
  serverName: {
    class: "informational",
    role: "header",
    source: "GameServer.serverName",
  },
  serverId: {
    class: "informational",
    role: "header",
    source: "GameServer.rankedServerId",
  },
  modeId: {
    class: "informational",
    role: "header",
    source: "GameServer.modeId",
  },
  raidId: {
    class: "informational",
    role: "header",
    source: "GameServer.raid?.raidId (when raid runtime)",
  },
  gameProto: {
    class: "informational",
    role: "header",
    source: "server-community/shared/net/opcodes.ts GAME_PROTO",
  },
  buildSha: {
    class: "informational",
    role: "header",
    source: "DOORS_BUILD_SHA env (capture-time)",
  },
  replayFormatVersion: {
    class: "informational",
    role: "header",
    source: "server-community/shared/replay/matchMetadata.ts REPLAY_FORMAT_VERSION (10.5 gate; #17 expands)",
  },
  capturedAtIso: {
    class: "informational",
    role: "header",
    source: "stamped at build tick (annotation only)",
  },
} as const satisfies Record<string, MatchMetadataFieldSpec>;

export type MatchMetadataField = keyof typeof MATCH_METADATA_FIELD_SPECS;

/** Keys whose mutation must never change sim outcomes. */
export const MATCH_METADATA_INFORMATIONAL_FIELDS = (
  Object.keys(MATCH_METADATA_FIELD_SPECS) as MatchMetadataField[]
).filter((k) => MATCH_METADATA_FIELD_SPECS[k].class === "informational");

/** Keys required for sim resumption / validation. */
export const MATCH_METADATA_LOAD_BEARING_FIELDS = (
  Object.keys(MATCH_METADATA_FIELD_SPECS) as MatchMetadataField[]
).filter((k) => MATCH_METADATA_FIELD_SPECS[k].class === "loadBearing");

/**
 * Wall-clock / operational keys that must never appear on MatchMetadata
 * (mirrors AuthoritativeRosterSnapshot exclusion).
 */
export const MATCH_METADATA_EXCLUDED_WALL_CLOCK_KEYS = [
  "liveStartedAtMs",
  "participation",
  "afk",
  "partyExpiry",
  "connectionGrace",
  "connectionGraceDeadline",
  "startedAtMs",
  "endedAtMs",
] as const;

export type MatchMetadata = {
  /** Tick at which this snapshot was read from owners. */
  captureTick: number;

  // --- load-bearing header ---
  matchSeed: number;
  /** Always `TICK_HZ` (60). Clock = tick × rate. */
  tickRate: number;
  matchDurationTicks: number;
  matchEndTick: number;
  doorCycleOriginTick: number;
  map: AuthoritativeMapIdentity;
  prematchEnabled: boolean;
  raidDoorPolicy: AuthoritativeRaidDoorPolicy;
  debugForceDoorsOpen: boolean;
  phase: AuthoritativeMatchPhase;

  // --- load-bearing initial-state companions (8.2 records verbatim) ---
  scores: AuthoritativeTeamScores;
  roster: AuthoritativeRosterSnapshot[];
  raidMatch: RaidMatchMetadataState;

  // --- informational ---
  runtimeMatchId: string;
  serverName: string;
  serverId: string | null;
  modeId: string | null;
  raidId: string | null;
  gameProto: number;
  buildSha: string | null;
  replayFormatVersion: ReplayFormatVersion;
  /** ISO wall-clock stamp at build; never fed back into the sim. */
  capturedAtIso: string;
};

export type MatchMetadataBuildError = {
  ok: false;
  reason: string;
};

export type MatchMetadataBuildOk = {
  ok: true;
  metadata: MatchMetadata;
};

export type MatchMetadataBuildResult =
  | MatchMetadataBuildOk
  | MatchMetadataBuildError;

/** Inputs the pure builder needs from PlayerManager-side owners. */
export type MatchMetadataSimSource = {
  matchSeed: number;
  matchDurationTicks: number;
  matchEndTick: number;
  doorCycleOriginTick: number;
  map: AuthoritativeMapIdentity;
  prematchEnabled: boolean;
  raidDoorPolicy: AuthoritativeRaidDoorPolicy;
  debugForceDoorsOpen: boolean;
  phase: AuthoritativeMatchPhase;
  scores: AuthoritativeTeamScores;
  roster: AuthoritativeRosterSnapshot[];
};

/** Inputs the pure builder needs from GameServer-side owners. */
export type MatchMetadataIdentitySource = {
  runtimeMatchId: string;
  serverName: string;
  serverId: string | null;
  modeId: string | null;
  raidId: string | null;
  buildSha: string | null;
  raidMatch: RaidMatchMetadataState;
};

const PHASES: readonly AuthoritativeMatchPhase[] = [
  "prematch",
  "live",
  "intermission",
];

const RAID_POLICIES: readonly AuthoritativeRaidDoorPolicy[] = [
  "off",
  "idle",
  "open",
];

function finiteNonNegInt(n: unknown): number | null {
  if (typeof n !== "number" || !Number.isFinite(n) || !Number.isInteger(n)) {
    return null;
  }
  if (n < 0) return null;
  return n;
}

function normalizeMapIdentity(
  raw: unknown,
): AuthoritativeMapIdentity | null {
  if (raw == null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.name !== "string" || o.name.length === 0) return null;
  if (!isSupportedMapFormatVersion(o.version)) return null;
  return { name: o.name, version: o.version as MapFormatVersion };
}

function normalizeScores(raw: unknown): AuthoritativeTeamScores | null {
  if (raw == null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const A = finiteNonNegInt(o.A);
  const B = finiteNonNegInt(o.B);
  if (A === null || B === null) return null;
  return { A, B };
}

function normalizePhase(raw: unknown): AuthoritativeMatchPhase | null {
  return typeof raw === "string" &&
      (PHASES as readonly string[]).includes(raw)
    ? (raw as AuthoritativeMatchPhase)
    : null;
}

function normalizeRaidPolicy(
  raw: unknown,
): AuthoritativeRaidDoorPolicy | null {
  return typeof raw === "string" &&
      (RAID_POLICIES as readonly string[]).includes(raw)
    ? (raw as AuthoritativeRaidDoorPolicy)
    : null;
}

const RAID_FAIL_REASONS: readonly RaidMatchFailReason[] = [
  "wipe",
  "enemy_capture",
  "empty",
  "timeout",
];

/** Validate + normalize a raid-match snapshot. Never defaults — bad shape fails loud. */
function normalizeRaidMatchState(raw: unknown): RaidMatchMetadataState | null {
  if (raw == null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.active === false) return { active: false };
  if (o.active !== true) return null;

  if (typeof o.raidId !== "string" || o.raidId.length === 0) return null;
  if (o.humanTeam !== "A" && o.humanTeam !== "B") return null;
  const goal = finiteNonNegInt(o.goal);
  if (goal === null || goal < 1) return null;
  const maxTimeSeconds = finiteNonNegInt(o.maxTimeSeconds);
  if (maxTimeSeconds === null || maxTimeSeconds < 1) return null;
  const respawnMs = finiteNonNegInt(o.respawnMs);
  if (respawnMs === null) return null;
  if (typeof o.initialMap !== "string" || o.initialMap.length === 0) {
    return null;
  }
  const expectedHumans = finiteNonNegInt(o.expectedHumans);
  if (expectedHumans === null || expectedHumans < 1) return null;
  const startWaitSeconds = finiteNonNegInt(o.startWaitSeconds);
  if (startWaitSeconds === null || startWaitSeconds < 1) return null;
  if (typeof o.started !== "boolean") return null;
  if (typeof o.ended !== "boolean") return null;
  const wave = finiteNonNegInt(o.wave);
  if (wave === null) return null;
  const failReason = o.failReason === null
    ? null
    : (typeof o.failReason === "string" &&
        (RAID_FAIL_REASONS as readonly string[]).includes(o.failReason))
    ? (o.failReason as RaidMatchFailReason)
    : undefined;
  if (failReason === undefined) return null;

  return {
    active: true,
    raidId: o.raidId,
    humanTeam: o.humanTeam,
    goal,
    maxTimeSeconds,
    respawnMs,
    initialMap: o.initialMap,
    expectedHumans,
    startWaitSeconds,
    started: o.started,
    ended: o.ended,
    wave,
    failReason,
  };
}

/**
 * Pure builder over owner snapshots. No cache, no subscribers, no persistence.
 * Invalid / absent load-bearing values fail loudly (`ok: false` + reason).
 */
export function buildMatchMetadata(
  captureTick: number,
  sim: MatchMetadataSimSource,
  identity: MatchMetadataIdentitySource,
  opts?: { capturedAtIso?: string; nowMs?: number },
): MatchMetadataBuildResult {
  const tick = finiteNonNegInt(captureTick);
  if (tick === null) {
    return { ok: false, reason: "captureTick must be a non-negative integer" };
  }

  const matchSeed = finiteNonNegInt(sim.matchSeed);
  if (matchSeed === null) {
    return { ok: false, reason: "matchSeed must be a non-negative integer" };
  }

  const matchDurationTicks = finiteNonNegInt(sim.matchDurationTicks);
  if (matchDurationTicks === null || matchDurationTicks < 1) {
    return {
      ok: false,
      reason: "matchDurationTicks must be a positive integer",
    };
  }

  const matchEndTick = finiteNonNegInt(sim.matchEndTick);
  if (matchEndTick === null) {
    return { ok: false, reason: "matchEndTick must be a non-negative integer" };
  }

  const doorCycleOriginTick = finiteNonNegInt(sim.doorCycleOriginTick);
  if (doorCycleOriginTick === null) {
    return {
      ok: false,
      reason: "doorCycleOriginTick must be a non-negative integer",
    };
  }

  const map = normalizeMapIdentity(sim.map);
  if (!map) {
    return {
      ok: false,
      reason:
        "map identity missing or unsupported version (never defaulted)",
    };
  }

  const phase = normalizePhase(sim.phase);
  if (!phase) {
    return { ok: false, reason: `unsupported match phase: ${String(sim.phase)}` };
  }

  const raidDoorPolicy = normalizeRaidPolicy(sim.raidDoorPolicy);
  if (!raidDoorPolicy) {
    return {
      ok: false,
      reason: `unsupported raidDoorPolicy: ${String(sim.raidDoorPolicy)}`,
    };
  }

  if (typeof sim.prematchEnabled !== "boolean") {
    return { ok: false, reason: "prematchEnabled must be boolean" };
  }
  if (typeof sim.debugForceDoorsOpen !== "boolean") {
    return { ok: false, reason: "debugForceDoorsOpen must be boolean" };
  }

  const scores = normalizeScores(sim.scores);
  if (!scores) {
    return { ok: false, reason: "scores must be { A, B } non-negative ints" };
  }

  if (!Array.isArray(sim.roster)) {
    return { ok: false, reason: "roster must be an array" };
  }
  const roster: AuthoritativeRosterSnapshot[] = [];
  for (let i = 0; i < sim.roster.length; i++) {
    const row = normalizeAuthoritativeRosterSnapshot(sim.roster[i]);
    if (!row) {
      return { ok: false, reason: `roster[${i}] failed normalize` };
    }
    // Team id already validated inside normalize; keep for type narrowing.
    if (!normalizeAuthoritativeTeamId(row.team)) {
      return { ok: false, reason: `roster[${i}] bad team` };
    }
    roster.push(row);
  }

  if (
    typeof identity.runtimeMatchId !== "string" ||
    identity.runtimeMatchId.length === 0
  ) {
    return { ok: false, reason: "runtimeMatchId required (informational key)" };
  }
  if (typeof identity.serverName !== "string") {
    return { ok: false, reason: "serverName must be a string" };
  }

  const raidMatch = normalizeRaidMatchState(identity.raidMatch);
  if (!raidMatch) {
    return {
      ok: false,
      reason: `raidMatch invalid or missing shape: ${JSON.stringify(identity.raidMatch)}`,
    };
  }

  const capturedAtIso = opts?.capturedAtIso ??
    new Date(opts?.nowMs ?? Date.now()).toISOString();
  if (typeof capturedAtIso !== "string" || capturedAtIso.length === 0) {
    return { ok: false, reason: "capturedAtIso must be a non-empty ISO string" };
  }

  const metadata: MatchMetadata = {
    captureTick: tick,
    matchSeed,
    tickRate: TICK_HZ,
    matchDurationTicks,
    matchEndTick,
    doorCycleOriginTick,
    map,
    prematchEnabled: sim.prematchEnabled,
    raidDoorPolicy,
    debugForceDoorsOpen: sim.debugForceDoorsOpen,
    phase,
    scores: { ...scores },
    roster,
    raidMatch,
    runtimeMatchId: identity.runtimeMatchId,
    serverName: identity.serverName,
    serverId: identity.serverId ?? null,
    modeId: identity.modeId ?? null,
    raidId: identity.raidId ?? null,
    gameProto: GAME_PROTO,
    buildSha: identity.buildSha ?? null,
    replayFormatVersion: REPLAY_FORMAT_VERSION,
    capturedAtIso,
  };

  return { ok: true, metadata };
}

/**
 * Re-validate a previously built (or deserialized) metadata object.
 * Dropping any load-bearing field fails loudly — the resumption gate.
 */
export function normalizeMatchMetadata(
  raw: unknown,
): MatchMetadataBuildResult {
  if (raw == null || typeof raw !== "object") {
    return { ok: false, reason: "metadata must be an object" };
  }
  const o = raw as Record<string, unknown>;

  // Reject wall-clock operational keys if somehow present.
  for (const key of MATCH_METADATA_EXCLUDED_WALL_CLOCK_KEYS) {
    if (key in o) {
      return {
        ok: false,
        reason: `excluded wall-clock key present: ${key}`,
      };
    }
  }

  for (const field of MATCH_METADATA_LOAD_BEARING_FIELDS) {
    if (!(field in o) || o[field] === undefined || o[field] === null) {
      return {
        ok: false,
        reason: `missing load-bearing field: ${field}`,
      };
    }
  }

  const map = normalizeMapIdentity(o.map);
  if (!map) {
    return {
      ok: false,
      reason: "map identity missing or unsupported version",
    };
  }

  return buildMatchMetadata(
    o.captureTick as number,
    {
      matchSeed: o.matchSeed as number,
      matchDurationTicks: o.matchDurationTicks as number,
      matchEndTick: o.matchEndTick as number,
      doorCycleOriginTick: o.doorCycleOriginTick as number,
      map,
      prematchEnabled: o.prematchEnabled as boolean,
      raidDoorPolicy: o.raidDoorPolicy as AuthoritativeRaidDoorPolicy,
      debugForceDoorsOpen: o.debugForceDoorsOpen as boolean,
      phase: o.phase as AuthoritativeMatchPhase,
      scores: o.scores as AuthoritativeTeamScores,
      roster: o.roster as AuthoritativeRosterSnapshot[],
    },
    {
      runtimeMatchId: String(o.runtimeMatchId ?? ""),
      serverName: String(o.serverName ?? ""),
      serverId: (o.serverId as string | null | undefined) ?? null,
      modeId: (o.modeId as string | null | undefined) ?? null,
      raidId: (o.raidId as string | null | undefined) ?? null,
      buildSha: (o.buildSha as string | null | undefined) ?? null,
      raidMatch: o.raidMatch as RaidMatchMetadataState,
    },
    {
      capturedAtIso: typeof o.capturedAtIso === "string"
        ? o.capturedAtIso
        : "1970-01-01T00:00:00.000Z",
    },
  );
}

/** Strip informational fields for sim-equivalence compares. */
export function loadBearingSubset(
  meta: MatchMetadata,
): Pick<MatchMetadata, (typeof MATCH_METADATA_LOAD_BEARING_FIELDS)[number]> {
  const out = {} as Record<string, unknown>;
  for (const key of MATCH_METADATA_LOAD_BEARING_FIELDS) {
    out[key] = meta[key];
  }
  return out as Pick<
    MatchMetadata,
    (typeof MATCH_METADATA_LOAD_BEARING_FIELDS)[number]
  >;
}
