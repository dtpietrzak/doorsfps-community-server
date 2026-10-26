/**
 * Runtime-neutral vertical combat-look motor.
 *
 * Deno owns target selection, LOS, anatomical aim-point selection, and the
 * resulting base pitch. This motor owns the stateful layer on top: correlated
 * micro/track wander around that aim point.
 *
 * The old one-shot "swing arc" (a vertical detour during big horizontal
 * swings) is gone: the aim planner now moves pitch with a real motor and bows
 * the whole 2D stroke itself (`aimCurvature`), so an extra 10–34° vertical
 * excursion would be chased as a genuine aim target.
 */

import {
  clamp,
  clamp01,
  fastExpNegative,
  max,
  radians,
} from "../../../math/index.ts";

/** Correlation time for continuous pitch micro-noise (seconds). */
export const PITCH_MICRO_CORR_SEC = 0.15;
/** Decay time for continuous pitch tracking error (seconds). */
export const PITCH_TRACK_DECAY_SEC = 0.25;
/** Gameplay-oriented cap on combined pitch noise (rad, roughly 12 degrees). */
export const PITCH_NOISE_CAP_RAD = radians(12);

export const COMBAT_PITCH_MICRO_KEY = "combatPitchMicro" as const;
export const COMBAT_PITCH_TRACK_KEY = "combatPitchTrack" as const;

export type CombatPitchMotorState = {
  [COMBAT_PITCH_MICRO_KEY]?: number | undefined;
  [COMBAT_PITCH_TRACK_KEY]?: number | undefined;
};

export type CombatPitchMotorInput = Readonly<{
  targetId: string;
  /** Collision/target-aware anatomical pitch selected by the caller. */
  basePitch: number;
  /** Safe value when the motor produces a non-finite result. */
  fallbackPitch: number;
  deltaSeconds: number;
  microNoiseAmp: number;
  trackErrorAmp: number;
}>;

export type CombatPitchMotorResult = Readonly<{
  pitch: number;
  statePatch: CombatPitchMotorState;
}>;

function finiteNumber(value: number | undefined, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function unit01(rng: () => number): number {
  const value = rng();
  return Number.isFinite(value) ? clamp01(value) : 0.5;
}

/** Correlated continuous pitch wander, detached from server objects. */
export function stepPitchWander(
  state: CombatPitchMotorState,
  deltaSeconds: number,
  microNoiseAmp: number,
  trackErrorAmp: number,
  rng: () => number,
): { offset: number; micro: number; track: number } {
  const dt = Number.isFinite(deltaSeconds) && deltaSeconds > 0
    ? deltaSeconds
    : 0;
  const microAmp = max(0, microNoiseAmp);
  const trackAmp = max(0, trackErrorAmp);

  const rho = dt > 0 ? fastExpNegative(dt / PITCH_MICRO_CORR_SEC) : 1;
  let micro = finiteNumber(state[COMBAT_PITCH_MICRO_KEY]);
  if (microAmp > 0 && dt > 0) {
    const kick = (unit01(rng) * 2 - 1) * microAmp;
    micro = rho * micro + (1 - rho) * kick;
  } else if (dt > 0) {
    micro *= rho;
  }
  micro = clamp(micro, -PITCH_NOISE_CAP_RAD, PITCH_NOISE_CAP_RAD);

  let track = finiteNumber(state[COMBAT_PITCH_TRACK_KEY]);
  if (trackAmp > 0 && dt > 0) {
    const kick = (unit01(rng) * 2 - 1) * trackAmp;
    track = (track + kick) * fastExpNegative(dt / PITCH_TRACK_DECAY_SEC);
  } else if (dt > 0) {
    track *= fastExpNegative(dt / (PITCH_TRACK_DECAY_SEC * 0.5));
  }
  track = clamp(track, -PITCH_NOISE_CAP_RAD, PITCH_NOISE_CAP_RAD);

  return {
    offset: clamp(
      micro + track,
      -PITCH_NOISE_CAP_RAD,
      PITCH_NOISE_CAP_RAD,
    ),
    micro,
    track,
  };
}

/** Clear only the persistent state owned by this extracted motor. */
export function clearCombatPitchMotorState(): CombatPitchMotorState {
  return {
    [COMBAT_PITCH_MICRO_KEY]: undefined,
    [COMBAT_PITCH_TRACK_KEY]: undefined,
  };
}

/** Apply a returned patch without Object.entries/dynamic runtime helpers. */
export function applyCombatPitchMotorPatch(
  state: CombatPitchMotorState,
  patch: CombatPitchMotorState,
): void {
  const micro = patch[COMBAT_PITCH_MICRO_KEY];
  state[COMBAT_PITCH_MICRO_KEY] =
    typeof micro === "number" && Number.isFinite(micro) ? micro : Number.NaN;

  const track = patch[COMBAT_PITCH_TRACK_KEY];
  state[COMBAT_PITCH_TRACK_KEY] =
    typeof track === "number" && Number.isFinite(track) ? track : Number.NaN;
}

/** Advance one vertical wander frame without mutating caller state. */
export function stepCombatPitchMotor(
  state: CombatPitchMotorState,
  input: CombatPitchMotorInput,
  rng: () => number,
): CombatPitchMotorResult {
  const wander = stepPitchWander(
    state,
    input.deltaSeconds,
    input.microNoiseAmp,
    input.trackErrorAmp,
    rng,
  );
  const pitch = input.basePitch + wander.offset;
  return {
    pitch: Number.isFinite(pitch) ? pitch : input.fallbackPitch,
    statePatch: {
      [COMBAT_PITCH_MICRO_KEY]: wander.micro,
      [COMBAT_PITCH_TRACK_KEY]: wander.track,
    },
  };
}
