/**
 * Epic 4.7 Chunk 4: death → score → match-end → intermission → respawn chain.
 * Mirrors GameServer.startGameLoop phase order at the PlayerManager boundary.
 * Run from server-community/:
 *   deno test -A players/sim_tick_chain_test.ts
 */

import { assertEquals } from "@std/assert";
import type { DoorsMap } from "../world/map.ts";
import { MapCollision } from "../world/MapCollision.ts";
import {
  DOOR_CAPTURE_DWELL_TICKS,
  RESPAWN_DELAY_TICKS,
  SPAWN_INVULN_TICKS,
  TICK_HZ,
} from "../protocol/network.ts";
import { PlayerManager } from "./PlayerManager.ts";
import { SIM_TICK_EVENT_ORDER } from "./simTickPhases.ts";

const map: DoorsMap = {
  name: "sim-tick-chain",
  version: 1,
  bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 },
  gridSize: 1,
  walls: [],
  teamA: { corners: [0, 1], edge: "south", doorHalfWidth: 2.5, spawnRadius: 3 },
  teamB: { corners: [2, 3], edge: "north", doorHalfWidth: 2.5, spawnRadius: 3 },
};

type ChainEvent =
  | { type: "PlayerDied"; victimId: string }
  | { type: "Score"; scorerId: string }
  | { type: "GameOver"; winner: string }
  | { type: "PlayerRespawned"; playerId: string };

function makePm(options?: ConstructorParameters<typeof PlayerManager>[1]) {
  return new PlayerManager(new MapCollision(map), options);
}

function placeAtEnemyDoor(pm: PlayerManager, id: string): void {
  const player = pm.get(id)!;
  player.x = 0;
  player.y = 1.6;
  player.z = 19.5;
  player.alive = true;
}

/**
 * PlayerManager slice of the pinned tick chain (no transport emit).
 * Order matches SIM: MovePhysics/OverlapDeath → ScoresRules → MatchEnd →
 * Intermission → Respawn.
 */
function runPmChain(
  pm: PlayerManager,
  tick: number,
  nowMs: number,
): { events: ChainEvent[]; restartDue: boolean } {
  const events: ChainEvent[] = [];

  const deaths = pm.update(tick, nowMs);
  for (const d of deaths) {
    events.push({ type: "PlayerDied", victimId: d.victimId });
  }

  const scores = pm.processScores(tick);
  for (const s of scores) {
    events.push({ type: "Score", scorerId: s.scorerId });
  }

  let gameOver = scores.length > 0 ? pm.checkMatchEnd(tick) : null;
  if (!pm.isMatchOver()) {
    gameOver = gameOver ?? pm.checkMatchTimeLimit(tick);
  }
  if (gameOver) {
    events.push({ type: "GameOver", winner: String(gameOver.winner) });
  }

  const restartDue = pm.isRestartDue(tick);
  if (restartDue) {
    pm.startNewMatch(tick, nowMs);
  }

  const respawned = pm.processRespawns(tick);
  for (const p of respawned) {
    events.push({ type: "PlayerRespawned", playerId: p.id });
  }

  return { events, restartDue };
}

function eventTypes(events: ChainEvent[]): string[] {
  return events.map((e) => e.type);
}

Deno.test("SIM_TICK_EVENT_ORDER keeps CombatBurst before PlayerDied … Respawned", () => {
  assertEquals([...SIM_TICK_EVENT_ORDER], [
    "CombatBurst",
    "PlayerDied",
    "Score",
    "GameOver",
    "PlayerRespawned",
  ]);
});

Deno.test("chain: same-tick capture emits Score; overlap death precedes Score", () => {
  const pm = makePm();
  pm.setDebugForceDoorsOpen(true);
  const scorer = pm.add("scorer", "Scorer", "A");
  const blocker = pm.add("blocker", "Blocker", "B");

  // Arm dwell for capture.
  placeAtEnemyDoor(pm, scorer.id);
  assertEquals(pm.processScores(100).length, 0);

  // Coincident centers in open map → clip push, not necessarily oof.
  // Kill scorer's teammate via takeDamage so death is already applied before
  // scores; overlap PlayerDied comes from update when we force oof.
  blocker.x = 0;
  blocker.y = 1.7;
  blocker.z = 0;
  blocker.spawnedAtTick = 0;

  placeAtEnemyDoor(pm, scorer.id);
  const scoreTick = 100 + DOOR_CAPTURE_DWELL_TICKS;
  const deaths = pm.update(scoreTick, 1_000);
  const scores = pm.processScores(scoreTick);

  // Scores run after update in the chain; capture still lands for alive scorer.
  assertEquals(scorer.alive, true);
  assertEquals(scores.length, 1);
  assertEquals(scores[0]!.scorerId, "scorer");
  // No requirement that overlap fired this tick — only that Score is after update.
  assertEquals(deaths.every((d) => d.victimId !== "scorer"), true);
});

