/**
 * Pure floating-wall crouch-under assist for bots (think-pipe step after
 * halfWallVault).
 *
 * Dormant unless a float slab sits on the desired path within:
 *   - {@link FLOAT_WALL_DUCK_PROBE_FRESH} when stamina ≥ 30% (can sprint), or
 *   - {@link FLOAT_WALL_DUCK_PROBE_TIRED} when stamina is lower.
 * Never starts while a half-wall vault is active.
 *
 * Design (Crossroads mid / Hourglass floats):
 *   1. **Path-aligned transit** — commit face + keys follow the desired path
 *      yaw, not the nearest float's wall normal (which pulled bots into the
 *      full-wall spine of the Crossroads +).
 *   2. **Under-slab ownership** — while standing headroom is blocked, always
 *      crouch and steer toward the nearest standing exit.
 *   3. **Side-clear options** — A/D collapses only when that side is blocked
 *      (same as half-wall vault), not when any full wall is within a ring.
 *   4. **Progress abort** — zero-progress commits cool down so bots stop
 *      thrashing into the same wall face.
 */

import {
  SLIDE_STAMINA_COST,
  SPRINT_DURATION_S,
} from "../../../../../shared/sim/game.ts";
import {
  CROUCH_COLLISION_HEIGHT,
  type MapCollision,
  PLAYER_RADIUS,
  STAND_COLLISION_HEIGHT,
} from "../../../world/MapCollision.ts";
import { msToTicks } from "../../../shared/network.ts";
import {
  clamp,
  distanceSquared2,
  fastAtan2,
  fastSinCos,
  HALF_PI,
  max,
  min,
  PI,
  TWO_PI,
} from "../../../math/index.ts";
import {
  HALF_WALL_VAULT_HEAD_ON_OPTION,
  HALF_WALL_VAULT_OPTIONS,
  pickHalfWallVaultOption,
  sideWallWithin,
  yawAbsDelta,
} from "../../halfWallVault/helpers/halfWallVault.ts";

/** Low-energy trigger distance along desired yaw. */
export const FLOAT_WALL_DUCK_PROBE_TIRED = 1.0;
/** Fresh-stamina trigger distance along desired yaw (can still sprint). */
export const FLOAT_WALL_DUCK_PROBE_FRESH = 2.0;

/**
 * @deprecated Ring full-wall check — no longer used to force head-on. Kept for
 * tests / callers. Prefer {@link sideWallWithin} via {@link pickFloatWallDuckOption}.
 */
export const FLOAT_WALL_DUCK_FULL_WALL_NEAR = 1.5;

/**
 * Minimum fraction of a full sprint bar to use the longer probe.
 * "Able to sprint" — not currently sprinting / sprint key intent.
 */
export const FLOAT_WALL_DUCK_STAMINA_FRAC = 0.3;

/**
 * Hold crouch-under long enough to clear a float slab at crouch speed.
 * Matches older nav float duck (~700ms @ 60 Hz).
 */
export const FLOAT_WALL_DUCK_COMMIT_TICKS = msToTicks(700);

/**
 * Hard cap on continuous crouch-under (approach + under-slab). Float slabs are
 * transit, not patrol space. After this, force exit seek / abort off-slab.
 */
export const FLOAT_WALL_DUCK_MAX_TICKS = msToTicks(1000);

/**
 * While under a slab, if preferred still has not opened standing headroom within
 * this many ticks, force the shortest exit (Crossroads + / Hourglass mid).
 */
export const FLOAT_WALL_DUCK_FORCE_EXIT_TICKS = msToTicks(350);

/** Preferred is only a valid under-slab transit if standing headroom is this close. */
const FLOAT_PREFERRED_EXIT_MAX = 1.35;
/** How far to search for standing headroom when exiting under a float. */
const FLOAT_EXIT_PROBE_MAX = 4.5;
const FLOAT_EXIT_PROBE_STEP = 0.25;

/**
 * After this many sim ticks into a commit, require minimum displacement or abort.
 * ~300ms @ 60 Hz.
 */
export const FLOAT_WALL_DUCK_PROGRESS_CHECK_TICKS = msToTicks(300);

