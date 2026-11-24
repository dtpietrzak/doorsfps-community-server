/**
 * Window gaps cut through full walls.
 *
 * One size for every mode. The opening is a hole in the wall: solid below
 * the sill and above the head, nothing in between. Meshes and collision
 * both come from {@link cutWallOpenings}.
 */

import {
  doorCentersOnWall,
  SLIDING_DOOR_WIDTH,
  type SlidingDoorRef,
} from "./slidingDoors.ts";
import { abs } from "../math/index.ts";

export type WindowVec2 = { x: number; z: number };

/** Fixed opening width along the wall (world units). */
export const WINDOW_WIDTH = 1.5;

/**
 * Bottom of the opening. Wall remains from the floor up to this height.
 * Standing and crouched bodies on the ground still meet that sill.
 */
export const WINDOW_SILL_Y = 0.9;

/**
 * Top of the opening. Wall remains from here up to the full wall top.
 * The opening is shorter than a standing body, so a player on the ground
 * cannot walk through. A body whose feet are on the sill can.
 */
export const WINDOW_HEAD_Y = 2.55;

export type WallSpan = {
  a: WindowVec2;
  b: WindowVec2;
  yMin: number;
  yMax: number;
};

export type WindowRef = {
  wallId: string;
  center: WindowVec2;
};

/** How far a stored center may sit off its wall and still count (world units). */
const CENTER_ON_WALL = 0.25;

type OpeningInterval = { s0: number; s1: number };

function wallAxis(
  a: WindowVec2,
  b: WindowVec2,
): { ux: number; uz: number; len: number } | null {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) return null;
  return { ux: dx / len, uz: dz / len, len };
}

function mergeIntervals(gaps: OpeningInterval[]): OpeningInterval[] {
  if (gaps.length === 0) return [];
  gaps.sort((p, q) => p.s0 - q.s0);
  const merged: OpeningInterval[] = [];
  for (const gap of gaps) {
    const last = merged[merged.length - 1];
    if (!last || gap.s0 > last.s1 - 1e-4) merged.push({ s0: gap.s0, s1: gap.s1 });
    else last.s1 = Math.max(last.s1, gap.s1);
  }
  return merged;
}

/** Open intervals along `a` → `b`, clipped to the wall. Empty when nothing lands on it. */
function openingIntervals(
  a: WindowVec2,
  axis: { ux: number; uz: number; len: number },
  centers: readonly WindowVec2[],
  halfWidth: number,
): OpeningInterval[] {
  if (centers.length === 0) return [];
  const { ux, uz, len } = axis;
  const gaps: OpeningInterval[] = [];
  for (const center of centers) {
    const s = (center.x - a.x) * ux + (center.z - a.z) * uz;
    const px = a.x + ux * s;
    const pz = a.z + uz * s;
    if (Math.hypot(center.x - px, center.z - pz) > CENTER_ON_WALL) continue;
    const raw0 = s - halfWidth;
    const raw1 = s + halfWidth;
    if (raw1 <= 1e-4 || raw0 >= len - 1e-4) continue;
    const s0 = Math.max(0, raw0);
    const s1 = Math.min(len, raw1);
    if (s1 - s0 < 1e-3) continue;
    gaps.push({ s0, s1 });
  }
  return mergeIntervals(gaps);
}

export function windowCentersOnWall(
  wallId: string,
  windows: readonly WindowRef[] | undefined,
): WindowVec2[] {
  if (!windows || windows.length === 0) return [];
  const centers: WindowVec2[] = [];
  for (const win of windows) {
    if (win.wallId === wallId) centers.push(win.center);
  }
  return centers;
}

/**
 * Split one wall slab around window centers.
 * Slabs that do not cover the opening (half walls, float slabs) are unchanged.
 * Each opening keeps the parent slab below the sill and above the head.
 */
export function cutWallOpenings(
  a: WindowVec2,
  b: WindowVec2,
  yMin: number,
  yMax: number,
  centers: readonly WindowVec2[],
): WallSpan[] {
  const whole: WallSpan = {
    a: { x: a.x, z: a.z },
    b: { x: b.x, z: b.z },
    yMin,
    yMax,
  };
  if (centers.length === 0) return [whole];
  if (yMin > WINDOW_SILL_Y + 1e-4 || yMax < WINDOW_HEAD_Y - 1e-4) return [whole];

  const axis = wallAxis(a, b);
  if (!axis) return [whole];
  const merged = openingIntervals(a, axis, centers, WINDOW_WIDTH / 2);
  if (merged.length === 0) return [whole];
  const { ux, uz, len } = axis;

  const at = (s: number): WindowVec2 => ({ x: a.x + ux * s, z: a.z + uz * s });
  const spans: WallSpan[] = [];
  let cursor = 0;
  for (const gap of merged) {
    if (gap.s0 > cursor + 1e-4) {
      spans.push({ a: at(cursor), b: at(gap.s0), yMin, yMax });
    }
    if (WINDOW_SILL_Y > yMin + 1e-4) {
      spans.push({
        a: at(gap.s0),
        b: at(gap.s1),
        yMin,
        yMax: WINDOW_SILL_Y,
      });
    }
    if (yMax > WINDOW_HEAD_Y + 1e-4) {
      spans.push({
        a: at(gap.s0),
        b: at(gap.s1),
        yMin: WINDOW_HEAD_Y,
        yMax,
      });
    }
    cursor = gap.s1;
  }
  if (cursor < len - 1e-4) {
    spans.push({ a: at(cursor), b: at(len), yMin, yMax });
  }
  return spans.length > 0 ? spans : [whole];
}

