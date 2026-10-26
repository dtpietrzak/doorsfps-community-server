import {
  cornerWorld,
  doorSegment,
  type DoorsMap,
  type TeamSide,
  type Vec2,
  wallKind,
} from "../shared/map.ts";
import {
  DOOR_CLOSED_STANDOFF,
  DOOR_POST_WIDTH,
  DOOR_WALK_IN,
} from "../../../shared/sim/game.ts";
import { createRandom } from "../core/random.ts";
import {
  abs,
  ceil,
  clamp,
  distance2,
  distance3,
  fastAtan2,
  fastCos,
  fastSin,
  floor,
  max,
  min,
  TWO_PI,
} from "../math/index.ts";

export const PLAYER_RADIUS = 0.35;
export const WALL_HALF_THICK = 0.22;
/** Full wall height — must match client buildMapScene WALL_HEIGHT. */
export const WALL_HEIGHT = 3.45; // 15% taller than original 3
/**
 * Half-wall height: above the crouched crown (1.0) so crouch is full cover;
 * standing visor (~1.48) still peeks over.
 * Movement collision is taller (see CROUCH_COLLISION_HEIGHT) so the
 * capsule still fits under floating walls.
 */
export const HALF_WALL_HEIGHT = 1.2;
/**
 * When classifying half-walls as jumpable for bots, ignore this many world units
 * at each end of the segment. A 5u wall is treated as a centered 3u vault target
 * so bots do not arm jumps on the lip and miss past the edge.
 */
export const JUMPABLE_HALF_WALL_END_INSET = 1;
/**
 * Floating wall solid slab: top-aligned with full walls. Underside sits
 * below standing head so the opening is a crouch tunnel (crouch crown 1.0).
 * Crouch clears; standing collides; jumping into the slab still hits.
 */
export const FLOAT_WALL_Y_MAX = WALL_HEIGHT;
/** Fixed underside — do not couple to HALF_WALL_HEIGHT (slab is thicker). */
export const FLOAT_WALL_Y_MIN = 1.4;
/**
 * Player vertical silhouette for wall clearance (from feet).
 * Crouch must fit under FLOAT_WALL_Y_MIN by ~0.1u; stand must not.
 */
export const STAND_COLLISION_HEIGHT = 1.7;
/** How much crouch / slide clears a floating-wall underside. */
export const FLOAT_WALL_CROUCH_CLEARANCE = 0.1;
export const CROUCH_COLLISION_HEIGHT =
  FLOAT_WALL_Y_MIN - FLOAT_WALL_CROUCH_CLEARANCE;
/** How deep into the door segment you must stand to score. */
export const DOOR_CAPTURE_RADIUS = 0.85;
/**
 * Only treat positions this deep into the map (from the door plane) as
 * candidates for the walk-in pocket clamp.
 */
const DOOR_WALK_IN_NEAR_DEPTH = PLAYER_RADIUS + 0.55;

type Segment = { a: Vec2; b: Vec2; yMin: number; yMax: number };
type Vec3 = { x: number; y: number; z: number };

export type VerticalRange = { yMin: number; yMax: number };

export function verticalRangeForKind(
  kind: "full" | "half" | "float",
): VerticalRange {
  switch (kind) {
    case "half":
      return { yMin: 0, yMax: HALF_WALL_HEIGHT };
    case "float":
      return { yMin: FLOAT_WALL_Y_MIN, yMax: FLOAT_WALL_Y_MAX };
    default:
      return { yMin: 0, yMax: WALL_HEIGHT };
  }
}

/** Span height of a wall kind (mesh box height). */
export function heightForWallKind(kind: "full" | "half" | "float"): number {
  const r = verticalRangeForKind(kind);
  return r.yMax - r.yMin;
}

export function collisionHeightForCrouch(crouch: boolean): number {
  return crouch ? CROUCH_COLLISION_HEIGHT : STAND_COLLISION_HEIGHT;
}

/**
 * True when player vertical interval [feetY, headY] overlaps wall slab.
 * Head uses >= so a standing silhouette (taller than FLOAT_WALL_Y_MIN) collides
 * and forces crouch-under; feet stay strict < so jump-over half-walls still clears
 * when feet sit exactly on the half-wall top.
 */
export function bodyOverlapsSlab(
  feetY: number,
  headY: number,
  yMin: number,
  yMax: number,
): boolean {
  return headY >= yMin && feetY < yMax;
}

/** Spatial grid cell size (world units) for wall segment queries. */
const SOLID_GRID_CELL = 3;

/**
 * Axis-aligned map: outer bounds + interior wall segments + door capture zones.
 */
