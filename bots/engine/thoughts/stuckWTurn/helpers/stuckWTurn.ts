/**
 * Pure stuck-while-intending-to-move protection (think-pipe after navigate).
 *
 * When the bot intends locomotion (any WASD) but tick-to-tick speed stays
 * under {@link STUCK_MOVE_EPS} for ~1.8s, start a short peel commit: face a
 * detour yaw and walk it. After the commit, standard ops re-engage with a
 * new look FOV so path / combat re-sample.
 */

import { msToTicks } from "../../../shared/network.ts";
import { STUCK_MOVE_EPS } from "../../../helpers/nav.ts";
import { distanceSquared2, HALF_PI } from "../../../math/index.ts";

/** Continuous move-intent + no speed longer than this → commit. */
export const STUCK_W_WINDOW_TICKS = msToTicks(1800);

/**
 * Per-sim-tick speed below which the window accumulates.
 * Same as nav {@link STUCK_MOVE_EPS} so audit stuck and this peel agree.
 */
export const STUCK_W_SPEED_EPS = STUCK_MOVE_EPS;

/** How long to hold the peel after trigger (~600ms). */
export const STUCK_W_COMMIT_TICKS = msToTicks(600);

/** Refuse re-arm until this many sim ticks after a commit ends. */
export const STUCK_W_COOLDOWN_TICKS = msToTicks(1000);

/** Opaque brain-state fields for watch + peel commit. */
export type StuckWTurnState = {
  /** Pose at the previous think (speed sample). */
  stuckWLastX?: number;
  stuckWLastZ?: number;
  /** Sim ticks accumulated while intending move and under speed eps. */
  stuckWElapsed?: number;
  /** Sim ticks left in the peel commit. */
  stuckWTurnTicksLeft?: number;
  /** Latched look / move yaw for the commit. */
  stuckWTurnFaceYaw?: number;
  /** Sim tick until which new windows are refused. */
  stuckWCooldownUntilTick?: number;
};

export type StuckWTurnResult = {
  active: boolean;
  /** Look + walk yaw while commit is active. */
  faceYaw?: number;
  /** True on the think that starts a new commit (ban pole / clear sticky). */
  justTriggered?: boolean;
  /** Fields to merge into draft brain state (undefined deletes). */
  statePatch: StuckWTurnState;
};

/** Clear watch + commit (death / finished turn). Keeps cooldown if set. */
export function clearStuckWTurnState(
  _state?: StuckWTurnState,
  opts?: { cooldownUntilTick?: number },
): StuckWTurnState {
  return {
    stuckWLastX: Number.NaN,
    stuckWLastZ: Number.NaN,
    stuckWElapsed: Number.NaN,
    stuckWTurnTicksLeft: Number.NaN,
    stuckWTurnFaceYaw: Number.NaN,
    stuckWCooldownUntilTick:
      typeof opts?.cooldownUntilTick === "number" &&
        Number.isFinite(opts.cooldownUntilTick)
        ? opts.cooldownUntilTick
        : Number.NaN,
  };
}

/** Clear only the watch window (still intending move but progressing). */
export function clearStuckWWatch(state: StuckWTurnState): StuckWTurnState {
  return {
    ...state,
    stuckWLastX: Number.NaN,
    stuckWLastZ: Number.NaN,
    stuckWElapsed: Number.NaN,
  };
}

function normalizeSimDelta(simDelta: number): number {
  return typeof simDelta === "number" && Number.isFinite(simDelta) &&
      simDelta > 0
    ? simDelta
    : 1;
}

/**
 * Pure stuck-speed step for one think.
 *
 * - While commit ticks remain: keep latched face yaw (caller walks W).
 * - Else while intending move under speed eps: accumulate; at window start
 *   commit with `peelYaw` (or yaw ±90° if peel omitted).
 * - Else: clear watch / pass-through.
 */
