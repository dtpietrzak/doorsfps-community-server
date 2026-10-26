/**
 * S9-PR3: party / reservation-batch bot eviction, deferred fill reconcile,
 * seed preservation, and balance-filler behavior around human parties.
 *
 * Exercises BotManager + PlayerManager the same way GameServer does after a
 * human is seated (bulk tryEvict → startAdmissionBatch → onHumanJoined →
 * finishAdmissionBatch) without spinning up Socket.IO.
 */
import { assert, assertEquals } from "@std/assert";
import {
  BotManager,
  type BotAdmissionReconcileReport,
} from "./BotManager.ts";
import { COMMUNITY_BOT_CONFIG } from "./botBrainConfig.ts";
import { encodeProfileData } from "../host/channel/protocol.ts";
import { PlayerManager } from "../players/PlayerManager.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";
import type { TeamId } from "../protocol/network.ts";

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

function setup(opts?: {
  maxPlayers?: number;
  minPlayers?: number;
  noBotsOnEmptyServer?: boolean;
}) {
  const maxPlayers = opts?.maxPlayers ?? 8;
  const collision = new MapCollision(testMap());
  const players = new PlayerManager(collision);
  const bots = new BotManager(players, {}, {
    fill: {
      minPlayers: opts?.minPlayers ?? maxPlayers,
      noBotsOnEmptyServer: opts?.noBotsOnEmptyServer ?? true,
    },
  });
  return { players, bots, maxPlayers };
}

/** Mirror GameServer.remainingPartySeats. */
function remainingPartySeats(
  players: PlayerManager,
  partyId: string | null,
  partySize: number,
): number {
  if (!partyId || partySize <= 1) return 1;
  const seated = players.listPartyMembers(partyId).length;
  return Math.max(1, partySize - seated);
}

/**
 * Admit one human as GameServer does for a multi-seat open admission:
 * pick team → bulk free seats → seat → deferred join policy.
 * Caller finishes the batch after the last member (or mid-wave).
 */
function admitPartyMember(
  players: PlayerManager,
  bots: BotManager,
  maxPlayers: number,
  opts: {
    socketId: string;
    name: string;
    partyId: string;
    partySize: number;
    /** When true, start batch + defer (default). Solo path uses false. */
    batch?: boolean;
  },
): { team: TeamId; evicted: number } {
  const batch = opts.batch !== false;
  const team = players.pickTeamForJoin({
    partyId: opts.partyId,
    partySize: opts.partySize,
  });
  const seats = remainingPartySeats(players, opts.partyId, opts.partySize);
  if (batch) bots.startAdmissionBatch();
  const free = Math.max(0, maxPlayers - players.nonAgentCount());
  let evicted = 0;
  if (free < seats) {
    evicted = bots.tryEvict(seats - free, team);
  }
  // Must free at least this seat.
  assert(
    maxPlayers - players.nonAgentCount() >= 1,
    `no seat for ${opts.name} after eviction`,
  );
  players.add(opts.socketId, opts.name, team, {
    partyId: opts.partyId,
    partySize: opts.partySize,
  });
  bots.onHumanJoined(maxPlayers);
  return { team, evicted };
}

Deno.test("S9-PR3: full bot-filled runtime admits a party of 4", () => {
  const { players, bots, maxPlayers } = setup({
    maxPlayers: 8,
    minPlayers: 8,
    noBotsOnEmptyServer: false,
  });
  bots.reconcile(maxPlayers);
  assertEquals(bots.fillBotCount, 8);
  assertEquals(players.humanCount(), 0);

  const partyId = "op_full";
  const partySize = 4;
  let totalEvicted = 0;
  for (let i = 0; i < partySize; i++) {
    const r = admitPartyMember(players, bots, maxPlayers, {
      socketId: `s${i}`,
      name: `P${i}`,
      partyId,
      partySize,
    });
    totalEvicted += r.evicted;
  }
  // First member should pre-evict enough for the whole party when full.
  assert(totalEvicted >= 4, `expected ≥4 evictions, got ${totalEvicted}`);

  // Deferred: fill should not thrash mid-wave.
  assertEquals(players.humanCount(), 4);
  // All on one team (party cohesion).
  const members = players.listPartyMembers(partyId);
  assertEquals(members.length, 4);
  const partyTeam = members[0]!.team;
  assert(members.every((m) => m.team === partyTeam));

  const report = bots.finishAdmissionBatch(maxPlayers);
  assertEquals(report.humanCount, 4);
  assertEquals(report.botsEvicted, totalEvicted);
  // autofill 8 with 4 humans → up to 4 fill bots.
  assertEquals(report.fillBotCount, 4);
  assertEquals(players.nonAgentCount(), 8);
  // Party still cohesive after settle.
  assert(
    players.listPartyMembers(partyId).every((m) => m.team === partyTeam),
  );
});

