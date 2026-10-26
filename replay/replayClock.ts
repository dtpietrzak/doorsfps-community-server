/**
 * Epic 11.3 — replay clock (wall→replay-time boundary).
 *
 * Owns pause / resume / speed / position as a pure tick-derivation layer over a
 * frozen `[firstTick, lastTick]` window. Tick is canonical; display time is
 * derived via 9.5 helpers only. The caller supplies `dtWallMs` (e.g. rAF delta);
 * this module never reads wall clock, never steps the runner, and never loads
 * bytes or checkpoints.
 *
 * Contract (see notes/replay/11-replay-playback/11-03-replay-clock.md):
 * - Closed speed set `{0.25, 0.5, 1, 2, 4}`; pause is a separate flag (never speed 0).
 * - Carry preserved across `advance`, cleared on pause / setSpeed / resetTo.
 * - `advance` is an accumulator with per-call step cap; end clamps to `lastTick`.
 * - `resetTo` is a clamped integer primitive (seek policy is 11.6 / 14.3).
 * - Scan-locked: no runner/loader/checkpoint/render/store/blob/fs/`net/` imports.
 *
 * Cursor semantics:
 * - `currentTick` is the last completed tick once playback has stepped, matching
 *   `ReplayRunner.currentTick` after the caller's step loop.
 * - Fresh clocks are "virgin": `currentTick === firstTick` but the next advance
 *   still steps `firstTick` (pre-first-step display, same as 11.6 start).
 * - `resetTo(tick)` leaves virgin mode (completed-tick seek); restart from the
 *   beginning with a fresh `createReplayClock` (11.6 start / restart).
 */

import { TICK_HZ, TICK_MS } from "../shared/sim/game.ts";
import {
  tickToTimeMs,
  tickToTimeSec,
} from "./checkpointIndex.ts";

// ---------------------------------------------------------------------------
// Speed ladder (defined here; 14.4 presents it and must not copy it)
// ---------------------------------------------------------------------------

/** Closed playback-speed set named by 14.4; validated fail-closed here. */
export const REPLAY_SPEEDS = [0.25, 0.5, 1, 2, 4] as const;

export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

export const DEFAULT_REPLAY_SPEED: ReplaySpeed = 1;

/**
 * Max whole ticks emitted by one `advance` call.
 * 4× × 60 Hz × 1s catch-up headroom — mirrors the live scheduler's drop-surplus
 * philosophy without importing that scheduler.
 */
export const MAX_STEPS_PER_ADVANCE = 240;

export function isReplaySpeed(value: unknown): value is ReplaySpeed {
  return (
    typeof value === "number" &&
    REPLAY_SPEEDS.includes(value as ReplaySpeed)
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CreateReplayClockArgs = {
  readonly firstTick: number;
  readonly lastTick: number;
  /** When supplied, must equal shared `TICK_HZ` (60). */
  readonly tickRate?: number;
};

/**
 * Step descriptor for the 11.6 loop.
 * Ticks to run are the half-open range `[fromTick, toTick)` — i.e. call
 * `runner.step(t)` for `t = fromTick .. toTick - 1` (`toTick - fromTick` times).
 */
export type ReplayClockAdvanceResult = {
  readonly steps: number;
  readonly fromTick: number;
  readonly toTick: number;
  readonly ended: boolean;
  readonly droppedSteps: number;
};

export type ReplayClock = {
  readonly firstTick: number;
  readonly lastTick: number;
  readonly currentTick: number;
  readonly isPaused: boolean;
  readonly speed: ReplaySpeed;
  /** Fractional ms toward the next tick (`u = carryMs / TICK_MS` for 11.4). */
  readonly carryMs: number;
  readonly isEnded: boolean;
  readonly replayTimeMs: number;
  readonly replayTimeSec: number;
  /** Playable span covering every tick in `[firstTick, lastTick]`. */
  readonly durationMs: number;

  pause(): void;
  resume(): void;
  setSpeed(speed: ReplaySpeed): void;
  advance(dtWallMs: number): ReplayClockAdvanceResult;
  resetTo(tick: number): void;
};

// ---------------------------------------------------------------------------
// Errors (fail-closed, named — mirror CheckpointVersionMismatch style)
// ---------------------------------------------------------------------------

export class ReplayClockRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayClockRangeError";
  }
}

