/**
 * Epic 9.5 — checkpoint indexing (tick → frame lookup for later seeking).
 *
 * One in-memory, append-only index per match. Answers: given a tick (or
 * replay-time derived from a tick), which checkpoint frame should a later
 * seek start from?
 *
 * Contract (see notes/replay/09-replay-state-checkpoints/09-05-checkpoint-indexing.md):
 * - Tick is the canonical key; time is derived (`tick * TICK_MS` /
 *   `floor(timeMs / TICK_MS)` from shared `TICK_HZ`) and never stored.
 * - Floor semantics: exact → self; mid-interval → nearest prior; pre-first
 *   (or empty) → explicit miss; post-last → last frame.
 * - Append-only + monotonic + single-match: duplicate / out-of-order /
 *   cross-match inserts fail loud with the index unmodified.
 * - Holds references to frozen 9.1 frames — never copies, reshapes, or
 *   quantizes. Feed-only / lookup-only: never calls builder, loader, harness,
 *   store, or filesystem.
 */

import { TICK_MS } from "../shared/sim/game.ts";
import type { AuthoritativeCheckpoint } from "./authoritativeCheckpoint.ts";

// ---------------------------------------------------------------------------
// Tick ↔ replay-time helpers (14.1/14.2 consume these; do not re-derive)
// ---------------------------------------------------------------------------

/**
 * Convert a simulation tick to replay-time milliseconds.
 * Pure: `tick * TICK_MS` from shared `TICK_HZ`. No wall-clock.
 */
export function tickToTimeMs(tick: number): number {
  return tick * TICK_MS;
}

/**
 * Convert replay-time milliseconds to a simulation tick.
 * Floors: sub-tick targets resolve to the same tick as the lower bound.
 * Pure: `floor(timeMs / TICK_MS)` from shared `TICK_HZ`. No wall-clock.
 */
export function timeMsToTick(timeMs: number): number {
  return Math.floor(timeMs / TICK_MS);
}

/** Convert a simulation tick to replay-time seconds (`tick * TICK_MS / 1000`). */
export function tickToTimeSec(tick: number): number {
  return tickToTimeMs(tick) / 1000;
}

// ---------------------------------------------------------------------------
// Lookup result + insert errors
// ---------------------------------------------------------------------------

export type CheckpointIndexHit = {
  readonly kind: "hit";
  readonly frame: AuthoritativeCheckpoint;
};

export type CheckpointIndexMiss = {
  readonly kind: "miss";
  /**
   * `empty` — no frames indexed.
   * `before-first` — query tick strictly before the first indexed frame.
   * `not-found` — exact lookup for a tick that is not an indexed key
   *   (findExact only; floor lookups never return this).
   */
  readonly reason: "empty" | "before-first" | "not-found";
};

/** Frame-or-miss: callers must handle miss (14.3 never clamps via the index). */
export type CheckpointIndexLookup = CheckpointIndexHit | CheckpointIndexMiss;

export class CheckpointIndexDuplicateTickError extends Error {
  readonly expectedTick: number;
  readonly actualTick: number;

  constructor(tick: number) {
    super(
      `CheckpointIndex: duplicate tick ${tick} (expected tick > last indexed)`,
    );
    this.name = "CheckpointIndexDuplicateTickError";
    this.expectedTick = tick;
    this.actualTick = tick;
  }
}

export class CheckpointIndexOutOfOrderError extends Error {
  readonly expectedMinTick: number;
  readonly actualTick: number;

  constructor(actualTick: number, lastTick: number) {
    super(
      `CheckpointIndex: out-of-order tick ${actualTick} ` +
        `(expected >= ${lastTick + 1}, last was ${lastTick})`,
    );
    this.name = "CheckpointIndexOutOfOrderError";
    this.expectedMinTick = lastTick + 1;
    this.actualTick = actualTick;
  }
}

export class CheckpointIndexCrossMatchError extends Error {
  readonly expectedMatchId: string;
  readonly actualMatchId: string;