export class MapCollision {
  readonly map: DoorsMap;
  private readonly walls: Segment[] = [];
  private readonly perimeter: Segment[] = [];
  /** walls + perimeter in one array for grid indexing. */
  private readonly solids: Segment[] = [];
  /** cell index → solid segment indices. */
  private solidGrid: number[][] = [];
  private gridCols = 1;
  private gridRows = 1;
  private gridOriginX = 0;
  private gridOriginZ = 0;
  private readonly cellSize = SOLID_GRID_CELL;
  /** Scratch flags for unique segment visits during a query. */
  private visitScratch: boolean[] = [];
  /**
   * When true, resolvePosition allows a short walk-in past the door plane.
   * Keep false while doors are closed so players don't clip into the sealed
   * portal; PlayerManager / client set this from the door cycle.
   */
  public doorWalkInEnabled = true;
  private readonly spawnRng = createRandom(0x9e3779b9);

  constructor(map: DoorsMap) {
    this.map = map;
    const source = map.walls;
    for (let i = 0; i < source.length; i++) {
      const w = source[i]!;
      const range = verticalRangeForKind(wallKind(w));
      this.walls.push({
        a: copyVec2(w.a),
        b: copyVec2(w.b),
        yMin: range.yMin,
        yMax: range.yMax,
      });
    }
    this.buildPerimeterWithDoorGaps();
    for (let i = 0; i < this.walls.length; i++) this.solids.push(this.walls[i]!);
    for (let i = 0; i < this.perimeter.length; i++) {
      this.solids.push(this.perimeter[i]!);
    }
    this.buildSolidGrid();
    this.visitScratch = [];
    for (let i = 0; i < this.solids.length; i++) this.visitScratch.push(false);
  }

  /**
   * Hitscan vs solid geometry (interior walls + outer perimeter slabs).
   * Full / half / float use their vertical ranges; half-thickness matches meshes.
   * Returns distance along the ray, or null if nothing within maxRange.
   */
  public raycastSolid(
    origin: Vec3,
    direction: Vec3,
    maxRange: number,
  ): number | null {
    return this.raycastSolidsFiltered(origin, direction, maxRange, false);
  }

  /**
   * Hitscan vs **full** walls only (floor-to-ceiling interior + perimeter).
   * Half and floating slabs are ignored — for nav guides that can clear cover.
   * Mirrors client MapCollision.raycastFullSolid.
   */
  public raycastFullSolid(
    origin: Vec3,
    direction: Vec3,
    maxRange: number,
  ): number | null {
    return this.raycastSolidsFiltered(origin, direction, maxRange, true);
  }

  private raycastSolidsFiltered(
    origin: Vec3,
    direction: Vec3,
    maxRange: number,
    fullOnly: boolean,
  ): number | null {
    const len = distance3(direction.x, direction.y, direction.z);
    if (len < 1e-12 || maxRange <= 0) return null;
    const dir: Vec3 = {
      x: direction.x / len,
      y: direction.y / len,
      z: direction.z / len,
    };

    let best: number | null = null;
    const consider = (seg: Segment) => {
      if (fullOnly && !isFullWallSegment(seg)) return;
      const t = rayThickSegment(
        origin,
        dir,
        maxRange,
        seg.a,
        seg.b,
        WALL_HALF_THICK,
        seg.yMin,
        seg.yMax,
      );
      if (t !== null && (best === null || t < best)) best = t;
    };

    // Query segments in the ray's horizontal AABB (expanded by wall thickness).
    const endX = origin.x + dir.x * maxRange;
    const endZ = origin.z + dir.z * maxRange;
    const pad = WALL_HALF_THICK + 0.05;
    const minX = min(origin.x, endX) - pad;
    const maxX = max(origin.x, endX) + pad;
    const minZ = min(origin.z, endZ) - pad;
    const maxZ = max(origin.z, endZ) + pad;
    this.forEachSolidInAabb(minX, maxX, minZ, maxZ, consider);
    return best;
  }

