/**
 * Epic 11.1 — replay loader (bytes → frozen session).
 *
 * Owns the finalized-file load boundary only:
 *   bytes (10.2 canonical JSON v1)
 *     → loadReplay
 *     → LoadedReplay (frozen container by reference + tick-keyed accessors)
 *
 * Pipeline (Decision 1):
 *   getReplayFormatVersionFromBytes → decodeReplayContainer →
 *   assertReplayFormatVersion (10.5 gate + companion echo) →
 *   accessor-map build → freeze.
 *
 * Session contract (locked):
 * - Version-first: no stream/index work before the version gate passes.
 * - Verbatim: frozen row references, full precision; no quantization.
 * - Dense inputs: every tick in [firstTick, lastTick] present at load
 *   (gap → loud failure); `inputAt` never returns undefined.
 * - Sparse events: missing tick → shared EMPTY_RECORDED_EVENTS; drain order kept.
 * - Checkpoint floor: 9.5 semantics via CheckpointIndex (exact → self; mid → prior;
 *   before-first/empty → miss; at/after-last → last; never clamp-forward).
 * - Index: file's ReplayIndex / empty-reserved slot, never rebuilt here.
 * - Integrity: opaque passthrough; always `integrityStatus: "unverified"` until 10.4.
 * - Bytes in, session out: no paths, URLs, stores, blob, fs, net, sim, or render.
 * - Sim-free: never constructs PlayerManager, never applies checkpoints, never steps.
 *
 * Non-consumer: delayed live spectating (12.7) tails the 8.5 in-memory buffer with
 * the 11.2 runner — it never sees file bytes and never calls this loader.
 *
 * Handoffs: 11.2 consumes inputAt/eventsAt/initialState/checkpoints; 11.3 uses
 * tick range + tick↔time helpers; 11.6 orchestrates start; 14.3 uses floor lookup;
 * 16.x supplies bytes; 18.x/20.x consume load gates. None of those live here.
 */

import type { AuthoritativeEvent } from "../shared/sim/authoritativeEvent.ts";
import {
  assertReplayFormatVersion,
  isSupportedReplayFormatVersion,
  ReplayFormatVersionError,
  type ReplayFormatVersionCompanionEcho,
} from "../shared/replay/replayFormatVersion.ts";
import type { AuthoritativeCheckpoint } from "./authoritativeCheckpoint.ts";
import {
  CheckpointIndex,
  tickToTimeMs as tickToTimeMsHelper,
  timeMsToTick as timeMsToTickHelper,
  type CheckpointIndexLookup,
} from "./checkpointIndex.ts";
import {
  REPLAY_RNG_CONSTRUCTION_RULE,
  type RecordedInitialState,
} from "./recordedInitialState.ts";
import { EMPTY_RECORDED_EVENTS } from "./recordedTickEvents.ts";
import type { RecordedTickInputs } from "./recordedTickInputs.ts";
import type {
  ReplayContainer,
  ReplayContainerHeader,
  ReplayContainerIndex,
  ReplayContainerIntegrity,
  ReplayContainerMetadata,
} from "./replayContainer.ts";
import {
  decodeReplayContainer,
  getReplayFormatVersionFromBytes,
  ReplayEncodingError,
} from "./replayEncoding.ts";
import {
  activityForPlayer as indexActivityForPlayer,
  findPriorCheckpointTick as indexFindPriorCheckpointTick,
  findPriorCheckpointTickByTimeMs as indexFindPriorCheckpointTickByTimeMs,
  isEmptyReplayContainerIndex,
  isFilledReplayIndex,
  markersAt as indexMarkersAt,
  markersInRange as indexMarkersInRange,
  type ReplayCheckpointTickLookup,
  type ReplayIndex,
  type ReplayIndexMarker,
  type ReplayIndexPlayerSpan,
} from "./replayIndex.ts";

/** Integrity is never verified in 11.1 — 10.4 owns compute/verify. */
export type LoadedReplayIntegrityStatus = "unverified";

/**
 * Frozen open-replay session: validated container + dense/sparse/floor accessors.
 * Holds no live-owner references (no Player, PlayerManager, MapCollision, socket, store).
 */
