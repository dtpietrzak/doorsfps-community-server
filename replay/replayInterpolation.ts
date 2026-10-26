/**
 * Epic 11.4 — replay pose interpolation (tick→display boundary).
 *
 * Pure blend between two whole-tick reconstructed poses. Owns continuous-field
 * lerp + discrete snap + discontinuity hard-snap; never steps the runner, never
 * owns clock state, never extracts from checkpoints, never writes render state.
 *
 * Contract (see notes/replay/11-replay-playback/11-04-replay-interpolation.md):
 * - Continuous: x/y/z linear, yaw shortest-arc, pitch linear, velocity* linear
 *   when present on both sides.
 * - Discrete mirror `b`: alive, crouch, onGround, spawnedAtTick, diedAtTick.
 * - Snap to `b` (`snapped: true`) on alive toggle, spawnedAtTick change,
 *   missing-side (roster), or distance > REPLAY_INTERP_SNAP_DISTANCE.
 * - Alpha from the caller (normally 11.3 `carryMs / TICK_MS`); clamp [0,1];
 *   non-finite fails loud. Never reads wall clock. Never extrapolates (u=1 → b).
 * - Scan-locked: no checkpoint/player/runner/clock/render/net/store/blob
 *   imports; never reuses the live-net smoother module.
 *
 * Handoffs: 11.5 extracts pose pairs and feeds the renderer; 11.6 blends per
 * frame between runner steps; 12.x/13.x/14.x consume display poses (lifecycle
 * snap is load-bearing for killcam death-frame exactness).
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * World-unit distance above which a per-tick displacement is treated as a
 * teleport (hard snap to `b`). An order of magnitude above max per-tick sprint
 * (~0.2u at 12 u/s ÷ 60 Hz) and far below any real respawn teleport.
 */
export const REPLAY_INTERP_SNAP_DISTANCE = 2.0;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal display pose pair — not a checkpoint slice.
 * 11.5 owns extraction from runner / checkpoint state.
 */
export type ReplayInterpPose = {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly pitch: number;
  readonly alive: boolean;
  readonly spawnedAtTick: number;
  /** Null while alive; sim tick of death while dead. */
  readonly diedAtTick: number | null;
  readonly crouch: boolean;
  readonly onGround: boolean;
  /** Optional authoritative velocity for animation layers only (never sim). */
  readonly velocityX?: number;
  readonly velocityY?: number;
  readonly velocityZ?: number;
};

export type ReplayInterpResult = {
  readonly pose: ReplayInterpPose;
  readonly snapped: boolean;
};

/**
 * Roster blend input. `projectiles` is hitscan-empty today and passes through
 * verbatim from the newer side (hook for a future projectile sim — not this epic).
 */
export type ReplayInterpRoster = {
  readonly poses: readonly ReplayInterpPose[];
  readonly projectiles?: readonly unknown[];
};

export type ReplayInterpRosterResult = {
  readonly poses: readonly ReplayInterpResult[];
  /** Verbatim from `next` (newer side); never per-projectile lerped. */
  readonly projectiles: readonly unknown[];
};

export type ReplayInterpErrorCode =
  | "replay-interp-alpha"
  | "replay-interp-field"
  | "replay-interp-id";

// ---------------------------------------------------------------------------
// Errors (fail-closed, named — same { code, detail } family as 10.2)
// ---------------------------------------------------------------------------

export class ReplayInterpError extends Error {
  readonly code: ReplayInterpErrorCode;
  readonly detail: string | null;

  constructor(
    code: ReplayInterpErrorCode,
    message: string,
    opts?: { detail?: string | null },
  ) {
    super(message);
    this.name = "ReplayInterpError";
    this.code = code;
    this.detail = opts?.detail ?? null;
  }
}

function fail(
  code: ReplayInterpErrorCode,
  message: string,
  detail?: string | null,
): never {
  throw new ReplayInterpError(code, message, { detail: detail ?? null });
}

// ---------------------------------------------------------------------------
// Alpha
// ---------------------------------------------------------------------------

