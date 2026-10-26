/**
 * Pure target-enemy step for bots (think-pipe after floatWallDuck).
 *
 * When a hostile is inside the player facing FOV with clear LOS, lock look yaw
 * onto them. World-space movement intent (path `moveYaw`, or vault/duck wish)
 * is preserved under the new look by **PWM-remapping** WASD — not bulky
 * octant snaps. Back hemisphere prefers strafe / partial reverse over pure S;
 * high doorAggression + door-progress folds to the forward hemisphere (no
 * moonwalk). Humans get intermediate headings by tapping A/D (or W/S); bots
 * do the same with a min tap dwell of {@link TARGET_ENEMY_MIN_TAP_MS}.
 *
 * **Stand-ground personality:** on each new lock, roll against
 * {@link StepTargetEnemyInput.standGroundChance} (per-bot, not a process
 * constant). On miss, keep PWM path / door-chase keys under combat look.
 * On hit, cancel path intent and run **stand-ground ADAD**: short A/D bursts
 * with random stand-still pauses from
 * {@link StepTargetEnemyInput.strafeAvgMs} /
 * {@link StepTargetEnemyInput.strafePauseAvgMs} /
 * {@link StepTargetEnemyInput.strafeVariation}. At each hold boundary the bot
 * may pause, chain another side, or **exit** ADAD and plant for the rest of
 * the lock (stand-ground stays sticky; no door-chase resume). Side picks
 * soft-flip (not a perfect LRLR square wave). During a lateral hold, a light
 * secondary W or S may PWM in at lower duty so motion is not pure A/D rails.
 * All timing zeros ⇒ classic plant-and-shoot (same as old stand-still).
 *
 * Sticky: once acquired, keep the same enemy id while they remain valid
 * (alive, hostile, LOS, still inside a **wider** hold FOV). Unlock when the
 * bot is **closer to the enemy door** than to the locked foe — path focus
 * returns to the door. Aim only (yaw + pitch) + keys — shooting is the
 * separate {@code click} step after yawHumanize.
 *
 * **Aim lead:** after the lock is warm (second+ think on the same id), look
 * tracks a straight-line guess of the enemy’s future position from an EMA
 * of XZ samples (τ {@link TARGET_ENEMY_LEAD_EMA_TAU_SEC}) + vertical
 * velocity, over {@link StepTargetEnemyInput.leadSec} (default
 * {@link TARGET_ENEMY_LEAD_SEC} = think→apply buffer lag). Predicted
 * points with no LOS fall back to the live body. Acquire / hold FOV + LOS
 * still use the live body; only combat look (and click’s preferred-lock
 * box) use the lead.
 *
 * **minSeparation:** when the locked foe is closer than this horizontal
 * distance, cancel W and hold S (ADAD kept) until past the range + slack.
 * Stops face-hug / point-blank yaw freeze after playerClip.
 */

import {
  MAX_HEALTH,
  SPRINT_SPEED_MULT,
  WALK_SPEED,
} from "../../../../../shared/sim/game.ts";
import { TICK_HZ } from "../../../shared/network.ts";
import { YAW_PLAYER_FOV_HALF_ANGLE } from "../../../../../shared/world/wallCorners.ts";
import {
  wishMoveYaw,
  yawInHalfAngle,
  yawPoleSignedDelta,
} from "../../../../../shared/world/yawPole.ts";
import { BOT_TICK_HZ, THINK_BUFFER_BOT_TICKS } from "../../../types.ts";
import type { Player } from "../../../players/Player.ts";
import type { MapCollision } from "../../../world/MapCollision.ts";
import {
  aimPointOnPlayer,
  areHostile,
  type CombatAimHeight,
  hasLineOfSight,
  isHiddenByGlitch,
  pickCombatAimPoint,
  pickCombatAimPointPreferred,
} from "../../../helpers/combat.ts";
import {
  enemyDoorTarget,
  pitchToward,
  yawToward,
} from "../../../helpers/nav.ts";
import {
  abs,
  ceil,
  clamp,
  clamp01,
  decayAlpha,
  distance2,
  distanceSquared2,
  fastSinCos,
  fastTan,
  HALF_PI,
  max,
  min,
  PI,
  QUARTER_PI,
  refinedAtan2,
  round,
  SQRT2,
  TWO_PI,
} from "../../../math/index.ts";

/** Brain-state key for sticky combat lock. */
export const TARGET_ENEMY_STATE_KEY = "targetEnemyId" as const;

/** Min key press / release dwell for combat WASD PWM (human-plausible tap). */
export const TARGET_ENEMY_MIN_TAP_MS = 100;

/** Bot-tick dwell matching {@link TARGET_ENEMY_MIN_TAP_MS} at {@link BOT_TICK_HZ}. */
export const TARGET_ENEMY_MIN_TAP_BOT_TICKS = max(
  1,
  ceil((TARGET_ENEMY_MIN_TAP_MS * BOT_TICK_HZ) / 1000),
);

/**
 * How far ahead (seconds) sticky combat look extrapolates enemy motion.
 * Matches think→apply buffer lag so hitscan arrives near the body — not
 * projectile ballistics.
 */
export const TARGET_ENEMY_LEAD_SEC = THINK_BUFFER_BOT_TICKS / BOT_TICK_HZ;

/** EMA time-constant for lock velocity (seconds). Kills ADAD whip-saw. */
export const TARGET_ENEMY_LEAD_EMA_TAU_SEC = 0.12;

/** Sticky lock score bonus so we do not thrash on near-ties. */
export const TARGET_THREAT_STICKY_BONUS = 10;

/** Threat bonus when the foe shot within this many sim ticks. */
export const TARGET_THREAT_SHOOTING_TICKS = round(TICK_HZ * 0.5);

/** Max HP-wound term on the threat score. */
export const TARGET_THREAT_WOUND_WEIGHT = 8;

/** Extra range to keep backing after crossing {@link StepTargetEnemyInput.minSeparation}. */
export const MIN_SEPARATION_HYSTERESIS = 0.25;

/**
 * Cap on estimated horizontal speed used for lead (u/s). Slightly above
 * sprint so genuine movers track; one-tick teleports clamp instead of whip.
 */
export const TARGET_ENEMY_LEAD_MAX_SPEED = WALK_SPEED * SPRINT_SPEED_MULT *
  1.25;

/** Bot-think dt for sticky sample → velocity (targetEnemy runs every bot tick). */
export const TARGET_ENEMY_SAMPLE_DT_SEC = 1 / BOT_TICK_HZ;

/**
 * Hold FOV is wider than acquire so look-ease lag / edge strafe does not thrash
 * the sticky lock (acquire still uses {@link YAW_PLAYER_FOV_HALF_ANGLE}).
 */
export const TARGET_ENEMY_HOLD_FOV_HALF_ANGLE = YAW_PLAYER_FOV_HALF_ANGLE * 1.5;

/** Near-axis dead zone (rad): pure cardinal, no secondary PWM. ~2.3°. */
export const TARGET_ENEMY_PWM_AXIS_EPS = 0.04;

/** Clamp micro-duties so min-dwell does not thrash for near-zero demand. */
export const TARGET_ENEMY_PWM_DUTY_EPS = 0.02;

/**
 * Max secondary-S duty when primary is strafe near reverse (φ ≤ π/4).
 * Caps partial reverse so combat never prioritizes pure moonwalk S.
 */
export const TARGET_ENEMY_BACK_S_DUTY_CAP = 0.55;

/**
 * Stand-ground: P(leave ADAD and plant for the rest of this lock) when a
 * hold expires. Not rolled on the opening strafe of a new lock.
 */
export const TARGET_STRAFE_EXIT_P = 0.18;

/**
 * Stand-ground: P(pause after a strafe hold) when not exiting. Remainder
 * chains another A/D hold so bursts are not a strict strafe/pause square wave.
 */
export const TARGET_STRAFE_PAUSE_P = 0.55;

/**
 * Fallback pause length band (ms) when {@link StepTargetEnemyInput.strafePauseAvgMs}
 * is 0 but a pause still rolled — zero pause avg no longer means infinite A-D.
 */
export const TARGET_STRAFE_PAUSE_DEFAULT_MS_MIN = 250;
export const TARGET_STRAFE_PAUSE_DEFAULT_MS_MAX = 700;

/** Extra pause duration scale so gaps are not a second metronome. */
export const TARGET_STRAFE_PAUSE_SCALE_MIN = 0.5;
export const TARGET_STRAFE_PAUSE_SCALE_MAX = 1.5;

