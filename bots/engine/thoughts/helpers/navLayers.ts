/**
 * Nav-layer helpers for the bot think pipe:
 *   navMode → navGoal → yawPole → pathHeading → doorCampLook → yawIntent
 *
 * Separates **mode**, **always-defined goal**, **corner poles**, **raw heading**,
 * and the post-target look motor so behavior is not crammed into yawIntent.
 */

import type { DoorsMap } from "../../shared/map.ts";
import type { TeamId } from "../../shared/network.ts";
import { TICK_HZ } from "../../shared/network.ts";
import {
  collectEnemyDoorCampClaims,
  doorCampLookYaw,
  doorCampOwnDoorYaw,
  doorCampYawSignedDelta,
  isAtDoorCampPlant,
  pickEnemyDoorCampPlant,
  rollCampLookHoldSec,
  shortestArcPassesNear,
  wantsEnemyDoorCamp,
  wantsLipDoorCamp,
} from "./doorCamp.ts";
import {
  botLateralBias,
  CAMP_MAX_DOOR_DIST,
  enemyDoorTarget,
  pickCoverDoorCamp,
} from "../../helpers/nav.ts";
import {
  hasDoorCampPlant,
  UNSET,
  type BotBrainState,
  type BotWorldView,
} from "../../types.ts";
import {
  clearStickyYawPole,
  enemyDoorMidpoint,
  HUNT_DOOR_BIAS_FLIP_RADIUS,
  ownDoorMidpoint,
  yawPoleMapCenter,
  type YawPolePoint,
} from "../yawPole/helpers/yawPole.ts";
import { isDwellForceHuntActive } from "./dwellBreak.ts";
import type { MapCollision } from "../../world/MapCollision.ts";
import { abs, distance2, max, round } from "../../math/index.ts";

// ── Types ──────────────────────────────────────────────────────────────────

/** High-level navigation mode while thinking. */
export type NavMode = "path" | "hunt" | "doorCamp";

/** Brain-bag fields for doors-closed agent hunt + enemy-door camp. */
export type HuntBrainState = BotBrainState;

export type NavModeDecision = {
  mode: NavMode;
  /** True when mode/spawn forced a pole-noise re-roll this think. */
  forceNoiseReroll: boolean;
};

export type NavGoalDecision = {
  mode: NavMode;
  /**
   * Always-defined XZ the bot is pursuing this think.
   * path: enemy door mid
   * hunt: live preferred class → last known → map center
   * doorCamp: plant XZ
   */
  goal: YawPolePoint;
  /** Hunt doorDist oscillation mid (own/enemy); null otherwise. */
  doorDistPoint: YawPolePoint | null;
  /** Camp plant arrived this think. */
  campArrived: boolean;
  forceNoiseReroll: boolean;
};

export type YawPoleNavDecision = {
  mode: NavMode;
  goal: YawPolePoint;
  campArrived: boolean;
  /**
   * Sticky wall/door pole while pathing (path, hunt, doorCamp travel), or
   * camp plant as sole target once doorCamp has arrived.
   */
  target: YawPolePoint | null;
  next: YawPolePoint | null;
};

export type HeadingDecision = {
  mode: NavMode;
  goal: YawPolePoint;
  campArrived: boolean;
  target: YawPolePoint | null;
  next: YawPolePoint | null;
  /** Unfiltered look command this think. */
  rawLook: number;
  /** World move heading (corner outside + pathStrafe). */
  moveYaw: number;
  /** Timed authored Nudge input; applied as literal A/D without steering yaw. */
  nudgeDir: "left" | "right" | "none";
};

// ── Bag clear ──────────────────────────────────────────────────────────────

export function clearDoorCampState(bag: HuntBrainState): void {
  bag.doorCampActive = false;
  bag.doorCampPlantX = UNSET;
  bag.doorCampPlantZ = UNSET;
  bag.doorCampWantLip = false;
  bag.doorCampLookIndex = 0;
  bag.doorCampViaOwn = false;
  bag.doorCampNextSwitchAt = UNSET;
}

export function clearHuntState(bag: HuntBrainState): void {
  bag.huntActive = false;
  bag.huntDoorBias = "";
  bag.huntDoorBiasDist = UNSET;
  bag.huntLastAgentX = UNSET;
  bag.huntLastAgentZ = UNSET;
}