Deno.test("S9-PR3: party disconnect then reconnect does not double-fill", () => {
  const { players, bots, maxPlayers } = setup({
    maxPlayers: 8,
    minPlayers: 4,
  });
  const partyId = "op_re";
  const partySize = 2;

  admitPartyMember(players, bots, maxPlayers, {
    socketId: "s1",
    name: "Alpha",
    partyId,
    partySize,
  });
  admitPartyMember(players, bots, maxPlayers, {
    socketId: "s2",
    name: "Bravo",
    partyId,
    partySize,
  });
  const report1 = bots.finishAdmissionBatch(maxPlayers);
  assertEquals(report1.humanCount, 2);
  assertEquals(report1.fillBotCount, 2);

  // Member disconnects (leave collapses any open wave + refills).
  const alpha = players.listPartyMembers(partyId).find((p) => p.name === "Alpha")!;
  players.remove(alpha.id);
  bots.onHumanLeft(maxPlayers);
  assertEquals(players.humanCount(), 1);
  // autofill 4 with 1 human → 3 fill bots.
  assertEquals(bots.fillBotCount, 3);

  // Reconnect as same party member (new socket; party size claim remains).
  admitPartyMember(players, bots, maxPlayers, {
    socketId: "s1b",
    name: "Alpha",
    partyId,
    partySize,
  });
  // Second member still present — finish when party complete path would fire.
  const report2 = bots.finishAdmissionBatch(maxPlayers);
  assertEquals(report2.humanCount, 2);
  assertEquals(report2.fillBotCount, 2);
  assertEquals(
    players.listPartyMembers(partyId).map((p) => p.team).every(
      (t, _, arr) => t === arr[0],
    ),
    true,
  );
});

Deno.test("S9-PR3: pool pawns on both teams stay until eviction; balance preserved", () => {
  const { players, bots, maxPlayers } = setup({
    maxPlayers: 8,
    minPlayers: 0,
  });
  bots.clear();
  bots.setMinPlayers(4);
  bots.setNoBotsOnEmptyServer(false);
  const profileData = encodeProfileData(
    new TextEncoder().encode(JSON.stringify(COMMUNITY_BOT_CONFIG)),
  );
  bots.putPoolIdentities([1, 2, 3, 4, 5, 6].map((n) => ({
    id: `pool-${n}`,
    name: `Pawn${n}`,
    accountId: `pool_account_${n}`,
    profile: "community",
    profileData,
  })));
  bots.reconcile(maxPlayers);
  assert(bots.fillBotCount >= 4, "seeded fill should occupy seats");
  // Force team spread: move half of fill bots to each side if needed.
  const fill = players.bots().filter((p) => !p.isBalanceBot);
  let i = 0;
  for (const p of fill) {
    p.team = i % 2 === 0 ? "A" : "B";
    i++;
  }
  const teamsBefore = {
    A: fill.filter((p) => p.team === "A").length,
    B: fill.filter((p) => p.team === "B").length,
  };
  assert(teamsBefore.A >= 1 && teamsBefore.B >= 1, "seeds on both teams");

  // Party of 2 joins one side — bulk evict, single settle.
  const partyId = "op_seed";
  admitPartyMember(players, bots, maxPlayers, {
    socketId: "h1",
    name: "H1",
    partyId,
    partySize: 2,
  });
  admitPartyMember(players, bots, maxPlayers, {
    socketId: "h2",
    name: "H2",
    partyId,
    partySize: 2,
  });
  const report = bots.finishAdmissionBatch(maxPlayers);
  assertEquals(report.humanCount, 2);
  // Seed/fill still present around the party; balance bot only if uneven.
  assertEquals(report.fillBotCount >= 0, true);
  const totals = players.teamCounts();
  assertEquals(Math.abs(totals.A - totals.B) <= 1, true);
});

