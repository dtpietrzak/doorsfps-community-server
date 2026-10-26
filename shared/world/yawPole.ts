/**
 * Shared yaw-pole target selection (client blue guide + bot brain).
 *
 * Selection:
 *  0. opponent **center** door pole (orange) — hard priority when LOS (+ optional
 *     walkable) is clear. Side door poles are not hard-picked (lip dance).
 *  1. pink wall poles — filter (skip / LOS / door∪player∪movement FOV) then multi-term score
 *
 * Wall score terms:
 *  - door FOV: +10 (binary)
 *  - player FOV: 10 at facing center → 5 at FOV edge → 0 outside (anti-jerk)
 *  - movement FOV: same curve as player FOV, centered on move yaw (wish / slide)
 *  - proximity among filtered: closest +10, next +5, rest 0
 *  - per-bot spawn noise: [YAW_POLE_NOISE_MIN, YAW_POLE_NOISE_MAX]; re-rolled
 *    on death respawn and door-capture home
 *  - distance to enemy door: 10 → 0 linear (team-shared)
 *  - lateral map center: 5 → 0 edges (shared both teams)
 *  - human residual heat: shared offline prior [0,1] × humanHeatMax (default 8)
 *
 * Constants and pure pick live here so client debug overlay and server bots
 * cannot drift. Platform-specific full-wall raycast is injected via `blocksLos`.
 *
 * Sticky lock ({@link stepStickyYawPole}) is pure too but *state* is hoisted
 * by the caller (bot brain bag / client overlay) — pick itself never remembers.
 *
 * Lookahead ({@link pickNextYawPoleTarget}) re-picks as if already standing at
 * the current target (skip radius drops underfoot); not sticky itself.
 *
 * Corner round ({@link computeYawPoleCornerRound}): as we approach current,
 * pre-rotate look toward next and strafe the **outside** of the turn
 * ("go left to go right") so we leave the pole already aimed at next.
 */

import {
  computeDoorYawDots,
  doorLineSegment,
  resolveWallCorners,
  type DoorYawDotSide,
  type WallCornerBounds,
  type WallCornerPoint,
  type WallCornerSegment,
  YAW_DOOR_FOV_HALF_ANGLE,
  YAW_MOVEMENT_FOV_HALF_ANGLE,
  YAW_PLAYER_FOV_HALF_ANGLE,
  YAW_POLE_SKIP_RADIUS,
} from "./wallCorners.ts";
import { MOVE_CROUCH_EYE, MOVE_STAND_EYE } from "../sim/moveStep.ts";
import {
  abs,
  clamp01,
  distance2,
  fastAtan2,
  fastCos,
  fastSin,
  max,
  min,
  PI,
  round,
  TWO_PI,
} from "../math/index.ts";

function fallbackRandom(): number {
  return 0.5;
}

/** Re-export FOV / skip constants (tweak in wallCorners.ts). */
export {
  YAW_DOOR_FOV_HALF_ANGLE,
  YAW_MOVEMENT_FOV_HALF_ANGLE,
  YAW_PLAYER_FOV_HALF_ANGLE,
  YAW_POLE_SKIP_RADIUS,
};

/** Standing navel height from feet — blue-line / LOS origin. */
export const YAW_BELLY_FROM_FEET_STAND = 1.0;
/** Crouch navel height from feet. */
export const YAW_BELLY_FROM_FEET_CROUCH = 0.55;
/** Stop short of the pole so wall thickness at the target is not a block. */
export const YAW_POLE_LOS_RANGE_INSET = 0.15;

/** Binary points for a wall pole inside the enemy-door band. */
export const YAW_POLE_DOOR_FOV_SCORE = 10;
/** Player FOV score at dead-center facing. */
export const YAW_POLE_PLAYER_FOV_CENTER = 10;
/** Player FOV score at the wedge edge (outside → 0). */
export const YAW_POLE_PLAYER_FOV_EDGE = 0;
/**
 * Movement FOV score at dead-center move direction.
 * Matches player FOV for now — tweak independently later.
 */
export const YAW_POLE_MOVEMENT_FOV_CENTER = 10;
/** Movement FOV score at the wedge edge (outside → 0). */
export const YAW_POLE_MOVEMENT_FOV_EDGE = 5;
/** Closest filtered wall pole to the player. */
export const YAW_POLE_PROXIMITY_CLOSEST = 8;
/** Second-closest filtered wall pole. */
export const YAW_POLE_PROXIMITY_SECOND = 5;
/** Max points for closest-to-enemy-door among map wall poles. */
export const YAW_POLE_DOOR_DIST_MAX = 10;
/**
 * Path / door-camp travel: ignore wall poles this close to **own** door mid.
 * After score-home (and any pose near the home portal), proximity scoring
 * otherwise sticky-locks the nearest lip / triangle tip and bots thrash into
 * their own door instead of leaving for the score door. Hunt keeps own-door
 * poles (doorDist bias "own").
 */
export const PATH_OWN_DOOR_POLE_EXCLUDE = 5;
/** Max points on the map lateral center line. */
export const YAW_POLE_MAP_CENTER_MAX = 5;
/** Inclusive range for per-bot spawn noise. */
export const YAW_POLE_NOISE_MIN = -10;
export const YAW_POLE_NOISE_MAX = 10;

// ---------------------------------------------------------------------------
// Agent-hunt mode dials (doors closed). Callers pass these via PickYawPoleInput.
// ---------------------------------------------------------------------------

/** Feet within this of the current doorDist bias door → flip own ↔ enemy. */
export const HUNT_DOOR_BIAS_FLIP_RADIUS = 8;
/** Hunt-phase pole noise inclusive min. */
export const HUNT_YAW_POLE_NOISE_MIN = -15;
/** Hunt-phase pole noise inclusive max. */
export const HUNT_YAW_POLE_NOISE_MAX = 15;
/** Jacked doorDist max while hunting (patrol to bias door). */
export const HUNT_DOOR_DIST_MAX = 18;
/** Wider door/goal FOV half-angle while hunting (agent search cone). */
export const HUNT_DOOR_FOV_HALF_ANGLE = PI / 2;
/** Hunt doorFov binary score (stronger agent-bearing pull). */
export const HUNT_YAW_POLE_DOOR_FOV_SCORE = 20;
/** Hunt map-center soft bias (low so agent/doorDist dominate). */
export const HUNT_YAW_POLE_MAP_CENTER_MAX = 4;
/** Hunt player FOV center score (less look-inertia than door rush). */
export const HUNT_YAW_POLE_PLAYER_FOV_CENTER = 6;
/** Hunt movement FOV center score. */
export const HUNT_YAW_POLE_MOVEMENT_FOV_CENTER = 4;
/** Hunt movement FOV edge score. */
export const HUNT_YAW_POLE_MOVEMENT_FOV_EDGE = 0;

/**
 * Overridable score / FOV dials for {@link scoreYawWallPoles}.
 * Omit fields on {@link PickYawPoleInput.weights} to keep defaults.
 */
export type YawPoleScoreWeights = {
  doorFov: number;
  playerFovCenter: number;
  playerFovEdge: number;
  movementFovCenter: number;
  movementFovEdge: number;
  proximityClosest: number;
  proximitySecond: number;
  doorDistMax: number;
  mapCenterMax: number;
  doorFovHalfAngle: number;
  playerFovHalfAngle: number;
  movementFovHalfAngle: number;
  /**
   * Max points from offline human residual heat (0..1 baked × this).
   * 0 disables the term even when a prior table is attached.
   */
  humanHeatMax: number;
};