  /**
   * Resolve horizontal motion against bounds + walls. Returns new x,z.
   * @param feetY World-space feet height (0 on ground).
   * @param headY World-space top of player silhouette. Walls with no vertical
   *   overlap are ignored (jump over half-walls; crouch under floating walls).
   *   Defaults to standing height from feetY.
   * @param halfWallEndInset When > 0, half-wall segments are shortened by this
   *   amount at each end before collision (bot jumpable-core checks only).
   */
  public resolvePosition(
    x: number,
    z: number,
    radius = PLAYER_RADIUS,
    feetY = 0,
    headY = feetY + STAND_COLLISION_HEIGHT,
    halfWallEndInset = 0,
  ): {
    x: number;
    z: number;
  } {
    let px = x;
    let pz = z;

    // Outer bounds (inset by radius); optional short walk-in pocket at doors.
    const clamped0 = this.clampBounds(px, pz, radius);
    px = clamped0.x;
    pz = clamped0.z;

    // Nearby solid segments only (spatial grid). Margin covers wall half-thick.
    const pad = radius + WALL_HALF_THICK + 0.05;
    this.forEachSolidInAabb(
      px - pad,
      px + pad,
      pz - pad,
      pz + pad,
      (seg) => {
        if (!bodyOverlapsSlab(feetY, headY, seg.yMin, seg.yMax)) return;
        let ax = seg.a.x;
        let az = seg.a.z;
        let bx = seg.b.x;
        let bz = seg.b.z;
        if (halfWallEndInset > 0 && isHalfWallSegment(seg)) {
          const core = segmentWithEndInset(seg.a, seg.b, halfWallEndInset);
          if (!core) return; // too short for a vault core — ignore for inset resolve
          ax = core.a.x;
          az = core.a.z;
          bx = core.b.x;
          bz = core.b.z;
        }
        const pushed = pushCircleFromSegment(
          px,
          pz,
          radius,
          { x: ax, z: az },
          { x: bx, z: bz },
          WALL_HALF_THICK,
        );
        px = pushed.x;
        pz = pushed.z;
      },
    );

    // Re-clamp after pushes (preserve door walk-in only while enabled).
    return this.clampBounds(px, pz, radius);
  }

  private clampBounds(
    x: number,
    z: number,
    radius: number,
  ): { x: number; z: number } {
    if (this.doorWalkInEnabled) {
      return clampToBoundsWithDoorWalkIn(x, z, radius, this.map);
    }
    return clampToBoundsWithClosedDoorStandoff(x, z, radius, this.map);
  }

  /** Build uniform grid over map bounds for solid segment lookups. */
  private buildSolidGrid(): void {
    const { minX, maxX, minZ, maxZ } = this.map.bounds;
    const pad = WALL_HALF_THICK + 1;
    this.gridOriginX = minX - pad;
    this.gridOriginZ = minZ - pad;
    const width = max(this.cellSize, maxX - minX + pad * 2);
    const depth = max(this.cellSize, maxZ - minZ + pad * 2);
    this.gridCols = max(1, ceil(width / this.cellSize));
    this.gridRows = max(1, ceil(depth / this.cellSize));
    const n = this.gridCols * this.gridRows;
    this.solidGrid = [];
    for (let i = 0; i < n; i++) this.solidGrid.push([]);

    for (let si = 0; si < this.solids.length; si++) {
      const seg = this.solids[si]!;
      const thick = WALL_HALF_THICK + 0.02;
      const sMinX = min(seg.a.x, seg.b.x) - thick;
      const sMaxX = max(seg.a.x, seg.b.x) + thick;
      const sMinZ = min(seg.a.z, seg.b.z) - thick;
      const sMaxZ = max(seg.a.z, seg.b.z) + thick;
      const c0 = this.cellCoord(sMinX, sMinZ);
      const c1 = this.cellCoord(sMaxX, sMaxZ);
      for (let cz = c0.cz; cz <= c1.cz; cz++) {
        for (let cx = c0.cx; cx <= c1.cx; cx++) {
          this.solidGrid[cz * this.gridCols + cx]!.push(si);
        }
      }
    }
  }

  private cellCoord(x: number, z: number): { cx: number; cz: number } {
    const cx = clamp(
      floor((x - this.gridOriginX) / this.cellSize),
      0,
      this.gridCols - 1,
    );
    const cz = clamp(
      floor((z - this.gridOriginZ) / this.cellSize),
      0,
      this.gridRows - 1,
    );
    return { cx, cz };
  }

