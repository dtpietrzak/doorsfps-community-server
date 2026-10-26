/**
 * Dwell anti-stick (B1): if a bot sits near the same sticky yaw-pole or door-
 * camp plant for too long **without combat**, force a replan and ban that
 * key so paths stop freezing on door belly cells.
 *
 * Pure helpers + bag fields — O(1) per think. Wired from the yawPole step.
 */

import { msToTicks } from "../../shared/network.ts";
import { max } from "../../math/index.ts";
import { UNSET, type BotBrainState } from "../../types.ts";
import {
  isYawPoleArrived,
  yawPoleKey,
  type YawPolePoint,
} from "../../../../shared/world/yawPole.ts";
import { writeStickyYawPole } from "../yawPole/helpers/stickyBag.ts";

/** How long feet may linger near a sticky target / plant without combat. */
export const YAW_POLE_DWELL_MS = 3200;

/** Door-camp plant linger before forced re-plant / leave. */
export const CAMP_PLANT_DWELL_MS = 4500;

/**
 * "Near enough" to count as dwelling (larger than skip/arrive so we catch
 * bots shimmying on the cell, not only dead-center plant).
 */
export const YAW_POLE_DWELL_NEAR_RADIUS = 2.25;

/** Ban duration as other-pole clear counts (same units as ping-pong ignore). */
export const YAW_POLE_DWELL_BAN_CLEARS = 3;

/** After breaking a camp plant, force hunt this long so we don't re-plant. */
export const CAMP_DWELL_FORCE_HUNT_MS = 4000;

export const YAW_POLE_DWELL_MS_TICKS = msToTicks(YAW_POLE_DWELL_MS);
export const CAMP_PLANT_DWELL_MS_TICKS = msToTicks(CAMP_PLANT_DWELL_MS);
export const CAMP_DWELL_FORCE_HUNT_TICKS = msToTicks(CAMP_DWELL_FORCE_HUNT_MS);

/** Bag: pole/plant key currently being timed. */
export const DWELL_KEY = "dwellBreakKey" as const;
/** Bag: sim tick when dwell near `DWELL_KEY` started. */
export const DWELL_SINCE_TICK_KEY = "dwellBreakSinceTick" as const;
/** Bag: while tick &lt; this, navMode treats camper as hunter. */
export const DWELL_FORCE_HUNT_UNTIL_TICK_KEY =
  "dwellForceHuntUntilTick" as const;

export type DwellBreakBag = BotBrainState;

export type DwellBreakInput = {
  x: number;
  z: number;
  tick: number;
  /** True when combat-locked (any hostile lock this/last think). */
  inCombat: boolean;
  sticky: YawPolePoint | null | undefined;
  /** Planted door camp (arrived). */
  campPlant: YawPolePoint | null | undefined;
  campArrived: boolean;
  nearRadius?: number;
  stickyDwellTicks?: number;
  campDwellTicks?: number;
};

export type DwellBreakResult = {
  /** Ban this key and force replan. */
  breakKey: string | null;
  /** Clear sticky lock. */
  clearSticky: boolean;
  /** Clear door-camp plant so nav re-picks. */
  clearCampPlant: boolean;
  /** Updated dwell key (null = clear). */
  dwellKey: string | null;
  dwellSinceTick: number | null;
};

function dist2(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}

function isNear(
  x: number,
  z: number,
  p: YawPolePoint,
  radius: number,
): boolean {
  return dist2(x, z, p.x, p.z) <= radius * radius;
}

/**
 * Choose the dwell anchor for this think: sticky if near it, else camp plant
 * if arrived and near it. Prefer sticky when both apply.
 */
export function resolveDwellAnchor(input: {
  x: number;
  z: number;
  sticky: YawPolePoint | null | undefined;
  campPlant: YawPolePoint | null | undefined;
  campArrived: boolean;
  nearRadius?: number;
}): { kind: "sticky" | "camp"; point: YawPolePoint; key: string } | null {
  const r = input.nearRadius ?? YAW_POLE_DWELL_NEAR_RADIUS;
  const sticky = input.sticky;
  if (
    sticky &&
    Number.isFinite(sticky.x) &&
    Number.isFinite(sticky.z) &&
    isNear(input.x, input.z, sticky, r)
  ) {
    return {
      kind: "sticky",
      point: sticky,
      key: yawPoleKey(sticky.x, sticky.z),
    };
  }
  const plant = input.campPlant;
  if (
    input.campArrived &&
    plant &&
    Number.isFinite(plant.x) &&
    Number.isFinite(plant.z) &&
    isNear(input.x, input.z, plant, r)
  ) {
    return {
      kind: "camp",
      point: plant,
      key: yawPoleKey(plant.x, plant.z),
    };
  }
  return null;
}

