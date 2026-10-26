/**
 * Epic 9.1 — authoritative checkpoint state definition.
 *
 * One versioned, resume-sufficient shape for a tick-boundary capture. Reads
 * simulation owners directly (never `toSnapshot` / `createSnapshot` /
 * quantizers). Pure builder: no timer, no schedule, no store / file I/O.
 *
 * Contract (see notes/replay/09-replay-state-checkpoints/09-01-checkpoint-state-definition.md):
 * - Self-contained dynamic state + static anchor (map / seed / runtimeMatchId).
 * - Full float precision; deep-frozen return.
 * - Post-update / post-drain only — non-empty drain buffer fails loud.
 * - Static beyond the anchor lives in 8.2 `RecordedInitialState` via runtimeMatchId.
 * - 9.2 owns when to call; 9.3 owns load/resume; this module owns shape + read.
 */

import type { AuthoritativeMapIdentity } from "../shared/sim/authoritativeEvent.ts";
import type { PlayerEquipment } from "../shared/sim/game.ts";
import type { SkillId, SkillLoadout, SkillProductId } from "../shared/sim/skills.ts";
import {
  getWeapon,
  shellReloadOf,
  WEAPON_ORDER,
} from "../shared/sim/weapons.ts";
import type {
  SnapshotProjectile,
  TeamId,
  TeamScores,
} from "../protocol/network.ts";
import { equipmentFromPlayer } from "../players/authoritativeEventDerive.ts";
import type { Player } from "../players/Player.ts";
import type { PlayerManager } from "../players/PlayerManager.ts";
import { deepFreeze } from "./recordedInitialState.ts";

/** Bump on shape changes (#14 owns compatibility policy). */
export const CHECKPOINT_SCHEMA_VERSION = 1 as const;

/** Opaque xorshift32 cursor words for the five resume streams. */
export type CheckpointRngCursors = {
  readonly damage: number;
  readonly spread: number;
  readonly spawn: number;
  readonly agents: number;
  /** Collision spawn stream (often same closure as `spawn`, recorded separately). */
  readonly collisionSpawn: number;
};

/**
 * Dynamic `RaidMatch` fields that change mid-match (`GameServer.stepSimBody`
 * mutates wave/started/ended/failReason via `tickRaidAgentEncounter` /
 * `handleRaidScores` / `handleRaidFailConditions`). Static raid identity
 * (raidId/humanTeam/goal/...) lives in `RecordedInitialState`'s metadata, not
 * here — it never changes mid-match. `{ active: false }` off-raid, never
 * `null` (see `shared/replay/matchMetadata.ts` `RaidMatchMetadataState`).
 * See notes/replay.md §29.2 item 2.
 */
export type CheckpointRaidState =
  | { readonly active: false }
  | {
    readonly active: true;
    readonly wave: number;
    readonly started: boolean;
    readonly ended: boolean;
    readonly expectedHumans: number;
    readonly failReason: "wipe" | "enemy_capture" | "empty" | "timeout" | null;
  };

export type CheckpointMatchState = {
  readonly scores: TeamScores;
  readonly matchOver: boolean;
  readonly inPrematch: boolean;
  readonly restartAtTick: number | null;
  readonly doorCycleOriginTick: number;
  readonly doorsPowerUpUntilTick: number | null;
  readonly raidDoorPolicy: "off" | "idle" | "open";
  readonly debugForceDoorsOpen: boolean;
  readonly matchEndTick: number;
  readonly matchDurationTicks: number;
  readonly raid: CheckpointRaidState;
};

export type CheckpointWeaponLoadout = {
  readonly weaponId: number;
  readonly ammoInMag: number;
  /** Spare magazines, or spare shells for a shell gun. */
  readonly spareClips: number;
  /**
   * Shell guns only (omitted for mag guns, which are always cocked). Absent in
   * pre-shotgun checkpoints; restore treats absent as true.
   */
  readonly chambered?: boolean;
};

