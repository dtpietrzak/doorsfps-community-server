/**
 * Epic 18.3 — replay round trip.
 *
 * The caller records a live match (simulation → record) and keeps one
 * authoritative capture per tick. This function loads those bytes, steps
 * the replay runner from the first tick through the last, and compares
 * each tick to the live capture.
 *
 * Every tick uses the 9.4 field walk. Object keys are sorted first,
 * because insertion order is not state. Ticks on the 18.2 sample cadence
 * also require the state digest to match. The first difference throws
 * `replay-round-trip-mismatch` with that field-walk report.
 *
 * Checkpoint resume is 18.4. Extending the divergence columns is 18.5.
 * Regression fixtures are 18.6. The live match does not call this module.
 */
import type { MapCollision } from "../world/MapCollision.ts";
import {
  type AuthoritativeCheckpoint,
  captureCheckpointState,
} from "./authoritativeCheckpoint.ts";
import {
  type CheckpointDivergence,
  compareCheckpoints,
} from "./checkpointValidation.ts";
import { loadReplay } from "./replayLoader.ts";
import { createReplayRunner } from "./replaySimulationRunner.ts";
import {
  authoritativeCheckpointsMatch,
  isReplayStateHashTick,
  REPLAY_STATE_HASH_INTERVAL_TICKS_DEFAULT,
} from "./replayStateHash.ts";

export const REPLAY_ROUND_TRIP_INVALID = "replay-round-trip-invalid" as const;
export const REPLAY_ROUND_TRIP_MISMATCH = "replay-round-trip-mismatch" as const;

export type ReplayRoundTripErrorCode =
  | typeof REPLAY_ROUND_TRIP_INVALID
  | typeof REPLAY_ROUND_TRIP_MISMATCH;

export class ReplayRoundTripError extends Error {
  readonly code: ReplayRoundTripErrorCode;
  readonly detail: string | null;
  /** Tick under comparison. Null when the call itself is invalid. */
  readonly tick: number | null;
  /** 9.4 report. Null when the call is invalid or only the digest disagreed. */
  readonly report: CheckpointDivergence | null;

  constructor(
    code: ReplayRoundTripErrorCode,
    message: string,
    opts?: {
      detail?: string | null;
      tick?: number | null;
      report?: CheckpointDivergence | null;
    },
  ) {
    super(message);
    this.name = "ReplayRoundTripError";
    this.code = code;
    this.detail = opts?.detail ?? null;
    this.tick = opts?.tick ?? null;
    this.report = opts?.report ?? null;
  }
}

export type ReplayRoundTripOptions = {
  /** Finalized replay bytes. */
  readonly bytes: Uint8Array;
  readonly collision: MapCollision;
  /** Live capture for `tick`, or undefined when that tick was not captured. */
  readonly liveAt: (tick: number) => AuthoritativeCheckpoint | undefined;
  /**
   * State-hash sample period in ticks. Default is the 18.2 cadence
   * (300). The recorder's own checkpoint interval is untouched.
   */
  readonly hashIntervalTicks?: number;
};

export type ReplayRoundTripResult = {
  readonly firstTick: number;
  readonly lastTick: number;
  readonly comparedTicks: number;
  readonly hashedTicks: number;
};

function failInvalid(message: string, detail?: string, tick?: number): never {
  throw new ReplayRoundTripError(REPLAY_ROUND_TRIP_INVALID, message, {
    detail: detail ?? null,
    tick: tick ?? null,
  });
}

function assertOptions(options: ReplayRoundTripOptions): number {
  if (options == null || typeof options.liveAt !== "function") {
    failInvalid("round trip needs a live capture function");
  }
  if (
    !(options.bytes instanceof Uint8Array) || options.bytes.byteLength === 0
  ) {
    failInvalid("round trip needs finalized replay bytes");
  }
  if (options.collision == null) {
    failInvalid("round trip needs a collision map");
  }
  const interval = options.hashIntervalTicks ??
    REPLAY_STATE_HASH_INTERVAL_TICKS_DEFAULT;
  if (!Number.isInteger(interval) || interval < 1) {
    failInvalid(
      "round trip hash interval must be an integer >= 1",
      String(interval),
    );
  }
  return interval;
}

/** Object key order is not state. The 9.4 walk stringifies maps in insertion order. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeys(obj[key]);
    }
    return sorted;
  }
  return value;
}

function captureReplay(
  runner: ReturnType<typeof createReplayRunner>,
  tick: number,
  runtimeMatchId: string,
): AuthoritativeCheckpoint {
  try {
    return captureCheckpointState(runner.simulation, tick, runtimeMatchId);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    failInvalid("round trip could not capture a replay tick", detail, tick);
  }
}

/**
 * Load `bytes`, replay every tick, and compare to `liveAt`.
 * Does not record, seek, or write a file.
 */
export function runReplayRoundTrip(
  options: ReplayRoundTripOptions,
): ReplayRoundTripResult {
  const interval = assertOptions(options);
  const session = loadReplay(options.bytes);
  const runner = createReplayRunner(session, { collision: options.collision });
  let hashedTicks = 0;

  for (let tick = session.firstTick; tick <= session.lastTick; tick++) {
    runner.step(tick);
    const expected = options.liveAt(tick);
    if (!expected) {
      failInvalid(
        `round trip has no live capture at tick ${tick}`,
        `tick=${tick}`,
        tick,
      );
    }
    const actual = captureReplay(runner, tick, session.runtimeMatchId);
    const report = compareCheckpoints(
      sortKeys(expected) as AuthoritativeCheckpoint,
      sortKeys(actual) as AuthoritativeCheckpoint,
      tick,
      session.firstTick,
    );
    if (report) {
      throw new ReplayRoundTripError(
        REPLAY_ROUND_TRIP_MISMATCH,
        `replay round trip diverged at tick ${tick}`,
        {
          detail: `${report.entityId}.${report.fieldPath}`,
          tick,
          report,
        },
      );
    }
    if (isReplayStateHashTick(tick, interval)) {
      hashedTicks++;
      if (!authoritativeCheckpointsMatch(expected, actual)) {
        throw new ReplayRoundTripError(
          REPLAY_ROUND_TRIP_MISMATCH,
          `replay round trip state hash diverged at tick ${tick}`,
          { detail: "state-hash", tick },
        );
      }
    }
  }

  const comparedTicks = session.lastTick - session.firstTick + 1;
  return Object.freeze({
    firstTick: session.firstTick,
    lastTick: session.lastTick,
    comparedTicks,
    hashedTicks,
  });
}
