/**
 * Zombots floor nav for zombies (notes/zombots.md step 9a). Windows are the
 * only way out of a zombie closure, so a zombie standing in one walks to the
 * best window into a player closure, climbs it, and then chases on through
 * any opened doors.
 *
 * The climb is a hardcoded window-crawl animation driven by the sim: once a
 * zombie walks up to the opening and pushes toward it, the sim switches it
 * into window crawl (one of three crawl animations) and lands it back in
 * normal locomotion on the inside — no jump or crouch needed.
 *
 * Routes are walk-distance fields on a coarse floor grid (wall bands, half
 * walls and closed doors are not floor): one per window over its zombie
 * closure, built at map load, and one per chase goal over the player
 * closures, cached. Rooms and window links come from `zombotsLayout`.
 * Latches reuse the half-wall vault slots, which the zombie brain never runs.
 */

import { zombotsLayout } from "../../../../shared/zombots/zombotsLayout.ts";
import { SLIDING_DOOR_WIDTH } from "../../../../shared/world/slidingDoors.ts";
import { WINDOW_WIDTH } from "../../../../shared/world/wallWindows.ts";
import {
  abs,
  ceil,
  distance2,
  distanceSquared2,
  floor,
  normalize2,
} from "../../math/index.ts";
import { yawToward } from "../../navigation/heading.ts";
import {
  type BotBrainState,
  isSetNumber,
  UNSET,
} from "../../pipeline/state.ts";
import type { DoorsMap } from "../../shared/map.ts";

type Vec2 = { x: number; z: number };

/** The collision queries the grid needs (the engine MapCollision fits). */
export type ZombieNavCollision = {
  hasHeadroom(x: number, z: number): boolean;
  /**
   * Windows into closures no opened door reaches yet (the engine
   * MapCollision's rule). Absent = none sealed.
   */
  sealedZombieWindowIds?(): readonly string[];
};

/** One window a zombie may climb, with its zombie-side normal. */
export type ZombieWindowPortal = {
  windowId: string;
  zombieRoom: number;
  playerRoom: number;
  center: Vec2;
  /** Unit normal pointing into the zombie closure. */
  outX: number;
  outZ: number;
  /**
   * Walk distance in cells to this window's approach point from each floor
   * cell of its zombie closure; -1 anywhere else.
   */
  field: number[];
  /** Floor cell just inside the player closure, -1 if none. */
  exitCell: number;
};

/** Coarse floor grid the fields live on. */
type NavGrid = {
  minX: number;
  minZ: number;
  nx: number;
  nz: number;
  /** Room per cell (center sample), -1 on wall bands. */
  room: number[];
  /** A standing body fits at the cell center. */
  floor: boolean[];
};

/** What the zombie brain knows about a zombots map's windows and rooms. */
export type ZombieWindowNav = {
  portals: readonly ZombieWindowPortal[];
  grid: NavGrid;
  /** Room id at `p`, null on wall bands or off the map. */
  roomOf(p: Vec2): number | null;
  /** True for the three player closures. */
  isPlayerRoom(room: number): boolean;
  /** Door cells, per map door, that become floor once it opens. */
  doorCells: readonly { doorId: string; cells: readonly number[] }[];
  /** Open doors already turned to floor. */
  openDoors: string[];
  /**
   * Windows zombies can't use yet: their player closure isn't unlocked, so
   * the collision treats them as wall. Only ever shrinks as doors open.
   */
  sealedWindows: string[];
  /** Chase fields and their goal cells. Dropped whenever a door opens. */
  chaseCells: number[];
  chaseFields: number[][];
};

/** Zombie-side stand-off the walk aims for, from the wall line (m). */
export const ZOMBIE_WINDOW_APPROACH = 1.1;
/** Within this depth of the wall line and lined up, the climb starts (m). */
export const ZOMBIE_WINDOW_CLIMB_DEPTH = 1.4;
/**
 * Max sideways offset from the window center to climb. The opening is
 * 1.5 m and a jamb's end pushes a body 0.57 m off, which leaves 0.18 m.
 */
