/**
 * Epic 5.2 — tick association policy for per-player input selection.
 *
 * Pure helpers + types only. `Player.queueInput` / `Player.update` apply this
 * policy; recording (#8.3) will tap {@link TickSelectedInput} — never
 * `latestInput` directly.
 *
 * Wire `PlayerInput` is the live selection type today. When 5.3/5.4 adapters
 * land, the same association rows apply to `CanonicalPlayerInput` without
 * changing this truth table.
 */

import type { PlayerInput } from "../protocol/network.ts";

/**
 * Why a tick selected its input. Rows match the policy truth table.
 *
 * | Case               | Arrival / state                         | Selected                  | Edges                         |
 * |--------------------|-----------------------------------------|---------------------------|-------------------------------|
 * | `fresh`            | new `sequence` at tick start            | that packet               | armed once                    |
 * | `hold`             | same `sequence` re-queued / re-stepped  | same packet               | suppressed (already consumed) |
 * | `repeat_missing`   | no arrival; prior packet still latest   | previous packet           | suppressed                    |
 * | (stale — drop)     | `sequence < lastSequence` at queue       | never selected            | n/a                           |
 * | `neutral`          | never any input (`latestInput` null)    | null → stepMove null path | none                          |
 * | `dead`             | `!alive` (look-only in queueInput)      | no move selection         | n/a                           |
 * | `connection_issue` | sitting duck                            | null (forced)             | none                          |
 *
 * Late/stale arrivals are dropped in `queueInput` and never appear here.
 * Multiple arrivals in one inter-tick window: last-write-wins (latest packet
 * at tick-start snapshot). Mid-tick arrivals after the snapshot apply next tick.
 */
export type TickAssociationKind =
  | "fresh"
  | "hold"
  | "repeat_missing"
  | "neutral"
  | "dead"
  | "connection_issue";

/**
 * Per-tick selection exposed for future recording (#8.3).
 * One row per player per sim tick after `Player.update` runs.
 */
export type TickSelectedInput = {
  readonly tick: number;
  readonly playerId: string;
  /**
   * Snapshot selected at tick start. `null` means neutral / connection-issue
   * (stepMove null path — preserves crouch-edge and slide-drop semantics).
   * Recording may materialize {@link neutralPlayerInput} when null.
   */
  readonly selectedInput: PlayerInput | null;
  readonly association: TickAssociationKind;
  /** Highest sequence stepped at least once (distinct from last received). */
  readonly appliedSequence: number;
  /** Hold count for {@link appliedSequence} after this tick (1 on fresh). */
  readonly inputHoldTicks: number;
  /**
   * Packet accepted by `queueInput` this tick when there is no selection
   * (dead look-only arrival, or killed after queueing but before MovePhysics).
   * Replay must re-queue it so look / sequence state matches live.
   */
  readonly queuedInput?: PlayerInput;
};

/** Explicit no-keys default with authoritative look (recording / adapters). */
export function neutralPlayerInput(
  yaw: number,
  pitch: number,
  sequence = 0,
): PlayerInput {
  return {
    sequence,
    forward: false,
    backward: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
    crouch: false,
    meleeLunge: false,
    yaw,
    pitch,
  };
}

/**
 * Clear wire movement edges after a successful one-shot consumption.
 * Pins today's `jump` / `meleeLunge` clear-after-step precedent so a held
 * packet cannot double-fire. Canonical edges (`fire`, `reload`,
 * `weaponSelect`, `ability`) stay with out-of-band handlers in 5.2; when
 * adapters wire them into the per-tick snapshot, call
 * `consumeCanonicalEdges` after apply (see TICK_ASSOCIATION.md).
 */
export function consumeWireMovementEdges(
  input: PlayerInput,
  opts: { jumped: boolean; meleeLungeStarted: boolean },
): void {
  if (opts.jumped) input.jump = false;
  if (opts.meleeLungeStarted) input.meleeLunge = false;
}

/**
 * Classify the association row after a live update.
 * Pure: does not mutate inputs or counters.
 *
 * @param arrivalSinceLastStep - true if `queueInput` accepted a packet since
 *   the previous `update` (set by Player; cleared each step).
 * @param sequenceChanged - true if this tick's stepped sequence differs from
 *   the prior `appliedSequence`.
 */
export function classifyTickAssociation(args: {
  alive: boolean;
  connectionIssue: boolean;
  selectedInput: PlayerInput | null;
  arrivalSinceLastStep: boolean;
  sequenceChanged: boolean;
}): TickAssociationKind {
  if (!args.alive) return "dead";
  if (args.connectionIssue) return "connection_issue";
  const input = args.selectedInput;
  if (!input || !(typeof input.sequence === "number" && input.sequence > 0)) {
    return "neutral";
  }
  if (args.sequenceChanged) return "fresh";
  return args.arrivalSinceLastStep ? "hold" : "repeat_missing";
}
