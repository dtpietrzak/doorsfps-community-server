/**
 * The sim switches a zombots match turns on (notes/zombots.md steps 12a/12b):
 * unarmed starts, downed humans, and teammates that shots pass through. The
 * live runtime and replay rebuilds both read this one value.
 */
import type { ZombotsSimRules } from "./PlayerManager.ts";

export const ZOMBOTS_SIM_RULES: Readonly<ZombotsSimRules> = Object.freeze({
  armedWeapons: true,
  downedState: true,
  teammatesPassThrough: true,
});

/** Occupancy mode id of a zombots runtime (DOORS_MODE_ID). */
export const ZOMBOTS_MODE_ID = "zombots";
