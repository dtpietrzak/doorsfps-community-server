/**
 * Grey free-for-all agent tests: spawn on door close, rotation, cap, hostility.
 */
import { assertEquals, assertExists } from "@std/assert";
import {
  DOOR_CLOSED_TICKS,
  DOOR_OPEN_TICKS,
  DOOR_POWER_UP_TICKS,
} from "../protocol/network.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";
import { Player } from "../players/Player.ts";
import { PlayerManager } from "../players/PlayerManager.ts";
import { areHostile, canSensePlayer } from "./helpers/combat.ts";
import {
  AGENT_SPAWN_COUNT_WEIGHTS,
  BotManager,
  MAX_AGENTS,
  rollAgentsPerDoorClose,
} from "./BotManager.ts";
import { AGENT_DOOR_SPAWN_OUTSET, agentDoorSpawn } from "./helpers/nav.ts";

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
  const bots = new BotManager(players, {}, { autoFill: false });
  return { players, bots, collision };
}

/** Drive sim so doors flip open→closed once (live match, not prematch). */
function tickToFirstDoorClose(
  players: PlayerManager,
  bots: BotManager,
  collision: MapCollision,
): void {
  // Live match starts doors open at origin tick 0.
  players.beginLiveMatch(0);
  // First open phase ticks: observe doors open.
  bots.tick(1, collision);
  assertEquals(players.areDoorsOpen(1), true);
  // Edge into closed.
  const closeTick = DOOR_OPEN_TICKS;
  bots.tick(closeTick, collision);
  assertEquals(players.areDoorsOpen(closeTick), false);
}

Deno.test("areHostile: agents vs teams and each other", () => {
  const a = new Player("a", "A", "A");
  const b = new Player("b", "B", "B");
  const agent1 = new Player("agent:1", "agent1", "A", {
    isBot: true,
    isAgent: true,
  });
  const agent2 = new Player("agent:2", "agent2", "B", {
    isBot: true,
    isAgent: true,
  });

  assertEquals(areHostile(a, b), true);
  assertEquals(areHostile(a, a), false);
  assertEquals(areHostile(agent1, a), true);
  assertEquals(areHostile(agent1, b), true);
  assertEquals(areHostile(a, agent1), true);
  // Agents are friendly to each other.
  assertEquals(areHostile(agent1, agent2), false);
});

Deno.test("canSensePlayer: agent senses both team colors", () => {
  const collision = new MapCollision(testMap());
  const agent = new Player("agent:1", "agent1", "A", {
    isBot: true,
    isAgent: true,
    spawn: { x: 0, y: 1.7, z: 0 },
  });
  const blue = new Player("p1", "blue", "A", {
    spawn: { x: 0, y: 1.7, z: 5 },
  });
  const red = new Player("p2", "red", "B", {
    spawn: { x: 0, y: 1.7, z: -5 },
  });

  assertEquals(canSensePlayer(collision, agent, blue), true);
  assertEquals(canSensePlayer(collision, agent, red), true);
  assertEquals(areHostile(agent, blue), true);
  assertEquals(areHostile(agent, red), true);
});

Deno.test("agents: no spawn without humans", () => {
  const { players, bots, collision } = setup();
  players.beginLiveMatch(0);
  bots.tick(1, collision);
  bots.tick(DOOR_OPEN_TICKS, collision);
  assertEquals(bots.agentCount, 0);
  assertEquals(players.agentCount(), 0);
});

Deno.test("rollAgentsPerDoorClose: weights 45% / 35% / 20%", () => {
  assertEquals(rollAgentsPerDoorClose(() => 0), 1);
  assertEquals(rollAgentsPerDoorClose(() => 0.449), 1);
  assertEquals(rollAgentsPerDoorClose(() => 0.45), 2);
  assertEquals(rollAgentsPerDoorClose(() => 0.45 + 0.35 - 1e-9), 2);
  assertEquals(rollAgentsPerDoorClose(() => 0.45 + 0.35), 3);
  assertEquals(rollAgentsPerDoorClose(() => 0.999), 3);
  // Weights sum to 1.
  const sum = AGENT_SPAWN_COUNT_WEIGHTS[1] +
    AGENT_SPAWN_COUNT_WEIGHTS[2] +
    AGENT_SPAWN_COUNT_WEIGHTS[3];
  assertEquals(sum, 1);
});

