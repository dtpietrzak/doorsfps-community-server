/**
 * Epic 4.8 Chunk 3: stepping with injected nowMs / RNG must not touch wall
 * clock or process RNG globals.
 *
 * Run from server-community/:
 *   deno test -A players/sim_clock_injection_test.ts
 */

import { assertEquals } from "@std/assert";
import type { DoorsMap } from "../world/map.ts";
import { MapCollision } from "../world/MapCollision.ts";
import { BotManager } from "../bots/BotManager.ts";
import { PlayerManager } from "./PlayerManager.ts";
import { createSimRng } from "../shared/sim/simRng.ts";

const map: DoorsMap = {
  name: "sim-clock-injection",
  version: 1,
  bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 },
  gridSize: 1,
  walls: [],
  teamA: { corners: [0, 1], edge: "south", doorHalfWidth: 2.5, spawnRadius: 3 },
  teamB: { corners: [2, 3], edge: "north", doorHalfWidth: 2.5, spawnRadius: 3 },
};

function stubGlobalsToThrow(): () => void {
  const g = globalThis as unknown as {
    Date: DateConstructor;
    performance: Performance;
    Math: Math;
  };
  const origDateNow = g.Date.now;
  const origPerfNow = g.performance.now.bind(g.performance);
  const origRandom = g.Math.random;
  g.Date.now = () => {
    throw new Error("Date.now must not be called during injected sim step");
  };
  g.performance.now = () => {
    throw new Error(
      "performance.now must not be called during injected sim step",
    );
  };
  g.Math.random = () => {
    throw new Error("Math.random must not be called during injected sim step");
  };
  return () => {
    g.Date.now = origDateNow;
    g.performance.now = origPerfNow;
    g.Math.random = origRandom;
  };
}

Deno.test("PlayerManager + BotManager apply step with injected clock/RNG never hits globals", () => {
  const nowMs = 1_700_000_000_000;
  const damageRandom = createSimRng(0xC0FFEE);
  const collision = new MapCollision(map);
  const pm = new PlayerManager(collision, {
    damageRandom,
    nowMs,
  });
  // Construct roster before stubbing — add/spawn may use wall clock defaults.
  pm.add("sock-1", "Alice", "A", undefined, nowMs);
  pm.addBot("bot:1", "BotOne", { team: "B" });
  pm.startNewMatch(0, nowMs);

  const bots = new BotManager(pm, {}, {
    nowMs: () => nowMs,
    rand: createSimRng(0xBADC0DE),
    autoFill: false,
  });
  bots.setAgentsRandom(createSimRng(0xA6E17));

  const restore = stubGlobalsToThrow();
  try {
    // Core step-path surfaces used by GameServer.stepSim (without GameServer).
    bots.tickChurn(8, nowMs);
    bots.tickHousekeeping(1, collision);
    bots.applyReadyActions(1, nowMs, () => {});
    const deaths = pm.update(1, nowMs);
    assertEquals(Array.isArray(deaths), true);
    pm.processScores(1);
    pm.processRespawns(1);
  } finally {
    restore();
  }
});
