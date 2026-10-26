/**
 * Bot input adapter (replay epic 5.4).
 *
 * Pure boundary: think `ReadyAction` (post-delay-release) + per-bot adapter
 * state → per-sim-tick normalized action (+ discrete intent constructors).
 * Think (`@doors/bot-engine`), BotManager lifecycle (churn/fill/agents), and
 * `PlayerManager` entry points stay where they are; `runApplyPipe` stays put.
 *
 * Guarantees (handoffs):
 * - **5.1** — held movement/look + shoot/reload/weapon/ability edges are
 *   field-for-field mappable to `CanonicalPlayerInput`; no canonical union
 *   packaging here.
 * - **5.2** — monotonic `sequence` per bot (including dead/idle rows); keeps
 *   today's delay-release + hold/interp contract without inventing missing/
 *   repeat/late queues.
 * - **8.3** — every bot-originated byte the server steps can be taken from
 *   {@link sampleTickAction} / discrete builders without re-running think.
 *   Idle/dead rows are think-emitted too (keys-only PR 5) — this module
 *   never synthesizes an input. Recorder also needs actually-invoked edges
 *   from the apply pipe (see DETERMINISTIC_BOT_BOUNDARY.md).
 *
 * Non-goals: think-step edits, interp-curve retune, apply-order / budget /
 * roster changes, canonical edge union, recorder/checkpoint/playback code.
 *
 * Intentionally avoids `PlayerManager` / `performance.now` / `Date.now` /
 * `Math.random` so Deno characterization tests stay clock-free.
 *
 * Melee-lunge gap: think builders never set `meleeLunge` today; the adapter
 * passes the field through (default false) and does not invent bot melee
 * lunge triggers.
 */

import {
  type PlayerInput,
  SNAPSHOT_EVERY_TICKS,
} from "../../protocol/network.ts";
import {
  LAG_COMP_INTERP_DEFAULT_MS,
  msToRewindTicks,
} from "../../combat/lagComp.ts";
import type { SkillId } from "../../shared/sim/skills.ts";
import type { BotApplyInterp } from "../types.ts";
import {
  beginApplyInterp,
  buildInterpolatedReadyAction,
  lookFromAction,
  type LookSample,
} from "./botInterp.ts";
import type { ReadyAction } from "./types.ts";

/** Re-export look sample for callers that only import the adapter. */
export type { LookSample as BotLookSample };

/** Mutable sequence owner — typically `ManagedBot.sequence`. */
export type BotSequenceState = {
  sequence: number;
};

/** Shoot aim snapshot matching apply-step `ShootPacket` aim fields. */
export type BotShootAimSnapshot = {
  yaw: number;
  pitch: number;
  clientTick: number;
  lastAppliedSnapshotTick?: number;
};

export type BotReloadIntent = { kind: "reload" };
export type BotWeaponSwitchIntent = { weapon: number };
export type BotAbilityIntent = { ability: SkillId };

/**
 * Result of sampling one sim tick after delay release.
 * `action === null` means empty-buffer hold — caller must not invent keys
 * or call the apply pipe.
 */
export type BotTickSampleResult = {
  action: ReadyAction | null;
  /** Updated interp state (new segment and/or combatEdgeDone). */
  applyInterp: BotApplyInterp | null;
  /**
   * Normalized curr action when a due slot started a new interp segment
   * this tick (for `lastMove` / `readyAction` bookkeeping). Null otherwise.
   */
  releasedCurr: ReadyAction | null;
};

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Normalize a think-built `PlayerInput`: strip placeholder sequence, enforce
 * finite yaw/pitch, re-assert crouch > sprint priority, pass meleeLunge
 * through (default false — think never sets it today).
 */
export function normalizeThinkInput(
  input: PlayerInput,
  lookFallback: LookSample = { yaw: 0, pitch: 0 },
): PlayerInput {
  const crouch = Boolean(input.crouch);
  const normalized: PlayerInput = {
    sequence: 0,
    forward: Boolean(input.forward),
    backward: Boolean(input.backward),
    left: Boolean(input.left),
    right: Boolean(input.right),
    jump: Boolean(input.jump),
    sprint: crouch ? false : Boolean(input.sprint),
    crouch,
    yaw: finiteOr(input.yaw, lookFallback.yaw),
    pitch: finiteOr(input.pitch, lookFallback.pitch),
  };
  if (input.meleeLunge === true) {
    normalized.meleeLunge = true;
  }
  return normalized;
}

/**
 * Normalize think look samples against the normalized final look: non-finite
 * values fall back to it, and the last sample is pinned to it. Undefined when
 * there are no samples or no input.
 */
function normalizeLookSamples(
  samples: readonly LookSample[] | undefined,
  input: PlayerInput | null,
): LookSample[] | undefined {
  if (!input || !samples || samples.length === 0) return undefined;
  const out: LookSample[] = [];
  for (let i = 0; i < samples.length - 1; i++) {
    const sample = samples[i]!;
    out.push({
      yaw: finiteOr(sample.yaw, input.yaw),
      pitch: finiteOr(sample.pitch, input.pitch),
    });
  }
  out.push({ yaw: input.yaw, pitch: input.pitch });
  return out;
}

