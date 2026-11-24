/**
 * Zombie brain target loss: when the prey goes down every zombie moves to
 * the other human, and with nobody standing no one swings.
 */
import { assert, assertEquals } from "@std/assert";
import { PISTOL } from "../../../shared/sim/weapons.ts";
import { ZOMBIE_BOT_CONFIG } from "../../botBrainConfig.ts";
import { MAP_FORMAT_VERSION, type DoorsMap } from "../shared/map.ts";
import type { BotWorldView } from "../types.ts";
import { MapCollision } from "../world/MapCollision.ts";
import {
  zombieLookAt,
  type ZombiePlayerView,
} from "../thoughts/zombie/index.ts";
import { emptyBotBrainState } from "./state.ts";
import { ZombieBrain } from "./zombieBrain.ts";

const MAP: DoorsMap = {
  name: "zombie-open",
  version: MAP_FORMAT_VERSION,
  bounds: { minX: -50, maxX: 50, minZ: -50, maxZ: 50 },
  gridSize: 1,
  walls: [],
  wallCorners: [],
  teamA: { corners: [0, 1], edge: "south", doorHalfWidth: 2, spawnRadius: 4 },
  teamB: { corners: [2, 3], edge: "north", doorHalfWidth: 2, spawnRadius: 4 },
};
const COLLISION = new MapCollision(MAP);

function pawn(
  id: string,
  x: number,
  z: number,
  extra: Partial<ZombiePlayerView> = {},
): ZombiePlayerView {
  return {
    id,
    team: "A",
    alive: true,
    health: 100,
    x,
    y: 1.6,
    z,
    yaw: 0,
    pitch: 0,
    crouch: false,
    onGround: true,
    spawnedAtTick: 0,
    sprintStamina: 1,
    velocityX: 0,
    velocityY: 0,
    velocityZ: 0,
    moveYaw: null,
    lastShotAtTick: 0,
    isAgent: false,
    isBot: false,
    matchPlayer: true,
    glitchState: "inactive",
    weaponId: PISTOL.id,
    weapon: PISTOL,
    ammoInMag: PISTOL.magSize,
    spareClips: PISTOL.totalClips,
    reloading: false,
    weapons: [],
    skills: [],
    unlimitedAmmo: false,
    ...extra,
  };
}

function view(
  tick: number,
  self: ZombiePlayerView,
  players: readonly ZombiePlayerView[],
): BotWorldView {
  return {
    tick,
    self,
    players,
    collision: COLLISION,
    map: MAP,
    doorsOpen: true,
  };
}

Deno.test("target goes down: every zombie retargets the other human, then none swing", () => {
  const near = pawn("near", 0, -6);
  const far = pawn("far", 0, 14);
  // Three zombies at different spots, each with its own brain and state.
  const zombies = [
    pawn("z0", -2, -3, { isBot: true, team: "B" }),
    pawn("z1", 2, -3, { isBot: true, team: "B" }),
    pawn("z2", 0, -4, { isBot: true, team: "B" }),
  ];
  const brains = zombies.map(() =>
    new ZombieBrain(ZOMBIE_BOT_CONFIG, { rng: () => 0.5 })
  );
  const states = zombies.map(() => emptyBotBrainState());
  const players = [...zombies, near, far];
  let tick = 0;
  const thinkAll = () => {
    tick += 3;
    return zombies.map((z, i) => brains[i]!.think(view(tick, z, players), states[i]!));
  };

  thinkAll();
  for (const s of states) assertEquals(s.targetEnemyId, "near");

  near.isDowned = true;
  const after = thinkAll();
  for (let i = 0; i < zombies.length; i++) {
    assertEquals(states[i]!.targetEnemyId, "far");
    assertEquals(after[i]?.shoot === true, false);
  }

  // Everyone down: no target, no swing, even with a body right at their feet
  // and the zombie facing it. Stay quiet for a good while.
  far.isDowned = true;
  for (const z of zombies) {
    z.x = near.x;
    z.z = near.z + 0.6;
    z.yaw = zombieLookAt(z, near).yaw;
  }
  for (let n = 0; n < 20; n++) {
    const actions = thinkAll();
    for (let i = 0; i < zombies.length; i++) {
      assertEquals(states[i]!.targetEnemyId, "");
      const input = actions[i]?.input;
      assert(input !== null && input !== undefined);
      assertEquals(actions[i]?.melee === true, false);
      assertEquals(actions[i]?.shoot === true, false);
      assert(Number.isFinite(input.yaw) && Number.isFinite(input.pitch));
    }
  }
});
