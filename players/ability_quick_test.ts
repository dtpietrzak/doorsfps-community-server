/**
 * PR2 Quick — stall all stamina spend for the owned tier window (max 2.5s).
 * Run: deno test -A server/players/ability_quick_test.ts
 */
import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";
import {
  slideStaminaCostSeconds,
  SPRINT_DURATION_S,
} from "../protocol/network.ts";
import { abilityDurationTicks } from "../shared/sim/abilities.ts";
import { Player } from "./Player.ts";

const durationTicks = abilityDurationTicks("quick");

const openMap: DoorsMap = {
  version: 1,
  name: "QuickOpen",
  bounds: { minX: -40, maxX: 40, minZ: -40, maxZ: 40 },
  gridSize: 1,
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
  walls: [],
};

function makePlayer(): Player {
  const p = new Player("q", "QuickTester", "A", {
    spawn: { x: 0, z: 0, yaw: Math.PI },
  });
  p.spawnedAtTick = 0;
  p.sprintStamina = SPRINT_DURATION_S;
  p.restoreAbilityCharges();
  return p;
}

function stepSprint(p: Player, col: MapCollision, tick: number): void {
  p.queueInput({
    sequence: tick + 1,
    forward: true,
    backward: false,
    left: false,
    right: false,
    jump: false,
    sprint: true,
    crouch: false,
    yaw: Math.PI,
    pitch: 0,
  });
  p.update(col, tick);
}

Deno.test("tryActivateAbility quick sets end tick and isAbilityActive", () => {
  const p = makePlayer();
  const tick = 10;
  assertEquals(p.tryActivateAbility("quick", tick), true);
  assertEquals(p.isAbilityActive("quick", tick), true);
  assertEquals(p.isAbilityActive("quick", tick + durationTicks - 1), true);
  assertEquals(p.isAbilityActive("quick", tick + durationTicks), false);
  // Re-activate while active is no-op
  assertEquals(p.tryActivateAbility("quick", tick + 1), false);
});

Deno.test("Quick stalls sprint drain for full duration window", () => {
  const col = new MapCollision(openMap);
  const p = makePlayer();
  const startTick = 0;
  assertEquals(p.tryActivateAbility("quick", startTick), true);

  for (let t = startTick; t < startTick + durationTicks; t++) {
    stepSprint(p, col, t);
  }
  assertAlmostEquals(p.sprintStamina, SPRINT_DURATION_S, 1e-4);

  // After window, sprint drain resumes
  const after = p.sprintStamina;
  stepSprint(p, col, startTick + durationTicks);
  assertEquals(p.sprintStamina < after, true);
});

Deno.test("Quick stalls slide and jump stamina costs", () => {
  const col = new MapCollision(openMap);
  const p = makePlayer();
  const startTick = 5;
  assertEquals(p.tryActivateAbility("quick", startTick), true);

  // Slide start (rising crouch + forward)
  p.queueInput({
    sequence: 1,
    forward: true,
    backward: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
    crouch: true,
    yaw: Math.PI,
    pitch: 0,
  });
  p.update(col, startTick);
  assertEquals(p.isSliding(), true);
  assertAlmostEquals(p.sprintStamina, SPRINT_DURATION_S, 1e-4);

  // Jump without cost
  p.slideRemaining = 0;
  p.crouch = false;
  p.onGround = true;
  p.y = 1.7;
  p.queueInput({
    sequence: 2,
    forward: false,
    backward: false,
    left: false,
    right: false,
    jump: true,
    sprint: false,
    crouch: false,
    yaw: Math.PI,
    pitch: 0,
  });
  p.update(col, startTick + 1);
  assertEquals(p.onGround, false);
  assertAlmostEquals(p.sprintStamina, SPRINT_DURATION_S, 1e-4);
});

Deno.test("Quick still gates slide by stamina threshold", () => {
  const col = new MapCollision(openMap);
  const p = makePlayer();
  const cost = slideStaminaCostSeconds();
  const startStamina = Math.max(0, cost - 0.05);
  p.sprintStamina = startStamina;
  const startTick = 0;
  assertEquals(p.tryActivateAbility("quick", startTick), true);

  p.queueInput({
    sequence: 1,
    forward: true,
    backward: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
    crouch: true,
    yaw: Math.PI,
    pitch: 0,
  });
  p.update(col, startTick);
  // No free slide from below threshold.
  assertEquals(p.isSliding(), false);
  // May crouch-regen a tick; must not drop (no cost charged).
  assertEquals(p.sprintStamina >= startStamina - 1e-9, true);
});

Deno.test("snapshot includes active quick ability while window open", () => {
  const p = makePlayer();
  const tick = 20;
  p.tryActivateAbility("quick", tick);
  const snap = p.toSnapshot(tick, "motion");
  assertEquals(Array.isArray(snap.abilities), true);
  assertEquals(snap.abilities!.length, 1);
  assertEquals(snap.abilities![0]!.id, "quick");
  assertEquals(snap.abilities![0]!.endsAtTick, tick + durationTicks);

  const after = p.toSnapshot(tick + durationTicks, "motion");
  assertEquals(after.abilities, undefined);
});

Deno.test("dead player cannot activate Quick", () => {
  const p = makePlayer();
  p.alive = false;
  assertEquals(p.tryActivateAbility("quick", 0), false);
});
