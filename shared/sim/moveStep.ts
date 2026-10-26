/**
 * Shared movement step — single source of truth for server sim + client
 * prediction / input replay (rubberbanding Phase 2 — A1 / A5).
 *
 * Deterministic contract:
 * - the authoritative server calls this once per simulation tick;
 * - the caller supplies the fixed {@link DT}, never a wall-clock delta;
 * - the only world queries are through {@link MoveCollision}; and
 * - the function has no networking, rendering, weapons, or bot-AI side effects.
 *
 * Given the same state, input, collision responses, and options, this function
 * returns the same next state. It does not mutate the input or state objects.
 */

import {
  jumpStaminaCostSeconds,
  MELEE_LUNGE_DURATION_S,
  moveSpeedForInput,
  SLIDE_DURATION_S,
  slideStaminaCostSeconds,
  SPRINT_DURATION_S,
  sprintDrainPerSecond,
  sprintRegenPerSecond,
} from "./game.ts";
import { distance2, fastCos, fastSin, floor, max, min } from "../math/index.ts";
import {
  PLAYER_CROUCH_VISOR_CENTER_Y,
  PLAYER_VISOR_CENTER_Y,
} from "./playerModelDimensions.ts";

/** Gravity (u/s²). Peak feet ≈ JUMP_VELOCITY²/(2·g). */
export const MOVE_GRAVITY = 20;
/**
 * Jump impulse — must clear half-walls (1.2): 8.25 → ~1.70m apex
 * (10% higher impulse than the former 7.5 / ~1.41m).
 */
export const MOVE_JUMP_VELOCITY = 8.25;

/** Standing eye height — camera / pose y sits at the visor center. */
export const MOVE_STAND_EYE = PLAYER_VISOR_CENTER_Y;
/**
 * Crouch / slide eye height. First-person matches other players' visors —
 * do not couple this to collision height (that one is taller so the capsule
 * fits under floats).
 */
export const MOVE_CROUCH_EYE = PLAYER_CROUCH_VISOR_CENTER_Y;

/** Standing vertical collision silhouette from feet. */
export const MOVE_STAND_COLLISION_H = 1.7;
/**
 * Crouch / slide vertical collision from feet.
 * Must stay 0.1u under FLOAT_WALL_Y_MIN (1.4) so crouch/slide fits
 * the tunnel. Taller than the visual / hitscan crouch on purpose.
 */
export const MOVE_CROUCH_COLLISION_H = 1.3;

export function moveEyeHeight(crouch: boolean): number {
  return crouch ? MOVE_CROUCH_EYE : MOVE_STAND_EYE;
}

export function moveCollisionHeight(crouch: boolean): number {
  return crouch ? MOVE_CROUCH_COLLISION_H : MOVE_STAND_COLLISION_H;
}

/**
 * Keep feet planted while swapping stance. Used when authority Y was sampled
 * at a different crouch flag than local prediction — writing that Y raw onto
 * a crouched sim leaves the camera at standing eye, then gravity drops it
 * for ~0.26s every time a snapshot restamps it.
 */
export function retargetEyeY(
  eyeY: number,
  fromCrouch: boolean,
  toCrouch: boolean,
): number {
  if (fromCrouch === toCrouch) return eyeY;
  return eyeY - moveEyeHeight(fromCrouch) + moveEyeHeight(toCrouch);
}

/**
 * Minimal collision surface used by the step (client + server MapCollision).
 *
 * This is the complete collision boundary for player mobility. Adding a new
 * simulation-visible world query requires extending this interface explicitly;
 * callers must not reach through it to inspect MapCollision implementation
 * details.
 */
export type MoveCollision = {
  resolvePosition(
    x: number,
    z: number,
    radius?: number,
    feetY?: number,
    headY?: number,
  ): { x: number; z: number };
  hasHeadroom(
    x: number,
    z: number,
    feetY?: number,
    headY?: number,
    radius?: number,
  ): boolean;
  /** Optional elevated floor used by local set dressing such as platforms. */
  floorYAt?: (x: number, z: number) => number | null;
  /** Optional low ceiling used by local set dressing. */
  ceilingYAt?: (x: number, z: number) => number | null;
};

/**
 * Boolean WASD + stance intent (matches wire PlayerInput without sequence).
 *
 * The input is the frame selected for this simulation tick. `yaw` is consumed
 * as an authoritative direct look value; rotation is not integrated here.
 * Tick association and packet sequencing belong to the input boundary outside
 * this pure movement function.
 */