// ── Hunt goal / door bias ──────────────────────────────────────────────────

/**
 * Nearest living hunt-goal XZ, or null.
 * - Team hunters (`preferAgents`): living greys.
 * - Grey agents: living non-agents (humans + team bots).
 */
export function nearestHuntGoalFrom(
  selfX: number,
  selfZ: number,
  players: BotWorldView["players"],
  selfId: string,
  preferAgents: boolean,
): YawPolePoint | null {
  let best: YawPolePoint | null = null;
  let bestD2 = Infinity;
  for (const p of players) {
    if (!p.alive || p.id === selfId) continue;
    if (preferAgents ? !p.isAgent : p.isAgent) continue;
    const dx = p.x - selfX;
    const dz = p.z - selfZ;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = { x: p.x, z: p.z };
    }
  }
  return best;
}

/**
 * Hunt goal: nearest preferred class → last known → map center.
 * Team hunters seek greys; grey agents seek non-agents.
 * When {@link opts.liveGoal} is provided (including null), skips the players scan.
 */
export function resolveHuntGoalPoint(
  selfX: number,
  selfZ: number,
  players: BotWorldView["players"],
  selfId: string,
  map: BotWorldView["map"],
  last: { x?: number; z?: number },
  opts?: {
    isGreyAgent?: boolean;
    /** Precomputed live hunt goal; null = none living. */
    liveGoal?: YawPolePoint | null;
  },
): { goal: YawPolePoint; lastX?: number; lastZ?: number } {
  const preferAgents = !opts?.isGreyAgent;
  const live = opts?.liveGoal !== undefined
    ? opts.liveGoal
    : nearestHuntGoalFrom(
      selfX,
      selfZ,
      players,
      selfId,
      preferAgents,
    );
  if (live) {
    return { goal: live, lastX: live.x, lastZ: live.z };
  }
  if (
    typeof last.x === "number" &&
    Number.isFinite(last.x) &&
    typeof last.z === "number" &&
    Number.isFinite(last.z)
  ) {
    return { goal: { x: last.x, z: last.z }, lastX: last.x, lastZ: last.z };
  }
  return { goal: yawPoleMapCenter(map) };
}

export function doorBiasMidpoint(
  map: BotWorldView["map"],
  team: "A" | "B",
  bias: "own" | "enemy",
): YawPolePoint | null {
  return bias === "own"
    ? ownDoorMidpoint(map, team)
    : enemyDoorMidpoint(map, team);
}

/**
 * Flip own↔enemy when **entering** the flip radius of the current bias door
 * (prev dist was outside / unknown, now inside). Avoids thrashing on the lip.
 */
export function stepHuntDoorBias(
  x: number,
  z: number,
  map: BotWorldView["map"],
  team: "A" | "B",
  bias: "own" | "enemy",
  prevDist: number | undefined,
): { bias: "own" | "enemy"; dist: number | undefined } {
  const mid = doorBiasMidpoint(map, team, bias);
  if (!mid) return { bias, dist: prevDist };
  const d = distance2(x - mid.x, z - mid.z);
  const wasOutside = typeof prevDist !== "number" ||
    !Number.isFinite(prevDist) ||
    prevDist > HUNT_DOOR_BIAS_FLIP_RADIUS;
  if (wasOutside && d <= HUNT_DOOR_BIAS_FLIP_RADIUS) {
    const next: "own" | "enemy" = bias === "own" ? "enemy" : "own";
    // Track dist to the *new* bias door so we don't immediately re-flip.
    const nextMid = doorBiasMidpoint(map, team, next);
    const nextD = nextMid ? distance2(x - nextMid.x, z - nextMid.z) : undefined;
    return { bias: next, dist: nextD };
  }
  return { bias, dist: d };
}

// ── navMode ────────────────────────────────────────────────────────────────

export type StepNavModeArgs = {
  doorsOpen: boolean;
  isGreyAgent: boolean;
  agentAggression: number;
  bag: HuntBrainState;
  rng: () => number;
  /**
   * Sim tick for dwell-break force-hunt window (camp plant anti-stick).
   * Omit → no force-hunt check.
   */
  tick?: number;
};

/**
 * Latch path | hunt | doorCamp from doors + personality.
 * Mutates bag hunt/camp flags and sticky on mode edges.
 * Team hunters roll initial doorDist bias with `rng`.
 */