  /**
   * Invoke `fn` once per solid segment whose expanded AABB overlaps the query box.
   */
  private forEachSolidInAabb(
    minX: number,
    maxX: number,
    minZ: number,
    maxZ: number,
    fn: (seg: Segment) => void,
  ): void {
    if (this.solids.length === 0) return;
    const c0 = this.cellCoord(minX, minZ);
    const c1 = this.cellCoord(maxX, maxZ);
    const seen = this.visitScratch;
    for (let i = 0; i < seen.length; i++) seen[i] = false;
    for (let cz = c0.cz; cz <= c1.cz; cz++) {
      for (let cx = c0.cx; cx <= c1.cx; cx++) {
        const bucket = this.solidGrid[cz * this.gridCols + cx];
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const si = bucket[i]!;
          if (seen[si] === true) continue;
          seen[si] = true;
          fn(this.solids[si]!);
        }
      }
    }
  }

  /**
   * True when a standing (or given) silhouette at x,z is not inside any wall slab.
   * Used to block uncrouch under low overhead solids.
   */
  public hasHeadroom(
    x: number,
    z: number,
    feetY = 0,
    headY = feetY + STAND_COLLISION_HEIGHT,
    radius = PLAYER_RADIUS,
  ): boolean {
    const resolved = this.resolvePosition(x, z, radius, feetY, headY);
    return probeReachable(x, z, resolved.x, resolved.z);
  }

  /**
   * Classify whether a world point is reachable for a standing player, only by
   * crouching under a floating wall, only by jumping a half-wall, or not at all
   * (full wall / perimeter). Used by bots to decide crouch-under vs jump-over
   * vs detour. Floating walls are crouchable, never jumpable.
   *
   * Half-wall jumpable samples ignore {@link JUMPABLE_HALF_WALL_END_INSET} at
   * each end of the segment so bots do not vault the lip and miss past the edge.
   * End zones stay non-clear for standing (real geometry still blocks) and are
   * reported as blocked so nav detours instead of arming a hop.
   */
  public classifyProbe(
    x: number,
    z: number,
    radius = PLAYER_RADIUS,
  ): "clear" | "crouchable" | "jumpable" | "blocked" {
    const standHead = STAND_COLLISION_HEIGHT;
    const ground = this.resolvePosition(x, z, radius, 0, standHead);
    if (probeReachable(x, z, ground.x, ground.z)) return "clear";

    // Crouch silhouette clears floating slabs (bottom at FLOAT_WALL_Y_MIN).
    const crouch = this.resolvePosition(
      x,
      z,
      radius,
      0,
      CROUCH_COLLISION_HEIGHT,
    );
    if (probeReachable(x, z, crouch.x, crouch.z)) return "crouchable";

    // Feet just above half-wall top — same clearance players get at jump apex.
    // headY rises with feet so the silhouette still overlaps floating slabs.
    const airFeet = HALF_WALL_HEIGHT + 0.05;
    const air = this.resolvePosition(
      x,
      z,
      radius,
      airFeet,
      airFeet + standHead,
    );
    if (!probeReachable(x, z, air.x, air.z)) return "blocked";

    // Only the vault *core* (half-wall shortened on both ends) counts as jumpable.
    // If ground is clear once ends are inset, this sample was only on the lip.
    const coreGround = this.resolvePosition(
      x,
      z,
      radius,
      0,
      standHead,
      JUMPABLE_HALF_WALL_END_INSET,
    );
    if (probeReachable(x, z, coreGround.x, coreGround.z)) return "blocked";
    return "jumpable";
  }

  /**
   * Probe a short distance along a facing yaw (player forward = −sin/−cos).
   * Returns the obstacle class at that sample point.
   */
  public classifyForward(
    x: number,
    z: number,
    yaw: number,
    distance = 0.9,
    radius = PLAYER_RADIUS,
  ): "clear" | "crouchable" | "jumpable" | "blocked" {
    const tx = x - fastSin(yaw) * distance;
    const tz = z - fastCos(yaw) * distance;
    return this.classifyProbe(tx, tz, radius);
  }

  /** True if player (circle) is touching the team's door zone. */
  public isInDoorZone(
    x: number,
    z: number,
    side: TeamSide,
    radius = DOOR_CAPTURE_RADIUS,
  ): boolean {
    const [d0, d1] = doorSegment(this.map.bounds, side);
    const dist = distPointToSegment({ x, z }, d0, d1);
    return dist <= radius;
  }

  /**
   * After capturing at the enemy door, map the capture pose onto the scorer's
   * own door as a portal: same along-door slot, through-door depth flipped
   * (outward through enemy = inward through home), yaw remapped in that frame.
   * Omit `yaw` to face into the map. Pitch is the caller's to copy.
   * Corner spawn radii are not used — only join / death respawn use those.
   */
  public homeFromEnemyDoor(
    x: number,
    z: number,
    ownSide: TeamSide,
    enemySide: TeamSide,
    yaw?: number,
  ): { x: number; z: number; yaw: number } {
    const enemy = doorFrame(this.map, enemySide);
    const own = doorFrame(this.map, ownSide);

    // World-aligned along-edge offset so N/S doors share +X and E/W share +Z
    // (doorSegment endpoint order flips on opposite edges).
    let along = (x - enemy.mid.x) * enemy.alongX +
      (z - enemy.mid.z) * enemy.alongZ;
    along = clamp(along, -own.halfLen, own.halfLen);

    // Outward through the enemy plane is inward through the home plane.
    let depth = -((x - enemy.mid.x) * enemy.inwardX +
      (z - enemy.mid.z) * enemy.inwardZ);
    depth = clamp(depth, -DOOR_WALK_IN, DOOR_CAPTURE_RADIUS);

    const hx = own.mid.x + along * own.alongX + depth * own.inwardX;
    const hz = own.mid.z + along * own.alongZ + depth * own.inwardZ;
    const resolved = this.resolvePosition(hx, hz);

    // Face into the map (forward = (−sin yaw, −cos yaw)) when no capture yaw.
    let outYaw = fastAtan2(-own.inwardX, -own.inwardZ);
    if (yaw !== undefined) {
      const fx = -fastSin(yaw);
      const fz = -fastCos(yaw);
      const fAlong = fx * enemy.alongX + fz * enemy.alongZ;
      const fInward = fx * enemy.inwardX + fz * enemy.inwardZ;
      const ox = fAlong * own.alongX + (-fInward) * own.inwardX;
      const oz = fAlong * own.alongZ + (-fInward) * own.inwardZ;
      outYaw = fastAtan2(-ox, -oz);
    }
    return { x: resolved.x, z: resolved.z, yaw: outYaw };
  }

  /** Random spawn near one of the team's two corners, facing into the map. */
  public randomSpawn(side: TeamSide): { x: number; z: number; yaw: number } {
    const corner = this.spawnRng() < 0.5 ? side.corners[0] : side.corners[1];
    const c = cornerWorld(this.map.bounds, corner);
    const { minX, maxX, minZ, maxZ } = this.map.bounds;
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;

    // Sample a few times for a free-ish point inside spawn radius.
    let x = c.x;
    let z = c.z;
    for (let i = 0; i < 12; i++) {
      const ang = this.spawnRng() * TWO_PI;
      const r = this.spawnRng() * side.spawnRadius;
      // Bias slightly toward map center so we don't sit in the wall.
      const towardX = cx - c.x;
      const towardZ = cz - c.z;
      const tlen = distance2(towardX, towardZ) || 1;
      const nx = c.x + fastCos(ang) * r * 0.55 +
        (towardX / tlen) * (0.8 + this.spawnRng());
      const nz = c.z + fastSin(ang) * r * 0.55 +
        (towardZ / tlen) * (0.8 + this.spawnRng());
      const resolved = this.resolvePosition(nx, nz);
      x = resolved.x;
      z = resolved.z;
      // Prefer points not too close to the outer wall corner
      if (distance2(x - c.x, z - c.z) < side.spawnRadius * 1.2) break;
    }

    // Face toward map center (forward = (−sin yaw, −cos yaw)).
    const dx = cx - x;
    const dz = cz - z;
    const yaw = fastAtan2(-dx, -dz);

    return { x, z, yaw };
  }

  private buildPerimeterWithDoorGaps(): void {
    const b = this.map.bounds;
    const doorA = doorSegment(b, this.map.teamA);
    const doorB = doorSegment(b, this.map.teamB);

    // Four outer edges, split by door openings when the door lies on that edge.
    addEdgeWithGap(this.perimeter, { x: b.minX, z: b.minZ }, {
      x: b.maxX,
      z: b.minZ,
    }, [doorA, doorB]); // south
    addEdgeWithGap(this.perimeter, { x: b.maxX, z: b.minZ }, {
      x: b.maxX,
      z: b.maxZ,
    }, [doorA, doorB]); // east
    addEdgeWithGap(this.perimeter, { x: b.maxX, z: b.maxZ }, {
      x: b.minX,
      z: b.maxZ,
    }, [doorA, doorB]); // north
    addEdgeWithGap(this.perimeter, { x: b.minX, z: b.maxZ }, {
      x: b.minX,
      z: b.minZ,
    }, [doorA, doorB]); // west
  }
}

