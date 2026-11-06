/**
 * Epic 18.1 — determinism harness.
 *
 * Runs one script on two or more fresh simulations and compares
 * authoritative state after every tick. The comparison is the 9.4
 * checkpoint field walk (`compareCheckpoints`). The first mismatch
 * throws `replay-determinism-mismatch` with that report.
 *
 * The caller owns the script: `create` builds a new simulation, `step`
 * applies the same inputs and leaves the authoritative-event buffer
 * empty (9.1 capture is post-drain).
 *
 * This module does not hash state (18.2), record or reload a file
 * (18.3), certify a checkpoint horizon (18.4), extend the divergence
 * columns (18.5), or keep regression fixtures (18.6). The live match
 * does not call it.
 */

import type { PlayerManager } from "../players/PlayerManager.ts";
import { captureCheckpointState } from "./authoritativeCheckpoint.ts";
import {
  type CheckpointDivergence,
  compareCheckpoints,
} from "./checkpointValidation.ts";

export const REPLAY_DETERMINISM_INVALID = "replay-determinism-invalid" as const;
export const REPLAY_DETERMINISM_MISMATCH =
  "replay-determinism-mismatch" as const;

export type ReplayDeterminismErrorCode =
  | typeof REPLAY_DETERMINISM_INVALID
  | typeof REPLAY_DETERMINISM_MISMATCH;

export class ReplayDeterminismError extends Error {
  readonly code: ReplayDeterminismErrorCode;
  readonly detail: string | null;
  /** Later run that disagreed with run 0. Null when the call itself is invalid. */
  readonly run: number | null;
  /** 9.4 report. Null when the call itself is invalid. */
  readonly report: CheckpointDivergence | null;

  constructor(
    code: ReplayDeterminismErrorCode,
    message: string,
    opts?: {
      detail?: string | null;
      run?: number | null;
      report?: CheckpointDivergence | null;
    },
  ) {
    super(message);
    this.name = "ReplayDeterminismError";
    this.code = code;
    this.detail = opts?.detail ?? null;
    this.run = opts?.run ?? null;
    this.report = opts?.report ?? null;
  }
}

export type DeterminismHarnessOptions = {
  /** Independent runs of `create` + `step`. Default 2. Minimum 2. */
  readonly runs?: number;
  readonly firstTick: number;
  readonly lastTick: number;
  readonly runtimeMatchId: string;
  readonly create: () => PlayerManager;
  /**
   * Advance one tick. Same inputs on every run. Leave the
   * authoritative-event buffer empty before returning.
   */
  readonly step: (sim: PlayerManager, tick: number) => void;
};

export type DeterminismHarnessResult = {
  readonly runs: number;
  readonly firstTick: number;
  readonly lastTick: number;
};

function failInvalid(message: string, detail?: string): never {
  throw new ReplayDeterminismError(
    REPLAY_DETERMINISM_INVALID,
    message,
    detail !== undefined ? { detail } : undefined,
  );
}

function assertOptions(
  options: DeterminismHarnessOptions,
): { runs: number; firstTick: number; lastTick: number } {
  const runs = options.runs ?? 2;
  if (!Number.isInteger(runs) || runs < 2) {
    failInvalid(
      "determinism harness needs at least two runs",
      String(runs),
    );
  }
  if (!Number.isInteger(options.firstTick) || options.firstTick < 0) {
    failInvalid(
      "firstTick must be a non-negative integer",
      String(options.firstTick),
    );
  }
  if (
    !Number.isInteger(options.lastTick) || options.lastTick < options.firstTick
  ) {
    failInvalid(
      "lastTick must be an integer on or after firstTick",
      String(options.lastTick),
    );
  }
  if (
    typeof options.runtimeMatchId !== "string" ||
    options.runtimeMatchId.length === 0
  ) {
    failInvalid("runtimeMatchId is required");
  }
  return { runs, firstTick: options.firstTick, lastTick: options.lastTick };
}

function captureAt(
  sim: PlayerManager,
  tick: number,
  run: number,
  runtimeMatchId: string,
) {
  try {
    return captureCheckpointState(sim, tick, runtimeMatchId);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ReplayDeterminismError(
      REPLAY_DETERMINISM_INVALID,
      "determinism harness could not capture a tick",
      { detail, run },
    );
  }
}

/**
 * Run `create` once per run, step every tick, and compare each later run
 * with run 0. Returns when every tick matches. Throws
 * `replay-determinism-mismatch` at the first difference.
 */
export function runDeterminismHarness(
  options: DeterminismHarnessOptions,
): DeterminismHarnessResult {
  const { runs, firstTick, lastTick } = assertOptions(options);
  const sims: PlayerManager[] = [];
  for (let run = 0; run < runs; run++) {
    sims.push(options.create());
  }
  for (let tick = firstTick; tick <= lastTick; tick++) {
    for (const sim of sims) options.step(sim, tick);
    const reference = captureAt(sims[0]!, tick, 0, options.runtimeMatchId);
    for (let run = 1; run < sims.length; run++) {
      const actual = captureAt(sims[run]!, tick, run, options.runtimeMatchId);
      const report = compareCheckpoints(reference, actual, tick, firstTick);
      if (report) {
        throw new ReplayDeterminismError(
          REPLAY_DETERMINISM_MISMATCH,
          `determinism harness run ${run} diverged at tick ${tick}`,
          { detail: `${report.entityId}.${report.fieldPath}`, run, report },
        );
      }
    }
  }
  return Object.freeze({ runs, firstTick, lastTick });
}
