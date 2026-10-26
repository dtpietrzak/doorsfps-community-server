/**
 * Epic 8.2 — recorded initial state: thin container + capture/validate/freeze.
 *
 * The initial state IS `MatchInitEvent` + `MatchMetadata` at the recording-start
 * tick (verbatim 7.5 / 7.4 reads). This module adds no parallel field shape.
 *
 * Contract (see notes/replay/08-replay-recording/08-02-initial-state-recording.md):
 * - Deep-frozen copies only — never live owner references.
 * - Fail-loud on unsupported map version, missing load-bearing values, or
 *   init↔metadata disagreement.
 * - Map identity only (`name + version`); no map bytes.
 * - Deterministic RNG: record `matchSeed` + construction rule below; do not
 *   serialize live stream positions.
 * - No snapshot-path imports (`createSnapshot` / `toSnapshot`).
 * - Memory-only; no store / file / finalized writes.
 */

import type { MatchInitEvent } from "../shared/sim/authoritativeEvent.ts";
import { isSupportedMapFormatVersion } from "../shared/world/doorsMapFormat.ts";
import {
  MATCH_METADATA_EXCLUDED_WALL_CLOCK_KEYS,
  MATCH_METADATA_FIELD_SPECS,
  type MatchMetadata,
} from "../shared/replay/matchMetadata.ts";
import type { ReplayMatchInitPayload } from "./replayIntegration.ts";
import type { AuthoritativeCheckpoint } from "./authoritativeCheckpoint.ts";

/**
 * Playback (11.x) must rebuild opening domain streams from the recorded seed:
 * `createMatchSimRngStreams(matchSeed)` then `collision.reseedSpawnRng(spawn)`.
 * Mid-match attach is out of scope here — use a #9 checkpoint.
 */
export const REPLAY_RNG_CONSTRUCTION_RULE =
  "createMatchSimRngStreams(matchSeed) + collision.reseedSpawnRng(spawn)";

/** Per-entry fields that must be present on every roster snapshot. */
export const ROSTER_ENTRY_REQUIRED_KEYS = [
  "id",
  "name",
  "team",
  "isBot",
  "isAgent",
  "isBalanceBot",
  "alive",
  "pose",
  "equipment",
  "skillLoadout",
  "ownedAbilities",
  "maxHealth",
  "modelScale",
  "moveSpeedScale",
] as const;

/**
 * Wall-clock / operational keys that must never appear on captured init,
 * metadata, or roster entries (mirrors 7.4 + AuthoritativeRosterSnapshot).
 */
export const WALL_CLOCK_EXCLUDED_KEYS = MATCH_METADATA_EXCLUDED_WALL_CLOCK_KEYS;

/**
 * Frozen initial-state capture for one `runtimeMatchId` session.
 * Consumed by 8.5 buffers / 8.6 finalization / #10 / 11.1 via
 * `ReplayRecorder.getInitialState(runtimeMatchId)`.
 */
export type RecordedInitialState = {
  readonly runtimeMatchId: string;
  /** Start tick at which init + metadata were captured (`init.appliedTick`). */
  readonly captureTick: number;
  readonly init: Readonly<MatchInitEvent>;
  readonly metadata: Readonly<MatchMetadata>;
  /**
   * Full 9.1 authoritative state at `captureTick`, captured at the same moment
   * as `init`. Recording usually starts mid-match (first human seats), so the
   * `init` roster alone cannot rebuild health / ammo / timers / door clock —
   * playback restores from this frame when present. Optional for fixtures and
   * recordings made before it existed.
   */
  readonly startCheckpoint?: AuthoritativeCheckpoint;
};

export type CaptureInitialStateResult =
  | { ok: true; state: RecordedInitialState }
  | { ok: false; reason: string };

/**
 * Validate the 7.5 init payload, deep-clone, and deep-freeze.
 * Does not touch live sim state or the replays store.
 */
