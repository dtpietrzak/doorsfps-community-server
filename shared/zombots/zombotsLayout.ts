/**
 * Zombots map layout (notes/zombots.md decision 10, Phase 1 step 4d).
 *
 * Labels the closures `zombotsRoomGraph` finds: three player closures chained
 * by doors (phases 1–3), zombie closures around them, which window joins
 * which zombie closure to which player closure, and which side each gun rack
 * faces. Also validates the map against those rules. The loader, mapBuilder
 * (5b), ceilings (23c), the spawn gate (9a) and the window blocker (12c) all
 * read this one module.
 *
 * Pure and deterministic. Uses `shared/math`, never global `Math`, so the bot
 * engine can import it (step 9a). Note that `zombotsDoors.ts` pulls in
 * `world/slidingDoors.ts` and `world/wallWindows.ts`, which still use global
 * `Math`; that matters only if this file joins the ScriptC no-Math list.
 */

import { MOVE_PLAYER_RADIUS } from "../sim/moveStep.ts";
import { distance2, distanceSquared2, min, round } from "../math/index.ts";
import {
  type ZombotsDoorMap,
  ZOMBOTS_ROOM_CELL,
  type ZombotsRoomGraph,
  ZOMBOTS_ROOM_WALL_HALF_THICK,
  type ZombotsRoomStats,
  zombotsRoomRaster,
} from "./zombotsDoors.ts";
import type { ZombotsRackKind, ZombotsRackWeapon, ZombotsSpawnGate } from "./types.ts";

type Vec2 = { x: number; z: number };

/** Player closure phase: 1 = spawn pad room, 2 and 3 behind one door each. */
export type ZombotsLayoutPhase = 1 | 2 | 3;

/** The map fields the layout reads. Any zombots DoorsMap fits. */
export type ZombotsLayoutMap = ZombotsDoorMap & {
  windows?: readonly { id: string; wallId: string; center: Vec2 }[];
  gunRacks?: readonly {
    id: string;
    wallId: string;
    center: Vec2;
    weapon: ZombotsRackKind;
    /** 1 = faces the wall's left normal, -1 the right (see `GunRack.face`). */
    face?: 1 | -1;
  }[];
};

export type ZombotsZombieRoom = {
  room: number;
  /** Spawns inside, in `zombieSpawns` order. */
  spawnIds: readonly string[];
};

export type ZombotsWindowLink = {
  windowId: string;
  zombieRoom: number;
  playerRoom: number;
  phase: ZombotsLayoutPhase;
};

export type ZombotsRackPlacement = {
  rackId: string;
  weapon: ZombotsRackKind;
  /** Player closure the rack faces; null when neither or both sides are one. */
  playerRoom: number | null;
  phase: ZombotsLayoutPhase | null;
  /** Unit wall normal pointing into `playerRoom`; null with it. */
  facing: Vec2 | null;
};

export type ZombotsLayout = {
  /** [phase 1, phase 2, phase 3] rooms, or null unless the chain is valid. */
  phases: readonly [number, number, number] | null;
  zombieRooms: readonly ZombotsZombieRoom[];
  /** Every window between a zombie closure and a player closure, in map order. */
  windowLinks: readonly ZombotsWindowLink[];
  /** Door → the two rooms it joins, in map door order (from the room split). */
  doorRooms: ZombotsRoomGraph["doorRooms"];
  /** One entry per gun rack, in map order. */
  rackPhase: readonly ZombotsRackPlacement[];
  /** Room ids too small to count as closures (see {@link ZOMBOTS_LAYOUT_MIN_ROOM_AREA}). */
  slivers: readonly number[];
  /** Raw room stats from the split, index = room id. */
  rooms: readonly ZombotsRoomStats[];
  /** Room id of the floor cell at `p`; null on wall bands or outside the map. */
  roomOf(p: Vec2): number | null;
  /** Phase of the player closure at `p`, or null anywhere else. */
  phaseOf(p: Vec2): ZombotsLayoutPhase | null;
  /** Rule breaks the designer must fix. Empty on a valid map. */
  errors: readonly string[];
  /** Things worth a look that don't break the mode. */
  warnings: readonly string[];
};