/** Max contribution of shared human residual prior (order of other terms). */
export const YAW_POLE_HUMAN_HEAT_MAX = 8;

/** Door-rush defaults (match historical constants). */
export const DEFAULT_YAW_POLE_WEIGHTS: YawPoleScoreWeights = {
  doorFov: YAW_POLE_DOOR_FOV_SCORE,
  playerFovCenter: YAW_POLE_PLAYER_FOV_CENTER,
  playerFovEdge: YAW_POLE_PLAYER_FOV_EDGE,
  movementFovCenter: YAW_POLE_MOVEMENT_FOV_CENTER,
  movementFovEdge: YAW_POLE_MOVEMENT_FOV_EDGE,
  proximityClosest: YAW_POLE_PROXIMITY_CLOSEST,
  proximitySecond: YAW_POLE_PROXIMITY_SECOND,
  doorDistMax: YAW_POLE_DOOR_DIST_MAX,
  mapCenterMax: YAW_POLE_MAP_CENTER_MAX,
  doorFovHalfAngle: YAW_DOOR_FOV_HALF_ANGLE,
  playerFovHalfAngle: YAW_PLAYER_FOV_HALF_ANGLE,
  movementFovHalfAngle: YAW_MOVEMENT_FOV_HALF_ANGLE,
  humanHeatMax: YAW_POLE_HUMAN_HEAT_MAX,
};

/** Agent-hunt preset: agent goal FOV + jacked doorDist patrol, no hard door poles. */
export const HUNT_YAW_POLE_WEIGHTS: YawPoleScoreWeights = {
  doorFov: HUNT_YAW_POLE_DOOR_FOV_SCORE,
  playerFovCenter: HUNT_YAW_POLE_PLAYER_FOV_CENTER,
  playerFovEdge: YAW_POLE_PLAYER_FOV_EDGE,
  movementFovCenter: HUNT_YAW_POLE_MOVEMENT_FOV_CENTER,
  movementFovEdge: HUNT_YAW_POLE_MOVEMENT_FOV_EDGE,
  proximityClosest: YAW_POLE_PROXIMITY_CLOSEST,
  proximitySecond: YAW_POLE_PROXIMITY_SECOND,
  doorDistMax: HUNT_DOOR_DIST_MAX,
  mapCenterMax: HUNT_YAW_POLE_MAP_CENTER_MAX,
  doorFovHalfAngle: HUNT_DOOR_FOV_HALF_ANGLE,
  playerFovHalfAngle: YAW_PLAYER_FOV_HALF_ANGLE,
  movementFovHalfAngle: YAW_MOVEMENT_FOV_HALF_ANGLE,
  humanHeatMax: YAW_POLE_HUMAN_HEAT_MAX,
};

/** Merge partial weights onto door-rush defaults. */
export function resolveYawPoleWeights(
  partial?: Partial<YawPoleScoreWeights> | null,
): YawPoleScoreWeights {
  if (!partial) return DEFAULT_YAW_POLE_WEIGHTS;
  return { ...DEFAULT_YAW_POLE_WEIGHTS, ...partial };
}

export type YawPolePoint = { x: number; z: number };

export type YawPoleTeamId = "A" | "B";

/** Minimal map slice needed for pole split + enemy-door bearing. */
export type YawPoleMap = {
  bounds: WallCornerBounds;
  teamA?: DoorYawDotSide | null;
  teamB?: DoorYawDotSide | null;
  /** Pink + optional baked door poles (door keys stripped for wall list). */
  wallCorners?: readonly WallCornerPoint[] | null;
  /**
   * Full walls — used by {@link resolveWallCorners} when `wallCorners` is
   * missing/empty so client debug and bots stay in sync on legacy maps.
   */
  walls?: readonly WallCornerSegment[] | null;
};

export type YawPoleScoreBreakdown = {
  /** 0 or {@link YAW_POLE_DOOR_FOV_SCORE}. */
  doorFov: number;
  /** 0 outside wedge; {@link YAW_POLE_PLAYER_FOV_CENTER}→{@link YAW_POLE_PLAYER_FOV_EDGE} inside. */
  playerFov: number;
  /**
   * 0 outside wedge / when not moving;
   * {@link YAW_POLE_MOVEMENT_FOV_CENTER}→{@link YAW_POLE_MOVEMENT_FOV_EDGE} inside.
   */
  movementFov: number;
  /** 0, {@link YAW_POLE_PROXIMITY_SECOND}, or {@link YAW_POLE_PROXIMITY_CLOSEST}. */
  proximity: number;
  /** Per-bot noise or 0 when absent. */
  random: number;
  /** 0…{@link YAW_POLE_DOOR_DIST_MAX} by distance to enemy door. */
  doorDist: number;
  /** 0…{@link YAW_POLE_MAP_CENTER_MAX} by lateral map center. */
  mapCenter: number;
  /**
   * 0…humanHeatMax from shared offline residual prior
   * ({@link PickYawPoleInput.humanHeatByPole} × weight).
   */
  humanHeat: number;
  total: number;
  /** total − random (stable for labels without noise). */
  base: number;
};

export type ScoredYawPole = {
  pole: YawPolePoint;
  score: YawPoleScoreBreakdown;
};

export type PickYawPoleInput = {
  x: number;
  z: number;
  /** Facing yaw (player forward basis). */
  yaw: number;
  /**
   * Horizontal movement yaw (wish / slide / velocity). Same convention as
   * facing: forward = (−sin yaw, −cos yaw). Omit / null / non-finite when
   * not moving — movement FOV then contributes 0 and does not filter in.
   */
  moveYaw?: number | null;
  team: YawPoleTeamId;
  map: YawPoleMap;
  /** Pink wall-corner poles (no door poles). */
  wallPoles: readonly YawPolePoint[];
  /** Three orange poles on the *enemy* door line. */
  enemyDoorPoles: readonly YawPolePoint[];
  /**
   * True when a horizontal navel-height ray to the pole hits a full wall.
   * Omit / undefined ⇒ treat LOS as clear (open unit tests / no collision).
   */
  blocksLos?: (ox: number, oz: number, tx: number, tz: number) => boolean;
  /**
   * Per-pole spawn noise keyed by {@link yawPoleKey}. Missing keys count as 0.
   */
  poleNoise?: ReadonlyMap<string, number> | Readonly<Record<string, number>>;
  /**
   * When set, door FOV filter/score centers on bearing to this point instead
   * of the enemy door midpoint (hunt: agent / last-known / map center).
   */
  goalPoint?: YawPolePoint | null;
  /**
   * When set, doorDist scores poles by distance to this point (closer better).
   * Hunt oscillation: own door mid or enemy door mid. Omit → enemy door mid.
   */
  doorDistPoint?: YawPolePoint | null;
  /**
   * When false, skip opponent-door hard priority (wall scores only).
   * Default true (door-rush). Hunt: false.
   * When true, only the **center** enemy door pole is eligible (not sides).
   */
  hardPrioritizeDoorPoles?: boolean;
  /**
   * Optional walkability gate for the hard-priority center door pole.
   * Return false when a short step toward `(tx, tz)` is blocked (full wall).
   * Jumpable / crouchable should return true — vault/duck handle those.
   * Omit → treat as walkable (open unit tests / client overlay).
   */
  walkableTo?: (tx: number, tz: number) => boolean;
  /**
   * Skip wall poles within this distance of **own** door mid (path / score-home
   * leave). Omit / ≤0 → no filter. See {@link PATH_OWN_DOOR_POLE_EXCLUDE}.
   */
  excludeNearOwnDoorDist?: number;
  /** Partial score/FOV dial overrides. Omit → {@link DEFAULT_YAW_POLE_WEIGHTS}. */
  weights?: Partial<YawPoleScoreWeights> | null;
  /**
   * Pole keys banned by ping-pong memory (A→B→A). See
   * {@link recordYawPoleCommit}. Set / array / remaining-clears map all work;
   * map entries with remaining ≤ 0 are not ignored.
   */
  ignorePoleKeys?:
    | ReadonlySet<string>
    | readonly string[]
    | Readonly<Record<string, number>>;
  /**
   * Shared offline human residual prior: poleKey → strength in [0, 1].
   * Multiplied by {@link YawPoleScoreWeights.humanHeatMax}. All bots share
   * the same table (loaded once per map). Missing keys → 0.
   */
  humanHeatByPole?:
    | ReadonlyMap<string, number>
    | Readonly<Record<string, number>>;
};

