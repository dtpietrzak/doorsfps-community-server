import type { CombatPitchMotorInput } from "../thoughts/combatPitch/helpers/motor.ts";
import type {
  BotBrainState,
  BotLookSample,
  BotWorldView,
} from "../types.ts";
import type { PlayerInput } from "../shared/network.ts";
import type { SkillId } from "../../../shared/sim/skills.ts";
import type { BotPerception } from "../thoughts/perception/helpers/perception.ts";
import type { BrainHooks } from "../hooks.ts";

export type ReadyAction = {
  input: PlayerInput | null;
  /** Per-sim-tick look for the bot period; last === input look. */
  lookSamples?: BotLookSample[];
  shoot?: boolean;
  reload?: boolean;
  weapon?: number;
  ability?: SkillId;
  /** Private handoff from combatPitch through navigate into yawHumanize. */
  compiledPitchInput?: CombatPitchMotorInput;
};

export type ThinkContext = {
  logicalTick: number;
  view: BotWorldView;
  botId: string;
  rng: () => number;
  perception?: BotPerception;
  /** Set once for the engine. Thoughts read hooks from here. */
  hooks: BrainHooks;
};

export type ThinkAccum = Record<string, unknown>;

export type StepResult<TOut> = {
  out: TOut;
  statePatch?: BotBrainState;
  done?: boolean;
  ready?: ReadyAction | null;
};

export type ThinkStepKind = "passive" | "switch" | "impure";

export type ThinkStep<TIn = unknown, TOut = unknown> = {
  readonly id: string;
  readonly kind: ThinkStepKind;
  run(
    ctx: ThinkContext,
    prior: TIn,
    draftState: BotBrainState,
  ): StepResult<TOut>;
};

export type ThinkPipeResult = {
  ready: ReadyAction | null;
  nextState: BotBrainState;
};

export const THINK_STEP_IDS = [
  "gate",
  "perception",
  "navMode",
  "navGoal",
  "yawPole",
  "pathHeading",
  "doorCampLook",
  "yawIntent",
  "halfWallVault",
  "floatWallDuck",
  "targetEnemy",
  "combatPitch",
  "evalSprint",
  "navigate",
  "stuckWTurn",
  "yawHumanize",
  "click",
  "useSkills",
  "raidTemperament",
] as const;

export type ThinkStepId = (typeof THINK_STEP_IDS)[number];

