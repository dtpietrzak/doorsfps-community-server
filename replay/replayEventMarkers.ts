/**
 * Epic 14.2 — replay event markers (presentation only).
 *
 * Places the 10.3 marker table on the 14.1 timeline:
 *   kills, deaths, door captures, agent appearances, major match events.
 *
 * Contract (notes/replay/replay-detailed.md §14.2, index handoff in
 * notes/replay/10-replay-file-format/10-03-replay-index.md, killer identity
 * in notes/replay/13-killcams/13-killcams.md):
 * - Which pins exist, and at which tick, comes from `ReplayIndex.markers`.
 *   This module does not build an index and does not scan an unindexed
 *   event stream into a second table.
 * - Tick is canonical. Times use `tickToTimeMs` / `tickToTimeSec`.
 *   `elapsedMs` is `tickToTimeMs(tick - firstTick)` (no carry). `progress`
 *   uses the timeline denominator `lastTick - firstTick`: 0 on the start
 *   tick, 1 on the end tick. A single-tick span is progress 0 — carry and
 *   `isEnded` belong to the playhead, not to a pin.
 * - Closed presentation kinds:
 *     death        ← markerKind death (every playerDied)
 *     kill         ← that death when the event stream names a different killer
 *     doorCapture  ← markerKind doorCapture
 *     agentAppearance ← agentAdd only (agentRemove is not an appearance)
 *     matchEvent   ← markerKind phaseChange (matchStart/End/Draw, gameOver)
 *   Roster markers (join, leave, respawn) are not pins. combatBurst is not
 *   in the v1 index, so it is not a pin.
 * - `involvedPlayerIds` order is not victim/killer. When `eventsAt` is
 *   passed, deaths pair with `playerDied` in drain order and identity comes
 *   from `resolveKillcamDeath`. A kill pin exists only then, and only when
 *   killerId !== victimId (self-kills stay a death). Without `eventsAt`,
 *   deaths are still listed and player ids are an uninterpreted copy.
 * - Same-tick order is the index drain order. A kill pin is emitted
 *   immediately after its death, before the next index row.
 * - When `eventsAt` is passed, each presented kind's rows at a tick must
 *   match the stream's events of that kind (count, appliedTick, eventKind).
 *   A mismatch is a loud error, not a nearest-event guess.
 * - Pure: no runner, clock, camera, THREE, DOM, wall-clock, fs, blob, store,
 *   or net imports. No seek. 21.4 draws the pins.
 */

import type {
  AuthoritativeEvent,
  AuthoritativeEventKind,
  AuthoritativeTeamId,
} from "../shared/sim/authoritativeEvent.ts";
import { tickToTimeMs, tickToTimeSec } from "./checkpointIndex.ts";
import { resolveKillcamDeath } from "./killcam.ts";
import type { ReplayIndexMarker } from "./replayIndex.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const REPLAY_EVENT_MARKER_KINDS = [
  "kill",
  "death",
  "doorCapture",
  "agentAppearance",
  "matchEvent",
] as const;

export type ReplayEventMarkerKind = (typeof REPLAY_EVENT_MARKER_KINDS)[number];

type ReplayEventMarkerBase = {
  readonly eventKind: AuthoritativeEventKind;
  readonly tick: number;
  readonly timeMs: number;
  readonly timeSec: number;
  /** `tickToTimeMs(tick - firstTick)`. No sub-tick carry. */
  readonly elapsedMs: number;
  readonly elapsedSec: number;
  /**
   * 0 at `firstTick`, 1 at `lastTick`. Single-tick span is 0.
   * Denominator matches timeline progress (`lastTick - firstTick`).
   */
  readonly progress: number;
  readonly playerIds: readonly string[];
};

export type ReplayDeathMarker = ReplayEventMarkerBase & {
  readonly kind: "death";
  /** Null when the caller did not pass `eventsAt`. */
  readonly victimId: string | null;
  readonly killerId: string | null;
  readonly victimName: string | null;
  readonly killerName: string | null;
};