export function stepNavMode(args: StepNavModeArgs): NavModeDecision {
  const { doorsOpen, isGreyAgent, agentAggression, bag, rng, tick } = args;
  const prevDoorsOpen = bag.huntDoorsOpen;
  // Dwell-break after long camp plant: temporarily hunt instead of re-plant.
  const forceHunt = typeof tick === "number" &&
    isDwellForceHuntActive(bag, tick);
  const preferCamp = !isGreyAgent && !forceHunt &&
    wantsEnemyDoorCamp(agentAggression);
  const canClosedMode = !doorsOpen;

  let huntActive = Boolean(bag.huntActive) && canClosedMode && !preferCamp;
  let doorCampActive = Boolean(bag.doorCampActive) && canClosedMode &&
    preferCamp;
  let huntDoorBias: "own" | "enemy" = bag.huntDoorBias === "enemy"
    ? "enemy"
    : "own";
  let forceNoiseReroll = false;

  const initialHuntBias = (): "own" | "enemy" =>
    isGreyAgent ? "enemy" : rng() < 0.5 ? "own" : "enemy";

  const enterClosedMode = () => {
    if (preferCamp) {
      doorCampActive = true;
      huntActive = false;
      huntDoorBias = "own";
      clearHuntState(bag);
      clearDoorCampState(bag);
    } else {
      doorCampActive = false;
      huntActive = true;
      huntDoorBias = initialHuntBias();
      clearDoorCampState(bag);
      bag.huntDoorBias = huntDoorBias;
      bag.huntActive = true;
    }
    forceNoiseReroll = true;
    clearStickyYawPole(bag);
  };

  if (bag.huntDoorsSampled) {
    if (prevDoorsOpen && !doorsOpen) {
      enterClosedMode();
    } else if (!prevDoorsOpen && doorsOpen) {
      huntActive = false;
      doorCampActive = false;
      huntDoorBias = "own";
      clearDoorCampState(bag);
      clearHuntState(bag);
      forceNoiseReroll = true;
      clearStickyYawPole(bag);
    }
  } else if (!doorsOpen) {
    // First think already closed — enter without waiting for edge.
    if (preferCamp) {
      doorCampActive = true;
      huntActive = false;
      if (!hasDoorCampPlant(bag)) {
        bag.doorCampPlantX = UNSET;
        bag.doorCampPlantZ = UNSET;
      }
    } else {
      doorCampActive = false;
      huntActive = true;
      if (bag.huntDoorBias !== "own" && bag.huntDoorBias !== "enemy") {
        huntDoorBias = initialHuntBias();
      }
    }
    forceNoiseReroll = !bag.yawPoleNoiseReady;
    if (forceNoiseReroll) clearStickyYawPole(bag);
  }

  // Camp dwell-break: leave plant and hunt until force-hunt window ends.
  if (forceHunt && canClosedMode) {
    doorCampActive = false;
    huntActive = true;
    if (bag.huntDoorBias !== "own" && bag.huntDoorBias !== "enemy") {
      huntDoorBias = initialHuntBias();
    }
    clearDoorCampState(bag);
  }

  if (doorsOpen) {
    huntActive = false;
    doorCampActive = false;
  }
  if (doorCampActive) huntActive = false;
  if (huntActive) doorCampActive = false;

  // Write mode flags onto bag for downstream readers (targetEnemy, navigate).
  bag.huntDoorsOpen = doorsOpen;
  bag.huntDoorsSampled = true;
  if (doorCampActive) {
    bag.doorCampActive = true;
    clearHuntState(bag);
  } else if (huntActive) {
    bag.huntActive = true;
    bag.huntDoorBias = huntDoorBias;
    clearDoorCampState(bag);
  } else {
    clearHuntState(bag);
    clearDoorCampState(bag);
  }

  const mode: NavMode = doorCampActive
    ? "doorCamp"
    : huntActive
    ? "hunt"
    : "path";

  return { mode, forceNoiseReroll };
}

// ── navGoal ────────────────────────────────────────────────────────────────