export type CheckpointAbilityFxOrigin = {
  readonly x: number;
  readonly y: number;
  readonly z: number;
};

/** One lag-comp pose sample (verbatim `Player` pose ring slot). */
export type CheckpointPoseSample = {
  readonly tick: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly crouch: boolean;
  readonly slide: boolean;
  readonly yaw: number;
  readonly pitch: number;
  readonly velocityX: number;
  readonly velocityY: number;
  readonly velocityZ: number;
  readonly onGround: boolean;
  readonly landingAmount: number;
};

export type CheckpointPlayerState = {
  readonly id: string;
  readonly team: TeamId;
  /** Raid-bot role (sim-relevant), not "AI-controlled" — see the keys-only note. */
  readonly isBot: boolean;
  readonly isAgent: boolean;
  // Motion — full floats, never quantized.
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly pitch: number;
  readonly velocityX: number;
  readonly velocityY: number;
  readonly velocityZ: number;
  readonly onGround: boolean;
  readonly crouch: boolean;
  readonly sprintStamina: number;
  readonly slideRemaining: number;
  readonly slideDirX: number;
  readonly slideDirZ: number;
  readonly slideForceCrouch: boolean;
  /**
   * Previous step's crouch key (moveStep rising-edge slide detect). Without it
   * a player holding crouch across a checkpoint "presses" crouch on resume and
   * starts a slide live never had.
   */
  readonly prevInputCrouch: boolean;
  /** Last ground landing tick (landing pose in lag-comp hit volumes); null = none. */
  readonly lastLandedAtTick: number | null;
  /**
   * Recent pose ring, oldest first (`Player.checkpointPoseHistory`): lag-comp
   * rewinds and the Rewind skill read it right after a resume.
   */
  readonly poseHistory: readonly CheckpointPoseSample[];
  // Health / lifecycle.
  readonly health: number;
  readonly maxHealth: number;
  readonly alive: boolean;
  readonly spawnedAtTick: number;
  /** Null while alive; sim tick of death while dead (respawn gate). */
  readonly diedAtTick: number | null;
  /** Null when not dwelling on an enemy door for capture. */
  readonly enemyDoorSinceTick: number | null;
  readonly hitSlowStacks: number;
  readonly hitSlowEndsAtTick: number;
  // Weapons.
  readonly weaponId: number;
  readonly weaponLoadouts: readonly CheckpointWeaponLoadout[];
  readonly reloadEndsAtTick: number | null;
  readonly weaponSwitchEndsAtTick: number | null;
  /** Fire cooldown anchor (`canShoot`); null = never fired. */
  readonly lastShotAtTick: number | null;
  /** Melee cooldown anchor (`canMelee`); null = never swung. */
  readonly lastMeleeAtTick: number | null;
  readonly pausedReloadRemainingTicks: Readonly<Record<number, number>>;
  /**
   * Shell guns: next shell-insert tick while loading. Omitted when null, so
   * checkpoints without a shell gun keep their pre-shotgun shape.
   */
  readonly shellReloadNextAtTick?: number;
  /** Shell guns: pump end tick while cocking. Omitted when null. */
  readonly pumpEndsAtTick?: number;
  readonly unlimitedAmmo: boolean;
  // Abilities / charge locks.
  readonly abilityEndsAtTick: Readonly<Partial<Record<SkillId, number>>>;
  readonly abilityFxOrigin: Readonly<
    Partial<Record<SkillId, CheckpointAbilityFxOrigin>>
  >;
  readonly abilitySpent: Readonly<Partial<Record<SkillId, true>>>;
  readonly abilityGlobalLockEndsAtTick: number | null;
  readonly abilityBarRegenEndsAtTick: number | null;
  readonly abilityDoorRegenEndsAtTick: number | null;
  readonly abilityNoSpendOnEnd: Readonly<Partial<Record<SkillId, true>>>;
  // Dynamic loadout (mid-match mutable despite 8.2 roster presence).
  readonly equipment: PlayerEquipment;
  readonly skillLoadout: SkillLoadout | null;
  readonly ownedAbilities: readonly SkillProductId[] | null;
  // Scoring.
  readonly score: number;
  readonly kills: number;
  readonly deaths: number;
  readonly xp: number;
};

