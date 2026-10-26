/**
 * Shared bot navigation helpers used by think steps.
 *
 * Path following, vault, duck, and stuck recovery live in dedicated modules.
 * This file is door/camp geometry, heading math, and cheap collision probes.
 */

import { doorSegment, type DoorsMap, type TeamSide } from "../shared/map.ts";
import type { MapCollision } from "../world/MapCollision.ts";
import type { TeamId } from "../shared/network.ts";
import { fallbackRandom } from "../core/random.ts";
import { MOVE_STAND_EYE } from "../../../shared/sim/moveStep.ts";
import {
  abs,
  approximateDistance2,
  distance2,
  distance3,
  max,
  min,
  PI,
} from "../math/index.ts";
import {
  estimateHalfWallFaceYaw,
  hasOpenSpaceAhead,
  isFullWallAhead,
  isLookIntoFullWall,
  moveKeysForWorldYaw,
  pitchToward,
  pointAlongYaw,
  yawToward,
} from "../navigation/index.ts";

export {
  estimateHalfWallFaceYaw,
  hasOpenSpaceAhead,
  isFullWallAhead,
  isLookIntoFullWall,
  moveKeysForWorldYaw,
  pitchToward,
  yawToward,
};

/** How little horizontal progress counts as "stuck" (world units / tick). */
export const STUCK_MOVE_EPS = 0.02;
/** How far ahead to sample for half-wall jumps. */
export const JUMP_PROBE_DIST = 0.95;
/**
 * Minimum clear run distance (world units) before bots bother sprinting.
 * Short enough that typical mid-map lanes still qualify (humans sprint often).
 */
export const SPRINT_OPEN_DIST = 2;

export type Vec2 = { x: number; z: number };

/**
 * Pull door goals slightly into the map so bots aim at walkable ground inside
 * the capture zone — not the bound plane (where wall probes read as blocked).
 * Keep small so bots still reach the walk-in pocket / DOOR_CAPTURE_RADIUS
 * (and can dwell 0.25s for capture). Slightly shallower than before so they
 * finish closer to the portal plane.
 */
const DOOR_NAV_INSET = 0.28;
/**
 * Within this range of the door goal, never wall-strafe or peel away.
 * Doorframe perimeter tips look like walls; the gap is walkable.
 */
export const DOOR_APPROACH_DIST = 3.5;

/** Midpoint of the opposing team's door (score target while doors are open). */
export function enemyDoorTarget(map: DoorsMap, team: TeamId): Vec2 {
  const enemySide = team === "A" ? map.teamB : map.teamA;
  return doorNavPoint(map, enemySide);
}

/** Midpoint of own team's door (defensive anchor while doors are closed). */
export function ownDoorTarget(map: DoorsMap, team: TeamId): Vec2 {
  const ownSide = team === "A" ? map.teamA : map.teamB;
  return doorNavPoint(map, ownSide);
}

/**
 * Extra inset past the door plane so grey agents spawn on open floor, not in
 * the portal / team-colored threshold (pad extends ~0.6u into the map).
 */
export const AGENT_DOOR_SPAWN_OUTSET = 0.5;

/**
 * Drop-in pose just inside a team's door, facing map center.
 * Used for grey agent spawns on door-close.
 */
export function agentDoorSpawn(
  map: DoorsMap,
  doorTeam: TeamId,
): { x: number; z: number; yaw: number } {
  const side = doorTeam === "A" ? map.teamA : map.teamB;
  // Deeper than nav + 0.5u past the door so they don't spawn in the portal.
  const mid = doorMidpoint(map, side);
  const center = mapCenter(map);
  const dx = center.x - mid.x;
  const dz = center.z - mid.z;
  const len = distance2(dx, dz) || 1;
  const inset = DOOR_NAV_INSET + 0.55 + AGENT_DOOR_SPAWN_OUTSET;
  const x = mid.x + (dx / len) * inset;
  const z = mid.z + (dz / len) * inset;
  return {
    x,
    z,
    yaw: yawToward(x, z, center.x, center.z),
  };
}

