/**
 * Epic 4.8 Chunk 1: SimTickEvent shape + order contract.
 * Run from server-community/:
 *   deno test -A players/simTickResult_test.ts
 */

import { assertEquals } from "@std/assert";
import { SIM_TICK_EVENT_ORDER } from "./simTickPhases.ts";
import type {
  SimRosterLeaveFact,
  SimTickEvent,
  SimTickEventType,
  SimTickResult,
} from "./simTickResult.ts";

Deno.test("SimTickEvent types align with SIM_TICK_EVENT_ORDER", () => {
  const order: SimTickEventType[] = [...SIM_TICK_EVENT_ORDER];
  assertEquals(order, [
    "CombatBurst",
    "PlayerDied",
    "Score",
    "GameOver",
    "PlayerRespawned",
  ]);
});

Deno.test("collected event list preserves CombatBurst before PlayerDied … Respawned", () => {
  // Shape-only stand-in: driver emit walks events in array order.
  const events: Array<Pick<SimTickEvent, "type">> = [
    { type: "CombatBurst" },
    { type: "CombatBurst" },
    { type: "PlayerDied" },
    { type: "Score" },
    { type: "GameOver" },
    { type: "PlayerRespawned" },
  ];
  const types = events.map((e) => e.type);
  let lastIdx = -1;
  for (const name of SIM_TICK_EVENT_ORDER) {
    const idx = types.lastIndexOf(name);
    if (idx === -1) continue;
    assertEquals(
      idx >= lastIdx,
      true,
      `${name} must not precede earlier SIM_TICK_EVENT_ORDER entries`,
    );
    lastIdx = idx;
  }
});

Deno.test("SimTickResult includes rosterLeaves for driver PlayerLeft emit (7.1)", () => {
  const leaves: SimRosterLeaveFact[] = [
    { playerId: "x", hadMapVote: false },
  ];
  const result: SimTickResult = {
    events: [],
    shootHeatmap: [],
    heatmapDepartures: [],
    rosterLeaves: leaves,
  };
  assertEquals(result.rosterLeaves.length, 1);
  assertEquals(result.rosterLeaves[0]!.playerId, "x");
});