/**
 * Stand-ground: P(switch A↔D) when rolling the next strafe side with a prior
 * direction. Below 1 so bots can double-tap the same side (not metronomic LRLR).
 */
export const TARGET_STRAFE_SIDE_FLIP_P = 0.72;

/**
 * Stand-ground: P(pure lateral, no W/S) when rolling depth for a strafe hold.
 * Remaining mass is split evenly between slight forward and slight back.
 */
export const TARGET_STRAFE_DEPTH_NONE_P = 0.2;

/**
 * Stand-ground: secondary W/S duty band while primary A/D is hard-on.
 * Kept below 0.5 so depth is slight relative to full lateral.
 */
export const TARGET_STRAFE_DEPTH_DUTY_MIN = 0.2;
export const TARGET_STRAFE_DEPTH_DUTY_MAX = 0.45;

/**
 * doorAggression at/above this suppresses combat S while world move
 * progresses toward the enemy door (forward-hemisphere keys only).
 */
export const DOOR_AGGRESSION_SUPPRESS_BACKWARD = 0.5;

export type MoveKeyName = "forward" | "backward" | "left" | "right";

/** Stand-ground ADAD phase while combat lock holds. */
export type TargetEnemyStrafePhase = "strafe" | "pause";

/** Slight W/S secondary while stand-ground primary A/D holds. */
export type TargetEnemyStrafeDepth = "forward" | "backward";

/** Opaque brain-state fields for sticky target lock + WASD PWM phase. */
export type TargetEnemyState = {
  [TARGET_ENEMY_STATE_KEY]?: string;
  /**
   * Sticky for this combat lock: true ⇒ stand-ground ADAD (or plant when
   * strafe avg is 0). Rolled once on acquire from
   * {@link StepTargetEnemyInput.standGroundChance}.
   */
  targetEnemyStandGround?: boolean;
  /** Active ADAD phase while stand-ground. */
  targetEnemyStrafePhase?: string;
  /** Bot ticks remaining in the current ADAD phase. */
  targetEnemyStrafeTicksLeft?: number;
  /** Current pure A/D direction during a strafe phase. */
  targetEnemyStrafeDir?: string;
  /**
   * Slight depth axis for the current strafe hold (PWM secondary).
   * Empty during pause / pure lateral / plant.
   */
  targetEnemyStrafeDepth?: string;
  /** Secondary W/S duty [0, 1] for the current strafe hold. */
  targetEnemyStrafeDepthDuty?: number;
  /**
   * Sticky: ADAD exited this lock — plant until unlock / new id.
   * Distinct from a timed pause so ticksLeft=0 cannot re-roll a hold.
   */
  targetEnemyStrafeStopped?: boolean;
  /** Sigma-delta error: positive ⇒ owe more secondary ON time. */
  targetEnemyPwmAcc?: number;
  /** Secondary key currently pressed. */
  targetEnemyPwmOn?: boolean;
  /** Bot ticks spent at the current secondary level. */
  targetEnemyPwmDwell?: number;
  /** Which secondary key the modulator is driving (pair-change detect). */
  targetEnemyPwmSec?: string;
  /**
   * Last observed lock-target XZ for velocity (updated every combat think).
   * Warm sticky uses sample → current Δ / {@link TARGET_ENEMY_SAMPLE_DT_SEC}.
   */
  targetEnemySampleX?: number;
  targetEnemySampleZ?: number;
  /**
   * Latest estimated lock velocity (u/s) after this think — for click aim-box
   * lead on the preferred id (same lead as combat look).
   */
  targetEnemyVx?: number;
  targetEnemyVz?: number;
  targetEnemyVy?: number;
  /**
   * Sticky: backing off a face-hug under {@link StepTargetEnemyInput.minSeparation}.
   * Hysteresis — stay backing until past minSeparation + slack.
   */
  targetEnemySeparating?: boolean;
};

/** Pre-step move keys (vault / duck) when recovering world move from WASD. */
export type TargetEnemyPriorKeys = {
  forward: boolean;
  backward?: boolean;
  left: boolean;
  right: boolean;
};

export type TargetEnemyCombat = {
  lookYaw: number;
  /**
   * Eye → aim pitch (torso-led here; combatPitch may re-aim head/torso + arc
   * so the ±1° shoot box can engage vertically).
   */
  lookPitch: number;
  enemyId: string;
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
};

export type TargetEnemyResult = {
  combat: TargetEnemyCombat | null;
  /** Merge into draft brain state (`undefined` deletes sticky id / PWM). */
  statePatch: TargetEnemyState;
};

/** Clear sticky combat lock + stand-ground ADAD + PWM + aim-lead samples. */
export function clearTargetEnemyState(
  state: TargetEnemyState,
): TargetEnemyState {
  state[TARGET_ENEMY_STATE_KEY] = "";
  state.targetEnemyStandGround = false;
  state.targetEnemyStrafePhase = "";
  state.targetEnemyStrafeTicksLeft = Number.NaN;
  state.targetEnemyStrafeDir = "";
  state.targetEnemyStrafeDepth = "";
  state.targetEnemyStrafeDepthDuty = Number.NaN;
  state.targetEnemyStrafeStopped = false;
  state.targetEnemyPwmAcc = Number.NaN;
  state.targetEnemyPwmOn = false;
  state.targetEnemyPwmDwell = Number.NaN;
  state.targetEnemyPwmSec = "";
  state.targetEnemySampleX = Number.NaN;
  state.targetEnemySampleZ = Number.NaN;
  state.targetEnemyVx = Number.NaN;
  state.targetEnemyVz = Number.NaN;
  state.targetEnemyVy = Number.NaN;
  state.targetEnemySeparating = false;
  return state;
}

export type TargetEnemyVel = {
  vx: number;
  vy: number;
  vz: number;
};

/**
 * Clamp a horizontal speed vector to {@link TARGET_ENEMY_LEAD_MAX_SPEED}.
 * Non-finite components → 0.
 */
export function clampLeadVelocity(vx: number, vz: number): {
  vx: number;
  vz: number;
} {
  let x = Number.isFinite(vx) ? vx : 0;
  let z = Number.isFinite(vz) ? vz : 0;
  const sp = distance2(x, z);
  if (sp > TARGET_ENEMY_LEAD_MAX_SPEED && sp > 1e-9) {
    const s = TARGET_ENEMY_LEAD_MAX_SPEED / sp;
    x *= s;
    z *= s;
  }
  return { vx: x, vz: z };
}

/**
 * Straight-line aim lead: `aim + v * leadSec`. Zero lead / zero speed is identity.
 */
export function extrapolateCombatAim(
  aim: { x: number; y: number; z: number },
  vel: TargetEnemyVel,
  leadSec: number = TARGET_ENEMY_LEAD_SEC,
): { x: number; y: number; z: number } {
  const t = Number.isFinite(leadSec) && leadSec > 0 ? leadSec : 0;
  if (!(t > 0)) {
    return { x: aim.x, y: aim.y, z: aim.z };
  }
  const vx = Number.isFinite(vel.vx) ? vel.vx : 0;
  const vy = Number.isFinite(vel.vy) ? vel.vy : 0;
  const vz = Number.isFinite(vel.vz) ? vel.vz : 0;
  return {
    x: aim.x + vx * t,
    y: aim.y + vy * t,
    z: aim.z + vz * t,
  };
}

/** EMA mix weight for one sample of duration `dtSec`. */
export function leadEmaAlpha(
  dtSec: number = TARGET_ENEMY_SAMPLE_DT_SEC,
  tauSec: number = TARGET_ENEMY_LEAD_EMA_TAU_SEC,
): number {
  const dt = Number.isFinite(dtSec) && dtSec > 0
    ? dtSec
    : TARGET_ENEMY_SAMPLE_DT_SEC;
  const tau = Number.isFinite(tauSec) && tauSec > 1e-6
    ? tauSec
    : TARGET_ENEMY_LEAD_EMA_TAU_SEC;
  return decayAlpha(dt, tau);
}

/**
 * Blend instant lock velocity into the previous EMA. Instant sample is
 * already speed-clamped by the caller.
 */
export function emaLeadVelocity(
  prevVx: number,
  prevVz: number,
  instVx: number,
  instVz: number,
  dtSec: number = TARGET_ENEMY_SAMPLE_DT_SEC,
): { vx: number; vz: number } {
  const a = leadEmaAlpha(dtSec);
  const px = Number.isFinite(prevVx) ? prevVx : 0;
  const pz = Number.isFinite(prevVz) ? prevVz : 0;
  const ix = Number.isFinite(instVx) ? instVx : 0;
  const iz = Number.isFinite(instVz) ? instVz : 0;
  return clampLeadVelocity(px + a * (ix - px), pz + a * (iz - pz));
}

