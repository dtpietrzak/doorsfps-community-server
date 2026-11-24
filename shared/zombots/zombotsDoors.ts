/**
 * Zombots sliding-door state (notes/zombots.md, Phase 1 step 4).
 *
 * Which doors are open, the buy rule (reach, then cost), and which zombie
 * spawns the open doors make reachable. Pure: the purse lives elsewhere and
 * comes in as a `spend` callback; collision is opened by the glue
 * (`MapCollision.openSlidingDoor`) when a `doorOpened` intent comes out.
 */

import {
  SLIDING_DOOR_COST,
  slidingDoorBlock,
  slidingDoorPlacement,
  ZOMBOTS_DOOR_REACH,
} from "../world/slidingDoors.ts";
import { authoredWallSpans } from "../world/wallWindows.ts";
import { MOVE_PLAYER_RADIUS } from "../sim/moveStep.ts";
import { abs, ceil, clamp, distance2, distanceSquared2, floor, max, min } from "../math/index.ts";
import type { ZombotsIntent, ZombotsPlayerId, ZombotsSpawnGate } from "./types.ts";

type Vec2 = { x: number; z: number };

/** The map fields door state and spawn gating read. Any DoorsMap fits. */
export type ZombotsDoorMap = {
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  walls: readonly { id: string; a: Vec2; b: Vec2; kind?: string }[];
  doors?: readonly { id: string; wallId: string; center: Vec2; cost?: number }[];
  spawnCorner?: 0 | 1 | 2 | 3;
  zombieSpawns?: readonly { id: string; p: Vec2 }[];
};

export type ZombotsDoor = {
  id: string;
  wallId: string;
  /** Authored center. */
  center: Vec2;
  /**
   * Where reach is measured to: the center snapped onto its wall, the same
   * point the client door mesh and the playtest offer use.
   */
  reachPoint: Vec2;
  cost: number;
};

export type ZombotsDoorRefusal =
  | "unknown"
  | "alreadyOpen"
  | "outOfReach"
  | "cantAfford";

export type ZombotsDoorOpened = Extract<ZombotsIntent, { kind: "doorOpened" }>;

export type ZombotsDoorOpenResult =
  | { ok: true; doorId: string; cost: number; points: number; intent: ZombotsDoorOpened }
  | { ok: false; reason: ZombotsDoorRefusal };

/** Purse debit. Must leave the purse alone when it returns `ok: false`. */
export type ZombotsDoorSpend = (cost: number) => { ok: boolean; points: number };

export class ZombotsDoorState {
  private readonly doors: ZombotsDoor[] = [];
  private readonly open = new Set<string>();

  constructor(map: ZombotsDoorMap) {
    const seen = new Set<string>();
    for (const door of map.doors ?? []) {
      // Duplicate ids would make "open door X" ambiguous; first one wins.
      if (seen.has(door.id)) continue;
      seen.add(door.id);
      const wall = map.walls.find((w) => w.id === door.wallId);
      const place = wall ? slidingDoorPlacement(wall.a, wall.b, door.center) : null;
      const cost = door.cost !== undefined && Number.isFinite(door.cost) && door.cost >= 0
        ? door.cost
        : SLIDING_DOOR_COST;
      this.doors.push({
        id: door.id,
        wallId: door.wallId,
        center: { x: door.center.x, z: door.center.z },
        reachPoint: place ? { x: place.mid.x, z: place.mid.z } : { x: door.center.x, z: door.center.z },
        cost,
      });
    }
  }

  /** Every door in map order. */
  all(): readonly ZombotsDoor[] {
    return this.doors;
  }

  door(doorId: string): ZombotsDoor | null {
    return this.doors.find((d) => d.id === doorId) ?? null;
  }

  isOpen(doorId: string): boolean {
    return this.open.has(doorId);
  }

  /** Open door ids in map order, so the result never depends on buy order. */
  openIds(): string[] {
    return this.doors.filter((d) => this.open.has(d.id)).map((d) => d.id);
  }

