/**
 * Shared network packet shapes (server-side). Keep packet types in sync with client.
 * Gameplay constants live in shared/sim/game.ts — re-exported here for convenience.
 */

import type { DoorsMap } from "../world/map.ts";
import type {
  AbilityId,
  AbilitySnapEntry,
  GlitchSnapState,
} from "../shared/sim/abilities.ts";
import type { SkillId } from "../shared/sim/skills.ts";
import type { MmsRankId } from "../shared/progression/mmsRanks.ts";
import {
  AFK_KICK_MS,
  AFK_TIMEOUT_MS,
  agentPlayerEquipment,
  AUTO_REBALANCE_DELAY_MS,
  AUTO_REBALANCE_MIN_HUMAN_DIFF,
  AUTO_REBALANCE_NOTICE_MESSAGE,
  CONNECTION_ISSUE_TIMEOUT_MS,
  CROUCH_SPEED_MULT,
  defaultPlayerEquipment,
  DOOR_CAPTURE_DWELL_MS,
  DOOR_CLOSED_MS,
  DOOR_CLOSED_STANDOFF,
  DOOR_OPEN_MS,
  DOOR_POWER_UP_MS,
  DOOR_WALK_IN,
  DT,
  HIT_SLOW_DURATION_MS,
  HIT_SLOW_MAX_STACKS,
  HIT_SLOW_PER_STACK,
  hitSlowMoveSpeedScale,
  JoinErrors,
  JUMP_STAMINA_COST,
  jumpStaminaCostSeconds,
  MATCH_DURATION_SECONDS,
  MATCH_RESTART_SECONDS,
  MAX_HEALTH,
  moveSpeedForInput,
  msToTicks,
  normalizePlayerEquipment,
  normalizePlayerName,
  PLAYER_NAME_MAX,
  PLAYER_NAME_MIN,
  type PlayerEquipment,
  playerNameKey,
  PREMATCH_CONFIG,
  RAID_RESPAWN_DELAY_MS,
  REBALANCE_VOTE_FRACTION,
  rebalanceVotePasses,
  rebalanceVotesNeeded,
  RESPAWN_DELAY_CLOSED_MS,
  RESPAWN_DELAY_MS,
  SCORE_COOLDOWN_MS,
  simTime,
  SLIDE_DURATION_S,
  SLIDE_STAMINA_COST,
  slideStaminaCostSeconds,
  SPAWN_INVULN_MS,
  SPRINT_CROUCH_REGEN_MULT,
  SPRINT_DRAIN_MULT,
  SPRINT_DURATION_S,
  SPRINT_MOVE_REGEN_MULT,
  SPRINT_REGEN_PER_S,
  SPRINT_SPEED_MULT,
  sprintDrainPerSecond,
  sprintRegenPerSecond,
  TICK_HZ,
  TICK_MS,
  ticksToMs,
  WALK_SPEED,
  WIN_BY_MARGIN,
  WIN_SCORE,
} from "../shared/sim/game.ts";
import {
  getWeapon as getSharedWeapon,
  isWeaponId,
  MELEE_BASE_DAMAGE,
  MELEE_COOLDOWN_MS,
  MELEE_HIT_MOMENT_T,
  MELEE_RANGE,
  MELEE_SWING_MS,
  PISTOL as SHARED_PISTOL,
  RIFLE as SHARED_RIFLE,
  SHOTGUN as SHARED_SHOTGUN,
  WEAPON_ORDER,
  WEAPON_PISTOL,
  WEAPON_RIFLE,
  WEAPON_SHOTGUN,
  WEAPON_SWITCH_MS,
  type WeaponDef as SharedWeaponDef,
  WEAPONS as SHARED_WEAPONS,
} from "../shared/sim/weapons.ts";

export {
  AFK_KICK_MS,
  AFK_TIMEOUT_MS,
  agentPlayerEquipment,
  AUTO_REBALANCE_DELAY_MS,
  AUTO_REBALANCE_MIN_HUMAN_DIFF,
  AUTO_REBALANCE_NOTICE_MESSAGE,
  CONNECTION_ISSUE_TIMEOUT_MS,
  CROUCH_SPEED_MULT,
  defaultPlayerEquipment,
  DOOR_CAPTURE_DWELL_MS,
  DOOR_CLOSED_MS,
  DOOR_CLOSED_STANDOFF,
  DOOR_OPEN_MS,
  DOOR_POWER_UP_MS,
  DOOR_WALK_IN,
  DT,
  HIT_SLOW_DURATION_MS,
  HIT_SLOW_MAX_STACKS,
  HIT_SLOW_PER_STACK,
  hitSlowMoveSpeedScale,
  isWeaponId,
  JoinErrors,
  JUMP_STAMINA_COST,
  jumpStaminaCostSeconds,
  MATCH_DURATION_SECONDS,
  MATCH_RESTART_SECONDS,
  MAX_HEALTH,
  MELEE_BASE_DAMAGE,
  MELEE_COOLDOWN_MS,
  MELEE_HIT_MOMENT_T,
  MELEE_RANGE,
  MELEE_SWING_MS,
  moveSpeedForInput,
  msToTicks,
  normalizePlayerEquipment,
  normalizePlayerName,
  PLAYER_NAME_MAX,
  PLAYER_NAME_MIN,
  playerNameKey,
  PREMATCH_CONFIG,
  RAID_RESPAWN_DELAY_MS,
  REBALANCE_VOTE_FRACTION,
  rebalanceVotePasses,
  rebalanceVotesNeeded,
  RESPAWN_DELAY_CLOSED_MS,
  RESPAWN_DELAY_MS,
  SCORE_COOLDOWN_MS,
  simTime,
  SLIDE_DURATION_S,
  SLIDE_STAMINA_COST,
  slideStaminaCostSeconds,
  SPAWN_INVULN_MS,
  SPRINT_CROUCH_REGEN_MULT,
  SPRINT_DRAIN_MULT,
  SPRINT_DURATION_S,
  SPRINT_MOVE_REGEN_MULT,
  SPRINT_REGEN_PER_S,
  SPRINT_SPEED_MULT,
  sprintDrainPerSecond,
  sprintRegenPerSecond,
  TICK_HZ,
  TICK_MS,
  ticksToMs,
  WALK_SPEED,
  WEAPON_ORDER,
  WEAPON_PISTOL,
  WEAPON_RIFLE,
  WEAPON_SHOTGUN,
  WEAPON_SWITCH_MS,
  WIN_BY_MARGIN,
  WIN_SCORE,
};
export type { PlayerEquipment, SharedWeaponDef };

