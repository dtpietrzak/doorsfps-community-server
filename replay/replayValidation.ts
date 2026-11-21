/**
 * Epic 20.2 — replay validation.
 *
 * Untrusted replay bytes either become a 11.1 session or they are
 * rejected. This module does not parse a second way. It calls
 * `loadReplay` and classifies that failure.
 *
 * `malformed` is not a replay document: truncated, bad UTF-8, bad
 * JSON, bad shape, missing section. `invalid` is a document that must
 * not play: bad tick, unsupported map, missing seed, format version,
 * incompatible rules, or a compatibility input the gate itself rejects.
 * The kind follows the loader's code. This module does not rename it.
 *
 * An error that is not one of those codes is rethrown. A rejection
 * never returns a session. The file trailer stays unverified (10.4).
 * 20.6 checks the SQL checksum when a file is served. Abuse limits are
 * 20.5. Account and live-socket facts are 20.3
 * (`replay-data-boundary`), classified here as invalid. An in-memory
 * session (the 12.7 tail) is not a byte load and is not classified here.
 *
 * No clock, no file, no hash. The status page is 23.4.
 */

import { loadReplay, type LoadedReplay } from "./replayLoader.ts";

export const REPLAY_VALIDATION_REJECTED = "replay-validation-rejected" as const;

export type ReplayValidationErrorCode = typeof REPLAY_VALIDATION_REJECTED;

export type ReplayRejectionKind = "malformed" | "invalid";

export type ReplayRejection = {
  readonly kind: ReplayRejectionKind;
  /** The loader's code, unchanged. */
  readonly reason: string;
};

const MALFORMED_REASONS: ReadonlySet<string> = new Set([
  "replay-truncated",
  "replay-bad-utf8",
  "replay-bad-json",
  "replay-bad-shape",
  "replay-missing-section",
]);

const INVALID_REASONS: ReadonlySet<string> = new Set([
  "replay-bad-tick",
  "replay-unsupported-map",
  "replay-missing-seed",
  "replay-version-mismatch",
  "replay-incompatible",
  "replay-compatibility-invalid",
  "replay-data-boundary",
]);

export class ReplayValidationError extends Error {
  readonly code: ReplayValidationErrorCode;
  readonly kind: ReplayRejectionKind;
  readonly reason: string;
  readonly detail: string | null;

  constructor(rejection: ReplayRejection, cause: Error) {
    super(`rejected ${rejection.kind} replay data (${rejection.reason})`, {
      cause,
    });
    this.name = "ReplayValidationError";
    this.code = REPLAY_VALIDATION_REJECTED;
    this.kind = rejection.kind;
    this.reason = rejection.reason;
    this.detail = cause.message;
  }
}

function reasonOf(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  if (!("code" in error) || typeof error.code !== "string") return null;
  return error.code;
}

/**
 * Known loader failure, or null when the throw is not a replay rejection.
 * Null means the caller rethrows.
 */
export function classifyReplayRejection(error: unknown): ReplayRejection | null {
  const reason = reasonOf(error);
  if (reason == null) return null;
  if (MALFORMED_REASONS.has(reason)) return { kind: "malformed", reason };
  if (INVALID_REASONS.has(reason)) return { kind: "invalid", reason };
  return null;
}

/**
 * Load bytes or throw `ReplayValidationError`. Does not mutate `bytes`.
 * Does not verify a digest.
 */
export function acceptReplayBytes(bytes: Uint8Array): LoadedReplay {
  try {
    return loadReplay(bytes);
  } catch (err) {
    const rejection = classifyReplayRejection(err);
    if (rejection == null || !(err instanceof Error)) throw err;
    throw new ReplayValidationError(rejection, err);
  }
}