function copyVec2(p: Vec2): Vec2 {
  return { x: p.x, z: p.z };
}

/**
 * Local frame for a team door: midpoint, world-aligned along-edge axis,
 * inward normal (toward map center), and half-length of the door segment.
 */
function doorFrame(
  map: DoorsMap,
  side: TeamSide,
): {
  mid: Vec2;
  alongX: number;
  alongZ: number;
  inwardX: number;
  inwardZ: number;
  halfLen: number;
} {
  const door = doorSegment(map.bounds, side);
  const d0 = door[0];
  const d1 = door[1];
  const mid = { x: (d0.x + d1.x) / 2, z: (d0.z + d1.z) / 2 };
  const halfLen = distance2(d1.x - d0.x, d1.z - d0.z) / 2;

  // Consistent world axes so opposite edges share the same "left/right" sense.
  let alongX = 0;
  let alongZ = 0;
  if (side.edge === "south" || side.edge === "north") {
    alongX = 1;
  } else {
    alongZ = 1;
  }

  const { minX, maxX, minZ, maxZ } = map.bounds;
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  let inwardX = cx - mid.x;
  let inwardZ = cz - mid.z;
  const ilen = distance2(inwardX, inwardZ) || 1;
  inwardX /= ilen;
  inwardZ /= ilen;

  return { mid, alongX, alongZ, inwardX, inwardZ, halfLen };
}

