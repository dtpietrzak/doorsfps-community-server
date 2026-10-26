/**
 * Epic 10.3 — replay file index (tick-anchored seek tables).
 *
 * Fills the 10.1 Index slot with four derived tables:
 *   checkpoints | markers | phases | playerActivity
 *
 * Contract (see notes/replay/10-replay-file-format/10-03-replay-index.md):
 * - Derived, never authoritative: rebuild from sibling sections → deep-equal.
 * - Tick-keyed everywhere; time is `tick * TICK_MS` / `floor(timeMs / TICK_MS)`.
 * - No byte offsets stored (16.5 derives those post-encode outside hashed bytes).
 * - 9.5-parity floor: exact → self; mid → prior; before-first/empty → miss;
 *   at/after-last → last. Never clamp-forward.
 * - Pure: no filesystem, blob, store, codec, compression, hash, or `net/` imports.
 *
 * Marker taxonomy (closed; combatBurst excluded — high-frequency sim-outcome;
 * deaths already mark kills):
 *   playerDied → death
 *   score → doorCapture  (ScoreEvent is the door-capture score)
 *   matchStart | matchEnd | matchDraw | gameOver → phaseChange
 *   humanJoin | botAdd | playerRemove | playerRespawned → roster
 *   agentAdd | agentRemove → agent
 */

import type {
  AuthoritativeEvent,
  AuthoritativeEventKind,
  AuthoritativeMatchPhase,
} from "../shared/sim/authoritativeEvent.ts";
import type { AuthoritativeCheckpoint } from "./authoritativeCheckpoint.ts";
import { timeMsToTick } from "./checkpointIndex.ts";
import { deepFreeze } from "./recordedInitialState.ts";
import type { RecordedTickEvents } from "./recordedTickEvents.ts";
import type { RecordedTickInputs } from "./recordedTickInputs.ts";

export { tickToTimeMs, timeMsToTick, tickToTimeSec } from "./checkpointIndex.ts";

/** Index schema stamp — taxonomy changes ride this, not the container version. */
export const REPLAY_INDEX_VERSION = 1 as const;
export type ReplayIndexVersion = typeof REPLAY_INDEX_VERSION;

export type ReplayMarkerKind =
  | "death"
  | "doorCapture"
  | "phaseChange"
  | "roster"
  | "agent";

/**
 * Index phase labels. `intermission` from live metadata maps to `prematch`.
 * Terminal variants: `ended` (matchEnd), `draw` (matchDraw), `gameOver`.
 */
export type ReplayIndexPhase =
  | "prematch"
  | "live"
  | "ended"
  | "draw"
  | "gameOver";

export type ReplayIndexMarker = {
  readonly tick: number;
  readonly markerKind: ReplayMarkerKind;
  readonly eventKind: AuthoritativeEventKind;
  readonly involvedPlayerIds: readonly string[];
};

export type ReplayIndexPhaseSpan = {
  readonly phase: ReplayIndexPhase;
  readonly startTick: number;
  readonly endTick: number;
};

export type ReplayIndexPlayerSpan = {
  readonly playerId: string;
  readonly firstTick: number;
  readonly lastTick: number;
  /** Count of input-stream ticks where this player had a movement row. */
  readonly ticksPresent: number;
};

/**
 * File-level seek tables. Placed as the 10.1 Index section when filled.
 * Empty 10.1 reserved `{ schemaNote, entries: [] }` remains valid (no tables).
 */
export type ReplayIndex = {
  readonly indexVersion: ReplayIndexVersion;
  /** Ascending checkpoint ticks (anchor + periodic + final). Empty valid. */
  readonly checkpoints: readonly number[];
  /** Tick-ascending; drain order preserved within a tick. */
  readonly markers: readonly ReplayIndexMarker[];
  /** Gapless, non-overlapping spans covering [firstTick, lastTick]. */
  readonly phases: readonly ReplayIndexPhaseSpan[];
  /** Sorted by playerId; spans within file tick range. */
  readonly playerActivity: readonly ReplayIndexPlayerSpan[];
};

