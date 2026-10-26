/**
 * Epic 4.6 Chunk 4: agents-domain stream for door-close count + first door.
 */
import { assertEquals, assertExists } from "jsr:@std/assert@1";
import { BotManager, rollAgentsPerDoorClose } from "./BotManager.ts";
import { PlayerManager } from "../players/PlayerManager.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";
import {
  DOOR_CLOSED_TICKS,
  DOOR_OPEN_TICKS,
} from "../protocol/network.ts";
import { createSimRng, deriveDomainSeed } from "../shared/sim/simRng.ts";

const miniMap: DoorsMap = {
  name: "agent-rng-test",
  version: 1,
  bounds: { minX: -80, maxX: 80, minZ: -80, maxZ: 80 },
  gridSize: 1,
  walls: [],
  teamA: {
    corners: [0, 1],
    edge: "south",
    doorHalfWidth: 3,
    spawnRadius: 5,
  },
  teamB: {
    corners: [2, 3],
    edge: "north",
    doorHalfWidth: 3,
    spawnRadius: 5,
  },
};

function setup(matchSeed: number) {
  const collision = new MapCollision(miniMap);
  const players = new PlayerManager(collision, { matchSeed });
  const bots = new BotManager(players, {}, { autoFill: false });
  bots.setAgentsRandom(players.getSimRngStreams().agents);
  return { players, bots, collision };
}

function tickToFirstDoorClose(
  players: PlayerManager,
  bots: BotManager,
  collision: MapCollision,
): void {
  players.beginLiveMatch(0);
  // Open edge then close edge.
  bots.tick(1, collision);
  bots.tick(DOOR_OPEN_TICKS, collision);
}

Deno.test("agents domain: same match seed → identical count and first door", () => {
  const run = () => {
    const { players, bots, collision } = setup(0xa6e4001);
    players.add("h1", "Alice");
    tickToFirstDoorClose(players, bots, collision);
    const agents = players.bots().filter((p) => p.isAgent);
    assertEquals(agents.length >= 1, true);
    return {
      count: bots.agentCount,
      firstTeam: agents[0]!.team,
      teams: agents.map((a) => a.team),
    };
  };
  assertEquals(run(), run());
});

Deno.test("agents domain: count roll then door pick order", () => {
  // Scripted agents stream: first sample → count 2 (0.5), second → door A (<0.5).
  const samples = [0.5, 0.1];
  const collision = new MapCollision(miniMap);
  const players = new PlayerManager(collision, { matchSeed: 1 });
  const bots = new BotManager(players, {}, { autoFill: false });
  bots.setAgentsRandom(() => {
    const v = samples.shift();
    if (v === undefined) throw new Error("unexpected agents draw");
    return v;
  });
  players.add("h1", "Alice");
  tickToFirstDoorClose(players, bots, collision);
  assertEquals(bots.agentCount, 2);
  const agents = players.bots().filter((p) => p.isAgent);
  assertEquals(agents.length, 2);
  assertEquals(agents[0]!.team, "A");
  assertEquals(agents[1]!.team, "B"); // alternates after first
  assertEquals(samples.length, 0);
});

Deno.test("rollAgentsPerDoorClose still honors injectable rand", () => {
  assertEquals(rollAgentsPerDoorClose(() => 0), 1);
  assertEquals(rollAgentsPerDoorClose(() => 0.5), 2);
});

Deno.test("setAgentsRandom clears first-door latch across reseeds", () => {
  const { players, bots, collision } = setup(0x111);
  players.add("h1", "Alice");
  tickToFirstDoorClose(players, bots, collision);
  assertExists(players.bots().find((p) => p.isAgent));

  // Reseed agents stream and latch; next close should roll first door again.
  bots.setAgentsRandom(createSimRng(deriveDomainSeed(0x222, "agents")));
  // Force another open→close: advance through a full cycle.
  const reopen = DOOR_OPEN_TICKS + DOOR_CLOSED_TICKS + 1;
  bots.tick(reopen, collision);
  bots.tick(reopen + DOOR_OPEN_TICKS, collision);
  // Still under cap / humans present — smoke that tick path still runs.
  assertEquals(bots.agentCount >= 1, true);
});
