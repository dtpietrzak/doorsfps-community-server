/**
 * Hardcoded zombots window-crawl traversal.
 *
 * When a zombie approaches a window on a zombots map, it switches from normal
 * walk locomotion into a deterministic, fixed-duration window-crawl state using
 * one of three hardcoded crawl animations (variants 1, 2, 3), moves along a
 * scripted path across the sill, and returns to normal standing locomotion on
 * the inside (player side) of the window.
 *
 * Pure and deterministic: shared by server `Player.update`, bot sim harnesses,
 * and client remote animation timing.
 */

import { abs, clamp01, normalize2 } from "../math/index.ts";
import { TICK_HZ } from "../sim/game.ts";
import { MOVE_STAND_EYE } from "../sim/moveStep.ts";
import { WINDOW_SILL_Y } from "../world/wallWindows.ts";
import { yawFromWorldDir } from "../world/yawPole.ts";
import { zombotsLayout, type ZombotsLayoutMap } from "./zombotsLayout.ts";

/** Number of distinct hardcoded window-crawl animations. */
export const WINDOW_CRAWL_VARIANT_COUNT = 3;

/** Wire/state identifier for the three hardcoded crawl animations. */
export type WindowCrawlVariant = 1 | 2 | 3;

/** Fixed animation duration (seconds). */
export const WINDOW_CRAWL_SECONDS = 1.4;

/** Fixed animation duration in 60 Hz simulation ticks. */
export const WINDOW_CRAWL_TICKS = Math.round(WINDOW_CRAWL_SECONDS * TICK_HZ);

/** Minimum signed depth on the approach side to trigger a crawl (m). */
export const WINDOW_CRAWL_TRIGGER_MIN_DEPTH = 0.05;

/** Maximum signed depth on the approach side to trigger a crawl (m). */
export const WINDOW_CRAWL_TRIGGER_MAX_DEPTH = 1.35;

/** Max sideways offset from window center to start crawling (m). */
export const WINDOW_CRAWL_TRIGGER_LATERAL = 0.62;

/** Minimum dot product of movement intent toward the window opening. */
export const WINDOW_CRAWL_TRIGGER_DOT = 0.25;

/** Landing distance past the wall center on the inside / player side (m). */
export const WINDOW_CRAWL_EXIT_DEPTH = 1.05;

/** Distance off the wall center to probe which side is the zombie closure. */
const SIDE_PROBE = 1.1;

/** One window opening a zombie may crawl through. */
export type WindowCrawlPortal = {
  windowId: string;
  centerX: number;
  centerZ: number;
  /** Unit normal pointing into the outside / zombie side. */
  outX: number;
  outZ: number;
  /**
   * True only on synthetic zombots test maps without a full 3-phase closure
   * layout, allowing approach from either side of the wall.
   */
  twoWay: boolean;
};

/** Active scripted window-crawl state on a zombie body. */
export type WindowCrawlState = {
  variant: WindowCrawlVariant;
  /** Elapsed sim ticks since the crawl began (0 .. WINDOW_CRAWL_TICKS). */
  tick: number;
  startX: number;
  startZ: number;
  centerX: number;
  centerZ: number;
  endX: number;
  endZ: number;
  /** Facing yaw straight through the window into the inside room. */
  yaw: number;
};

/** Pose produced for one point along the hardcoded crawl path. */
export type WindowCrawlPose = {
  x: number;
  /** Eye Y (standing eye height + vertical sill lift). */
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  /** Feet height above the floor (0 at start and end). */
  feetLift: number;
  onGround: boolean;
};

export type WindowCrawlMap = ZombotsLayoutMap & {
  mirrorMode?: string;
};

/**
 * Extract crawlable window portals for a zombots map.
 * Returns empty on non-zombots maps.
 */
