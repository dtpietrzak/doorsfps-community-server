import { assert, assertEquals } from "@std/assert";
import { createBotThinkEngine } from "@doors/bot-engine";
import {
  BotManager,
  botTickToSimTick,
  RAID_BOT_SPAWN_INTERVAL_TICKS,
  SIM_TICKS_PER_BOT_TICK,
  THINK_BUFFER_BOT_TICKS,
} from "./BotManager.ts";
import type { ChurnPolicy } from "../host/channel/protocol.ts";

/** ±1 band, 30% mirror, 30–60 min delays. */
const CHURN_POLICY: ChurnPolicy = {
  band: 1,
  humanMirrorChance: 0.3,
  minDelayMs: 30 * 60 * 1000,
  maxDelayMs: 60 * 60 * 1000,
};
const BOT_CHURN_MIN_MS = CHURN_POLICY.minDelayMs;
const AUTHENTIC_HUMAN_MIRROR_CHANCE = CHURN_POLICY.humanMirrorChance;
import { PlayerManager } from "../players/PlayerManager.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";
import {
  DOOR_POWER_UP_TICKS,
  SNAP_KEY_FORWARD,
} from "../protocol/network.ts";

/** Run `n` consecutive bot-tick advances via full bots.tick (3 sim ticks each). */
function tickBotPeriods(
  bots: BotManager,
  collision: MapCollision,
  startSim: number,
  periods: number,
): number {
  let sim = startSim;
  for (let i = 0; i < periods; i++) {
    for (let p = 0; p < SIM_TICKS_PER_BOT_TICK; p++) {
      bots.tick(sim + p, collision);
    }
    sim += SIM_TICKS_PER_BOT_TICK;
  }
  return sim;
}

/** Drive all three sim phases of a bot period (phase-sharded think). */
function thinkAllBotPeriod(
  bots: BotManager,
  botTick: number,
  collision: MapCollision,
): void {
  const base = botTickToSimTick(botTick);
  for (let p = 0; p < SIM_TICKS_PER_BOT_TICK; p++) {
    bots.thinkAll(base + p, collision);
  }
}