/**
 * Lead `aim` by `vel * leadSec`, then reject the prediction when the
 * led point has no eye LOS (peek / cover). Zero lead is identity.
 */
export function applyCombatLead(
  eye: { x: number; y: number; z: number },
  aim: { x: number; y: number; z: number },
  vel: TargetEnemyVel,
  leadSec: number = TARGET_ENEMY_LEAD_SEC,
  collision?: MapCollision | null,
): { x: number; y: number; z: number } {
  const led = extrapolateCombatAim(aim, vel, leadSec);
  if (led.x === aim.x && led.y === aim.y && led.z === aim.z) return aim;
  if (collision && !hasLineOfSight(collision, eye, led)) return aim;
  return led;
}

/**
 * Estimate sticky-target velocity from last sample, then refresh sample to
 * current enemy pose. New lock / missing sample → zero vel + seed sample.
 */
export function estimateStickyTargetVelocity(
  state: TargetEnemyState,
  enemy: Player,
  isNewLock: boolean,
  dtSec: number = TARGET_ENEMY_SAMPLE_DT_SEC,
): { vel: TargetEnemyVel; samplePatch: TargetEnemyState } {
  const dt = Number.isFinite(dtSec) && dtSec > 1e-6
    ? dtSec
    : TARGET_ENEMY_SAMPLE_DT_SEC;
  const sampleX = state.targetEnemySampleX;
  const sampleZ = state.targetEnemySampleZ;
  const hasSample = typeof sampleX === "number" && Number.isFinite(sampleX) &&
    typeof sampleZ === "number" && Number.isFinite(sampleZ);

  let vx = 0;
  let vz = 0;
  if (!isNewLock && hasSample) {
    const inst = clampLeadVelocity(
      (enemy.x - sampleX) / dt,
      (enemy.z - sampleZ) / dt,
    );
    const prevVx = typeof state.targetEnemyVx === "number" &&
        Number.isFinite(state.targetEnemyVx)
      ? state.targetEnemyVx
      : 0;
    const prevVz = typeof state.targetEnemyVz === "number" &&
        Number.isFinite(state.targetEnemyVz)
      ? state.targetEnemyVz
      : 0;
    const ema = emaLeadVelocity(prevVx, prevVz, inst.vx, inst.vz, dt);
    vx = ema.vx;
    vz = ema.vz;
  }

  const vyRaw = enemy.velocityY;
  const vy = Number.isFinite(vyRaw) ? vyRaw : 0;

  return {
    vel: { vx, vy, vz },
    samplePatch: {
      targetEnemySampleX: enemy.x,
      targetEnemySampleZ: enemy.z,
      targetEnemyVx: vx,
      targetEnemyVz: vz,
      targetEnemyVy: vy,
    },
  };
}

/**
 * Combat look yaw/pitch toward current LOS aim, led by sticky velocity.
 * Falls back to unled `fallback` when LOS aim is missing (should be rare
 * after a successful pick).
 */
export function combatLookWithLead(
  self: Player,
  enemy: Player,
  collision: MapCollision,
  vel: TargetEnemyVel,
  fallback: { lookYaw: number; lookPitch: number },
  leadSec: number = TARGET_ENEMY_LEAD_SEC,
): { lookYaw: number; lookPitch: number } {
  const eye = { x: self.x, y: self.y, z: self.z };
  const aim = pickCombatAimPoint(collision, eye, enemy);
  if (!aim) return fallback;
  const led = applyCombatLead(eye, aim, vel, leadSec, collision);
  return {
    lookYaw: yawToward(eye.x, eye.z, led.x, led.z),
    lookPitch: pitchToward(eye.x, eye.y, eye.z, led.x, led.y, led.z),
  };
}

/**
 * Preferred-lock aim for click: same lead as combat look when velocity is on
 * the bag for the sticky id. Otherwise current LOS aim.
 * When {@code preferHeight} is set (from combatPitch latch), use that height
 * so the shoot box matches head/torso reticle preference.
 */
export function combatAimForClick(
  self: Player,
  enemy: Player,
  collision: MapCollision,
  state: TargetEnemyState | undefined,
  leadSec: number = TARGET_ENEMY_LEAD_SEC,
  preferHeight?: CombatAimHeight,
): { x: number; y: number; z: number } | null {
  const eye = { x: self.x, y: self.y, z: self.z };
  const aim = preferHeight
    ? pickCombatAimPointPreferred(collision, eye, enemy, preferHeight)
    : pickCombatAimPoint(collision, eye, enemy);
  if (!aim) return null;

  const sticky = state?.[TARGET_ENEMY_STATE_KEY];
  if (
    typeof sticky !== "string" ||
    sticky.length === 0 ||
    sticky !== enemy.id ||
    !state
  ) {
    return aim;
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
  if (vx === 0 && vy === 0 && vz === 0) return aim;
  return applyCombatLead(eye, aim, { vx, vy, vz }, leadSec, collision);
}

/**
 * Map personality {@code agentAggression} ∈ [0,1] to P(prefer agent hostiles
 * over non-agents on fresh acquire):
 *  0 → 0% agent-first, 0.5 → 100%, ≥0.5 stays 100% (`clamp01(agg / 0.5)`).
 */
export function agentFirstChanceFromAggression(
  agentAggression: number | undefined,
): number {
  if (
    typeof agentAggression !== "number" || !Number.isFinite(agentAggression)
  ) {
    return 0;
  }
  return clamp01(2 * agentAggression);
}

/** Wider acquire FOV half-angle while agent-hunting (default ×1.35). */
export const TARGET_ENEMY_HUNT_ACQUIRE_FOV_SCALE = 1.35;

/** Clamp a personality probability into [0, 1]; non-finite → 0. */
export function clampStandGroundChance(chance: number | undefined): number {
  if (typeof chance !== "number" || !Number.isFinite(chance)) return 0;
  if (chance <= 0) return 0;
  if (chance >= 1) return 1;
  return chance;
}

/** @deprecated Use {@link clampStandGroundChance}. */
export const clampStandStillChance = clampStandGroundChance;

/** Non-negative finite ms; non-finite / negative → 0. */
export function clampNonNegMs(ms: number | undefined): number {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return 0;
  return ms;
}

/** Clamp relative variation into [0, 1]; non-finite → 0. */
export function clampStrafeVariation(v: number | undefined): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v;
}

/**
 * Roll a phase duration in ms: `avg * (1 + (2u-1) * variation)`, floored at 0.
 */
export function rollTargetStrafeDurationMs(
  avgMs: number,
  variation: number,
  rng: () => number,
): number {
  const base = clampNonNegMs(avgMs);
  if (!(base > 0)) return 0;
  const var01 = clampStrafeVariation(variation);
  const uRaw = typeof rng === "function" ? rng() : 0.5;
  const u = Number.isFinite(uRaw) ? clamp01(uRaw) : 0.5;
  const ms = base * (1 + (2 * u - 1) * var01);
  return ms > 0 ? ms : 0;
}

/** Convert ms to bot ticks (at least 1 when ms &gt; 0). */
export function targetStrafeMsToTicks(ms: number): number {
  if (!(ms > 0) || !Number.isFinite(ms)) return 0;
  return max(1, ceil((ms * BOT_TICK_HZ) / 1000));
}

export type StandGroundStrafeInput = {
  strafeAvgMs: number;
  strafePauseAvgMs: number;
  strafeVariation: number;
  rng: () => number;
  /** Prior sticky phase state for this lock. */
  state: Pick<
    TargetEnemyState,
    | "targetEnemyStrafePhase"
    | "targetEnemyStrafeTicksLeft"
    | "targetEnemyStrafeDir"
    | "targetEnemyStrafeDepth"
    | "targetEnemyStrafeDepthDuty"
    | "targetEnemyStrafeStopped"
    | "targetEnemyPwmAcc"
    | "targetEnemyPwmOn"
    | "targetEnemyPwmDwell"
    | "targetEnemyPwmSec"
  >;
  /** True when this think just acquired a new lock id. */
  isNewLock: boolean;
};

export type StandGroundStrafeResult = {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  phase: TargetEnemyStrafePhase;
  ticksLeft: number;
  dir: "left" | "right" | undefined;
  depth: TargetEnemyStrafeDepth | undefined;
  depthDuty: number;
  /** True when ADAD has exited; plant until a new lock. */
  stopped: boolean;
  pwmPatch: TargetEnemyState;
};

