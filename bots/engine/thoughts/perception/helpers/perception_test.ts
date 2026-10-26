import { assertEquals, assertExists } from "jsr:@std/assert@1";
import { Player } from "../../../players/Player.ts";
import { MapCollision } from "../../../world/MapCollision.ts";
import type { DoorsMap } from "../../../shared/map.ts";
import {
  beginCombatLosCacheEpoch,
  BOT_FULL_LOS_EVERY_TICKS,
  botWorkSlot,
  clearCombatLosCache,
} from "../../../helpers/combat.ts";
import { SIM_TICKS_PER_BOT_TICK } from "../../../types.ts";
import { enemyDoorTarget, ownDoorTarget } from "../../../helpers/nav.ts";
import {
  buildBotPerception,
  createYawPoleLosMemo,
  yawPoleLosCacheKey,
} from "./perception.ts";
import type { BotWorldView } from "../../../types.ts";
import { wallBlocksYawPoleLos } from "../../yawPole/helpers/yawPole.ts";

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

function viewFor(
  map: DoorsMap,
  self: Player,
  others: Player[],
  doorsOpen = true,
): BotWorldView {
  return {
    tick: 10,
    self,
    players: [self, ...others],
    collision: new MapCollision(map),
    map,
    doorsOpen,
  };
}

Deno.test("buildBotPerception: door mids match nav targets for A and B", () => {
  const a = new Player("bot:a", "a", "A", {
    isBot: true,
    spawn: { x: 0, y: 1.7, z: -8 },
  });
  const b = new Player("bot:b", "b", "B", {
    isBot: true,
    spawn: { x: 0, y: 1.7, z: 8 },
  });
  const percA = buildBotPerception(viewFor(openMap, a, [b]));
  const percB = buildBotPerception(viewFor(openMap, b, [a]));
  assertEquals(percA.enemyDoor, enemyDoorTarget(openMap, "A"));
  assertEquals(percA.ownDoor, ownDoorTarget(openMap, "A"));
  assertEquals(percB.enemyDoor, enemyDoorTarget(openMap, "B"));
  assertEquals(percB.ownDoor, ownDoorTarget(openMap, "B"));
  assertEquals(percA.doorsOpen, true);
  assertEquals(percA.selfId, "bot:a");
  assertEquals(percA.tick, 10);
});

Deno.test("buildBotPerception: hostiles sorted nearest-first; empty when alone", () => {
  const self = new Player("bot:1", "b1", "A", {
    isBot: true,
    spawn: { x: 0, y: 1.7, z: 0 },
  });
  const near = new Player("e1", "e1", "B", {
    spawn: { x: 0, y: 1.7, z: -3 },
  });
  const far = new Player("e2", "e2", "B", {
    spawn: { x: 0, y: 1.7, z: -20 },
  });
  const ally = new Player("ally", "ally", "A", {
    isBot: true,
    spawn: { x: 2, y: 1.7, z: 0 },
  });

  const alone = buildBotPerception(viewFor(openMap, self, []));
  assertEquals(alone.hostiles.length, 0);
  assertEquals(alone.nearestHostile, null);

  const perc = buildBotPerception(viewFor(openMap, self, [far, near, ally]));
  assertEquals(perc.hostiles.length, 2);
  assertEquals(perc.hostiles[0]!.player.id, "e1");
  assertEquals(perc.hostiles[1]!.player.id, "e2");
  assertEquals(perc.nearestHostile?.player.id, "e1");
  assertEquals(perc.sensedHostiles.length, 2);
  assertExists(perc.sensedHostiles[0]!.aim);
});