/** Distinct-killer view of a death. Absent for self-kills and unresolved deaths. */
export type ReplayKillMarker = ReplayEventMarkerBase & {
  readonly kind: "kill";
  readonly victimId: string;
  readonly killerId: string;
  readonly victimName: string;
  readonly killerName: string;
};

export type ReplayDoorCaptureMarker = ReplayEventMarkerBase & {
  readonly kind: "doorCapture";
  readonly scorerId: string | null;
  readonly team: AuthoritativeTeamId | null;
};

export type ReplayAgentAppearanceMarker = ReplayEventMarkerBase & {
  readonly kind: "agentAppearance";
  readonly playerId: string | null;
};

export type ReplayMatchEventMarker = ReplayEventMarkerBase & {
  readonly kind: "matchEvent";
};

export type ReplayEventMarker =
  | ReplayKillMarker
  | ReplayDeathMarker
  | ReplayDoorCaptureMarker
  | ReplayAgentAppearanceMarker
  | ReplayMatchEventMarker;

export type ReplayEventMarkers = {
  /** Drain order, with each kill pin sitting immediately after its death. */
  readonly markers: readonly ReplayEventMarker[];
  readonly kills: readonly ReplayKillMarker[];
  readonly deaths: readonly ReplayDeathMarker[];
  readonly doorCaptures: readonly ReplayDoorCaptureMarker[];
  readonly agentAppearances: readonly ReplayAgentAppearanceMarker[];
  readonly matchEvents: readonly ReplayMatchEventMarker[];
};

export type ReplayEventMarkersInput = {
  readonly firstTick: number;
  readonly lastTick: number;
  /** Index marker table. Not rebuilt here. */
  readonly markers: readonly ReplayIndexMarker[];
  /**
   * Event stream for identity. Omit to present deaths without a kill split.
   * Passed: every presented index row at a tick must match the stream.
   */
  readonly eventsAt?: (tick: number) => ReadonlyArray<AuthoritativeEvent>;
};

export type ReplayEventMarkersErrorCode =
  | "replay-markers-bad-tick"
  | "replay-markers-bad-range"
  | "replay-markers-bad-order"
  | "replay-markers-out-of-range"
  | "replay-markers-unknown-kind"
  | "replay-markers-stream-mismatch";

export class ReplayEventMarkersError extends Error {
  readonly code: ReplayEventMarkersErrorCode;
  readonly detail: string | null;

