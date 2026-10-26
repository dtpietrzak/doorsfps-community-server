import { assertEquals, assertExists } from "jsr:@std/assert";
import { PlayerManager } from "./PlayerManager.ts";
import { PREMATCH_CONFIG } from "../protocol/network.ts";
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

function makePrematchManager(): PlayerManager {
  return new PlayerManager(new MapCollision(miniMap), {
    enablePrematch: true,
  });
}

function makeOpenManager(): PlayerManager {
  return new PlayerManager(new MapCollision(miniMap));
}

Deno.test("prematch: ranked manager starts in prematch with doors closed", () => {
  const pm = makePrematchManager();
  assertEquals(pm.isPrematchEnabled(), true);
  assertEquals(pm.isPrematch(), true);
  assertEquals(pm.getMatchPhase(), "prematch");
  assertEquals(pm.areDoorsOpen(0), false);
  assertEquals(pm.getDoorCycleState(0).doorsOpen, false);
});

Deno.test("debug force doors: overrides prematch / cycle closed", () => {
  const pm = makePrematchManager();
  assertEquals(pm.areDoorsOpen(0), false);
  assertEquals(pm.setDebugForceDoorsOpen(true), true);
  assertEquals(pm.isDebugForceDoorsOpen(), true);
  assertEquals(pm.areDoorsOpen(0), true);
  assertEquals(pm.getDoorCycleState(0).doorsOpen, true);

  // Still open after clearing power-up style holds via toggle off/on.
  assertEquals(pm.toggleDebugForceDoorsOpen(), false);
  assertEquals(pm.areDoorsOpen(0), false);
  assertEquals(pm.setDebugForceDoorsOpen(true), true);
  assertEquals(pm.areDoorsOpen(999_999), true);
});

Deno.test("prematch: open manager starts live with doors open", () => {
  const pm = makeOpenManager();
  assertEquals(pm.isPrematchEnabled(), false);
  assertEquals(pm.isPrematch(), false);
  assertEquals(pm.isLive(), true);
  assertEquals(pm.getMatchPhase(), "live");
  assertEquals(pm.areDoorsOpen(0), true);
});

Deno.test("prematch: cannot start with fewer than minHumans", () => {
  const pm = makePrematchManager();
  // 2 humans → 1v1, under min 4
  pm.add("s1", "A1");
  pm.add("s2", "B1");
  assertEquals(pm.humanCount(), 2);
  assertEquals(pm.canStartFromPrematch(), false);

  pm.setMatchReady("s1", true);
  pm.setMatchReady("s2", true);
  assertEquals(pm.tryStartLiveFromReady(10), null);
  assertEquals(pm.isPrematch(), true);
});

Deno.test("prematch: cannot start with uneven human teams", () => {
  const pm = makePrematchManager();
  // Force 3v1 by adding then we need uneven - pickTeamForHuman balances,
  // so add 4 then move one... easier: add 3 and check canStart false.
  pm.add("s1", "P1");
  pm.add("s2", "P2");
  pm.add("s3", "P3");
  assertEquals(pm.humanCount(), 3);
  assertEquals(pm.canStartFromPrematch(), false);

  // 4 humans should be even 2v2 via pickTeamForHuman.
  pm.add("s4", "P4");
  const teams = pm.humanTeamCounts();
  assertEquals(teams.A + teams.B, 4);
  assertEquals(teams.A, teams.B);
  assertEquals(pm.canStartFromPrematch(), true);
});

Deno.test("prematch: unanimous ready starts live match", () => {
  const pm = makePrematchManager();
  const ids = ["s1", "s2", "s3", "s4"];
  for (const id of ids) pm.add(id, `Player-${id}`);

  assertEquals(pm.canStartFromPrematch(), true);
  assertEquals(pm.tryStartLiveFromReady(5), null); // not all ready

  for (const id of ids.slice(0, 3)) {
    assertEquals(pm.setMatchReady(id, true), true);
  }
  assertEquals(pm.tryStartLiveFromReady(5), null);

  assertEquals(pm.setMatchReady("s4", true), true);
  const start = pm.tryStartLiveFromReady(100);
  assertExists(start);
  assertEquals(start.phase, "live");
  assertEquals(start.doorsOpen, true);
  assertEquals(pm.isPrematch(), false);
  assertEquals(pm.isLive(), true);
  assertEquals(pm.getMatchPhase(), "live");
  // Unlimited ammo off after live start.
  for (const p of pm.humans()) {
    assertEquals(p.unlimitedAmmo, false);
  }
});

