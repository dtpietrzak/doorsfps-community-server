/**
 * Instant look for the built-in brain.
 *
 * Public configs set the aim-planner knobs to zero. The private motor's
 * zero-knob branch ramps from the previous servo pose to the aim target,
 * one sample per sim tick, and still rolls look-reaction RNG when the
 * combat target changes. This step matches that branch. It does not plan
 * Fitts strokes, overshoot, or aim noise.
 */
import { abs, clamp, clamp01, max, round } from "../math/index.ts";
import type { BotBrainState, BotLookSample } from "../types.ts";
import { viewSimDelta } from "../types.ts";
import { TICK_HZ } from "../shared/network.ts";
import { yawSignedDelta } from "./helpers/yawEase.ts";
import type { ReadyAction, StepResult, ThinkContext } from "../pipeline/types.ts";

export function plannedLookYaw(state: BotBrainState, fallback: number): number {
  const servo = state.yawHumanizeServoYaw;
  if (typeof servo !== "number" || !Number.isFinite(servo)) return fallback;
  const noise = state.yawHumanizeNoiseOut;
  const extra = typeof noise === "number" && Number.isFinite(noise) ? noise : 0;
  return servo + extra;
}

export function plannedLookPitch(state: BotBrainState, fallback: number): number {
  const pitch = state.lookPlanPitch;
  return typeof pitch === "number" && Number.isFinite(pitch) ? pitch : fallback;
}

/** Drop the per-life look chain. Next period starts from the live body. */
export function resetPublicLookLife(state: BotBrainState): void {
  state.yawHumanizeLastDesired = Number.NaN;
  state.yawHumanizeServoYaw = Number.NaN;
  state.lookPlanPitch = Number.NaN;
  state.yawHumanizeNoiseOut = Number.NaN;
  state.lookReactionForEnemyId = "";
  state.lookReactionReadyAtTick = Number.NaN;
  state.lookOvershootPending = false;
  state.yawHumanizeSpawnedAtTick = Number.NaN;
}

function beginPublicLookLife(state: BotBrainState, spawnedAtTick: number): void {
  if (state.yawHumanizeSpawnedAtTick === spawnedAtTick) return;
  resetPublicLookLife(state);
  state.yawHumanizeSpawnedAtTick = spawnedAtTick;
}

function packLook(
  prior: ReadyAction,
  input: NonNullable<ReadyAction["input"]>,
  yawSamples: readonly number[],
  pitchSamples: readonly number[],
): StepResult<ReadyAction> {
  const count = yawSamples.length;
  const yaw = yawSamples[count - 1]!;
  const pitch = pitchSamples[count - 1]!;
  let ready: ReadyAction;
  if (count > 1) {
    const samples: BotLookSample[] = [];
    for (let k = 0; k < count; k += 1) {
      samples.push({ yaw: yawSamples[k]!, pitch: pitchSamples[k]! });
    }
    ready = {
      ...prior,
      input: { ...input, yaw, pitch },
      lookSamples: samples,
    };
  } else {
    ready = { ...prior, input: { ...input, yaw, pitch } };
  }
  delete ready.compiledPitchInput;
  return { out: ready };
}

