/** Public build: no raid waves, no raid map names. */

import type { RaidDefinition } from "./raids.ts";

export const RAID_DOOR_GOAL = 10;
export const RAID_DEFAULT_MAX_TIME_SECONDS = 4 * 60;
export const RAID_BREEZEWAY_MAX_TIME_SECONDS = 4 * 60;
export const RAID_MIDWAY_MAX_TIME_SECONDS = 5 * 60;
export const RAID_TERMINAL_MAX_TIME_SECONDS = 6 * 60;
export const RAID_WIN_REWARD = { xp: 15, coins: 15 } as const;

export const RAIDS: readonly RaidDefinition[] = [];

export const RAID_FIRST_ID: string = "";

export function isRaidOnlyMapName(_name: string): boolean {
  return false;
}