/** Min horizontal move from commit start by the progress check, else abort. */
export const FLOAT_WALL_DUCK_MIN_PROGRESS = 0.15;

/** Cooldown after a zero-progress / failed duck before re-triggering. */
export const FLOAT_WALL_DUCK_ABORT_COOLDOWN_TICKS = msToTicks(700);

/**
 * Commit / force-exit / max timers above assume the crouch press starts a
 * slide (sprint-speed burst). Without slide stamina the sim crouch-walks at
 * half walk speed, so the same slab takes a few times longer to cross.
 */
export const FLOAT_WALL_DUCK_CRAWL_TIME_SCALE = 2.5;

/** Same five approach options as half-wall vault (look on face, keys pick path). */
export const FLOAT_WALL_DUCK_OPTIONS = HALF_WALL_VAULT_OPTIONS;

/** Index into {@link FLOAT_WALL_DUCK_OPTIONS} for pure forward W crouch. */
export const FLOAT_WALL_DUCK_HEAD_ON_OPTION = HALF_WALL_VAULT_HEAD_ON_OPTION;

/** Opaque brain-state fields for an active float duck commit. */
export type FloatWallDuckState = {
  floatWallDuckTicksLeft?: number;
  /** Look + WASD reference yaw (path-aligned or under-slab exit). */
  floatWallDuckFaceYaw?: number;
  /** Index into {@link FLOAT_WALL_DUCK_OPTIONS}. */
  floatWallDuckOption?: number;
  /** World X at commit start (progress watchdog). */
  floatWallDuckStartX?: number;
  /** World Z at commit start (progress watchdog). */
  floatWallDuckStartZ?: number;
  /** Sim ticks elapsed in the current continuous duck. */
  floatWallDuckElapsed?: number;
  /** Sim tick until which new approach ducks are refused (abort cooldown). */
  floatWallDuckCooldownUntilTick?: number;
};

export type FloatWallDuckResult = {
  active: boolean;
  faceYaw?: number;
  forward?: boolean;
  left?: boolean;
  right?: boolean;
  crouch?: boolean;
  /** Fields to merge into draft brain state (undefined deletes). */
  statePatch: FloatWallDuckState;
};

/** Clear duck commit fields (death / finished pass). Keeps cooldown if set. */
export function clearFloatWallDuckState(
  _state?: FloatWallDuckState,
  opts?: { cooldownUntilTick?: number },
): FloatWallDuckState {
  return {
    floatWallDuckTicksLeft: Number.NaN,
    floatWallDuckFaceYaw: Number.NaN,
    floatWallDuckOption: Number.NaN,
    floatWallDuckStartX: Number.NaN,
    floatWallDuckStartZ: Number.NaN,
    floatWallDuckElapsed: Number.NaN,
    floatWallDuckCooldownUntilTick:
      typeof opts?.cooldownUntilTick === "number" &&
        Number.isFinite(opts.cooldownUntilTick)
        ? opts.cooldownUntilTick
        : Number.NaN,
  };
}

/**
 * True when stamina is high enough that the bot could still sprint
 * (≥ {@link FLOAT_WALL_DUCK_STAMINA_FRAC} of a full bar).
 */
export function canSprintFromStamina(
  sprintStamina: number,
  maxStamina: number = SPRINT_DURATION_S,
): boolean {
  if (!(maxStamina > 0) || !Number.isFinite(sprintStamina)) return false;
  return sprintStamina >= maxStamina * FLOAT_WALL_DUCK_STAMINA_FRAC;
}

/** True when a crouch press now would start a slide (sim stamina gate). */
export function canSlideFromStamina(
  sprintStamina: number,
  maxStamina: number = SPRINT_DURATION_S,
): boolean {
  if (!(maxStamina > 0) || !Number.isFinite(sprintStamina)) return false;
  return sprintStamina >= maxStamina * SLIDE_STAMINA_COST;
}

/**
 * Multiplier for duck timers: 1 when the duck will slide, else
 * {@link FLOAT_WALL_DUCK_CRAWL_TIME_SCALE} for a crouch-walk transit.
 */