Deno.test("prematch: ready votes clear on human join/leave", () => {
  const pm = makePrematchManager();
  pm.add("s1", "A");
  pm.add("s2", "B");
  pm.add("s3", "C");
  pm.add("s4", "D");

  for (const id of ["s1", "s2", "s3", "s4"]) {
    pm.setMatchReady(id, true);
  }
  assertEquals(pm.getPrematchState().humansReady, 4);

  // New human join clears votes.
  pm.add("s5", "E");
  assertEquals(pm.getPrematchState().humansReady, 0);
  assertEquals(pm.getPrematchState().readyPlayerIds.length, 0);

  for (const id of ["s1", "s2", "s3", "s4", "s5"]) {
    pm.setMatchReady(id, true);
  }
  // Even with 5 ready, uneven teams block start.
  assertEquals(pm.canStartFromPrematch(), false);

  // Leave clears all votes again.
  pm.remove("s5");
  assertEquals(pm.getPrematchState().humansReady, 0);
});

Deno.test("prematch: no door scoring during warm-up", () => {
  const pm = makePrematchManager();
  const p = pm.add("s1", "Alice", "A");
  // Even if standing in a door zone, warm-up never awards captures.
  p.x = 0;
  p.z = 0;
  p.alive = true;

  const scores = pm.processScores(50);
  assertEquals(scores.length, 0);
  assertEquals(pm.getScores(), { A: 0, B: 0 });
  // processScores short-circuits on unscored prematch regardless of position.
  assertEquals(pm.isPrematch(), true);
});

Deno.test("prematch: unlimited ammo during warm-up", () => {
  const pm = makePrematchManager();
  const p = pm.add("s1", "Shooter");
  assertEquals(p.unlimitedAmmo, PREMATCH_CONFIG.unlimitedAmmo);

  const mag = p.ammoInMag;
  assertEquals(p.canShoot(0), true);
  p.markShot(0);
  // Mag does not empty.
  assertEquals(p.ammoInMag, mag);
});

Deno.test("prematch: bots do not count toward min humans or ready", () => {
  const pm = makePrematchManager();
  pm.add("s1", "H1");
  pm.add("s2", "H2");
  pm.addBot("bot1", "Bot One");
  pm.addBot("bot2", "Bot Two");
  pm.addBot("bot3", "Bot Three");
  pm.addBot("bot4", "Bot Four");

  assertEquals(pm.humanCount(), 2);
  assertEquals(pm.canStartFromPrematch(), false);
  assertEquals(pm.setMatchReady("bot1", true), false);
});

Deno.test("prematch: after live match ends, startNewMatch returns to prematch", () => {
  const pm = makePrematchManager();
  for (const id of ["s1", "s2", "s3", "s4"]) pm.add(id, id);
  for (const id of ["s1", "s2", "s3", "s4"]) pm.setMatchReady(id, true);
  assertExists(pm.tryStartLiveFromReady(10));
  assertEquals(pm.isLive(), true);

  // Force end via score path: set winning scores.
  // Use forceDraw is no-op? forceDraw ends live as draw.
  const over = pm.forceDraw(200);
  assertExists(over);
  assertEquals(pm.getMatchPhase(), "intermission");

  // Host-style restart (no intermission wait): startNewMatch → prematch.
  const next = pm.startNewMatch(300);
  assertEquals(next.phase, "prematch");
  assertEquals(pm.isPrematch(), true);
  assertEquals(pm.areDoorsOpen(300), false);
});

Deno.test("prematch: respawns work while doors locked in warm-up", () => {
  const pm = makePrematchManager();
  const p = pm.add("s1", "Dead");
  const killTick = 120;
  assertEquals(p.takeDamage(200, "body", killTick, Date.now()), true);
  assertEquals(p.alive, false);

  // RESPAWN_DELAY is ~2s * 60 = 120 ticks roughly; jump far ahead.
  const respawned = pm.processRespawns(killTick + 10_000);
  assertEquals(respawned.length, 1);
  assertEquals(p.alive, true);
});
