/**
 * Epic 18.4 — checkpoint verification.
 *
 * Compares replay state to the authoritative checkpoints stored in a
 * finalized file. Each frame is restored with `resetToCheckpoint` and
 * captured again. Between two frames the runner steps the gap, and the
 * replay state at the later tick must match that later checkpoint.
 *
 * Object keys are sorted before the 9.4 field walk, because insertion
 * order is not state. The report columns stay the 9.4 shape.
 *
 * Extending those columns is 18.5. Regression fixtures are 18.6.
 * The live match does not call this module.
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
import type { LoadedReplay } from "./replayLoader.ts";
import { createReplayRunner } from "./replaySimulationRunner.ts";

export const REPLAY_CHECKPOINT_VERIFY_INVALID =
  "replay-checkpoint-verify-invalid" as const;
export const REPLAY_CHECKPOINT_VERIFY_MISMATCH =
  "replay-checkpoint-verify-mismatch" as const;

export type ReplayCheckpointVerifyErrorCode =
  | typeof REPLAY_CHECKPOINT_VERIFY_INVALID
  | typeof REPLAY_CHECKPOINT_VERIFY_MISMATCH;

export class ReplayCheckpointVerifyError extends Error {
  readonly code: ReplayCheckpointVerifyErrorCode;
  readonly detail: string | null;
  /** Checkpoint tick under comparison. Null when the call itself is invalid. */
  readonly tick: number | null;
  /** 9.4 report. Null when the call itself is invalid. */
  readonly report: CheckpointDivergence | null;

  constructor(
    code: ReplayCheckpointVerifyErrorCode,
    message: string,
    opts?: {
      detail?: string | null;
      tick?: number | null;
      report?: CheckpointDivergence | null;
    },
  ) {
    super(message);
    this.name = "ReplayCheckpointVerifyError";
    this.code = code;
    this.detail = opts?.detail ?? null;
    this.tick = opts?.tick ?? null;
    this.report = opts?.report ?? null;
  }
}

export type ReplayCheckpointVerifyOptions = {
  /** Finalized replay bytes. */
  readonly bytes: Uint8Array;
  readonly collision: MapCollision;
};

export type ReplayCheckpointVerifyResult = {
  /** Checkpoint ticks whose restored replay state matched the frame. */
  readonly resumed: number;
  /** Gaps stepped from one checkpoint onto the next. */
  readonly horizons: number;
  readonly ticks: readonly number[];
};

function failInvalid(message: string, detail?: string, tick?: number): never {
  throw new ReplayCheckpointVerifyError(
    REPLAY_CHECKPOINT_VERIFY_INVALID,
    message,
    { detail: detail ?? null, tick: tick ?? null },
  );
}

function failMismatch(
  message: string,
  tick: number,
  report: CheckpointDivergence,
): never {
  throw new ReplayCheckpointVerifyError(
    REPLAY_CHECKPOINT_VERIFY_MISMATCH,
    message,
    {
      detail: `${report.entityId}.${report.fieldPath}`,
      tick,
      report,
    },
  );
}

function assertOptions(options: ReplayCheckpointVerifyOptions): void {
  if (
    !(options?.bytes instanceof Uint8Array) || options.bytes.byteLength === 0
  ) {
    failInvalid("checkpoint verification needs finalized replay bytes");
  }
  if (options.collision == null) {
    failInvalid("checkpoint verification needs a collision map");
  }
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

function sameFrame(
  expected: AuthoritativeCheckpoint,
  actual: AuthoritativeCheckpoint,
  tick: number,
  checkpointTick: number,
): CheckpointDivergence | null {
  return compareCheckpoints(
    sortKeys(expected) as AuthoritativeCheckpoint,
    sortKeys(actual) as AuthoritativeCheckpoint,
    tick,
    checkpointTick,
  );
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
    failInvalid(
      "checkpoint verification could not capture replay state",
      detail,
      tick,
    );
  }
}

function collectFrames(session: LoadedReplay): AuthoritativeCheckpoint[] {
  const byTick = new Map<number, AuthoritativeCheckpoint>();
  const start = session.initialState.startCheckpoint;
  if (start) byTick.set(start.tick, start);
  for (const frame of session.container.checkpoints) {
    const prior = byTick.get(frame.tick);
    if (prior) {
      const report = sameFrame(prior, frame, frame.tick, frame.tick);
      if (report) {
        failMismatch(
          `checkpoint copies disagree at tick ${frame.tick}`,
          frame.tick,
          report,
        );
      }
      continue;
    }
    byTick.set(frame.tick, frame);
  }
  return [...byTick.values()].sort((a, b) => a.tick - b.tick);
}

function horizonInRange(
  session: LoadedReplay,
  fromTick: number,
  toTick: number,
): boolean {
  const startStep = fromTick + 1;
  return toTick > fromTick &&
    startStep >= session.firstTick &&
    toTick <= session.lastTick &&
    toTick >= session.firstTick;
}

/**
 * Restore every stored checkpoint and, where the file can step the gap,
 * replay from one checkpoint to the next.
 */
export function verifyReplayCheckpoints(
  options: ReplayCheckpointVerifyOptions,
): ReplayCheckpointVerifyResult {
  assertOptions(options);
  const session = loadReplay(options.bytes);
  const frames = collectFrames(session);
  if (frames.length === 0) {
    failInvalid("checkpoint verification found no authoritative checkpoints");
  }

  const runner = createReplayRunner(session, { collision: options.collision });
  for (const frame of frames) {
    runner.resetToCheckpoint(frame);
    const actual = captureReplay(runner, frame.tick, frame.runtimeMatchId);
    const report = sameFrame(frame, actual, frame.tick, frame.tick);
    if (report) {
      failMismatch(
        `replay state diverged from the checkpoint at tick ${frame.tick}`,
        frame.tick,
        report,
      );
    }
  }

  let horizons = 0;
  for (let i = 0; i < frames.length - 1; i++) {
    const from = frames[i]!;
    const to = frames[i + 1]!;
    if (!horizonInRange(session, from.tick, to.tick)) continue;
    runner.resetToCheckpoint(from);
    for (let tick = from.tick + 1; tick <= to.tick; tick++) {
      runner.step(tick);
    }
    const actual = captureReplay(runner, to.tick, to.runtimeMatchId);
    const report = sameFrame(to, actual, to.tick, from.tick);
    if (report) {
      failMismatch(
        `replay state diverged from the checkpoint at tick ${to.tick}`,
        to.tick,
        report,
      );
    }
    horizons++;
  }

  return Object.freeze({
    resumed: frames.length,
    horizons,
    ticks: Object.freeze(frames.map((frame) => frame.tick)),
  });
}
