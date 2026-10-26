/**
 * Menu-party join: party identity is retained on runtime sessions (S9-PR1)
 * and group-aware team assignment / rebalance / manual switch (S9-PR2).
 */
import { assertEquals, assertExists } from "jsr:@std/assert";
import { DEFAULT_OPEN_SEAT_RESERVATION_LEASE_MS } from "../shared/fleet/openPlacement.ts";
import {
  assignGroupsToTeams,
  runtimeMaxPartySize,
} from "../shared/social/partyTeamBalance.ts";
import {
  normalizePlayerPartyId,
  normalizePlayerPartySize,
  Player,
} from "./Player.ts";
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
  return new PlayerManager(new MapCollision(miniMap), { enablePrematch: true });
}

Deno.test("party identity: normalize rejects empty / partial size", () => {
  assertEquals(normalizePlayerPartyId(""), null);
  assertEquals(normalizePlayerPartyId("  "), null);
  assertEquals(normalizePlayerPartyId("op_abc"), "op_abc");
  assertEquals(normalizePlayerPartySize(0), null);
  assertEquals(normalizePlayerPartySize(2.7), 2);
  assertEquals(normalizePlayerPartySize(99), 8);
  assertEquals(normalizePlayerPartySize(undefined), null);
});

Deno.test("party identity: Player stores claim fields; solos stay null", () => {
  const party = new Player("s1", "Alpha", "A", {
    partyId: "op_friends",
    partySize: 3,
    accountUserId: "user_a",
  });
  assertEquals(party.partyId, "op_friends");
  assertEquals(party.partySize, 3);

  const solo = new Player("s2", "Solo", "B", { accountUserId: "user_b" });
  assertEquals(solo.partyId, null);
  assertEquals(solo.partySize, null);

  // Size without id is dropped (not a party session).
  const partial = new Player("s3", "Ghost", "A", { partySize: 4 });
  assertEquals(partial.partyId, null);
  assertEquals(partial.partySize, null);

  // Id without size defaults size to 1.
  const bareId = new Player("s4", "Bare", "A", { partyId: "op_one" });
  assertEquals(bareId.partyId, "op_one");
  assertEquals(bareId.partySize, 1);
});

Deno.test("party identity: add retains party fields on the roster", () => {
  const pm = makePm();
  const a = pm.add("s1", "Alpha", "A", {
    partyId: "op_crew",
    partySize: 2,
    accountUserId: "user_a",
  });
  assertEquals(a.partyId, "op_crew");
  assertEquals(a.partySize, 2);
  assertEquals(pm.findPartyMember("op_crew")?.id, a.id);
  assertEquals(pm.findPartyMember("op_other"), undefined);
});

Deno.test("party team: members with same partyId share a team", () => {
  const pm = makePm();
  // Solo on A so the light side is B for a party of 2.
  const solo = pm.add("s0", "Solo");
  assertEquals(solo.team, "A");
  assertEquals(solo.partyId, null);

  const t1 = pm.pickTeamForJoin({ partyId: "pty_friends", partySize: 2 });
  assertEquals(t1, "B");
  const a = pm.add("s1", "Alpha", t1, {
    partyId: "pty_friends",
    partySize: 2,
  });
  assertEquals(a.team, "B");
  assertEquals(a.partyId, "pty_friends");

  const t2 = pm.pickTeamForJoin({ partyId: "pty_friends", partySize: 2 });
  assertEquals(t2, "B");
  const b = pm.add("s2", "Bravo", t2, {
    partyId: "pty_friends",
    partySize: 2,
  });
  assertEquals(b.team, "B");
  assertEquals(b.partyId, "pty_friends");

  // Without party lock, next human would balance toward A.
  assertEquals(pm.pickTeamForHuman(), "A");
});

Deno.test("party team: different parties can sit opposite", () => {
  const pm = makePm();
  const p1 = pm.pickTeamForJoin({ partyId: "pty_a", partySize: 1 });
  assertEquals(p1, "A");
  pm.add("s1", "A1", p1, { partyId: "pty_a", partySize: 1 });

  const p2 = pm.pickTeamForJoin({ partyId: "pty_b", partySize: 1 });
  assertEquals(p2, "B");
  pm.add("s2", "B1", p2, { partyId: "pty_b", partySize: 1 });

  const p1b = pm.pickTeamForJoin({ partyId: "pty_a", partySize: 1 });
  assertEquals(p1b, "A");
});