/**
 * Remove full-height door intervals from spans that were already cut for windows.
 * A door wins over a window: sill and header inside the door interval go too.
 */
function subtractDoorGaps(
  spans: readonly WallSpan[],
  originA: WindowVec2,
  originB: WindowVec2,
  centers: readonly WindowVec2[],
): WallSpan[] {
  if (centers.length === 0 || spans.length === 0) return spans.slice();
  const axis = wallAxis(originA, originB);
  if (!axis) return spans.slice();
  const merged = openingIntervals(originA, axis, centers, SLIDING_DOOR_WIDTH / 2);
  if (merged.length === 0) return spans.slice();
  const { ux, uz } = axis;
  const at = (s: number): WindowVec2 => ({
    x: originA.x + ux * s,
    z: originA.z + uz * s,
  });
  const project = (p: WindowVec2) =>
    (p.x - originA.x) * ux + (p.z - originA.z) * uz;
  const out: WallSpan[] = [];
  for (const span of spans) {
    let lo = project(span.a);
    let hi = project(span.b);
    if (hi < lo) {
      const swap = lo;
      lo = hi;
      hi = swap;
    }
    let cursor = lo;
    for (const gap of merged) {
      if (gap.s1 <= cursor + 1e-4) continue;
      if (gap.s0 >= hi - 1e-4) break;
      const cut0 = Math.max(gap.s0, lo);
      const cut1 = Math.min(gap.s1, hi);
      if (cut0 > cursor + 1e-4) {
        out.push({
          a: at(cursor),
          b: at(cut0),
          yMin: span.yMin,
          yMax: span.yMax,
        });
      }
      cursor = Math.max(cursor, cut1);
    }
    if (cursor < hi - 1e-4) {
      out.push({ a: at(cursor), b: at(hi), yMin: span.yMin, yMax: span.yMax });
    }
  }
  return out;
}

/** Collision and mesh spans for one authored wall. Half and float walls ignore openings. */
export function authoredWallSpans(
  wall: { id: string; a: WindowVec2; b: WindowVec2; kind?: string },
  windows: readonly WindowRef[] | undefined,
  yMin: number,
  yMax: number,
  doors?: readonly SlidingDoorRef[],
): WallSpan[] {
  const full = wall.kind !== "half" && wall.kind !== "float";
  const centers = full ? windowCentersOnWall(wall.id, windows) : [];
  const cut = cutWallOpenings(wall.a, wall.b, yMin, yMax, centers);
  if (!full) return cut;
  return subtractDoorGaps(cut, wall.a, wall.b, doorCentersOnWall(wall.id, doors));
}

/**
 * Which body a collision copy moves. Only zombots maps tell them apart
 * (notes/zombots.md step 12c): there a window is solid wall for humans,
 * and a zombie climbs it like a 0.9 m half wall. Other maps: no difference.
 */
export type WindowBody = "human" | "zombie";

/** A collision slab with no window role. */
export const WINDOW_PART_NONE = 0;
/** The slab above a window opening. Zombies on zombots maps ignore it. */
export const WINDOW_PART_HEADER = 1;
/**
 * Zombots only: an invisible slab filling the opening, sill to header.
 * It blocks human movement and nothing else: shots, sight and zombies pass.
 */
export const WINDOW_PART_PANE = 2;
export type WindowPart =
  | typeof WINDOW_PART_NONE
  | typeof WINDOW_PART_HEADER
  | typeof WINDOW_PART_PANE;

export type CollisionWallSpan = WallSpan & { windowPart: WindowPart };

/**
 * Collision slabs for one authored wall: {@link authoredWallSpans} with each
 * window header tagged, plus a pane in each opening when `sealWindows`
 * (zombots maps). Every MapCollision copy builds from this, in this order,
 * so server, bot engine and client prediction agree.
 */
export function collisionWallSpans(
  wall: { id: string; a: WindowVec2; b: WindowVec2; kind?: string },
  windows: readonly WindowRef[] | undefined,
  yMin: number,
  yMax: number,
  doors: readonly SlidingDoorRef[] | undefined,
  sealWindows: boolean,
): CollisionWallSpan[] {
  const spans = authoredWallSpans(wall, windows, yMin, yMax, doors);
  const full = wall.kind !== "half" && wall.kind !== "float";
  const out: CollisionWallSpan[] = [];
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i]!;
    // Only a cut full wall has a slab ending at the sill or starting at the head.
    const header = full && span.yMin > yMin + 1e-4 &&
      abs(span.yMin - WINDOW_HEAD_Y) <= 1e-4;
    out.push({ ...span, windowPart: header ? WINDOW_PART_HEADER : WINDOW_PART_NONE });
    const sill = full && span.yMax < yMax - 1e-4 &&
      abs(span.yMax - WINDOW_SILL_Y) <= 1e-4;
    if (sill && sealWindows) {
      out.push({
        a: { x: span.a.x, z: span.a.z },
        b: { x: span.b.x, z: span.b.z },
        yMin: WINDOW_SILL_Y,
        yMax: WINDOW_HEAD_Y,
        windowPart: WINDOW_PART_PANE,
      });
    }
  }
  return out;
}