export function floatWallDuckTimeScale(
  sprintStamina: number,
  maxStamina: number = SPRINT_DURATION_S,
): number {
  return canSlideFromStamina(sprintStamina, maxStamina)
    ? 1
    : FLOAT_WALL_DUCK_CRAWL_TIME_SCALE;
}

/**
 * Probe distance from remaining sprint energy — longer when the bar is ≥ 30%.
 * Does not use sprint key / brain sprint config.
 */
export function floatWallDuckProbeDist(
  sprintStamina: number,
  maxStamina: number = SPRINT_DURATION_S,
): number {
  return canSprintFromStamina(sprintStamina, maxStamina)
    ? FLOAT_WALL_DUCK_PROBE_FRESH
    : FLOAT_WALL_DUCK_PROBE_TIRED;
}

/**
 * True when any sample along `yaw` out to `maxDist` is a crouchable float.
 * Multi-sample so a close bot with a long sprint probe still sees the slab
 * (a single far sample can land past a thin wall and read clear).
 */
export function isCrouchableWithin(
  collision: MapCollision,
  x: number,
  z: number,
  yaw: number,
  maxDist: number,
): boolean {
  if (!(maxDist > 0)) return false;
  const step = min(0.2, maxDist);
  for (let d = step; d <= maxDist + 1e-6; d += step) {
    if (collision.classifyForward(x, z, yaw, d) === "crouchable") return true;
  }
  return collision.classifyForward(x, z, yaw, maxDist) === "crouchable";
}

/**
 * First non-clear obstacle along yaw (dense samples). Used so we only start a
 * duck when the path's first hit is crouchable — not a full wall with a side float.
 */
export function firstObstacleAlongDesired(
  collision: MapCollision,
  x: number,
  z: number,
  yaw: number,
  maxDist = 4.0,
): { kind: "blocked" | "crouchable" | "jumpable"; dist: number } | null {
  for (let d = 0.35; d <= maxDist + 1e-6; d += 0.3) {
    const kind = collision.classifyForward(x, z, yaw, d);
    if (kind === "blocked" || kind === "crouchable" || kind === "jumpable") {
      return { kind, dist: d };
    }
  }
  return null;
}

/**
 * Standing head blocked but crouch silhouette free at (x, z).
 * Must keep crouch held while true or the body pins under the slab.
 */
export function isUnderFloatSlab(
  collision: MapCollision,
  x: number,
  z: number,
): boolean {
  return (
    !collision.hasHeadroom(x, z, 0, STAND_COLLISION_HEIGHT) &&
    collision.hasHeadroom(x, z, 0, CROUCH_COLLISION_HEIGHT)
  );
}

/**
 * Face yaw into a nearby float (standing blocked, crouch free).
 * Prefer path-aligned commits; this remains for diagnostics / look cosmetics.
 */
export function estimateFloatWallFaceYaw(
  collision: MapCollision,
  x: number,
  z: number,
  seedYaw: number,
): number | null {
  const offsets = [
    0,
    0.15,
    -0.15,
    0.3,
    -0.3,
    0.5,
    -0.5,
    0.75,
    -0.75,
    1.0,
    -1.0,
    HALF_PI,
    -HALF_PI,
  ];
  const dists = [0.2, 0.4, 0.6, 0.85, 1.1, 1.4] as const;
  let bestFace: number | null = null;
  let bestScore = Infinity;
  for (const off of offsets) {
    const yaw = seedYaw + off;
    for (const dist of dists) {
      if (collision.classifyForward(x, z, yaw, dist) !== "crouchable") {
        continue;
      }
      const face = faceYawFromCrouchableProbe(collision, x, z, yaw, dist);
      if (face === null) continue;
      // Prefer faces near the seed (path) so side arms lose to path floats.
      const score = dist + yawAbsDelta(yaw, seedYaw) * 0.55 +
        yawAbsDelta(face, seedYaw) * 0.35;
      if (score < bestScore) {
        bestScore = score;
        bestFace = face;
      }
      break;
    }
  }
  return bestFace;
}