function doorMidpoint(map: DoorsMap, side: TeamSide): Vec2 {
  const [d0, d1] = doorSegment(map.bounds, side);
  return {
    x: (d0.x + d1.x) / 2,
    z: (d0.z + d1.z) / 2,
  };
}

/** Door goal inset toward map center (walkable + inside capture radius). */
function doorNavPoint(map: DoorsMap, side: TeamSide): Vec2 {
  const mid = doorMidpoint(map, side);
  const center = mapCenter(map);
  const dx = center.x - mid.x;
  const dz = center.z - mid.z;
  const len = distance2(dx, dz) || 1;
  return {
    x: mid.x + (dx / len) * DOOR_NAV_INSET,
    z: mid.z + (dz / len) * DOOR_NAV_INSET,
  };
}

/** Enemy team side definition (the door this team scores on). */
export function enemyDoorSide(map: DoorsMap, team: TeamId): TeamSide {
  return team === "A" ? map.teamB : map.teamA;
}

/**
 * True when the bot is inside the enemy capture slab and should stop pushing.
 * Prefer this over dist-to-nav for door rushes — nav arriveEps stopped short of
 * DOOR_CAPTURE_RADIUS and bots idled just outside the door.
 */
export function isInEnemyDoorZone(
  collision: MapCollision,
  x: number,
  z: number,
  team: TeamId,
): boolean {
  return collision.isInDoorZone(x, z, enemyDoorSide(collision.map, team));
}

/** Map center in XZ. */
export function mapCenter(map: DoorsMap): Vec2 {
  const { minX, maxX, minZ, maxZ } = map.bounds;
  return {
    x: (minX + maxX) / 2,
    z: (minZ + maxZ) / 2,
  };
}

/**
 * Camp point near a door, stepped toward map center so bots hold an interior
 * angle instead of sitting on the bound / capture plane.
 */
export function doorCampAnchor(
  map: DoorsMap,
  door: Vec2,
  inset = 4.5,
): Vec2 {
  const center = mapCenter(map);
  const dx = center.x - door.x;
  const dz = center.z - door.z;
  const len = distance2(dx, dz) || 1;
  return {
    x: door.x + (dx / len) * inset,
    z: door.z + (dz / len) * inset,
  };
}

/**
 * Standing eye height for camp LOS checks (matches hitscan STAND_EYE_HEIGHT).
 * Kept local so nav does not import combat.
 */
const CAMP_EYE_Y = MOVE_STAND_EYE;
/** Aim height on the door plane when verifying "can see the door". */
const CAMP_DOOR_SIGHT_Y = 1.2;
/** Don't plant inside / on the capture lip. */
export const CAMP_MIN_DOOR_DIST = 3.4;
/** How far from the door we still consider a hold. */
export const CAMP_MAX_DOOR_DIST = 11;
/**
 * Prefer this band so holds are off the door but still an easy walk when
 * doors reopen (enemy staging) or a solid home angle (own door).
 */
const CAMP_SWEET_DIST_MIN = 4.0;
const CAMP_SWEET_DIST_MAX = 8.5;
/**
 * Teammate camp exclusion radius — bots should not plant on top of each other.
 * Slightly larger than arrive dist so two crouch holds don't share the angle.
 * Widened for heatmap anti-clone (was 2.75).
 */
export const CAMP_OCCUPY_RADIUS = 3.25;

export type CoverCampPickMode =
  /** Best scored free sample (default). */
  | "best"
  /** Upstream: next-best free sample after excluding occupied best. */
  | "nextBest"
  /** Downstream: among free samples, maximize distance from enemy door. */
  | "farFromEnemy"
  /**
   * Third+ stream when upstream/downstream are taken: 3rd-best free by score,
   * or farthest from the centroid of teammate claims.
   */
  | "spread";