/** Canonical per-tick action intent (replay epic 5.1) — single shared definition. */
export {
  CANONICAL_APPLY_ORDER,
  CANONICAL_EDGE_FIELDS,
  CANONICAL_HELD_FIELDS,
  CANONICAL_PITCH_LIMIT,
  canonicalFromWireParts,
  consumeCanonicalEdges,
  emptyCanonicalInput,
  normalizeCanonicalInput,
  projectCanonicalHandlerCalls,
  toFirePacket,
  toMoveInput,
} from "../shared/sim/canonicalPlayerInput.ts";
export type {
  CanonicalAimSnapshot,
  CanonicalApplyStepId,
  CanonicalEdgeField,
  CanonicalFireEdge,
  CanonicalFirePacket,
  CanonicalHandlerCall,
  CanonicalHeldField,
  CanonicalPlayerInput,
  CanonicalPlayerInputInit,
} from "../shared/sim/canonicalPlayerInput.ts";

/** Canonical non-input authoritative events (replay epic 5.5). */
export {
  AUTHORITATIVE_EVENT_KINDS,
  AUTHORITATIVE_INTRA_TICK_CATEGORIES,
  AUTHORITATIVE_KIND_CATEGORY,
  compareAuthoritativeEvents,
  emptyAuthoritativePose,
  emptyAuthoritativeRosterSnapshot,
  makeAgentAddEvent,
  makeAgentRemoveEvent,
  makeBotAddEvent,
  makeCombatBurstEvent,
  makeConnectionStatusEvent,
  makeGameOverEvent,
  makeHumanJoinEvent,
  makeLoadoutCommitEvent,
  makeMatchConfigEvent,
  makeMatchDrawEvent,
  makeMatchEndEvent,
  makeMatchInitEvent,
  makeMatchStartEvent,
  makePlayerDiedEvent,
  makePlayerRemoveEvent,
  makePlayerRespawnedEvent,
  makeReadyVoteEvent,
  makeScoreEvent,
  makeTeamAssignEvent,
  normalizeAppliedTick,
  normalizeAuthoritativeEvent,
  normalizeAuthoritativePose,
  normalizeAuthoritativeRosterSnapshot,
  normalizeAuthoritativeTeamId,
  sortAuthoritativeEvents,
} from "../shared/sim/authoritativeEvent.ts";
export type {
  AgentAddEvent,
  AgentRemoveEvent,
  AuthoritativeCombatOutcome,
  AuthoritativeDamageOutcome,
  AuthoritativeEvent,
  AuthoritativeEventInit,
  AuthoritativeEventKind,
  AuthoritativeHitZone,
  AuthoritativeIntraTickCategory,
  AuthoritativeMapIdentity,
  AuthoritativeMatchPhase,
  AuthoritativeMatchWinner,
  AuthoritativePose,
  AuthoritativeRaidDoorPolicy,
  AuthoritativeRosterSnapshot,
  AuthoritativeShotFired,
  AuthoritativeTeamId,
  AuthoritativeTeamScores,
  BotAddEvent,
  CombatBurstEvent,
  ConnectionStatusEvent,
  GameOverEvent,
  HumanJoinEvent,
  LoadoutCommitEvent,
  MatchConfigEvent,
  MatchDrawEvent,
  MatchEndEvent,
  MatchInitEvent,
  MatchStartEvent,
  PlayerDiedEvent,
  PlayerRemoveEvent,
  PlayerRespawnedEvent,
  ReadyVoteEvent,
  ScoreEvent,
  TeamAssignEvent,
} from "../shared/sim/authoritativeEvent.ts";

/**
 * Server weapon view: shared ms stats + tick-rate cooldowns for the sim.
 * Edit stats only in shared/sim/weapons.ts — never duplicate mag size etc. here.
 */
export type WeaponDef = SharedWeaponDef & {
  fireCooldownTicks: number;
  reloadTicks: number;
  /** Sim ticks between melee swings (null = weapon has no melee). */
  meleeCooldownTicks: number | null;
};

function toServerWeapon(w: SharedWeaponDef): WeaponDef {
  return {
    ...w,
    fireCooldownTicks: msToTicks(w.fireCooldownMs),
    reloadTicks: msToTicks(w.reloadMs),
    meleeCooldownTicks: w.melee ? msToTicks(w.melee.cooldownMs) : null,
  };
}

/** Sim ticks for holster + draw when equipping a different weapon. */
export const WEAPON_SWITCH_TICKS = msToTicks(WEAPON_SWITCH_MS);

/** Sim ticks between pistol-whip swings (alias of PISTOL.meleeCooldownTicks). */
export const MELEE_COOLDOWN_TICKS = msToTicks(MELEE_COOLDOWN_MS);

export const PISTOL: WeaponDef = toServerWeapon(SHARED_PISTOL);
export const RIFLE: WeaponDef = toServerWeapon(SHARED_RIFLE);
export const SHOTGUN: WeaponDef = toServerWeapon(SHARED_SHOTGUN);

export const WEAPONS: Record<number, WeaponDef> = {
  [WEAPON_PISTOL]: PISTOL,
  [WEAPON_RIFLE]: RIFLE,
  [WEAPON_SHOTGUN]: SHOTGUN,
};

// Keep table complete if SHARED_WEAPONS gains entries later.
for (const id of Object.keys(SHARED_WEAPONS)) {
  const n = Number(id);
  if (!(n in WEAPONS)) WEAPONS[n] = toServerWeapon(getSharedWeapon(n));
}

export function getWeapon(id: number): WeaponDef {
  return WEAPONS[id] ?? PISTOL;
}

/** Packet for NetEvents.WeaponSwitch. */
export interface WeaponSwitchPacket {
  weapon: number;
}

/**
 * Packet for NetEvents.Ability — client → server activate request.
 * Family {@link SkillId} (timed / instant); passives must not be sent.
 */
export interface AbilityPacket {
  ability: SkillId;
}

/**
 * Packet for NetEvents.SkillLoadout — client → server match loadout sync.
 * Fixed 4 slots (My Skills bar); server validates owned + unique.
 */