Deno.test("buildBotPerception: staggerSense rays lock + nearest only", () => {
  const self = new Player("bot:1", "b1", "A", {
    isBot: true,
    spawn: { x: 0, y: 1.7, z: 0 },
  });
  const near = new Player("e1", "e1", "B", {
    spawn: { x: 0, y: 1.7, z: -3 },
  });
  const far = new Player("e2", "e2", "B", {
    spawn: { x: 0, y: 1.7, z: -20 },
  });
  const mid = new Player("e3", "e3", "B", {
    spawn: { x: 0, y: 1.7, z: -10 },
  });
  const every = BOT_FULL_LOS_EVERY_TICKS;
  const slot = botWorkSlot(self.id, every);
  const offBot = slot === 0 ? 1 : 0;
  const offView = {
    ...viewFor(openMap, self, [far, near, mid]),
    tick: offBot * SIM_TICKS_PER_BOT_TICK,
  };
  const skip = buildBotPerception(offView, {
    staggerSense: true,
    lockTargetId: "e2",
  });
  assertEquals(skip.hostiles.length, 3);
  assertEquals(
    skip.sensedHostiles.map((h) => h.player.id).sort(),
    ["e1", "e2"],
  );

  const full = buildBotPerception(offView, {
    staggerSense: true,
    forceFullScan: true,
  });
  assertEquals(full.sensedHostiles.length, 3);
});

Deno.test("buildBotPerception: full wall drops sensed hostiles, keeps hostiles", () => {
  clearCombatLosCache();
  beginCombatLosCacheEpoch(1);
  const self = new Player("bot:1", "b1", "A", {
    isBot: true,
    spawn: { x: 0, y: 1.7, z: 5 },
  });
  const enemy = new Player("e1", "e1", "B", {
    spawn: { x: 0, y: 1.7, z: -5 },
  });
  const perc = buildBotPerception(viewFor(wallMap, self, [enemy]));
  assertEquals(perc.hostiles.length, 1);
  assertEquals(perc.sensedHostiles.length, 0);
  assertEquals(perc.nearestSensedHostile, null);
  clearCombatLosCache();
});

Deno.test("buildBotPerception: hunt goal prefers agents for team bot", () => {
  const self = new Player("bot:1", "b1", "A", {
    isBot: true,
    spawn: { x: 0, y: 1.7, z: 0 },
  });
  const agent = new Player("agent:1", "ag", "A", {
    isBot: true,
    isAgent: true,
    spawn: { x: 10, y: 1.7, z: 0 },
  });
  const human = new Player("h1", "h1", "B", {
    spawn: { x: 1, y: 1.7, z: 0 },
  });
  const perc = buildBotPerception(viewFor(openMap, self, [human, agent]));
  assertExists(perc.nearestHuntGoal);
  assertEquals(perc.nearestHuntGoal.playerId, "agent:1");
});

Deno.test("buildBotPerception: grey agent hunt goal prefers non-agents", () => {
  const self = new Player("agent:1", "ag", "A", {
    isBot: true,
    isAgent: true,
    spawn: { x: 0, y: 1.7, z: 0 },
  });
  const otherAgent = new Player("agent:2", "ag2", "B", {
    isBot: true,
    isAgent: true,
    spawn: { x: 1, y: 1.7, z: 0 },
  });
  const human = new Player("h1", "h1", "B", {
    spawn: { x: 10, y: 1.7, z: 0 },
  });
  const perc = buildBotPerception(viewFor(openMap, self, [otherAgent, human]));
  assertExists(perc.nearestHuntGoal);
  assertEquals(perc.nearestHuntGoal.playerId, "h1");
});

Deno.test("buildBotPerception: poles lists non-empty for open map", () => {
  const self = new Player("bot:1", "b1", "A", {
    isBot: true,
    spawn: { x: 0, y: 1.7, z: -8 },
  });
  const perc = buildBotPerception(viewFor(openMap, self, []));
  assertEquals(
    perc.wallPoles.length > 0 || perc.enemyDoorPoles.length > 0,
    true,
  );
});

