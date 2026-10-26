import { assertAlmostEquals, assertEquals } from "@std/assert";
import { Player } from "../../../players/Player.ts";
import { MapCollision } from "../../../world/MapCollision.ts";
import type { DoorsMap } from "../../../shared/map.ts";
import {
  aimPointHead,
  aimPointOnPlayer,
  clearCombatLosCache,
  pickCombatAimPoint,
} from "../../../helpers/combat.ts";
import {
  botShotStanceOk,
  enemyInShootAimBox,
  inputHorizMoving,
  plantInputForShot,
  SHOOT_AIM_FOV_HALF_ANGLE,
  stepClick,
  weaponReadyForShot,
} from "./click.ts";
import { pitchToward, yawToward } from "../../../helpers/nav.ts";

function tinyMap(): DoorsMap {
  return {
    version: 1,
    name: "ClickTest",
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
    walls: [],
  };
}

Deno.test("SHOOT_AIM_FOV_HALF_ANGLE is 1 degree", () => {
  assertAlmostEquals(SHOOT_AIM_FOV_HALF_ANGLE, Math.PI / 180, 1e-12);
});

Deno.test("enemyInShootAimBox: dead-center hit", () => {
  // Looking −Z at a point further −Z, level pitch.
  assertEquals(
    enemyInShootAimBox(0, 1.6, 0, 0, 0, 0, 1.6, -10),
    true,
  );
});

Deno.test("enemyInShootAimBox: just outside horizontal half-angle", () => {
  const half = SHOOT_AIM_FOV_HALF_ANGLE;
  // Bearing yaw slightly past half from camera yaw 0.
  const bearing = half + 0.02;
  const dist = 10;
  const x = -Math.sin(bearing) * dist;
  const z = -Math.cos(bearing) * dist;
  assertEquals(
    enemyInShootAimBox(0, 1.6, 0, 0, 0, x, 1.6, z),
    false,
  );
});

Deno.test("enemyInShootAimBox: just inside both axes", () => {
  const half = SHOOT_AIM_FOV_HALF_ANGLE;
  const bearing = half * 0.5;
  const dist = 10;
  const x = -Math.sin(bearing) * dist;
  const z = -Math.cos(bearing) * dist;
  // Small pitch offset within box.
  const aimY = 1.6 + Math.tan(half * 0.5) * dist;
  assertEquals(
    enemyInShootAimBox(0, 1.6, 0, 0, 0, x, aimY, z),
    true,
  );
});

Deno.test("enemyInShootAimBox: pitch out of box", () => {
  const half = SHOOT_AIM_FOV_HALF_ANGLE;
  const dist = 10;
  const aimY = 1.6 + Math.tan(half + 0.05) * dist;
  assertEquals(
    enemyInShootAimBox(0, 1.6, 0, 0, 0, 0, aimY, -dist),
    false,
  );
});

Deno.test("stepClick: fires when aimed at hostile torso", () => {
  clearCombatLosCache();
  const collision = new MapCollision(tinyMap());
  const me = new Player("bot:1", "bot1", "A", { isBot: true });
  me.applySpawn({ x: 0, y: 1.6, z: 0, yaw: 0 }, 0);
  me.alive = true;
  const enemy = new Player("e1", "foe", "B");
  enemy.applySpawn({ x: 0, y: 1.6, z: -8, yaw: Math.PI }, 0);
  enemy.alive = true;

  const aim = aimPointOnPlayer(enemy);
  const yaw = yawToward(me.x, me.z, aim.x, aim.z);
  const pitch = pitchToward(me.x, me.y, me.z, aim.x, aim.y, aim.z);

  assertEquals(
    stepClick({
      self: me,
      players: [me, enemy],
      collision,
      yaw,
      pitch,
    }),
    true,
  );
});

Deno.test("stepClick: no fire when look is far off", () => {
  clearCombatLosCache();
  const collision = new MapCollision(tinyMap());
  const me = new Player("bot:1", "bot1", "A", { isBot: true });
  me.applySpawn({ x: 0, y: 1.6, z: 0, yaw: 0 }, 0);
  me.alive = true;
  const enemy = new Player("e1", "foe", "B");
  enemy.applySpawn({ x: 0, y: 1.6, z: -8, yaw: Math.PI }, 0);
  enemy.alive = true;

  // Looking opposite direction.
  assertEquals(
    stepClick({
      self: me,
      players: [me, enemy],
      collision,
      yaw: Math.PI,
      pitch: 0,
    }),
    false,
  );
});

