/**
 * Unique wall corner / vertical-edge **yaw / walk-around targets** for bot nav.
 *
 * Pink dots are not the geometric vertices — they sit 1u into open air:
 *  - free end (deg 1): 1u past the tip, collinear with the wall (kept always)
 *  - joint (deg 2+): 1u only **outside** the wall angle — the open sector
 *    strictly larger than 180°. Never inside acute / 90° / obtuse wedges,
 *    and never into solid fill.
 *
 * Outer map bounds count as walls in the graph (joins + T into the perimeter).
 * Pure map-corner nodes (bounds only) are not emitted.
 */

import {
  abs,
  distance2,
  fastCos,
  fastSin,
  max,
  min,
  PI,
  refinedAtan2,
  round,
  TWO_PI,
} from "../math/index.ts";
import {
  findClosedWallPolygons,
  type WallPolyBounds,
  type WallPolyPoint,
  type WallSegment,
} from "./wallPolygons.ts";

export type WallCornerPoint = { x: number; z: number };

export type WallCornerSegment = {
  a: WallCornerPoint;
  b: WallCornerPoint;
  /** Defaults to "full" when omitted (legacy maps). */
  kind?: "full" | "half" | "float" | string;
};

export type WallCornerBounds = WallPolyBounds;

/** Walk-around offset from the geometric joint (world units). */
export const WALL_CORNER_OFFSET = 1.2;

/**
 * Horizontal half-angle of the **player facing** FOV wedge (green).
 * π/4 ⇒ 90° full width. Shared by client debug overlay + server yawPole.
 */
export const YAW_PLAYER_FOV_HALF_ANGLE = PI / 3;

/**
 * Horizontal half-angle of the **movement** FOV wedge (cyan).
 * π/4 ⇒ 90° full width — same as player FOV for now; tweak independently.
 * Centered on the horizontal move direction (wish / slide / velocity).
 * Shared by client debug overlay + server yawPole.
 */
export const YAW_MOVEMENT_FOV_HALF_ANGLE = PI / 2;

/**
 * Horizontal half-angle of the **enemy-door** band (yellow).
 * π/4 ⇒ 90° full width. Independent of player FOV — tweak separately.
 * Shared by client debug overlay + server yawPole.
 */
export const YAW_DOOR_FOV_HALF_ANGLE = PI / 3;

/**
 * Half-angle of the bot **shoot / click** aim box (±1° yaw and pitch from
 * eye center). Shared by server click step + client Y-debug overlay.
 */
export const SHOOT_AIM_FOV_HALF_ANGLE = PI / 180;

/**
 * Yaw poles within this horizontal distance are treated as "already there"
 * (blue guide / bot pick aims at the next-closest pole instead).
 * Shared by client and server.
 */
export const YAW_POLE_SKIP_RADIUS = 1;

/** Snap nearly-coincident joints to one key (matches wallPolygons VERTEX_EPS). */
const VERTEX_EPS = 1e-4;
/** Drop degenerate wall pieces. */
const MIN_SEG_LEN = 1e-4;
/** |θ − π| below this ⇒ collinear continuous wall (skip sector). */
const COLLINEAR_ANGLE_EPS = (8 * PI) / 180;
/**
 * Joint yaw dots only in sectors **outside** any wall angle.
 * Outside ⇒ sector strictly larger than 180° (plus collinear slack so near-flat
 * 180° bars never emit). Acute / right / obtuse wedges (θ ≤ 180°) never get a pin.
 */
const OUTSIDE_ANGLE_MIN = PI + COLLINEAR_ANGLE_EPS;
/** Final target snap so near-duplicate emits collapse. */
const TARGET_SNAP = 0.05;
/** How far along a sector bisector we sample for solid tests. */
const SOLID_PROBE = WALL_CORNER_OFFSET * 0.55;

function keyOf(x: number, z: number): string {
  return `${round(x / VERTEX_EPS)},${round(z / VERTEX_EPS)}`;
}

function targetKey(x: number, z: number): string {
  return `${round(x / TARGET_SNAP)},${round(z / TARGET_SNAP)}`;
}

function isFullWall(kind: WallCornerSegment["kind"]): boolean {
  return kind !== "half" && kind !== "float";
}