/** Clamp rng() into [0, 1]; non-finite → 0.5. */
function rollUnit01(rng: () => number): number {
  const uRaw = typeof rng === "function" ? rng() : 0.5;
  return Number.isFinite(uRaw) ? clamp01(uRaw) : 0.5;
}

/**
 * Pick next stand-ground A/D side. First hold is 50/50; later holds soft-flip
 * ({@link TARGET_STRAFE_SIDE_FLIP_P}) so same-side double-taps remain possible.
 */
export function pickStandGroundStrafeSide(
  prior: "left" | "right" | undefined,
  rng: () => number,
): "left" | "right" {
  if (prior !== "left" && prior !== "right") {
    return rollUnit01(rng) < 0.5 ? "left" : "right";
  }
  if (rollUnit01(rng) < TARGET_STRAFE_SIDE_FLIP_P) {
    return prior === "left" ? "right" : "left";
  }
  return prior;
}

/**
 * Roll slight W/S secondary for one strafe hold (or none for pure lateral).
 * Duty stays below full lateral so depth is a function of hard A/D primary.
 */
export function rollStandGroundStrafeDepth(
  rng: () => number,
): { depth: TargetEnemyStrafeDepth | undefined; duty: number } {
  const u = rollUnit01(rng);
  if (u < TARGET_STRAFE_DEPTH_NONE_P) {
    return { depth: undefined, duty: 0 };
  }
  const half = (1 - TARGET_STRAFE_DEPTH_NONE_P) / 2;
  const depth: TargetEnemyStrafeDepth = u < TARGET_STRAFE_DEPTH_NONE_P + half
    ? "forward"
    : "backward";
  const t = rollUnit01(rng);
  const duty = TARGET_STRAFE_DEPTH_DUTY_MIN +
    t * (TARGET_STRAFE_DEPTH_DUTY_MAX - TARGET_STRAFE_DEPTH_DUTY_MIN);
  return { depth, duty };
}

/**
 * Advance stand-ground ADAD for one bot tick. Pure plant when avg strafe is 0.
 * Holds may pause, chain another side, or exit-to-plant for the rest of the lock.
 * Strafe holds soft-flip L/R and may PWM slight W/S under hard A/D.
 */
export function stepStandGroundStrafe(
  input: StandGroundStrafeInput,
): StandGroundStrafeResult {
  const avgStrafe = clampNonNegMs(input.strafeAvgMs);
  const avgPause = clampNonNegMs(input.strafePauseAvgMs);
  const variation = clampStrafeVariation(input.strafeVariation);
  const rng = input.rng;
  const idlePwm = (stopped: boolean): StandGroundStrafeResult => {
    const st = secondaryPwmFromState({});
    stepSecondaryPwm(st, null, 0);
    return {
      forward: false,
      backward: false,
      left: false,
      right: false,
      phase: "pause",
      ticksLeft: 0,
      dir: undefined,
      depth: undefined,
      depthDuty: 0,
      stopped,
      pwmPatch: secondaryPwmToPatch(st),
    };
  };

  // No strafe scheme → classic plant for the whole lock.
  if (!(avgStrafe > 0)) {
    return idlePwm(false);
  }

  if (!input.isNewLock && input.state.targetEnemyStrafeStopped) {
    return idlePwm(true);
  }

  const storedPhase = input.state.targetEnemyStrafePhase;
  let phase: TargetEnemyStrafePhase | undefined = input.isNewLock
    ? undefined
    : storedPhase === "strafe" || storedPhase === "pause"
    ? storedPhase
    : undefined;
  let ticksLeft = input.isNewLock
    ? 0
    : typeof input.state.targetEnemyStrafeTicksLeft === "number" &&
        Number.isFinite(input.state.targetEnemyStrafeTicksLeft)
    ? input.state.targetEnemyStrafeTicksLeft
    : 0;
  let dir: "left" | "right" | undefined = input.isNewLock
    ? undefined
    : input.state.targetEnemyStrafeDir === "left" ||
        input.state.targetEnemyStrafeDir === "right"
    ? input.state.targetEnemyStrafeDir
    : undefined;
  let depth: TargetEnemyStrafeDepth | undefined = input.isNewLock
    ? undefined
    : input.state.targetEnemyStrafeDepth === "forward" ||
        input.state.targetEnemyStrafeDepth === "backward"
    ? input.state.targetEnemyStrafeDepth
    : undefined;
  let depthDuty = input.isNewLock
    ? 0
    : typeof input.state.targetEnemyStrafeDepthDuty === "number" &&
        Number.isFinite(input.state.targetEnemyStrafeDepthDuty)
    ? clamp01(input.state.targetEnemyStrafeDepthDuty)
    : 0;
  const pwm = secondaryPwmFromState(input.isNewLock ? {} : input.state);

  // Consume one bot tick of the current phase when mid-hold.
  if (phase !== undefined && ticksLeft > 0) {
    ticksLeft -= 1;
  }

  if (phase === undefined || ticksLeft <= 0) {
    // Opening hold of a new lock is always strafe. Later boundaries may
    // pause, chain another side, or plant for the rest of the lock.
    if (phase === undefined) {
      phase = "strafe";
    } else {
      if (rollUnit01(rng) < TARGET_STRAFE_EXIT_P) {
        return idlePwm(true);
      }
      if (phase === "strafe") {
        phase = rollUnit01(rng) < TARGET_STRAFE_PAUSE_P ? "pause" : "strafe";
      } else {
        phase = "strafe";
      }
    }

    let baseMs = phase === "strafe" ? avgStrafe : avgPause;
    if (phase === "pause" && !(baseMs > 0)) {
      const t = rollUnit01(rng);
      baseMs = TARGET_STRAFE_PAUSE_DEFAULT_MS_MIN +
        t * (TARGET_STRAFE_PAUSE_DEFAULT_MS_MAX -
            TARGET_STRAFE_PAUSE_DEFAULT_MS_MIN);
    }
    let ms = rollTargetStrafeDurationMs(baseMs, variation, rng);
    if (phase === "pause") {
      const t = rollUnit01(rng);
      const scale = TARGET_STRAFE_PAUSE_SCALE_MIN +
        t * (TARGET_STRAFE_PAUSE_SCALE_MAX - TARGET_STRAFE_PAUSE_SCALE_MIN);
      ms *= scale;
    }
    // Always at least one bot tick so we cannot thrash phases every think.
    ticksLeft = max(1, targetStrafeMsToTicks(ms));

    if (phase === "strafe") {
      dir = pickStandGroundStrafeSide(dir, rng);
      const rolled = rollStandGroundStrafeDepth(rng);
      depth = rolled.depth;
      depthDuty = rolled.duty;
    } else {
      depth = undefined;
      depthDuty = 0;
    }
  }

  const left = phase === "strafe" && dir === "left";
  const right = phase === "strafe" && dir === "right";
  let forward = false;
  let backward = false;
  if (phase === "strafe" && depth !== undefined && depthDuty > 0) {
    const on = stepSecondaryPwm(pwm, depth, depthDuty);
    if (on) {
      if (depth === "forward") forward = true;
      else backward = true;
    }
  } else {
    stepSecondaryPwm(pwm, null, 0);
    depth = phase === "strafe" ? depth : undefined;
    if (phase !== "strafe") depthDuty = 0;
  }

  return {
    forward,
    backward,
    left,
    right,
    phase,
    ticksLeft,
    dir: phase === "strafe" ? dir : dir,
    depth: phase === "strafe" ? depth : undefined,
    depthDuty: phase === "strafe" ? depthDuty : 0,
    stopped: false,
    pwmPatch: secondaryPwmToPatch(pwm),
  };
}

/**
 * World-space move yaw implied by pre-step look + WASD.
 * Falls back to `fallbackMoveYaw` when keys produce no direction (idle).
 */
export function worldMoveYawFromPrior(
  lookYaw: number,
  keys: TargetEnemyPriorKeys,
  fallbackMoveYaw: number,
): number {
  const w = wishMoveYaw(lookYaw, {
    forward: keys.forward,
    backward: Boolean(keys.backward),
    left: keys.left,
    right: keys.right,
  });
  return typeof w === "number" && Number.isFinite(w) ? w : fallbackMoveYaw;
}

/**
 * True when enemy XZ bearing is inside the player facing FOV wedge.
 */