Deno.test("party team: pickTeamForParty balances after seating whole party", () => {
  const pm = makePm();
  pm.add("s1", "H1", "A");
  // A=1 B=0, party of 2 → seating on B yields 1–2; on A yields 3–0.
  assertEquals(pm.pickTeamForParty(2), "B");
});

Deno.test(
  "party team: roster cohesion survives expired connect lock",
  () => {
    const pm = makePm();
    const t1 = pm.pickTeamForJoin({ partyId: "op_late", partySize: 2 });
    pm.add("s1", "First", t1, { partyId: "op_late", partySize: 2 });

    // Drop temporary lock; seated member still anchors the team.
    pm.expirePartyTeamsForTests();
    assertEquals(
      pm.pickTeamForJoin({ partyId: "op_late", partySize: 2 }),
      t1,
    );
  },
);

Deno.test(
  "party team: connect lock expires without seated members",
  () => {
    const pm = makePm();
    // Force first party toward B so expiry is observable.
    pm.add("s0", "Solo", "A");
    const locked = pm.pickTeamForJoin({ partyId: "op_only_lock", partySize: 2 });
    assertEquals(locked, "B");

    pm.expirePartyTeamsForTests();
    // No roster member → lock gone; re-pick still balances (B again here).
    const again = pm.pickTeamForJoin({ partyId: "op_only_lock", partySize: 2 });
    assertEquals(again, "B");

    // After seating on A manually without lock refresh path via findPartyMember.
    pm.clearPartyTeamsForTests();
    pm.add("s1", "OnA", "A", { partyId: "op_only_lock", partySize: 2 });
    assertEquals(
      pm.pickTeamForJoin({ partyId: "op_only_lock", partySize: 2 }),
      "A",
    );
  },
);

Deno.test(
  "party identity: reclaim / disconnect grace preserve party fields",
  () => {
    const pm = makePm();
    const p = pm.add("sock-1", "Alice", "A", {
      partyId: "op_grace",
      partySize: 3,
      accountUserId: "user_alice",
    });
    assertEquals(p.partyId, "op_grace");
    assertEquals(p.partySize, 3);

    assertEquals(pm.markConnectionIssue(p.id, 1_000), true);
    assertEquals(p.connectionIssue, true);
    // Still discoverable as a party member while in grace.
    assertEquals(pm.findPartyMember("op_grace")?.id, p.id);
    assertEquals(
      pm.pickTeamForJoin({ partyId: "op_grace", partySize: 3 }),
      "A",
    );

    const restored = pm.takeOverConnection(p.id, "sock-2", 10);
    assertExists(restored);
    assertEquals(restored.player.partyId, "op_grace");
    assertEquals(restored.player.partySize, 3);
    assertEquals(restored.player.id, "sock-1");
    assertEquals(restored.wasConnectionIssue, true);
  },
);

Deno.test("party identity: snapshots never leak party metadata", () => {
  const pm = makePm();
  const p = pm.add("s1", "Alice", "A", {
    partyId: "op_secret",
    partySize: 4,
    accountUserId: "user_a",
  });
  const full = p.toSnapshot(0, "full", pm.getCollision());
  const motion = p.toSnapshot(0, "motion", pm.getCollision());
  const fullKeys = Object.keys(full);
  const motionKeys = Object.keys(motion);
  assertEquals(fullKeys.includes("partyId"), false);
  assertEquals(fullKeys.includes("partySize"), false);
  assertEquals(motionKeys.includes("partyId"), false);
  assertEquals(motionKeys.includes("partySize"), false);
  assertEquals(
    (full as unknown as Record<string, unknown>).partyId,
    undefined,
  );
  assertEquals(
    (motion as unknown as Record<string, unknown>).partySize,
    undefined,
  );
});

