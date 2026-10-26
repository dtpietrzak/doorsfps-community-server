import { assertEquals } from "jsr:@std/assert";
import { rankedSessionStatus } from "./rankedSession.ts";
import { PlayerManager } from "../players/PlayerManager.ts";
import { BotManager } from "../bots/BotManager.ts";
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

Deno.test("rankedSessionStatus: ranked prematch empty is joinable", () => {
  const s = rankedSessionStatus({
    ranked: true,
    phase: "prematch",
    humanCount: 0,
    maxPlayers: 8,
  });
  assertEquals(s.freeSlots, 8);
  assertEquals(s.joinable, true);
});

Deno.test("rankedSessionStatus: ranked live is not joinable", () => {
  const s = rankedSessionStatus({
    ranked: true,
    phase: "live",
    humanCount: 4,
    maxPlayers: 8,
  });
  assertEquals(s.freeSlots, 4);
  assertEquals(s.joinable, false);
});

Deno.test("rankedSessionStatus: ranked intermission not joinable", () => {
  const s = rankedSessionStatus({
    ranked: true,
    phase: "intermission",
    humanCount: 2,
    maxPlayers: 8,
  });
  assertEquals(s.freeSlots, 6);
  assertEquals(s.joinable, false);
});

Deno.test("rankedSessionStatus: ranked full prematch not joinable", () => {
  const s = rankedSessionStatus({
    ranked: true,
    phase: "prematch",
    humanCount: 8,
    maxPlayers: 8,
  });
  assertEquals(s.freeSlots, 0);
  assertEquals(s.joinable, false);
});

Deno.test("rankedSessionStatus: open mid-live is joinable when seats free", () => {
  const s = rankedSessionStatus({
    ranked: false,
    phase: "live",
    humanCount: 3,
    maxPlayers: 8,
  });
  assertEquals(s.freeSlots, 5);
  assertEquals(s.joinable, true);
});

Deno.test("empty reset: live → enterPrematch clears scores, void, phase", () => {
  const pm = new PlayerManager(new MapCollision(miniMap), {
    enablePrematch: true,
  });
  for (const id of ["s1", "s2", "s3", "s4"]) {
    pm.add(id, id, undefined, { accountUserId: `u_${id}` });
  }
  for (const id of ["s1", "s2", "s3", "s4"]) pm.setMatchReady(id, true);
  assertEquals(pm.tryStartLiveFromReady(10)?.phase, "live");

  // Simulate mid-match scores + void.
  // processScores is gated; set scores via start then force void.
  pm.markLiveMatchVoided("s1");
  assertEquals(pm.isLiveMatchVoided(), true);

  // Everyone leaves.
  for (const id of ["s1", "s2", "s3", "s4"]) pm.remove(id);
  assertEquals(pm.humanCount(), 0);

  // Phase 8 hard reset.
  const start = pm.enterPrematch(200);
  assertEquals(start.phase, "prematch");
  assertEquals(pm.isPrematch(), true);
  assertEquals(pm.isLiveMatchVoided(), false);
  assertEquals(pm.getScores(), { A: 0, B: 0 });
  assertEquals(pm.areDoorsOpen(200), false);
  assertEquals(pm.getPrematchState().humansReady, 0);
  assertEquals(pm.getPrematchState().humanCount, 0);

  // Joinable for next party.
  const status = rankedSessionStatus({
    ranked: true,
    phase: pm.getMatchPhase(),
    humanCount: pm.humanCount(),
    maxPlayers: 8,
  });
  assertEquals(status.joinable, true);
  assertEquals(status.freeSlots, 8);
});

Deno.test("empty reset: bots cleared with humans so lobby stays empty", () => {
  const pm = new PlayerManager(new MapCollision(miniMap), {
    enablePrematch: true,
  });
  const bots = new BotManager(pm, {}, {
    fill: { minPlayers: 4, noBotsOnEmptyServer: true },
  });

  pm.add("s1", "Solo", undefined, { accountUserId: "u1" });
  bots.reconcile(8);
  assertEquals(pm.humanCount(), 1);
  assertEquals(pm.botCount() > 0, true);

  pm.remove("s1");
  assertEquals(pm.humanCount(), 0);
  bots.clear();
  bots.reconcile(8);
  assertEquals(pm.botCount(), 0);
  assertEquals(bots.count, 0);

  pm.enterPrematch(50);
  assertEquals(pm.isPrematch(), true);
  assertEquals(pm.getScores(), { A: 0, B: 0 });
});

Deno.test("empty reset: intermission with zero humans becomes prematch", () => {
  const pm = new PlayerManager(new MapCollision(miniMap), {
    enablePrematch: true,
  });
  for (const id of ["s1", "s2", "s3", "s4"]) pm.add(id, id);
  for (const id of ["s1", "s2", "s3", "s4"]) pm.setMatchReady(id, true);
  assertEquals(pm.tryStartLiveFromReady(10)?.phase, "live");
  assertEquals(pm.forceDraw(20)?.winner, "draw");
  assertEquals(pm.getMatchPhase(), "intermission");

  for (const id of ["s1", "s2", "s3", "s4"]) pm.remove(id);
  pm.enterPrematch(30);
  assertEquals(pm.getMatchPhase(), "prematch");
  assertEquals(pm.isMatchOver(), false);
  assertEquals(
    rankedSessionStatus({
      ranked: true,
      phase: "prematch",
      humanCount: 0,
      maxPlayers: 8,
    }).joinable,
    true,
  );
});