export class ReplayClockSpeedError extends Error {
  readonly actual: unknown;

  constructor(actual: unknown) {
    super(
      `ReplayClock: invalid speed ${String(actual)} (allowed: ${
        REPLAY_SPEEDS.join(", ")
      })`,
    );
    this.name = "ReplayClockSpeedError";
    this.actual = actual;
  }
}

export class ReplayClockTickError extends Error {
  readonly actual: unknown;

  constructor(actual: unknown) {
    super(
      `ReplayClock: tick must be a finite integer, got ${String(actual)}`,
    );
    this.name = "ReplayClockTickError";
    this.actual = actual;
  }
}

export class ReplayClockTimeDeltaError extends Error {
  readonly actual: unknown;

  constructor(actual: unknown) {
    super(
      `ReplayClock: dtWallMs must be a finite non-negative number, got ${String(actual)}`,
    );
    this.name = "ReplayClockTimeDeltaError";
    this.actual = actual;
  }
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function assertRange(firstTick: number, lastTick: number): void {
  if (!Number.isInteger(firstTick) || firstTick < 0 || !Number.isFinite(firstTick)) {
    throw new ReplayClockRangeError(
      `ReplayClock: firstTick must be a non-negative integer, got ${firstTick}`,
    );
  }
  if (!Number.isInteger(lastTick) || lastTick < 0 || !Number.isFinite(lastTick)) {
    throw new ReplayClockRangeError(
      `ReplayClock: lastTick must be a non-negative integer, got ${lastTick}`,
    );
  }
  if (lastTick < firstTick) {
    throw new ReplayClockRangeError(
      `ReplayClock: lastTick (${lastTick}) must be >= firstTick (${firstTick})`,
    );
  }
}

class ReplayClockImpl implements ReplayClock {
  readonly firstTick: number;
  readonly lastTick: number;

  private _currentTick: number;
  private _speed: ReplaySpeed;
  private _isPaused: boolean;
  private _carryMs: number;
  private _isEnded: boolean;
  /**
   * Fresh / start-from-beginning: `currentTick === firstTick` for display, but
   * the next advance still emits `firstTick` as the first stepped tick.
   */
  private _virgin: boolean;

  constructor(firstTick: number, lastTick: number) {
    this.firstTick = firstTick;
    this.lastTick = lastTick;
    this._currentTick = firstTick;
    this._speed = DEFAULT_REPLAY_SPEED;
    this._isPaused = false;
    this._carryMs = 0;
    this._isEnded = false;
    this._virgin = true;
  }

  get currentTick(): number {
    return this._currentTick;
  }

  get isPaused(): boolean {
    return this._isPaused;
  }

  get speed(): ReplaySpeed {
    return this._speed;
  }

  get carryMs(): number {
    return this._carryMs;
  }

  get isEnded(): boolean {
    return this._isEnded;
  }

  get replayTimeMs(): number {
    return tickToTimeMs(this._currentTick);
  }

  get replayTimeSec(): number {
    return tickToTimeSec(this._currentTick);
  }

  get durationMs(): number {
    return tickToTimeMs(this.lastTick - this.firstTick + 1);
  }

  pause(): void {
    this._isPaused = true;
    this._carryMs = 0;
  }

  resume(): void {
    this._isPaused = false;
    // Carry stays zero — first post-resume tick needs a full TICK_MS/speed of wall.
  }

  setSpeed(speed: ReplaySpeed): void {
    if (!isReplaySpeed(speed)) {
      throw new ReplayClockSpeedError(speed);
    }
    this._speed = speed;
    this._carryMs = 0;
    // Never auto-resume: paused × speed stays paused with armed speed.
  }

