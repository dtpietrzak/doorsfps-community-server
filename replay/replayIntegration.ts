import type {
  AuthoritativeEvent,
  MatchInitEvent,
} from "../shared/sim/authoritativeEvent.ts";
import { type MatchMetadata } from "../shared/replay/matchMetadata.ts";
import type { SimActionEffect } from "../players/simActionEffect.ts";
import type { TickSelectedInput } from "../players/tickAssociation.ts";
import type { AuthoritativeCheckpoint } from "./authoritativeCheckpoint.ts";

/**
 * Driver-owned recorder tap point for epic 7.5.
 *
 * Contract:
 * - single attach/detach enable path
 * - no sink attached => zero payload construction beyond the normal live loop
 * - sink is subscription-shaped; it never drives the sim
 * - payloads are read-only views / copies; throws are isolated from the sim tick
 */
export interface ReplayIntegrationSink {
  /**
   * Initial-state family for the current match/session.
   *
   * This is the one-time initializer payload for this match. It is not a start
   * transition and must not be re-emitted merely because the match later enters
   * the live phase.
   */
  onMatchInit(payload: Readonly<ReplayMatchInitPayload>): void;

  /**
   * Lifecycle transition for the match entering live play.
   *
   * This is a transition callback only; it does not carry the initial-state
   * family again.
   */
  onMatchStart(payload: Readonly<ReplayLifecyclePayload>): void;

  /** Called when the match ends via victory/defeat. */
  onMatchEnd(payload: Readonly<ReplayLifecyclePayload>): void;

  /** Called when the match ends in a draw. */
  onMatchDraw(payload: Readonly<ReplayLifecyclePayload>): void;

  /** Called every simulation tick after stepSim() completes. */
  onTick(payload: Readonly<ReplayTickPayload>): void;

  /** Called when the driver requests a full authoritative state snapshot. */
  onCheckpoint(payload: Readonly<ReplayCheckpointPayload>): void;
}

/**
 * Driver-owned attach point. Later epics may store or buffer behind this sink,
 * but the server itself only owns the subscription contract here.
 */
export interface ReplayIntegrationSinkHandle {
  attachReplaySink(sink: ReplayIntegrationSink): void;
  detachReplaySink(): void;
}

export type ReplayMatchInitPayload = {
  /**
   * Initial-state family for this match/session.
   *
   * This payload is emitted once at match initialization and is intentionally
   * distinct from the later lifecycle "matchStart" transition.
   */
  readonly initEvent: Readonly<MatchInitEvent>;
  readonly metadata: Readonly<MatchMetadata>;
};

export type ReplayTickPayload = {
  readonly tick: number;
  /** Per-player consumed input for this tick. */
  readonly inputs: ReadonlyMap<string, TickSelectedInput | null>;
  /**
   * 7.1 queued-vs-immediate association rows (fire / reload / weapon / ability)
   * noted at the unified PlayerManager.handle* seam since the prior fan-out.
   * Each effect carries its own tick (may be earlier than `tick` for
   * between-tick immediates). Empty when no sink-side observer is armed.
   */
  readonly actions: ReadonlyArray<SimActionEffect>;
  /** Unified authoritative events for this tick in the pinned order drained by 7.3. */
  readonly events: ReadonlyArray<AuthoritativeEvent>;
};

export type ReplayCheckpointPayload = {
  readonly tick: number;
  /**
   * Epic 9.1 — resume-sufficient authoritative checkpoint (owner reads).
   * Never a presentation `createSnapshot` / `toSnapshot` view.
   */
  readonly checkpoint: AuthoritativeCheckpoint;
};

export type ReplayLifecycleTransition =
  | "matchStart"
  | "matchEnd"
  | "matchDraw"
  | "runtimeMatchIdRotated";

export type ReplayLifecyclePayload = {
  /** Lifecycle-only callback payload; it never repeats the initial-state family. */
  readonly tick: number;
  readonly runtimeMatchId: string;
  readonly transition: ReplayLifecycleTransition;
  readonly previousRuntimeMatchId?: string;
};