/**
 * Rooms with less walkable floor than this (m²) are slivers, not closures.
 * Walkable floor is already shrunk by a body radius plus the wall half
 * thickness (0.57 m) along every wall, so a pillar drawn as a closed box of
 * walls up to about 4 × 4 m leaves less than 9 m² inside, and so do pockets
 * where walls almost meet. A real closure has to hold a zombie spawn and room
 * to fight, which needs well over 3 × 3 m of floor.
 */
export const ZOMBOTS_LAYOUT_MIN_ROOM_AREA = 9;

/** Sample this far off a wall line to land on floor on each side. */
const SIDE_PROBE = ZOMBOTS_ROOM_WALL_HALF_THICK + MOVE_PLAYER_RADIUS + ZOMBOTS_ROOM_CELL * 2;
/** Same tolerance the loaders use for wall-mounted centers. */
const CENTER_ON_WALL = 0.25;

/**
 * The first phase a weapon's rack may hang in. Later phases may carry it too
 * (a pistol rack in every phase, a rifle rack in 2 and 3), never earlier.
 */
const RACK_PHASE: Record<ZombotsRackKind, ZombotsLayoutPhase> = {
  pistol: 1,
  rifle: 2,
  shotgun: 3,
  // Utility racks (power recharge and dis-rack-tor) may hang in any phase.
  power: 1,
  distractor: 1,
};

/** "phase 3" / "phase 2 or later" / "any phase", for rack messages. */
function phasesFrom(first: ZombotsLayoutPhase): string {
  if (first === 3) return "phase 3";
  return first === 1 ? "any phase" : `phase ${first} or later`;
}