function testMap(): DoorsMap {
  return {
    version: 1,
    name: "Test",
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

function setup() {
  const collision = new MapCollision(testMap());
  const players = new PlayerManager(collision);
  const bots = new BotManager(players);
  return { players, bots, maxPlayers: 8 };
}

Deno.test("raid waves spawn at most two bots every two seconds", () => {
  const collision = new MapCollision(testMap());
  const players = new PlayerManager(collision);
  const bots = new BotManager(players);
  bots.setRaidMode(true);

  bots.setRaidWave(5, "B");
  assertEquals(bots.count, 2);
  assertEquals(
    bots.list().map((bot) => [bot.name, bot.team]),
    [["bot", "B"], ["bot2", "B"]],
  );

  bots.tickHousekeeping(RAID_BOT_SPAWN_INTERVAL_TICKS - 1, collision);
  assertEquals(bots.count, 2);
  bots.tickHousekeeping(RAID_BOT_SPAWN_INTERVAL_TICKS, collision);
  assertEquals(bots.count, 4);

  bots.tickHousekeeping(RAID_BOT_SPAWN_INTERVAL_TICKS * 2 - 1, collision);
  assertEquals(bots.count, 4);
  bots.tickHousekeeping(RAID_BOT_SPAWN_INTERVAL_TICKS * 2, collision);
  assertEquals(bots.count, 5);
  assertEquals(bots.list().map((bot) => bot.name), [
    "bot",
    "bot2",
    "bot3",
    "bot4",
    "bot5",
  ]);
  for (const player of players.all()) {
    assertEquals(player.isRaidBot, true, `${player.name} is a raid bot`);
  }
});

Deno.test("raid reinforcements stop spawning after game over", () => {
  const collision = new MapCollision(testMap());
  const players = new PlayerManager(collision);
  const bots = new BotManager(players);
  bots.setRaidMode(true);
  bots.setRaidWave(6, "B");
  assertEquals(bots.count, 2);

  players.forceEndMatch(1, "A");
  bots.tickHousekeeping(RAID_BOT_SPAWN_INTERVAL_TICKS, collision);
  assertEquals(bots.count, 2);

  players.startNewMatch(RAID_BOT_SPAWN_INTERVAL_TICKS + 1);
  bots.tickHousekeeping(RAID_BOT_SPAWN_INTERVAL_TICKS * 2, collision);
  assertEquals(bots.count, 2);
});

Deno.test("raid boss wave spawns exactly two enlarged 200 HP slow bots", () => {
  const collision = new MapCollision(testMap());
  const players = new PlayerManager(collision);
  const bots = new BotManager(players);
  bots.setRaidMode(true);
  bots.setRaidBossWave(2, "B", {
    maxHealth: 200,
    modelScale: 1.15,
    moveSpeedScale: 0.65,
  });

  const bosses = [...players.all()].filter((player) => player.isBot);
  assertEquals(bosses.length, 2);
  for (const boss of bosses) {
    assertEquals(boss.team, "B");
    assertEquals(boss.health, 200);
    assertEquals(boss.maxHealth, 200);
    assertEquals(boss.modelScale, 1.15);
    assertEquals(boss.moveSpeedScale, 0.65);
    assertEquals(boss.isRaidBot, true);
    assertEquals(boss.toSnapshot(0).scale, 1.15);
  }
  bots.tickHousekeeping(RAID_BOT_SPAWN_INTERVAL_TICKS * 2, collision);
  assertEquals(bots.count, 2);
});

Deno.test("raid mini wave spawns fragile fast small bots in pairs", () => {
  const collision = new MapCollision(testMap());
  const players = new PlayerManager(collision);
  const bots = new BotManager(players);
  bots.setRaidMode(true);
  bots.setRaidMiniWave(4, "B", {
    maxHealth: 20,
    modelScale: 0.8,
    moveSpeedScale: 1.3,
  });
  assertEquals(
    bots.list().map((bot) => [bot.name, bot.team]),
    [["mini", "B"], ["mini2", "B"]],
  );

  bots.tickHousekeeping(RAID_BOT_SPAWN_INTERVAL_TICKS, collision);
  const minis = [...players.all()].filter((player) => player.isBot);
  assertEquals(minis.length, 4);
  assertEquals(
    minis.map((mini) => mini.name),
    ["mini", "mini2", "mini3", "mini4"],
  );
  for (const mini of minis) {
    assertEquals(mini.team, "B");
    assertEquals(mini.health, 20);
    assertEquals(mini.maxHealth, 20);
    assertEquals(mini.modelScale, 0.8);
    assertEquals(mini.moveSpeedScale, 1.3);
    assertEquals(mini.isRaidBot, true);
  }
  bots.tickHousekeeping(RAID_BOT_SPAWN_INTERVAL_TICKS * 2, collision);
  assertEquals(bots.count, 4);
});

Deno.test("raid mixed wave fields bosses normals and minis without collisions", () => {
  const collision = new MapCollision(testMap());
  const players = new PlayerManager(collision);
  const bots = new BotManager(players);
  bots.setRaidMode(true);
  bots.setRaidMixedWave("B", {
    normals: 4,
    minis: { count: 4, maxHealth: 20, modelScale: 0.8, moveSpeedScale: 1.3 },
    bosses: { count: 2, maxHealth: 200, modelScale: 1.3, moveSpeedScale: 0.65 },
  });
  // Bosses arrive immediately alongside the first normal/mini pairs.
  assertEquals(bots.count, 6);

  bots.tickHousekeeping(RAID_BOT_SPAWN_INTERVAL_TICKS, collision);
  const roster = [...players.all()].filter((player) => player.isBot);
  assertEquals(roster.length, 10);
  const names = roster.map((player) => player.name).sort();
  assertEquals(names, [
    "boss",
    "boss2",
    "bot",
    "bot2",
    "bot3",
    "bot4",
    "mini",
    "mini2",
    "mini3",
    "mini4",
  ]);
  assertEquals(
    new Set(roster.map((player) => player.id)).size,
    roster.length,
  );
  for (const boss of roster.filter((player) => player.name.startsWith("boss"))) {
    assertEquals(boss.health, 200);
    assertEquals(boss.maxHealth, 200);
    assertEquals(boss.moveSpeedScale, 0.65);
  }
  for (const mini of roster.filter((player) => player.name.startsWith("mini"))) {
    assertEquals(mini.health, 20);
    assertEquals(mini.maxHealth, 20);
    assertEquals(mini.moveSpeedScale, 1.3);
  }
  bots.tickHousekeeping(RAID_BOT_SPAWN_INTERVAL_TICKS * 2, collision);
  assertEquals(bots.count, 10);
});

Deno.test("scripted raid agents seal doors until the full group is defeated", () => {
  const collision = new MapCollision(testMap());
  const players = new PlayerManager(collision);
  const bots = new BotManager(players);
  bots.setRaidMode(true);
  players.setRaidDoorPolicy("open");
  assertEquals(players.areDoorsOpen(0), true);

  assertEquals(bots.spawnAgentsAtDoor(3, collision, "B"), 3);
  assertEquals(players.agentCount(), 3);
  assertEquals(players.areDoorsOpen(0), false);
  const deathTick = 10_000;
  for (const agent of [...players.all()].filter((p) => p.isAgent)) {
    agent.takeDamage(999, "body", deathTick, Date.now());
  }
  assertEquals(bots.pruneDeadAgents(deathTick).length, 3);
  assertEquals(players.areDoorsOpen(deathTick), false);
  assertEquals(players.areDoorsOpen(deathTick + DOOR_POWER_UP_TICKS), true);
});

Deno.test("auto-fill: 0 humans → 0 bots (default noBotsOnEmptyServer)", () => {
  const { bots, maxPlayers } = setup();
  bots.reconcile(maxPlayers);
  assertEquals(bots.count, 0);
});

Deno.test("auto-fill: 0 humans → minPlayers bots when noBotsOnEmptyServer is false", () => {
  const { bots, maxPlayers } = setup();
  bots.setNoBotsOnEmptyServer(false);
  bots.reconcile(maxPlayers);
  assertEquals(bots.count, 4);
});

Deno.test("auto-fill: 1 human → 3 bots (total 4)", () => {
  const { players, bots, maxPlayers } = setup();
  players.add("sock-h1", "Alice");
  bots.reconcile(maxPlayers);
  assertEquals(players.humanCount(), 1);
  assertEquals(bots.count, 3);
  assertEquals(players.size, 4);
});

Deno.test("auto-fill: 4 humans → 0 bots", () => {
  const { players, bots, maxPlayers } = setup();
  players.add("s1", "A");
  players.add("s2", "B");
  players.add("s3", "C");
  players.add("s4", "D");
  bots.reconcile(maxPlayers);
  assertEquals(bots.count, 0);
});

Deno.test("auto-fill: human leaves → bots clear when noBotsOnEmptyServer true", () => {
  const { players, bots, maxPlayers } = setup();
  players.add("s1", "Alice");
  bots.reconcile(maxPlayers);
  assertEquals(bots.count, 3);

  players.remove("s1");
  bots.reconcile(maxPlayers);
  assertEquals(bots.count, 0);
});

Deno.test("auto-fill: human leaves → bots stay when noBotsOnEmptyServer false", () => {
  const { players, bots, maxPlayers } = setup();
  bots.setNoBotsOnEmptyServer(false);
  players.add("s1", "Alice");
  bots.reconcile(maxPlayers);
  assertEquals(bots.count, 3);

  players.remove("s1");
  bots.reconcile(maxPlayers);
  // Empty server still auto-fills to minPlayers (4 bots).
  assertEquals(bots.count, 4);
});

Deno.test("bots named bot1, bot2, …", () => {
  const { players, bots, maxPlayers } = setup();
  players.add("s1", "Alice");
  bots.reconcile(maxPlayers);
  const names = bots.list().map((b) => b.name).sort();
  assertEquals(names, ["bot1", "bot2", "bot3"]);
});

Deno.test("community bots stay botN without seed clerk ids", () => {
  const { players, bots, maxPlayers } = setup();
  players.add("s1", "Alice");
  bots.reconcile(maxPlayers);
  for (const p of players.bots()) {
    if (p.isBalanceBot) continue;
    assertEquals(p.accountUserId, null);
    assert(/^bot\d+$/i.test(p.name));
    // Community fillers have no socket RTT and no fake ping.
    assertEquals(p.pingMs, 0);
  }
});

Deno.test("community autofill uses COMMUNITY_BOT_CONFIG brain (not tier/seed)", () => {
  const { players, bots, maxPlayers } = setup();
  players.add("s1", "Alice");
  bots.reconcile(maxPlayers);
  const fillers = bots.list().filter((b) => b.brainId === "community");
  assert(fillers.length > 0, "expected community-brained autofill bots");
  for (const b of bots.list()) {
    // Autofill names are botN; balance filler (if any) is balance-bot id.
    if (/^bot\d+$/i.test(b.name)) {
      assertEquals(b.brainId, "community");
    }
  }
  // Difficulty changes do not retarget community autofill brains.
  bots.setDifficulty("hard");
  bots.clear();
  // Alice still on roster after clear — refill with hard difficulty stored.
  bots.reconcile(maxPlayers);
  for (const b of bots.list()) {
    if (/^bot\d+$/i.test(b.name)) {
      assertEquals(b.brainId, "community");
    }
  }
});

Deno.test("churn keeps bot count within base ± 1", () => {
  let now = 1_000_000;
  // Always fire: next delay rolls to MIN when rand=0
  const bots = new BotManager(
    new PlayerManager(new MapCollision(testMap())),
    {},
    {
      difficulty: "medium",
      fill: { noBotsOnEmptyServer: false, minPlayers: 4 },
      nowMs: () => now,
      rand: () => 0,
    },
  );
  bots.setChurnPolicy(CHURN_POLICY);
  bots.reconcile(8);
  assertEquals(bots.fillBotCount, 4);
  const base = 4;

  // Advance past first leave deadline
  now += BOT_CHURN_MIN_MS + 1;
  bots.tickChurn(8, now);
  assert(bots.fillBotCount >= base - 1 && bots.fillBotCount <= base + 1);
  assertEquals(Math.abs(bots.getChurnOffset()) <= 1, true);

  // Fire join path repeatedly — never exceed base+1
  for (let i = 0; i < 5; i++) {
    now += BOT_CHURN_MIN_MS + 1;
    bots.tickChurn(8, now);
    assert(
      bots.fillBotCount >= base - 1 && bots.fillBotCount <= base + 1,
      `fill count ${bots.fillBotCount} out of band`,
    );
  }
});

function setupAuthentic(mirrorRoll: () => number = () => 0.99) {
  const collision = new MapCollision(testMap());
  const players = new PlayerManager(collision);
  const bots = new BotManager(players, {}, {
    difficulty: "easy",
    fill: { minPlayers: 4, noBotsOnEmptyServer: true },
    mirrorRoll,
  });
  bots.setChurnPolicy(CHURN_POLICY);
  return { players, bots, maxPlayers: 8 };
}

Deno.test("community onHumanJoined always drops a bot (exact autofill)", () => {
  const { players, bots, maxPlayers } = setup();
  players.add("s1", "Alice");
  bots.onHumanJoined(maxPlayers);
  assertEquals(bots.fillBotCount, 3);

  players.add("s2", "Bob");
  bots.onHumanJoined(maxPlayers);
  assertEquals(bots.fillBotCount, 2);
});

Deno.test("authentic onHumanJoined without mirror keeps bot count (base+1)", () => {
  // rand >= mirror chance → no voluntary leave
  const { players, bots, maxPlayers } = setupAuthentic(() => 0.99);
  assert(0.99 >= AUTHENTIC_HUMAN_MIRROR_CHANCE);

  players.add("s1", "Alice");
  bots.onHumanJoined(maxPlayers);
  assertEquals(bots.fillBotCount, 3); // initial fill to base
  assertEquals(bots.getChurnOffset(), 0);

  players.add("s2", "Bob");
  bots.onHumanJoined(maxPlayers);
  // base drops 3→2; fill bots stay 3 → offset +1
  // (odd roster may also carry a temporary balance "bot")
  assertEquals(bots.fillBotCount, 3);
  assertEquals(bots.getChurnOffset(), 1);
});

Deno.test("authentic onHumanJoined with mirror drops a bot", () => {
  const { players, bots, maxPlayers } = setupAuthentic(() => 0);
  assert(0 < AUTHENTIC_HUMAN_MIRROR_CHANCE);

  players.add("s1", "Alice");
  bots.onHumanJoined(maxPlayers);
  assertEquals(bots.fillBotCount, 3);

  players.add("s2", "Bob");
  bots.onHumanJoined(maxPlayers);
  // base=2, mirror leave → 2 fill bots (offset 0)
  assertEquals(bots.fillBotCount, 2);
  assertEquals(bots.getChurnOffset(), 0);
});

Deno.test("authentic onHumanLeft without mirror keeps bot count (base-1)", () => {
  let i = 0;
  // join fill, join mirror→2, leave no-mirror stay 2 at base 3 (-1)
  const seq = [0.99, 0, 0.99];
  const { players, bots, maxPlayers } = setupAuthentic(() =>
    seq[Math.min(i++, seq.length - 1)]!
  );

  players.add("s1", "Alice");
  bots.onHumanJoined(maxPlayers);
  players.add("s2", "Bob");
  bots.onHumanJoined(maxPlayers);
  assertEquals(bots.fillBotCount, 2);

  players.remove("s2");
  bots.onHumanLeft(maxPlayers);
  assertEquals(bots.fillBotCount, 2);
  assertEquals(bots.getChurnOffset(), -1);
});

Deno.test("authentic onHumanLeft with mirror adds a bot when not at +1", () => {
  const { players, bots, maxPlayers } = setupAuthentic(() => 0);

  players.add("s1", "Alice");
  bots.onHumanJoined(maxPlayers);
  assertEquals(bots.fillBotCount, 3);

  players.add("s2", "Bob");
  bots.onHumanJoined(maxPlayers);
  assertEquals(bots.fillBotCount, 2); // mirrored leave

  players.remove("s2");
  bots.onHumanLeft(maxPlayers);
  // base=3, start at 2 (floor), mirror add → 3
  assertEquals(bots.fillBotCount, 3);
});

Deno.test("authentic join while at +1 forces one leave into band", () => {
  const { players, bots, maxPlayers } = setupAuthentic(() => 0.99);

  players.add("s1", "A");
  bots.onHumanJoined(maxPlayers); // 3
  players.add("s2", "B");
  bots.onHumanJoined(maxPlayers); // keep 3, base 2, +1
  assertEquals(bots.fillBotCount, 3);
  assertEquals(bots.getChurnOffset(), 1);

  players.add("s3", "C");
  bots.onHumanJoined(maxPlayers);
  // base 1, ceil 2: clamp 3→2 (forced), no voluntary mirror
  assertEquals(bots.fillBotCount, 2);
  assertEquals(bots.getChurnOffset(), 1);
});

Deno.test("authentic leave while at -1 forces one join into band", () => {
  let i = 0;
  // j1 fill, j2 mirror→2, j3 mirror→1, leave no-mirror stay1 (-1),
  // leave no-mirror force→2 (floor)
  const seq = [0.99, 0, 0, 0.99, 0.99];
  const { players, bots, maxPlayers } = setupAuthentic(() =>
    seq[Math.min(i++, seq.length - 1)]!
  );

  players.add("s1", "A");
  bots.onHumanJoined(maxPlayers);
  players.add("s2", "B");
  bots.onHumanJoined(maxPlayers);
  players.add("s3", "C");
  bots.onHumanJoined(maxPlayers);
  assertEquals(bots.fillBotCount, 1); // base 1

  players.remove("s3");
  bots.onHumanLeft(maxPlayers); // bots 1, base 2 → at -1
  assertEquals(bots.fillBotCount, 1);
  assertEquals(bots.getChurnOffset(), -1);

  players.remove("s2");
  bots.onHumanLeft(maxPlayers); // bots 1, base 3 → floor 2, force join
  assertEquals(players.humanCount(), 1);
  assertEquals(bots.fillBotCount, 2);
  assertEquals(bots.getChurnOffset(), -1);
});

Deno.test("authentic at -1 does not voluntary-remove on human join", () => {
  let i = 0;
  // j1 fill, j2 mirror→2, leave no-mirror → 2 bots base3 (-1),
  // join WITH mirror attempt → wasAtMin, keep 2 (new base 2, center)
  const seq = [0.99, 0, 0.99, 0];
  const { players, bots, maxPlayers } = setupAuthentic(() =>
    seq[Math.min(i++, seq.length - 1)]!
  );

  players.add("s1", "A");
  bots.onHumanJoined(maxPlayers);
  players.add("s2", "B");
  bots.onHumanJoined(maxPlayers);
  assertEquals(bots.fillBotCount, 2);

  players.remove("s2");
  bots.onHumanLeft(maxPlayers);
  assertEquals(bots.fillBotCount, 2);
  assertEquals(bots.getChurnOffset(), -1);

  players.add("s2", "B");
  bots.onHumanJoined(maxPlayers);
  // Was at −1: no voluntary remove; bots stay 2 = new base
  assertEquals(bots.fillBotCount, 2);
  assertEquals(bots.getChurnOffset(), 0);
});

Deno.test("authentic at +1 does not voluntary-add on human leave", () => {
  let i = 0;
  // j1 fill, j2 no-mirror → 3 bots base2 (+1), leave WITH mirror → wasAtMax, keep 3
  const seq = [0.99, 0.99, 0];
  const { players, bots, maxPlayers } = setupAuthentic(() =>
    seq[Math.min(i++, seq.length - 1)]!
  );

  players.add("s1", "A");
  bots.onHumanJoined(maxPlayers);
  players.add("s2", "B");
  bots.onHumanJoined(maxPlayers);
  assertEquals(bots.fillBotCount, 3);
  assertEquals(bots.getChurnOffset(), 1);

  players.remove("s2");
  bots.onHumanLeft(maxPlayers);
  // Was at +1: no voluntary add; bots stay 3 = new base
  assertEquals(bots.fillBotCount, 3);
  assertEquals(bots.getChurnOffset(), 0);
});

Deno.test("manual add/remove while human present", () => {
  const { players, bots, maxPlayers } = setup();
  players.add("s1", "Alice");
  bots.reconcile(maxPlayers);
  assertEquals(bots.fillBotCount, 3);

  const added = bots.addBots(1, maxPlayers);
  assertEquals(added, 1);
  assertEquals(bots.fillBotCount, 4);

  const removed = bots.removeBots(2, maxPlayers);
  assertEquals(removed, 2);
  assertEquals(bots.fillBotCount, 2);
});

Deno.test("evict bot frees a slot", () => {
  const { players, bots } = setup();
  // Fill to max with 1 human + bots capped by maxPlayers.
  players.add("s1", "Alice");
  bots.reconcile(8);
  // Force-fill remaining slots as bots via manual extras.
  bots.addBots(10, 8);
  assertEquals(players.size, 8);

  const ok = bots.tryEvictOne();
  assertEquals(ok, true);
  assertEquals(players.size, 7);
});

Deno.test("human joins team with fewest humans (not fewest total)", () => {
  const { players, bots, maxPlayers } = setup();
  // Alice on A; bots fill so totals are even (A:1h+1b, B:0h+2b).
  const alice = players.add("s1", "Alice");
  assertEquals(alice.team, "A");
  bots.reconcile(maxPlayers);
  assertEquals(bots.count, 3);

  // Force a skewed human/total layout that used to put the next human on A:
  // put both remaining bots on B by removing A bots if needed and re-checking.
  // With balance spawn: Alice A, bot1 B, bot2 A, bot3 B → A:1h+1b B:0h+2b.
  const teamAHumans = players.humanTeamCounts().A;
  const teamBHumans = players.humanTeamCounts().B;
  assertEquals(teamAHumans, 1);
  assertEquals(teamBHumans, 0);

  // Bob should join B (0 humans), not A.
  const bob = players.add("s2", "Bob");
  assertEquals(bob.team, "B");
});

Deno.test("joining human replaces a bot on their team (no 1v3)", () => {
  const { players, bots, maxPlayers } = setup();
  // 1 human → 3 bots, totals balanced ~2v2.
  players.add("s1", "Alice"); // team A
  bots.reconcile(maxPlayers);
  assertEquals(players.size, 4);

  const before = players.teamCounts();
  assertEquals(before.A + before.B, 4);
  // Expect roughly even teams with 4 players.
  assertEquals(Math.abs(before.A - before.B) <= 1, true);

  // Second human joins fewest-human team (B) and autofill drops one bot.
  const bob = players.add("s2", "Bob");
  bots.reconcile(maxPlayers);

  assertEquals(bob.team, "B");
  assertEquals(bots.count, 2);
  assertEquals(players.size, 4);

  const after = players.teamCounts();
  // Must stay balanced — never 1v3.
  assertEquals(after.A, 2);
  assertEquals(after.B, 2);
  assertEquals(players.humanTeamCounts(), { A: 1, B: 1 });
});

Deno.test("tryEvictOne prefers the join team", () => {
  const { players, bots } = setup();
  players.add("s1", "Alice"); // A
  bots.setNoBotsOnEmptyServer(false);
  bots.addBots(3, 8);
  // A: 1h + bots, B: bots — ensure B has at least one bot.
  const joinTeam = players.pickTeamForHuman(); // B (0 humans)
  assertEquals(joinTeam, "B");

  const botsOnB = players.bots().filter((p) => p.team === "B").length;
  assertEquals(botsOnB >= 1, true);

  const beforeB = players.bots().filter((p) => p.team === "B").length;
  const ok = bots.tryEvictOne(joinTeam);
  assertEquals(ok, true);
  const afterB = players.bots().filter((p) => p.team === "B").length;
  assertEquals(afterB, beforeB - 1);
});

Deno.test("successive humans alternate teams by human count", () => {
  const { players, bots, maxPlayers } = setup();
  bots.setMinPlayers(4);

  const p1 = players.add("s1", "P1");
  bots.reconcile(maxPlayers);
  assertEquals(p1.team, "A");

  const p2 = players.add("s2", "P2");
  bots.reconcile(maxPlayers);
  assertEquals(p2.team, "B");

  const p3 = players.add("s3", "P3");
  bots.reconcile(maxPlayers);
  assertEquals(p3.team, "A");

  const p4 = players.add("s4", "P4");
  bots.reconcile(maxPlayers);
  assertEquals(p4.team, "B");

  assertEquals(players.humanTeamCounts(), { A: 2, B: 2 });
  assertEquals(bots.count, 0);
});

Deno.test("balance bot: adds named bot when teams uneven, drops when even", () => {
  const { players, bots, maxPlayers } = setup();
  // Disable autofill so imbalance is pure humans.
  bots.setMinPlayers(0);
  players.add("h1", "A1", "A");
  players.add("h2", "A2", "A");
  players.add("h3", "B1", "B");
  bots.reconcile(maxPlayers);

  assertEquals(bots.fillBotCount, 0);
  assertEquals(bots.hasBalanceBot(), true);
  assertEquals(bots.count, 1);
  const bal = [...players.all()].find((p) => p.isBalanceBot);
  assertEquals(bal?.name, "bot");
  assertEquals(bal?.team, "B");
  // Standard fit (all zeros).
  assertEquals(bal?.headType, 0);
  assertEquals(bal?.bodyType, 0);
  assertEquals(bal?.legType, 0);
  // With balancer: 2v2 totals.
  assertEquals(players.teamCounts(), { A: 2, B: 2 });

  // Even underlying humans: drop balance bot.
  players.add("h4", "B2", "B");
  bots.reconcile(maxPlayers);
  assertEquals(players.teamCounts(), { A: 2, B: 2 });
  assertEquals(bots.hasBalanceBot(), false);
  assertEquals(bots.count, 0);
});

Deno.test("balance bot: stays while still uneven after one body", () => {
  const { players, bots, maxPlayers } = setup();
  bots.setMinPlayers(0);
  // 3v1 → balance on B → 3v2 (still one short; single named bot only).
  players.add("h1", "A1", "A");
  players.add("h2", "A2", "A");
  players.add("h3", "A3", "A");
  players.add("h4", "B1", "B");
  bots.reconcile(maxPlayers);
  assertEquals(bots.hasBalanceBot(), true);
  assertEquals(players.teamCounts(), { A: 3, B: 2 });
  const bal = [...players.all()].find((p) => p.isBalanceBot);
  assertEquals(bal?.team, "B");
});

Deno.test("balance bot: uses balance-bot brain", () => {
  const { players, bots, maxPlayers } = setup();
  bots.setMinPlayers(0);
  players.add("h1", "A1", "A");
  players.add("h2", "A2", "A");
  players.add("h3", "B1", "B");
  bots.reconcile(maxPlayers);
  assertEquals(bots.hasBalanceBot(), true);
  const info = bots.list().find((b) => b.name === "bot");
  assertEquals(info?.brainId, "balance-bot");
});

Deno.test("balance bot: empty server drops balancer", () => {
  const { players, bots, maxPlayers } = setup();
  bots.setMinPlayers(0);
  players.add("h1", "A1", "A");
  players.add("h2", "A2", "A");
  players.add("h3", "B1", "B");
  bots.reconcile(maxPlayers);
  assertEquals(bots.hasBalanceBot(), true);

  players.remove("h1");
  players.remove("h2");
  players.remove("h3");
  bots.reconcile(maxPlayers);
  assertEquals(bots.hasBalanceBot(), false);
  assertEquals(bots.count, 0);
});

Deno.test("balance bot: counts pool pawns toward evenness", () => {
  const { players, bots, maxPlayers } = setup();
  bots.setMinPlayers(0);
  players.add("h1", "Alice", "A");
  // Two seed-like team bots on B already balance Alice alone once we add one more on B…
  // Start uneven: 1 human A, one regular bot B.
  players.addBot("bot:seed-1", "SeedOne");
  // pickBalancedTeam → B. Totals 1v1 even → no balance bot.
  bots.reconcile(maxPlayers);
  assertEquals(players.teamCounts(), { A: 1, B: 1 });
  assertEquals(bots.hasBalanceBot(), false);

  // Add another human on A → 2v1 → balance bot on B.
  players.add("h2", "Bob", "A");
  bots.reconcile(maxPlayers);
  assertEquals(bots.hasBalanceBot(), true);
  assertEquals(players.teamCounts(), { A: 2, B: 2 });
});

Deno.test("package pipeline batches a phase shard and feeds the delayed apply path", () => {
  const collision = new MapCollision(testMap());
  const players = new PlayerManager(collision);
  const bots = new BotManager(players, {}, {
    thoughtEngine: createBotThinkEngine(),
    fill: { minPlayers: 2 },
  });
  players.add("s1", "Alice");
  bots.reconcile(8);
  const bot = [...players.all()].find((player) => player.isBot);
  assert(bot);

  const firstBotTick = 16;
  thinkAllBotPeriod(bots, firstBotTick, collision);
  assertEquals(bot.isMoveIntent(), false, "batch output remains delayed");

  for (let offset = 1; offset <= THINK_BUFFER_BOT_TICKS; offset++) {
    thinkAllBotPeriod(bots, firstBotTick + offset, collision);
  }
  bots.applyReadyActions(
    botTickToSimTick(firstBotTick + THINK_BUFFER_BOT_TICKS),
     1_000_000,
    () => {},
  );
  assert(
    bot.lastSequence > 0,
    "package ReadyAction reaches the authoritative apply path",
  );
  assertEquals(bots.getBotThinkMetrics().softSlots, 0);
});

Deno.test("pipeline-js-codec round-trips think messages without changing apply", () => {
  const collision = new MapCollision(testMap());
  const players = new PlayerManager(collision);
  const bots = new BotManager(players, {}, {
    thoughtEngine: createBotThinkEngine(),
    thoughtCodecLoop: true,
    fill: { minPlayers: 2 },
  });
  players.add("s1", "Alice");
  bots.reconcile(8);
  const bot = [...players.all()].find((player) => player.isBot);
  assert(bot);

  const firstBotTick = 16;
  thinkAllBotPeriod(bots, firstBotTick, collision);
  for (let offset = 1; offset <= THINK_BUFFER_BOT_TICKS; offset++) {
    thinkAllBotPeriod(bots, firstBotTick + offset, collision);
  }
  bots.applyReadyActions(
    botTickToSimTick(firstBotTick + THINK_BUFFER_BOT_TICKS),
     1_000_000,
    () => {},
  );
  assert(
    bot.lastSequence > 0,
    "codec-loop ReadyAction still reaches apply",
  );
  const metrics = bots.getBotThinkMetrics();
  assertEquals(metrics.runtime, "pipeline-js-codec");
  assert(metrics.codecLoop);
  assert(metrics.codecLoop.samples > 0);
  assertEquals(metrics.codecLoop.mismatches, 0);
});

Deno.test("complete compiled shadow matches the batched JS action", async () => {
  const collision = new MapCollision(testMap());
  const players = new PlayerManager(collision);
  const native = createBotThinkEngine();
  let batches = 0;
  const compiled = {
    loadMap: native.loadMap.bind(native),
    synchronizeBots: native.synchronizeBots.bind(native),
    // deno-lint-ignore require-await -- matches the async pipeline interface
    async thinkBatch(input: Parameters<typeof native.thinkBatch>[0]) {
      batches += 1;
      return {
        output: native.thinkBatch(input),
        roundTripMs: 0.1,
        requestBytes: 100,
      };
    },
    async idle() {},
    snapshot() {
      return {
        status: "ready" as const,
        engineVersion: "test",
        inFlight: 0,
        batches,
        errors: 0,
        meanRoundTripMs: 0.1,
        meanRequestBytes: 100,
      };
    },
    async close() {},
  };
  const bots = new BotManager(players, {}, {
    thoughtEngine: createBotThinkEngine(),
    compiledThoughtEngine: compiled,
    compiledThoughtMode: "shadow",
    fill: { minPlayers: 2 },
  });
  players.add("s1", "Alice");
  bots.reconcile(8);
  thinkAllBotPeriod(bots, 16, collision);
  await Promise.resolve();
  await Promise.resolve();
  const metrics = bots.getBotThinkMetrics().compiledPipeline;
  assert(metrics);
  assertEquals(metrics.mode, "shadow");
  assertEquals(metrics.samples, 1);
  assertEquals(metrics.exactMatches, 1);
  assertEquals(metrics.mismatches, 0);
  assertEquals(bots.getBotThinkMetrics().runtime, "pipeline-compiled-shadow");
});

Deno.test("Deno-compiled host labels pipeline-compiled-deno runtimes", () => {
  const collision = new MapCollision(testMap());
  const players = new PlayerManager(collision);
  const native = createBotThinkEngine();
  const compiled = {
    loadMap: native.loadMap.bind(native),
    synchronizeBots: native.synchronizeBots.bind(native),
    // deno-lint-ignore require-await -- matches the async pipeline interface
    async thinkBatch(input: Parameters<typeof native.thinkBatch>[0]) {
      return {
        output: native.thinkBatch(input),
        roundTripMs: 0,
        requestBytes: 0,
      };
    },
    async idle() {},
    snapshot() {
      return {
        status: "ready" as const,
        engineVersion: "test",
        inFlight: 0,
        batches: 0,
        errors: 0,
        meanRoundTripMs: 0,
        meanRequestBytes: 0,
      };
    },
    async close() {},
  };
  const authority = new BotManager(players, {}, {
    thoughtEngine: null,
    compiledThoughtEngine: compiled,
    compiledThoughtMode: "compiled",
    compiledThoughtHost: "deno",
    fill: { minPlayers: 0, noBotsOnEmptyServer: true },
  });
  const shadow = new BotManager(players, {}, {
    thoughtEngine: createBotThinkEngine(),
    compiledThoughtEngine: compiled,
    compiledThoughtMode: "shadow",
    compiledThoughtHost: "deno",
    fill: { minPlayers: 0, noBotsOnEmptyServer: true },
  });
  assertEquals(authority.getBotThinkMetrics().runtime, "pipeline-compiled-deno");
  assertEquals(
    shadow.getBotThinkMetrics().runtime,
    "pipeline-compiled-deno-shadow",
  );
});

Deno.test("complete compiled authority replaces its deadline fallback slot", async () => {
  const collision = new MapCollision(testMap());
  const players = new PlayerManager(collision);
  const native = createBotThinkEngine();
  const compiled = {
    loadMap: native.loadMap.bind(native),
    synchronizeBots: native.synchronizeBots.bind(native),
    // deno-lint-ignore require-await -- matches the async pipeline interface
    async thinkBatch(input: Parameters<typeof native.thinkBatch>[0]) {
      return {
        output: native.thinkBatch(input),
        roundTripMs: 0.1,
        requestBytes: 100,
      };
    },
    async idle() {},
    snapshot() {
      return {
        status: "ready" as const,
        engineVersion: "test",
        inFlight: 0,
        batches: 1,
        errors: 0,
        meanRoundTripMs: 0.1,
        meanRequestBytes: 100,
      };
    },
    async close() {},
  };
  const bots = new BotManager(players, {}, {
    compiledThoughtEngine: compiled,
    compiledThoughtMode: "compiled",
    fill: { minPlayers: 2 },
  });
  players.add("s1", "Alice");
  bots.reconcile(8);
  const bot = [...players.all()].find((player) => player.isBot);
  assert(bot);
  const firstBotTick = 16;
  thinkAllBotPeriod(bots, firstBotTick, collision);
  await Promise.resolve();
  await Promise.resolve();
  const metrics = bots.getBotThinkMetrics().compiledPipeline;
  assert(metrics);
  assertEquals(metrics.compiledApplied, 1);
  assertEquals(metrics.compiledFallbacks, 0);
  bots.applyReadyActions(
    botTickToSimTick(firstBotTick + THINK_BUFFER_BOT_TICKS),
     1_000_000,
    () => {},
  );
  assert(bot.lastSequence > 0);
});

function fakeCompiledPipeline(
  thinkBatch: (
    input: Parameters<ReturnType<typeof createBotThinkEngine>["thinkBatch"]>[0],
  ) => Promise<{
    output: ReturnType<ReturnType<typeof createBotThinkEngine>["thinkBatch"]>;
    roundTripMs: number;
    requestBytes: number;
  }>,
  native: ReturnType<typeof createBotThinkEngine> = createBotThinkEngine(),
) {
  return {
    loadMap: native.loadMap.bind(native),
    synchronizeBots: native.synchronizeBots.bind(native),
    thinkBatch,
    async idle() {},
    snapshot() {
      return {
        status: "ready" as const,
        engineVersion: "test",
        inFlight: 0,
        batches: 1,
        errors: 0,
        meanRoundTripMs: 0.1,
        meanRequestBytes: 100,
      };
    },
    async close() {},
  };
}

async function flushCompiled(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

Deno.test("compiled authority enqueues an on-time native action without last-move", async () => {
  const collision = new MapCollision(testMap());
  const players = new PlayerManager(collision);
  const engine = createBotThinkEngine();
  let release: (() => void) | undefined;
  const compiled = fakeCompiledPipeline((input) => {
    const output = engine.thinkBatch(input);
    return new Promise((resolve) => {
      release = () =>
        resolve({
          output,
          roundTripMs: 0.1,
          requestBytes: 100,
        });
    });
  }, engine);
  const bots = new BotManager(players, {}, {
    compiledThoughtEngine: compiled,
    compiledThoughtMode: "compiled",
    fill: { minPlayers: 2 },
  });
  players.add("s1", "Alice");
  bots.reconcile(8);
  const bot = [...players.all()].find((player) => player.isBot);
  assert(bot);
  const firstBotTick = 16;
  thinkAllBotPeriod(bots, firstBotTick, collision);
  bots.applyReadyActions(
    botTickToSimTick(firstBotTick + THINK_BUFFER_BOT_TICKS),
     1_000_000,
    () => {},
  );
  assertEquals(bot.lastSequence, 0, "hold interpolator; no last-move slot");
  assert(release);
  release();
  await flushCompiled();
  const metrics = bots.getBotThinkMetrics().compiledPipeline;
  assert(metrics);
  assertEquals(metrics.compiledApplied, 1);
  assertEquals(metrics.compiledFallbacks, 0);
  assertEquals(metrics.compiledFallbackNull, 0);
  bots.applyReadyActions(
    botTickToSimTick(firstBotTick + THINK_BUFFER_BOT_TICKS),
     1_000_000,
    () => {},
  );
  assert(bot.lastSequence > 0);
});

Deno.test("compiled authority does not apply a native null action", async () => {
  const collision = new MapCollision(testMap());
  const players = new PlayerManager(collision);
  // deno-lint-ignore require-await -- matches the async pipeline interface
  const compiled = fakeCompiledPipeline(async (input) => ({
    output: {
      tick: input.frame.tick,
      applyTick: input.applyTick,
      mapRevision: input.frame.mapRevision,
      decisions: input.bots.map((bot) => ({
        botId: bot.botId,
        spawnedAtTick: bot.spawnedAtTick,
        action: null,
      })),
    },
    roundTripMs: 0.1,
    requestBytes: 100,
  }));
  const bots = new BotManager(players, {}, {
    compiledThoughtEngine: compiled,
    compiledThoughtMode: "compiled",
    fill: { minPlayers: 2 },
  });
  players.add("s1", "Alice");
  bots.reconcile(8);
  const bot = [...players.all()].find((player) => player.isBot);
  assert(bot);
  const firstBotTick = 16;
  thinkAllBotPeriod(bots, firstBotTick, collision);
  await flushCompiled();
  const metrics = bots.getBotThinkMetrics().compiledPipeline;
  assert(metrics);
  assertEquals(metrics.compiledApplied, 0);
  assertEquals(metrics.compiledFallbackNull, 1);
  assertEquals(metrics.compiledFallbacks, 1);
  bots.applyReadyActions(
    botTickToSimTick(firstBotTick + THINK_BUFFER_BOT_TICKS),
     1_000_000,
    () => {},
  );
  assertEquals(bot.lastSequence, 0);
});

Deno.test("compiled authority discards a late native result and keeps holding", async () => {
  const collision = new MapCollision(testMap());
  const players = new PlayerManager(collision);
  const engine = createBotThinkEngine();
  let release: (() => void) | undefined;
  const compiled = fakeCompiledPipeline((input) => {
    const output = engine.thinkBatch(input);
    return new Promise((resolve) => {
      release = () =>
        resolve({
          output,
          roundTripMs: 0.1,
          requestBytes: 100,
        });
    });
  }, engine);
  const bots = new BotManager(players, {}, {
    compiledThoughtEngine: compiled,
    compiledThoughtMode: "compiled",
    fill: { minPlayers: 2 },
  });
  players.add("s1", "Alice");
  bots.reconcile(8);
  const bot = [...players.all()].find((player) => player.isBot);
  assert(bot);
  const firstBotTick = 16;
  thinkAllBotPeriod(bots, firstBotTick, collision);
  players.update(botTickToSimTick(firstBotTick + THINK_BUFFER_BOT_TICKS));
  assert(release);
  release();
  await flushCompiled();
  const metrics = bots.getBotThinkMetrics().compiledPipeline;
  assert(metrics);
  assertEquals(metrics.compiledApplied, 0);
  assertEquals(metrics.compiledFallbackLate, 1);
  bots.applyReadyActions(
    botTickToSimTick(firstBotTick + THINK_BUFFER_BOT_TICKS),
     1_000_000,
    () => {},
  );
  assertEquals(bot.lastSequence, 0);
});

Deno.test("compiled authority does not enqueue last-move when the worker is down", async () => {
  const collision = new MapCollision(testMap());
  const players = new PlayerManager(collision);
  const compiled = fakeCompiledPipeline(() => {
    return Promise.reject(new Error("compiled pipeline is unavailable"));
  });
  const bots = new BotManager(players, {}, {
    compiledThoughtEngine: compiled,
    compiledThoughtMode: "compiled",
    fill: { minPlayers: 2 },
  });
  players.add("s1", "Alice");
  bots.reconcile(8);
  const bot = [...players.all()].find((player) => player.isBot);
  assert(bot);
  const firstBotTick = 16;
  thinkAllBotPeriod(bots, firstBotTick, collision);
  await flushCompiled();
  const metrics = bots.getBotThinkMetrics().compiledPipeline;
  assert(metrics);
  assertEquals(metrics.compiledApplied, 0);
  assertEquals(metrics.compiledFallbackUnavailable, 1);
  bots.applyReadyActions(
    botTickToSimTick(firstBotTick + THINK_BUFFER_BOT_TICKS),
     1_000_000,
    () => {},
  );
  assertEquals(bot.lastSequence, 0);
});

Deno.test("compiled authority skips dead bots and drops WASD on respawn", async () => {
  const collision = new MapCollision(testMap());
  const players = new PlayerManager(collision);
  let thinkCalls = 0;
  // deno-lint-ignore require-await -- matches the async pipeline interface
  const compiled = fakeCompiledPipeline(async (input) => {
    thinkCalls += 1;
    return {
      output: {
        tick: input.frame.tick,
        applyTick: input.applyTick,
        mapRevision: input.frame.mapRevision,
        decisions: input.bots.map((entry) => ({
          botId: entry.botId,
          spawnedAtTick: entry.spawnedAtTick,
          action: {
            input: {
              forward: true,
              backward: false,
              left: false,
              right: false,
              jump: false,
              sprint: false,
              crouch: false,
              yaw: 0,
              pitch: 0,
            },
          },
        })),
      },
      roundTripMs: 0.1,
      requestBytes: 100,
    };
  });
  const bots = new BotManager(players, {}, {
    compiledThoughtEngine: compiled,
    compiledThoughtMode: "compiled",
    fill: { minPlayers: 2 },
  });
  players.add("s1", "Alice");
  bots.reconcile(8);
  const bot = [...players.all()].find((player) => player.isBot);
  assert(bot);
  const firstBotTick = 16;
  thinkAllBotPeriod(bots, firstBotTick, collision);
  await flushCompiled();
  bots.applyReadyActions(
    botTickToSimTick(firstBotTick + THINK_BUFFER_BOT_TICKS),
     1_000_000,
    () => {},
  );
  assertEquals(
    (bot.toSnapshot().keys ?? 0) & SNAP_KEY_FORWARD,
    SNAP_KEY_FORWARD,
  );

  // Real death path (Player.becomeDead nulls latestInput) — the driver no
  // longer synthesizes an idle handleInput of its own (keys-only PR 5).
  // Past spawn invulnerability; unrelated to the bot-tick scheduling below.
  const deathTick = 10_000;
  bot.takeDamage(999, "body", deathTick, Date.now());
  assertEquals(bot.alive, false);
  const thinksBeforeDeath = thinkCalls;
  thinkAllBotPeriod(bots, firstBotTick + 1, collision);
  await flushCompiled();
  assertEquals(thinkCalls, thinksBeforeDeath);

  // Real respawn path (Player.respawn nulls latestInput); the driver only
  // drops the stale queue, it never re-inputs.
  bot.respawn({ x: 0, y: 0, z: 0 }, deathTick + 1);
  bots.applyReadyActions(botTickToSimTick(firstBotTick + 1), 1_000_000, () => {});
  assertEquals(bot.toSnapshot().keys ?? 0, 0);
});

Deno.test("community and balance bots never own skills", () => {
  const { players, bots, maxPlayers } = setup();
  players.add("s1", "Alice");
  bots.reconcile(maxPlayers);
  for (const p of players.bots()) {
    assertEquals(p.snapshotOwnedAbilities(), []);
    const loadout = p.snapshotSkillLoadout();
    assert(loadout != null);
    assertEquals(loadout!.every((s) => s === null), true);
  }
});

// --- S9-PR3: bulk eviction + deferred admission reconcile --------------------

Deno.test("S9-PR3: tryEvict removes multiple ordinary bots", () => {
  const { players, bots } = setup();
  bots.setMinPlayers(0);
  bots.setNoBotsOnEmptyServer(false);
  bots.addBots(6, 8);
  assertEquals(bots.fillBotCount, 6);
  const removed = bots.tryEvict(3);
  assertEquals(removed, 3);
  assertEquals(bots.fillBotCount, 3);
  assertEquals(players.size, 3);
});

Deno.test("S9-PR3: tryEvict prefers preferredTeam then falls back", () => {
  const { players, bots } = setup();
  players.add("s1", "Alice", "A");
  bots.setNoBotsOnEmptyServer(false);
  bots.addBots(4, 8);
  const onB = players.bots().filter((p) => p.team === "B").length;
  assert(onB >= 1, "expected bots on B");
  const beforeB = players.bots().filter((p) => p.team === "B").length;
  const removed = bots.tryEvict(2, "B");
  assertEquals(removed, 2);
  const afterB = players.bots().filter((p) => p.team === "B").length;
  // Prefer B: at least one of the two came from B when available.
  assert(afterB <= beforeB, "expected B-side bots to shrink first");
});

Deno.test("S9-PR3: admission batch defers reconcile until finish", () => {
  const { players, bots, maxPlayers } = setup();
  bots.setMinPlayers(4);
  // Empty → first human would normally fill to 3 bots.
  bots.startAdmissionBatch();
  assertEquals(bots.isAdmissionBatchActive(), true);
  players.add("s1", "A1", "A", { partyId: "op_a", partySize: 2 });
  bots.onHumanJoined(maxPlayers);
  // Deferred: still no fill bots until finish.
  assertEquals(bots.fillBotCount, 0);
  players.add("s2", "A2", "A", { partyId: "op_a", partySize: 2 });
  bots.onHumanJoined(maxPlayers);
  assertEquals(bots.fillBotCount, 0);

  const report = bots.finishAdmissionBatch(maxPlayers);
  assertEquals(bots.isAdmissionBatchActive(), false);
  // 2 humans, autofill 4 → 2 fill bots.
  assertEquals(report.fillBotCount, 2);
  assertEquals(bots.fillBotCount, 2);
  assertEquals(report.humanCount, 2);
  assertEquals(report.botsEvicted, 0);
});

Deno.test("S9-PR3: admission batch counts bulk eviction in report", () => {
  const { players, bots, maxPlayers } = setup();
  bots.setMinPlayers(8);
  bots.setNoBotsOnEmptyServer(false);
  bots.reconcile(maxPlayers);
  assertEquals(bots.fillBotCount, 8);

  bots.startAdmissionBatch();
  const evicted = bots.tryEvict(3, "A");
  assertEquals(evicted, 3);
  assertEquals(bots.admissionBatchEvictedCount(), 3);
  players.add("h1", "H1", "A", { partyId: "op_p", partySize: 3 });
  bots.onHumanJoined(maxPlayers);
  players.add("h2", "H2", "A", { partyId: "op_p", partySize: 3 });
  bots.onHumanJoined(maxPlayers);
  players.add("h3", "H3", "A", { partyId: "op_p", partySize: 3 });
  bots.onHumanJoined(maxPlayers);

  const report = bots.finishAdmissionBatch(maxPlayers);
  assertEquals(report.botsEvicted, 3);
  assertEquals(report.humanCount, 3);
  // autofill target 8 with 3 humans → 5 fill (capped by free seats).
  assertEquals(report.fillBotCount + report.humanCount <= maxPlayers, true);
});

Deno.test("S9-PR3: leave mid-batch forces immediate settle", () => {
  const { players, bots, maxPlayers } = setup();
  bots.setMinPlayers(4);
  bots.startAdmissionBatch();
  const a = players.add("s1", "A1", "A", { partyId: "op_x", partySize: 2 });
  bots.onHumanJoined(maxPlayers);
  assertEquals(bots.fillBotCount, 0);
  players.remove(a.id);
  bots.onHumanLeft(maxPlayers);
  assertEquals(bots.isAdmissionBatchActive(), false);
  // Empty server + noBotsOnEmptyServer → no bots.
  assertEquals(bots.fillBotCount, 0);
});

Deno.test("package think enqueues; applyReadyActions applies after THINK_BUFFER_BOT_TICKS", () => {
  const collision = new MapCollision(testMap());
  const players = new PlayerManager(collision);
  const bots = new BotManager(players, {}, {
    thoughtEngine: createBotThinkEngine(),
    fill: { minPlayers: 2 },
  });
  players.add("s1", "Alice");
  bots.reconcile(8);
  const bot = [...players.all()].find((p) => p.isBot);
  assert(bot);

  thinkAllBotPeriod(bots, 16, collision);
  assertEquals(bot.isMoveIntent(), false, "think must not queue PlayerInput");
  bots.applyReadyActions(botTickToSimTick(16), 1_000_000, () => {});
  assertEquals(bot.isMoveIntent(), false, "no apply until delay elapses");
  bots.applyReadyActions(botTickToSimTick(16 + THINK_BUFFER_BOT_TICKS), 1_000_000, () => {});
  assert(bot.lastSequence > 0);
});

Deno.test("bots stop via think-emitted idle keys after match over", () => {
  const collision = new MapCollision(testMap());
  const players = new PlayerManager(collision);
  const bots = new BotManager(players, {}, {
    thoughtEngine: createBotThinkEngine(),
    fill: { minPlayers: 2 },
  });
  players.add("s1", "Alice");
  bots.reconcile(8);
  const bot = [...players.all()].find((p) => p.isBot);
  assert(bot);

  const start = botTickToSimTick(33);
  tickBotPeriods(bots, collision, start, THINK_BUFFER_BOT_TICKS + 1);
  const overTick = start +
    (THINK_BUFFER_BOT_TICKS + 1) * SIM_TICKS_PER_BOT_TICK;
  const over = players.forceDraw(overTick);
  assertEquals(over?.winner, "draw");

  // Idle keys are think-authored, not apply-time synthesis: draining the
  // pre-matchOver queue and a fresh think round trip takes up to
  // THINK_BUFFER_BOT_TICKS bot periods before movement actually stops.
  let sim = overTick + 1;
  let shots: ReturnType<typeof bots.tick> = [];
  for (let period = 0; period < THINK_BUFFER_BOT_TICKS + 2; period++) {
    for (let p = 0; p < SIM_TICKS_PER_BOT_TICK; p++) {
      shots = bots.tick(sim + p, collision);
    }
    sim += SIM_TICKS_PER_BOT_TICK;
  }
  assertEquals(shots.length, 0, "no shots during endgame");
  assertEquals(
    bot.isMoveIntent(),
    false,
    "held WASD stops via think-emitted idle keys",
  );
});

Deno.test("respawned bot does not replay pre-death queued keys", () => {
  const collision = new MapCollision(testMap());
  const players = new PlayerManager(collision);
  const bots = new BotManager(players, {}, {
    thoughtEngine: createBotThinkEngine(),
    fill: { minPlayers: 2 },
  });
  players.add("s1", "Alice");
  bots.reconcile(8);
  const bot = [...players.all()].find((p) => p.isBot);
  assert(bot);

  const start = botTickToSimTick(33);
  // Run enough live bot periods that movement is queued ahead of the apply
  // horizon (THINK_BUFFER_BOT_TICKS always keeps a few due-slots in flight).
  const deathTick = tickBotPeriods(
    bots,
    collision,
    start,
    THINK_BUFFER_BOT_TICKS + 3,
  );
  bot.takeDamage(999, "body", deathTick, Date.now());
  assertEquals(bot.alive, false);

  // Respawn before the pre-death queue would have drained on its own.
  bot.respawn({ x: 0, y: 0, z: 0 }, deathTick + 1);
  assertEquals(bot.isMoveIntent(), false, "new life starts idle");

  // Drain the (now-stale) pre-death queue window; none of it should apply
  // to the new life — the driver only drops stale slots, it never re-inputs.
  const horizon = deathTick + 1 + THINK_BUFFER_BOT_TICKS * SIM_TICKS_PER_BOT_TICK;
  for (let sim = deathTick + 1; sim < horizon; sim++) {
    bots.applyReadyActions(sim, 1_000_000, () => {});
    assertEquals(
      bot.isMoveIntent(),
      false,
      "pre-death queued WASD must not replay onto the new life",
    );
  }
});

Deno.test("BotManager never calls handleInput directly (only the apply pipe does)", () => {
  const src = Deno.readTextFileSync(
    new URL("./BotManager.ts", import.meta.url),
  );
  assertEquals(
    src.includes(".handleInput("),
    false,
    "bot-originated input must flow through runApplyPipe's stampAndInput step, never be synthesized in BotManager",
  );
});

Deno.test("thinkAll thinks each bot once per bot period (phase shards)", () => {
  const collision = new MapCollision(testMap());
  const players = new PlayerManager(collision);
  const bots = new BotManager(players, {}, {
    thoughtEngine: createBotThinkEngine(),
    fill: { minPlayers: 4 },
  });
  players.add("s1", "Alice");
  bots.reconcile(8);
  assertEquals(bots.count, 3);
  const botIds = [...players.all()].filter((p) => p.isBot).map((p) => p.id);
  const base = botTickToSimTick(20);
  let thought = 0;
  for (let phase = 0; phase < SIM_TICKS_PER_BOT_TICK; phase++) {
    bots.thinkAll(base + phase, collision);
    thought += bots.getBotThinkMetrics().lastThinkBots;
  }
  assertEquals(thought, botIds.length);
  bots.thinkAll(base, collision);
  assertEquals(bots.getBotThinkMetrics().lastThinkBots, 0);
});
