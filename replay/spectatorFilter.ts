/**
 * Epic 12.5 — visibility filter (projected roster → visible subset).
 *
 * Owns the roster-visibility boundary only:
 *   ReplayViewState.players (CheckpointPlayerState[] via the runner)
 *     + SpectatorState.visibilityFilter
 *     → applyVisibilityFilter(roster, filter) → visible subset
 *     → setVisibilityFilter(state, filter) → state (filter field only)
 *
 * Vocabulary (HUD copy, Open Question 3 closed here):
 *   value    predicate              label
 *   all      identity (new array)   All
 *   blue     team === "A"           Blue
 *   red      team === "B"           Red
 *   agents   isAgent === true       Agents
 *
 * HUD A=Blue / B=Red is pinned against client `RaidsModal.teamLabel` /
 * `Menu` teamHud / `Landing03` team buttons. `isAgent` is the agents
 * predicate — never `isBot` (`authoritativeCheckpoint.ts` CheckpointPlayerState
 * documents isBot as the raid-bot role).
 *
 * Contract (see notes/replay/12-spectator-system/12-05-team-player-filtering.md):
 * - Fail closed on unknown filter values (`replay-spectator-filter-unknown`),
 *   including `player:<id>`, empty string, and wrong case (`"Red"`). Never
 *   silent-fallback to `all`.
 * - Empty subset is a value: `[]` when nothing matches (including an empty
 *   input roster). Never an error. The HUD empty note is 12.6's rendering.
 * - Output is a new frozen array of the same row refs in input order. `all`
 *   is not a pass-through of the input array.
 * - Focus ⊥ filter by construction: applyVisibilityFilter takes no focus
 *   argument; setVisibilityFilter takes no roster and copies focusedPlayerId
 *   + cameraMode unchanged. Setting focus (12.1) never writes this field.
 * - Pure: frozen subset / state in → new frozen subset / state out. No THREE
 *   / DOM / keyboard / wall-clock / runner / clock / sim / net / store /
 *   blob / socket / ReplayPlayback. No consumer rewire — 12.6 / remotes /
 *   21.5 call this; this module never edits the viewer.
 *
 * Handoffs: 12.6 renders the subset + explicit-empty note; 12.7 calls this
 * over windowed views; 13.x relies on focus ⊥ filter for killer focus;
 * 14.x re-filters at seek targets; 18.x asserts subset exactness; 21.5
 * transports the four values and must not invent a fifth.
 */

import type { TeamId } from "../protocol/network.ts";
import type { CheckpointPlayerState } from "./authoritativeCheckpoint.ts";
import type {
  SpectatorState,
  SpectatorVisibilityFilter,
} from "./spectatorSelection.ts";

// ---------------------------------------------------------------------------
// Pins (presentation vocabulary; stops at this module)
// ---------------------------------------------------------------------------

/** HUD "Blue" — wire TeamId for filter value `"blue"`. */
export const SPECTATOR_FILTER_BLUE_TEAM_ID: TeamId = "A";

/** HUD "Red" — wire TeamId for filter value `"red"`. */
export const SPECTATOR_FILTER_RED_TEAM_ID: TeamId = "B";

export const SPECTATOR_VISIBILITY_FILTERS: readonly SpectatorVisibilityFilter[] =
  ["all", "red", "blue", "agents"];

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type SpectatorFilterErrorCode = "replay-spectator-filter-unknown";

export class SpectatorFilterError extends Error {
  readonly code: SpectatorFilterErrorCode;
  readonly detail: string | null;

  constructor(
    code: SpectatorFilterErrorCode,
    message: string,
    opts?: { detail?: string | null },
  ) {
    super(message);
    this.name = "SpectatorFilterError";
    this.code = code;
    this.detail = opts?.detail ?? null;
  }
}

// ---------------------------------------------------------------------------
// Guard / setter / predicate
// ---------------------------------------------------------------------------

export function isSpectatorVisibilityFilter(
  value: unknown,
): value is SpectatorVisibilityFilter {
  return (
    value === "all" ||
    value === "red" ||
    value === "blue" ||
    value === "agents"
  );
}

export function setVisibilityFilter(
  state: SpectatorState,
  filter: SpectatorVisibilityFilter,
): SpectatorState {
  const nextFilter = requireFilter(filter);
  return Object.freeze({
    focusedPlayerId: state.focusedPlayerId,
    cameraMode: state.cameraMode,
    visibilityFilter: nextFilter,
  });
}

export function applyVisibilityFilter(
  roster: readonly CheckpointPlayerState[],
  filter: SpectatorVisibilityFilter,
): readonly CheckpointPlayerState[] {
  const kind = requireFilter(filter);
  if (kind === "all") {
    return Object.freeze(roster.slice());
  }
  const out: CheckpointPlayerState[] = [];
  for (const row of roster) {
    if (kind === "red" && row.team === SPECTATOR_FILTER_RED_TEAM_ID) {
      out.push(row);
    } else if (kind === "blue" && row.team === SPECTATOR_FILTER_BLUE_TEAM_ID) {
      out.push(row);
    } else if (kind === "agents" && row.isAgent === true) {
      out.push(row);
    }
  }
  return Object.freeze(out);
}

function requireFilter(filter: unknown): SpectatorVisibilityFilter {
  if (!isSpectatorVisibilityFilter(filter)) {
    const shown = typeof filter === "string" ? filter : String(filter);
    throw new SpectatorFilterError(
      "replay-spectator-filter-unknown",
      `SpectatorFilter: unknown visibility filter "${shown}"`,
      { detail: typeof filter === "string" ? filter : null },
    );
  }
  return filter;
}
