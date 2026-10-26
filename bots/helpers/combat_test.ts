import { assert, assertEquals, assertExists } from "jsr:@std/assert@1";
import {
  beginCombatLosCacheEpoch,
  botThinksOnSimPhase,
  botWorkSlot,
  canSensePlayer,
  clearCombatLosCache,
  hasLineOfSight,
  isHiddenByGlitch,
  isUnarmedForCombat,
  wantsBotReload,
  botWeaponPreferenceForRange,
  pickBotWeaponSwitch,
  pickCombatAimPoint,
  shouldRunExpensiveNavProbes,
} from "./combat.ts";
import { botTickPhase, botTickToSimTick } from "../types.ts";
import { Player } from "../../players/Player.ts";
import { MapCollision } from "../../world/MapCollision.ts";
import type { DoorsMap } from "../../world/map.ts";
import {
  WEAPON_PISTOL,
  WEAPON_RIFLE,
  WEAPON_SHOTGUN,
} from "../../shared/sim/weapons.ts";
import { SIM_TICKS_PER_BOT_TICK } from "../types.ts";

const openMap: DoorsMap = {
  name: "open",
  version: 1,
  bounds: { minX: -50, maxX: 50, minZ: -50, maxZ: 50 },
  gridSize: 1,
  walls: [],
  teamA: {
    corners: [0, 1],
    edge: "south",
    doorHalfWidth: 2,
    spawnRadius: 4,
  },
  teamB: {
    corners: [2, 3],
    edge: "north",
    doorHalfWidth: 2,
    spawnRadius: 4,
  },
};

/** Full bar wall across z=0 — nothing should sense through it. */
const wallMap: DoorsMap = {
  ...openMap,
  name: "full-wall",
  walls: [
    {
      id: "bar",
      kind: "full",
      a: { x: -20, z: 0 },
      b: { x: 20, z: 0 },
    },
  ],
};

/** Half bar across z=0 — standing peekable; crouch cover. */
const halfWallMap: DoorsMap = {
  ...openMap,
  name: "half-wall",
  walls: [
    {
      id: "half",
      kind: "half",
      a: { x: -20, z: 0 },
      b: { x: 20, z: 0 },
    },
  ],
};

function makePlayers(): { self: Player; enemy: Player } {
  const self = new Player("bot:1", "bot1", "A", {
    isBot: true,
    spawn: { x: 0, y: 1.7, z: 5 },
  });
  const enemy = new Player("enemy", "e1", "B", {
    spawn: { x: 0, y: 1.7, z: 0 },
  });
  return { self, enemy };
}

function drainActiveMag(p: Player): void {
  while (p.ammoInMag > 0) p.markShot(0);
}

Deno.test("pickBotWeaponSwitch: empty pistol → rifle when rifle has rounds", () => {
  const { self } = makePlayers();
  assertEquals(self.weaponId, WEAPON_PISTOL);
  assertEquals(pickBotWeaponSwitch(self), null);
  drainActiveMag(self);
  assertEquals(pickBotWeaponSwitch(self), WEAPON_RIFLE);
});

Deno.test("pickBotWeaponSwitch: empty rifle → pistol when pistol has rounds", () => {
  const { self } = makePlayers();
  assertEquals(self.trySwitchWeapon(WEAPON_RIFLE, 0), true);
  drainActiveMag(self);
  assertEquals(pickBotWeaponSwitch(self), WEAPON_PISTOL);
});

Deno.test("pickBotWeaponSwitch: close lock prefers loaded shotgun", () => {
  const { self } = makePlayers();
  assertEquals(self.weaponId, WEAPON_PISTOL);
  assertEquals(self.trySwitchWeapon(WEAPON_RIFLE, 0), true);
  assertEquals(pickBotWeaponSwitch(self, { lockDist: 5 }), WEAPON_SHOTGUN);
  assertEquals(pickBotWeaponSwitch(self, { lockDist: 14 }), WEAPON_PISTOL);
  assertEquals(pickBotWeaponSwitch(self, { lockDist: 20 }), null);
});

