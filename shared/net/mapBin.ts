import { ByteReader, ByteWriter } from "./bytes.ts";

type Vec2 = { x: number; z: number };

type WallKind = "full" | "half" | "float";

type EdgeId = "south" | "east" | "north" | "west";

type CornerId = 0 | 1 | 2 | 3;

type TeamSide = {
  corners: [CornerId, CornerId];
  edge: EdgeId;
  doorHalfWidth: number;
  spawnRadius: number;
};

type BotHintKind =
  | "nudge"
  | "camp"
  | "sprint"
  | "spawn"
  | "stuck";

type BotHint = {
  id: string;
  kind: BotHintKind;
  team: "A" | "B";
  a?: Vec2;
  b?: Vec2;
  p?: Vec2;
  points?: Vec2[];
  polygon?: Vec2[];
  center?: Vec2;
  radius?: number;
  yaw?: number;
};

export type WireDoorsMap = {
  /** JSON map format version; the binary map envelope is always wire v1. */
  version: 1 | 2;
  name: string;
  description?: string;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  gridSize: number;
  teamA: TeamSide;
  teamB: TeamSide;
  walls: Array<{ id: string; a: Vec2; b: Vec2; kind?: WallKind }>;
  wallCorners?: Vec2[];
  botHints?: BotHint[];
};

const EDGE: EdgeId[] = ["south", "east", "north", "west"];
const WALL_KIND: WallKind[] = ["full", "half", "float"];
const HINT_KIND: BotHintKind[] = [
  "nudge",
  "camp",
  "sprint",
  "spawn",
  "stuck",
];

function writeVec2(w: ByteWriter, v: Vec2): void {
  w.f32(v.x);
  w.f32(v.z);
}

function readVec2(r: ByteReader): Vec2 {
  return { x: r.f32(), z: r.f32() };
}

function writeSide(w: ByteWriter, s: TeamSide): void {
  w.u8(s.corners[0]);
  w.u8(s.corners[1]);
  w.u8(Math.max(0, EDGE.indexOf(s.edge)));
  w.f32(s.doorHalfWidth);
  w.f32(s.spawnRadius);
}

function readSide(r: ByteReader): TeamSide {
  const c0 = r.u8() as CornerId;
  const c1 = r.u8() as CornerId;
  const edge = EDGE[r.u8()] ?? "south";
  return {
    corners: [c0, c1],
    edge,
    doorHalfWidth: r.f32(),
    spawnRadius: r.f32(),
  };
}

const HINT_HAS_AB = 1;
const HINT_HAS_P = 2;
const HINT_HAS_POINTS = 4;
const HINT_HAS_POLY = 8;
const HINT_HAS_STUCK = 16;

function writeHint(w: ByteWriter, h: BotHint): void {
  w.str8(h.id);
  w.u8(Math.max(0, HINT_KIND.indexOf(h.kind)));
  w.u8(h.team === "B" ? 1 : 0);
  let flags = 0;
  if (h.a && h.b) flags |= HINT_HAS_AB;
  if (h.p) flags |= HINT_HAS_P;
  if (h.points) flags |= HINT_HAS_POINTS;
  if (h.polygon) flags |= HINT_HAS_POLY;
  if (h.center && h.radius != null && h.yaw != null) flags |= HINT_HAS_STUCK;
  w.u8(flags);
  if (flags & HINT_HAS_AB) {
    writeVec2(w, h.a!);
    writeVec2(w, h.b!);
  }
  if (flags & HINT_HAS_P) writeVec2(w, h.p!);
  if (flags & HINT_HAS_POINTS) {
    const pts = h.points ?? [];
    w.u8(Math.min(255, pts.length));
    for (const p of pts) writeVec2(w, p);
  }
  if (flags & HINT_HAS_POLY) {
    const pts = h.polygon ?? [];
    w.u8(Math.min(255, pts.length));
    for (const p of pts) writeVec2(w, p);
  }
  if (flags & HINT_HAS_STUCK) {
    writeVec2(w, h.center!);
    w.f32(h.radius!);
    w.f32(h.yaw!);
  }
}

