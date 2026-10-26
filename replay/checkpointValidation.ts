/**
 * Epic 9.4 — checkpoint sufficiency harness.
 *
 * Proves a frozen 9.1 `AuthoritativeCheckpoint` v1 plus the 9.3 loader resume
 * the simulation: capture at T → load fresh → step T+1..T+N with recorded
 * inputs through the 5.2 `queueInput` arrival path → bit-exact compare.
 *
 * Contract (see notes/replay/09-replay-state-checkpoints/09-04-checkpoint-validation.md):
 * - Calls only 9.1 builder + 9.3 loader (never snapshot / store / bot AI).
 * - Never steps inside the load; never mutates the source frame.
 * - First divergence → five-column report (tick, entityId, fieldPath,
 *   expected, actual) — the shape 18.5 adopts unchanged.
 * - Test-owned / memory-only; live match never calls this module.
 */

import { TICK_HZ } from "../shared/sim/game.ts";
import type { PlayerInput } from "../protocol/network.ts";
import type { PlayerManager } from "../players/PlayerManager.ts";
import {
  captureCheckpointState,
  type AuthoritativeCheckpoint,
  type CheckpointMatchState,
  type CheckpointPlayerState,
  type CheckpointRaidState,
  type CheckpointRngCursors,
} from "./authoritativeCheckpoint.ts";
import {
  CheckpointLoadError,
  loadCheckpointState,
  type CheckpointLoadInit,
  type LoadCheckpointOptions,
} from "./checkpointLoading.ts";
import type { RecordedInitialState } from "./recordedInitialState.ts";

/** Default horizon ≈ 2.5s at 60 Hz — covers open-door respawn (2s) + margin. */
export const DEFAULT_HORIZON_TICKS = Math.round(2.5 * TICK_HZ);

/**
 * Five-column divergence report (18.5 adopts this shape unchanged).
 * `entityId` is a player id, `"match"`, `"rng"`, or `"checkpoint"`.
 */
export type CheckpointDivergence = {
  readonly tick: number;
  readonly checkpointTick: number;
  /** Ticks since the checkpoint (`0` at T, `1` at T+1, …). */
  readonly horizonOffset: number;
  readonly entityId: string;
  readonly fieldPath: string;
  readonly expected: unknown;
  readonly actual: unknown;
};

export type QueuedPlayerInput = {
  readonly playerId: string;
  readonly input: PlayerInput;
};

export type ValidateCheckpointOptions = {
  readonly checkpointTick: number;
  /** How many ticks after T to compare (default {@link DEFAULT_HORIZON_TICKS}). */
  readonly horizonTicks?: number;
  readonly runtimeMatchId: string;
  readonly expectedInit: CheckpointLoadInit | RecordedInitialState;
  readonly expectedRuntimeMatchId?: string;
  /**
   * Inputs to queue on both legs immediately before `update(tick)`.
   * Missing keys → no arrivals that tick (5.2 repeat-on-missing / neutral).
   */
  readonly inputsByTick: ReadonlyMap<number, readonly QueuedPlayerInput[]>;
  /** Build the restored-leg manager (same map / seed policy as reference). */
  readonly createManager: () => PlayerManager;
  /**
   * Optional deterministic wall-clock for `update(tick, nowMs)`.
   * Defaults to `1_000 + tick * (1000 / TICK_HZ)`.
   */
  readonly nowMsForTick?: (tick: number) => number;
  /**
   * Optional identical ops on both legs before inputs/update (e.g. scripted
   * mid-horizon join/leave/equipment). Never used to inject bot AI.
   */
  readonly beforeTick?: (
    tick: number,
    legs: { reference: PlayerManager; restored: PlayerManager },
  ) => void;
};

export type ValidateCheckpointResult =
  | {
    readonly ok: true;
    readonly checkpointTick: number;
    readonly horizonEndTick: number;
  }
  | {
    readonly ok: false;
    readonly kind: "precondition";
    readonly reason: string;
  }
  | {
    readonly ok: false;
    readonly kind: "mismatch";
    readonly error: CheckpointLoadError;
  }
  | {
    readonly ok: false;
    readonly kind: "divergence";
    readonly report: CheckpointDivergence;
  };