export function captureRecordedInitialState(
  payload: Readonly<ReplayMatchInitPayload>,
  runtimeMatchId: string,
  startCheckpoint?: AuthoritativeCheckpoint,
): CaptureInitialStateResult {
  if (typeof runtimeMatchId !== "string" || runtimeMatchId.length === 0) {
    return { ok: false, reason: "runtimeMatchId required" };
  }
  if (payload == null || typeof payload !== "object") {
    return { ok: false, reason: "init payload missing" };
  }

  const init = payload.initEvent;
  const metadata = payload.metadata;
  if (init == null || typeof init !== "object") {
    return { ok: false, reason: "initEvent missing" };
  }
  if (metadata == null || typeof metadata !== "object") {
    return { ok: false, reason: "metadata missing" };
  }

  const loadBearing = validateLoadBearing(init, metadata);
  if (!loadBearing.ok) return loadBearing;

  const agreement = assertInitMetadataAgreement(init, metadata, runtimeMatchId);
  if (!agreement.ok) return agreement;

  const excluded = assertNoWallClockKeys(init, metadata);
  if (!excluded.ok) return excluded;

  if (startCheckpoint !== undefined) {
    if (startCheckpoint.tick !== init.appliedTick) {
      return {
        ok: false,
        reason:
          `startCheckpoint.tick (${startCheckpoint.tick}) !== init.appliedTick (${init.appliedTick})`,
      };
    }
    if (startCheckpoint.runtimeMatchId !== runtimeMatchId) {
      return { ok: false, reason: "startCheckpoint.runtimeMatchId !== session" };
    }
  }

  // Structured-clone-equivalent freeze point: independent of live owners.
  const frozenInit = deepFreeze(structuredClone(init)) as MatchInitEvent;
  const frozenMeta = deepFreeze(structuredClone(metadata)) as MatchMetadata;

  return {
    ok: true,
    state: deepFreeze({
      runtimeMatchId,
      captureTick: frozenInit.appliedTick,
      init: frozenInit,
      metadata: frozenMeta,
      ...(startCheckpoint !== undefined
        ? { startCheckpoint: structuredClone(startCheckpoint) }
        : {}),
    }),
  };
}

function validateLoadBearing(
  init: Readonly<MatchInitEvent>,
  metadata: Readonly<MatchMetadata>,
): CaptureInitialStateResult | { ok: true } {
  if (init.kind !== "matchInit") {
    return { ok: false, reason: `init.kind must be matchInit, got ${String(init.kind)}` };
  }

  if (!Number.isInteger(init.appliedTick) || init.appliedTick < 0) {
    return { ok: false, reason: "init.appliedTick must be a non-negative integer" };
  }
  if (!Number.isInteger(metadata.captureTick) || metadata.captureTick < 0) {
    return { ok: false, reason: "metadata.captureTick must be a non-negative integer" };
  }

  if (!init.map || typeof init.map.name !== "string" || init.map.name.length === 0) {
    return { ok: false, reason: "init.map.name required" };
  }
  if (!isSupportedMapFormatVersion(init.map.version)) {
    return {
      ok: false,
      reason: `unsupported map version: ${String(init.map.version)}`,
    };
  }
  if (!metadata.map || typeof metadata.map.name !== "string" ||
    metadata.map.name.length === 0
  ) {
    return { ok: false, reason: "metadata.map.name required" };
  }
  if (!isSupportedMapFormatVersion(metadata.map.version)) {
    return {
      ok: false,
      reason: `unsupported metadata map version: ${String(metadata.map.version)}`,
    };
  }

  if (!Number.isInteger(init.matchSeed) || init.matchSeed < 0) {
    return { ok: false, reason: "init.matchSeed must be a non-negative integer" };
  }
  if (!Number.isInteger(metadata.matchSeed) || metadata.matchSeed < 0) {
    return { ok: false, reason: "metadata.matchSeed must be a non-negative integer" };
  }

  if (!Number.isInteger(init.matchDurationTicks) || init.matchDurationTicks < 1) {
    return { ok: false, reason: "init.matchDurationTicks must be a positive integer" };
  }
  if (
    !Number.isInteger(metadata.matchDurationTicks) ||
    metadata.matchDurationTicks < 1
  ) {
    return {
      ok: false,
      reason: "metadata.matchDurationTicks must be a positive integer",
    };
  }
  if (!Number.isInteger(metadata.matchEndTick) || metadata.matchEndTick < 0) {
    return { ok: false, reason: "metadata.matchEndTick must be a non-negative integer" };
  }
  if (
    !Number.isInteger(metadata.doorCycleOriginTick) ||
    metadata.doorCycleOriginTick < 0
  ) {
    return {
      ok: false,
      reason: "metadata.doorCycleOriginTick must be a non-negative integer",
    };
  }

  if (typeof init.prematchEnabled !== "boolean") {
    return { ok: false, reason: "init.prematchEnabled must be boolean" };
  }
  if (typeof init.debugForceDoorsOpen !== "boolean") {
    return { ok: false, reason: "init.debugForceDoorsOpen must be boolean" };
  }
  if (typeof init.raidDoorPolicy !== "string" || init.raidDoorPolicy.length === 0) {
    return { ok: false, reason: "init.raidDoorPolicy required" };
  }
  if (typeof init.phase !== "string" || init.phase.length === 0) {
    return { ok: false, reason: "init.phase required" };
  }

  if (!init.scores || typeof init.scores !== "object") {
    return { ok: false, reason: "init.scores required" };
  }
  if (!Number.isInteger(init.scores.A) || !Number.isInteger(init.scores.B)) {
    return { ok: false, reason: "init.scores.A/B must be integers" };
  }

  if (!Array.isArray(init.roster)) {
    return { ok: false, reason: "init.roster must be an array" };
  }
  for (let i = 0; i < init.roster.length; i++) {
    const row = init.roster[i];
    if (row == null || typeof row !== "object") {
      return { ok: false, reason: `init.roster[${i}] missing` };
    }
    for (const key of ROSTER_ENTRY_REQUIRED_KEYS) {
      if (!(key in row)) {
        return { ok: false, reason: `init.roster[${i}].${key} required` };
      }
    }
    if (row.pose == null || typeof row.pose !== "object") {
      return { ok: false, reason: `init.roster[${i}].pose required` };
    }
    if (row.equipment == null || typeof row.equipment !== "object") {
      return { ok: false, reason: `init.roster[${i}].equipment required` };
    }
  }

  if (!Array.isArray(metadata.roster)) {
    return { ok: false, reason: "metadata.roster must be an array" };
  }

  // Every MATCH_METADATA_FIELD_SPECS load-bearing key must be present.
  for (const [key, spec] of Object.entries(MATCH_METADATA_FIELD_SPECS)) {
    if (spec.class !== "loadBearing") continue;
    if (!(key in metadata)) {
      return { ok: false, reason: `metadata.${key} (load-bearing) required` };
    }
  }

  return { ok: true };
}

