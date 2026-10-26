/**
 * Equivalence probe for replay epic 5.5: live PlayerManager mutations map
 * 1:1 onto AuthoritativeEvent variants with unchanged observable state.
 */
import { assertEquals, assertExists } from "jsr:@std/assert@1";
import type { DoorsMap } from "../world/map.ts";
import { MapCollision } from "../world/MapCollision.ts";
import { PlayerManager } from "./PlayerManager.ts";
import {
  normalizeAuthoritativeEvent,
  sortAuthoritativeEvents,
  type AuthoritativeEvent,
} from "../shared/sim/authoritativeEvent.ts";
import { rosterSnapshotFromPlayer } from "./authoritativeEventDerive.ts";

const map: DoorsMap = {
  name: "auth-events",
  version: 2,
  bounds: { minX: -40, maxX: 40, minZ: -40, maxZ: 40 },
  gridSize: 1,
  walls: [],
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
};

function makePm(
  options?: ConstructorParameters<typeof PlayerManager>[1],
): PlayerManager {
  return new PlayerManager(new MapCollision(map), {
    matchSeed: 12345,
    nowMs: 1_000_000,
    ...options,
  });
}

function kinds(events: readonly AuthoritativeEvent[]): string[] {
  return events.map((e) => e.kind);
}

Deno.test("equivalence: human/bot/agent add+remove → 1:1 events", () => {
  const pm = makePm();
  pm.drainAuthoritativeEvents();

  const human = pm.add("sock-h", "Human", "A");
  const bot = pm.addBot("bot-1", "BotOne", { team: "B" });
  const agent = pm.addAgent("agent-1", "Agent", "A", {
    x: 1,
    y: 1.6,
    z: 2,
    yaw: 0.5,
  });

  const added = pm.drainAuthoritativeEvents();
  // Keys-only bots: a fill bot records exactly like a human join.
  assertEquals(kinds(added), ["humanJoin", "humanJoin", "agentAdd"]);

  const humanEv = added[0];
  assertEquals(humanEv.kind, "humanJoin");
  if (humanEv.kind === "humanJoin") {
    assertEquals(humanEv.player.id, human.id);
    assertEquals(humanEv.player.pose.x, human.x);
    assertEquals(humanEv.player.pose.z, human.z);
    assertEquals(humanEv.player.team, "A");
  }

  const botEv = added[1];
  assertEquals(botEv.kind, "humanJoin");
  if (botEv.kind === "humanJoin") {
    assertEquals(botEv.player.id, bot.id);
    // The wire `isBot` means "raid bot" now; an arena bot is a plain player.
    assertEquals(botEv.player.isBot, false);
    assertEquals(botEv.player.isAgent, false);
  }

  const agentEv = added[2];
  assertEquals(agentEv.kind, "agentAdd");
  if (agentEv.kind === "agentAdd") {
    assertEquals(agentEv.player.id, agent.id);
    assertEquals(agentEv.player.isAgent, true);
    assertEquals(agentEv.player.unlimitedAmmo, true);
    assertEquals(agentEv.player.pose.x, 1);
    assertEquals(agentEv.player.pose.z, 2);
  }

  pm.remove("agent-1");
  pm.remove("bot-1");
  pm.remove("sock-h");
  assertEquals(kinds(pm.drainAuthoritativeEvents()), [
    "agentRemove",
    "playerRemove",
    "playerRemove",
  ]);
  assertEquals(pm.size, 0);
});

