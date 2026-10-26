/**
 * Build shared per-think perception (doors, hostiles, poles, LOS memo).
 * Transparent pass-through of prior so navMode still sees gate's null out.
 *
 * @kind passive
 * No draft bag write — only fills ephemeral `ctx.perception`. Free early;
 * any consumer of perception must run after this step.
 */

import { buildBotPerception } from "./helpers/perception.ts";
import type {
  StepResult,
  ThinkContext,
  ThinkStep,
} from "../../pipeline/types.ts";
import type { BotBrainState } from "../../types.ts";

export function runPerceptionStep(
  ctx: ThinkContext,
  prior: null,
  draftState: BotBrainState,
): StepResult<null> {
  const lockRaw = draftState.targetEnemyId;
  ctx.perception = buildBotPerception(ctx.view, {
    staggerSense: true,
    lockTargetId: typeof lockRaw === "string" ? lockRaw : undefined,
  });
  return { out: prior };
}

export function createPerceptionStep() {
  return {
    id: "perception",
    kind: "passive",
    run: runPerceptionStep,
  } satisfies ThinkStep<null, null>;
}