export type CoverDoorCampOpts = {
  /** Minimum distance from the door midpoint. */
  minDoorDist?: number;
  /** Maximum distance from the door midpoint. */
  maxDoorDist?: number;
  /**
   * When true, bias toward slightly closer holds (enemy-door staging so a
   * score is a short walk when doors open).
   */
  preferTight?: boolean;
  /**
   * Prefer mid-map depths (seeker staging) — soft bias away from both door
   * mouths toward the sweet/far band.
   */
  preferMid?: boolean;
  /** Teammate camp claims to avoid (XZ). */
  avoid?: readonly Vec2[];
  /** Radius around each avoid point (default {@link CAMP_OCCUPY_RADIUS}). */
  avoidRadius?: number;
  /**
   * How to choose among free samples after exclusion.
   * Default `"best"`.
   */
  pickMode?: CoverCampPickMode;
  /**
   * Enemy door position — required for `pickMode: "farFromEnemy"` (downstream).
   * Also used to lightly score downstream when provided with other modes.
   */
  enemyDoor?: Vec2;
  /**
   * RNG for sample jitter / tie-break (defaults to fallbackRandom).
   * Brains inject ctx.rng for determinism.
   */
  rng?: () => number;
  /**
   * Stable preferred door side in [-1, 1] (from {@link botLateralBias}).
   * Positive favors +lateral samples; negative favors −lateral.
   */
  lateralBias?: number;
};

/**
 * Stable per-bot lateral preference in [-1, 1] so squads fan left/right of a
 * door instead of cloning one corner (heatmap anti-clone).
 */
export function botLateralBias(playerId: string): number {
  let h = 5381;
  for (let i = 0; i < playerId.length; i++) {
    h = ((h << 5) + h) + playerId.charCodeAt(i);
    h |= 0;
  }
  const u = ((h >>> 0) % 1000) / 999; // 0..1
  return u * 2 - 1;
}

/** Distance from (x,z) to the nearest avoid claim (Infinity if none). */
export function minDistToClaims(
  x: number,
  z: number,
  avoid: readonly Vec2[] | undefined,
): number {
  if (!avoid || avoid.length === 0) return 1e30;
  let best = 1e30;
  for (let i = 0; i < avoid.length; i++) {
    const a = avoid[i]!;
    const d = approximateDistance2(x - a.x, z - a.z);
    if (d < best) best = d;
  }
  return best;
}

/**
 * True when a standing eye at (fromX, fromZ) can see (toX, toZ) at targetY
 * without a solid wall in between.
 */
export function hasCampLineOfSight(
  collision: MapCollision,
  fromX: number,
  fromZ: number,
  toX: number,
  toZ: number,
  eyeY = CAMP_EYE_Y,
  targetY = CAMP_DOOR_SIGHT_Y,
): boolean {
  const dx = toX - fromX;
  const dy = targetY - eyeY;
  const dz = toZ - fromZ;
  const dist = distance3(dx, dy, dz);
  if (dist < 0.05) return true;
  const wallDist = collision.raycastSolid(
    { x: fromX, y: eyeY, z: fromZ },
    { x: dx, y: dy, z: dz },
    dist,
  );
  return wallDist === null || wallDist >= dist - 0.08;
}

/** True when a full/perimeter wall sits within ~1m of the sample (side cover). */
export function hasAdjacentWallCover(
  collision: MapCollision,
  x: number,
  z: number,
  probeDist = 1.05,
): boolean {
  const dirX = [1, -1, 0, 0, 0.71, -0.71, 0.71, -0.71];
  const dirZ = [0, 0, 1, -1, 0.71, 0.71, -0.71, -0.71];
  for (let i = 0; i < 8; i++) {
    const dx = dirX[i]!;
    const dz = dirZ[i]!;
    if (
      collision.classifyProbe(x + dx * probeDist, z + dz * probeDist) ===
        "blocked"
    ) {
      return true;
    }
  }
  return false;
}

type CampSample = { x: number; z: number; score: number };