/**
 * Clamp interpolation alpha to `[0, 1]`. Non-finite values fail loud.
 * Caller supplies `u` (normally `carryMs / TICK_MS` from the 11.3 clock).
 */
export function clampInterpAlpha(u: number): number {
  if (!Number.isFinite(u)) {
    fail(
      "replay-interp-alpha",
      `ReplayInterp: alpha must be finite, got ${String(u)}`,
      String(u),
    );
  }
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  return u;
}

// ---------------------------------------------------------------------------
// Math (local copies — never import remoteInterp)
// ---------------------------------------------------------------------------

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Shortest-arc yaw blend. Exact ±π ties keep the post-wrap signed delta
 * (same shape as the live remote private angle lerp — deliberately not imported).
 */
function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function assertFiniteField(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    fail(
      "replay-interp-field",
      `ReplayInterp: ${name} must be finite, got ${String(value)}`,
      name,
    );
  }
}

function assertContinuousFields(pose: ReplayInterpPose, side: "a" | "b"): void {
  const prefix = `${side}.${pose.id}`;
  assertFiniteField(`${prefix}.x`, pose.x);
  assertFiniteField(`${prefix}.y`, pose.y);
  assertFiniteField(`${prefix}.z`, pose.z);
  assertFiniteField(`${prefix}.yaw`, pose.yaw);
  assertFiniteField(`${prefix}.pitch`, pose.pitch);
  if (pose.velocityX !== undefined) {
    assertFiniteField(`${prefix}.velocityX`, pose.velocityX);
  }
  if (pose.velocityY !== undefined) {
    assertFiniteField(`${prefix}.velocityY`, pose.velocityY);
  }
  if (pose.velocityZ !== undefined) {
    assertFiniteField(`${prefix}.velocityZ`, pose.velocityZ);
  }
}

function distanceSq(a: ReplayInterpPose, b: ReplayInterpPose): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  return dx * dx + dy * dy + dz * dz;
}

function copyPose(src: ReplayInterpPose): ReplayInterpPose {
  const out: ReplayInterpPose = {
    id: src.id,
    x: src.x,
    y: src.y,
    z: src.z,
    yaw: src.yaw,
    pitch: src.pitch,
    alive: src.alive,
    spawnedAtTick: src.spawnedAtTick,
    diedAtTick: src.diedAtTick,
    crouch: src.crouch,
    onGround: src.onGround,
    ...(src.velocityX !== undefined ? { velocityX: src.velocityX } : {}),
    ...(src.velocityY !== undefined ? { velocityY: src.velocityY } : {}),
    ...(src.velocityZ !== undefined ? { velocityZ: src.velocityZ } : {}),
  };
  return Object.freeze(out);
}

function shouldSnap(a: ReplayInterpPose, b: ReplayInterpPose): boolean {
  if (a.alive !== b.alive) return true;
  if (a.spawnedAtTick !== b.spawnedAtTick) return true;
  const snapSq = REPLAY_INTERP_SNAP_DISTANCE * REPLAY_INTERP_SNAP_DISTANCE;
  return distanceSq(a, b) > snapSq;
}

function blendVelocity(
  a: ReplayInterpPose,
  b: ReplayInterpPose,
  u: number,
  out: {
    -readonly [K in keyof ReplayInterpPose]: ReplayInterpPose[K];
  },
): void {
  const hasA =
    a.velocityX !== undefined &&
    a.velocityY !== undefined &&
    a.velocityZ !== undefined;
  const hasB =
    b.velocityX !== undefined &&
    b.velocityY !== undefined &&
    b.velocityZ !== undefined;
  if (hasA && hasB) {
    out.velocityX = lerp(a.velocityX!, b.velocityX!, u);
    out.velocityY = lerp(a.velocityY!, b.velocityY!, u);
    out.velocityZ = lerp(a.velocityZ!, b.velocityZ!, u);
  } else if (hasB) {
    out.velocityX = b.velocityX;
    out.velocityY = b.velocityY;
    out.velocityZ = b.velocityZ;
  } else if (hasA && u === 0) {
    out.velocityX = a.velocityX;
    out.velocityY = a.velocityY;
    out.velocityZ = a.velocityZ;
  }
  // else: omit velocity from output (neither side authoritative for blend)
}