Deno.test("pickBotWeaponSwitch: empty shotgun at close range → pistol", () => {
  const { self } = makePlayers();
  assertEquals(self.trySwitchWeapon(WEAPON_SHOTGUN, 0), true);
  drainActiveMag(self);
  assertEquals(self.trySwitchWeapon(WEAPON_RIFLE, 100), true);
  assertEquals(pickBotWeaponSwitch(self, { lockDist: 5 }), WEAPON_PISTOL);
});

Deno.test("botWeaponPreferenceForRange: edges lean toward the gun in hand", () => {
  assertEquals(botWeaponPreferenceForRange(11, WEAPON_SHOTGUN)[0], WEAPON_SHOTGUN);
  assertEquals(botWeaponPreferenceForRange(11, WEAPON_PISTOL)[0], WEAPON_PISTOL);
  assertEquals(botWeaponPreferenceForRange(19, WEAPON_RIFLE)[0], WEAPON_RIFLE);
  assertEquals(botWeaponPreferenceForRange(19, WEAPON_PISTOL)[0], WEAPON_PISTOL);
  assertEquals(botWeaponPreferenceForRange(30, WEAPON_PISTOL)[0], WEAPON_RIFLE);
});

Deno.test("wantsBotReload: idle tops up a shotgun tube with room", () => {
  const { self } = makePlayers();
  assertEquals(self.trySwitchWeapon(WEAPON_SHOTGUN, 0), true);
  // Full tube: nothing to load.
  assertEquals(wantsBotReload(self, { idle: true }), false);
  self.markShot(100);
  assert(self.ammoInMag > 0);
  // In combat a part-full tube keeps shooting.
  assertEquals(wantsBotReload(self), false);
  assertEquals(wantsBotReload(self, { idle: false }), false);
  assertEquals(wantsBotReload(self, { idle: true }), true);
  self.unlimitedAmmo = true;
  assertEquals(wantsBotReload(self, { idle: true }), false);
});

Deno.test("wantsBotReload: idle never tops up a part-empty mag gun", () => {
  const { self } = makePlayers();
  self.markShot(0);
  assert(self.ammoInMag > 0);
  assertEquals(wantsBotReload(self, { idle: true }), false);
});

Deno.test("wantsBotReload: empty mag + spare clips, no other loaded gun", () => {
  const { self } = makePlayers();
  assertEquals(wantsBotReload(self), false);
  drainActiveMag(self);
  // Pistol dry; rifle still loaded → switch, do not reload.
  assertEquals(wantsBotReload(self), false);
  assertEquals(self.trySwitchWeapon(WEAPON_RIFLE, 0), true);
  drainActiveMag(self);
  // Rifle dry; shotgun still loaded → switch, do not reload.
  assertEquals(wantsBotReload(self), false);
  assertEquals(pickBotWeaponSwitch(self), WEAPON_SHOTGUN);
  assertEquals(self.trySwitchWeapon(WEAPON_SHOTGUN, 100), true);
  drainActiveMag(self);
  assertEquals(self.trySwitchWeapon(WEAPON_RIFLE, 200), true);
  assertEquals(self.ammoInMag, 0);
  assert(self.spareClips > 0);
  assertEquals(wantsBotReload(self), true);
  self.unlimitedAmmo = true;
  assertEquals(wantsBotReload(self), false);
});

Deno.test("isUnarmedForCombat: false while spare clips remain", () => {
  const { self } = makePlayers();
  drainActiveMag(self);
  assertEquals(self.trySwitchWeapon(WEAPON_RIFLE, 0), true);
  drainActiveMag(self);
  assertEquals(isUnarmedForCombat(self), false);
});

