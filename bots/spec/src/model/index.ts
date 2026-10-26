export type TeamId = "A" | "B";
export type PlayerKind = "human" | "bot" | "agent";
export type WallKind = "full" | "half" | "float";
export type EdgeId = "south" | "east" | "north" | "west";

export type Vec2 = Readonly<{ x: number; z: number }>;
export type Vec3 = Readonly<{ x: number; y: number; z: number }>;

export type BotMapBounds = Readonly<{
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}>;

export type BotMapWall = Readonly<{
  id: string;
  ax: number;
  az: number;
  bx: number;
  bz: number;
  kind: WallKind;
}>;

export type BotMapSide = Readonly<{
  edge: EdgeId;
  doorHalfWidth: number;
  spawnRadius: number;
}>;

export type BotHintTeam = TeamId;

export type BotNudgeHint = Readonly<{
  id: string;
  team: BotHintTeam;
  points: readonly Vec2[];
}>;

export type BotCampHint = Readonly<{
  id: string;
  team: BotHintTeam;
  point: Vec2;
}>;

export type BotSprintHint = Readonly<{
  id: string;
  team: BotHintTeam;
  polygon: readonly Vec2[];
}>;

export type BotSpawnHint = Readonly<{
  id: string;
  team: BotHintTeam;
  start: Vec2;
  end: Vec2;
}>;

export type BotStuckHint = Readonly<{
  id: string;
  team: BotHintTeam;
  center: Vec2;
  radius: number;
  yaw: number;
}>;

/** Kind-separated arrays avoid repeated union/tag dispatch in the hot path. */
export type BotMapHints = Readonly<{
  nudges: readonly BotNudgeHint[];
  camps: readonly BotCampHint[];
  sprints: readonly BotSprintHint[];
  spawns: readonly BotSpawnHint[];
  stuck: readonly BotStuckHint[];
}>;

/** Normalized map form loaded once and cached by revision in the think worker. */
export type BotMapDefinition = Readonly<{
  id: string;
  revision: string;
  formatVersion: number;
  bounds: BotMapBounds;
  teamA: BotMapSide;
  teamB: BotMapSide;
  walls: readonly BotMapWall[];
  wallCorners: readonly Vec2[];
  hints: BotMapHints;
}>;

export type WeaponSnapshot = Readonly<{
  id: number;
  ammoInMagazine: number;
  spareClips: number;
  reloading: boolean;
  lastShotTick: number;
}>;

export type WeaponInventorySnapshot = Readonly<{
  id: number;
  ammoInMagazine: number;
  spareClips: number;
}>;

export type SkillSnapshot = Readonly<{
  id: string;
  equipped: boolean;
  charge: number;
  activeUntilTick: number | null;
  /** Authoritative per-frame activation gate, including global lock/cooldown. */
  canActivate?: boolean;
}>;

/** Plain per-frame data: no Player methods or server object references. */
export type PlayerSnapshot = Readonly<{
  id: string;
  kind: PlayerKind;
  team: TeamId;
  alive: boolean;
  health: number;
  score: number;
  spawnedAtTick: number;
  x: number;
  y: number;
  z: number;
  velocityX: number;
  velocityY: number;
  velocityZ: number;
  yaw: number;
  pitch: number;
  crouch: boolean;
  onGround: boolean;
  sprintStamina?: number;
  /** Current horizontal movement yaw used by the navigation FOV. */
  moveYaw?: number | null;
  /** Official match-player identity; drives score-anxiety behavior. */
  matchPlayer?: boolean;
  unlimitedAmmo?: boolean;
  /** All carried magazines. Omit to expose only the active weapon. */
  weapons?: readonly WeaponInventorySnapshot[];
  /** Pre-resolved Glitch visibility for this immutable frame. */
  glitchState?: "hidden" | "revealed" | "inactive";
  weapon: WeaponSnapshot;
  skills: readonly SkillSnapshot[];
}>;

/**
 * Which brain job a pawn has. A command brain only sees `fill` and `balance`;
 * the pool brain only `pool`. `agent` and `raid` stay on the built-in brain.
 */
export type BotRole = "fill" | "balance" | "pool" | "agent" | "raid";

export type BotDefinition = Readonly<{
  id: string;
  role: BotRole;
  /**
   * Personality name the built-in engine resolves to a config (`community`,
   * `balance-bot`, `agent-easy`, `raid`, …). A third-party brain may ignore it.
   */
  profile: string;
  randomSeed: number;
  /** Opaque bytes from whoever spawned the pawn. The host forwards them unread. */
  profileData?: string;
  /**
   * In-process only, never on the wire: the host's own config for this pawn.
   * Over the wire the engine resolves `profile` instead.
   */
  config?: BotBrainConfig;
}>;

/** Input intent deliberately omits sequence; the authoritative server stamps it. */
export type BotInputIntent = Readonly<{
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
  sprint: boolean;
  crouch: boolean;
  yaw: number;
  pitch: number;
}>;

/** One sim tick of look inside a bot period. */
export type BotLookSample = Readonly<{
  yaw: number;
  pitch: number;
}>;

export type ReadyAction = Readonly<{
  input: BotInputIntent | null;
  /**
   * Per-sim-tick look for this action's bot period, oldest first. The host
   * applies sample k on the k-th sim tick after release and holds the last
   * (which equals `input.yaw/pitch`). Only present with a non-null input;
   * omitted → the host lerps from the previous look.
   */
  lookSamples?: readonly BotLookSample[];
  shoot?: boolean;
  reload?: boolean;
  weapon?: number;
  ability?: string;
}>;

export type BotDecision = Readonly<{
  botId: string;
  action: ReadyAction | null;
}>;

export type ThinkBatchBot = Readonly<{
  botId: string;
  /** Reject stale results after death/respawn. */
  spawnedAtTick: number;
}>;

/** The sole public hot-path call for browser, Deno, and compiled workers. */
export type ThinkBatchInput = Readonly<{
  frame: ThinkFrame;
  /** Sim tick on which the authoritative host should apply these actions. */
  applyTick: number;
  /** Usually one scheduler shard (roughly one third of the live bots). */
  bots: readonly ThinkBatchBot[];
}>;

export type ThinkBatchDecision = Readonly<{
  botId: string;
  spawnedAtTick: number;
  action: ReadyAction | null;
}>;

export type ThinkBatchOutput = Readonly<{
  tick: number;
  applyTick: number;
  mapRevision: string;
  decisions: readonly ThinkBatchDecision[];
}>;

export type ThinkFrame = Readonly<{
  tick: number;
  simDelta: number;
  mapRevision: string;
  doorsOpen: boolean;
  doorChangeTick: number | null;
  teamScoreA: number;
  teamScoreB: number;
  players: readonly PlayerSnapshot[];
  /**
   * In-process only, never on the wire: a residual route prior a private
   * brain attaches to its own copy of the frame.
   */
  humanHeatByPole?: Readonly<Record<string, number>>;
  /** Set once the match has ended; brains short-circuit to idle keys. */
  matchOver?: boolean;
}>;

/** Stateful engine contract shared by direct browser and worker transports. */
export interface BotThinkEngine {
  loadMap(map: BotMapDefinition): void;
  synchronizeBots(bots: readonly BotDefinition[]): void;
  think(frame: ThinkFrame): readonly BotDecision[];
  thinkBatch(input: ThinkBatchInput): ThinkBatchOutput;
}
import type { BotBrainConfig } from "../config.ts";