export interface SkillLoadoutPacket {
  slots: Array<SkillId | null>;
}

export type { AbilityId, AbilitySnapEntry, GlitchSnapState, SkillId };

/** Tick-derived delays — values come from shared/sim/game.ts (ms). */
export const RESPAWN_DELAY_TICKS = msToTicks(RESPAWN_DELAY_MS);
export const RAID_RESPAWN_DELAY_TICKS = msToTicks(RAID_RESPAWN_DELAY_MS);
/** Live match, doors closed (agents in the field). */
export const RESPAWN_DELAY_CLOSED_TICKS = msToTicks(RESPAWN_DELAY_CLOSED_MS);
export const SCORE_COOLDOWN_TICKS = msToTicks(SCORE_COOLDOWN_MS);
export const DOOR_CAPTURE_DWELL_TICKS = msToTicks(DOOR_CAPTURE_DWELL_MS);
export const SPAWN_INVULN_TICKS = msToTicks(SPAWN_INVULN_MS);
export const HIT_SLOW_DURATION_TICKS = msToTicks(HIT_SLOW_DURATION_MS);
export const MATCH_RESTART_TICKS = MATCH_RESTART_SECONDS * TICK_HZ;
/** Full match length in sim ticks. */
export const MATCH_DURATION_TICKS = MATCH_DURATION_SECONDS * TICK_HZ;
/** Ticks doors stay open each cycle. */
export const DOOR_OPEN_TICKS = msToTicks(DOOR_OPEN_MS);
/** Ticks doors stay closed each cycle. */
export const DOOR_CLOSED_TICKS = msToTicks(DOOR_CLOSED_MS);
/** Ticks doors stay closed after last agent dies (power-up before re-open). */
export const DOOR_POWER_UP_TICKS = msToTicks(DOOR_POWER_UP_MS);
/** One full open+closed cycle in ticks. */
export const DOOR_FULL_CYCLE_TICKS = DOOR_OPEN_TICKS + DOOR_CLOSED_TICKS;

/**
 * Pose snapshots on the volatile stream (60 Hz sim / 20 Hz pose).
 * Lag-comp lastApplied validation only accepts ticks on this grid
 * (or the exact last emit, for reliable keyframes).
 */
export const SNAPSHOT_EVERY_TICKS = Math.max(1, Math.round(TICK_HZ / 20));

/**
 * Max ticks a shot may rewind target poses (hard anti-cheat clamp).
 * ~250ms at 60 Hz. The RTT window in combat/lagComp.ts is usually tighter.
 */
export const LAG_COMP_MAX_REWIND_TICKS = msToTicks(250);

/**
 * Fallback rewind samples when client does not send clientTick.
 * Dense enough that a ray aimed at a recent snapshot still connects.
 */
export const LAG_COMP_FALLBACK_REWIND_TICKS = [
  0,
  1,
  2,
  3,
  4,
  5,
  6,
  8,
  10,
  12,
  15,
] as const;

export type TeamId = "A" | "B";

export interface PlayerInput {
  sequence: number;
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
  /** Hold Shift — server applies SPRINT_SPEED_MULT. Ignored if crouch. */
  sprint: boolean;
  /** Hold crouch — server applies CROUCH_SPEED_MULT (takes priority over sprint). */
  crouch: boolean;
  /**
   * One-shot standing melee lunge — same stamina gates as crouch-slide.
   * Optional for older clients; treated as false when omitted.
   */
  meleeLunge?: boolean;
  yaw: number;
  pitch: number;
}

/**
 * Bit flags for {@link SnapshotPlayer.keys} (latest held move intent).
 * Spectate / yaw-dot debug HUD only — not used for prediction.
 */
export const SNAP_KEY_FORWARD = 1;
export const SNAP_KEY_BACKWARD = 2;
export const SNAP_KEY_LEFT = 4;
export const SNAP_KEY_RIGHT = 8;
export const SNAP_KEY_JUMP = 16;
export const SNAP_KEY_SPRINT = 32;
export const SNAP_KEY_CROUCH = 64;
/** One-shot standing melee lunge (same stamina gates as crouch-slide). */
export const SNAP_KEY_MELEE_LUNGE = 128;

/** Pack boolean move keys into {@link SnapshotPlayer.keys}. */
export function encodeSnapKeys(
  input:
    | {
      forward?: boolean;
      backward?: boolean;
      left?: boolean;
      right?: boolean;
      jump?: boolean;
      sprint?: boolean;
      crouch?: boolean;
      meleeLunge?: boolean;
    }
    | null
    | undefined,
): number {
  if (!input) return 0;
  let keys = 0;
  if (input.forward) keys |= SNAP_KEY_FORWARD;
  if (input.backward) keys |= SNAP_KEY_BACKWARD;
  if (input.left) keys |= SNAP_KEY_LEFT;
  if (input.right) keys |= SNAP_KEY_RIGHT;
  if (input.jump) keys |= SNAP_KEY_JUMP;
  if (input.sprint) keys |= SNAP_KEY_SPRINT;
  if (input.crouch) keys |= SNAP_KEY_CROUCH;
  if (input.meleeLunge) keys |= SNAP_KEY_MELEE_LUNGE;
  return keys;
}

export interface ShootPacket {
  yaw: number;
  pitch: number;
  origin?: [number, number, number];
  sequence?: number;
  /**
   * Server tick for the remote world the client was aiming at when they fired
   * (latest snapshot tick minus remote interp delay). Lag-comp rewinds targets
   * to this tick so hits match the delayed mesh, not live sim pose.
   */
  clientTick?: number;
  /**
   * Latest snapshot tick the client had applied when they fired.
   * Server uses this as the snap base only if it is a tick we emitted
   * and not older than a few snapshot periods / RTT+jitter.
   */
  lastAppliedSnapshotTick?: number;
}

/**
 * Max horizontal/vertical distance client shoot origin may deviate from the
 * server eye. Beyond this the origin is soft-clamped (not discarded).
 */
export const SHOOT_ORIGIN_MAX_ERROR = 2.5;

export type HitZone = "head" | "body";

/**
 * Detail level for player snapshots.
 * - full: join / Welcome.players / Ready catch-up / PlayerJoined
 *   (name, cosmetics, score/K/D, ping) — clients cache identity from this
 * - motion: 20 Hz stream — pose, ammo, health; no score/K/D (event-driven);
 *   ping only on 2 Hz ticks; clients merge onto cached identity
 */