/**
 * True when a moving body ignores this slab. Panes block only humans; on
 * zombots maps a zombie also ignores the header so its jump arc over the
 * sill isn't cut short. `zombieClimb` is false everywhere but zombots.
 */
export function windowPartPassable(part: number, zombieClimb: boolean): boolean {
  return zombieClimb && part !== WINDOW_PART_NONE;
}

/**
 * Top-down pieces of a wall. The opening is a gap in the line.
 * Half and float walls are drawn whole.
 */
export function wallPlanSegments(
  wall: { id: string; a: WindowVec2; b: WindowVec2; kind?: string },
  windows: readonly WindowRef[] | undefined,
  doors?: readonly SlidingDoorRef[],
): { a: WindowVec2; b: WindowVec2 }[] {
  if (wall.kind === "half" || wall.kind === "float") {
    return [{ a: wall.a, b: wall.b }];
  }
  const spans = authoredWallSpans(wall, windows, 0, WINDOW_HEAD_Y + 1, doors);
  const plan: { a: WindowVec2; b: WindowVec2 }[] = [];
  for (const span of spans) {
    if (span.yMin <= 1e-4 && span.yMax > WINDOW_HEAD_Y) {
      plan.push({ a: span.a, b: span.b });
    }
  }
  return plan.length > 0 ? plan : [{ a: wall.a, b: wall.b }];
}

type GapDoor = SlidingDoorRef & { id?: string };

/**
 * `openDoorIds` omitted or null: every door is a gap (arenas).
 * A set or array, including empty: only those ids are gaps, so a closed
 * zombots door stays solid. A door with no id counts only in the omitted case.
 */
function doorsForGaps(
  doors: readonly GapDoor[] | undefined,
  openDoorIds: ReadonlySet<string> | readonly string[] | null | undefined,
): readonly GapDoor[] | undefined {
  if (!doors || doors.length === 0 || openDoorIds == null) return doors;
  const open = doorIdSet(openDoorIds);
  const kept: GapDoor[] = [];
  for (let i = 0; i < doors.length; i++) {
    const door = doors[i]!;
    if (door.id !== undefined && open.has(door.id)) kept.push(door);
  }
  return kept;
}

function doorIdSet(ids: ReadonlySet<string> | readonly string[]): ReadonlySet<string> {
  if (isDoorIdSet(ids)) return ids;
  const open = new Set<string>();
  for (let i = 0; i < ids.length; i++) open.add(ids[i]!);
  return open;
}

function isDoorIdSet(
  ids: ReadonlySet<string> | readonly string[],
): ids is ReadonlySet<string> {
  return ids instanceof Set;
}

/**
 * Top-down gaps a closure walk should treat as open: window widths and
 * full-height sliding doors on full walls. Half and float walls are omitted.
 * A center that sits off its wall is ignored.
 * Overlapping openings on one wall merge into one span.
 * `openDoorIds` defaults to every door. Pass a set to seal the rest.
 */
export function interiorOpeningGaps(
  walls: readonly { id?: string; a: WindowVec2; b: WindowVec2; kind?: string }[],
  windows: readonly WindowRef[] | undefined,
  doors: readonly GapDoor[] | undefined,
  openDoorIds?: ReadonlySet<string> | readonly string[] | null,
): { a: WindowVec2; b: WindowVec2 }[] {
  const gapDoors = doorsForGaps(doors, openDoorIds);
  const out: { a: WindowVec2; b: WindowVec2 }[] = [];
  if ((!windows || windows.length === 0) && (!gapDoors || gapDoors.length === 0)) {
    return out;
  }
  for (const wall of walls) {
    if (!wall.id) continue;
    if (wall.kind === "half" || wall.kind === "float") continue;
    const axis = wallAxis(wall.a, wall.b);
    if (!axis) continue;
    const gaps = mergeIntervals([
      ...openingIntervals(
        wall.a,
        axis,
        windowCentersOnWall(wall.id, windows),
        WINDOW_WIDTH / 2,
      ),
      ...openingIntervals(
        wall.a,
        axis,
        doorCentersOnWall(wall.id, gapDoors),
        SLIDING_DOOR_WIDTH / 2,
      ),
    ]);
    const { ux, uz } = axis;
    for (const gap of gaps) {
      out.push({
        a: { x: wall.a.x + ux * gap.s0, z: wall.a.z + uz * gap.s0 },
        b: { x: wall.a.x + ux * gap.s1, z: wall.a.z + uz * gap.s1 },
      });
    }
  }
  return out;
}
