/**
 * Raid temperament: half the raid roster periodically pauses body movement
 * for 1-2s between 2-5s rushes; the other half never stops. Bosses (and
 * every non-raid role) opt out entirely.
 *
 * Runs last (after {@link useSkills}) and only rewrites the already-packed
 * `ReadyAction` — WASD/jump/sprint are zeroed on a pause tick, look, crouch,
 * and combat edges (shoot/reload/weapon/ability) pass through untouched.
 * Ported from `BotManager`'s apply-time `RaidBotMovementCadence` (keys-only
 * PR 6): the pause/resume roll now lives in think, keyed by the bot's own
 * seeded rng instead of a BotManager-wide `raidRoll` stream.
 *
 * @kind impure (pack: final action rewrite)
 */

import type {
  ReadyAction,
  StepResult,
  ThinkContext,
  ThinkStep,
} from "../../pipeline/types.ts";
import type { BotBrainState } from "../../types.ts";
import {
  advanceRaidBotMovementCadence,
  createRaidBotMovementCadence,
  zeroRaidMovementInput,
} from "./helpers/raidTemperament.ts";

export type RaidTemperamentStepOpts = {
  /** Not a raid bot (or raid role unknown) → step is a pure pass-through. */
  isRaidBot: boolean;
  /** Bosses (and any raid bot opting out) never pause. */
  allowRandomStops: boolean;
  rng: () => number;
};

export function runRaidTemperamentStep(
  ctx: ThinkContext,
  prior: ReadyAction,
  draftState: BotBrainState,
  isRaidBot: boolean,
  allowRandomStops: boolean,
  rng: () => number,
): StepResult<ReadyAction> {
  if (!isRaidBot || !allowRandomStops || prior.input === null) {
    return { out: prior };
  }

  const bag = draftState;
  const tick = ctx.view.tick;

  if (!bag.raidStopperHasLatch) {
    bag.raidStopperHasLatch = true;
    const cadence = createRaidBotMovementCadence(tick, rng);
    bag.raidIsStopper = cadence !== null;
    if (cadence !== null) {
      bag.raidNextStopTick = cadence.nextStopTick;
      bag.raidStopUntilTick = cadence.stopUntilTick;
    }
  }
  if (!bag.raidIsStopper) {
    return { out: prior };
  }

  const cadence = {
    nextStopTick: bag.raidNextStopTick,
    stopUntilTick: bag.raidStopUntilTick,
  };
  const paused = advanceRaidBotMovementCadence(cadence, tick, rng);
  bag.raidNextStopTick = cadence.nextStopTick;
  bag.raidStopUntilTick = cadence.stopUntilTick;
  if (!paused) {
    return { out: prior };
  }

  return {
    out: {
      ...prior,
      input: zeroRaidMovementInput(prior.input),
    },
  };
}

export function createRaidTemperamentStep(
  opts: RaidTemperamentStepOpts,
) {
  const { isRaidBot, allowRandomStops, rng } = opts;
  return {
    id: "raidTemperament",
    kind: "impure",
    run(ctx, prior, draftState) {
      return runRaidTemperamentStep(
        ctx,
        prior,
        draftState,
        isRaidBot,
        allowRandomStops,
        rng,
      );
    },
  } satisfies ThinkStep<ReadyAction, ReadyAction>;
}