Deno.test("stepClick: wider halfAngle fires with larger aim error", () => {
  clearCombatLosCache();
  const collision = new MapCollision(tinyMap());
  const me = new Player("bot:1", "bot1", "A", { isBot: true });
  me.applySpawn({ x: 0, y: 1.6, z: 0, yaw: 0 }, 0);
  me.alive = true;
  const enemy = new Player("e1", "foe", "B");
  enemy.applySpawn({ x: 0, y: 1.6, z: -8, yaw: Math.PI }, 0);
  enemy.alive = true;

  const aim = aimPointOnPlayer(enemy);
  const bearing = yawToward(me.x, me.z, aim.x, aim.z);
  const pitch = pitchToward(me.x, me.y, me.z, aim.x, aim.y, aim.z);
  // ~2° off bearing — inside 3° box, outside 1° box.
  const yaw = bearing + (2 * Math.PI) / 180;

  assertEquals(
    stepClick({
      self: me,
      players: [me, enemy],
      collision,
      yaw,
      pitch,
      halfAngle: (1 * Math.PI) / 180,
    }),
    false,
  );
  assertEquals(
    stepClick({
      self: me,
      players: [me, enemy],
      collision,
      yaw,
      pitch,
      halfAngle: (3 * Math.PI) / 180,
    }),
    true,
  );
});

Deno.test("stepClick: no fire on teammate in box", () => {
  clearCombatLosCache();
  const collision = new MapCollision(tinyMap());
  const me = new Player("bot:1", "bot1", "A", { isBot: true });
  me.applySpawn({ x: 0, y: 1.6, z: 0, yaw: 0 }, 0);
  me.alive = true;
  const ally = new Player("a1", "ally", "A");
  ally.applySpawn({ x: 0, y: 1.6, z: -8, yaw: Math.PI }, 0);
  ally.alive = true;

  const aim = aimPointOnPlayer(ally);
  const yaw = yawToward(me.x, me.z, aim.x, aim.z);
  const pitch = pitchToward(me.x, me.y, me.z, aim.x, aim.y, aim.z);

  assertEquals(
    stepClick({
      self: me,
      players: [me, ally],
      collision,
      yaw,
      pitch,
    }),
    false,
  );
});

function halfWallMap(): DoorsMap {
  return {
    ...tinyMap(),
    name: "ClickHalfWall",
    walls: [
      {
        id: "half",
        kind: "half",
        a: { x: -15, z: 0 },
        b: { x: 15, z: 0 },
      },
    ],
  };
}

Deno.test("stepClick: fires at standing hostile behind half wall", () => {
  clearCombatLosCache();
  const collision = new MapCollision(halfWallMap());
  const me = new Player("bot:half", "bot1", "A", { isBot: true });
  me.applySpawn({ x: 0, y: 1.7, z: -8, yaw: Math.PI }, 0);
  me.alive = true;
  const enemy = new Player("e:half", "foe", "B");
  enemy.applySpawn({ x: 0, y: 1.7, z: 1, yaw: 0 }, 0);
  enemy.alive = true;

  const eye = { x: me.x, y: me.y, z: me.z };
  const aim = pickCombatAimPoint(collision, eye, enemy);
  assertEquals(aim !== null, true);
  const yaw = yawToward(me.x, me.z, aim!.x, aim!.z);
  const pitch = pitchToward(me.x, me.y, me.z, aim!.x, aim!.y, aim!.z);

  assertEquals(
    stepClick({
      self: me,
      players: [me, enemy],
      collision,
      yaw,
      pitch,
    }),
    true,
  );
});

Deno.test("stepClick: preferAimHeight head matches head reticle (not torso-only box)", () => {
  clearCombatLosCache();
  const collision = new MapCollision(tinyMap());
  const me = new Player("bot:1", "bot1", "A", { isBot: true });
  me.applySpawn({ x: 0, y: 1.7, z: 0, yaw: 0 }, 0);
  me.alive = true;
  const enemy = new Player("e1", "foe", "B");
  enemy.applySpawn({ x: 0, y: 1.7, z: -12, yaw: Math.PI }, 0);
  enemy.alive = true;

  const head = aimPointHead(enemy);
  const torso = aimPointOnPlayer(enemy);
  const headYaw = yawToward(me.x, me.z, head.x, head.z);
  const headPitch = pitchToward(me.x, me.y, me.z, head.x, head.y, head.z);
  // Tight 1° box: looking at head misses torso aim point.
  assertEquals(
    stepClick({
      self: me,
      players: [me, enemy],
      collision,
      yaw: headYaw,
      pitch: headPitch,
      preferredEnemyId: "e1",
      halfAngle: SHOOT_AIM_FOV_HALF_ANGLE,
      targetEnemyState: { targetEnemyId: "e1" },
    }),
    false,
  );
  // Same look with head preference → fire.
  assertEquals(
    stepClick({
      self: me,
      players: [me, enemy],
      collision,
      yaw: headYaw,
      pitch: headPitch,
      preferredEnemyId: "e1",
      halfAngle: SHOOT_AIM_FOV_HALF_ANGLE,
      targetEnemyState: { targetEnemyId: "e1" },
      preferAimHeight: "head",
    }),
    true,
  );
  // Sanity: torso height still works with torso preference.
  const torsoYaw = yawToward(me.x, me.z, torso.x, torso.z);
  const torsoPitch = pitchToward(
    me.x,
    me.y,
    me.z,
    torso.x,
    torso.y,
    torso.z,
  );
  assertEquals(
    stepClick({
      self: me,
      players: [me, enemy],
      collision,
      yaw: torsoYaw,
      pitch: torsoPitch,
      preferredEnemyId: "e1",
      halfAngle: SHOOT_AIM_FOV_HALF_ANGLE,
      targetEnemyState: { targetEnemyId: "e1" },
      preferAimHeight: "torso",
    }),
    true,
  );
});