/** True when (x,z) is within radius of any avoid point. */
export function isNearCampClaim(
  x: number,
  z: number,
  avoid: readonly Vec2[] | undefined,
  radius: number,
): boolean {
  if (!avoid || avoid.length === 0) return false;
  const r2 = radius * radius;
  for (let i = 0; i < avoid.length; i++) {
    const a = avoid[i]!;
    const dx = x - a.x;
    const dz = z - a.z;
    if (dx * dx + dz * dz < r2) return true;
  }
  return false;
}

/**
 * Sample and score interior holds near a door.
 *
 * Goals (hard bot closed-door / defend camping):
 * 1. Keep LOS to the door (watch who walks through / be ready to score).
 * 2. Prefer tucking next to walls / off-angles over planting on the door axis.
 * 3. Never sit right on the capture lip ("right in front of the door").
 * 4. Optionally avoid teammate claims and pick upstream / downstream alternatives.
 *
 * Falls back to a laterally-jittered `doorCampAnchor` when the map is open.
 */
export function pickCoverDoorCamp(
  collision: MapCollision,
  door: Vec2,
  opts: CoverDoorCampOpts = {},
): Vec2 {
  const map = collision.map;
  const center = mapCenter(map);
  const minDist = opts.minDoorDist ?? CAMP_MIN_DOOR_DIST;
  const maxDist = opts.maxDoorDist ?? CAMP_MAX_DOOR_DIST;
  const preferTight = opts.preferTight ?? false;
  const preferMid = opts.preferMid ?? false;
  const avoid = opts.avoid;
  const avoidRadius = opts.avoidRadius ?? CAMP_OCCUPY_RADIUS;
  const pickMode: CoverCampPickMode = opts.pickMode ?? "best";
  const enemyDoor = opts.enemyDoor;
  const rng = opts.rng ?? fallbackRandom;
  const lateralBias = opts.lateralBias ?? 0;
  // Never plant on occupied samples when teammates already claim spots —
  // caller falls back to mid-roam when we return a crowded fallback.
  const refuseOccupied = Boolean(avoid && avoid.length > 0);

  const ix = center.x - door.x;
  const iz = center.z - door.z;
  const ilen = distance2(ix, iz) || 1;
  const inX = ix / ilen;
  const inZ = iz / ilen;
  // Lateral axis (perpendicular to door→center).
  const latX = -inZ;
  const latZ = inX;

  const depths = preferTight
    ? [3.6, 4.4, 5.2, 6.2, 7.2, 8.5, 10]
    : preferMid
    ? [5.8, 6.8, 7.8, 9.0, 10.5, 5.0, 4.2]
    : [4.2, 5.0, 5.8, 6.8, 7.8, 9.0, 10.5];
  const laterals = [
    0,
    1.4,
    -1.4,
    2.4,
    -2.4,
    3.6,
    -3.6,
    5.0,
    -5.0,
    6.5,
    -6.5,
    8.0,
    -8.0,
  ];

  const free: CampSample[] = [];
  const occupied: CampSample[] = [];

  for (let di = 0; di < depths.length; di++) {
    const depth = depths[di]!;
    for (let li = 0; li < laterals.length; li++) {
      const lat = laterals[li]!;
      // Small per-sample jitter so bots don't stack on the exact same cell.
      const jLat = lat + (rng() - 0.5) * 0.55;
      const jDepth = depth + (rng() - 0.5) * 0.4;
      const rawX = door.x + inX * jDepth + latX * jLat;
      const rawZ = door.z + inZ * jDepth + latZ * jLat;
      const resolved = collision.resolvePosition(rawX, rawZ);
      const x = resolved.x;
      const z = resolved.z;

      if (collision.classifyProbe(x, z) !== "clear") continue;

      const doorDist = distance2(x - door.x, z - door.z);
      if (doorDist < minDist || doorDist > maxDist) continue;

      // Must stay on the interior side of the door plane (toward center).
      const inward = (x - door.x) * inX + (z - door.z) * inZ;
      if (inward < minDist * 0.55) continue;

      if (!hasCampLineOfSight(collision, x, z, door.x, door.z)) continue;

      // Lateral offset from the door centerline (0 = planted in front).
      const latSigned = (x - door.x) * latX + (z - door.z) * latZ;
      const latOff = abs(latSigned);

      let score = 0;
      // Reward leaving the door mouth; punish centerline plants.
      score += min(latOff, 7) * 1.35;
      if (latOff < 1.0) score -= 4.5;
      else if (latOff < 2.0) score -= 1.5;

      // Stable per-bot side preference (anti-clone).
      if (lateralBias !== 0) {
        score += lateralBias * latSigned * 0.9;
      }

      // Prefer samples farther from teammate claims when deconflicting.
      if (avoid && avoid.length > 0) {
        const dClaim = minDistToClaims(x, z, avoid);
        if (Number.isFinite(dClaim)) {
          score += min(dClaim, 10) * 0.95;
        }
      }

      // Sweet distance band.
      if (doorDist >= CAMP_SWEET_DIST_MIN && doorDist <= CAMP_SWEET_DIST_MAX) {
        score += 2.5;
      } else if (doorDist < CAMP_SWEET_DIST_MIN) {
        score -= (CAMP_SWEET_DIST_MIN - doorDist) * 1.2;
      } else {
        score -= (doorDist - CAMP_SWEET_DIST_MAX) * 0.45;
      }
      if (preferTight && doorDist <= 6.5) score += 1.2;
      if (preferMid && doorDist >= 6.0) score += 1.4;

      // Hard requirement of the request: use walls when available.
      const adjacent = hasAdjacentWallCover(collision, x, z);
      if (adjacent) score += 6.5;

      // Off-angle: mid/center cannot freely shoot the hold, but we still see
      // the door (peeking a corner). Strongly preferred when it exists.
      const coveredFromMid = !hasCampLineOfSight(
        collision,
        center.x,
        center.z,
        x,
        z,
        CAMP_EYE_Y,
        CAMP_EYE_Y,
      );
      if (coveredFromMid && adjacent) score += 5.0;
      else if (coveredFromMid) score += 2.0;

      // Mild noise so equal-scoring side picks vary across bots.
      score += rng() * 0.35;

      const sample: CampSample = { x, z, score };
      if (isNearCampClaim(x, z, avoid, avoidRadius)) {
        occupied.push(sample);
      } else {
        free.push(sample);
      }
    }
  }

  const picked = selectCampSample(
    free,
    occupied,
    pickMode,
    enemyDoor,
    refuseOccupied,
  );
  if (picked) return { x: picked.x, z: picked.z };

  // Open maps / no legal cover sample: classical inset + lateral jitter,
  // still trying to stay clear of teammate claims.
  return fallbackDoorCamp(
    collision,
    door,
    { inX, inZ, latX, latZ },
    {
      preferTight,
      minDist,
      avoid,
      avoidRadius,
      pickMode,
      enemyDoor,
      rng,
      lateralBias,
      refuseOccupied,
    },
  );
}