Deno.test("equivalence: team switch / bot rebalance / loadout / config", () => {
  const pm = makePm();
  pm.add("h1", "H1", "A");
  pm.addBot("b1", "B1", { team: "A" });
  pm.addBot("b2", "B2", { team: "A" });
  pm.addBot("b3", "B3", { team: "A" });
  pm.drainAuthoritativeEvents();

  const switched = pm.changeTeam("h1", { autofillBots: 0, team: "B" });
  assertEquals(switched.ok, true);
  const teamEv = pm.drainAuthoritativeEvents();
  assertEquals(kinds(teamEv), ["teamAssign"]);
  if (teamEv[0]?.kind === "teamAssign") {
    assertEquals(teamEv[0].reason, "switch");
    assertEquals(teamEv[0].from, "A");
    assertEquals(teamEv[0].to, "B");
    assertEquals(teamEv[0].player.team, "B");
    // Recorded pose matches live post-respawn pose.
    const live = pm.get("h1")!;
    assertEquals(teamEv[0].player.pose.x, live.x);
    assertEquals(teamEv[0].player.pose.z, live.z);
  }

  // After switch: A has 3 bots, B has 1 human → rebalance moves bots.
  const moved = pm.rebalanceBotTeams();
  assertEquals(moved.length > 0, true);
  const rebal = pm.drainAuthoritativeEvents();
  assertEquals(rebal.every((e) => e.kind === "teamAssign"), true);
  assertEquals(
    rebal.every((e) =>
      e.kind === "teamAssign" && e.reason === "botRebalance"
    ),
    true,
  );

  // Non-array loadout ignored — no event.
  pm.handleSkillLoadout("h1", "nope");
  assertEquals(pm.drainAuthoritativeEvents().length, 0);

  pm.handleSkillLoadout("h1", ["quick", null, null, null]);
  const loadoutEv = pm.drainAuthoritativeEvents();
  assertEquals(kinds(loadoutEv), ["loadoutCommit"]);
  if (loadoutEv[0]?.kind === "loadoutCommit") {
    assertEquals(loadoutEv[0].loadout?.[0], "quick");
    assertEquals(pm.get("h1")!.snapshotSkillLoadout()?.[0], "quick");
  }

  pm.setRaidDoorPolicy("open");
  pm.setDebugForceDoorsOpen(true);
  pm.toggleDebugForceDoorsOpen();
  const cfg = pm.drainAuthoritativeEvents();
  assertEquals(kinds(cfg), ["matchConfig", "matchConfig", "matchConfig"]);
  assertEquals(pm.isDebugForceDoorsOpen(), false);
});

Deno.test("equivalence: connection issue + restore", () => {
  const pm = makePm();
  pm.add("h1", "H1", "A");
  pm.drainAuthoritativeEvents();

  assertEquals(pm.markConnectionIssue("h1", 1_000_000), true);
  const issued = pm.drainAuthoritativeEvents();
  assertEquals(kinds(issued), ["connectionStatus"]);
  if (issued[0]?.kind === "connectionStatus") {
    assertEquals(issued[0].connectionIssue, true);
    assertEquals(issued[0].respawned, false);
  }
  assertEquals(pm.get("h1")!.connectionIssue, true);

  const restored = pm.restoreConnection("h1", "sock-new", 10, 1_000_100);
  assertExists(restored);
  const restEv = pm.drainAuthoritativeEvents();
  assertEquals(kinds(restEv), ["connectionStatus"]);
  if (restEv[0]?.kind === "connectionStatus") {
    assertEquals(restEv[0].connectionIssue, false);
    assertEquals(restEv[0].socketId, "sock-new");
  }
  assertEquals(pm.get("h1")!.connectionIssue, false);
});

Deno.test("equivalence: ready vote + match lifecycle end/draw/start", () => {
  const pm = makePm({ enablePrematch: true });
  pm.add("h1", "H1", "A");
  pm.add("h2", "H2", "B");
  // Join in prematch clears ready votes when configured.
  pm.drainAuthoritativeEvents();

  assertEquals(pm.setMatchReady("h1", true), true);
  assertEquals(pm.setMatchReady("h1", true), false); // no-op duplicate
  assertEquals(kinds(pm.drainAuthoritativeEvents()), ["readyVote"]);

  pm.beginLiveMatch(100, 1_000_000);
  const startEv = pm.drainAuthoritativeEvents();
  assertEquals(kinds(startEv), ["matchStart"]);
  if (startEv[0]?.kind === "matchStart") {
    assertEquals(startEv[0].phase, "live");
    assertEquals(startEv[0].roster.length, 2);
  }

  const end = pm.forceEndMatch(200, "A", {
    scheduleRestart: true,
    restartSeconds: 5,
  });
  assertExists(end);
  const endEv = pm.drainAuthoritativeEvents();
  assertEquals(kinds(endEv), ["matchEnd"]);
  if (endEv[0]?.kind === "matchEnd") {
    assertEquals(endEv[0].winner, "A");
    assertEquals(endEv[0].scheduleRestart, true);
    assertEquals(endEv[0].restartSeconds, 5);
    assertExists(endEv[0].restartAtTick);
  }

  // Restart → prematch on ranked.
  const restarted = pm.maybeRestartMatch(endEv[0]!.kind === "matchEnd"
    ? (endEv[0].restartAtTick ?? 200)
    : 200);
  assertExists(restarted);
  assertEquals(kinds(pm.drainAuthoritativeEvents()), ["matchStart"]);

  // Draw path.
  pm.beginLiveMatch(500, 1_000_000);
  pm.drainAuthoritativeEvents();
  pm.forceDraw(510);
  assertEquals(kinds(pm.drainAuthoritativeEvents()), ["matchDraw"]);
});