Deno.test("stepClick: preferred lock uses targetEnemy lead aim", () => {
  clearCombatLosCache();
  const collision = new MapCollision(tinyMap());
  const me = new Player("bot:1", "bot1", "A", { isBot: true });
  me.applySpawn({ x: 0, y: 1.6, z: 0, yaw: 0 }, 0);
  me.alive = true;
  const enemy = new Player("e1", "foe", "B");
  enemy.applySpawn({ x: 0, y: 1.6, z: -8, yaw: Math.PI }, 0);
  enemy.alive = true;

  const liveAim = aimPointOnPlayer(enemy);
  const liveYaw = yawToward(me.x, me.z, liveAim.x, liveAim.z);
  const livePitch = pitchToward(
    me.x,
    me.y,
    me.z,
    liveAim.x,
    liveAim.y,
    liveAim.z,
  );

  // Camera pointed at lead position (vx=6 → +0.9u over 0.15s).
  const leadX = 6 * 0.15;
  const leadYaw = yawToward(me.x, me.z, liveAim.x + leadX, liveAim.z);
  const leadPitch = pitchToward(
    me.x,
    me.y,
    me.z,
    liveAim.x + leadX,
    liveAim.y,
    liveAim.z,
  );

  // Hard 1° box: looking at lead misses live body without lead-aware click.
  assertEquals(
    stepClick({
      self: me,
      players: [me, enemy],
      collision,
      yaw: leadYaw,
      pitch: leadPitch,
      preferredEnemyId: "e1",
      halfAngle: SHOOT_AIM_FOV_HALF_ANGLE,
    }),
    false,
  );

  // With sticky velocity bag, preferred lock uses same lead → fire.
  assertEquals(
    stepClick({
      self: me,
      players: [me, enemy],
      collision,
      yaw: leadYaw,
      pitch: leadPitch,
      preferredEnemyId: "e1",
      halfAngle: SHOOT_AIM_FOV_HALF_ANGLE,
      targetEnemyState: {
        targetEnemyId: "e1",
        targetEnemyVx: 6,
        targetEnemyVz: 0,
        targetEnemyVy: 0,
      },
    }),
    true,
  );

  // Looking at live body still works without lead bag.
  assertEquals(
    stepClick({
      self: me,
      players: [me, enemy],
      collision,
      yaw: liveYaw,
      pitch: livePitch,
      preferredEnemyId: "e1",
    }),
    true,
  );
});

Deno.test("botShotStanceOk: plant / crouch / Hawkeyes allow the shot", () => {
  const still = {
    forward: false,
    backward: false,
    left: false,
    right: false,
    crouch: false,
  };
  const adad = { ...still, left: true };
  const crouched = { ...adad, crouch: true };
  assertEquals(inputHorizMoving(adad), true);
  assertEquals(botShotStanceOk(still, false), true);
  assertEquals(botShotStanceOk(adad, false), false);
  assertEquals(botShotStanceOk(crouched, false), true);
  assertEquals(botShotStanceOk(adad, true), true);
});

Deno.test("plantInputForShot: zeros WASD + sprint, leaves crouch alone", () => {
  const planted = plantInputForShot({
    sequence: 3,
    forward: true,
    backward: false,
    left: true,
    right: false,
    jump: false,
    sprint: true,
    crouch: false,
    yaw: 0.2,
    pitch: -0.1,
  });
  assertEquals(planted.forward, false);
  assertEquals(planted.left, false);
  assertEquals(planted.sprint, false);
  assertEquals(planted.crouch, false);
  assertEquals(planted.yaw, 0.2);
  assertEquals(planted.jump, false);
  const ducked = plantInputForShot({
    sequence: 4,
    forward: true,
    backward: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
    crouch: true,
    yaw: 0,
    pitch: 0,
  });
  assertEquals(ducked.crouch, true);
});

Deno.test("weaponReadyForShot: first shot and after cooldown", () => {
  assertEquals(weaponReadyForShot(Number.NEGATIVE_INFINITY, 10, 750), true);
  assertEquals(weaponReadyForShot(0, 1, 750), false);
  assertEquals(weaponReadyForShot(0, 1000, 750), true);
});
