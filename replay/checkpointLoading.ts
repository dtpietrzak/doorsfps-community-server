/**
 * Epic 9.3 — checkpoint loading: frozen `AuthoritativeCheckpoint` v1 → step-ready sim.
 *
 * One named loader owns "checkpoint → simulation". Validate anchors before any
 * owner write; restore event-free, no RNG draws, no `update()` step.
 *
 * Contract (see notes/replay/09-replay-state-checkpoints/09-03-checkpoint-loading.md):
 * - Validate order: version → runtimeMatchId → map + matchSeed → tick sanity.
 * - Restore order: match block → RNG setState ×5 → roster clear-first →
 *   simTick = T → clear event buffer + per-tick scratch → input queues at defaults.
 * - Source checkpoint never mutated; manager fully replaced (never merged).
 * - Later epics (9.4 / 9.5 / 11.x / 14.3 / #10 / 18.4) call this loader only —
 *   they do not reimplement restore order or anchor policy.
 */

import type { AuthoritativeMapIdentity } from "../shared/sim/authoritativeEvent.ts";
import type { PlayerManager } from "../players/PlayerManager.ts";
import { Player } from "../players/Player.ts";
import {
  CHECKPOINT_SCHEMA_VERSION,
  type AuthoritativeCheckpoint,
  type CheckpointPlayerState,
} from "./authoritativeCheckpoint.ts";
import type { RecordedInitialState } from "./recordedInitialState.ts";

/** Minimal init anchor for chain validation (+ optional roster names). */
export type CheckpointLoadInit = {
  readonly runtimeMatchId: string;
  readonly init: {
    readonly map: AuthoritativeMapIdentity;
    readonly matchSeed: number;
    readonly roster?: readonly { readonly id: string; readonly name: string }[];
  };
};

export type LoadCheckpointOptions = {
  /**
   * 8.2 `RecordedInitialState` or a structural anchor with the same
   * `runtimeMatchId` + `init.map` + `init.matchSeed` (+ optional roster names).
   */
  expectedInit: CheckpointLoadInit | RecordedInitialState;
  /** When set, must equal both the checkpoint and `expectedInit.runtimeMatchId`. */
  expectedRuntimeMatchId?: string;
};

export type CheckpointMismatchField =
  | "schemaVersion"
  | "runtimeMatchId"
  | "map"
  | "matchSeed"
  | "tick";

/** Base typed mismatch — expected vs actual always present. */
export class CheckpointLoadError extends Error {
  readonly field: CheckpointMismatchField;
  readonly expected: unknown;
  readonly actual: unknown;

  constructor(
    field: CheckpointMismatchField,
    expected: unknown,
    actual: unknown,
    message: string,
  ) {
    super(message);
    this.name = "CheckpointLoadError";
    this.field = field;
    this.expected = expected;
    this.actual = actual;
  }
}

export class CheckpointVersionMismatch extends CheckpointLoadError {
  constructor(expected: number, actual: number) {
    super(
      "schemaVersion",
      expected,
      actual,
      `checkpoint schemaVersion mismatch: expected ${expected}, got ${actual}`,
    );
    this.name = "CheckpointVersionMismatch";
  }
}

export class CheckpointAnchorMismatch extends CheckpointLoadError {
  constructor(expected: string, actual: string) {
    super(
      "runtimeMatchId",
      expected,
      actual,
      `checkpoint runtimeMatchId mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
    this.name = "CheckpointAnchorMismatch";
  }
}

export class CheckpointInitMismatch extends CheckpointLoadError {
  constructor(
    field: "map" | "matchSeed",
    expected: unknown,
    actual: unknown,
  ) {
    super(
      field,
      expected,
      actual,
      field === "map"
        ? `checkpoint map identity mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
        : `checkpoint matchSeed mismatch: expected ${expected}, got ${actual}`,
    );
    this.name = "CheckpointInitMismatch";
  }
}