export const ZOMBIE_WINDOW_LINE_UP = 0.15;
/** Sideways offset (m) inside which the zombie heads through the window. */
export const ZOMBIE_WINDOW_FUNNEL = 0.6;
/** Past the wall line by this much on the player side, the climb is over. */
const CROSSED_DEPTH = 0.75;
/** Within this of the approach point, steer by hand instead of nav (m). */
const ALIGN_RADIUS = 2.5;
/** A new window must beat the latched one by this much (m) to switch. */
const SWITCH_MARGIN = 3;
/** Sample this far off the wall line to tell the zombie side (m). */
const SIDE_PROBE = 1.1;
/** Field cell size (m). Rooms are walled with ≥ 1.14 m blocked bands. */
const NAV_CELL = 0.5;
/** Cells walked down a field to pick the next walk goal. */
const LOOKAHEAD_CELLS = 5;
/** How far (cells) a body off the floor grid looks for field floor. */
const NEAR_CELLS = 2;
/** Chasing: this close (cells) to the goal, walk straight at it. */
const CHASE_DIRECT_CELLS = 6;
/**
 * Sideways clearance (m) kept along straight segments in `clearRun`.
 * Less than half a cell (0.25 m) so an axis-aligned step through a 1-cell
 * open doorway stays valid while diagonal corner/jamb cuts are rejected.
 */
const CLEAR_MARGIN = 0.2;
/** Chase fields kept at once (a few humans, a cell or two each). */
const CHASE_CACHE = 16;

function cellIndex(grid: NavGrid, x: number, z: number): number {
  const ix = floor((x - grid.minX) / NAV_CELL);
  const iz = floor((z - grid.minZ) / NAV_CELL);
  if (ix < 0 || iz < 0 || ix >= grid.nx || iz >= grid.nz) return -1;
  return iz * grid.nx + ix;
}

function cellCenter(grid: NavGrid, index: number): Vec2 {
  const ix = index % grid.nx;
  const iz = (index - ix) / grid.nx;
  return {
    x: grid.minX + (ix + 0.5) * NAV_CELL,
    z: grid.minZ + (iz + 0.5) * NAV_CELL,
  };
}

function navGrid(
  bounds: DoorsMap["bounds"],
  roomOf: (p: Vec2) => number | null,
  collision: ZombieNavCollision,
): NavGrid {
  const nx = ceil((bounds.maxX - bounds.minX) / NAV_CELL);
  const nz = ceil((bounds.maxZ - bounds.minZ) / NAV_CELL);
  const grid: NavGrid = {
    minX: bounds.minX,
    minZ: bounds.minZ,
    nx,
    nz,
    room: [],
    floor: [],
  };
  for (let i = 0; i < nx * nz; i++) {
    const c = cellCenter(grid, i);
    const r = roomOf(c);
    grid.room.push(r === null ? -1 : r);
    // Half walls split no rooms but a zombie can't vault them.
    grid.floor.push(r !== null && collision.hasHeadroom(c.x, c.z));
  }
  return grid;
}

/** Nearest floor cell to `p` within a couple of cells (in `room` if ≥ 0), or -1. */
function nearestFloor(grid: NavGrid, p: Vec2, room: number): number {
  let best = -1;
  let bestD = 0;
  for (let dz = -NEAR_CELLS; dz <= NEAR_CELLS; dz++) {
    for (let dx = -NEAR_CELLS; dx <= NEAR_CELLS; dx++) {
      const n = cellIndex(grid, p.x + dx * NAV_CELL, p.z + dz * NAV_CELL);
      if (n < 0 || !grid.floor[n]) continue;
      if (room >= 0 && grid.room[n] !== room) continue;
      const c = cellCenter(grid, n);
      const d = distanceSquared2(c.x - p.x, c.z - p.z);
      if (best < 0 || d < bestD) {
        best = n;
        bestD = d;
      }
    }
  }
  return best;
}