Deno.test("pickBotWeaponSwitch: all dry or unlimited → null", () => {
  const { self } = makePlayers();
  drainActiveMag(self);
  assertEquals(self.trySwitchWeapon(WEAPON_RIFLE, 0), true);
  drainActiveMag(self);
  // Only shells left → fall back to the loaded shotgun.
  assertEquals(pickBotWeaponSwitch(self), WEAPON_SHOTGUN);
  assertEquals(self.trySwitchWeapon(WEAPON_SHOTGUN, 100), true);
  drainActiveMag(self);
  assertEquals(pickBotWeaponSwitch(self), null);
  self.unlimitedAmmo = true;
  assertEquals(pickBotWeaponSwitch(self), null);
});

Deno.test("botThinksOnSimPhase matches work slot to botTickPhase", () => {
  const ids = ["bot-a", "bot-b", "bot-c", "agent1", "x"];
  for (const id of ids) {
    const slot = botWorkSlot(id, SIM_TICKS_PER_BOT_TICK);
    for (let p = 0; p < SIM_TICKS_PER_BOT_TICK; p++) {
      const sim = botTickToSimTick(10) + p;
      assertEquals(botTickPhase(sim), p);
      assertEquals(botThinksOnSimPhase(id, sim), slot === p);
    }
  }
});

Deno.test("botThinksOnSimPhase covers each id exactly once per bot period", () => {
  const ids = Array.from({ length: 30 }, (_, i) => `bot${i}-${i * 17}`);
  const base = botTickToSimTick(5);
  const hits = new Map<string, number>();
  for (const id of ids) hits.set(id, 0);
  for (let p = 0; p < SIM_TICKS_PER_BOT_TICK; p++) {
    for (const id of ids) {
      if (botThinksOnSimPhase(id, base + p)) {
        hits.set(id, (hits.get(id) ?? 0) + 1);
      }
    }
  }
  for (const id of ids) {
    assertEquals(hits.get(id), 1, `${id} should think on exactly one phase`);
  }
});

Deno.test("full wall blocks combat lock, sense, and chase awareness", () => {
  const collision = new MapCollision(wallMap);
  const self = new Player("bot:1", "bot1", "A", {
    isBot: true,
    spawn: { x: 0, y: 1.7, z: -5 },
  });
  const enemy = new Player("enemy", "e1", "B", {
    spawn: { x: 0, y: 1.7, z: 5 },
  });
  const ally = new Player("ally", "a1", "A", {
    isBot: true,
    spawn: { x: 2, y: 1.7, z: 5 },
  });

  assertEquals(canSensePlayer(collision, self, enemy), false);
  assertEquals(canSensePlayer(collision, self, ally), false);

  const friend = new Player("friend", "f1", "A", {
    isBot: true,
    spawn: { x: 2, y: 1.7, z: -4 },
  });
  assertEquals(canSensePlayer(collision, self, friend), true);
});

Deno.test("glitch-hidden enemy cannot be sensed or combat-locked", () => {
  const collision = new MapCollision(openMap);
  const { self, enemy } = makePlayers();
  const tick = 20;
  enemy.restoreAbilityCharges();
  assertEquals(enemy.tryActivateAbility("glitch", tick), true);
  assertEquals(isHiddenByGlitch(enemy, tick, collision), true);

  assertEquals(canSensePlayer(collision, self, enemy, tick), false);

  // Without tick, glitch is not applied (legacy test path).
  assertEquals(canSensePlayer(collision, self, enemy), true);
});

Deno.test("open map still senses enemies and allies", () => {
  const collision = new MapCollision(openMap);
  const { self, enemy } = makePlayers();
  const ally = new Player("ally", "a1", "A", {
    isBot: true,
    spawn: { x: 2, y: 1.7, z: 3 },
  });
  assertEquals(canSensePlayer(collision, self, enemy), true);
  assertEquals(canSensePlayer(collision, self, ally), true);
});