export class CheckpointTickInvalid extends CheckpointLoadError {
  constructor(expected: string, actual: number) {
    super(
      "tick",
      expected,
      actual,
      `checkpoint tick invalid: expected ${expected}, got ${actual}`,
    );
    this.name = "CheckpointTickInvalid";
  }
}

/**
 * Validate then restore. On any mismatch, throws a typed error and leaves
 * `manager` untouched. Never calls `update()`, never records authoritative
 * events, never mutates `checkpoint`.
 */
export function loadCheckpointState(
  manager: PlayerManager,
  checkpoint: AuthoritativeCheckpoint,
  options: LoadCheckpointOptions,
): void {
  validateCheckpointLoad(checkpoint, options);
  manager.restoreFromCheckpoint(checkpoint, nameLookup(options.expectedInit));
}

/** Pure validation — same rules as the loader, no mutation. */
export function validateCheckpointLoad(
  checkpoint: AuthoritativeCheckpoint,
  options: LoadCheckpointOptions,
): void {
  if (checkpoint.schemaVersion !== CHECKPOINT_SCHEMA_VERSION) {
    throw new CheckpointVersionMismatch(
      CHECKPOINT_SCHEMA_VERSION,
      checkpoint.schemaVersion as number,
    );
  }

  const init = options.expectedInit;
  const expectedId = options.expectedRuntimeMatchId ?? init.runtimeMatchId;
  if (expectedId !== init.runtimeMatchId) {
    throw new CheckpointAnchorMismatch(init.runtimeMatchId, expectedId);
  }
  if (checkpoint.runtimeMatchId !== expectedId) {
    throw new CheckpointAnchorMismatch(expectedId, checkpoint.runtimeMatchId);
  }

  const expectedMap = init.init.map;
  if (
    checkpoint.map.name !== expectedMap.name ||
    checkpoint.map.version !== expectedMap.version
  ) {
    throw new CheckpointInitMismatch("map", expectedMap, checkpoint.map);
  }

  if (checkpoint.matchSeed !== init.init.matchSeed) {
    throw new CheckpointInitMismatch(
      "matchSeed",
      init.init.matchSeed,
      checkpoint.matchSeed,
    );
  }

  assertTickSane(checkpoint);
}

function assertTickSane(checkpoint: AuthoritativeCheckpoint): void {
  const tick = checkpoint.tick;
  if (!Number.isFinite(tick) || !Number.isInteger(tick) || tick < 0) {
    throw new CheckpointTickInvalid(
      "finite integer >= 0",
      tick,
    );
  }
  const match = checkpoint.match;
  const upper = Math.max(
    match.matchEndTick,
    match.restartAtTick ?? match.matchEndTick,
  ) + match.matchDurationTicks;
  if (tick > upper) {
    throw new CheckpointTickInvalid(
      `<= ${upper} (match bounds)`,
      tick,
    );
  }
}

function nameLookup(
  init: CheckpointLoadInit | RecordedInitialState,
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  const roster = init.init.roster;
  if (!roster) return map;
  for (const entry of roster) {
    if (typeof entry?.id === "string" && typeof entry?.name === "string") {
      map.set(entry.id, entry.name);
    }
  }
  return map;
}

/** Build a Player from a checkpoint row without join/spawn side effects. */
export function playerFromCheckpointState(
  state: CheckpointPlayerState,
  name: string,
): Player {
  const isAgent = state.isAgent === true;
  const player = new Player(state.id, name, state.team, {
    // Checkpoint `isBot` is the raid-bot role — see capturePlayerState.
    isBot: isAgent,
    isAgent,
    isRaidBot: state.isBot === true,
    maxHealth: state.maxHealth,
    equipment: state.equipment,
    ...(state.ownedAbilities !== undefined
      ? { ownedAbilities: state.ownedAbilities }
      : {}),
    ...(state.skillLoadout !== undefined
      ? { skillLoadout: state.skillLoadout }
      : {}),
  });
  player.restoreFromCheckpoint(state);
  return player;
}