export type SnapshotPlayerMode = "full" | "motion";

export interface SnapshotPlayer {
  id: string;
  /**
   * Unique-on-server display name.
   * Omitted on motion-only 20 Hz snapshots once the client has cached it.
   */
  name?: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  health: number;
  /** Uniform player model / hit-volume scale. Omitted for the normal 1x size. */
  scale?: number;
  alive: boolean;
  team: TeamId;
  /**
   * Grey free-for-all hunter bot (hostile to red + blue). When true, clients
   * render grey instead of team neon. Omitted / false for normal players.
   */
  isAgent?: boolean;
  /** Spawn protection — cannot take damage; still can shoot. */
  invulnerable?: boolean;
  /** Ducking — shorter hit volumes + lower eye. */
  crouch?: boolean;
  /** Mid crouch-slide burst (sprint-speed, air aim bloom). */
  slide?: boolean;
  /** Active bullet-hit slow stacks (5% each, max 3). Omitted when inactive. */
  hitSlowStacks?: number;
  /** Sim tick when all bullet-hit slow stacks expire (exclusive). */
  hitSlowEndsAtTick?: number;
  /**
   * Seconds remaining on crouch-slide (A1 seed). Present when slide is true.
   * Without this, client replay guesses a short timer and drifts mid-slide.
   */
  slideRemaining?: number;
  /** Locked slide direction X (unit). Present when slide is true. */
  slideDirX?: number;
  /** Locked slide direction Z (unit). Present when slide is true. */
  slideDirZ?: number;
  /** Authoritative horizontal velocity (u/s) for remote locomotion. */
  velocityX?: number;
  /**
   * Vertical velocity (u/s). Required for A1 mid-jump replay; without it the
   * client seeds vy=0 and soft-correct thrash on vaults / apex.
   */
  velocityY?: number;
  /** Authoritative horizontal velocity (u/s) for remote locomotion. */
  velocityZ?: number;
  /** Active weapon id (WEAPON_PISTOL / WEAPON_RIFLE). */
  weapon?: number;
  /** Rounds currently in the magazine. */
  ammoInMag?: number;
  /** Spare full magazines left (not including the one loaded). */
  spareClips?: number;
  /** True while a reload is in progress on the active weapon. */
  reloading?: boolean;
  /** Shell guns: cocking after a shot / reload / draw. Omitted when false. */
  pumping?: boolean;
  /** True while holstering / drawing after a weapon switch. */
  switching?: boolean;
  /**
   * Stamina-seconds remaining (0 … SPRINT_DURATION_S).
   * Full bar lasts SPRINT_DURATION_S / SPRINT_DRAIN_MULT seconds of sprint.
   */
  sprintStamina?: number;
  /**
   * Active ability windows. Omitted when none are active.
   * Used for local prediction reconcile + remotes (Glitch).
   */
  abilities?: AbilitySnapEntry[];
  /**
   * Skills already used this charge cycle, or locked until door this life
   * (grey until door regen).
   * Full snaps only. Omitted when empty. Ids are skill families.
   */
  abilitySpent?: SkillId[];
  /**
   * Sim tick when the global ability lock ends (exclusive). Top bar drains
   * until this. Full snaps only. Omitted when not locked.
   */
  abilityLockEndsAtTick?: number;
  /**
   * Sim tick when bar reverse-fill or door charge regen ends (exclusive).
   * Full snaps only. Omitted when idle.
   */
  abilityRegenEndsAtTick?: number;
  /**
   * Glitch remote visibility. `hidden` = fully invisible to others;
   * `revealed` = forced visible within 5u of enemy door. Omitted when
   * Glitch is not active.
   */
  glitch?: GlitchSnapState;
  /**
   * Highest input sequence the server has *stepped* into this pose (A1).
   * Client keeps this cmd and replays only the remaining hold ticks.
   * Omitted for bots / before first input.
   */
  lastProcessedInputSeq?: number;
  /**
   * How many sim ticks lastProcessedInputSeq has already been held (1…).
   * A1 replays max(0, ticksPerInput − hold) of that cmd, then full later cmds.
   */
  inputHoldTicks?: number;
  /**
   * Latest held move keys as a bitfield (spectate / yaw-dot debug HUD).
   * Bits: 1=forward 2=back 4=left 8=right 16=jump 32=sprint 64=crouch.
   * Always set on motion + full snaps (0 when no input).
   */
  keys?: number;
  /**
   * Bot brain decision bitfield (spectate Y-mode decision tree).
   * Bits defined in shared/bots/botDecisions.ts. Present only for bots; omitted
   * for humans so the client can hide the panel.
   */
  botDec?: number;
  /** Personal door captures (TAB scoreboard rank). */
  score?: number;
  /** Confirmed kills. */
  kills?: number;
  /** Times eliminated. */
  deaths?: number;
  /** Lifetime XP for the level badge (full identity snapshots only). */
  xp?: number;
  /** Live MMS prestige badge (full identity snapshots only). */
  mmsRankId?: MmsRankId;
  /** Permanent Founder badge entitlement (full identity snapshots only). */
  founderBadge?: boolean;
  /**
   * True while the player's socket is down (grace period). They remain in the
   * match as a sitting duck until reconnect or timeout.
   */
  connectionIssue?: boolean;
  /**
   * True when the player has had no meaningful activity (move / look / shoot /
   * reload / switch) for AFK_TIMEOUT_MS. Frozen at death so closed-door waits
   * do not auto-AFK. Not set while connectionIssue.
   */
  afk?: boolean;
  /**
   * Whole seconds remaining until AFK kick (ceil). Only set while {@link afk}
   * is true. Counts down from AFK_KICK_MS after the AFK flag starts.
   * Omitted during intermission (AFK hard-kick is suspended for endgame).
   */
  afkKickIn?: number;
  /**
   * One-way-ish RTT in ms (server ping → client pong). Omitted until the first
   * successful sample for humans. Community/balance/agent bots omit; official
   * pool pawns may carry a stable fake value for the TAB scoreboard.
   */
  ping?: number;
  /**
   * Account cosmetics (Clerk join only). Guests/bots omit or use defaults.
   * head: 0…HEAD_TYPE_COUNT-1 mesh variant.
   */
  head?: number;
  /** Visor / eyes: 0 standard, 1 octo, 2 diamond, 3 spike, 4 dome. */
  visor?: number;
  /** Shoulder mesh: 0…SHOULDER_TYPE_COUNT-1. */
  shoulder?: number;
  /** Body/torso mesh: 0…BODY_TYPE_COUNT-1. */
  body?: number;
  /** Leg mesh: 0 standard, 1 octo, 2 diamond, 3 spike, 4 dome. */
  leg?: number;
  /** Player (body) neon hue shift -2…2 (shop tints stay within ±1). */
  hue?: number;
  /** Gun neon hue shift -2…2 (independent of body hue). */
  gunHue?: number;
  /** Bullet tracer hue shift -2…2. */
  bulletHue?: number;
  /** Packed crosshair color; -1 = default (first-person + killcam only). */
  crosshairColor?: number;
  /** Own name tag hue shift -2…2 off team color (shown when aimed at). */
  nameHue?: number;
  /** Pistol mesh style 0…4. */
  pistol?: number;
  /** Rifle mesh style 0…4. */
  rifle?: number;
  /** Shotgun mesh style 0…4. */
  shotgun?: number;
  /** Rifle optic 0…4. Omitted joins use Standard. */
  scope?: number;
  /** Crosshair style 0…4 (first-person only; still carried on identity). */
  crosshair?: number;
}