Deno.test("S9-PR3: one free slot — party of 2 only needs one eviction", () => {
  const { players, bots, maxPlayers } = setup({
    maxPlayers: 4,
    minPlayers: 4,
    noBotsOnEmptyServer: false,
  });
  // 1 human + bots to leave exactly one free seat (non-agent 3 / max 4).
  players.add("solo", "Solo", "A");
  bots.setMinPlayers(2);
  bots.reconcile(maxPlayers);
  // 1 human + 1 fill (± balance) — ensure non-agent is 3 so freeSlots=1.
  while (players.nonAgentCount() < 3) {
    bots.addBots(1, maxPlayers);
  }
  while (players.nonAgentCount() > 3) {
    bots.tryEvictOne();
  }
  assertEquals(players.nonAgentCount(), 3);
  assertEquals(maxPlayers - players.nonAgentCount(), 1);

  const partyId = "op_onefree";
  // Party of 2, free=1 → first member only needs to free 1 more seat.
  const r1 = admitPartyMember(players, bots, maxPlayers, {
    socketId: "p1",
    name: "P1",
    partyId,
    partySize: 2,
  });
  assertEquals(r1.evicted, 1);
  const r2 = admitPartyMember(players, bots, maxPlayers, {
    socketId: "p2",
    name: "P2",
    partyId,
    partySize: 2,
  });
  assertEquals(r2.evicted, 0);
  const report = bots.finishAdmissionBatch(maxPlayers);
  assertEquals(report.humanCount, 3);
  assertEquals(report.botsEvicted, 1);
  // max 4 with 3 humans → at most 1 body of bots (fill and/or balance).
  assertEquals(players.nonAgentCount() <= maxPlayers, true);
  assertEquals(report.fillBotCount + (report.balanceBot ? 1 : 0) <= 1, true);
});

Deno.test("S9-PR3: no free balance-bot slot when full of humans", () => {
  const { players, bots, maxPlayers } = setup({
    maxPlayers: 4,
    minPlayers: 0,
  });
  // 3 humans on A, 1 on B → uneven, balance would want a slot.
  players.add("a1", "A1", "A");
  players.add("a2", "A2", "A");
  players.add("a3", "A3", "A");
  players.add("b1", "B1", "B");
  bots.reconcile(maxPlayers);
  // Full of humans — no room for named balance bot.
  assertEquals(players.nonAgentCount(), 4);
  assertEquals(bots.hasBalanceBot(), false);
  assertEquals(players.teamCounts(), { A: 3, B: 1 });
});

Deno.test("S9-PR3: balance bot appears when a roster slot remains uneven", () => {
  const { players, bots, maxPlayers } = setup({
    maxPlayers: 8,
    minPlayers: 0,
  });
  players.add("a1", "A1", "A");
  players.add("a2", "A2", "A");
  players.add("b1", "B1", "B");
  bots.reconcile(maxPlayers);
  assertEquals(bots.hasBalanceBot(), true);
  assertEquals(players.teamCounts(), { A: 2, B: 2 });
  const bal = [...players.all()].find((p) => p.isBalanceBot);
  assertEquals(bal?.name, "bot");
  assertEquals(bal?.team, "B");
});

Deno.test("S9-PR3: multiple batched parties reconcile once", () => {
  const { players, bots, maxPlayers } = setup({
    maxPlayers: 8,
    minPlayers: 8,
    noBotsOnEmptyServer: false,
  });
  bots.reconcile(maxPlayers);
  assertEquals(bots.fillBotCount, 8);

  // Simulate Story 6 packing two parties onto one runtime.
  bots.startAdmissionBatch();
  const parties = [
    { id: "op_p1", size: 2, names: ["A1", "A2"] },
    { id: "op_p2", size: 2, names: ["B1", "B2"] },
  ] as const;

  const midWaveFillSamples: number[] = [];
  for (const party of parties) {
    for (let i = 0; i < party.size; i++) {
      admitPartyMember(players, bots, maxPlayers, {
        socketId: `${party.id}-${i}`,
        name: party.names[i]!,
        partyId: party.id,
        partySize: party.size,
      });
      midWaveFillSamples.push(bots.fillBotCount);
    }
  }
  // Mid-wave fill count must not climb back up (no per-join reconcile thrash).
  // After bulk evict for parties, fill only shrinks until finish.
  for (let i = 1; i < midWaveFillSamples.length; i++) {
    assert(
      midWaveFillSamples[i]! <= midWaveFillSamples[i - 1]!,
      `fill bots re-grew mid-wave: ${midWaveFillSamples.join(",")}`,
    );
  }

  const report = bots.finishAdmissionBatch(maxPlayers);
  assertEquals(report.humanCount, 4);
  assertEquals(report.fillBotCount, 4);
  // Each party cohesive.
  for (const party of parties) {
    const members = players.listPartyMembers(party.id);
    assertEquals(members.length, party.size);
    assert(members.every((m) => m.team === members[0]!.team));
  }
});