export function runPublicLookStep(
  ctx: ThinkContext,
  prior: ReadyAction,
  draftState: BotBrainState,
  lookReactionBaseMs: number,
  lookReactionVarianceMs: number,
  rng: () => number,
): StepResult<ReadyAction> {
  const me = ctx.view.self;
  beginPublicLookLife(draftState, me.spawnedAtTick);
  const input = prior.input;
  if (!input) return { out: prior };

  const combatIdRaw = draftState.targetEnemyId;
  const combatId = typeof combatIdRaw === "string" && combatIdRaw.length > 0
    ? combatIdRaw
    : null;
  const combatLocked = combatId !== null;
  const simDelta = viewSimDelta(ctx.view);
  const substeps = max(1, round(simDelta));
  // Instant branch continues from the servo, not servo-plus-noise.
  const servo = draftState.yawHumanizeServoYaw;
  const chainYaw = typeof servo === "number" && Number.isFinite(servo)
    ? servo
    : me.yaw;
  const fromPitch = plannedLookPitch(draftState, me.pitch);

  if (combatLocked) {
    if (draftState.lookReactionForEnemyId !== combatId) {
      draftState.lookReactionForEnemyId = combatId;
      const u = rng();
      const t = Number.isFinite(u) ? clamp01(u) : 0.5;
      const delayMs = lookReactionBaseMs + t * lookReactionVarianceMs;
      const delayTicks = max(0, round((delayMs / 1000) * TICK_HZ));
      draftState.lookReactionReadyAtTick = ctx.view.tick + delayTicks;
    }
    const readyAt = draftState.lookReactionReadyAtTick;
    if (
      typeof readyAt === "number" &&
      Number.isFinite(readyAt) &&
      ctx.view.tick < readyAt
    ) {
      const heldYaw = plannedLookYaw(draftState, me.yaw);
      draftState.yawHumanizeLastDesired = Number.NaN;
      draftState.yawHumanizeServoYaw = heldYaw;
      draftState.lookPlanPitch = fromPitch;
      draftState.yawHumanizeNoiseOut = 0;
      const yawSamples: number[] = [];
      const pitchSamples: number[] = [];
      for (let k = 0; k < substeps; k += 1) {
        yawSamples.push(heldYaw);
        pitchSamples.push(fromPitch);
      }
      return packLook(prior, input, yawSamples, pitchSamples);
    }
  } else {
    draftState.lookReactionForEnemyId = "";
    draftState.lookReactionReadyAtTick = Number.NaN;
    draftState.lookOvershootPending = false;
  }

  const targetYaw = input.yaw;
  const targetPitch = input.pitch;
  draftState.yawHumanizeLastDesired = targetYaw;
  const deltaYaw = yawSignedDelta(chainYaw, targetYaw);
  const deltaPitch = targetPitch - fromPitch;
  const combatDelayMs = typeof ctx.view.combatDelayMs === "number" &&
      Number.isFinite(ctx.view.combatDelayMs) && ctx.view.combatDelayMs > 0
    ? ctx.view.combatDelayMs
    : 0;
  // When dynamic arena combat slowdown is active on a built-in ("bot") bot,
  // cap combat turn rate so aim speed slows down smoothly instead of snapping.
  const slewCapped = combatLocked && combatDelayMs > 0;
  const maxTurnRadPerSubstep = slewCapped
    ? clamp(10 / (1 + combatDelayMs * (1 / 300)), 2.0, 10.0) / TICK_HZ
    : Number.POSITIVE_INFINITY;
  const yawSamples: number[] = [];
  const pitchSamples: number[] = [];
  let curYaw = chainYaw;
  let curPitch = fromPitch;
  for (let k = 0; k < substeps; k += 1) {
    const last = k + 1 >= substeps;
    if (slewCapped) {
      const remYaw = yawSignedDelta(curYaw, targetYaw);
      const stepYaw = abs(remYaw) <= maxTurnRadPerSubstep
        ? remYaw
        : (remYaw >= 0 ? maxTurnRadPerSubstep : -maxTurnRadPerSubstep);
      const remPitch = targetPitch - curPitch;
      const stepPitch = abs(remPitch) <= maxTurnRadPerSubstep
        ? remPitch
        : (remPitch >= 0 ? maxTurnRadPerSubstep : -maxTurnRadPerSubstep);
      curYaw += stepYaw;
      curPitch += stepPitch;
      yawSamples.push(curYaw);
      pitchSamples.push(curPitch);
    } else {
      const f = (k + 1) / substeps;
      curYaw = last ? targetYaw : chainYaw + deltaYaw * f;
      curPitch = last ? targetPitch : fromPitch + deltaPitch * f;
      yawSamples.push(curYaw);
      pitchSamples.push(curPitch);
    }
  }
  draftState.yawHumanizeServoYaw = curYaw;
  draftState.lookPlanPitch = curPitch;
  draftState.yawHumanizeNoiseOut = 0;
  return packLook(prior, input, yawSamples, pitchSamples);
}