function dist2(a: WallCornerPoint, b: WallCornerPoint): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

function orient(
  a: WallCornerPoint,
  b: WallCornerPoint,
  c: WallCornerPoint,
): number {
  return (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
}

function onSegment(
  a: WallCornerPoint,
  b: WallCornerPoint,
  p: WallCornerPoint,
): boolean {
  const eps = 1e-6;
  return (
    p.x >= min(a.x, b.x) - eps &&
    p.x <= max(a.x, b.x) + eps &&
    p.z >= min(a.z, b.z) - eps &&
    p.z <= max(a.z, b.z) + eps
  );
}

function segmentJoint(
  a: WallCornerPoint,
  b: WallCornerPoint,
  c: WallCornerPoint,
  d: WallCornerPoint,
): WallCornerPoint | null {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  const col = (o: number) => abs(o) < 1e-8;

  if (col(o1) && onSegment(a, b, c)) return { x: c.x, z: c.z };
  if (col(o2) && onSegment(a, b, d)) return { x: d.x, z: d.z };
  if (col(o3) && onSegment(c, d, a)) return { x: a.x, z: a.z };
  if (col(o4) && onSegment(c, d, b)) return { x: b.x, z: b.z };

  if (o1 * o2 < 0 && o3 * o4 < 0) {
    const dx1 = b.x - a.x;
    const dz1 = b.z - a.z;
    const dx2 = d.x - c.x;
    const dz2 = d.z - c.z;
    const den = dx1 * dz2 - dz1 * dx2;
    if (abs(den) < 1e-12) return null;
    const t = ((c.x - a.x) * dz2 - (c.z - a.z) * dx2) / den;
    return { x: a.x + t * dx1, z: a.z + t * dz1 };
  }
  return null;
}

/** Split segments at intersections / T-junctions so mid-edge hits become nodes. */
function splitSegmentsAtJoints(segments: WallSegment[]): WallSegment[] {
  const n = segments.length;
  if (n === 0) return [];

  const ptsOn: WallCornerPoint[][] = [];
  const keysOn: string[][] = [];
  for (let i = 0; i < n; i++) {
    ptsOn.push([]);
    keysOn.push([]);
  }
  const addPt = (i: number, p: WallCornerPoint) => {
    const key = keyOf(p.x, p.z);
    const keys = keysOn[i]!;
    for (let k = 0; k < keys.length; k++) {
      if (keys[k] === key) return;
    }
    keys.push(key);
    ptsOn[i]!.push({ x: p.x, z: p.z });
  };

  for (let i = 0; i < n; i++) {
    const s = segments[i]!;
    addPt(i, s.a);
    addPt(i, s.b);
  }
  for (let i = 0; i < n; i++) {
    const si = segments[i]!;
    for (let j = i + 1; j < n; j++) {
      const sj = segments[j]!;
      const joint = segmentJoint(si.a, si.b, sj.a, sj.b);
      if (!joint) continue;
      addPt(i, joint);
      addPt(j, joint);
    }
  }

  const out: WallSegment[] = [];
  for (let i = 0; i < n; i++) {
    const s = segments[i]!;
    const dx = s.b.x - s.a.x;
    const dz = s.b.z - s.a.z;
    const len2 = dx * dx + dz * dz;
    const items: Array<{ t: number; p: WallCornerPoint }> = [];
    const pts = ptsOn[i]!;
    for (let pi = 0; pi < pts.length; pi++) {
      const p = pts[pi]!;
      const t =
        len2 < 1e-18
          ? 0
          : ((p.x - s.a.x) * dx + (p.z - s.a.z) * dz) / len2;
      items.push({ t, p });
    }
    items.sort((u, v) => u.t - v.t);
    for (let k = 0; k < items.length - 1; k++) {
      const p1 = items[k]!.p;
      const p2 = items[k + 1]!.p;
      if (keyOf(p1.x, p1.z) === keyOf(p2.x, p2.z)) continue;
      if (dist2(p1, p2) < VERTEX_EPS * VERTEX_EPS) continue;
      out.push({
        a: { x: p1.x, z: p1.z },
        b: { x: p2.x, z: p2.z },
      });
    }
  }
  return out;
}

/**
 * Outer rectangle edges subdivided at interior-wall touch points so walls
 * that meet the perimeter get correct degree (T into bounds).
 */
function exteriorSegments(
  walls: WallSegment[],
  bounds: WallCornerBounds,
): WallSegment[] {
  const { minX, maxX, minZ, maxZ } = bounds;
  type EdgeId = "south" | "north" | "west" | "east";
  const buckets: Record<EdgeId, Array<{ t: number; p: WallCornerPoint }>> = {
    south: [],
    north: [],
    west: [],
    east: [],
  };
  const push = (edge: EdgeId, t: number, p: WallCornerPoint) => {
    buckets[edge].push({ t, p });
  };
  push("south", minX, { x: minX, z: minZ });
  push("south", maxX, { x: maxX, z: minZ });
  push("north", minX, { x: minX, z: maxZ });
  push("north", maxX, { x: maxX, z: maxZ });
  push("west", minZ, { x: minX, z: minZ });
  push("west", maxZ, { x: minX, z: maxZ });
  push("east", minZ, { x: maxX, z: minZ });
  push("east", maxZ, { x: maxX, z: maxZ });

  const snapEps = 1e-3;
  const addEndpoint = (raw: WallCornerPoint) => {
    let x = raw.x;
    let z = raw.z;
    let on = false;
    if (abs(x - minX) <= snapEps) {
      x = minX;
      on = true;
    } else if (abs(x - maxX) <= snapEps) {
      x = maxX;
      on = true;
    }
    if (abs(z - minZ) <= snapEps) {
      z = minZ;
      on = true;
    } else if (abs(z - maxZ) <= snapEps) {
      z = maxZ;
      on = true;
    }
    if (!on) return;
    if (
      x < minX - 1e-6 ||
      x > maxX + 1e-6 ||
      z < minZ - 1e-6 ||
      z > maxZ + 1e-6
    ) {
      return;
    }
    const p = { x, z };
    if (abs(z - minZ) <= 1e-6) push("south", p.x, p);
    if (abs(z - maxZ) <= 1e-6) push("north", p.x, p);
    if (abs(x - minX) <= 1e-6) push("west", p.z, p);
    if (abs(x - maxX) <= 1e-6) push("east", p.z, p);
  };
  for (let wi = 0; wi < walls.length; wi++) {
    const wall = walls[wi]!;
    addEndpoint(wall.a);
    addEndpoint(wall.b);
  }

  const segs: WallSegment[] = [];
  const flushEdge = (items: Array<{ t: number; p: WallCornerPoint }>) => {
    const uniq = new Map<string, { t: number; p: WallCornerPoint }>();
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      uniq.set(keyOf(item.p.x, item.p.z), item);
    }
    const sorted = [...uniq.values()].sort((a, b) => a.t - b.t);
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i]!.p;
      const b = sorted[i + 1]!.p;
      if (keyOf(a.x, a.z) === keyOf(b.x, b.z)) continue;
      segs.push({
        a: { x: a.x, z: a.z },
        b: { x: b.x, z: b.z },
      });
    }
  };
  flushEdge(buckets.south);
  flushEdge(buckets.north);
  flushEdge(buckets.west);
  flushEdge(buckets.east);
  return segs;
}