export function enemyInPlayerFov(
  selfX: number,
  selfZ: number,
  facingYaw: number,
  enemyX: number,
  enemyZ: number,
  halfAngle: number = YAW_PLAYER_FOV_HALF_ANGLE,
): boolean {
  const dx = enemyX - selfX;
  const dz = enemyZ - selfZ;
  if (!(distanceSquared2(dx, dz) > 1e-12)) return true; // stacked — treat as in FOV
  const bearing = yawToward(selfX, selfZ, enemyX, enemyZ);
  return yawInHalfAngle(bearing, facingYaw, halfAngle);
}

// ---------------------------------------------------------------------------
// Octant PWM planning (pure)
// ---------------------------------------------------------------------------

/**
 * Duty cycle for blending pure primary with primary+secondary diagonal so the
 * **time-averaged** wish (normalized each tick, like moveStep) sits at angle
 * `theta` from the primary axis, theta ∈ [0, π/4].
 *
 * Hold primary always; secondary ON fraction = d:
 *   tan(θ) = (d/√2) / (1 − d + d/√2)
 */
export function dutyForBlend0to45(theta: number): number {
  const t = clamp(theta, 0, QUARTER_PI);
  if (t <= 1e-9) return 0;
  if (t >= QUARTER_PI - 1e-9) return 1;
  const s = SQRT2;
  const tan = fastTan(t);
  return tan / (1 / s + tan * (1 - 1 / s));
}

/**
 * Duty of the **secondary toward primary** when primary is the strafe/cardinal
 * at 45…90° from the other axis. Hold the far axis always; PWM the near one.
 * theta ∈ [π/4, π/2] from pure forward (or pure back) toward pure strafe.
 *
 *   w = √2 / (tan(θ) − 1 + √2)   // fraction of time both keys held
 */
export function dutyForBlend45to90(theta: number): number {
  const t = clamp(theta, QUARTER_PI, HALF_PI);
  if (t <= QUARTER_PI + 1e-9) return 1;
  if (t >= HALF_PI - 1e-9) return 0;
  const s = SQRT2;
  const tan = fastTan(t);
  return s / (tan - 1 + s);
}

/** Predicted average wish angle [0, π/4] for duty d (primary always, secondary PWM). */
export function thetaFromDuty0to45(duty: number): number {
  const d = clamp01(duty);
  if (d <= 1e-9) return 0;
  if (d >= 1 - 1e-9) return QUARTER_PI;
  const s = SQRT2;
  const num = d / s;
  const den = 1 - d + d / s;
  return refinedAtan2(num, den);
}

export type OctantPwmPlan = {
  /** Keys held every tick (primary). */
  hard: Readonly<Record<MoveKeyName, boolean>>;
  /** Key that is pulse-width modulated; null when hard-only. */
  secondary: MoveKeyName | null;
  /** Target ON fraction for secondary in (0, 1); 0/1 means hard off/on. */
  duty: number;
};

function hardOnly(key: MoveKeyName): OctantPwmPlan {
  return {
    hard: {
      forward: key === "forward",
      backward: key === "backward",
      left: key === "left",
      right: key === "right",
    },
    secondary: null,
    duty: 0,
  };
}

function hardPlusSecondary(
  primary: MoveKeyName,
  secondary: MoveKeyName,
  duty: number,
): OctantPwmPlan {
  const d = clamp01(duty);
  if (d <= TARGET_ENEMY_PWM_DUTY_EPS) return hardOnly(primary);
  if (d >= 1 - TARGET_ENEMY_PWM_DUTY_EPS) {
    return {
      hard: {
        forward: primary === "forward" || secondary === "forward",
        backward: primary === "backward" || secondary === "backward",
        left: primary === "left" || secondary === "left",
        right: primary === "right" || secondary === "right",
      },
      secondary: null,
      duty: 0,
    };
  }
  return {
    hard: {
      forward: primary === "forward",
      backward: primary === "backward",
      left: primary === "left",
      right: primary === "right",
    },
    secondary,
    duty: d,
  };
}

/**
 * Map signed look→move yaw delta α onto a primary key + optional secondary PWM.
 * α = yawPoleSignedDelta(lookYaw, worldMoveYaw).
 *
 * Back hemisphere prefers **strafe / partial reverse** over pure S so combat
 * lock does not full-moonwalk when path is opposite look (see also door-run
 * {@link combatMoveKeysPwm} suppressBackward).
 */
export function planOctantPwm(alpha: number): OctantPwmPlan {
  let a = alpha;
  while (a > PI) a -= TWO_PI;
  while (a <= -PI) a += TWO_PI;

  const absAngle = abs(a);
  // Game yaw: +yaw turns left (−x when facing −z); −yaw turns right (+x).
  // At exactly ±π, a ≥ 0 after wrap → left (stable pure-reverse peel).
  const strafe: MoveKeyName = a >= 0 ? "left" : "right";

  // Pure forward.
  if (absAngle < TARGET_ENEMY_PWM_AXIS_EPS) return hardOnly("forward");
  // Pure reverse → pure strafe (never hard-only S).
  if (abs(absAngle - PI) < TARGET_ENEMY_PWM_AXIS_EPS) {
    return hardOnly(strafe);
  }

  if (absAngle <= HALF_PI) {
    // Forward hemisphere: 0 = W … π/2 = pure strafe.
    const theta = absAngle;
    if (theta <= QUARTER_PI) {
      return hardPlusSecondary("forward", strafe, dutyForBlend0to45(theta));
    }
    if (HALF_PI - theta < TARGET_ENEMY_PWM_AXIS_EPS) {
      return hardOnly(strafe);
    }
    return hardPlusSecondary(strafe, "forward", dutyForBlend45to90(theta));
  }

  // Back hemisphere: φ = π − |α| so 0 ≈ reverse, π/2 = pure strafe.
  // Prefer strafe primary + capped secondary S (partial reverse, not moonwalk).
  const phi = PI - absAngle;
  if (phi <= QUARTER_PI) {
    const duty = min(
      dutyForBlend0to45(phi),
      TARGET_ENEMY_BACK_S_DUTY_CAP,
    );
    return hardPlusSecondary(strafe, "backward", duty);
  }
  if (HALF_PI - phi < TARGET_ENEMY_PWM_AXIS_EPS) {
    return hardOnly(strafe);
  }
  return hardPlusSecondary(strafe, "backward", dutyForBlend45to90(phi));
}

/**
 * True when world move has any component toward `target` (open half-plane).
 * Same basis as lenient door-run sprint (no map required when target known).
 */
export function worldMoveProgressesToward(
  x: number,
  z: number,
  moveYaw: number,
  target: { x: number; z: number },
): boolean {
  if (!Number.isFinite(moveYaw) || !Number.isFinite(x) || !Number.isFinite(z)) {
    return false;
  }
  if (!Number.isFinite(target.x) || !Number.isFinite(target.z)) return false;
  const dx = target.x - x;
  const dz = target.z - z;
  const direction = fastSinCos(moveYaw);
  const fx = -direction.sin;
  const fz = -direction.cos;
  return fx * dx + fz * dz > 1e-6;
}

/** Fold signed α into [−π/2, π/2] so octant PWM never enters the back hemisphere. */
export function foldAlphaForwardHemisphere(alpha: number): number {
  let a = alpha;
  while (a > PI) a -= TWO_PI;
  while (a <= -PI) a += TWO_PI;
  if (a > HALF_PI) return HALF_PI;
  if (a < -HALF_PI) return -HALF_PI;
  return a;
}

// ---------------------------------------------------------------------------
// Sigma-delta modulator (min dwell)
// ---------------------------------------------------------------------------

export type SecondaryPwmScratch = {
  acc: number;
  on: boolean;
  dwell: number;
  sec: MoveKeyName | null;
};

export function secondaryPwmFromState(
  state: TargetEnemyState,
): SecondaryPwmScratch {
  return {
    acc: typeof state.targetEnemyPwmAcc === "number" &&
        Number.isFinite(state.targetEnemyPwmAcc)
      ? state.targetEnemyPwmAcc
      : 0,
    on: Boolean(state.targetEnemyPwmOn),
    dwell: typeof state.targetEnemyPwmDwell === "number" &&
        Number.isFinite(state.targetEnemyPwmDwell)
      ? state.targetEnemyPwmDwell
      : TARGET_ENEMY_MIN_TAP_BOT_TICKS,
    sec: state.targetEnemyPwmSec === "forward" ||
        state.targetEnemyPwmSec === "backward" ||
        state.targetEnemyPwmSec === "left" ||
        state.targetEnemyPwmSec === "right"
      ? state.targetEnemyPwmSec
      : null,
  };
}