/**
 * Network placeholder for a future projectile entity (epic 4.4).
 *
 * The live game is hitscan-only: authoritative snapshots always send
 * `projectiles: []` and nothing populates this shape. If a later epic adds
 * simulated projectiles, the minimal sim state to account for in ordering /
 * checkpoints is: stable `id`, owning player id, position + velocity per tick,
 * expiry tick, collision against the existing move/collision solid surface,
 * and optional damage payload / weapon id. Do not treat this wire type alone
 * as that full state.
 */
export interface SnapshotProjectile {
  id: string;
  x: number;
  y: number;
  z: number;
}

export interface TeamScores {
  A: number;
  B: number;
}

/** Door open/closed phase shared on snapshots and join packets. */
export interface DoorCycleState {
  /** True when enemy doors can be captured. */
  doorsOpen: boolean;
  /**
   * Sim tick when doors next toggle. Client derives seconds remaining from
   * this and the packet's `tick` (or current estimated tick).
   */
  doorChangeTick: number;
}

/** Match clock shared on snapshots and join packets. */
export interface MatchClockState {
  /**
   * Sim tick when the match time limit expires (most points wins).
   * Client derives remaining time from this and the packet's `tick`.
   */
  matchEndTick: number;
}

/**
 * Ranked session phase (community servers stay on `"live"`).
 * Prematch = warm-up lobby before scored play; intermission = post game-over.
 */
export type MatchPhase = "prematch" | "live" | "intermission";

/**
 * Broadcast whenever ranked pre-match lobby state changes (join/leave/ready/start).
 * Also attached to Welcome so late joiners sync immediately.
 */
export interface PrematchStatePacket {
  phase: MatchPhase;
  humanCount: number;
  humansReady: number;
  minHumans: number;
  /**
   * True when min humans + even-team gates pass (ready votes can start the match).
   * False while waiting for more / balanced humans.
   */
  canVote: boolean;
  /** Player ids that have voted ready (humans only). */
  readyPlayerIds: string[];
  teamHumans: { A: number; B: number };
  requireEvenTeams: boolean;
}

/** Client → server: cast or clear ready vote during ranked pre-match. */
export interface MatchReadyPacket {
  ready: boolean;
}

export interface SnapshotPacket extends DoorCycleState, MatchClockState {
  /** Authoritative simulation tick; derive simulation time from tick / tickRate. */
  tick: number;
  /**
   * Best-effort per-socket host emit marker for diagnosing delayed/bursty
   * snapshot delivery. `emitAtMs` is server-monotonic and must only be
   * compared with other server markers, never with browser performance.now().
   */
  transport?: {
    emitSeq: number;
    emitAtMs: number;
    kind: "volatile" | "heartbeat" | "catchup";
  };
  players: SnapshotPlayer[];
  projectiles: SnapshotProjectile[];
  scores: TeamScores;
  /** Ranked phase when present (community may omit → treat as live). */
  phase?: MatchPhase;
}

export interface WelcomePacket extends DoorCycleState, MatchClockState {
  id: string;
  serverName: string;
  tickRate: number;
  snapshotRate: number;
  /** Current sim tick (for door cycle / join-time sync). */
  tick: number;
  spawn: SnapshotPlayer;
  /**
   * Full-identity roster at join / Ready (names, cosmetics, scoreboard).
   * High-rate snapshots are motion-only; clients cache this once.
   */
  players: SnapshotPlayer[];
  team: TeamId;
  map: DoorsMap;
  scores: TeamScores;
  /** Present when the client joins during the post-match intermission. */
  gameOver?: GameOverPacket;
  /** Ranked pre-match / phase snapshot for lobby HUD. */
  prematch?: PrematchStatePacket;
  /** True when this is an official ranked instance. */
  ranked?: boolean;
  /**
   * Open-match bot auto-fill target (total humans + bots). Client allows
   * change-team while humanCount < autofillBots (bot-fill regime).
   * Omitted on ranked servers.
   */
  autofillBots?: number;
  /**
   * Open-match team rebalance vote tallies + whether this client has voted.
   * Omitted on ranked servers.
   */
  rebalanceVote?: TeamRebalanceVoteStatePacket & { youVoted: boolean };
  /**
   * Admin spectator: no player body, no inputs. Camera follows any roster
   * player/bot. Omitted / false for normal joins.
   */
  spectator?: boolean;
  /**
   * PR7: skill products permanently owned by this account
   * (e.g. quick, quick2, selfHeal). Empty array → all slots locked.
   * Omitted on legacy servers → treat as none.
   */
  ownedAbilities?: import("../shared/sim/skills.ts").SkillProductId[];
  /**
   * PR-2: validated match loadout (Ability 1–4). Empty slots are null.
   * Omitted when unrestricted (bots) or legacy servers.
   */
  skillLoadout?: Array<import("../shared/sim/skills.ts").SkillId | null>;
}

