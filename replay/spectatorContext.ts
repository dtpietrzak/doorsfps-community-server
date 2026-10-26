/**
 * Epic 12.6 — spectator context (reconstructed view → display facts).
 *
 * Owns the reconstructed-view → spectator-facts boundary only:
 *   ReplayViewState | null
 *     + ReplayIndex
 *     + focusedPlayerId (12.1 identity primitive)
 *     + SpectatorVisibilityFilter value (12.5; predicate called inside)
 *     + rosterNames (caller-built once per session from init-roster names)
 *     → projectSpectatorContext(...) → SpectatorContext | null
 *
 * Per-field provenance:
 *   replayTimeMs     tickToTimeMs(view.tick)          (9.x helper)
 *   scores           { A, B } value copy of view.scores
 *   phase            view.phase
 *   doors.open       view.doorsOpen
 *   doors.changeTick view.doorChangeTick
 *   teams.red/blue   applyVisibilityFilter(visible, "red"|"blue")
 *                    shaped to { id, name, team, presence }
 *   focus.nameplate  rosterNames.get(id) ?? id
 *   focus.presence   CameraPresence from view-row membership + alive
 *   markers          markersAt(index, view.tick) element refs
 *   focusActivity    activityForPlayer(index, id) ref or null
 *
 * Contract (see notes/replay/12-spectator-system/12-06-spectator-context.md):
 * - Null view → null context (pre-step; no tick, no facts).
 * - Verbatim copies for scores / phase / doors — never getDoorCycleState,
 *   never phase derivation, never clock, never wall-clock.
 * - Filter value in, 12.5 predicate inside. Team rows are that subset,
 *   grouped by calling the same predicate with "red" / "blue" (no second
 *   team=== map). Agents stay under their own team. Malformed TeamId rows
 *   that survive "all" are omitted (no third group).
 * - Focus facts ignore the filter (focus ⊥ filter). Lookup is on
 *   view.players, not the subset. Missing row → "absent"; listed name
 *   still used when present in rosterNames.
 * - Presence reuses CameraPresence (type-only): present+alive → "present";
 *   present+dead → "eliminated"; missing → "absent". Null focus → null
 *   focus facts. Never migrates the 12.1 slot, never fails on absence.
 * - Markers are the unfiltered now-row; focusActivity is the focus span.
 *   No markersInRange windows, no kind filter, no filter-subset of markers.
 * - Names from the init-roster lookup only. Unknown id → raw id. Never a
 *   generated handle, never a live-lobby lookup.
 * - Omitted: matchEndTick, projectiles, motion/health/weapon, ping,
 *   cosmetics, account, wallhack/yawdots, live-socket, wall-clock.
 * - SPECTATOR_PRESENCE_NOTE templates are for 21.x chrome; this function
 *   never interpolates them.
 * - Pure: frozen facts in → frozen facts out. No THREE / DOM / keyboard /
 *   wall-clock / runner / clock / sim / net / store / blob / socket /
 *   ReplayPlayback. No consumer rewire — 12.7 / 13.x / 14.x / 18.x / 21.x
 *   call this; this module never edits the viewer.
 *
 * Handoffs: 12.7 shapes windowed tail views through this same function;
 * 13.x reads focus.presence as killcam framing input; 14.x re-derives at
 * seek targets; 18.x asserts fact-exactness; 21.x renders the facts
 * (and the presence-note table) and must not invent facts or transitions.
 */

import type { MatchPhase, TeamScores } from "../protocol/network.ts";
import type { CheckpointPlayerState } from "./authoritativeCheckpoint.ts";
import { tickToTimeMs } from "./checkpointIndex.ts";
import {
  activityForPlayer,
  markersAt,
  type ReplayIndex,
  type ReplayIndexMarker,
  type ReplayIndexPlayerSpan,
} from "./replayIndex.ts";
import type { ReplayViewState } from "./replayStateAccess.ts";
import type { CameraPresence } from "./spectatorCamera.ts";
import { applyVisibilityFilter } from "./spectatorFilter.ts";
import type { SpectatorVisibilityFilter } from "./spectatorSelection.ts";

