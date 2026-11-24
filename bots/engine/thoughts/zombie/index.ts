/**
 * Zombie think steps: sticky human, chest look, melee lunge, crowd strafe,
 * windows out of the zombie closures.
 */

export {
  armMeleeCooldown,
  meleeCooldownTicks,
  rememberZombieTarget,
  zombieLastKnown,
  zombieStickyId,
} from "./latch.ts";
export { zombieLookAt } from "./look.ts";
export {
  zombieMeleeLunge,
  ZOMBIE_MELEE_YAW_TOLERANCE,
} from "./melee.ts";
export {
  zombieHoldsForward,
  zombieSeparationStrafe,
  ZOMBIE_SEPARATION_RADIUS,
} from "./separate.ts";
export type { ZombieCrowdBody } from "./separate.ts";
export {
  isZombiePrey,
  pickZombieTarget,
  readZombieIsDowned,
  ZOMBIE_TARGET_SWITCH_MARGIN,
} from "./target.ts";
export type { ZombiePlayerView } from "./target.ts";
export {
  buildZombieWindowNav,
  ZOMBIE_WINDOW_APPROACH,
  ZOMBIE_WINDOW_CLIMB_DEPTH,
  ZOMBIE_WINDOW_FUNNEL,
  ZOMBIE_WINDOW_LINE_UP,
  openZombieNavDoors,
  zombieWindowPlan,
} from "./window.ts";
export type {
  ZombieWindowNav,
  ZombieWindowPlan,
  ZombieWindowPortal,
} from "./window.ts";