export interface ShotFiredPacket {
  shooterId: string;
  origin: [number, number, number];
  direction: [number, number, number];
  weapon: number;
  hitId: string | null;
  hitZone: HitZone | null;
  hitPoint: [number, number, number] | null;
  /**
   * Pistol-whip swing (clients: swing animation + thwack, no tracer/gunshot).
   * Always broadcast, even on a miss, so observers see the swing.
   */
  melee?: boolean;
  /**
   * Multi-pellet shots only (shotgun): every pellet, index 0 = the centre
   * pellet (same as the top-level direction / hit fields). Omitted for
   * single-pellet guns.
   */
  pellets?: ShotPellet[];
}

/** One pellet of a multi-pellet shot (tracer + hit). */
export interface ShotPellet {
  direction: [number, number, number];
  hitId: string | null;
  hitZone: HitZone | null;
  /** Player hit point, else wall impact, else null (ran out of range). */
  hitPoint: [number, number, number] | null;
}

/** Client → server pistol-whip request. Same shape as ShootPacket. */
export interface MeleePacket {
  yaw: number;
  pitch: number;
  origin?: [number, number, number];
  sequence?: number;
  clientTick?: number;
  lastAppliedSnapshotTick?: number;
}

export interface PlayerDamagedPacket {
  targetId: string;
  shooterId: string;
  damage: number;
  health: number;
  zone: HitZone;
  alive: boolean;
  /** True when the random damage roll exceeded +2%. */
  critical: boolean;
  /** Authoritative active bullet-hit slow stacks after this damage. */
  hitSlowStacks?: number;
  /** Sim tick when all authoritative bullet-hit slow stacks expire. */
  hitSlowEndsAtTick?: number;
}

export interface PlayerDiedPacket {
  victimId: string;
  killerId: string;
  zone: HitZone;
  /** Weapon that scored the kill (same ids as ammo HUD). */
  weapon: number;
  /** Display names for kill feed. */
  killerName: string;
  victimName: string;
  /** Team colors for kill-feed name tints. */
  killerTeam: TeamId;
  victimTeam: TeamId;
  /** Grey agent killer — kill feed uses agent color, not team neon. */
  killerIsAgent?: boolean;
  /** Grey agent victim. */
  victimIsAgent?: boolean;
}

/**
 * One shot + any damage/death side-effects, packed for a single emit.
 * Prefer CombatBurst over legacy ShotFired/PlayerDamaged/PlayerDied.
 */
export interface CombatOutcomePacket {
  shot: ShotFiredPacket;
  damages?: PlayerDamagedPacket[];
  deaths?: PlayerDiedPacket[];
  /** Shooter received Leech heal from this shot (client VFX). */
  leech?: boolean;
}

/**
 * One or more combat outcomes in a single Socket.IO message.
 * Used for human shots (length 1) and multi-bot fire in the same tick.
 */
export interface CombatBurstPacket {
  outcomes: CombatOutcomePacket[];
}

export interface PlayerRespawnedPacket {
  player: SnapshotPlayer;
}

/**
 * Client → server: request to switch teams (open matches only).
 * Omitting `team` flips A↔B.
 */
export interface ChangeTeamPacket {
  team?: TeamId;
}

/** Server → all: a player switched teams (includes respawn pose). */
export interface TeamChangedPacket {
  id: string;
  team: TeamId;
  player: SnapshotPlayer;
  /** Why the switch happened (omit for legacy / manual). */
  reason?: "manual" | "auto_rebalance";
}

/**
 * Server → one client: you will be force-swapped after `delayMs` for open-match
 * team rebalance (player-voted). Show a pulsing banner until swap or cancel.
 */
export interface AutoTeamRebalanceNoticePacket {
  delayMs: number;
  from: TeamId;
  to: TeamId;
  message: string;
}

/** Server → one client: pending team rebalance cancelled (hide banner). */
export interface AutoTeamRebalanceCancelPacket {
  /** Optional machine reason for debugging; clients may ignore. */
  reason?: string;
}

/**
 * Client → server: cast or clear a vote to rebalance teams (open matches).
 * Omit `vote` or pass true to vote; false clears the vote.
 */
export interface TeamRebalanceVotePacket {
  vote?: boolean;
}

/** Server → all: live tallies for open-match team rebalance votes. */
export interface TeamRebalanceVoteStatePacket {
  /** How many humans currently have an active rebalance vote. */
  votes: number;
  /** Votes needed to pass (`> 1/3` of humans). */
  needed: number;
  /** Connected human count used for the threshold. */
  humans: number;
  /** True when match-player teams currently need rebalancing (|diff| ≥ 2). */
  neededByBalance: boolean;
}

/** Server → requester: outcome of a TeamRebalanceVote request. */
export interface TeamRebalanceVoteResultPacket {
  ok: boolean;
  error?: string;
  /** Your vote after the request (false if cleared / rejected). */
  voted?: boolean;
}

/** Server → requester: outcome of a ChangeTeam request. */
export interface ChangeTeamResultPacket {
  ok: boolean;
  error?: string;
  team?: TeamId;
}

export interface ScorePacket {
  scorerId: string;
  team: TeamId;
  scores: TeamScores;
  /** Scorer was teleported to their own door after the capture. */
  player: SnapshotPlayer;
  /**
   * Co-op raid only: every surviving teammate reset at their own door for the
   * next capture. Eliminated teammates are intentionally omitted.
   */
  resetPlayers?: SnapshotPlayer[];
}

/** One row of end-of-match stats (mirrors the TAB scoreboard). */
export interface GameOverPlayerStat {
  id: string;
  name: string;
  team: TeamId;
  score: number;
  kills: number;
  deaths: number;
  /** Whether the player was alive when the match ended. */
  alive: boolean;
  xp: number;
  mmsRankId: MmsRankId;
  founderBadge: boolean;
}

/** Winner of a finished match, or "draw" when the match is cut short (e.g. map change). */
export type MatchResult = TeamId | "draw";

/** One map choice in the post-match vote. */
export interface MapVoteOption {
  /** Internal map name (unique on the server). */
  name: string;
  votes: number;
}

/** Live tallies during the intermission map vote. */
export interface MapVoteStatePacket {
  options: MapVoteOption[];
  /** How many connected players have cast a vote. */
  voterCount: number;
}