/** Closed eventKind → markerKind map. Unlisted kinds produce no marker. */
export const REPLAY_EVENT_TO_MARKER_KIND: Readonly<
  Partial<Record<AuthoritativeEventKind, ReplayMarkerKind>>
> = Object.freeze({
  playerDied: "death",
  score: "doorCapture",
  matchStart: "phaseChange",
  matchEnd: "phaseChange",
  matchDraw: "phaseChange",
  gameOver: "phaseChange",
  humanJoin: "roster",
  botAdd: "roster",
  playerRemove: "roster",
  playerRespawned: "roster",
  agentAdd: "agent",
  agentRemove: "agent",
  // Excluded (budget / not seek landmarks):
  // combatBurst — high-frequency; deaths cover kills
  // matchInit — diverted to initial state
  // matchConfig, connectionStatus, teamAssign, loadoutCommit, readyVote
});

export type BuildReplayIndexArgs = {
  readonly inputRows: ReadonlyArray<RecordedTickInputs>;
  readonly eventRows: ReadonlyArray<RecordedTickEvents>;
  readonly checkpoints: ReadonlyArray<
    Pick<AuthoritativeCheckpoint, "tick"> | { readonly tick: number }
  >;
  /** Inclusive stream window (header firstTick/lastTick). */
  readonly firstTick: number;
  readonly lastTick: number;
  /**
   * Phase before the first lifecycle marker (from header/init).
   * `intermission` maps to `prematch`. Defaults to `prematch`.
   */
  readonly initialPhase?: AuthoritativeMatchPhase | ReplayIndexPhase;
};

export type ReplayCheckpointTickHit = {
  readonly kind: "hit";
  readonly tick: number;
};

export type ReplayCheckpointTickMiss = {
  readonly kind: "miss";
  readonly reason: "empty" | "before-first";
};

export type ReplayCheckpointTickLookup =
  | ReplayCheckpointTickHit
  | ReplayCheckpointTickMiss;

export class ReplayIndexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayIndexError";
  }
}

function assertValidTick(label: string, tick: number): void {
  if (typeof tick !== "number" || !Number.isFinite(tick) || !Number.isInteger(tick)) {
    throw new ReplayIndexError(`${label}: tick must be a finite integer (got ${String(tick)})`);
  }
  if (tick < 0) {
    throw new ReplayIndexError(`${label}: tick must be non-negative (got ${tick})`);
  }
}

function mapInitialPhase(
  phase: AuthoritativeMatchPhase | ReplayIndexPhase | undefined,
): ReplayIndexPhase {
  if (phase === "live") return "live";
  if (phase === "ended" || phase === "draw" || phase === "gameOver") return phase;
  // prematch | intermission | undefined → prematch
  return "prematch";
}

function involvedPlayerIds(event: AuthoritativeEvent): string[] {
  switch (event.kind) {
    case "playerDied": {
      const ids = [event.victimId];
      if (event.killerId && event.killerId !== event.victimId) {
        ids.push(event.killerId);
      }
      return ids;
    }
    case "score":
      return [event.scorerId];
    case "humanJoin":
    case "botAdd":
    case "agentAdd":
    case "playerRespawned":
      return [event.player.id];
    case "agentRemove":
    case "playerRemove":
      return [event.playerId];
    default:
      return [];
  }
}

function markerFromEvent(event: AuthoritativeEvent): ReplayIndexMarker | null {
  const markerKind = REPLAY_EVENT_TO_MARKER_KIND[event.kind];
  if (markerKind === undefined) return null;
  return {
    tick: event.appliedTick,
    markerKind,
    eventKind: event.kind,
    involvedPlayerIds: involvedPlayerIds(event),
  };
}

function buildCheckpointTicks(
  checkpoints: BuildReplayIndexArgs["checkpoints"],
): number[] {
  const ticks = checkpoints.map((c) => c.tick);
  for (const t of ticks) assertValidTick("checkpoints", t);
  // Ascending copy — source should already be ordered; sort for determinism.
  return ticks.slice().sort((a, b) => a - b);
}