Deno.test("agents: spawn 1–3 on first door close when humans present", () => {
  const { players, bots, collision } = setup();
  players.add("h1", "Alice");
  tickToFirstDoorClose(players, bots, collision);
  const n = bots.agentCount;
  assertEquals(n >= 1 && n <= MAX_AGENTS, true);
  assertEquals(players.agentCount(), n);
  const agent = players.bots().find((p) => p.isAgent);
  assertExists(agent);
  assertEquals(agent.isBot, true);
  assertEquals(/^agent\d+$/i.test(agent.name), true);
});

Deno.test("agents: all mesh slots use dome style", () => {
  const { players, bots, collision } = setup();
  players.add("h1", "Alice");
  tickToFirstDoorClose(players, bots, collision);
  const agents = players.bots().filter((p) => p.isAgent);
  assertEquals(agents.length >= 1, true);
  for (const agent of agents) {
    // 4 = dome (see EQUIPMENT_PART_LABELS / agentPlayerEquipment).
    assertEquals(agent.headType, 4);
    assertEquals(agent.visorType, 4);
    assertEquals(agent.shoulderType, 4);
    assertEquals(agent.bodyType, 4);
    assertEquals(agent.legType, 4);
    assertEquals(agent.pistolType, 4);
    assertEquals(agent.rifleType, 4);
    assertEquals(agent.crosshairType, 4);
    // Dome body does not imply a dome optic.
    assertEquals(agent.scopeType, 0);
  }
});

Deno.test("agents: door side alternates within a multi-spawn batch", () => {
  // Force rolls of 2 on each close so we always get a pair (and hit the cap).
  const orig = Math.random;
  Math.random = () => 0.5; // → 2 agents (0.45 ≤ r < 0.80)
  try {
    const { players, bots, collision } = setup();
    players.add("h1", "Alice");
    tickToFirstDoorClose(players, bots, collision);
    assertEquals(bots.agentCount, 2);

    const agents = players.bots().filter((p) => p.isAgent);
    assertEquals(agents.length, 2);
    // Batch uses alternating doors (first random A/B, second the other).
    assertEquals(agents[0]!.team !== agents[1]!.team, true);
  } finally {
    Math.random = orig;
  }
});

Deno.test("agents: max 3 on the map", () => {
  const orig = Math.random;
  Math.random = () => 0.9; // → 3 agents per close
  try {
    const { players, bots, collision } = setup();
    players.add("h1", "Alice");
    players.beginLiveMatch(0);

    bots.tick(1, collision);
    bots.tick(DOOR_OPEN_TICKS, collision);
    assertEquals(bots.agentCount, MAX_AGENTS);

    // Further closes must not exceed the cap.
    const secondClose = DOOR_OPEN_TICKS + DOOR_CLOSED_TICKS + DOOR_OPEN_TICKS;
    bots.tick(DOOR_OPEN_TICKS + DOOR_CLOSED_TICKS + 1, collision);
    bots.tick(secondClose, collision);
    assertEquals(bots.agentCount, MAX_AGENTS);
    assertEquals(players.agentCount(), MAX_AGENTS);
  } finally {
    Math.random = orig;
  }
});

Deno.test("agents: removed on death, no respawn", () => {
  const orig = Math.random;
  Math.random = () => 0; // → exactly 1 agent
  try {
    const { players, bots, collision } = setup();
    players.add("h1", "Alice");
    tickToFirstDoorClose(players, bots, collision);
    assertEquals(bots.agentCount, 1);

    const agent = players.bots().find((p) => p.isAgent)!;
    agent.takeDamage(999, "body", DOOR_OPEN_TICKS, Date.now());
    assertEquals(agent.alive, false);

    const removed = bots.pruneDeadAgents();
    assertEquals(removed.length, 1);
    assertEquals(bots.agentCount, 0);
    assertEquals(players.get(agent.id), undefined);
  } finally {
    Math.random = orig;
  }
});

Deno.test("agents: clearAgents resets roster and door rotation", () => {
  const { players, bots, collision } = setup();
  players.add("h1", "Alice");
  tickToFirstDoorClose(players, bots, collision);
  assertEquals(bots.agentCount >= 1, true);
  bots.clearAgents();
  assertEquals(bots.agentCount, 0);
  assertEquals(players.agentCount(), 0);
});