  constructor(
    code: ReplayEventMarkersErrorCode,
    message: string,
    opts?: { detail?: string | null; cause?: unknown },
  ) {
    super(
      message,
      opts?.cause !== undefined ? { cause: opts.cause } : undefined,
    );
    this.name = "ReplayEventMarkersError";
    this.code = code;
    this.detail = opts?.detail ?? null;
  }
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

const MATCH_EVENT_KINDS: ReadonlySet<AuthoritativeEventKind> = new Set([
  "matchStart",
  "matchEnd",
  "matchDraw",
  "gameOver",
]);

function assertSpanTick(name: string, tick: number): void {
  if (!Number.isInteger(tick) || !Number.isFinite(tick) || tick < 0) {
    throw new ReplayEventMarkersError(
      "replay-markers-bad-tick",
      `${name} must be a non-negative integer tick`,
      { detail: String(tick) },
    );
  }
}

function copyIds(ids: readonly string[]): readonly string[] {
  return Object.freeze(ids.slice());
}

function soleId(ids: readonly string[]): string | null {
  return ids.length === 1 ? ids[0]! : null;
}

function place(
  firstTick: number,
  lastTick: number,
  tick: number,
  eventKind: AuthoritativeEventKind,
  playerIds: readonly string[],
): ReplayEventMarkerBase {
  const timeMs = tickToTimeMs(tick);
  const elapsedMs = tickToTimeMs(tick - firstTick);
  const span = lastTick - firstTick;
  return {
    eventKind,
    tick,
    timeMs,
    timeSec: tickToTimeSec(tick),
    elapsedMs,
    elapsedSec: elapsedMs / 1000,
    progress: span === 0 ? 0 : (tick - firstTick) / span,
    playerIds,
  };
}

function eventsAtTick(
  eventsAt: (tick: number) => ReadonlyArray<AuthoritativeEvent>,
  tick: number,
): readonly AuthoritativeEvent[] {
  const events = eventsAt(tick);
  if (!Array.isArray(events)) {
    throw new ReplayEventMarkersError(
      "replay-markers-stream-mismatch",
      "eventsAt must return an array",
      { detail: String(tick) },
    );
  }
  return events;
}

function mismatch(detail: string): never {
  throw new ReplayEventMarkersError(
    "replay-markers-stream-mismatch",
    "index markers and the event stream disagree",
    { detail },
  );
}

function takeNext<T extends AuthoritativeEvent>(
  events: readonly T[],
  index: number,
  marker: ReplayIndexMarker,
): T {
  const event = events[index];
  if (event === undefined) {
    mismatch(
      `${marker.markerKind} at ${marker.tick}: marker ${
        index + 1
      } has no event`,
    );
  }
  if (event.appliedTick !== marker.tick || event.kind !== marker.eventKind) {
    mismatch(
      `${marker.markerKind} at ${marker.tick}: expected ${marker.eventKind}@${marker.tick}, got ${event.kind}@${event.appliedTick}`,
    );
  }
  return event;
}

function finishCount(
  label: string,
  tick: number,
  used: number,
  available: number,
): void {
  if (used !== available) {
    mismatch(
      `${label} at ${tick}: ${used} markers, ${available} events`,
    );
  }
}

type TickGroup = {
  readonly tick: number;
  readonly markers: readonly ReplayIndexMarker[];
};

function groupByTick(markers: readonly ReplayIndexMarker[]): TickGroup[] {
  const groups: { tick: number; markers: ReplayIndexMarker[] }[] = [];
  for (const marker of markers) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.tick === marker.tick) {
      last.markers.push(marker);
    } else {
      groups.push({ tick: marker.tick, markers: [marker] });
    }
  }
  return groups;
}

function assertMarkers(
  markers: readonly ReplayIndexMarker[],
  firstTick: number,
  lastTick: number,
): void {
  let prev: number | null = null;
  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i]!;
    assertSpanTick(`markers[${i}].tick`, marker.tick);
    if (prev !== null && marker.tick < prev) {
      throw new ReplayEventMarkersError(
        "replay-markers-bad-order",
        "markers must be in non-decreasing tick order",
        { detail: `${prev} then ${marker.tick}` },
      );
    }
    prev = marker.tick;
    if (marker.tick < firstTick || marker.tick > lastTick) {
      throw new ReplayEventMarkersError(
        "replay-markers-out-of-range",
        "marker tick is outside [firstTick, lastTick]",
        { detail: `${marker.tick} not in ${firstTick}..${lastTick}` },
      );
    }
    if (!Array.isArray(marker.involvedPlayerIds)) {
      throw new ReplayEventMarkersError(
        "replay-markers-unknown-kind",
        "marker involvedPlayerIds must be an array",
        { detail: String(marker.tick) },
      );
    }
  }
}

/**
 * Present index markers on `[firstTick, lastTick]`. Does not read a clock
 * and does not seek.
 */
