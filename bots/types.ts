/**
 * Extensible bot AI contracts.
 *
 * Brains produce the same PlayerInput humans send over the wire so bots flow
 * through the normal Player sim (movement, scoring, combat). Swap or compose
 * brains without touching PlayerManager / GameServer.
 *
 * Difficulty modes (easy / hard / …) pick a brain factory; new levels register
 * in difficulty.ts without rewriting the manager.
 */

import type { Player } from "../players/Player.ts";
import type { BotBrainConfig as PipelineBotBrainConfig } from "@doors/bot-spec/config";
import type { BotDifficulty } from "@doors/bot-spec/config";
import {
  BOT_TICK_HZ,
  botTickPhase,
  botTickToSimTick,
  SIM_TICKS_PER_BOT_TICK,
  simToBotTick,
  THINK_BUFFER_BOT_TICKS,
  THINK_BUFFER_SIM_TICKS,
  THINK_BUFFER_TICKS,
  viewSimDelta,
} from "@doors/bot-spec/schedule";
import type { PlayerInput, TeamId } from "../protocol/network.ts";
import { TICK_HZ } from "../protocol/network.ts";
import type { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";

export type { BotDifficulty };
export {
  BOT_TICK_HZ,
  botTickPhase,
  botTickToSimTick,
  SIM_TICKS_PER_BOT_TICK,
  simToBotTick,
  THINK_BUFFER_BOT_TICKS,
  THINK_BUFFER_SIM_TICKS,
  THINK_BUFFER_TICKS,
  viewSimDelta,
};

if (!Number.isInteger(SIM_TICKS_PER_BOT_TICK) || SIM_TICKS_PER_BOT_TICK < 1 ||
  SIM_TICKS_PER_BOT_TICK !== TICK_HZ / BOT_TICK_HZ) {
  throw new Error(
    `BOT_TICK_HZ (${BOT_TICK_HZ}) must evenly divide TICK_HZ (${TICK_HZ})`,
  );
}

/** True on the first sim tick of a bot period (phase 0). */
export function isBotTickBoundary(simTick: number): boolean {
  return botTickPhase(simTick) === 0;
}

/** Team door scores for lightweight objective pressure (optional in unit tests). */
export type BotTeamScores = { A: number; B: number };

/** Per-tick world view handed to a brain. Expand freely as AI grows. */
export type BotWorldView = {
  /** Live sim tick (doors, msToTicks reaction clocks). */
  tick: number;
  /**
   * How many sim ticks this think represents for countdown drains.
   * {@link BotManager} sets {@link SIM_TICKS_PER_BOT_TICK}; unit tests that
   * omit it keep delta 1 so existing think-once tests stay valid.
   */
  simDelta?: number;
  /** Self — authoritative player state for this bot. */
  self: Player;
  /** All players in the match (humans + bots), including self. */
  players: readonly Player[];
  collision: MapCollision;
  map: DoorsMap;
  /**
   * Authoritative door phase. Captures only while open; hard bots camp when
   * closed. Always provided so brains do not need to recompute the cycle.
   */
  doorsOpen: boolean;
  /**
   * Sim tick when the current door phase ends (from PlayerManager).
   * Optional for unit tests. Used to walk onto the capture lip as doors
   * are about to open.
   */
  doorChangeTick?: number;
  /**
   * Same-team bot camp / hold anchors known this tick (from other bots' brain
   * state). Used to deconflict camping so squads don't stack the same angle.
   * Optional for unit tests that build views by hand.
   */
  teammateCamps?: readonly TeammateCampClaim[];
  /**
   * Match team scores (door captures). Official pool pawns use this for
   * score anxiety: trailing → push the enemy door harder than people;
   * leading → duel hostiles over the door. Community fill / agents ignore.
   */
  teamScores?: BotTeamScores;
};

/** A teammate's claimed camp/hold XZ (opaque to brains beyond position). */
export type TeammateCampClaim = {
  playerId: string;
  x: number;
  z: number;
};

/**
 * Full brain output for one tick: movement/look plus optional combat intents.
 * BotManager stamps input sequences and routes shoot/reload through the same
 * PlayerManager paths humans use.
 *
 * Alias of pipeline ReadyAction — think pipe output / apply pipe input.
 */
/** One sim tick of look inside a bot period (see {@link BotAction.lookSamples}). */
export type BotLookSample = { yaw: number; pitch: number };

export type BotAction = {
  /** Movement + look for this tick. Null = no new input (hold still). */
  input: PlayerInput | null;
  /**
   * Per-sim-tick look for this action's bot period, oldest first. The driver
   * applies sample k on the k-th sim tick after release and holds the last
   * (which equals `input.yaw/pitch`). Omitted → lerp from the previous look.
   * Driver-only: never reaches the sim or the recording (those see the
   * per-tick `input.yaw/pitch` it produces).
   */
  lookSamples?: BotLookSample[];
  /** Request a shot this tick (server validates via canShoot). */
  shoot?: boolean;
  /** Request a reload this tick (server validates). */
  reload?: boolean;
  /** Equip this weapon id this tick (server validates via handleWeaponSwitch). */
  weapon?: number;
  /**
   * Activate this skill family (edge-only through apply interp).
   * Apply calls {@link PlayerManager.handleAbility}; server re-validates.
   */
  ability?: import("../shared/sim/skills.ts").SkillId;
  /** Sim tick of the think's world view (driver-stamped; shot lag-comp claim). */
  observedTick?: number;
};

/** @see BotAction — preferred name at the think→apply boundary. */
export type ReadyAction = BotAction;

/**
 * One completed think result waiting to pass through the apply pipe.
 * Enqueued at think time with {@link applyAt} = thinkBotTick + {@link THINK_BUFFER_BOT_TICKS}.
 */
export type DelayedReadySlot = {
  /** Bot tick when this action should start applying (then held/interp for the bot period). */
  applyAt: number;
  action: ReadyAction | null;
};

/**
 * Per-bot look interpolation between successive ready actions (apply @ 60 Hz).
 * Discrete keys/shoot come from {@link curr}; yaw/pitch lerp over one bot period.
 */
export type BotApplyInterp = {
  prevYaw: number;
  prevPitch: number;
  curr: ReadyAction;
  /** Sim tick when {@link curr} first became due. */
  startSimTick: number;
  /** Shoot/reload already consumed for this ready slot (edge only). */
  combatEdgeDone: boolean;
};

/**
 * Which brain slot owns this pawn for its whole life.
 * `fill` and `balance` follow `bots.brain`. `agent` and `raid` stay on
 * the built-in slot. `pool` follows `DOORS_POOL_BRAIN_CMD` when it is set.
 */
export type BotRole = "fill" | "balance" | "raid" | "agent" | "pool";

export type BotFillPolicy = {
  /**
   * Desired total roster size (humans + bots) for auto-fill.
   * When humanCount is 0 and noBotsOnEmptyServer is true, the fill target
   * is forced to 0 bots regardless of this value.
   */
  minPlayers: number;
  /**
   * When true (default), zero humans → zero bots.
   * When false, auto-fill keeps bots on an empty server.
   */
  noBotsOnEmptyServer: boolean;
};

export type ManagedBot = {
  playerId: string;
  /** Display index used for "bot1", "bot2", … (also used when seeded). */
  nameIndex: number;
  /** Slot routing. Fixed at spawn. */
  role: BotRole;
  /** Exact config sent to the persistent batched thought engine. */
  pipelineConfig: PipelineBotBrainConfig;
  /** Monotonic input sequence so Player.queueInput accepts every tick. */
  sequence: number;
  /**
   * FIFO of completed think outputs waiting for their apply **bot tick**.
   * Think enqueues here; apply releases slots with {@link DelayedReadySlot.applyAt}
   * ≤ current bot tick (last due wins if bot ticks skipped). Soft-buffer
   * (incomplete AI / STOP RESULT) is a separate queue.
   */
  readyDelayQueue: DelayedReadySlot[];
  /**
   * Action released for the apply pipe this sim tick (from the delay queue),
   * or the held ready action being interpolated. Null while the pipeline is
   * still filling (first {@link THINK_BUFFER_BOT_TICKS} bot thinks).
   */
  readyAction?: ReadyAction | null;
  /**
   * Look interpolation state between ready actions (60 Hz apply between 20 Hz bot ticks).
   */
  applyInterp?: BotApplyInterp | null;
  /**
   * Last applied ReadyAction for soft-buffer failure-tick replay.
   * Written on apply when the orchestrator is wired (PR3); optional until then.
   * Not a second buffer — only a per-bot cache of the last body move.
   * @see docs/game/bots.md §3.1
   */
  lastAppliedAction?: ReadyAction | null;
  /**
   * `Player.spawnedAtTick` last seen by apply. A change drops the held
   * interpolator so a new life does not inherit the previous WASD.
   */
  lifeSpawnedAtTick?: number;
  /**
   * Host-channel identity this pawn took. Set for pool role only.
   * The director frees the slot when the pawn is removed.
   */
  poolIdentityId?: string;
  /** Brain profile id from the pool identity. Forwarded, not decoded. */
  profile?: string;
  /** Opaque profile bytes from the pool identity. Forwarded, not decoded. */
  profileData?: string;
  /**
   * Temporary uneven-team filler (display name `"bot"`). Excluded from autofill
   * quota; added/dropped by {@link BotManager} when team totals are uneven/even.
   */
  isBalanceBot?: boolean;
};

export type BotSnapshotInfo = {
  id: string;
  name: string;
  team: TeamId;
  brainId: string;
};
