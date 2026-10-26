/**
 * Epic 10.1 — replay container (logical layout only).
 *
 * One encoding-agnostic, versioned container owns the file shape consumed by
 * 8.6 (finalization writer), 10.2 (encoding), 10.3 (index fill), 10.4
 * (integrity), 10.5/#17 (version policy), 11.1 (loader), and 16.1/16.5
 * (blob + range serving).
 *
 * Fixed section order (Decision 2 / 16.5 range-skippability):
 *   Header → Metadata → Initial State → Input Stream → Event Stream →
 *   Checkpoints → Index (10.3 tables or empty reserved) → Integrity (reserved)
 *
 * Version: reuses planted `REPLAY_FORMAT_VERSION = 1` (Decision 1 — no second
 * container schema constant). Strict accept/reject is the 10.5 gate
 * (`isSupportedReplayFormatVersion`); full policy expands in #17.
 *
 * Pure types + build/validate helpers. No filesystem, blob, codec,
 * compression, or `net/` wire imports (scan-locked).
 */

import { TICK_HZ } from "../shared/sim/game.ts";
import {
  type MatchMetadata,
} from "../shared/replay/matchMetadata.ts";
import {
  isSupportedMapFormatVersion,
} from "../shared/world/doorsMapFormat.ts";
import {
  isSupportedReplayFormatVersion,
  REPLAY_FORMAT_VERSION,
  type ReplayFormatVersion,
} from "../shared/replay/replayFormatVersion.ts";
import type {
  AuthoritativeEvent,
  AuthoritativeMapIdentity,
  AuthoritativeMatchPhase,
  AuthoritativeRaidDoorPolicy,
} from "../shared/sim/authoritativeEvent.ts";
import type { AuthoritativeCheckpoint } from "./authoritativeCheckpoint.ts";
import type { RecordedInitialState } from "./recordedInitialState.ts";
import { deepFreeze } from "./recordedInitialState.ts";
import type { RecordedTickEvents } from "./recordedTickEvents.ts";
import type { RecordedTickInputs } from "./recordedTickInputs.ts";
import type { ReplayBufferedSessionView } from "./replaySessionBuffer.ts";
import {
  buildReplayIndex,
  isEmptyReplayContainerIndex,
  validateReplayIndex,
  type ReplayIndex,
} from "./replayIndex.ts";

/** Fixed logical section order — never reorder per file (16.5). */
export const REPLAY_CONTAINER_SECTION_ORDER = [
  "header",
  "metadata",
  "initialState",
  "inputStream",
  "eventStream",
  "checkpoints",
  "index",
  "integrity",
] as const;

export type ReplayContainerSectionName =
  (typeof REPLAY_CONTAINER_SECTION_ORDER)[number];

/**
 * Self-describing header: load-bearing 7.4 header-role fields + tick range +
 * version, so a loader can reject incompatibility before reading streams.
 * Roster/scores live once in Initial State (Decision 4).
 */
export type ReplayContainerHeader = {
  readonly replayFormatVersion: ReplayFormatVersion;
  readonly runtimeMatchId: string;
  readonly captureTick: number;
  readonly firstTick: number;
  readonly lastTick: number;
  readonly matchSeed: number;
  readonly tickRate: number;
  readonly matchDurationTicks: number;
  readonly matchEndTick: number;
  readonly doorCycleOriginTick: number;
  readonly map: AuthoritativeMapIdentity;
  readonly prematchEnabled: boolean;
  readonly raidDoorPolicy: AuthoritativeRaidDoorPolicy;
  readonly debugForceDoorsOpen: boolean;
  readonly phase: AuthoritativeMatchPhase;
};

/**
 * Informational-only 7.4 fields. Never fed back into the sim.
 * `runtimeMatchId` / `replayFormatVersion` live in Header (boundary contract).
 */
export type ReplayContainerMetadata = {
  readonly serverName: string;
  readonly serverId: string | null;
  readonly modeId: string | null;
  readonly raidId: string | null;
  readonly gameProto: number;
  readonly buildSha: string | null;
  readonly capturedAtIso: string;
};

/**
 * Reserved Index slot — explicit-empty (10.1-era) or filled `ReplayIndex` (10.3).
 * Present-but-empty remains valid; absence is not.
 */
export type ReplayContainerIndexEmpty = {
  readonly schemaNote: "reserved-for-10.3";
  readonly entries: readonly [];
};