function pointInPolygon(p: WallCornerPoint, poly: WallPolyPoint[]): boolean {
  let inside = false;
  let i = 0;
  let j = poly.length - 1;
  for (; i < poly.length; ) {
    const pi = poly[i]!;
    const pj = poly[j]!;
    const intersect =
      pi.z > p.z !== pj.z > p.z &&
      p.x <
        ((pj.x - pi.x) * (p.z - pi.z)) / (pj.z - pi.z + 1e-12) + pi.x;
    if (intersect) inside = !inside;
    j = i;
    i += 1;
  }
  return inside;
}

function pointInAnySolid(
  p: WallCornerPoint,
  solids: WallPolyPoint[][],
): boolean {
  for (const poly of solids) {
    if (poly.length >= 3 && pointInPolygon(p, poly)) return true;
  }
  return false;
}

function inBounds(
  p: WallCornerPoint,
  bounds: WallCornerBounds | null | undefined,
  pad = 0,
): boolean {
  if (!bounds) return true;
  return (
    p.x >= bounds.minX - pad &&
    p.x <= bounds.maxX + pad &&
    p.z >= bounds.minZ - pad &&
    p.z <= bounds.maxZ + pad
  );
}

function unitFromTo(
  from: WallCornerPoint,
  to: WallCornerPoint,
): WallCornerPoint | null {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const len = distance2(dx, dz);
  if (len < MIN_SEG_LEN) return null;
  return { x: dx / len, z: dz / len };
}