function faceYawFromCrouchableProbe(
  collision: MapCollision,
  x: number,
  z: number,
  yaw: number,
  dist: number,
): number | null {
  const direction = fastSinCos(yaw);
  const tx = x - direction.sin * dist;
  const tz = z - direction.cos * dist;
  const resolved = collision.resolvePosition(
    tx,
    tz,
    PLAYER_RADIUS,
    0,
    STAND_COLLISION_HEIGHT,
  );
  const ox = resolved.x - tx;
  const oz = resolved.z - tz;
  if (distanceSquared2(ox, oz) < 1e-8) {
    return null;
  }
  return fastAtan2(ox, oz);
}

/**
 * True when a full wall (`blocked`) lies within `maxDist` of (x, z) in any
 * direction — multi-ray ring. Kept for diagnostics; option pick no longer
 * forces head-on solely from this.
 */
export function isFullWallNear(
  collision: MapCollision,
  x: number,
  z: number,
  maxDist: number = FLOAT_WALL_DUCK_FULL_WALL_NEAR,
): boolean {
  if (!(maxDist > 0)) return false;
  const dirs = 16;
  const step = min(0.25, maxDist);
  for (let i = 0; i < dirs; i++) {
    const yaw = (i / dirs) * TWO_PI;
    for (let d = step; d <= maxDist + 1e-6; d += step) {
      if (collision.classifyForward(x, z, yaw, d) === "blocked") return true;
    }
  }
  return false;
}

/**
 * Distance along yaw until standing headroom returns (crouch path must stay
 * walkable). Null if none within probe max — bad exit direction.
 */
export function distToStandingHeadroom(
  collision: MapCollision,
  x: number,
  z: number,
  yaw: number,
): number | null {
  const direction = fastSinCos(yaw);
  for (
    let d = FLOAT_EXIT_PROBE_STEP;
    d <= FLOAT_EXIT_PROBE_MAX + 1e-6;
    d += FLOAT_EXIT_PROBE_STEP
  ) {
    const tx = x - direction.sin * d;
    const tz = z - direction.cos * d;
    if (!collision.hasHeadroom(tx, tz, 0, CROUCH_COLLISION_HEIGHT)) {
      return null;
    }
    if (collision.hasHeadroom(tx, tz, 0, STAND_COLLISION_HEIGHT)) {
      return d;
    }
  }
  return null;
}

/**
 * Pick a yaw that leaves overhead soonest. Biases toward preferredYaw when
 * several exits are similarly short.
 *
 * With `forwardOnly`, exits within 90° of preferredYaw win over any backward
 * exit (falls back to the shortest overall when none exists). A crouch-walk
 * that re-picks the shortest exit each think backs out, re-enters on the next
 * approach, and flips look/keys between path and exit.
 */
export function findFloatExitYaw(
  collision: MapCollision,
  x: number,
  z: number,
  preferredYaw: number,
  commitYaw?: number,
  forwardOnly = false,
): number {
  const offsets = [
    0,
    0.25,
    -0.25,
    0.5,
    -0.5,
    0.85,
    -0.85,
    1.2,
    -1.2,
    HALF_PI,
    -HALF_PI,
    PI,
  ] as const;

  let bestYaw = preferredYaw;
  let bestScore = Number.POSITIVE_INFINITY;
  let bestForwardYaw = preferredYaw;
  let bestForwardScore = Number.POSITIVE_INFINITY;

  const consider = (yaw: number) => {
    const dist = distToStandingHeadroom(collision, x, z, yaw);
    if (dist === null) return;
    const prefDelta = yawAbsDelta(yaw, preferredYaw);
    const prefBias = prefDelta * 0.15;
    const commitBias = typeof commitYaw === "number"
      ? yawAbsDelta(yaw, commitYaw) * 0.05
      : 0;
    const score = dist + prefBias + commitBias;
    if (score < bestScore) {
      bestScore = score;
      bestYaw = yaw;
    }
    if (prefDelta <= HALF_PI + 1e-6 && score < bestForwardScore) {
      bestForwardScore = score;
      bestForwardYaw = yaw;
    }
  };

  consider(preferredYaw);
  if (typeof commitYaw === "number") consider(commitYaw);
  for (const offset of offsets) {
    consider(preferredYaw + offset);
  }

  if (forwardOnly && bestForwardScore < Number.POSITIVE_INFINITY) {
    return bestForwardYaw;
  }
  return bestYaw;
}

