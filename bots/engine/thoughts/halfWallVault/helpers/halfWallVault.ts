/**
 * Pure half-wall vault assist for bots (think-pipe step after yawIntent).
 *
 * Dormant until a half wall sits within {@link HALF_WALL_VAULT_PROBE} along the
 * desired path (multi-distance samples — not a single nose-on check). Then
 * faces into the wall and picks one of five discrete move options
 * (head-on W / WA·WD / pure A·D) from desired-vs-face angle bands — pure
 * forward covers a wide cone; diagonals and pure strafes only at the edges —
 * holds jump + keys for a commit long enough to clear, and returns to
 * pass-through.
 *
 * Face commit is gated by {@link isJumpableFace}: the first non-clear sample
 * along the estimated face must be jumpable. Sliding along a full wall into a
 * collinear half-wall can see jumpable geometry *ahead* on the desired path
 * while the face still points into the full wall / non-jumpable lip — arming
 * then yaws into the full wall and faceplants. Wait until the face itself is
 * clear to vault (half-wall core).
 *
 * While a commit is active, if the bot lands still blocked by a half-wall,
 * space is re-armed for a short latch so failed first hops can clear.
 *
 * Consecutive vault attempts in the same spot escalate: the 3rd jump within
 * {@link HALF_WALL_VAULT_CONSEC_WINDOW_TICKS} and
 * {@link HALF_WALL_VAULT_CONSEC_AREA} forces a pure head-on forward hop
 * (no strafe) so bots stop side-shimmying at a stuck wall.
 */

import { msToTicks } from "../../../shared/network.ts";
import type { MapCollision } from "../../../world/MapCollision.ts";
import {
  abs,
  clamp,
  HALF_PI,
  max,
  PI,
  QUARTER_PI,
  radians,
  TWO_PI,
} from "../../../math/index.ts";
import { estimateHalfWallFaceYaw } from "../../../helpers/nav.ts";

/**
 * Max look-ahead (world units) along desired yaw for jumpable geometry.
 * Samples are multi-distance up to this range so bots arm before faceplanting
 * (a single 0.2 nose sample was too late and often missed mid-approach).
 */
export const HALF_WALL_VAULT_PROBE = 1.2;

/**
 * Distances sampled when hunting half-walls (near → far). Kept dense so thin
 * slabs are not skipped; max should match {@link HALF_WALL_VAULT_PROBE}.
 */
export const HALF_WALL_VAULT_PROBE_DISTS = [
  0.35,
  0.5,
  0.75,
  0.95,
  1.2,
] as const;

/**
 * If any wall sits within this distance to the player's left (A side) or right
 * (D side) relative to face yaw, skip A/AW or D/DW vaults and hop head-on (W).
 */
export const HALF_WALL_VAULT_SIDE_CLEAR_DIST = 1;

/**
 * Base vault key hold (W / A / D + face). Must cover full jump airtime
 * (~750ms at JUMP_VELOCITY 7.5 / g 20) plus a landing sample — not just the
 * old 500ms hop, which released mid-air and stranded angled approaches.
 */
export const HALF_WALL_VAULT_COMMIT_TICKS = msToTicks(1200);

/**
 * Extra commit ticks for ±45° (W+A / W+D): into-wall speed is ~0.71× walk.
 */
export const HALF_WALL_VAULT_COMMIT_DIAGONAL_EXTRA_TICKS = msToTicks(300);

/**
 * Extra commit ticks for pure ±90° strafe (A / D only): slowest clear path;
 * keep A/D down through a full hop + recovery.
 */
export const HALF_WALL_VAULT_COMMIT_STRAFE_EXTRA_TICKS = msToTicks(500);

/**
 * Hold space this many sim ticks from commit *start* — long enough that
 * think→apply lag does not drop the takeoff edge. Movement keys stay held
 * for the full commit separately.
 */
export const HALF_WALL_VAULT_JUMP_HOLD_TICKS = msToTicks(750);

/**
 * Short space re-arm when landing mid-commit still against a half-wall.
 * Long enough for one think buffer (~150ms) without full bunny-hop spam.
 */
export const HALF_WALL_VAULT_REJUMP_HOLD_TICKS = msToTicks(200);

/**
 * Max gap between vault *starts* to still count as consecutive.
 * Three hops inside this window (same area) force head-on on the third.
 */
