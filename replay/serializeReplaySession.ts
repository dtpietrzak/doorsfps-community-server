/**
 * Epic 8.6 — serialize a finalized session through the 10.1 container +
 * 10.2 canonical encoding.
 *
 * Builds a `ReplayContainer` (logical sections + version stamp), fills the
 * 10.3 index from sibling streams/checkpoints pre-encode, then emits bytes
 * via `encodeReplayContainer` (no hand-rolled JSON).
 *
 * Load path: `parseProvisionalReplayFile` delegates through 11.1 `loadReplay`
 * so there is one decode/validate/session path. Callers that need tick accessors
 * should use `loadReplay` directly; this alias returns the container only for
 * 8.6/finalization sites.
 */

import {
  buildReplayContainerFromSession,
  type ReplayContainer,
} from "./replayContainer.ts";
import { encodeReplayContainer } from "./replayEncoding.ts";
import { loadReplay } from "./replayLoader.ts";
import type { ReplayBufferedSessionView } from "./replaySessionBuffer.ts";

/**
 * @deprecated Use {@link ReplayContainer}. Kept as an alias so 8.6 call sites
 * and tests that still say "provisional file" resolve to the 10.1 container.
 */
export type ProvisionalReplayFile = ReplayContainer;

export function buildProvisionalReplayFile(
  session: ReplayBufferedSessionView,
): ReplayContainer {
  return buildReplayContainerFromSession(session);
}

export function serializeReplaySession(
  session: ReplayBufferedSessionView,
): Uint8Array {
  const file = buildReplayContainerFromSession(session);
  return encodeReplayContainer(file);
}

/**
 * Thin 8.6 alias over 11.1 {@link loadReplay}: same decode/validate/gate path,
 * returning the container only. Prefer `loadReplay` for an open session with
 * tick accessors.
 */
export function parseProvisionalReplayFile(
  bytes: Uint8Array,
): ReplayContainer {
  return loadReplay(bytes).container;
}
