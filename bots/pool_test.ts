import { assert, assertEquals } from "@std/assert";
import { ownedSkillsForLevel } from "../shared/sim/skills.ts";
import { BotManager, type PoolRosterEvent } from "./BotManager.ts";
import { COMMUNITY_BOT_CONFIG } from "./botBrainConfig.ts";
import { encodeProfileData } from "../host/channel/protocol.ts";
import { PlayerManager } from "../players/PlayerManager.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";
import type { PoolIdentity } from "../host/channel/protocol.ts";

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

function harness() {
  const collision = new MapCollision(testMap());
  const players = new PlayerManager(collision);
  const events: PoolRosterEvent[] = [];
  const bots = new BotManager(players, {}, {
    fill: { minPlayers: 2, noBotsOnEmptyServer: false },
  });
  bots.setPoolListener((event) => events.push(event));
  return { collision, players, bots, events };
}

function identity(n: number, extra: Partial<PoolIdentity> = {}): PoolIdentity {
  const owned = [...ownedSkillsForLevel(3)];
  return {
    id: `pool-${n}`,
    name: `Ada${n}`,
    accountId: `pool_account_${n}`,
    profile: COMMUNITY_BOT_CONFIG.id,
    profileData: encodeProfileData(
      new TextEncoder().encode(JSON.stringify(COMMUNITY_BOT_CONFIG)),
    ),
    initialPingMs: 40,
    founderBadge: true,
    xp: 250,
    skills: {
      ownedAbilities: owned,
      skillLoadout: [null, null, null, null],
    },
    ...extra,
  };
}

Deno.test("pool: empty queue falls back to botN", () => {
  const { players, bots } = harness();
  bots.reconcile(8);
  const names = players.bots().filter((p) => !p.isBalanceBot).map((p) => p.name);
  assert(names.length >= 1);
  for (const name of names) assert(/^bot\d+$/i.test(name));
});

Deno.test("pool: next identity is taken, then ping is host-driven", () => {
  const { collision, players, bots, events } = harness();
  const owned = [...ownedSkillsForLevel(3)];
  const accepted = bots.putPoolIdentities([identity(1)]);
  assertEquals(accepted.dropped, []);
  bots.setMinPlayers(1);
  bots.reconcile(8);
  const pawn = players.bots().find((p) => p.name === "Ada1");
  assert(pawn);
  assertEquals(pawn!.accountUserId, "pool_account_1");
  assertEquals(pawn!.poolAccount, true);
  assertEquals(pawn!.isMatchPlayer(), true);
  assertEquals(pawn!.founderBadge, true);
  assertEquals(pawn!.xp, 250);
  assertEquals(pawn!.pingMs, 40);
  assertEquals(pawn!.snapshotOwnedAbilities(), owned);
  assertEquals(bots.list().find((row) => row.id === pawn!.id)?.brainId, "community");
  assertEquals(events[0], {
    type: "pawn-took",
    identityId: "pool-1",
    pawnId: pawn!.id,
  });

  bots.setPawnPing(pawn!.id, 88.4);
  assertEquals(pawn!.pingMs, 88);
  for (let tick = 0; tick < 120; tick++) bots.tick(tick, collision);
  assertEquals(pawn!.pingMs, 88);

  bots.tryEvict(1);
  const removed = events.find((event) => event.type === "pawn-removed");
  assertEquals(removed, {
    type: "pawn-removed",
    identityId: "pool-1",
    pawnId: pawn!.id,
    reason: "eviction",
  });
});

Deno.test("pool: taken and duplicate names are dropped", () => {
  const { players, bots, events } = harness();
  players.add("human", "Ada1", "A");
  const result = bots.putPoolIdentities([
    identity(1),
    identity(2, { name: "Ada1" }),
    identity(3, { id: "pool-3", name: "Bea" }),
  ]);
  assertEquals(result.accepted, ["pool-3"]);
  assertEquals(result.dropped.map((row) => row.reason), [
    "name-taken",
    "name-taken",
  ]);
  // The put reply carries the drops, so no separate event is sent.
  assert(!events.some((event) => event.type === "identity-dropped"));
});

Deno.test("pool: missing profileData is still queued", () => {
  const { bots } = harness();
  const result = bots.putPoolIdentities([
    identity(1, { profileData: undefined }),
  ]);
  assertEquals(result.accepted, ["pool-1"]);
  assertEquals(result.dropped, []);
});

Deno.test("pool: boot botN fill is swapped for pool identities while empty", () => {
  const { players, bots, events } = harness();
  bots.setMinPlayers(4);
  bots.reconcile(8);
  const before = players.bots().filter((p) => !p.isBalanceBot);
  assertEquals(before.length, 4);
  for (const p of before) assert(/^bot\d+$/i.test(p.name));
  const teams = { A: 0, B: 0 };
  for (const p of before) teams[p.team]++;

  bots.putPoolIdentities([1, 2, 3].map((n) => identity(n)));

  const after = players.bots().filter((p) => !p.isBalanceBot);
  assertEquals(after.length, 4);
  assertEquals(
    after.map((p) => p.name).filter((name) => /^Ada\d$/.test(name)).sort(),
    ["Ada1", "Ada2", "Ada3"],
  );
  const teamsAfter = { A: 0, B: 0 };
  for (const p of after) teamsAfter[p.team]++;
  assertEquals(teamsAfter, teams);
  assertEquals(events.filter((event) => event.type === "pawn-took").length, 3);
});

Deno.test("pool: botN is not swapped while a human is on", () => {
  const { players, bots } = harness();
  players.add("human", "Hu", "A");
  bots.setMinPlayers(4);
  bots.reconcile(8);
  bots.putPoolIdentities([identity(1)]);
  assert(!players.bots().some((p) => p.name === "Ada1"));
});