/**
 * Pure dwell step: update timers and decide whether to break.
 * Does not mutate bag — caller applies result.
 */
export function stepDwellBreak(
  bag: Readonly<DwellBreakBag>,
  input: DwellBreakInput,
): DwellBreakResult {
  const stickyTicks = input.stickyDwellTicks ?? YAW_POLE_DWELL_MS_TICKS;
  const campTicks = input.campDwellTicks ?? CAMP_PLANT_DWELL_MS_TICKS;
  const nearR = input.nearRadius ?? YAW_POLE_DWELL_NEAR_RADIUS;

  const anchor = resolveDwellAnchor({
    x: input.x,
    z: input.z,
    sticky: input.sticky,
    campPlant: input.campPlant,
    campArrived: input.campArrived,
    nearRadius: nearR,
  });

  // Not lingering / combat → reset timer, no break.
  if (!anchor || input.inCombat) {
    return {
      breakKey: null,
      clearSticky: false,
      clearCampPlant: false,
      dwellKey: null,
      dwellSinceTick: null,
    };
  }

  const storedKey = bag.dwellBreakKey;
  const prevKey = storedKey.length > 0 ? storedKey : null;
  const prevSince = Number.isFinite(bag.dwellBreakSinceTick)
    ? bag.dwellBreakSinceTick
    : null;

  let since = prevSince;
  if (prevKey !== anchor.key || since === null) {
    since = input.tick;
  }

  const limit = anchor.kind === "camp" ? campTicks : stickyTicks;
  const elapsed = input.tick - since;
  if (elapsed >= limit) {
    return {
      breakKey: anchor.key,
      clearSticky: true,
      clearCampPlant: anchor.kind === "camp",
      dwellKey: null,
      dwellSinceTick: null,
    };
  }

  return {
    breakKey: null,
    clearSticky: false,
    clearCampPlant: false,
    dwellKey: anchor.key,
    dwellSinceTick: since,
  };
}

/**
 * Apply a break: ban key on ignore map, clear sticky, optionally clear camp.
 * Mutates `bag`.
 */
export function applyDwellBreak(
  bag: DwellBreakBag,
  result: DwellBreakResult,
  opts?: {
    banClears?: number;
    /** Current sim tick — required to schedule force-hunt after camp break. */
    tick?: number;
    forceHuntTicks?: number;
  },
): void {
  const banClears = opts?.banClears ?? YAW_POLE_DWELL_BAN_CLEARS;

  if (result.dwellKey === null) {
    bag.dwellBreakKey = "";
    bag.dwellBreakSinceTick = UNSET;
  } else {
    bag.dwellBreakKey = result.dwellKey;
    bag.dwellBreakSinceTick = result.dwellSinceTick ?? 0;
  }

  if (!result.breakKey) return;

  const ignore: Record<string, number> = {};
  const ignoreKeys = Object.keys(bag.yawPoleIgnore);
  if (ignoreKeys.length > 0) {
    for (let i = 0; i < ignoreKeys.length; i += 1) {
      const key = ignoreKeys[i]!;
      const rem = bag.yawPoleIgnore[key];
      if (typeof rem === "number" && Number.isFinite(rem) && rem > 0) {
        ignore[key] = rem;
      }
    }
  }
  ignore[result.breakKey] = max(
    ignore[result.breakKey] ?? 0,
    banClears,
  );
  bag.yawPoleIgnore = ignore;

  if (result.clearSticky) {
    writeStickyYawPole(bag, null);
  }
  if (result.clearCampPlant) {
    bag.doorCampPlantX = UNSET;
    bag.doorCampPlantZ = UNSET;
    bag.doorCampWantLip = false;
    bag.doorCampActive = false;
    const tick = opts?.tick;
    if (typeof tick === "number" && Number.isFinite(tick)) {
      const huntTicks = opts?.forceHuntTicks ?? CAMP_DWELL_FORCE_HUNT_TICKS;
      bag.dwellForceHuntUntilTick = tick + huntTicks;
    }
  }
  bag.dwellBreakKey = "";
  bag.dwellBreakSinceTick = UNSET;
}

/** True when camp dwell-break is still suppressing re-plant. */
export function isDwellForceHuntActive(
  bag: Readonly<DwellBreakBag>,
  tick: number,
): boolean {
  const until = bag.dwellForceHuntUntilTick;
  return typeof until === "number" && Number.isFinite(until) && tick < until;
}

/** True when feet are still on a just-broken / banned plant (tests / debug). */
export function isDwellingNearPoint(
  x: number,
  z: number,
  point: YawPolePoint,
  radius: number = YAW_POLE_DWELL_NEAR_RADIUS,
): boolean {
  return isNear(x, z, point, radius);
}

export { isYawPoleArrived };