/** BFS (4-way) over floor cells from `start`, optionally inside one room. */
function walkField(grid: NavGrid, start: number, room: number): number[] {
  const field: number[] = [];
  for (let i = 0; i < grid.floor.length; i++) field.push(-1);
  if (start < 0 || !grid.floor[start]) return field;
  if (room >= 0 && grid.room[start] !== room) return field;
  const queue: number[] = [start];
  field[start] = 0;
  for (let head = 0; head < queue.length; head++) {
    const at = queue[head]!;
    const ix = at % grid.nx;
    const next = field[at]! + 1;
    for (let k = 0; k < 4; k++) {
      const n = k === 0
        ? (ix > 0 ? at - 1 : -1)
        : k === 1
        ? (ix < grid.nx - 1 ? at + 1 : -1)
        : k === 2
        ? at - grid.nx
        : at + grid.nx;
      if (n < 0 || n >= field.length || field[n] !== -1) continue;
      if (!grid.floor[n] || (room >= 0 && grid.room[n] !== room)) continue;
      field[n] = next;
      queue.push(n);
    }
  }
  return field;
}

/**
 * Field cell for a body: its own, or the nearest Euclidean covered cell close
 * by (preferring `room` when known). Picking by Euclidean distance instead of
 * lowest field value prevents snapping across a wall or closed sliding door
 * into the room on the far side.
 */
function fieldCell(
  grid: NavGrid,
  field: number[],
  x: number,
  z: number,
  room = -1,
): number {
  const at = cellIndex(grid, x, z);
  if (at >= 0 && field[at]! >= 0) return at;
  let best = -1;
  let bestD = 0;
  let bestAny = -1;
  let bestAnyD = 0;
  for (let dz = -NEAR_CELLS; dz <= NEAR_CELLS; dz++) {
    for (let dx = -NEAR_CELLS; dx <= NEAR_CELLS; dx++) {
      const n = cellIndex(grid, x + dx * NAV_CELL, z + dz * NAV_CELL);
      if (n < 0 || field[n]! < 0) continue;
      const c = cellCenter(grid, n);
      const d = distanceSquared2(c.x - x, c.z - z);
      if (
        bestAny < 0 || d < bestAnyD - 1e-6 ||
        (abs(d - bestAnyD) <= 1e-6 && field[n]! < field[bestAny]!)
      ) {
        bestAny = n;
        bestAnyD = d;
      }
      if (room >= 0 && grid.room[n] === room) {
        if (
          best < 0 || d < bestD - 1e-6 ||
          (abs(d - bestD) <= 1e-6 && field[n]! < field[best]!)
        ) {
          best = n;
          bestD = d;
        }
      }
    }
  }
  return best >= 0 ? best : bestAny;
}

/**
 * Every sample on the segment lands on a cell the field covers. When `margin`
 * is positive, two offset tracks ±margin perpendicular to the segment must also
 * stay on covered cells so straight runs don't clip wall corners or door jambs.
 * The last `endSlack` metres are not checked (a human against a wall stands on
 * its band, off the field).
 */
function clearRun(
  grid: NavGrid,
  field: number[],
  from: Vec2,
  to: Vec2,
  endSlack = 0,
  margin = 0,
): boolean {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const len = distance2(dx, dz);
  if (len <= 1e-6) return true;
  const steps = ceil(len / (NAV_CELL / 2));
  const perpX = margin > 0 ? (-dz / len) * margin : 0;
  const perpZ = margin > 0 ? (dx / len) * margin : 0;
  for (let k = 1; k <= steps; k++) {
    const t = k / steps;
    if ((1 - t) * len < endSlack) break;
    const px = from.x + dx * t;
    const pz = from.z + dz * t;
    const n = cellIndex(grid, px, pz);
    if (n < 0 || field[n]! < 0) return false;
    if (margin > 0) {
      const nl = cellIndex(grid, px + perpX, pz + perpZ);
      if (nl < 0 || field[nl]! < 0) return false;
      const nr = cellIndex(grid, px - perpX, pz - perpZ);
      if (nr < 0 || field[nr]! < 0) return false;
    }
  }
  return true;
}

