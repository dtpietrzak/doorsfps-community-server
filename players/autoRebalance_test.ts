/**
 * Open-match team rebalance helpers (humans + pool pawns as match players):
 * - needsHumanRebalance / humanRebalanceSides (|diff| >= 2)
 * - pickWorstHumanForRebalance (AFK → lowest rating → …)
 * - forceChangeTeam (no balance eligibility gate)
 * - rebalanceVotesNeeded / rebalanceVotePasses (>1/3 humans)
 */
import { assertEquals } from "jsr:@std/assert";
import { PlayerManager } from "./PlayerManager.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";
import {
  AFK_TIMEOUT_MS,
  rebalanceVotePasses,
  rebalanceVotesNeeded,
} from "../protocol/network.ts";

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

Deno.test("needsHumanRebalance: false when even or |diff| = 1", () => {
  const pm = makePm();
  pm.add("h1", "Alice", "A");
  pm.add("h2", "Bob", "B");
  assertEquals(pm.needsHumanRebalance(), false);
  assertEquals(pm.humanRebalanceSides(), null);

  pm.add("h3", "Carol", "A");
  // 2v1 — odd residual, do not thrash
  assertEquals(pm.needsHumanRebalance(), false);
  assertEquals(pm.humanRebalanceSides(), null);
});

Deno.test("needsHumanRebalance: true when |diff| >= 2", () => {
  const pm = makePm();
  pm.add("h1", "Alice", "A");
  pm.add("h2", "Bob", "A");
  pm.add("h3", "Carol", "A");
  pm.add("h4", "Dave", "B");
  assertEquals(pm.needsHumanRebalance(), true);
  assertEquals(pm.humanRebalanceSides(), { heavy: "A", light: "B" });
});

Deno.test("pickWorstHumanForRebalance: lowest rating on heavy", () => {
  const pm = makePm();
  const strong = pm.add("h1", "Strong", "A");
  const weak = pm.add("h2", "Weak", "A");
  pm.add("h3", "Mid", "A");
  pm.add("h4", "Solo", "B");

  strong.kills = 5;
  strong.score = 3;
  strong.deaths = 0;
  weak.kills = 0;
  weak.score = 0;
  weak.deaths = 4;
  const mid = pm.get("h3")!;
  mid.kills = 2;
  mid.score = 1;
  mid.deaths = 1;

  const pick = pm.pickWorstHumanForRebalance("A");
  assertEquals(pick?.id, weak.id);
});

Deno.test("pickWorstHumanForRebalance: prefers AFK over low rating", () => {
  const pm = makePm();
  const activeWeak = pm.add("h1", "ActiveWeak", "A");
  const afkStrong = pm.add("h2", "AfkStrong", "A");
  pm.add("h3", "AlsoA", "A");
  pm.add("h4", "Solo", "B");

  activeWeak.kills = 0;
  activeWeak.score = 0;
  activeWeak.deaths = 10;
  afkStrong.kills = 10;
  afkStrong.score = 5;
  afkStrong.deaths = 0;
  // Force AFK by aging last activity past the timeout.
  afkStrong.lastActivityAtMs = Date.now() - AFK_TIMEOUT_MS - 1000;

  const pick = pm.pickWorstHumanForRebalance("A");
  assertEquals(pick?.id, afkStrong.id);
});

Deno.test("pickWorstHumanForRebalance: skips connection-issue", () => {
  const pm = makePm();
  const offline = pm.add("h1", "Offline", "A");
  const online = pm.add("h2", "Online", "A");
  const strong = pm.add("h3", "StrongA", "A");
  pm.add("h4", "Solo", "B");

  offline.kills = 0;
  offline.score = 0;
  offline.deaths = 99;
  online.kills = 1;
  online.score = 0;
  online.deaths = 2;
  strong.kills = 8;
  strong.score = 4;
  strong.deaths = 0;
  offline.markConnectionIssue(Date.now() + 30_000);

  const pick = pm.pickWorstHumanForRebalance("A");
  assertEquals(pick?.id, online.id);
});

Deno.test("pickWorstHumanForRebalance: community fill bots never selected", () => {
  const pm = makePm();
  pm.add("h1", "Alice", "A");
  pm.add("h2", "Bob", "A");
  pm.addBot("bot:1", "bot1", { team: "A" });
  pm.add("h3", "Carol", "B");
  // Humans 2v1 — not enough for rebalance, but pick still works on heavy.
  const pick = pm.pickWorstHumanForRebalance("A");
  assertEquals(pick?.isBot, false);
  assertEquals(pick?.id === "bot:1", false);
});

