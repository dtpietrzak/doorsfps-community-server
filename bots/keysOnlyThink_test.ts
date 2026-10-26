/**
 * Bot-think behavior that replaced server movement assists
 * (the keys-only note PR 1). `bots/thoughts/` tests are excluded
 * from `deno task test`, so these live here.
 *
 * Run from server-community/:
 *   deno test -A --node-modules-dir=manual bots/keysOnlyThink_test.ts
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import type { DoorsMap } from "../world/map.ts";
import { MapCollision } from "./engine/world/MapCollision.ts";
import type { Player } from "./engine/players/Player.ts";
import { getWeapon } from "../shared/sim/weapons.ts";
import { slideStaminaCostSeconds } from "../protocol/network.ts";
import {
  canSlideFromStamina,
  findFloatExitYaw,
  FLOAT_WALL_DUCK_COMMIT_TICKS,
  FLOAT_WALL_DUCK_CRAWL_TIME_SCALE,
  floatWallDuckTimeScale,
  stepFloatWallDuck,
} from "@doors/bot-engine/thoughts/floatWallDuck/helpers/floatWallDuck.ts";
import { yawAbsDelta } from "@doors/bot-engine/thoughts/halfWallVault/helpers/halfWallVault.ts";
import { clearCombatLosCache } from "./engine/helpers/combat.ts";
import {
  stepTargetEnemy,
  TARGET_ENEMY_STATE_KEY,
} from "@doors/bot-engine/thoughts/targetEnemy/helpers/targetEnemy.ts";

function mapWith(walls: DoorsMap["walls"]): DoorsMap {
  return {
    version: 1,
    name: "KeysOnlyThink",
    bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 },
    gridSize: 1,
    teamA: {
      corners: [0, 1],
      edge: "south",
      doorHalfWidth: 2.5,
      spawnRadius: 3,
    },
    teamB: {
      corners: [2, 3],
      edge: "north",
      doorHalfWidth: 2.5,
      spawnRadius: 3,
    },
    walls,
  };
}

Deno.test("canSlideFromStamina mirrors the sim slide gate", () => {
  const cost = slideStaminaCostSeconds();
  assertEquals(canSlideFromStamina(cost), true);
  assertEquals(canSlideFromStamina(cost - 1e-6), false);
  assertEquals(floatWallDuckTimeScale(cost), 1);
  assertEquals(floatWallDuckTimeScale(0), FLOAT_WALL_DUCK_CRAWL_TIME_SCALE);
});

Deno.test("stepFloatWallDuck: crouch-walk commit lasts longer than a slide commit", () => {
  const col = new MapCollision(
    mapWith([{
      id: "f1",
      kind: "float",
      a: { x: -6, z: 0 },
      b: { x: 6, z: 0 },
    }]),
  );
  const at = (sprintStamina: number) =>
    stepFloatWallDuck({
      x: 0,
      // Inside the tired (1u) probe so both stamina levels trigger.
      z: -0.8,
      desiredYaw: Math.PI,
      sprintStamina,
      vaultActive: false,
      collision: col,
      simDelta: 1,
      state: {},
    });
  const slide = at(slideStaminaCostSeconds());
  const crawl = at(0);
  assertEquals(slide.active, true);
  assertEquals(crawl.active, true);
  assertEquals(
    slide.statePatch.floatWallDuckTicksLeft,
    FLOAT_WALL_DUCK_COMMIT_TICKS,
  );
  assertEquals(
    crawl.statePatch.floatWallDuckTicksLeft,
    FLOAT_WALL_DUCK_COMMIT_TICKS * FLOAT_WALL_DUCK_CRAWL_TIME_SCALE,
  );
});

Deno.test("findFloatExitYaw forwardOnly keeps a Crossroads + crawl moving along the path", () => {
  const raw = Deno.readTextFileSync(
    new URL("../maps/competitive/Crossroads.doors.json", import.meta.url),
  );
  const col = new MapCollision(JSON.parse(raw) as DoorsMap);
  // Under the + center heading south-west; shortest standing exit is back north.
  const x = 0.34;
  const z = 0.05;
  const preferred = 0.35;
  const forward = findFloatExitYaw(col, x, z, preferred, undefined, true);
  assert(
    yawAbsDelta(forward, preferred) <= Math.PI / 2 + 1e-6,
    `forward exit ${forward} should stay within 90° of path ${preferred}`,
  );
});

function makeBot(
  id: string,
  team: "A" | "B",
  x: number,
  z: number,
  yaw: number,
): Player {
  return {
    id,
    team,
    alive: true,
    health: 100,
    x,
    y: 1.6,
    z,
    yaw,
    pitch: 0,
    crouch: false,
    onGround: true,
    spawnedAtTick: -10_000,
    sprintStamina: 1,
    velocityX: 0,
    velocityY: 0,
    velocityZ: 0,
    moveYaw: null,
    lastShotAtTick: -10_000,
    isAgent: false,
    isBot: true,
    matchPlayer: true,
    glitchState: "inactive",
    weaponId: 0,
    weapon: getWeapon(0),
    ammoInMag: 12,
    spareClips: 3,
    reloading: false,
    weapons: [],
    skills: [],
    unlimitedAmmo: false,
  };
}

Deno.test("stepTargetEnemy: sticky lock holds on intended look while body yaw lags", () => {
  clearCombatLosCache();
  const col = new MapCollision(mapWith([]));
  // Body faces −z (yaw 0); foe is directly behind at +z.
  const me = makeBot("bot:1", "A", 0, 0, 0);
  const enemy = makeBot("enemy:1", "B", 0, 8, 0);
  const sticky = { [TARGET_ENEMY_STATE_KEY]: "enemy:1" };
  const base = {
    self: me,
    players: [me, enemy],
    collision: col,
    worldMoveYaw: 0,
  };

  assertEquals(stepTargetEnemy({ ...base, state: { ...sticky } }).combat, null);

  const held = stepTargetEnemy({
    ...base,
    state: { ...sticky },
    holdIntentYaw: Math.PI,
  });
  assertExists(held.combat);
  assertEquals(held.combat.enemyId, "enemy:1");

  // Intent only extends an existing lock; it never acquires a new one.
  assertEquals(
    stepTargetEnemy({ ...base, state: {}, holdIntentYaw: Math.PI }).combat,
    null,
  );
});