export type LoadedReplay = {
  /** Validated, deep-frozen 10.1 container (by reference from decode). */
  readonly container: ReplayContainer;
  readonly header: ReplayContainerHeader;
  /** Informational only — never fed back into the sim. */
  readonly metadata: ReplayContainerMetadata;
  readonly initialState: RecordedInitialState;
  /** File index verbatim (filled 10.3 or empty-reserved 10.1). Never rebuilt. */
  readonly index: ReplayContainerIndex;
  /** Opaque trailer; verification is 10.4's job. */
  readonly integrity: ReplayContainerIntegrity;
  readonly integrityStatus: LoadedReplayIntegrityStatus;
  readonly firstTick: number;
  readonly lastTick: number;
  readonly tickRate: number;
  readonly runtimeMatchId: string;
  /** Referenced for 11.2 RNG rebuild — not redefined here. */
  readonly rngConstructionRule: typeof REPLAY_RNG_CONSTRUCTION_RULE;

  /**
   * Dense input row for `tick` in `[firstTick, lastTick]`.
   * Out-of-range / non-integer tick → loud `ReplayEncodingError`.
   * Coverage gaps fail at {@link loadReplay}, never here.
   */
  inputAt(tick: number): RecordedTickInputs;

  /**
   * Sparse event list for `tick`. Missing stored row → shared frozen empty list.
   * Out-of-range / non-integer tick → loud `ReplayEncodingError`.
   */
  eventsAt(tick: number): ReadonlyArray<AuthoritativeEvent>;

  /** Exact checkpoint frame at `tick`, or miss (never floors). */
  checkpointAt(tick: number): CheckpointIndexLookup;

  /** 9.5 floor: nearest prior-or-equal checkpoint frame. */
  findPriorCheckpoint(tick: number): CheckpointIndexLookup;

  /** Time-based floor via {@link timeMsToTick} then same 9.5 path. */
  findPriorCheckpointByTimeMs(timeMs: number): CheckpointIndexLookup;

  /** Delegates to 10.3 when index is filled; empty-reserved → []. */
  markersAt(tick: number): readonly ReplayIndexMarker[];

  /** Delegates to 10.3 when index is filled; empty-reserved → []. */
  markersInRange(fromTick: number, toTick: number): readonly ReplayIndexMarker[];

  /** Delegates to 10.3 when index is filled; empty-reserved → null. */
  activityForPlayer(playerId: string): ReplayIndexPlayerSpan | null;

  /** Index-table floor (tick only); empty-reserved → miss empty. */
  findPriorCheckpointTick(tick: number): ReplayCheckpointTickLookup;

  /** Index-table floor by time; empty-reserved → miss empty. */
  findPriorCheckpointTickByTimeMs(timeMs: number): ReplayCheckpointTickLookup;

  tickToTimeMs(tick: number): number;
  timeMsToTick(timeMs: number): number;
};

const LOADED_REPLAY_BRAND = Symbol.for("doorsfps.LoadedReplay");

type LoadedReplayInternal = LoadedReplay & {
  readonly [LOADED_REPLAY_BRAND]: true;
};

function failBadTick(
  message: string,
  opts?: { section?: string | null; detail?: string | null },
): never {
  throw new ReplayEncodingError("replay-bad-tick", message, opts);
}

function assertTickShape(label: string, tick: number): void {
  if (typeof tick !== "number" || !Number.isFinite(tick) || !Number.isInteger(tick)) {
    failBadTick(`${label}: tick must be a finite integer (got ${String(tick)})`, {
      detail: String(tick),
    });
  }
  if (tick < 0) {
    failBadTick(`${label}: tick must be non-negative (got ${tick})`, {
      detail: String(tick),
    });
  }
}

function assertTickInRange(
  label: string,
  tick: number,
  firstTick: number,
  lastTick: number,
): void {
  assertTickShape(label, tick);
  if (tick < firstTick || tick > lastTick) {
    failBadTick(
      `${label}: tick ${tick} out of range [${firstTick}, ${lastTick}]`,
      { detail: `tick=${tick} range=[${firstTick},${lastTick}]` },
    );
  }
}

function companionsFromContainer(
  container: ReplayContainer,
): ReplayFormatVersionCompanionEcho {
  return {
    map: container.header.map,
    matchSeed: container.header.matchSeed,
    tickRate: container.header.tickRate,
    gameProto: container.initialState.metadata.gameProto,
    buildSha: container.initialState.metadata.buildSha,
  };
}