export function replayEventMarkers(
  input: ReplayEventMarkersInput,
): ReplayEventMarkers {
  assertSpanTick("firstTick", input.firstTick);
  assertSpanTick("lastTick", input.lastTick);
  if (input.lastTick < input.firstTick) {
    throw new ReplayEventMarkersError(
      "replay-markers-bad-range",
      "lastTick precedes firstTick",
      { detail: `${input.firstTick}..${input.lastTick}` },
    );
  }
  if (!Array.isArray(input.markers)) {
    throw new ReplayEventMarkersError(
      "replay-markers-unknown-kind",
      "markers must be an array",
    );
  }
  assertMarkers(input.markers, input.firstTick, input.lastTick);

  const out: ReplayEventMarker[] = [];
  for (const group of groupByTick(input.markers)) {
    presentTick(out, input, group);
  }

  const kills: ReplayKillMarker[] = [];
  const deaths: ReplayDeathMarker[] = [];
  const doorCaptures: ReplayDoorCaptureMarker[] = [];
  const agentAppearances: ReplayAgentAppearanceMarker[] = [];
  const matchEvents: ReplayMatchEventMarker[] = [];
  for (const marker of out) {
    switch (marker.kind) {
      case "kill":
        kills.push(marker);
        break;
      case "death":
        deaths.push(marker);
        break;
      case "doorCapture":
        doorCaptures.push(marker);
        break;
      case "agentAppearance":
        agentAppearances.push(marker);
        break;
      case "matchEvent":
        matchEvents.push(marker);
        break;
      default: {
        const _exhaustive: never = marker;
        throw new ReplayEventMarkersError(
          "replay-markers-unknown-kind",
          "unknown presentation kind",
          { detail: String(_exhaustive) },
        );
      }
    }
  }

  return Object.freeze({
    markers: Object.freeze(out),
    kills: Object.freeze(kills),
    deaths: Object.freeze(deaths),
    doorCaptures: Object.freeze(doorCaptures),
    agentAppearances: Object.freeze(agentAppearances),
    matchEvents: Object.freeze(matchEvents),
  });
}

function presentTick(
  out: ReplayEventMarker[],
  input: ReplayEventMarkersInput,
  group: TickGroup,
): void {
  const events = input.eventsAt
    ? eventsAtTick(input.eventsAt, group.tick)
    : null;
  const died = events?.filter((event) => event.kind === "playerDied") ?? [];
  const scores = events?.filter((event) => event.kind === "score") ?? [];
  const agents = events?.filter((event) => event.kind === "agentAdd") ?? [];
  const phases = events?.filter((event) => MATCH_EVENT_KINDS.has(event.kind)) ??
    [];

  let deathI = 0;
  let scoreI = 0;
  let agentI = 0;
  let phaseI = 0;

  for (const marker of group.markers) {
    switch (marker.markerKind) {
      case "death":
        presentDeath(out, input, marker, events, died, deathI);
        deathI++;
        break;
      case "doorCapture":
        presentDoor(out, input, marker, scores, scoreI);
        scoreI++;
        break;
      case "agent":
        if (marker.eventKind === "agentRemove") break;
        if (marker.eventKind !== "agentAdd") {
          throw new ReplayEventMarkersError(
            "replay-markers-unknown-kind",
            "agent marker is neither agentAdd nor agentRemove",
            { detail: `${marker.eventKind}@${marker.tick}` },
          );
        }
        presentAgent(out, input, marker, agents, agentI);
        agentI++;
        break;
      case "phaseChange":
        presentPhase(out, input, marker, phases, phaseI);
        phaseI++;
        break;
      case "roster":
        break;
      default: {
        const kind: never = marker.markerKind;
        throw new ReplayEventMarkersError(
          "replay-markers-unknown-kind",
          "unknown index marker kind",
          { detail: String(kind) },
        );
      }
    }
  }

  if (events) {
    finishCount("death", group.tick, deathI, died.length);
    finishCount("doorCapture", group.tick, scoreI, scores.length);
    finishCount("agentAdd", group.tick, agentI, agents.length);
    finishCount("phaseChange", group.tick, phaseI, phases.length);
  }
}

