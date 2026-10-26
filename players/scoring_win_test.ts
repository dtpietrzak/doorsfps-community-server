import { assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import type { DoorsMap } from "../world/map.ts";
import { MapCollision } from "../world/MapCollision.ts";
import {
  DOOR_CAPTURE_DWELL_TICKS,
  DOOR_FULL_CYCLE_TICKS,
  DOOR_OPEN_TICKS,
  SCORE_COOLDOWN_TICKS,
  TICK_HZ,
} from "../protocol/network.ts";
import { PlayerManager, winningTeam } from "./PlayerManager.ts";

const map: DoorsMap = {
  name: "scoring-win",
  version: 1,
  bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 },
  gridSize: 1,
  walls: [],
  teamA: { corners: [0, 1], edge: "south", doorHalfWidth: 2.5, spawnRadius: 3 },
  teamB: { corners: [2, 3], edge: "north", doorHalfWidth: 2.5, spawnRadius: 3 },
};

function makePm(options?: ConstructorParameters<typeof PlayerManager>[1]): PlayerManager {
  return new PlayerManager(new MapCollision(map), options);
}

function placeAtEnemyDoor(pm: PlayerManager, id: string): void {
  const player = pm.get(id)!;
  player.x = 0;
  player.y = 1.6;
  player.z = 19.5;
  player.alive = true;
}

function scoreOnce(pm: PlayerManager, id: string, startTick: number): number {
  placeAtEnemyDoor(pm, id);
  assertEquals(pm.processScores(startTick).length, 0);
  const scoreTick = startTick + DOOR_CAPTURE_DWELL_TICKS;
  placeAtEnemyDoor(pm, id);
  assertEquals(pm.processScores(scoreTick).length, 1);
  return scoreTick;
}

Deno.test("winningTeam: score and margin matrix", () => {
  const cases = [
    { scores: { A: 21, B: 19 }, winner: "A" },
    { scores: { A: 19, B: 21 }, winner: "B" },
    { scores: { A: 21, B: 20 }, winner: null },
    { scores: { A: 20, B: 20 }, winner: null },
    { scores: { A: 22, B: 21 }, winner: null },
    { scores: { A: 22, B: 19 }, winner: "A" },
  ] as const;

  for (const testCase of cases) {
    assertEquals(winningTeam(testCase.scores), testCase.winner);
  }
});

Deno.test("scoring: cooldown suppresses capture until the exact tick", () => {
  const pm = makePm();
  pm.add("runner", "Runner", "A");
  const firstScore = scoreOnce(pm, "runner", 100);

  placeAtEnemyDoor(pm, "runner");
  assertEquals(pm.processScores(firstScore + SCORE_COOLDOWN_TICKS - 1).length, 0);
  assertEquals(pm.get("runner")!.enemyDoorSinceTick, null);

  const cooldownEnd = firstScore + SCORE_COOLDOWN_TICKS;
  placeAtEnemyDoor(pm, "runner");
  assertEquals(pm.processScores(cooldownEnd).length, 0);
  placeAtEnemyDoor(pm, "runner");
  assertEquals(pm.processScores(cooldownEnd + DOOR_CAPTURE_DWELL_TICKS).length, 1);
});

Deno.test("scoring: a closed door clears dwell and reopens on the cycle boundary", () => {
  const pm = makePm();
  const player = pm.add("runner", "Runner", "A");
  placeAtEnemyDoor(pm, player.id);
  assertEquals(pm.processScores(0).length, 0);
  assertEquals(player.enemyDoorSinceTick, 0);

  placeAtEnemyDoor(pm, player.id);
  assertEquals(pm.processScores(DOOR_OPEN_TICKS).length, 0);
  assertEquals(player.enemyDoorSinceTick, null);

  placeAtEnemyDoor(pm, player.id);
  assertEquals(pm.processScores(DOOR_FULL_CYCLE_TICKS).length, 0);
  assertEquals(player.enemyDoorSinceTick, DOOR_FULL_CYCLE_TICKS);
});

Deno.test("scoring: dead, disconnected, and agent players are excluded", () => {
  const pm = makePm();
  const scorer = pm.add("scorer", "Scorer", "A");
  const dead = pm.add("dead", "Dead", "A");
  dead.alive = false;
  dead.health = 0;
  const disconnected = pm.add("disconnected", "Disconnected", "A");
  assertEquals(pm.markConnectionIssue(disconnected.id, 10_000), true);
  const agent = pm.addAgent("agent", "Agent", "A", { x: 0, y: 1.7, z: 19.5, yaw: 0 });
  pm.setDebugForceDoorsOpen(true);

  for (const id of [scorer.id, disconnected.id, agent.id]) {
    placeAtEnemyDoor(pm, id);
  }
  assertEquals(pm.processScores(100).length, 0);
  for (const id of [scorer.id, disconnected.id, agent.id]) {
    placeAtEnemyDoor(pm, id);
  }
  const events = pm.processScores(100 + DOOR_CAPTURE_DWELL_TICKS);

  assertEquals(events.length, 1);
  assertEquals(events[0]!.scorerId, scorer.id);
  assertEquals(pm.getScores(), { A: 1, B: 0 });
  assertEquals(dead.score, 0);
  assertEquals(disconnected.score, 0);
  assertEquals(agent.score, 0);
});

Deno.test("scoring: PvP teleport preserves health/stamina and resupplies ammo", () => {
  const pm = makePm();
  const player = pm.add("runner", "Runner", "A");
  player.health = 41;
  player.sprintStamina = 17;
  player.markShot(0);
  const spentAmmo = player.ammoInMag;

  scoreOnce(pm, player.id, 100);

  assertEquals(player.health, 41);
  assertEquals(player.sprintStamina, 17);
  assertNotEquals(player.ammoInMag, spentAmmo);
  assertEquals(player.z < -15, true);
});

Deno.test("match end: time limit chooses leader and draws ties at the exact tick", () => {
  const leader = makePm({ matchDurationSeconds: 1 });
  leader.add("runner", "Runner", "A");
  scoreOnce(leader, "runner", 0);
  assertEquals(leader.checkMatchTimeLimit(TICK_HZ - 1), null);
  assertEquals(leader.checkMatchTimeLimit(TICK_HZ)?.winner, "A");
  assertEquals(leader.checkMatchTimeLimit(TICK_HZ), null);

  const tied = makePm({ matchDurationSeconds: 1 });
  assertEquals(tied.checkMatchTimeLimit(TICK_HZ)?.winner, "draw");
  assertEquals(tied.checkMatchTimeLimit(TICK_HZ), null);
});
