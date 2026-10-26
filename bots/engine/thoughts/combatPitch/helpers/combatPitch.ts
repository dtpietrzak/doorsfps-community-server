/**
 * Pure combat pitch step: head/torso aim preference from shoot skill +
 * wrist-like vertical arc on large horizontal aim swings + continuous
 * micro/track pitch wander while locked (yaw-humanize analogue for pitch).
 *
 * Wired after {@code targetEnemy} (which still writes torso-led lookPitch).
 * Click must use the same height latch so the shoot box matches the reticle.
 */

import type { Player } from "../../../players/Player.ts";
import type { MapCollision } from "../../../world/MapCollision.ts";
import {
  aimPointHead,
  aimPointOnPlayer,
  type CombatAimHeight,
  pickCombatAimPointPreferred,
} from "../../../helpers/combat.ts";
import {
  applyCombatLead,
  TARGET_ENEMY_LEAD_SEC,
  TARGET_ENEMY_STATE_KEY,
  type TargetEnemyState,
  type TargetEnemyVel,
} from "../../targetEnemy/helpers/targetEnemy.ts";
import { pitchToward } from "../../../helpers/nav.ts";
import { clamp01 as clampValue01 } from "../../../math/index.ts";
import {
  clearCombatPitchMotorState,
  type CombatPitchMotorInput,
  type CombatPitchMotorState,
  stepCombatPitchMotor,
} from "./motor.ts";

export {
  COMBAT_PITCH_MICRO_KEY,
  COMBAT_PITCH_TRACK_KEY,
  PITCH_MICRO_CORR_SEC,
  PITCH_NOISE_CAP_RAD,
  PITCH_TRACK_DECAY_SEC,
  stepPitchWander,
} from "./motor.ts";

/** Skill ≥ this always prefers head. */
export const HEAD_AIM_SKILL_ALWAYS = 0.9;
/** P(head) at shoot skill 0. */
export const HEAD_AIM_CHANCE_AT_ZERO = 0.05;

export const COMBAT_AIM_HEIGHT_FOR_ID_KEY = "combatAimHeightForId" as const;
export const COMBAT_AIM_HEIGHT_KEY = "combatAimHeight" as const;

export type CombatPitchState = CombatPitchMotorState & {
  [COMBAT_AIM_HEIGHT_FOR_ID_KEY]?: string;
  [COMBAT_AIM_HEIGHT_KEY]?: string;
};

export type StepCombatPitchInput = {
  self: Player;
  enemy: Player;
  collision: MapCollision;
  /** Horizontal combat look from targetEnemy (unchanged). */
  lookYaw: number;
  /** Fallback pitch if preferred aim is missing. */
  lookPitch: number;
  /**
   * Click miss-gate skill (0..1). Still used for swing-arc sloppiness.
   * Head vs torso uses {@link headAim} when set.
   */
  hitChance: number;
  /**
   * P(latch head) skill dial, split from hitChance. Omit → fall back to
   * hitChance so older callers / tests keep working.
   */
  headAim?: number;
  /**
   * Think span (seconds) for continuous pitch noise correlation.
   * Typical: {@code viewSimDelta * BOT_YAW_EASE_DT}. ≤0 freezes noise.
   */
  dtSec?: number;
  /** Combat lead horizon (seconds). 0 / omit → {@link TARGET_ENEMY_LEAD_SEC}. */
  leadSec?: number;
  /** Correlated micro-wander amplitude (rad). 0 disables. */
  microNoiseAmp?: number;
  /** Tracking-error kick scale (rad). 0 disables. */
  trackErrorAmp?: number;
  state: CombatPitchState & TargetEnemyState;
  rng: () => number;
};

export type StepCombatPitchResult = {
  lookPitch: number;
  aimHeight: CombatAimHeight;
  statePatch: CombatPitchState;
  /** Plain extracted-motor input eligible for persistent compiled execution. */
  motorInput: CombatPitchMotorInput;
};

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return clampValue01(v);
}

function unit01(rng: () => number): number {
  const u = rng();
  return Number.isFinite(u) ? clamp01(u) : 0.5;
}

/**
 * P(prefer head) from shoot skill.
 * skill ≥ 0.9 → always head; skill 0 → 5% head; linear in between.
 */
export function headAimChance(skill: number): number {
  const s = clamp01(skill);
  if (s >= HEAD_AIM_SKILL_ALWAYS) return 1;
  return HEAD_AIM_CHANCE_AT_ZERO +
    (1 - HEAD_AIM_CHANCE_AT_ZERO) * (s / HEAD_AIM_SKILL_ALWAYS);
}

/** Roll sticky aim height for a new combat lock. */
export function rollAimHeight(
  hitChance: number,
  rng: () => number,
): CombatAimHeight {
  const p = headAimChance(hitChance);
  if (p >= 1) return "head";
  if (p <= 0) return "torso";
  return unit01(rng) < p ? "head" : "torso";
}