export type ReplayContainerIndex = ReplayContainerIndexEmpty | ReplayIndex;

/**
 * Reserved Integrity trailer slot — 10.4 defines digests.
 * No hash is computed in 10.1.
 */
export type ReplayContainerIntegrity = {
  readonly schemaNote: "reserved-for-10.4";
  readonly digest: null;
};

export const EMPTY_REPLAY_CONTAINER_INDEX: ReplayContainerIndexEmpty =
  Object.freeze({
    schemaNote: "reserved-for-10.3",
    entries: Object.freeze([]) as readonly [],
  });

export const EMPTY_REPLAY_CONTAINER_INTEGRITY: ReplayContainerIntegrity =
  Object.freeze({
    schemaNote: "reserved-for-10.4",
    digest: null,
  });

/**
 * Encoding-agnostic replay container. Carries structure only — never a path,
 * URL, row id, compressed blob, or hash digest (SQL/blob separation).
 */
export type ReplayContainer = {
  readonly header: ReplayContainerHeader;
  readonly metadata: ReplayContainerMetadata;
  readonly initialState: RecordedInitialState;
  readonly inputStream: ReadonlyArray<RecordedTickInputs>;
  readonly eventStream: ReadonlyArray<RecordedTickEvents>;
  /** Required slot; list may be empty until 9.2 populates. */
  readonly checkpoints: ReadonlyArray<AuthoritativeCheckpoint>;
  readonly index: ReplayContainerIndex;
  readonly integrity: ReplayContainerIntegrity;
};

export type BuildReplayContainerArgs = {
  readonly init: RecordedInitialState;
  readonly inputRows: ReadonlyArray<RecordedTickInputs>;
  readonly eventRows: ReadonlyArray<RecordedTickEvents>;
  readonly checkpoints?: ReadonlyArray<AuthoritativeCheckpoint>;
  /** Optional reserved index; defaults to empty 10.3 slot. */
  readonly index?: ReplayContainerIndex;
  /** Optional first/last tick overrides; derived from init + streams when omitted. */
  readonly firstTick?: number;
  readonly lastTick?: number;
};

export type ReplayContainerValidateOk = {
  ok: true;
  container: ReplayContainer;
};

export type ReplayContainerValidateError = {
  ok: false;
  reason: string;
};

export type ReplayContainerValidateResult =
  | ReplayContainerValidateOk
  | ReplayContainerValidateError;

function finiteNonNegInt(n: unknown): number | null {
  if (typeof n !== "number" || !Number.isFinite(n) || !Number.isInteger(n)) {
    return null;
  }
  if (n < 0) return null;
  return n;
}

function headerFromMetadata(
  metadata: Readonly<MatchMetadata>,
  firstTick: number,
  lastTick: number,
): ReplayContainerHeader {
  return {
    replayFormatVersion: REPLAY_FORMAT_VERSION,
    runtimeMatchId: metadata.runtimeMatchId,
    captureTick: metadata.captureTick,
    firstTick,
    lastTick,
    matchSeed: metadata.matchSeed,
    tickRate: metadata.tickRate,
    matchDurationTicks: metadata.matchDurationTicks,
    matchEndTick: metadata.matchEndTick,
    doorCycleOriginTick: metadata.doorCycleOriginTick,
    map: { name: metadata.map.name, version: metadata.map.version },
    prematchEnabled: metadata.prematchEnabled,
    raidDoorPolicy: metadata.raidDoorPolicy,
    debugForceDoorsOpen: metadata.debugForceDoorsOpen,
    phase: metadata.phase,
  };
}

function metadataSectionFrom(
  metadata: Readonly<MatchMetadata>,
): ReplayContainerMetadata {
  return {
    serverName: metadata.serverName,
    serverId: metadata.serverId,
    modeId: metadata.modeId,
    raidId: metadata.raidId,
    gameProto: metadata.gameProto,
    buildSha: metadata.buildSha,
    capturedAtIso: metadata.capturedAtIso,
  };
}