/** Normalize a post-delay `ReadyAction` (input + look samples + combat edges). */
export function normalizeReadyAction(
  action: ReadyAction,
  lookFallback: LookSample = { yaw: 0, pitch: 0 },
): ReadyAction {
  const input = action.input
    ? normalizeThinkInput(action.input, lookFallback)
    : null;
  const lookSamples = normalizeLookSamples(action.lookSamples, input);
  return {
    input,
    ...(lookSamples === undefined ? {} : { lookSamples }),
    shoot: action.shoot,
    reload: action.reload,
    weapon: action.weapon,
    ability: action.ability,
    ...(action.observedTick === undefined
      ? {}
      : { observedTick: action.observedTick }),
  };
}

/** Monotonic sequence stamp — sole numbering source per bot. */
export function nextBotSequence(state: BotSequenceState): number {
  state.sequence += 1;
  return state.sequence;
}

/**
 * Stamp `bot.sequence` onto a normalized movement input for `handleInput`.
 * Used by `stampAndInput` so sequence ownership lives in this module.
 */
export function stampBotInput(
  state: BotSequenceState,
  input: PlayerInput,
): PlayerInput {
  return {
    ...input,
    sequence: nextBotSequence(state),
  };
}

/**
 * Drop held interp on spawn-respawn so a new life does not inherit WASD.
 * Returns null interp; caller still clears the delay queue.
 */
export function dropInterpOnSpawn(): null {
  return null;
}

/**
 * Sample the per-sim-tick action from a delay-released slot + interp state.
 *
 * - New due slot → normalize, begin interp from previous target (or body).
 * - Keys hold from curr; look plays curr's per-tick samples, else yaw
 *   shortest-path lerp / pitch linear lerp.
 * - Combat edges fire once per slot (`combatEdgeDone` marked after sample).
 * - No due slot and no interp → empty hold (`action: null`); never invents keys.
 */
export function sampleTickAction(opts: {
  simTick: number;
  /** Action from the released delay slot, or null when none due. */
  dueAction: ReadyAction | null;
  applyInterp: BotApplyInterp | null;
  selfLook: LookSample;
}): BotTickSampleResult {
  let applyInterp = opts.applyInterp;
  let releasedCurr: ReadyAction | null = null;

  if (opts.dueAction !== null) {
    const prevLook = applyInterp
      ? lookFromAction(applyInterp.curr, opts.selfLook)
      : opts.selfLook;
    const curr = normalizeReadyAction(opts.dueAction, prevLook);
    applyInterp = beginApplyInterp(prevLook, curr, opts.simTick);
    releasedCurr = curr;
  }

  if (!applyInterp) {
    return { action: null, applyInterp: null, releasedCurr };
  }

  const action = buildInterpolatedReadyAction(applyInterp, opts.simTick);
  // Edge-once: mark after first sample of this slot (matches prior caller).
  applyInterp.combatEdgeDone = true;

  return { action, applyInterp, releasedCurr };
}

/**
 * Lag-comp claims for a bot shot, shaped like a human client's.
 *
 * A human renders remote players at (last applied snapshot − interp delay) and
 * stamps that as `clientTick`. Bot think sees the exact world at
 * `observedTick` with no interp, so the equivalent claims are
 * `clientTick = observedTick` and the snapshot a client would have needed to
 * render that tick at the default interp delay. Both go through the same
 * server RTT window as humans (no pongs → unknown-RTT band), which clamps a
 * stale or over-long think buffer.
 */
export function botLagCompStamps(observedTick: number): {
  clientTick: number;
  lastAppliedSnapshotTick: number;
} {
  const tick = Math.max(0, Math.floor(observedTick));
  const renderSnap = tick + msToRewindTicks(LAG_COMP_INTERP_DEFAULT_MS);
  return {
    clientTick: tick,
    lastAppliedSnapshotTick: renderSnap - (renderSnap % SNAPSHOT_EVERY_TICKS),
  };
}

/**
 * Shoot aim from action input, falling back to self yaw/pitch when input
 * is null — matches apply-step `shoot` packet construction. Lag-comp stamps
 * come from {@link ReadyAction.observedTick} (falls back to the apply tick for
 * actions without one).
 */
export function buildShootAimSnapshot(
  action: ReadyAction,
  selfLook: LookSample,
  applyTick: number,
): BotShootAimSnapshot {
  const stamps = botLagCompStamps(action.observedTick ?? applyTick);
  const look = action.input
    ? {
      yaw: finiteOr(action.input.yaw, selfLook.yaw),
      pitch: finiteOr(action.input.pitch, selfLook.pitch),
    }
    : { yaw: selfLook.yaw, pitch: selfLook.pitch };
  return { ...look, ...stamps };
}

export function buildReloadIntent(): BotReloadIntent {
  return { kind: "reload" };
}

export function buildWeaponSwitchIntent(weapon: number): BotWeaponSwitchIntent {
  return { weapon };
}

export function buildAbilityIntent(ability: SkillId): BotAbilityIntent {
  return { ability };
}
