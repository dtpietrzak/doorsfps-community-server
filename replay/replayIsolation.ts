/**
 * Epic 20.1 — replay isolation.
 *
 * Replay bytes must not override the live match. `GameServer` claims its
 * `PlayerManager` when it constructs the match. The claim is object
 * identity. A copy of the same bytes is not the live match, and a
 * checkpoint captured from the live match may still load into a
 * different manager.
 *
 * `loadCheckpointState` checks after anchor validation and before
 * `restoreFromCheckpoint`. The runner checks the private manager it
 * built (`new PlayerManager`) at `resetToInitial`, `resetToCheckpoint`,
 * and `step`, before applying a checkpoint, roster, or tick. The runner
 * does not accept a live manager.
 *
 * Claim is idempotent. Release clears it. The registry is a `WeakSet`:
 * dropping the server drops the claim. No clock, no file, no encode.
 * Validation of malformed bytes is 20.2. Who may fetch a file is 20.4.
 * The status page is 23.4.
 */

export const REPLAY_ISOLATION_VIOLATION = "replay-isolation-violation" as const;
export const REPLAY_ISOLATION_INVALID = "replay-isolation-invalid" as const;

export type ReplayIsolationErrorCode =
  | typeof REPLAY_ISOLATION_VIOLATION
  | typeof REPLAY_ISOLATION_INVALID;

export class ReplayIsolationError extends Error {
  readonly code: ReplayIsolationErrorCode;
  readonly detail: string | null;

  constructor(
    code: ReplayIsolationErrorCode,
    message: string,
    detail?: string | null,
  ) {
    super(message);
    this.name = "ReplayIsolationError";
    this.code = code;
    this.detail = detail ?? null;
  }
}

const liveAuthoritative = new WeakSet<object>();

function fail(
  code: ReplayIsolationErrorCode,
  message: string,
  detail?: string,
): never {
  throw new ReplayIsolationError(code, message, detail ?? null);
}

function assertSimulation(name: string, players: object): void {
  if (players == null || typeof players !== "object") {
    fail(
      REPLAY_ISOLATION_INVALID,
      `${name} must be a simulation object`,
      String(players),
    );
  }
}

/** Mark this object as the live match. A second claim does not stack. */
export function claimLiveAuthoritative(players: object): void {
  assertSimulation("players", players);
  liveAuthoritative.add(players);
}

/** Drop the claim. Releasing an object that was not claimed does nothing. */
export function releaseLiveAuthoritative(players: object): void {
  assertSimulation("players", players);
  liveAuthoritative.delete(players);
}

export function isLiveAuthoritative(players: object): boolean {
  if (players == null || typeof players !== "object") return false;
  return liveAuthoritative.has(players);
}

/**
 * Throw when `players` is the claimed live match. Unclaimed managers,
 * including a replay runner's private one, pass.
 */
export function assertReplayMayWrite(players: object): void {
  assertSimulation("players", players);
  if (liveAuthoritative.has(players)) {
    fail(
      REPLAY_ISOLATION_VIOLATION,
      "replay data must not write live authoritative state",
    );
  }
}