export type MoveInput = {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  /** One-shot: applied once while on ground. */
  jump: boolean;
  sprint: boolean;
  crouch: boolean;
  /**
   * One-shot: standing melee lunge. Same stamina cost / forward-ish / ground
   * gates as crouch-slide, but does not force crouch.
   */
  meleeLunge?: boolean;
  yaw: number;
};

/**
 * Full mobility pose carried across steps (prediction + server).
 *
 * This is the movement portion of the authoritative state surface. It excludes
 * network sequence numbers and presentation-only values; those belong to the
 * caller's input/state boundary.
 */
export type MoveState = {
  x: number;
  y: number;
  z: number;
  velocityY: number;
  onGround: boolean;
  crouch: boolean;
  sprintStamina: number;
  slideRemaining: number;
  slideDirX: number;
  slideDirZ: number;
  /**
   * When a move burst is active, whether crouch is forced (crouch-slide)
   * or stance follows the key (melee lunge).
   */
  slideForceCrouch: boolean;
  /** Previous step's crouch key — rising-edge slide detect. */
  prevInputCrouch: boolean;
};

export type MoveStepOptions = {
  /**
   * Integration step (seconds). The server must pass the shared fixed `DT`
   * for every tick; this must never be derived from wall-clock elapsed time.
   */
  dt: number;
  /** Equipped weapon horizontal mult (default 1). */
  weaponMoveMult?: number;
  /** Bot / status scale on top of weapon mult (default 1). */
  moveSpeedScale?: number;
  /**
   * When true (Quick ability), skip all stamina *spend*: continuous sprint
   * drain, slide start cost, and jump cost. Slide still requires the usual
   * stamina threshold to *start*; regen still runs when not sprinting.
   */
  stallStaminaSpend?: boolean;
};

export type MoveStepResult = {
  state: MoveState;
  /** True if a jump impulse was applied this step. */
  jumped: boolean;
  /** True if a crouch-slide burst started this step. */
  slideStarted: boolean;
  /** True if a standing melee lunge burst started this step. */
  meleeLungeStarted: boolean;
};

/** Empty open map collision (tests / free-space parity). */
export const NO_COLLISION: MoveCollision = {
  resolvePosition(x, z) {
    return { x, z };
  },
  hasHeadroom() {
    return true;
  },
};

/**
 * Player body radius for blink / resolve — matches server/client MapCollision.
 */
export const MOVE_PLAYER_RADIUS = 0.35;

/**
 * Max step size for collision-swept blink (must stay ≤ wall thickness margin).
 * Smaller = stop closer to walls; larger = cheaper but coarser.
 */
const BLINK_STEP = 0.15;

/**
 * How far resolve may push off the requested sample before we treat the step
 * as blocked (matches MapCollision probeReachable eps).
 */
const BLINK_REACH_EPS = 0.08;

/**
 * Skill F — Teleport: horizontal blink along look yaw (forward = −sin/−cos).
 * Eye height is preserved by the caller (this only moves x/z). Steps along the
 * ray and keeps the last free sample so walls stop the blink rather than
 * free-warping through solids.
 *
 * @returns last free {x,z} (may equal start if fully blocked)
 */
export function blinkAlongYaw(
  collision: MoveCollision,
  x: number,
  z: number,
  yaw: number,
  distance: number,
  feetY = 0,
  headY = feetY + MOVE_STAND_COLLISION_H,
  radius = MOVE_PLAYER_RADIUS,
): { x: number; z: number } {
  if (!(distance > 0) || !Number.isFinite(distance)) return { x, z };
  if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(yaw)) {
    return { x, z };
  }

  const dirX = -fastSin(yaw);
  const dirZ = -fastCos(yaw);
  // Zero-length direction (shouldn't happen with finite yaw).
  if (distance2(dirX, dirZ) < 1e-8) return { x, z };

  let cx = x;
  let cz = z;
  let remaining = distance;

  while (remaining > 1e-6) {
    const step = min(BLINK_STEP, remaining);
    const wantX = cx + dirX * step;
    const wantZ = cz + dirZ * step;
    const got = collision.resolvePosition(wantX, wantZ, radius, feetY, headY);
    // Blocked or slid off the intended sample — stop at last free point.
    if (distance2(got.x - wantX, got.z - wantZ) > BLINK_REACH_EPS) {
      break;
    }
    // No progress (flush against solid).
    if (distance2(got.x - cx, got.z - cz) < 1e-5) {
      break;
    }
    cx = got.x;
    cz = got.z;
    remaining -= step;
  }

  return { x: cx, z: cz };
}