function buildInputMap(
  container: ReplayContainer,
): ReadonlyMap<number, RecordedTickInputs> {
  const { firstTick, lastTick } = container.header;
  const map = new Map<number, RecordedTickInputs>();

  for (const row of container.inputStream) {
    if (map.has(row.tick)) {
      failBadTick(
        `inputStream duplicate tick ${row.tick}`,
        { section: "inputStream", detail: `tick=${row.tick}` },
      );
    }
    map.set(row.tick, row);
  }

  // Degenerate zero-length: empty inputs only when firstTick === lastTick
  // (already gated by validateReplayContainer). No coverage rows required.
  if (container.inputStream.length === 0) {
    return map;
  }

  for (let tick = firstTick; tick <= lastTick; tick++) {
    if (!map.has(tick)) {
      failBadTick(
        `inputStream gap: missing tick ${tick} in [${firstTick}, ${lastTick}]`,
        { section: "inputStream", detail: `missingTick=${tick}` },
      );
    }
  }
  return map;
}

function buildEventMap(
  container: ReplayContainer,
): ReadonlyMap<number, ReadonlyArray<AuthoritativeEvent>> {
  const map = new Map<number, ReadonlyArray<AuthoritativeEvent>>();
  for (const row of container.eventStream) {
    if (map.has(row.tick)) {
      failBadTick(
        `eventStream duplicate tick ${row.tick}`,
        { section: "eventStream", detail: `tick=${row.tick}` },
      );
    }
    map.set(row.tick, row.events);
  }
  return map;
}

function buildCheckpointIndex(
  frames: ReadonlyArray<AuthoritativeCheckpoint>,
): CheckpointIndex {
  const index = new CheckpointIndex();
  for (const frame of frames) {
    // insert() fails loud on duplicate / out-of-order / cross-match (9.5 parity).
    index.insert(frame);
  }
  return index;
}

function filledIndexOrNull(index: ReplayContainerIndex): ReplayIndex | null {
  if (isFilledReplayIndex(index)) return index;
  if (isEmptyReplayContainerIndex(index)) return null;
  // validateReplayContainer already rejects unknown shapes; belt-and-suspenders.
  throw new ReplayEncodingError(
    "replay-bad-shape",
    "LoadedReplay.index is neither a filled ReplayIndex nor empty-reserved",
    { section: "index" },
  );
}

/**
 * Load finalized replay bytes into a frozen, randomly-accessible session.
 *
 * Pure: never mutates `bytes`. Failures use the 10.2 / 10.5 named taxonomy
 * (`ReplayEncodingError` / `ReplayFormatVersionError`) — never a partial session.
 */
