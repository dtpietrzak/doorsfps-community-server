/**
 * Path ADAD while walking yaw-poles (personality `pathStrafe`).
 *
 * Pattern: L→R→L… or R→L→R… (picked once) in short bursts. Hold lengths
 * re-roll each phase (0.18–0.65s when active). Dead (forward-only) phases
 * still scale with personality, with a floor so high personality still rests.
 * After a live hold the bot may take a longer rest (exit the burst) before
 * weaving again. Outside of the upcoming turn holds ~2× inside. Amplitude
 * scales with open side clearance and fades as we approach the current pole
 * (corner-round owns the apex). An authored Nudge can choose the active A/D
 * side while preserving this phase timing. Suppresses when vault/duck is
 * queued or committed.
 */

import { TICK_HZ } from "../../../shared/network.ts";
import type { MapCollision } from "../../../world/MapCollision.ts";
import {
  abs,
  distance2,
  distanceSquared2,
  fastSinCos,
  HALF_PI,
  max,
  min,
  round,
  sign,
  yawFromWorldDirection,
} from "../../../math/index.ts";
import {
  FLOAT_WALL_DUCK_PROBE_FRESH,
  isCrouchableWithin,
  isUnderFloatSlab,
} from "../../floatWallDuck/helpers/floatWallDuck.ts";
import {
  HALF_WALL_VAULT_PROBE,
  isJumpableWithin,
} from "../../halfWallVault/helpers/halfWallVault.ts";
import {
  YAW_POLE_CORNER_END_DIST,
  YAW_POLE_CORNER_START_DIST,
  yawPoleCornerApproachT,
  type YawPolePoint,
  yawPoleSignedDelta,
  yawPoleToward,
} from "../../yawPole/helpers/yawPole.ts";

/** Active L/R hold length band (seconds). Re-rolled each phase. */
export const PATH_STRAFE_HOLD_SEC_MIN = 0.18;
export const PATH_STRAFE_HOLD_SEC_MAX = 0.65;
/** Dead (no strafe) phase length band when personality skips a hold. */
export const PATH_STRAFE_DEAD_SEC_MIN = 0.4;
export const PATH_STRAFE_DEAD_SEC_MAX = 1.2;
/**
 * Longer forward-only rest after a live hold when the burst exits.
 * Distinct from the short dead band so “stop weaving” is visible.
 */
export const PATH_STRAFE_REST_SEC_MIN = 1.2;
export const PATH_STRAFE_REST_SEC_MAX = 3.0;
/** Floor on P(short dead phase) so personality 1 still rests. */
export const PATH_STRAFE_DEAD_FLOOR = 0.22;
/**
 * P(long rest) after a live L/R hold expires. Not rolled when coming out of
 * none — the next burst can start without an extra rest gate.
 */
export const PATH_STRAFE_EXIT_P = 0.2;
/**
 * Lateral feeler distance (world units). Need clear space before random ADAD.
 * Tight tunnels → scale 0.
 */
export const PATH_STRAFE_FEELER_DIST = 1.75;
/** Max lateral mix into world move at full personality + open space. */
export const PATH_STRAFE_MAX_LATERAL = 0.4;
/** Minimum lateral-feeler clearance before a Nudge may press literal A/D. */
export const PATH_NUDGE_MIN_OPEN_SCALE = 0.5;
/**
 * How far ahead to treat half-wall as “queued” (straighten before hop).
 * Combined with {@link HALF_WALL_VAULT_PROBE} via max() so multi-sample vault
 * and path-strafe straighten over the same approach band.
 */
export const PATH_STRAFE_JUMP_QUEUE_DIST = 0.85;
/** Outside-of-turn hold duration multiplier vs inside. */
export const PATH_STRAFE_OUTSIDE_HOLD_MULT = 2;

export type PathStrafeDir = "left" | "right" | "none";