  /**
   * Buy a door. Checks run in a fixed order (unknown, already open, reach,
   * cost) and `spend` is only called once everything else has passed, so a
   * refused buy never touches the purse.
   */
  tryOpenDoor(
    playerId: ZombotsPlayerId,
    doorId: string,
    eye: Vec2,
    spend: ZombotsDoorSpend,
  ): ZombotsDoorOpenResult {
    const door = this.door(doorId);
    if (!door) return { ok: false, reason: "unknown" };
    if (this.open.has(doorId)) return { ok: false, reason: "alreadyOpen" };
    if (!withinDoorReach(door, eye)) return { ok: false, reason: "outOfReach" };
    const paid = spend(door.cost);
    if (!paid.ok) return { ok: false, reason: "cantAfford" };
    this.open.add(doorId);
    return {
      ok: true,
      doorId,
      cost: door.cost,
      points: paid.points,
      intent: { kind: "doorOpened", doorId, by: playerId },
    };
  }

  /**
   * Open without a buy: the server's confirmation on a client, or a restore.
   * Returns true when this call opened it.
   */
  markOpen(doorId: string): boolean {
    if (!this.door(doorId) || this.open.has(doorId)) return false;
    this.open.add(doorId);
    return true;
  }
}

/** Horizontal eye-to-door reach, inclusive, like `nearestClosedSlidingDoor`. */
export function withinDoorReach(door: ZombotsDoor, eye: Vec2, reach = ZOMBOTS_DOOR_REACH): boolean {
  if (!Number.isFinite(eye.x) || !Number.isFinite(eye.z)) return false;
  return distanceSquared2(door.reachPoint.x - eye.x, door.reachPoint.z - eye.z) <= reach * reach;
}

/**
 * Spawn id → door ids that must all be open. Missing id or `null` means the
 * spawn can never be reached.
 */
export type ZombotsSpawnDoorRequirements = ReadonlyMap<string, readonly string[] | null>;

/** Gate from a requirement table: a spawn is live once all its doors are open. */
export function spawnGate(
  requirements: ZombotsSpawnDoorRequirements,
  isOpen: (doorId: string) => boolean,
): ZombotsSpawnGate {
  return (spawnId) => {
    const need = requirements.get(spawnId);
    if (!need) return false;
    for (const doorId of need) if (!isOpen(doorId)) return false;
    return true;
  };
}

// ---------------------------------------------------------------------------
// Rooms: flood fill over the floor with every sliding door closed.

/** Matches `WALL_HALF_THICK` in both MapCollision copies (checked in tests). */
export const ZOMBOTS_ROOM_WALL_HALF_THICK = 0.22;
/** Flood-fill cell size. Must stay under the blocked band (2 × 0.57). */
export const ZOMBOTS_ROOM_CELL = 0.25;
/** Inward offset from the spawn corner to the pad's flood seed. */
const PAD_SEED_INSET = 1.5;
/** How far a seed may move to find open floor (cells). */
const SEED_SEARCH_CELLS = 8;

export type ZombotsRoomGraph = {
  /** Room the human pad sits in, or null if the pad is boxed in. */
  padRoom: number | null;
  /** Spawn id → room, in `zombieSpawns` order. Null when inside a wall. */
  spawnRooms: ReadonlyMap<string, number | null>;
  /** Door → the two rooms it joins, in map door order. */
  doorRooms: readonly { doorId: string; rooms: readonly [number, number] | null }[];
  roomCount: number;
};

/**
 * Split the map into rooms with every sliding door shut. Only full-height
 * walls separate rooms: half walls can be jumped and float walls crouched
 * under, while windows are treated as solid (their sill and head stop a
 * walking body, and nav probes call them blocked). Cells are blocked when a
 * body center there would overlap a wall, so gaps a body can't fit through
 * stay shut.
 */
export function zombotsRoomGraph(map: ZombotsDoorMap): ZombotsRoomGraph {
  return zombotsRoomRaster(map).graph;
}

/** Per-room floor stats from the room split, index = room id. */
export type ZombotsRoomStats = {
  /** Free cells in the room. Area is `cells × ZOMBOTS_ROOM_CELL²`. */
  cells: number;
  /** Mean of the cell centers (may sit outside an L-shaped room). */
  centroid: Vec2;
  /** Cell-center bounding box. */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
};