/** Sticky velocity from the targetEnemy bag (same as click lead). */
export function stickyVelFromState(
  state: TargetEnemyState,
  enemyId: string,
): TargetEnemyVel {
  const sticky = state[TARGET_ENEMY_STATE_KEY];
  if (typeof sticky !== "string" || sticky !== enemyId) {
    return { vx: 0, vy: 0, vz: 0 };
  }
  const vx = typeof state.targetEnemyVx === "number" &&
      Number.isFinite(state.targetEnemyVx)
    ? state.targetEnemyVx
    : 0;
  const vy = typeof state.targetEnemyVy === "number" &&
      Number.isFinite(state.targetEnemyVy)
    ? state.targetEnemyVy
    : 0;
  const vz = typeof state.targetEnemyVz === "number" &&
      Number.isFinite(state.targetEnemyVz)
    ? state.targetEnemyVz
    : 0;
  return { vx, vy, vz };
}

/**
 * Eye → preferred height (led) pitch. Falls back to unled torso/head points
 * then to {@code fallbackPitch} if LOS is fully blocked.
 */
export function basePitchForHeight(
  self: Player,
  enemy: Player,
  collision: MapCollision,
  height: CombatAimHeight,
  vel: TargetEnemyVel,
  fallbackPitch: number,
  leadSec: number = TARGET_ENEMY_LEAD_SEC,
): number {
  const eye = { x: self.x, y: self.y, z: self.z };
  let aim = pickCombatAimPointPreferred(collision, eye, enemy, height);
  if (!aim) {
    // LOS edge cases: still bias pitch toward the preferred anatomical point.
    aim = height === "head" ? aimPointHead(enemy) : aimPointOnPlayer(enemy);
  }
  const led = applyCombatLead(eye, aim, vel, leadSec, collision);
  const p = pitchToward(eye.x, eye.y, eye.z, led.x, led.y, led.z);
  return Number.isFinite(p) ? p : fallbackPitch;
}

/** Clear all combatPitch latches (unlock / death). */
export function clearCombatPitchState(): CombatPitchState {
  const motor = clearCombatPitchMotorState();
  return {
    combatPitchMicro: motor.combatPitchMicro,
    combatPitchTrack: motor.combatPitchTrack,
    [COMBAT_AIM_HEIGHT_FOR_ID_KEY]: "",
    [COMBAT_AIM_HEIGHT_KEY]: "",
  };
}

/**
 * Advance combat pitch for one think: sticky head/torso + optional swing arc
 * + continuous micro/track wander. Mutates nothing; returns lookPitch + bag
 * patch (undefined keys delete).
 */
export function stepCombatPitch(
  input: StepCombatPitchInput,
): StepCombatPitchResult {
  const {
    self,
    enemy,
    collision,
    lookPitch,
    hitChance,
    state,
    rng,
  } = input;
  const enemyId = enemy.id;
  const heightSkill = typeof input.headAim === "number" &&
      Number.isFinite(input.headAim)
    ? input.headAim
    : hitChance;

  // ── Sticky aim height ──
  let height: CombatAimHeight;
  const latchedFor = state[COMBAT_AIM_HEIGHT_FOR_ID_KEY];
  const latchedHeight = state[COMBAT_AIM_HEIGHT_KEY];
  if (
    latchedFor === enemyId &&
    (latchedHeight === "head" || latchedHeight === "torso")
  ) {
    height = latchedHeight;
  } else {
    height = rollAimHeight(heightSkill, rng);
  }

  const vel = stickyVelFromState(state, enemyId);
  const basePitch = basePitchForHeight(
    self,
    enemy,
    collision,
    height,
    vel,
    lookPitch,
    input.leadSec ?? TARGET_ENEMY_LEAD_SEC,
  );

  const motorInput: CombatPitchMotorInput = {
    targetId: enemyId,
    basePitch,
    fallbackPitch: lookPitch,
    deltaSeconds: input.dtSec ?? 0,
    microNoiseAmp: input.microNoiseAmp ?? 0,
    trackErrorAmp: input.trackErrorAmp ?? 0,
  };
  const motor = stepCombatPitchMotor(state, motorInput, rng);

  const patch: CombatPitchState = {
    combatPitchMicro: motor.statePatch.combatPitchMicro,
    combatPitchTrack: motor.statePatch.combatPitchTrack,
    [COMBAT_AIM_HEIGHT_FOR_ID_KEY]: enemyId,
    [COMBAT_AIM_HEIGHT_KEY]: height,
  };

  return {
    lookPitch: motor.pitch,
    aimHeight: height,
    statePatch: patch,
    motorInput,
  };
}