function deriveTickRange(
  init: RecordedInitialState,
  inputRows: ReadonlyArray<RecordedTickInputs>,
  eventRows: ReadonlyArray<RecordedTickEvents>,
  checkpoints: ReadonlyArray<AuthoritativeCheckpoint>,
  overrides?: { firstTick?: number; lastTick?: number },
): { firstTick: number; lastTick: number } {
  // Stream window is distinct from captureTick: firstTick is the first input
  // tick when inputs exist, else the capture/init tick (degenerate).
  let firstTick: number;
  if (overrides?.firstTick !== undefined) {
    firstTick = overrides.firstTick;
  } else if (inputRows.length > 0) {
    firstTick = inputRows[0]!.tick;
  } else {
    firstTick = init.captureTick;
  }

  let lastTick = overrides?.lastTick ?? firstTick;
  if (overrides?.lastTick === undefined) {
    for (const row of inputRows) {
      if (row.tick > lastTick) lastTick = row.tick;
    }
    for (const row of eventRows) {
      if (row.tick > lastTick) lastTick = row.tick;
    }
    for (const cp of checkpoints) {
      if (cp.tick > lastTick) lastTick = cp.tick;
    }
  }

  return { firstTick, lastTick };
}

/**
 * Assemble a frozen container from already-frozen earlier-epic values.
 * No owner reads, no I/O — 8.6 calls this at finalization.
 */
export function buildReplayContainer(
  args: BuildReplayContainerArgs,
): ReplayContainer {
  const checkpoints = args.checkpoints ?? [];
  const index = args.index ?? EMPTY_REPLAY_CONTAINER_INDEX;
  const { firstTick, lastTick } = deriveTickRange(
    args.init,
    args.inputRows,
    args.eventRows,
    checkpoints,
    { firstTick: args.firstTick, lastTick: args.lastTick },
  );

  const header = headerFromMetadata(args.init.metadata, firstTick, lastTick);
  const metadata = metadataSectionFrom(args.init.metadata);

  const container: ReplayContainer = {
    header,
    metadata,
    initialState: args.init,
    inputStream: args.inputRows,
    eventStream: args.eventRows,
    checkpoints,
    index,
    integrity: EMPTY_REPLAY_CONTAINER_INTEGRITY,
  };

  const validated = validateReplayContainer(container);
  if (!validated.ok) {
    throw new Error(`buildReplayContainer: ${validated.reason}`);
  }
  return deepFreeze(validated.container);
}

/**
 * Build from an 8.5 buffered session view (8.6 finalization path).
 */
export function buildReplayContainerFromSession(
  session: ReplayBufferedSessionView,
): ReplayContainer {
  if (!session.init) {
    throw new Error("buildReplayContainerFromSession: missing init capture");
  }
  // Prefer the input-stream window. session.startTick is the init/capture tick
  // and may precede the first onTick input row — do not force it as firstTick.
  // Build a provisional container to derive the tick window, then fill the
  // 10.3 index from sibling sections (pre-encode; Decision 5).
  const provisional = buildReplayContainer({
    init: session.init,
    inputRows: session.inputs,
    eventRows: session.events,
    checkpoints: session.checkpoints,
  });
  const index = buildReplayIndex({
    inputRows: provisional.inputStream,
    eventRows: provisional.eventStream,
    checkpoints: provisional.checkpoints,
    firstTick: provisional.header.firstTick,
    lastTick: provisional.header.lastTick,
    initialPhase: provisional.header.phase,
  });
  return buildReplayContainer({
    init: session.init,
    inputRows: session.inputs,
    eventRows: session.events,
    checkpoints: session.checkpoints,
    index,
    firstTick: provisional.header.firstTick,
    lastTick: provisional.header.lastTick,
  });
}