function readHint(r: ByteReader): BotHint {
  const id = r.str8();
  const kind = HINT_KIND[r.u8()] ?? "camp";
  const team = r.u8() === 1 ? "B" : "A";
  const flags = r.u8();
  const h: BotHint = { id, kind, team };
  if (flags & HINT_HAS_AB) {
    h.a = readVec2(r);
    h.b = readVec2(r);
  }
  if (flags & HINT_HAS_P) h.p = readVec2(r);
  if (flags & HINT_HAS_POINTS) {
    const n = r.u8();
    const pts: Vec2[] = [];
    for (let i = 0; i < n; i++) pts.push(readVec2(r));
    h.points = pts;
  }
  if (flags & HINT_HAS_POLY) {
    const n = r.u8();
    const pts: Vec2[] = [];
    for (let i = 0; i < n; i++) pts.push(readVec2(r));
    h.polygon = pts;
  }
  if (flags & HINT_HAS_STUCK) {
    h.center = readVec2(r);
    h.radius = r.f32();
    h.yaw = r.f32();
  }
  return h;
}

const MAP_HAS_DESC = 1;
const MAP_HAS_CORNERS = 2;
const MAP_HAS_HINTS = 4;

export function writeMap(w: ByteWriter, map: WireDoorsMap): void {
  let flags = 0;
  if (map.description) flags |= MAP_HAS_DESC;
  if (map.wallCorners && map.wallCorners.length > 0) flags |= MAP_HAS_CORNERS;
  if (map.botHints && map.botHints.length > 0) flags |= MAP_HAS_HINTS;
  w.u8(flags);
  w.u8(map.version === 1 ? 1 : 1);
  w.str8(map.name);
  if (flags & MAP_HAS_DESC) w.str16(map.description ?? "");
  w.f32(map.bounds.minX);
  w.f32(map.bounds.maxX);
  w.f32(map.bounds.minZ);
  w.f32(map.bounds.maxZ);
  w.f32(map.gridSize);
  writeSide(w, map.teamA);
  writeSide(w, map.teamB);
  const walls = map.walls ?? [];
  w.u16(Math.min(65535, walls.length));
  for (const wall of walls) {
    w.str8(wall.id);
    writeVec2(w, wall.a);
    writeVec2(w, wall.b);
    w.u8(Math.max(0, WALL_KIND.indexOf(wall.kind ?? "full")));
  }
  if (flags & MAP_HAS_CORNERS) {
    const corners = map.wallCorners ?? [];
    w.u16(Math.min(65535, corners.length));
    for (const c of corners) writeVec2(w, c);
  }
  if (flags & MAP_HAS_HINTS) {
    const hints = map.botHints ?? [];
    w.u16(Math.min(65535, hints.length));
    for (const h of hints) writeHint(w, h);
  }
}

export function readMap(r: ByteReader): WireDoorsMap {
  const flags = r.u8();
  r.u8(); // version
  const name = r.str8();
  const description = flags & MAP_HAS_DESC ? r.str16() : undefined;
  const bounds = {
    minX: r.f32(),
    maxX: r.f32(),
    minZ: r.f32(),
    maxZ: r.f32(),
  };
  const gridSize = r.f32();
  const teamA = readSide(r);
  const teamB = readSide(r);
  const wallCount = r.u16();
  const walls: WireDoorsMap["walls"] = [];
  for (let i = 0; i < wallCount; i++) {
    const id = r.str8();
    const a = readVec2(r);
    const b = readVec2(r);
    const kind = WALL_KIND[r.u8()] ?? "full";
    walls.push(kind === "full" ? { id, a, b } : { id, a, b, kind });
  }
  let wallCorners: Vec2[] | undefined;
  if (flags & MAP_HAS_CORNERS) {
    const n = r.u16();
    wallCorners = [];
    for (let i = 0; i < n; i++) wallCorners.push(readVec2(r));
  }
  let botHints: BotHint[] | undefined;
  if (flags & MAP_HAS_HINTS) {
    const n = r.u16();
    botHints = [];
    for (let i = 0; i < n; i++) botHints.push(readHint(r));
  }
  const map: WireDoorsMap = {
    version: 1,
    name,
    bounds,
    gridSize,
    teamA,
    teamB,
    walls,
  };
  if (description) map.description = description;
  if (wallCorners) map.wallCorners = wallCorners;
  if (botHints) map.botHints = botHints;
  return map;
}
