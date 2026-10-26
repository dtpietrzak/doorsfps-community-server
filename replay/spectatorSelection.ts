/**
 * Epic 12.1 — player selection (focused identity).
 *
 * Owns the roster → focused-player-id boundary only:
 *   roster ids (runner / init / current view; never a live lobby)
 *     → selectFocusedPlayer / nextPlayer / previousPlayer
 *     → focusedPlayerId
 *   ReplayPlayback.setFocusedPlayerId(id)  (slot-only; Open Question 2A)
 *
 * Contract (see notes/replay/12-spectator-system/12-01-player-selection.md):
 * - Fail closed at selection time: unknown id → `replay-spectator-focus-unknown`;
 *   empty roster → `replay-spectator-focus-empty`. Never null-fallback, never
 *   silent first-alive, never a zero-pose. 11.5's `replay-state-focus-unknown`
 *   is surfaced unchanged where *projection* is the detector (valid-then-absent).
 * - Switch is selection-state only: flip the focus slot; next project reads the
 *   live cursor. Focus change ≠ reset ≠ re-step ≠ clock change.
 * - Absence does not migrate: a valid focus stays selected when the player
 *   later leaves / dies / despawns; they become unprojectable. No auto-advance.
 * - Focus ⊥ visibilityFilter: neither field constrains or implies the other.
 *   `player:<id>` is never a filter value. Filter vocabulary is reserved for
 *   12.5; this module never branches on it.
 * - Cycle order is ascending id (UTF-16 code units, same compare as 11.5
 *   `sortedPlayers`); wrap-around at both ends. Absent ids keep their slot
 *   (the caller must pass an uncompacted identity roster). Single-id roster
 *   next/previous is a no-op round-trip.
 * - Pure: frozen state in / new frozen state out. No THREE / DOM / keyboard /
 *   wall-clock / runner / clock / sim / net / store / blob / socket. The one
 *   impure touchpoint is ReplayPlayback.setFocusedPlayerId (writes the 11.6
 *   focus slot and re-projects; writes nothing else).
 *
 * Handoffs: 12.2–12.4 pose from the focused feed; 12.5 subsets visibility
 * without touching focus; 12.6 reads nameplate/presence and never migrates;
 * 13.x sets killer focus through this API; 14.x re-renders at seek targets;
 * 18.x asserts exactness + non-interference; 21.5 calls select/next/previous
 * (chrome must not invent transitions).
 */

// ---------------------------------------------------------------------------
// Reserved fields (12.2–12.5 land into these; 12.1 does not interpret them)
// ---------------------------------------------------------------------------

/**
 * Reserved for 12.2–12.4 camera math. 12.1 never reads or branches on this.
 * 15.1 clips store one of these modes and must not declare a second set.
 */
export const SPECTATOR_CAMERA_MODES = [
  "first-person",
  "third-person",
  "free",
] as const;

export type SpectatorCameraMode = (typeof SPECTATOR_CAMERA_MODES)[number];

/**
 * Reserved for 12.5 visibility policy. 12.1 never reads, writes (beyond
 * defaulting), or branches on this. `player:<id>` is not a filter value.
 */
export type SpectatorVisibilityFilter = "all" | "red" | "blue" | "agents";

export const DEFAULT_SPECTATOR_CAMERA_MODE: SpectatorCameraMode =
  "first-person";

export const DEFAULT_SPECTATOR_VISIBILITY_FILTER: SpectatorVisibilityFilter =
  "all";

/**
 * Pinned cycle order: lexicographic ascending player id.
 * Independent of runner insertion order and of current presence.
 */
export const SPECTATOR_CYCLE_ORDER = "ascending-id" as const;

/** Pinned wrap: next(last) = first, previous(first) = last. */
export const SPECTATOR_CYCLE_WRAP = "wrap" as const;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type SpectatorState = {
  readonly focusedPlayerId: string | null;
  readonly cameraMode: SpectatorCameraMode;
  readonly visibilityFilter: SpectatorVisibilityFilter;
};

export type SpectatorRoster = readonly string[];

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type SpectatorSelectionErrorCode =
  | "replay-spectator-focus-unknown"
  | "replay-spectator-focus-empty";

export class SpectatorSelectionError extends Error {
  readonly code: SpectatorSelectionErrorCode;
  readonly detail: string | null;

  constructor(
    code: SpectatorSelectionErrorCode,
    message: string,
    opts?: { detail?: string | null },
  ) {
    super(message);
    this.name = "SpectatorSelectionError";
    this.code = code;
    this.detail = opts?.detail ?? null;
  }
}

// ---------------------------------------------------------------------------
// Roster order
// ---------------------------------------------------------------------------