function assertHeaderInitAgreement(
  header: ReplayContainerHeader,
  init: RecordedInitialState,
): string | null {
  const md = init.metadata;
  if (header.runtimeMatchId !== init.runtimeMatchId) {
    return "header.runtimeMatchId !== initialState.runtimeMatchId";
  }
  if (header.runtimeMatchId !== md.runtimeMatchId) {
    return "header.runtimeMatchId !== metadata.runtimeMatchId";
  }
  if (header.captureTick !== init.captureTick || header.captureTick !== md.captureTick) {
    return "header.captureTick disagrees with initialState";
  }
  if (header.matchSeed !== md.matchSeed || header.matchSeed !== init.init.matchSeed) {
    return "header.matchSeed disagrees with initialState";
  }
  if (
    header.map.name !== md.map.name ||
    header.map.version !== md.map.version ||
    header.map.name !== init.init.map.name ||
    header.map.version !== init.init.map.version
  ) {
    return "header.map disagrees with initialState";
  }
  if (header.tickRate !== TICK_HZ || header.tickRate !== md.tickRate) {
    return `header.tickRate must be ${TICK_HZ}`;
  }
  if (header.matchDurationTicks !== md.matchDurationTicks) {
    return "header.matchDurationTicks disagrees with initialState";
  }
  if (header.matchEndTick !== md.matchEndTick) {
    return "header.matchEndTick disagrees with initialState";
  }
  if (header.doorCycleOriginTick !== md.doorCycleOriginTick) {
    return "header.doorCycleOriginTick disagrees with initialState";
  }
  if (header.prematchEnabled !== md.prematchEnabled) {
    return "header.prematchEnabled disagrees with initialState";
  }
  if (header.raidDoorPolicy !== md.raidDoorPolicy) {
    return "header.raidDoorPolicy disagrees with initialState";
  }
  if (header.debugForceDoorsOpen !== md.debugForceDoorsOpen) {
    return "header.debugForceDoorsOpen disagrees with initialState";
  }
  if (header.phase !== md.phase) {
    return "header.phase disagrees with initialState";
  }
  if (!isSupportedReplayFormatVersion(header.replayFormatVersion)) {
    return `unsupported replayFormatVersion: ${String(header.replayFormatVersion)}`;
  }
  if (!isSupportedReplayFormatVersion(md.replayFormatVersion)) {
    return `initialState metadata replayFormatVersion must be ${REPLAY_FORMAT_VERSION}`;
  }
  return null;
}

function validateTickKey(
  label: string,
  tick: unknown,
  firstTick: number,
  lastTick: number,
): string | null {
  const t = finiteNonNegInt(tick);
  if (t === null) {
    return `${label}: tick must be a non-negative integer`;
  }
  if (t < firstTick || t > lastTick) {
    return `${label}: tick ${t} out of range [${firstTick}, ${lastTick}]`;
  }
  return null;
}

/**
 * Loud validation of a raw container-shaped value.
 * Fails on missing load-bearing sections, bad ticks, unsupported map version,
 * missing seed, or version mismatch. Never reads sim/network/blob/SQL.
 */