Deno.test("combat LOS board: pair + geometric caches share results in epoch", () => {
  const collision = new MapCollision(openMap);
  const { self, enemy } = makePlayers();
  clearCombatLosCache();
  beginCombatLosCacheEpoch(42);

  assertEquals(canSensePlayer(collision, self, enemy), true);
  assertEquals(canSensePlayer(collision, self, enemy), true);
  const eye = { x: self.x, y: self.y, z: self.z };
  assertEquals(
    hasLineOfSight(collision, eye, { x: enemy.x, y: 1.1, z: enemy.z }),
    true,
  );

  const wallCol = new MapCollision(wallMap);
  clearCombatLosCache();
  beginCombatLosCacheEpoch(43);
  const blocked = new Player("bot:w", "bw", "A", {
    isBot: true,
    spawn: { x: 0, y: 1.7, z: -5 },
  });
  const farEnemy = new Player("enemy:w", "ew", "B", {
    spawn: { x: 0, y: 1.7, z: 5 },
  });
  assertEquals(canSensePlayer(wallCol, blocked, farEnemy), false);
  assertEquals(canSensePlayer(wallCol, blocked, farEnemy), false);
  clearCombatLosCache();
});

Deno.test("half wall: standing enemy still sensed (asymmetric far shooter)", () => {
  clearCombatLosCache();
  const col = new MapCollision(halfWallMap);
  const self = new Player("bot:half", "bh", "A", {
    isBot: true,
    spawn: { x: 0, y: 1.7, z: -8 },
  });
  const enemy = new Player("enemy:half", "eh", "B", {
    spawn: { x: 0, y: 1.7, z: 1 },
  });
  assertEquals(canSensePlayer(col, self, enemy), true);
  const aim = pickCombatAimPoint(
    col,
    { x: self.x, y: self.y, z: self.z },
    enemy,
  );
  assertExists(aim);
  // Head fallback (standing head ~1.55) — torso alone would be false.
  assertEquals(aim.y > 1.2, true);
});

Deno.test("half wall: crouched enemy stays hidden (asymmetric cover)", () => {
  clearCombatLosCache();
  const col = new MapCollision(halfWallMap);
  const self = new Player("bot:half2", "bh2", "A", {
    isBot: true,
    spawn: { x: 0, y: 1.7, z: -8 },
  });
  const enemy = new Player("enemy:half2", "eh2", "B", {
    spawn: { x: 0, y: 1.7, z: 1 },
  });
  enemy.crouch = true;
  enemy.y = 1.05;
  assertEquals(canSensePlayer(col, self, enemy), false);
  assertEquals(
    pickCombatAimPoint(col, { x: self.x, y: self.y, z: self.z }, enemy),
    null,
  );
});

Deno.test("half wall: full wall still hard-blocks standing LOS", () => {
  clearCombatLosCache();
  const col = new MapCollision(wallMap);
  const self = new Player("bot:full", "bf", "A", {
    isBot: true,
    spawn: { x: 0, y: 1.7, z: -8 },
  });
  const enemy = new Player("enemy:full", "ef", "B", {
    spawn: { x: 0, y: 1.7, z: 1 },
  });
  assertEquals(canSensePlayer(col, self, enemy), false);
});

Deno.test("shouldRunExpensiveNavProbes: mid-commit and stuck always run", () => {
  const id = "probe-bot";
  assertEquals(
    shouldRunExpensiveNavProbes({ halfWallVaultTicksLeft: 4 }, 0, id),
    true,
  );
  assertEquals(
    shouldRunExpensiveNavProbes({ floatWallDuckTicksLeft: 3 }, 0, id),
    true,
  );
  assertEquals(
    shouldRunExpensiveNavProbes({ stuckWElapsed: 3 }, 0, id),
    true,
  );
  assertEquals(
    shouldRunExpensiveNavProbes({ stuckWTurnTicksLeft: 2 }, 0, id),
    true,
  );
});

Deno.test("shouldRunExpensiveNavProbes: free-path follows bot-tick slot", () => {
  const id = "probe-free";
  const every = 2;
  const slot = botWorkSlot(id, every);
  const onSim = slot * SIM_TICKS_PER_BOT_TICK;
  const offSim = ((slot + 1) % every) * SIM_TICKS_PER_BOT_TICK;
  assertEquals(shouldRunExpensiveNavProbes({}, onSim, id, every), true);
  assertEquals(shouldRunExpensiveNavProbes({}, offSim, id, every), false);
});