export const HALF_WALL_VAULT_CONSEC_WINDOW_TICKS = msToTicks(3000);

/** World-unit radius: attempts farther than this reset the consecutive chain. */
export const HALF_WALL_VAULT_CONSEC_AREA = 2;

/** Attempt count at which option is forced to head-on forward only. */
export const HALF_WALL_VAULT_CONSEC_FORCE_HEAD_ON = 3;

/** Index into {@link HALF_WALL_VAULT_OPTIONS} for pure forward (no strafe). */
export const HALF_WALL_VAULT_HEAD_ON_OPTION = 0;

/** Opaque brain-state fields for an active vault commit + consec chain. */
export type HalfWallVaultState = {
  halfWallVaultTicksLeft?: number;
  halfWallVaultFaceYaw?: number;
  /** Index into {@link HALF_WALL_VAULT_OPTIONS}. */
  halfWallVaultOption?: number;
  /** Sim ticks left forcing jump key high at the start of a commit. */
  halfWallVaultJumpHoldTicksLeft?: number;
  /**
   * Consecutive vault *starts* in the same area / time window.
   * Survives commit clear so the next hop can escalate; cleared on death
   * or when the next start is too far / too late.
   */
  halfWallVaultConsecCount?: number;
  halfWallVaultConsecX?: number;
  halfWallVaultConsecZ?: number;
  /** Sim tick when the last vault commit started. */
  halfWallVaultConsecTick?: number;
};

export type HalfWallVaultKeys = {
  forward: boolean;
  left: boolean;
  right: boolean;
};

/** One of five discrete vault approaches relative to wall face. */
export type HalfWallVaultOption = {
  /** World-move yaw offset from face (look stays on face). */
  moveOffset: number;
  keys: HalfWallVaultKeys;
};

/**
 * Look always faces into the wall; keys choose world move direction:
 *  0° W, −45° W+A, −90° A, +45° W+D, +90° D.
 *
 * Selection is **not** nearest-neighbor to these offsets — see
 * {@link HALF_WALL_VAULT_FORWARD_MAX_ANGLE} / {@link HALF_WALL_VAULT_DIAGONAL_MAX_ANGLE}.
 * Offsets still describe the physical key move and commit-length class.
 */
export const HALF_WALL_VAULT_OPTIONS: readonly HalfWallVaultOption[] = [
  { moveOffset: 0, keys: { forward: true, left: false, right: false } },
  {
    moveOffset: -QUARTER_PI,
    keys: { forward: true, left: true, right: false },
  },
  {
    moveOffset: -HALF_PI,
    keys: { forward: false, left: true, right: false },
  },
  {
    moveOffset: QUARTER_PI,
    keys: { forward: true, left: false, right: true },
  },
  {
    moveOffset: HALF_PI,
    keys: { forward: false, left: false, right: true },
  },
];

/**
 * |desired − face| within this band → pure W hop.
 * Wider than the old Voronoi half-gap (~22.5°) so forward vaults are the default.
 */
export const HALF_WALL_VAULT_FORWARD_MAX_ANGLE = radians(40);

/**
 * Beyond forward max and within this band → WA / WD.
 * Beyond this (toward ±90° and past) → pure A / D only.
 */
export const HALF_WALL_VAULT_DIAGONAL_MAX_ANGLE = radians(75);

export type HalfWallVaultResult = {
  active: boolean;
  faceYaw?: number;
  forward?: boolean;
  left?: boolean;
  right?: boolean;
  /** True when grounded this think (rising-edge jump). */
  jump?: boolean;
  /** Fields to merge into draft brain state (undefined deletes). */
  statePatch: HalfWallVaultState;
};

/** Signed shortest yaw delta from `from` to `to` in (−π, π]. */
export function yawSignedDelta(from: number, to: number): number {
  let d = to - from;
  while (d > PI) d -= TWO_PI;
  while (d <= -PI) d += TWO_PI;
  return d;
}

export function yawAbsDelta(a: number, b: number): number {
  return abs(yawSignedDelta(a, b));
}

/** Clear vault commit fields (death / finished hop). */
export function clearHalfWallVaultState(
  _state: HalfWallVaultState,
): HalfWallVaultState {
  return {
    halfWallVaultTicksLeft: Number.NaN,
    halfWallVaultFaceYaw: Number.NaN,
    halfWallVaultOption: Number.NaN,
    halfWallVaultJumpHoldTicksLeft: Number.NaN,
  };
}