export type StepNavGoalArgs = {
  mode: NavMode;
  forceNoiseReroll: boolean;
  selfX: number;
  selfZ: number;
  selfId: string;
  team: TeamId;
  isGreyAgent: boolean;
  map: DoorsMap;
  players: BotWorldView["players"];
  collision: MapCollision | null | undefined;
  bag: HuntBrainState;
  rng: () => number;
  /** Precomputed enemy door mid (path goal); omit to call enemyDoorTarget. */
  enemyDoor?: { x: number; z: number } | null;
  /**
   * Precomputed nearest hunt-class pose (no LOS). When set, skips
   * {@link nearestHuntGoalFrom} inside resolveHuntGoalPoint.
   */
  nearestHuntGoal?: { x: number; z: number } | null;
  /** Door-rusher personality — high values plant on the capture lip. */
  doorAggression?: number;
  /** Sim tick + next door-phase change (lip plant when closed phase is ending). */
  tick?: number;
  doorChangeTick?: number;
  /** Extra teammate hold claims (from BotManager harvest). */
  teammateCamps?: readonly { x: number; z: number }[];
};

/**
 * Always-defined world goal for this think.
 * Hunt fallback (agent → last → center) lives here — not in yawIntent.
 */
export function stepNavGoal(args: StepNavGoalArgs): NavGoalDecision {
  const {
    mode,
    forceNoiseReroll,
    selfX,
    selfZ,
    selfId,
    team,
    isGreyAgent,
    map,
    players,
    collision,
    bag,
    rng,
    enemyDoor: enemyDoorOpt,
    nearestHuntGoal: nearestHuntOpt,
    doorAggression,
    tick,
    doorChangeTick,
    teammateCamps,
  } = args;
  const enemyDoor = enemyDoorOpt ?? enemyDoorTarget(map, team);

  if (mode === "doorCamp") {
    const wantLip = wantsLipDoorCamp(doorAggression, tick, doorChangeTick);
    if (bag.doorCampWantLip !== wantLip) {
      bag.doorCampWantLip = wantLip;
      bag.doorCampPlantX = UNSET;
      bag.doorCampPlantZ = UNSET;
    }
    if (!hasDoorCampPlant(bag) && collision) {
      const claims = collectEnemyDoorCampClaims(
        map,
        team,
        players,
        selfId,
        CAMP_MAX_DOOR_DIST,
      );
      if (teammateCamps) {
        for (const c of teammateCamps) {
          claims.push({ x: c.x, z: c.z });
        }
      }
      const plant = wantLip
        ? pickEnemyDoorCampPlant(collision, team, {
          avoid: claims,
          rng,
        })
        : pickCoverDoorCamp(collision, enemyDoor, {
          avoid: claims,
          rng,
          lateralBias: botLateralBias(selfId),
          preferTight: (doorAggression ?? 0) >= 0.5,
        });
      bag.doorCampPlantX = plant.x;
      bag.doorCampPlantZ = plant.z;
    }
    const plantX = bag.doorCampPlantX;
    const plantZ = bag.doorCampPlantZ;
    if (hasDoorCampPlant(bag)) {
      bag.doorCampActive = true;
      const campArrived = isAtDoorCampPlant(selfX, selfZ, plantX, plantZ);
      return {
        mode,
        goal: { x: plantX, z: plantZ },
        doorDistPoint: null,
        campArrived,
        forceNoiseReroll,
      };
    }
    // No collision / plant: fall back to enemy door mid as goal.
    return {
      mode,
      goal: enemyDoor,
      doorDistPoint: null,
      campArrived: false,
      forceNoiseReroll,
    };
  }

  if (mode === "hunt") {
    let huntDoorBias: "own" | "enemy" = bag.huntDoorBias === "enemy"
      ? "enemy"
      : "own";
    const biasStep = stepHuntDoorBias(
      selfX,
      selfZ,
      map,
      team,
      huntDoorBias,
      bag.huntDoorBiasDist,
    );
    huntDoorBias = biasStep.bias;
    bag.huntDoorBias = huntDoorBias;
    bag.huntDoorBiasDist = typeof biasStep.dist === "number" &&
        Number.isFinite(biasStep.dist)
      ? biasStep.dist
      : UNSET;
    bag.huntActive = true;

    const resolved = resolveHuntGoalPoint(
      selfX,
      selfZ,
      players,
      selfId,
      map,
      { x: bag.huntLastAgentX, z: bag.huntLastAgentZ },
      {
        isGreyAgent,
        liveGoal: nearestHuntOpt === undefined
          ? undefined
          : nearestHuntOpt
          ? { x: nearestHuntOpt.x, z: nearestHuntOpt.z }
          : null,
      },
    );
    if (typeof resolved.lastX === "number" && typeof resolved.lastZ === "number") {
      bag.huntLastAgentX = resolved.lastX;
      bag.huntLastAgentZ = resolved.lastZ;
    }
    const doorDistPoint = doorBiasMidpoint(map, team, huntDoorBias);
    return {
      mode,
      goal: resolved.goal,
      doorDistPoint,
      campArrived: false,
      forceNoiseReroll,
    };
  }

  // path (doors open)
  return {
    mode: "path",
    goal: enemyDoor,
    doorDistPoint: null,
    campArrived: false,
    forceNoiseReroll,
  };
}