export function validateReplayContainer(
  raw: unknown,
): ReplayContainerValidateResult {
  if (raw == null || typeof raw !== "object") {
    return { ok: false, reason: "container must be an object" };
  }
  const o = raw as Record<string, unknown>;

  // SQL/blob separation: location must never live inside the container.
  for (const banned of [
    "filePath",
    "file_path",
    "url",
    "blobUrl",
    "rowId",
    "row_id",
  ] as const) {
    if (banned in o) {
      return { ok: false, reason: `container must not carry location field: ${banned}` };
    }
  }

  if (!("header" in o) || o.header == null || typeof o.header !== "object") {
    return { ok: false, reason: "missing required section: header" };
  }
  if (
    !("initialState" in o) ||
    o.initialState == null ||
    typeof o.initialState !== "object"
  ) {
    return { ok: false, reason: "missing required section: initialState" };
  }
  if (!("metadata" in o) || o.metadata == null || typeof o.metadata !== "object") {
    return { ok: false, reason: "missing required section: metadata" };
  }
  if (!Array.isArray(o.inputStream)) {
    return { ok: false, reason: "missing required section: inputStream" };
  }
  if (!Array.isArray(o.eventStream)) {
    return { ok: false, reason: "missing required section: eventStream" };
  }
  if (!Array.isArray(o.checkpoints)) {
    return { ok: false, reason: "missing required section: checkpoints" };
  }
  if (!("index" in o) || o.index == null || typeof o.index !== "object") {
    return { ok: false, reason: "missing reserved section: index" };
  }
  if (!("integrity" in o) || o.integrity == null || typeof o.integrity !== "object") {
    return { ok: false, reason: "missing reserved section: integrity" };
  }

  const header = o.header as Record<string, unknown>;
  const init = o.initialState as RecordedInitialState;
  const metaSection = o.metadata as Record<string, unknown>;

  if (typeof init.runtimeMatchId !== "string" || init.runtimeMatchId.length === 0) {
    return { ok: false, reason: "initialState.runtimeMatchId missing" };
  }
  if (init.metadata == null || typeof init.metadata !== "object") {
    return { ok: false, reason: "initialState.metadata missing" };
  }
  if (init.init == null || typeof init.init !== "object") {
    return { ok: false, reason: "initialState.init missing" };
  }

  const version = header.replayFormatVersion;
  if (!isSupportedReplayFormatVersion(version)) {
    return {
      ok: false,
      reason: `unsupported replayFormatVersion: ${String(version)} (expected ${REPLAY_FORMAT_VERSION})`,
    };
  }

  const firstTick = finiteNonNegInt(header.firstTick);
  const lastTick = finiteNonNegInt(header.lastTick);
  if (firstTick === null || lastTick === null) {
    return { ok: false, reason: "header.firstTick/lastTick must be non-negative integers" };
  }
  if (lastTick < firstTick) {
    return { ok: false, reason: "header.lastTick < firstTick" };
  }

  const captureTick = finiteNonNegInt(header.captureTick);
  if (captureTick === null) {
    return { ok: false, reason: "header.captureTick must be a non-negative integer" };
  }

  const matchSeed = finiteNonNegInt(header.matchSeed);
  if (matchSeed === null) {
    return { ok: false, reason: "header.matchSeed missing or invalid" };
  }

  const map = header.map;
  if (map == null || typeof map !== "object") {
    return { ok: false, reason: "header.map missing" };
  }
  const mapObj = map as Record<string, unknown>;
  if (typeof mapObj.name !== "string" || mapObj.name.length === 0) {
    return { ok: false, reason: "header.map.name missing" };
  }
  if (!isSupportedMapFormatVersion(mapObj.version)) {
    return { ok: false, reason: "unsupported map version (never defaulted)" };
  }

  if (header.tickRate !== TICK_HZ) {
    return { ok: false, reason: `header.tickRate must be ${TICK_HZ}` };
  }

  if (typeof header.runtimeMatchId !== "string" || header.runtimeMatchId.length === 0) {
    return { ok: false, reason: "header.runtimeMatchId missing" };
  }

  const typedHeader = header as unknown as ReplayContainerHeader;
  const agree = assertHeaderInitAgreement(typedHeader, init);
  if (agree) return { ok: false, reason: agree };

  // Metadata section: informational fields only (annotation).
  for (const key of [
    "serverName",
    "gameProto",
    "capturedAtIso",
  ] as const) {
    if (!(key in metaSection)) {
      return { ok: false, reason: `metadata.${key} missing` };
    }
  }
  if (typeof metaSection.capturedAtIso !== "string") {
    return { ok: false, reason: "metadata.capturedAtIso must be a string" };
  }
  if (metaSection.serverName !== init.metadata.serverName) {
    return { ok: false, reason: "metadata.serverName disagrees with initialState" };
  }
  if (metaSection.gameProto !== init.metadata.gameProto) {
    return { ok: false, reason: "metadata.gameProto disagrees with initialState" };
  }

  const inputStream = o.inputStream as RecordedTickInputs[];
  const eventStream = o.eventStream as RecordedTickEvents[];
  const checkpoints = o.checkpoints as AuthoritativeCheckpoint[];

  // Degenerate: empty inputs only when firstTick === lastTick.
  if (inputStream.length === 0 && firstTick !== lastTick) {
    return {
      ok: false,
      reason: "inputStream empty only valid for zero-tick degenerate (firstTick === lastTick)",
    };
  }

  // Input stream: unique, ordered, in-range; contiguous coverage of [firstTick, lastTick]
  // when non-empty. (firstTick/lastTick are the stream window, distinct from captureTick.)
  let prevInputTick = firstTick - 1;
  for (let i = 0; i < inputStream.length; i++) {
    const row = inputStream[i]!;
    const err = validateTickKey(`inputStream[${i}]`, row.tick, firstTick, lastTick);
    if (err) return { ok: false, reason: err };
    if (row.tick <= prevInputTick) {
      return {
        ok: false,
        reason: `inputStream ticks must be strictly ascending (duplicate or out-of-order at ${row.tick})`,
      };
    }
    if (row.tick !== prevInputTick + 1 && prevInputTick >= firstTick) {
      return {
        ok: false,
        reason: `inputStream gap: expected tick ${prevInputTick + 1}, got ${row.tick}`,
      };
    }
    prevInputTick = row.tick;
  }
  if (inputStream.length > 0) {
    if (inputStream[0]!.tick !== firstTick) {
      return {
        ok: false,
        reason: `inputStream must start at firstTick ${firstTick}, got ${inputStream[0]!.tick}`,
      };
    }
    if (inputStream[inputStream.length - 1]!.tick !== lastTick) {
      // lastTick may be extended by events/checkpoints beyond inputs only when
      // those are within range — still require contiguous input coverage of the
      // input span; lastTick must equal max stream tick so inputs must reach it
      // when inputs are the sole contributors. When events/checkpoints extend
      // lastTick past inputs, require inputs cover [firstTick, lastInput] with
      // no gaps, and last input ≤ lastTick (already checked). Strict "cover
      // every tick in range" means inputs for every tick in [firstTick, lastTick]:
      return {
        ok: false,
        reason: `inputStream must cover every tick in [${firstTick}, ${lastTick}]`,
      };
    }
  }

  // Event stream: per-tick lists; appliedTick in range; ticks ordered.
  let prevEventTick = firstTick - 1;
  for (let i = 0; i < eventStream.length; i++) {
    const row = eventStream[i]!;
    const err = validateTickKey(`eventStream[${i}]`, row.tick, firstTick, lastTick);
    if (err) return { ok: false, reason: err };
    if (row.tick < prevEventTick) {
      return { ok: false, reason: `eventStream ticks must be ascending (at ${row.tick})` };
    }
    if (!Array.isArray(row.events)) {
      return { ok: false, reason: `eventStream[${i}].events must be an array` };
    }
    for (let j = 0; j < row.events.length; j++) {
      const ev = row.events[j] as AuthoritativeEvent;
      if (ev == null || typeof ev !== "object") {
        return { ok: false, reason: `eventStream[${i}].events[${j}] invalid` };
      }
      const applied = finiteNonNegInt(ev.appliedTick);
      if (applied === null) {
        return {
          ok: false,
          reason: `eventStream[${i}].events[${j}].appliedTick invalid`,
        };
      }
      // appliedTick may precede the input-stream window (joins / matchStart
      // buffered before the first onTick) but must not exceed lastTick.
      if (applied > lastTick) {
        return {
          ok: false,
          reason: `eventStream[${i}].events[${j}].appliedTick ${applied} > lastTick ${lastTick}`,
        };
      }
    }
    prevEventTick = row.tick;
  }

  // Checkpoints: ordered, in-range; empty valid.
  let prevCpTick = firstTick - 1;
  for (let i = 0; i < checkpoints.length; i++) {
    const cp = checkpoints[i]!;
    const err = validateTickKey(`checkpoints[${i}]`, cp.tick, firstTick, lastTick);
    if (err) return { ok: false, reason: err };
    if (cp.tick <= prevCpTick) {
      return {
        ok: false,
        reason: `checkpoints must be strictly ascending by tick (at ${cp.tick})`,
      };
    }
    if (cp.runtimeMatchId !== typedHeader.runtimeMatchId) {
      return {
        ok: false,
        reason: `checkpoints[${i}].runtimeMatchId disagrees with header`,
      };
    }
    prevCpTick = cp.tick;
  }

  const indexRaw = o.index;
  let index: ReplayContainerIndex;
  if (isEmptyReplayContainerIndex(indexRaw)) {
    if (indexRaw.entries.length !== 0) {
      return { ok: false, reason: "empty index.entries must be []" };
    }
    index = indexRaw;
  } else {
    const indexValidated = validateReplayIndex(indexRaw);
    if (!indexValidated.ok) {
      return { ok: false, reason: `index: ${indexValidated.reason}` };
    }
    index = indexValidated.index;
    // Derived consistency: file checkpoint table must match Checkpoints section.
    const cpTicks = checkpoints.map((c) => c.tick);
    if (index.checkpoints.length !== cpTicks.length) {
      return {
        ok: false,
        reason: "index.checkpoints length disagrees with checkpoints section",
      };
    }
    for (let i = 0; i < cpTicks.length; i++) {
      if (index.checkpoints[i] !== cpTicks[i]) {
        return {
          ok: false,
          reason: `index.checkpoints[${i}] disagrees with checkpoints section`,
        };
      }
    }
  }

  const integrity = o.integrity as Record<string, unknown>;
  if (integrity.schemaNote !== "reserved-for-10.4") {
    return {
      ok: false,
      reason: "integrity.schemaNote must be reserved-for-10.4 in 10.1",
    };
  }
  if (integrity.digest !== null) {
    return { ok: false, reason: "integrity.digest must be null in 10.1 (10.4 owns hashes)" };
  }

  const container: ReplayContainer = {
    header: typedHeader,
    metadata: metaSection as unknown as ReplayContainerMetadata,
    initialState: init,
    inputStream,
    eventStream,
    checkpoints,
    index,
    integrity: integrity as unknown as ReplayContainerIntegrity,
  };

  return { ok: true, container };
}