/**
 * Resume-sufficient authoritative state at one tick boundary.
 * Chained to 8.2 init via `runtimeMatchId` for static identity beyond the anchor.
 */
export type AuthoritativeCheckpoint = {
  readonly schemaVersion: typeof CHECKPOINT_SCHEMA_VERSION;
  readonly tick: number;
  readonly runtimeMatchId: string;
  readonly map: AuthoritativeMapIdentity;
  readonly matchSeed: number;
  readonly rng: CheckpointRngCursors;
  readonly match: CheckpointMatchState;
  readonly players: readonly CheckpointPlayerState[];
  /**
   * Hitscan-only today — always empty. Element type reserved so the first
   * real projectile sim extends without a breaking schema rename (Decision 5).
   */
  readonly projectiles: readonly SnapshotProjectile[];
};

function cloneAbilityFxOrigin(
  src: Player["abilityFxOrigin"],
): Partial<Record<SkillId, CheckpointAbilityFxOrigin>> {
  const out: Partial<Record<SkillId, CheckpointAbilityFxOrigin>> = {};
  for (const id of Object.keys(src) as SkillId[]) {
    const from = src[id];
    if (!from) continue;
    out[id] = { x: from.x, y: from.y, z: from.z };
  }
  return out;
}

/** `-Infinity` "never" sentinels are not JSON-safe; checkpoints carry null. */
function finiteTickOrNull(tick: number): number | null {
  return Number.isFinite(tick) ? tick : null;
}

function capturePlayerState(player: Player): CheckpointPlayerState {
  const weaponLoadouts: CheckpointWeaponLoadout[] = WEAPON_ORDER.map(
    (weaponId) => ({
      weaponId,
      ammoInMag: player.ammoInMagFor(weaponId),
      spareClips: player.spareClipsFor(weaponId),
      ...(shellReloadOf(getWeapon(weaponId))
        ? { chambered: player.chamberedFor(weaponId) }
        : {}),
    }),
  );

  return {
    id: player.id,
    team: player.team,
    // Roster/checkpoint `isBot` is the raid-bot role — see rosterSnapshotFromPlayer.
    isBot: player.isRaidBot,
    isAgent: player.isAgent,
    x: player.x,
    y: player.y,
    z: player.z,
    yaw: player.yaw,
    pitch: player.pitch,
    velocityX: player.velocityX,
    velocityY: player.velocityY,
    velocityZ: player.velocityZ,
    onGround: player.onGround,
    crouch: player.crouch,
    sprintStamina: player.sprintStamina,
    slideRemaining: player.slideRemaining,
    slideDirX: player.slideDirX,
    slideDirZ: player.slideDirZ,
    slideForceCrouch: player.slideForceCrouch,
    prevInputCrouch: player.previousInputCrouch,
    lastLandedAtTick: player.lastLandedTick,
    poseHistory: player.checkpointPoseHistory(),
    health: player.health,
    maxHealth: player.maxHealth,
    alive: player.alive,
    spawnedAtTick: player.spawnedAtTick,
    diedAtTick: player.diedAtTick,
    enemyDoorSinceTick: player.enemyDoorSinceTick,
    hitSlowStacks: player.getHitSlowStacks(),
    hitSlowEndsAtTick: player.getHitSlowEndsAtTick(),
    weaponId: player.weaponId,
    weaponLoadouts,
    reloadEndsAtTick: player.reloadEndsAtTick,
    weaponSwitchEndsAtTick: player.weaponSwitchEndsAtTick,
    lastShotAtTick: finiteTickOrNull(player.lastShotAtTick),
    lastMeleeAtTick: finiteTickOrNull(player.lastMeleeAtTick),
    pausedReloadRemainingTicks: player.snapshotPausedReloadRemainingTicks(),
    ...(player.shellReloadNextAtTick !== null
      ? { shellReloadNextAtTick: player.shellReloadNextAtTick }
      : {}),
    ...(player.pumpEndsAtTick !== null
      ? { pumpEndsAtTick: player.pumpEndsAtTick }
      : {}),
    unlimitedAmmo: player.unlimitedAmmo,
    abilityEndsAtTick: { ...player.abilityEndsAtTick },
    abilityFxOrigin: cloneAbilityFxOrigin(player.abilityFxOrigin),
    abilitySpent: { ...player.abilitySpent },
    abilityGlobalLockEndsAtTick: player.abilityGlobalLockEndsAtTick,
    abilityBarRegenEndsAtTick: player.abilityBarRegenEndsAtTick,
    abilityDoorRegenEndsAtTick: player.abilityDoorRegenEndsAtTick,
    abilityNoSpendOnEnd: player.snapshotAbilityNoSpendOnEnd(),
    equipment: equipmentFromPlayer(player),
    skillLoadout: player.snapshotSkillLoadout(),
    ownedAbilities: player.snapshotOwnedAbilities(),
    score: player.score,
    kills: player.kills,
    deaths: player.deaths,
    xp: player.xp,
  };
}

