/**
 * Epic 4.7 Chunk 3 / keys-only PR 4: deferred weapons flush order + pre-move
 * resolution. Shared by humans (enqueued from ingress) and bots (enqueued
 * from the apply pipe) — same queue, same ordering, same flush.
 * Run from server-community/:
 *   deno test -A players/weapons_order_test.ts
 */

import { assertEquals } from "@std/assert";
import { orderPendingWeapons, type PendingWeapon } from "./weaponsQueue.ts";
import { PlayerManager } from "./PlayerManager.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";
import type { ShootPacket } from "../protocol/network.ts";

Deno.test("orderPendingWeapons sorts by ascending shooter id, FIFO ties", () => {
  const items: PendingWeapon[] = [
    { kind: "shoot", shooterId: "z", packet: null },
    { kind: "melee", shooterId: "a", packet: null },
    { kind: "shoot", shooterId: "m", packet: null },
    { kind: "shoot", shooterId: "a", packet: null },
  ];
  assertEquals(
    orderPendingWeapons(items).map((p) => `${p.shooterId}:${p.kind}`),
    ["a:melee", "a:shoot", "m:shoot", "z:shoot"],
  );
});

Deno.test("opposite enqueue order yields identical ordered flush sequence", () => {
  const forward = orderPendingWeapons([
    { kind: "shoot" as const, shooterId: "b", packet: null },
    { kind: "shoot" as const, shooterId: "a", packet: null },
  ]);
  const reverse = orderPendingWeapons([
    { kind: "shoot" as const, shooterId: "a", packet: null },
    { kind: "shoot" as const, shooterId: "b", packet: null },
  ]);
  assertEquals(
    forward.map((p) => p.shooterId),
    reverse.map((p) => p.shooterId),
  );
  assertEquals(forward.map((p) => p.shooterId), ["a", "b"]);
});

const openMap: DoorsMap = {
  name: "human-weapons-order",
  version: 1,
  bounds: { minX: -50, maxX: 50, minZ: -50, maxZ: 50 },
  gridSize: 1,
  walls: [],
  teamA: { corners: [0, 1], edge: "south", doorHalfWidth: 2, spawnRadius: 4 },
  teamB: { corners: [2, 3], edge: "north", doorHalfWidth: 2, spawnRadius: 4 },
};

function place(
  p: { x: number; y: number; z: number; yaw: number; spawnedAtTick: number; pitch: number },
  x: number,
  z: number,
  yaw: number,
): void {
  p.x = x;
  p.y = 1.7;
  p.z = z;
  p.yaw = yaw;
  p.pitch = 0;
  p.spawnedAtTick = 0;
}

function shootPacket(origin: [number, number, number], yaw: number): ShootPacket {
  return { origin, yaw, pitch: 0 };
}

function simSnap(pm: PlayerManager) {
  return ["attacker", "victim"].map((id) => {
    const p = pm.get(id)!;
    return {
      id,
      x: p.x,
      z: p.z,
      health: p.health,
      alive: p.alive,
      deaths: p.deaths,
    };
  });
}

/**
 * Flush weapons then move — mirrors BotApply → Weapons → MovePhysics.
 * Opposite "arrival" orders of two shooters' pending shots must match.
 */
function runDeferredShootThenMove(
  enqueueOrder: readonly ("attacker" | "other")[],
) {
  const pm = new PlayerManager(new MapCollision(openMap), {
    damageRandom: () => 0.5,
    spreadRandom: () => 0.5,
  });
  const attacker = pm.add("attacker", "Attacker", "A");
  const victim = pm.add("victim", "Victim", "B");
  const other = pm.add("other", "Other", "A");
  // yaw=0 aims -Z (see lag_comp_shoot_test).
  place(attacker, 0, 5, 0);
  place(victim, 0, 0, Math.PI);
  place(other, 10, 10, 0);
  attacker.recordPose(20);
  victim.recordPose(20);
  other.recordPose(20);

  const pending: PendingWeapon[] = enqueueOrder.map((id) => ({
    kind: "shoot",
    shooterId: id,
    packet: shootPacket(
      id === "attacker" ? [0, 1.7, 5] : [10, 1.7, 10],
      id === "attacker" ? 0 : Math.PI / 2,
    ),
  }));

  const tick = 20;
  const nowMs = 1_000_000;
  for (const req of orderPendingWeapons(pending)) {
    pm.handleShoot(req.shooterId, tick, req.packet, { nowMs });
  }
  // Victim tries to strafe after the weapons phase.
  victim.queueInput({
    sequence: 1,
    forward: false,
    backward: false,
    left: true,
    right: false,
    jump: false,
    sprint: false,
    crouch: false,
    yaw: Math.PI,
    pitch: 0,
  });
  pm.update(tick, nowMs);
  return simSnap(pm);
}

Deno.test("deferred shoot+move is independent of enqueue/arrival order", () => {
  const a = runDeferredShootThenMove(["attacker", "other"]);
  const b = runDeferredShootThenMove(["other", "attacker"]);
  assertEquals(a, b);
});