function defaultNowMs(tick: number): number {
  return 1_000 + tick * (1000 / TICK_HZ);
}

/**
 * Bit-exact compare of every 9.1 content-table field via fresh captures.
 * Returns the first divergence, or null when equal.
 */
export function compareSimulationState(
  reference: PlayerManager,
  restored: PlayerManager,
  tick: number,
  runtimeMatchId: string,
  checkpointTick: number = tick,
): CheckpointDivergence | null {
  reference.drainAuthoritativeEvents();
  restored.drainAuthoritativeEvents();

  let refCp: AuthoritativeCheckpoint;
  let actCp: AuthoritativeCheckpoint;
  try {
    refCp = captureCheckpointState(reference, tick, runtimeMatchId);
    actCp = captureCheckpointState(restored, tick, runtimeMatchId);
  } catch (err) {
    return {
      tick,
      checkpointTick,
      horizonOffset: tick - checkpointTick,
      entityId: "checkpoint",
      fieldPath: "capture",
      expected: "captureCheckpointState ok",
      actual: err instanceof Error ? err.message : String(err),
    };
  }

  return compareCheckpoints(refCp, actCp, tick, checkpointTick);
}

/** Pure field walk over two frozen checkpoints (also used by calibration). */
export function compareCheckpoints(
  expected: AuthoritativeCheckpoint,
  actual: AuthoritativeCheckpoint,
  tick: number,
  checkpointTick: number = expected.tick,
): CheckpointDivergence | null {
  const base = {
    tick,
    checkpointTick,
    horizonOffset: tick - checkpointTick,
  };

  const fail = (
    entityId: string,
    fieldPath: string,
    exp: unknown,
    act: unknown,
  ): CheckpointDivergence => ({
    ...base,
    entityId,
    fieldPath,
    expected: exp,
    actual: act,
  });

  if (expected.schemaVersion !== actual.schemaVersion) {
    return fail(
      "checkpoint",
      "schemaVersion",
      expected.schemaVersion,
      actual.schemaVersion,
    );
  }
  if (expected.tick !== actual.tick) {
    return fail("checkpoint", "tick", expected.tick, actual.tick);
  }
  if (expected.runtimeMatchId !== actual.runtimeMatchId) {
    return fail(
      "checkpoint",
      "runtimeMatchId",
      expected.runtimeMatchId,
      actual.runtimeMatchId,
    );
  }
  if (
    expected.map.name !== actual.map.name ||
    expected.map.version !== actual.map.version
  ) {
    return fail("checkpoint", "map", expected.map, actual.map);
  }
  if (expected.matchSeed !== actual.matchSeed) {
    return fail("checkpoint", "matchSeed", expected.matchSeed, actual.matchSeed);
  }

  const rngDiv = compareRng(expected.rng, actual.rng, base);
  if (rngDiv) return rngDiv;

  const matchDiv = compareMatch(expected.match, actual.match, base);
  if (matchDiv) return matchDiv;

  if (expected.players.length !== actual.players.length) {
    return fail(
      "checkpoint",
      "players.length",
      expected.players.length,
      actual.players.length,
    );
  }

  const actualById = new Map(actual.players.map((p) => [p.id, p]));
  for (const exp of expected.players) {
    const act = actualById.get(exp.id);
    if (!act) {
      return fail(exp.id, "presence", true, false);
    }
    const playerDiv = comparePlayer(exp, act, base);
    if (playerDiv) return playerDiv;
  }
  for (const act of actual.players) {
    if (!expected.players.some((p) => p.id === act.id)) {
      return fail(act.id, "presence", false, true);
    }
  }

  if (expected.projectiles.length !== actual.projectiles.length) {
    return fail(
      "checkpoint",
      "projectiles.length",
      expected.projectiles.length,
      actual.projectiles.length,
    );
  }

  return null;
}

function compareRng(
  expected: CheckpointRngCursors,
  actual: CheckpointRngCursors,
  base: Pick<
    CheckpointDivergence,
    "tick" | "checkpointTick" | "horizonOffset"
  >,
): CheckpointDivergence | null {
  for (const key of [
    "damage",
    "spread",
    "spawn",
    "agents",
    "collisionSpawn",
  ] as const) {
    if (!Object.is(expected[key], actual[key])) {
      return {
        ...base,
        entityId: "rng",
        fieldPath: key,
        expected: expected[key],
        actual: actual[key],
      };
    }
  }
  return null;
}