export function zombotsLayout(map: ZombotsLayoutMap): ZombotsLayout {
  const raster = zombotsRoomRaster(map);
  const { graph, rooms } = raster;
  const errors: string[] = [];
  const warnings: string[] = [];
  const minCells = ZOMBOTS_LAYOUT_MIN_ROOM_AREA / (ZOMBOTS_ROOM_CELL * ZOMBOTS_ROOM_CELL);

  const isSliver = rooms.map((r) => r.cells < minCells);
  const slivers: number[] = [];
  for (let room = 0; room < rooms.length; room++) {
    if (!isSliver[room]) continue;
    slivers.push(room);
    const s = rooms[room]!;
    warnings.push(
      `gap near ${at(s.centroid)}: ${area(s.cells)} m² of floor shut in by walls ` +
        `(a closed wall box, or walls that almost meet). Ignored; fine for a pillar, but open it up if it was meant to be a room.`,
    );
  }
  /** A room that counts as a closure, or null. */
  const closure = (room: number | null): number | null => room !== null && !isSliver[room] ? room : null;

  // --- Player closures: the pad room plus everything doors reach from it.
  const depth = new Map<number, number>();
  const padRoom = graph.padRoom;
  const cornerSeed = padSeed(map);
  if (padRoom === null) {
    errors.push(`The spawn pad near ${at(cornerSeed)} is boxed in by walls; leave open floor in that corner.`);
  } else if (isSliver[padRoom]) {
    errors.push(
      `The spawn pad near ${at(cornerSeed)} sits in a room of only ${area(rooms[padRoom]!.cells)} m²; ` +
        `phase 1 needs at least ${ZOMBOTS_LAYOUT_MIN_ROOM_AREA} m².`,
    );
  } else {
    depth.set(padRoom, 0);
    const queue = [padRoom];
    for (let head = 0; head < queue.length; head++) {
      const room = queue[head]!;
      for (const door of graph.doorRooms) {
        if (!door.rooms) continue;
        const [a, b] = door.rooms;
        const next = a === room ? b : b === room ? a : null;
        if (next === null || depth.has(next) || isSliver[next]) continue;
        depth.set(next, depth.get(room)! + 1);
        queue.push(next);
      }
    }
  }
  const playerRooms = [...depth.keys()];
  const phaseOfRoom = (room: number | null): ZombotsLayoutPhase | null => {
    if (room === null) return null;
    const d = depth.get(room);
    return d === 0 ? 1 : d === 1 ? 2 : d === 2 ? 3 : null;
  };

  const doorCenters = new Map<string, Vec2>();
  for (const door of map.doors ?? []) if (!doorCenters.has(door.id)) doorCenters.set(door.id, door.center);
  for (const door of graph.doorRooms) {
    const where = at(doorCenters.get(door.doorId)!);
    if (!door.rooms) {
      errors.push(
        `Door ${door.doorId} at ${where} doesn't separate two rooms (same floor on both sides, or no floor on one); ` +
          `put it in a full wall between two player closures.`,
      );
      continue;
    }
    const [a, b] = door.rooms;
    if (isSliver[a] || isSliver[b]) {
      errors.push(`Door ${door.doorId} at ${where} opens onto a tiny walled-off gap; put it between two player closures.`);
    } else if (!depth.has(a) || !depth.has(b)) {
      errors.push(
        `Door ${door.doorId} at ${where} joins two rooms the spawn pad can't reach through doors; ` +
          `doors may only join player closures.`,
      );
    }
  }

  let phases: [number, number, number] | null = null;
  const perDepth = [0, 0, 0];
  for (const d of depth.values()) if (d < 3) perDepth[d]!++;
  if (padRoom !== null && !isSliver[padRoom]) {
    if (playerRooms.length !== 3) {
      errors.push(
        `Expected exactly 3 player closures chained by doors from the spawn pad, found ${playerRooms.length}` +
          (playerRooms.length ? ` (${playerRooms.map((r) => `room near ${at(rooms[r]!.centroid)}`).join(", ")})` : "") +
          `.`,
      );
    } else if (perDepth[0] !== 1 || perDepth[1] !== 1 || perDepth[2] !== 1) {
      errors.push(
        `Phase 1 (near ${at(rooms[padRoom]!.centroid)}) opens straight onto two closures; ` +
          `chain them so phase 2 is behind one door and phase 3 behind a door from phase 2.`,
      );
    } else {
      const byDepth = [0, 0, 0];
      for (const [room, d] of depth) byDepth[d] = room;
      phases = [byDepth[0]!, byDepth[1]!, byDepth[2]!];
    }
  }

  // --- Zombie closures and their spawns.
  const spawnsByRoom = new Map<number, string[]>();
  const spawnPoints = new Map<string, Vec2>();
  for (const spawn of map.zombieSpawns ?? []) if (!spawnPoints.has(spawn.id)) spawnPoints.set(spawn.id, spawn.p);
  for (const [spawnId, room] of graph.spawnRooms) {
    const where = at(spawnPoints.get(spawnId)!);
    if (room === null) {
      errors.push(`Zombie spawn ${spawnId} at ${where} is inside a wall; move it onto open floor.`);
    } else if (isSliver[room]) {
      errors.push(
        `Zombie spawn ${spawnId} at ${where} is in a tiny walled-off gap (${area(rooms[room]!.cells)} m²); ` +
          `move it into a zombie closure.`,
      );
    } else if (depth.has(room)) {
      const phase = phaseOfRoom(room);
      errors.push(
        `Zombie spawn ${spawnId} at ${where} is inside a player closure${phase ? ` (phase ${phase})` : ""}; ` +
          `move it into a zombie closure.`,
      );
    } else {
      let list = spawnsByRoom.get(room);
      if (!list) spawnsByRoom.set(room, list = []);
      list.push(spawnId);
    }
  }
  const zombieRooms: ZombotsZombieRoom[] = [];
  for (let room = 0; room < rooms.length; room++) {
    if (isSliver[room] || depth.has(room)) continue;
    zombieRooms.push({ room, spawnIds: spawnsByRoom.get(room) ?? [] });
  }
  const zombieRoomSet = new Set(zombieRooms.map((z) => z.room));

  // --- Windows: which room sits on each face.
  const walls = new Map<string, ZombotsLayoutMap["walls"][number]>();
  for (const wall of map.walls) if (!walls.has(wall.id)) walls.set(wall.id, wall);
  const windowLinks: ZombotsWindowLink[] = [];
  const linkedZombieRooms = new Set<number>();
  const seenWindow = new Set<string>();
  for (const win of map.windows ?? []) {
    if (seenWindow.has(win.id)) continue;
    seenWindow.add(win.id);
    const where = at(win.center);
    const sides = wallSides(walls.get(win.wallId), win.center);
    if (!sides) {
      warnings.push(`Window ${win.id} at ${where} isn't on a full wall; it is ignored.`);
      continue;
    }
    const left = closure(raster.roomNear(offset(sides.p, sides.n, SIDE_PROBE)));
    const right = closure(raster.roomNear(offset(sides.p, sides.n, -SIDE_PROBE)));
    if (left === null || right === null || left === right) {
      warnings.push(`Window ${win.id} at ${where} doesn't join two closures, so no zombie can use it.`);
      continue;
    }
    const leftPhase = phaseOfRoom(left);
    const rightPhase = phaseOfRoom(right);
    if (leftPhase && rightPhase) {
      warnings.push(
        `Window ${win.id} at ${where} joins phase ${leftPhase} and phase ${rightPhase}; ` +
          `zombies could climb between player closures past the door.`,
      );
      continue;
    }
    const playerRoom = leftPhase ? left : rightPhase ? right : null;
    const zombieRoom = playerRoom === left ? right : left;
    const phase = leftPhase ?? rightPhase;
    if (playerRoom === null || phase === null || !zombieRoomSet.has(zombieRoom)) continue;
    windowLinks.push({ windowId: win.id, zombieRoom, playerRoom, phase });
    linkedZombieRooms.add(zombieRoom);
  }

  for (const z of zombieRooms) {
    const where = at(rooms[z.room]!.centroid);
    const box = `x ${round(rooms[z.room]!.minX)}..${round(rooms[z.room]!.maxX)}, ` +
      `z ${round(rooms[z.room]!.minZ)}..${round(rooms[z.room]!.maxZ)}`;
    if (z.spawnIds.length === 0) {
      errors.push(`Zombie closure near ${where} (${box}) has no zombie spawn; add one or merge it into a neighbour.`);
    }
    if (!linkedZombieRooms.has(z.room)) {
      errors.push(
        `Zombie closure near ${where} (${box}) has no window into a player closure, ` +
          `so its zombies can never reach anyone; add a window.`,
      );
    }
  }

  // --- Gun racks: the picked side, or else the side with a player closure, is the front.
  const rackPhase: ZombotsRackPlacement[] = [];
  const rackedWeapons = new Set<ZombotsRackKind>();
  const seenRack = new Set<string>();
  for (const rack of map.gunRacks ?? []) {
    if (seenRack.has(rack.id)) continue;
    seenRack.add(rack.id);
    rackedWeapons.add(rack.weapon);
    const where = at(rack.center);
    const want = RACK_PHASE[rack.weapon];
    const entry: ZombotsRackPlacement = {
      rackId: rack.id,
      weapon: rack.weapon,
      playerRoom: null,
      phase: null,
      facing: null,
    };
    rackPhase.push(entry);
    const sides = wallSides(walls.get(rack.wallId), rack.center);
    if (!sides) {
      errors.push(`Gun rack ${rack.id} (${rack.weapon}) at ${where} isn't on a full wall; mount it on one.`);
      continue;
    }
    const left = closure(raster.roomNear(offset(sides.p, sides.n, SIDE_PROBE)));
    const right = closure(raster.roomNear(offset(sides.p, sides.n, -SIDE_PROBE)));
    const leftPhase = left !== right ? phaseOfRoom(left) : null;
    const rightPhase = left !== right ? phaseOfRoom(right) : null;
    let sign: 1 | -1;
    if (rack.face !== undefined) {
      // The designer picked the side. The take check only accepts players on
      // the side the rack faces, so a wall between two phases is fine.
      sign = rack.face;
      if (!(sign === 1 ? leftPhase : rightPhase)) {
        errors.push(
          `Gun rack ${rack.id} (${rack.weapon}) at ${where} faces a side with no player closure; ` +
            `flip it to face ${phasesFrom(want)}.`,
        );
        continue;
      }
    } else if (leftPhase && rightPhase) {
      errors.push(
        `Gun rack ${rack.id} (${rack.weapon}) at ${where} is on a wall between phase ${leftPhase} and phase ${rightPhase}; ` +
          `pick which side it faces.`,
      );
      continue;
    } else if (!leftPhase && !rightPhase) {
      errors.push(
        `Gun rack ${rack.id} (${rack.weapon}) at ${where} has no player closure on either side; move it into ${phasesFrom(want)}.`,
      );
      continue;
    } else {
      sign = leftPhase ? 1 : -1;
    }
    entry.playerRoom = sign === 1 ? left : right;
    entry.phase = sign === 1 ? leftPhase : rightPhase;
    entry.facing = { x: sides.n.x * sign, z: sides.n.z * sign };
    if (entry.phase! < want) {
      errors.push(
        `Gun rack ${rack.id} (${rack.weapon}) at ${where} faces phase ${entry.phase}; ` +
          `${rack.weapon} racks belong in ${phasesFrom(want)}.`,
      );
    }
  }
  for (const weapon of ["pistol", "rifle", "shotgun"] as const satisfies readonly ZombotsRackWeapon[]) {
    if (!rackedWeapons.has(weapon)) warnings.push(`No ${weapon} rack; phase ${RACK_PHASE[weapon]} should have one.`);
  }

  const roomOf = (p: Vec2) => raster.roomAt(p);
  return {
    phases,
    zombieRooms,
    windowLinks,
    doorRooms: graph.doorRooms,
    rackPhase,
    slivers,
    rooms,
    roomOf,
    phaseOf: (p) => phaseOfRoom(closure(roomOf(p))),
    errors,
    warnings,
  };
}

