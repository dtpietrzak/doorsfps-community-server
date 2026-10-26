/**
 * Pool slot. The child is the hold-W brain. profileData is forwarded, not
 * decoded. An extra agent decision drops that whole result. Killing the child
 * does not stall the sim tick. Agents still spawn on door close.
 */
import { assert, assertEquals } from "@std/assert";
import { DOOR_OPEN_TICKS } from "../protocol/network.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";
import { PlayerManager } from "../players/PlayerManager.ts";
import { BotManager } from "./BotManager.ts";

const SENTINEL_YAW = 2.5;

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

Deno.test("pool brain holds W, drops an agent id, and restarts", async () => {
  const collision = new MapCollision(testMap());
  const players = new PlayerManager(collision);
  const script = new URL("./compiled/holdWBrain.ts", import.meta.url).pathname;
  const config = new URL("../deno.json", import.meta.url).pathname;
  const bots = new BotManager(players, {}, {
    fill: { minPlayers: 2, noBotsOnEmptyServer: false },
    poolBrain: [Deno.execPath(), "run", "-A", `--config=${config}`, script],
    brainRestartMinDelayMs: 20,
    brainRestartMaxDelayMs: 40,
  });

  const poolBots = () =>
    [...players.all()].filter((player) =>
      player.isBot && !player.isAgent && !player.isBalanceBot
    );

  const holds = (yaw: number): boolean => {
    let any = false;
    for (const player of poolBots()) {
      const input = bots.lastReadyAction(player.id)?.input;
      if (!input) continue;
      if (!input.forward || input.yaw !== yaw) return false;
      any = true;
    }
    return any;
  };

  const agentTookSentinel = (): boolean => {
    for (const player of [...players.all()]) {
      if (!player.isAgent) continue;
      const input = bots.lastReadyAction(player.id)?.input;
      if (!input) continue;
      if (
        input.forward && input.backward && input.left && input.right &&
        input.jump && input.crouch && input.yaw === SENTINEL_YAW
      ) {
        return true;
      }
    }
    return false;
  };

  const yieldIo = () => new Promise((resolve) => setTimeout(resolve, 5));

  try {
    // Swap botN for pool pawns while the server is empty. A human blocks that swap.
    bots.reconcile(8);
    bots.putPoolIdentities([1, 2].map((n) => ({
      id: `pool-${n}`,
      name: `Ada${n}`,
      accountId: `pool_account_${n}`,
      profile: "opaque",
      profileData: "cG9vbA==",
    })));
    assert(poolBots().length >= 1);
    players.add("h1", "Ada", "A");
    players.beginLiveMatch(0);

    const deadline = Date.now() + 8_000;
    let tick = 1;
    while (Date.now() < deadline && !holds(0)) {
      bots.tick(tick, collision);
      await bots.poolBrainSettled();
      await yieldIo();
      tick += 1;
    }
    assert(holds(0), "pool pawns take hold-W from the pool brain");

    const pid = bots.poolBrainPid();
    assertEquals(typeof pid, "number");
    Deno.kill(pid!, "SIGKILL");

    const started = performance.now();
    bots.tick(tick, collision);
    const elapsed = performance.now() - started;
    tick += 1;
    await bots.poolBrainSettled();
    assert(elapsed < 250, `sim tick stalled on a dead brain (${elapsed}ms)`);

    bots.tick(DOOR_OPEN_TICKS, collision);
    await bots.poolBrainSettled();
    assert(bots.agentCount > 0, "agents still spawn on door close");
    assert(!agentTookSentinel());

    let again = false;
    const againDeadline = Date.now() + 8_000;
    for (
      let step = 1;
      step <= 400 && Date.now() < againDeadline && !again;
      step += 1
    ) {
      bots.tick(DOOR_OPEN_TICKS + step, collision);
      await bots.poolBrainSettled();
      await yieldIo();
      if (agentTookSentinel()) break;
      if (holds(0.5)) again = true;
    }
    assert(!agentTookSentinel(), "agent action from the pool brain is dropped");
    assert(again, "pool pawns take hold-W again after restart");
    assert(bots.agentCount > 0);
  } finally {
    await bots.closePoolBrain();
  }
});
