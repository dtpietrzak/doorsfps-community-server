/**
 * Wire + shared types for runtime → authority replay lifecycle persistence.
 *
 * Authority owns SQLite (`replays.sqlite`) and blob storage. Official community
 * runtimes never open those files — they call `/api/replays/*` with match-report
 * credentials. See server-authority/replays/replayRuntimeApi.ts.
 */

export type ReplayLifecycleStatus =
  | "recording"
  | "finalizing"
  | "finalized"
  | "failed"
  | "abandoned";

export type ReplayLifecycleRow = {
  id: number;
  runtimeMatchId: string;
  status: ReplayLifecycleStatus;
  createdAt: string;
  updatedAt: string;
  ticksObserved: number;
  inputTicks: number;
  eventTicks: number;
  errorCount: number;
  error: string | null;
  /** Absolute path on the authority host; null until finalized. */
  filePath: string | null;
  fileSizeBytes: number | null;
};

export type ReplayCounterPatch = {
  ticksObserved: number;
  inputTicks: number;
  eventTicks: number;
  errorCount: number;
};

/** Statuses `updateReplayLifecycle` / PATCH may write (never `finalized`). */
export type ReplayLifecycleUpdatableStatus = Exclude<
  ReplayLifecycleStatus,
  "finalized"
>;

export type ReplayLifecycleUpdatePatch = {
  status: ReplayLifecycleUpdatableStatus;
  error?: string | null;
  counters?: ReplayCounterPatch;
};

/** Public row shape returned on runtime APIs (includes path for admin parity). */
export type ReplayLifecyclePublicRow = ReplayLifecycleRow;

export function isReplayLifecycleStatus(
  value: unknown,
): value is ReplayLifecycleStatus {
  return (
    value === "recording" ||
    value === "finalizing" ||
    value === "finalized" ||
    value === "failed" ||
    value === "abandoned"
  );
}

export function isReplayLifecycleUpdatableStatus(
  value: unknown,
): value is ReplayLifecycleUpdatableStatus {
  return (
    value === "recording" ||
    value === "finalizing" ||
    value === "failed" ||
    value === "abandoned"
  );
}