/**
 * Outer bounds clamp while doors are sealed: no walk-in pocket, and inside the
 * door gap strip push centers inward to {@link DOOR_CLOSED_STANDOFF} so bodies
 * don't clip the dark closed-door pane (perimeter leaves a hole at doors).
 */
function clampToBoundsWithClosedDoorStandoff(
  x: number,
  z: number,
  radius: number,
  map: DoorsMap,
): { x: number; z: number } {
  const { minX, maxX, minZ, maxZ } = map.bounds;
  let px = clamp(x, minX + radius, maxX - radius);
  let pz = clamp(z, minZ + radius, maxZ - radius);

  // Keep center at least this far into the map from the door plane.
  const minDepth = max(radius, DOOR_CLOSED_STANDOFF);

  for (let i = 0; i < 2; i++) {
    const side = i === 0 ? map.teamA : map.teamB;
    const frame = doorFrame(map, side);
    const along = (px - frame.mid.x) * frame.alongX +
      (pz - frame.mid.z) * frame.alongZ;
    const depth = (px - frame.mid.x) * frame.inwardX +
      (pz - frame.mid.z) * frame.inwardZ;
    const lat = doorWalkInCenterHalfWidth(frame.halfLen, radius);
    // Only the door mouth strip (not walls/corners beside the posts).
    if (abs(along) > lat + radius) continue;
    // Past the plane shouldn't happen after the bounds clamp; shallow depth is
    // the clip zone we care about.
    if (depth >= minDepth) continue;
    if (depth < -0.05) continue;

    const push = minDepth - depth;
    px += frame.inwardX * push;
    pz += frame.inwardZ * push;
  }

  return {
    x: clamp(px, minX + radius, maxX - radius),
    z: clamp(pz, minZ + radius, maxZ - radius),
  };
}

/**
 * Outer bounds clamp that allows a short pocket past the door plane inside
 * each door gap so players can walk into the portal before capturing.
 */
function clampToBoundsWithDoorWalkIn(
  x: number,
  z: number,
  radius: number,
  map: DoorsMap,
): { x: number; z: number } {
  const { minX, maxX, minZ, maxZ } = map.bounds;
  const halfLat = (side: TeamSide) => {
    const frame = doorFrame(map, side);
    return doorWalkInCenterHalfWidth(frame.halfLen, radius);
  };

  // Prefer the nearer door when near a capture lip.
  let best: {
    along: number;
    depth: number;
    halfLat: number;
    frame: ReturnType<typeof doorFrame>;
  } | null = null;
  let bestScore = Infinity;

  for (let i = 0; i < 2; i++) {
    const side = i === 0 ? map.teamA : map.teamB;
    const frame = doorFrame(map, side);
    const along = (x - frame.mid.x) * frame.alongX +
      (z - frame.mid.z) * frame.alongZ;
    const depth = (x - frame.mid.x) * frame.inwardX +
      (z - frame.mid.z) * frame.inwardZ;
    const lat = halfLat(side);
    // Near the door plane (inside or slightly past) and roughly in the gap.
    if (depth > DOOR_WALK_IN_NEAR_DEPTH || depth < -DOOR_WALK_IN - 0.2) {
      continue;
    }
    if (abs(along) > lat + radius) continue;
    const score = abs(depth) + max(0, abs(along) - lat) * 2;
    if (score < bestScore) {
      bestScore = score;
      best = { along, depth, halfLat: lat, frame };
    }
  }

  if (best) {
    const along = clamp(best.along, -best.halfLat, best.halfLat);
    // depth: positive into map; allow negative into the portal pocket.
    const depth = clamp(best.depth, -DOOR_WALK_IN, DOOR_WALK_IN_NEAR_DEPTH);
    // When still mostly inside the map, also respect the far-side bounds via
    // reconstructing only the door-local axes and hard-clamping the rest.
    let px = best.frame.mid.x + along * best.frame.alongX +
      depth * best.frame.inwardX;
    let pz = best.frame.mid.z + along * best.frame.alongZ +
      depth * best.frame.inwardZ;
    // The non-door axes stay in normal bounds (e.g. X when on a N/S door).
    if (best.frame.alongX !== 0) {
      // Door runs along X — free axis is X (already along-clamped); Z is depth.
      px = clamp(px, minX + radius, maxX - radius);
      // Z may sit past the plane; only clamp the *inward* extreme to map.
      if (best.frame.inwardZ > 0) {
        // South door: inward +Z → max Z is normal, min Z is walk-in.
        pz = clamp(pz, minZ - DOOR_WALK_IN, maxZ - radius);
      } else {
        // North door: inward −Z.
        pz = clamp(pz, minZ + radius, maxZ + DOOR_WALK_IN);
      }
    } else {
      // Door runs along Z — free axis is Z; X is depth.
      pz = clamp(pz, minZ + radius, maxZ - radius);
      if (best.frame.inwardX > 0) {
        // West door: inward +X.
        px = clamp(px, minX - DOOR_WALK_IN, maxX - radius);
      } else {
        // East door: inward −X.
        px = clamp(px, minX + radius, maxX + DOOR_WALK_IN);
      }
    }
    return { x: px, z: pz };
  }

  return {
    x: clamp(x, minX + radius, maxX - radius),
    z: clamp(z, minZ + radius, maxZ - radius),
  };
}