function selectCampSample(
  free: CampSample[],
  occupied: CampSample[],
  pickMode: CoverCampPickMode,
  enemyDoor: Vec2 | undefined,
  refuseOccupied = false,
): CampSample | null {
  // When deconflicting, never fall back onto occupied corners (stacks the squad).
  const pool = free.length > 0 ? free : (refuseOccupied ? [] : occupied);
  if (pool.length === 0) return null;

  const byScore: CampSample[] = [];
  for (let i = 0; i < pool.length; i++) byScore.push(pool[i]!);
  for (let i = 1; i < byScore.length; i++) {
    const cur = byScore[i]!;
    let j = i;
    while (j > 0 && byScore[j - 1]!.score < cur.score) {
      byScore[j] = byScore[j - 1]!;
      j -= 1;
    }
    byScore[j] = cur;
  }
  if (byScore.length === 0) return null;

  if (pickMode === "nextBest") {
    // Upstream: best free if only one claim conflicted; else 2nd-best free.
    if (free.length >= 2) return byScore[1]!;
    if (free.length === 1) return byScore[0]!;
    if (refuseOccupied) return null;
    // Only occupied samples — take the furthest from the top-scoring occupied.
    if (occupied.length >= 2) {
      let top = occupied[0]!;
      for (let i = 1; i < occupied.length; i++) {
        if (occupied[i]!.score >= top.score) top = occupied[i]!;
      }
      let bestAlt: CampSample | null = null;
      let bestDist = -1;
      for (let i = 0; i < occupied.length; i++) {
        const s = occupied[i]!;
        const d = approximateDistance2(s.x - top.x, s.z - top.z);
        if (d > bestDist) {
          bestDist = d;
          bestAlt = s;
        }
      }
      return bestAlt ?? byScore[0]!;
    }
    return byScore[0]!;
  }

  if (pickMode === "spread") {
    // Third stream: 3rd-best free, else farthest from free centroid / claims.
    if (free.length >= 3) return byScore[2]!;
    if (free.length >= 1) {
      // Among free, maximize distance from the mean of free samples.
      let mx = 0;
      let mz = 0;
      for (let i = 0; i < free.length; i++) {
        mx += free[i]!.x;
        mz += free[i]!.z;
      }
      mx /= free.length;
      mz /= free.length;
      let best: CampSample | null = null;
      let bestD = -1;
      for (let i = 0; i < free.length; i++) {
        const s = free[i]!;
        const d = approximateDistance2(s.x - mx, s.z - mz);
        if (d > bestD) {
          bestD = d;
          best = s;
        }
      }
      return best ?? byScore[0]!;
    }
    return refuseOccupied ? null : byScore[0]!;
  }

  if (pickMode === "farFromEnemy" && enemyDoor) {
    // Downstream: maximize distance from enemy door among free (or all) samples.
    // Keep a score floor so we don't plant in garbage when free samples exist.
    const ranked = free.length > 0 ? free : pool;
    let maxScore = -1e30;
    for (let i = 0; i < ranked.length; i++) {
      maxScore = max(maxScore, ranked[i]!.score);
    }
    const floor = maxScore - 8;
    let best: CampSample | null = null;
    let bestEnemyDist = -1;
    for (let i = 0; i < ranked.length; i++) {
      const s = ranked[i]!;
      if (s.score < floor) continue;
      const d = approximateDistance2(s.x - enemyDoor.x, s.z - enemyDoor.z);
      if (
        d > bestEnemyDist ||
        (d === bestEnemyDist && best && s.score > best.score)
      ) {
        bestEnemyDist = d;
        best = s;
      }
    }
    return best ?? byScore[0]!;
  }

  // "best" (default)
  return byScore[0]!;
}