/**
 * A point a few cells down the field from `at`: the farthest one the body
 * can walk to in a straight line over field floor, so the goal never cuts
 * a wall end, a half wall or an open door jamb.
 */
function downField(
  grid: NavGrid,
  field: number[],
  at: number,
  from: Vec2,
): Vec2 {
  let cur = at;
  let goal = cellCenter(grid, at);
  for (let step = 0; step < LOOKAHEAD_CELLS; step++) {
    if (field[cur]! <= 0) break;
    const ix = cur % grid.nx;
    let best = cur;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue;
        if ((ix === 0 && dx < 0) || (ix === grid.nx - 1 && dx > 0)) continue;
        const n = cur + dz * grid.nx + dx;
        if (n < 0 || n >= field.length || field[n]! < 0) continue;
        if (dx !== 0 && dz !== 0) {
          if (field[cur + dx]! < 0 || field[cur + dz * grid.nx]! < 0) continue;
        }
        if (field[n]! < field[best]!) best = n;
      }
    }
    if (best === cur) break;
    cur = best;
    const next = cellCenter(grid, cur);
    if (!clearRun(grid, field, from, next, 0, CLEAR_MARGIN)) break;
    goal = next;
  }
  return goal;
}

/**
 * Nav for a zombots map, or null on any other map and on a map whose phases
 * don't check out (the layout's own validation says why). `collision` is the
 * engine's zombie copy with every door still shut.
 */
export function buildZombieWindowNav(
  map: DoorsMap,
  collision: ZombieNavCollision,
): ZombieWindowNav | null {
  if (map.mirrorMode !== "zombots") return null;
  const layout = zombotsLayout(map);
  const phases = layout.phases;
  if (phases === null) return null;
  const grid = navGrid(map.bounds, (p) => layout.roomOf(p), collision);
  const portals: ZombieWindowPortal[] = [];
  const windows = map.windows ?? [];
  for (let i = 0; i < layout.windowLinks.length; i++) {
    const link = layout.windowLinks[i]!;
    let win = null;
    for (let w = 0; w < windows.length; w++) {
      if (windows[w]!.id === link.windowId) {
        win = windows[w]!;
        break;
      }
    }
    if (win === null) continue;
    let wall = null;
    for (let w = 0; w < map.walls.length; w++) {
      if (map.walls[w]!.id === win.wallId) {
        wall = map.walls[w]!;
        break;
      }
    }
    if (wall === null) continue;
    const dir = normalize2(wall.b.x - wall.a.x, wall.b.z - wall.a.z);
    if (dir.length < 1e-6) continue;
    let outX = -dir.z;
    let outZ = dir.x;
    const probe = layout.roomOf({
      x: win.center.x + outX * SIDE_PROBE,
      z: win.center.z + outZ * SIDE_PROBE,
    });
    if (probe !== link.zombieRoom) {
      outX = -outX;
      outZ = -outZ;
    }
    const center = { x: win.center.x, z: win.center.z };
    const start = nearestFloor(grid, {
      x: center.x + outX * ZOMBIE_WINDOW_APPROACH,
      z: center.z + outZ * ZOMBIE_WINDOW_APPROACH,
    }, link.zombieRoom);
    portals.push({
      windowId: link.windowId,
      zombieRoom: link.zombieRoom,
      playerRoom: link.playerRoom,
      center,
      outX,
      outZ,
      field: walkField(grid, start, link.zombieRoom),
      exitCell: nearestFloor(grid, {
        x: center.x - outX * ZOMBIE_WINDOW_APPROACH,
        z: center.z - outZ * ZOMBIE_WINDOW_APPROACH,
      }, link.playerRoom),
    });
  }

  // Door gaps sit in a wall band, so they're never floor until opened.
  const doorCells: { doorId: string; cells: number[] }[] = [];
  const reach = SLIDING_DOOR_WIDTH / 2 + NAV_CELL;
  const doors = map.doors ?? [];
  for (let d = 0; d < doors.length; d++) {
    const door = doors[d]!;
    const cells: number[] = [];
    const span = ceil(reach / NAV_CELL);
    for (let dz = -span; dz <= span; dz++) {
      for (let dx = -span; dx <= span; dx++) {
        const n = cellIndex(
          grid,
          door.center.x + dx * NAV_CELL,
          door.center.z + dz * NAV_CELL,
        );
        if (n < 0 || grid.floor[n]) continue;
        const c = cellCenter(grid, n);
        if (distance2(c.x - door.center.x, c.z - door.center.z) > reach) {
          continue;
        }
        if (cells.indexOf(n) < 0) cells.push(n);
      }
    }
    doorCells.push({ doorId: door.id, cells });
  }

  return {
    portals,
    grid,
    roomOf: (p) => layout.roomOf(p),
    isPlayerRoom: (room) =>
      room === phases[0] || room === phases[1] || room === phases[2],
    doorCells,
    openDoors: [],
    sealedWindows: sealedOf(collision),
    chaseCells: [],
    chaseFields: [],
  };
}

