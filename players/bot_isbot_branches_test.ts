/**
 * Epic 4.5 Chunk 4: pin inventoried isBot branches; movement is now asserted
 * bot/human identical (bot-official keys-only PR 1).
 * Damage scale coverage lives in botDamage_test.ts.
 * Run from server-community/:
 *   deno test -A --unstable-net --node-modules-dir=manual players/bot_isbot_branches_test.ts
 */

import { assertEquals } from "@std/assert";
import type { DoorsMap } from "../world/map.ts";
import { Player } from "./Player.ts";
import { PlayerManager } from "./PlayerManager.ts";
import { botLagCompStamps } from "../bots/pipeline/botInputAdapter.ts";
import { MapCollision } from "../world/MapCollision.ts";
import { slideStaminaCostSeconds } from "../protocol/network.ts";
import type { PlayerInput } from "../protocol/network.ts";

const miniMap: DoorsMap = {
  name: "bot-isbot-branches",
  version: 1,
  bounds: { minX: -30, maxX: 30, minZ: -30, maxZ: 30 },
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

function input(sequence: number, overrides: Partial<PlayerInput> = {}): PlayerInput {
  return {
    sequence,
    forward: false,
    backward: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
    crouch: false,
    yaw: 0,
    pitch: 0,
    ...overrides,
  };
}

type MoveSnapshot = Pick<
  Player,
  | "x"
  | "y"
  | "z"
  | "velocityY"
  | "onGround"
  | "crouch"
  | "sprintStamina"
  | "slideRemaining"
>;

function moveSnapshot(p: Player): MoveSnapshot {
  return {
    x: p.x,
    y: p.y,
    z: p.z,
    velocityY: p.velocityY,
    onGround: p.onGround,
    crouch: p.crouch,
    sprintStamina: p.sprintStamina,
    slideRemaining: p.slideRemaining,
  };
}

/**
 * Keys-only (the keys-only note): identical keys + state must give a
 * bot and a human the identical move result, tick for tick.
 */
function assertMoveParity(
  map: DoorsMap,
  setup: (p: Player) => void,
  keysAt: (tick: number, p: Player) => Partial<PlayerInput>,
  ticks: number,
): void {
  const collision = new MapCollision(map);
  const bot = new Player("bot-parity", "Bot", "A", { isBot: true });
  const human = new Player("human-parity", "Human", "A");
  for (const p of [bot, human]) {
    p.spawnedAtTick = 0;
    setup(p);
  }
  for (let tick = 1; tick <= ticks; tick++) {
    bot.queueInput(input(tick, keysAt(tick, bot)), tick);
    human.queueInput(input(tick, keysAt(tick, human)), tick);
    bot.update(collision, tick);
    human.update(collision, tick);
    assertEquals(moveSnapshot(bot), moveSnapshot(human), `tick ${tick}`);
  }
}

Deno.test("move parity: crouch-move below slide stamina crouch-walks for bots too", () => {
  const cost = slideStaminaCostSeconds();
  assertMoveParity(
    miniMap,
    (p) => {
      p.x = 0;
      p.z = 0;
      p.onGround = true;
      p.sprintStamina = cost * 0.25;
    },
    () => ({ forward: true, crouch: true }),
    30,
  );
});

Deno.test("move parity: crouch-move with slide stamina slides identically", () => {
  assertMoveParity(
    miniMap,
    (p) => {
      p.x = 0;
      p.z = 0;
      p.onGround = true;
    },
    () => ({ forward: true, crouch: true }),
    30,
  );
});

Deno.test("move parity: airborne jump into a half wall (no clearance assist)", () => {
  const halfWallMap: DoorsMap = {
    ...miniMap,
    walls: [{ id: "h1", kind: "half", a: { x: -6, z: 0 }, b: { x: 6, z: 0 } }],
  };
  assertMoveParity(
    halfWallMap,
    (p) => {
      p.x = 0;
      p.z = -2.5;
      p.yaw = Math.PI;
      p.onGround = true;
    },
    // Late jump: a feet-raised resolve would change where the body ends up.
    (_tick, p) => ({
      forward: true,
      yaw: Math.PI,
      jump: p.onGround && p.z > -1.0,
    }),
    120,
  );
});

Deno.test("snapshot identity omits lastProcessedInputSeq for bots and attaches botDec", () => {
  const bot = new Player("bot-snap", "Bot", "A", { isBot: true });
  const human = new Player("human-snap", "Human", "A");
  bot.queueInput(input(3, { forward: true }), 1);
  human.queueInput(input(3, { forward: true }), 1);
  const collision = new MapCollision(miniMap);
  bot.update(collision, 1);
  human.update(collision, 1);

  const botSnap = bot.toSnapshot(1, "motion", null, 1_000);
  const humanSnap = human.toSnapshot(1, "motion", null, 1_000);

  assertEquals(botSnap.lastProcessedInputSeq, undefined);
  assertEquals(typeof botSnap.botDec, "number");
  assertEquals(humanSnap.botDec, undefined);
  assertEquals(humanSnap.lastProcessedInputSeq, 3);
  assertEquals(bot.socketId, null);
  assertEquals(human.socketId, "human-snap");
});

Deno.test("lag comp parity: bot and human with the same stamps rewind identically", () => {
  // Target strafes +x; at the observed tick it sat on the shooter's line.
  const OBSERVED = 70;
  const APPLY = 79;
  const hitsAt = (
    shooterKind: "bot" | "human",
    stamps: { clientTick: number; lastAppliedSnapshotTick: number },
  ) => {
    const collision = new MapCollision(miniMap);
    const players = new PlayerManager(collision, {
      damageRandom: () => 0.5,
      nowMs: 1_000,
    });
    const shooter = shooterKind === "bot"
      ? players.addBot("shooter", "Shooter", { team: "A" })
      : players.add("shooter", "Shooter", "A");
    const target = players.add("target", "Target", "B");
    shooter.x = 0;
    shooter.y = 1.7;
    shooter.z = 5;
    shooter.spawnedAtTick = 0;
    target.y = 1.7;
    target.z = 0;
    target.spawnedAtTick = 0;
    for (let t = 40; t <= APPLY; t++) {
      target.x = (t - OBSERVED) * 0.5;
      target.recordPose(t);
      shooter.recordPose(t);
    }
    assertEquals(shooter.pingReady, false);
    const out = players.handleShoot(shooter.id, APPLY, {
      yaw: 0,
      pitch: 0,
      origin: [0, 1.7, 5],
      ...stamps,
    }, { nowMs: 1_000 });
    return out?.shot.hitId ?? null;
  };

  const observed = botLagCompStamps(OBSERVED);
  assertEquals(hitsAt("bot", observed), "target");
  assertEquals(hitsAt("human", observed), "target");
  // Stamping the apply tick (the old bot path) resolves near the newest legal
  // world, where the strafing target has already left the line.
  const applyStamp = botLagCompStamps(APPLY);
  assertEquals(hitsAt("bot", applyStamp), null);
  assertEquals(hitsAt("human", applyStamp), null);
});

Deno.test("construction flags: isAgent and isBalanceBot imply isBot", () => {
  const agent = new Player("agent-1", "Agent", "A", { isAgent: true });
  const balance = new Player("bal-1", "bot", "A", { isBalanceBot: true });
  assertEquals(agent.isBot, true);
  assertEquals(agent.isAgent, true);
  assertEquals(balance.isBot, true);
  assertEquals(balance.isBalanceBot, true);
});

Deno.test("construction flags: isRaidBot implies isBot; fill bots and agents are not raid bots", () => {
  const raid = new Player("bot:raid-1", "bot", "B", { isRaidBot: true });
  const fill = new Player("bot-1", "bot1", "A", { isBot: true });
  const agent = new Player("agent-2", "Agent", "A", {
    isAgent: true,
    isRaidBot: true,
  });
  const human = new Player("human-1", "Human", "A");
  assertEquals(raid.isRaidBot, true);
  assertEquals(raid.isBot, true);
  assertEquals(fill.isRaidBot, false);
  assertEquals(agent.isRaidBot, false);
  assertEquals(human.isRaidBot, false);
});