// ---------------------------------------------------------------------------
// Pose blend
// ---------------------------------------------------------------------------

/**
 * Blend two minimal poses at alpha `u ∈ [0, 1]` (clamped).
 * Returns a fresh frozen pose; `u = 0` / `u = 1` are bit-exact copies of `a` / `b`.
 * Never mutates inputs. Never extrapolates past `b`.
 */
export function interpolateReplayPose(
  a: ReplayInterpPose,
  b: ReplayInterpPose,
  u: number,
): ReplayInterpResult {
  if (a.id !== b.id) {
    fail(
      "replay-interp-id",
      `ReplayInterp: pose id mismatch "${a.id}" vs "${b.id}"`,
      `${a.id}!==${b.id}`,
    );
  }
  assertContinuousFields(a, "a");
  assertContinuousFields(b, "b");

  const t = clampInterpAlpha(u);

  if (t === 0) {
    return Object.freeze({ pose: copyPose(a), snapped: false });
  }
  if (t === 1) {
    return Object.freeze({ pose: copyPose(b), snapped: false });
  }

  if (shouldSnap(a, b)) {
    return Object.freeze({ pose: copyPose(b), snapped: true });
  }

  const blended: {
    -readonly [K in keyof ReplayInterpPose]: ReplayInterpPose[K];
  } = {
    id: b.id,
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    z: lerp(a.z, b.z, t),
    yaw: lerpAngle(a.yaw, b.yaw, t),
    pitch: lerp(a.pitch, b.pitch, t),
    // Discrete fields always mirror the newer side.
    alive: b.alive,
    spawnedAtTick: b.spawnedAtTick,
    diedAtTick: b.diedAtTick,
    crouch: b.crouch,
    onGround: b.onGround,
  };
  blendVelocity(a, b, t, blended);

  return Object.freeze({
    pose: Object.freeze(blended as ReplayInterpPose),
    snapped: false,
  });
}

// ---------------------------------------------------------------------------
// Roster blend
// ---------------------------------------------------------------------------

/**
 * Id-matched roster blend. Present-only on one side → that side with
 * `snapped: true` (join/leave). Projectiles pass through from `next` verbatim.
 */
export function interpolateReplayRoster(
  prev: ReplayInterpRoster,
  next: ReplayInterpRoster,
  u: number,
): ReplayInterpRosterResult {
  const t = clampInterpAlpha(u);
  const prevById = new Map<string, ReplayInterpPose>();
  for (const p of prev.poses) {
    prevById.set(p.id, p);
  }
  const nextById = new Map<string, ReplayInterpPose>();
  for (const p of next.poses) {
    nextById.set(p.id, p);
  }

  const ids = new Set<string>([...prevById.keys(), ...nextById.keys()]);
  const sortedIds = [...ids].sort();
  const poses: ReplayInterpResult[] = [];

  for (const id of sortedIds) {
    const a = prevById.get(id);
    const b = nextById.get(id);
    if (a && b) {
      poses.push(interpolateReplayPose(a, b, t));
    } else if (b) {
      // Join: show the present (newer) side.
      poses.push(Object.freeze({ pose: copyPose(b), snapped: true }));
    } else if (a) {
      // Leave: show the present (older) side — never invent a pose past leave.
      // At u→1 the entity is gone from next; still surface `a` with snap so
      // 11.5 can drop it, but we never fabricate a blend toward absence.
      poses.push(Object.freeze({ pose: copyPose(a), snapped: true }));
    }
  }

  const projectiles = Object.freeze(
    [...(next.projectiles ?? [])],
  ) as readonly unknown[];

  return Object.freeze({
    poses: Object.freeze(poses) as readonly ReplayInterpResult[],
    projectiles,
  });
}
