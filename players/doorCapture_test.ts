import { assertEquals } from "jsr:@std/assert@1";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";
import {
  DOOR_CAPTURE_DWELL_TICKS,
  RAID_RESPAWN_DELAY_TICKS,
  RESPAWN_DELAY_TICKS,
  TICK_HZ,
} from "../protocol/network.ts";
import { PlayerManager } from "./PlayerManager.ts";

const map: DoorsMap = {
  version: 1,
  name: "door-capture",
  bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 },
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

function makePm(): PlayerManager {
  return new PlayerManager(new MapCollision(map));
}

/** Team A capture pose: just inside / at the north (enemy) door. */
function placeAtEnemyDoor(pm: PlayerManager, playerId: string): void {
  const p = pm.get(playerId)!;
  // North door at z=20; stand slightly inside so isInDoorZone is true.
  p.x = 0;
  p.z = 20 - 0.5;
  p.y = 1.6;
  p.alive = true;
}

Deno.test("door capture: no score before dwell completes", () => {
  const pm = makePm();
  const p = pm.add("s1", "Runner");
  p.team = "A";
  placeAtEnemyDoor(pm, p.id);

  assertEquals(pm.areDoorsOpen(0), true);
  const early = pm.processScores(10);
  assertEquals(early.length, 0);
  assertEquals(pm.getScores(), { A: 0, B: 0 });
  assertEquals(p.enemyDoorSinceTick, 10);
});

Deno.test("door capture: scores after continuous dwell", () => {
  const pm = makePm();
  const p = pm.add("s1", "Runner");
  p.team = "A";
  placeAtEnemyDoor(pm, p.id);

  // First tick starts dwell.
  assertEquals(pm.processScores(100).length, 0);
  assertEquals(p.enemyDoorSinceTick, 100);

  // One tick short of dwell — still no score.
  const almost = 100 + DOOR_CAPTURE_DWELL_TICKS - 1;
  placeAtEnemyDoor(pm, p.id);
  assertEquals(pm.processScores(almost).length, 0);

  // Dwell complete.
  placeAtEnemyDoor(pm, p.id);
  const done = 100 + DOOR_CAPTURE_DWELL_TICKS;
  const events = pm.processScores(done);
  assertEquals(events.length, 1);
  assertEquals(events[0]!.team, "A");
  assertEquals(pm.getScores(), { A: 1, B: 0 });
  assertEquals(p.score, 1);
  assertEquals(p.enemyDoorSinceTick, null);
  // Sent home to south door.
  assertEquals(p.z < -15, true);
});

Deno.test("door capture: simultaneous capturers resolve by stable player id", () => {
  const run = (joinOrder: string[]) => {
    // Same match seed in both runs: only the join order may differ.
    const pm = new PlayerManager(new MapCollision(map), { matchSeed: 12345 });
    for (const id of joinOrder) {
      const p = pm.add(id, id, "A");
      p.team = "A";
      placeAtEnemyDoor(pm, id);
    }

    const start = 100;
    assertEquals(pm.processScores(start).length, 0);
    for (const id of joinOrder) placeAtEnemyDoor(pm, id);

    const events = pm.processScores(start + DOOR_CAPTURE_DWELL_TICKS);
    return {
      events: events.map((event) => ({
        scorerId: event.scorerId,
        scores: event.scores,
      })),
      scores: pm.getScores(),
    };
  };

  assertEquals(run(["b", "a"]), run(["a", "b"]));
  assertEquals(run(["b", "a"]).events.map((event) => event.scorerId), [
    "a",
    "b",
  ]);
});

Deno.test("door capture: preserves pitch and remaps yaw; death respawn zeros pitch", () => {
  const pm = makePm();
  const p = pm.add("s1", "Runner");
  p.team = "A";
  placeAtEnemyDoor(pm, p.id);
  p.yaw = Math.PI - 0.25;
  p.pitch = 0.35;

  assertEquals(pm.processScores(100).length, 0);
  placeAtEnemyDoor(pm, p.id);
  p.yaw = Math.PI - 0.25;
  p.pitch = 0.35;
  const events = pm.processScores(100 + DOOR_CAPTURE_DWELL_TICKS);
  assertEquals(events.length, 1);
  assertEquals(Math.abs(p.pitch - 0.35) < 1e-6, true);
  assertEquals(Math.abs(p.yaw - (Math.PI - 0.25)) < 0.05, true);

  p.health = 0;
  p.alive = false;
  p.diedAtTick = 200;
  p.pitch = 0.35;
  const revived = pm.processRespawns(200 + RESPAWN_DELAY_TICKS);
  assertEquals(revived.length, 1);
  assertEquals(p.pitch, 0);
});

