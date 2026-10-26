/**
 * Designer-authored bot hint queries.
 *
 * Hints never affect collision or humans — only brain locomotion / camp picks.
 */

import {
  type BotHint,
  type BotHintKind,
  type DoorsMap,
  normalizeBotHints,
  type Vec2,
} from "../../shared/map.ts";
import type { TeamId } from "../../shared/network.ts";
import {
  abs,
  clamp01,
  distance2,
  fastSinCos,
  min,
  PI,
  TWO_PI,
} from "../../math/index.ts";
import { yawToward } from "../../helpers/nav.ts";

/** Maximum distance from the nearest Nudge segment (world units). */
export const NUDGE_MAX_DIST = 5;
/** Avoid A/D chatter when already effectively centered on the line. */
export const NUDGE_CENTER_DEAD_BAND = 0.12;
/** How close to a spawn arrow to pick it up. */
export const SPAWN_HINT_MAX_DIST = 6;
/**
 * Stuck disc locomotion mix (natural vs escape).
 * High blend: escape must dominate. At 0.5, wall-facing path yaw still
 * pulls bots into the obstacle (NW into a south bar, etc.) and they scrub
 * forever. Designer discs mark known traps — honor the escape heading.
 */
export const STUCK_BLEND = 0.9;

export type BotHintInfluence = {
  /** Stuck escape yaw. */
  stuckYaw?: number;
  /** 0 or STUCK_BLEND. */
  stuckBlend: number;
  /** Active kinds this sample. */
  kinds: BotHintKind[];
};

export function emptyInfluence(): BotHintInfluence {
  return {
    stuckBlend: 0,
    kinds: [],
  };
}

/** Mix two yaws by shortest arc. t=0 → a, t=1 → b. */
export function mixYaw(a: number, b: number, t: number): number {
  if (t <= 0) return a;
  if (t >= 1) return b;
  let d = b - a;
  while (d > PI) d -= TWO_PI;
  while (d < -PI) d += TWO_PI;
  return a + d * t;
}

export function pointInPolygon(p: Vec2, poly: readonly Vec2[]): boolean {
  let inside = false;
  let j = poly.length - 1;
  for (let i = 0; i < poly.length; i++) {
    const pi = poly[i]!;
    const pj = poly[j]!;
    const intersect = pi.z > p.z !== pj.z > p.z &&
      p.x <
        ((pj.x - pi.x) * (p.z - pi.z)) / (pj.z - pi.z + 1e-12) + pi.x;
    if (intersect) inside = !inside;
    j = i;
  }
  return inside;
}

export function distPointToSegment(
  p: Vec2,
  a: Vec2,
  b: Vec2,
): { dist: number; t: number; point: Vec2 } {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const apx = p.x - a.x;
  const apz = p.z - a.z;
  const ab2 = abx * abx + abz * abz;
  if (ab2 < 1e-9) {
    return {
      dist: distance2(apx, apz),
      t: 0,
      point: { x: a.x, z: a.z },
    };
  }
  let t = (apx * abx + apz * abz) / ab2;
  t = clamp01(t);
  const qx = a.x + abx * t;
  const qz = a.z + abz * t;
  return {
    dist: distance2(p.x - qx, p.z - qz),
    t,
    point: { x: qx, z: qz },
  };
}

export type NudgeLineHit = {
  dist: number;
  point: Vec2;
  hintId: string;
  segmentIndex: number;
};

function teamHints(map: DoorsMap, team: TeamId): BotHint[] {
  return normalizeBotHints(map).filter((h) => h.team === team);
}

/**
 * Find the single closest same-team Nudge segment within 5 world units.
 * Distance is measured to finite segments, including polyline endpoints.
 */
export function nearestNudgeLine(
  map: DoorsMap,
  team: TeamId,
  x: number,
  z: number,
): NudgeLineHit | null {
  const p = { x, z };
  let best: NudgeLineHit | null = null;
  for (const hint of teamHints(map, team)) {
    if (hint.kind !== "nudge" || hint.points.length < 2) continue;
    for (let index = 1; index < hint.points.length; index++) {
      const hit = distPointToSegment(
        p,
        hint.points[index - 1]!,
        hint.points[index]!,
      );
      if (
        hit.dist <= NUDGE_MAX_DIST &&
        (!best || hit.dist < best.dist)
      ) {
        best = {
          dist: hit.dist,
          point: hit.point,
          hintId: hint.id,
          segmentIndex: index - 1,
        };
      }
    }
  }
  return best;
}