Deno.test("party identity: non-party / ranked-style joins stay null", () => {
  const pm = makePm();
  // Ranked-style account join without party claims.
  const ranked = pm.add("s1", "RankedPlayer", "A", {
    accountUserId: "user_ranked",
  });
  assertEquals(ranked.partyId, null);
  assertEquals(ranked.partySize, null);
  // Solo human on A → next join balances to B; no party lock applies.
  assertEquals(pm.pickTeamForJoin({}), "B");
  assertEquals(
    pm.pickTeamForJoin({ partyId: null, partySize: null }),
    pm.pickTeamForHuman(),
  );

  // Community guest: no account, no party.
  const guest = pm.add("s2", "Guest", "B");
  assertEquals(guest.partyId, null);
  assertEquals(guest.accountUserId, null);
});

Deno.test("party team lock TTL matches reservation lease constant", () => {
  // Guard against accidental drift from the placement lease window.
  assertEquals(DEFAULT_OPEN_SEAT_RESERVATION_LEASE_MS, 30_000);
});

// --- S9-PR2: group-aware assignment, rebalance, manual switch -----------------

Deno.test("S9-PR2: pickTeamForParty sizes 1..max with uneven seeds", () => {
  const pm = makePm();
  // Seed one match player on A.
  pm.add("seed-human", "SeedH", "A");
  for (let size = 1; size <= 4; size++) {
    // Fresh lock map; only the seed remains for balance math if we don't seat.
    const team = pm.pickTeamForParty(size);
    // Seating size on B always yields better or equal |diff| when A already has 1.
    assertEquals(team, "B");
  }
});

Deno.test("S9-PR2: multi-party pure assign used for batch seating order", () => {
  // Existing seed on A; two parties + one solo waiting.
  const r = assignGroupsToTeams(
    [
      { id: "pty_3", size: 3 },
      { id: "pty_2", size: 2 },
      { id: "solo", size: 1 },
    ],
    { A: 1, B: 0 },
  );
  assertEquals(r.ok, true);
  if (!r.ok) return;
  const byId = Object.fromEntries(
    r.assignments.map((a) => [a.groupId, a.team]),
  );
  // size 3 first → B (A has 1); size 2 → A or B; solo fills.
  assertEquals(byId.pty_3, "B");
  assertEquals(r.teamCounts.A + r.teamCounts.B, 1 + 3 + 2 + 1);
});

Deno.test("S9-PR2: manual changeTeam rejected while party session active", () => {
  const pm = makePm();
  const a = pm.add("s1", "Alpha", "A", {
    partyId: "op_crew",
    partySize: 2,
  });
  pm.add("s2", "Bravo", "A", { partyId: "op_crew", partySize: 2 });
  // Even with autofill room, party members cannot solo-switch.
  const r = pm.changeTeam(a.id, { autofillBots: 8 });
  assertEquals(r.ok, false);
  if (!r.ok) {
    assertEquals(r.error.includes("Party members"), true);
  }
  assertEquals(a.team, "A");

  // Solo still allowed under bot regime.
  const solo = pm.add("s3", "Solo", "B");
  assertEquals(pm.changeTeam(solo.id, { autofillBots: 8 }).ok, true);
});

Deno.test("S9-PR2: forceChangeTeam refuses splitting a multi-member party", () => {
  const pm = makePm();
  const a = pm.add("s1", "Alpha", "A", {
    partyId: "op_split",
    partySize: 2,
  });
  pm.add("s2", "Bravo", "A", { partyId: "op_split", partySize: 2 });
  pm.add("s3", "Light", "B");
  const r = pm.forceChangeTeam(a.id, "B");
  assertEquals(r.ok, false);
  assertEquals(a.team, "A");
});

Deno.test("S9-PR2: forceChangeTeamGroup moves whole party; partial rejected", () => {
  const pm = makePm();
  const a = pm.add("s1", "Alpha", "A", {
    partyId: "op_move",
    partySize: 2,
  });
  const b = pm.add("s2", "Bravo", "A", {
    partyId: "op_move",
    partySize: 2,
  });
  pm.add("s3", "C1", "A");
  pm.add("s4", "C2", "B");

  // Partial group must fail.
  assertEquals(pm.forceChangeTeamGroup([a.id], "B").ok, false);
  assertEquals(a.team, "A");

  const r = pm.forceChangeTeamGroup([a.id, b.id], "B");
  assertEquals(r.ok, true);
  if (r.ok) {
    assertEquals(r.moved.length, 2);
    assertEquals(a.team, "B");
    assertEquals(b.team, "B");
  }
});