/** The room split plus point lookups, for callers that need more than the graph. */
export type ZombotsRoomRaster = {
  graph: ZombotsRoomGraph;
  rooms: readonly ZombotsRoomStats[];
  /** Room whose cell holds `p`; null on blocked floor or outside the map. */
  roomAt(p: Vec2): number | null;
  /** Like `roomAt`, but falls back to the nearest room within a few cells. */
  roomNear(p: Vec2): number | null;
};

/** {@link zombotsRoomGraph} with the raster kept for lookups. */
export function zombotsRoomRaster(map: ZombotsDoorMap): ZombotsRoomRaster {
  const grid = new FloorGrid(map.bounds);
  const reach = ZOMBOTS_ROOM_WALL_HALF_THICK + MOVE_PLAYER_RADIUS;
  const doors = map.doors ?? [];
  for (const wall of map.walls) {
    if (wall.kind === "half" || wall.kind === "float") continue;
    // No windows: they stay solid here. Door holes are cut, then refilled
    // below by the closed door blocks.
    for (const span of authoredWallSpans(wall, undefined, 0, 1, doors)) {
      grid.blockSegment(span.a, span.b, reach);
    }
  }
  const blocks: { doorId: string; a: Vec2; b: Vec2 }[] = [];
  const seenDoor = new Set<string>();
  for (const door of doors) {
    if (seenDoor.has(door.id)) continue;
    seenDoor.add(door.id);
    const wall = map.walls.find((w) => w.id === door.wallId);
    const block = wall ? slidingDoorBlock(wall, door.center) : null;
    if (!block) continue;
    grid.blockSegment(block.a, block.b, reach);
    blocks.push({ doorId: door.id, a: block.a, b: block.b });
  }
  const roomCount = grid.label();

  const corner = cornerPoint(map.bounds, map.spawnCorner ?? 0);
  const cx = (map.bounds.minX + map.bounds.maxX) / 2;
  const cz = (map.bounds.minZ + map.bounds.maxZ) / 2;
  const padRoom = grid.roomNear({
    x: corner.x + (cx > corner.x ? PAD_SEED_INSET : -PAD_SEED_INSET),
    z: corner.z + (cz > corner.z ? PAD_SEED_INSET : -PAD_SEED_INSET),
  });

  const spawnRooms = new Map<string, number | null>();
  for (const spawn of map.zombieSpawns ?? []) {
    if (!spawnRooms.has(spawn.id)) spawnRooms.set(spawn.id, grid.roomNear(spawn.p));
  }

  const doorRooms: { doorId: string; rooms: readonly [number, number] | null }[] = [];
  const probe = reach + ZOMBOTS_ROOM_CELL * 2;
  for (const block of blocks) {
    const dx = block.b.x - block.a.x;
    const dz = block.b.z - block.a.z;
    const len = distance2(dx, dz);
    const mid = { x: (block.a.x + block.b.x) / 2, z: (block.a.z + block.b.z) / 2 };
    const nx = len > 1e-6 ? -dz / len : 0;
    const nz = len > 1e-6 ? dx / len : 0;
    const left = grid.roomNear({ x: mid.x + nx * probe, z: mid.z + nz * probe });
    const right = grid.roomNear({ x: mid.x - nx * probe, z: mid.z - nz * probe });
    doorRooms.push({
      doorId: block.doorId,
      rooms: left !== null && right !== null && left !== right ? [left, right] : null,
    });
  }

  return {
    graph: { padRoom, spawnRooms, doorRooms, roomCount },
    rooms: grid.stats(roomCount),
    roomAt: (p) => grid.roomAt(p),
    roomNear: (p) => grid.roomNear(p),
  };
}

/**
 * Exact gate from the room graph: a spawn is live when its room connects to
 * the pad through open doors, whichever route the players opened.
 */
export function roomSpawnGate(
  graph: ZombotsRoomGraph,
  isOpen: (doorId: string) => boolean,
): ZombotsSpawnGate {
  return (spawnId) => {
    const room = graph.spawnRooms.get(spawnId);
    if (room === undefined || room === null || graph.padRoom === null) return false;
    return reachableRooms(graph, isOpen).has(room);
  };
}

