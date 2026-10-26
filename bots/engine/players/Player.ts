import type {
  SkillSnapshot,
  WeaponInventorySnapshot,
} from "../model/index.ts";
import type { WeaponDef } from "../../../shared/sim/weapons.ts";
import {
  isSkillId,
  type SkillId,
} from "../../../shared/sim/skills.ts";
import type { TeamId } from "../shared/network.ts";
import { yawFromWorldDirection } from "../math/index.ts";

/** Structural player view consumed by the portable thought pipeline. */
export interface Player {
  id: string;
  team: TeamId;
  alive: boolean;
  health: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  crouch: boolean;
  onGround: boolean;
  spawnedAtTick: number;
  sprintStamina: number;
  velocityX: number;
  velocityY: number;
  velocityZ: number;
  moveYaw: number | null;
  lastShotAtTick: number;
  isAgent: boolean;
  isBot: boolean;
  matchPlayer: boolean;
  glitchState: "hidden" | "revealed" | "inactive";
  weaponId: number;
  weapon: WeaponDef;
  ammoInMag: number;
  spareClips: number;
  reloading: boolean;
  weapons: readonly WeaponInventorySnapshot[];
  skills: readonly SkillSnapshot[];
  unlimitedAmmo: boolean;
  strength?: number;
}

/** Current horizontal movement yaw used by navigation FOV scoring. */
export function playerMoveYawForFov(player: Player): number | null {
  const authored = player.moveYaw;
  if (typeof authored === "number" && Number.isFinite(authored)) return authored;
  const vx = player.velocityX;
  const vz = player.velocityZ;
  if (vx * vx + vz * vz <= 0.0004) return null;
  return yawFromWorldDirection(vx, vz);
}

/** Magazine rounds for any carried weapon, falling back to the active gun. */
export function playerAmmoInMagFor(
  player: Player,
  requestedWeaponId: number,
): number {
  for (const weapon of player.weapons) {
    if (weapon.id === requestedWeaponId) return weapon.ammoInMagazine;
  }
  return requestedWeaponId === player.weaponId ? player.ammoInMag : 0;
}

/** Spare clips for any carried weapon, falling back to the active gun. */
export function playerSpareClipsFor(
  player: Player,
  requestedWeaponId: number,
): number {
  for (const weapon of player.weapons) {
    if (weapon.id === requestedWeaponId) return weapon.spareClips;
  }
  return requestedWeaponId === player.weaponId ? player.spareClips : 0;
}

/** Equipped, recognized skills from this immutable frame. */
export function playerSnapshotSkillLoadout(
  player: Player,
): readonly (SkillId | null)[] | null {
  const output: (SkillId | null)[] = [];
  for (const skill of player.skills) {
    if (skill.equipped && isSkillId(skill.id)) output.push(skill.id);
  }
  return output.length === 0 ? null : output;
}

/** Authoritative activation gate already resolved into the frame snapshot. */
export function playerCanActivateAbility(
  player: Player,
  skill: SkillId,
  _tick: number,
): boolean {
  for (const item of player.skills) {
    if (item.id === skill) {
      return item.equipped && item.canActivate === true;
    }
  }
  return false;
}

/** Whether a snapshotted skill remains active at the requested tick. */
export function playerIsAbilityActive(
  player: Player,
  skill: SkillId,
  tick: number,
): boolean {
  for (const item of player.skills) {
    if (item.id === skill) {
      return item.activeUntilTick !== null && item.activeUntilTick > tick;
    }
  }
  return false;
}