export function secondaryPwmToPatch(st: SecondaryPwmScratch): {
  targetEnemyPwmAcc: number;
  targetEnemyPwmOn: boolean;
  targetEnemyPwmDwell: number;
  targetEnemyPwmSec: string;
} {
  return {
    targetEnemyPwmAcc: st.acc,
    targetEnemyPwmOn: st.on,
    targetEnemyPwmDwell: st.dwell,
    targetEnemyPwmSec: st.sec ?? "",
  };
}

/**
 * Advance secondary-key PWM one bot tick. Integrates duty vs actual ON so the
 * long-run ON fraction tracks `duty`, but never flips faster than `minDwell`
 * bot ticks (on **or** off).
 */
export function stepSecondaryPwm(
  st: SecondaryPwmScratch,
  secondary: MoveKeyName | null,
  duty: number,
  minDwell: number = TARGET_ENEMY_MIN_TAP_BOT_TICKS,
): boolean {
  const d = clamp01(duty);
  const minDwellTicks = max(1, minDwell | 0);

  if (secondary === null || d <= TARGET_ENEMY_PWM_DUTY_EPS) {
    st.acc = 0;
    st.on = false;
    st.dwell = minDwellTicks;
    st.sec = secondary;
    return false;
  }
  if (d >= 1 - TARGET_ENEMY_PWM_DUTY_EPS) {
    st.acc = 0;
    st.on = true;
    st.dwell = minDwellTicks;
    st.sec = secondary;
    return true;
  }

  if (st.sec !== secondary) {
    st.sec = secondary;
    st.acc = 0;
    st.on = false;
    st.dwell = minDwellTicks; // free to start the new pair immediately
  }

  // Error: positive ⇒ we have under-fired ON relative to duty.
  st.acc += d - (st.on ? 1 : 0);
  st.dwell += 1;

  if (st.dwell >= minDwellTicks) {
    if (!st.on && st.acc > 0) {
      st.on = true;
      st.dwell = 0;
    } else if (st.on && st.acc < 0) {
      st.on = false;
      st.dwell = 0;
    }
  }

  return st.on;
}

export type CombatMoveKeysPwmOpts = {
  minDwell?: number;
  /**
   * When true, fold look→move α into the forward hemisphere so the plan
   * never emits backward (door-run combat: strafe/fight, no moonwalk S).
   */
  suppressBackward?: boolean;
};

/**
 * Plan + one PWM step → boolean WASD under combat look for world move intent.
 */
export function combatMoveKeysPwm(
  lookYaw: number,
  worldMoveYaw: number,
  state: TargetEnemyState,
  minDwellOrOpts: number | CombatMoveKeysPwmOpts =
    TARGET_ENEMY_MIN_TAP_BOT_TICKS,
): {
  keys: {
    forward: boolean;
    backward: boolean;
    left: boolean;
    right: boolean;
  };
  pwmPatch: TargetEnemyState;
} {
  // Accept legacy minDwell number or opts object (tests pass number).
  const opts: CombatMoveKeysPwmOpts = typeof minDwellOrOpts === "number"
    ? { minDwell: minDwellOrOpts }
    : minDwellOrOpts ?? {};
  const minDwell = opts.minDwell ?? TARGET_ENEMY_MIN_TAP_BOT_TICKS;
  const suppressBackward = opts.suppressBackward === true;

  let alpha = yawPoleSignedDelta(lookYaw, worldMoveYaw);
  if (suppressBackward) {
    alpha = foldAlphaForwardHemisphere(alpha);
  }
  const plan = planOctantPwm(alpha);
  const st = secondaryPwmFromState(state);
  const secOn = stepSecondaryPwm(st, plan.secondary, plan.duty, minDwell);

  const keys = {
    forward: plan.hard.forward,
    backward: plan.hard.backward,
    left: plan.hard.left,
    right: plan.hard.right,
  };
  if (plan.secondary && secOn) {
    if (plan.secondary === "forward") keys.forward = true;
    else if (plan.secondary === "backward") keys.backward = true;
    else if (plan.secondary === "left") keys.left = true;
    else keys.right = true;
  }
  // Belt: never leave S on when suppress is armed (secondary cannot re-add it
  // after fold, but keep invariant explicit for callers/tests).
  if (suppressBackward) {
    keys.backward = false;
  }

  return { keys, pwmPatch: secondaryPwmToPatch(st) };
}

// ---------------------------------------------------------------------------
// Target pick
// ---------------------------------------------------------------------------

type HostileCandidate = {
  player: Player;
  dist: number;
  lookYaw: number;
  lookPitch: number;
};

export type PickTargetEnemyOpts = {
  /**
   * When true, do not drop candidates for being closer to the enemy door
   * (agent-hunt mode while doors are closed).
   */
  ignoreDoorPriority?: boolean;
  /**
   * Multiplier on door distance for door priority (see
   * {@link closerToEnemyDoorThanTarget}). Default 1. Trailing seeds use &lt;1.
   */
  doorPriorityRatio?: number;
  /**
   * Horizontal half-angle for fresh acquire. Default
   * {@link YAW_PLAYER_FOV_HALF_ANGLE}. Hunt uses a wider cone.
   */
  acquireFovHalf?: number;
  /**
   * Hold FOV half-angle for sticky. Defaults to max(acquire×1.5, hold default).
   */
  holdFovHalf?: number;
  /**
   * The bot's last intended look yaw (previous think). Sticky hold also passes
   * when the foe is inside this facing: think→apply delay leaves body yaw on an
   * older action, and gating only on it drops/re-acquires the lock every few
   * thinks (look flips between foe and path).
   */
  holdIntentYaw?: number;
  /**
   * P(prefer agents over non-agents) on a **fresh** multi-hostile acquire.
   * See {@link agentFirstChanceFromAggression}. Sticky id is never re-rolled.
   */
  agentFirstChance?: number;
  /** RNG for the agent-first preference roll. */
  /**
   * Pre-filtered hostiles (e.g. from perception). When set, scan this list
   * instead of all players. Sticky still resolves from this list.
   */
  hostiles?: readonly Player[];
  /**
   * When true, skip the eye→body LOS ray (caller already filtered via
   * {@link BotPerception.sensedHostiles}). FOV + door-priority still apply.
   */
  assumeLos?: boolean;
  /** Precomputed enemy door mid for door-priority. */
  enemyDoor?: { x: number; z: number };
  /** Precomputed distance from self to enemy door. */
  distToEnemyDoor?: number;
  /** Sim tick for Glitch hide checks (omit only in unit tests). */
  tick?: number;
};

/**
 * Combat-lock score: closer, more wounded, recently shooting, and closer to
 * the score door beat nearest-in-FOV. Sticky gets a hysteresis bonus.
 */
export function scoreHostileThreat(
  self: Pick<Player, "x" | "z">,
  other: Pick<Player, "x" | "z" | "health" | "lastShotAtTick">,
  dist: number,
  opts?: {
    sticky?: boolean;
    enemyDoor?: { x: number; z: number };
    distToEnemyDoor?: number;
    tick?: number;
  },
): number {
  let score = -dist;
  const hp = other.health;
  if (typeof hp === "number" && Number.isFinite(hp)) {
    const wound = 1 - clamp01(hp / MAX_HEALTH);
    score += wound * TARGET_THREAT_WOUND_WEIGHT;
  }
  const tick = opts?.tick;
  const lastShot = other.lastShotAtTick;
  if (
    typeof tick === "number" &&
    Number.isFinite(tick) &&
    typeof lastShot === "number" &&
    Number.isFinite(lastShot) &&
    tick - lastShot >= 0 &&
    tick - lastShot <= TARGET_THREAT_SHOOTING_TICKS
  ) {
    score += 6;
  }
  const door = opts?.enemyDoor;
  if (door) {
    const dSelf = typeof opts?.distToEnemyDoor === "number" &&
        Number.isFinite(opts.distToEnemyDoor)
      ? opts.distToEnemyDoor
      : distance2(self.x - door.x, self.z - door.z);
    const dEnemy = distance2(other.x - door.x, other.z - door.z);
    score += max(0, dSelf - dEnemy) * 0.35;
  }
  if (opts?.sticky) score += TARGET_THREAT_STICKY_BONUS;
  return score;
}

/**
 * Pick a valid combat lock: sticky id if still valid and not clearly beaten,
 * else the highest-threat FOV+LOS hostile. Optional agent-first roll on a
 * fresh acquire when both agent and non-agent candidates exist.
 */