// ── doorCampLook ───────────────────────────────────────────────────────────

export type StepDoorCampLookArgs = {
  prior: HeadingDecision;
  selfYaw: number;
  team: TeamId;
  map: DoorsMap;
  tick: number;
  campingAnxiety: number;
  bag: HuntBrainState;
  rng: () => number;
};

/**
 * Planted look sweep between enemy spawn corners via own door.
 * Pass-through when not camped+arrived.
 */
export function stepDoorCampLook(args: StepDoorCampLookArgs): HeadingDecision {
  const {
    prior,
    selfYaw,
    team,
    map,
    tick,
    campingAnxiety,
    bag,
    rng,
  } = args;

  if (prior.mode !== "doorCamp" || !prior.campArrived) {
    return prior;
  }

  const plantX = prior.goal.x;
  const plantZ = prior.goal.z;

  let lookIndex: 0 | 1 = bag.doorCampLookIndex === 1 ? 1 : 0;
  let viaOwn = Boolean(bag.doorCampViaOwn);
  let nextSwitchAt = bag.doorCampNextSwitchAt;

  if (!Number.isFinite(nextSwitchAt)) {
    // First plant: pick a spawn corner and schedule first flip.
    lookIndex = rng() < 0.5 ? 0 : 1;
    viaOwn = false;
    const holdSec = rollCampLookHoldSec(campingAnxiety, rng);
    nextSwitchAt = tick + max(1, round(holdSec * TICK_HZ));
  } else if (tick >= nextSwitchAt) {
    const fromIndex = lookIndex;
    lookIndex = fromIndex === 0 ? 1 : 0;
    const fromYaw = doorCampLookYaw(
      plantX,
      plantZ,
      map,
      team,
      fromIndex,
    );
    const toYaw = doorCampLookYaw(
      plantX,
      plantZ,
      map,
      team,
      lookIndex,
    );
    const ownYaw = doorCampOwnDoorYaw(plantX, plantZ, map, team);
    // Prefer path through own door so the back stays to the enemy door.
    viaOwn = !shortestArcPassesNear(fromYaw, toYaw, ownYaw);
    const holdSec = rollCampLookHoldSec(campingAnxiety, rng);
    nextSwitchAt = tick + max(1, round(holdSec * TICK_HZ));
  }

  // If mid-sweep via own door, stick until nearly facing it.
  let rawLook: number;
  if (viaOwn) {
    const ownYaw = doorCampOwnDoorYaw(plantX, plantZ, map, team);
    if (abs(doorCampYawSignedDelta(selfYaw, ownYaw)) < 0.35) {
      viaOwn = false;
      rawLook = doorCampLookYaw(plantX, plantZ, map, team, lookIndex);
    } else {
      rawLook = ownYaw;
    }
  } else {
    rawLook = doorCampLookYaw(plantX, plantZ, map, team, lookIndex);
  }

  bag.doorCampLookIndex = lookIndex;
  bag.doorCampViaOwn = viaOwn;
  bag.doorCampNextSwitchAt = nextSwitchAt;
  // Keep plant coords live for navigate / targetEnemy.
  bag.doorCampActive = true;
  bag.doorCampPlantX = plantX;
  bag.doorCampPlantZ = plantZ;

  return {
    ...prior,
    rawLook,
    // Idle move yaw (navigate zeros keys when planted).
    moveYaw: rawLook,
    next: null,
  };
}

// re-export for callers that only need types from one place
export type { YawPolePoint };