/**
 * Pick option index from desired-vs-face bands (same as half-wall vault).
 *
 * A/D sides collapse to head-on W only when that *side* has a wall within
 * half-wall side-clear distance — not when any full wall is in a ring
 * (ring-force walked Crossroads bots into the spine).
 */
export function pickFloatWallDuckOption(
  faceYaw: number,
  desiredYaw: number,
  opts?: {
    x: number;
    z: number;
    collision: MapCollision;
  },
): number {
  return pickHalfWallVaultOption(faceYaw, desiredYaw, opts);
}

function emitOption(
  faceYaw: number,
  optionIndex: number,
  ticksLeft: number,
  extra?: Partial<FloatWallDuckState>,
): FloatWallDuckResult {
  const opt = FLOAT_WALL_DUCK_OPTIONS[
    clamp(optionIndex, 0, FLOAT_WALL_DUCK_OPTIONS.length - 1)
  ]!;
  return {
    active: true,
    faceYaw,
    forward: opt.keys.forward,
    left: opt.keys.left,
    right: opt.keys.right,
    crouch: true,
    statePatch: {
      ...extra,
      floatWallDuckTicksLeft: ticksLeft,
      floatWallDuckFaceYaw: faceYaw,
      floatWallDuckOption: optionIndex,
    },
  };
}

/** Pure forward crouch along `faceYaw` (under-slab exit / path head-on). */
function emitForward(
  faceYaw: number,
  ticksLeft: number,
  extra?: Partial<FloatWallDuckState>,
): FloatWallDuckResult {
  return emitOption(faceYaw, FLOAT_WALL_DUCK_HEAD_ON_OPTION, ticksLeft, extra);
}

function dormant(
  clear = true,
  opts?: { cooldownUntilTick?: number },
): FloatWallDuckResult {
  return {
    active: false,
    statePatch: clear ? clearFloatWallDuckState({}, opts) : {},
  };
}

function progressStalled(
  state: FloatWallDuckState,
  x: number,
  z: number,
  elapsed: number,
): boolean {
  if (elapsed < FLOAT_WALL_DUCK_PROGRESS_CHECK_TICKS) return false;
  const sx = state.floatWallDuckStartX;
  const sz = state.floatWallDuckStartZ;
  if (typeof sx !== "number" || typeof sz !== "number") return false;
  return distanceSquared2(x - sx, z - sz) <
    FLOAT_WALL_DUCK_MIN_PROGRESS * FLOAT_WALL_DUCK_MIN_PROGRESS;
}

function underSlabMoveYaw(
  collision: MapCollision,
  x: number,
  z: number,
  preferredYaw: number,
  commitYaw: number | undefined,
  elapsed: number,
  timeScale: number,
): number {
  const step = 0.45;
  const direction = fastSinCos(preferredYaw);
  const prefX = x - direction.sin * step;
  const prefZ = z - direction.cos * step;
  const preferredCrouchOk = collision.hasHeadroom(
    prefX,
    prefZ,
    0,
    CROUCH_COLLISION_HEIGHT,
  );
  const prefExitDist = distToStandingHeadroom(collision, x, z, preferredYaw);
  const preferredClearsSoon = preferredCrouchOk &&
    prefExitDist !== null &&
    prefExitDist <= FLOAT_PREFERRED_EXIT_MAX;
  const forceExit = !preferredClearsSoon ||
    elapsed >= FLOAT_WALL_DUCK_FORCE_EXIT_TICKS * timeScale ||
    elapsed >= FLOAT_WALL_DUCK_MAX_TICKS * timeScale;
  if (!forceExit) return preferredYaw;
  // Crouch-walk: keep transiting forward until the hard cap, then take the
  // shortest way out. A slide clears before this matters.
  const forwardOnly = timeScale > 1 && elapsed < FLOAT_WALL_DUCK_MAX_TICKS * timeScale;
  return findFloatExitYaw(collision, x, z, preferredYaw, commitYaw, forwardOnly);
}