function buildMarkers(
  eventRows: ReadonlyArray<RecordedTickEvents>,
): ReplayIndexMarker[] {
  const markers: ReplayIndexMarker[] = [];
  for (const row of eventRows) {
    for (const event of row.events) {
      const marker = markerFromEvent(event);
      if (marker !== null) markers.push(marker);
    }
  }
  return markers;
}

/**
 * Gapless phase spans over [firstTick, lastTick] from lifecycle events.
 */
function buildPhases(
  eventRows: ReadonlyArray<RecordedTickEvents>,
  firstTick: number,
  lastTick: number,
  initialPhase: ReplayIndexPhase,
): ReplayIndexPhaseSpan[] {
  assertValidTick("firstTick", firstTick);
  assertValidTick("lastTick", lastTick);
  if (lastTick < firstTick) {
    throw new ReplayIndexError(
      `lastTick ${lastTick} < firstTick ${firstTick}`,
    );
  }

  const spans: ReplayIndexPhaseSpan[] = [];
  let phase: ReplayIndexPhase = initialPhase;
  let spanStart = firstTick;

  const commitTransition = (atTick: number, nextPhase: ReplayIndexPhase) => {
    if (nextPhase === phase) return;
    if (atTick > spanStart) {
      spans.push({
        phase,
        startTick: spanStart,
        endTick: atTick - 1,
      });
      phase = nextPhase;
      spanStart = atTick;
      return;
    }
    if (atTick === spanStart) {
      // Same-tick replace (e.g. matchEnd then gameOver): keep start, rename.
      phase = nextPhase;
      return;
    }
    // atTick < spanStart — ignore out-of-window / out-of-order lifecycle.
  };

  for (const row of eventRows) {
    for (const event of row.events) {
      const t = event.appliedTick;
      switch (event.kind) {
        case "matchStart":
          commitTransition(t, "live");
          break;
        case "matchEnd":
          commitTransition(t, "ended");
          break;
        case "matchDraw":
          commitTransition(t, "draw");
          break;
        case "gameOver":
          commitTransition(t, "gameOver");
          break;
        default:
          break;
      }
    }
  }

  spans.push({ phase, startTick: spanStart, endTick: lastTick });
  return spans;
}

function buildPlayerActivity(
  inputRows: ReadonlyArray<RecordedTickInputs>,
  eventRows: ReadonlyArray<RecordedTickEvents>,
): ReplayIndexPlayerSpan[] {
  type Acc = { firstTick: number; lastTick: number; ticksPresent: number };
  const byId = new Map<string, Acc>();

  const touch = (playerId: string, tick: number, countInput: boolean) => {
    const cur = byId.get(playerId);
    if (!cur) {
      byId.set(playerId, {
        firstTick: tick,
        lastTick: tick,
        ticksPresent: countInput ? 1 : 0,
      });
      return;
    }
    if (tick < cur.firstTick) cur.firstTick = tick;
    if (tick > cur.lastTick) cur.lastTick = tick;
    if (countInput) cur.ticksPresent += 1;
  };

  for (const row of inputRows) {
    const seen = new Set<string>();
    for (const movement of row.movement) {
      if (seen.has(movement.playerId)) continue;
      seen.add(movement.playerId);
      touch(movement.playerId, row.tick, true);
    }
  }

  for (const row of eventRows) {
    for (const event of row.events) {
      const markerKind = REPLAY_EVENT_TO_MARKER_KIND[event.kind];
      if (markerKind !== "roster" && markerKind !== "agent") continue;
      for (const id of involvedPlayerIds(event)) {
        touch(id, event.appliedTick, false);
      }
    }
  }

  const ids = [...byId.keys()].sort();
  return ids.map((playerId) => {
    const acc = byId.get(playerId)!;
    return {
      playerId,
      firstTick: acc.firstTick,
      lastTick: acc.lastTick,
      ticksPresent: acc.ticksPresent,
    };
  });
}