function sealedOf(collision: ZombieNavCollision): string[] {
  const ids = collision.sealedZombieWindowIds?.() ?? [];
  const out: string[] = [];
  for (let i = 0; i < ids.length; i++) out.push(ids[i]!);
  return out;
}

/**
 * Doors opened since the last call become floor where a body fits (the
 * collision has already dropped their blocks). Idempotent; ids only grow.
 */
export function openZombieNavDoors(
  nav: ZombieWindowNav,
  openIds: readonly string[],
  collision: ZombieNavCollision,
): void {
  for (let i = 0; i < openIds.length; i++) {
    const id = openIds[i]!;
    if (nav.openDoors.indexOf(id) >= 0) continue;
    nav.openDoors.push(id);
    for (let d = 0; d < nav.doorCells.length; d++) {
      const entry = nav.doorCells[d]!;
      if (entry.doorId !== id) continue;
      for (let c = 0; c < entry.cells.length; c++) {
        const n = entry.cells[c]!;
        const p = cellCenter(nav.grid, n);
        if (collision.hasHeadroom(p.x, p.z)) nav.grid.floor[n] = true;
      }
    }
    nav.chaseCells.length = 0;
    nav.chaseFields.length = 0;
    // A door can join a new closure to phase 1 and unseal its windows.
    nav.sealedWindows = sealedOf(collision);
  }
}

/** Walk field over all floor toward `goal`, cached by its cell. */
function chaseField(nav: ZombieWindowNav, goal: Vec2): number[] | null {
  const at = cellIndex(nav.grid, goal.x, goal.z);
  if (at < 0) return null;
  const cached = nav.chaseCells.indexOf(at);
  if (cached >= 0) return nav.chaseFields[cached]!;
  // Humans stand near walls too: prefer floor in the goal's own room so a
  // human pressed against a closed door never seeds the field on the far side.
  const goalRoom = nav.roomOf(goal);
  let start = goalRoom !== null ? nearestFloor(nav.grid, goal, goalRoom) : -1;
  if (start < 0) start = nearestFloor(nav.grid, goal, -1);
  if (start < 0) return null;
  if (nav.chaseCells.length >= CHASE_CACHE) {
    nav.chaseCells.length = 0;
    nav.chaseFields.length = 0;
  }
  const field = walkField(nav.grid, start, -1);
  nav.chaseCells.push(at);
  nav.chaseFields.push(field);
  return field;
}