function addEdgeWithGap(
  out: Segment[],
  a: Vec2,
  b: Vec2,
  doors: [Vec2, Vec2][],
): void {
  // Collect door intervals projected onto the edge as t in [0,1]
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len2 = dx * dx + dz * dz;
  if (len2 < 1e-8) return;

  type Interval = { t0: number; t1: number };
  const gaps: Interval[] = [];

  for (let i = 0; i < doors.length; i++) {
    const door = doors[i]!;
    const d0 = door[0];
    const d1 = door[1];
    // Only if door is collinear / on this edge
    if (!pointOnEdge(d0, a, b) || !pointOnEdge(d1, a, b)) continue;
    let t0 = projectT(d0, a, b);
    let t1 = projectT(d1, a, b);
    if (t0 > t1) {
      const swap = t0;
      t0 = t1;
      t1 = swap;
    }
    // Door endpoints are post centerlines. The perimeter capsules end there;
    // their half-thickness closely matches the posts' visual half-width.
    if (t1 > t0) gaps.push({ t0, t1 });
  }

  if (gaps.length === 0) {
    out.push({
      a: copyVec2(a),
      b: copyVec2(b),
      yMin: 0,
      yMax: WALL_HEIGHT,
    });
    return;
  }

  gaps.sort((g, h) => g.t0 - h.t0);
  // Merge overlapping gaps
  const merged: Interval[] = [];
  for (let i = 0; i < gaps.length; i++) {
    const g = gaps[i]!;
    if (merged.length === 0) {
      merged.push({ t0: g.t0, t1: g.t1 });
    } else {
      const last = merged[merged.length - 1]!;
      if (g.t0 > last.t1) merged.push({ t0: g.t0, t1: g.t1 });
      else last.t1 = max(last.t1, g.t1);
    }
  }

  let cursor = 0;
  for (let i = 0; i < merged.length; i++) {
    const g = merged[i]!;
    if (g.t0 > cursor + 1e-4) {
      out.push({
        a: { x: a.x + dx * cursor, z: a.z + dz * cursor },
        b: { x: a.x + dx * g.t0, z: a.z + dz * g.t0 },
        yMin: 0,
        yMax: WALL_HEIGHT,
      });
    }
    cursor = g.t1;
  }
  if (cursor < 1 - 1e-4) {
    out.push({
      a: { x: a.x + dx * cursor, z: a.z + dz * cursor },
      b: { x: b.x, z: b.z },
      yMin: 0,
      yMax: WALL_HEIGHT,
    });
  }
}

/** Full walls and perimeter: floor → WALL_HEIGHT (not half / float). */
function isFullWallSegment(seg: Segment): boolean {
  return seg.yMin <= 1e-6 && abs(seg.yMax - WALL_HEIGHT) <= 1e-6;
}

/** Half-wall slab: floor → HALF_WALL_HEIGHT. */
function isHalfWallSegment(seg: Segment): boolean {
  return seg.yMin <= 1e-6 && abs(seg.yMax - HALF_WALL_HEIGHT) <= 1e-6;
}

/**
 * Shorten a segment by `inset` at each end. Returns null when the remaining
 * core length would be ≤ 0 (wall shorter than 2·inset).
 */
function segmentWithEndInset(
  a: Vec2,
  b: Vec2,
  inset: number,
): { a: Vec2; b: Vec2 } | null {
  if (!(inset > 0)) return { a: copyVec2(a), b: copyVec2(b) };
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = distance2(dx, dz);
  if (len < 2 * inset + 1e-6) return null;
  const ux = dx / len;
  const uz = dz / len;
  return {
    a: { x: a.x + ux * inset, z: a.z + uz * inset },
    b: { x: b.x - ux * inset, z: b.z - uz * inset },
  };
}