/**
 * Identity roster for select / next / previous: unique ids, ascending order.
 * Empty strings are dropped (they are not identities). Presence is not
 * filtered — the caller supplies the uncompacted match roster.
 */
export function orderSpectatorRoster(
  roster: SpectatorRoster,
): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of roster) {
    if (typeof id !== "string" || id.length === 0) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return out;
}

// ---------------------------------------------------------------------------
// Constructors / readers
// ---------------------------------------------------------------------------

export function createSpectatorState(init?: {
  readonly focusedPlayerId?: string | null;
  readonly cameraMode?: SpectatorCameraMode;
  readonly visibilityFilter?: SpectatorVisibilityFilter;
}): SpectatorState {
  return freezeState({
    focusedPlayerId: init?.focusedPlayerId ?? null,
    cameraMode: init?.cameraMode ?? DEFAULT_SPECTATOR_CAMERA_MODE,
    visibilityFilter: init?.visibilityFilter ??
      DEFAULT_SPECTATOR_VISIBILITY_FILTER,
  });
}

export function getFocusedPlayerId(state: SpectatorState): string | null {
  return state.focusedPlayerId;
}

export function hasFocus(state: SpectatorState): boolean {
  return state.focusedPlayerId !== null && state.focusedPlayerId.length > 0;
}

// ---------------------------------------------------------------------------
// Select / cycle
// ---------------------------------------------------------------------------

/**
 * Validate `playerId` against the identity roster and return a new state with
 * that focus. Reserved fields are copied unchanged (focus ⊥ filter).
 * Re-selecting the same id is a no-op success (new frozen object, same slot).
 */
export function selectFocusedPlayer(
  state: SpectatorState,
  playerId: string,
  roster: SpectatorRoster,
): SpectatorState {
  const ordered = orderSpectatorRoster(roster);
  if (ordered.length === 0) {
    throw new SpectatorSelectionError(
      "replay-spectator-focus-empty",
      "SpectatorSelection: cannot select — roster is empty",
    );
  }
  if (
    typeof playerId !== "string" || playerId.length === 0 ||
    !ordered.includes(playerId)
  ) {
    throw new SpectatorSelectionError(
      "replay-spectator-focus-unknown",
      `SpectatorSelection: unknown focus playerId "${playerId}"`,
      { detail: typeof playerId === "string" ? playerId : null },
    );
  }
  return freezeState({
    focusedPlayerId: playerId,
    cameraMode: state.cameraMode,
    visibilityFilter: state.visibilityFilter,
  });
}

/**
 * Advance one slot in ascending-id order, wrapping last → first.
 * Null focus selects the first id. Current focus missing from the roster
 * fails unknown (never silently compact / migrate).
 */
export function nextPlayer(
  state: SpectatorState,
  roster: SpectatorRoster,
): SpectatorState {
  const ordered = requireOrderedRoster(roster);
  const current = state.focusedPlayerId;
  if (current === null || current.length === 0) {
    return selectFocusedPlayer(state, ordered[0]!, roster);
  }
  const idx = indexInRoster(current, ordered);
  const nextId = ordered[(idx + 1) % ordered.length]!;
  return selectFocusedPlayer(state, nextId, roster);
}

/**
 * Retreat one slot in ascending-id order, wrapping first → last.
 * Null focus selects the last id. Current focus missing from the roster
 * fails unknown (never silently compact / migrate).
 */
export function previousPlayer(
  state: SpectatorState,
  roster: SpectatorRoster,
): SpectatorState {
  const ordered = requireOrderedRoster(roster);
  const current = state.focusedPlayerId;
  if (current === null || current.length === 0) {
    return selectFocusedPlayer(state, ordered[ordered.length - 1]!, roster);
  }
  const idx = indexInRoster(current, ordered);
  const prevId = ordered[(idx - 1 + ordered.length) % ordered.length]!;
  return selectFocusedPlayer(state, prevId, roster);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function requireOrderedRoster(roster: SpectatorRoster): readonly string[] {
  const ordered = orderSpectatorRoster(roster);
  if (ordered.length === 0) {
    throw new SpectatorSelectionError(
      "replay-spectator-focus-empty",
      "SpectatorSelection: cannot cycle — roster is empty",
    );
  }
  return ordered;
}

function indexInRoster(
  playerId: string,
  ordered: readonly string[],
): number {
  const idx = ordered.indexOf(playerId);
  if (idx < 0) {
    throw new SpectatorSelectionError(
      "replay-spectator-focus-unknown",
      `SpectatorSelection: unknown focus playerId "${playerId}"`,
      { detail: playerId },
    );
  }
  return idx;
}

function freezeState(state: SpectatorState): SpectatorState {
  return Object.freeze(state);
}