/**
 * Pure single-tick checkpoint builder (9.1).
 *
 * Must run post-update / post-drain at tick T: a non-empty authoritative-event
 * buffer means the tap left the tick boundary and fails loud.
 * Returns a deep-frozen object; never mutates sim state.
 */
export function captureCheckpointState(
  players: PlayerManager,
  tick: number,
  runtimeMatchId: string,
  raid: CheckpointRaidState = { active: false },
  opts?: {
    /**
     * Recording-start capture (8.2 `startCheckpoint`) runs mid-tick beside the
     * init read. Pending events there are facts already applied to state and
     * are recorded at `appliedTick <= captureTick`, which playback skips.
     */
    readonly allowPendingEvents?: boolean;
  },
): AuthoritativeCheckpoint {
  if (typeof runtimeMatchId !== "string" || runtimeMatchId.length === 0) {
    throw new Error("captureCheckpointState: runtimeMatchId required");
  }
  if (!Number.isFinite(tick)) {
    throw new Error("captureCheckpointState: tick must be finite");
  }

  const pending = players.peekAuthoritativeEvents();
  if (pending.length > 0 && !opts?.allowPendingEvents) {
    throw new Error(
      `captureCheckpointState: drain buffer not empty at tick ${tick} ` +
        `(${pending.length} event(s)) — capture must run post-drain`,
    );
  }

  const map = players.getCollision().map;
  const streams = players.getSimRngStreams();
  const collision = players.getCollision();

  const checkpoint: AuthoritativeCheckpoint = {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    tick,
    runtimeMatchId,
    map: { name: map.name, version: map.version },
    matchSeed: players.getMatchSeed(),
    rng: {
      damage: streams.damage.getState(),
      spread: streams.spread.getState(),
      spawn: streams.spawn.getState(),
      agents: streams.agents.getState(),
      collisionSpawn: collision.getSpawnRngState(),
    },
    match: {
      scores: players.getScores(),
      matchOver: players.isMatchOver(),
      inPrematch: players.getInPrematchFlag(),
      restartAtTick: players.getRestartAtTick(),
      doorCycleOriginTick: players.getDoorCycleOriginTick(),
      doorsPowerUpUntilTick: players.getDoorsPowerUpUntilTick(),
      raidDoorPolicy: players.getRaidDoorPolicy(),
      debugForceDoorsOpen: players.getDebugForceDoorsOpen(),
      matchEndTick: players.getMatchClockState().matchEndTick,
      matchDurationTicks: players.getMatchDurationTicks(),
      raid,
    },
    players: players.allCached().map(capturePlayerState),
    projectiles: [],
  };

  return deepFreeze(structuredClone(checkpoint)) as AuthoritativeCheckpoint;
}