/**
 * Door id → the two phases it joins, low first. Only doors on the phase
 * chain are listed; empty when the layout has no valid chain.
 */
export function zombotsDoorPhases(
  layout: Pick<ZombotsLayout, "phases" | "doorRooms">,
): Map<string, readonly [number, number]> {
  const out = new Map<string, readonly [number, number]>();
  const phases = layout.phases;
  if (!phases) return out;
  const phaseOfRoom = new Map<number, number>();
  for (let i = 0; i < phases.length; i++) phaseOfRoom.set(phases[i]!, i + 1);
  for (const door of layout.doorRooms) {
    if (!door.rooms) continue;
    const a = phaseOfRoom.get(door.rooms[0]);
    const b = phaseOfRoom.get(door.rooms[1]);
    if (a === undefined || b === undefined) continue;
    out.set(door.doorId, a < b ? [a, b] : [b, a]);
  }
  return out;
}

/**
 * Phases the players can reach: 1, then one more for each opened door on the
 * chain. A door only counts once the phase before it is reachable, so a door
 * bought out of order (if a map allows it) unlocks nothing yet. Without a
 * valid chain, each open door counts as one phase, up to 3.
 */
export function zombotsUnlockedPhases(
  layout: Pick<ZombotsLayout, "phases">,
  doorPhases: ReadonlyMap<string, readonly [number, number]>,
  openDoorIds: readonly string[],
): number {
  if (!layout.phases) return min(3, 1 + openDoorIds.length);
  let unlocked = 1;
  let grew = true;
  while (grew) {
    grew = false;
    for (const id of openDoorIds) {
      const pair = doorPhases.get(id);
      if (pair && pair[0] <= unlocked && pair[1] > unlocked) {
        unlocked = pair[1];
        grew = true;
      }
    }
  }
  return unlocked;
}