Deno.test("S9-PR3: final even team totals drop balance bot", () => {
  const { players, bots, maxPlayers } = setup({
    maxPlayers: 8,
    minPlayers: 0,
  });
  // Two parties of 2 seated on opposite sides → even, no balance bot.
  bots.startAdmissionBatch();
  for (const [id, names, teamHint] of [
    ["op_e1", ["E1", "E2"], "A"],
    ["op_e2", ["E3", "E4"], "B"],
  ] as const) {
    for (const name of names) {
      const team = players.pickTeamForJoin({ partyId: id, partySize: 2 });
      // First party lands A (empty), second should land B.
      void teamHint;
      players.add(`${id}-${name}`, name, team, {
        partyId: id,
        partySize: 2,
      });
      bots.onHumanJoined(maxPlayers);
    }
  }
  const report = bots.finishAdmissionBatch(maxPlayers);
  assertEquals(report.humanCount, 4);
  assertEquals(report.humanTeamCounts, { A: 2, B: 2 });
  assertEquals(report.balanceBot, false);
  assertEquals(report.teamCounts, { A: 2, B: 2 });
});

Deno.test("S9-PR3: final odd team totals keep single balance bot", () => {
  const { players, bots, maxPlayers } = setup({
    maxPlayers: 8,
    minPlayers: 0,
  });
  bots.startAdmissionBatch();
  // Party of 3 on one side + solo on the other → 3v1 underlying, balance on light.
  const partyId = "op_odd";
  for (let i = 0; i < 3; i++) {
    const team = players.pickTeamForJoin({ partyId, partySize: 3 });
    players.add(`p${i}`, `P${i}`, team, { partyId, partySize: 3 });
    bots.onHumanJoined(maxPlayers);
  }
  // Solo opposite or same — pickTeamForHuman balances.
  const soloTeam = players.pickTeamForJoin({});
  players.add("solo", "Solo", soloTeam);
  bots.onHumanJoined(maxPlayers);

  const report = bots.finishAdmissionBatch(maxPlayers);
  assertEquals(report.humanCount, 4);
  // Party of 3 + solo of 1 → human teams 3v1; balance pads light side → 3v2 totals.
  assertEquals(
    Math.abs(report.humanTeamCounts.A - report.humanTeamCounts.B),
    2,
  );
  assertEquals(report.balanceBot, true);
  assertEquals(Math.abs(report.teamCounts.A - report.teamCounts.B), 1);
});

Deno.test("S9-PR3: metrics report includes final team sizes and filler action", () => {
  const { players, bots, maxPlayers } = setup({
    maxPlayers: 6,
    minPlayers: 6,
    noBotsOnEmptyServer: false,
  });
  bots.reconcile(maxPlayers);
  bots.startAdmissionBatch();
  const evicted = bots.tryEvict(2, "A");
  players.add("h1", "H1", "A", { partyId: "op_m", partySize: 2 });
  bots.onHumanJoined(maxPlayers);
  players.add("h2", "H2", "A", { partyId: "op_m", partySize: 2 });
  bots.onHumanJoined(maxPlayers);
  const report: BotAdmissionReconcileReport = bots.finishAdmissionBatch(
    maxPlayers,
  );
  assertEquals(report.botsEvicted, evicted);
  assertEquals(typeof report.fillBotCount, "number");
  assertEquals(typeof report.balanceBot, "boolean");
  assertEquals(typeof report.humanCount, "number");
  assertEquals(typeof report.teamCounts.A, "number");
  assertEquals(typeof report.teamCounts.B, "number");
  assertEquals(typeof report.humanTeamCounts.A, "number");
  assertEquals(typeof report.humanTeamCounts.B, "number");
});