/** What the brain should do about floor nav this think. */
export type ZombieWindowPlan =
  /** Nothing to add: chase the goal as before. */
  | { kind: "none" }
  /** Walk the normal nav chain toward this point. */
  | { kind: "walk"; goal: Vec2 }
  /** Steer straight at `yaw`, forward held; `jump` while climbing. */
  | { kind: "steer"; yaw: number; jump: boolean };

const NONE: ZombieWindowPlan = { kind: "none" };

function clearLatch(state: BotBrainState): void {
  state.halfWallVaultOption = UNSET;
  state.halfWallVaultTicksLeft = UNSET;
}

/** Signed depth along the portal normal (> 0 on the zombie side). */
function depthOf(p: ZombieWindowPortal, x: number, z: number): number {
  return (x - p.center.x) * p.outX + (z - p.center.z) * p.outZ;
}

/** Sideways offset from the window center, along the wall. */
function lateralOf(p: ZombieWindowPortal, x: number, z: number): number {
  return (x - p.center.x) * -p.outZ + (z - p.center.z) * p.outX;
}

function approachPoint(p: ZombieWindowPortal): Vec2 {
  return {
    x: p.center.x + p.outX * ZOMBIE_WINDOW_APPROACH,
    z: p.center.z + p.outZ * ZOMBIE_WINDOW_APPROACH,
  };
}

/**
 * Walk to the window, then on to the goal: by the goal's chase field when
 * given (so only windows the goal can be walked to from count), else in a
 * straight line. -1 = no route.
 */
function routeCost(
  nav: ZombieWindowNav,
  p: ZombieWindowPortal,
  self: Vec2,
  goal: Vec2 | null,
  goalField: number[] | null,
): number {
  const at = fieldCell(nav.grid, p.field, self.x, self.z, p.zombieRoom);
  if (at < 0) return -1;
  const toWindow = p.field[at]! * NAV_CELL;
  if (goalField !== null) {
    const rest = p.exitCell < 0 ? -1 : goalField[p.exitCell]!;
    return rest < 0 ? -1 : toWindow + rest * NAV_CELL;
  }
  if (goal === null) return toWindow;
  return toWindow + distance2(goal.x - p.center.x, goal.z - p.center.z);
}

/** Cheapest window out of `room`, or -1. */
function bestPortal(
  nav: ZombieWindowNav,
  room: number,
  self: Vec2,
  goal: Vec2 | null,
  goalField: number[] | null,
): { index: number; cost: number } {
  let index = -1;
  let cost = 0;
  for (let i = 0; i < nav.portals.length; i++) {
    const p = nav.portals[i]!;
    if (p.zombieRoom !== room) continue;
    // Never into a closure the players haven't opened: it's a dead end.
    if (nav.sealedWindows.indexOf(p.windowId) >= 0) continue;
    const c = routeCost(nav, p, self, goal, goalField);
    if (c < 0) continue;
    if (index < 0 || c < cost) {
      index = i;
      cost = c;
    }
  }
  return { index, cost };
}

/** In a player closure: walk the chase field while the goal is far. */
function chasePlan(
  nav: ZombieWindowNav,
  self: Vec2,
  goal: Vec2 | null,
  room: number | null = null,
): ZombieWindowPlan {
  if (goal === null) return NONE;
  const field = chaseField(nav, goal);
  if (field === null) return NONE;
  const at = fieldCell(nav.grid, field, self.x, self.z, room ?? -1);
  if (at < 0) return NONE;
  // Close and nothing in the way: the plain chase (and its swing) takes over.
  if (
    field[at]! <= CHASE_DIRECT_CELLS &&
    clearRun(nav.grid, field, self, goal, NAV_CELL, CLEAR_MARGIN)
  ) {
    return NONE;
  }
  return { kind: "walk", goal: downField(nav.grid, field, at, self) };
}