export function loadReplay(bytes: Uint8Array): LoadedReplay {
  // Cheap version pre-check (also surfaces truncated / bad utf-8 / bad json / bad shape).
  const version = getReplayFormatVersionFromBytes(bytes);
  if (!isSupportedReplayFormatVersion(version)) {
    // Fail before decode walks streams; companion echo filled after a soft parse
    // is unnecessary here — decode would also reject, and the 10.5 error carries
    // expected/seen. Callers that need companions on the happy path get them below.
    throw new ReplayFormatVersionError(version);
  }

  const container = decodeReplayContainer(bytes);

  const companions = companionsFromContainer(container);
  assertReplayFormatVersion(container.header, companions);

  const inputByTick = buildInputMap(container);
  const eventsByTick = buildEventMap(container);
  const checkpointIndex = buildCheckpointIndex(container.checkpoints);
  const filledIndex = filledIndexOrNull(container.index);

  const firstTick = container.header.firstTick;
  const lastTick = container.header.lastTick;

  const session: LoadedReplayInternal = {
    [LOADED_REPLAY_BRAND]: true,
    container,
    header: container.header,
    metadata: container.metadata,
    initialState: container.initialState,
    index: container.index,
    integrity: container.integrity,
    integrityStatus: "unverified",
    firstTick,
    lastTick,
    tickRate: container.header.tickRate,
    runtimeMatchId: container.header.runtimeMatchId,
    rngConstructionRule: REPLAY_RNG_CONSTRUCTION_RULE,

    inputAt(tick: number): RecordedTickInputs {
      assertTickInRange("inputAt", tick, firstTick, lastTick);
      const row = inputByTick.get(tick);
      if (row === undefined) {
        // Degenerate empty-input session, or invariant breach after load.
        failBadTick(
          `inputAt: no input row for tick ${tick}`,
          { section: "inputStream", detail: `missingTick=${tick}` },
        );
      }
      return row;
    },

    eventsAt(tick: number): ReadonlyArray<AuthoritativeEvent> {
      assertTickInRange("eventsAt", tick, firstTick, lastTick);
      return eventsByTick.get(tick) ?? EMPTY_RECORDED_EVENTS;
    },

    checkpointAt(tick: number): CheckpointIndexLookup {
      assertTickShape("checkpointAt", tick);
      return checkpointIndex.findExact(tick);
    },

    findPriorCheckpoint(tick: number): CheckpointIndexLookup {
      assertTickShape("findPriorCheckpoint", tick);
      return checkpointIndex.findPriorOrEqual(tick);
    },

    findPriorCheckpointByTimeMs(timeMs: number): CheckpointIndexLookup {
      if (typeof timeMs !== "number" || !Number.isFinite(timeMs)) {
        failBadTick(
          `findPriorCheckpointByTimeMs: timeMs must be a finite number (got ${String(timeMs)})`,
          { detail: String(timeMs) },
        );
      }
      return checkpointIndex.findPriorOrEqualByTimeMs(timeMs);
    },

    markersAt(tick: number): readonly ReplayIndexMarker[] {
      if (filledIndex === null) {
        assertTickShape("markersAt", tick);
        return [];
      }
      return indexMarkersAt(filledIndex, tick);
    },

    markersInRange(fromTick: number, toTick: number): readonly ReplayIndexMarker[] {
      if (filledIndex === null) {
        assertTickShape("markersInRange.fromTick", fromTick);
        assertTickShape("markersInRange.toTick", toTick);
        return [];
      }
      return indexMarkersInRange(filledIndex, fromTick, toTick);
    },

    activityForPlayer(playerId: string): ReplayIndexPlayerSpan | null {
      if (filledIndex === null) return null;
      return indexActivityForPlayer(filledIndex, playerId);
    },

    findPriorCheckpointTick(tick: number): ReplayCheckpointTickLookup {
      if (filledIndex === null) {
        assertTickShape("findPriorCheckpointTick", tick);
        return { kind: "miss", reason: "empty" };
      }
      return indexFindPriorCheckpointTick(filledIndex, tick);
    },

    findPriorCheckpointTickByTimeMs(timeMs: number): ReplayCheckpointTickLookup {
      if (filledIndex === null) {
        if (typeof timeMs !== "number" || !Number.isFinite(timeMs)) {
          failBadTick(
            `findPriorCheckpointTickByTimeMs: timeMs must be a finite number (got ${String(timeMs)})`,
            { detail: String(timeMs) },
          );
        }
        return { kind: "miss", reason: "empty" };
      }
      return indexFindPriorCheckpointTickByTimeMs(filledIndex, timeMs);
    },

    tickToTimeMs(tick: number): number {
      assertTickShape("tickToTimeMs", tick);
      return tickToTimeMsHelper(tick);
    },

    timeMsToTick(timeMs: number): number {
      if (typeof timeMs !== "number" || !Number.isFinite(timeMs)) {
        failBadTick(
          `timeMsToTick: timeMs must be a finite number (got ${String(timeMs)})`,
          { detail: String(timeMs) },
        );
      }
      return timeMsToTickHelper(timeMs);
    },
  };

  // Freeze the session shell. Nested container/rows are already deep-frozen by decode.
  // Methods live on the object and remain callable after freeze.
  return Object.freeze(session);
}

/** Narrow guard for values produced by {@link loadReplay}. */
export function isLoadedReplay(value: unknown): value is LoadedReplay {
  return (
    value != null &&
    typeof value === "object" &&
    (value as { [LOADED_REPLAY_BRAND]?: unknown })[LOADED_REPLAY_BRAND] === true
  );
}

/** Re-export tick↔time helpers so 11.3 can import from one module if desired. */
export { tickToTimeMsHelper as tickToTimeMs, timeMsToTickHelper as timeMsToTick };