Deno.test("S9-PR2: pickGroupForRebalance prefers solo over party", () => {
  const pm = makePm();
  // Heavy A: party of 2 + weak solo; light B: one human. 3v1 needs rebalance.
  const strong = pm.add("p1", "Strong", "A", {
    partyId: "op_heavy",
    partySize: 2,
  });
  const mate = pm.add("p2", "Mate", "A", {
    partyId: "op_heavy",
    partySize: 2,
  });
  const weakSolo = pm.add("s1", "WeakSolo", "A");
  pm.add("s2", "OnB", "B");

  strong.kills = 10;
  strong.score = 5;
  mate.kills = 8;
  mate.score = 4;
  weakSolo.kills = 0;
  weakSolo.score = 0;
  weakSolo.deaths = 6;

  assertEquals(pm.needsHumanRebalance(), true);
  const group = pm.pickGroupForRebalance("A", "B");
  assertExists(group);
  assertEquals(group!.size, 1);
  assertEquals(group!.memberIds, [weakSolo.id]);
});

Deno.test("S9-PR2: pickGroupForRebalance moves whole party when only legal move", () => {
  const pm = makePm();
  // 4v1: party of 2 + two strong on A, one on B. Moving party of 2 → 2v3 improves.
  const a = pm.add("p1", "P1", "A", { partyId: "op_only", partySize: 2 });
  const b = pm.add("p2", "P2", "A", { partyId: "op_only", partySize: 2 });
  const s1 = pm.add("s1", "S1", "A");
  const s2 = pm.add("s2", "S2", "A");
  pm.add("b1", "B1", "B");

  // Make solos higher rated so if they were preferred for other reasons party still wins
  // when we force only party to improve more... Actually solos of 1 also improve 4v1→3v2.
  // Exclude solos by making them connection-issue so only party is eligible.
  s1.markConnectionIssue(Date.now() + 60_000);
  s2.markConnectionIssue(Date.now() + 60_000);

  const group = pm.pickGroupForRebalance("A", "B");
  assertExists(group);
  assertEquals(group!.size, 2);
  assertEquals(new Set(group!.memberIds), new Set([a.id, b.id]));
});

Deno.test("S9-PR2: pickGroupForRebalance skips party move that does not improve", () => {
  const pm = makePm();
  // 3v1: only a party of 2 on heavy + one solo connection-issue.
  // Moving party of 2 → 1v3 does not improve |diff|.
  pm.add("p1", "P1", "A", { partyId: "op_bad", partySize: 2 });
  pm.add("p2", "P2", "A", { partyId: "op_bad", partySize: 2 });
  const solo = pm.add("s1", "S1", "A");
  solo.markConnectionIssue(Date.now() + 60_000);
  pm.add("b1", "B1", "B");

  assertEquals(pm.needsHumanRebalance(), true); // 3v1
  const group = pm.pickGroupForRebalance("A", "B");
  // No legal improver (party of 2 doesn't help; solo offline).
  assertEquals(group, null);
});

Deno.test("S9-PR2: pickGroupForRebalance can pick a pool pawn solo", () => {
  const pm = makePm();
  const human = pm.add("h1", "Strong", "A");
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

  const group = pm.pickGroupForRebalance("A", "B");
  assertExists(group);
  assertEquals(group!.size, 1);
  assertEquals(group!.memberIds[0], seed.id);
});

Deno.test("S9-PR2: maxPartySize tracks human capacity", () => {
  const pm = makePm();
  assertEquals(pm.maxPartySize(8), 8);
  assertEquals(pm.maxPartySize(4), 4);
  assertEquals(pm.maxPartySize(16), runtimeMaxPartySize(16));
  assertEquals(runtimeMaxPartySize(16), 8);
});

