/**
 * Enemy-door plant camp (low agentAggression while doors are closed).
 *
 * Pure helpers: personality gates, plant deconflict, spawn-corner look sweep
 * via own door, and campingAnxiety hold intervals (shared by future camps).
 */

import {
  cornerWorld,
  doorSegment,
  type DoorsMap,
} from "../../shared/map.ts";
import { type TeamId, TICK_HZ } from "../../shared/network.ts";
import { PLAYER_CLIP_RADIUS } from "../../../../shared/sim/playerClip.ts";
import {
  abs,
  clamp,
  clamp01,
  distance2,
  distanceSquared2,
  max,
  min,
  PI,
  TWO_PI,
} from "../../math/index.ts";
import type { MapCollision } from "../../world/MapCollision.ts";
import {
  enemyDoorSide,
  enemyDoorTarget,
  ownDoorTarget,
  type Vec2,
  yawToward,
} from "../../helpers/nav.ts";

/** Horizontal separation between enemy-door campers (clip-aware floor). */
export const DOOR_CAMP_OCCUPY_RADIUS = max(
  1.5,
  2 * PLAYER_CLIP_RADIUS + 0.5,
);

/** Close enough to plant to freeze movement (world units). */
export const DOOR_CAMP_ARRIVE_EPS = 0.4;

/** Max |along| from door mid as fraction of half-width for lateral samples. */
const DOOR_CAMP_LATERAL_PAD = 0.35;

/** Lateral sample steps (world units) along the door. */
const DOOR_CAMP_LATERALS = [
  0,
  0.7,
  -0.7,
  1.4,
  -1.4,
  2.1,
  -2.1,
  2.8,
  -2.8,
];

/** How near enemy door mid a teammate must be to count as a camper claim. */
export const DOOR_CAMP_CLAIM_RADIUS = 4;

/** Last this many seconds of the closed phase → walk onto the capture lip. */
export const DOOR_LIP_CAMP_SEC = 3;

/** doorAggression at/above this camps the lip even mid-close. */
export const DOOR_LIP_CAMP_AGGRESSION = 0.75;

/**
 * True when the closed-door plant should sit on the capture lip (score
 * ready / designated rusher) instead of {@link pickCoverDoorCamp}.
 */
export function wantsLipDoorCamp(
  doorAggression: number | undefined,
  tick?: number,
  doorChangeTick?: number,
): boolean {
  if (
    typeof doorAggression === "number" &&
    Number.isFinite(doorAggression) &&
    doorAggression >= DOOR_LIP_CAMP_AGGRESSION
  ) {
    return true;
  }
  if (
    typeof tick === "number" &&
    Number.isFinite(tick) &&
    typeof doorChangeTick === "number" &&
    Number.isFinite(doorChangeTick)
  ) {
    const remain = doorChangeTick - tick;
    return remain >= 0 && remain <= DOOR_LIP_CAMP_SEC * TICK_HZ;
  }
  return false;
}

// ── Personality ────────────────────────────────────────────────────────────