export type NudgeStrafeInfluence = NudgeLineHit & {
  dir: "left" | "right" | "none";
};

/**
 * Resolve A/D relative to the bot's normal forward approach. This does not
 * alter forward steering: it only tells the path-ADAD phase which side moves
 * toward the nearest Nudge segment.
 */
export function sampleNudgeStrafe(
  map: DoorsMap,
  team: TeamId,
  x: number,
  z: number,
  approachYaw: number,
): NudgeStrafeInfluence | null {
  const hit = nearestNudgeLine(map, team, x, z);
  if (!hit) return null;
  const dx = hit.point.x - x;
  const dz = hit.point.z - z;
  // Player right vector for yaw: (cos yaw, -sin yaw).
  const direction = fastSinCos(approachYaw);
  const lateral = dx * direction.cos - dz * direction.sin;
  const dir = abs(lateral) <= NUDGE_CENTER_DEAD_BAND
    ? "none"
    : lateral > 0
    ? "right"
    : "left";
  return { ...hit, dir };
}

/** Sample the remaining continuous steering hint: authored stuck discs. */
export function sampleBotHintInfluence(
  map: DoorsMap,
  team: TeamId,
  x: number,
  z: number,
): BotHintInfluence {
  const out = emptyInfluence();
  const hints = teamHints(map, team);
  if (hints.length === 0) return out;

  let bestStuckDist = Infinity;
  let stuckYaw: number | undefined;

  for (const h of hints) {
    if (h.kind === "stuck") {
      const d = distance2(x - h.center.x, z - h.center.z);
      if (d <= h.radius && d < bestStuckDist) {
        bestStuckDist = d;
        stuckYaw = h.yaw;
      }
    }
  }

  if (stuckYaw !== undefined) {
    out.kinds.push("stuck");
    out.stuckYaw = stuckYaw;
    out.stuckBlend = STUCK_BLEND;
  }

  return out;
}

/** Authored camp plant points for a team. */
export function listCampHints(map: DoorsMap, team: TeamId): Vec2[] {
  const out: Vec2[] = [];
  for (const h of teamHints(map, team)) {
    if (h.kind === "camp") out.push({ x: h.p.x, z: h.p.z });
  }
  return out;
}

/**
 * Nearest spawn-arrow yaw if the bot is near a team spawn hint segment.
 * Prefers the closest segment within SPAWN_HINT_MAX_DIST.
 */
export function spawnHintYaw(
  map: DoorsMap,
  team: TeamId,
  x: number,
  z: number,
): number | null {
  const p = { x, z };
  let bestDist = SPAWN_HINT_MAX_DIST;
  let bestYaw: number | null = null;
  for (const h of teamHints(map, team)) {
    if (h.kind !== "spawn") continue;
    const { dist } = distPointToSegment(p, h.a, h.b);
    // Also accept near the start of the arrow (spawn pocket).
    const dStart = distance2(x - h.a.x, z - h.a.z);
    const d = min(dist, dStart);
    if (d < bestDist) {
      bestDist = d;
      bestYaw = yawToward(h.a.x, h.a.z, h.b.x, h.b.z);
    }
  }
  return bestYaw;
}

export function inSprintZone(
  map: DoorsMap,
  team: TeamId,
  x: number,
  z: number,
): boolean {
  const p = { x, z };
  for (const h of teamHints(map, team)) {
    if (h.kind !== "sprint") continue;
    if (h.polygon.length >= 3 && pointInPolygon(p, h.polygon)) return true;
  }
  return false;
}

/**
 * Apply stuck-disc influence to a natural path yaw. Nudge hints intentionally
 * do not pass through this function because they press A/D without steering.
 */
export function applyHintMoveYaw(
  naturalYaw: number,
  influence: BotHintInfluence,
): number {
  if (influence.stuckYaw !== undefined && influence.stuckBlend > 0) {
    return mixYaw(naturalYaw, influence.stuckYaw, influence.stuckBlend);
  }
  return naturalYaw;
}