function compareMatch(
  expected: CheckpointMatchState,
  actual: CheckpointMatchState,
  base: Pick<
    CheckpointDivergence,
    "tick" | "checkpointTick" | "horizonOffset"
  >,
): CheckpointDivergence | null {
  const keys: (keyof CheckpointMatchState)[] = [
    "matchOver",
    "inPrematch",
    "restartAtTick",
    "doorCycleOriginTick",
    "doorsPowerUpUntilTick",
    "raidDoorPolicy",
    "debugForceDoorsOpen",
    "matchEndTick",
    "matchDurationTicks",
  ];
  if (!Object.is(expected.scores.A, actual.scores.A)) {
    return {
      ...base,
      entityId: "match",
      fieldPath: "scores.A",
      expected: expected.scores.A,
      actual: actual.scores.A,
    };
  }
  if (!Object.is(expected.scores.B, actual.scores.B)) {
    return {
      ...base,
      entityId: "match",
      fieldPath: "scores.B",
      expected: expected.scores.B,
      actual: actual.scores.B,
    };
  }
  const raidDiv = compareRaidState(expected.raid, actual.raid, base);
  if (raidDiv) return raidDiv;
  for (const key of keys) {
    if (!Object.is(expected[key], actual[key])) {
      return {
        ...base,
        entityId: "match",
        fieldPath: key,
        expected: expected[key],
        actual: actual[key],
      };
    }
  }
  return null;
}

/** Structural compare — `raid` is a fresh object per capture, never `Object.is`-equal. */
function compareRaidState(
  expected: CheckpointRaidState,
  actual: CheckpointRaidState,
  base: Pick<
    CheckpointDivergence,
    "tick" | "checkpointTick" | "horizonOffset"
  >,
): CheckpointDivergence | null {
  if (expected.active !== actual.active) {
    return {
      ...base,
      entityId: "match",
      fieldPath: "raid.active",
      expected: expected.active,
      actual: actual.active,
    };
  }
  if (!expected.active || !actual.active) return null;
  const keys: (keyof typeof expected)[] = [
    "wave",
    "started",
    "ended",
    "expectedHumans",
    "failReason",
  ];
  for (const key of keys) {
    if (!Object.is(expected[key], actual[key])) {
      return {
        ...base,
        entityId: "match",
        fieldPath: `raid.${key}`,
        expected: expected[key],
        actual: actual[key],
      };
    }
  }
  return null;
}