function fallbackDoorCamp(
  collision: MapCollision,
  door: Vec2,
  axes: { inX: number; inZ: number; latX: number; latZ: number },
  opts: {
    preferTight: boolean;
    minDist: number;
    avoid?: readonly Vec2[];
    avoidRadius: number;
    pickMode: CoverCampPickMode;
    enemyDoor?: Vec2;
    rng: () => number;
    lateralBias: number;
    refuseOccupied: boolean;
  },
): Vec2 {
  const map = collision.map;
  const { latX, latZ } = axes;
  const candidates: CampSample[] = [];
  const rng = opts.rng;

  for (let i = 0; i < 16; i++) {
    const inset = opts.preferTight ? 3.2 + rng() * 1.4 : 4.5 + rng() * 2.2;
    const anchor = doorCampAnchor(map, door, inset);
    // Spread laterals further when avoiding teammates; bias preferred side.
    const span = opts.avoid?.length ? 10 : 4.5;
    const lateral = (rng() - 0.5) * span + opts.lateralBias * span * 0.35;
    const raw = {
      x: anchor.x + latX * lateral,
      z: anchor.z + latZ * lateral,
    };
    const resolved = collision.resolvePosition(raw.x, raw.z);
    if (collision.classifyProbe(resolved.x, resolved.z) !== "clear") continue;
    if (
      distance2(resolved.x - door.x, resolved.z - door.z) < opts.minDist * 0.85
    ) {
      continue;
    }
    const near = isNearCampClaim(
      resolved.x,
      resolved.z,
      opts.avoid,
      opts.avoidRadius,
    );
    let score = near ? -10 : 0;
    score += abs(lateral) * 0.3;
    score += opts.lateralBias * lateral * 0.5;
    score += min(minDistToClaims(resolved.x, resolved.z, opts.avoid), 10) *
      0.4;
    if (opts.enemyDoor) {
      score += approximateDistance2(
        resolved.x - opts.enemyDoor.x,
        resolved.z - opts.enemyDoor.z,
      ) * 0.05;
    }
    candidates.push({ x: resolved.x, z: resolved.z, score });
  }

  const free = candidates.filter((c) =>
    !isNearCampClaim(c.x, c.z, opts.avoid, opts.avoidRadius)
  );
  const picked = selectCampSample(
    free,
    candidates,
    opts.pickMode,
    opts.enemyDoor,
    opts.refuseOccupied,
  );
  if (picked) return { x: picked.x, z: picked.z };

  // Last resort: still try a free-ish lateral even if crowded — caller may roam.
  const inset = opts.preferTight ? 3.2 + rng() * 1.4 : 4.5 + rng() * 1.8;
  const anchor = doorCampAnchor(map, door, inset);
  const lat = opts.lateralBias * 5.5 + (rng() - 0.5) * 2;
  return collision.resolvePosition(
    anchor.x + latX * lat,
    anchor.z + latZ * lat,
  );
}