  constructor(expected: string, actual: string) {
    super(
      `CheckpointIndex: cross-match insert (expected runtimeMatchId ` +
        `${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
    );
    this.name = "CheckpointIndexCrossMatchError";
    this.expectedMatchId = expected;
    this.actualMatchId = actual;
  }
}

// ---------------------------------------------------------------------------
// CheckpointIndex
// ---------------------------------------------------------------------------

/**
 * Tick-keyed, append-only index of frozen authoritative checkpoint frames
 * for one `runtimeMatchId`. Binary-search floor for predecessor queries.
 */
export class CheckpointIndex {
  /** Ordered tick keys — single source of truth for key order. */
  private readonly _ticks: number[] = [];
  /** Frame references parallel to `_ticks` (identity-equal to inserted). */
  private readonly _frames: AuthoritativeCheckpoint[] = [];
  /** Exact-hit map (same references); not a second ordering. */
  private readonly byTick = new Map<number, AuthoritativeCheckpoint>();
  private runtimeMatchId: string | null = null;

  /** Number of indexed frames. */
  get size(): number {
    return this._ticks.length;
  }

  /** Tick of the first indexed frame, or `null` when empty. */
  get firstTick(): number | null {
    return this._ticks.length === 0 ? null : this._ticks[0]!;
  }

  /** Tick of the last indexed frame, or `null` when empty. */
  get lastTick(): number | null {
    return this._ticks.length === 0
      ? null
      : this._ticks[this._ticks.length - 1]!;
  }

  /** Locked match id after the first insert, else `null`. */
  get matchId(): string | null {
    return this.runtimeMatchId;
  }

  /** Ordered copy of indexed ticks (for 10.3 serialization / tests). */
  ticks(): readonly number[] {
    return this._ticks.slice();
  }

  /**
   * Append a frozen frame. Fails loud on duplicate tick, out-of-order tick,
   * or cross-`runtimeMatchId` — index unmodified on rejection.
   */
  insert(frame: AuthoritativeCheckpoint): void {
    const tick = frame.tick;
    const id = frame.runtimeMatchId;

    if (this.runtimeMatchId === null) {
      this.runtimeMatchId = id;
    } else if (id !== this.runtimeMatchId) {
      throw new CheckpointIndexCrossMatchError(this.runtimeMatchId, id);
    }

    const last = this.lastTick;
    if (last !== null) {
      if (tick === last) {
        throw new CheckpointIndexDuplicateTickError(tick);
      }
      if (tick < last) {
        throw new CheckpointIndexOutOfOrderError(tick, last);
      }
    }

    this._ticks.push(tick);
    this._frames.push(frame);
    this.byTick.set(tick, frame);
  }

  /** Exact tick hit, or miss (empty / before-first / not-found). Never floors. */
  findExact(tick: number): CheckpointIndexLookup {
    if (this._ticks.length === 0) {
      return { kind: "miss", reason: "empty" };
    }
    const frame = this.byTick.get(tick);
    if (frame === undefined) {
      if (tick < this._ticks[0]!) {
        return { kind: "miss", reason: "before-first" };
      }
      return { kind: "miss", reason: "not-found" };
    }
    return { kind: "hit", frame };
  }

  /**
   * Nearest-prior (floor) lookup: greatest indexed tick ≤ `tick`.
   * Pre-first / empty → miss. Post-last → last frame.
   */
  findPriorOrEqual(tick: number): CheckpointIndexLookup {
    if (this._ticks.length === 0) {
      return { kind: "miss", reason: "empty" };
    }
    const idx = this.floorIndex(tick);
    if (idx < 0) {
      return { kind: "miss", reason: "before-first" };
    }
    return { kind: "hit", frame: this._frames[idx]! };
  }

  /**
   * Time-based floor: convert with {@link timeMsToTick}, then same floor path.
   * Time is never stored as a second key.
   */
  findPriorOrEqualByTimeMs(timeMs: number): CheckpointIndexLookup {
    return this.findPriorOrEqual(timeMsToTick(timeMs));
  }

  /**
   * Binary-search predecessor: greatest index i with `_ticks[i] <= tick`,
   * or `-1` when every key is greater (pre-first).
   */
  private floorIndex(tick: number): number {
    const keys = this._ticks;
    let lo = 0;
    let hi = keys.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (keys[mid]! <= tick) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans;
  }
}
