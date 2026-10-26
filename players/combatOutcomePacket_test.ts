/**
 * Kill-feed names are stamped at pack time from the live roster.
 * Run from server-community/:
 *   deno test -A players/combatOutcomePacket_test.ts
 */

import { assertEquals } from "@std/assert";
import { packCombatOutcomePacket } from "./combatOutcomePacket.ts";
import type { ShootOutcome } from "./PlayerManager.ts";

const shot = {
  shooterId: "human-1",
  origin: [0, 1.6, 0] as [number, number, number],
  direction: [0, 0, 1] as [number, number, number],
  weapon: 1,
  hitId: "agent:1",
  hitZone: "head" as const,
  hitPoint: [0, 1.6, 4] as [number, number, number],
};

function killOutcome(): ShootOutcome {
  return {
    shot,
    damages: [{
      targetId: "agent:1",
      shooterId: "human-1",
      damage: 100,
      health: 0,
      zone: "head",
      alive: false,
      killed: true,
      critical: true,
    }],
  };
}

Deno.test("packCombatOutcomePacket stamps names while roster still has both sides", () => {
  const roster = new Map([
    ["human-1", { name: "Ada", team: "A" as const, isAgent: false }],
    ["agent:1", { name: "agent1", team: "B" as const, isAgent: true }],
  ]);
  const packed = packCombatOutcomePacket(killOutcome(), roster);
  const death = packed.deaths![0]!;
  assertEquals(death.killerName, "Ada");
  assertEquals(death.victimName, "agent1");
  assertEquals(death.killerIsAgent, undefined);
  assertEquals(death.victimIsAgent, true);
});

Deno.test("packCombatOutcomePacket keeps names after the victim is pruned", () => {
  const roster = new Map([
    ["human-1", { name: "Ada", team: "A" as const, isAgent: false }],
    ["agent:1", { name: "agent1", team: "B" as const, isAgent: true }],
  ]);
  const packed = packCombatOutcomePacket(killOutcome(), roster);
  roster.delete("agent:1");
  assertEquals(packed.deaths![0]!.victimName, "agent1");
  assertEquals(
    packCombatOutcomePacket(killOutcome(), roster).deaths![0]!.victimName,
    "Unknown",
  );
});