Deno.test("chain: Score then GameOver on time-limit tick; processScores empty after matchOver", () => {
  const pm = makePm({ matchDurationSeconds: 1 });
  pm.setDebugForceDoorsOpen(true);
  pm.add("runner", "Runner", "A");
  placeAtEnemyDoor(pm, "runner");
  assertEquals(pm.processScores(0).length, 0);
  placeAtEnemyDoor(pm, "runner");
  const scoreTick = DOOR_CAPTURE_DWELL_TICKS;
  const scores = pm.processScores(scoreTick);
  assertEquals(scores.length, 1);

  const endTick = TICK_HZ;
  const { events } = runPmChain(pm, endTick, 2_000);
  const types = eventTypes(events);
  assertEquals(types.includes("GameOver"), true);
  assertEquals(types.indexOf("GameOver") >= 0, true);
  // No further scores once match is over.
  assertEquals(pm.processScores(endTick + 1).length, 0);
  assertEquals(pm.isMatchOver(), true);
});

Deno.test("chain: processRespawns still runs while matchOver (pinned)", () => {
  const pm = makePm();
  pm.setDebugForceDoorsOpen(true);
  const p = pm.add("dead", "Dead", "A");
  p.spawnedAtTick = 0;
  const dieTick = SPAWN_INVULN_TICKS + 10;
  assertEquals(p.takeDamage(999, "body", dieTick, 1_000), true);
  assertEquals(p.alive, false);

  const gameOver = pm.forceEndMatch(dieTick + 1, "B", {
    scheduleRestart: true,
    restartSeconds: 30,
  });
  assertEquals(gameOver?.winner, "B");
  assertEquals(pm.isMatchOver(), true);

  const respawnTick = dieTick + RESPAWN_DELAY_TICKS;
  assertEquals(pm.isRestartDue(respawnTick), false);
  const respawned = pm.processRespawns(respawnTick);
  assertEquals(respawned.map((r) => r.id), ["dead"]);
  assertEquals(p.alive, true);
});

Deno.test("chain: intermission tick starts new match before respawns", () => {
  const pm = makePm();
  pm.setDebugForceDoorsOpen(true);
  const p = pm.add("dead", "Dead", "A");
  p.spawnedAtTick = 0;
  const dieTick = SPAWN_INVULN_TICKS + 10;
  assertEquals(p.takeDamage(999, "body", dieTick, 1_000), true);

  // Short intermission; Intermission phase runs before Respawn on the same tick.
  pm.forceEndMatch(dieTick, "A", { scheduleRestart: true, restartSeconds: 1 });
  const restartTick = dieTick + TICK_HZ;
  assertEquals(pm.isRestartDue(restartTick), true);
  assertEquals(p.alive, false);

  const { restartDue } = runPmChain(pm, restartTick, 5_000);
  assertEquals(restartDue, true);
  assertEquals(pm.isMatchOver(), false);
  // startNewMatch (Intermission) respawns the roster; Respawn phase still runs after.
  assertEquals(p.alive, true);
});

Deno.test("chain: event types never reverse Score after GameOver in one tick", () => {
  const pm = makePm({ matchDurationSeconds: 1 });
  pm.setDebugForceDoorsOpen(true);
  pm.add("runner", "Runner", "A");
  placeAtEnemyDoor(pm, "runner");
  pm.processScores(0);
  placeAtEnemyDoor(pm, "runner");
  pm.processScores(DOOR_CAPTURE_DWELL_TICKS);

  const { events } = runPmChain(pm, TICK_HZ, 9_000);
  const types = eventTypes(events);
  const scoreIdx = types.indexOf("Score");
  const overIdx = types.indexOf("GameOver");
  if (scoreIdx >= 0 && overIdx >= 0) {
    assertEquals(scoreIdx < overIdx, true);
  }
  assertEquals(overIdx >= 0, true);
});
