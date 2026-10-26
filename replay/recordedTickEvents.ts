/**
 * Epic 8.4 — recorded per-tick authoritative events.
 *
 * The tick-event family IS the 7.5 sink payload:
 * `ReplayTickPayload.events` — the 7.3 unified drain output already ordered
 * (buffer canonical order, then sim-outcome `SIM_TICK_EVENT_ORDER`, GameOver
 * dedup applied). This module never calls the drain itself.
 *
 * Contract (see notes/replay/08-replay-recording/08-04-event-recording.md):
 * - Frozen copies only — never live owner references / mutable aliases.
 * - Verbatim drain order — no re-sort, no emit-path enrichment.
 * - `matchInit` diverted to the 8.2 slot, never appended to the event stream.
 * - Sparse ticks: empty lists are not stored; accessors synthesize frozen [].
 * - No bot-brain / second-drain imports — humans and bots share one vocabulary.
 * - Memory-only; no store / file / finalized writes.
 *
 * Accessors for later epics: `ReplayRecorder.getTickEvents(runtimeMatchId, tick)`
 * and `ReplayRecorder.getEventStream(runtimeMatchId)`.
 */

import type {
  AuthoritativeEvent,
  MatchInitEvent,
} from "../shared/sim/authoritativeEvent.ts";
import type { ReplayTickPayload } from "./replayIntegration.ts";
import { deepFreeze } from "./recordedInitialState.ts";

/**
 * Frozen per-tick event capture for one `runtimeMatchId` session tick.
 * Consumed by 8.5 / 8.6 / #10 / 11.2 / #13 via
 * `ReplayRecorder.getTickEvents` / `getEventStream`.
 */
export type RecordedTickEvents = {
  /** Draining tick under which the list is keyed. */
  readonly tick: number;
  /**
   * Drain-order events for this tick (`appliedTick` preserved per event).
   * Never includes `matchInit` (diverted to 8.2).
   */
  readonly events: ReadonlyArray<AuthoritativeEvent>;
};

export type CaptureTickEventsResult =
  | {
    ok: true;
    tick: number;
    /** Remaining events after `matchInit` divert (already frozen). */
    events: ReadonlyArray<AuthoritativeEvent>;
    /** Diverted `matchInit` rows (frozen); empty when none present. */
    divertedMatchInits: ReadonlyArray<MatchInitEvent>;
  }
  | { ok: false; reason: string };

/** Shared frozen empty list for sparse-tick accessor reads. */
export const EMPTY_RECORDED_EVENTS: ReadonlyArray<AuthoritativeEvent> =
  deepFreeze([]);

/**
 * Validate + freeze the sink-delivered event list for one draining tick.
 * Does not touch live sim state, the drain, or the replays store.
 */
export function captureRecordedTickEvents(
  payload: Readonly<ReplayTickPayload>,
): CaptureTickEventsResult {
  if (payload == null || typeof payload !== "object") {
    return { ok: false, reason: "tick payload missing" };
  }
  if (typeof payload.tick !== "number" || !Number.isFinite(payload.tick)) {
    return { ok: false, reason: "event tick anchor missing" };
  }
  if (payload.events == null || !Array.isArray(payload.events)) {
    return { ok: false, reason: "events payload missing" };
  }

  const divertedMatchInits: MatchInitEvent[] = [];
  const kept: AuthoritativeEvent[] = [];

  for (let i = 0; i < payload.events.length; i++) {
    const ev = payload.events[i];
    if (ev == null || typeof ev !== "object") {
      return { ok: false, reason: `null event at ordinal ${i}` };
    }
    if (typeof ev.kind !== "string") {
      return { ok: false, reason: `event at ordinal ${i} missing kind` };
    }
    if (typeof ev.appliedTick !== "number" || !Number.isFinite(ev.appliedTick)) {
      return {
        ok: false,
        reason: `event missing appliedTick (kind=${ev.kind}, ordinal=${i})`,
      };
    }
    if (ev.kind === "matchInit") {
      divertedMatchInits.push(ev);
      continue;
    }
    kept.push(ev);
  }

  // Structured-clone-equivalent freeze point: independent of live owners.
  const frozenEvents = deepFreeze(structuredClone(kept)) as AuthoritativeEvent[];
  const frozenDiverted = divertedMatchInits.map(
    (e) => deepFreeze(structuredClone(e)) as MatchInitEvent,
  );

  return {
    ok: true,
    tick: payload.tick,
    events: frozenEvents,
    divertedMatchInits: frozenDiverted,
  };
}

/** Build a frozen `RecordedTickEvents` row (caller supplies already-frozen events). */
export function freezeRecordedTickEvents(
  tick: number,
  events: ReadonlyArray<AuthoritativeEvent>,
): RecordedTickEvents {
  return deepFreeze({ tick, events }) as RecordedTickEvents;
}

/**
 * Compare a diverted `matchInit` against the 8.2 session slot.
 * Agreement is structural equality of the frozen init payloads.
 */
export function matchInitAgreesWithSlot(
  slotInit: Readonly<MatchInitEvent>,
  diverted: Readonly<MatchInitEvent>,
): boolean {
  try {
    return JSON.stringify(slotInit) === JSON.stringify(diverted);
  } catch {
    return false;
  }
}