Deno.test("match players: pool pawns count toward rebalance imbalance", () => {
  const pm = makePm();
  pm.add("h1", "Alice", "A");
  // 1 human + 2 seeds on A, 1 seed on B → match players 3v1
  pm.addBot("bot:seed1", "SeedOne", {
    team: "A",
    accountUserId: "acct-1",
    poolAccount: true,
  });
  pm.addBot("bot:seed2", "SeedTwo", {
    team: "A",
    accountUserId: "acct-2",
    poolAccount: true,
  });
  pm.addBot("bot:seed3", "SeedThree", {
    team: "B",
    accountUserId: "acct-3",
    poolAccount: true,
  });
  // Community fill bot must not affect match-player counts.
  pm.addBot("bot:fill", "bot1", { team: "B" });

  assertEquals(pm.matchPlayerTeamCounts(), { A: 3, B: 1 });
  assertEquals(pm.needsHumanRebalance(), true);
  assertEquals(pm.humanRebalanceSides(), { heavy: "A", light: "B" });
});

Deno.test("pickWorstHumanForRebalance: can pick pool pawn", () => {
  const pm = makePm();
  const human = pm.add("h1", "StrongHuman", "A");
  human.kills = 10;
  human.score = 5;
  const seed = pm.addBot("bot:seed1", "WeakSeed", {
    team: "A",
    accountUserId: "acct-1",
    poolAccount: true,
  });
  seed.kills = 0;
  seed.score = 0;
  seed.deaths = 8;
  pm.addBot("bot:seed2", "SeedTwo", {
    team: "A",
    accountUserId: "acct-2",
    poolAccount: true,
  });
  pm.add("h2", "Solo", "B");

  const pick = pm.pickWorstHumanForRebalance("A");
  assertEquals(pick?.id, seed.id);
  assertEquals(pick?.isMatchPlayer(), true);
});

Deno.test("forceChangeTeam: moves and respawns without balance gate", () => {
  const pm = makePm();
  // Heavy A is larger — manual changeTeam would block joining A; force can leave A→B.
  const a = pm.add("h1", "Alice", "A");
  pm.add("h2", "Bob", "A");
  pm.add("h3", "Carol", "A");
  pm.add("h4", "Dave", "B");

  // Alice is on the heavy side; force her to light (always allowed for auto).
  const r = pm.forceChangeTeam(a.id, "B");
  assertEquals(r.ok, true);
  if (r.ok) {
    assertEquals(r.from, "A");
    assertEquals(r.to, "B");
    assertEquals(a.team, "B");
    assertEquals(a.alive, true);
  }
  const counts = pm.matchPlayerTeamCounts();
  assertEquals(counts, { A: 2, B: 2 });
});

Deno.test("forceChangeTeam: moves pool pawn; rejects fill bot", () => {
  const pm = makePm();
  const seed = pm.addBot("bot:seed1", "SeedOne", {
    team: "A",
    accountUserId: "acct-1",
    poolAccount: true,
  });
  pm.add("h1", "Alice", "A");
  pm.add("h2", "Bob", "B");

  const r = pm.forceChangeTeam(seed.id, "B");
  assertEquals(r.ok, true);
  if (r.ok) {
    assertEquals(seed.team, "B");
  }

  const fill = pm.addBot("bot:fill", "bot1", { team: "A" });
  assertEquals(pm.forceChangeTeam(fill.id, "B").ok, false);

  const h = pm.add("h3", "Carol", "A");
  assertEquals(pm.forceChangeTeam(h.id, "A").ok, false);
});

Deno.test("rebalanceBotTeams: does not move pool pawns", () => {
  const pm = makePm();
  pm.add("h1", "Alice", "A");
  const seed = pm.addBot("bot:seed1", "SeedOne", {
    team: "A",
    accountUserId: "acct-1",
    poolAccount: true,
  });
  const fill = pm.addBot("bot:fill", "bot1", { team: "A" });
  // Force uneven totals: A has 3, B has 0
  const moved = pm.rebalanceBotTeams();
  // Fill bot may move; seed must stay on A until voted rebalance force-swaps.
  assertEquals(seed.team, "A");
  assertEquals(moved.some((p) => p.id === seed.id), false);
  // Fill should have been eligible to move toward B.
  assertEquals(moved.some((p) => p.id === fill.id) || fill.team === "B", true);
});

Deno.test("rebalanceVotesNeeded: strictly more than 1/3 of humans", () => {
  assertEquals(rebalanceVotesNeeded(0), 0);
  assertEquals(rebalanceVotesNeeded(1), 1);
  assertEquals(rebalanceVotesNeeded(2), 1);
  assertEquals(rebalanceVotesNeeded(3), 2);
  assertEquals(rebalanceVotesNeeded(4), 2);
  assertEquals(rebalanceVotesNeeded(5), 2);
  assertEquals(rebalanceVotesNeeded(6), 3);
  assertEquals(rebalanceVotesNeeded(9), 4);
});

Deno.test("rebalanceVotePasses: votes > humanCount / 3", () => {
  assertEquals(rebalanceVotePasses(0, 3), false);
  assertEquals(rebalanceVotePasses(1, 3), false);
  assertEquals(rebalanceVotePasses(2, 3), true);
  assertEquals(rebalanceVotePasses(1, 1), true);
  assertEquals(rebalanceVotePasses(1, 2), true);
  assertEquals(rebalanceVotePasses(1, 4), false);
  assertEquals(rebalanceVotePasses(2, 4), true);
  assertEquals(rebalanceVotePasses(0, 0), false);
});
