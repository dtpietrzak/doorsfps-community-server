/** Brain-state latch for sprintChance (set when zone first wants sprint). */
export const SPRINT_CHANCE_LATCH_KEY = "sprintChanceLatched" as const;

/**
 * Brain-state latch for open-lane sprintChance (set when open + lenient
 * door-run first becomes true). Separate from zone latch so leaving a zone
 * into open ground re-rolls fairly.
 */
export const OPEN_SPRINT_CHANCE_LATCH_KEY = "openSprintChanceLatched" as const;

/** Combat id the current reaction timer was rolled for. */
export const REACTION_FOR_ID_KEY = "reactionForEnemyId" as const;

/** Sim tick at/after which shoot is allowed for the current lock. */
export const REACTION_READY_AT_TICK_KEY = "reactionReadyAtTick" as const;

/**
 * After an intentional miss (`hitChance` fail), suppress further click
 * attempts until this tick (weapon CD + shotInterval gap). Cleared on
 * unlock / new combat lock.
 */
export const HIT_CHANCE_MISS_UNTIL_TICK_KEY = "hitChanceMissUntilTick" as const;

/**
 * Combat pitch latch keys live on {@link ../combatPitch/helpers/combatPitch.ts} so pure helpers
 * and the think step share one source of truth:
 * `combatAimHeightForId`, `combatAimHeight`, swing arc fields, continuous
 * pitch micro/track wander.
 */

/**
 * Last {@link import("./navLayers.ts").NavGoalDecision} from a full
 * navGoal run — used when the 5 Hz cadence skips replan.
 */
export const CADENCE_NAV_GOAL_CACHE_KEY = "cadenceNavGoalCache" as const;

/**
 * Last {@link import("./navLayers.ts").YawPoleNavDecision} from a full
 * yawPole run — used when the 10 Hz cadence skips re-score.
 */
export const CADENCE_YAW_POLE_CACHE_KEY = "cadenceYawPoleCache" as const;