function comparePlayer(
  expected: CheckpointPlayerState,
  actual: CheckpointPlayerState,
  base: Pick<
    CheckpointDivergence,
    "tick" | "checkpointTick" | "horizonOffset"
  >,
): CheckpointDivergence | null {
  const scalarKeys: (keyof CheckpointPlayerState)[] = [
    "team",
    "isBot",
    "isAgent",
    "x",
    "y",
    "z",
    "yaw",
    "pitch",
    "velocityX",
    "velocityY",
    "velocityZ",
    "onGround",
    "crouch",
    "sprintStamina",
    "slideRemaining",
    "slideDirX",
    "slideDirZ",
    "slideForceCrouch",
    "prevInputCrouch",
    "lastLandedAtTick",
    "health",
    "maxHealth",
    "alive",
    "spawnedAtTick",
    "diedAtTick",
    "enemyDoorSinceTick",
    "hitSlowStacks",
    "hitSlowEndsAtTick",
    "weaponId",
    "reloadEndsAtTick",
    "weaponSwitchEndsAtTick",
    "lastShotAtTick",
    "lastMeleeAtTick",
    "unlimitedAmmo",
    "abilityGlobalLockEndsAtTick",
    "abilityBarRegenEndsAtTick",
    "abilityDoorRegenEndsAtTick",
    "score",
    "kills",
    "deaths",
    "xp",
  ];

  for (const key of scalarKeys) {
    const exp = expected[key];
    const act = actual[key];
    if (typeof exp === "number" || typeof act === "number") {
      if (!Object.is(exp, act)) {
        return {
          ...base,
          entityId: expected.id,
          fieldPath: key,
          expected: exp,
          actual: act,
        };
      }
    } else if (exp !== act) {
      return {
        ...base,
        entityId: expected.id,
        fieldPath: key,
        expected: exp,
        actual: act,
      };
    }
  }

  // Shell-gun timers are omitted when null (pre-shotgun checkpoint shape).
  const optionalTickKeys = [
    "shellReloadNextAtTick",
    "pumpEndsAtTick",
  ] as const satisfies readonly (keyof CheckpointPlayerState)[];
  for (const key of optionalTickKeys) {
    const exp = expected[key] ?? null;
    const act = actual[key] ?? null;
    if (!Object.is(exp, act)) {
      return {
        ...base,
        entityId: expected.id,
        fieldPath: key,
        expected: exp,
        actual: act,
      };
    }
  }

  // Loadouts match per weaponId, not by slot count: a recording from before
  // the shotgun joined WEAPON_ORDER carries two slots, and those two must
  // still verify against a three-slot re-sim (no replay version bump).
  for (const e of expected.weaponLoadouts) {
    const a = actual.weaponLoadouts.find((s) => s.weaponId === e.weaponId);
    if (!a) {
      return {
        ...base,
        entityId: expected.id,
        fieldPath: `weaponLoadouts[${e.weaponId}]`,
        expected: e,
        actual: undefined,
      };
    }
    if (
      !Object.is(e.ammoInMag, a.ammoInMag) ||
      !Object.is(e.spareClips, a.spareClips) ||
      (e.chambered ?? true) !== (a.chambered ?? true)
    ) {
      return {
        ...base,
        entityId: expected.id,
        fieldPath: `weaponLoadouts[${e.weaponId}]`,
        expected: e,
        actual: a,
      };
    }
  }

  const jsonKeys: (keyof CheckpointPlayerState)[] = [
    "pausedReloadRemainingTicks",
    "abilityEndsAtTick",
    "abilityFxOrigin",
    "abilitySpent",
    "abilityNoSpendOnEnd",
    "equipment",
    "skillLoadout",
    "ownedAbilities",
    "poseHistory",
  ];
  for (const key of jsonKeys) {
    const exp = JSON.stringify(expected[key]);
    const act = JSON.stringify(actual[key]);
    if (exp !== act) {
      return {
        ...base,
        entityId: expected.id,
        fieldPath: key,
        expected: expected[key],
        actual: actual[key],
      };
    }
  }

  return null;
}

/**
 * Sufficiency runner: reference must already be at `checkpointTick`
 * (post-update, post-drain). Captures, loads into a fresh manager, then
 * steps both legs through the horizon with the same queued inputs.
 */