// ---------------------------------------------------------------------------
// Presence-note templates (chrome interpolates; this module does not)
// ---------------------------------------------------------------------------

export const SPECTATOR_PRESENCE_NOTE = Object.freeze({
  present: "{name}",
  eliminated: "{name} — eliminated",
  absent: "{name-or-id} — absent",
  empty: "No players in view",
} as const);

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export type SpectatorTeamLabel = "red" | "blue";

export type SpectatorTeamRow = {
  readonly id: string;
  readonly name: string;
  readonly team: SpectatorTeamLabel;
  readonly presence: CameraPresence;
};

export type SpectatorTeamRows = {
  readonly red: readonly SpectatorTeamRow[];
  readonly blue: readonly SpectatorTeamRow[];
};

export type SpectatorFocusFacts = {
  readonly nameplate: string;
  readonly presence: CameraPresence;
};

export type SpectatorDoors = {
  readonly open: boolean;
  readonly changeTick: number;
};

export type SpectatorContext = {
  readonly replayTimeMs: number;
  readonly teams: SpectatorTeamRows;
  readonly scores: TeamScores;
  readonly phase: MatchPhase;
  readonly doors: SpectatorDoors;
  readonly focus: SpectatorFocusFacts | null;
  readonly markers: readonly ReplayIndexMarker[];
  readonly focusActivity: ReplayIndexPlayerSpan | null;
};

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------

export function projectSpectatorContext(
  view: ReplayViewState | null,
  index: ReplayIndex,
  focusedPlayerId: string | null,
  filter: SpectatorVisibilityFilter,
  rosterNames: ReadonlyMap<string, string>,
): SpectatorContext | null {
  if (view === null) return null;

  const visible = applyVisibilityFilter(view.players, filter);
  const red = shapeGroup(
    applyVisibilityFilter(visible, "red"),
    "red",
    rosterNames,
  );
  const blue = shapeGroup(
    applyVisibilityFilter(visible, "blue"),
    "blue",
    rosterNames,
  );

  let focus: SpectatorFocusFacts | null = null;
  let focusActivity: ReplayIndexPlayerSpan | null = null;
  if (focusedPlayerId !== null) {
    const focusRow = findRow(view.players, focusedPlayerId);
    focus = Object.freeze({
      nameplate: nameOf(focusedPlayerId, rosterNames),
      presence: focusRow === undefined ? "absent" : rowPresence(focusRow),
    });
    focusActivity = activityForPlayer(index, focusedPlayerId);
  }

  return Object.freeze({
    replayTimeMs: tickToTimeMs(view.tick),
    teams: Object.freeze({ red, blue }),
    scores: Object.freeze({ A: view.scores.A, B: view.scores.B }),
    phase: view.phase,
    doors: Object.freeze({
      open: view.doorsOpen,
      changeTick: view.doorChangeTick,
    }),
    focus,
    markers: Object.freeze(markersAt(index, view.tick)),
    focusActivity,
  });
}

function shapeGroup(
  rows: readonly CheckpointPlayerState[],
  team: SpectatorTeamLabel,
  rosterNames: ReadonlyMap<string, string>,
): readonly SpectatorTeamRow[] {
  const out: SpectatorTeamRow[] = [];
  for (const row of rows) {
    out.push(Object.freeze({
      id: row.id,
      name: nameOf(row.id, rosterNames),
      team,
      presence: rowPresence(row),
    }));
  }
  return Object.freeze(out);
}

function findRow(
  players: readonly CheckpointPlayerState[],
  id: string,
): CheckpointPlayerState | undefined {
  for (const row of players) {
    if (row.id === id) return row;
  }
  return undefined;
}

function nameOf(
  id: string,
  rosterNames: ReadonlyMap<string, string>,
): string {
  const name = rosterNames.get(id);
  return name === undefined ? id : name;
}

function rowPresence(row: CheckpointPlayerState): CameraPresence {
  return row.alive ? "present" : "eliminated";
}