/** CCW angle from unit d0 to unit d1 in [0, 2π). */
function ccwAngle(d0: WallCornerPoint, d1: WallCornerPoint): number {
  let a = refinedAtan2(d1.z, d1.x) - refinedAtan2(d0.z, d0.x);
  if (a < 0) a += TWO_PI;
  return a;
}

function sectorBisector(
  d0: WallCornerPoint,
  sectorAngle: number,
): WallCornerPoint {
  const a0 = refinedAtan2(d0.z, d0.x);
  const mid = a0 + sectorAngle / 2;
  return { x: fastCos(mid), z: fastSin(mid) };
}

/** True when the sector is the exterior of a wall corner (never ≤ 180°). */
function isOutsideAngleSector(theta: number): boolean {
  return theta > OUTSIDE_ANGLE_MIN;
}

type GraphEdge = {
  aKey: string;
  bKey: string;
  /** True when the edge comes from an interior full wall (not outer bounds). */
  interior: boolean;
};

/**
 * Collect offset yaw / walk-around targets for full walls + outer bounds.
 * When `bounds` is provided, the outer perimeter is part of the wall graph.
 * Pure bounds-only corners are not emitted (their “outside” is off-map).
 */
export function computeWallCorners(
  walls: readonly WallCornerSegment[],
  bounds?: WallCornerBounds | null,
): WallCornerPoint[] {
  const interiorSegs: WallSegment[] = [];
  for (const wall of walls) {
    if (!isFullWall(wall.kind)) continue;
    if (!Number.isFinite(wall.a.x) || !Number.isFinite(wall.a.z)) continue;
    if (!Number.isFinite(wall.b.x) || !Number.isFinite(wall.b.z)) continue;
    if (distance2(wall.b.x - wall.a.x, wall.b.z - wall.a.z) < MIN_SEG_LEN) {
      continue;
    }
    interiorSegs.push({
      a: { x: wall.a.x, z: wall.a.z },
      b: { x: wall.b.x, z: wall.b.z },
    });
  }
  // Outer walls alone never emit (no interior geometry). Still require at
  // least one full interior wall so we have something to path around.
  if (interiorSegs.length === 0) return [];

  // Outer map walls always join the graph when bounds are known.
  const seed: WallSegment[] = [...interiorSegs];
  if (bounds) {
    seed.push(...exteriorSegments(interiorSegs, bounds));
  }
  const planar = splitSegmentsAtJoints(seed);

  // Tag which planar edges touch an original interior segment (approx by
  // midpoint proximity to some interior seg — after split, pieces lie on them).
  const interiorKeys = new Set<string>();
  const markInterior = (a: WallCornerPoint, b: WallCornerPoint) => {
    const ka = keyOf(a.x, a.z);
    const kb = keyOf(b.x, b.z);
    if (ka === kb) return;
    interiorKeys.add(ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`);
  };
  // Re-split only interior segs so keys match planar pieces on interior walls.
  for (const s of splitSegmentsAtJoints(interiorSegs)) {
    markInterior(s.a, s.b);
  }

  type NodeKey = string;
  const pos = new Map<NodeKey, WallCornerPoint>();
  const edges: GraphEdge[] = [];
  const seenEdge = new Set<string>();

  for (const wall of planar) {
    const ka = keyOf(wall.a.x, wall.a.z);
    const kb = keyOf(wall.b.x, wall.b.z);
    if (ka === kb) continue;
    if (!pos.has(ka)) pos.set(ka, { x: wall.a.x, z: wall.a.z });
    if (!pos.has(kb)) pos.set(kb, { x: wall.b.x, z: wall.b.z });
    const eKey = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
    if (seenEdge.has(eKey)) continue;
    seenEdge.add(eKey);
    edges.push({
      aKey: ka,
      bKey: kb,
      interior: interiorKeys.has(eKey),
    });
  }

  /** node → neighbor keys */
  const adj = new Map<NodeKey, NodeKey[]>();
  /** node has at least one interior wall edge */
  const hasInterior = new Set<NodeKey>();
  for (const e of edges) {
    let la = adj.get(e.aKey);
    if (!la) {
      la = [];
      adj.set(e.aKey, la);
    }
    la.push(e.bKey);
    let lb = adj.get(e.bKey);
    if (!lb) {
      lb = [];
      adj.set(e.bKey, lb);
    }
    lb.push(e.aKey);
    if (e.interior) {
      hasInterior.add(e.aKey);
      hasInterior.add(e.bKey);
    }
  }

  // Solid pockets for sector rejection (same rules as map-builder fill).
  const solids = findClosedWallPolygons(interiorSegs, bounds ?? null);

  const emitted = new Map<string, WallCornerPoint>();
  /**
   * Never pull OOB points back into the arena — that would slide an “outside”
   * pin into the inside of a map/wall angle. Drop OOB / solid targets instead.
   */
  const emit = (p: WallCornerPoint) => {
    if (bounds && !inBounds(p, bounds, 0.01)) return;
    if (pointInAnySolid(p, solids)) return;
    const k = targetKey(p.x, p.z);
    if (emitted.has(k)) return;
    emitted.set(k, { x: p.x, z: p.z });
  };

  for (const [node, neighbors] of adj) {
    // Pure outer-wall corners (no interior wall) — skip. Their exterior is
    // off-map; their interior is “inside” the map-corner angle.
    if (!hasInterior.has(node)) continue;
    const V = pos.get(node)!;

    // Unique neighbor dirs (unit vectors V → neighbor), including outer walls.
    type Dir = { key: NodeKey; u: WallCornerPoint; ang: number };
    const dirs: Dir[] = [];
    const seenN = new Set<string>();
    for (const nk of neighbors) {
      if (seenN.has(nk)) continue;
      seenN.add(nk);
      const N = pos.get(nk)!;
      const u = unitFromTo(V, N);
      if (!u) continue;
      dirs.push({ key: nk, u, ang: refinedAtan2(u.z, u.x) });
    }
    dirs.sort((a, b) => a.ang - b.ang);
    // Dedup near-identical angles (overlapping segments).
    const uniqueDirs: Dir[] = [];
    for (const d of dirs) {
      const prev = uniqueDirs[uniqueDirs.length - 1];
      if (prev && abs(d.ang - prev.ang) < 1e-6) continue;
      if (
        uniqueDirs.length > 0 &&
        abs(d.ang - uniqueDirs[0]!.ang + TWO_PI) < 1e-6
      ) {
        continue;
      }
      uniqueDirs.push(d);
    }

    const degree = uniqueDirs.length;
    if (degree === 0) continue;

    // ── Degree 1: free end — 1u past tip, collinear (always kept) ───────
    if (degree === 1) {
      const towardNeighbor = uniqueDirs[0]!.u;
      // Away from the wall body = opposite of toward-neighbor.
      emit({
        x: V.x - towardNeighbor.x * WALL_CORNER_OFFSET,
        z: V.z - towardNeighbor.z * WALL_CORNER_OFFSET,
      });
      continue;
    }

    // ── Degree 2+: ONLY outside-angle sectors (θ > 180°) ────────────────
    // Never place a yaw dot inside acute / 90° / obtuse wedges.
    for (let i = 0; i < uniqueDirs.length; i++) {
      const d0 = uniqueDirs[i]!.u;
      const d1 = uniqueDirs[(i + 1) % uniqueDirs.length]!.u;
      const theta = ccwAngle(d0, d1);
      if (!isOutsideAngleSector(theta)) continue;

      const bis = sectorBisector(d0, theta);
      const probe = {
        x: V.x + bis.x * SOLID_PROBE,
        z: V.z + bis.z * SOLID_PROBE,
      };
      // Outside the geometric angle but still solid fill → skip.
      if (pointInAnySolid(probe, solids)) continue;

      emit({
        x: V.x + bis.x * WALL_CORNER_OFFSET,
        z: V.z + bis.z * WALL_CORNER_OFFSET,
      });
    }
  }

  return [...emitted.values()];
}

/** Minimal door side for auto door yaw-dots (matches map TeamSide edge + width). */
export type DoorYawDotSide = {
  edge: "south" | "east" | "north" | "west";
  doorHalfWidth: number;
};

/**
 * Three orange yaw-dot targets per door, sitting **on** the door line:
 * left door edge, center, right door edge (no inset into the map).
 */
export function computeDoorYawDots(
  bounds: WallCornerBounds,
  teamA: DoorYawDotSide,
  teamB: DoorYawDotSide,
): WallCornerPoint[] {
  return [
    ...doorYawDotsForSide(bounds, teamA),
    ...doorYawDotsForSide(bounds, teamB),
  ];
}

function doorYawDotsForSide(
  bounds: WallCornerBounds,
  side: DoorYawDotSide,
): WallCornerPoint[] {
  const ends = doorLineSegment(bounds, side);
  const d0 = ends[0];
  const d1 = ends[1];
  const midX = (d0.x + d1.x) / 2;
  const midZ = (d0.z + d1.z) / 2;
  return [
    { x: d0.x, z: d0.z },
    { x: midX, z: midZ },
    { x: d1.x, z: d1.z },
  ];
}

/**
 * Door line endpoints (left / right on the perimeter edge) — same geometry as
 * client/server `doorSegment`. Shared so yaw-pole door bearing matches poles.
 */
export function doorLineSegment(
  bounds: WallCornerBounds,
  side: DoorYawDotSide,
): [WallCornerPoint, WallCornerPoint] {
  const { minX, maxX, minZ, maxZ } = bounds;
  // Corner order matches map EDGE_CORNERS: SW, SE, NE, NW.
  let p0: WallCornerPoint;
  let p1: WallCornerPoint;
  switch (side.edge) {
    case "south":
      p0 = { x: minX, z: minZ };
      p1 = { x: maxX, z: minZ };
      break;
    case "east":
      p0 = { x: maxX, z: minZ };
      p1 = { x: maxX, z: maxZ };
      break;
    case "north":
      p0 = { x: maxX, z: maxZ };
      p1 = { x: minX, z: maxZ };
      break;
    case "west":
      p0 = { x: minX, z: maxZ };
      p1 = { x: minX, z: minZ };
      break;
  }
  const mx = (p0.x + p1.x) / 2;
  const mz = (p0.z + p1.z) / 2;
  const dx = p1.x - p0.x;
  const dz = p1.z - p0.z;
  const len = distance2(dx, dz) || 1;
  const ux = dx / len;
  const uz = dz / len;
  const hw = min(side.doorHalfWidth, len / 2 - 0.01);
  return [
    { x: mx - ux * hw, z: mz - uz * hw },
    { x: mx + ux * hw, z: mz + uz * hw },
  ];
}

function mergeCornerLists(
  base: WallCornerPoint[],
  extra: WallCornerPoint[],
): WallCornerPoint[] {
  if (extra.length === 0) return base;
  const out = new Map<string, WallCornerPoint>();
  for (const p of base) out.set(targetKey(p.x, p.z), p);
  for (const p of extra) {
    const k = targetKey(p.x, p.z);
    if (!out.has(k)) out.set(k, p);
  }
  return [...out.values()];
}

/**
 * Prefer author-stored corners from the map file; recompute from walls when
 * missing or empty so legacy maps still get nav corners at runtime.
 * When `doors` is provided, always append automatic door yaw-dots (3 per door).
 */
export function resolveWallCorners(
  walls: readonly WallCornerSegment[],
  stored: readonly WallCornerPoint[] | null | undefined,
  bounds?: WallCornerBounds | null,
  doors?: {
    teamA: DoorYawDotSide;
    teamB: DoorYawDotSide;
  } | null,
): WallCornerPoint[] {
  let corners: WallCornerPoint[];
  if (stored !== null && stored !== undefined && stored.length > 0) {
    corners = [];
    for (let i = 0; i < stored.length; i++) {
      const p = stored[i]!;
      if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
      corners.push({ x: p.x, z: p.z });
    }
  } else {
    corners = computeWallCorners(walls, bounds);
  }
  if (bounds && doors?.teamA && doors?.teamB) {
    corners = mergeCornerLists(
      corners,
      computeDoorYawDots(bounds, doors.teamA, doors.teamB),
    );
  }
  return corners;
}