/**
 * Navel Y for blue-line origin / LOS.
 * When `eyeY` is given (player.y), navel = eye − eyeHeight + bellyFromFeet.
 * Without eyeY, returns belly height from feet (as if feet at y=0).
 */
export function yawPoleBellyY(opts?: {
  crouch?: boolean;
  eyeY?: number;
}): number {
  const crouch = Boolean(opts?.crouch);
  const bellyFromFeet = crouch
    ? YAW_BELLY_FROM_FEET_CROUCH
    : YAW_BELLY_FROM_FEET_STAND;
  const eyeH = crouch ? MOVE_CROUCH_EYE : MOVE_STAND_EYE;
  if (typeof opts?.eyeY === "number" && Number.isFinite(opts.eyeY)) {
    return opts.eyeY - eyeH + bellyFromFeet;
  }
  return bellyFromFeet;
}

/**
 * Horizontal LOS ray params from origin XZ toward pole XZ.
 * Returns null when the segment is too short to test (inside inset).
 */
export function yawPoleLosQuery(
  ox: number,
  oz: number,
  tx: number,
  tz: number,
): { dirX: number; dirZ: number; range: number } | null {
  const dx = tx - ox;
  const dz = tz - oz;
  const dist = distance2(dx, dz);
  const range = dist - YAW_POLE_LOS_RANGE_INSET;
  if (range <= 1e-4) return null;
  const inv = 1 / dist;
  return { dirX: dx * inv, dirZ: dz * inv, range };
}

/**
 * True when `key` is present in a pick-input ignore bag (ping-pong ban).
 */
export function yawPoleKeyIgnored(
  ignore:
    | ReadonlySet<string>
    | readonly string[]
    | Readonly<Record<string, number>>
    | null
    | undefined,
  key: string,
): boolean {
  if (!ignore) return false;
  if (ignore instanceof Set) return ignore.has(key);
  if (Array.isArray(ignore)) return ignore.includes(key);
  const rem = (ignore as Readonly<Record<string, number>>)[key];
  return typeof rem === "number" && Number.isFinite(rem) && rem > 0;
}

export function yawPoleKey(x: number, z: number): string {
  return `${round(x * 1e4)},${round(z * 1e4)}`;
}

/**
 * Split map poles into pink wall poles + door poles for both teams.
 * Door poles come from {@link computeDoorYawDots} (A×3 then B×3); wall poles are
 * resolved corners with door keys stripped (loadMap may merge doors into corners).
 */
export function splitYawPoles(map: YawPoleMap): {
  wallPoles: YawPolePoint[];
  doorPolesA: YawPolePoint[];
  doorPolesB: YawPolePoint[];
} {
  const doorPts =
    map.teamA && map.teamB
      ? computeDoorYawDots(map.bounds, map.teamA, map.teamB)
      : [];
  const doorPolesA = doorPts.slice(0, 3).map((p) => ({ x: p.x, z: p.z }));
  const doorPolesB = doorPts.slice(3, 6).map((p) => ({ x: p.x, z: p.z }));
  const doorKeys = new Set(doorPts.map((p) => yawPoleKey(p.x, p.z)));

  // Prefer author-stored corners; recompute from walls when empty (legacy).
  // Do not pass doors here — orange poles are tracked separately.
  const corners = resolveWallCorners(
    map.walls ?? [],
    map.wallCorners,
    map.bounds,
  );

  const wallPoles: YawPolePoint[] = [];
  for (const p of corners) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
    if (doorKeys.has(yawPoleKey(p.x, p.z))) continue;
    wallPoles.push({ x: p.x, z: p.z });
  }

  return { wallPoles, doorPolesA, doorPolesB };
}

/**
 * Wall poles + *enemy* door poles for {@link pickYawPoleTarget}.
 */
export function polesForTeam(
  map: YawPoleMap,
  team: YawPoleTeamId,
): { wallPoles: YawPolePoint[]; enemyDoorPoles: YawPolePoint[] } {
  const { wallPoles, doorPolesA, doorPolesB } = splitYawPoles(map);
  return {
    wallPoles,
    enemyDoorPoles: team === "A" ? doorPolesB : doorPolesA,
  };
}

/**
 * Yaw facing world point (tx, tz) from (x, z).
 * Player forward = (−sin yaw, −cos yaw) → yaw = atan2(−dx, −dz).
 */
export function yawTowardPoint(
  x: number,
  z: number,
  tx: number,
  tz: number,
): number | null {
  const dx = tx - x;
  const dz = tz - z;
  if (!(distance2(dx, dz) > 1e-6)) return null;
  return fastAtan2(-dx, -dz);
}

/**
 * Yaw that faces the enemy door center from (x, z).
 * Player forward = (−sin yaw, −cos yaw) → yaw = atan2(−dx, −dz).
 */
export function yawTowardEnemyDoor(
  map: YawPoleMap,
  team: YawPoleTeamId,
  x: number,
  z: number,
): number | null {
  const mid = enemyDoorMidpoint(map, team);
  if (!mid) return null;
  return yawTowardPoint(x, z, mid.x, mid.z);
}

/**
 * Goal-band center yaw for door FOV filter/score.
 * Uses {@link PickYawPoleInput.goalPoint} when finite; else enemy door.
 */
export function resolveGoalYaw(input: {
  x: number;
  z: number;
  team: YawPoleTeamId;
  map: YawPoleMap;
  goalPoint?: YawPolePoint | null;
}): number | null {
  const g = input.goalPoint;
  if (
    g &&
    Number.isFinite(g.x) &&
    Number.isFinite(g.z)
  ) {
    return yawTowardPoint(input.x, input.z, g.x, g.z);
  }
  return yawTowardEnemyDoor(input.map, input.team, input.x, input.z);
}

/** True if `yaw` is within `halfAngle` of `center` (shortest wrap). */
export function yawInHalfAngle(
  yaw: number,
  center: number,
  halfAngle: number,
): boolean {
  return yawAbsDelta(yaw, center) <= halfAngle + 1e-9;
}

/** Shortest absolute yaw delta in [0, π]. */
export function yawAbsDelta(a: number, b: number): number {
  let d = a - b;
  while (d > PI) d -= TWO_PI;
  while (d < -PI) d += TWO_PI;
  return abs(d);
}

/**
 * Continuous FOV wedge score: `centerScore` at wedge center, linear fade to
 * `edgeScore` at halfAngle, 0 outside.
 */
export function continuousFovPoleScore(
  centerYaw: number,
  poleBearingYaw: number,
  halfAngle: number,
  centerScore: number,
  edgeScore: number,
): number {
  if (!(halfAngle > 0)) return 0;
  const delta = yawAbsDelta(centerYaw, poleBearingYaw);
  if (delta > halfAngle + 1e-9) return 0;
  const t = delta / halfAngle; // 0 center → 1 edge
  return centerScore - t * (centerScore - edgeScore);
}

