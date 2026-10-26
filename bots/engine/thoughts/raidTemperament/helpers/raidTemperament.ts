/**
 * Pure raid-temperament helpers: half the raid roster periodically pauses
 * body movement while rushing, the other half never stops. Ported from
 * `BotManager`'s apply-time `RaidBotMovementCadence` (keys-only PR 6) so the
 * roll lives in think, keyed by the bot's own seeded rng instead of a
 * BotManager-wide `raidRoll` stream.
 */

import type { PlayerInput } from "../../../shared/network.ts";
import { msToTicks } from "../../../shared/network.ts";
import { clamp01 } from "../../../math/index.ts";

/** Half the raid roster periodically pauses; the other half keeps rushing. */
export const RAID_BOT_STOP_CHANCE = 0.5;
export const RAID_BOT_MOVE_MIN_MS = 2_000;
export const RAID_BOT_MOVE_MAX_MS = 5_000;
export const RAID_BOT_STOP_MIN_MS = 1_000;
export const RAID_BOT_STOP_MAX_MS = 2_000;

export type RaidBotMovementCadence = {
  nextStopTick: number;
  stopUntilTick: number;
};

export function rollRaidDurationTicks(
  minMs: number,
  maxMs: number,
  rand: () => number,
): number {
  const raw = rand();
  const unit = Number.isFinite(raw) ? clamp01(raw) : 0;
  return msToTicks(minMs + (maxMs - minMs) * unit);
}

/** Assign the slower raid temperament and schedule its first pause. */
export function createRaidBotMovementCadence(
  spawnTick: number,
  rand: () => number,
): RaidBotMovementCadence | null {
  if (rand() >= RAID_BOT_STOP_CHANCE) return null;
  return {
    nextStopTick: spawnTick + rollRaidDurationTicks(
      RAID_BOT_MOVE_MIN_MS,
      RAID_BOT_MOVE_MAX_MS,
      rand,
    ),
    stopUntilTick: spawnTick,
  };
}

/** Advance one stopper's move/pause cycle and report whether it is paused now. */
export function advanceRaidBotMovementCadence(
  cadence: RaidBotMovementCadence,
  tick: number,
  rand: () => number,
): boolean {
  if (tick < cadence.stopUntilTick) return true;
  if (tick < cadence.nextStopTick) return false;

  cadence.stopUntilTick = tick + rollRaidDurationTicks(
    RAID_BOT_STOP_MIN_MS,
    RAID_BOT_STOP_MAX_MS,
    rand,
  );
  cadence.nextStopTick = cadence.stopUntilTick + rollRaidDurationTicks(
    RAID_BOT_MOVE_MIN_MS,
    RAID_BOT_MOVE_MAX_MS,
    rand,
  );
  return true;
}

/** Stop body movement without interrupting aim, fire, reload, or abilities. */
export function zeroRaidMovementInput(input: PlayerInput): PlayerInput {
  return {
    ...input,
    forward: false,
    backward: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
  };
}