/**
 * Pick vault option from desired-vs-face angle bands (not nearest option offset):
 * - |δ| ≤ {@link HALF_WALL_VAULT_FORWARD_MAX_ANGLE} → pure W
 * - else |δ| ≤ {@link HALF_WALL_VAULT_DIAGONAL_MAX_ANGLE} → WA / WD
 * - else → pure A / D (most edge-on approaches)
 *
 * Returns option index into {@link HALF_WALL_VAULT_OPTIONS}.
 *
 * When `collision` + position are provided: if a wall is within
 * {@link HALF_WALL_VAULT_SIDE_CLEAR_DIST} on the A (left) side, A/AW options
 * become a pure W hop; same for D/DW when the right side is blocked.
 */
export function pickHalfWallVaultOption(
  faceYaw: number,
  desiredYaw: number,
  opts?: {
    x: number;
    z: number;
    collision: MapCollision;
  },
): number {
  // Signed path error relative to wall face: negative = left (A), positive = right (D).
  const delta = yawSignedDelta(faceYaw, desiredYaw);
  const absDelta = abs(delta);
  // Tiny eps so face±band survives (a+b)−a float noise at the boundary.
  const bandEps = 1e-9;
  let best: number;
  if (absDelta <= HALF_WALL_VAULT_FORWARD_MAX_ANGLE + bandEps) {
    best = HALF_WALL_VAULT_HEAD_ON_OPTION;
  } else if (absDelta <= HALF_WALL_VAULT_DIAGONAL_MAX_ANGLE + bandEps) {
    best = delta < 0 ? 1 : 3; // WA : WD
  } else {
    best = delta < 0 ? 2 : 4; // A : D
  }

  if (!opts?.collision) return best;

  const picked = HALF_WALL_VAULT_OPTIONS[best]!;
  if (
    picked.keys.left &&
    sideWallWithin(opts.collision, opts.x, opts.z, faceYaw, "left")
  ) {
    return HALF_WALL_VAULT_HEAD_ON_OPTION;
  }
  if (
    picked.keys.right &&
    sideWallWithin(opts.collision, opts.x, opts.z, faceYaw, "right")
  ) {
    return HALF_WALL_VAULT_HEAD_ON_OPTION;
  }
  return best;
}

/**
 * True when any non-clear geometry sits within
 * {@link HALF_WALL_VAULT_SIDE_CLEAR_DIST} along the player's A or D axis
 * (relative to face into the vault wall).
 */
export function sideWallWithin(
  collision: MapCollision,
  x: number,
  z: number,
  faceYaw: number,
  side: "left" | "right",
  distance: number = HALF_WALL_VAULT_SIDE_CLEAR_DIST,
): boolean {
  // Match moveStep WASD: A steps (−cos, +sin), D steps (+cos, −sin).
  // Those are face+90° / face−90° in classifyForward yaw space.
  const sideYaw = side === "left" ? faceYaw + HALF_PI : faceYaw - HALF_PI;
  return collision.classifyForward(x, z, sideYaw, distance) !== "clear";
}

/**
 * Commit length for a vault option: base airtime hold, plus extra for
 * diagonal / pure-strafe so A/D stay down long enough to clear.
 */
export function commitTicksForVaultOption(optionIndex: number): number {
  const i = clamp(optionIndex, 0, HALF_WALL_VAULT_OPTIONS.length - 1);
  const offset = abs(HALF_WALL_VAULT_OPTIONS[i]!.moveOffset);
  let ticks = HALF_WALL_VAULT_COMMIT_TICKS;
  // Pure ±90° strafe
  if (offset >= HALF_PI - 1e-6) {
    ticks += HALF_WALL_VAULT_COMMIT_STRAFE_EXTRA_TICKS;
  } else if (offset > 1e-6) {
    // ±45° (or any non-zero non-90)
    ticks += HALF_WALL_VAULT_COMMIT_DIAGONAL_EXTRA_TICKS;
  }
  return ticks;
}