function assertInitMetadataAgreement(
  init: Readonly<MatchInitEvent>,
  metadata: Readonly<MatchMetadata>,
  runtimeMatchId: string,
): CaptureInitialStateResult | { ok: true } {
  if (metadata.runtimeMatchId !== runtimeMatchId) {
    return {
      ok: false,
      reason:
        `metadata.runtimeMatchId ${JSON.stringify(metadata.runtimeMatchId)} !== session ${JSON.stringify(runtimeMatchId)}`,
    };
  }
  if (init.appliedTick !== metadata.captureTick) {
    return {
      ok: false,
      reason:
        `init.appliedTick (${init.appliedTick}) !== metadata.captureTick (${metadata.captureTick})`,
    };
  }
  if (init.matchSeed !== metadata.matchSeed) {
    return {
      ok: false,
      reason:
        `matchSeed disagreement: init=${init.matchSeed} metadata=${metadata.matchSeed}`,
    };
  }
  if (
    init.map.name !== metadata.map.name ||
    init.map.version !== metadata.map.version
  ) {
    return {
      ok: false,
      reason:
        `map disagreement: init=${init.map.name}@${init.map.version} metadata=${metadata.map.name}@${metadata.map.version}`,
    };
  }
  if (init.matchDurationTicks !== metadata.matchDurationTicks) {
    return {
      ok: false,
      reason: "matchDurationTicks disagreement between init and metadata",
    };
  }
  if (init.prematchEnabled !== metadata.prematchEnabled) {
    return { ok: false, reason: "prematchEnabled disagreement" };
  }
  if (init.raidDoorPolicy !== metadata.raidDoorPolicy) {
    return { ok: false, reason: "raidDoorPolicy disagreement" };
  }
  if (init.debugForceDoorsOpen !== metadata.debugForceDoorsOpen) {
    return { ok: false, reason: "debugForceDoorsOpen disagreement" };
  }
  if (init.phase !== metadata.phase) {
    return { ok: false, reason: "phase disagreement" };
  }
  if (init.scores.A !== metadata.scores.A || init.scores.B !== metadata.scores.B) {
    return { ok: false, reason: "scores disagreement" };
  }
  if (!stableEqual(init.roster, metadata.roster)) {
    return { ok: false, reason: "roster disagreement between init and metadata" };
  }
  return { ok: true };
}

function assertNoWallClockKeys(
  init: Readonly<MatchInitEvent>,
  metadata: Readonly<MatchMetadata>,
): CaptureInitialStateResult | { ok: true } {
  const hit = findWallClockKey(init) ?? findWallClockKey(metadata);
  if (hit) {
    return { ok: false, reason: `wall-clock key present: ${hit}` };
  }
  return { ok: true };
}

function findWallClockKey(value: unknown, path = ""): string | null {
  if (value == null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findWallClockKey(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if ((WALL_CLOCK_EXCLUDED_KEYS as readonly string[]).includes(key)) {
      return path ? `${path}.${key}` : key;
    }
    const hit = findWallClockKey(obj[key], path ? `${path}.${key}` : key);
    if (hit) return hit;
  }
  return null;
}

function stableEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Recursive freeze so accessor callers cannot mutate stored capture. */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Reflect.ownKeys(value as object)) {
    // deno-lint-ignore no-explicit-any
    deepFreeze((value as any)[key]);
  }
  return value;
}