export function createMoveState(
  partial?: Partial<MoveState>,
): MoveState {
  return {
    x: partial?.x ?? 0,
    y: partial?.y ?? MOVE_STAND_EYE,
    z: partial?.z ?? 0,
    velocityY: partial?.velocityY ?? 0,
    onGround: partial?.onGround ?? true,
    crouch: partial?.crouch ?? false,
    sprintStamina: partial?.sprintStamina ?? SPRINT_DURATION_S,
    slideRemaining: partial?.slideRemaining ?? 0,
    slideDirX: partial?.slideDirX ?? 0,
    slideDirZ: partial?.slideDirZ ?? 0,
    slideForceCrouch: partial?.slideForceCrouch ?? false,
    prevInputCrouch: partial?.prevInputCrouch ?? false,
  };
}

function clearSlide(s: MoveState): void {
  s.slideRemaining = 0;
  s.slideDirX = 0;
  s.slideDirZ = 0;
  s.slideForceCrouch = false;
}

/** W/A/D (and forward-strafe diagonals); pure back / back-diagonals never qualify. */
export function isForwardIshMove(
  input: Pick<MoveInput, "forward" | "backward" | "left" | "right">,
): boolean {
  return !input.backward && (input.forward || input.left || input.right);
}

/**
 * Shared eligibility for crouch-slide and melee lunge (before spending).
 * Does not check wish-dir length — caller builds the dir after this passes.
 */
export function canStartMoveBurst(
  s: Pick<MoveState, "slideRemaining" | "onGround" | "sprintStamina">,
  input: Pick<MoveInput, "forward" | "backward" | "left" | "right">,
): boolean {
  if (s.slideRemaining > 0) return false;
  if (!s.onGround) return false;
  if (!isForwardIshMove(input)) return false;
  return s.sprintStamina >= slideStaminaCostSeconds();
}

/**
 * Start a horizontal move burst (crouch-slide or standing melee lunge).
 * Returns true if the burst started.
 */
function tryStartMoveBurst(
  s: MoveState,
  input: MoveInput,
  opts: { forceCrouch: boolean; stallStaminaSpend: boolean },
): boolean {
  if (!canStartMoveBurst(s, input)) return false;
  const sin = fastSin(input.yaw);
  const cos = fastCos(input.yaw);
  // Same WASD basis as normal move; no back contribution (gated above).
  let mx = 0;
  let mz = 0;
  if (input.forward) {
    mx -= sin;
    mz -= cos;
  }
  if (input.left) {
    mx -= cos;
    mz += sin;
  }
  if (input.right) {
    mx += cos;
    mz -= sin;
  }
  const len = distance2(mx, mz);
  if (len <= 1e-6) return false;
  const cost = slideStaminaCostSeconds();
  s.slideDirX = mx / len;
  s.slideDirZ = mz / len;
  s.slideRemaining = opts.forceCrouch
    ? SLIDE_DURATION_S
    : MELEE_LUNGE_DURATION_S;
  s.slideForceCrouch = opts.forceCrouch;
  if (!opts.stallStaminaSpend) {
    s.sprintStamina = max(0, s.sprintStamina - cost);
  }
  return true;
}

/**
 * Advance one movement step. Matches server Player.update mobility (humans).
 * Does not mutate `input` or the incoming `state` object — returns a new state.
 */
