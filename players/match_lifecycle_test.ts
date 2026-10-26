/**
 * Epic 7.2 — match lifecycle boundary.
 *
 * Run from server-community/:
 *   deno test -A players/match_lifecycle_test.ts
 *
 * Locks: closed phase set via getMatchPhase, transition guards, restartAtTick
 * math, identity-rotation call sites, empty-ranked keep-identity, sim/driver
 * split (no sessions.emit / heatmap / authority writes inside PlayerManager
 * lifecycle methods), and single-writer rows for lifecycle fields.
 */

import {
  assertEquals,
  assertExists,
  assertMatch,
  assertNotEquals,
} from "@std/assert";
import { PlayerManager, winningTeam } from "./PlayerManager.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";
import {
  MATCH_RESTART_SECONDS,
  TICK_HZ,
  WIN_BY_MARGIN,
  WIN_SCORE,
} from "../protocol/network.ts";
import { GameServer } from "../runtime/GameServer.ts";
import { NoopAuthorityAdapter } from "../authority/adapter.ts";

const miniMap: DoorsMap = {
  name: "lifecycle",
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

const PACKAGE_ROOT = new URL("../", import.meta.url);

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function countMatches(source: string, re: RegExp): number {
  const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
  return [...source.matchAll(new RegExp(re.source, flags))].length;
}

async function readRepo(rel: string): Promise<string> {
  return await Deno.readTextFile(new URL(rel, PACKAGE_ROOT));
}

function makeOpen(): PlayerManager {
  return new PlayerManager(new MapCollision(miniMap));
}

function makePrematch(): PlayerManager {
  return new PlayerManager(new MapCollision(miniMap), { enablePrematch: true });
}

function startRankedLive(pm: PlayerManager, tick = 10): void {
  for (const id of ["s1", "s2", "s3", "s4"]) pm.add(id, id);
  for (const id of ["s1", "s2", "s3", "s4"]) pm.setMatchReady(id, true);
  assertExists(pm.tryStartLiveFromReady(tick));
  assertEquals(pm.getMatchPhase(), "live");
}

// --- Phase rows -------------------------------------------------------------

Deno.test("lifecycle phase: construct open → live; ranked → prematch", () => {
  assertEquals(makeOpen().getMatchPhase(), "live");
  assertEquals(makePrematch().getMatchPhase(), "prematch");
});

Deno.test("lifecycle phase: prematch → live → intermission → prematch|live", () => {
  const ranked = makePrematch();
  startRankedLive(ranked, 10);
  assertExists(ranked.forceDraw(50));
  assertEquals(ranked.getMatchPhase(), "intermission");
  assertEquals(ranked.startNewMatch(100).phase, "prematch");
  assertEquals(ranked.getMatchPhase(), "prematch");

  const open = makeOpen();
  assertEquals(open.getMatchPhase(), "live");
  assertExists(open.forceDraw(20));
  assertEquals(open.getMatchPhase(), "intermission");
  assertEquals(open.startNewMatch(40).phase, "live");
  assertEquals(open.getMatchPhase(), "live");
});

// --- Guard rows -------------------------------------------------------------

Deno.test("lifecycle guards: no score-end / time-end / force-draw in prematch", () => {
  const pm = makePrematch();
  assertEquals(pm.getMatchPhase(), "prematch");
  assertEquals(pm.checkMatchEnd(10), null);
  assertEquals(pm.checkMatchTimeLimit(Number.MAX_SAFE_INTEGER), null);
  assertEquals(pm.forceDraw(10), null);
});

Deno.test("lifecycle guards: no score-end / time-end / force-draw in intermission", () => {
  const pm = makeOpen();
  assertExists(pm.forceDraw(5));
  assertEquals(pm.getMatchPhase(), "intermission");
  assertEquals(pm.checkMatchEnd(10), null);
  assertEquals(pm.checkMatchTimeLimit(Number.MAX_SAFE_INTEGER), null);
  assertEquals(pm.forceDraw(10), null);
});

Deno.test("lifecycle guards: forceDraw schedules no restart", () => {
  const pm = makeOpen();
  const over = pm.forceDraw(100);
  assertExists(over);
  assertEquals(over.restartInSeconds, 0);
  assertEquals(pm.isRestartDue(100), false);
  assertEquals(pm.isRestartDue(100 + MATCH_RESTART_SECONDS * TICK_HZ), false);
  assertEquals(pm.maybeRestartMatch(100 + MATCH_RESTART_SECONDS * TICK_HZ), null);
});

Deno.test("lifecycle guards: forceEndMatch defaults to no rematch", () => {
  const pm = makeOpen();
  const over = pm.forceEndMatch(30, "A");
  assertExists(over);
  assertEquals(over.restartInSeconds, 0);
  assertEquals(pm.isRestartDue(30 + MATCH_RESTART_SECONDS * TICK_HZ), false);

  const withRestart = makeOpen();
  const scheduled = withRestart.forceEndMatch(40, "B", {
    scheduleRestart: true,
    restartSeconds: 2,
  });
  assertExists(scheduled);
  assertEquals(scheduled.restartInSeconds, 2);
  assertEquals(withRestart.isRestartDue(40 + 2 * TICK_HZ - 1), false);
  assertEquals(withRestart.isRestartDue(40 + 2 * TICK_HZ), true);
});

// --- Restart / score-end rows -----------------------------------------------

Deno.test("lifecycle restart: restartAtTick math + isRestartDue gate", () => {
  const pm = makeOpen();
  // Score-end path schedules default rematch.
  pm.add("a", "A", "A");
  // Drive endMatch via time-limit draw so we get a scheduled restart.
  const over = pm.checkMatchTimeLimit(pm.getMatchClockState().matchEndTick);
  assertExists(over);
  assertEquals(over.winner, "draw");
  const restartTick = pm.getMatchClockState().matchEndTick +
    MATCH_RESTART_SECONDS * TICK_HZ;
  // restartAtTick is private; probe via isRestartDue.
  assertEquals(pm.isRestartDue(restartTick - 1), false);
  assertEquals(pm.isRestartDue(restartTick), true);
  const next = pm.maybeRestartMatch(restartTick);
  assertExists(next);
  assertEquals(next.phase, "live");
  assertEquals(pm.getMatchPhase(), "live");
});

Deno.test("lifecycle restart: ranked re-enters prematch; open goes live", () => {
  const ranked = makePrematch();
  startRankedLive(ranked, 5);
  // Schedule restart via forceEndMatch (score/time use same endMatch).
  assertExists(ranked.forceEndMatch(20, "A", { scheduleRestart: true, restartSeconds: 1 }));
  const due = 20 + TICK_HZ;
  assertEquals(ranked.maybeRestartMatch(due)?.phase, "prematch");
  assertEquals(ranked.getMatchPhase(), "prematch");

  const open = makeOpen();
  assertExists(open.forceEndMatch(20, "B", { scheduleRestart: true, restartSeconds: 1 }));
  assertEquals(open.maybeRestartMatch(20 + TICK_HZ)?.phase, "live");
  assertEquals(open.getMatchPhase(), "live");
});

Deno.test("lifecycle score-end: WIN_SCORE + margin via checkMatchEnd", () => {
  assertEquals(
    winningTeam({ A: WIN_SCORE, B: WIN_SCORE - WIN_BY_MARGIN }),
    "A",
  );
  assertEquals(
    winningTeam({ A: WIN_SCORE, B: WIN_SCORE - WIN_BY_MARGIN + 1 }),
    null,
  );

  const pm = makeOpen();
  pm.add("scorer", "Scorer", "A");
  (pm as unknown as { scores: { A: number; B: number } }).scores = {
    A: WIN_SCORE,
    B: WIN_SCORE - WIN_BY_MARGIN,
  };
  const over = pm.checkMatchEnd(50);
  assertExists(over);
  assertEquals(over.winner, "A");
  assertEquals(pm.getMatchPhase(), "intermission");
  assertEquals(over.restartInSeconds, MATCH_RESTART_SECONDS);
  // Second call is a no-op once intermission.
  assertEquals(pm.checkMatchEnd(51), null);
});

// --- Ready-start row --------------------------------------------------------

Deno.test("lifecycle ready-start: unanimous ready → beginLiveMatch packet", () => {
  const pm = makePrematch();
  for (const id of ["s1", "s2", "s3", "s4"]) pm.add(id, id);
  for (const id of ["s1", "s2", "s3"]) {
    assertEquals(pm.setMatchReady(id, true), true);
  }
  assertEquals(pm.tryStartLiveFromReady(10), null);
  assertEquals(pm.setMatchReady("s4", true), true);
  const start = pm.tryStartLiveFromReady(100);
  assertExists(start);
  assertEquals(start.phase, "live");
  assertEquals(pm.getMatchPhase(), "live");
  assertEquals(start.doorsOpen, true);
});

// --- Edge rows --------------------------------------------------------------

Deno.test("lifecycle edge: empty-ranked reset returns clean prematch (no identity rotate)", () => {
  const server = new GameServer({
    name: "lifecycle-empty-ranked",
    port: 0,
    host: "127.0.0.1",
    map: miniMap,
    collision: new MapCollision(miniMap),
    autofillBots: 0,
    noBotsOnEmptyServer: true,
    joinMode: "ranked",
    rankedServerId: "ranked",
    authorityAdapter: new NoopAuthorityAdapter(),
    botThinkEngine: null,
  });
  const internals = server as unknown as {
    runtimeMatchId: string;
    players: PlayerManager;
    sessions: { emit(...args: unknown[]): void };
    dropPlayer(playerId: string): void;
    maybeResetEmptyRankedInstance(): boolean;
  };
  internals.sessions = { emit: () => {} };

  const humans = ["p1", "p2", "p3", "p4"].map((id, i) =>
    internals.players.add(id, `H${i}`, i % 2 === 0 ? "A" : "B")
  );
  for (const h of humans) internals.players.setMatchReady(h.id, true);
  assertEquals(internals.players.tryStartLiveFromReady(10)?.phase, "live");

  const idBefore = internals.runtimeMatchId;
  for (const h of humans) internals.dropPlayer(h.id);

  assertEquals(internals.players.getMatchPhase(), "prematch");
  assertEquals(internals.players.getScores(), { A: 0, B: 0 });
  assertEquals(internals.players.isLiveMatchVoided(), false);
  // Contract: empty-ranked re-enters prematch without rotating match identity.
  assertEquals(internals.runtimeMatchId, idBefore);
});

Deno.test("lifecycle edge: admin map change ends live as draw (no restart) then starts fresh + rotates", () => {
  const server = new GameServer({
    name: "lifecycle-map-change",
    port: 0,
    host: "127.0.0.1",
    map: miniMap,
    collision: new MapCollision(miniMap),
    autofillBots: 0,
    noBotsOnEmptyServer: true,
    joinMode: "open",
    authorityAdapter: new NoopAuthorityAdapter(),
    botThinkEngine: null,
  });
  const internals = server as unknown as {
    runtimeMatchId: string;
    players: PlayerManager;
  };
  assertEquals(internals.players.getMatchPhase(), "live");
  const idBefore = internals.runtimeMatchId;

  const packet = server.changeMap({
    map: { ...miniMap, name: "lifecycle-b" },
    collision: new MapCollision({ ...miniMap, name: "lifecycle-b" }),
    mapPath: "lifecycle-b",
  });
  assertEquals(packet.endedAsDraw, true);
  assertEquals(internals.players.getMatchPhase(), "live");
  assertNotEquals(internals.runtimeMatchId, idBefore);
});

Deno.test("lifecycle edge: release-drain hold starts nothing (finishIntermission)", () => {
  const server = new GameServer({
    name: "lifecycle-drain",
    port: 0,
    host: "127.0.0.1",
    map: miniMap,
    collision: new MapCollision(miniMap),
    autofillBots: 0,
    noBotsOnEmptyServer: true,
    joinMode: "open",
    authorityAdapter: new NoopAuthorityAdapter(),
    botThinkEngine: null,
  });
  const internals = server as unknown as {
    runtimeMatchId: string;
    releaseLocked: boolean;
    players: PlayerManager;
    finishIntermission(tick: number, nowMs: number): void;
    returnHumansToMenuAfterDrain(): void;
  };
  assertExists(
    internals.players.forceEndMatch(10, "A", {
      scheduleRestart: true,
      restartSeconds: 1,
    }),
  );
  const idBefore = internals.runtimeMatchId;
  const phaseBefore = internals.players.getMatchPhase();
  assertEquals(phaseBefore, "intermission");

  internals.releaseLocked = true;
  // Drain path returns humans to menu and must not call startNewMatch / rotate.
  internals.finishIntermission(10 + TICK_HZ, Date.now());
  assertEquals(internals.players.getMatchPhase(), "intermission");
  assertEquals(internals.runtimeMatchId, idBefore);
  // restartAtTick may still be set; hold means we did not consume a restart.
  assertEquals(internals.players.isMatchOver(), true);
});

Deno.test("lifecycle edge: raid activate rotates; idle reset does not", () => {
  const map = { ...miniMap, name: "Crossroads" };
  const server = new GameServer({
    name: "lifecycle-raid-id",
    port: 0,
    host: "127.0.0.1",
    map,
    collision: new MapCollision(map),
    autofillBots: 0,
    noBotsOnEmptyServer: true,
    joinMode: "open",
    rankedServerId: "raid",
    modeId: "raid",
    authorityAdapter: new NoopAuthorityAdapter(),
  });
  const internals = server as unknown as {
    runtimeMatchId: string;
    activateRaidFromJoin(input: {
      team?: "A" | "B";
      raidId?: string;
      partySize?: number;
    }): void;
    resetIdleRaidRuntime(): void;
  };
  const bootId = internals.runtimeMatchId;
  internals.activateRaidFromJoin({ team: "A", raidId: "crossroads", partySize: 2 });
  const raidId = internals.runtimeMatchId;
  assertNotEquals(raidId, bootId);

  internals.resetIdleRaidRuntime();
  assertEquals(internals.runtimeMatchId, raidId); // keep until next activate

  internals.activateRaidFromJoin({ team: "A", raidId: "crossroads", partySize: 2 });
  assertNotEquals(internals.runtimeMatchId, raidId);
});

Deno.test("lifecycle identity: ready-start rotates via handleMatchReady path", () => {
  const server = new GameServer({
    name: "lifecycle-ready-id",
    port: 0,
    host: "127.0.0.1",
    map: miniMap,
    collision: new MapCollision(miniMap),
    autofillBots: 0,
    noBotsOnEmptyServer: true,
    joinMode: "ranked",
    rankedServerId: "ranked",
    authorityAdapter: new NoopAuthorityAdapter(),
    botThinkEngine: null,
  });
  const internals = server as unknown as {
    runtimeMatchId: string;
    players: PlayerManager;
    sessions: { emit(...args: unknown[]): void } | null;
    handleMatchReady(playerId: string, ready: boolean): void;
  };
  internals.sessions = { emit: () => {} };

  for (const id of ["s1", "s2", "s3", "s4"]) {
    internals.players.add(id, id);
  }
  const idBefore = internals.runtimeMatchId;
  for (const id of ["s1", "s2", "s3"]) {
    internals.handleMatchReady(id, true);
  }
  assertEquals(internals.runtimeMatchId, idBefore);
  internals.handleMatchReady("s4", true);
  assertEquals(internals.players.getMatchPhase(), "live");
  assertNotEquals(internals.runtimeMatchId, idBefore);
});

// --- Source-scan / single-writer rows ---------------------------------------

Deno.test("lifecycle source-scan: PlayerManager lifecycle methods have no transport/heatmap/authority writes", async () => {
  const src = stripComments(
    await readRepo("players/PlayerManager.ts"),
  );
  // Whole-file scan is the contract: lifecycle lives only here and must stay pure.
  assertEquals(/sessions\s*\.\s*emit/.test(src), false);
  assertEquals(/NetEvents\./.test(src), false);
  assertEquals(/heatmap/i.test(src), false);
  assertEquals(/authority\.report/i.test(src), false);
  assertEquals(/reportMatch\s*\(/.test(src), false);
});

Deno.test("lifecycle source-scan: beginRuntimeMatchIdentity call sites are exhaustive", async () => {
  const src = stripComments(await readRepo("runtime/GameServer.ts"));
  const calls = countMatches(src, /this\.beginRuntimeMatchIdentity\s*\(/);
  // Definition + 5 call sites: changeMap, handleMatchReady, activateRaidFromJoin,
  // finishIntermission map-vote, finishIntermission same-map.
  assertEquals(calls, 5, `expected 5 beginRuntimeMatchIdentity calls, got ${calls}`);
  assertMatch(src, /changeMap[\s\S]*?beginRuntimeMatchIdentity/);
  assertMatch(src, /handleMatchReady[\s\S]*?beginRuntimeMatchIdentity/);
  assertMatch(src, /activateRaidFromJoin[\s\S]*?beginRuntimeMatchIdentity/);
  assertMatch(src, /finishIntermission[\s\S]*?beginRuntimeMatchIdentity/);
});

Deno.test("lifecycle source-scan: empty-ranked reset does not rotate identity", async () => {
  const src = stripComments(await readRepo("runtime/GameServer.ts"));
  const start = src.indexOf("private maybeResetEmptyRankedInstance");
  assertNotEquals(start, -1);
  const brace = src.indexOf("{", start);
  let depth = 0;
  let end = brace;
  for (let i = brace; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = src.slice(brace, end + 1);
  assertEquals(/beginRuntimeMatchIdentity/.test(body), false);
  assertMatch(body, /enterPrematch/);
});

Deno.test("lifecycle single-writer: matchOver / inPrematch only in lifecycle + construct", async () => {
  const src = stripComments(
    await readRepo("players/PlayerManager.ts"),
  );
  // Assignments only (not reads / comparisons).
  const matchOverWrites = countMatches(src, /this\.matchOver\s*=(?!=)/);
  const inPrematchWrites = countMatches(src, /this\.inPrematch\s*=(?!=)/);
  // construct (inPrematch), endMatch, enterPrematch, beginLiveMatch, and
  // restoreFromCheckpoint (epic 9.3 replay seek, event-free).
  assertEquals(matchOverWrites, 4, `matchOver writers: ${matchOverWrites}`);
  assertEquals(inPrematchWrites, 5, `inPrematch writers: ${inPrematchWrites}`);
});

Deno.test("lifecycle single-writer: restartAtTick writers are endMatch + clears + starts", async () => {
  const src = stripComments(
    await readRepo("players/PlayerManager.ts"),
  );
  const writes = countMatches(src, /this\.restartAtTick\s*=(?!=)/);
  // endMatch (schedule or null), clearScheduledRestart, enterPrematch,
  // beginLiveMatch, restoreFromCheckpoint (epic 9.3)
  assertEquals(writes, 5, `restartAtTick writers: ${writes}`);
});

Deno.test("lifecycle single-writer: matchEndTick writers are construct + starts + setMatchClock", async () => {
  const src = stripComments(
    await readRepo("players/PlayerManager.ts"),
  );
  const writes = countMatches(src, /this\.matchEndTick\s*=(?!=)/);
  // construct (default + prematch branch), setMatchClock, enterPrematch,
  // beginLiveMatch, restoreFromCheckpoint (epic 9.3)
  assertEquals(writes, 6, `matchEndTick writers: ${writes}`);
});

Deno.test("lifecycle: stepSim MatchEnd/Intermission comments + driver ownership", async () => {
  const raw = await readRepo("runtime/GameServer.ts");
  assertMatch(raw, /--- SIM: MatchEnd --- \(epic 7\.2 lifecycle\)/);
  assertMatch(raw, /--- SIM: Intermission --- \(epic 7\.2 lifecycle\)/);
  const src = stripComments(raw);
  // stepSim is a re-entrancy guard around stepSimBody; the tick lives there.
  const start = src.indexOf("private stepSimBody(");
  assertNotEquals(start, -1);
  const brace = src.indexOf("{", start);
  let depth = 0;
  let end = brace;
  for (let i = brace; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = src.slice(brace, end + 1);
  assertMatch(body, /checkMatchEnd/);
  assertMatch(body, /checkMatchTimeLimit/);
  assertMatch(body, /onMatchEnded/);
  assertMatch(body, /isRestartDue/);
  assertMatch(body, /finishIntermission/);
  // Transitions stay on PlayerManager; startNewMatch is driver-owned in finishIntermission.
  assertEquals(/startNewMatch/.test(body), false);
});