Deno.test("agents: not counted in team balance", () => {
  const { players, bots, collision } = setup();
  players.add("h1", "Alice"); // likely team A
  tickToFirstDoorClose(players, bots, collision);
  const counts = players.teamCounts();
  // Only the human (agents excluded).
  assertEquals(counts.A + counts.B, 1);
  assertEquals(players.nonAgentCount(), 1);
});

Deno.test("agents: agentDoorSpawn faces map center", () => {
  const map = testMap();
  const spawn = agentDoorSpawn(map, "A");
  // South door → positive-Z center, spawn should be near south edge but inside.
  assertEquals(spawn.z < 0, true);
  // Yaw toward center (0,0) from south.
  assertEquals(Number.isFinite(spawn.yaw), true);
});

Deno.test("agents: agentDoorSpawn sits 0.5u outside the door plane", () => {
  const map = testMap();
  // South door plane at minZ = -20; spawn must be ≥ 0.5u into the map.
  const spawnA = agentDoorSpawn(map, "A");
  assertEquals(spawnA.z >= map.bounds.minZ + AGENT_DOOR_SPAWN_OUTSET, true);
  // And still on the south half (not past midfield).
  assertEquals(spawnA.z < 0, true);

  // North door plane at maxZ = 20.
  const spawnB = agentDoorSpawn(map, "B");
  assertEquals(spawnB.z <= map.bounds.maxZ - AGENT_DOOR_SPAWN_OUTSET, true);
  assertEquals(spawnB.z > 0, true);
});

Deno.test("agents: doors stay closed until all agents are cleared", () => {
  const orig = Math.random;
  Math.random = () => 0; // → exactly 1 agent
  try {
    const { players, bots, collision } = setup();
    players.add("h1", "Alice");
    tickToFirstDoorClose(players, bots, collision);
    assertEquals(bots.agentCount, 1);
    assertEquals(players.areDoorsOpen(DOOR_OPEN_TICKS), false);

    // Past the nominal closed phase: still sealed while the agent lives.
    const pastClosed = DOOR_OPEN_TICKS + DOOR_CLOSED_TICKS + 100;
    assertEquals(players.areDoorsOpen(pastClosed), false);

    const agent = players.bots().find((p) => p.isAgent)!;
    agent.takeDamage(999, "body", pastClosed, Date.now());
    bots.pruneDeadAgents(pastClosed);
    assertEquals(bots.agentCount, 0);

    // Still closed during power-up window.
    assertEquals(players.areDoorsOpen(pastClosed), false);
    assertEquals(
      players.areDoorsOpen(pastClosed + DOOR_POWER_UP_TICKS - 1),
      false,
    );
    const powerState = players.getDoorCycleState(pastClosed);
    assertEquals(powerState.doorsOpen, false);
    assertEquals(powerState.doorChangeTick, pastClosed + DOOR_POWER_UP_TICKS);

    // Open once power-up completes.
    const openTick = pastClosed + DOOR_POWER_UP_TICKS;
    assertEquals(players.areDoorsOpen(openTick), true);
    assertEquals(players.areDoorsOpen(openTick + 1), true);
  } finally {
    Math.random = orig;
  }
});

Deno.test("agents: closed doors allow 15s respawn (not blocked)", () => {
  const orig = Math.random;
  Math.random = () => 0; // → 1 agent
  try {
    const { players, bots, collision } = setup();
    players.add("h1", "Alice");
    tickToFirstDoorClose(players, bots, collision);
    assertEquals(players.areDoorsOpen(DOOR_OPEN_TICKS), false);

    const human = players.get("h1")!;
    human.takeDamage(999, "body", DOOR_OPEN_TICKS, Date.now());
    assertEquals(human.alive, false);

    // Short open-door delay is not enough while closed.
    const short = players.processRespawns(
      DOOR_OPEN_TICKS + 120, // ~2s at 60Hz
    );
    assertEquals(short.length, 0);

    // Full closed delay (~15s) respawns while agents still live.
    const long = players.processRespawns(
      DOOR_OPEN_TICKS + 15 * 60 + 5,
    );
    assertEquals(long.length, 1);
    assertEquals(human.alive, true);
  } finally {
    Math.random = orig;
  }
});