/**
 * Pure builder: streams + checkpoints → frozen ReplayIndex.
 * Deterministic: same inputs → same tables (sorted ticks, drain-order markers).
 */
export function buildReplayIndex(args: BuildReplayIndexArgs): ReplayIndex {
  assertValidTick("firstTick", args.firstTick);
  assertValidTick("lastTick", args.lastTick);

  const index: ReplayIndex = {
    indexVersion: REPLAY_INDEX_VERSION,
    checkpoints: buildCheckpointTicks(args.checkpoints),
    markers: buildMarkers(args.eventRows),
    phases: buildPhases(
      args.eventRows,
      args.firstTick,
      args.lastTick,
      mapInitialPhase(args.initialPhase),
    ),
    playerActivity: buildPlayerActivity(args.inputRows, args.eventRows),
  };
  return deepFreeze(index);
}

/** Rebuild from a container's sibling sections (drop existing index). */
export function buildReplayIndexFromContainerSections(args: {
  readonly inputStream: ReadonlyArray<RecordedTickInputs>;
  readonly eventStream: ReadonlyArray<RecordedTickEvents>;
  readonly checkpoints: ReadonlyArray<Pick<AuthoritativeCheckpoint, "tick">>;
  readonly firstTick: number;
  readonly lastTick: number;
  readonly initialPhase?: AuthoritativeMatchPhase | ReplayIndexPhase;
}): ReplayIndex {
  return buildReplayIndex({
    inputRows: args.inputStream,
    eventRows: args.eventStream,
    checkpoints: args.checkpoints,
    firstTick: args.firstTick,
    lastTick: args.lastTick,
    initialPhase: args.initialPhase,
  });
}