Deno.test("door capture: leaving zone resets dwell", () => {
  const pm = makePm();
  const p = pm.add("s1", "Runner");
  p.team = "A";
  placeAtEnemyDoor(pm, p.id);

  assertEquals(pm.processScores(50).length, 0);
  assertEquals(p.enemyDoorSinceTick, 50);

  // Step out of the zone mid-dwell.
  p.z = 0;
  assertEquals(pm.processScores(55).length, 0);
  assertEquals(p.enemyDoorSinceTick, null);

  // Re-enter — timer restarts; not enough dwell yet.
  placeAtEnemyDoor(pm, p.id);
  assertEquals(pm.processScores(60).length, 0);
  assertEquals(p.enemyDoorSinceTick, 60);
  placeAtEnemyDoor(pm, p.id);
  assertEquals(
    pm.processScores(60 + DOOR_CAPTURE_DWELL_TICKS - 1).length,
    0,
  );
  placeAtEnemyDoor(pm, p.id);
  assertEquals(pm.processScores(60 + DOOR_CAPTURE_DWELL_TICKS).length, 1);
});

Deno.test("door capture: dwell constant is ~250ms at 60Hz", () => {
  // ceil(250 * 60 / 1000) = 15
  assertEquals(DOOR_CAPTURE_DWELL_TICKS, Math.ceil((250 * TICK_HZ) / 1000));
});

Deno.test("raid door capture: sends survivors home without healing them", () => {
  const pm = makePm();
  pm.setRaidDoorPolicy("open");

  const scorer = pm.add("s1", "Runner");
  scorer.team = "A";
  placeAtEnemyDoor(pm, scorer.id);
  scorer.health = 37;

  const survivor = pm.add("s2", "Survivor");
  survivor.team = "A";
  survivor.x = 1;
  survivor.z = 0;
  survivor.health = 62;

  const eliminated = pm.add("s3", "Eliminated");
  eliminated.team = "A";
  eliminated.x = -1;
  eliminated.z = 0;
  eliminated.health = 0;
  eliminated.alive = false;

  const opponent = pm.add("s4", "Opponent");
  opponent.team = "B";
  opponent.x = 5;
  opponent.z = 5;

  assertEquals(pm.processScores(100).length, 0);
  placeAtEnemyDoor(pm, scorer.id);
  const [event] = pm.processScores(100 + DOOR_CAPTURE_DWELL_TICKS);

  assertEquals(event?.scores, { A: 1, B: 0 });
  assertEquals(event?.resetPlayers?.map((p) => p.id).sort(), ["s1", "s2"]);
  assertEquals(scorer.z < -15, true);
  assertEquals(survivor.z < -15, true);
  assertEquals(scorer.health, 37);
  assertEquals(survivor.health, 62);
  assertEquals(survivor.alive, true);
  assertEquals(eliminated.z, 0);
  assertEquals(eliminated.alive, false);
  assertEquals(eliminated.health, 0);
  assertEquals(opponent.x, 5);
  assertEquals(opponent.z, 5);
});

Deno.test("raid death: players respawn after 30 seconds unless the team wipes", () => {
  const pm = makePm();
  pm.setRaidDoorPolicy("open");
  const eliminated = pm.add("s1", "Eliminated");
  eliminated.team = "A";
  eliminated.health = 0;
  eliminated.alive = false;
  eliminated.diedAtTick = 1;

  assertEquals(pm.processRespawns(1 + RAID_RESPAWN_DELAY_TICKS - 1), []);
  assertEquals(eliminated.alive, false);
  assertEquals(pm.processRespawns(1 + RAID_RESPAWN_DELAY_TICKS).length, 1);
  assertEquals(eliminated.alive, true);
  assertEquals(eliminated.health, 100);
});

Deno.test("respawns: simultaneous spawns use stable player id order", () => {
  const run = (joinOrder: string[]) => {
    // Same match seed in both runs: only the join order may differ.
    const pm = new PlayerManager(new MapCollision(map), { matchSeed: 12345 });
    for (const id of joinOrder) {
      const player = pm.add(id, id, "A");
      player.alive = false;
      player.health = 0;
      player.diedAtTick = 1;
    }

    return pm.processRespawns(1 + RESPAWN_DELAY_TICKS).map((player) => ({
      id: player.id,
      x: player.x,
      y: player.y,
      z: player.z,
      yaw: player.yaw,
    }));
  };

  assertEquals(run(["b", "a"]), run(["a", "b"]));
  assertEquals(run(["b", "a"]).map((player) => player.id), ["a", "b"]);
});

Deno.test("raid death: reconnect does not revive an eliminated player", () => {
  const pm = makePm();
  pm.setRaidDoorPolicy("open");
  const eliminated = pm.add("sock-1", "Eliminated");
  eliminated.team = "A";
  eliminated.health = 0;
  eliminated.alive = false;
  eliminated.diedAtTick = 1;

  const restored = pm.takeOverConnection(eliminated.id, "sock-2", 1_000_000);
  assertEquals(restored?.respawned, false);
  assertEquals(restored?.player.alive, false);
  assertEquals(restored?.player.health, 0);
});