/**
 * Continuous player-FOV score: {@link YAW_POLE_PLAYER_FOV_CENTER} at facing
 * center, linear fade to {@link YAW_POLE_PLAYER_FOV_EDGE} at the wedge edge,
 * 0 outside. Reduces look-jerk at FOV boundaries.
 */
export function playerFovPoleScore(
  facingYaw: number,
  poleBearingYaw: number,
  halfAngle: number = YAW_PLAYER_FOV_HALF_ANGLE,
): number {
  return continuousFovPoleScore(
    facingYaw,
    poleBearingYaw,
    halfAngle,
    YAW_POLE_PLAYER_FOV_CENTER,
    YAW_POLE_PLAYER_FOV_EDGE,
  );
}

/**
 * Continuous movement-FOV score (same curve as player FOV for now).
 * Pass the horizontal move yaw (wish / slide / velocity).
 */
export function movementFovPoleScore(
  moveYaw: number,
  poleBearingYaw: number,
  halfAngle: number = YAW_MOVEMENT_FOV_HALF_ANGLE,
): number {
  return continuousFovPoleScore(
    moveYaw,
    poleBearingYaw,
    halfAngle,
    YAW_POLE_MOVEMENT_FOV_CENTER,
    YAW_POLE_MOVEMENT_FOV_EDGE,
  );
}

/**
 * Horizontal wish-move yaw from look yaw + WASD (same basis as moveStep).
 * Returns null when no move keys are held (or dir is degenerate).
 * Forward basis: (−sin yaw, −cos yaw); right: (cos yaw, −sin yaw).
 */
export function wishMoveYaw(
  lookYaw: number,
  keys: {
    forward?: boolean;
    backward?: boolean;
    left?: boolean;
    right?: boolean;
  },
): number | null {
  const sin = fastSin(lookYaw);
  const cos = fastCos(lookYaw);
  let mx = 0;
  let mz = 0;
  if (keys.forward) {
    mx -= sin;
    mz -= cos;
  }
  if (keys.backward) {
    mx += sin;
    mz += cos;
  }
  if (keys.left) {
    mx -= cos;
    mz += sin;
  }
  if (keys.right) {
    mx += cos;
    mz -= sin;
  }
  if (!(distance2(mx, mz) > 1e-6)) return null;
  return fastAtan2(-mx, -mz);
}

/**
 * Yaw facing along horizontal direction (dx, dz) in world space.
 * Same convention as player forward. Null when length is tiny.
 */
export function yawFromWorldDir(dx: number, dz: number): number | null {
  if (!(distance2(dx, dz) > 1e-6)) return null;
  return fastAtan2(-dx, -dz);
}

/**
 * Enemy door midpoint used for door-distance scoring.
 */
export function enemyDoorMidpoint(
  map: YawPoleMap,
  team: YawPoleTeamId,
): YawPolePoint | null {
  const side = team === "A" ? map.teamB : map.teamA;
  if (!side) return null;
  const [d0, d1] = doorLineSegment(map.bounds, side);
  return { x: (d0.x + d1.x) / 2, z: (d0.z + d1.z) / 2 };
}

/**
 * The walkable mouth of a door: the orange pole closest to `mid`
 * (the middle of the three door dots). Side poles are lip-dance generators.
 */
export function centerEnemyDoorPole(
  poles: readonly YawPolePoint[],
  mid?: YawPolePoint | null,
): YawPolePoint | null {
  let best: YawPolePoint | null = null;
  let bestD2 = Infinity;
  const mx = mid && Number.isFinite(mid.x) ? mid.x : null;
  const mz = mid && Number.isFinite(mid.z) ? mid.z : null;
  let cx = 0;
  let cz = 0;
  let n = 0;
  for (const p of poles) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
    cx += p.x;
    cz += p.z;
    n += 1;
  }
  const tx = mx ?? (n > 0 ? cx / n : 0);
  const tz = mz ?? (n > 0 ? cz / n : 0);
  for (const p of poles) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
    const d2 = (p.x - tx) ** 2 + (p.z - tz) ** 2;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = p;
    }
  }
  return best;
}

/**
 * Own door midpoint (hunt doorDist bias "own" side).
 */
export function ownDoorMidpoint(
  map: YawPoleMap,
  team: YawPoleTeamId,
): YawPolePoint | null {
  const side = team === "A" ? map.teamA : map.teamB;
  if (!side) return null;
  const [d0, d1] = doorLineSegment(map.bounds, side);
  return { x: (d0.x + d1.x) / 2, z: (d0.z + d1.z) / 2 };
}

/**
 * Map center XZ from bounds (hunt goal fallback when no agent known).
 */
export function yawPoleMapCenter(map: YawPoleMap): YawPolePoint {
  const { minX, maxX, minZ, maxZ } = map.bounds;
  return {
    x: (minX + maxX) / 2,
    z: (minZ + maxZ) / 2,
  };
}

/**
 * Lateral axis relative to doors: N/S edges → X; E/W → Z.
 * Prefers the enemy door edge; falls back to own door.
 */
export function lateralMapAxis(
  map: YawPoleMap,
  team: YawPoleTeamId,
): "x" | "z" {
  const enemy = team === "A" ? map.teamB : map.teamA;
  const own = team === "A" ? map.teamA : map.teamB;
  const edge = enemy?.edge ?? own?.edge;
  if (edge === "east" || edge === "west") return "z";
  return "x";
}

/**
 * Map-center score on the lateral axis: max on center line, 0 at bounds edges.
 * @param maxScore defaults to {@link YAW_POLE_MAP_CENTER_MAX}.
 */
export function yawPoleMapCenterScore(
  map: YawPoleMap,
  team: YawPoleTeamId,
  pole: YawPolePoint,
  maxScore: number = YAW_POLE_MAP_CENTER_MAX,
): number {
  const axis = lateralMapAxis(map, team);
  const { minX, maxX, minZ, maxZ } = map.bounds;
  const lo = axis === "x" ? minX : minZ;
  const hi = axis === "x" ? maxX : maxZ;
  const lat = axis === "x" ? pole.x : pole.z;
  const mid = (lo + hi) / 2;
  const halfSpan = (hi - lo) / 2;
  if (!(halfSpan > 1e-9)) return maxScore;
  const t = min(1, abs(lat - mid) / halfSpan);
  return maxScore * (1 - t);
}

/**
 * Per-wall-pole distance-to-anchor scores (0…maxScore). Closest among the given
 * poles gets max; farthest gets 0; linear in between.
 * Default anchor = enemy door mid; override via `opts.mid` (hunt door bias).
 */
export function yawPoleDoorDistScores(
  map: YawPoleMap,
  team: YawPoleTeamId,
  wallPoles: readonly YawPolePoint[],
  opts?: {
    mid?: YawPolePoint | null;
    maxScore?: number;
  },
): Map<string, number> {
  const out = new Map<string, number>();
  const maxScore =
    typeof opts?.maxScore === "number" && Number.isFinite(opts.maxScore)
      ? opts.maxScore
      : YAW_POLE_DOOR_DIST_MAX;
  const mid =
    opts?.mid &&
      Number.isFinite(opts.mid.x) &&
      Number.isFinite(opts.mid.z)
      ? opts.mid
      : enemyDoorMidpoint(map, team);
  if (!mid || wallPoles.length === 0) {
    for (const p of wallPoles) out.set(yawPoleKey(p.x, p.z), 0);
    return out;
  }

  const dists: Array<{ key: string; d: number }> = [];
  let dMin = Infinity;
  let dMax = -Infinity;
  for (const p of wallPoles) {
    const d = distance2(p.x - mid.x, p.z - mid.z);
    const key = yawPoleKey(p.x, p.z);
    dists.push({ key, d });
    if (d < dMin) dMin = d;
    if (d > dMax) dMax = d;
  }

  const span = dMax - dMin;
  for (const { key, d } of dists) {
    if (!(span > 1e-9)) {
      out.set(key, maxScore);
    } else {
      out.set(key, maxScore * ((dMax - d) / span));
    }
  }
  return out;
}