function emitOption(
  faceYaw: number,
  optionIndex: number,
  ticksLeft: number,
  jumpHoldLeft: number,
  /** When starting a new commit, stamp consecutive-attempt chain. */
  consec?: {
    count: number;
    x: number;
    z: number;
    tick: number;
  },
): HalfWallVaultResult {
  const opt = HALF_WALL_VAULT_OPTIONS[
    clamp(optionIndex, 0, HALF_WALL_VAULT_OPTIONS.length - 1)
  ]!;
  const statePatch: HalfWallVaultState = {
    halfWallVaultTicksLeft: ticksLeft,
    halfWallVaultFaceYaw: faceYaw,
    halfWallVaultOption: optionIndex,
    halfWallVaultJumpHoldTicksLeft: jumpHoldLeft > 0 ? jumpHoldLeft : Number.NaN,
  };
  if (consec) {
    statePatch.halfWallVaultConsecCount = consec.count;
    statePatch.halfWallVaultConsecX = consec.x;
    statePatch.halfWallVaultConsecZ = consec.z;
    statePatch.halfWallVaultConsecTick = consec.tick;
  }
  // Space while the jump latch remains (start hold or landing re-arm).
  return {
    active: true,
    faceYaw,
    forward: opt.keys.forward,
    left: opt.keys.left,
    right: opt.keys.right,
    jump: jumpHoldLeft > 0,
    statePatch,
  };
}

/**
 * True when any sample along `yaw` out to `maxDist` is a jumpable half-wall.
 * Multi-sample so mid-approach bots arm before nose-on.
 */
export function isJumpableWithin(
  collision: MapCollision,
  x: number,
  z: number,
  yaw: number,
  maxDist: number = HALF_WALL_VAULT_PROBE,
): boolean {
  if (!(maxDist > 0)) return false;
  let sawExactMax = false;
  for (const d of HALF_WALL_VAULT_PROBE_DISTS) {
    if (d > maxDist + 1e-6) break;
    if (abs(d - maxDist) < 1e-6) sawExactMax = true;
    if (collision.classifyForward(x, z, yaw, d) === "jumpable") return true;
  }
  if (!sawExactMax) {
    return collision.classifyForward(x, z, yaw, maxDist) === "jumpable";
  }
  return false;
}

/**
 * True when the first non-clear probe along `faceYaw` is a jumpable half-wall
 * core (not a full wall / half-wall lip). Used to arm vault commits so bots do
 * not face-and-hop into solid geometry when jumpable samples only exist along
 * a parallel slide path (full→half collinear junctions).
 */
export function isJumpableFace(
  collision: MapCollision,
  x: number,
  z: number,
  faceYaw: number,
  maxDist: number = HALF_WALL_VAULT_PROBE,
): boolean {
  if (!(maxDist > 0)) return false;
  let sawExactMax = false;
  for (const d of HALF_WALL_VAULT_PROBE_DISTS) {
    if (d > maxDist + 1e-6) break;
    if (abs(d - maxDist) < 1e-6) sawExactMax = true;
    const c = collision.classifyForward(x, z, faceYaw, d);
    if (c === "clear") continue;
    return c === "jumpable";
  }
  if (!sawExactMax) {
    const c = collision.classifyForward(x, z, faceYaw, maxDist);
    if (c === "clear") return false;
    return c === "jumpable";
  }
  return false;
}

function dormant(clear = true): HalfWallVaultResult {
  return {
    active: false,
    statePatch: clear ? clearHalfWallVaultState({}) : {},
  };
}

/**
 * Next consecutive vault count for a new commit start at (x, z) on `tick`.
 * Resets to 1 when previous start was too long ago or too far away.
 */
export function nextVaultConsecCount(
  state: HalfWallVaultState,
  x: number,
  z: number,
  tick: number,
): number {
  const prevCount = state.halfWallVaultConsecCount ?? 0;
  const prevTick = state.halfWallVaultConsecTick;
  const prevX = state.halfWallVaultConsecX;
  const prevZ = state.halfWallVaultConsecZ;
  if (
    prevCount <= 0 ||
    typeof prevTick !== "number" ||
    !Number.isFinite(prevTick) ||
    typeof prevX !== "number" ||
    !Number.isFinite(prevX) ||
    typeof prevZ !== "number" ||
    !Number.isFinite(prevZ)
  ) {
    return 1;
  }
  const dt = tick - prevTick;
  if (dt < 0 || dt > HALF_WALL_VAULT_CONSEC_WINDOW_TICKS) {
    return 1;
  }
  const dx = x - prevX;
  const dz = z - prevZ;
  if (
    dx * dx + dz * dz >
      HALF_WALL_VAULT_CONSEC_AREA * HALF_WALL_VAULT_CONSEC_AREA
  ) {
    return 1;
  }
  return prevCount + 1;
}

