/**
 * Doors map format — keep in sync with mapBuilder/src/mapTypes.ts
 *
 * Used by the server when loading a map for matches.
 * Corner spawn radii are for join / death only; door captures exit through
 * the scorer's own door at the same relative entry spot.
 */
import {
  MAP_FORMAT_VERSION,
  type MapFormatVersion,
} from "../../../shared/world/doorsMapFormat.ts";

export { MAP_FORMAT_VERSION, type MapFormatVersion };
import { distance2, min } from "../math/index.ts";

export type Vec2 = { x: number; z: number };

export type EdgeId = "south" | "east" | "north" | "west";

export type CornerId = 0 | 1 | 2 | 3;

/**
 * full = floor-to-ceiling; half = crouch cover (jump over);
 * float = hanging slab top-aligned with full walls, bottom at stand head (crouch under).
 */
export type WallKind = "full" | "half" | "float";
export type MapMirrorMode = "flipY" | "flipXZ";

export type Wall = {
  id: string;
  a: Vec2;
  b: Vec2;
  /** Defaults to "full" when omitted (legacy maps). */
  kind?: WallKind;
};

export function wallKind(wall: Pick<Wall, "kind">): WallKind {
  if (wall.kind === "half") return "half";
  if (wall.kind === "float") return "float";
  return "full";
}

/** Fixed zombie-mode window width (world units). All windows share this size. */
export const WINDOW_WIDTH = 1.5;

/**
 * Zombie-mode crawl-through opening cut into a full interior wall.
 * `center` lies on the referenced wall segment; the opening spans
 * `WINDOW_WIDTH` along the wall, centered there.
 */
export type Window = {
  id: string;
  /** Interior full wall this opening is cut into. */
  wallId: string;
  center: Vec2;
};

export type TeamSide = {
  corners: [CornerId, CornerId];
  edge: EdgeId;
  doorHalfWidth: number;
  spawnRadius: number;
};

// ── Bot hints (designer-authored bot guidance) ─────────────────────────────

export type BotHintKind =
  | "nudge"
  | "camp"
  | "sprint"
  | "spawn"
  | "stuck";

export type BotHintTeam = "A" | "B";

export const BOT_HINT_KINDS: readonly BotHintKind[] = [
  "nudge",
  "camp",
  "sprint",
  "spawn",
  "stuck",
] as const;

type BotHintBase = {
  id: string;
  kind: BotHintKind;
  team: BotHintTeam;
};

export type BotHintArrow = BotHintBase & {
  kind: "spawn";
  a: Vec2;
  b: Vec2;
};

export type BotHintNudge = BotHintBase & {
  kind: "nudge";
  points: Vec2[];
};

export type BotHintCamp = BotHintBase & {
  kind: "camp";
  p: Vec2;
};

export type BotHintZone = BotHintBase & {
  kind: "sprint";
  polygon: Vec2[];
};

export type BotHintStuck = BotHintBase & {
  kind: "stuck";
  center: Vec2;
  radius: number;
  /** Player yaw: forward = (−sin yaw, −cos yaw). */
  yaw: number;
};

export type BotHint =
  | BotHintArrow
  | BotHintNudge
  | BotHintCamp
  | BotHintZone
  | BotHintStuck;

export type DoorsMap = {
  version: MapFormatVersion;
  name: string;
  /** Optional short blurb for menus / map select. */
  description?: string;
  bounds: {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
  };
  gridSize: number;
  /** Builder authoring rule; server geometry is already fully expanded. */
  mirrorMode?: MapMirrorMode;
  teamA: TeamSide;
  teamB: TeamSide;
  walls: Wall[];
  /**
   * Zombie-mode crawl-through openings cut into full interior walls.
   * Omitted or [] on maps without zombie windows.
   */
  windows?: Window[];
  /**
   * Unique full-wall corner / vertical-edge points for bot nav.
   * Shared endpoints (L/T joints) appear once. Omitted on legacy maps.
   */
  wallCorners?: Vec2[];
  /** Designer bot guidance. Omitted or [] on legacy maps. */
  botHints?: BotHint[];
};

export function normalizeBotHints(map: DoorsMap): BotHint[] {
  return Array.isArray(map.botHints) ? map.botHints : [];
}

export const EDGE_CORNERS: Record<EdgeId, [CornerId, CornerId]> = {
  south: [0, 1],
  east: [1, 2],
  north: [2, 3],
  west: [3, 0],
};

export const OPPOSITE_EDGE: Record<EdgeId, EdgeId> = {
  south: "north",
  north: "south",
  east: "west",
  west: "east",
};

export function cornerWorld(
  bounds: DoorsMap["bounds"],
  corner: CornerId,
): Vec2 {
  const { minX, maxX, minZ, maxZ } = bounds;
  switch (corner) {
    case 0:
      return { x: minX, z: minZ };
    case 1:
      return { x: maxX, z: minZ };
    case 2:
      return { x: maxX, z: maxZ };
    case 3:
      return { x: minX, z: maxZ };
  }
}

export function doorSegment(
  bounds: DoorsMap["bounds"],
  side: TeamSide,
): [Vec2, Vec2] {
  const [c0, c1] = EDGE_CORNERS[side.edge];
  const p0 = cornerWorld(bounds, c0);
  const p1 = cornerWorld(bounds, c1);
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
