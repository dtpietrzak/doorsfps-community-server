/**
 * Owns bot lifecycle and fill policy for a match.
 *
 * - Auto-fill: keep total roster at minPlayers (default 4) by adding/removing
 *   bots. With noBotsOnEmptyServer (default true), zero humans → zero bots;
 *   set that false to keep bots playing on an empty server.
 * - Balance bot: when team totals (humans + pool pawns + fillers) are uneven,
 *   a single named `"bot"` with {@link BALANCE_BOT_CONFIG} joins the lighter
 *   side. Dropped as soon as underlying teams are even.
 * - Community autofill: dumb `botN` fillers with {@link COMMUNITY_BOT_CONFIG}
 *   when the identity pool is empty.
 * - Official open matches push catalog identities, churn, and vote share over
 *   the host channel. Think/apply still use the pawn's pipeline config.
 * - Manual add/remove APIs are ready for the host CLI (`bots add 1`, etc.).
 * - Think is `@doors/bot-engine` (`pipeline-js`, `pipeline-js-codec`,
 *   `pipeline-compiled`, or `pipeline-compiled-deno`). BotManager only
 *   snapshots the world, delays ReadyActions, and applies.
 * - Grey "agents": free-for-all hunters that drop in on door-close
 *   (1–3 per close by weight, cap MAX_AGENTS), same combat difficulty,
 *   never autofill/reconcile, removed on death.
 */

import type { Player } from "../players/Player.ts";
import { PLAYER_HEIGHT } from "../players/Player.ts";
import type { PlayerManager } from "../players/PlayerManager.ts";
import type { ShootOutcome } from "../players/PlayerManager.ts";
import type { TeamId } from "../protocol/network.ts";
import {
  defaultPlayerEquipment,
  msToTicks,
} from "../protocol/network.ts";
import type { MapCollision } from "../world/MapCollision.ts";
import {
  type BotBrainConfig as PipelineBotBrainConfig,
  type BotDefinition,
  type BotMapDefinition,
  type BotThinkEngine,
  createBotThinkEngine,
  type ReadyAction as PipelineReadyAction,
  type ThinkBatchInput,
  type ThinkBatchOutput,
} from "@doors/bot-engine";
import {
  findPipelineCodecDiff,
  type PipelineCodecValue,
  roundTripBotThinkPipelineRequest,
  roundTripBotThinkPipelineResponse,
} from "@doors/bot-engine/protocol";
import {
  type CompiledBotThinkPipeline,
  type CompiledPipelineResult,
  DenoCompiledBotThinkPipeline,
} from "./compiled/index.ts";
import {
  AGENT_BOT_CONFIGS,
  agentBrainConfigFor,
  BALANCE_BOT_CONFIG,
  COMMUNITY_BOT_CONFIG,
  RAID_BOT_CONFIG,
  RAID_NO_STOPS_BOT_CONFIG,
} from "./botBrainConfig.ts";
import { DEFAULT_BOT_DIFFICULTY } from "./difficulty.ts";
import { botThinksOnSimPhase } from "./helpers/combat.ts";
import { agentDoorSpawn } from "./helpers/nav.ts";
import { botLifeRandomSeed } from "./shadow/types.ts";
import {
  type ChurnPolicy,
  type IdentityDropReason,
  type PawnRemoveReason,
  type PoolIdentity,
  type VoteSeedPolicy,
} from "../host/channel/protocol.ts";
import {
  MMS_RANKS,
  type MmsRankId,
} from "../shared/progression/mmsRanks.ts";
import { buildBotMapDefinition, buildThinkFrame } from "./shadow/frame.ts";

import { encodeBotDecisions } from "../shared/bots/botDecisions.ts";
import {
  emptySkillLoadout,
  isSkillId,
  type SkillProductId,
} from "../shared/sim/skills.ts";
import type {
  BotDifficulty,
  BotFillPolicy,
  BotSnapshotInfo,
  DelayedReadySlot,
  ManagedBot,
} from "./types.ts";
import {
  BOT_TICK_HZ,
  botTickToSimTick,
  SIM_TICKS_PER_BOT_TICK,
  simToBotTick,
  THINK_BUFFER_BOT_TICKS,
  THINK_BUFFER_TICKS,
} from "./types.ts";
import {
  type ApplyContext,
  createLastMoveMemory,
  DEFAULT_APPLY_STEPS,
  type LastMoveMemory,
  type ReadyAction,
  recordLastMove,
  replayLastMove,
  runApplyPipe,
} from "./pipeline/index.ts";
import {
  flushPendingWeapons,
  type PendingWeapon,
} from "../players/weaponsQueue.ts";
import {
  dropInterpOnSpawn,
  sampleTickAction,
} from "./pipeline/botInputAdapter.ts";

export {
  BOT_TICK_HZ,
  botTickToSimTick,
  SIM_TICKS_PER_BOT_TICK,
  simToBotTick,
  THINK_BUFFER_BOT_TICKS,
  THINK_BUFFER_TICKS,
};



function pipelineReadyAction(
  action: PipelineReadyAction | null,
): ReadyAction | null {
  if (action === null) return null;
  const samples = action.lookSamples;
  return {
    input: action.input === null ? null : {
      sequence: 0,
      forward: action.input.forward,
      backward: action.input.backward,
      left: action.input.left,
      right: action.input.right,
      jump: action.input.jump,
      sprint: action.input.sprint,
      crouch: action.input.crouch,
      yaw: action.input.yaw,
      pitch: action.input.pitch,
    },
    ...(action.input === null || samples === undefined || samples.length === 0
      ? {}
      : {
        lookSamples: samples.map((sample) => ({
          yaw: sample.yaw,
          pitch: sample.pitch,
        })),
      }),
    ...(action.shoot === undefined ? {} : { shoot: action.shoot }),
    ...(action.reload === undefined ? {} : { reload: action.reload }),
    ...(action.weapon === undefined ? {} : { weapon: action.weapon }),
    ...(isSkillId(action.ability) ? { ability: action.ability } : {}),
  };
}

function wrappedAngleDelta(left: number, right: number): number {
  let delta = left - right;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return Math.abs(delta);
}

type PipelineMismatchKind =
  | "ok"
  | "null"
  | "keys"
  | "shoot"
  | "stance"
  | "look";

type PipelineActionComparison = {
  exact: boolean;
  discreteMatch: boolean;
  keysMatch: boolean;
  shootMatch: boolean;
  stanceMatch: boolean;
  kind: PipelineMismatchKind;
  yawDelta: number;
  pitchDelta: number;
};

function comparePipelineActions(
  js: PipelineReadyAction | null,
  compiled: PipelineReadyAction | null,
): PipelineActionComparison {
  const exact = JSON.stringify(js) === JSON.stringify(compiled);
  if (js === null || compiled === null) {
    const match = js === compiled;
    return {
      exact,
      discreteMatch: match,
      keysMatch: match,
      shootMatch: match,
      stanceMatch: match,
      kind: match ? "ok" : "null",
      yawDelta: match ? 0 : Number.POSITIVE_INFINITY,
      pitchDelta: match ? 0 : Number.POSITIVE_INFINITY,
    };
  }
  const left = js.input;
  const right = compiled.input;
  const shootMatch = js.shoot === compiled.shoot &&
    js.reload === compiled.reload &&
    js.weapon === compiled.weapon &&
    js.ability === compiled.ability;
  if (left === null || right === null) {
    const match = left === right && shootMatch;
    return {
      exact,
      discreteMatch: match,
      keysMatch: left === right,
      shootMatch,
      stanceMatch: left === right,
      kind: left === right ? (shootMatch ? "ok" : "shoot") : "null",
      yawDelta: left === right ? 0 : Number.POSITIVE_INFINITY,
      pitchDelta: left === right ? 0 : Number.POSITIVE_INFINITY,
    };
  }
  const keysMatch = left.forward === right.forward &&
    left.backward === right.backward &&
    left.left === right.left &&
    left.right === right.right;
  const stanceMatch = left.jump === right.jump &&
    left.sprint === right.sprint &&
    left.crouch === right.crouch;
  const yawDelta = wrappedAngleDelta(left.yaw, right.yaw);
  const pitchDelta = Math.abs(left.pitch - right.pitch);
  const discreteMatch = shootMatch && keysMatch && stanceMatch;
  let kind: PipelineMismatchKind = "ok";
  if (!keysMatch) kind = "keys";
  else if (!shootMatch) kind = "shoot";
  else if (!stanceMatch) kind = "stance";
  else if (
    yawDelta > (Math.PI * 5) / 180 || pitchDelta > (Math.PI * 5) / 180
  ) {
    kind = "look";
  }
  return {
    exact,
    discreteMatch,
    keysMatch,
    shootMatch,
    stanceMatch,
    kind,
    yawDelta,
    pitchDelta,
  };
}

type PipelineMismatchDump = {
  tick: number;
  botId: string;
  kind: PipelineMismatchKind;
  js: PipelineReadyAction | null;
  compiled: PipelineReadyAction | null;
};


/**
 * Bot AI buffer diagnostics for /api/status and admin dashboards.
 * Soft slots ≠ ready-action delay depth — only incomplete think debt.
 * @see docs/game/bots.md §6
 */
export type BotThinkMetrics = {
  /** Active whole-brain execution path. */
  runtime:
    | "pipeline-js"
    | "pipeline-js-codec"
    | "pipeline-compiled-shadow"
    | "pipeline-compiled"
    | "pipeline-compiled-deno-shadow"
    | "pipeline-compiled-deno"
    | "pipeline-compiled-perry"
    | "pipeline-compiled-perry-shadow";
  /**
   * Soft-credit residual **right now**. Always 0 — the checkpoint runner is gone.
   * Kept so /api/status shape stays stable.
   */
  softSlots: number;
  /** Always 0. */
  softSlotsPeak: number;
  /** Soft credit window leftover field; unused. */
  softSlotsMax: number;
  /** Always null. */
  softOldestAge: number | null;
  /** Always 0. Package think does not use failure-tick drops. */
  lastFailureCount: number;
  /** Always 0. */
  failureCountTotal: number;
  /** Last apply-phase wall time (ms). */
  lastApplyMs: number;
  /** Last think-phase wall time (ms). */
  lastThinkMs: number;
  /** Bots included in the last completed phase batch. */
  lastThinkBots: number;
  /** Lifetime process-local batch timing (rough machine comparison). */
  thinkBatchesTotal: number;
  meanThinkBatchMs: number;
  meanThinkMsPerBot: number;
  /** Same-tick bots total = apply + AI (ms). */
  lastBotsTotalMs: number;
  /** Unused; package think does not time individual steps. */
  stepCpu: null;
  /** Look-only worker removed. */
  shadowLook: null;
  /** Complete native-pipeline transport, parity, and canary counters. */
  compiledPipeline: {
    mode: "shadow" | "compiled";
    status: "starting" | "ready" | "error" | "stopped";
    engineVersion: string | null;
    samples: number;
    exactMatches: number;
    withinOneDegree: number;
    withinFiveDegrees: number;
    withinTenDegrees: number;
    discreteMismatches: number;
    keyMismatches: number;
    shootMismatches: number;
    mismatches: number;
    meanAbsYawDeltaRad: number;
    maxAbsYawDeltaRad: number;
    meanAbsPitchDeltaRad: number;
    maxAbsPitchDeltaRad: number;
    compiledApplied: number;
    compiledFallbacks: number;
    compiledFallbackLate: number;
    compiledFallbackInvalid: number;
    compiledFallbackNull: number;
    compiledFallbackUnavailable: number;
    inFlight: number;
    transportErrors: number;
    meanRoundTripMs: number;
    meanRequestBytes: number;
    firstMismatch: PipelineMismatchDump | null;
    lastMismatch: PipelineMismatchDump | null;
  } | null;
  /** In-process encode→decode sandwich; null unless `pipeline-js-codec`. */
  codecLoop: {
    samples: number;
    mismatches: number;
    lastMismatch: {
      message: string;
      path: string;
      tick: number;
    } | null;
  } | null;
};