/**
 * Floor nav for one zombie. In a zombie closure: pick a window (into the
 * goal's closure if one is, else any, by walk distance plus the rest of the
 * way), keep it latched, walk to it and climb. In a player closure: walk the
 * chase field round walls and through opened doors, then `none` up close.
 */
export function zombieWindowPlan(
  nav: ZombieWindowNav | null | undefined,
  self: { x: number; z: number; onGround: boolean },
  goal: Vec2 | null,
  state: BotBrainState,
): ZombieWindowPlan {
  if (!nav) return NONE;
  const room = nav.roomOf(self);
  const latched = isSetNumber(state.halfWallVaultOption)
    ? nav.portals[state.halfWallVaultOption] ?? null
    : null;

  if (room !== null && nav.isPlayerRoom(room)) {
    clearLatch(state);
    return chasePlan(nav, self, goal, room);
  }

  let portal: ZombieWindowPortal | null = latched;
  // Mid-window (on the wall band) the room is unknown: keep the latch.
  if (room !== null) {
    if (latched !== null && latched.zombieRoom !== room) portal = null;
    if (portal !== null && nav.sealedWindows.indexOf(portal.windowId) >= 0) {
      portal = null;
    }
    // Windows the goal can be walked to from (through opened doors) win;
    // if there are none, the nearest by straight line.
    let goalField = goal === null ? null : chaseField(nav, goal);
    let best = bestPortal(nav, room, self, goal, goalField);
    if (best.index < 0 && goalField !== null) {
      goalField = null;
      best = bestPortal(nav, room, self, goal, null);
    }
    if (best.index < 0) {
      clearLatch(state);
      return NONE;
    }
    const keptCost = portal === null
      ? -1
      : routeCost(nav, portal, self, goal, goalField);
    if (
      portal === null || keptCost < 0 || keptCost > best.cost + SWITCH_MARGIN
    ) {
      state.halfWallVaultOption = best.index;
      state.halfWallVaultTicksLeft = UNSET;
      portal = nav.portals[best.index]!;
    }
  }
  if (portal === null) return chasePlan(nav, self, goal);

  const depth = depthOf(portal, self.x, self.z);
  const lateral = lateralOf(portal, self.x, self.z);
  // Only right at the window: a closure can wrap round behind its wall.
  const atWindow = abs(lateral) <= WINDOW_WIDTH;
  if (atWindow && depth < -CROSSED_DEPTH) {
    clearLatch(state);
    return chasePlan(nav, self, goal);
  }
  // In front of the window: aim straight through the opening at a point beyond
  // the far side so the zombie walks cleanly into the window-crawl trigger
  // without needing to jump or crouch.
  const side = abs(lateral);
  if (
    atWindow && depth >= -CROSSED_DEPTH && depth <= ZOMBIE_WINDOW_CLIMB_DEPTH &&
    side <= ZOMBIE_WINDOW_FUNNEL
  ) {
    if (side <= ZOMBIE_WINDOW_LINE_UP) state.halfWallVaultTicksLeft = 1;
    const exitX = portal.center.x - portal.outX * 2;
    const exitZ = portal.center.z - portal.outZ * 2;
    return {
      kind: "steer",
      yaw: yawToward(self.x, self.z, exitX, exitZ),
      jump: false,
    };
  }
  state.halfWallVaultTicksLeft = UNSET;
  const a = approachPoint(portal);
  if (
    distance2(a.x - self.x, a.z - self.z) <= ALIGN_RADIUS &&
    depth > 0 &&
    clearRun(nav.grid, portal.field, self, a, NAV_CELL)
  ) {
    return {
      kind: "steer",
      yaw: yawToward(self.x, self.z, a.x, a.z),
      jump: false,
    };
  }
  // Follow the window's field round the closure's walls.
  const at = fieldCell(nav.grid, portal.field, self.x, self.z, portal.zombieRoom);
  return {
    kind: "walk",
    goal: at < 0 ? a : downField(nav.grid, portal.field, at, self),
  };
}
