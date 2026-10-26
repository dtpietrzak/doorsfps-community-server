import type { PlayerSnapshot } from "../model/index.ts";
import type { Player } from "../players/Player.ts";
import { getWeapon } from "../../../shared/sim/weapons.ts";

/** Plain runtime view over a wire/browser snapshot. No host objects leak in. */
export function runtimePlayer(source: PlayerSnapshot): Player {
  const weaponId = source.weapon.id;
  return {
    id: source.id,
    team: source.team,
    alive: source.alive,
    health: source.health,
    x: source.x,
    y: source.y,
    z: source.z,
    yaw: source.yaw,
    pitch: source.pitch,
    crouch: source.crouch,
    onGround: source.onGround,
    spawnedAtTick: source.spawnedAtTick,
    sprintStamina: source.sprintStamina ?? 0,
    velocityX: source.velocityX,
    velocityY: source.velocityY,
    velocityZ: source.velocityZ,
    moveYaw: source.moveYaw ?? null,
    lastShotAtTick: source.weapon.lastShotTick,
    isAgent: source.kind === "agent",
    isBot: source.kind !== "human",
    matchPlayer: source.matchPlayer === true,
    glitchState: source.glitchState ?? "inactive",
    weaponId,
    weapon: getWeapon(weaponId),
    ammoInMag: source.weapon.ammoInMagazine,
    spareClips: source.weapon.spareClips,
    reloading: source.weapon.reloading,
    weapons: source.weapons ?? [],
    skills: source.skills,
    unlimitedAmmo: source.unlimitedAmmo === true,
    strength: undefined,
  };
}