function roundMs(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Safety cap on {@link ManagedBot.readyDelayQueue} length.
 * Steady state is THINK_BUFFER_BOT_TICKS (+1 when think runs before apply).
 * Extra headroom covers a few skipped applies without unbounded growth.
 */
const READY_DELAY_QUEUE_CAP = THINK_BUFFER_BOT_TICKS * 2 + 2;

/**
 * Enqueue a completed think output for apply at thinkBotTick + delay.
 * {@link applyAt} and {@link thinkBotTick} are **bot ticks** (not sim ticks).
 * `observedTick` (sim tick of the think's world view) rides on the action for
 * shot lag-comp stamps.
 */
export function enqueueReadyAction(
  bot: ManagedBot,
  action: ReadyAction | null,
  thinkBotTick: number,
  delayBotTicks: number = THINK_BUFFER_BOT_TICKS,
  observedTick?: number,
): void {
  const applyAt = thinkBotTick + delayBotTicks;
  bot.readyDelayQueue.push({
    applyAt,
    action: action !== null && observedTick !== undefined
      ? { ...action, observedTick }
      : action,
  });
  while (bot.readyDelayQueue.length > READY_DELAY_QUEUE_CAP) {
    bot.readyDelayQueue.shift();
  }
}

/**
 * Release due ready actions for this live **sim** tick.
 * Due when slot.applyAt (bot tick) ≤ current bot tick.
 * If several are due (bot ticks skipped), the latest due action wins.
 */
export function takeDueReadySlot(
  bot: ManagedBot,
  simTick: number,
): DelayedReadySlot | null {
  const botTick = simToBotTick(simTick);
  let due: DelayedReadySlot | null = null;
  const q = bot.readyDelayQueue;
  while (q.length > 0 && q[0]!.applyAt <= botTick) {
    due = q.shift()!;
  }
  if (due !== null) {
    bot.readyAction = due.action;
  }
  return due;
}

/**
 * Stable ascending player/session-id order for applyReadyActions (epic 4.5).
 * Bots and agents share one list so shot-budget truncation is join-order
 * independent. Matches 4.3/4.4 ruleRoster policy.
 */
export function collectApplyRoster(
  bots: Iterable<ManagedBot>,
  agents: Iterable<ManagedBot> = [],
): ManagedBot[] {
  return [...bots, ...agents].sort((a, b) =>
    a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0
  );
}

export function takeDueReadyAction(
  bot: ManagedBot,
  simTick: number,
): ReadyAction | null {
  return takeDueReadySlot(bot, simTick)?.action ?? null;
}

/**
 * Coalesce window for multi-seat open admissions (party / reservation batch).
 * GameServer defers fill+balance reconcile across near-simultaneous connects so
 * bots do not thrash after each member (S9-PR3).
 */
export const OPEN_ADMISSION_BOT_RECONCILE_MS = 150;

/** Snapshot after a batch admission bot reconcile (metrics / structured logs). */
export type BotAdmissionReconcileReport = {
  /** Ordinary fill / pool pawns removed during the batch to free human seats. */
  botsEvicted: number;
  /** Fill / pool pawns remaining (excludes temporary balance filler). */
  fillBotCount: number;
  /** True when the named `"bot"` balance filler is present. */
  balanceBot: boolean;
  /** Team of the balance filler when present. */
  balanceBotTeam: TeamId | null;
  /** Total non-agent team sizes (humans + fill + balance). */
  teamCounts: { A: number; B: number };
  humanCount: number;
  humanTeamCounts: { A: number; B: number };
};

/** Default fill: keep the lobby feeling alive with 4 bodies when anyone is in. */
export const DEFAULT_BOT_FILL: BotFillPolicy = {
  minPlayers: 4,
  noBotsOnEmptyServer: true,
};

/** Max simultaneous grey free-for-all agents on the map. */
export const MAX_AGENTS = 3;

/**
 * Weights for how many agents drop on each open→closed door edge.
 * Always at least one; sums to 1.
 */
export const AGENT_SPAWN_COUNT_WEIGHTS = {
  1: 0.45,
  2: 0.35,
  3: 0.20,
} as const;

/**
 * Roll how many agents to try spawning on this door close (1 / 2 / 3).
 * `rand` is injectable for tests (default {@link Math.random}).
 */
export function rollAgentsPerDoorClose(
  rand: () => number = Math.random,
): 1 | 2 | 3 {
  const r = rand();
  if (!Number.isFinite(r) || r < 0) return 1;
  if (r < AGENT_SPAWN_COUNT_WEIGHTS[1]) return 1;
  if (r < AGENT_SPAWN_COUNT_WEIGHTS[1] + AGENT_SPAWN_COUNT_WEIGHTS[2]) {
    return 2;
  }
  return 3;
}

/** Synthetic id prefix for grey agents (never collides with bot: or sockets). */
const AGENT_ID_PREFIX = "agent:";

/** Synthetic id prefix — never collides with Socket.IO socket ids. */
const BOT_ID_PREFIX = "bot:";

/**
 * Temporary uneven-team filler. Fixed display name so players can tell it
 * apart from seeded / `botN` fillers. Only one may exist at a time.
 */
export const BALANCE_BOT_NAME = "bot";
const BALANCE_BOT_ID_PREFIX = "bot:balance-";

/** Health / size / speed modifiers for one raid mini-bot roster. */
export type RaidMiniModifiers = {
  maxHealth: number;
  modelScale: number;
  moveSpeedScale: number;
};

/** Raid reinforcements arrive in pairs instead of materializing all at once. */
export const RAID_BOTS_PER_SPAWN = 2;
export const RAID_BOT_SPAWN_INTERVAL_MS = 2_000;
export const RAID_BOT_SPAWN_INTERVAL_TICKS = msToTicks(
  RAID_BOT_SPAWN_INTERVAL_MS,
);

export type BotManagerHooks = {
  /** Called after a bot is added to PlayerManager (emit PlayerJoined, etc.). */
  onBotJoined?: (player: Player) => void;
  /** Called after a bot is removed (emit PlayerLeft, etc.). */
  onBotLeft?: (playerId: string) => void;
};

/** Builtin thinks in process. Command is the `bots.brain` child, fill and balance only. */
type BrainSlotId = "builtin" | "command" | "pool";

type BrainSlot = {
  id: BrainSlotId;
  thoughtEngine: BotThinkEngine | null;
  compiled: CompiledBotThinkPipeline | null;
};

const COMMAND_RESTART_MIN_DELAY_MS = 1_000;
const COMMAND_RESTART_MAX_DELAY_MS = 30_000;

function commandFromBrain(
  brain: "builtin" | readonly string[] | undefined,
): readonly string[] | null {
  if (brain === undefined || brain === "builtin" || brain.length === 0) {
    return null;
  }
  for (const part of brain) {
    if (part.length === 0) return null;
  }
  return brain;
}

export type PoolRosterEvent =
  | { type: "pawn-took"; identityId: string; pawnId: string }
  | {
    type: "pawn-removed";
    identityId: string;
    pawnId: string;
    reason: PawnRemoveReason;
  }
  | { type: "identity-dropped"; identityId: string; reason: IdentityDropReason };

type QueuedPoolIdentity = {
  identity: PoolIdentity;
};

function knownMmsRankId(id: string | undefined): MmsRankId | undefined {
  if (!id) return undefined;
  for (const rank of MMS_RANKS) {
    if (rank.id === id) return rank.id;
  }
  return undefined;
}

export class BotManager {
  private readonly players: PlayerManager;
  private readonly hooks: BotManagerHooks;
  private readonly bots = new Map<string, ManagedBot>();
  /** Grey free-for-all agents (separate from team autofill bots). */
  private readonly agents = new Map<string, ManagedBot>();
  private fill: BotFillPolicy;
  private difficulty: BotDifficulty;
  /** Churn band and delays. Null keeps the roster on the exact autofill target. */
  private churnPolicy: ChurnPolicy | null = null;
  /** Map-vote share for pool pawns. Null casts no votes. */
  private voteSeed: VoteSeedPolicy | null = null;
  /** Queued identities waiting for the next fill. Capped at max players. */
  private pool: QueuedPoolIdentity[] = [];
  private poolCap = 32;
  private poolListener: ((event: PoolRosterEvent) => void) | null = null;
  /**
   * Signed offset from the auto-fill target (CLI).
   *   desired = max(0, auto + manualExtra + churnOffset)
   * Positive → CLI `bots add`; negative → CLI `bots remove` below auto-fill.
   * Cleared when the server has zero humans and noBotsOnEmptyServer is true.
   */
  private manualExtra = 0;
  /**
   * Authentic churn only: keep bot count within autofill base ± 1.
   * Independent of CLI manualExtra.
   */
  private churnOffset = 0;
  private nextLeaveAtMs = 0;
  private nextJoinAtMs = 0;
  private churnInitialized = false;
  /** When true, auto-fill is disabled and only manual bots remain. */
  private autoFillEnabled = true;
  /**
   * Last observed door-open phase. Used to detect open→closed transitions so
   * agents can drop in. Undefined until the first tick.
   */
  private prevDoorsOpen: boolean | undefined = undefined;
  /**
   * Door side for the next agent drop. Null until the first agent of the match
   * (then random A/B); after that alternates each spawn.
   */
  private nextAgentDoor: TeamId | null = null;
  /** Injectable clock for churn tests. */
  private nowMs: () => number;
  private rand: () => number;
  /**
   * RNG for authentic human↔bot mirror rolls only (so tests can drive
   * join/leave policy without interfering with seed-name picks).
   */
  private mirrorRoll: () => number;
  /**
   * Epic 4.6 `agents` domain stream (door-close count + first-door coin).
   * Held here from match reseed; Chunk 4 wires the call sites. Defaults to
   * Math.random until {@link setAgentsRandom} runs.
   */
  private agentsRandom: () => number = Math.random;
  /** Deterministic synthetic-id seam for tests/benchmarks; production uses UUIDs. */
  private readonly botIdFactory: ((nameIndex: number) => string) | null;
  private readonly idSuffix: () => string;

  /** Last completed/applied ReadyAction per bot for compiled deadline fallback. */
  private readonly lastMoves: LastMoveMemory = createLastMoveMemory();
  /** Complete persistent JS pipeline; null in compiled-only mode. */
  private readonly thoughtEngine: BotThinkEngine | null;
  /** Encode→decode every production message in process (JS engine still thinks). */
  private readonly thoughtCodecLoop: boolean;
  private codecLoopSamples = 0;
  private codecLoopMismatches = 0;
  private codecLoopLastMismatch: {
    message: string;
    path: string;
    tick: number;
  } | null = null;
  /** Complete persistent ScriptC or Deno-compiled pipeline; optional shadow or authority. */
  private readonly compiledThoughtEngine: CompiledBotThinkPipeline | null;
  private readonly compiledThoughtMode: "shadow" | "compiled";
  private readonly compiledThoughtHost: "scriptc" | "deno" | "perry";
  /**
   * Builtin slot always. Command slot only when `bots.brain` is a command.
   * Builtin engines are {@link thoughtEngine} and {@link compiledThoughtEngine}.
   */
  private readonly brainSlots = new Map<BrainSlotId, BrainSlot>();
  /** Fill/balance child. Null when brain is builtin. */
  private readonly commandPipeline: DenoCompiledBotThinkPipeline | null;
  /** Official pool child. Null unless `DOORS_POOL_BRAIN_CMD` is set. */
  private readonly poolPipeline: DenoCompiledBotThinkPipeline | null;
  /** In-flight command results. The sim tick does not wait on this. */
  private commandInFlight: Promise<void> = Promise.resolve();
  /** In-flight pool results. The sim tick does not wait on this. */
  private poolInFlight: Promise<void> = Promise.resolve();
  private compiledSamples = 0;
  private compiledExactMatches = 0;
  private compiledWithinOneDegree = 0;
  private compiledWithinFiveDegrees = 0;
  private compiledWithinTenDegrees = 0;
  private compiledDiscreteMismatches = 0;
  private compiledKeyMismatches = 0;
  private compiledShootMismatches = 0;
  private compiledMismatches = 0;
  private compiledAbsYawDeltaTotal = 0;
  private compiledMaxAbsYawDelta = 0;
  private compiledAbsPitchDeltaTotal = 0;
  private compiledMaxAbsPitchDelta = 0;
  private compiledApplied = 0;
  private compiledFallbacks = 0;
  private compiledFallbackLate = 0;
  private compiledFallbackInvalid = 0;
  private compiledFallbackNull = 0;
  private compiledFallbackUnavailable = 0;
  private compiledUnavailableLogAt = 0;
  private compiledFirstMismatch: PipelineMismatchDump | null = null;
  private compiledLastMismatch: PipelineMismatchDump | null = null;
  /**
   * Open admission wave (S9-PR3): defer fill/balance reconcile until the
   * reservation/party batch settles so near-simultaneous joins do not thrash.
   */
  private admissionBatchActive = false;
  /** Ordinary bots removed via {@link tryEvict} while a batch is open. */
  private admissionBatchEvicted = 0;
  /** Human roster changes occurred while deferring reconcile. */
  private deferredReconcilePending = false;

  constructor(
    players: PlayerManager,
    hooks: BotManagerHooks = {},
    options: {
      fill?: Partial<BotFillPolicy>;
      difficulty?: BotDifficulty;
      autoFill?: boolean;
      nowMs?: () => number;
      rand?: () => number;
      /** Override only the human-mirror probability roll (tests). */
      mirrorRoll?: () => number;
      /** Deterministic synthetic-id seam for tests/benchmarks. */
      botIdFactory?: (nameIndex: number) => string;
      /**
       * Deterministic suffix for agent / balance-bot ids (tests / audits).
       * Bot-think hashes player ids into personality, so random ids make
       * seeded offline sims unrepeatable. Default: 8 random uuid chars.
       */
      idSuffix?: () => string;
      /** Complete batched package pipeline (browser/Deno implementation). */
      thoughtEngine?: BotThinkEngine | null;
      /**
       * Round-trip map/roster/think through the compiled binary codec in
       * process. Isolates wire lossiness from ScriptC and compiled apply.
       */
      thoughtCodecLoop?: boolean;
      /** Complete persistent ScriptC or Deno-compiled pipeline transport. */
      compiledThoughtEngine?: CompiledBotThinkPipeline | null;
      /** Shadow compares against JS; compiled owns the queued action. */
      compiledThoughtMode?: "shadow" | "compiled";
      /** Which compiler produced the child host. Status runtime names depend on this. */
      compiledThoughtHost?: "scriptc" | "deno" | "perry";
      /**
       * `bots.brain`. Omitted and `"builtin"` keep one in-process slot.
       * A command array spawns the fill/balance child.
       */
      brain?: "builtin" | readonly string[];
      /** Command-slot restart window. Defaults to 1 s, doubling, cap 30 s. */
      brainRestartMinDelayMs?: number;
      brainRestartMaxDelayMs?: number;
      /**
       * Official pool brain (`DOORS_POOL_BRAIN_CMD`). Omitted keeps pool
       * pawns on the builtin slot with the community config.
       */
      poolBrain?: "builtin" | readonly string[];
    } = {},
  ) {
    this.players = players;
    this.hooks = hooks;
    this.fill = {
      minPlayers: options.fill?.minPlayers ?? DEFAULT_BOT_FILL.minPlayers,
      noBotsOnEmptyServer: options.fill?.noBotsOnEmptyServer ??
        DEFAULT_BOT_FILL.noBotsOnEmptyServer,
    };
    this.difficulty = options.difficulty ?? DEFAULT_BOT_DIFFICULTY;
    this.autoFillEnabled = options.autoFill !== false;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.rand = options.rand ?? Math.random;
    this.mirrorRoll = options.mirrorRoll ?? this.rand;
    this.botIdFactory = options.botIdFactory ?? null;
    this.idSuffix = options.idSuffix ?? (() => crypto.randomUUID().slice(0, 8));
    this.thoughtCodecLoop = options.thoughtCodecLoop === true;
    this.compiledThoughtEngine = options.compiledThoughtEngine ?? null;
    this.compiledThoughtMode = options.compiledThoughtMode ?? "shadow";
    this.compiledThoughtHost = options.compiledThoughtHost ?? "scriptc";
    this.thoughtEngine = options.thoughtEngine === undefined
      ? (this.compiledThoughtEngine !== null &&
          this.compiledThoughtMode === "compiled"
        ? null
        : createBotThinkEngine())
      : options.thoughtEngine;
    this.brainSlots.set("builtin", {
      id: "builtin",
      thoughtEngine: this.thoughtEngine,
      compiled: this.compiledThoughtEngine,
    });
    const command = commandFromBrain(options.brain);
    if (command === null) {
      this.commandPipeline = null;
    } else {
      const pipeline = DenoCompiledBotThinkPipeline.start(command[0]!, {
        info: (message) => console.log(message),
        warn: (message) => console.warn(message),
      }, {
        args: command.slice(1),
        restartMinDelayMs: options.brainRestartMinDelayMs ??
          COMMAND_RESTART_MIN_DELAY_MS,
        restartMaxDelayMs: options.brainRestartMaxDelayMs ??
          COMMAND_RESTART_MAX_DELAY_MS,
      });
      this.commandPipeline = pipeline;
      this.brainSlots.set("command", {
        id: "command",
        thoughtEngine: null,
        compiled: pipeline,
      });
    }
    const poolCommand = commandFromBrain(options.poolBrain);
    if (poolCommand === null) {
      this.poolPipeline = null;
    } else {
      const pipeline = DenoCompiledBotThinkPipeline.start(poolCommand[0]!, {
        info: (message) => console.log(message),
        warn: (message) => console.warn(message),
      }, {
        args: poolCommand.slice(1),
        restartMinDelayMs: options.brainRestartMinDelayMs ??
          COMMAND_RESTART_MIN_DELAY_MS,
        restartMaxDelayMs: options.brainRestartMaxDelayMs ??
          COMMAND_RESTART_MAX_DELAY_MS,
      });
      this.poolPipeline = pipeline;
      this.brainSlots.set("pool", {
        id: "pool",
        thoughtEngine: null,
        compiled: pipeline,
      });
    }
  }

  /**
   * Install the match `agents` domain stream (epic 4.6). Called from
   * GameServer's sim-RNG reseed listener. Also clears the first-door latch so
   * a new match does not inherit the previous match's alternation state.
   */
  public setAgentsRandom(rng: () => number): void {
    this.agentsRandom = rng;
    this.nextAgentDoor = null;
  }

  /** Current agents-domain RNG (tests / Chunk 4 wiring). */
  public getAgentsRandom(): () => number {
    return this.agentsRandom;
  }

  /**
   * Turn churn on or off. Null zeros the offset. Enabling from off leaves
   * the next {@link tickChurn} to roll the delays.
   */
  public setChurnPolicy(policy: ChurnPolicy | null): void {
    const was = this.churnPolicy;
    this.churnPolicy = policy;
    if (!policy) {
      this.churnOffset = 0;
      this.churnInitialized = false;
      return;
    }
    if (!was) this.churnInitialized = false;
  }

  public setVoteSeedPolicy(policy: VoteSeedPolicy | null): void {
    this.voteSeed = policy;
  }

  public voteSeedPolicy(): VoteSeedPolicy | null {
    return this.voteSeed;
  }

  public setPoolCap(cap: number): void {
    this.poolCap = Math.max(0, Math.floor(cap));
    while (this.pool.length > this.poolCap) {
      const dropped = this.pool.pop();
      if (!dropped) break;
      this.emitPool({
        type: "identity-dropped",
        identityId: dropped.identity.id,
        reason: "pool-full",
      });
    }
  }

  public setPoolListener(listener: ((event: PoolRosterEvent) => void) | null): void {
    this.poolListener = listener;
  }

  public putPoolIdentities(identities: readonly PoolIdentity[]): {
    accepted: string[];
    dropped: { id: string; reason: IdentityDropReason }[];
  } {
    this.sweepTakenPoolNames();
    const accepted: string[] = [];
    const dropped: { id: string; reason: IdentityDropReason }[] = [];
    const seen = new Set(this.pool.map((row) => row.identity.id));
    for (const bot of this.bots.values()) {
      if (bot.poolIdentityId) seen.add(bot.poolIdentityId);
    }
    const queuedNames = new Set(
      this.pool.map((row) => row.identity.name.toLocaleLowerCase()),
    );
    for (const identity of identities) {
      if (seen.has(identity.id)) {
        accepted.push(identity.id);
        continue;
      }
      if (this.pool.length >= this.poolCap) {
        dropped.push({ id: identity.id, reason: "pool-full" });
        continue;
      }
      const nameKey = identity.name.toLocaleLowerCase();
      if (
        queuedNames.has(nameKey) || this.players.isNameTaken(identity.name)
      ) {
        dropped.push({ id: identity.id, reason: "name-taken" });
        continue;
      }
      queuedNames.add(nameKey);
      seen.add(identity.id);
      this.pool.push({ identity });
      accepted.push(identity.id);
    }
    this.swapFillForPool();
    return { accepted, dropped };
  }

  /**
   * Official boot fills with `botN` before the director's first put lands
   * (`noBotsOnEmptyServer: false`), and fill pawns otherwise live for the
   * whole runtime. While no human can see it, swap each `botN` for a queued
   * identity. The count stays the same.
   */
  private swapFillForPool(): void {
    if (this.pool.length === 0 || this.raidMode) return;
    if (this.players.humanCount() > 0) return;
    for (const bot of [...this.bots.values()]) {
      if (this.pool.length === 0) return;
      if (bot.role !== "fill") continue;
      // The freed slot leaves its team lighter, so the new pawn lands there.
      this.removeBotById(bot.playerId, "churn");
      if (!this.addOneBot()) return;
    }
  }

  public setPawnPing(pawnId: string, pingMs: number): void {
    const bot = this.bots.get(pawnId);
    if (!bot || bot.role !== "pool") return;
    const player = this.players.get(pawnId);
    if (!player) return;
    player.pingMs = Math.max(0, Math.min(9999, Math.round(pingMs)));
  }

  /** Live fill pawns that took a pool identity. Balance and `botN` are omitted. */
  public poolPawnIds(): string[] {
    const ids: string[] = [];
    for (const bot of this.bots.values()) {
      if (bot.role === "pool") ids.push(bot.playerId);
    }
    return ids;
  }

  /** Last ReadyAction released into the apply pipe for this pawn. */
  public lastReadyAction(playerId: string): ReadyAction | null {
    return this.getManaged(playerId)?.lastAppliedAction ?? null;
  }

  /** Pid of the fill/balance child, when `bots.brain` is a command. */
  public commandBrainPid(): number | undefined {
    return this.commandPipeline?.pid();
  }

  /** Pid of the official pool child, when `DOORS_POOL_BRAIN_CMD` is set. */
  public poolBrainPid(): number | undefined {
    return this.poolPipeline?.pid();
  }

  /** Resolves when command results dispatched so far have been accepted or dropped. */
  public commandBrainSettled(): Promise<void> {
    return this.commandInFlight;
  }

  /** Resolves when pool results dispatched so far have been accepted or dropped. */
  public poolBrainSettled(): Promise<void> {
    return this.poolInFlight;
  }

  /** Stop the fill/balance child. Builtin engines are not touched. */
  public closeCommandBrain(): Promise<void> {
    return this.commandPipeline?.close() ?? Promise.resolve();
  }

  /** Stop the official pool child. Builtin engines are not touched. */
  public closePoolBrain(): Promise<void> {
    return this.poolPipeline?.close() ?? Promise.resolve();
  }

  public get count(): number {
    return this.bots.size;
  }

  /** Autofill / pool pawns only (excludes the temporary balance filler). */
  public get fillBotCount(): number {
    let n = 0;
    for (const bot of this.bots.values()) {
      if (!bot.isBalanceBot) n++;
    }
    return n;
  }

  /** True when the temporary uneven-team "bot" is on the roster. */
  public hasBalanceBot(): boolean {
    return this.findBalanceBot() !== null;
  }

  /** Living + managed grey agents (not team autofill bots). */
  public get agentCount(): number {
    return this.agents.size;
  }

  public get minPlayers(): number {
    return this.fill.minPlayers;
  }

  public getDifficulty(): BotDifficulty {
    return this.difficulty;
  }

  /**
   * Change difficulty for future spawns. Existing bots keep their current config
   * until removed/replaced (call reconcile after clear if a full swap is needed).
   *
   * Agents pick up the new tier on their next spawn. Fill uses the pool
   * config, or {@link COMMUNITY_BOT_CONFIG} when the pool is empty.
   */
  public setDifficulty(difficulty: BotDifficulty): void {
    this.difficulty = difficulty;
  }

  public setMinPlayers(n: number): void {
    this.fill.minPlayers = Math.max(0, Math.floor(n));
  }

  public setNoBotsOnEmptyServer(enabled: boolean): void {
    this.fill.noBotsOnEmptyServer = enabled;
  }

  public getNoBotsOnEmptyServer(): boolean {
    return this.fill.noBotsOnEmptyServer;
  }

  public setAutoFill(enabled: boolean): void {
    this.autoFillEnabled = enabled;
  }

  public isAutoFillEnabled(): boolean {
    return this.autoFillEnabled;
  }

  public list(): BotSnapshotInfo[] {
    const out: BotSnapshotInfo[] = [];
    for (const bot of this.bots.values()) {
      const p = this.players.get(bot.playerId);
      if (!p) continue;
      out.push({
        id: p.id,
        name: p.name,
        team: p.team,
        brainId: bot.pipelineConfig.id,
      });
    }
    for (const bot of this.agents.values()) {
      const p = this.players.get(bot.playerId);
      if (!p) continue;
      out.push({
        id: p.id,
        name: p.name,
        team: p.team,
        brainId: bot.pipelineConfig.id,
      });
    }
    return out;
  }

  /**
   * Autofill base before churn/CLI offsets (minPlayers − humans).
   */
  public autofillBase(humanCount = this.players.humanCount()): number {
    if (humanCount <= 0 && this.fill.noBotsOnEmptyServer) return 0;
    if (!this.autoFillEnabled) return 0;
    return Math.max(0, this.fill.minPlayers - humanCount);
  }

  /**
   * Desired bot count given current humans.
   * With noBotsOnEmptyServer, 0 humans → 0 bots. Otherwise auto-fill to
   * minPlayers (including on an empty server when that flag is false),
   * adjusted by manualExtra + churnOffset (authentic).
   */
  public desiredBotCount(humanCount = this.players.humanCount()): number {
    if (humanCount <= 0 && this.fill.noBotsOnEmptyServer) return 0;
    if (!this.autoFillEnabled) {
      return Math.max(0, this.manualExtra + this.churnOffset);
    }
    const auto = this.autofillBase(humanCount);
    return Math.max(0, auto + this.manualExtra + this.churnOffset);
  }

  /**
   * Reconcile bot roster with the fill policy.
   * Safe to call every tick or only on join/leave — idempotent.
   * Respects maxPlayers: never grows past free slots.
   *
   * After autofill, ensures a single named balance bot (`"bot"`) is present
   * only while team totals (humans + pool pawns + fillers) are uneven.
   */
  public reconcile(maxPlayers: number): void {
    if (this.raidMode) return;
    const humans = this.players.humanCount();

    // Empty server with default policy: drop offset so bots stay gone.
    if (humans <= 0 && this.fill.noBotsOnEmptyServer) {
      this.manualExtra = 0;
      this.churnOffset = 0;
      // No humans → no grey agents either.
      if (this.agents.size > 0) this.clearAgents();
    }

    this.clampChurnOffset(humans, maxPlayers);

    let desired = this.desiredBotCount(humans);

    // Cap so humans + team bots never exceed the server hard limit.
    // Agents are over-roster and do not consume bot fill slots.
    // Reserve one slot for the balance bot when teams are uneven so autofill
    // does not crowd it out.
    const freeForBots = Math.max(0, maxPlayers - humans);
    const reserveBalance = this.teamsUnevenExcludingBalance() ? 1 : 0;
    const freeForFill = Math.max(0, freeForBots - reserveBalance);
    desired = Math.min(desired, freeForFill);

    while (this.fillBotCount > desired) {
      this.removeOneBot();
    }
    while (this.fillBotCount < desired) {
      if (!this.addOneBot()) break;
    }

    this.reconcileBalanceBot(maxPlayers);

    // Snap offset to whatever we actually have (handles maxPlayers cap).
    this.syncManualExtra(humans);
  }

  /**
   * Independent leave/join churn for authentic open servers.
   * Call from the game loop with wall-clock ms. Bot count stays base ± 1.
   */
  public tickChurn(maxPlayers: number, nowMs = this.nowMs()): void {
    if (!this.churnPolicy) return;
    const humans = this.players.humanCount();
    if (humans <= 0 && this.fill.noBotsOnEmptyServer) {
      this.churnOffset = 0;
      this.churnInitialized = false;
      return;
    }

    if (!this.churnInitialized) {
      this.nextLeaveAtMs = nowMs + this.rollChurnDelayMs();
      this.nextJoinAtMs = nowMs + this.rollChurnDelayMs();
      this.churnInitialized = true;
    }

    let dirty = false;
    if (nowMs >= this.nextLeaveAtMs) {
      if (this.tryChurnLeave(humans, maxPlayers)) dirty = true;
      this.nextLeaveAtMs = nowMs + this.rollChurnDelayMs();
    }
    if (nowMs >= this.nextJoinAtMs) {
      if (this.tryChurnJoin(humans, maxPlayers)) dirty = true;
      this.nextJoinAtMs = nowMs + this.rollChurnDelayMs();
    }
    if (dirty) this.reconcile(maxPlayers);
  }

  /**
   * After a human joins the roster.
   * Community: snap to exact autofill target.
   * Churn policy on: keep bots within autofill base ± band; only
   * `humanMirrorChance` of the time also drop a bot (never below base − band).
   *
   * When an admission batch is active (S9-PR3), churn/policy is updated but
   * fill+balance reconcile is deferred until {@link finishAdmissionBatch}.
   */
  public onHumanJoined(maxPlayers: number): void {
    this.onHumanRosterChange(maxPlayers, "join");
  }

  /**
   * After a human leaves the roster.
   * Community: snap to exact autofill target.
   * Churn policy on: keep bots within autofill base ± band; only
   * `humanMirrorChance` of the time also add a bot (never above base + band).
   *
   * Leaves always reconcile immediately (and close any open admission batch)
   * so a mid-batch disconnect does not leave the bot roster stale.
   */
  public onHumanLeft(maxPlayers: number): void {
    if (this.admissionBatchActive) {
      // Collapse the wave so the leave path applies fill/balance once.
      this.admissionBatchActive = false;
      this.deferredReconcilePending = true;
    }
    this.onHumanRosterChange(maxPlayers, "leave");
  }

  /**
   * Open a multi-seat admission wave. Human joins update churn but do not
   * reconcile fill/balance until {@link finishAdmissionBatch}.
   * Idempotent while a wave is already open.
   */
  public startAdmissionBatch(): void {
    if (this.admissionBatchActive) return;
    this.admissionBatchActive = true;
    this.admissionBatchEvicted = 0;
    this.deferredReconcilePending = false;
  }

  public isAdmissionBatchActive(): boolean {
    return this.admissionBatchActive;
  }

  /** Ordinary bots evicted so far in the open admission batch (tests/metrics). */
  public admissionBatchEvictedCount(): number {
    return this.admissionBatchEvicted;
  }

  /**
   * Attribute pre-seat bot removals (e.g. middleware free-slot work before the
   * admission wave opened) to the current batch metrics report.
   */
  public noteAdmissionEvictions(n: number): void {
    const count = Math.max(0, Math.floor(n));
    if (count === 0) return;
    if (this.admissionBatchActive) {
      this.admissionBatchEvicted += count;
    }
  }

  /**
   * End the admission wave and run a single fill + balance reconcile.
   * Safe to call when no batch is open (still reconciles if needed).
   */
  public finishAdmissionBatch(maxPlayers: number): BotAdmissionReconcileReport {
    const wasActive = this.admissionBatchActive;
    const evicted = this.admissionBatchEvicted;
    this.admissionBatchActive = false;
    this.admissionBatchEvicted = 0;
    // Always settle once at batch end so balance filler matches final teams.
    if (wasActive || this.deferredReconcilePending) {
      // Bulk seat eviction runs while the pre-join autofill base is still high
      // (e.g. 0 humans → minPlayers). That would leave a large negative
      // manualExtra and wipe every fill bot after the party seats. Human seat
      // claims are not CLI `bots remove` debt — clear it and keep only
      // authentic churnOffset from deferred onHumanJoined mirrors.
      this.manualExtra = 0;
      this.reconcile(maxPlayers);
    }
    this.deferredReconcilePending = false;
    return this.admissionReconcileReport(evicted);
  }

  /** Build a metrics snapshot (also usable after a one-shot reconcile). */
  public admissionReconcileReport(
    botsEvicted = 0,
  ): BotAdmissionReconcileReport {
    const balance = this.findBalanceBot();
    const balancePlayer = balance
      ? this.players.get(balance.playerId)
      : undefined;
    return {
      botsEvicted,
      fillBotCount: this.fillBotCount,
      balanceBot: balance != null,
      balanceBotTeam: balancePlayer?.team ?? null,
      teamCounts: this.players.teamCounts(),
      humanCount: this.players.humanCount(),
      humanTeamCounts: this.players.humanTeamCounts(),
    };
  }

  /** @internal tests */
  public getChurnOffset(): number {
    return this.churnOffset;
  }

  private onHumanRosterChange(
    maxPlayers: number,
    kind: "join" | "leave",
  ): void {
    this.sweepTakenPoolNames();
    const defer = this.admissionBatchActive && kind === "join";
    const policy = this.churnPolicy;

    if (!policy) {
      if (defer) {
        this.deferredReconcilePending = true;
        return;
      }
      this.reconcile(maxPlayers);
      return;
    }

    const humans = this.players.humanCount();
    if (humans <= 0 && this.fill.noBotsOnEmptyServer) {
      this.churnOffset = 0;
      this.manualExtra = 0;
      if (defer) {
        this.deferredReconcilePending = true;
        return;
      }
      this.reconcile(maxPlayers);
      return;
    }

    const band = policy.band;
    const prevHumans = kind === "join" ? Math.max(0, humans - 1) : humans + 1;
    const prevCenter = this.autofillBase(prevHumans) + this.manualExtra;
    const prevCount = this.fillBotCount;
    const wasAtMin = prevCount <= Math.max(0, prevCenter - band);
    const wasAtMax = prevCount >= prevCenter + band;

    const base = this.autofillBase(humans);
    const center = base + this.manualExtra;
    const floor = Math.max(0, center - band);
    const ceil = center + band;

    let target = prevCount;

    if (target === 0 && center > 0 && kind === "join") {
      target = center;
    } else {
      if (target < floor) target = floor;
      if (target > ceil) target = ceil;
    }

    if (this.mirrorRoll() < policy.humanMirrorChance) {
      if (kind === "join" && target > floor && !wasAtMin) {
        target -= 1;
      } else if (kind === "leave" && target < ceil && !wasAtMax) {
        target += 1;
      }
    }

    this.churnOffset = Math.max(-band, Math.min(band, target - center));
    if (defer) {
      this.deferredReconcilePending = true;
      return;
    }
    this.reconcile(maxPlayers);
  }

  private rollChurnDelayMs(): number {
    // Only tickChurn calls this, and it returns early without a policy.
    const min = this.churnPolicy?.minDelayMs ?? 0;
    const max = Math.max(min, this.churnPolicy?.maxDelayMs ?? 0);
    const span = max - min;
    return min + Math.floor(this.rand() * (span + 1));
  }

  private tryChurnLeave(humanCount: number, maxPlayers: number): boolean {
    const band = this.churnPolicy?.band ?? 0;
    const base = this.autofillBase(humanCount);
    const floor = Math.max(0, base + this.manualExtra - band);
    if (this.fillBotCount <= floor) return false;
    if (this.churnOffset > -band) {
      this.churnOffset -= 1;
      return true;
    }
    void maxPlayers;
    return false;
  }

  private tryChurnJoin(humanCount: number, maxPlayers: number): boolean {
    const band = this.churnPolicy?.band ?? 0;
    const base = this.autofillBase(humanCount);
    const ceil = base + this.manualExtra + band;
    const free = Math.max(
      0,
      maxPlayers - humanCount - this.bots.size,
    );
    if (free <= 0) return false;
    if (this.fillBotCount >= ceil) return false;
    if (this.churnOffset < band) {
      this.churnOffset += 1;
      return true;
    }
    return false;
  }

  /** Keep churnOffset so desired stays in [base-1, base+1] (plus manualExtra). */
  /** Keep churnOffset inside the policy band (plus manualExtra at reconcile). */
  private clampChurnOffset(humanCount: number, maxPlayers: number): void {
    const band = this.churnPolicy?.band ?? 0;
    if (!this.churnPolicy) {
      this.churnOffset = 0;
      return;
    }
    this.churnOffset = Math.max(-band, Math.min(band, this.churnOffset));
    const base = this.autofillBase(humanCount);
    const freeForBots = Math.max(0, maxPlayers - humanCount);
    void freeForBots;
    void base;
  }

  /**
   * Manually add `n` bots (CLI: `bots add n`).
   * Bumps the signed offset so auto-fill keeps the extras while humans remain.
   */
  public addBots(n: number, maxPlayers: number): number {
    const count = Math.max(0, Math.floor(n));
    if (count === 0) return 0;
    this.manualExtra += count;
    const before = this.fillBotCount;
    this.reconcile(maxPlayers);
    return Math.max(0, this.fillBotCount - before);
  }

  /**
   * Manually remove up to `n` bots (CLI: `bots remove n`).
   * Lowers the signed offset so auto-fill does not instantly re-add them.
   */
  public removeBots(n: number, maxPlayers: number): number {
    const count = Math.max(0, Math.floor(n));
    if (count === 0) return 0;

    this.manualExtra -= count;
    const before = this.fillBotCount;
    this.reconcile(maxPlayers);
    return Math.max(0, before - this.fillBotCount);
  }

  /**
   * Admin kick for a managed bot (fill / seed / balance / agent).
   * Fill bots lower manualExtra so autofill does not immediately re-spawn.
   * Balance bot / agents are removed only (balance may reappear on next reconcile
   * if teams stay uneven — caller may skip reconcile if desired).
   */
  public kickBot(playerId: string): boolean {
    if (this.agents.has(playerId)) {
      return this.removeAgentById(playerId);
    }
    const managed = this.bots.get(playerId);
    if (!managed) return false;
    if (!managed.isBalanceBot) {
      // Keep autofill from instantly replacing this slot.
      this.manualExtra -= 1;
    }
    return this.removeBotById(playerId, "rebalance");
  }

  /**
   * Evict up to `n` ordinary fill / pool pawns to free seats for human joins.
   * Prefer `preferredTeam` (the team humans are about to join) so body counts
   * stay balanced. Never removes grey agents. Balance filler is last resort
   * (same preference order as single-slot eviction).
   * Adjusts the offset so autofill does not immediately re-spawn into full.
   * Returns how many bots were actually removed.
   */
  public tryEvict(n: number, preferredTeam?: TeamId): number {
    const want = Math.max(0, Math.floor(n));
    if (want === 0 || this.bots.size === 0) return 0;

    let removed = 0;
    for (let i = 0; i < want; i++) {
      if (this.bots.size === 0) break;
      // Prefer ordinary fill bots; balance is only removed if nothing else left.
      if (!this.removeOneBot(preferredTeam, "eviction")) break;
      this.manualExtra -= 1;
      removed++;
    }
    if (removed > 0) {
      this.syncManualExtra(this.players.humanCount());
      if (this.admissionBatchActive) {
        this.admissionBatchEvicted += removed;
      }
    }
    return removed;
  }

  /**
   * Evict one bot to free a slot for a human join. Returns true if a bot left.
   * Prefer `preferredTeam` (the team the human is about to join) so the human
   * replaces a same-team bot and rosters stay balanced.
   * Adjusts the offset so we do not immediately re-spawn into a full server.
   */
  public tryEvictOne(preferredTeam?: TeamId): boolean {
    return this.tryEvict(1, preferredTeam) === 1;
  }

  /**
   * Keep manualExtra consistent with current bot count, auto target, and churn.
   * actual ≈ auto + manualExtra + churnOffset
   */
  private syncManualExtra(humanCount: number): void {
    if (humanCount <= 0 && this.fill.noBotsOnEmptyServer) {
      this.manualExtra = 0;
      this.churnOffset = 0;
      return;
    }
    // Balance bot is outside the autofill / CLI offset accounting.
    const fillCount = this.fillBotCount;
    if (!this.autoFillEnabled) {
      this.manualExtra = fillCount - this.churnOffset;
      return;
    }
    const auto = this.autofillBase(humanCount);
    this.manualExtra = fillCount - auto - this.churnOffset;
  }

  private findBalanceBot(): ManagedBot | null {
    for (const bot of this.bots.values()) {
      if (bot.isBalanceBot) return bot;
    }
    return null;
  }

  /**
   * Team totals excluding the temporary balance filler (and agents).
   * Evenness is judged without the balancer so add/drop does not oscillate.
   */
  private teamCountsExcludingBalance(): { A: number; B: number } {
    let A = 0;
    let B = 0;
    for (const p of this.players.all()) {
      if (p.isAgent || p.isBalanceBot) continue;
      if (p.team === "A") A++;
      else if (p.team === "B") B++;
    }
    return { A, B };
  }

  private teamsUnevenExcludingBalance(): boolean {
    const { A, B } = this.teamCountsExcludingBalance();
    return A !== B;
  }

  /**
   * Keep exactly one named `"bot"` on the lighter team while totals are uneven
   * (humans + pool pawns + regular fillers all count). Drop it when even.
   */
  private reconcileBalanceBot(maxPlayers: number): void {
    const humans = this.players.humanCount();
    if (humans <= 0 && this.fill.noBotsOnEmptyServer) {
      const existing = this.findBalanceBot();
      if (existing) this.removeBotById(existing.playerId);
      return;
    }

    const { A, B } = this.teamCountsExcludingBalance();
    const existing = this.findBalanceBot();

    if (A === B) {
      if (existing) this.removeBotById(existing.playerId);
      return;
    }

    const light: TeamId = A < B ? "A" : "B";

    if (existing) {
      const p = this.players.get(existing.playerId);
      if (!p) {
        this.bots.delete(existing.playerId);
      } else if (p.team !== light) {
        // Flip to the lighter side (same path as rebalanceBotTeams).
        p.team = light;
        p.respawn(this.players.spawnFor(light), this.players.tick);
      }
      return;
    }

    // Need a free non-agent slot.
    if (this.players.nonAgentCount() >= maxPlayers) return;
    // Name must be free (human may have claimed "bot").
    if (this.players.isNameTaken(BALANCE_BOT_NAME)) return;

    this.spawnBalanceBot(light);
  }

  private spawnBalanceBot(team: TeamId): boolean {
    const id = `${BALANCE_BOT_ID_PREFIX}${this.idSuffix()}`;
    return this.spawnManagedBot(id, 0, {
      name: BALANCE_BOT_NAME,
      pipelineConfig: BALANCE_BOT_CONFIG,
      addBotOpts: {
        isBalanceBot: true,
        team,
        equipment: defaultPlayerEquipment(),
        ownedAbilities: [],
        skillLoadout: emptySkillLoadout(),
      },
      isBalanceBot: true,
    });
  }

  private raidMode = false;
  private readonly raidBotIds = new Set<string>();
  private raidWaveSpawn: {
    count: number;
    spawned: number;
    team: TeamId;
    nextSpawnTick: number;
  } | null = null;
  private raidMiniWaveSpawn: {
    count: number;
    spawned: number;
    team: TeamId;
    nextSpawnTick: number;
    maxHealth: number;
    modelScale: number;
    moveSpeedScale: number;
  } | null = null;

  public setRaidMode(on: boolean): void {
    this.raidMode = on;
    if (!on) this.clearRaidBots();
  }

  /**
   * Spawn a directed raid bot that does not pick a balanced team.
   * Names stay unique (`bot`, `bot2`, …) because `"bot"` is reserved once.
   */
  public addDirectedBot(
    id: string,
    name: string,
    team: TeamId,
    modifiers?: {
      maxHealth?: number;
      modelScale?: number;
      moveSpeedScale?: number;
      /** Bosses keep advancing instead of receiving the random raid pauses. */
      allowRandomStops?: boolean;
    },
  ): boolean {
    if (this.players.get(id) || this.players.isNameTaken(name)) return false;
    const player = this.players.addBot(id, name, {
      team,
      isRaidBot: true,
      equipment: defaultPlayerEquipment(),
      ownedAbilities: [],
      skillLoadout: emptySkillLoadout(),
      maxHealth: modifiers?.maxHealth,
      modelScale: modifiers?.modelScale,
      moveSpeedScale: modifiers?.moveSpeedScale,
    });
    const managed: ManagedBot = {
      playerId: player.id,
      nameIndex: 0,
      role: "raid",
      pipelineConfig: modifiers?.allowRandomStops === false
        ? RAID_NO_STOPS_BOT_CONFIG
        : RAID_BOT_CONFIG,
      sequence: 0,
      readyDelayQueue: [],
    };
    this.bots.set(player.id, managed);
    this.raidBotIds.add(player.id);
    this.hooks.onBotJoined?.(player);
    return true;
  }

  public clearRaidBots(): void {
    this.raidWaveSpawn = null;
    this.raidMiniWaveSpawn = null;
    for (const id of [...this.raidBotIds]) {
      this.removeBotById(id);
      this.raidBotIds.delete(id);
    }
  }

  /** Replace the enemy roster, spawning at most two immediately and per 2s. */
  public setRaidWave(n: number, team: TeamId): void {
    this.clearRaidBots();
    const count = Math.max(0, Math.floor(n));
    if (count === 0) return;
    this.raidWaveSpawn = {
      count,
      spawned: 0,
      team,
      nextSpawnTick: this.players.tick,
    };
    this.spawnNextRaidPair(this.players.tick);
  }

  /** Replace the normal wave with an immediately spawned raid boss roster. */
  public setRaidBossWave(
    count: number,
    team: TeamId,
    modifiers: {
      maxHealth: number;
      modelScale: number;
      moveSpeedScale: number;
    },
  ): void {
    this.clearRaidBots();
    const n = Math.max(0, Math.floor(count));
    for (let i = 1; i <= n; i++) {
      const name = i === 1 ? "bot" : `bot${i}`;
      this.addDirectedBot(
        `bot:raid-boss-${i}`,
        name,
        team,
        { ...modifiers, allowRandomStops: false },
      );
    }
  }

  /** Replace the enemy roster with staggered fragile, fast mini bots. */
  public setRaidMiniWave(
    count: number,
    team: TeamId,
    modifiers: RaidMiniModifiers,
  ): void {
    this.clearRaidBots();
    this.startRaidMiniWave(count, team, modifiers);
  }

  private startRaidMiniWave(
    count: number,
    team: TeamId,
    modifiers: RaidMiniModifiers,
  ): void {
    const n = Math.max(0, Math.floor(count));
    if (n === 0) return;
    this.raidMiniWaveSpawn = {
      count: n,
      spawned: 0,
      team,
      nextSpawnTick: this.players.tick,
      maxHealth: modifiers.maxHealth,
      modelScale: modifiers.modelScale,
      moveSpeedScale: modifiers.moveSpeedScale,
    };
    this.spawnNextRaidMiniPair(this.players.tick);
  }

  /**
   * Replace the enemy roster with a mixed raid wave: bosses arrive
   * immediately while normals and minis stagger in. One clear up front so
   * the sub-spawns never wipe each other. Kind-prefixed names keep the
   * shared scoreboard namespace collision-free.
   */
  public setRaidMixedWave(
    team: TeamId,
    spec: {
      normals: number;
      minis?: { count: number } & RaidMiniModifiers;
      bosses?: { count: number } & RaidMiniModifiers;
    },
  ): void {
    this.clearRaidBots();
    const bossModifiers = spec.bosses;
    const bossCount = Math.max(0, Math.floor(bossModifiers?.count ?? 0));
    for (let i = 1; i <= bossCount; i++) {
      const name = i === 1 ? "boss" : `boss${i}`;
      this.addDirectedBot(
        `bot:raid-boss-${i}`,
        name,
        team,
        {
          maxHealth: bossModifiers?.maxHealth ?? 200,
          modelScale: bossModifiers?.modelScale ?? 1.3,
          moveSpeedScale: bossModifiers?.moveSpeedScale ?? 0.65,
          allowRandomStops: false,
        },
      );
    }
    const normalCount = Math.max(0, Math.floor(spec.normals));
    if (normalCount > 0) {
      this.raidWaveSpawn = {
        count: normalCount,
        spawned: 0,
        team,
        nextSpawnTick: this.players.tick,
      };
      this.spawnNextRaidPair(this.players.tick);
    }
    const miniModifiers = spec.minis;
    if (miniModifiers) {
      this.startRaidMiniWave(miniModifiers.count, team, miniModifiers);
    }
  }

  private spawnNextRaidPair(simTick: number): void {
    const wave = this.raidWaveSpawn;
    if (!wave || simTick < wave.nextSpawnTick) return;

    const end = Math.min(wave.count, wave.spawned + RAID_BOTS_PER_SPAWN);
    for (let i = wave.spawned + 1; i <= end; i++) {
      const name = i <= 1 ? "bot" : `bot${i}`;
      this.addDirectedBot(`bot:raid-${i}`, name, wave.team);
    }
    wave.spawned = end;
    if (wave.spawned >= wave.count) {
      this.raidWaveSpawn = null;
      return;
    }
    wave.nextSpawnTick = simTick + RAID_BOT_SPAWN_INTERVAL_TICKS;
  }

  private spawnNextRaidMiniPair(simTick: number): void {
    const wave = this.raidMiniWaveSpawn;
    if (!wave || simTick < wave.nextSpawnTick) return;

    const end = Math.min(wave.count, wave.spawned + RAID_BOTS_PER_SPAWN);
    for (let i = wave.spawned + 1; i <= end; i++) {
      const name = i <= 1 ? "mini" : `mini${i}`;
      this.addDirectedBot(`bot:raid-mini-${i}`, name, wave.team, {
        maxHealth: wave.maxHealth,
        modelScale: wave.modelScale,
        moveSpeedScale: wave.moveSpeedScale,
      });
    }
    wave.spawned = end;
    if (wave.spawned >= wave.count) {
      this.raidMiniWaveSpawn = null;
      return;
    }
    wave.nextSpawnTick = simTick + RAID_BOT_SPAWN_INTERVAL_TICKS;
  }

  /**
   * Last think-phase wall time (ms) from {@link thinkAll} / {@link tick}.
   * NON-SIM metering for bot budget diagnostics — must never feed resolution.
   */
  public lastThinkMs = 0;
  public lastThinkBots = 0;
  private thinkBatchesTotal = 0;
  private thinkBotsTotal = 0;
  /** NON-SIM cumulative think metering for /api/status averages. */
  private thinkMsTotal = 0;
  /**
   * Last apply-phase wall time (ms) from {@link applyReadyActions} / {@link tick}.
   * NON-SIM metering — must never feed Player / combat resolution.
   */
  public lastApplyMs = 0;
  /**
   * Last bot-tick for which each bot completed a think (or compiled hold).
   * Prevents double-think when the same phase is re-entered; shards skip bots
   * already done for the current bot period.
   */
  private lastThoughtBotTick = new Map<string, number>();

  public get softSlots(): number {
    return 0;
  }

  /**
   * Bot AI diagnostics for /api/status and admin.
   */
  public getBotThinkMetrics(
    _opts: { consumeSnapshot?: boolean } = {},
  ): BotThinkMetrics {
    const lastApplyMs = roundMs(this.lastApplyMs);
    const lastThinkMs = roundMs(this.lastThinkMs);
    const compiled = this.compiledThoughtEngine?.snapshot() ?? null;
    const runtime: BotThinkMetrics["runtime"] = this.compiledThoughtEngine
      ? (this.compiledThoughtHost === "deno"
        ? (this.compiledThoughtMode === "compiled"
          ? "pipeline-compiled-deno"
          : "pipeline-compiled-deno-shadow")
        : (this.compiledThoughtHost === "perry"
          ? (this.compiledThoughtMode === "compiled"
            ? "pipeline-compiled-perry"
            : "pipeline-compiled-perry-shadow")
          : (this.compiledThoughtMode === "compiled"
            ? "pipeline-compiled"
            : "pipeline-compiled-shadow")))
      : this.thoughtCodecLoop
      ? "pipeline-js-codec"
      : "pipeline-js";

    return {
      runtime,
      softSlots: 0,
      softSlotsPeak: 0,
      softSlotsMax: THINK_BUFFER_BOT_TICKS,
      softOldestAge: null,
      lastFailureCount: 0,
      failureCountTotal: 0,
      lastApplyMs,
      lastThinkMs,
      lastThinkBots: this.lastThinkBots,
      thinkBatchesTotal: this.thinkBatchesTotal,
      meanThinkBatchMs: this.thinkBatchesTotal > 0
        ? roundMs(this.thinkMsTotal / this.thinkBatchesTotal)
        : 0,
      meanThinkMsPerBot: this.thinkBotsTotal > 0
        ? Math.round((this.thinkMsTotal / this.thinkBotsTotal) * 10_000) /
          10_000
        : 0,
      lastBotsTotalMs: roundMs(this.lastApplyMs + this.lastThinkMs),
      stepCpu: null,
      shadowLook: null,
      compiledPipeline: compiled === null ? null : {
        mode: this.compiledThoughtMode,
        status: compiled.status,
        engineVersion: compiled.engineVersion,
        samples: this.compiledSamples,
        exactMatches: this.compiledExactMatches,
        withinOneDegree: this.compiledWithinOneDegree,
        withinFiveDegrees: this.compiledWithinFiveDegrees,
        withinTenDegrees: this.compiledWithinTenDegrees,
        discreteMismatches: this.compiledDiscreteMismatches,
        keyMismatches: this.compiledKeyMismatches,
        shootMismatches: this.compiledShootMismatches,
        mismatches: this.compiledMismatches,
        meanAbsYawDeltaRad: this.compiledSamples > 0
          ? this.compiledAbsYawDeltaTotal / this.compiledSamples
          : 0,
        maxAbsYawDeltaRad: this.compiledMaxAbsYawDelta,
        meanAbsPitchDeltaRad: this.compiledSamples > 0
          ? this.compiledAbsPitchDeltaTotal / this.compiledSamples
          : 0,
        maxAbsPitchDeltaRad: this.compiledMaxAbsPitchDelta,
        compiledApplied: this.compiledApplied,
        compiledFallbacks: this.compiledFallbacks,
        compiledFallbackLate: this.compiledFallbackLate,
        compiledFallbackInvalid: this.compiledFallbackInvalid,
        compiledFallbackNull: this.compiledFallbackNull,
        compiledFallbackUnavailable: this.compiledFallbackUnavailable,
        inFlight: compiled.inFlight,
        transportErrors: compiled.errors,
        meanRoundTripMs: compiled.meanRoundTripMs,
        meanRequestBytes: compiled.meanRequestBytes,
        firstMismatch: this.compiledFirstMismatch,
        lastMismatch: this.compiledLastMismatch,
      },
      codecLoop: this.thoughtCodecLoop
        ? {
          samples: this.codecLoopSamples,
          mismatches: this.codecLoopMismatches,
          lastMismatch: this.codecLoopLastMismatch,
        }
        : null,
    };
  }

  private recordThinkPerformance(botCount: number): void {
    if (botCount <= 0) return;
    this.lastThinkBots = botCount;
    this.thinkBatchesTotal += 1;
    this.thinkBotsTotal += botCount;
    this.thinkMsTotal += this.lastThinkMs;
  }

  /**
   * Per-tick housekeeping: door-close agent drops.
   * Safe before apply and independent of the AI budget.
   * On intermission, bot controls release via think-emitted idle keys
   * (`BotWorldView.matchOver`, see the gate step) — not synthesized here.
   */
  public tickHousekeeping(tick: number, collision: MapCollision): void {
    if (this.players.isMatchOver()) {
      // A win can happen before a large wave has finished arriving.
      this.raidWaveSpawn = null;
      this.raidMiniWaveSpawn = null;
    } else {
      this.spawnNextRaidPair(tick);
      this.spawnNextRaidMiniPair(tick);
    }

    // Door-close agent drops (even if only agents remain managed).
    this.maybeSpawnAgentOnDoorClose(tick, collision);
  }

  /**
   * Full bot segment for offline sims / tests: housekeeping → **apply** →
   * flush → **think**. Matches the GameServer order with sim omitted between
   * apply and think.
   *
   * Production {@link GameServer} calls {@link tickHousekeeping},
   * {@link applyReadyActions}, then the Weapons-phase flush, then (after
   * sim/emit) {@link thinkAll} separately so AI stays off the critical path
   * and bot shots interleave with human shots by ascending shooter id
   * (PR 4 of the keys-only note) — see docs/game/bots.md §5. This
   * offline wrapper has no humans to interleave with, so apply → flush →
   * think in one call is equivalent.
   *
   * During intermission brains keep running: `matchOver` (see the gate step)
   * makes them emit idle keys, which drain the queue and hold controls
   * released the same as any other think output — no apply-time synthesis.
   */
  public tick(tick: number, collision: MapCollision): ShootOutcome[] {
    this.tickHousekeeping(tick, collision);

    if (this.bots.size === 0 && this.agents.size === 0) {
      this.lastThinkMs = 0;
      this.lastApplyMs = 0;
      return [];
    }

    // Apply delayed ReadyActions first (body), then budgeted AI (next delay slots).
    const nowMs = this.nowMs();
    const pending: PendingWeapon[] = [];
    this.applyReadyActions(tick, nowMs, (req) => pending.push(req));
    const { outcomes } = flushPendingWeapons(pending, this.players, tick, nowMs);
    this.thinkAll(tick, collision);
    return outcomes;
  }

  /**
   * Package-engine AI phase every **sim** tick: this phase's roster shard
   * (~1/{@link SIM_TICKS_PER_BOT_TICK} of bots). Each bot still thinks once
   * per bot period ({@link BOT_TICK_HZ}); load is spread instead of a phase-0 spike.
   * Completed actions enqueue at `thinkBotTick + THINK_BUFFER_BOT_TICKS`.
   *
   * Epic 4.7 phase `BotThink` (NON-SIM for resolution): production calls this
   * **after** sim/emit. Contract: `think(T) → apply(T + THINK_BUFFER_BOT_TICKS)`.
   * See players/DETERMINISTIC_SYSTEM_ORDERING.md and
   * pipeline/DETERMINISTIC_BOT_BOUNDARY.md.
   *
   * Does **not** touch PlayerManager inputs/shots.
   */
  public thinkAll(simTick: number, collision: MapCollision): void {
    if (this.commandPipeline || this.poolPipeline) {
      this.thinkAllWithCommandSlot(simTick, collision);
      return;
    }
    const t0 = performance.now();
    this.lastThinkBots = 0;
    const botTick = simToBotTick(simTick);
    this.synchronizeThoughtEngineRoster();

    if (this.bots.size === 0 && this.agents.size === 0) {
      this.lastThinkMs = 0;
      return;
    }

    const shardPreview = this.thinkShardIds(simTick, botTick);
    if (shardPreview.length === 0) {
      this.lastThinkMs = 0;
      return;
    }

    this.thinkPackageBatch(simTick, botTick, collision, shardPreview);
    this.lastThinkMs = performance.now() - t0;
    this.recordThinkPerformance(shardPreview.length);
  }

  /**
   * Cheap apply phase (every **sim** tick): release due ReadyActions (computed
   * {@link THINK_BUFFER_BOT_TICKS} bot ticks earlier), interpolate look between
   * ready samples, hold discrete keys, and run the shared apply pipe. Shot
   * intents forward to `enqueueWeapon`; resolution happens later in the
   * Weapons-phase flush shared with humans (PR 4) — this method itself
   * resolves nothing and returns no outcomes.
   *
   * Sole think→sim crossing for bots (epic 4.5) — see
   * pipeline/DETERMINISTIC_BOT_BOUNDARY.md. Iteration order is stable ascending
   * player/session id via {@link collectApplyRoster}. Do not mutate Player
   * fields here except via the apply pipe / PlayerManager.
   *
   * Does not run brains. Epic 4.7 phase `BotApply` (SIM): production calls this
   * **before** Weapons / MovePhysics; call {@link thinkAll} after sim/emit
   * (docs/game/bots.md §5). Named contract:
   * `think(T) → apply(T + THINK_BUFFER_BOT_TICKS)`.
   */
  public applyReadyActions(
    simTick: number,
    // Required for sim-step callers (epic 4.8). Offline/test helpers may pass
    // `this.nowMs()` or a fixed clock.
    nowMs: number,
    enqueueWeapon: (req: PendingWeapon) => void,
  ): void {
    if (this.bots.size === 0 && this.agents.size === 0) {
      this.lastApplyMs = 0;
      return;
    }

    const applyOne = (bot: ManagedBot): void => {
      const self = this.players.get(bot.playerId);
      if (!self || !self.isBot) return;

      if (bot.lifeSpawnedAtTick === undefined) {
        bot.lifeSpawnedAtTick = self.spawnedAtTick;
      } else if (bot.lifeSpawnedAtTick !== self.spawnedAtTick) {
        bot.lifeSpawnedAtTick = self.spawnedAtTick;
        // Spawn change drops stale queued slots only; Player.respawn already
        // nulled latestInput, so the driver never re-inputs for the new life.
        bot.readyDelayQueue.length = 0;
        bot.readyAction = null;
        bot.applyInterp = dropInterpOnSpawn();
      }
      if (!self.alive) {
        // Player.becomeDead already nulled latestInput; drop stale queued
        // slots so a later respawn doesn't replay pre-death keys.
        bot.readyDelayQueue.length = 0;
        bot.readyAction = null;
        bot.applyInterp = dropInterpOnSpawn();
        return;
      }

      const dueSlot = takeDueReadySlot(bot, simTick);
      const dueAction: ReadyAction | null = dueSlot !== null
        ? (dueSlot.action ?? { input: null })
        : null;

      const sampled = sampleTickAction({
        simTick,
        dueAction,
        applyInterp: bot.applyInterp ?? null,
        selfLook: { yaw: self.yaw, pitch: self.pitch },
      });
      bot.applyInterp = sampled.applyInterp;

      if (sampled.releasedCurr !== null) {
        bot.lastAppliedAction = sampled.releasedCurr;
        recordLastMove(this.lastMoves, bot.playerId, sampled.releasedCurr);
        bot.readyAction = sampled.releasedCurr;
      }

      const action = sampled.action;
      if (action) {
        bot.readyAction = action;
      }

      // No apply-time maneuver injection. If the think buffer has no ready
      // action this tick, the bot holds (interp / last slot) or idles — brains
      // own every key press via the delayed ReadyAction pipeline.
      if (!action) return;

      const applyCtx: ApplyContext = {
        tick: simTick,
        nowMs,
        bot,
        self,
        players: this.players,
        enqueueWeapon,
      };
      runApplyPipe(DEFAULT_APPLY_STEPS, applyCtx, action);
    };

    for (const bot of collectApplyRoster(this.bots.values(), this.agents.values())) {
      applyOne(bot);
    }

    // Apply duration metering moved out of the sim step (epic 4.8 Chunk 3).
    // Status still exposes lastApplyMs; leave 0 until a driver-side probe exists.
    this.lastApplyMs = 0;
  }

  /** Stable roster for a think job: team bots then agents. */
  private thinkRosterIds(): string[] {
    const ids: string[] = [];
    for (const bot of this.bots.values()) ids.push(bot.playerId);
    for (const bot of this.agents.values()) ids.push(bot.playerId);
    return ids;
  }

  /**
   * Phase shard for this sim tick: bots whose work slot matches the phase and
   * that have not already completed a think for {@link botTick}.
   */
  private thinkShardIds(simTick: number, botTick: number): string[] {
    const ids: string[] = [];
    for (const id of this.thinkRosterIds()) {
      if (!botThinksOnSimPhase(id, simTick)) continue;
      if (this.lastThoughtBotTick.get(id) === botTick) continue;
      const player = this.players.get(id);
      if (!player || !player.alive) continue;
      ids.push(id);
    }
    return ids;
  }

  /** Mark bot done for this think bot-tick (complete pipe or failure replay). */
  private markThoughtBotTick(botId: string, thinkBotTick: number): void {
    this.lastThoughtBotTick.set(botId, thinkBotTick);
  }

  private getManaged(playerId: string): ManagedBot | undefined {
    return this.bots.get(playerId) ?? this.agents.get(playerId);
  }

  private noteCodecLoop(
    message: string,
    original: unknown,
    decoded: unknown,
    tick: number,
  ): void {
    this.codecLoopSamples += 1;
    const path = findPipelineCodecDiff(
      original as PipelineCodecValue,
      decoded as PipelineCodecValue,
    );
    if (path === null) return;
    this.codecLoopMismatches += 1;
    this.codecLoopLastMismatch = { message, path, tick };
    if (this.codecLoopMismatches <= 5) {
      console.warn(
        `[bot-brain pipeline-js-codec] ${message} lost ${path} tick=${tick}`,
      );
    }
  }

  private codecLoopMap(
    map: BotMapDefinition,
    tick: number,
  ): BotMapDefinition {
    if (!this.thoughtCodecLoop) return map;
    const decoded = roundTripBotThinkPipelineRequest({
      type: "pipeline-load-map",
      requestId: 1,
      map,
    });
    if (decoded.type !== "pipeline-load-map") {
      this.noteCodecLoop("pipeline-load-map", map, decoded, tick);
      return map;
    }
    this.noteCodecLoop("pipeline-load-map", map, decoded.map, tick);
    return decoded.map;
  }

  private codecLoopBots(
    bots: readonly BotDefinition[],
  ): readonly BotDefinition[] {
    if (!this.thoughtCodecLoop) return bots;
    const decoded = roundTripBotThinkPipelineRequest({
      type: "pipeline-synchronize-bots",
      requestId: 1,
      bots,
    });
    // `config` is in-process only; the wire carries the profile it resolves from.
    const wire = bots.map(({ config: _config, ...bot }) => bot);
    if (decoded.type !== "pipeline-synchronize-bots") {
      this.noteCodecLoop("pipeline-synchronize-bots", wire, decoded, 0);
      return bots;
    }
    this.noteCodecLoop("pipeline-synchronize-bots", wire, decoded.bots, 0);
    return decoded.bots;
  }

  private codecLoopThinkInput(
    input: ThinkBatchInput,
    tick: number,
  ): ThinkBatchInput {
    if (!this.thoughtCodecLoop) return input;
    const decoded = roundTripBotThinkPipelineRequest({
      type: "pipeline-think-batch",
      requestId: 1,
      input,
    });
    if (decoded.type !== "pipeline-think-batch") {
      this.noteCodecLoop("pipeline-think-batch", input, decoded, tick);
      return input;
    }
    this.noteCodecLoop("pipeline-think-batch", input, decoded.input, tick);
    return decoded.input;
  }

  private codecLoopThinkOutput(
    output: ThinkBatchOutput,
    tick: number,
  ): ThinkBatchOutput {
    if (!this.thoughtCodecLoop) return output;
    const decoded = roundTripBotThinkPipelineResponse({
      type: "pipeline-think-batch-result",
      requestId: 1,
      output,
    });
    if (decoded.type !== "pipeline-think-batch-result") {
      this.noteCodecLoop("pipeline-think-batch-result", output, decoded, tick);
      return output;
    }
    this.noteCodecLoop(
      "pipeline-think-batch-result",
      output,
      decoded.output,
      tick,
    );
    return decoded.output;
  }

  /** Keep full per-bot config/state ownership inside the persistent engine. */
  private synchronizeThoughtEngineRoster(): void {
    // Pool-only hosts have no command child. They still need the per-slot roster,
    // or the pool process never sees its pawns and every think is dropped.
    if (this.commandPipeline || this.poolPipeline) {
      this.synchronizeBrainSlots();
      return;
    }
    if (!this.thoughtEngine && !this.compiledThoughtEngine) return;
    const definitions = this.brainDefinitions(this.bots.values(), this.agents.values());
    this.thoughtEngine?.synchronizeBots(this.codecLoopBots(definitions));
    this.compiledThoughtEngine?.synchronizeBots(definitions);
  }

  /** One roster per slot. Command hears fill and balance only. */
  private synchronizeBrainSlots(): void {
    const bySlot = new Map<BrainSlotId, BotDefinition[]>();
    for (const slotId of this.brainSlots.keys()) bySlot.set(slotId, []);
    const append = (managed: ManagedBot): void => {
      const definition = this.brainDefinition(managed);
      if (!definition) return;
      bySlot.get(this.brainSlotFor(managed))?.push(definition);
    };
    for (const managed of this.bots.values()) append(managed);
    for (const managed of this.agents.values()) append(managed);
    for (const [slotId, slot] of this.brainSlots) {
      const definitions = bySlot.get(slotId) ?? [];
      if (slotId === "builtin") {
        if (!slot.thoughtEngine && !slot.compiled) continue;
        slot.thoughtEngine?.synchronizeBots(this.codecLoopBots(definitions));
        slot.compiled?.synchronizeBots(definitions);
        continue;
      }
      slot.compiled?.synchronizeBots(definitions);
    }
  }

  private brainDefinitions(
    ...groups: Array<Iterable<ManagedBot>>
  ): BotDefinition[] {
    const definitions: BotDefinition[] = [];
    for (const group of groups) {
      for (const managed of group) {
        const definition = this.brainDefinition(managed);
        if (definition) definitions.push(definition);
      }
    }
    return definitions;
  }

  private brainDefinition(managed: ManagedBot): BotDefinition | null {
    const player = this.players.get(managed.playerId);
    if (!player) return null;
    const definition = {
      id: managed.playerId,
      role: managed.role,
      profile: brainProfile(managed),
      randomSeed: botLifeRandomSeed(managed.playerId, player.spawnedAtTick),
    };
    // The pool brain decodes its own config from profileData.
    if (this.brainSlotFor(managed) === "pool") {
      return managed.profileData === undefined
        ? definition
        : { ...definition, profileData: managed.profileData };
    }
    return { ...definition, config: managed.pipelineConfig };
  }

  /** Fill and balance follow the command child. Everyone else stays builtin. */
  private brainSlotFor(managed: ManagedBot): BrainSlotId {
    if (this.poolPipeline && managed.role === "pool") return "pool";
    if (
      this.commandPipeline &&
      (managed.role === "fill" || managed.role === "balance")
    ) {
      return "command";
    }
    return "builtin";
  }

  /**
   * Command slot present: one frame per sim tick, then each slot thinks its
   * own shard. Builtin-only matches keep {@link thinkAll}'s original path.
   */
  private thinkAllWithCommandSlot(
    simTick: number,
    collision: MapCollision,
  ): void {
    const t0 = performance.now();
    this.lastThinkBots = 0;
    const botTick = simToBotTick(simTick);
    this.synchronizeThoughtEngineRoster();

    if (this.bots.size === 0 && this.agents.size === 0) {
      this.lastThinkMs = 0;
      return;
    }

    const shard = this.thinkShardIds(simTick, botTick);
    if (shard.length === 0) {
      this.lastThinkMs = 0;
      return;
    }

    const builtinIds: string[] = [];
    const commandIds: string[] = [];
    const poolIds: string[] = [];
    for (const id of shard) {
      const managed = this.getManaged(id);
      const slot = managed ? this.brainSlotFor(managed) : "builtin";
      if (slot === "command") commandIds.push(id);
      else if (slot === "pool") poolIds.push(id);
      else builtinIds.push(id);
    }
    const frame = this.buildPackageFrame(simTick, collision);
    const map = buildBotMapDefinition(collision);
    if (builtinIds.length > 0) {
      this.thinkPackageBatch(simTick, botTick, collision, builtinIds, {
        frame,
        map,
      });
    }
    if (commandIds.length > 0) {
      this.thinkCommandBatch(
        this.commandPipeline,
        "command",
        simTick,
        botTick,
        commandIds,
        frame,
        map,
      );
    }
    if (poolIds.length > 0) {
      this.thinkCommandBatch(
        this.poolPipeline,
        "pool",
        simTick,
        botTick,
        poolIds,
        frame,
        map,
      );
    }
    this.lastThinkMs = performance.now() - t0;
    this.recordThinkPerformance(shard.length);
  }

  private buildPackageFrame(
    simTick: number,
    collision: MapCollision,
  ): ThinkBatchInput["frame"] {
    const doorCycle = this.players.getDoorCycleState(simTick);
    const teamScores = this.players.getScores();
    return buildThinkFrame({
      tick: simTick,
      simDelta: SIM_TICKS_PER_BOT_TICK,
      collision,
      players: this.players.allCached(),
      doorsOpen: doorCycle.doorsOpen,
      doorChangeTick: doorCycle.doorChangeTick,
      teamScoreA: teamScores.A,
      teamScoreB: teamScores.B,
      matchOver: this.players.isMatchOver(),
    });
  }

  /** One world + one scheduler shard in, all future actions out. */
  private thinkPackageBatch(
    simTick: number,
    botTick: number,
    collision: MapCollision,
    shard: readonly string[],
    prepared?: {
      frame: ThinkBatchInput["frame"];
      map: BotMapDefinition;
    },
  ): void {
    const engine = this.thoughtEngine;
    const compiled = this.compiledThoughtEngine;
    if ((!engine && !compiled) || shard.length === 0) return;
    const frame = prepared?.frame ?? this.buildPackageFrame(simTick, collision);
    const map = prepared?.map ?? buildBotMapDefinition(collision);
    engine?.loadMap(this.codecLoopMap(map, simTick));
    compiled?.loadMap(map);
    const bots: Array<{ botId: string; spawnedAtTick: number }> = [];
    for (const botId of shard) {
      const player = this.players.get(botId);
      if (player) bots.push({ botId, spawnedAtTick: player.spawnedAtTick });
    }

    const input = this.codecLoopThinkInput({
      frame,
      applyTick: botTickToSimTick(botTick + THINK_BUFFER_BOT_TICKS),
      bots,
    }, simTick);
    let jsOutput: ReturnType<BotThinkEngine["thinkBatch"]> | null = null;
    const shadow = compiled !== null && this.compiledThoughtMode === "shadow";
    if (engine && !shadow) {
      try {
        const output = this.codecLoopThinkOutput(
          engine.thinkBatch(input),
          simTick,
        );
        jsOutput = output;
        this.applyPackageOutput(output, simTick, botTick);
      } catch (error) {
        console.error("[bot-brain] package batch failed", error);
        for (const botId of shard) this.failBotOnSoftTick(botId, botTick);
      }
    }

    if (compiled) {
      const queued = compiled.thinkBatch(input);
      if (this.compiledThoughtMode === "compiled") {
        // Hold the previous interpolator until a non-null native action
        // beats the apply deadline. Unmark in catch if send never queued.
        for (const bot of bots) {
          const managed = this.getManaged(bot.botId);
          const self = this.players.get(bot.botId);
          if (!managed || !self || self.spawnedAtTick !== bot.spawnedAtTick) {
            continue;
          }
          this.markThoughtBotTick(bot.botId, botTick);
        }
      }
      void queued.then((result) => {
        let expectedJs = jsOutput;
        if (engine && shadow) {
          try {
            const output = this.codecLoopThinkOutput(
              engine.thinkBatch(input),
              simTick,
            );
            expectedJs = output;
            this.applyPackageOutput(output, simTick, botTick);
          } catch (error) {
            console.error("[bot-brain] package batch failed", error);
            for (const botId of shard) this.failBotOnSoftTick(botId, botTick);
          }
        }
        this.acceptCompiledPackageOutput(
          result,
          expectedJs,
          input,
          simTick,
          botTick,
        );
      }).catch((error: unknown) => {
        if (this.compiledThoughtMode === "compiled") {
          for (const bot of bots) {
            if (this.lastThoughtBotTick.get(bot.botId) === botTick) {
              this.lastThoughtBotTick.delete(bot.botId);
            }
          }
        }
        const count = bots.length;
        this.compiledFallbackUnavailable += count;
        this.compiledFallbacks += count;
        const message = error instanceof Error ? error.message : String(error);
        const now = Date.now();
        const spam = message.includes("compiled pipeline is unavailable");
        if (
          !spam ||
          now - this.compiledUnavailableLogAt >= 5_000
        ) {
          this.compiledUnavailableLogAt = now;
          console.warn(
            `[bot-brain pipeline-compiled] batch failed: ${message}`,
          );
        }
      });
    }
  }

  /**
   * Fill/balance child. Does not wait. A dead child throws into the rejected
   * promise; previous keys stay down. An extra id drops the whole result,
   * same rule as {@link acceptCompiledPackageOutput}.
   */
  private thinkCommandBatch(
    pipeline: DenoCompiledBotThinkPipeline | null,
    slot: "command" | "pool",
    simTick: number,
    botTick: number,
    shard: readonly string[],
    frame: ThinkBatchInput["frame"],
    map: BotMapDefinition,
  ): void {
    if (!pipeline || shard.length === 0) return;
    pipeline.loadMap(map);
    const bots: Array<{ botId: string; spawnedAtTick: number }> = [];
    for (const botId of shard) {
      const player = this.players.get(botId);
      if (player) bots.push({ botId, spawnedAtTick: player.spawnedAtTick });
    }
    if (bots.length === 0) return;
    const input: ThinkBatchInput = {
      frame,
      applyTick: botTickToSimTick(botTick + THINK_BUFFER_BOT_TICKS),
      bots,
    };
    const queued = pipeline.thinkBatch(input);
    for (const bot of bots) {
      const managed = this.getManaged(bot.botId);
      const self = this.players.get(bot.botId);
      if (!managed || !self || self.spawnedAtTick !== bot.spawnedAtTick) {
        continue;
      }
      this.markThoughtBotTick(bot.botId, botTick);
    }
    const settled = queued.then((result) => {
      this.acceptCommandPackageOutput(slot, result, input, simTick, botTick);
    }).catch(() => {
      for (const bot of bots) {
        if (this.lastThoughtBotTick.get(bot.botId) === botTick) {
          this.lastThoughtBotTick.delete(bot.botId);
        }
      }
    }).then(() => {});
    const inflight = slot === "pool" ? this.poolInFlight : this.commandInFlight;
    const next = Promise.all([inflight, settled]).then(() => {});
    if (slot === "pool") this.poolInFlight = next;
    else this.commandInFlight = next;
  }

  private applyPackageOutput(
    output: ReturnType<BotThinkEngine["thinkBatch"]>,
    simTick: number,
    botTick: number,
  ): void {
    for (const decision of output.decisions) {
      const managed = this.getManaged(decision.botId);
      const self = this.players.get(decision.botId);
      if (
        !managed || !self ||
        self.spawnedAtTick !== decision.spawnedAtTick
      ) {
        continue;
      }
      const action = pipelineReadyAction(decision.action);
      enqueueReadyAction(
        managed,
        action,
        botTick,
        THINK_BUFFER_BOT_TICKS,
        simTick,
      );
      recordLastMove(this.lastMoves, decision.botId, action);
      self.botDecisions = encodeBotDecisions({
        tick: simTick,
        state: {},
        selfX: self.x,
        selfZ: self.z,
        ready: action,
      });
      this.markThoughtBotTick(decision.botId, botTick);
    }
  }

  private acceptCompiledPackageOutput(
    result: CompiledPipelineResult,
    expectedJs: ReturnType<BotThinkEngine["thinkBatch"]> | null,
    input: Parameters<BotThinkEngine["thinkBatch"]>[0],
    simTick: number,
    botTick: number,
  ): void {
    const output = result.output;
    const expectedCount = input.bots.length;
    let valid = output.tick === input.frame.tick &&
      output.applyTick === input.applyTick &&
      output.mapRevision === input.frame.mapRevision &&
      output.decisions.length === expectedCount;
    if (valid) {
      for (let index = 0; index < expectedCount; index += 1) {
        const requested = input.bots[index]!;
        const decision = output.decisions[index]!;
        if (
          decision.botId !== requested.botId ||
          decision.spawnedAtTick !== requested.spawnedAtTick
        ) {
          valid = false;
          break;
        }
      }
    }
    if (!valid) {
      this.compiledFallbackInvalid += expectedCount;
      this.compiledFallbacks += expectedCount;
      return;
    }

    if (this.compiledThoughtMode === "shadow") {
      if (expectedJs === null) return;
      this.compiledSamples += expectedCount;
      for (let index = 0; index < expectedCount; index += 1) {
        const nativeDecision = output.decisions[index]!;
        const jsDecision = expectedJs.decisions[index];
        const comparison = comparePipelineActions(
          jsDecision?.action ?? null,
          nativeDecision.action,
        );
        if (comparison.exact) {
          this.compiledExactMatches += 1;
        }
        if (!comparison.discreteMatch) this.compiledDiscreteMismatches += 1;
        if (!comparison.keysMatch) this.compiledKeyMismatches += 1;
        if (!comparison.shootMatch) this.compiledShootMismatches += 1;
        const maxAngleDelta = Math.max(
          comparison.yawDelta,
          comparison.pitchDelta,
        );
        if (maxAngleDelta <= Math.PI / 180) this.compiledWithinOneDegree += 1;
        if (maxAngleDelta <= (Math.PI * 5) / 180) {
          this.compiledWithinFiveDegrees += 1;
        }
        if (maxAngleDelta <= (Math.PI * 10) / 180) {
          this.compiledWithinTenDegrees += 1;
        }
        if (Number.isFinite(comparison.yawDelta)) {
          this.compiledAbsYawDeltaTotal += comparison.yawDelta;
          this.compiledMaxAbsYawDelta = Math.max(
            this.compiledMaxAbsYawDelta,
            comparison.yawDelta,
          );
        }
        if (Number.isFinite(comparison.pitchDelta)) {
          this.compiledAbsPitchDeltaTotal += comparison.pitchDelta;
          this.compiledMaxAbsPitchDelta = Math.max(
            this.compiledMaxAbsPitchDelta,
            comparison.pitchDelta,
          );
        }
        if (!comparison.discreteMatch || maxAngleDelta > (Math.PI * 5) / 180) {
          this.compiledMismatches += 1;
          const dump: PipelineMismatchDump = {
            tick: input.frame.tick,
            botId: nativeDecision.botId,
            kind: comparison.kind,
            js: jsDecision?.action ?? null,
            compiled: nativeDecision.action,
          };
          if (this.compiledFirstMismatch === null) {
            this.compiledFirstMismatch = dump;
          }
          this.compiledLastMismatch = dump;
        }
      }
      return;
    }

    this.compiledSamples += expectedCount;
    // Apply already ran earlier on this same sim tick, so equality is late too.
    if (this.players.tick >= output.applyTick) {
      this.compiledFallbackLate += expectedCount;
      this.compiledFallbacks += expectedCount;
      return;
    }
    for (const decision of output.decisions) {
      const managed = this.getManaged(decision.botId);
      const self = this.players.get(decision.botId);
      if (!managed || !self || self.spawnedAtTick !== decision.spawnedAtTick) {
        this.compiledFallbackInvalid += 1;
        this.compiledFallbacks += 1;
        continue;
      }
      if (decision.action === null) {
        this.compiledFallbackNull += 1;
        this.compiledFallbacks += 1;
        enqueueReadyAction(
          managed,
          { input: null },
          botTick,
          THINK_BUFFER_BOT_TICKS,
        );
        continue;
      }
      const action = pipelineReadyAction(decision.action);
      enqueueReadyAction(
        managed,
        action,
        botTick,
        THINK_BUFFER_BOT_TICKS,
        simTick,
      );
      this.compiledApplied += 1;
      recordLastMove(this.lastMoves, decision.botId, action);
      self.botDecisions = encodeBotDecisions({
        tick: simTick,
        state: {},
        selfX: self.x,
        selfZ: self.z,
        ready: action,
      });
    }
  }

  /**
   * Command-slot apply. Echo and decision list must match the request.
   * One extra id (an agent, say) drops the whole result. Null is hold.
   * A result that arrives on or after `applyTick` is dropped.
   */
  private acceptCommandPackageOutput(
    slot: "command" | "pool",
    result: CompiledPipelineResult,
    input: ThinkBatchInput,
    simTick: number,
    botTick: number,
  ): void {
    const output = result.output;
    if (this.players.tick >= output.applyTick) return;
    if (!this.commandBatchAccepted(slot, output, input)) return;
    for (const decision of output.decisions) {
      const managed = this.getManaged(decision.botId);
      const self = this.players.get(decision.botId);
      if (
        !managed || !self ||
        self.spawnedAtTick !== decision.spawnedAtTick ||
        !this.externalSlotOwns(slot, managed.role)
      ) {
        continue;
      }
      if (decision.action === null) {
        enqueueReadyAction(
          managed,
          { input: null },
          botTick,
          THINK_BUFFER_BOT_TICKS,
        );
        continue;
      }
      const action = pipelineReadyAction(decision.action);
      enqueueReadyAction(
        managed,
        action,
        botTick,
        THINK_BUFFER_BOT_TICKS,
        simTick,
      );
      recordLastMove(this.lastMoves, decision.botId, action);
      self.botDecisions = encodeBotDecisions({
        tick: simTick,
        state: {},
        selfX: self.x,
        selfZ: self.z,
        ready: action,
      });
      this.markThoughtBotTick(decision.botId, botTick);
    }
  }

  private externalSlotOwns(
    slot: "command" | "pool",
    role: ManagedBot["role"],
  ): boolean {
    if (slot === "pool") return role === "pool";
    return role === "fill" || role === "balance";
  }

  private commandBatchAccepted(
    slot: "command" | "pool",
    output: ThinkBatchOutput,
    input: ThinkBatchInput,
  ): boolean {
    if (
      output.tick !== input.frame.tick ||
      output.applyTick !== input.applyTick ||
      output.mapRevision !== input.frame.mapRevision ||
      output.decisions.length !== input.bots.length
    ) {
      return false;
    }
    for (let index = 0; index < input.bots.length; index += 1) {
      const requested = input.bots[index]!;
      const decision = output.decisions[index]!;
      if (
        decision.botId !== requested.botId ||
        decision.spawnedAtTick !== requested.spawnedAtTick
      ) {
        return false;
      }
      const managed = this.getManaged(decision.botId);
      if (!managed || !this.externalSlotOwns(slot, managed.role)) {
        return false;
      }
    }
    return true;
  }

  /** Package-think failure: enqueue last-move replay for this bot tick. */
  private failBotOnSoftTick(botId: string, thinkTick: number): void {
    const managed = this.getManaged(botId);
    const last = replayLastMove(this.lastMoves, botId) ??
      managed?.lastAppliedAction ??
      null;
    // Hold the last move's final look: replaying its samples would rewind the
    // mouse to the start of that period.
    let replay = last;
    if (last !== null && last.lookSamples !== undefined) {
      const { lookSamples: _played, ...held } = last;
      replay = held;
    }
    if (managed) {
      enqueueReadyAction(managed, replay, thinkTick);
    }
    this.markThoughtBotTick(botId, thinkTick);
  }

  /**
   * Remove dead agents (no respawn). Call after combat is broadcast so clients
   * still see the death event. When the last agent is cleared, doors re-open
   * for a fresh open phase. Returns removed player ids.
   */
  public pruneDeadAgents(tick?: number): string[] {
    const hadAgents = this.agents.size > 0;
    const removed: string[] = [];
    for (const bot of [...this.agents.values()]) {
      const p = this.players.get(bot.playerId);
      if (p && p.alive) continue;
      if (this.removeAgentById(bot.playerId)) {
        removed.push(bot.playerId);
      }
    }
    if (
      hadAgents &&
      this.agents.size === 0 &&
      typeof tick === "number"
    ) {
      this.players.reopenDoorsAfterAgentsCleared(tick);
    }
    return removed;
  }

  /**
   * Drop all grey agents (match restart / empty server). Does not touch team bots.
   * Resets door-side rotation so the next match re-rolls first door randomly.
   */
  public clearAgents(): void {
    const ids = [...this.agents.keys()];
    for (const id of ids) {
      this.removeAgentById(id);
    }
    this.nextAgentDoor = null;
    this.prevDoorsOpen = undefined;
  }

  /** Drop all bots + agents (e.g. server shutdown). */
  public clear(): void {
    this.raidWaveSpawn = null;
    this.raidMiniWaveSpawn = null;
    const ids = [...this.bots.keys()];
    for (const id of ids) {
      this.removeBotById(id, "match-end");
    }
    this.clearAgents();
    this.manualExtra = 0;
    this.lastMoves.clear();
  }

  /**
   * On open→closed door transition, drop 1–3 grey agents (weighted roll) while
   * under the map cap and humans are present. First door is random; later
   * drops (including within the same batch) alternate sides.
   */
  private maybeSpawnAgentOnDoorClose(
    tick: number,
    collision: MapCollision,
  ): void {
    const doorsOpen = this.players.areDoorsOpen(tick);
    const prev = this.prevDoorsOpen;
    this.prevDoorsOpen = doorsOpen;

    // Need a real open→closed edge (skip first tick / prematch forever-closed).
    if (prev !== true || doorsOpen !== false) return;
    if (this.raidMode) return;
    if (this.players.isMatchOver()) return;
    if (this.players.isPrematch()) return;
    if (this.players.humanCount() <= 0) return;
    if (this.agents.size >= MAX_AGENTS) return;

    // Epic 4.6 agents domain: count roll, then door pick inside allocAgentDoor.
    const want = rollAgentsPerDoorClose(this.agentsRandom);
    const room = MAX_AGENTS - this.agents.size;
    const n = Math.min(want, room);
    for (let i = 0; i < n; i++) {
      if (!this.spawnAgent(collision)) break;
    }
  }

  /** Scripted raid drop at a specific door (ordinary matches use random sides). */
  public spawnAgentsAtDoor(
    count: number,
    collision: MapCollision,
    doorTeam: TeamId,
  ): number {
    const n = Math.min(
      Math.max(0, Math.floor(count)),
      MAX_AGENTS - this.agents.size,
    );
    let spawned = 0;
    for (let i = 0; i < n; i++) {
      if (!this.spawnAgent(collision, doorTeam)) break;
      spawned += 1;
    }
    return spawned;
  }

  private spawnAgent(
    collision: MapCollision,
    forcedDoorTeam?: TeamId,
  ): boolean {
    if (this.agents.size >= MAX_AGENTS) return false;

    const doorTeam = forcedDoorTeam ?? this.allocAgentDoor();
    const nameIndex = this.allocAgentNameIndex();
    const name = `agent${nameIndex}`;
    const id = `${AGENT_ID_PREFIX}${nameIndex}-${this.idSuffix()}`;

    const pose = agentDoorSpawn(collision.map, doorTeam);
    const resolved = collision.resolvePosition(pose.x, pose.z);
    // Grey agents never use talent skills.
    const player = this.players.addAgent(id, name, doorTeam, {
      x: resolved.x,
      y: PLAYER_HEIGHT,
      z: resolved.z,
      yaw: pose.yaw,
    }, {
      ownedAbilities: [],
      skillLoadout: emptySkillLoadout(),
    });

    const pipelineConfig = agentBrainConfigFor(this.difficulty);
    const managed: ManagedBot = {
      playerId: player.id,
      nameIndex,
      role: "agent",
      pipelineConfig,
      sequence: 0,
      readyDelayQueue: [],
    };
    this.agents.set(player.id, managed);
    this.hooks.onBotJoined?.(player);
    return true;
  }

  /** First agent: random A/B. After that: alternate. */
  private allocAgentDoor(): TeamId {
    if (this.nextAgentDoor === null) {
      // First door of the match: agents-domain coin (epic 4.6).
      const first: TeamId = this.agentsRandom() < 0.5 ? "A" : "B";
      this.nextAgentDoor = first === "A" ? "B" : "A";
      return first;
    }
    const door = this.nextAgentDoor;
    this.nextAgentDoor = door === "A" ? "B" : "A";
    return door;
  }

  private allocAgentNameIndex(): number {
    const used = new Set<number>();
    for (const bot of this.agents.values()) used.add(bot.nameIndex);
    for (const p of this.players.all()) {
      const m = /^agent(\d+)$/i.exec(p.name);
      if (m) used.add(Number(m[1]));
    }
    let n = 1;
    while (used.has(n)) n++;
    return n;
  }

  private removeAgentById(playerId: string): boolean {
    const bot = this.agents.get(playerId);
    if (!bot) return false;
    this.agents.delete(playerId);
    this.lastMoves.delete(playerId);
    this.lastThoughtBotTick.delete(playerId);
    this.players.remove(playerId);
    this.hooks.onBotLeft?.(playerId);
    return true;
  }

  // --- internals -----------------------------------------------------------

  private addOneBot(): boolean {
    this.sweepTakenPoolNames();
    const nameIndex = this.allocNameIndex();
    const id = this.botIdFactory?.(nameIndex) ??
      `${BOT_ID_PREFIX}${nameIndex}-${crypto.randomUUID().slice(0, 8)}`;

    while (this.pool.length > 0) {
      const row = this.pool.shift();
      if (!row) break;
      if (this.players.isNameTaken(row.identity.name)) {
        this.emitPool({
          type: "identity-dropped",
          identityId: row.identity.id,
          reason: "name-taken",
        });
        continue;
      }
      const spawned = this.spawnManagedBot(id, nameIndex, {
        name: row.identity.name,
        pipelineConfig: COMMUNITY_BOT_CONFIG,
        addBotOpts: this.poolAddBotOpts(row.identity),
        role: "pool",
        poolIdentityId: row.identity.id,
        profile: row.identity.profile,
        profileData: row.identity.profileData,
        initialPingMs: row.identity.initialPingMs,
      });
      if (!spawned) return false;
      this.emitPool({
        type: "pawn-took",
        identityId: row.identity.id,
        pawnId: id,
      });
      return true;
    }

    const name = `bot${nameIndex}`;
    if (this.players.isNameTaken(name)) {
      const retry = this.allocNameIndex();
      const retryName = `bot${retry}`;
      if (this.players.isNameTaken(retryName)) return false;
      return this.spawnCommunityBot(id, retryName, retry);
    }
    return this.spawnCommunityBot(id, name, nameIndex);
  }

  private sweepTakenPoolNames(): void {
    if (this.pool.length === 0) return;
    const kept: QueuedPoolIdentity[] = [];
    for (const row of this.pool) {
      if (this.players.isNameTaken(row.identity.name)) {
        this.emitPool({
          type: "identity-dropped",
          identityId: row.identity.id,
          reason: "name-taken",
        });
        continue;
      }
      kept.push(row);
    }
    this.pool = kept;
  }

  private emitPool(event: PoolRosterEvent): void {
    this.poolListener?.(event);
  }

  private poolAddBotOpts(
    identity: PoolIdentity,
  ): Parameters<PlayerManager["addBot"]>[2] {
    const opts: Parameters<PlayerManager["addBot"]>[2] = {
      equipment: identity.equipment,
      accountUserId: identity.accountId,
      xp: identity.xp,
      founderBadge: identity.founderBadge === true,
      poolAccount: Boolean(identity.accountId),
    };
    const rankId = knownMmsRankId(identity.rankId);
    if (rankId) opts.mmsRankId = rankId;
    if (identity.skills) {
      opts.ownedAbilities = identity.skills.ownedAbilities as SkillProductId[];
      opts.skillLoadout = identity.skills.skillLoadout;
    }
    return opts;
  }

  private spawnCommunityBot(
    id: string,
    name: string,
    nameIndex: number,
  ): boolean {
    return this.spawnManagedBot(id, nameIndex, {
      name,
      pipelineConfig: COMMUNITY_BOT_CONFIG,
      addBotOpts: {
        ownedAbilities: [],
        skillLoadout: emptySkillLoadout(),
      },
    });
  }

  private spawnManagedBot(
    id: string,
    nameIndex: number,
    spec: {
      name: string;
      pipelineConfig: PipelineBotBrainConfig;
      addBotOpts?: Parameters<PlayerManager["addBot"]>[2];
      initialPingMs?: number;
      isBalanceBot?: boolean;
      role?: ManagedBot["role"];
      poolIdentityId?: string;
      profile?: string;
      profileData?: string;
    },
  ): boolean {
    const player = this.players.addBot(id, spec.name, spec.addBotOpts);
    if (spec.initialPingMs != null) {
      player.pingMs = spec.initialPingMs;
    }
    const role = spec.role ??
      (spec.isBalanceBot ? "balance" : "fill");
    const managed: ManagedBot = {
      playerId: player.id,
      nameIndex,
      role,
      pipelineConfig: spec.pipelineConfig,
      sequence: 0,
      readyDelayQueue: [],
      poolIdentityId: spec.poolIdentityId,
      profile: spec.profile,
      profileData: spec.profileData,
      isBalanceBot: spec.isBalanceBot,
    };
    this.bots.set(player.id, managed);
    this.hooks.onBotJoined?.(player);
    return true;
  }

  /**
   * Remove one bot, preferring a team so human joins stay balanced.
   *
   * Order of preference:
   * 1. `preferredTeam` when set and it has a bot (human taking a bot's slot)
   * 2. Team with more total players (humans + bots)
   * 3. On a total-count tie, team with fewer humans (where the next human joins)
   * Among candidates on the chosen team, highest name index (stable low ids).
   * Falls back to any bot if the preferred team has none.
   */
  private removeOneBot(
    preferredTeam?: TeamId,
    reason: PawnRemoveReason = "churn",
  ): boolean {
    // Never remove agents via autofill / human-join eviction — only team bots.
    if (this.bots.size === 0) return false;

    /**
     * Prefer regular fill bots over the temporary balance filler so autofill
     * shrinks do not delete the balancer first (reconcileBalanceBot owns that).
     */
    const pickFromTeam = (
      team: TeamId,
      opts?: { allowBalance?: boolean },
    ): ManagedBot | null => {
      let victim: ManagedBot | null = null;
      for (const bot of this.bots.values()) {
        const p = this.players.get(bot.playerId);
        if (!p || p.isAgent || p.team !== team) continue;
        if (bot.isBalanceBot && !opts?.allowBalance) continue;
        if (!victim || bot.nameIndex > victim.nameIndex) victim = bot;
      }
      return victim;
    };

    if (preferredTeam) {
      const preferred = pickFromTeam(preferredTeam) ??
        pickFromTeam(preferredTeam, { allowBalance: true });
      if (preferred) return this.removeBotById(preferred.playerId, reason);
    }

    const totals = this.players.teamCounts();
    const humans = this.players.humanTeamCounts();
    let heavyTeam: TeamId;
    if (totals.B > totals.A) {
      heavyTeam = "B";
    } else if (totals.A > totals.B) {
      heavyTeam = "A";
    } else if (humans.B < humans.A) {
      // Equal body count: drop a bot from the human-light team (join target).
      heavyTeam = "B";
    } else {
      heavyTeam = "A";
    }

    const balanced = pickFromTeam(heavyTeam) ??
      pickFromTeam(heavyTeam, { allowBalance: true });
    if (balanced) return this.removeBotById(balanced.playerId, reason);

    // Preferred / heavy team had no bots — remove any fill bot first.
    let victim: ManagedBot | null = null;
    for (const bot of this.bots.values()) {
      if (bot.isBalanceBot) continue;
      if (!victim || bot.nameIndex > victim.nameIndex) victim = bot;
    }
    if (!victim) {
      for (const bot of this.bots.values()) {
        if (!victim || bot.nameIndex > victim.nameIndex) victim = bot;
      }
    }
    if (!victim) return false;
    return this.removeBotById(victim.playerId, reason);
  }

  private removeBotById(
    playerId: string,
    reason: PawnRemoveReason = "churn",
  ): boolean {
    const bot = this.bots.get(playerId);
    if (!bot) return false;
    const identityId = bot.poolIdentityId;
    this.bots.delete(playerId);
    this.lastMoves.delete(playerId);
    this.lastThoughtBotTick.delete(playerId);
    this.raidBotIds.delete(playerId);
    this.players.remove(playerId);
    if (identityId) {
      this.emitPool({
        type: "pawn-removed",
        identityId,
        pawnId: playerId,
        reason,
      });
    }
    this.hooks.onBotLeft?.(playerId);
    return true;
  }

  private allocNameIndex(): number {
    const used = new Set<number>();
    for (const bot of this.bots.values()) used.add(bot.nameIndex);
    // Treat existing player names "botN" as taken (human stole the name).
    for (const p of this.players.all()) {
      const m = /^bot(\d+)$/i.exec(p.name);
      if (m) used.add(Number(m[1]));
    }
    let n = 1;
    while (used.has(n)) n++;
    return n;
  }
}

/**
 * The profile name {@link publicResolveConfig} turns back into this pawn's
 * config, so a brain that only has the wire still plays it exactly.
 */
export function brainProfile(managed: ManagedBot): string {
  const config = managed.pipelineConfig;
  switch (managed.role) {
    case "pool":
      return managed.profile ?? config.id;
    case "agent":
      if (config === AGENT_BOT_CONFIGS.medium) return "agent-medium";
      if (config === AGENT_BOT_CONFIGS.hard) return "agent-hard";
      return "agent-easy";
    case "raid":
      return config.raidAllowRandomStops === false ? "raid-no-stops" : "raid";
    default:
      return config.id;
  }
}