/** True when low aggression should plant on the enemy door (not agent-hunt). */
export function wantsEnemyDoorCamp(
  agentAggression: number | undefined,
): boolean {
  return typeof agentAggression === "number" &&
    Number.isFinite(agentAggression) &&
    agentAggression < 0.5;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Hold-duration band (seconds) between camp look-spot checks.
 * High anxiety → short holds (1.25–2s); low → long (2–5s).
 * (Former high floor 0.75s was too twitchy.)
 * Reuse for any future camping timers so personalities stay consistent.
 */
export function campLookHoldRangeSec(
  campingAnxiety: number | undefined,
): { lo: number; hi: number } {
  const a = clamp01(
    typeof campingAnxiety === "number" && Number.isFinite(campingAnxiety)
      ? campingAnxiety
      : 0.5,
  );
  return {
    lo: lerp(2.0, 1.25, a),
    hi: lerp(5.0, 2.0, a),
  };
}

/** Uniform roll inside {@link campLookHoldRangeSec}. */
export function rollCampLookHoldSec(
  campingAnxiety: number | undefined,
  rng: () => number,
): number {
  const { lo, hi } = campLookHoldRangeSec(campingAnxiety);
  const u = rng();
  const t = Number.isFinite(u) ? clamp01(u) : 0.5;
  return lo + t * (hi - lo);
}

// ── Geometry ───────────────────────────────────────────────────────────────

/** Enemy team's two spawn corner world positions (stable corner order). */
export function enemySpawnCorners(
  map: DoorsMap,
  team: TeamId,
): [Vec2, Vec2] {
  const side = enemyDoorSide(map, team);
  const c0 = cornerWorld(map.bounds, side.corners[0]!);
  const c1 = cornerWorld(map.bounds, side.corners[1]!);
  return [c0, c1];
}

/** Yaw from plant toward enemy spawn corner `lookIndex` (0 or 1). */
export function doorCampLookYaw(
  fromX: number,
  fromZ: number,
  map: DoorsMap,
  team: TeamId,
  lookIndex: 0 | 1,
): number {
  const corners = enemySpawnCorners(map, team);
  const c = lookIndex === 0 ? corners[0] : corners[1];
  return yawToward(fromX, fromZ, c.x, c.z);
}

/** Yaw from plant toward own door mid (sweep waypoint). */
export function doorCampOwnDoorYaw(
  fromX: number,
  fromZ: number,
  map: DoorsMap,
  team: TeamId,
): number {
  const own = ownDoorTarget(map, team);
  return yawToward(fromX, fromZ, own.x, own.z);
}

/** Signed shortest yaw delta in (−π, π]. */
export function doorCampYawSignedDelta(from: number, to: number): number {
  let d = to - from;
  while (d > PI) d -= TWO_PI;
  while (d <= -PI) d += TWO_PI;
  return d;
}

/**
 * True when the **shortest** arc from `fromYaw` to `toYaw` passes near
 * `viaYaw` (within half the arc, roughly). Used to decide if we need an
 * own-door waypoint so the back stays to the enemy door.
 */
export function shortestArcPassesNear(
  fromYaw: number,
  toYaw: number,
  viaYaw: number,
  nearEps = 0.45,
): boolean {
  const total = doorCampYawSignedDelta(fromYaw, toYaw);
  if (abs(total) < 1e-4) return true;
  const toVia = doorCampYawSignedDelta(fromYaw, viaYaw);
  // Via is on the shortest arc when it lies between 0 and total (same sign,
  // |toVia| ≤ |total| + eps).
  if (total > 0) {
    return toVia >= -nearEps && toVia <= total + nearEps;
  }
  return toVia <= nearEps && toVia >= total - nearEps;
}

export type DoorCampPlantOpts = {
  avoid?: readonly Vec2[];
  occupyRadius?: number;
  rng?: () => number;
};

/** Deterministic fallback for library callers; the live brain injects its RNG. */
const CENTERED_DOOR_CAMP_RNG = (): number => 0.5;

/**
 * Pick a capture-zone plant on the enemy door, laterally deconflicted from
 * teammate claims so multiple campers do not stack.
 */
export function pickEnemyDoorCampPlant(
  collision: MapCollision,
  team: TeamId,
  opts: DoorCampPlantOpts = {},
): Vec2 {
  const map = collision.map;
  const side = enemyDoorSide(map, team);
  const base = enemyDoorTarget(map, team);
  const [d0, d1] = doorSegment(map.bounds, side);
  const midX = (d0.x + d1.x) / 2;
  const midZ = (d0.z + d1.z) / 2;
  const alongX = d1.x - d0.x;
  const alongZ = d1.z - d0.z;
  const alongLen = distance2(alongX, alongZ) || 1;
  const ux = alongX / alongLen;
  const uz = alongZ / alongLen;
  const halfW = min(side.doorHalfWidth, alongLen / 2) -
    DOOR_CAMP_LATERAL_PAD;
  const maxAlong = max(0.4, halfW);

  // Inward from door mid to base (capture inset).
  const inX = base.x - midX;
  const inZ = base.z - midZ;

  const avoid = opts.avoid ?? [];
  const occupy = opts.occupyRadius ?? DOOR_CAMP_OCCUPY_RADIUS;
  const rng = opts.rng ?? CENTERED_DOOR_CAMP_RNG;

  type Sample = { x: number; z: number; minD: number; latAbs: number };
  const samples: Sample[] = [];

  for (const lat of DOOR_CAMP_LATERALS) {
    const j = lat + (rng() - 0.5) * 0.25;
    const along = clamp(j, -maxAlong, maxAlong);
    const rawX = midX + ux * along + inX;
    const rawZ = midZ + uz * along + inZ;
    const resolved = collision.resolvePosition(rawX, rawZ);
    const x = resolved.x;
    const z = resolved.z;
    if (collision.classifyProbe(x, z) !== "clear") continue;
    if (!collision.isInDoorZone(x, z, side)) continue;

    let minD = Infinity;
    for (const a of avoid) {
      const d = distance2(x - a.x, z - a.z);
      if (d < minD) minD = d;
    }
    if (!Number.isFinite(minD)) minD = 999;
    samples.push({ x, z, minD, latAbs: abs(along) });
  }

  if (samples.length === 0) {
    return base;
  }

  // Prefer free of occupy radius; among those, larger minD then slight side bias.
  samples.sort((a, b) => {
    const aFree = a.minD >= occupy ? 1 : 0;
    const bFree = b.minD >= occupy ? 1 : 0;
    if (aFree !== bFree) return bFree - aFree;
    if (a.minD !== b.minD) return b.minD - a.minD;
    // Prefer off-center (side to door) over exact mid when equally free.
    return b.latAbs - a.latAbs;
  });

  if (samples.length === 0) return { x: 0, z: 0 };
  return { x: samples[0]!.x, z: samples[0]!.z };
}

/**
 * Living same-team non-agent positions near the enemy door (camp claims).
 */
export function collectEnemyDoorCampClaims(
  map: DoorsMap,
  team: TeamId,
  players: readonly {
    id: string;
    team: TeamId;
    alive: boolean;
    isAgent?: boolean;
    x: number;
    z: number;
  }[],
  selfId: string,
  claimRadius = DOOR_CAMP_CLAIM_RADIUS,
): Vec2[] {
  const door = enemyDoorTarget(map, team);
  const out: Vec2[] = [];
  for (const p of players) {
    if (!p.alive || p.id === selfId || p.team !== team || p.isAgent) continue;
    if (
      distanceSquared2(p.x - door.x, p.z - door.z) <=
        claimRadius * claimRadius
    ) {
      out.push({ x: p.x, z: p.z });
    }
  }
  return out;
}

/** True when within arrive eps of the plant. */
export function isAtDoorCampPlant(
  x: number,
  z: number,
  plantX: number,
  plantZ: number,
  eps = DOOR_CAMP_ARRIVE_EPS,
): boolean {
  return distanceSquared2(x - plantX, z - plantZ) <= eps * eps;
}