export function buildWindowCrawlPortals(
  map: WindowCrawlMap,
): WindowCrawlPortal[] {
  if (map.mirrorMode !== "zombots") return [];
  const windows = map.windows ?? [];
  if (windows.length === 0) return [];

  const layout = zombotsLayout(map);
  const portals: WindowCrawlPortal[] = [];

  if (layout.windowLinks.length > 0) {
    for (let i = 0; i < layout.windowLinks.length; i++) {
      const link = layout.windowLinks[i]!;
      const win = windows.find((w) => w.id === link.windowId);
      if (!win) continue;
      const wall = map.walls.find((w) => w.id === win.wallId);
      if (!wall) continue;
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
      portals.push({
        windowId: win.id,
        centerX: win.center.x,
        centerZ: win.center.z,
        outX,
        outZ,
        twoWay: false,
      });
    }
    return portals;
  }

  // Fallback for synthetic zombots maps without full 3-phase closures.
  for (let i = 0; i < windows.length; i++) {
    const win = windows[i]!;
    const wall = map.walls.find((w) => w.id === win.wallId);
    if (!wall) continue;
    const dir = normalize2(wall.b.x - wall.a.x, wall.b.z - wall.a.z);
    if (dir.length < 1e-6) continue;
    portals.push({
      windowId: win.id,
      centerX: win.center.x,
      centerZ: win.center.z,
      outX: -dir.z,
      outZ: dir.x,
      twoWay: true,
    });
  }
  return portals;
}

