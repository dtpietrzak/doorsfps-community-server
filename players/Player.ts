import type {
  AbilityId,
  AbilitySnapEntry,
  HitZone,
  PlayerEquipment,
  PlayerInput,
  SnapshotPlayer,
  SnapshotPlayerMode,
  TeamId,
  WeaponDef,
} from "../protocol/network.ts";
import {
  AFK_KICK_MS,
  AFK_TIMEOUT_MS,
  agentPlayerEquipment,
  defaultPlayerEquipment,
  DT,
  encodeSnapKeys,
  getWeapon,
  HIT_SLOW_DURATION_TICKS,
  HIT_SLOW_MAX_STACKS,
  hitSlowMoveSpeedScale,
  isWeaponId,
  LAG_COMP_MAX_REWIND_TICKS,
  MAX_HEALTH,
  msToTicks,
  normalizePlayerEquipment,
  RESPAWN_DELAY_TICKS,
  SPAWN_INVULN_TICKS,
  SPRINT_DURATION_S,
  TICK_HZ,
  WEAPON_ORDER,
  WEAPON_PISTOL,
  WEAPON_SWITCH_TICKS,
  WEAPONS,
} from "../protocol/network.ts";
import {
  createPingFilter,
  type LagCompClampDir,
  observeRttSample,
  type PingFilter,
} from "../combat/lagComp.ts";
import {
  ABILITY_ORDER,
  abilityBarRegenTicks,
  abilityDoorRegenTicks,
  type GlitchSnapState,
  isAbilityActiveAt,
  isGlitchForcedVisible,
} from "../shared/sim/abilities.ts";
import { MMS_RANKS, type MmsRankId } from "../shared/progression/mmsRanks.ts";
import {
  defaultSkillLoadout,
  getSkillDef,
  INSTANT_SKILL_FLASH_TICKS,
  instantSkillLockTicks,
  isSkillActivatable,
  isSkillEquipped,
  isSkillId,
  isSkillProductId,
  normalizeSkillLoadout,
  ownsSkill,
  SKILL_ORDER,
  SKILL_PRODUCT_ORDER,
  type SkillId,
  type SkillLoadout,
  type SkillProductId,
  skillValueForOwned,
  timedSkillDurationSForOwned,
  timedSkillDurationTicks,
} from "../shared/sim/skills.ts";
import { doorSegment } from "../world/map.ts";
import {
  RAPID_FIRE_BONUS_SHELLS,
  shellReloadOf,
  spareClipsForWeapon,
} from "../shared/sim/weapons.ts";
import { RUNTIME_PARTY_SIZE_ABSOLUTE_MAX } from "../shared/social/partyTeamBalance.ts";
import { CROUCH_EYE_HEIGHT, STAND_EYE_HEIGHT } from "../combat/hitscan.ts";
import type { MapCollision } from "../world/MapCollision.ts";
import type { CheckpointPlayerState } from "../replay/authoritativeCheckpoint.ts";
import {
  classifyTickAssociation,
  consumeWireMovementEdges,
  type TickSelectedInput,
} from "./tickAssociation.ts";
import {
  blinkAlongYaw,
  type MoveCollision,
  moveCollisionHeight,
  moveEyeHeight,
  MOVE_GRAVITY,
  type MoveInput,
  type MoveState,
  NO_COLLISION,
  stepMove,
} from "../shared/sim/moveStep.ts";
import {
  applyPlayerClip,
  type PlayerClipPose,
  withPlayerObstacles,
} from "../shared/sim/playerClip.ts";
import { playerLandingHitAmount } from "../shared/sim/playerHitVolumes.ts";
import { wishMoveYaw, yawFromWorldDir } from "../shared/world/yawPole.ts";

// Re-export mobility contract so tests / callers can import from Player.ts.
export {
  CROUCH_SPEED_MULT,
  JUMP_STAMINA_COST,
  jumpStaminaCostSeconds,
  moveSpeedForInput,
  SLIDE_DURATION_S,
  SLIDE_STAMINA_COST,
  slideStaminaCostSeconds,
  SPRINT_CROUCH_REGEN_MULT,
  SPRINT_DURATION_S,
  SPRINT_MOVE_REGEN_MULT,
  SPRINT_REGEN_PER_S,
  SPRINT_SPEED_MULT,
  sprintDrainPerSecond,
  sprintRegenPerSecond,
  WALK_SPEED,
} from "../protocol/network.ts";