/** Opaque brain-state fields for path strafe phase machine. */
export type PathStrafeState = {
  pathStrafeDir: string;
  pathStrafeTicksLeft: number;
  /** First side of the alternating pattern (LRLR vs RLRL). */
  pathStrafeFirst: string;
};

export function clearPathStrafeState(bag: PathStrafeState): void {
  bag.pathStrafeDir = "none";
  bag.pathStrafeTicksLeft = Number.NaN;
  bag.pathStrafeFirst = "";
}

function clamp01(v: number): number {
  if (!(v > 0) || !Number.isFinite(v)) return 0;
  if (v > 1) return 1;
  return v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Clear distance along player A/D axis relative to face yaw, capped at maxDist. */
export function sideClearDist(
  collision: MapCollision,
  x: number,
  z: number,
  faceYaw: number,
  side: "left" | "right",
  maxDist: number = PATH_STRAFE_FEELER_DIST,
): number {
  if (!(maxDist > 0)) return 0;
  // Match moveStep WASD: A = face+90°, D = face−90° in classifyForward space.
  const sideYaw = side === "left" ? faceYaw + HALF_PI : faceYaw - HALF_PI;
  const step = min(0.25, maxDist);
  for (let d = step; d <= maxDist + 1e-6; d += step) {
    if (collision.classifyForward(x, z, sideYaw, d) !== "clear") {
      return max(0, d - step);
    }
  }
  return maxDist;
}

/**
 * Open-space scale in [0, 1] for a chosen side (or both when dir is none).
 * Uses min clear when checking general openness.
 */
export function openSpaceScaleForDir(
  collision: MapCollision | null | undefined,
  x: number,
  z: number,
  faceYaw: number,
  dir: PathStrafeDir,
  feelerDist: number = PATH_STRAFE_FEELER_DIST,
): number {
  if (!collision) return 1;
  if (dir === "left") {
    return clamp01(
      sideClearDist(collision, x, z, faceYaw, "left", feelerDist) /
        feelerDist,
    );
  }
  if (dir === "right") {
    return clamp01(
      sideClearDist(collision, x, z, faceYaw, "right", feelerDist) /
        feelerDist,
    );
  }
  const l = sideClearDist(collision, x, z, faceYaw, "left", feelerDist);
  const r = sideClearDist(collision, x, z, faceYaw, "right", feelerDist);
  return clamp01(min(l, r) / feelerDist);
}

/** True when jump/crouch is committed or about to queue on the path. */
export function pathStrafeShouldSuppress(args: {
  collision?: MapCollision | null;
  x: number;
  z: number;
  pathYaw: number;
  halfWallVaultTicksLeft?: number;
  floatWallDuckTicksLeft?: number;
}): boolean {
  if ((args.halfWallVaultTicksLeft ?? 0) > 0) return true;
  if ((args.floatWallDuckTicksLeft ?? 0) > 0) return true;
  const collision = args.collision;
  if (!collision) return false;
  if (isUnderFloatSlab(collision, args.x, args.z)) return true;

  // Match vault multi-sample trigger (not a single far sample that can miss).
  const jumpProbe = max(
    HALF_WALL_VAULT_PROBE,
    PATH_STRAFE_JUMP_QUEUE_DIST,
  );
  if (isJumpableWithin(collision, args.x, args.z, args.pathYaw, jumpProbe)) {
    return true;
  }
  // Use the longer float probe so we straighten early regardless of stamina.
  const floatProbe = FLOAT_WALL_DUCK_PROBE_FRESH;
  if (
    isCrouchableWithin(
      collision,
      args.x,
      args.z,
      args.pathYaw,
      floatProbe,
    )
  ) {
    return true;
  }
  return false;
}

/**
 * Corner outside sign in approach frame: +1 right, −1 left.
 * Opposite of next (same as computeYawPoleCornerRound).
 * 0 when next missing / degenerate / near-straight.
 */
export function pathStrafeOutsideSign(
  x: number,
  z: number,
  current: YawPolePoint,
  next: YawPolePoint | null | undefined,
): number {
  if (
    !next ||
    !Number.isFinite(current.x) ||
    !Number.isFinite(current.z) ||
    !Number.isFinite(next.x) ||
    !Number.isFinite(next.z)
  ) {
    return 0;
  }
  const toCurrent = yawPoleToward(x, z, current.x, current.z);
  const dxExit = next.x - current.x;
  const dzExit = next.z - current.z;
  if (!(distanceSquared2(dxExit, dzExit) > 1e-12)) return 0;
  const direction = fastSinCos(toCurrent);
  const rx = direction.cos;
  const rz = -direction.sin;
  const side = dxExit * rx + dzExit * rz;
  // Strafe opposite next: next right → outside left (−1).
  if (side > 1e-8) return -1;
  if (side < -1e-8) return 1;
  const turn = yawPoleSignedDelta(
    toCurrent,
    yawPoleToward(current.x, current.z, next.x, next.z),
  );
  if (abs(turn) < 0.12) return 0;
  return turn > 0 ? 1 : -1;
}

function secToTicks(sec: number): number {
  return max(1, round(sec * TICK_HZ));
}

function rollUniform(rng: () => number, lo: number, hi: number): number {
  const u = rng();
  const t = Number.isFinite(u) ? clamp01(u) : 0.5;
  return lerp(lo, hi, t);
}

/**
 * Roll next phase duration in ticks. Active holds 0.18–0.65s; short dead
 * longer. Outside holds ×2 when outsideSign matches the new dir.
 */
export function rollPathStrafeHoldTicks(args: {
  personality: number;
  dir: PathStrafeDir;
  outsideSign: number;
  rng: () => number;
}): number {
  if (args.dir === "none") {
    return secToTicks(
      rollUniform(args.rng, PATH_STRAFE_DEAD_SEC_MIN, PATH_STRAFE_DEAD_SEC_MAX),
    );
  }
  let sec = rollUniform(
    args.rng,
    PATH_STRAFE_HOLD_SEC_MIN,
    PATH_STRAFE_HOLD_SEC_MAX,
  );
  // Outside of upcoming turn: hold ~2× as long.
  if (args.outsideSign !== 0) {
    const dirSign = args.dir === "left" ? -1 : 1;
    if (dirSign === sign(args.outsideSign)) {
      sec *= PATH_STRAFE_OUTSIDE_HOLD_MULT;
    }
  }
  return secToTicks(sec);
}

/**
 * Probability of starting a short dead (no strafe) phase. High when
 * personality is low; floored so high personality still pauses.
 */
export function pathStrafeDeadChance(personality: number): number {
  const p = clamp01(personality);
  if (p <= 0) return 1;
  return max(1 - p, PATH_STRAFE_DEAD_FLOOR);
}

function oppositeDir(d: "left" | "right"): "left" | "right" {
  return d === "left" ? "right" : "left";
}

/**
 * Advance the L/R/none phase machine. Mutates `state`. Returns active dir.
 */
export function stepPathStrafePhase(args: {
  state: PathStrafeState;
  personality: number;
  outsideSign: number;
  simDelta: number;
  rng: () => number;
  /** At a phase boundary, choose this A/D side instead of alternating. */
  preferredDir?: PathStrafeDir;
  /** When true, force dir none and freeze timer (vault/duck/suppress). */
  suppress: boolean;
}): PathStrafeDir {
  const { state, rng } = args;
  const p = clamp01(args.personality);
  const simDelta =
    typeof args.simDelta === "number" && Number.isFinite(args.simDelta) &&
      args.simDelta > 0
      ? args.simDelta
      : 1;

  if (args.suppress || p <= 0) {
    // Keep pattern seed if any; clear live hold so we re-roll when free again.
    state.pathStrafeDir = "none";
    state.pathStrafeTicksLeft = 0;
    return "none";
  }

  const ticksLeft = Number.isFinite(state.pathStrafeTicksLeft)
    ? state.pathStrafeTicksLeft
    : 0;
  const storedDir = state.pathStrafeDir;
  const dir: PathStrafeDir = storedDir === "left" || storedDir === "right"
    ? storedDir
    : "none";

  if (ticksLeft > 0) {
    const next = ticksLeft - simDelta;
    if (next > 0) {
      state.pathStrafeTicksLeft = next;
      state.pathStrafeDir = dir;
      return dir;
    }
    // Phase expired — roll next below.
  }

  // Seed alternating pattern once.
  if (state.pathStrafeFirst !== "left" && state.pathStrafeFirst !== "right") {
    state.pathStrafeFirst = rng() < 0.5 ? "left" : "right";
  }
  const first: "left" | "right" = state.pathStrafeFirst === "right"
    ? "right"
    : "left";

  // After a live hold, sometimes exit the burst into a longer forward rest.
  if (
    (dir === "left" || dir === "right") &&
    args.preferredDir !== "none" &&
    rng() < PATH_STRAFE_EXIT_P
  ) {
    const rest = secToTicks(
      rollUniform(rng, PATH_STRAFE_REST_SEC_MIN, PATH_STRAFE_REST_SEC_MAX),
    );
    state.pathStrafeDir = "none";
    state.pathStrafeTicksLeft = rest;
    return "none";
  }

  // Pick next dir: Nudge can bias active phases toward its nearest line;
  // otherwise alternate L/R. Personality still controls dead phases.
  let nextDir: PathStrafeDir;
  if (args.preferredDir === "none") {
    nextDir = "none";
  } else if (rng() < pathStrafeDeadChance(p)) {
    nextDir = "none";
  } else if (
    args.preferredDir === "left" || args.preferredDir === "right"
  ) {
    nextDir = args.preferredDir;
  } else if (dir === "left" || dir === "right") {
    nextDir = oppositeDir(dir);
  } else {
    // Coming out of dead or first tick: use first, or opposite of last active.
    nextDir = first;
  }

  const hold = rollPathStrafeHoldTicks({
    personality: p,
    dir: nextDir,
    outsideSign: args.outsideSign,
    rng,
  });
  state.pathStrafeDir = nextDir;
  state.pathStrafeTicksLeft = hold;
  return nextDir;
}

/**
 * Lateral mix in approach frame this tick: +right / −left, magnitude [0, max].
 */
export function pathStrafeLateralAmount(args: {
  dir: PathStrafeDir;
  personality: number;
  openScale: number;
  /** 0 far → 1 near pole; random fades with approach. */
  approachT: number;
  maxLateral?: number;
}): number {
  if (args.dir === "none") return 0;
  const p = clamp01(args.personality);
  const open = clamp01(args.openScale);
  const far = clamp01(1 - clamp01(args.approachT));
  const maxLat = clamp01(args.maxLateral ?? PATH_STRAFE_MAX_LATERAL);
  const mag = p * open * far * maxLat;
  if (!(mag > 0)) return 0;
  return args.dir === "left" ? -mag : mag;
}

/**
 * Corner-style lateral blend: strafeAmount ≥ 0, strafeSign ±1.
 * Matches computeYawPoleCornerRound move math (over-round amount &gt; 1 ok).
 */
export function moveYawFromApproachLateral(
  approachYaw: number,
  strafeAmount: number,
  strafeSign: number,
): number {
  const amount = Number.isFinite(strafeAmount) && strafeAmount > 0
    ? strafeAmount
    : 0;
  if (!(amount > 0) || strafeSign === 0) return approachYaw;
  const sign = strafeSign > 0 ? 1 : -1;
  const direction = fastSinCos(approachYaw);
  const fx = -direction.sin;
  const fz = -direction.cos;
  const rx = direction.cos;
  const rz = -direction.sin;
  const fwdW = 1 - amount;
  const latW = amount * sign;
  let mx = fx * fwdW + rx * latW;
  let mz = fz * fwdW + rz * latW;
  const mLen = distance2(mx, mz);
  if (!(mLen > 1e-8)) return approachYaw;
  mx /= mLen;
  mz /= mLen;
  return yawFromWorldDirection(mx, mz);
}

/** Signed lateral (+right / −left) → move yaw in the approach frame. */
export function moveYawWithLateral(
  approachYaw: number,
  lateralSigned: number,
): number {
  if (!(abs(lateralSigned) > 1e-12)) return approachYaw;
  return moveYawFromApproachLateral(
    approachYaw,
    abs(lateralSigned),
    lateralSigned > 0 ? 1 : -1,
  );
}

/**
 * Full path-strafe tick: phase + amplitude + combined move yaw with optional
 * corner lateral (same approach frame).
 *
 * `cornerLateral` = approachT * angleScale * maxStrafe * strafeSign conceptually
 * but we take precomputed corner strafeAmount * strafeSign as a signed lateral
 * contribution that ramps with approach; path random fades with (1-approachT).
 */
export function stepPathStrafeMove(args: {
  state: PathStrafeState;
  x: number;
  z: number;
  approachYaw: number;
  current: YawPolePoint | null | undefined;
  next: YawPolePoint | null | undefined;
  personality: number;
  /**
   * Signed corner lateral mix already scaled by approach (amount * sign).
   * 0 when no corner round.
   */
  cornerLateral: number;
  collision?: MapCollision | null;
  simDelta: number;
  rng: () => number;
  /** Same cadence, but active phases choose the side toward a Nudge line. */
  preferredDir?: PathStrafeDir;
  /** Run the phase machine without blending its lateral into move yaw. */
  phaseOnly?: boolean;
  suppress: boolean;
}): {
  moveYaw: number;
  dir: PathStrafeDir;
  pathLateral: number;
  approachT: number;
} {
  const approachYaw = args.approachYaw;
  let approachT = 0;
  if (
    args.current && Number.isFinite(args.current.x) &&
    Number.isFinite(args.current.z)
  ) {
    const dist = distance2(args.current.x - args.x, args.current.z - args.z);
    approachT = yawPoleCornerApproachT(
      dist,
      YAW_POLE_CORNER_START_DIST,
      YAW_POLE_CORNER_END_DIST,
    );
  }

  const outsideSign = args.current
    ? pathStrafeOutsideSign(args.x, args.z, args.current, args.next)
    : 0;

  const dir = stepPathStrafePhase({
    state: args.state,
    personality: args.personality,
    outsideSign,
    simDelta: args.simDelta,
    rng: args.rng,
    preferredDir: args.preferredDir,
    suppress: args.suppress,
  });

  const open = openSpaceScaleForDir(
    args.collision,
    args.x,
    args.z,
    approachYaw,
    dir,
  );
  const activeDir = args.phaseOnly && open < PATH_NUDGE_MIN_OPEN_SCALE
    ? "none"
    : dir;
  const pathLateral = args.phaseOnly ? 0 : pathStrafeLateralAmount({
    dir,
    personality: args.personality,
    openScale: open,
    approachT,
  });

  // Combine: corner lateral (grows with approach) + path random (fades).
  const totalLateral = args.cornerLateral + pathLateral;
  // Corner uses amount with sign: signed = amount * sign, fwdW = 1 - amount.
  // Path uses signed mag with |mag| ≤ max. Sum as signed lateral using corner math
  // when |total| interpreted as amount with sign:
  const amount = abs(totalLateral);
  const sign = totalLateral === 0 ? 0 : totalLateral > 0 ? 1 : -1;
  const moveYaw = sign === 0
    ? approachYaw
    : moveYawFromApproachLateral(approachYaw, amount, sign);

  return { moveYaw, dir: activeDir, pathLateral, approachT };
}