/** Deterministic variant selector (1, 2, or 3) from entity id, tick, and window id. */
export function pickWindowCrawlVariant(
  entityId: string,
  tick: number,
  windowId: string,
): WindowCrawlVariant {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < entityId.length; i++) {
    h ^= entityId.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  h ^= (tick | 0) >>> 0;
  h = Math.imul(h, 16777619) >>> 0;
  for (let i = 0; i < windowId.length; i++) {
    h ^= windowId.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return ((h % WINDOW_CRAWL_VARIANT_COUNT) + 1) as WindowCrawlVariant;
}

/**
 * Check whether a zombie at `pos` moving along unit `wishDir` should switch
 * into a window crawl. Returns the initialized crawl state or null.
 */
export function tryStartWindowCrawl(
  portals: readonly WindowCrawlPortal[],
  pos: { x: number; z: number },
  wishDir: { x: number; z: number } | null,
  entityId: string,
  tick: number,
): WindowCrawlState | null {
  if (portals.length === 0 || wishDir === null) return null;
  let bestPortal: WindowCrawlPortal | null = null;
  let bestOutX = 0;
  let bestOutZ = 0;
  let bestScore = Infinity;

  for (let i = 0; i < portals.length; i++) {
    const p = portals[i]!;
    const dx = pos.x - p.centerX;
    const dz = pos.z - p.centerZ;
    let outX = p.outX;
    let outZ = p.outZ;
    let depth = dx * outX + dz * outZ;
    if (p.twoWay && depth < 0) {
      outX = -outX;
      outZ = -outZ;
      depth = -depth;
    }
    if (
      depth < WINDOW_CRAWL_TRIGGER_MIN_DEPTH ||
      depth > WINDOW_CRAWL_TRIGGER_MAX_DEPTH
    ) {
      continue;
    }
    const lateral = abs(dx * -outZ + dz * outX);
    if (lateral > WINDOW_CRAWL_TRIGGER_LATERAL) continue;

    // Must be pushing into the window (opposite the outside normal).
    const intoDot = -(wishDir.x * outX + wishDir.z * outZ);
    if (intoDot < WINDOW_CRAWL_TRIGGER_DOT) continue;

    const score = depth + lateral;
    if (score < bestScore) {
      bestScore = score;
      bestPortal = p;
      bestOutX = outX;
      bestOutZ = outZ;
    }
  }

  if (bestPortal === null) return null;
  const inX = -bestOutX;
  const inZ = -bestOutZ;
  return {
    variant: pickWindowCrawlVariant(entityId, tick, bestPortal.windowId),
    tick: 0,
    startX: pos.x,
    startZ: pos.z,
    centerX: bestPortal.centerX,
    centerZ: bestPortal.centerZ,
    endX: bestPortal.centerX + inX * WINDOW_CRAWL_EXIT_DEPTH,
    endZ: bestPortal.centerZ + inZ * WINDOW_CRAWL_EXIT_DEPTH,
    yaw: yawFromWorldDir(inX, inZ) ?? 0,
  };
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * Sample the hardcoded world pose along a window crawl at progress `u` in [0, 1].
 *
 * Staged in three physical phases so the body never clips the 0.9 m sill:
 *  1. Hoist (0 → 0.24): align with window center outside the wall while lifting
 *     onto sill height.
 *  2. Crawl (0.24 → 0.78): pull horizontally across the sill with the waist
 *     held above `WINDOW_SILL_Y` so the belly rests on top of the sill.
 *  3. Drop  (0.78 → 1.00): clear the inside wall face and step down to floor.
 */
export function sampleWindowCrawlPose(
  crawl: Readonly<WindowCrawlState>,
  progress: number,
): WindowCrawlPose {
  const u = clamp01(progress);

  // Unit inward vector (center → end).
  const toEndX = crawl.endX - crawl.centerX;
  const toEndZ = crawl.endZ - crawl.centerZ;
  const endLen = Math.sqrt(toEndX * toEndX + toEndZ * toEndZ);
  const invEndLen = endLen > 1e-6 ? 1 / endLen : 0;
  const inX = endLen > 1e-6 ? toEndX * invEndLen : 0;
  const inZ = endLen > 1e-6 ? toEndZ * invEndLen : -1;

  // Outside sill-grab point (+0.58 m outside wall) and inside drop-off point (-0.58 m inside wall).
  const sillHold = 0.58;
  const grabX = crawl.centerX - inX * sillHold;
  const grabZ = crawl.centerZ - inZ * sillHold;
  const dropX = crawl.centerX + inX * sillHold;
  const dropZ = crawl.centerZ + inZ * sillHold;

  let x: number;
  let z: number;
  if (u < 0.24) {
    // Phase 1: step/align from start to the outside sill-grab point.
    const t = smoothstep(0, 0.24, u);
    x = crawl.startX + (grabX - crawl.startX) * t;
    z = crawl.startZ + (grabZ - crawl.startZ) * t;
  } else if (u < 0.78) {
    // Phase 2: crawl horizontally across the sill (variant-specific pacing).
    const raw = (u - 0.24) / (0.78 - 0.24);
    let t: number;
    if (crawl.variant === 1) {
      t = smoothstep(0, 1, raw);
    } else if (crawl.variant === 2) {
      // Side-roll: brief pause at sill edge, brisk roll across.
      t = raw < 0.45
        ? 0.45 * smoothstep(0, 0.45, raw)
        : 0.45 + 0.55 * smoothstep(0.45, 1, raw);
    } else {
      // Headfirst lunge: surges over the sill early.
      const dive = 1 - (1 - raw) * (1 - raw);
      t = 0.55 * smoothstep(0, 1, raw) + 0.45 * dive;
    }
    x = grabX + (dropX - grabX) * t;
    z = grabZ + (dropZ - grabZ) * t;
  } else {
    // Phase 3: drop off the sill onto the inside floor.
    const t = smoothstep(0.78, 1, u);
    x = dropX + (crawl.endX - dropX) * t;
    z = dropZ + (crawl.endZ - dropZ) * t;
  }

  // Lift feet smoothly so the horizontal waist (SPINE_PIVOT_Y ≈ 0.72 m above
  // feet) rides right on top of the 0.90 m sill (belly underside ≈ 1.0 m).
  const up = smoothstep(0.05, 0.24, u);
  const down = 1 - smoothstep(0.76, 0.96, u);
  const peakLift = crawl.variant === 3
    ? WINDOW_SILL_Y * 0.54
    : crawl.variant === 2
    ? WINDOW_SILL_Y * 0.50
    : WINDOW_SILL_Y * 0.48;
  const feetLift = up * down * peakLift;

  return {
    x,
    y: MOVE_STAND_EYE + feetLift,
    z,
    yaw: crawl.yaw,
    pitch: 0,
    feetLift,
    onGround: feetLift < 0.02,
  };
}

/**
 * Advance an active crawl by one simulation tick.
 * Mutates `crawl.tick` in place and returns the sampled pose and completion flag.
 */
export function stepWindowCrawl(
  crawl: WindowCrawlState,
): { done: boolean; progress: number; pose: WindowCrawlPose } {
  crawl.tick = Math.min(WINDOW_CRAWL_TICKS, crawl.tick + 1);
  const progress = crawl.tick / WINDOW_CRAWL_TICKS;
  const done = crawl.tick >= WINDOW_CRAWL_TICKS;
  const pose = sampleWindowCrawlPose(crawl, done ? 1 : progress);
  return { done, progress: done ? 1 : progress, pose };
}

/** Deep-copy a crawl state for checkpoint save/restore. */
export function cloneWindowCrawlState(
  crawl: Readonly<WindowCrawlState> | null,
): WindowCrawlState | null {
  return crawl === null ? null : { ...crawl };
}