export function stepStuckWTurn(input: {
  x: number;
  z: number;
  /** Body / eye yaw at think time (fallback peel pivot). */
  yaw: number;
  /**
   * True when ReadyAction intends locomotion (any WASD). Camp plant / idle
   * must be false so intentional holds do not fire.
   */
  holdingW: boolean;
  simDelta: number;
  tick: number;
  state: StuckWTurnState;
  rng: () => number;
  /**
   * Preferred peel yaw (hint stuck disc, or `smartDetourYawOffset` result).
   * Used only on the trigger think. Omit → random ±90° from `yaw`.
   */
  peelYaw?: number;
}): StuckWTurnResult {
  const { x, z, yaw, holdingW, state, rng } = input;
  const simDelta = normalizeSimDelta(input.simDelta);
  const tick = typeof input.tick === "number" && Number.isFinite(input.tick)
    ? input.tick
    : 0;

  const ticksLeft = state.stuckWTurnTicksLeft ?? 0;
  const storedFace = state.stuckWTurnFaceYaw;

  // --- active commit: walk the latched peel ---
  if (
    ticksLeft > 0 &&
    typeof storedFace === "number" &&
    Number.isFinite(storedFace)
  ) {
    const next = ticksLeft - simDelta;
    if (next <= 0) {
      return {
        active: false,
        statePatch: clearStuckWTurnState({}, {
          cooldownUntilTick: tick + STUCK_W_COOLDOWN_TICKS,
        }),
      };
    }
    return {
      active: true,
      faceYaw: storedFace,
      statePatch: {
        stuckWLastX: undefined,
        stuckWLastZ: undefined,
        stuckWElapsed: undefined,
        stuckWTurnTicksLeft: next,
        stuckWTurnFaceYaw: storedFace,
        stuckWCooldownUntilTick: undefined,
      },
    };
  }

  // --- cooldown: no re-arm ---
  if (
    typeof state.stuckWCooldownUntilTick === "number" &&
    tick < state.stuckWCooldownUntilTick
  ) {
    return {
      active: false,
      statePatch: {
        stuckWLastX: undefined,
        stuckWLastZ: undefined,
        stuckWElapsed: undefined,
        stuckWTurnTicksLeft: undefined,
        stuckWTurnFaceYaw: undefined,
        stuckWCooldownUntilTick: state.stuckWCooldownUntilTick,
      },
    };
  }

  // --- not intending move: drop watch ---
  if (!holdingW) {
    return {
      active: false,
      statePatch: {
        stuckWLastX: undefined,
        stuckWLastZ: undefined,
        stuckWElapsed: undefined,
        stuckWTurnTicksLeft: undefined,
        stuckWTurnFaceYaw: undefined,
        stuckWCooldownUntilTick: state.stuckWCooldownUntilTick,
      },
    };
  }

  const lx = state.stuckWLastX;
  const lz = state.stuckWLastZ;
  const hasLast = typeof lx === "number" &&
    Number.isFinite(lx) &&
    typeof lz === "number" &&
    Number.isFinite(lz);

  // First sample of a window.
  if (!hasLast) {
    return {
      active: false,
      statePatch: {
        stuckWLastX: x,
        stuckWLastZ: z,
        stuckWElapsed: 0,
        stuckWTurnTicksLeft: undefined,
        stuckWTurnFaceYaw: undefined,
        stuckWCooldownUntilTick: undefined,
      },
    };
  }

  const speedEps = STUCK_W_SPEED_EPS * simDelta;

  // Made progress this think → reset elapsed, keep sampling from here.
  if (distanceSquared2(x - lx, z - lz) >= speedEps * speedEps) {
    return {
      active: false,
      statePatch: {
        stuckWLastX: x,
        stuckWLastZ: z,
        stuckWElapsed: 0,
        stuckWTurnTicksLeft: undefined,
        stuckWTurnFaceYaw: undefined,
        stuckWCooldownUntilTick: undefined,
      },
    };
  }

  const elapsed = (state.stuckWElapsed ?? 0) + simDelta;

  if (elapsed < STUCK_W_WINDOW_TICKS) {
    return {
      active: false,
      statePatch: {
        stuckWLastX: x,
        stuckWLastZ: z,
        stuckWElapsed: elapsed,
        stuckWTurnTicksLeft: undefined,
        stuckWTurnFaceYaw: undefined,
        stuckWCooldownUntilTick: undefined,
      },
    };
  }

  const peel = input.peelYaw;
  let faceYaw: number;
  if (typeof peel === "number" && Number.isFinite(peel)) {
    faceYaw = peel;
  } else {
    const u = rng();
    const turnLeft = Number.isFinite(u) ? u < 0.5 : true;
    faceYaw = yaw + (turnLeft ? HALF_PI : -HALF_PI);
  }

  return {
    active: true,
    justTriggered: true,
    faceYaw,
    statePatch: {
      stuckWLastX: undefined,
      stuckWLastZ: undefined,
      stuckWElapsed: undefined,
      stuckWTurnTicksLeft: STUCK_W_COMMIT_TICKS,
      stuckWTurnFaceYaw: faceYaw,
      stuckWCooldownUntilTick: undefined,
    },
  };
}