/** Client → server: cast or change a map vote (only during intermission). */
export interface MapVotePacket {
  mapName: string;
}

/** How official servers grant XP for this completed match (absent = none). */
export type GameOverXpMode = "ranked" | "unranked";

/** Broadcast when a team reaches WIN_SCORE and leads by WIN_BY_MARGIN. */
export interface GameOverPacket {
  winner: MatchResult;
  scores: TeamScores;
  players: GameOverPlayerStat[];
  /**
   * Seconds until the next match starts, or until players are returned to
   * the menu when {@link GameOverPacket.returnToMenu} is set.
   */
  restartInSeconds: number;
  /** Intermission ends by sending everyone to the main menu (raid / drain). */
  returnToMenu?: boolean;
  /** Map vote options + tallies (players pick next map during intermission). */
  mapVote?: MapVoteStatePacket;
  /**
   * Present on official authentic servers that report progression.
   * Ranked: match base + win bonus + kills/doors.
   * Unranked: open match base + win bonus + kills/doors.
   * Actual XP/coin UI waits for MatchProgression (post DB confirm).
   */
  xpMode?: GameOverXpMode;
  matchKind?: "raid";
  raid?: {
    door: number;
    goal: number;
    respawnMs: number;
    title: string;
    map?: string;
    prevMap?: string;
    nextMap?: string;
  };
}

/**
 * Server → one client after match-report succeeds (DB already committed).
 * Ranked: personal SS = teamShare + doorBonus; teamSkillPot is context only.
 * Open official: skill deltas are 0; XP/coins still set.
 * mmr* fields are MMS (SS+XP) before/after.
 */
export interface MatchProgressionPacket {
  matchId?: number;
  skillBefore: number;
  skillDelta: number;
  skillAfter: number;
  mmrBefore: number;
  mmrDelta: number;
  mmrAfter: number;
  xpBefore: number;
  xpEarned: number;
  xpAfter: number;
  coinsBefore: number;
  coinsEarned: number;
  coinsAfter: number;
  teamSkillPot: number;
  teamShare: number;
  doorBonus: number;
  doors: number;
  shareOfPot: number;
  performanceRank: number;
  teamSize: number;
}

/** Broadcast when a new match begins after the intermission (or prematch → live). */
export interface MatchStartPacket extends DoorCycleState, MatchClockState {
  scores: TeamScores;
  players: SnapshotPlayer[];
  /** Ranked phase after start (`live` or `prematch` after intermission reset). */
  phase?: MatchPhase;
}

/**
 * Broadcast when the host switches maps mid-session.
 * Players stay connected; clients rebuild the world from `map`.
 */
export interface MapChangePacket extends DoorCycleState, MatchClockState {
  map: DoorsMap;
  scores: TeamScores;
  players: SnapshotPlayer[];
  /**
   * True when the previous match was still in progress and is treated as a
   * draw (not set during the post-match intermission).
   */
  endedAsDraw: boolean;
  /** Final scores of the match that was cut short (only when endedAsDraw). */
  previousScores?: TeamScores;
  /** In-raid stage transition; preserves the active raid and ability state. */
  raidStage?: boolean;
  /**
   * Raid stage neighbors for beyond-door peeks (catalog map names).
   * Omitted when same as the active map or when not a raid stage.
   */
  prevMap?: string;
  nextMap?: string;
}

/** Client → server: authority-signed admin action token. */
export interface AdminCommandPacket {
  token: string;
}

/** Server → client: bot heatmap tracking state (admin HUD). */
export interface BotHeatmapTrackingPacket {
  engaged: boolean;
}

/** Server → requester: admin command outcome. */
export type AdminCommandResultPacket =
  | {
    ok: true;
    command: string;
    message: string;
    data?: Record<string, unknown>;
    jti?: string;
  }
  | {
    ok: false;
    error: string;
    code?: string;
    command?: string;
    jti?: string;
  };

/** Broadcast when a player drops into the connection-issue grace period. */
export interface PlayerConnectionIssuePacket {
  id: string;
  /** Seconds remaining before the server drops them. */
  timeoutSeconds: number;
}

/** Broadcast when a player reclaims their slot after a connection issue. */
export interface PlayerConnectionRestoredPacket {
  id: string;
  /** Authoritative pose/state after restore (respawn if they died while down). */
  player: SnapshotPlayer;
}

/**
 * Server → previous client only: same user joined this match again.
 * Client should leave to the menu and skip connection-issue reconnect.
 */
export interface SessionReplacedPacket {
  /** Stable reason code for UI / analytics. */
  reason: "joined_elsewhere";
  /** Human-readable notice for the kicked client. */
  message: string;
}

/**
 * Server → this client only: hard-removed from the match (e.g. AFK timeout).
 * Client should leave to the menu and skip connection-issue reconnect.
 */
export interface KickedPacket {
  /** Stable reason code for UI / analytics. */
  reason: "afk" | "return_to_menu" | "raid_load_timeout";
  /** Human-readable notice for the kicked client. */
  message: string;
}

/**
 * Ranked live match voided after first human abandon.
 * Remaining players may leave with no further ranking penalty.
 */
export interface MatchVoidedPacket {
  /** Stable session id of the leaver (may already be gone from roster). */
  abandonedById: string;
  abandonedByName: string;
  /** Always true in v1 — remaining players free to leave. */
  freeToLeave: true;
  message: string;
}

