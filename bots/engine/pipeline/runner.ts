import {
  type BotBrainState,
  cloneBotBrainState,
  copyBotBrainState,
} from "../types.ts";
import { fallbackRandom } from "../core/random.ts";
import type { BotWorldView } from "../types.ts";
import { defaultBrainHooks, type BrainHooks } from "../hooks.ts";
import type {
  ReadyAction,
  StepResult,
  ThinkContext,
  ThinkPipeResult,
  ThinkStep,
} from "./types.ts";

export type { ReadyAction };

export function cloneBrainState(state: BotBrainState): BotBrainState {
  return cloneBotBrainState(state);
}

export function mergeStatePatch(
  draft: BotBrainState,
  patch: BotBrainState,
): void {
  copyBotBrainState(patch, draft);
}

export function commitBrainState(
  target: BotBrainState,
  next: BotBrainState,
): void {
  copyBotBrainState(next, target);
}

function isReadyAction(value: unknown): value is ReadyAction {
  if (value === null || typeof value !== "object") return false;
  const action = value as ReadyAction;
  return action.input === null || typeof action.input === "object";
}

export function runThinkPipe(
  steps: readonly ThinkStep[],
  ctx: ThinkContext,
  committedState: BotBrainState,
): ThinkPipeResult {
  const draft = cloneBrainState(committedState);
  let prior: unknown = null;
  for (const step of steps) {
    const result: StepResult<unknown> = step.run(ctx, prior, draft);
    if (result.statePatch !== undefined) {
      mergeStatePatch(draft, result.statePatch);
    }
    prior = result.out;
    if (result.done === true) {
      const ready = result.ready !== undefined
        ? result.ready
        : isReadyAction(result.out)
        ? result.out
        : null;
      return { ready, nextState: draft };
    }
  }
  return {
    ready: isReadyAction(prior) ? prior : null,
    nextState: draft,
  };
}

export function runBrainThink(
  steps: readonly ThinkStep[],
  view: BotWorldView,
  state: BotBrainState,
  opts: {
    botId?: string;
    rng?: () => number;
    logicalTick?: number;
    hooks?: BrainHooks;
  } = {},
): ReadyAction | null {
  const fallbackRng = fallbackRandom;
  const result = runThinkPipe(
    steps,
    {
      logicalTick: opts.logicalTick ?? view.tick,
      view,
      botId: opts.botId ?? view.self.id,
      rng: opts.rng ?? fallbackRng,
      hooks: opts.hooks ?? defaultBrainHooks(),
    },
    state,
  );
  commitBrainState(state, result.nextState);
  return result.ready;
}