  resetTo(tick: number): void {
    if (!Number.isInteger(tick) || !Number.isFinite(tick)) {
      throw new ReplayClockTickError(tick);
    }
    const clamped = Math.min(this.lastTick, Math.max(this.firstTick, tick));
    this._currentTick = clamped;
    this._carryMs = 0;
    this._virgin = false;
    this._isEnded = clamped === this.lastTick;
  }

  advance(dtWallMs: number): ReplayClockAdvanceResult {
    if (
      typeof dtWallMs !== "number" ||
      !Number.isFinite(dtWallMs) ||
      dtWallMs < 0
    ) {
      throw new ReplayClockTimeDeltaError(dtWallMs);
    }

    const empty = (
      droppedSteps: number,
    ): ReplayClockAdvanceResult => ({
      steps: 0,
      fromTick: this.nextTickToStep(),
      toTick: this.nextTickToStep(),
      ended: this._isEnded,
      droppedSteps,
    });

    if (this._isPaused) {
      // Wall time while paused is discarded, not banked.
      return empty(0);
    }

    if (this._isEnded) {
      return empty(0);
    }

    this._carryMs += dtWallMs * this._speed;

    const wantAll = Math.floor(this._carryMs / TICK_MS);
    let droppedSteps = 0;
    let want = wantAll;
    if (wantAll > MAX_STEPS_PER_ADVANCE) {
      droppedSteps = wantAll - MAX_STEPS_PER_ADVANCE;
      want = MAX_STEPS_PER_ADVANCE;
    }

    const next = this.nextTickToStep();
    const remaining = this.lastTick - next + 1;

    if (want <= 0 || remaining <= 0) {
      // Keep fractional carry when we simply have not reached a whole tick yet.
      if (remaining <= 0) {
        this._isEnded = true;
        this._carryMs = 0;
        this._currentTick = this.lastTick;
        this._virgin = false;
      }
      return {
        steps: 0,
        fromTick: next,
        toTick: next,
        ended: this._isEnded,
        droppedSteps,
      };
    }

    const steps = Math.min(want, remaining);
    const fromTick = next;
    const toTick = next + steps; // exclusive end
    const endedByRange = steps === remaining;

    // Cap surplus: discard whole ticks past the cap (never bank them).
    // End clamp: zero carry. Otherwise keep fractional remainder after consumed steps.
    if (droppedSteps > 0) {
      // Subtract all wanted whole ticks (emitted + dropped) → fractional only.
      this._carryMs -= wantAll * TICK_MS;
      if (this._carryMs < 0) this._carryMs = 0;
    } else {
      this._carryMs -= steps * TICK_MS;
      if (this._carryMs < 0) this._carryMs = 0;
    }

    this._currentTick = toTick - 1; // last completed
    this._virgin = false;

    if (endedByRange) {
      this._isEnded = true;
      this._carryMs = 0;
      this._currentTick = this.lastTick;
    }

    return {
      steps,
      fromTick,
      toTick,
      ended: this._isEnded,
      droppedSteps,
    };
  }

  /** Next tick the caller's step loop should feed to the runner. */
  private nextTickToStep(): number {
    if (this._isEnded) return this.lastTick;
    if (this._virgin) return this.firstTick;
    return this._currentTick + 1;
  }
}

/**
 * Create a pure replay clock over a frozen tick window.
 * Cursor starts virgin at `firstTick` (pre-first-step); speed 1; unpaused.
 */
export function createReplayClock(args: CreateReplayClockArgs): ReplayClock {
  assertRange(args.firstTick, args.lastTick);
  if (args.tickRate !== undefined && args.tickRate !== TICK_HZ) {
    throw new ReplayClockRangeError(
      `ReplayClock: tickRate must be ${TICK_HZ}, got ${args.tickRate}`,
    );
  }
  return new ReplayClockImpl(args.firstTick, args.lastTick);
}