export const NetEvents = {
  Connection: "connection",
  Disconnect: "disconnect",
  /** Client intentional leave — skip the connection-issue grace period. */
  Leave: "leave",
  Welcome: "welcome",
  Ready: "ready",
  Input: "input",
  Snapshot: "snapshot",
  PlayerJoined: "playerJoined",
  PlayerLeft: "playerLeft",
  PlayerConnectionIssue: "playerConnectionIssue",
  PlayerConnectionRestored: "playerConnectionRestored",
  /**
   * Server → previous client only: same account/name joined again (other tab
   * or device). Client should exit to menu and not attempt reconnect grace.
   */
  SessionReplaced: "sessionReplaced",
  /**
   * Server → this client only: hard-kicked (AFK). Exit to menu; no reconnect grace.
   */
  Kicked: "kicked",
  Shoot: "shoot",
  /** Client → server: pistol-whip request (pistol equipped only). */
  Melee: "melee",
  Reload: "reload",
  /** @deprecated Prefer CombatBurst — kept for older clients during transition. */
  ShotFired: "shotFired",
  /** @deprecated Prefer CombatBurst. */
  PlayerDamaged: "playerDamaged",
  /**
   * Non-shot deaths (player-player overlap oof). Shot kills travel in CombatBurst.
   */
  PlayerDied: "playerDied",
  /**
   * Batched combat: one or more shots with embedded damage/death events.
   * Replaces multi-emit ShotFired + PlayerDamaged + PlayerDied fan-out.
   */
  CombatBurst: "combatBurst",
  PlayerRespawned: "playerRespawned",
  /**
   * Client → server: switch teams on open matches (validated server-side).
   * Server broadcasts TeamChanged on success; replies ChangeTeamResult either way.
   */
  ChangeTeam: "changeTeam",
  /** Server → all: player switched teams + respawned. */
  TeamChanged: "teamChanged",
  /** Server → requester: ChangeTeam accepted or rejected. */
  ChangeTeamResult: "changeTeamResult",
  /**
   * Server → one client: open-match team rebalance selected you; swap after delay.
   */
  AutoTeamRebalanceNotice: "autoTeamRebalanceNotice",
  /** Server → one client: pending team rebalance cancelled. */
  AutoTeamRebalanceCancel: "autoTeamRebalanceCancel",
  /**
   * Client → server: vote (or clear vote) to rebalance open-match teams.
   * Server replies TeamRebalanceVoteResult and broadcasts TeamRebalanceVoteState.
   */
  TeamRebalanceVote: "teamRebalanceVote",
  /** Server → requester: TeamRebalanceVote accepted or rejected. */
  TeamRebalanceVoteResult: "teamRebalanceVoteResult",
  /** Server → all: rebalance vote tallies. */
  TeamRebalanceVoteState: "teamRebalanceVoteState",
  Score: "score",
  GameOver: "gameOver",
  MatchStart: "matchStart",
  MapChange: "mapChange",
  /** Client casts a map vote; server broadcasts MapVoteState. */
  MapVote: "mapVote",
  MapVoteState: "mapVoteState",
  /**
   * Client → server: authority-signed admin action token.
   * Only accepted when the runtime has authority token public keys.
   */
  AdminCommand: "adminCommand",
  /** Server → requester only: admin command outcome. */
  AdminCommandResult: "adminCommandResult",
  /**
   * Server → requester (or admin): bot heatmap collection engaged/disengaged.
   * Used for the in-game HUD label under the minimap.
   */
  BotHeatmapTracking: "botHeatmapTracking",
  /**
   * Client → server: ready / unready during ranked pre-match.
   * Distinct from `Ready` (client requests welcome re-sync).
   */
  MatchReady: "matchReady",
  /** Server → clients: ranked pre-match lobby state. */
  PrematchState: "prematchState",
  /**
   * Server → clients: ranked live match voided after first human abandon.
   * Remaining players free to leave without ranking penalty.
   */
  MatchVoided: "matchVoided",
  /**
   * Server → one client: authority progression after a scored ranked match
   * (skill pot share, door bonus, XP).
   */
  MatchProgression: "matchProgression",
  JoinRoom: "joinRoom",
  LeaveRoom: "leaveRoom",
  WeaponSwitch: "weaponSwitch",
  /**
   * Client → server: activate a skill family ({@link SkillId}).
   * Timed → window + charge on end; instant → charge + lock; passive rejected.
   */
  Ability: "ability",
  /**
   * Client → server: set match skill loadout (4 slots from My Skills /
   * account). Server validates owned + unique; reply is the
   * welcome/skillLoadout field only on Welcome — this event is fire-and-forget
   * apply. Account join tokens may already have applied the saved bar.
   */
  SkillLoadout: "skillLoadout",
  Knife: "knife",
  Chat: "chat",
  /**
   * Server → client latency probe (`{ t: serverMs }`).
   * Client must immediately emit Pong with the same payload.
   */
  Ping: "ping",
  /** Client → server reply to Ping (`{ t: serverMs }`). */
  Pong: "pong",
  /**
   * Client → server: request a reliable thin pose after wire silence (A4).
   * Server rate-limits and replies with a reliable Snapshot to this socket only.
   * Do not use for full 20 Hz — only starvation recovery.
   */
  RequestPoseHeartbeat: "requestPoseHeartbeat",
  /**
   * Client → server: map built and first frame presented. Raids hold doors
   * and bots until every reserved party member has sent it.
   */
  MapLoaded: "mapLoaded",
} as const;

/**
 * Latency probe payload (server wall-clock ms stamped at send).
 * Optional `srv` piggybacks sim tick budget stats (~1 Hz) for the client perf HUD.
 * Optional `net` piggybacks pose-stream mirror (C5 / honest loss layers).
 */
export interface PingPacket {
  t: number;
  /**
   * Server sim tick capacity (from TickTimingStats).
   * `avg` / `peak` are fractions of `budgetMs` (0.06 = 6% of budget).
   */
  srv?: {
    /** Sim rate (Hz), typically 60. */
    hz: number;
    /** RMS tick wall time / budget over ~1s. */
    avg: number;
    /** Peak tick wall time / budget over ~30s. */
    peak: number;
    /** Max wall time allowed per tick (ms) = 1000 / hz. */
    budgetMs: number;
  };
  /**
   * Pose stream mirror for this client + host aggregate (C5 / honest loss).
   * Counters are cumulative since connect; client derives recent volDrop% from deltas.
   */
  net?: {
    /** This socket: volatile snapshots that left the host. */
    vSent: number;
    /** This socket: volatile drops (transport not writable). */
    vDrop: number;
    /** This socket: reliable pose heartbeats. */
    hb: number;
    /** This socket: peak Engine.IO write-buffer length. */
    peakWb: number;
    /** Host total volatile sent (all clients). */
    hSent: number;
    /** Host total volatile drops. */
    hDrop: number;
    /** Host max peak write buffer across clients. */
    hPeakWb: number;
    /** Clients with ≥1 volatile drop. */
    hDropClients: number;
    /**
     * Cumulative rewind-window clamps (this socket / host). Optional — older
     * codecs omit these; hitch HUD shows dashes until present.
     */
    rwClamp?: number;
    rwFwd?: number;
    rwBack?: number;
    hRwClamp?: number;
  };
}