function presentDeath(
  out: ReplayEventMarker[],
  input: ReplayEventMarkersInput,
  marker: ReplayIndexMarker,
  events: readonly AuthoritativeEvent[] | null,
  died: readonly AuthoritativeEvent[],
  index: number,
): void {
  const baseIds = copyIds(marker.involvedPlayerIds);
  if (!events) {
    out.push(Object.freeze({
      ...place(
        input.firstTick,
        input.lastTick,
        marker.tick,
        marker.eventKind,
        baseIds,
      ),
      kind: "death",
      victimId: null,
      killerId: null,
      victimName: null,
      killerName: null,
    }));
    return;
  }

  const event = takeNext(died, index, marker);
  const resolved = resolveKillcamDeath(events, {
    victimId: event.kind === "playerDied" ? event.victimId : "",
    deathTick: marker.tick,
  });
  const distinct = resolved.killerId !== resolved.victimId;
  const playerIds = distinct
    ? Object.freeze([resolved.victimId, resolved.killerId])
    : Object.freeze([resolved.victimId]);
  out.push(Object.freeze({
    ...place(
      input.firstTick,
      input.lastTick,
      marker.tick,
      marker.eventKind,
      playerIds,
    ),
    kind: "death",
    victimId: resolved.victimId,
    killerId: resolved.killerId,
    victimName: resolved.victimName,
    killerName: resolved.killerName,
  }));
  if (!distinct) return;
  out.push(Object.freeze({
    ...place(
      input.firstTick,
      input.lastTick,
      marker.tick,
      marker.eventKind,
      Object.freeze([resolved.killerId]),
    ),
    kind: "kill",
    victimId: resolved.victimId,
    killerId: resolved.killerId,
    victimName: resolved.victimName,
    killerName: resolved.killerName,
  }));
}

function presentDoor(
  out: ReplayEventMarker[],
  input: ReplayEventMarkersInput,
  marker: ReplayIndexMarker,
  scores: readonly AuthoritativeEvent[],
  index: number,
): void {
  if (input.eventsAt === undefined) {
    out.push(Object.freeze({
      ...place(
        input.firstTick,
        input.lastTick,
        marker.tick,
        marker.eventKind,
        copyIds(marker.involvedPlayerIds),
      ),
      kind: "doorCapture",
      scorerId: soleId(marker.involvedPlayerIds),
      team: null,
    }));
    return;
  }
  const event = takeNext(scores, index, marker);
  if (event.kind !== "score") {
    mismatch(`doorCapture at ${marker.tick}: event is ${event.kind}`);
  }
  out.push(Object.freeze({
    ...place(
      input.firstTick,
      input.lastTick,
      marker.tick,
      marker.eventKind,
      Object.freeze([event.scorerId]),
    ),
    kind: "doorCapture",
    scorerId: event.scorerId,
    team: event.team,
  }));
}

function presentAgent(
  out: ReplayEventMarker[],
  input: ReplayEventMarkersInput,
  marker: ReplayIndexMarker,
  agents: readonly AuthoritativeEvent[],
  index: number,
): void {
  if (input.eventsAt === undefined) {
    out.push(Object.freeze({
      ...place(
        input.firstTick,
        input.lastTick,
        marker.tick,
        marker.eventKind,
        copyIds(marker.involvedPlayerIds),
      ),
      kind: "agentAppearance",
      playerId: soleId(marker.involvedPlayerIds),
    }));
    return;
  }
  const event = takeNext(agents, index, marker);
  if (event.kind !== "agentAdd") {
    mismatch(`agentAdd at ${marker.tick}: event is ${event.kind}`);
  }
  out.push(Object.freeze({
    ...place(
      input.firstTick,
      input.lastTick,
      marker.tick,
      marker.eventKind,
      Object.freeze([event.player.id]),
    ),
    kind: "agentAppearance",
    playerId: event.player.id,
  }));
}

function presentPhase(
  out: ReplayEventMarker[],
  input: ReplayEventMarkersInput,
  marker: ReplayIndexMarker,
  phases: readonly AuthoritativeEvent[],
  index: number,
): void {
  if (!MATCH_EVENT_KINDS.has(marker.eventKind)) {
    throw new ReplayEventMarkersError(
      "replay-markers-unknown-kind",
      "phaseChange marker has a non-match event kind",
      { detail: `${marker.eventKind}@${marker.tick}` },
    );
  }
  if (input.eventsAt !== undefined) {
    takeNext(phases, index, marker);
  }
  out.push(Object.freeze({
    ...place(
      input.firstTick,
      input.lastTick,
      marker.tick,
      marker.eventKind,
      copyIds(marker.involvedPlayerIds),
    ),
    kind: "matchEvent",
  }));
}