export function pickTargetEnemy(
  self: Player,
  players: readonly Player[],
  collision: MapCollision,
  stickyId: string | undefined,
  opts?: PickTargetEnemyOpts,
  rng: () => number = () => 1,
): HostileCandidate | null {
  if (!self.alive) return null;

  const acquireFov = typeof opts?.acquireFovHalf === "number" &&
      Number.isFinite(opts.acquireFovHalf) &&
      opts.acquireFovHalf > 0
    ? opts.acquireFovHalf
    : YAW_PLAYER_FOV_HALF_ANGLE;
  const holdFov = typeof opts?.holdFovHalf === "number" &&
      Number.isFinite(opts.holdFovHalf) &&
      opts.holdFovHalf > 0
    ? opts.holdFovHalf
    : max(TARGET_ENEMY_HOLD_FOV_HALF_ANGLE, acquireFov * 1.5);
  const ignoreDoor = Boolean(opts?.ignoreDoorPriority);
  const evalOpts = {
    ignoreDoorPriority: ignoreDoor,
    doorPriorityRatio: opts?.doorPriorityRatio,
    enemyDoor: opts?.enemyDoor,
    distToEnemyDoor: opts?.distToEnemyDoor,
    tick: opts?.tick,
    assumeLos: opts?.assumeLos === true,
  };

  const pool = opts?.hostiles ?? players;
  const scoreOpts = {
    enemyDoor: opts?.enemyDoor,
    distToEnemyDoor: opts?.distToEnemyDoor,
    tick: opts?.tick,
  };

  let sticky: HostileCandidate | null = null;
  if (stickyId) {
    for (const p of pool) {
      if (p.id !== stickyId) continue;
      sticky = evaluateCandidate(self, p, collision, {
        ...evalOpts,
        fovHalf: holdFov,
        intentYaw: opts?.holdIntentYaw,
      });
      break;
    }
  }

  let bestAgent: HostileCandidate | null = null;
  let bestAgentScore = -Infinity;
  let bestOther: HostileCandidate | null = null;
  let bestOtherScore = -Infinity;
  for (const p of pool) {
    if (p.id === self.id || !p.alive) continue;
    if (!areHostile(self, p)) continue;
    const isSticky = stickyId === p.id;
    const c = isSticky ? sticky : evaluateCandidate(self, p, collision, {
      ...evalOpts,
      fovHalf: acquireFov,
    });
    if (!c) continue;
    const score = scoreHostileThreat(self, p, c.dist, {
      ...scoreOpts,
      sticky: isSticky,
    });
    if (p.isAgent) {
      if (score > bestAgentScore) {
        bestAgentScore = score;
        bestAgent = c;
      }
    } else if (score > bestOtherScore) {
      bestOtherScore = score;
      bestOther = c;
    }
  }

  // Sticky wins unless a fresh candidate clearly beats the hysteresis bonus.
  if (sticky) {
    const stickyScore = scoreHostileThreat(self, sticky.player, sticky.dist, {
      ...scoreOpts,
      sticky: true,
    });
    const bestFresh = max(bestAgentScore, bestOtherScore);
    if (!(bestFresh > stickyScore)) return sticky;
    return bestAgentScore >= bestOtherScore ? bestAgent : bestOther;
  }

  if (!bestAgent && !bestOther) return null;
  if (!bestAgent) return bestOther;
  if (!bestOther) return bestAgent;

  // Both classes present: roll agent-first personality (default 0 → enemy first).
  const chance = clampStandGroundChance(opts?.agentFirstChance);
  const roll = rng();
  if (chance > 0 && Number.isFinite(roll) && roll < chance) {
    return bestAgent;
  }
  return bestOther;
}

/**
 * True when the bot should drop combat for door focus: the foe is not close
 * enough relative to the enemy-door distance.
 *
 * Default (`doorPriorityRatio` 1): drop when `distDoor < distEnemy` (same as
 * before). Ratio &lt; 1 (score anxiety trailing) drops more often — only duel
 * when the foe is well inside door range. Ratio &gt; 1 keeps locks farther out.
 */
export function closerToEnemyDoorThanTarget(
  self: Player,
  other: Player,
  collision: MapCollision,
  enemyDoor?: { x: number; z: number },
  distToEnemyDoor?: number,
  opts?: { doorPriorityRatio?: number },
): boolean {
  const distDoor = typeof distToEnemyDoor === "number" &&
      Number.isFinite(distToEnemyDoor)
    ? distToEnemyDoor
    : (() => {
      const door = enemyDoor ?? enemyDoorTarget(collision.map, self.team);
      return distance2(self.x - door.x, self.z - door.z);
    })();
  const distEnemy = distance2(other.x - self.x, other.z - self.z);
  const raw = opts?.doorPriorityRatio;
  const ratio = typeof raw === "number" && Number.isFinite(raw) && raw > 0
    ? raw
    : 1;
  return distDoor * ratio < distEnemy;
}

function evaluateCandidate(
  self: Player,
  other: Player,
  collision: MapCollision,
  opts: {
    fovHalf: number;
    /** Alternate facing that also satisfies the FOV test (sticky hold). */
    intentYaw?: number;
    ignoreDoorPriority?: boolean;
    doorPriorityRatio?: number;
    enemyDoor?: { x: number; z: number };
    distToEnemyDoor?: number;
    tick?: number;
    assumeLos?: boolean;
  },
): HostileCandidate | null {
  if (!other.alive || other.id === self.id || !areHostile(self, other)) {
    return null;
  }
  if (
    typeof opts.tick === "number" &&
    isHiddenByGlitch(other)
  ) {
    return null;
  }
  const intentYaw = opts.intentYaw;
  if (
    !enemyInPlayerFov(
      self.x,
      self.z,
      self.yaw,
      other.x,
      other.z,
      opts.fovHalf,
    ) &&
    !(
      typeof intentYaw === "number" &&
      Number.isFinite(intentYaw) &&
      enemyInPlayerFov(self.x, self.z, intentYaw, other.x, other.z, opts.fovHalf)
    )
  ) {
    return null;
  }
  // Solid geometry (full walls always; half/float if every eye→body ray hits).
  // Standing foes behind half walls use head fallback via pickCombatAimPoint.
  // Perception-backed combat already paid this ray (`assumeLos`) — use torso
  // for lock look; combatPitch resticks height.
  let aim: { x: number; y: number; z: number };
  if (opts.assumeLos) {
    aim = aimPointOnPlayer(other);
  } else {
    const eye = { x: self.x, y: self.y, z: self.z };
    const picked = pickCombatAimPoint(collision, eye, other);
    if (!picked) return null;
    aim = picked;
  }
  const dist = distance2(other.x - self.x, other.z - self.z);
  // Nearer the score door than this foe → drop / skip combat (door priority).
  if (
    !opts.ignoreDoorPriority &&
    closerToEnemyDoorThanTarget(
      self,
      other,
      collision,
      opts.enemyDoor,
      opts.distToEnemyDoor,
      { doorPriorityRatio: opts.doorPriorityRatio },
    )
  ) {
    return null;
  }
  const lookYaw = yawToward(self.x, self.z, aim.x, aim.z);
  const lookPitch = pitchToward(self.x, self.y, self.z, aim.x, aim.y, aim.z);
  return { player: other, dist, lookYaw, lookPitch };
}