Deno.test("buildBotPerception: glitch-hidden hostiles are fully ignored", () => {
  clearCombatLosCache();
  beginCombatLosCacheEpoch(10);
  const self = new Player("bot:1", "b1", "A", {
    isBot: true,
    spawn: { x: 0, y: 1.7, z: 0 },
  });
  // Mid-map = outside door force-visible radius → glitch "hidden".
  const ghost = new Player("e1", "ghost", "B", {
    spawn: { x: 0, y: 1.7, z: -3 },
  });
  const tick = 10;
  ghost.restoreAbilityCharges();
  assertEquals(ghost.tryActivateAbility("glitch", tick), true);
  assertEquals(
    ghost.glitchSnapState(tick, new MapCollision(openMap)),
    "hidden",
  );

  const perc = buildBotPerception(viewFor(openMap, self, [ghost]));
  assertEquals(perc.hostiles.length, 0);
  assertEquals(perc.sensedHostiles.length, 0);
  assertEquals(perc.nearestHostile, null);
  assertEquals(perc.nearestSensedHostile, null);
  clearCombatLosCache();
});

Deno.test("buildBotPerception: door-revealed glitch still counts as hostile", () => {
  clearCombatLosCache();
  beginCombatLosCacheEpoch(10);
  const self = new Player("bot:1", "b1", "A", {
    isBot: true,
    spawn: { x: 0, y: 1.7, z: 0 },
  });
  // Team B scores at team A south door (z ≈ -50). Place ghost on that lip.
  const ghost = new Player("e1", "ghost", "B", {
    spawn: { x: 0, y: 1.7, z: -49 },
  });
  const tick = 10;
  const col = new MapCollision(openMap);
  ghost.restoreAbilityCharges();
  assertEquals(ghost.tryActivateAbility("glitch", tick), true);
  assertEquals(ghost.glitchSnapState(tick, col), "revealed");

  const perc = buildBotPerception(viewFor(openMap, self, [ghost]));
  assertEquals(perc.hostiles.length, 1);
  assertEquals(perc.hostiles[0]!.player.id, "e1");
  clearCombatLosCache();
});

Deno.test("buildBotPerception: glitch-hidden hunt goals are ignored", () => {
  const self = new Player("bot:1", "b1", "A", {
    isBot: true,
    spawn: { x: 0, y: 1.7, z: 0 },
  });
  const agent = new Player("agent:1", "ag", "A", {
    isBot: true,
    isAgent: true,
    spawn: { x: 5, y: 1.7, z: 0 },
  });
  const tick = 10;
  agent.restoreAbilityCharges();
  assertEquals(agent.tryActivateAbility("glitch", tick), true);
  // Agents are always fully hidden while glitched (no enemy door).
  assertEquals(
    agent.glitchSnapState(tick, new MapCollision(openMap)),
    "hidden",
  );

  const perc = buildBotPerception(viewFor(openMap, self, [agent]));
  assertEquals(perc.nearestHuntGoal, null);
});

Deno.test("yawPoleLos memo: second identical query hits cache", () => {
  const col = new MapCollision(openMap);
  const memo = createYawPoleLosMemo(col, { crouch: false, eyeY: 1.7 });
  const a = memo.blocksYawPoleLos(0, -5, 0, 5);
  assertEquals(memo.cache.size, 1);
  const b = memo.blocksYawPoleLos(0, -5, 0, 5);
  assertEquals(a, b);
  assertEquals(memo.cache.size, 1);
  // Tiny float noise still same quant key.
  const key1 = yawPoleLosCacheKey(0, -5, 0, 5, false);
  const key2 = yawPoleLosCacheKey(0.01, -5.01, 0.01, 5.01, false);
  assertEquals(key1, key2);
});

Deno.test("yawPoleLos memo: matches uncached wallBlocksYawPoleLos", () => {
  const col = new MapCollision(wallMap);
  const memo = createYawPoleLosMemo(col, { crouch: false, eyeY: 1.7 });
  const blocked = memo.blocksYawPoleLos(0, 5, 0, -5);
  const raw = wallBlocksYawPoleLos(col, 0, 5, 0, -5, {
    crouch: false,
    eyeY: 1.7,
  });
  assertEquals(blocked, raw);
  assertEquals(blocked, true);

  const openCol = new MapCollision(openMap);
  const openMemo = createYawPoleLosMemo(openCol, { crouch: false, eyeY: 1.7 });
  assertEquals(openMemo.blocksYawPoleLos(0, 5, 0, -5), false);
});