/**
 * Pure float-duck step for one think.
 *
 * - If `vaultActive`: always dormant (jump owns mobility).
 * - If under a float slab: crouch + steer to standing headroom (never release).
 * - While commit ticks remain: keep path-aligned face + crouch + keys; abort
 *   on zero progress.
 * - Else: if crouchable float is the first obstacle on desired yaw within
 *   stamina probe, start a path-aligned commit.
 * - Else: dormant pass-through.
 */
export function stepFloatWallDuck(input: {
  x: number;
  z: number;
  desiredYaw: number;
  /**
   * Remaining sprint stamina (seconds of bar). Selects 1u vs 2u probe when
   * ≥ 30% of a full bar — ability to sprint, not sprint intent.
   */
  sprintStamina: number;
  /** Full bar capacity (defaults to {@link SPRINT_DURATION_S}). */
  maxSprintStamina?: number;
  /**
   * When true (half-wall vault active / jump commit), this step never starts
   * and clears any leftover duck state.
   */
  vaultActive: boolean;
  collision?: MapCollision | null;
  simDelta: number;
  /** Live sim tick — used for abort cooldown. */
  tick?: number;
  state: FloatWallDuckState;
}): FloatWallDuckResult {
  const {
    x,
    z,
    desiredYaw,
    sprintStamina,
    vaultActive,
    collision,
    state,
  } = input;
  const maxSprintStamina = input.maxSprintStamina ?? SPRINT_DURATION_S;
  const simDelta =
    typeof input.simDelta === "number" && Number.isFinite(input.simDelta) &&
      input.simDelta > 0
      ? input.simDelta
      : 1;
  const tick = typeof input.tick === "number" && Number.isFinite(input.tick)
    ? input.tick
    : 0;

  if (vaultActive) {
    return dormant(true);
  }

  // Crouch-walk (no slide stamina) needs longer timers than a slide.
  const timeScale = floatWallDuckTimeScale(sprintStamina, maxSprintStamina);
  const maxTicks = FLOAT_WALL_DUCK_MAX_TICKS * timeScale;

  // --- under-slab: always own crouch + exit (even mid-cooldown) ---
  if (collision && isUnderFloatSlab(collision, x, z)) {
    const elapsed = (state.floatWallDuckElapsed ?? 0) + simDelta;
    const commitYaw = typeof state.floatWallDuckFaceYaw === "number"
      ? state.floatWallDuckFaceYaw
      : undefined;
    const moveYaw = underSlabMoveYaw(
      collision,
      x,
      z,
      desiredYaw,
      commitYaw,
      elapsed,
      timeScale,
    );
    // Keep a short commit pulse so consecutive thinks stay "active".
    const ticksLeft = elapsed >= maxTicks
      ? msToTicks(100)
      : max(msToTicks(150), state.floatWallDuckTicksLeft ?? 0);
    return emitForward(moveYaw, ticksLeft, {
      floatWallDuckStartX: state.floatWallDuckStartX ?? x,
      floatWallDuckStartZ: state.floatWallDuckStartZ ?? z,
      floatWallDuckElapsed: elapsed,
      floatWallDuckCooldownUntilTick: undefined,
    });
  }

  const ticksLeft = state.floatWallDuckTicksLeft ?? 0;
  const storedFace = state.floatWallDuckFaceYaw;
  const storedOpt = state.floatWallDuckOption;
  const elapsedPrev = state.floatWallDuckElapsed ?? 0;

  // --- active approach commit ---
  if (
    ticksLeft > 0 &&
    typeof storedFace === "number" &&
    Number.isFinite(storedFace) &&
    typeof storedOpt === "number"
  ) {
    const elapsed = elapsedPrev + simDelta;

    // Zero progress into a wall: abort + cooldown (Crossroads spine thrash).
    if (progressStalled(state, x, z, elapsed)) {
      return dormant(true, {
        cooldownUntilTick: tick + FLOAT_WALL_DUCK_ABORT_COOLDOWN_TICKS,
      });
    }

    // Hard elapsed cap while off-slab.
    if (elapsed >= maxTicks) {
      return dormant(true, {
        cooldownUntilTick: tick + FLOAT_WALL_DUCK_ABORT_COOLDOWN_TICKS,
      });
    }

    const next = ticksLeft - simDelta;
    if (next <= 0) {
      // Timer done off-slab: clear. Re-trigger next think only if still needed.
      return dormant(true);
    }

    // Path still has crouchable ahead: brief refresh so thin slabs don't drop
    // crouch mid-pass. Do not refresh into a full wall face.
    let refresh = next;
    if (collision) {
      const first = firstObstacleAlongDesired(collision, x, z, storedFace, 3.0);
      if (first?.kind === "crouchable" && elapsed < maxTicks) {
        refresh = max(next, msToTicks(200));
      }
      // Cleared: free standing path ahead → stand.
      if (
        first === null ||
        (first.kind !== "crouchable" &&
          collision.classifyForward(x, z, storedFace, 0.55) === "clear")
      ) {
        // Still hold remaining ticks only if very early (entry edge); else done.
        if (elapsed >= msToTicks(200) && first?.kind !== "crouchable") {
          return dormant(true);
        }
      }
    }

    return emitOption(storedFace, storedOpt, refresh, {
      floatWallDuckStartX: state.floatWallDuckStartX,
      floatWallDuckStartZ: state.floatWallDuckStartZ,
      floatWallDuckElapsed: elapsed,
      floatWallDuckCooldownUntilTick: state.floatWallDuckCooldownUntilTick,
    });
  }

  // --- dormant: maybe trigger ---
  if (!collision) return dormant(true);

  // Abort cooldown (off-slab only — under handled above).
  if (
    typeof state.floatWallDuckCooldownUntilTick === "number" &&
    tick < state.floatWallDuckCooldownUntilTick
  ) {
    return {
      active: false,
      statePatch: {
        floatWallDuckCooldownUntilTick: state.floatWallDuckCooldownUntilTick,
      },
    };
  }

  // Full wall first on preferred: do not start a side-float dive.
  const firstObs = firstObstacleAlongDesired(collision, x, z, desiredYaw, 4.0);
  if (firstObs?.kind === "blocked") {
    return dormant(true);
  }

  const probe = floatWallDuckProbeDist(sprintStamina, maxSprintStamina);
  if (!isCrouchableWithin(collision, x, z, desiredYaw, probe)) {
    return dormant(true);
  }
  // Require the path's first obstacle to be crouchable (not jumpable-only).
  if (firstObs && firstObs.kind !== "crouchable") {
    return dormant(true);
  }

  // Path-aligned face: drive through along desired, not into nearest side arm.
  const face = desiredYaw;
  const option = pickFloatWallDuckOption(face, desiredYaw, {
    x,
    z,
    collision,
  });
  // If the chosen side is blocked, pickHalfWall already forced head-on.
  // Extra: if pure head-on still walks into blocked within 0.55, refuse — path
  // is not a crouch corridor from here (corner of Crossroads +).
  if (option === FLOAT_WALL_DUCK_HEAD_ON_OPTION) {
    const nose = collision.classifyForward(x, z, face, 0.55);
    if (nose === "blocked") {
      return dormant(true, {
        cooldownUntilTick: tick + FLOAT_WALL_DUCK_ABORT_COOLDOWN_TICKS,
      });
    }
  }

  return emitOption(face, option, FLOAT_WALL_DUCK_COMMIT_TICKS * timeScale, {
    floatWallDuckStartX: x,
    floatWallDuckStartZ: z,
    floatWallDuckElapsed: 0,
    floatWallDuckCooldownUntilTick: undefined,
  });
}

/** Whether duck/under-slab must keep mobility (combat must not plant still). */
export function floatDuckBlocksStandStill(
  state: FloatWallDuckState,
  collision: MapCollision | null | undefined,
  x: number,
  z: number,
): boolean {
  if ((state.floatWallDuckTicksLeft ?? 0) > 0) return true;
  if (collision && isUnderFloatSlab(collision, x, z)) return true;
  return false;
}

// Re-export sideWallWithin for tests that assert side-clear behavior.
export { sideWallWithin };