function pointOnEdge(p: Vec2, a: Vec2, b: Vec2, eps = 0.35): boolean {
  return distPointToSegment(p, a, b) <= eps;
}

function projectT(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const ab2 = abx * abx + abz * abz || 1;
  return clamp(((p.x - a.x) * abx + (p.z - a.z) * abz) / ab2, 0, 1);
}

function distPointToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const apx = p.x - a.x;
  const apz = p.z - a.z;
  const ab2 = abx * abx + abz * abz;
  if (ab2 < 1e-9) return distance2(apx, apz);
  const t = clamp((apx * abx + apz * abz) / ab2, 0, 1);
  return distance2(p.x - (a.x + abx * t), p.z - (a.z + abz * t));
}

function pushCircleFromSegment(
  px: number,
  pz: number,
  radius: number,
  a: Vec2,
  b: Vec2,
  halfThick: number,
): { x: number; z: number } {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const ab2 = abx * abx + abz * abz;
  if (ab2 < 1e-9) return { x: px, z: pz };

  const t = clamp(((px - a.x) * abx + (pz - a.z) * abz) / ab2, 0, 1);
  const qx = a.x + abx * t;
  const qz = a.z + abz * t;
  let nx = px - qx;
  let nz = pz - qz;
  let dist = distance2(nx, nz);
  const minDist = radius + halfThick;

  if (dist >= minDist) return { x: px, z: pz };

  if (dist < 1e-8) {
    // Centered on segment — push along a perpendicular
    const plen = distance2(abx, abz) || 1;
    nx = -abz / plen;
    nz = abx / plen;
    dist = 0;
  } else {
    nx /= dist;
    nz /= dist;
  }

  const push = minDist - dist;
  return { x: px + nx * push, z: pz + nz * push };
}

/**
 * Ray vs vertical wall slab (segment extruded by halfThick in XZ, yMin..yMax).
 * Returns entry distance along unit direction, or null.
 */
function rayThickSegment(
  origin: Vec3,
  dir: Vec3,
  maxRange: number,
  a: Vec2,
  b: Vec2,
  halfThick: number,
  yMin: number,
  yMax: number,
): number | null {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const segLen = distance2(abx, abz);
  if (segLen < 1e-8) return null;

  const ax = abx / segLen;
  const az = abz / segLen;
  // Perpendicular in XZ (right-handed with up = +Y).
  const px = -az;
  const pz = ax;

  const cx = (a.x + b.x) * 0.5;
  const cy = (yMin + yMax) * 0.5;
  const cz = (a.z + b.z) * 0.5;
  const halfLen = segLen * 0.5;
  const halfH = (yMax - yMin) * 0.5;

  // Ray into OBB local space (X=along, Y=up, Z=perp).
  const ox = origin.x - cx;
  const oy = origin.y - cy;
  const oz = origin.z - cz;
  const rox = ox * ax + oz * az;
  const roy = oy;
  const roz = ox * px + oz * pz;
  const rdx = dir.x * ax + dir.z * az;
  const rdy = dir.y;
  const rdz = dir.x * px + dir.z * pz;

  return rayAabbLocal(
    rox,
    roy,
    roz,
    rdx,
    rdy,
    rdz,
    halfLen,
    halfH,
    halfThick,
    maxRange,
  );
}

/** Slab-method ray vs AABB centered at origin with given half-extents. */
function rayAabbLocal(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  hx: number,
  hy: number,
  hz: number,
  maxRange: number,
): number | null {
  let tmin = 0;
  let tmax = maxRange;

  for (let axis = 0; axis < 3; axis++) {
    const o = axis === 0 ? ox : axis === 1 ? oy : oz;
    const d = axis === 0 ? dx : axis === 1 ? dy : dz;
    const h = axis === 0 ? hx : axis === 1 ? hy : hz;
    if (abs(d) < 1e-12) {
      if (o < -h || o > h) return null;
      continue;
    }
    let t1 = (-h - o) / d;
    let t2 = (h - o) / d;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }

  // Inside the volume → block immediately (t = 0).
  if (tmax < 0) return null;
  const t = tmin < 0 ? 0 : tmin;
  if (t > maxRange) return null;
  return t;
}

/** True when resolvePosition left the sample near the requested point. */
function probeReachable(
  wantX: number,
  wantZ: number,
  gotX: number,
  gotZ: number,
  eps = 0.08,
): boolean {
  return distance2(gotX - wantX, gotZ - wantZ) <= eps;
}

/** Walkable half-width for a player center between the rendered door posts. */
function doorWalkInCenterHalfWidth(
  doorHalfWidth: number,
  playerRadius: number,
): number {
  return max(
    0.05,
    doorHalfWidth - DOOR_POST_WIDTH * 0.5 - playerRadius,
  );
}