export function stepMove(
  stateIn: MoveState,
  input: MoveInput | null,
  collision: MoveCollision,
  opts: MoveStepOptions,
): MoveStepResult {
  const dt = opts.dt > 0 && Number.isFinite(opts.dt) ? opts.dt : 0;
  const weaponMoveMult = opts.weaponMoveMult ?? 1;
  const moveSpeedScale = opts.moveSpeedScale ?? 1;
  const stallStaminaSpend = Boolean(opts.stallStaminaSpend);

  const s: MoveState = {
    x: stateIn.x,
    y: stateIn.y,
    z: stateIn.z,
    velocityY: stateIn.velocityY,
    onGround: stateIn.onGround,
    crouch: stateIn.crouch,
    sprintStamina: stateIn.sprintStamina,
    slideRemaining: stateIn.slideRemaining,
    slideDirX: stateIn.slideDirX,
    slideDirZ: stateIn.slideDirZ,
    slideForceCrouch: stateIn.slideForceCrouch,
    prevInputCrouch: stateIn.prevInputCrouch,
  };

  let jumped = false;
  let slideStarted = false;
  let meleeLungeStarted = false;

  if (input) {
    const wantCrouch = Boolean(input.crouch);
    const crouchRising = wantCrouch && !s.prevInputCrouch;
    s.prevInputCrouch = wantCrouch;

    // Crouch-slide: rising crouch + forward-ish + ground + stamina.
    if (crouchRising) {
      if (
        tryStartMoveBurst(s, input, {
          forceCrouch: true,
          stallStaminaSpend,
        })
      ) {
        slideStarted = true;
      }
    }

    // Melee lunge: same gates/cost as slide, standing (no forced crouch).
    if (input.meleeLunge) {
      if (
        tryStartMoveBurst(s, input, {
          forceCrouch: false,
          stallStaminaSpend,
        })
      ) {
        meleeLungeStarted = true;
      }
    }

    // Crouch-slide forces crouch for the burst; melee lunge keeps stance.
    let nextCrouch = wantCrouch;
    if (s.slideRemaining > 0 && s.slideForceCrouch) {
      nextCrouch = true;
    }
    // Block stand-up under floating walls (or any low overhead solid).
    if (
      s.crouch &&
      !nextCrouch &&
      !collision.hasHeadroom(
        s.x,
        s.z,
        max(0, s.y - moveEyeHeight(true)),
        max(0, s.y - moveEyeHeight(true)) + MOVE_STAND_COLLISION_H,
      )
    ) {
      nextCrouch = true;
    }
    if (nextCrouch !== s.crouch) {
      // Keep feet fixed when ducking / standing.
      s.y += moveEyeHeight(nextCrouch) - moveEyeHeight(s.crouch);
      s.crouch = nextCrouch;
    }

    const sin = fastSin(input.yaw);
    const cos = fastCos(input.yaw);
    let mx = 0;
    let mz = 0;

    if (input.forward) {
      mx -= sin;
      mz -= cos;
    }
    if (input.backward) {
      mx += sin;
      mz += cos;
    }
    if (input.left) {
      mx -= cos;
      mz += sin;
    }
    if (input.right) {
      mx += cos;
      mz -= sin;
    }

    const len = distance2(mx, mz);
    const sliding = s.slideRemaining > 0;
    const wantsSprint = Boolean(input.sprint) && !s.crouch && !sliding;
    const canSprint = wantsSprint && s.sprintStamina > 0;
    const effectivelySprinting = canSprint && len > 0;

    if (effectivelySprinting) {
      if (!stallStaminaSpend) {
        s.sprintStamina = max(
          0,
          s.sprintStamina - sprintDrainPerSecond() * dt,
        );
      }
    } else if (!wantsSprint && !sliding && s.onGround) {
      // Cooldown only while grounded, not holding sprint, and not sliding.
      const rate = sprintRegenPerSecond(s.crouch, len > 0);
      s.sprintStamina = min(
        SPRINT_DURATION_S,
        s.sprintStamina + rate * dt,
      );
    }

    if (sliding) {
      const speed = moveSpeedForInput(false, true, weaponMoveMult, true) *
        moveSpeedScale;
      s.x += s.slideDirX * speed * dt;
      s.z += s.slideDirZ * speed * dt;
      s.slideRemaining = max(0, s.slideRemaining - dt);
      if (s.slideRemaining <= 0) {
        clearSlide(s);
        // After slide: stay crouched only if still holding crouch,
        // or if standing would clip a floating wall / overhead solid.
        if (!wantCrouch && s.crouch) {
          const feetY = max(0, s.y - moveEyeHeight(true));
          if (
            collision.hasHeadroom(
              s.x,
              s.z,
              feetY,
              feetY + MOVE_STAND_COLLISION_H,
            )
          ) {
            s.y += moveEyeHeight(false) - moveEyeHeight(true);
            s.crouch = false;
          }
        }
      }
    } else if (len > 0) {
      // Airborne crouch keeps walk speed so half-wall vaults still clear.
      const speed = moveSpeedForInput(
        canSprint,
        s.crouch,
        weaponMoveMult,
        false,
        !s.onGround,
      ) * moveSpeedScale;
      const scale = (speed * dt) / len;
      s.x += mx * scale;
      s.z += mz * scale;
    }

    if (input.jump && s.onGround) {
      // Jump always works; energy is only spent (clamped at 0), not required.
      if (!stallStaminaSpend) {
        const jumpCost = jumpStaminaCostSeconds();
        s.sprintStamina = max(0, s.sprintStamina - jumpCost);
      }
      s.velocityY = MOVE_JUMP_VELOCITY;
      s.onGround = false;
      if (s.slideRemaining > 0) clearSlide(s);
      jumped = true;
    }
  } else {
    // Keep the crouch edge while ducked so a dropped packet cannot look like
    // a fresh crouch press (that restarts a 0.4s slide and bobs the camera).
    if (!s.crouch) s.prevInputCrouch = false;
    // No input this tick — standing still for regen purposes.
    if (s.slideRemaining > 0) {
      // Commit slide even if input drops mid-burst.
      const speed = moveSpeedForInput(false, true, weaponMoveMult, true) *
        moveSpeedScale;
      s.x += s.slideDirX * speed * dt;
      s.z += s.slideDirZ * speed * dt;
      s.slideRemaining = max(0, s.slideRemaining - dt);
      if (s.slideRemaining <= 0) {
        clearSlide(s);
        // Stay crouched until a real input frame says to stand. Auto-standing
        // here fought held crouch on the next packet (0.4s up / 0.4s down).
      } else if (!s.crouch) {
        s.y += moveEyeHeight(true) - moveEyeHeight(false);
        s.crouch = true;
      }
    }
    // No regen mid-slide or mid-jump even if input drops for a tick.
    if (s.slideRemaining <= 0 && s.onGround) {
      const rate = sprintRegenPerSecond(s.crouch, false);
      s.sprintStamina = min(
        SPRINT_DURATION_S,
        s.sprintStamina + rate * dt,
      );
    }
  }

  const groundEye = moveEyeHeight(s.crouch);
  s.velocityY -= MOVE_GRAVITY * dt;
  s.y += s.velocityY * dt;
  const elevatedFloorY = max(0, collision.floorYAt?.(s.x, s.z) ?? 0);
  const standFeetY = s.y - moveEyeHeight(false);
  // Crouch flag with standing-eye Y (repredict / seed mismatch): snap to
  // crouch eye instead of falling ~0.26s from stand height every restamp.
  // Only while already grounded — a crouch-jump apex has vy≈0 and must fall.
  if (
    s.crouch &&
    s.onGround &&
    s.velocityY <= 0 &&
    standFeetY <= elevatedFloorY + 0.05
  ) {
    s.y = elevatedFloorY + groundEye;
    s.velocityY = 0;
    s.onGround = true;
  } else if (s.velocityY <= 0 && s.y <= elevatedFloorY + groundEye) {
    s.y = elevatedFloorY + groundEye;
    s.velocityY = 0;
    s.onGround = true;
  } else if (s.y <= groundEye) {
    s.y = groundEye;
    s.velocityY = 0;
    s.onGround = true;
  } else {
    s.onGround = false;
  }

  const ceilingY = collision.ceilingYAt?.(s.x, s.z);
  if (ceilingY !== null && ceilingY !== undefined) {
    const headY = s.y - groundEye + moveCollisionHeight(s.crouch);
    if (headY > ceilingY) {
      s.y = ceilingY - moveCollisionHeight(s.crouch) + groundEye;
      if (s.velocityY > 0) s.velocityY = 0;
    }
  }

  // Horizontal collision after vertical so jump apex can clear half-walls.
  const feetY = max(0, s.y - groundEye);
  const headY = feetY + moveCollisionHeight(s.crouch);
  const resolved = collision.resolvePosition(s.x, s.z, undefined, feetY, headY);
  s.x = resolved.x;
  s.z = resolved.z;

  return { state: s, jumped, slideStarted, meleeLungeStarted };
}

/**
 * Run `count` fixed steps with the same input (jump / melee lunge only on
 * the first step). Used by input-replay: each 20 Hz packet spans
 * ~TICK_HZ/20 sim ticks.
 */
export function stepMoveTicks(
  stateIn: MoveState,
  input: MoveInput | null,
  collision: MoveCollision,
  opts: MoveStepOptions & { ticks: number },
): MoveState {
  const ticks = max(0, floor(opts.ticks));
  let state = stateIn;
  let jump = input?.jump ?? false;
  let meleeLunge = Boolean(input?.meleeLunge);
  for (let i = 0; i < ticks; i++) {
    const frame: MoveInput | null = input
      ? {
        ...input,
        jump: jump && i === 0,
        meleeLunge: meleeLunge && i === 0,
      }
      : null;
    const { state: next, jumped, meleeLungeStarted } = stepMove(
      state,
      frame,
      collision,
      opts,
    );
    state = next;
    if (jumped) jump = false;
    if (meleeLungeStarted) meleeLunge = false;
  }
  return state;
}
