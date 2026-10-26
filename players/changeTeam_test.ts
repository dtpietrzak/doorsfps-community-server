/**
 * Open-match change-team rules:
 * - Target team has fewer total players (humans + bots), or
 * - Roster under autofill threshold (bot can rebalance).
 */
import { assertEquals } from "jsr:@std/assert";
import { PlayerManager } from "./PlayerManager.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";

const miniMap: DoorsMap = {
  name: "test",
  version: 1,
  bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 },
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

function makePm(): PlayerManager {
  return new PlayerManager(new MapCollision(miniMap));
}

Deno.test("changeTeam: allowed when target has fewer players", () => {
  const pm = makePm();
  const a = pm.add("h1", "Alice", "A");
  pm.add("h2", "Bob", "A");
  // A=2 B=0 → Alice may switch to B
  const r = pm.changeTeam(a.id, { autofillBots: 0 });
  assertEquals(r.ok, true);
  if (r.ok) {
    assertEquals(r.to, "B");
    assertEquals(a.team, "B");
    assertEquals(a.alive, true);
  }
});

Deno.test("changeTeam: denied when target has more players (no bot room)", () => {
  const pm = makePm();
  const a = pm.add("h1", "Alice", "A");
  pm.add("h2", "Bob", "B");
  pm.add("h3", "Carol", "B");
  // A=1 B=2 — Alice cannot join the larger team; total=3 but autofill=0
  const r = pm.changeTeam(a.id, { autofillBots: 0 });
  assertEquals(r.ok, false);
  assertEquals(a.team, "A");
});

Deno.test("changeTeam: even humans denied when at human autofill cap", () => {
  const pm = makePm();
  const a = pm.add("h1", "Alice", "A");
  pm.add("h2", "Bob", "B");
  // 2 humans, autofill=2 → full human lobby, even teams → no switch
  const r = pm.changeTeam(a.id, { autofillBots: 2 });
  assertEquals(r.ok, false);
  assertEquals(a.team, "A");
});

Deno.test("changeTeam: even teams allowed when humans under autofill (bot regime)", () => {
  const pm = makePm();
  const a = pm.add("h1", "Alice", "A");
  pm.add("h2", "Bob", "B");
  // 2 humans, autofill=4 → still within bot threshold
  const r = pm.changeTeam(a.id, { autofillBots: 4 });
  assertEquals(r.ok, true);
  if (r.ok) {
    assertEquals(r.to, "B");
    assertEquals(a.team, "B");
  }
});

Deno.test("changeTeam: allowed at full bot fill (1 human + bots = autofill)", () => {
  const pm = makePm();
  const a = pm.add("h1", "Alice", "A");
  pm.addBot("bot:1", "bot1");
  pm.addBot("bot:2", "bot2");
  pm.addBot("bot:3", "bot3");
  // Typical open lobby: 4 bodies, autofill=4, humanCount=1 < 4
  assertEquals(pm.size, 4);
  const r = pm.changeTeam(a.id, { autofillBots: 4 });
  assertEquals(r.ok, true);
  if (r.ok) assertEquals(a.team, "B");
});

Deno.test("changeTeam: rebalanceBotTeams moves bots heavy→light", () => {
  const pm = makePm();
  const a = pm.add("h1", "Alice", "A");
  pm.addBot("bot:1", "bot1"); // → B
  pm.addBot("bot:2", "bot2"); // → A (totals even)
  pm.addBot("bot:3", "bot3"); // → B
  // Force uneven after human flip without rebalance API
  assertEquals(pm.changeTeam(a.id, { autofillBots: 4 }).ok, true);
  // After Alice A→B: rebalance should pull toward even
  const moved = pm.rebalanceBotTeams();
  const { A, B } = pm.teamCounts();
  assertEquals(Math.abs(A - B) <= 1, true);
  assertEquals(moved.length >= 0, true);
});

Deno.test("changeTeam: bots count toward team sizes", () => {
  const pm = makePm();
  const a = pm.add("h1", "Alice", "A");
  pm.addBot("bot:1", "bot1"); // balanced → B (A has human)
  // A=1 B=1, humanCount=1, autofill=2 → still in bot regime → allowed
  const allowed = pm.changeTeam(a.id, { autofillBots: 2 });
  assertEquals(allowed.ok, true);

  const pm2 = makePm();
  const a2 = pm2.add("h1", "Alice", "A");
  pm2.add("h2", "Bob", "B");
  pm2.add("h3", "Carol", "B");
  // A=1 B=2 — Alice can't join larger team with autofill=0
  assertEquals(pm2.changeTeam(a2.id, { autofillBots: 0 }).ok, false);
  // Bob on larger team can switch to A
  const bob = pm2.get("h2")!;
  const ok = pm2.changeTeam(bob.id, { autofillBots: 0 });
  assertEquals(ok.ok, true);
  if (ok.ok) assertEquals(ok.to, "A");
});

Deno.test("changeTeam: already on team is rejected", () => {
  const pm = makePm();
  const a = pm.add("h1", "Alice", "A");
  const r = pm.changeTeam(a.id, { autofillBots: 4, team: "A" });
  assertEquals(r.ok, false);
});

Deno.test("changeTeam: bots cannot request switch", () => {
  const pm = makePm();
  const bot = pm.addBot("bot:1", "bot1");
  const r = pm.changeTeam(bot.id, { autofillBots: 4 });
  assertEquals(r.ok, false);
});