/**
 * Pick a detour yaw offset by probing left/right angles for a clear step that
 * still makes progress toward the goal. Falls back to a random side-step.
 * Never returns a near-reverse peel (≥ ~100°) — those walk bots back into
 * the lane they just left and re-create pillar orbits.
 */
export function smartDetourYawOffset(
  collision: MapCollision,
  x: number,
  z: number,
  baseYaw: number,
  targetX: number,
  targetZ: number,
  probeDist = JUMP_PROBE_DIST,
  rng: () => number = fallbackRandom,
): number {
  // Keep peels in the forward-ish hemisphere. ±2π/3 (~120°) was walking bots
  // south away from the door after wall-escape detours.
  const candidates = [
    PI / 4,
    -PI / 4,
    PI / 2.2,
    -PI / 2.2,
    PI / 3,
    -PI / 3,
    PI / 2.6,
    -PI / 2.6,
  ];

  let bestOffset = 0;
  let bestScore = Number.NEGATIVE_INFINITY;
  const distNow = distance2(targetX - x, targetZ - z);

  for (let i = 0; i < candidates.length; i++) {
    const offset = candidates[i]!;
    const yaw = baseYaw + offset;
    const kind = collision.classifyForward(x, z, yaw, probeDist);
    if (kind === "blocked") continue;

    const next = pointAlongYaw(x, z, yaw, probeDist);
    const distAfter = distance2(targetX - next.x, targetZ - next.z);
    const progress = distNow - distAfter;
    // Reject peels that clearly walk away from the goal.
    if (progress < -0.4) continue;
    const score = progress + (kind === "clear" ? 0.15 : 0.05);
    if (score > bestScore) {
      bestScore = score;
      bestOffset = offset;
    }
  }

  if (bestScore > Number.NEGATIVE_INFINITY) return bestOffset;

  // Last resort: random side peel in the forward hemisphere (not reverse).
  const u = rng();
  const u2 = rng();
  const sign = (Number.isFinite(u) ? u : 0.5) < 0.5 ? -1 : 1;
  const t = Number.isFinite(u2) ? u2 : 0.5;
  const mag = PI / 4 + t * (PI / 5);
  return sign * mag;
}
