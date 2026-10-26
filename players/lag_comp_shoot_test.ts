/**
 * Lag-comp shoot: clientTick must rewind to the delayed pose the shooter saw.
 * Run with: deno test -A server/players/lag_comp_shoot_test.ts
 */
import { assertEquals, assertExists } from "jsr:@std/assert";
import { PlayerManager } from "./PlayerManager.ts";
import { SPAWN_INVULN_TICKS } from "../protocol/network.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";

const miniMap: DoorsMap = {
  name: "test",
  version: 1,
  bounds: { minX: -50, maxX: 50, minZ: -50, maxZ: 50 },
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

const TICK = SPAWN_INVULN_TICKS + 60;
/** ~83 ms behind at 60 Hz — typical remote interp delay. */
const RENDER_LAG_TICKS = 5;

Deno.test("lag-comp: shot at delayed pose hits when clientTick is render-time", () => {
  const pm = new PlayerManager(new MapCollision(miniMap));
  const shooter = pm.add("s1", "Shooter", "A");
  const victim = pm.add("v1", "Victim", "B");

  // Shooter looks -Z from (0, 1.7, 5).
  shooter.x = 0;
  shooter.y = 1.7;
  shooter.z = 5;
  shooter.yaw = 0;
  shooter.pitch = 0;
  shooter.spawnedAtTick = 0;

  // Victim strafe: at render tick they were on the crosshair (x=0);
  // by sim "now" they have moved to x=2 (outside body radius from the ray).
  const past = TICK - RENDER_LAG_TICKS;
  victim.y = 1.7;
  victim.z = 0;
  victim.spawnedAtTick = 0;

  victim.x = 0;
  for (let t = past - 2; t <= past + 1; t++) {
    victim.recordPose(t);
  }
  victim.x = 2;
  for (let t = past + 2; t <= TICK; t++) {
    victim.recordPose(t);
  }
  shooter.recordPose(TICK);

  // Aim at where the delayed mesh was (x=0). With render-time clientTick → hit.
  const hit = pm.handleShoot("s1", TICK, {
    yaw: 0,
    pitch: 0,
    origin: [0, 1.7, 5],
    clientTick: past,
  });
  assertExists(hit);
  assertEquals(hit!.shot.hitId, "v1");

  // Same aim with clientTick = now only sees the live pose at x=2 → miss.
  // (Also confirms we no longer sample live simTick alongside a rewound stamp.)
  // Need a fresh shot: advance past fire cooldown.
  const later = TICK + 30;
  shooter.recordPose(later);
  victim.recordPose(later);
  const miss = pm.handleShoot("s1", later, {
    yaw: 0,
    pitch: 0,
    origin: [0, 1.7, 5],
    clientTick: later,
  });
  assertExists(miss);
  assertEquals(miss!.shot.hitId, null);
});

function lanShooter(pm: PlayerManager, tick: number) {
  const shooter = pm.add("s1", "Shooter", "A");
  shooter.x = 0;
  shooter.y = 1.7;
  shooter.z = 5;
  shooter.yaw = 0;
  shooter.pitch = 0;
  shooter.spawnedAtTick = 0;
  shooter.observeRtt(40);
  shooter.observeRtt(40);
  shooter.recordPose(tick);
  pm.lastSnapshotTick = tick - (tick % 3);
  return shooter;
}

Deno.test("lag-comp: LAN window blocks 250ms backtrack shop", () => {
  const pm = new PlayerManager(new MapCollision(miniMap));
  lanShooter(pm, TICK);
  const victim = pm.add("v1", "Victim", "B");
  victim.y = 1.7;
  victim.z = 0;
  victim.spawnedAtTick = 0;

  const old = TICK - 15;
  victim.x = 0;
  for (let t = old - 1; t <= old + 1; t++) victim.recordPose(t);
  victim.x = 2;
  for (let t = old + 2; t <= TICK; t++) victim.recordPose(t);

  const lastSnap = pm.lastSnapshotTick;
  const miss = pm.handleShoot("s1", TICK, {
    yaw: 0,
    pitch: 0,
    origin: [0, 1.7, 5],
    clientTick: old,
    lastAppliedSnapshotTick: lastSnap,
  });
  assertExists(miss);
  assertEquals(miss!.shot.hitId, null);
  assertEquals(pm.rewindClampTotal > 0, true);
});

Deno.test("lag-comp: omitted clientTick does not search live pose", () => {
  const pm = new PlayerManager(new MapCollision(miniMap));
  lanShooter(pm, TICK);
  const victim = pm.add("v1", "Victim", "B");
  victim.y = 1.7;
  victim.z = 0;
  victim.spawnedAtTick = 0;

  // Only the live pose is on the crosshair; delayed poses are off to the side.
  const past = TICK - RENDER_LAG_TICKS;
  victim.x = 2;
  for (let t = past - 2; t <= TICK - 1; t++) victim.recordPose(t);
  victim.x = 0;
  victim.recordPose(TICK);

  const miss = pm.handleShoot("s1", TICK, {
    yaw: 0,
    pitch: 0,
    origin: [0, 1.7, 5],
    lastAppliedSnapshotTick: pm.lastSnapshotTick,
  });
  assertExists(miss);
  assertEquals(miss!.shot.hitId, null);
});

Deno.test("lag-comp: high-ping window still hits a delayed honest stamp", () => {
  const pm = new PlayerManager(new MapCollision(miniMap));
  const shooter = lanShooter(pm, TICK);
  shooter.observeRtt(180);
  shooter.observeRtt(200);
  const victim = pm.add("v1", "Victim", "B");
  victim.y = 1.7;
  victim.z = 0;
  victim.spawnedAtTick = 0;

  const past = TICK - RENDER_LAG_TICKS;
  victim.x = 0;
  for (let t = past - 2; t <= past + 1; t++) victim.recordPose(t);
  victim.x = 2;
  for (let t = past + 2; t <= TICK; t++) victim.recordPose(t);

  const hit = pm.handleShoot("s1", TICK, {
    yaw: 0,
    pitch: 0,
    origin: [0, 1.7, 5],
    clientTick: past,
    lastAppliedSnapshotTick: pm.lastSnapshotTick,
  });
  assertExists(hit);
  assertEquals(hit!.shot.hitId, "v1");
});