/**
 * Pure vault step for one think.
 *
 * - While commit ticks remain: keep face + move keys; jump while the start
 *   latch has ticks left; if grounded and still jumpable, re-arm a short
 *   landing re-jump latch.
 * - Otherwise: if half wall jumpable within probe along desired yaw, start commit.
 * - Else: dormant pass-through.
 *
 * Consecutive starts in the same area within
 * {@link HALF_WALL_VAULT_CONSEC_WINDOW_TICKS} escalate; attempt
 * {@link HALF_WALL_VAULT_CONSEC_FORCE_HEAD_ON}+ is head-on forward only.
 */
export function stepHalfWallVault(input: {
  x: number;
  z: number;
  desiredYaw: number;
  onGround: boolean;
  collision?: MapCollision | null;
  simDelta: number;
  /** Live sim tick — used for consecutive-attempt timing. */
  tick?: number;
  state: HalfWallVaultState;
}): HalfWallVaultResult {
  const {
    x,
    z,
    desiredYaw,
    onGround,
    collision,
    state,
  } = input;
  const simDelta =
    typeof input.simDelta === "number" && Number.isFinite(input.simDelta) &&
      input.simDelta > 0
      ? input.simDelta
      : 1;
  const tick = typeof input.tick === "number" && Number.isFinite(input.tick)
    ? input.tick
    : 0;

  const ticksLeft = state.halfWallVaultTicksLeft ?? 0;
  const storedFace = state.halfWallVaultFaceYaw;
  const storedOpt = state.halfWallVaultOption;
  const jumpHoldLeft = state.halfWallVaultJumpHoldTicksLeft ?? 0;

  // --- active commit: keep driving the chosen option ---
  if (
    ticksLeft > 0 &&
    typeof storedFace === "number" &&
    Number.isFinite(storedFace) &&
    typeof storedOpt === "number"
  ) {
    const next = ticksLeft - simDelta;
    if (next <= 0) {
      // Commit done — keep consecutive chain on state (not cleared here).
      return dormant(true);
    }
    let nextJumpHold = max(0, jumpHoldLeft - simDelta);
    // Landed still blocked by a jumpable face: re-arm a short takeoff so the
    // first hop lag / skim does not strand the bot for the rest of commit.
    // Use face-first-hit (not any-sample) so a nearby full wall does not
    // re-press space into solid while a half core is only off to the side.
    if (
      nextJumpHold <= 0 &&
      onGround &&
      collision &&
      isJumpableFace(collision, x, z, storedFace)
    ) {
      nextJumpHold = HALF_WALL_VAULT_REJUMP_HOLD_TICKS;
    }
    return emitOption(storedFace, storedOpt, next, nextJumpHold);
  }

  // --- dormant: maybe trigger ---
  if (!collision) return dormant(true);
  if (!onGround) return dormant(true);

  if (!isJumpableWithin(collision, x, z, desiredYaw, HALF_WALL_VAULT_PROBE)) {
    return dormant(true);
  }

  const face = estimateHalfWallFaceYaw(collision, x, z, desiredYaw) ??
    desiredYaw;
  // Desired path can see jumpable geometry while the face still aims into a
  // collinear full wall or half-wall end inset (Hourglass center tunnels).
  // Hold the slide until the face itself is a vaultable core.
  if (!isJumpableFace(collision, x, z, face)) {
    return dormant(true);
  }
  const consecCount = nextVaultConsecCount(state, x, z, tick);
  // 3rd+ hop in-place: no side strafe — face wall, jump straight forward.
  // Otherwise closest option, but A/AW or D/DW collapse to W if that side
  // has a wall within {@link HALF_WALL_VAULT_SIDE_CLEAR_DIST}.
  const option = consecCount >= HALF_WALL_VAULT_CONSEC_FORCE_HEAD_ON
    ? HALF_WALL_VAULT_HEAD_ON_OPTION
    : pickHalfWallVaultOption(face, desiredYaw, { x, z, collision });
  return emitOption(
    face,
    option,
    commitTicksForVaultOption(option),
    HALF_WALL_VAULT_JUMP_HOLD_TICKS,
    { count: consecCount, x, z, tick },
  );
}