export function validateCheckpointAt(
  reference: PlayerManager,
  options: ValidateCheckpointOptions,
): ValidateCheckpointResult {
  const T = options.checkpointTick;
  const horizon = options.horizonTicks ?? DEFAULT_HORIZON_TICKS;
  const runtimeMatchId = options.runtimeMatchId;
  const nowMs = options.nowMsForTick ?? defaultNowMs;

  if (reference.tick !== T) {
    return {
      ok: false,
      kind: "precondition",
      reason:
        `reference.tick (${reference.tick}) !== checkpointTick (${T}) — capture must run post-update at T`,
    };
  }
  if (reference.peekAuthoritativeEvents().length > 0) {
    return {
      ok: false,
      kind: "precondition",
      reason:
        `drain buffer not empty at tick ${T} (${reference.peekAuthoritativeEvents().length} event(s))`,
    };
  }

  const checkpoint = captureCheckpointState(reference, T, runtimeMatchId);
  const checkpointCopy = structuredClone(checkpoint) as AuthoritativeCheckpoint;

  const restored = options.createManager();
  const loadOpts: LoadCheckpointOptions = {
    expectedInit: options.expectedInit,
    expectedRuntimeMatchId: options.expectedRuntimeMatchId,
  };

  try {
    loadCheckpointState(restored, checkpoint, loadOpts);
  } catch (err) {
    if (err instanceof CheckpointLoadError) {
      return { ok: false, kind: "mismatch", error: err };
    }
    throw err;
  }

  // Immediate post-load equality at T (no step).
  {
    const div = compareSimulationState(
      reference,
      restored,
      T,
      runtimeMatchId,
      T,
    );
    if (div) return { ok: false, kind: "divergence", report: div };
  }

  const horizonEnd = T + horizon;
  for (let tick = T + 1; tick <= horizonEnd; tick++) {
    options.beforeTick?.(tick, { reference, restored });

    const rows = options.inputsByTick.get(tick) ?? [];
    for (const row of rows) {
      reference.get(row.playerId)?.queueInput(row.input);
      restored.get(row.playerId)?.queueInput(row.input);
    }

    const tMs = nowMs(tick);
    reference.update(tick, tMs);
    restored.update(tick, tMs);
    reference.drainAuthoritativeEvents();
    restored.drainAuthoritativeEvents();

    const div = compareSimulationState(
      reference,
      restored,
      tick,
      runtimeMatchId,
      T,
    );
    if (div) return { ok: false, kind: "divergence", report: div };
  }

  // Source frame must remain frozen / untouched.
  const sourceDiv = compareCheckpoints(checkpointCopy, checkpoint, T, T);
  if (sourceDiv) {
    return {
      ok: false,
      kind: "divergence",
      report: {
        ...sourceDiv,
        entityId: "checkpoint",
        fieldPath: `source.${sourceDiv.fieldPath}`,
      },
    };
  }

  return {
    ok: true,
    checkpointTick: T,
    horizonEndTick: horizonEnd,
  };
}

/**
 * Calibration helper: load a scratch-mutated checkpoint copy and compare at T.
 * Used by injection tests — does not step the horizon.
 */
export function validateMutatedCheckpointAt(
  reference: PlayerManager,
  mutate: (cp: AuthoritativeCheckpoint) => AuthoritativeCheckpoint,
  options: Omit<ValidateCheckpointOptions, "inputsByTick" | "horizonTicks"> & {
    inputsByTick?: ValidateCheckpointOptions["inputsByTick"];
    horizonTicks?: number;
  },
): ValidateCheckpointResult {
  const T = options.checkpointTick;
  const runtimeMatchId = options.runtimeMatchId;

  if (reference.tick !== T) {
    return {
      ok: false,
      kind: "precondition",
      reason: `reference.tick (${reference.tick}) !== checkpointTick (${T})`,
    };
  }
  reference.drainAuthoritativeEvents();
  const original = captureCheckpointState(reference, T, runtimeMatchId);
  const mutated = mutate(
    structuredClone(original) as AuthoritativeCheckpoint,
  );

  const restored = options.createManager();
  try {
    loadCheckpointState(restored, mutated, {
      expectedInit: options.expectedInit,
      expectedRuntimeMatchId: options.expectedRuntimeMatchId,
    });
  } catch (err) {
    if (err instanceof CheckpointLoadError) {
      return { ok: false, kind: "mismatch", error: err };
    }
    throw err;
  }

  const horizon = options.horizonTicks ?? 1;
  const inputsByTick = options.inputsByTick ?? new Map();
  const nowMs = options.nowMsForTick ?? defaultNowMs;

  // Compare at T first (often enough to catch the omission).
  {
    const div = compareSimulationState(
      reference,
      restored,
      T,
      runtimeMatchId,
      T,
    );
    if (div) return { ok: false, kind: "divergence", report: div };
  }

  for (let tick = T + 1; tick <= T + horizon; tick++) {
    options.beforeTick?.(tick, { reference, restored });
    const rows = inputsByTick.get(tick) ?? [];
    for (const row of rows) {
      reference.get(row.playerId)?.queueInput(row.input);
      restored.get(row.playerId)?.queueInput(row.input);
    }
    const tMs = nowMs(tick);
    reference.update(tick, tMs);
    restored.update(tick, tMs);
    reference.drainAuthoritativeEvents();
    restored.drainAuthoritativeEvents();
    const div = compareSimulationState(
      reference,
      restored,
      tick,
      runtimeMatchId,
      T,
    );
    if (div) return { ok: false, kind: "divergence", report: div };
  }

  return {
    ok: true,
    checkpointTick: T,
    horizonEndTick: T + horizon,
  };
}