/**
 * Build a per-bot spawn noise map: each wall pole key → float in [min, max].
 * Defaults [{@link YAW_POLE_NOISE_MIN}, {@link YAW_POLE_NOISE_MAX}].
 * Hunt phase uses [{@link HUNT_YAW_POLE_NOISE_MIN}, {@link HUNT_YAW_POLE_NOISE_MAX}].
 * Callers re-roll on death respawn, door-capture home, and door open/close phase.
 */
export function buildYawPoleNoise(
  wallPoles: readonly YawPolePoint[],
  rng: () => number = fallbackRandom,
  opts?: { min?: number; max?: number },
): Record<string, number> {
  const lo =
    typeof opts?.min === "number" && Number.isFinite(opts.min)
      ? opts.min
      : YAW_POLE_NOISE_MIN;
  const hi =
    typeof opts?.max === "number" && Number.isFinite(opts.max)
      ? opts.max
      : YAW_POLE_NOISE_MAX;
  const out: Record<string, number> = {};
  const span = hi - lo;
  for (const p of wallPoles) {
    const u = rng();
    const n = Number.isFinite(u) ? u : 0.5;
    out[yawPoleKey(p.x, p.z)] = lo + min(1, max(0, n)) * span;
  }
  return out;
}

function lookupNoise(
  noise: PickYawPoleInput["poleNoise"],
  key: string,
): number {
  if (!noise) return 0;
  if (noise instanceof Map) {
    const v = noise.get(key);
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  }
  const v = (noise as Record<string, number>)[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function makeBreakdown(parts: {
  doorFov: number;
  playerFov: number;
  movementFov: number;
  proximity: number;
  random: number;
  doorDist: number;
  mapCenter: number;
  humanHeat: number;
}): YawPoleScoreBreakdown {
  const base =
    parts.doorFov +
    parts.playerFov +
    parts.movementFov +
    parts.proximity +
    parts.doorDist +
    parts.mapCenter +
    parts.humanHeat;
  return {
    ...parts,
    total: base + parts.random,
    base,
  };
}

function lookupHumanHeat(
  heat: PickYawPoleInput["humanHeatByPole"],
  key: string,
): number {
  if (!heat) return 0;
  let v: number | undefined;
  if (heat instanceof Map) {
    v = heat.get(key);
  } else {
    v = (heat as Record<string, number>)[key];
  }
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return 0;
  return min(1, v);
}

/**
 * Score wall poles that pass skip / (door FOV ∪ player FOV ∪ movement FOV) / LOS.
 * Does not apply enemy-door hard priority — see {@link pickYawPoleTarget}.
 *
 * Door FOV centers on {@link PickYawPoleInput.goalPoint} when set (hunt agent),
 * else enemy door. DoorDist uses {@link PickYawPoleInput.doorDistPoint} when set.
 */
export function scoreYawWallPoles(input: PickYawPoleInput): ScoredYawPole[] {
  const {
    x,
    z,
    yaw: facingYaw,
    moveYaw: moveYawRaw,
    team,
    map,
    wallPoles,
    blocksLos,
    poleNoise,
    humanHeatByPole,
  } = input;

  const w = resolveYawPoleWeights(input.weights);
  const humanHeatMax = Number.isFinite(w.humanHeatMax) && w.humanHeatMax > 0
    ? w.humanHeatMax
    : 0;
  const doorYaw = resolveGoalYaw(input);
  if (doorYaw === null) return [];

  const moveYaw =
    typeof moveYawRaw === "number" && Number.isFinite(moveYawRaw)
      ? moveYawRaw
      : null;

  const skipR2 = YAW_POLE_SKIP_RADIUS * YAW_POLE_SKIP_RADIUS;
  const doorDistByKey = yawPoleDoorDistScores(map, team, wallPoles, {
    mid: input.doorDistPoint,
    maxScore: w.doorDistMax,
  });

  type Cand = {
    pole: YawPolePoint;
    d2: number;
    doorFov: number;
    playerFov: number;
    movementFov: number;
    random: number;
    doorDist: number;
    mapCenter: number;
  };

  const ignore = input.ignorePoleKeys;
  const ownExcl = input.excludeNearOwnDoorDist;
  const ownMid =
    typeof ownExcl === "number" && Number.isFinite(ownExcl) && ownExcl > 0
      ? ownDoorMidpoint(map, team)
      : null;
  const ownExclR2 =
    ownMid && typeof ownExcl === "number" ? ownExcl * ownExcl : 0;

  const cands: Cand[] = [];
  for (const c of wallPoles) {
    const dx = c.x - x;
    const dz = c.z - z;
    const d2 = dx * dx + dz * dz;
    if (d2 < skipR2) continue;
    if (yawPoleKeyIgnored(ignore, yawPoleKey(c.x, c.z))) continue;
    // Path leave-home: never sticky-lock lip poles on the scorer's own door.
    if (ownMid && ownExclR2 > 0) {
      const odx = c.x - ownMid.x;
      const odz = c.z - ownMid.z;
      if (odx * odx + odz * odz < ownExclR2) continue;
    }

    const toYaw = fastAtan2(-dx, -dz);
    const inDoor = yawInHalfAngle(toYaw, doorYaw, w.doorFovHalfAngle);
    const playerFov = continuousFovPoleScore(
      facingYaw,
      toYaw,
      w.playerFovHalfAngle,
      w.playerFovCenter,
      w.playerFovEdge,
    );
    const movementFov =
      moveYaw === null
        ? 0
        : continuousFovPoleScore(
          moveYaw,
          toYaw,
          w.movementFovHalfAngle,
          w.movementFovCenter,
          w.movementFovEdge,
        );
    const inPlayer = playerFov > 0;
    const inMove = movementFov > 0;
    // Cheap FOV filter before full-wall belly LOS (one ray per remaining pole).
    if (!inDoor && !inPlayer && !inMove) continue;
    if (blocksLos && d2 >= 1e-8 && blocksLos(x, z, c.x, c.z)) continue;

    const key = yawPoleKey(c.x, c.z);
    cands.push({
      pole: c,
      d2,
      doorFov: inDoor ? w.doorFov : 0,
      playerFov,
      movementFov,
      random: lookupNoise(poleNoise, key),
      doorDist: doorDistByKey.get(key) ?? 0,
      mapCenter: yawPoleMapCenterScore(map, team, c, w.mapCenterMax),
    });
  }

  // Proximity ranks among filtered candidates.
  cands.sort((a, b) => a.d2 - b.d2 || a.pole.x - b.pole.x || a.pole.z - b.pole.z);
  const scored: ScoredYawPole[] = cands.map((c, i) => {
    const proximity =
      i === 0
        ? w.proximityClosest
        : i === 1
        ? w.proximitySecond
        : 0;
    const pKey = yawPoleKey(c.pole.x, c.pole.z);
    const humanHeat = humanHeatMax > 0
      ? lookupHumanHeat(humanHeatByPole, pKey) * humanHeatMax
      : 0;
    return {
      pole: c.pole,
      score: makeBreakdown({
        doorFov: c.doorFov,
        playerFov: c.playerFov,
        movementFov: c.movementFov,
        proximity,
        random: c.random,
        doorDist: c.doorDist,
        mapCenter: c.mapCenter,
        humanHeat,
      }),
    };
  });

  // Best total first for consumers that only need the ranking.
  scored.sort((a, b) => {
    if (b.score.total !== a.score.total) return b.score.total - a.score.total;
    const da = (a.pole.x - x) ** 2 + (a.pole.z - z) ** 2;
    const db = (b.pole.x - x) ** 2 + (b.pole.z - z) ** 2;
    if (da !== db) return da - db;
    const ka = yawPoleKey(a.pole.x, a.pole.z);
    const kb = yawPoleKey(b.pole.x, b.pole.z);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  return scored;
}

/**
 * Pick the prioritized yaw-pole target (blue-line / bot brain logic).
 * Returns null when no candidate exists (or goal bearing cannot be resolved).
 *
 * Pure / stateless — does not remember last pick. Sticky lock lives outside via
 * {@link stepStickyYawPole} (bot brain bag, client overlay, etc.).
 *
 * Hard-prioritizes the **center** enemy door pole when
 * {@link PickYawPoleInput.hardPrioritizeDoorPoles} is not false. Hunt mode
 * sets it false so wall scores (agent goal) own the pick. Side door poles
 * are never hard-picked — they walk the frame instead of the mouth.
 */
export function pickYawPoleTarget(
  input: PickYawPoleInput,
): YawPolePoint | null {
  const { x, z, enemyDoorPoles, blocksLos } = input;

  // Need a resolvable goal band (enemy door or goalPoint) so scoring can run.
  if (resolveGoalYaw(input) === null) return null;

  const skipR2 = YAW_POLE_SKIP_RADIUS * YAW_POLE_SKIP_RADIUS;
  const blocked = (tx: number, tz: number, d2: number): boolean => {
    if (!blocksLos) return false;
    if (d2 < 1e-8) return false;
    return blocksLos(x, z, tx, tz);
  };

  const ignore = input.ignorePoleKeys;

  // Hard priority: clear LOS (+ optional walk) to the *center* door pole
  // beats every wall pole. Side orange dots are lip-dance generators.
  if (input.hardPrioritizeDoorPoles !== false) {
    const mid = enemyDoorMidpoint(input.map, input.team);
    const center = centerEnemyDoorPole(enemyDoorPoles, mid);
    if (center) {
      const dx = center.x - x;
      const dz = center.z - z;
      const d2 = dx * dx + dz * dz;
      if (
        d2 >= skipR2 &&
        !blocked(center.x, center.z, d2) &&
        !yawPoleKeyIgnored(ignore, yawPoleKey(center.x, center.z)) &&
        (typeof input.walkableTo !== "function" ||
          input.walkableTo(center.x, center.z))
      ) {
        return center;
      }
    }
  }

  const scored = scoreYawWallPoles(input);
  return scored[0]?.pole ?? null;
}

/**
 * Lookahead: the yaw-pole that would be chosen **if we already stood at
 * `current`** with the same facing / move / LOS / noise inputs.
 *
 * Uses {@link YAW_POLE_SKIP_RADIUS} so the current pole is underfoot and
 * filtered out. Not sticky — callers recompute each tick from the locked
 * current target + live yaw. Returns null when `current` is missing or
 * pure pick has nothing further (or would re-select the same key).
 */
export function pickNextYawPoleTarget(
  input: PickYawPoleInput,
  current: YawPolePoint | null | undefined,
): YawPolePoint | null {
  if (
    !current ||
    !Number.isFinite(current.x) ||
    !Number.isFinite(current.z)
  ) {
    return null;
  }
  const next = pickYawPoleTarget({
    ...input,
    x: current.x,
    z: current.z,
  });
  if (!next) return null;
  if (yawPoleKey(next.x, next.z) === yawPoleKey(current.x, current.z)) {
    return null;
  }
  return next;
}

// ---------------------------------------------------------------------------
// Corner rounding ("Lightning McQueen" — go left to go right)
// ---------------------------------------------------------------------------

/**
 * Distance (world units) at which corner-rounding **starts** ramping in.
 * Farther than this → pure walk toward current (no pre-turn / strafe).
 * Tweak here to enter the apex earlier/later.
 */
export const YAW_POLE_CORNER_START_DIST = 7;
/**
 * Distance at which corner effect is **full**. Clamped to at least
 * {@link YAW_POLE_SKIP_RADIUS} so we finish the turn as we "arrive".
 * Between START and END, approachT ramps 0 → 1.
 */
export const YAW_POLE_CORNER_END_DIST = 1.5;
/**
 * At full approach, how much look yaws toward the exit heading
 * (current → next). 1 = fully face next by arrival; 0 = always face current.
 */
export const YAW_POLE_CORNER_LOOK_BLEND = 1;
/**
 * |turn angle| (radians) that maps to max strafe scale.
 * π/2 ⇒ a 90° corner gets full lateral bias (scaled by max strafe).
 */
export const YAW_POLE_CORNER_STRAFE_REF_ANGLE = PI / 2;
/**
 * Max lateral mix into world move at a hard corner + full approach for a
 * "full normal" race-line (personality `cornerRound` = 1).
 * 0 = pure forward; 1 = pure strafe (no forward). ~0.7–0.85 feels race-line.
 * Personality may push past this via over-round (`cornerRound` &gt; 1).
 */
export const YAW_POLE_CORNER_MAX_STRAFE = 0.75;
/**
 * Hard ceiling on lateral mix (including over-round). Above 1 → slight reverse
 * + heavy outside strafe after normalize. Caps pathological config.
 */
export const YAW_POLE_CORNER_OVER_STRAFE_MAX = 1.2;
/**
 * |turn| below this (rad) → treat as straight; skip rounding.
 * Avoids noise strafe on near-collinear pole chains.
 */
export const YAW_POLE_CORNER_MIN_TURN = 0.12;

/** Result of {@link computeYawPoleCornerRound}. */
export type YawPoleCornerRound = {
  /** Desired face yaw (pre-rotated toward exit / next). */
  lookYaw: number;
  /**
   * Desired **world** move yaw — still tracks current, biased laterally to
   * the **outside** of the turn (opposite side from next).
   */
  moveYaw: number;
  /** 0 far → 1 near current (smoothstep of distance between start/end). */
  approachT: number;
  /**
   * Signed turn from approach heading to exit heading in (−π, π].
   * Positive = next is left of approach (CCW).
   */
  turnSigned: number;
  /**
   * Lateral bias in the approach frame: +1 = strafe right, −1 = left.
   * Always opposite the side next sits on ("go left to go right").
   */
  strafeSign: number;
  /**
   * Lateral mix amount in [0, {@link YAW_POLE_CORNER_OVER_STRAFE_MAX}].
   * May exceed 1 under over-round (slight reverse + heavy outside).
   */
  strafeAmount: number;
};

/** Signed shortest yaw delta from `from` to `to` in (−π, π]. */
export function yawPoleSignedDelta(from: number, to: number): number {
  let d = to - from;
  while (d > PI) d -= TWO_PI;
  while (d <= -PI) d += TWO_PI;
  return d;
}

/**
 * Face world point: player forward = (−sin yaw, −cos yaw).
 * Same convention as bot `yawToward` / pure pick bearings.
 */
export function yawPoleToward(
  fromX: number,
  fromZ: number,
  toX: number,
  toZ: number,
): number {
  return fastAtan2(-(toX - fromX), -(toZ - fromZ));
}

/**
 * Corner-round look + move yaws while approaching `current` with a known
 * `next` pole.
 *
 * - **Look** blends approach heading → exit heading (current→next) by
 *   approach closeness so the nose is already on next at arrival.
 * - **Move** keeps progress toward current but strafes the **opposite** side
 *   of the turn; strafe scales with |turn| and approachT.
 *
 * Returns null when next is missing, segments are degenerate, or the turn is
 * below {@link YAW_POLE_CORNER_MIN_TURN} (straight run — pure walk is fine).
 *
 * Pure / no state. Callers still sticky-lock **current** separately; next is
 * live via {@link pickNextYawPoleTarget}.
 */
export function computeYawPoleCornerRound(args: {
  x: number;
  z: number;
  current: YawPolePoint;
  next: YawPolePoint | null | undefined;
  startDist?: number;
  endDist?: number;
  lookBlend?: number;
  strafeRefAngle?: number;
  maxStrafe?: number;
  minTurn?: number;
}): YawPoleCornerRound | null {
  const current = args.current;
  const next = args.next;
  if (
    !next ||
    !Number.isFinite(current.x) ||
    !Number.isFinite(current.z) ||
    !Number.isFinite(next.x) ||
    !Number.isFinite(next.z)
  ) {
    return null;
  }

  const dxCur = current.x - args.x;
  const dzCur = current.z - args.z;
  const dist = distance2(dxCur, dzCur);
  if (!(dist > 1e-6)) return null;

  const dxExit = next.x - current.x;
  const dzExit = next.z - current.z;
  if (!(distance2(dxExit, dzExit) > 1e-6)) return null;

  const toCurrent = yawPoleToward(args.x, args.z, current.x, current.z);
  const toNext = yawPoleToward(current.x, current.z, next.x, next.z);
  const turnSigned = yawPoleSignedDelta(toCurrent, toNext);

  const minTurn = args.minTurn ?? YAW_POLE_CORNER_MIN_TURN;
  if (abs(turnSigned) < minTurn) return null;

  let startDist = args.startDist ?? YAW_POLE_CORNER_START_DIST;
  let endDist = args.endDist ?? YAW_POLE_CORNER_END_DIST;
  if (!(startDist > 0)) startDist = YAW_POLE_CORNER_START_DIST;
  // End must be strictly inside start for a valid ramp.
  endDist = max(YAW_POLE_SKIP_RADIUS * 0.5, min(endDist, startDist - 1e-3));

  let approachT: number;
  if (dist >= startDist) approachT = 0;
  else if (dist <= endDist) approachT = 1;
  else approachT = (startDist - dist) / (startDist - endDist);
  // Smoothstep: ease in/out so far approach stays quiet and apex bites.
  approachT = approachT * approachT * (3 - 2 * approachT);

  const lookBlend = clamp01(args.lookBlend ?? YAW_POLE_CORNER_LOOK_BLEND);
  const lookYaw = toCurrent + turnSigned * approachT * lookBlend;

  // Which side is next relative to approach forward? +1 = right, −1 = left.
  // Right basis: (cos yaw, −sin yaw) when forward is (−sin, −cos).
  const rx = fastCos(toCurrent);
  const rz = -fastSin(toCurrent);
  // Exit direction in world (unnormalized ok for side).
  const side = dxExit * rx + dzExit * rz;
  // Strafe opposite next: next right → strafe left (−1).
  let strafeSign = 0;
  if (side > 1e-8) strafeSign = -1;
  else if (side < -1e-8) strafeSign = 1;
  // Fallback from turn sign if nearly collinear laterally (should be rare).
  if (strafeSign === 0) {
    strafeSign = turnSigned > 0 ? 1 : -1; // CCW next → strafe right
  }

  const refAngle = max(
    1e-3,
    args.strafeRefAngle ?? YAW_POLE_CORNER_STRAFE_REF_ANGLE,
  );
  // Allow over-round (&gt; full normal / &gt;1 pure strafe) up to OVER_STRAFE_MAX.
  const maxStrafe = clampOverStrafe(
    args.maxStrafe ?? YAW_POLE_CORNER_MAX_STRAFE,
  );
  const angleScale = min(1, abs(turnSigned) / refAngle);
  const strafeAmount = approachT * angleScale * maxStrafe;

  // Blend approach forward with lateral in approach frame.
  const fx = -fastSin(toCurrent);
  const fz = -fastCos(toCurrent);
  const fwdW = 1 - strafeAmount;
  const latW = strafeAmount * strafeSign;
  let mx = fx * fwdW + rx * latW;
  let mz = fz * fwdW + rz * latW;
  const mLen = distance2(mx, mz);
  if (!(mLen > 1e-8)) {
    mx = fx;
    mz = fz;
  } else {
    mx /= mLen;
    mz /= mLen;
  }
  const moveYaw = fastAtan2(-mx, -mz);

  return {
    lookYaw,
    moveYaw,
    approachT,
    turnSigned,
    strafeSign,
    strafeAmount,
  };
}

/** Floor 0, ceiling {@link YAW_POLE_CORNER_OVER_STRAFE_MAX} (over-round ok). */
function clampOverStrafe(v: number): number {
  if (!(v > 0) || !Number.isFinite(v)) return 0;
  if (v > YAW_POLE_CORNER_OVER_STRAFE_MAX) return YAW_POLE_CORNER_OVER_STRAFE_MAX;
  return v;
}

/**
 * Map personality `cornerRound` → maxStrafe for {@link computeYawPoleCornerRound}.
 * 1.0 → {@link YAW_POLE_CORNER_MAX_STRAFE}; &gt;1 over-rounds; clamped to over max.
 */
export function maxStrafeFromCornerRound(cornerRound: number): number {
  if (!(cornerRound > 0) || !Number.isFinite(cornerRound)) return 0;
  return clampOverStrafe(cornerRound * YAW_POLE_CORNER_MAX_STRAFE);
}

/**
 * Smoothstep approach factor for corner distance (0 far → 1 near).
 * Same ramp as {@link computeYawPoleCornerRound}'s approachT.
 */
export function yawPoleCornerApproachT(
  dist: number,
  startDist: number = YAW_POLE_CORNER_START_DIST,
  endDist: number = YAW_POLE_CORNER_END_DIST,
): number {
  let start = startDist;
  let end = endDist;
  if (!(start > 0)) start = YAW_POLE_CORNER_START_DIST;
  end = max(YAW_POLE_SKIP_RADIUS * 0.5, min(end, start - 1e-3));
  if (!(dist > 0) || !Number.isFinite(dist)) return 1;
  let t: number;
  if (dist >= start) t = 0;
  else if (dist <= end) t = 1;
  else t = (start - dist) / (start - end);
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------
// Sticky lock (hoisted state — not inside pure pick)
// ---------------------------------------------------------------------------

/**
 * Opaque bag field for the locked yaw-pole. Lives on bot `BotBrainState` (or
 * any caller bag). Other pipeline steps clear via {@link clearStickyYawPole}
 * or `statePatch: { stickyYawPole: undefined }`.
 */
export const YAW_POLE_STICKY_KEY = "stickyYawPole" as const;

/** Last committed sticky pole keys (oldest → newest, cap {@link YAW_POLE_COMMIT_HISTORY_LEN}). */
export const YAW_POLE_COMMIT_KEYS_KEY = "yawPoleCommitKeys" as const;
/**
 * Ping-pong ban: pole key → remaining **other-pole** clears required before
 * the key may be picked again. Seeded at {@link YAW_POLE_PINGPONG_CLEARS_REQUIRED}.
 */
export const YAW_POLE_IGNORE_KEY = "yawPoleIgnore" as const;

/** Commit history length for A→B→A detection. */
export const YAW_POLE_COMMIT_HISTORY_LEN = 3;
/**
 * After A→B→A, ban B until this many distinct other poles have been arrived at.
 */
export const YAW_POLE_PINGPONG_CLEARS_REQUIRED = 2;

/** Minimal bag that holds sticky lock + optional ping-pong memory. */
export type StickyYawPoleState = {
  stickyYawPole?: YawPolePoint;
  /** Last committed sticky keys (oldest → newest). */
  yawPoleCommitKeys?: string[];
  /** Banned middle poles from A→B→A → remaining other-pole clears. */
  yawPoleIgnore?: Record<string, number>;
};

/**
 * True when feet are inside the pole skip radius (arrived — unlock sticky).
 * Same radius pure pick uses to ignore underfoot poles.
 */
export function isYawPoleArrived(
  x: number,
  z: number,
  pole: YawPolePoint,
  radius: number = YAW_POLE_SKIP_RADIUS,
): boolean {
  const dx = pole.x - x;
  const dz = pole.z - z;
  return dx * dx + dz * dz < radius * radius;
}

/**
 * True when full-wall LOS to the pole is clear (or no `blocksLos` injected).
 * Same occlusion rule pure pick uses for door / wall candidates.
 */
export function isYawPoleLosVisible(
  x: number,
  z: number,
  pole: YawPolePoint,
  blocksLos?: (ox: number, oz: number, tx: number, tz: number) => boolean,
): boolean {
  if (!blocksLos) return true;
  if (!Number.isFinite(pole.x) || !Number.isFinite(pole.z)) return false;
  const dx = pole.x - x;
  const dz = pole.z - z;
  if (dx * dx + dz * dz < 1e-8) return true;
  return !blocksLos(x, z, pole.x, pole.z);
}

/**
 * True when sticky is set, not yet arrived, and still visible (caller may
 * skip pure pick). Pass `stillVisible: false` when LOS is occluded.
 */
export function isYawPoleStickyLocked(
  x: number,
  z: number,
  sticky: YawPolePoint | null | undefined,
  clear?: boolean,
  /** When false, treat as unlocked (pole no longer visible). Default true. */
  stillVisible: boolean = true,
): boolean {
  if (clear || !sticky || stillVisible === false) return false;
  if (!Number.isFinite(sticky.x) || !Number.isFinite(sticky.z)) return false;
  return !isYawPoleArrived(x, z, sticky);
}

/**
 * Record a sticky **commit** (unlock → lock on a new pole key).
 *
 * Consecutive same key is ignored. When the last three commits form A→B→A
 * (A ≠ B), ban B for {@link YAW_POLE_PINGPONG_CLEARS_REQUIRED} other-pole clears.
 * Mutates `state`.
 */
export function recordYawPoleCommit(
  state: StickyYawPoleState,
  key: string,
): void {
  if (typeof key !== "string" || key.length === 0) return;
  const hist = Array.isArray(state.yawPoleCommitKeys)
    ? state.yawPoleCommitKeys.filter((k) => typeof k === "string" && k.length > 0)
    : [];
  if (hist.length > 0 && hist[hist.length - 1] === key) return;
  hist.push(key);
  while (hist.length > YAW_POLE_COMMIT_HISTORY_LEN) hist.shift();
  state.yawPoleCommitKeys = hist;

  if (hist.length < YAW_POLE_COMMIT_HISTORY_LEN) return;
  const a = hist[hist.length - 3]!;
  const b = hist[hist.length - 2]!;
  const c = hist[hist.length - 1]!;
  if (a === c && a !== b) {
    const ignore = { ...(state.yawPoleIgnore ?? {}) };
    ignore[b] = YAW_POLE_PINGPONG_CLEARS_REQUIRED;
    state.yawPoleIgnore = ignore;
  }
}

/**
 * Record an **arrival clear** at `arrivedKey`. Each ban whose key ≠ arrived
 * decrements; at 0 the ban is removed. Arriving on a banned pole does not
 * count toward its own unban. Mutates `state`.
 */
export function recordYawPoleClear(
  state: StickyYawPoleState,
  arrivedKey: string,
): void {
  const ignore = state.yawPoleIgnore;
  if (!ignore || typeof ignore !== "object") return;
  const next: Record<string, number> = {};
  for (const [banned, remRaw] of Object.entries(ignore)) {
    const rem = typeof remRaw === "number" && Number.isFinite(remRaw)
      ? remRaw
      : 0;
    if (!(rem > 0)) continue;
    if (banned === arrivedKey) {
      next[banned] = rem;
      continue;
    }
    const left = rem - 1;
    if (left > 0) next[banned] = left;
  }
  if (Object.keys(next).length > 0) state.yawPoleIgnore = next;
  else delete state.yawPoleIgnore;
}

/** Drop commit history + ping-pong bans (spawn / mode noise / death). */
export function clearYawPolePingPong(state: StickyYawPoleState): void {
  delete state.yawPoleCommitKeys;
  delete state.yawPoleIgnore;
}

/**
 * Sticky lock around pure {@link pickYawPoleTarget}.
 *
 * Once a pole is chosen it stays locked until:
 *  - feet arrive within {@link YAW_POLE_SKIP_RADIUS}, or
 *  - the pole is no longer visible (`stillVisible: false`, typically LOS), or
 *  - `clear` is true (another step / death / explicit unlock).
 *
 * `newPick` is only consumed when unlocked — while locked the sticky target
 * is returned unchanged (FOV / score thrash cannot steal the goal).
 *
 * Callers hoist `sticky` on their own state bag; this helper stays pure.
 * Ping-pong commit/clear is recorded by the caller via
 * {@link recordYawPoleCommit} / {@link recordYawPoleClear}.
 */
export function stepStickyYawPole(args: {
  x: number;
  z: number;
  sticky: YawPolePoint | null | undefined;
  /** Fresh pure pick this tick; ignored while locked. */
  newPick: YawPolePoint | null;
  /** Force unlock (other pipeline step / death). */
  clear?: boolean;
  /**
   * When false, unlock because the pole is no longer visible (e.g. full-wall
   * LOS blocked). Omit / true to keep the prior lock (default).
   */
  stillVisible?: boolean;
}): {
  target: YawPolePoint | null;
  /** Next sticky to persist; null when unlocked with no new pick. */
  sticky: YawPolePoint | null;
  /** True when a prior sticky was dropped this tick (arrive, LOS, or clear). */
  unlocked: boolean;
} {
  let sticky: YawPolePoint | null =
    args.sticky &&
      Number.isFinite(args.sticky.x) &&
      Number.isFinite(args.sticky.z)
      ? { x: args.sticky.x, z: args.sticky.z }
      : null;

  let unlocked = false;
  const lostVisibility = args.stillVisible === false;
  if (
    sticky &&
    (args.clear || lostVisibility || isYawPoleArrived(args.x, args.z, sticky))
  ) {
    sticky = null;
    unlocked = true;
  }

  if (sticky) {
    return { target: sticky, sticky, unlocked: false };
  }

  const next = args.newPick
    ? { x: args.newPick.x, z: args.newPick.z }
    : null;
  return { target: next, sticky: next, unlocked };
}

/**
 * Drop sticky lock (death / reset / another step).
 * Also clears ping-pong commit history + ignore bans so a fresh route can
 * re-evaluate poles without carrying a prior A→B→A ban.
 */
export function clearStickyYawPole(state: StickyYawPoleState): void {
  delete state.stickyYawPole;
  clearYawPolePingPong(state);
}