function floorCheckpointIndex(ticks: readonly number[], tick: number): number {
  let lo = 0;
  let hi = ticks.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = ticks[mid]!;
    if (v === tick) return mid;
    if (v < tick) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/**
 * 9.5-parity floor over the file checkpoint tick list.
 * Exact → hit; mid-interval → nearest prior; before-first / empty → miss;
 * at/after-last → last. Never clamps forward.
 */
export function findPriorCheckpointTick(
  index: ReplayIndex,
  tick: number,
): ReplayCheckpointTickLookup {
  assertValidTick("findPriorCheckpointTick", tick);
  const ticks = index.checkpoints;
  if (ticks.length === 0) {
    return { kind: "miss", reason: "empty" };
  }
  const idx = floorCheckpointIndex(ticks, tick);
  if (idx < 0) {
    return { kind: "miss", reason: "before-first" };
  }
  return { kind: "hit", tick: ticks[idx]! };
}

/** Time → tick (floor) then identical floor path. */
export function findPriorCheckpointTickByTimeMs(
  index: ReplayIndex,
  timeMs: number,
): ReplayCheckpointTickLookup {
  if (typeof timeMs !== "number" || !Number.isFinite(timeMs)) {
    throw new ReplayIndexError(
      `findPriorCheckpointTickByTimeMs: timeMs must be finite (got ${String(timeMs)})`,
    );
  }
  if (timeMs < 0) {
    throw new ReplayIndexError(
      `findPriorCheckpointTickByTimeMs: timeMs must be non-negative (got ${timeMs})`,
    );
  }
  return findPriorCheckpointTick(index, timeMsToTick(timeMs));
}

/** Markers whose tick equals `tick` (drain order). */
export function markersAt(
  index: ReplayIndex,
  tick: number,
): readonly ReplayIndexMarker[] {
  assertValidTick("markersAt", tick);
  return index.markers.filter((m) => m.tick === tick);
}

/** Markers with `fromTick <= tick <= toTick` (inclusive). */
export function markersInRange(
  index: ReplayIndex,
  fromTick: number,
  toTick: number,
): readonly ReplayIndexMarker[] {
  assertValidTick("markersInRange.fromTick", fromTick);
  assertValidTick("markersInRange.toTick", toTick);
  if (toTick < fromTick) {
    throw new ReplayIndexError(
      `markersInRange: toTick ${toTick} < fromTick ${fromTick}`,
    );
  }
  return index.markers.filter((m) => m.tick >= fromTick && m.tick <= toTick);
}

/** Activity span for a player, or null when absent. */
export function activityForPlayer(
  index: ReplayIndex,
  playerId: string,
): ReplayIndexPlayerSpan | null {
  if (typeof playerId !== "string" || playerId.length === 0) {
    throw new ReplayIndexError("activityForPlayer: playerId must be a non-empty string");
  }
  for (const span of index.playerActivity) {
    if (span.playerId === playerId) return span;
  }
  return null;
}

export type ReplayIndexValidateOk = { ok: true; index: ReplayIndex };
export type ReplayIndexValidateError = { ok: false; reason: string };
export type ReplayIndexValidateResult =
  | ReplayIndexValidateOk
  | ReplayIndexValidateError;

function finiteNonNegInt(n: unknown): number | null {
  if (typeof n !== "number" || !Number.isFinite(n) || !Number.isInteger(n)) {
    return null;
  }
  if (n < 0) return null;
  return n;
}

const MARKER_KINDS = new Set<string>([
  "death",
  "doorCapture",
  "phaseChange",
  "roster",
  "agent",
]);

const PHASE_LABELS = new Set<string>([
  "prematch",
  "live",
  "ended",
  "draw",
  "gameOver",
]);

/**
 * Loud validation of a filled index value.
 * Unknown `indexVersion` fails (10.5/#17 owns migration policy).
 */
export function validateReplayIndex(raw: unknown): ReplayIndexValidateResult {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "index must be an object" };
  }
  const o = raw as Record<string, unknown>;

  for (const banned of [
    "filePath",
    "file_path",
    "url",
    "blobUrl",
    "rowId",
    "byteOffset",
    "byte_offset",
    "sha256",
    "checksum",
  ] as const) {
    if (banned in o) {
      return { ok: false, reason: `index must not carry field: ${banned}` };
    }
  }

  if (o.indexVersion !== REPLAY_INDEX_VERSION) {
    return {
      ok: false,
      reason: `unsupported indexVersion: ${String(o.indexVersion)} (expected ${REPLAY_INDEX_VERSION})`,
    };
  }
  if (!Array.isArray(o.checkpoints)) {
    return { ok: false, reason: "index.checkpoints must be an array" };
  }
  if (!Array.isArray(o.markers)) {
    return { ok: false, reason: "index.markers must be an array" };
  }
  if (!Array.isArray(o.phases)) {
    return { ok: false, reason: "index.phases must be an array" };
  }
  if (!Array.isArray(o.playerActivity)) {
    return { ok: false, reason: "index.playerActivity must be an array" };
  }

  let prevCp = -1;
  for (let i = 0; i < o.checkpoints.length; i++) {
    const t = finiteNonNegInt(o.checkpoints[i]);
    if (t === null) {
      return { ok: false, reason: `index.checkpoints[${i}] must be a non-negative integer` };
    }
    if (t < prevCp) {
      return { ok: false, reason: "index.checkpoints must be ascending" };
    }
    // Allow equal? Checkpoint ticks should be unique. Strictly ascending.
    if (t === prevCp) {
      return { ok: false, reason: `index.checkpoints duplicate tick ${t}` };
    }
    prevCp = t;
  }

  let prevMarkerTick = -1;
  for (let i = 0; i < o.markers.length; i++) {
    const m = o.markers[i];
    if (m == null || typeof m !== "object" || Array.isArray(m)) {
      return { ok: false, reason: `index.markers[${i}] must be an object` };
    }
    const mr = m as Record<string, unknown>;
    const tick = finiteNonNegInt(mr.tick);
    if (tick === null) {
      return { ok: false, reason: `index.markers[${i}].tick invalid` };
    }
    if (tick < prevMarkerTick) {
      return { ok: false, reason: "index.markers must be tick-ascending" };
    }
    prevMarkerTick = tick;
    if (typeof mr.markerKind !== "string" || !MARKER_KINDS.has(mr.markerKind)) {
      return { ok: false, reason: `index.markers[${i}].markerKind invalid` };
    }
    if (typeof mr.eventKind !== "string") {
      return { ok: false, reason: `index.markers[${i}].eventKind invalid` };
    }
    if (!Array.isArray(mr.involvedPlayerIds)) {
      return { ok: false, reason: `index.markers[${i}].involvedPlayerIds must be an array` };
    }
    for (let j = 0; j < mr.involvedPlayerIds.length; j++) {
      if (typeof mr.involvedPlayerIds[j] !== "string") {
        return {
          ok: false,
          reason: `index.markers[${i}].involvedPlayerIds[${j}] must be a string`,
        };
      }
    }
  }

  if (o.phases.length === 0) {
    return { ok: false, reason: "index.phases must be non-empty for a filled index" };
  }
  let expectStart: number | null = null;
  let prevEnd = -1;
  for (let i = 0; i < o.phases.length; i++) {
    const p = o.phases[i];
    if (p == null || typeof p !== "object" || Array.isArray(p)) {
      return { ok: false, reason: `index.phases[${i}] must be an object` };
    }
    const pr = p as Record<string, unknown>;
    if (typeof pr.phase !== "string" || !PHASE_LABELS.has(pr.phase)) {
      return { ok: false, reason: `index.phases[${i}].phase invalid` };
    }
    const start = finiteNonNegInt(pr.startTick);
    const end = finiteNonNegInt(pr.endTick);
    if (start === null || end === null) {
      return { ok: false, reason: `index.phases[${i}] ticks invalid` };
    }
    if (end < start) {
      return { ok: false, reason: `index.phases[${i}] endTick < startTick` };
    }
    if (expectStart !== null && start !== expectStart) {
      return {
        ok: false,
        reason: `index.phases gap/overlap at ${i}: expected start ${expectStart}, got ${start}`,
      };
    }
    if (i > 0 && start <= prevEnd) {
      return { ok: false, reason: `index.phases overlap at ${i}` };
    }
    expectStart = end + 1;
    prevEnd = end;
  }

  let prevPlayerId = "";
  for (let i = 0; i < o.playerActivity.length; i++) {
    const a = o.playerActivity[i];
    if (a == null || typeof a !== "object" || Array.isArray(a)) {
      return { ok: false, reason: `index.playerActivity[${i}] must be an object` };
    }
    const ar = a as Record<string, unknown>;
    if (typeof ar.playerId !== "string" || ar.playerId.length === 0) {
      return { ok: false, reason: `index.playerActivity[${i}].playerId invalid` };
    }
    if (ar.playerId < prevPlayerId) {
      return { ok: false, reason: "index.playerActivity must be sorted by playerId" };
    }
    prevPlayerId = ar.playerId;
    const first = finiteNonNegInt(ar.firstTick);
    const last = finiteNonNegInt(ar.lastTick);
    const present = finiteNonNegInt(ar.ticksPresent);
    if (first === null || last === null || present === null) {
      return { ok: false, reason: `index.playerActivity[${i}] ticks invalid` };
    }
    if (last < first) {
      return { ok: false, reason: `index.playerActivity[${i}] lastTick < firstTick` };
    }
  }

  return { ok: true, index: raw as ReplayIndex };
}

/** Type guard: 10.1 explicit-empty reserved index. */
export function isEmptyReplayContainerIndex(
  index: unknown,
): index is {
  readonly schemaNote: "reserved-for-10.3";
  readonly entries: readonly [];
} {
  if (index == null || typeof index !== "object" || Array.isArray(index)) {
    return false;
  }
  const o = index as Record<string, unknown>;
  return o.schemaNote === "reserved-for-10.3" && Array.isArray(o.entries);
}

/** Type guard: filled 10.3 ReplayIndex. */
export function isFilledReplayIndex(index: unknown): index is ReplayIndex {
  if (index == null || typeof index !== "object" || Array.isArray(index)) {
    return false;
  }
  const o = index as Record<string, unknown>;
  return o.indexVersion === REPLAY_INDEX_VERSION && Array.isArray(o.checkpoints);
}