function reachableRooms(graph: ZombotsRoomGraph, isOpen: (doorId: string) => boolean): Set<number> {
  const seen = new Set<number>();
  if (graph.padRoom === null) return seen;
  seen.add(graph.padRoom);
  // Few doors per map, so relaxing until stable is plenty.
  let grew = true;
  while (grew) {
    grew = false;
    for (const door of graph.doorRooms) {
      if (!door.rooms || !isOpen(door.doorId)) continue;
      const [a, b] = door.rooms;
      if (seen.has(a) && !seen.has(b)) {
        seen.add(b);
        grew = true;
      } else if (seen.has(b) && !seen.has(a)) {
        seen.add(a);
        grew = true;
      }
    }
  }
  return seen;
}

/**
 * Fewest doors from the pad to each spawn (ties go to the earlier door in
 * map order). `[]` for spawns reachable with every door shut, `null` for
 * spawns no door opens. With loops in the map this is one route, not every
 * route; {@link roomSpawnGate} is exact if that matters.
 */
export function zombieSpawnDoorRequirements(
  map: ZombotsDoorMap,
  graph: ZombotsRoomGraph = zombotsRoomGraph(map),
): ZombotsSpawnDoorRequirements {
  // BFS over rooms; each room remembers the door path that reached it.
  const path = new Map<number, string[]>();
  if (graph.padRoom !== null) {
    path.set(graph.padRoom, []);
    const queue = [graph.padRoom];
    for (let head = 0; head < queue.length; head++) {
      const room = queue[head]!;
      const here = path.get(room)!;
      for (const door of graph.doorRooms) {
        if (!door.rooms) continue;
        const [a, b] = door.rooms;
        const next = a === room ? b : b === room ? a : null;
        if (next === null || path.has(next)) continue;
        path.set(next, [...here, door.doorId]);
        queue.push(next);
      }
    }
  }
  const out = new Map<string, readonly string[] | null>();
  for (const [spawnId, room] of graph.spawnRooms) {
    out.set(spawnId, room === null ? null : path.get(room) ?? null);
  }
  return out;
}

function cornerPoint(bounds: ZombotsDoorMap["bounds"], corner: 0 | 1 | 2 | 3): Vec2 {
  // Same corner order as `cornerWorld` in world/map.ts.
  switch (corner) {
    case 0:
      return { x: bounds.minX, z: bounds.minZ };
    case 1:
      return { x: bounds.maxX, z: bounds.minZ };
    case 2:
      return { x: bounds.maxX, z: bounds.maxZ };
    case 3:
      return { x: bounds.minX, z: bounds.maxZ };
  }
}

/** Walkable-floor raster for the room split. 0 = free, -1 = blocked, >0 = room id + 1. */
class FloorGrid {
  private readonly cols: number;
  private readonly rows: number;
  private readonly originX: number;
  private readonly originZ: number;
  private readonly cells: Int32Array;