Deno.test("buildMatchInitEvent: snapshot matches live roster/config", () => {
  const pm = makePm({ enablePrematch: true, matchSeed: 42 });
  pm.add("h1", "H1", "A");
  pm.addBot("b1", "B1", { team: "B" });
  pm.setRaidDoorPolicy("idle");
  pm.drainAuthoritativeEvents();

  const init = pm.buildMatchInitEvent(0);
  const n = normalizeAuthoritativeEvent(init);
  assertEquals(n?.kind, "matchInit");
  if (n?.kind === "matchInit") {
    assertEquals(n.map.name, "auth-events");
    assertEquals(n.map.version, 2);
    assertEquals(n.matchSeed, 42);
    assertEquals(n.prematchEnabled, true);
    assertEquals(n.raidDoorPolicy, "idle");
    assertEquals(n.roster.length, 2);
    const ids = n.roster.map((r) => r.id).sort();
    assertEquals(ids, ["b1", "h1"]);
    // Snapshot equals derive helper.
    assertEquals(
      n.roster.find((r) => r.id === "h1"),
      rosterSnapshotFromPlayer(pm.get("h1")!),
    );
  }
});

Deno.test("spawn pose recorded equals live pose after join", () => {
  const pm = makePm({ matchSeed: 777 });
  const a = pm.add("a", "A", "A");
  const b = pm.add("b", "B", "B");
  const events = pm.drainAuthoritativeEvents().filter((e) =>
    e.kind === "humanJoin"
  );
  assertEquals(events.length, 2);
  for (const ev of events) {
    if (ev.kind !== "humanJoin") continue;
    const live = pm.get(ev.player.id)!;
    assertEquals(ev.player.pose, {
      x: live.x,
      y: live.y,
      z: live.z,
      yaw: live.yaw,
      pitch: live.pitch,
    });
  }
  // Same seed + same join order reproduces poses.
  const pm2 = makePm({ matchSeed: 777 });
  const a2 = pm2.add("a", "A", "A");
  const b2 = pm2.add("b", "B", "B");
  assertEquals(a2.x, a.x);
  assertEquals(a2.z, a.z);
  assertEquals(b2.x, b.x);
  assertEquals(b2.z, b.z);
});

Deno.test("sortAuthoritativeEvents: lifecycle before roster before commits", () => {
  const pm = makePm({ enablePrematch: true });
  pm.add("z", "Z", "A");
  pm.add("a", "A", "B");
  pm.setMatchReady("a", true);
  pm.setRaidDoorPolicy("open");
  const raw = pm.drainAuthoritativeEvents();
  const sorted = sortAuthoritativeEvents(raw);
  const cats = sorted.map((e) => {
    if (
      e.kind === "matchConfig" || e.kind === "matchStart" ||
      e.kind === "matchInit" || e.kind === "matchEnd" || e.kind === "matchDraw"
    ) {
      return "lifecycleConfig";
    }
    if (
      e.kind === "teamAssign" || e.kind === "loadoutCommit" ||
      e.kind === "readyVote"
    ) {
      return "commit";
    }
    return "roster";
  });
  // Categories are non-decreasing in the sorted stream.
  let prev = 0;
  const rank = { lifecycleConfig: 0, roster: 1, commit: 2 } as const;
  for (const c of cats) {
    const r = rank[c];
    assertEquals(r >= prev, true);
    prev = r;
  }
});
