import type { Player } from "./players/Player.ts";
import type { PlayerInput } from "./shared/network.ts";
import type { MapCollision } from "./world/MapCollision.ts";
import type { DoorsMap } from "./shared/map.ts";
import type { SkillId } from "../../shared/sim/skills.ts";
import type { BotBrainState } from "./pipeline/state.ts";

export {
  applyFloatWallDuckPatch,
  applyHalfWallVaultPatch,
  applyStuckWTurnPatch,
  applyTargetEnemyPatch,
  BotBrainState,
  cloneBotBrainState,
  copyBotBrainState,
  emptyBotBrainState,
  hasDoorCampPlant,
  hasStickyYawPole,
  isSetNumber,
  storedNumber,
  storedString,
  UNSET,
} from "./pipeline/state.ts";

export {
  BOT_TICK_HZ,
  SIM_TICKS_PER_BOT_TICK,
  THINK_BUFFER_BOT_TICKS,
  THINK_BUFFER_SIM_TICKS,
  THINK_BUFFER_TICKS,
  botTickPhase,
  botTickToSimTick,
  simToBotTick,
  viewSimDelta,
} from "@doors/bot-spec/schedule";
export type { BotDifficulty } from "@doors/bot-spec/config";
export type BotTeamScores = { A: number; B: number };

export type TeammateCampClaim = {
  playerId: string;
  x: number;
  z: number;
};

/** Immutable inputs consumed by one bot's run through the batch pipeline. */
export type BotWorldView = {
  tick: number;
  simDelta?: number;
  self: Player;
  players: readonly Player[];
  collision: MapCollision;
  map: DoorsMap;
  doorsOpen: boolean;
  doorChangeTick?: number;
  teammateCamps?: readonly TeammateCampClaim[];
  teamScores?: BotTeamScores;
  /** Optional map-authored/offline residual table, keyed by yaw-pole key. */
  humanHeatByPole?: Readonly<Record<string, number>>;
  /**
   * Set once the match has ended (intermission). The brain short-circuits
   * to idle keys (hold look, no movement/combat) — see the gate step.
   */
  matchOver?: boolean;
};

/** One sim tick of look inside a bot period (see {@link BotAction.lookSamples}). */
export type BotLookSample = { yaw: number; pitch: number };

export type BotAction = {
  input: PlayerInput | null;
  /**
   * Per-sim-tick look for this action's bot period, oldest first: the driver
   * applies `lookSamples[k]` on the k-th sim tick after the slot is released
   * and holds the last one. The last sample equals `input.yaw/pitch`. Omitted
   * → the driver lerps from the previous look to `input`.
   */
  lookSamples?: BotLookSample[];
  shoot?: boolean;
  reload?: boolean;
  weapon?: number;
  ability?: SkillId;
};

export type ReadyAction = BotAction;

export interface BotBrain {
  readonly id: string;
  think(view: BotWorldView, state: BotBrainState): BotAction | null;
}
