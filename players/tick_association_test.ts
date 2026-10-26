/**
 * Epic 5.2 — tick association truth table.
 * Run: deno test -A server-community/players/tick_association_test.ts
 */

import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import type { PlayerInput } from "../protocol/network.ts";
import type { DoorsMap, Wall } from "../world/map.ts";
import { MapCollision } from "../world/MapCollision.ts";
import { Player } from "./Player.ts";
import { PlayerManager } from "./PlayerManager.ts";
import {
  classifyTickAssociation,
  consumeWireMovementEdges,
  neutralPlayerInput,
} from "./tickAssociation.ts";

function mapWithWalls(walls: Wall[] = []): DoorsMap {
  return {
    name: "tick-association",
    version: 1,
    bounds: { minX: -30, maxX: 30, minZ: -30, maxZ: 30 },
    gridSize: 1,
    walls,
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
}

function input(
  sequence: number,
  overrides: Partial<PlayerInput> = {},
): PlayerInput {
  return {
    sequence,
    forward: false,
    backward: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
    crouch: false,
    yaw: Math.PI,
    pitch: 0,
    ...overrides,
  };
}

function groundedPlayer(id = "p1"): { p: Player; collision: MapCollision } {
  const p = new Player(id, "Test", "A", {
    spawn: { x: 0, z: 0, yaw: Math.PI },
  });
  const collision = new MapCollision(mapWithWalls());
  // Settle onto ground.
  p.update(collision, 0);
  return { p, collision };
}

Deno.test("neutralPlayerInput: no keys, look preserved", () => {
  const n = neutralPlayerInput(1.25, -0.5, 0);
  assertEquals(n.forward, false);
  assertEquals(n.jump, false);
  assertEquals(n.meleeLunge, false);
  assertEquals(n.yaw, 1.25);
  assertEquals(n.pitch, -0.5);
  assertEquals(n.sequence, 0);
});

Deno.test("consumeWireMovementEdges: clears only successful edges", () => {
  const pkt = input(1, { jump: true, meleeLunge: true });
  consumeWireMovementEdges(pkt, { jumped: true, meleeLungeStarted: false });
  assertEquals(pkt.jump, false);
  assertEquals(pkt.meleeLunge, true);
  consumeWireMovementEdges(pkt, { jumped: false, meleeLungeStarted: true });
  assertEquals(pkt.meleeLunge, false);
});

Deno.test("classifyTickAssociation: truth-table rows", () => {
  assertEquals(
    classifyTickAssociation({
      alive: false,
      connectionIssue: false,
      selectedInput: input(1),
      arrivalSinceLastStep: true,
      sequenceChanged: true,
    }),
    "dead",
  );
  assertEquals(
    classifyTickAssociation({
      alive: true,
      connectionIssue: true,
      selectedInput: null,
      arrivalSinceLastStep: false,
      sequenceChanged: false,
    }),
    "connection_issue",
  );
  assertEquals(
    classifyTickAssociation({
      alive: true,
      connectionIssue: false,
      selectedInput: null,
      arrivalSinceLastStep: false,
      sequenceChanged: false,
    }),
    "neutral",
  );
  assertEquals(
    classifyTickAssociation({
      alive: true,
      connectionIssue: false,
      selectedInput: input(3),
      arrivalSinceLastStep: true,
      sequenceChanged: true,
    }),
    "fresh",
  );
  assertEquals(
    classifyTickAssociation({
      alive: true,
      connectionIssue: false,
      selectedInput: input(3),
      arrivalSinceLastStep: true,
      sequenceChanged: false,
    }),
    "hold",
  );
  assertEquals(
    classifyTickAssociation({
      alive: true,
      connectionIssue: false,
      selectedInput: input(3),
      arrivalSinceLastStep: false,
      sequenceChanged: false,
    }),
    "repeat_missing",
  );
});

Deno.test("fresh input applies once; holdTicks = 1", () => {
  const { p, collision } = groundedPlayer();
  const z0 = p.z;
  p.queueInput(input(1, { forward: true }), 1);
  p.update(collision, 1);
  const sel = p.lastTickInputSelection();
  assertEquals(sel?.association, "fresh");
  assertEquals(sel?.appliedSequence, 1);
  assertEquals(sel?.inputHoldTicks, 1);
  assertEquals(sel?.selectedInput?.sequence, 1);
  assertEquals(sel?.tick, 1);
  assertEquals(sel?.playerId, "p1");
  // yaw=π forward → +Z
  assertEquals(p.z > z0, true);
});

Deno.test("same sequence held N ticks: holdTicks increments; no edge refire", () => {
  const { p, collision } = groundedPlayer();
  const pkt = input(1, { forward: true, jump: true });
  p.queueInput(pkt, 1);
  p.update(collision, 1);
  const vyAfterJump = p.velocityY;
  assertEquals(p.onGround, false);
  assertEquals(pkt.jump, false); // consumed
  assertEquals(p.lastTickInputSelection()?.inputHoldTicks, 1);

  // Silent holds — same packet object, jump already cleared.
  p.update(collision, 2);
  assertEquals(p.lastTickInputSelection()?.association, "repeat_missing");
  assertEquals(p.lastTickInputSelection()?.inputHoldTicks, 2);
  assertEquals(p.lastTickInputSelection()?.appliedSequence, 1);
  // Gravity drained vertical speed — no second jump impulse.
  assertEquals(p.velocityY < vyAfterJump, true);

  p.update(collision, 3);
  assertEquals(p.lastTickInputSelection()?.inputHoldTicks, 3);
});

Deno.test("jump fires once on fresh packet; held packet never rejumps", () => {
  const { p, collision } = groundedPlayer();
  const pkt = input(7, { jump: true });
  p.queueInput(pkt, 1);
  p.update(collision, 1);
  assertEquals(p.onGround, false);
  const peakVy = p.velocityY;

  // Land by stepping silent ticks (jump apex needs ~49 ticks at TICK_HZ).
  for (let t = 2; t <= 60; t++) {
    p.update(collision, t);
  }
  assertEquals(p.onGround, true);
  assertEquals(pkt.jump, false);
  const yGround = p.y;
  p.update(collision, 61);
  assertEquals(p.y, yGround);
  assertEquals(p.onGround, true);
  assertEquals(peakVy > 0, true);
});

Deno.test("multi-arrival tick: last-write-wins", () => {
  const { p, collision } = groundedPlayer();
  p.queueInput(input(1, { forward: true, yaw: 0 }), 1);
  p.queueInput(input(2, { backward: true, yaw: Math.PI }), 1);
  p.update(collision, 1);
  const sel = p.lastTickInputSelection();
  assertEquals(sel?.association, "fresh");
  assertEquals(sel?.appliedSequence, 2);
  assertEquals(sel?.selectedInput?.backward, true);
  assertEquals(sel?.selectedInput?.forward, false);
  // Backward + yaw π: sinπ=0, cosπ=-1 → mz += cos → -Z.
  assertEquals(p.z < 0, true);
});

Deno.test("stale sequence dropped", () => {
  const { p, collision } = groundedPlayer();
  p.queueInput(input(5, { forward: true }), 1);
  p.queueInput(input(3, { backward: true }), 1); // stale
  assertEquals(p.lastSequence, 5);
  p.update(collision, 1);
  assertEquals(p.lastTickInputSelection()?.appliedSequence, 5);
  assertEquals(p.lastTickInputSelection()?.selectedInput?.forward, true);
});

Deno.test("silent tick repeats last (repeat_missing)", () => {
  const { p, collision } = groundedPlayer();
  p.queueInput(input(1, { forward: true }), 1);
  p.update(collision, 1);
  const z1 = p.z;
  p.update(collision, 2);
  const sel = p.lastTickInputSelection();
  assertEquals(sel?.association, "repeat_missing");
  assertEquals(sel?.appliedSequence, 1);
  assertEquals(sel?.inputHoldTicks, 2);
  assertEquals(p.z > z1, true); // still walking on held forward (yaw=π → +Z)
});

Deno.test("never-any-input tick uses neutral association", () => {
  const { p, collision } = groundedPlayer();
  const x0 = p.x;
  p.update(collision, 1);
  const sel = p.lastTickInputSelection();
  assertEquals(sel?.association, "neutral");
  assertEquals(sel?.selectedInput, null);
  assertEquals(sel?.appliedSequence, 0);
  assertEquals(sel?.inputHoldTicks, 0);
  assertAlmostEquals(p.x, x0, 1e-9);
});

Deno.test("dead-player input never moves", () => {
  const { p, collision } = groundedPlayer();
  assertEquals(p.takeDamage(9999, "body", 10_000, Date.now()), true);
  assertEquals(p.alive, false);
  const x0 = p.x;
  const z0 = p.z;
  p.queueInput(input(1, { forward: true, yaw: p.yaw + 0.2 }), 1);
  p.update(collision, 2);
  assertEquals(p.lastTickInputSelection()?.association, "dead");
  assertAlmostEquals(p.x, x0, 1e-9);
  assertAlmostEquals(p.z, z0, 1e-9);
  // Look still applied for AFK.
  assertAlmostEquals(p.yaw, Math.PI + 0.2, 1e-9);
});

Deno.test("connectionIssue: sitting duck, association connection_issue", () => {
  const { p, collision } = groundedPlayer();
  p.queueInput(input(1, { forward: true }), 1);
  p.markConnectionIssue(Date.now() + 60_000);
  p.update(collision, 2);
  const sel = p.lastTickInputSelection();
  assertEquals(sel?.association, "connection_issue");
  assertEquals(sel?.selectedInput, null);
});

Deno.test("mid-tick arrival after snapshot applies next tick only", () => {
  const { p, collision } = groundedPlayer();
  p.queueInput(input(1, { forward: true }), 1);
  // Simulate: update starts (would snapshot seq 1). Inject seq 2 only after
  // first update completes — next tick must pick it up as fresh.
  p.update(collision, 1);
  assertEquals(p.lastTickInputSelection()?.appliedSequence, 1);
  p.queueInput(input(2, { backward: true }), 1);
  p.update(collision, 2);
  assertEquals(p.lastTickInputSelection()?.association, "fresh");
  assertEquals(p.lastTickInputSelection()?.appliedSequence, 2);
  assertEquals(p.lastTickInputSelection()?.inputHoldTicks, 1);
});

Deno.test("re-queued same sequence labels hold (not repeat_missing)", () => {
  const { p, collision } = groundedPlayer();
  p.queueInput(input(1, { forward: true }), 1);
  p.update(collision, 1);
  p.queueInput(input(1, { forward: true }), 1); // same seq accepted (>=)
  p.update(collision, 2);
  assertEquals(p.lastTickInputSelection()?.association, "hold");
  assertEquals(p.lastTickInputSelection()?.inputHoldTicks, 2);
});

Deno.test("equivalence probe: scripted arrivals bit-identical across runs", () => {
  function run(): number[] {
    const collision = new MapCollision(mapWithWalls());
    const p = new Player("eq", "Eq", "A", {
      spawn: { x: -2, z: -4, yaw: Math.PI },
    });
    const xs: number[] = [];
    for (let tick = 1; tick <= 30; tick++) {
      if (tick === 1) {
        p.queueInput(input(1, { forward: true, jump: true }), 1);
        p.queueInput(input(2, { forward: true }), 1); // last-wins
      } else if (tick === 5) {
        p.queueInput(input(1, { backward: true }), 1); // stale drop
      } else if (tick === 10) {
        p.queueInput(input(3, { left: true, yaw: Math.PI / 2 }), 1);
      } else if (tick === 15) {
        p.queueInput(input(4, { forward: true, sprint: true }), 1);
      }
      // gaps → repeat_missing
      p.update(collision, tick);
      xs.push(p.x, p.y, p.z);
    }
    return xs;
  }
  const a = run();
  const b = run();
  assertEquals(a, b);
});

Deno.test("PlayerManager.update: association exposed per roster player", () => {
  const collision = new MapCollision(mapWithWalls());
  const pm = new PlayerManager(collision, { nowMs: 1 });
  const a = pm.add("a", "Alice", "A", undefined, 1);
  const b = pm.add("b", "Bob", "B", undefined, 1);
  a.queueInput(input(1, { forward: true }), 1);
  // b silent
  pm.update(1, 1);
  assertEquals(a.lastTickInputSelection()?.association, "fresh");
  assertEquals(b.lastTickInputSelection()?.association, "neutral");
  pm.update(2, 1);
  assertEquals(a.lastTickInputSelection()?.association, "repeat_missing");
  assertEquals(a.lastTickInputSelection()?.inputHoldTicks, 2);
});