/**
 * Spawn gate from the layout: a spawn is live when its zombie closure has a
 * window onto a phase the players have unlocked. Doors open in order, so
 * `unlockedPhases` is 1 at the start, then 2, then 3.
 */
export function zombotsSpawnGate(
  layout: Pick<ZombotsLayout, "zombieRooms" | "windowLinks">,
  unlockedPhases: number,
): ZombotsSpawnGate {
  const live = new Set<string>();
  for (const z of layout.zombieRooms) {
    const open = layout.windowLinks.some((w) => w.zombieRoom === z.room && w.phase <= unlockedPhases);
    if (open) for (const id of z.spawnIds) live.add(id);
  }
  return (spawnId) => live.has(spawnId);
}

/**
 * Windows a zombie may not use yet: every window into a player closure the
 * players haven't opened a door to. Phase 1 is always open; another closure
 * opens once a bought door chain joins it to phase 1. Zombies meet these
 * windows as solid wall (no walk, jump or crawl through) and their nav skips
 * them, so a zombie never lands in a room no human can reach. Shots and
 * sight still pass. Empty when the layout has no valid phase chain.
 */
export function zombotsSealedWindowIds(
  layout: Pick<ZombotsLayout, "phases" | "doorRooms" | "windowLinks">,
  isOpen: (doorId: string) => boolean,
): string[] {
  const phases = layout.phases;
  if (phases === null) return [];
  const reached: number[] = [phases[0]];
  // Few doors per map, so relaxing until stable is plenty.
  let grew = true;
  while (grew) {
    grew = false;
    for (let i = 0; i < layout.doorRooms.length; i++) {
      const door = layout.doorRooms[i]!;
      if (!door.rooms || !isOpen(door.doorId)) continue;
      const hasA = reached.indexOf(door.rooms[0]) >= 0;
      const hasB = reached.indexOf(door.rooms[1]) >= 0;
      if (hasA === hasB) continue;
      reached.push(hasA ? door.rooms[1] : door.rooms[0]);
      grew = true;
    }
  }
  const out: string[] = [];
  for (let i = 0; i < layout.windowLinks.length; i++) {
    const link = layout.windowLinks[i]!;
    if (reached.indexOf(link.playerRoom) < 0 && out.indexOf(link.windowId) < 0) {
      out.push(link.windowId);
    }
  }
  return out;
}