  constructor(bounds: ZombotsDoorMap["bounds"]) {
    const cell = ZOMBOTS_ROOM_CELL;
    this.originX = bounds.minX;
    this.originZ = bounds.minZ;
    this.cols = max(1, ceil((bounds.maxX - bounds.minX) / cell));
    this.rows = max(1, ceil((bounds.maxZ - bounds.minZ) / cell));
    this.cells = new Int32Array(this.cols * this.rows);
    // The zombots perimeter is solid; bodies stop a radius inside it.
    const r = MOVE_PLAYER_RADIUS;
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const p = this.center(col, row);
        if (
          p.x < bounds.minX + r || p.x > bounds.maxX - r ||
          p.z < bounds.minZ + r || p.z > bounds.maxZ - r
        ) {
          this.cells[row * this.cols + col] = -1;
        }
      }
    }
  }

  private center(col: number, row: number): Vec2 {
    return {
      x: this.originX + (col + 0.5) * ZOMBOTS_ROOM_CELL,
      z: this.originZ + (row + 0.5) * ZOMBOTS_ROOM_CELL,
    };
  }

  private colOf(x: number): number {
    return clamp(floor((x - this.originX) / ZOMBOTS_ROOM_CELL), 0, this.cols - 1);
  }

  private rowOf(z: number): number {
    return clamp(floor((z - this.originZ) / ZOMBOTS_ROOM_CELL), 0, this.rows - 1);
  }

  /** Block every cell whose center lies within `reach` of the segment. */
  blockSegment(a: Vec2, b: Vec2, reach: number): void {
    const c0 = this.colOf(min(a.x, b.x) - reach);
    const c1 = this.colOf(max(a.x, b.x) + reach);
    const r0 = this.rowOf(min(a.z, b.z) - reach);
    const r1 = this.rowOf(max(a.z, b.z) + reach);
    const reach2 = reach * reach;
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const p = this.center(col, row);
        if (pointSegmentDistanceSquared(p, a, b) < reach2) {
          this.cells[row * this.cols + col] = -1;
        }
      }
    }
  }

  /** Label 4-connected free regions in scan order. Returns the room count. */
  label(): number {
    let next = 0;
    const queue: number[] = [];
    for (let start = 0; start < this.cells.length; start++) {
      if (this.cells[start] !== 0) continue;
      next++;
      this.cells[start] = next;
      queue.length = 0;
      queue.push(start);
      for (let head = 0; head < queue.length; head++) {
        const i = queue[head]!;
        const col = i % this.cols;
        const row = (i - col) / this.cols;
        if (col > 0) this.visit(i - 1, next, queue);
        if (col < this.cols - 1) this.visit(i + 1, next, queue);
        if (row > 0) this.visit(i - this.cols, next, queue);
        if (row < this.rows - 1) this.visit(i + this.cols, next, queue);
      }
    }
    return next;
  }

  private visit(i: number, room: number, queue: number[]): void {
    if (this.cells[i] !== 0) return;
    this.cells[i] = room;
    queue.push(i);
  }

  roomAt(p: Vec2): number | null {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) return null;
    const x = (p.x - this.originX) / ZOMBOTS_ROOM_CELL;
    const z = (p.z - this.originZ) / ZOMBOTS_ROOM_CELL;
    if (x < 0 || z < 0 || x >= this.cols || z >= this.rows) return null;
    const v = this.cells[floor(z) * this.cols + floor(x)]!;
    return v > 0 ? v - 1 : null;
  }

  /** Cell count, centroid and box per room. Call after {@link label}. */
  stats(roomCount: number): ZombotsRoomStats[] {
    const out: ZombotsRoomStats[] = [];
    const sumX: number[] = [];
    const sumZ: number[] = [];
    for (let i = 0; i < roomCount; i++) {
      out.push({ cells: 0, centroid: { x: 0, z: 0 }, minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity });
      sumX.push(0);
      sumZ.push(0);
    }
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const v = this.cells[row * this.cols + col]!;
        if (v <= 0) continue;
        const room = out[v - 1]!;
        const p = this.center(col, row);
        room.cells++;
        sumX[v - 1]! += p.x;
        sumZ[v - 1]! += p.z;
        room.minX = min(room.minX, p.x);
        room.maxX = max(room.maxX, p.x);
        room.minZ = min(room.minZ, p.z);
        room.maxZ = max(room.maxZ, p.z);
      }
    }
    for (let i = 0; i < roomCount; i++) {
      const room = out[i]!;
      if (room.cells > 0) room.centroid = { x: sumX[i]! / room.cells, z: sumZ[i]! / room.cells };
    }
    return out;
  }

  /**
   * Room at `p`, or the nearest room within a few cells (rings by Chebyshev
   * distance, row-major inside a ring). Null when only wall is nearby.
   */
  roomNear(p: Vec2): number | null {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) return null;
    const col = this.colOf(p.x);
    const row = this.rowOf(p.z);
    for (let ring = 0; ring <= SEED_SEARCH_CELLS; ring++) {
      for (let dr = -ring; dr <= ring; dr++) {
        for (let dc = -ring; dc <= ring; dc++) {
          if (max(abs(dr), abs(dc)) !== ring) continue;
          const r = row + dr;
          const c = col + dc;
          if (r < 0 || r >= this.rows || c < 0 || c >= this.cols) continue;
          const v = this.cells[r * this.cols + c]!;
          if (v > 0) return v - 1;
        }
      }
    }
    return null;
  }
}

function pointSegmentDistanceSquared(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len2 = distanceSquared2(dx, dz);
  const t = len2 < 1e-12 ? 0 : clamp(((p.x - a.x) * dx + (p.z - a.z) * dz) / len2, 0, 1);
  return distanceSquared2(p.x - (a.x + dx * t), p.z - (a.z + dz * t));
}