/** Wire-only: 3 decimal places for position (motion snapshots). */
function quantizePos(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Wire-only: ~0.001 rad for look angles. */
function quantizeAngle(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Wire-only: hundredths of a second for sprint stamina. */
function quantizeStamina(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Wire-only: hundredths for velocity components (u/s). */
function quantizeVel(n: number): number {
  return Math.round(n * 100) / 100;
}

function identityNum(n: number): number {
  return n;
}

type WeaponLoadout = {
  ammoInMag: number;
  /** Spare magazines (mag guns) or loose spare shells (shell guns). */
  spareClips: number;
  /**
   * Shell guns: cocked and ready to fire. Cleared by a shot or a pump start,
   * set when a pump finishes. Always true for mag guns.
   */
  chambered: boolean;
};

/**
 * Every defined weapon gets a slot, so a weapon outside {@link WEAPON_ORDER}
 * (the shotgun before PR 8) still has ammo when a test equips it directly.
 */
const LOADOUT_WEAPON_IDS: readonly number[] = Object.keys(WEAPONS)
  .map(Number)
  .sort((a, b) => a - b);

function defaultLoadouts(): Record<number, WeaponLoadout> {
  const out: Record<number, WeaponLoadout> = {};
  for (const id of LOADOUT_WEAPON_IDS) {
    const w = WEAPONS[id]!;
    out[id] = {
      ammoInMag: w.magSize,
      spareClips: spareClipsForWeapon(id),
      chambered: true,
    };
  }
  return out;
}

/** Smallest absolute angle between two yaws in radians. */
function angleDelta(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return Math.abs(d);
}

export function eyeHeightForCrouch(crouch: boolean): number {
  return crouch ? CROUCH_EYE_HEIGHT : STAND_EYE_HEIGHT;
}

/** Standing eye height — used as default spawn / ground clamp when upright. */
export const PLAYER_HEIGHT = STAND_EYE_HEIGHT;

/**
 * Pose history window (ms): lag-comp (~350ms) plus Skill E Rewind (max 3s)
 * with a short margin so the oldest sample at the cutoff is still retained.
 */
export const POSE_HISTORY_MS = 3500;
/** Tick span retained for lag-comp + Rewind. */
export const POSE_HISTORY_TICKS = msToTicks(POSE_HISTORY_MS);
/**
 * Fixed ring capacity: one sample per sim tick over the history window, plus
 * one slot of slack so the oldest sample at the cutoff is still retained.
 */
const POSE_HISTORY_CAPACITY = POSE_HISTORY_TICKS + 1;

export type SpawnPose = {
  x: number;
  y?: number;
  z: number;
  yaw?: number;
  pitch?: number;
};

/**
 * Authoritative player simulation state inventory for replay/checkpoint work.
 *
 * This is a documentation boundary, not a serializer or hash implementation.
 * Future checkpoint and determinism code must account for the following values
 * when reproducing player mobility and damage/death behavior:
 *
 * Mobility and pose: `x`, `y`, `z`, `yaw`, `pitch`, `velocityX`, `velocityY`,
 * `velocityZ`, `onGround`, `lastLandedAtTick`, `crouch`, `sprintStamina`,
 * `slideRemaining`, `slideDirX`, `slideDirZ`, `slideForceCrouch`,
 * `prevInputCrouch`, `moveSpeedScale`, and `connectionIssue`.
 *
 * Damage and lifecycle: `maxHealth`, `health`, `alive`, `spawnedAtTick`,
 * `diedAtTick`, plus tick-based damage modifiers and invulnerability state
 * such as hit-slow and active ability expiry values.
 *
 * Input boundary (epic 5.2): `latestInput` is the arrival buffer (last-write-
 * wins). Each `update` snapshots it into the tick's selected input before
 * movement; `appliedSequence` / `inputHoldTicks` track what was stepped.
 * Recording (#8.3) must read {@link lastTickInputSelection}, never `latestInput`.
 * See `tickAssociation.ts` / `TICK_ASSOCIATION.md`.
 *
 * Explicitly outside this inventory are wall-clock AFK/participation meters,
 * network quantization, rendering/camera state, and future replay storage.
 */

export type PoseSample = {
  tick: number;
  x: number;
  y: number;
  z: number;
  crouch: boolean;
  slide: boolean;
  yaw: number;
  pitch: number;
  velocityX: number;
  velocityY: number;
  velocityZ: number;
  onGround: boolean;
  landingAmount: number;
};

type PoseAt = {
  x: number;
  y: number;
  z: number;
  crouch: boolean;
  slide: boolean;
  yaw: number;
  pitch: number;
  velocityX: number;
  velocityY: number;
  velocityZ: number;
  onGround: boolean;
  landingAmount: number;
};

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/**
 * Fixed-capacity pose ring for lag-comp. Avoids Array.shift() GC churn while
 * preserving chronological poseAt interpolation.
 */
class PoseHistoryRing {
  private readonly capacity: number;
  private readonly samples: PoseSample[];
  private count = 0;
  /** Next write index. */
  private write = 0;

  constructor(capacity: number) {
    this.capacity = Math.max(2, capacity);
    this.samples = new Array(this.capacity);
    for (let i = 0; i < this.capacity; i++) {
      this.samples[i] = {
        tick: 0,
        x: 0,
        y: 0,
        z: 0,
        crouch: false,
        slide: false,
        yaw: 0,
        pitch: 0,
        velocityX: 0,
        velocityY: 0,
        velocityZ: 0,
        onGround: true,
        landingAmount: 0,
      };
    }
  }

  clear(): void {
    this.count = 0;
    this.write = 0;
  }

  get length(): number {
    return this.count;
  }

  /** Overwrite-in-place push (no per-tick object alloc). */
  push(
    tick: number,
    x: number,
    y: number,
    z: number,
    crouch: boolean,
    slide: boolean,
    yaw: number,
    pitch: number,
    velocityX: number,
    velocityY: number,
    velocityZ: number,
    onGround: boolean,
    landingAmount: number,
  ): void {
    const slot = this.samples[this.write]!;
    slot.tick = tick;
    slot.x = x;
    slot.y = y;
    slot.z = z;
    slot.crouch = crouch;
    slot.slide = slide;
    slot.yaw = yaw;
    slot.pitch = pitch;
    slot.velocityX = velocityX;
    slot.velocityY = velocityY;
    slot.velocityZ = velocityZ;
    slot.onGround = onGround;
    slot.landingAmount = landingAmount;
    this.write = (this.write + 1) % this.capacity;
    if (this.count < this.capacity) this.count += 1;
  }

  /** Copies of the newest `depth` samples, oldest first. */
  tail(depth: number): PoseSample[] {
    const n = Math.min(this.count, Math.max(0, depth));
    const out: PoseSample[] = [];
    for (let i = this.count - n; i < this.count; i++) {
      out.push({ ...this.at(i) });
    }
    return out;
  }

  /** Chronological index 0 = oldest, length-1 = newest. */
  private at(chronoIndex: number): PoseSample {
    if (this.count < this.capacity) {
      return this.samples[chronoIndex]!;
    }
    const oldest = this.write; // next write = oldest when full
    return this.samples[(oldest + chronoIndex) % this.capacity]!;
  }

  poseAt(
    whenTick: number,
    fallback: PoseAt,
  ): PoseAt {
    if (this.count === 0) {
      return { ...fallback };
    }
    const newest = this.at(this.count - 1);
    if (whenTick >= newest.tick) {
      return {
        x: newest.x,
        y: newest.y,
        z: newest.z,
        crouch: newest.crouch,
        slide: newest.slide,
        yaw: newest.yaw,
        pitch: newest.pitch,
        velocityX: newest.velocityX,
        velocityY: newest.velocityY,
        velocityZ: newest.velocityZ,
        onGround: newest.onGround,
        landingAmount: newest.landingAmount,
      };
    }
    const oldest = this.at(0);
    if (whenTick <= oldest.tick) {
      return {
        x: oldest.x,
        y: oldest.y,
        z: oldest.z,
        crouch: oldest.crouch,
        slide: oldest.slide,
        yaw: oldest.yaw,
        pitch: oldest.pitch,
        velocityX: oldest.velocityX,
        velocityY: oldest.velocityY,
        velocityZ: oldest.velocityZ,
        onGround: oldest.onGround,
        landingAmount: oldest.landingAmount,
      };
    }
    for (let i = 1; i < this.count; i++) {
      const a = this.at(i - 1);
      const b = this.at(i);
      if (whenTick > b.tick) continue;
      const span = Math.max(1, b.tick - a.tick);
      const u = (whenTick - a.tick) / span;
      return {
        x: a.x + (b.x - a.x) * u,
        y: a.y + (b.y - a.y) * u,
        z: a.z + (b.z - a.z) * u,
        crouch: u < 0.5 ? a.crouch : b.crouch,
        slide: u < 0.5 ? a.slide : b.slide,
        yaw: lerpAngle(a.yaw, b.yaw, u),
        pitch: a.pitch + (b.pitch - a.pitch) * u,
        velocityX: a.velocityX + (b.velocityX - a.velocityX) * u,
        velocityY: a.velocityY + (b.velocityY - a.velocityY) * u,
        velocityZ: a.velocityZ + (b.velocityZ - a.velocityZ) * u,
        onGround: u < 0.5 ? a.onGround : b.onGround,
        landingAmount: a.landingAmount +
          (b.landingAmount - a.landingAmount) * u,
      };
    }
    return { ...fallback };
  }
}

/**
 * Max party size stored on a runtime player session. Matches join-token parsing
 * in rankedAuth; authority may configure a lower open-party cap but never above
 * this absolute runtime claim ceiling.
 */
export const PLAYER_PARTY_SIZE_MAX = RUNTIME_PARTY_SIZE_ABSOLUTE_MAX;

/** Normalize optional open-party id from a verified join claim. */
export function normalizePlayerPartyId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const id = raw.trim();
  if (!id || id.length > 128) return null;
  return id;
}

/** Normalize optional stable party size from a verified join claim. */
export function normalizePlayerPartySize(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  const n = Math.floor(raw);
  if (n < 1) return null;
  return Math.min(PLAYER_PARTY_SIZE_MAX, n);
}

export type PlayerOptions = {
  spawn?: SpawnPose;
  /** Server-driven AI player — no socket; never connection-issue. */
  isBot?: boolean;
  /**
   * Grey free-for-all hunter bot. Hostile to red and blue, never scores doors,
   * never respawns — removed when killed. Implies `isBot`.
   */
  isAgent?: boolean;
  /**
   * Temporary roster balancer named "bot". Lowest-skill filler that only exists
   * while teams are uneven. Implies `isBot`. Counts toward team totals.
   */
  isBalanceBot?: boolean;
  /**
   * Raid enemy (wave / boss) character. The only sim difference from a player
   * is the raid damage drop. Implies `isBot`. Recorded as roster `isBot`.
   */
  isRaidBot?: boolean;
  /** Per-player maximum health (raid bosses use 200). */
  maxHealth?: number;
  /** Uniform model / hit-volume scale (raid bosses use 1.3). */
  modelScale?: number;
  /** Horizontal movement multiplier (raid bosses use 0.65). */
  moveSpeedScale?: number;
  /**
   * Clerk user id from ranked join token (`sub`). Used for authority match
   * reports. Null on open/community joins and bots.
   */
  accountUserId?: string | null;
  /**
   * Pawn took a host-channel identity that carried an account id.
   * Match reports and team balance treat that pawn as a match player.
   */
  poolAccount?: boolean;
  /**
   * Open-party id from a verified assignment/join claim. Server-only cohesion
   * key for team assignment and rebalance; never sent on the wire.
   * Stable for the whole session including connection-issue reclaim.
   */
  partyId?: string | null;
  /**
   * Stable party size captured at admission (same for every member of the
   * party). Server-only; used while seating the group. Null for solos.
   */
  partySize?: number | null;
  /** Signed account progression shown on the in-match scoreboard. */
  xp?: number;
  mmsRankId?: MmsRankId;
  /** Signed permanent Founder badge entitlement. */
  founderBadge?: boolean;
  /**
   * Itest/loadlab account from the join-token `synthetic` claim.
   * Default false. Live gameplay is unchanged; heatmaps and replays read it.
   */
  synthetic?: boolean;
  /** Account cosmetics from join token (guests/bots omit → defaults). */
  equipment?: PlayerEquipment | null;
  /**
   * Permanently owned skill products from join token (PR7+tiers).
   * - Omitted / undefined → unrestricted (tests, bots) → max duration/value.
   * - Explicit array (including empty) → only owned families may activate;
   *   duration/value = highest owned tier.
   * Guests and join tokens always pass an explicit list.
   * Accepts full {@link SkillProductId} set (selfHeal, quick2, …).
   */
  ownedAbilities?: readonly (SkillProductId | string)[] | null;
  /**
   * PR-2 match loadout (4 slots). Omitted → unrestricted equip when ownership
   * is unrestricted (bots/tests); humans with an explicit owned list get
   * {@link defaultSkillLoadout} until the client sends their My Skills bar.
   */
  skillLoadout?: readonly (SkillId | null | string)[] | null;
};

export class Player {
  public readonly id: string;
  /** Unique-on-server display name (validated at join). */
  public readonly name: string;
  /**
   * Server-side bot (no client socket). Bots share the same sim path as humans
   * so combat / scoring / snapshots stay uniform as AI grows.
   */
  public readonly isBot: boolean;
  /**
   * Grey "agent" bot: hunts both teams, no door play, lives until killed.
   * Always implies `isBot`. Not counted toward team balance / autofill.
   */
  public readonly isAgent: boolean;
  /**
   * Temporary team-balance filler (`name === "bot"`). Counts in team totals but
   * is not a door rusher and is managed separately from autofill bots.
   */
  public readonly isBalanceBot: boolean;
  /**
   * Raid enemy character (wave / boss). A sim role like {@link isAgent}: the
   * raid damage drop may read it. Never read {@link isBot} in sim code —
   * arena bots are players (the keys-only note).
   */
  public readonly isRaidBot: boolean;
  /**
   * Clerk user id for ranked humans (join token `sub`). Null for bots / guests.
   * Stable for the whole session (including connection-issue reclaim).
   * Pool pawns copy the identity's account id when the director sent one.
   */
  public readonly accountUserId: string | null;
  /** True when this pawn took a pool identity that had an account id. */
  public readonly poolAccount: boolean;
  /**
   * Open-party id from verified join claims. Null for solos, guests without a
   * party, bots, and ranked non-party joins. Server-only — not on snapshots.
   * Stable through disconnect grace and reclaim (same Player instance).
   */
  public readonly partyId: string | null;
  /**
   * Stable party size from the join claim (every member carries the same value).
   * Null when `partyId` is null. Server-only.
   */
  public readonly partySize: number | null;
  /** Account progression badges cached for this match session. */
  public xp = 0;
  public mmsRankId: MmsRankId = "scrap";
  public founderBadge = false;
  /**
   * Itest/loadlab account. Server-only. Not on snapshots.
   * Heatmaps and replay recording read this; authority persistence does not.
   */
  public readonly synthetic: boolean;

  /**
   * True when this roster slot counts as a "real" player for open-match team
   * balance / voted rebalance: connected humans, and pool pawns that took
   * an identity with an account id. Community fill bots (`botN`), the
   * temporary balance bot, and agents do not.
   */
  public isMatchPlayer(): boolean {
    if (this.isAgent || this.isBalanceBot) return false;
    if (!this.isBot) return true;
    return this.poolAccount;
  }
  /**
   * Account cosmetics (head / visor / shoulder / body / leg mesh + player/gun neon hue).
   * Defaults for guests/bots. Updated on reclaim if the join token carries a newer look.
   */
  public headType: number;
  public visorType: number;
  public shoulderType: number;
  public bodyType: number;
  public legType: number;
  public hue: number;
  public gunHue: number;
  public bulletHue: number;
  /** Packed crosshair color; -1 = default. */
  public crosshairColor: number;
  /** Own name tag hue shift -2…2 off team color. */
  public nameHue: number;
  public pistolType: number;
  public rifleType: number;
  public shotgunType: number;
  /** Rifle optic 0…4. Standard when the join omits it. */
  public scopeType: number;
  public crosshairType: number;
  /**
   * Multiplier on horizontal move speed (walk / sprint / crouch).
   * Defaults to 1 for humans and bots (same mobility budget).
   */
  public moveSpeedScale: number;
  /** Uniform visual and authoritative hit-volume multiplier. */
  public modelScale: number;
  public team: TeamId = "A";

  public x = 0;
  public y = PLAYER_HEIGHT;
  public z = 0;
  public yaw = 0;
  public pitch = 0;

  /** Actual horizontal velocity from the previous authoritative sim step. */
  public velocityX = 0;
  public velocityY = 0;
  public velocityZ = 0;
  public onGround = true;
  /** Sim tick of the latest airborne → grounded transition. */
  private lastLandedAtTick: number | null = null;
  /** Authoritative duck stance (from latest input). */
  public crouch = false;
  /** Stamina-seconds remaining (0 … SPRINT_DURATION_S). */
  public sprintStamina = SPRINT_DURATION_S;
  /** Seconds remaining on crouch-slide / melee-lunge burst (0 = idle). */
  public slideRemaining = 0;
  /** Locked horizontal slide direction (unit vector). */
  public slideDirX = 0;
  public slideDirZ = 0;
  /**
   * When bursting: true = crouch-slide (force crouch + remote slide pose);
   * false = standing melee lunge.
   */
  public slideForceCrouch = false;
  /** Previous tick crouch input — rising-edge detect for slide start. */
  private prevInputCrouch = false;
  /** Checkpoint capture: last ground landing tick (null = none). */
  public get lastLandedTick(): number | null {
    return this.lastLandedAtTick;
  }
  /** Checkpoint capture: previous step's crouch key (rising-edge detect). */
  public get previousInputCrouch(): boolean {
    return this.prevInputCrouch;
  }

  public maxHealth = MAX_HEALTH;
  public health = MAX_HEALTH;
  public alive = true;
  /** Shared expiry for stacked bullet-hit movement penalties. */
  private hitSlowEndsAtTick = 0;
  private hitSlowStacks = 0;
  public diedAtTick: number | null = null;
  /** Sim tick of last spawn / respawn — used for spawn invulnerability. */
  public spawnedAtTick = 0;
  public lastScoreAtTick = Number.NEGATIVE_INFINITY;
  /**
   * Sim tick when continuous enemy-door-zone presence began (doors open).
   * Null when not currently dwelling for a capture.
   */
  public enemyDoorSinceTick: number | null = null;

  /** Personal door captures (ranking score on the TAB scoreboard). */
  public score = 0;
  /** Confirmed kills (any victim). */
  public kills = 0;
  /** Times this player was eliminated. */
  public deaths = 0;

  /**
   * Socket is down: still in the match as a sitting duck. Cleared on reclaim
   * or permanent leave. While true, no inputs / shoot / reload / switch.
   * Always false for bots.
   */
  public connectionIssue = false;
  /**
   * Non-simulation wall-clock deadline to drop after connectionIssue. It is
   * supplied by the transport boundary and never advances gameplay ticks.
   */
  public connectionIssueDeadlineMs: number | null = null;
  /**
   * Current transport socket id (changes on reconnect). Null while the
   * connection-issue grace period is active, and always null for bots.
   *
   * Adapter-only (epic 4.8): sim branches on `isBot` / `connectionIssue` /
   * stable `id`, never on socketId presence. `getBySocket` stays on PlayerManager
   * for transport emit/ping.
   */
  public socketId: string | null;
  /**
   * Wall-clock of last meaningful activity (move key, look, shoot, reload,
   * weapon switch). Used for AFK on the TAB scoreboard.
   */
  public lastActivityAtMs = Date.now();
  /** Time spent AFK during the current live raid (ms). */
  public raidAfkAccumMs = 0;
  /**
   * AFK label frozen at death. While dead the timer does not advance (doors
   * closed / long respawn would otherwise mark everyone AFK). Cleared on
   * respawn. Look / other activity while dead can clear a true freeze.
   */
  public afkWhileDead: boolean | null = null;
  /**
   * Accumulated wall-clock ms this live match while connected and not AFK.
   * Used to scale match base XP/coins. Bots unused.
   */
  public activeMatchMs = 0;
  /**
   * Last wall-clock sample for {@link activeMatchMs}. Null until live sampling
   * starts (match start or mid-match join).
   */
  public participationLastSampleMs: number | null = null;
  /**
   * Whether the player was participating at the last sample (credits the
   * following interval). Updated each {@link sampleParticipation}.
   */
  public participationWasActive = false;
  /**
   * Last measured client RTT in ms (server Ping → client Pong).
   * 0 for humans until the first successful sample. Community / balance /
   * agent bots stay 0; official pool pawns get a stable fake value at spawn
   * so the TAB Ping column looks populated (display-only for now).
   */
  public pingMs = 0;
  /**
   * EWMA RTT + jitter for lag-comp. First pong is ignored for the window
   * (`pingReady` is false until the second sample). Bots do not use this.
   */
  public pingFilter: PingFilter = createPingFilter();
  /** Shots whose clientTick was clamped into the RTT window. */
  public rewindClampCount = 0;
  public rewindClampForward = 0;
  public rewindClampBack = 0;

  public get pingReady(): boolean {
    return this.pingFilter.sampleCount >= 2;
  }

  public observeRtt(rttMs: number): void {
    this.pingFilter = observeRttSample(this.pingFilter, rttMs);
    if (this.pingFilter.sampleCount <= 0) return;
    this.pingMs = Math.round(
      this.pingFilter.sampleCount === 1 ? rttMs : this.pingFilter.ewmaMs,
    );
  }

  public recordRewindClamp(dir: LagCompClampDir): void {
    if (dir !== "forward" && dir !== "back") return;
    this.rewindClampCount += 1;
    if (dir === "forward") this.rewindClampForward += 1;
    else this.rewindClampBack += 1;
  }

  public resetPingStats(): void {
    this.pingMs = 0;
    this.pingFilter = createPingFilter();
  }
  /**
   * Spectate Y-mode bot decision bitfield (shared/bots/botDecisions.ts).
   * BotManager refreshes after each completed think; 0 for humans.
   */
  public botDecisions = 0;

  /** Zero personal scoreboard stats for a new match (team assignment kept). */
  public resetMatchStats(): void {
    this.score = 0;
    this.kills = 0;
    this.deaths = 0;
    this.clearAbilityCharges();
  }

  /**
   * Clear ability timers and re-lock all activatable charges until the next
   * door capture. Used for new match, join, and death (players + bots).
   */
  public clearAbilityCharges(): void {
    this.lockAbilityChargesUntilDoor();
  }

  /**
   * Gate skill bar charges until a door is captured this life.
   * Cancels actives / regen windows and marks every activatable skill spent.
   * Passives are equip-only and are not charged.
   */
  public lockAbilityChargesUntilDoor(): void {
    this.abilityEndsAtTick = {};
    this.abilityFxOrigin = {};
    this.abilityGlobalLockEndsAtTick = null;
    this.abilityBarRegenEndsAtTick = null;
    this.abilityDoorRegenEndsAtTick = null;
    this.abilityNoSpendOnEnd = {};
    this.abilitySpent = {};
    for (const id of SKILL_ORDER) {
      if (isSkillActivatable(id)) {
        this.abilitySpent[id] = true;
      }
    }
  }

  /**
   * Clear spent charges (end of door regen). Tests may call this to skip the
   * door gate when exercising activate / combat paths in isolation.
   */
  public restoreAbilityCharges(): void {
    this.abilitySpent = {};
    this.abilityDoorRegenEndsAtTick = null;
  }

  /** Reset live-match participation accumulators (new live match). */
  public resetMatchParticipation(nowMs = Date.now()): void {
    this.activeMatchMs = 0;
    this.participationLastSampleMs = nowMs;
    this.participationWasActive = this.isParticipating(nowMs);
  }

  /**
   * True when this moment should count toward active match time:
   * connected and not AFK (existing AFK algo).
   */
  public isParticipating(nowMs = Date.now()): boolean {
    if (this.connectionIssue) return false;
    return !this.isAfk(nowMs);
  }

  /**
   * Advance participation sampling. Credits wall-clock delta when the player
   * was participating at the previous sample. This is non-simulation state:
   * it may mutate only `activeMatchMs`, `participationLastSampleMs`, and
   * `participationWasActive`. Call it outside the authoritative sim update.
   */
  public sampleParticipation(nowMs = Date.now()): void {
    if (this.isBot) return;
    const last = this.participationLastSampleMs;
    if (last != null && nowMs > last && this.participationWasActive) {
      this.activeMatchMs += nowMs - last;
    }
    this.participationWasActive = this.isParticipating(nowMs);
    this.participationLastSampleMs = nowMs;
  }

  /**
   * Final sample for end-of-match reporting; returns total active ms.
   */
  public finalizeParticipation(nowMs = Date.now()): number {
    this.sampleParticipation(nowMs);
    return this.activeMatchMs;
  }

  public lastSequence = 0;
  public lastShotAtTick = Number.NEGATIVE_INFINITY;
  /** Last sim tick a pistol-whip swing started (melee cooldown gate). */
  public lastMeleeAtTick = Number.NEGATIVE_INFINITY;

  /** Currently equipped weapon id. */
  public weaponId: number = WEAPON_PISTOL;
  /** Per-weapon magazines — full on spawn / score / respawn. */
  private readonly loadouts: Record<number, WeaponLoadout> = defaultLoadouts();
  /**
   * When true, shooting never empties the magazine and reloads do not consume
   * spare clips. Used for ranked pre-match warm-up and always for grey agents.
   */
  public unlimitedAmmo = false;

  /**
   * Sim tick when the active weapon's reload finishes; null if not reloading
   * (or reload is paused because another weapon is equipped).
   */
  public reloadEndsAtTick: number | null = null;
  /**
   * Remaining reload ticks stored when switching away mid-reload.
   * Resumed when that weapon is equipped again and the switch completes.
   */
  private readonly pausedReloadRemainingTicks: Record<number, number> = {};
  /**
   * Shell guns: sim tick the next shell moves spare → tube; null when not
   * shell-reloading. Not paused across switches (loaded shells stay).
   */
  public shellReloadNextAtTick: number | null = null;
  /**
   * Shell guns: sim tick the active pump finishes (then `chambered`); null
   * when not pumping.
   */
  public pumpEndsAtTick: number | null = null;
  /**
   * Sim tick when holster+draw finishes after a weapon switch.
   * Null when not switching. Blocks shoot / reload / re-switch.
   */
  public weaponSwitchEndsAtTick: number | null = null;

  /**
   * Permanent ownership (skill product ids: quick, quick2, selfHeal, …).
   * `null` = unrestricted (bots / unit tests) → max duration/value.
   * Non-null Set = only families with any owned product may activate.
   * Guests and join tokens always set an explicit set (often empty).
   */
  private ownedSkillProducts: Set<SkillProductId> | null = null;

  /**
   * PR-2 match loadout (4 slots → Ability 1–4).
   * `null` = unrestricted equip (bots / unit tests) — any owned skill works.
   * Non-null = only equipped skills may activate; passives only when equipped.
   */
  private skillLoadout: SkillLoadout | null = null;

  /**
   * Exclusive sim tick when each skill's active window ends (timed buffs,
   * or a short flash for instants). Missing key / past tick → inactive.
   */
  public abilityEndsAtTick: Partial<Record<SkillId, number>> = {};
  /**
   * Pre-warp eye pose for rewind / teleport VFX while the instant flash is live.
   * Cleared when the flash expires.
   */
  public abilityFxOrigin: Partial<
    Record<SkillId, { x: number; y: number; z: number }>
  > = {};
  /**
   * Skills already used this charge cycle (grey on HUD).
   * All activatable skills start spent each life until a door capture
   * regenerates them; death re-locks the full kit. Cleared after door-capture regen.
   */
  public abilitySpent: Partial<Record<SkillId, true>> = {};
  /**
   * Exclusive tick: no activates while `tick < this` (global lock during
   * the active window — top bar drains). Instants use
   * {@link instantSkillLockTicks} instead of a long window.
   */
  public abilityGlobalLockEndsAtTick: number | null = null;
  /**
   * Exclusive tick: post-use bar reverse-fill. No activates while
   * `tick < this`.
   */
  public abilityBarRegenEndsAtTick: number | null = null;
  /**
   * Exclusive tick: door-capture charge regen. When it elapses, spent
   * charges clear. No activates while `tick < this`.
   */
  public abilityDoorRegenEndsAtTick: number | null = null;
  /**
   * Skills that were mid-active when door regen started — do not mark
   * spent when their window ends (capture already restored the kit).
   * Also set for instant flash so expiry does not re-spend.
   */
  private abilityNoSpendOnEnd: Partial<Record<SkillId, true>> = {};

  private latestInput: PlayerInput | null = null;
  /**
   * Tick-start snapshot of {@link latestInput} for the current/last `update`.
   * Mid-tick arrivals land in `latestInput` for the *next* tick only.
   */
  private selectedInputForTick: PlayerInput | null = null;
  /** Last completed tick's selection — stable handoff for #8.3. */
  private lastTickSelection: TickSelectedInput | null = null;
  /**
   * Set when {@link queueInput} accepts a packet; cleared at end of `update`.
   * Distinguishes `hold` (re-queued same seq) from `repeat_missing` (silent).
   */
  private arrivalSinceLastStep = false;
  /**
   * Copy of the last packet {@link queueInput} accepted since the previous
   * `update`, including look-only arrivals while dead. Recording needs it when
   * the tick has no selection (dead, or killed after queueing but before
   * MovePhysics) so replay still applies the look/sequence that live applied.
   */
  private lastArrivalInput: PlayerInput | null = null;
  /**
   * Highest input sequence that has been stepped at least once (A1 ack).
   * Distinct from {@link lastSequence} (highest *received*) — a packet can
   * arrive after the sim tick and must not be reported as applied yet.
   */
  private appliedSequence = 0;
  /**
   * How many sim ticks {@link appliedSequence} / selected input has been held.
   * Clients use this so A1 does not drop the current cmd as "done" mid-hold
   * (that was ~0.2u walk residual every snapshot on localhost).
   */
  private inputHoldTicks = 0;
  private readonly poseHistory = new PoseHistoryRing(POSE_HISTORY_CAPACITY);

  public get weapon(): WeaponDef {
    return getWeapon(this.weaponId);
  }

  /** Rounds in the active magazine. */
  public get ammoInMag(): number {
    return this.loadouts[this.weaponId]?.ammoInMag ?? 0;
  }

  /** Rounds in magazine for a specific weapon id (0 if unknown / unequipped slot). */
  public ammoInMagFor(weaponId: number): number {
    return this.loadouts[weaponId]?.ammoInMag ?? 0;
  }

  /** Spare full magazines remaining for the active weapon. */
  public get spareClips(): number {
    return this.loadouts[this.weaponId]?.spareClips ?? 0;
  }

  /** Spare full magazines remaining for a specific weapon id. */
  public spareClipsFor(weaponId: number): number {
    return this.loadouts[weaponId]?.spareClips ?? 0;
  }

  /** Shell guns: active weapon cocked (always true for mag guns). */
  public get chambered(): boolean {
    return this.loadouts[this.weaponId]?.chambered ?? true;
  }

  /** Cocked state for a specific weapon id (true when the slot is unknown). */
  public chamberedFor(weaponId: number): boolean {
    return this.loadouts[weaponId]?.chambered ?? true;
  }

  private setActiveAmmo(ammoInMag: number, spareClips?: number): void {
    const slot = this.loadouts[this.weaponId];
    if (!slot) return;
    slot.ammoInMag = ammoInMag;
    if (typeof spareClips === "number") slot.spareClips = spareClips;
  }

  /** Full mags + spare clips for every weapon (spawn / score / death respawn). */
  public restoreLoadouts(): void {
    const fresh = defaultLoadouts();
    for (const id of LOADOUT_WEAPON_IDS) {
      const src = fresh[id]!;
      const slot = this.loadouts[id];
      if (slot) {
        slot.ammoInMag = src.ammoInMag;
        slot.spareClips = src.spareClips;
        slot.chambered = src.chambered;
      } else {
        this.loadouts[id] = { ...src };
      }
    }
    this.cancelReload();
    this.cancelWeaponSwitch();
  }

  constructor(
    id: string,
    name: string,
    team: TeamId,
    options: PlayerOptions = {},
  ) {
    this.id = id;
    this.name = name;
    this.team = team;
    this.isAgent = Boolean(options.isAgent);
    this.isBalanceBot = Boolean(options.isBalanceBot) && !this.isAgent;
    this.isRaidBot = Boolean(options.isRaidBot) && !this.isAgent &&
      !this.isBalanceBot;
    this.isBot = Boolean(options.isBot) || this.isAgent || this.isBalanceBot ||
      this.isRaidBot;
    // Grey agents never run dry — hunters stay pressure-capable for the whole match.
    if (this.isAgent) this.unlimitedAmmo = true;
    this.accountUserId =
      typeof options.accountUserId === "string" && options.accountUserId.trim()
        ? options.accountUserId.trim()
        : null;
    this.poolAccount = options.poolAccount === true && this.accountUserId != null;
    this.partyId = normalizePlayerPartyId(options.partyId);
    const size = normalizePlayerPartySize(options.partySize);
    // Size is only meaningful with a party id; solos leave both null.
    this.partySize = this.partyId ? (size ?? 1) : null;
    this.synthetic = options.synthetic === true;
    this.setProgression(
      options.xp,
      options.mmsRankId,
      options.founderBadge,
    );
    // Agents always default to the full dome mesh set when no look is passed.
    const equipment = normalizePlayerEquipment(
      options.equipment ??
        (this.isAgent ? agentPlayerEquipment() : defaultPlayerEquipment()),
    );
    this.headType = equipment.head;
    this.visorType = equipment.visor;
    this.shoulderType = equipment.shoulder;
    this.bodyType = equipment.body;
    this.legType = equipment.leg;
    this.hue = equipment.hue;
    this.gunHue = equipment.gunHue;
    this.bulletHue = equipment.bulletHue;
    this.crosshairColor = equipment.crosshairColor;
    this.nameHue = equipment.nameHue;
    this.pistolType = equipment.pistol;
    this.rifleType = equipment.rifle;
    this.shotgunType = equipment.shotgun;
    this.scopeType = equipment.scope;
    this.crosshairType = equipment.crosshair;
    this.moveSpeedScale = Number.isFinite(options.moveSpeedScale)
      ? Math.max(0.1, Number(options.moveSpeedScale))
      : 1;
    this.modelScale = Number.isFinite(options.modelScale)
      ? Math.max(0.1, Number(options.modelScale))
      : 1;
    this.maxHealth = Number.isFinite(options.maxHealth)
      ? Math.max(1, Math.round(Number(options.maxHealth)))
      : MAX_HEALTH;
    this.health = this.maxHealth;
    // Bots never bind a transport socket.
    this.socketId = this.isBot ? null : id;
    // PR7 ownership: explicit list from join; omit → unrestricted (bots/tests).
    if (options.ownedAbilities !== undefined) {
      this.setOwnedAbilities(options.ownedAbilities);
    } else {
      this.ownedSkillProducts = null;
    }
    // PR-2 loadout: explicit (account token / client packet) → validate;
    // else default for restricted ownership; unrestricted (null) for bots/tests.
    if (options.skillLoadout !== undefined) {
      this.setSkillLoadout(options.skillLoadout);
    } else if (this.ownedSkillProducts !== null) {
      this.skillLoadout = defaultSkillLoadout(this.snapshotOwnedAbilities());
    } else {
      this.skillLoadout = null;
    }
    if (options.spawn) this.applySpawn(options.spawn, 0);
    // Skills stay locked until a door capture (players and bots).
    this.lockAbilityChargesUntilDoor();
  }

  /** Apply cosmetics from a join token (join or reclaim). */
  public setEquipment(raw: unknown): void {
    const a = normalizePlayerEquipment(raw);
    this.headType = a.head;
    this.visorType = a.visor;
    this.shoulderType = a.shoulder;
    this.bodyType = a.body;
    this.legType = a.leg;
    this.hue = a.hue;
    this.gunHue = a.gunHue;
    this.bulletHue = a.bulletHue;
    this.crosshairColor = a.crosshairColor;
    this.nameHue = a.nameHue;
    this.pistolType = a.pistol;
    this.rifleType = a.rifle;
    this.shotgunType = a.shotgun;
    this.scopeType = a.scope;
    this.crosshairType = a.crosshair;
  }

  /** Refresh signed progression metadata on join or session reclaim. */
  public setProgression(
    xp: unknown,
    mmsRankId: unknown,
    founderBadge?: unknown,
  ): void {
    if (xp !== undefined) {
      this.xp = typeof xp === "number" && Number.isFinite(xp)
        ? Math.max(0, Math.trunc(xp))
        : 0;
    }
    if (mmsRankId !== undefined) {
      this.mmsRankId = typeof mmsRankId === "string" &&
          MMS_RANKS.some((rank) => rank.id === mmsRankId)
        ? mmsRankId as MmsRankId
        : "scrap";
    }
    if (founderBadge !== undefined) {
      this.founderBadge = founderBadge === true;
    }
  }

  /** Enter the connection-issue grace period (sitting duck until reclaim/timeout). */
  public markConnectionIssue(deadlineMs: number): void {
    if (this.isBot) return;
    this.connectionIssue = true;
    this.connectionIssueDeadlineMs = deadlineMs;
    this.socketId = null;
    this.latestInput = null;
    this.resetPingStats();
  }

  /** Clear connection-issue flags and bind a new transport socket. */
  public clearConnectionIssue(
    socketId: string,
    nowMs = Date.now(),
  ): void {
    this.connectionIssue = false;
    this.connectionIssueDeadlineMs = null;
    this.socketId = socketId;
    this.latestInput = null;
    this.touchActivity(nowMs);
  }

  /** Mark the player as recently active (resets AFK timer). */
  public touchActivity(nowMs = Date.now()): void {
    this.lastActivityAtMs = nowMs;
    // Meaningful input while dead clears a frozen AFK label.
    if (!this.alive && this.afkWhileDead !== null) {
      this.afkWhileDead = false;
    }
  }

  /**
   * True when no meaningful activity for AFK_TIMEOUT_MS.
   * Connection-issue players use the reconnect icon instead.
   * While dead, status is frozen to the pre-death value (unless activity
   * clears it) so closed-door respawn waits do not auto-AFK everyone.
   */
  public isAfk(nowMs = Date.now()): boolean {
    if (this.connectionIssue) return false;
    if (!this.alive && this.afkWhileDead !== null) {
      return this.afkWhileDead;
    }
    return nowMs - this.lastActivityAtMs >= AFK_TIMEOUT_MS;
  }

  /**
   * Wall-clock when the AFK flag started for kick timing, or null if not AFK.
   * Uses lastActivityAtMs + AFK_TIMEOUT_MS so death-frozen AFK still counts
   * continuous idle from the original idle moment.
   */
  public afkFlagStartedAtMs(nowMs = Date.now()): number | null {
    if (!this.isAfk(nowMs)) return null;
    return this.lastActivityAtMs + AFK_TIMEOUT_MS;
  }

  /**
   * True when AFK long enough after the flag for a hard-kick.
   * Bots and connection-issue slots never kick this way.
   */
  public shouldKickForAfk(nowMs = Date.now()): boolean {
    if (this.isBot || this.connectionIssue) return false;
    const started = this.afkFlagStartedAtMs(nowMs);
    if (started === null) return false;
    return nowMs - started >= AFK_KICK_MS;
  }

  /**
   * Whole seconds remaining until AFK kick (ceil), or undefined when not AFK.
   */
  public afkKickInSeconds(nowMs = Date.now()): number | undefined {
    const started = this.afkFlagStartedAtMs(nowMs);
    if (started === null) return undefined;
    const remainingMs = AFK_KICK_MS - (nowMs - started);
    return Math.max(0, Math.ceil(remainingMs / 1000));
  }

  /**
   * Engagement fraction for match base XP/coins: activeMs / matchDurationMs.
   * Clamped to [0, 1]. Full attendance with no AFK → ~1.
   */
  public participationFactor(
    matchDurationMs: number,
    nowMs = Date.now(),
  ): number {
    const active = this.finalizeParticipation(nowMs);
    if (!(matchDurationMs > 0)) return 1;
    return Math.min(1, Math.max(0, active / matchDurationMs));
  }

  public applySpawn(spawn: SpawnPose, tick: number): void {
    this.enemyDoorSinceTick = null;
    this.x = spawn.x;
    this.y = spawn.y ?? PLAYER_HEIGHT;
    this.z = spawn.z;
    this.yaw = spawn.yaw ?? 0;
    this.pitch = spawn.pitch ?? 0;
    this.velocityX = 0;
    this.velocityY = 0;
    this.velocityZ = 0;
    this.onGround = true;
    this.lastLandedAtTick = null;
    this.crouch = false;
    this.sprintStamina = SPRINT_DURATION_S;
    this.clearSlide();
    this.prevInputCrouch = false;
    this.spawnedAtTick = tick;
    this.poseHistory.clear();
    this.recordPose(tick);
  }

  /** True while mid crouch-slide or standing melee-lunge burst. */
  public isSliding(): boolean {
    return this.slideRemaining > 0;
  }

  /** True only for crouch-slide (remote slide pose / PF_SLIDE). */
  public isCrouchSliding(): boolean {
    return this.slideRemaining > 0 && this.slideForceCrouch;
  }

  private clearSlide(): void {
    this.slideRemaining = 0;
    this.slideDirX = 0;
    this.slideDirZ = 0;
    this.slideForceCrouch = false;
  }

  /** True for SPAWN_INVULN_TICKS after spawn/respawn — blocks damage only. */
  public isSpawnProtected(tick: number): boolean {
    return tick - this.spawnedAtTick < SPAWN_INVULN_TICKS;
  }

  /**
   * True when damage must not apply: spawn protect or Force Field window.
   * Used by {@link takeDamage}, shoot resolution, and snapshot `invulnerable`.
   */
  public isInvulnerable(tick: number): boolean {
    if (this.isSpawnProtected(tick)) return true;
    if (this.isAbilityActive("forceField", tick)) return true;
    return false;
  }

  /**
   * Pose samples a resumed sim needs (checkpoint capture), oldest first: the
   * lag-comp rewind band (+ bracket slack), or the whole ring when the player
   * owns Rewind (teleports up to 3 s back through the same history).
   */
  public checkpointPoseHistory(): PoseSample[] {
    const ownsRewind = skillValueForOwned("rewind", this.ownedSkillsForValue()) > 0;
    return this.poseHistory.tail(
      ownsRewind ? POSE_HISTORY_CAPACITY : LAG_COMP_MAX_REWIND_TICKS + 3,
    );
  }

  public recordPose(tick: number): void {
    this.poseHistory.push(
      tick,
      this.x,
      this.y,
      this.z,
      this.crouch,
      this.isCrouchSliding(),
      this.yaw,
      this.pitch,
      this.velocityX,
      this.velocityY,
      this.velocityZ,
      this.onGround,
      this.lastLandedAtTick === null
        ? 0
        : playerLandingHitAmount((tick - this.lastLandedAtTick) / TICK_HZ),
    );
  }

  public poseAt(
    whenTick: number,
  ): PoseAt {
    return this.poseHistory.poseAt(whenTick, {
      x: this.x,
      y: this.y,
      z: this.z,
      crouch: this.crouch,
      // Standing melee lunge shares the burst timer but must not look like a duck-slide.
      slide: this.isCrouchSliding(),
      yaw: this.yaw,
      pitch: this.pitch,
      velocityX: this.velocityX,
      velocityY: this.velocityY,
      velocityZ: this.velocityZ,
      onGround: this.onGround,
      landingAmount: this.lastLandedAtTick === null
        ? 0
        : playerLandingHitAmount((whenTick - this.lastLandedAtTick) / TICK_HZ),
    });
  }

  /**
   * Serialize for the wire.
   * @param mode `full` includes name + cosmetics + scoreboard (join/welcome).
   *   `motion` is the 20 Hz stream: pose/ammo/health; omits score/K/D
   *   (event-driven) and only includes ping at 2 Hz.
   */
  /**
   * @param glitchCollision When set, computes authoritative Glitch remote
   *   visibility against enemy door geometry. Pass the live map collision
   *   from PlayerManager; omit only in unit tests that ignore glitch state.
   */
  public toSnapshot(
    tick = 0,
    mode: SnapshotPlayerMode = "full",
    glitchCollision?: MapCollision | null,
    nowMs = Date.now(),
  ): SnapshotPlayer {
    const motion = mode === "motion";
    const q = motion ? quantizePos : identityNum;
    const qAng = motion ? quantizeAngle : identityNum;

    const base: SnapshotPlayer = {
      id: this.id,
      x: q(this.x),
      y: q(this.y),
      z: q(this.z),
      yaw: qAng(this.yaw),
      pitch: qAng(this.pitch),
      health: this.health,
      scale: this.modelScale === 1 ? undefined : this.modelScale,
      alive: this.alive,
      team: this.team,
      isAgent: this.isAgent || undefined,
      invulnerable: this.alive && this.isInvulnerable(tick),
      crouch: this.crouch,
      // Always include so clients don't treat omission as "unknown/stale".
      // Standing melee lunge shares the burst timer but must not look like a duck-slide.
      slide: this.isCrouchSliding(),
      hitSlowStacks: this.activeHitSlowStacks(tick) || undefined,
      hitSlowEndsAtTick: this.activeHitSlowEndsAtTick(tick),
      // Velocity seed: remotes use X/Z for locomotion and A1 uses Y for jumps.
      velocityX: motion ? quantizeVel(this.velocityX) : this.velocityX,
      velocityY: motion ? quantizeVel(this.velocityY) : this.velocityY,
      velocityZ: motion ? quantizeVel(this.velocityZ) : this.velocityZ,
      weapon: this.weaponId,
      ammoInMag: this.ammoInMag,
      spareClips: this.spareClips,
      reloading: this.isReloading(),
      pumping: this.isPumping() || undefined,
      switching: this.isSwitching(tick),
      sprintStamina: motion
        ? quantizeStamina(this.sprintStamina)
        : this.sprintStamina,
      connectionIssue: this.connectionIssue || undefined,
      afk: this.isAfk(nowMs) || undefined,
      afkKickIn: this.afkKickInSeconds(nowMs),
      /**
       * Highest input sequence *stepped* into this pose (A1). Not merely
       * received — see appliedSequence. Clients use inputHoldTicks so the
       * current cmd is not treated as fully done mid-hold.
       */
      lastProcessedInputSeq: this.isBot || this.appliedSequence <= 0
        ? undefined
        : this.appliedSequence,
      // Spectate / yaw-dot debug: which move keys the sim is holding.
      keys: encodeSnapKeys(this.latestInput),
    };

    const glitch = this.glitchSnapState(tick, glitchCollision ?? null);
    if (glitch) base.glitch = glitch;

    // Bot decision tree (spectate Y) — only attach for bots so humans omit.
    if (this.isBot) {
      base.botDec = this.botDecisions | 0;
    }

    if (!this.isBot && this.appliedSequence > 0) {
      base.inputHoldTicks = this.inputHoldTicks;
    }

    // Crouch-slide timer + locked direction (keeps motion snaps thin).
    // Melee lunges are predicted locally and omitted so remotes stay standing.
    if (this.isCrouchSliding()) {
      base.slideRemaining = motion
        ? quantizeStamina(this.slideRemaining)
        : this.slideRemaining;
      base.slideDirX = motion ? quantizePos(this.slideDirX) : this.slideDirX;
      base.slideDirZ = motion ? quantizePos(this.slideDirZ) : this.slideDirZ;
    }

    const activeAbilities = this.snapshotActiveAbilities(tick);
    if (activeAbilities.length > 0) {
      base.abilities = activeAbilities;
    }

    // Charge / global bar state — full snaps only (join mid-match + Score).
    // Motion keeps thin; local client predicts between fulls.
    if (!motion) {
      const spent = this.snapshotSpentAbilities();
      if (spent.length > 0) base.abilitySpent = spent;
      if (
        this.abilityGlobalLockEndsAtTick !== null &&
        tick < this.abilityGlobalLockEndsAtTick
      ) {
        base.abilityLockEndsAtTick = this.abilityGlobalLockEndsAtTick;
      }
      const regenEnd = Math.max(
        this.abilityBarRegenEndsAtTick ?? 0,
        this.abilityDoorRegenEndsAtTick ?? 0,
      );
      if (regenEnd > tick) {
        base.abilityRegenEndsAtTick = regenEnd;
      }
    }

    if (motion) {
      // score / kills / deaths: event-driven (Score, CombatBurst) — omit here.
      // ping: 2 Hz only (every half-second at 60 Hz). Pool pawns carry a fake
      // pingMs so they appear on the TAB board like humans.
      if (tick % Math.max(1, Math.floor(TICK_HZ / 2)) === 0) {
        if (this.pingMs > 0) {
          base.ping = Math.round(this.pingMs);
        }
      }
      return base;
    }

    return {
      ...base,
      name: this.name,
      score: this.score,
      kills: this.kills,
      deaths: this.deaths,
      xp: this.xp,
      mmsRankId: this.mmsRankId,
      founderBadge: this.founderBadge || undefined,
      // Omit when unmeasured (humans pre-sample, ordinary bots). Pool pawns set
      // a display-only fake RTT at spawn so the TAB Ping column is populated.
      ping: this.pingMs <= 0 ? undefined : Math.round(this.pingMs),
      head: this.headType,
      visor: this.visorType,
      shoulder: this.shoulderType,
      body: this.bodyType,
      leg: this.legType,
      hue: this.hue,
      gunHue: this.gunHue,
      pistol: this.pistolType,
      rifle: this.rifleType,
      shotgun: this.shotgunType,
      crosshair: this.crosshairType,
      scope: this.scopeType,
      bulletHue: this.bulletHue,
      crosshairColor: this.crosshairColor,
      nameHue: this.nameHue,
    };
  }

  /**
   * Arrival path for wire/bot `PlayerInput` (epic 5.2).
   *
   * Truth table (selection happens at `update` tick-start snapshot):
   * - stale `sequence < lastSequence` → drop (never selected; no rewind)
   * - dead → look-only + AFK touch; no `latestInput` / no move
   * - else → last-write-wins into `latestInput` (multiple arrivals: last wins)
   *
   * Tick is stamped at consumption, not arrival. See `TICK_ASSOCIATION.md`.
   */
  /**
   * Arrival path for wire/bot `PlayerInput` (epic 5.2).
   *
   * Truth table (selection happens at `update` tick-start snapshot):
   * - stale `sequence < lastSequence` → drop (never selected; no rewind)
   * - dead → look-only + AFK touch; no `latestInput` / no move
   * - else → last-write-wins into `latestInput` (multiple arrivals: last wins)
   *
   * Tick is stamped at consumption, not arrival. See `TICK_ASSOCIATION.md`.
   */
  /**
   * Replay-only: re-establish a held selection without simulating an arrival.
   * A `repeat_missing` tick had no `queueInput` live, so look set since the
   * packet (e.g. a shot's aim) must survive. Only fills an empty buffer
   * (fresh checkpoint load); otherwise the held packet is already in place.
   */
  public restoreHeldInput(input: PlayerInput): void {
    if (this.connectionIssue || !this.alive) return;
    if (this.latestInput !== null) return;
    this.latestInput = input;
    if (input.sequence > this.lastSequence) this.lastSequence = input.sequence;
  }

  public queueInput(input: PlayerInput, nowMs = Date.now()): void {
    if (this.connectionIssue) return;
    if (input.sequence < this.lastSequence) return;

    // Dead: still accept look (and key) activity for AFK, but never move.
    if (!this.alive) {
      if (this.isMeaningfulInput(input)) {
        this.touchActivity(nowMs);
      }
      this.lastSequence = input.sequence;
      this.yaw = input.yaw;
      this.pitch = input.pitch;
      this.lastArrivalInput = { ...input };
      return;
    }

    if (this.isMeaningfulInput(input)) {
      this.touchActivity(nowMs);
    }
    this.latestInput = input;
    this.lastSequence = input.sequence;
    this.arrivalSinceLastStep = true;
    this.lastArrivalInput = { ...input };
    this.yaw = input.yaw;
    this.pitch = input.pitch;
  }

  /**
   * Idle keep-alive packets (all keys false, look unchanged) do not count —
   * only real control activity (move keys, jump/sprint/crouch, or mouse look)
   * resets AFK.
   */
  private isMeaningfulInput(input: PlayerInput): boolean {
    if (
      input.forward ||
      input.backward ||
      input.left ||
      input.right ||
      input.jump ||
      input.sprint ||
      input.crouch ||
      input.meleeLunge
    ) {
      return true;
    }
    // Look activity (mouse). Small epsilon ignores float noise.
    const LOOK_EPS = 0.0005;
    if (angleDelta(input.yaw, this.yaw) > LOOK_EPS) return true;
    if (Math.abs(input.pitch - this.pitch) > LOOK_EPS) return true;
    return false;
  }

  /** Mag reload timer or shell-by-shell loading in progress. */
  public isReloading(): boolean {
    return this.reloadEndsAtTick !== null ||
      this.shellReloadNextAtTick !== null;
  }

  /** Shell guns: cocking after a shot / a reload / a draw. */
  public isPumping(): boolean {
    return this.pumpEndsAtTick !== null;
  }

  /** True while holstering / drawing after a weapon switch. */
  public isSwitching(tick: number): boolean {
    return (
      this.weaponSwitchEndsAtTick !== null && tick < this.weaponSwitchEndsAtTick
    );
  }

  public isAbilityActive(id: SkillId | AbilityId, tick: number): boolean {
    if (!isSkillId(id)) return false;
    return isAbilityActiveAt(this.abilityEndsAtTick[id], tick);
  }

  public isAbilitySpent(id: SkillId | AbilityId): boolean {
    if (!isSkillId(id)) return false;
    return this.abilitySpent[id] === true;
  }

  /** True while the global lock or bar/door regen blocks all activates. */
  public isAbilityBarBusy(tick: number): boolean {
    if (
      this.abilityGlobalLockEndsAtTick !== null &&
      tick < this.abilityGlobalLockEndsAtTick
    ) {
      return true;
    }
    if (
      this.abilityBarRegenEndsAtTick !== null &&
      tick < this.abilityBarRegenEndsAtTick
    ) {
      return true;
    }
    if (
      this.abilityDoorRegenEndsAtTick !== null &&
      tick < this.abilityDoorRegenEndsAtTick
    ) {
      return true;
    }
    return false;
  }

  /**
   * Whether this player may start skill `id` at `tick`.
   * PR6: spent charges, global lock, bar/door regen. PR7: unlock/ownership.
   * PR-1: passives never activate; instants share charge/lock economy.
   * PR-2: skill must be in the match loadout (unless unrestricted).
   * Self heal: reject at full HP so a charge is not wasted.
   * Team heal: never heals the caster (no self full-HP gate either);
   * manager denies when no other teammate would receive HP.
   */
  public canActivateAbility(id: SkillId | AbilityId, tick: number): boolean {
    if (!isSkillId(id)) return false;
    if (!isSkillActivatable(id)) return false; // passives
    if (!this.alive || this.connectionIssue) return false;
    if (!this.ownsAbility(id)) return false;
    if (!this.hasSkillEquipped(id)) return false;
    if (this.isAbilityActive(id, tick)) return false;
    if (this.isAbilitySpent(id)) return false;
    if (this.isAbilityBarBusy(tick)) return false;
    if (id === "selfHeal" && this.health >= this.maxHealth) return false;
    return true;
  }

  /**
   * Ownership check (any tier of the skill family).
   * `null` owned set = unrestricted (bots / unit tests).
   * Explicit empty set = nothing owned (guests).
   */
  public ownsAbility(id: SkillId | AbilityId): boolean {
    if (!isSkillId(id)) return false;
    if (this.ownedSkillProducts === null) return true;
    return ownsSkill(id, [...this.ownedSkillProducts]);
  }

  /**
   * Whether skill `id` is in the match loadout (PR-2).
   * `null` loadout = unrestricted equip (bots / unit tests).
   */
  public hasSkillEquipped(id: SkillId | AbilityId): boolean {
    if (!isSkillId(id)) return false;
    return isSkillEquipped(id, this.skillLoadout);
  }

  /**
   * Replace ownership from a join token / reclaim.
   * Pass `null` to clear restriction (bots). Pass `[]` for guests.
   * Accepts full skill product ids (`selfHeal`, `quick2`, …).
   * Re-normalizes the match loadout so unowned skills are dropped.
   */
  public setOwnedAbilities(
    owned: readonly (SkillProductId | string)[] | null | undefined,
  ): void {
    if (owned == null) {
      this.ownedSkillProducts = null;
      // Unrestricted ownership → unrestricted equip unless an explicit loadout
      // was set (keep it; normalize with null ownership accepts all skill ids).
      if (this.skillLoadout != null) {
        this.skillLoadout = normalizeSkillLoadout(this.skillLoadout, null);
      }
      return;
    }
    const next = new Set<SkillProductId>();
    for (const id of owned) {
      if (typeof id === "string" && isSkillProductId(id)) next.add(id);
    }
    this.ownedSkillProducts = next;
    // Drop loadout slots that are no longer owned.
    if (this.skillLoadout != null) {
      this.skillLoadout = normalizeSkillLoadout(
        this.skillLoadout,
        this.snapshotOwnedAbilities(),
      );
    } else {
      // First time assigning restricted ownership with no loadout yet.
      this.skillLoadout = defaultSkillLoadout(this.snapshotOwnedAbilities());
    }
  }

  /**
   * Replace match loadout from client (My Skills bar). Validated: owned +
   * unique + max 4. Pass `null` for unrestricted equip (bots/tests only).
   */
  public setSkillLoadout(
    raw: readonly (SkillId | null | string)[] | null | undefined,
  ): void {
    if (raw == null) {
      this.skillLoadout = null;
      return;
    }
    const owned = this.snapshotOwnedAbilities();
    this.skillLoadout = normalizeSkillLoadout(raw, owned);
  }

  /** Owned product ids for welcome / debug (null → unrestricted). */
  public snapshotOwnedAbilities(): SkillProductId[] | null {
    if (this.ownedSkillProducts === null) return null;
    return SKILL_PRODUCT_ORDER.filter((id) => this.ownedSkillProducts!.has(id));
  }

  /**
   * Match loadout for welcome / debug.
   * `null` = unrestricted equip (bots). Empty slots are `null` cells.
   */
  public snapshotSkillLoadout(): SkillLoadout | null {
    if (this.skillLoadout === null) return null;
    return this.skillLoadout.slice() as SkillLoadout;
  }

  /** Full skill product list for catalog value lookups (`null` = max). */
  private ownedSkillsForValue(): SkillProductId[] | null {
    if (this.ownedSkillProducts === null) return null;
    return [...this.ownedSkillProducts];
  }

  /**
   * Start skill `id` if allowed. Branches by {@link SkillDef.kind}:
   * - **timed**: active window + global lock for duration; charge on end
   * - **instant**: charge immediately + global lock ({@link instantSkillLockTicks});
   *   optional 1-tick flash for VFX (does not re-spend)
   * - **passive**: never (rejected in {@link canActivateAbility})
   *
   * @param collision Optional map collision for Teleport sweep. Production
   *   paths pass {@link MapCollision}; omitted → open-space (tests / free blink).
   * Returns true when activation succeeded.
   */
  public tryActivateAbility(
    id: SkillId | AbilityId,
    tick: number,
    collision?: MoveCollision | null,
    obstacles?: readonly PlayerClipPose[] | null,
  ): boolean {
    if (!this.canActivateAbility(id, tick)) return false;
    if (!isSkillId(id)) return false;

    const kind = getSkillDef(id).kind;

    if (kind === "passive") {
      return false;
    }

    if (kind === "instant") {
      return this.activateInstantSkill(
        id,
        tick,
        collision ?? null,
        obstacles ?? null,
      );
    }

    // timed
    return this.activateTimedSkill(id, tick);
  }

  /**
   * Timed skill: exclusive end tick + global lock for the owned tier duration.
   * Charge is spent when the active window ends (not on activate).
   * Rapid fire also grants +1 spare magazine for the active weapon.
   */
  private activateTimedSkill(id: SkillId, tick: number): boolean {
    const durationTicks = this.timedDurationTicksFor(id);
    if (durationTicks <= 0) return false;
    const ends = tick + durationTicks;
    this.abilityEndsAtTick[id] = ends;
    // Global lock tracks the active window so shorter tiers do not over-lock.
    this.abilityGlobalLockEndsAtTick = ends;
    if (id === "rapidFire") {
      this.grantSpareClip();
    }
    this.touchActivity();
    return true;
  }

  /**
   * Skill G — Rapid fire: +1 spare magazine on the active weapon
   * (+{@link RAPID_FIRE_BONUS_SHELLS} spare shells on a shell gun).
   */
  private grantSpareClip(): void {
    const slot = this.loadouts[this.weaponId];
    if (!slot) return;
    const grant = shellReloadOf(this.weapon) ? RAPID_FIRE_BONUS_SHELLS : 1;
    slot.spareClips = Math.max(0, slot.spareClips) + grant;
  }

  /**
   * Instant skill: apply effect, spend charge immediately, global lock for
   * {@link INSTANT_SKILL_LOCK_S}, then bar regen. One-tick flash for VFX
   * snapshots (no re-spend on expire).
   *
   * Team heal is applied by {@link PlayerManager} (needs teammates); direct
   * activate here is incomplete and returns false — use handleAbility.
   * Teleport uses `collision` for a horizontal sweep (open-space if omitted).
   */
  private activateInstantSkill(
    id: SkillId,
    tick: number,
    collision: MoveCollision | null,
    obstacles: readonly PlayerClipPose[] | null = null,
  ): boolean {
    let fxFrom: { x: number; y: number; z: number } | undefined;
    if (id === "selfHeal") {
      if (!this.applySelfHeal()) return false;
    } else if (id === "teamHeal") {
      // Effect requires roster walk — PlayerManager.tryActivateTeamHeal.
      return false;
    } else if (id === "rewind") {
      // Capture pre-warp eye pose for client ghost VFX before applyRewind.
      fxFrom = { x: this.x, y: this.y, z: this.z };
      if (!this.applyRewind(tick)) return false;
    } else if (id === "teleport") {
      fxFrom = { x: this.x, y: this.y, z: this.z };
      if (
        !this.applyTeleport(collision ?? NO_COLLISION, tick, obstacles)
      ) {
        return false;
      }
    }

    this.applyInstantSpend(id, tick, fxFrom);
    return true;
  }

  /**
   * Spend charge + global lock + optional VFX flash for an instant skill
   * whose effect was already applied externally (e.g. team heal).
   * Returns false when activate gates fail.
   */
  public commitInstantSkill(id: SkillId | AbilityId, tick: number): boolean {
    if (!isSkillId(id)) return false;
    if (getSkillDef(id).kind !== "instant") return false;
    if (!this.canActivateAbility(id, tick)) return false;
    this.applyInstantSpend(id, tick);
    return true;
  }

  /** Charge + lock + flash shared by all instant activates. */
  private applyInstantSpend(
    id: SkillId,
    tick: number,
    fxFrom?: { x: number; y: number; z: number },
  ): void {
    // Spend charge up front — same economy as timed (one slot per cycle).
    this.abilitySpent[id] = true;
    const lockTicks = instantSkillLockTicks(TICK_HZ);
    const lockEnds = tick + lockTicks;
    this.abilityGlobalLockEndsAtTick = lockEnds;
    // Bar regen starts after the lock so total busy = lock + regen.
    this.abilityBarRegenEndsAtTick = lockEnds + abilityBarRegenTicks(TICK_HZ);
    // Optional flash so snapshot can show a pulse; already spent.
    if (INSTANT_SKILL_FLASH_TICKS > 0) {
      this.abilityEndsAtTick[id] = tick + INSTANT_SKILL_FLASH_TICKS;
      this.abilityNoSpendOnEnd[id] = true;
      if (fxFrom) {
        this.abilityFxOrigin[id] = fxFrom;
      }
    }
    this.touchActivity();
  }

  /**
   * Self heal instant effect: restore tier HP (15 / 25), clamp to max.
   * Returns false when no heal would apply (dead / full / zero value).
   */
  private applySelfHeal(): boolean {
    const amount = skillValueForOwned("selfHeal", this.ownedSkillsForValue());
    if (amount <= 0) return false;
    return this.heal(amount) > 0;
  }

  /**
   * Skill E — Rewind: teleport to pose from `value` seconds ago (1.5 / 2.25 / 3).
   * Uses the pose ring (must cover max window). Clears vertical velocity and
   * slide so the player does not keep falling / sliding from the future pose.
   * History is kept (not cleared) so lag-comp and a later rewind still work.
   * Returns false when value is zero (unowned).
   */
  private applyRewind(tick: number): boolean {
    const windowS = skillValueForOwned("rewind", this.ownedSkillsForValue());
    if (!(windowS > 0) || !Number.isFinite(windowS)) return false;
    const windowTicks = Math.max(1, Math.ceil(windowS * TICK_HZ));
    const whenTick = tick - windowTicks;
    const pose = this.poseAt(whenTick);
    this.x = pose.x;
    this.y = pose.y;
    this.z = pose.z;
    this.crouch = pose.crouch;
    this.velocityY = 0;
    this.clearSlide();
    this.prevInputCrouch = pose.crouch;
    // Grounded if eye height is at standing/crouch eye on flat ground.
    const groundEye = eyeHeightForCrouch(this.crouch);
    this.onGround = this.y <= groundEye + 0.05;
    this.lastLandedAtTick = null;
    // Record rewound pose at current tick so the ring reflects post-rewind.
    this.recordPose(tick);
    return true;
  }

  /**
   * Skill F — Teleport: collision-swept horizontal blink along look yaw up to
   * `value` units (3 / 5 / 7). Preserves eye height (y); ignores pitch so
   * players cannot vertical-exploit. Stops at the last free sample before a
   * wall/bounds hit. Clears vertical velocity + slide like Rewind.
   * Returns false when value is zero (unowned).
   */
  private applyTeleport(
    collision: MoveCollision,
    tick: number,
    obstacles: readonly PlayerClipPose[] | null = null,
  ): boolean {
    const dist = skillValueForOwned("teleport", this.ownedSkillsForValue());
    if (!(dist > 0) || !Number.isFinite(dist)) return false;

    const eye = moveEyeHeight(this.crouch);
    const feetY = Math.max(0, this.y - eye);
    const headY = feetY + moveCollisionHeight(this.crouch);
    const col = obstacles && obstacles.length > 0
      ? withPlayerObstacles(
        collision,
        { id: this.id, y: this.y, crouch: this.crouch },
        obstacles,
      )
      : collision;
    const next = blinkAlongYaw(
      col,
      this.x,
      this.z,
      this.yaw,
      dist,
      feetY,
      headY,
    );
    this.x = next.x;
    this.z = next.z;
    // Keep y (eye height); kill residual vertical motion from pre-blink jump.
    this.velocityY = 0;
    this.clearSlide();
    const groundEye = eyeHeightForCrouch(this.crouch);
    this.onGround = this.y <= groundEye + 0.05;
    this.lastLandedAtTick = null;
    this.recordPose(tick);
    return true;
  }

  /**
   * Heal amount for a skill family from ownership (0 if unowned; max if unrestricted).
   * Used by PlayerManager for team heal value.
   */
  public skillValue(id: SkillId): number {
    return skillValueForOwned(id, this.ownedSkillsForValue());
  }

  /**
   * Restore HP, clamped to this player's maximum. No overheal.
   * Returns the amount actually restored (0 if dead or already full).
   */
  public heal(amount: number): number {
    if (!this.alive) return 0;
    if (!Number.isFinite(amount) || amount <= 0) return 0;
    const before = this.health;
    if (before >= this.maxHealth) return 0;
    this.health = Math.min(this.maxHealth, before + amount);
    return this.health - before;
  }

  /** Duration ticks for a timed skill (single skills catalog source). */
  private timedDurationTicksFor(id: SkillId): number {
    return timedSkillDurationTicks(id, TICK_HZ, this.ownedSkillsForValue());
  }

  /** Wall-clock duration for a skill family given ownership (for tests/HUD). */
  public abilityDurationS(id: SkillId | AbilityId): number {
    if (!isSkillId(id)) return 0;
    return timedSkillDurationSForOwned(id, this.ownedSkillsForValue());
  }

  /**
   * Door capture: start 1s charge regen. Spent abilities restore when the
   * window ends (including the spawn/death lock that greys the whole kit).
   * Actives finishing after capture do not re-spend.
   * No-op when nothing is spent and no active abilities.
   */
  public beginAbilityDoorRegen(tick: number): void {
    const tracked = this.trackedSkillIds();
    const hasSpent = tracked.some((id) => this.isAbilitySpent(id));
    const hasActive = tracked.some((id) => this.isAbilityActive(id, tick));
    if (!hasSpent && !hasActive) return;
    // Capture restores charges after 1s; clear post-use bar regen so door
    // window is the sole lock. Keep global lock if still mid-effect so the
    // active ability finishes cleanly.
    this.abilityBarRegenEndsAtTick = null;
    this.abilityDoorRegenEndsAtTick = tick + abilityDoorRegenTicks();
    // Mid-active abilities were "paid for" before capture — don't re-spend.
    for (const id of tracked) {
      if (this.isAbilityActive(id, tick)) {
        this.abilityNoSpendOnEnd[id] = true;
      }
    }
  }

  /** Skill ids that may appear in spent / active maps this match. */
  private trackedSkillIds(): SkillId[] {
    const ids = new Set<SkillId>();
    for (const id of ABILITY_ORDER) ids.add(id);
    for (const id of SKILL_ORDER) ids.add(id);
    for (const id of Object.keys(this.abilityEndsAtTick) as SkillId[]) {
      ids.add(id);
    }
    for (const id of Object.keys(this.abilitySpent) as SkillId[]) {
      ids.add(id);
    }
    return [...ids];
  }

  /** Active ability entries for the wire snapshot (only still-running windows). */
  public snapshotActiveAbilities(tick: number): AbilitySnapEntry[] {
    const out: AbilitySnapEntry[] = [];
    for (const id of Object.keys(this.abilityEndsAtTick) as SkillId[]) {
      const ends = this.abilityEndsAtTick[id];
      if (!isAbilityActiveAt(ends, tick)) continue;
      const entry: AbilitySnapEntry = { id, endsAtTick: ends! };
      const from = this.abilityFxOrigin[id];
      if (from) {
        entry.fromX = from.x;
        entry.fromY = from.y;
        entry.fromZ = from.z;
      }
      out.push(entry);
    }
    return out;
  }

  /** Spent skill ids for the wire snapshot (omit empty). */
  public snapshotSpentAbilities(): SkillId[] {
    const out: SkillId[] = [];
    for (const id of this.trackedSkillIds()) {
      if (this.isAbilitySpent(id)) out.push(id);
    }
    return out;
  }

  /**
   * Expire active windows → spent + bar regen; clear stale lock/regen ticks;
   * complete door regen (clear spent). Safe to call while dead so timers progress.
   */
  public tickAbilityCharges(tick: number): void {
    let anyExpired = false;
    for (const id of Object.keys(this.abilityEndsAtTick) as SkillId[]) {
      const ends = this.abilityEndsAtTick[id];
      if (isAbilityActiveAt(ends, tick)) continue;
      delete this.abilityEndsAtTick[id];
      delete this.abilityFxOrigin[id];
      // Capture restored kit / instant already spent — do not re-spend.
      if (this.abilityNoSpendOnEnd[id]) {
        delete this.abilityNoSpendOnEnd[id];
        continue;
      }
      // Still inside door regen window — same forgiveness.
      if (
        this.abilityDoorRegenEndsAtTick !== null &&
        tick < this.abilityDoorRegenEndsAtTick
      ) {
        continue;
      }
      this.abilitySpent[id] = true;
      anyExpired = true;
    }

    if (anyExpired) {
      // Start post-use bar reverse-fill if not already in one / door regen.
      if (
        this.abilityDoorRegenEndsAtTick === null &&
        (this.abilityBarRegenEndsAtTick === null ||
          tick >= this.abilityBarRegenEndsAtTick)
      ) {
        this.abilityBarRegenEndsAtTick = tick + abilityBarRegenTicks();
      }
    }

    if (
      this.abilityGlobalLockEndsAtTick !== null &&
      tick >= this.abilityGlobalLockEndsAtTick
    ) {
      this.abilityGlobalLockEndsAtTick = null;
    }
    if (
      this.abilityBarRegenEndsAtTick !== null &&
      tick >= this.abilityBarRegenEndsAtTick
    ) {
      this.abilityBarRegenEndsAtTick = null;
    }
    if (
      this.abilityDoorRegenEndsAtTick !== null &&
      tick >= this.abilityDoorRegenEndsAtTick
    ) {
      this.abilityDoorRegenEndsAtTick = null;
      this.restoreAbilityCharges();
    }
  }

  /**
   * True when shots do not consume magazine ammo: permanent unlimited (prematch /
   * agents) or the timed Bullets ability.
   */
  public hasFreeAmmo(tick: number): boolean {
    return this.unlimitedAmmo || this.isAbilityActive("bullets", tick);
  }

  /**
   * Skill G — Rapid fire: fire cooldown halved (2× fire rate) while active.
   * Computed from wall-clock ms so client `fireCooldownMs / 2` stays in sync.
   */
  public fireCooldownTicksAt(tick: number): number {
    const w = this.weapon;
    if (!this.isAbilityActive("rapidFire", tick)) return w.fireCooldownTicks;
    return Math.max(1, msToTicks(w.fireCooldownMs / 2));
  }

  /**
   * Skill G — Rapid fire: reload duration halved while active.
   * Applied when a reload **starts** (tryBeginReload); in-progress timers keep
   * whatever end tick was set at start.
   */
  public reloadTicksAt(tick: number): number {
    const w = this.weapon;
    if (!this.isAbilityActive("rapidFire", tick)) return w.reloadTicks;
    return Math.max(1, msToTicks(w.reloadMs / 2));
  }

  /**
   * Shell-reload timer length (ms stat) at `tick`. Rapid Fire halves timers
   * that **start** under the buff, like {@link reloadTicksAt}.
   */
  private shellTicksAt(ms: number, tick: number): number {
    if (!this.isAbilityActive("rapidFire", tick)) return msToTicks(ms);
    return Math.max(1, msToTicks(ms / 2));
  }

  /**
   * Tick-exact fire gate (epic 4.4). Pure function of weapon/ability/life
   * state at `tick` — no wall-clock reads.
   */
  public canShoot(tick: number): boolean {
    // Bullets: treat as hasAmmo for the full active window (true free-fire).
    const hasAmmo = this.hasFreeAmmo(tick) || this.ammoInMag > 0;
    // Glitch: cannot shoot for the full active window (even if door-revealed).
    if (this.isAbilityActive("glitch", tick)) return false;
    return (
      this.alive &&
      !this.connectionIssue &&
      !this.isReloading() &&
      !this.isSwitching(tick) &&
      // Shell guns: every shot needs a finished pump (always true for mags).
      this.chambered &&
      !this.isPumping() &&
      hasAmmo &&
      tick - this.lastShotAtTick >= this.fireCooldownTicksAt(tick)
    );
  }

  /**
   * Glitch remote-visibility for the wire.
   * `hidden` when active and outside the enemy-door force-visible radius;
   * `revealed` when active and within 5u of the enemy door segment.
   * `undefined` when Glitch is not active.
   */
  public glitchSnapState(
    tick: number,
    collision: MapCollision | null | undefined,
  ): GlitchSnapState | undefined {
    if (!this.isAbilityActive("glitch", tick) || !this.alive) return undefined;
    if (!collision) return "hidden";
    // Agents have no enemy door to score — always fully hidden while glitched.
    if (this.isAgent) return "hidden";
    const enemySide = this.team === "A"
      ? collision.map.teamB
      : collision.map.teamA;
    const [d0, d1] = doorSegment(collision.map.bounds, enemySide);
    return isGlitchForcedVisible(this.x, this.z, d0, d1)
      ? "revealed"
      : "hidden";
  }

  /**
   * Commit a shot at `tick`: stamp cooldown and optionally decrement mag.
   * `touchActivity` is NON-SIM AFK metadata only — it does not mutate weapon
   * sim state (ammo / cooldown / reload / switch).
   */
  public markShot(tick: number): void {
    this.lastShotAtTick = tick;
    // Skip mag decrement for permanent unlimitedAmmo and timed Bullets.
    // Do not stomp unlimitedAmmo — Bullets is windowed via isAbilityActive.
    if (!this.hasFreeAmmo(tick)) {
      this.setActiveAmmo(Math.max(0, this.ammoInMag - 1));
    }
    // Shell guns pump after every shot (inside the fire cooldown).
    if (shellReloadOf(this.weapon)) this.startPump(tick);
    // NON-SIM: AFK / participation metadata only.
    this.touchActivity();
  }

  /**
   * Shell guns: start cocking at `tick` (uncocked until it finishes).
   * Rapid Fire halves a pump that starts under the buff.
   */
  private startPump(tick: number, delayTicks = 0): void {
    const shell = shellReloadOf(this.weapon);
    const slot = this.loadouts[this.weaponId];
    if (!shell || !slot) return;
    slot.chambered = false;
    this.pumpEndsAtTick = tick + delayTicks +
      this.shellTicksAt(shell.pumpMs, tick);
  }

  /** Finish the pump when its timer elapses (call each sim tick). */
  public tickPump(tick: number): void {
    if (this.pumpEndsAtTick === null) return;
    if (tick < this.pumpEndsAtTick) return;
    this.pumpEndsAtTick = null;
    const slot = this.loadouts[this.weaponId];
    if (slot) slot.chambered = true;
  }

  /**
   * Shell guns: a fire press during shell loading is spent as the interrupt.
   * Loading stops (loaded shells stay) and a pump starts; nothing fires. The
   * next shot needs a new press after the pump. Returns true when the press
   * was consumed.
   */
  public tryInterruptShellReload(tick: number): boolean {
    if (this.shellReloadNextAtTick === null) return false;
    if (!this.alive || this.connectionIssue) return false;
    this.shellReloadNextAtTick = null;
    this.startPump(tick);
    // NON-SIM: AFK / participation metadata only.
    this.touchActivity();
    return true;
  }

  /**
   * Tick-exact melee gate (epic 4.4): equipped weapon has `melee` (pistol-whip,
   * stock bash), alive, not switching, not mag-reloading, that weapon's melee
   * cooldown elapsed. Shell loading does not block: the bash interrupts it
   * (see {@link markMelee}). A pump in progress doesn't block either; a bash
   * needs no chambered shell. Glitch blocks melee like it blocks shots. Melee
   * never touches ammo. No wall-clock reads.
   */
  public canMelee(tick: number): boolean {
    const cooldownTicks = this.weapon.meleeCooldownTicks;
    if (cooldownTicks == null) return false;
    if (this.isAbilityActive("glitch", tick)) return false;
    return (
      this.alive &&
      !this.connectionIssue &&
      this.reloadEndsAtTick === null &&
      !this.isSwitching(tick) &&
      tick - this.lastMeleeAtTick >= cooldownTicks
    );
  }

  /**
   * Start a melee swing: stamp cooldown (no ammo, no recoil state). A bash
   * during shell loading stops it (loaded shells stay) and the pump runs
   * after the swing, like the fire interrupt. `touchActivity` is NON-SIM AFK
   * metadata only.
   */
  public markMelee(tick: number): void {
    this.lastMeleeAtTick = tick;
    if (this.shellReloadNextAtTick !== null) {
      this.shellReloadNextAtTick = null;
      const swingMs = this.weapon.melee?.swingMs ?? 0;
      this.startPump(tick, msToTicks(swingMs));
    }
    // NON-SIM: AFK / participation metadata only.
    this.touchActivity();
  }

  /**
   * Equip a different weapon. Pauses an in-progress reload on the old gun
   * (resumes when switched back). Blocks shoot/reload until switch completes.
   * Returns true when the active weapon changed.
   *
   * Authority: `weaponId` changes immediately (hitscan/ammo). Holster/draw
   * presentation is client-owned; the only timed server side is the fire lock
   * via `weaponSwitchEndsAtTick` / `isSwitching`.
   */
  public trySwitchWeapon(weaponId: number, tick: number): boolean {
    if (!this.alive || this.connectionIssue) return false;
    if (!isWeaponId(weaponId)) return false;
    if (weaponId === this.weaponId) return false;
    if (this.isSwitching(tick)) return false;

    this.pauseActiveReload(tick);
    // Shell guns: loading stops (loaded shells stay) and a pump in progress
    // is dropped; the slot stays uncocked and pumps at the end of the draw.
    this.shellReloadNextAtTick = null;
    this.pumpEndsAtTick = null;
    this.weaponId = weaponId;
    this.weaponSwitchEndsAtTick = tick + WEAPON_SWITCH_TICKS;
    // NON-SIM: AFK / participation metadata only.
    this.touchActivity();
    // Do not resume a paused reload on the new gun until the draw finishes.
    return true;
  }

  /** Cycle pistol ↔ rifle (and any future entries in WEAPON_ORDER). */
  public tryCycleWeapon(tick: number): boolean {
    const order = WEAPON_ORDER;
    const idx = order.indexOf(this.weaponId as (typeof order)[number]);
    const next = order[(idx < 0 ? 0 : idx + 1) % order.length]!;
    return this.trySwitchWeapon(next, tick);
  }

  /**
   * Begin a full-mag swap if possible. Returns true when reload started.
   * Partial mag is discarded (clip swap). No resupply when spares are gone.
   * If this weapon had a paused mid-switch reload, that remaining time is used
   * instead of a full reload (caller normally resumes via tickWeaponSwitch).
   */
  public tryBeginReload(tick: number): boolean {
    if (!this.alive || this.connectionIssue) return false;
    if (this.isSwitching(tick)) return false;
    if (this.isReloading()) return false;
    const w = this.weapon;
    if (!this.unlimitedAmmo && this.spareClips <= 0) return false;
    if (this.ammoInMag >= w.magSize) return false;
    const shell = shellReloadOf(w);
    if (shell) {
      // Open the gun, then one shell per perShellMs. A pump in progress is
      // dropped: every reload ends with its own pump.
      this.pumpEndsAtTick = null;
      this.shellReloadNextAtTick = tick +
        this.shellTicksAt(shell.startMs, tick) +
        this.shellTicksAt(shell.perShellMs, tick);
      // NON-SIM: AFK / participation metadata only.
      this.touchActivity();
      return true;
    }
    // Fresh reload — drop any stale paused progress for this slot.
    delete this.pausedReloadRemainingTicks[this.weaponId];
    // Rapid fire: half reload duration when the reload starts under the buff.
    this.reloadEndsAtTick = tick + this.reloadTicksAt(tick);
    // NON-SIM: AFK / participation metadata only.
    this.touchActivity();
    return true;
  }

  /** Store remaining reload ticks for the equipped weapon and clear the timer. */
  private pauseActiveReload(tick: number): void {
    if (this.reloadEndsAtTick === null) return;
    const remaining = this.reloadEndsAtTick - tick;
    if (remaining <= 0) {
      // Reload would complete this tick — finish now instead of dropping it.
      const w = this.weapon;
      this.setActiveAmmo(w.magSize, Math.max(0, this.spareClips - 1));
      this.reloadEndsAtTick = null;
      delete this.pausedReloadRemainingTicks[this.weaponId];
      return;
    }
    this.pausedReloadRemainingTicks[this.weaponId] = remaining;
    this.reloadEndsAtTick = null;
  }

  /** Resume a previously paused reload for the active weapon, if any. */
  private resumePausedReload(tick: number): void {
    const remaining = this.pausedReloadRemainingTicks[this.weaponId];
    if (remaining === undefined) return;
    delete this.pausedReloadRemainingTicks[this.weaponId];
    if (remaining <= 0) return;
    // Only resume if the mag still needs a reload and we still have spares.
    const w = this.weapon;
    if (
      (!this.unlimitedAmmo && this.spareClips <= 0) ||
      this.ammoInMag >= w.magSize
    ) {
      return;
    }
    this.reloadEndsAtTick = tick + remaining;
  }

  /**
   * Complete a weapon switch when the holster+draw window elapses, then resume
   * any paused reload on the newly equipped gun. A shell gun holstered
   * uncocked pumps at the end of the draw.
   */
  public tickWeaponSwitch(tick: number): void {
    if (this.weaponSwitchEndsAtTick === null) return;
    if (tick < this.weaponSwitchEndsAtTick) return;
    this.weaponSwitchEndsAtTick = null;
    this.resumePausedReload(tick);
    if (shellReloadOf(this.weapon) && !this.chambered) this.startPump(tick);
  }

  /** Finish reload when the timer elapses (call each sim tick). */
  public tickReload(tick: number): void {
    this.tickShellReload(tick);
    if (this.reloadEndsAtTick === null) return;
    if (tick < this.reloadEndsAtTick) return;
    const w = this.weapon;
    if (this.unlimitedAmmo) {
      this.setActiveAmmo(w.magSize, this.spareClips);
    } else {
      this.setActiveAmmo(w.magSize, Math.max(0, this.spareClips - 1));
    }
    this.reloadEndsAtTick = null;
    delete this.pausedReloadRemainingTicks[this.weaponId];
  }

  /**
   * Shell guns: move one shell spare → tube when due. Loading ends by itself
   * (with a pump) when the tube is full or the spares run out.
   */
  private tickShellReload(tick: number): void {
    if (this.shellReloadNextAtTick === null) return;
    if (tick < this.shellReloadNextAtTick) return;
    const shell = shellReloadOf(this.weapon);
    const slot = this.loadouts[this.weaponId];
    if (!shell || !slot) {
      this.shellReloadNextAtTick = null;
      return;
    }
    const w = this.weapon;
    if (slot.ammoInMag < w.magSize && (this.unlimitedAmmo || slot.spareClips > 0)) {
      slot.ammoInMag += 1;
      if (!this.unlimitedAmmo) slot.spareClips -= 1;
    }
    const outOfSpares = !this.unlimitedAmmo && slot.spareClips <= 0;
    if (slot.ammoInMag >= w.magSize || outOfSpares) {
      this.shellReloadNextAtTick = null;
      this.startPump(tick);
      return;
    }
    this.shellReloadNextAtTick = tick +
      this.shellTicksAt(shell.perShellMs, tick);
  }

  /** Drop active and paused reloads (death / resupply). */
  public cancelReload(): void {
    this.reloadEndsAtTick = null;
    this.shellReloadNextAtTick = null;
    this.pumpEndsAtTick = null;
    for (const id of Object.keys(this.pausedReloadRemainingTicks)) {
      delete this.pausedReloadRemainingTicks[Number(id)];
    }
  }

  /** Abort an in-progress weapon switch (death / resupply). */
  public cancelWeaponSwitch(): void {
    this.weaponSwitchEndsAtTick = null;
  }

  /** Horizontal move intent from the latest input (for aim bloom). */
  public isMoveIntent(): boolean {
    const i = this.latestInput;
    if (!i) return false;
    return Boolean(i.forward || i.backward || i.left || i.right);
  }

  /**
   * Horizontal movement yaw for yaw-pole movement FOV.
   * Slide direction while sliding; otherwise wish dir from WASD + look yaw.
   * Null when not moving (no keys / zero dir).
   */
  public moveYawForFov(): number | null {
    if (this.isSliding()) {
      return yawFromWorldDir(this.slideDirX, this.slideDirZ);
    }
    const i = this.latestInput;
    if (!i) return null;
    return wishMoveYaw(this.yaw, i);
  }

  /**
   * Sprint held, not crouching, and stamina remaining
   * (matches move speed / aim-bloom rules).
   */
  public isSprintIntent(): boolean {
    const i = this.latestInput;
    if (!i || this.crouch) return false;
    if (this.sprintStamina <= 0) return false;
    return Boolean(i.sprint);
  }

  /** Jump held on latest applied input (heatmap takeoff sampling). */
  public isJumpIntent(): boolean {
    const i = this.latestInput;
    if (!i) return false;
    return Boolean(i.jump);
  }

  /** Movement state used for aim-spread / crosshair bloom. */
  public aimMovementState(): {
    onGround: boolean;
    crouch: boolean;
    moving: boolean;
    sprint: boolean;
    sliding: boolean;
  } {
    return {
      onGround: this.onGround,
      crouch: this.crouch,
      moving: this.isMoveIntent(),
      sprint: this.isSprintIntent(),
      sliding: this.isSliding(),
    };
  }

  /**
   * Apply an already-computed authoritative damage amount.
   *
   * `nowMs` is used only to freeze the non-simulation AFK label at death;
   * health/alive/diedAtTick decisions remain tick-driven.
   */
  public takeDamage(
    amount: number,
    _zone: HitZone,
    tick: number,
    nowMs: number,
  ): boolean {
    if (!this.alive) return false;
    // Spawn protect + Force Field (Skill C) — no damage, no kill.
    if (this.isInvulnerable(tick)) return false;
    this.health = Math.max(0, this.health - amount);
    if (this.health <= 0) {
      this.becomeDead(tick, nowMs);
      return true;
    }
    return false;
  }

  /**
   * Stuck inside another player's body cylinder after clip failed.
   * Bypasses spawn protect / Force Field — this is a failsafe, not combat.
   */
  /** Overlap failsafe death; `nowMs` only serves non-sim AFK bookkeeping. */
  public dieFromOverlap(tick: number, nowMs: number): boolean {
    if (!this.alive) return false;
    this.becomeDead(tick, nowMs);
    return true;
  }

  private becomeDead(tick: number, nowMs: number): void {
    // Freeze AFK before flipping alive — closed-door waits must not re-label.
    // AFK is non-sim bookkeeping; the explicit value keeps this transition
    // free of implicit wall-clock reads.
    this.afkWhileDead = this.isAfk(nowMs);
    this.alive = false;
    this.health = 0;
    this.diedAtTick = tick;
    this.latestInput = null;
    this.velocityX = 0;
    this.velocityY = 0;
    this.velocityZ = 0;
    this.cancelReload();
    this.cancelWeaponSwitch();
    // Skills lock until the next door capture (same as fresh spawn).
    this.lockAbilityChargesUntilDoor();
    // Stand up on death so corpse / death flop uses full height.
    this.clearSlide();
    this.prevInputCrouch = false;
    this.clearHitSlow();
    if (this.crouch) {
      this.y += STAND_EYE_HEIGHT - CROUCH_EYE_HEIGHT;
      this.crouch = false;
    }
  }

  /** Apply one bullet-hit slow stack and refresh the shared expiry window. */
  public applyBulletHitSlow(tick: number): void {
    if (!this.alive) return;
    const current = this.activeHitSlowStacks(tick);
    this.hitSlowStacks = Math.min(HIT_SLOW_MAX_STACKS, current + 1);
    this.hitSlowEndsAtTick = tick + HIT_SLOW_DURATION_TICKS;
  }

  /** Active stack count at this sim tick (expired state reads as zero). */
  public activeHitSlowStacks(tick: number): number {
    return tick < this.hitSlowEndsAtTick ? this.hitSlowStacks : 0;
  }

  /** Authoritative expiry tick when the bullet-hit slow is active. */
  public activeHitSlowEndsAtTick(tick: number): number | undefined {
    return this.activeHitSlowStacks(tick) > 0
      ? this.hitSlowEndsAtTick
      : undefined;
  }

  /** Epic 9.1 — raw hit-slow stacks (checkpoint; not tick-filtered). */
  public getHitSlowStacks(): number {
    return this.hitSlowStacks;
  }

  /** Epic 9.1 — raw hit-slow expiry tick (checkpoint). */
  public getHitSlowEndsAtTick(): number {
    return this.hitSlowEndsAtTick;
  }

  /**
   * Epic 9.1 — per-weapon paused-reload remainders (checkpoint).
   * Returns a fresh copy; never the live owner map.
   */
  public snapshotPausedReloadRemainingTicks(): Readonly<Record<number, number>> {
    return { ...this.pausedReloadRemainingTicks };
  }

  /**
   * Epic 9.1 — instant-skill "no spend on end" flags (charge-lock state).
   * Returns a fresh copy; never the live owner map.
   */
  public snapshotAbilityNoSpendOnEnd(): Readonly<
    Partial<Record<SkillId, true>>
  > {
    return { ...this.abilityNoSpendOnEnd };
  }

  /**
   * Epic 9.3 — verbatim owner restore from a checkpoint player block.
   * No join/spawn/death side effects; input-arrival fields left at defaults.
   */
  public restoreFromCheckpoint(state: CheckpointPlayerState): void {
    this.team = state.team;

    // Motion — full floats, never quantized.
    this.x = state.x;
    this.y = state.y;
    this.z = state.z;
    this.yaw = state.yaw;
    this.pitch = state.pitch;
    this.velocityX = state.velocityX;
    this.velocityY = state.velocityY;
    this.velocityZ = state.velocityZ;
    this.onGround = state.onGround;
    this.crouch = state.crouch;
    this.sprintStamina = state.sprintStamina;
    this.slideRemaining = state.slideRemaining;
    this.slideDirX = state.slideDirX;
    this.slideDirZ = state.slideDirZ;
    this.slideForceCrouch = state.slideForceCrouch;
    this.prevInputCrouch = state.prevInputCrouch === true;
    this.lastLandedAtTick = state.lastLandedAtTick ?? null;
    this.poseHistory.clear();
    for (const s of state.poseHistory ?? []) {
      this.poseHistory.push(
        s.tick,
        s.x,
        s.y,
        s.z,
        s.crouch,
        s.slide,
        s.yaw,
        s.pitch,
        s.velocityX,
        s.velocityY,
        s.velocityZ,
        s.onGround,
        s.landingAmount,
      );
    }

    // Health / lifecycle.
    this.maxHealth = state.maxHealth;
    this.health = state.health;
    this.alive = state.alive;
    this.spawnedAtTick = state.spawnedAtTick;
    this.diedAtTick = state.diedAtTick;
    this.enemyDoorSinceTick = state.enemyDoorSinceTick;
    this.hitSlowStacks = state.hitSlowStacks;
    this.hitSlowEndsAtTick = state.hitSlowEndsAtTick;
    this.lastOverlapOof = false;

    // Weapons.
    this.weaponId = state.weaponId;
    for (const slot of state.weaponLoadouts) {
      const dest = this.loadouts[slot.weaponId];
      if (dest) {
        dest.ammoInMag = slot.ammoInMag;
        dest.spareClips = slot.spareClips;
        dest.chambered = slot.chambered ?? true;
      } else {
        this.loadouts[slot.weaponId] = {
          ammoInMag: slot.ammoInMag,
          spareClips: slot.spareClips,
          chambered: slot.chambered ?? true,
        };
      }
    }
    this.reloadEndsAtTick = state.reloadEndsAtTick;
    this.shellReloadNextAtTick = state.shellReloadNextAtTick ?? null;
    this.pumpEndsAtTick = state.pumpEndsAtTick ?? null;
    this.weaponSwitchEndsAtTick = state.weaponSwitchEndsAtTick;
    this.lastShotAtTick = state.lastShotAtTick ?? Number.NEGATIVE_INFINITY;
    this.lastMeleeAtTick = state.lastMeleeAtTick ?? Number.NEGATIVE_INFINITY;
    for (const key of Object.keys(this.pausedReloadRemainingTicks)) {
      delete this.pausedReloadRemainingTicks[Number(key)];
    }
    for (const [wid, remaining] of Object.entries(
      state.pausedReloadRemainingTicks,
    )) {
      this.pausedReloadRemainingTicks[Number(wid)] = remaining;
    }
    this.unlimitedAmmo = state.unlimitedAmmo;

    // Abilities / charge locks.
    this.abilityEndsAtTick = { ...state.abilityEndsAtTick };
    this.abilityFxOrigin = {};
    for (const id of Object.keys(state.abilityFxOrigin) as SkillId[]) {
      const from = state.abilityFxOrigin[id];
      if (!from) continue;
      this.abilityFxOrigin[id] = { x: from.x, y: from.y, z: from.z };
    }
    this.abilitySpent = { ...state.abilitySpent };
    this.abilityGlobalLockEndsAtTick = state.abilityGlobalLockEndsAtTick;
    this.abilityBarRegenEndsAtTick = state.abilityBarRegenEndsAtTick;
    this.abilityDoorRegenEndsAtTick = state.abilityDoorRegenEndsAtTick;
    this.abilityNoSpendOnEnd = { ...state.abilityNoSpendOnEnd };

    // Dynamic loadout.
    this.setEquipment(state.equipment);
    this.setOwnedAbilities(state.ownedAbilities);
    this.setSkillLoadout(state.skillLoadout);

    // Scoring.
    this.score = state.score;
    this.kills = state.kills;
    this.deaths = state.deaths;
    this.xp = state.xp;

    // Input-arrival defaults (Decision 4 — next-tick-owned, not in frame).
    this.latestInput = null;
    this.selectedInputForTick = null;
    this.lastTickSelection = null;
    this.arrivalSinceLastStep = false;
    this.lastArrivalInput = null;
    this.lastSequence = 0;
    this.appliedSequence = 0;
    this.inputHoldTicks = 0;
  }

  private clearHitSlow(): void {
    this.hitSlowStacks = 0;
    this.hitSlowEndsAtTick = 0;
  }

  /**
   * @param delayTicks Open-door / prematch uses {@link RESPAWN_DELAY_TICKS};
   *   closed-door (agents) uses the longer closed delay from the manager.
   */
  public shouldRespawn(
    tick: number,
    delayTicks: number = RESPAWN_DELAY_TICKS,
  ): boolean {
    // Hold respawn while connection is down — restore on reclaim instead.
    if (this.connectionIssue) return false;
    return (
      !this.alive &&
      this.diedAtTick !== null &&
      tick - this.diedAtTick >= delayTicks
    );
  }

  public respawn(spawn: SpawnPose, tick: number): void {
    // Long death waits leave lastActivityAtMs stale; if they were not AFK when
    // they died, refresh so they do not flip AFK the instant they respawn.
    const wasAfkWhileDead = this.afkWhileDead;
    this.afkWhileDead = null;
    this.applySpawn(spawn, tick);
    this.clearHitSlow();
    this.health = this.maxHealth;
    this.alive = true;
    this.diedAtTick = null;
    this.latestInput = null;
    if (wasAfkWhileDead === false) {
      this.touchActivity();
    }
    // Death respawn: full heal, full sprint (via applySpawn), full ammo.
    this.restoreLoadouts();
  }

  /**
   * Door capture: teleport to own door (portal-mapped xz + yaw, copied pitch)
   * with spawn protection and resupply ammo. Health and sprint stamina are
   * preserved (unlike death respawn, which uses corner spawn points).
   */
  public sendHomeAfterScore(spawn: SpawnPose, tick: number): void {
    const health = this.health;
    const sprintStamina = this.sprintStamina;
    this.applySpawn(spawn, tick);
    this.health = health;
    this.sprintStamina = sprintStamina;
    this.alive = true;
    this.diedAtTick = null;
    this.latestInput = null;
    this.restoreLoadouts();
    // Door capture regenerates spent ability charges (1s window).
    this.beginAbilityDoorRegen(tick);
  }

  /**
   * Set when the last {@link update} ended with the center still inside
   * another living player's body cylinder after clip + map resolve.
   */
  public lastOverlapOof = false;

  /**
   * Advance exactly one authoritative simulation tick.
   *
   * Contract:
   * 1. Read the latest accepted input selected for this tick (or null).
   * 2. Pass its movement subset, the fixed shared `DT`, and `MapCollision`
   *    through `stepMove`.
   * 3. Write the returned mobility state back to the authoritative player.
   * 4. Derive horizontal velocity from the resulting position delta.
   *
   * Dead-body gravity and the connection-issue sitting-duck branch remain
   * deterministic tick branches. This method never derives a timestep from
   * wall-clock time, and its return value only reports pose movement.
   */
  public update(
    collision: MapCollision,
    tick: number,
    obstacles: readonly PlayerClipPose[] = [],
  ): boolean {
    this.lastOverlapOof = false;
    if (!this.alive) {
      // Ability timers still advance while dead (charges persist; lock expires).
      this.tickAbilityCharges(tick);
      const prevY = this.y;
      this.velocityY -= MOVE_GRAVITY * DT;
      this.y += this.velocityY * DT;
      if (this.y <= PLAYER_HEIGHT) {
        this.y = PLAYER_HEIGHT;
        this.velocityY = 0;
        this.onGround = true;
      }
      this.recordPose(tick);
      this.velocityX = 0;
      this.velocityZ = 0;
      this.selectedInputForTick = null;
      this.recordTickSelection(tick, null, false);
      return Math.abs(this.y - prevY) > 1e-6;
    }

    // Sitting duck: no movement / weapon ticks, still take damage elsewhere.
    if (this.connectionIssue) {
      this.tickAbilityCharges(tick);
      this.latestInput = null;
      this.selectedInputForTick = null;
      this.velocityX = 0;
      this.velocityZ = 0;
      this.recordPose(tick);
      this.recordTickSelection(tick, null, false);
      return false;
    }

    // Epic 5.2: pin the tick's input at update start. Mid-tick arrivals update
    // latestInput for the *next* tick only; movement steps from this snapshot.
    this.selectedInputForTick = this.latestInput;
    const input = this.selectedInputForTick;
    // Recording snapshot is tick-start (pre edge-consume). consumeWireMovementEdges
    // mutates the live packet so held sequences cannot double-fire jump/melee.
    const recordedInput = input === null ? null : { ...input };
    const arrivalSinceLastStep = this.arrivalSinceLastStep;

    this.tickWeaponSwitch(tick);
    this.tickReload(tick);
    this.tickPump(tick);
    this.tickAbilityCharges(tick);

    const prevX = this.x;
    const prevY = this.y;
    const prevZ = this.z;
    const prevCrouch = this.crouch;

    // Live mobility — shared step (A1/A5). Yaw from authoritative look.
    let moveInput: MoveInput | null = null;
    if (input) {
      moveInput = {
        forward: Boolean(input.forward),
        backward: Boolean(input.backward),
        left: Boolean(input.left),
        right: Boolean(input.right),
        jump: Boolean(input.jump),
        sprint: Boolean(input.sprint),
        crouch: Boolean(input.crouch),
        meleeLunge: Boolean(input.meleeLunge),
        yaw: this.yaw,
      };
    }

    const before: MoveState = {
      x: this.x,
      y: this.y,
      z: this.z,
      velocityY: this.velocityY,
      onGround: this.onGround,
      crouch: this.crouch,
      sprintStamina: this.sprintStamina,
      slideRemaining: this.slideRemaining,
      slideDirX: this.slideDirX,
      slideDirZ: this.slideDirZ,
      slideForceCrouch: this.slideForceCrouch,
      prevInputCrouch: this.prevInputCrouch,
    };

    // Quick (PR2): stall all stamina spend while the window is active.
    const stallStaminaSpend = this.isAbilityActive("quick", tick);

    const { state: after, jumped, meleeLungeStarted } = stepMove(
      before,
      moveInput,
      collision,
      {
        dt: DT,
        weaponMoveMult: this.weapon.moveSpeedMult,
        moveSpeedScale: this.moveSpeedScale *
          hitSlowMoveSpeedScale(this.activeHitSlowStacks(tick)),
        stallStaminaSpend,
      },
    );

    this.x = after.x;
    this.y = after.y;
    this.z = after.z;
    this.velocityY = after.velocityY;
    this.onGround = after.onGround;
    if (!before.onGround && after.onGround) this.lastLandedAtTick = tick;
    this.crouch = after.crouch;
    this.sprintStamina = after.sprintStamina;
    this.slideRemaining = after.slideRemaining;
    this.slideDirX = after.slideDirX;
    this.slideDirZ = after.slideDirZ;
    this.slideForceCrouch = after.slideForceCrouch;
    this.prevInputCrouch = after.prevInputCrouch;

    // A1: track how long the current sequence has been integrated.
    let sequenceChanged = false;
    if (input && typeof input.sequence === "number" && input.sequence > 0) {
      if (input.sequence !== this.appliedSequence) {
        this.appliedSequence = input.sequence;
        this.inputHoldTicks = 1;
        sequenceChanged = true;
      } else {
        this.inputHoldTicks += 1;
      }
    }

    // Jump / melee lunge are one-shot on the held input packet (epic 5.2).
    if (input) {
      consumeWireMovementEdges(input, { jumped, meleeLungeStarted });
    }

    if (obstacles.length > 0) {
      const clip = applyPlayerClip(
        collision,
        {
          id: this.id,
          x: this.x,
          y: this.y,
          z: this.z,
          crouch: this.crouch,
        },
        obstacles,
      );
      this.x = clip.x;
      this.z = clip.z;
      this.lastOverlapOof = clip.inside;
    }

    this.velocityX = (this.x - prevX) / DT;
    this.velocityZ = (this.z - prevZ) / DT;

    this.recordPose(tick);
    this.recordTickSelection(
      tick,
      recordedInput,
      sequenceChanged,
      arrivalSinceLastStep,
    );

    return (
      Math.abs(this.x - prevX) > 1e-6 ||
      Math.abs(this.y - prevY) > 1e-6 ||
      Math.abs(this.z - prevZ) > 1e-6 ||
      this.crouch !== prevCrouch
    );
  }

  /**
   * Per-tick selected input after the last `update` (epic 5.2 → #8.3 handoff).
   * Recording must tap this snapshot, never `latestInput`.
   */
  public lastTickInputSelection(): TickSelectedInput | null {
    return this.lastTickSelection;
  }

  private recordTickSelection(
    tick: number,
    selectedInput: PlayerInput | null,
    sequenceChanged: boolean,
    arrivalSinceLastStep = this.arrivalSinceLastStep,
  ): void {
    const association = classifyTickAssociation({
      alive: this.alive,
      connectionIssue: this.connectionIssue,
      selectedInput,
      arrivalSinceLastStep,
      sequenceChanged,
    });
    this.lastTickSelection = {
      tick,
      playerId: this.id,
      selectedInput,
      association,
      appliedSequence: this.appliedSequence,
      inputHoldTicks: this.inputHoldTicks,
      ...(selectedInput === null && this.lastArrivalInput !== null
        ? { queuedInput: this.lastArrivalInput }
        : {}),
    };
    this.arrivalSinceLastStep = false;
    this.lastArrivalInput = null;
  }
}