/** Point on the wall line and its unit normal, or null off a full wall. */
function wallSides(
  wall: { a: Vec2; b: Vec2; kind?: string } | undefined,
  center: Vec2,
): { p: Vec2; n: Vec2 } | null {
  if (!wall || (wall.kind !== undefined && wall.kind !== "full")) return null;
  const dx = wall.b.x - wall.a.x;
  const dz = wall.b.z - wall.a.z;
  const len = distance2(dx, dz);
  if (len < 1e-6) return null;
  const invLen = 1 / len;
  const ux = dx * invLen;
  const uz = dz * invLen;
  const s = (center.x - wall.a.x) * ux + (center.z - wall.a.z) * uz;
  if (s < -CENTER_ON_WALL || s > len + CENTER_ON_WALL) return null;
  const p = { x: wall.a.x + ux * s, z: wall.a.z + uz * s };
  if (distanceSquared2(center.x - p.x, center.z - p.z) > CENTER_ON_WALL * CENTER_ON_WALL) return null;
  return { p, n: { x: -uz, z: ux } };
}

function offset(p: Vec2, n: Vec2, d: number): Vec2 {
  return { x: p.x + n.x * d, z: p.z + n.z * d };
}

/** Roughly where the pad flood seeds, for messages. */
function padSeed(map: ZombotsDoorMap): Vec2 {
  const b = map.bounds;
  const corner = map.spawnCorner ?? 0;
  return {
    x: corner === 1 || corner === 2 ? b.maxX : b.minX,
    z: corner === 2 || corner === 3 ? b.maxZ : b.minZ,
  };
}

function at(p: Vec2): string {
  return `(${tenth(p.x)}, ${tenth(p.z)})`;
}

function tenth(v: number): number {
  const r = round(v * 10) / 10;
  return r === 0 ? 0 : r;
}

function area(cells: number): number {
  return tenth(cells * ZOMBOTS_ROOM_CELL * ZOMBOTS_ROOM_CELL);
}