export type StepTargetEnemyInput = {
  self: Player;
  players: readonly Player[];
  collision: MapCollision;
  /**
   * Continuous world-space move intent (path / corner-round, or vault/duck wish).
   * Prefer this over recovering from already-quantized keys.
   */
  worldMoveYaw: number;
  state: TargetEnemyState;
  /**
   * Personality: P(stand ground for this lock) in [0, 1]. Per-bot — omit / 0
   * keeps prior path movement under combat look (door chase / shoot-and-run).
   * On hit: cancel path keys and run stand-ground ADAD (or plant when
   * {@link strafeAvgMs} is 0).
   */
  standGroundChance?: number;
  /**
   * Mean active A/D hold while stand-ground (ms). 0 ⇒ pure plant when
   * stand-ground hits.
   */
  strafeAvgMs?: number;
  /**
   * Mean stand-still gap between A/D holds (ms). 0 still allows rolled
   * pauses (default band) and random ADAD exit; it is not “never pause”.
   */
  strafePauseAvgMs?: number;
  /** Relative duration jitter in [0, 1] for both averages. */
  strafeVariation?: number;
  /** RNG for stand-ground roll + ADAD duration / side. */
  rng?: () => number;
  /** When true, keep combat locks near the enemy door (agent hunt). */
  ignoreDoorPriority?: boolean;
  /**
   * Door-priority distance scale (see {@link closerToEnemyDoorThanTarget}).
   * Trailing score anxiety uses &lt;1 so seeds favor the door over distant duels.
   */
  doorPriorityRatio?: number;
  /** Wider acquire FOV while hunting. */
  acquireFovHalf?: number;
  /**
   * P(prefer agents) on fresh acquire. See
   * {@link agentFirstChanceFromAggression}.
   */
  agentFirstChance?: number;
  /** Pre-filtered hostiles from perception. */
  hostiles?: readonly Player[];
  /**
   * Skip LOS in {@link pickTargetEnemy} — set when `hostiles` is already
   * {@link BotPerception.sensedHostiles}.
   */
  assumeLos?: boolean;
  /** Precomputed enemy door mid. */
  enemyDoor?: { x: number; z: number };
  /** Precomputed distance to enemy door. */
  distToEnemyDoor?: number;
  /** Sim tick for Glitch hide checks (omit only in unit tests). */
  tick?: number;
  /** See {@link PickTargetEnemyOpts.holdIntentYaw}. */
  holdIntentYaw?: number;
  /**
   * Personality 0–1 (door rusher high). At/above
   * {@link DOOR_AGGRESSION_SUPPRESS_BACKWARD}, PWM folds to the forward
   * hemisphere while world move progresses toward the enemy door.
   */
  doorAggression?: number;
  /**
   * Desired min horizontal distance to the locked enemy. When closer,
   * cancel W and hold S (keep A/D). 0 / omit → no separation.
   */
  minSeparation?: number;
  /**
   * Combat look / click lead horizon (seconds). 0 → live body.
   * Default {@link TARGET_ENEMY_LEAD_SEC}.
   */
  leadSec?: number;
};

/**
 * Pure combat-look step: FOV lock + either stand-ground ADAD or PWM path keys.
 */
export function stepTargetEnemy(
  input: StepTargetEnemyInput,
): TargetEnemyResult {
  const stickyRaw = input.state[TARGET_ENEMY_STATE_KEY];
  const stickyId = typeof stickyRaw === "string" && stickyRaw.length > 0
    ? stickyRaw
    : undefined;
  const rng = typeof input.rng === "function" ? input.rng : () => 0.5;

  const picked = pickTargetEnemy(
    input.self,
    input.players,
    input.collision,
    stickyId,
    {
      ignoreDoorPriority: input.ignoreDoorPriority,
      doorPriorityRatio: input.doorPriorityRatio,
      hostiles: input.hostiles,
      assumeLos: input.assumeLos,
      enemyDoor: input.enemyDoor,
      distToEnemyDoor: input.distToEnemyDoor,
      acquireFovHalf: input.acquireFovHalf,
      agentFirstChance: input.agentFirstChance,
      tick: input.tick,
      holdIntentYaw: input.holdIntentYaw,
    },
    rng,
  );

  if (!picked) {
    return {
      combat: null,
      statePatch: clearTargetEnemyState(input.state),
    };
  }

  // One roll per new lock id; sticky holds reuse the previous decision.
  // chance >= 1 always stand-ground (easy tier / agents) — no roll needed.
  const isNewLock = stickyId !== picked.player.id;
  let standGround: boolean;
  if (isNewLock) {
    const chance = clampStandGroundChance(input.standGroundChance);
    if (chance >= 1) {
      standGround = true;
    } else if (chance <= 0) {
      standGround = false;
    } else {
      const roll = rng();
      standGround = Number.isFinite(roll) && roll < chance;
    }
  } else {
    standGround = Boolean(input.state.targetEnemyStandGround);
  }

  // Warm sticky: lead look along estimated velocity (buffer lag compensation).
  const { vel, samplePatch } = estimateStickyTargetVelocity(
    input.state,
    picked.player,
    isNewLock,
  );
  const leadSec = typeof input.leadSec === "number" &&
      Number.isFinite(input.leadSec)
    ? max(0, input.leadSec)
    : TARGET_ENEMY_LEAD_SEC;
  const { lookYaw, lookPitch } = combatLookWithLead(
    input.self,
    picked.player,
    input.collision,
    vel,
    { lookYaw: picked.lookYaw, lookPitch: picked.lookPitch },
    leadSec,
  );

  const wasSeparating = Boolean(input.state.targetEnemySeparating);

  if (standGround) {
    const adad = stepStandGroundStrafe({
      strafeAvgMs: input.strafeAvgMs ?? 0,
      strafePauseAvgMs: input.strafePauseAvgMs ?? 0,
      strafeVariation: input.strafeVariation ?? 0,
      rng,
      state: input.state,
      isNewLock,
    });
    const keys = {
      forward: adad.forward,
      backward: adad.backward,
      left: adad.left,
      right: adad.right,
    };
    const separating = applyMinSeparation(
      keys,
      input.self,
      picked.player,
      input.minSeparation,
      wasSeparating,
    );
    return {
      combat: {
        ...keys,
        lookYaw,
        lookPitch,
        enemyId: picked.player.id,
      },
      statePatch: {
        ...adad.pwmPatch,
        ...samplePatch,
        [TARGET_ENEMY_STATE_KEY]: picked.player.id,
        targetEnemyStandGround: true,
        targetEnemyStrafePhase: adad.phase,
        targetEnemyStrafeTicksLeft: adad.ticksLeft,
        targetEnemyStrafeDir: adad.dir,
        targetEnemyStrafeDepth: adad.depth,
        targetEnemyStrafeDepthDuty: adad.depthDuty > 0
          ? adad.depthDuty
          : Number.NaN,
        targetEnemyStrafeStopped: adad.stopped,
        targetEnemySeparating: separating,
        // Depth secondary PWM while ADAD; idle when planted / pure lateral / pause.
      },
    };
  }

  // Door-push + path progressing toward enemy door → no combat moonwalk S.
  const doorAgg = typeof input.doorAggression === "number" &&
      Number.isFinite(input.doorAggression)
    ? input.doorAggression
    : 0;
  const enemyDoorPt = input.enemyDoor ??
    enemyDoorTarget(input.collision.map, input.self.team as "A" | "B");
  const suppressBackward = doorAgg >= DOOR_AGGRESSION_SUPPRESS_BACKWARD &&
    worldMoveProgressesToward(
      input.self.x,
      input.self.z,
      input.worldMoveYaw,
      enemyDoorPt,
    );

  const { keys, pwmPatch } = combatMoveKeysPwm(
    lookYaw,
    input.worldMoveYaw,
    input.state,
    { suppressBackward },
  );
  const pwmKeys = {
    forward: keys.forward,
    backward: keys.backward,
    left: keys.left,
    right: keys.right,
  };
  const separating = applyMinSeparation(
    pwmKeys,
    input.self,
    picked.player,
    input.minSeparation,
    wasSeparating,
  );

  return {
    combat: {
      ...pwmKeys,
      lookYaw,
      lookPitch,
      enemyId: picked.player.id,
    },
    statePatch: {
      ...pwmPatch,
      ...samplePatch,
      [TARGET_ENEMY_STATE_KEY]: picked.player.id,
      targetEnemyStandGround: false,
      targetEnemyStrafePhase: "",
      targetEnemyStrafeTicksLeft: Number.NaN,
      targetEnemyStrafeDir: "",
      targetEnemyStrafeDepth: "",
      targetEnemyStrafeDepthDuty: Number.NaN,
      targetEnemyStrafeStopped: false,
      targetEnemySeparating: separating,
    },
  };
}

/** True when the bot should back off a face-hug. */
export function shouldSeparateFromTarget(
  horizDist: number,
  minSeparation: number,
  wasSeparating: boolean,
): boolean {
  if (!(minSeparation > 0) || !Number.isFinite(horizDist)) return false;
  if (wasSeparating) {
    return horizDist < minSeparation + MIN_SEPARATION_HYSTERESIS;
  }
  return horizDist < minSeparation;
}

function applyMinSeparation(
  keys: {
    forward: boolean;
    backward: boolean;
    left: boolean;
    right: boolean;
  },
  self: Pick<Player, "x" | "z">,
  target: Pick<Player, "x" | "z">,
  minSeparation: number | undefined,
  wasSeparating: boolean,
): boolean {
  const minSep =
    typeof minSeparation === "number" && Number.isFinite(minSeparation)
      ? minSeparation
      : 0;
  const horiz = distance2(target.x - self.x, target.z - self.z);
  const separating = shouldSeparateFromTarget(horiz, minSep, wasSeparating);
  if (separating) {
    keys.forward = false;
    keys.backward = true;
  }
  return separating;
}
