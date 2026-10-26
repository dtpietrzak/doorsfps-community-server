/**
 * Epic 4.7 Chunk 0: phase contract shape.
 * Run from server-community/:
 *   deno test -A players/simTickPhases_test.ts
 */

import { assertEquals, assert } from "@std/assert";
import {
  SIM_TICK_EVENT_ORDER,
  SIM_TICK_PHASE_IDS,
  SIM_TICK_PHASES,
  type SimTickPhaseId,
} from "./simTickPhases.ts";

Deno.test("SIM_TICK_PHASES is a total ordered list with unique ids", () => {
  const ids = SIM_TICK_PHASES.map((p) => p.id);
  assertEquals(ids, [...SIM_TICK_PHASE_IDS]);
  assertEquals(new Set(ids).size, ids.length);
  for (const p of SIM_TICK_PHASES) {
    assert(p.summary.length > 0, `${p.id} needs a summary`);
    assert(
      p.kind === "SIM" || p.kind === "NON_SIM" || p.kind === "MIXED",
      `${p.id} kind`,
    );
  }
});

Deno.test("weapons phases precede MovePhysics; BotThink is last", () => {
  const index = (id: SimTickPhaseId) => SIM_TICK_PHASE_IDS.indexOf(id);
  assert(index("BotApply") < index("Weapons"));
  assert(index("Weapons") < index("MovePhysics"));
  assert(index("MovePhysics") < index("OverlapDeath"));
  assert(index("ScoresRules") < index("MatchEnd"));
  assert(index("MatchEnd") < index("Intermission"));
  assert(index("Intermission") < index("Respawn"));
  assertEquals(SIM_TICK_PHASE_IDS.at(-1), "BotThink");
});

Deno.test("SIM_TICK_EVENT_ORDER matches the pinned emit contract", () => {
  assertEquals([...SIM_TICK_EVENT_ORDER], [
    "CombatBurst",
    "PlayerDied",
    "Score",
    "GameOver",
    "PlayerRespawned",
  ]);
});
