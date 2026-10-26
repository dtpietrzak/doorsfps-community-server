import { abs, max, min, refinedAtan2, round } from "../math/index.ts";

/**
 * Closed wall-loop detection for top-down map views (minimap, map builder).
 * Builds a planar graph from wall segments (plus optional outer bounds) and
 * walks clockwise faces. Positive-area faces are filled as solid interiors.
 */

export type WallPolyPoint = { x: number; z: number };

export type WallSegment = {
  a: WallPolyPoint;
  b: WallPolyPoint;
};

export type WallPolyBounds = {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
};

/** Snap wall endpoints so nearly-coincident joints form a single graph node. */
const VERTEX_EPS = 1e-4;
/** Ignore degenerate / open faces (collinear backtracks, zero area). */
const MIN_FACE_AREA = 1e-3;
/** Endpoint lies on a segment / bounds edge. */
const ON_EDGE_EPS = 1e-6;
/** Snap free endpoints onto bounds when this close (loaded map float noise). */
const BOUNDS_SNAP_EPS = 1e-3;

function keyOf(x: number, z: number): string {
  return `${round(x / VERTEX_EPS)},${round(z / VERTEX_EPS)}`;
}

function dist2(a: WallPolyPoint, b: WallPolyPoint): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

function orient(a: WallPolyPoint, b: WallPolyPoint, c: WallPolyPoint): number {
  return (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
}

function onSegment(
  a: WallPolyPoint,
  b: WallPolyPoint,
  p: WallPolyPoint,
): boolean {
  return (
    p.x >= min(a.x, b.x) - ON_EDGE_EPS &&
    p.x <= max(a.x, b.x) + ON_EDGE_EPS &&
    p.z >= min(a.z, b.z) - ON_EDGE_EPS &&
    p.z <= max(a.z, b.z) + ON_EDGE_EPS
  );
}

/**
 * Intersection or T-junction between segments AB and CD.
 * Returns a point that lies on both (including endpoints / collinear cases).
 */
function segmentJoint(
  a: WallPolyPoint,
  b: WallPolyPoint,
  c: WallPolyPoint,
  d: WallPolyPoint,
): WallPolyPoint | null {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  const col = (o: number) => abs(o) < 1e-8;

  // Collinear / endpoint-on-edge cases first.
  if (col(o1) && onSegment(a, b, c)) return { x: c.x, z: c.z };
  if (col(o2) && onSegment(a, b, d)) return { x: d.x, z: d.z };
  if (col(o3) && onSegment(c, d, a)) return { x: a.x, z: a.z };
  if (col(o4) && onSegment(c, d, b)) return { x: b.x, z: b.z };

  // Proper crossing.
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

/** Split segments at every intersection / T-junction so the graph is planar. */
function splitSegmentsAtJoints(segments: WallSegment[]): WallSegment[] {
  const n = segments.length;
  if (n === 0) return [];

  const ptsOn: WallPolyPoint[][] = [];
  const keysOn: string[][] = [];
  for (let i = 0; i < n; i++) {
    ptsOn.push([]);
    keysOn.push([]);
  }

  const addPt = (i: number, p: WallPolyPoint) => {
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
    const items: Array<{ t: number; p: WallPolyPoint }> = [];
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
 * Snap a point onto bounds if it lies on (or nearly on) an outer edge.
 * Returns null when the point is interior.
 */
function snapToBounds(
  p: WallPolyPoint,
  bounds: WallPolyBounds,
): WallPolyPoint | null {
  const { minX, maxX, minZ, maxZ } = bounds;
  let { x, z } = p;
  let on = false;

  if (abs(x - minX) <= BOUNDS_SNAP_EPS) {
    x = minX;
    on = true;
  } else if (abs(x - maxX) <= BOUNDS_SNAP_EPS) {
    x = maxX;
    on = true;
  }

  if (abs(z - minZ) <= BOUNDS_SNAP_EPS) {
    z = minZ;
    on = true;
  } else if (abs(z - maxZ) <= BOUNDS_SNAP_EPS) {
    z = maxZ;
    on = true;
  }

  if (!on) return null;
  // Reject points outside the rectangle (corner diagonal snap noise).
  if (
    x < minX - ON_EDGE_EPS ||
    x > maxX + ON_EDGE_EPS ||
    z < minZ - ON_EDGE_EPS ||
    z > maxZ + ON_EDGE_EPS
  ) {
    return null;
  }
  // Must actually sit on the perimeter, not only corner-snap interior.
  const onPerim =
    abs(x - minX) <= ON_EDGE_EPS ||
    abs(x - maxX) <= ON_EDGE_EPS ||
    abs(z - minZ) <= ON_EDGE_EPS ||
    abs(z - maxZ) <= ON_EDGE_EPS;
  if (!onPerim) return null;
  return { x, z };
}

/**
 * Outer rectangle edges, subdivided at every wall endpoint that touches bounds
 * so interior walls join the perimeter graph.
 */
function exteriorSegments(
  walls: WallSegment[],
  bounds: WallPolyBounds,
): WallSegment[] {
  const { minX, maxX, minZ, maxZ } = bounds;

  type EdgeId = "south" | "north" | "west" | "east";
  const buckets: Record<EdgeId, Array<{ t: number; p: WallPolyPoint }>> = {
    south: [],
    north: [],
    west: [],
    east: [],
  };

  const push = (edge: EdgeId, t: number, p: WallPolyPoint) => {
    buckets[edge].push({ t, p });
  };

  // Corners (each belongs to two edges).
  push("south", minX, { x: minX, z: minZ });
  push("south", maxX, { x: maxX, z: minZ });
  push("north", minX, { x: minX, z: maxZ });
  push("north", maxX, { x: maxX, z: maxZ });
  push("west", minZ, { x: minX, z: minZ });
  push("west", maxZ, { x: minX, z: maxZ });
  push("east", minZ, { x: maxX, z: minZ });
  push("east", maxZ, { x: maxX, z: maxZ });

  const addEndpoint = (raw: WallPolyPoint) => {
    const p = snapToBounds(raw, bounds);
    if (!p) return;
    if (abs(p.z - minZ) <= ON_EDGE_EPS) push("south", p.x, p);
    if (abs(p.z - maxZ) <= ON_EDGE_EPS) push("north", p.x, p);
    if (abs(p.x - minX) <= ON_EDGE_EPS) push("west", p.z, p);
    if (abs(p.x - maxX) <= ON_EDGE_EPS) push("east", p.z, p);
  };
  for (let wi = 0; wi < walls.length; wi++) {
    const wall = walls[wi]!;
    addEndpoint(wall.a);
    addEndpoint(wall.b);
  }

  const segs: WallSegment[] = [];
  const flushEdge = (items: Array<{ t: number; p: WallPolyPoint }>) => {
    const uniq = new Map<string, { t: number; p: WallPolyPoint }>();
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

/** Optional snap of wall endpoints that nearly touch the outer bounds. */
function normalizeWalls(
  walls: WallSegment[],
  bounds: WallPolyBounds | null | undefined,
): WallSegment[] {
  if (!bounds) {
    return walls.map((w) => ({
      a: { x: w.a.x, z: w.a.z },
      b: { x: w.b.x, z: w.b.z },
    }));
  }
  return walls.map((w) => {
    const sa = snapToBounds(w.a, bounds);
    const sb = snapToBounds(w.b, bounds);
    return {
      a: sa ?? { x: w.a.x, z: w.a.z },
      b: sb ?? { x: w.b.x, z: w.b.z },
    };
  });
}

/**
 * Find interior faces of the wall segment graph (closed geometric loops).
 * Uses a planar embedding walk: at each vertex, take the next clockwise edge.
 * Positive-area faces are bounded interiors; negative/zero are exterior or open.
 *
 * When `bounds` is provided, outer walls are part of the graph so alcoves and
 * rooms that close against the perimeter count. The largest positive face
 * (main walkable arena) is discarded so only solid pockets remain.
 */
export function findClosedWallPolygons(
  walls: WallSegment[],
  bounds?: WallPolyBounds | null,
): WallPolyPoint[][] {
  const normalized = normalizeWalls(walls, bounds);
  const seed: WallSegment[] = [...normalized];
  if (bounds) {
    seed.push(...exteriorSegments(normalized, bounds));
  }

  const planar = splitSegmentsAtJoints(seed);
  if (planar.length === 0) return [];

  type NodeKey = string;
  type UndirectedEdge = { a: NodeKey; b: NodeKey };
  const pos = new Map<NodeKey, WallPolyPoint>();
  /** Undirected edges as unique node pairs. */
  const undirected: UndirectedEdge[] = [];
  const seenEdge = new Set<string>();

  for (const wall of planar) {
    const ax = wall.a.x;
    const az = wall.a.z;
    const bx = wall.b.x;
    const bz = wall.b.z;
    const ka = keyOf(ax, az);
    const kb = keyOf(bx, bz);
    if (ka === kb) continue;
    if (!pos.has(ka)) pos.set(ka, { x: ax, z: az });
    if (!pos.has(kb)) pos.set(kb, { x: bx, z: bz });
    const eKey = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
    if (seenEdge.has(eKey)) continue;
    seenEdge.add(eKey);
    undirected.push({ a: ka, b: kb });
  }

  if (undirected.length === 0) return [];

  /** Adjacency: node → neighbors sorted by outgoing angle (CCW from +X). */
  const adj = new Map<NodeKey, NodeKey[]>();
  const addAdj = (from: NodeKey, to: NodeKey) => {
    let list = adj.get(from);
    if (!list) {
      list = [];
      adj.set(from, list);
    }
    list.push(to);
  };
  for (let ei = 0; ei < undirected.length; ei++) {
    const edge = undirected[ei]!;
    addAdj(edge.a, edge.b);
    addAdj(edge.b, edge.a);
  }

  for (const [node, neighbors] of adj) {
    const p = pos.get(node)!;
    neighbors.sort((na, nb) => {
      const pa = pos.get(na)!;
      const pb = pos.get(nb)!;
      return (
        refinedAtan2(pa.z - p.z, pa.x - p.x) -
        refinedAtan2(pb.z - p.z, pb.x - p.x)
      );
    });
  }

  const nbrIndex = new Map<string, number>();
  for (const [node, neighbors] of adj) {
    for (let i = 0; i < neighbors.length; i++) {
      nbrIndex.set(`${node}>${neighbors[i]!}`, i);
    }
  }

  const usedDir = new Set<string>();
  const faces: Array<{ area: number; keys: NodeKey[] }> = [];

  const walkFace = (start: NodeKey, next: NodeKey) => {
    const startDir = `${start}>${next}`;
    if (usedDir.has(startDir)) return;

    const faceKeys: NodeKey[] = [start];
    let cur = start;
    let nxt = next;
    let guard = 0;
    const maxSteps = undirected.length * 4 + 8;

    while (guard++ < maxSteps) {
      usedDir.add(`${cur}>${nxt}`);
      faceKeys.push(nxt);

      const neighbors = adj.get(nxt);
      if (!neighbors || neighbors.length === 0) break;

      const revIdx = nbrIndex.get(`${nxt}>${cur}`);
      if (revIdx === undefined) break;

      // Arrived via cur→nxt. Next clockwise edge = previous in CCW-sorted list.
      const ni = (revIdx - 1 + neighbors.length) % neighbors.length;
      const following = neighbors[ni]!;
      cur = nxt;
      nxt = following;

      if (cur === start && nxt === next) break;
    }

    // Closed walk back to start (drop duplicate close vertex if present).
    if (faceKeys.length < 4) return;
    if (faceKeys[faceKeys.length - 1] !== start) return;
    faceKeys.pop();
    if (faceKeys.length < 3) return;

    let area = 0;
    for (let i = 0; i < faceKeys.length; i++) {
      const p = pos.get(faceKeys[i]!);
      const q = pos.get(faceKeys[(i + 1) % faceKeys.length]!);
      if (!p || !q) return;
      area += p.x * q.z - q.x * p.z;
    }
    area *= 0.5;

    // Keep only positive-area interiors (exterior walks have opposite sign).
    if (area < MIN_FACE_AREA) return;

    faces.push({ area, keys: faceKeys.slice() });
  };

  for (let ei = 0; ei < undirected.length; ei++) {
    const edge = undirected[ei]!;
    walkFace(edge.a, edge.b);
    walkFace(edge.b, edge.a);
  }

  // With outer bounds, every open pocket is a face — drop the main arena
  // (largest area) so only solid closures remain.
  if (bounds && faces.length > 0) {
    let maxArea = -1;
    let maxIdx = 0;
    for (let i = 0; i < faces.length; i++) {
      if (faces[i]!.area > maxArea) {
        maxArea = faces[i]!.area;
        maxIdx = i;
      }
    }
    faces.splice(maxIdx, 1);
  }

  const polygons: WallPolyPoint[][] = [];
  for (let fi = 0; fi < faces.length; fi++) {
    const keys = faces[fi]!.keys;
    const poly: WallPolyPoint[] = [];
    for (let ki = 0; ki < keys.length; ki++) {
      const pt = pos.get(keys[ki]!);
      if (!pt) continue;
      poly.push({ x: pt.x, z: pt.z });
    }
    polygons.push(poly);
  }
  return polygons;
}
