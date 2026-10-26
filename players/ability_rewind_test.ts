/**
 * Skill E — Rewind (Hacker, instant, time).
 * Run: deno test -A server/players/ability_rewind_test.ts
 */
import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import {
  abilityBarRegenTicks,
  abilityDoorRegenTicks,
} from "../shared/sim/abilities.ts";
import { TICK_HZ } from "../shared/sim/game.ts";
import {
  INSTANT_SKILL_FLASH_TICKS,
  instantSkillLockTicks,
  skillValueForOwned,
} from "../shared/sim/skills.ts";
import { Player, POSE_HISTORY_MS, POSE_HISTORY_TICKS } from "./Player.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";

const instantLockTicks = instantSkillLockTicks();
const barRegenTicks = abilityBarRegenTicks();

function emptyMap(): DoorsMap {
  return {
    version: 1,
    name: "rewind-test",
    bounds: { minX: -100, maxX: 100, minZ: -100, maxZ: 100 },
    gridSize: 1,
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
    walls: [],
  };
}

function makePlayer(
  owned?: readonly string[] | null,
): Player {
  const p = new Player("r", "RewindTester", "A", {
    spawn: { x: 0, y: 1.7, z: 0, yaw: 0 },
    ...(owned !== undefined ? { ownedAbilities: owned } : {}),
  });
  p.spawnedAtTick = 0;
  p.restoreAbilityCharges();
  return p;
}

/** Walk forward for `ticks` sim steps; returns final tick. */
function walkForward(p: Player, startTick: number, ticks: number): number {
  const collision = new MapCollision(emptyMap());
  let tick = startTick;
  for (let i = 0; i < ticks; i++) {
    tick = startTick + i + 1;
    p.queueInput({
      sequence: tick,
      forward: true,
      backward: false,
      left: false,
      right: false,
      jump: false,
      sprint: false,
      crouch: false,
      yaw: 0,
      pitch: 0,
    });
    p.update(collision, tick);
  }
  return tick;
}

Deno.test("pose history capacity covers max Rewind window (3s) + margin", () => {
  // Max catalog window is 3s; ring is 3.5s.
  assertEquals(POSE_HISTORY_MS >= 3000, true);
  const maxWindowTicks = Math.ceil(3 * TICK_HZ);
  assertEquals(POSE_HISTORY_TICKS >= maxWindowTicks, true);
});

Deno.test("rewind restores pose from tier window (unrestricted = 3s)", () => {
  const p = makePlayer(); // unrestricted → max tier 3s
  const startX = p.x;
  const startZ = p.z;
  // Record spawn at tick 0 already via constructor applySpawn path; walk ~3s.
  const windowTicks = Math.ceil(3 * TICK_HZ);
  const tick = walkForward(p, 0, windowTicks + 5);
  assertEquals(Math.hypot(p.x - startX, p.z - startZ) > 1, true);

  const beforeX = p.x;
  const beforeZ = p.z;
  const expected = p.poseAt(tick - windowTicks);
  assertEquals(p.tryActivateAbility("rewind", tick), true);
  // Should be near the pose from ~3s ago, not current.
  assertEquals(Math.hypot(p.x - beforeX, p.z - beforeZ) > 0.5, true);
  assertAlmostEquals(p.x, expected.x, 1e-5);
  assertAlmostEquals(p.z, expected.z, 1e-5);
  assertEquals(p.isAbilitySpent("rewind"), true);
  assertEquals(p.abilityGlobalLockEndsAtTick, tick + instantLockTicks);
  assertEquals(p.velocityY, 0);
});

Deno.test("rewind tier I is 1.5s window", () => {
  const p = makePlayer(["quick", "glitch", "rewind"]);
  assertEquals(skillValueForOwned("rewind", ["rewind"]), 1.5);
  const windowTicks = Math.ceil(1.5 * TICK_HZ);
  // Walk longer than 1.5s so lookback differs from start and from now.
  const tick = walkForward(p, 0, windowTicks + 30);
  const farX = p.x;
  const farZ = p.z;
  assertEquals(p.tryActivateAbility("rewind", tick), true);
  // Not still at the far end.
  assertEquals(Math.hypot(p.x - farX, p.z - farZ) > 0.3, true);
  // Closer to mid-path than to the end (1.5s rewind, not full trip).
  const distFromEnd = Math.hypot(p.x - farX, p.z - farZ);
  const distFromStart = Math.hypot(p.x - 0, p.z - 0);
  assertEquals(distFromEnd > 0.2, true);
  assertEquals(distFromStart > 0.2, true);
});

Deno.test("rewind tier II is 2.25s; tier III is 3s", () => {
  assertEquals(
    skillValueForOwned("rewind", ["rewind", "rewind2"]),
    2.25,
  );
  assertEquals(
    skillValueForOwned("rewind", ["rewind", "rewind2", "rewind3"]),
    3,
  );

  const p2 = makePlayer(["quick", "glitch", "rewind", "rewind2"]);
  const windowTicks = Math.ceil(2.25 * TICK_HZ);
  const tick = walkForward(p2, 0, windowTicks + 10);
  const farX = p2.x;
  const farZ = p2.z;
  assertEquals(p2.tryActivateAbility("rewind", tick), true);
  assertEquals(Math.hypot(p2.x - farX, p2.z - farZ) > 0.3, true);
});

Deno.test("rewind restores crouch stance from history", () => {
  // Tier I = 1.5s window so we can place crouch in that lookback.
  const p = makePlayer(["quick", "glitch", "rewind"]);
  const collision = new MapCollision(emptyMap());
  let tick = 0;
  // Standing walk, then crouch-walk for >1.5s, then stand briefly.
  for (let i = 0; i < 20; i++) {
    tick += 1;
    p.queueInput({
      sequence: tick,
      forward: true,
      backward: false,
      left: false,
      right: false,
      jump: false,
      sprint: false,
      crouch: false,
      yaw: 0,
      pitch: 0,
    });
    p.update(collision, tick);
  }
  for (let i = 0; i < Math.ceil(2 * TICK_HZ); i++) {
    tick += 1;
    p.queueInput({
      sequence: tick,
      forward: true,
      backward: false,
      left: false,
      right: false,
      jump: false,
      sprint: false,
      crouch: true,
      yaw: 0,
      pitch: 0,
    });
    p.update(collision, tick);
  }
  // Stand up so current crouch is false; 1.5s lookback is still crouched.
  for (let i = 0; i < 15; i++) {
    tick += 1;
    p.queueInput({
      sequence: tick,
      forward: false,
      backward: false,
      left: false,
      right: false,
      jump: false,
      sprint: false,
      crouch: false,
      yaw: 0,
      pitch: 0,
    });
    p.update(collision, tick);
  }
  assertEquals(p.crouch, false);
  assertEquals(p.tryActivateAbility("rewind", tick), true);
  assertEquals(p.crouch, true);
});

Deno.test("rewind denied when unowned (guest)", () => {
  const p = makePlayer([]);
  walkForward(p, 0, 30);
  assertEquals(p.ownsAbility("rewind"), false);
  const x = p.x;
  const z = p.z;
  assertEquals(p.tryActivateAbility("rewind", 30), false);
  assertEquals(p.x, x);
  assertEquals(p.z, z);
});

Deno.test("rewind denied when dead", () => {
  const p = makePlayer();
  const tick = walkForward(p, 0, 40);
  p.alive = false;
  const x = p.x;
  const z = p.z;
  assertEquals(p.tryActivateAbility("rewind", tick), false);
  assertEquals(p.x, x);
  assertEquals(p.z, z);
});

Deno.test("rewind denied while global lock / spent", () => {
  const p = makePlayer();
  const tick = walkForward(p, 0, Math.ceil(2 * TICK_HZ) + 5);
  assertEquals(p.tryActivateAbility("rewind", tick), true);
  const midX = p.x;
  const midZ = p.z;
  // Walk again then try second rewind — blocked.
  const later = walkForward(p, tick, 20);
  assertEquals(p.tryActivateAbility("rewind", later), false);
  // Position may have moved from walk, but ability not re-applied as rewind.
  assertEquals(p.isAbilitySpent("rewind"), true);

  const after = tick + instantLockTicks + barRegenTicks;
  p.tickAbilityCharges(after);
  assertEquals(p.tryActivateAbility("rewind", after), false);
  assertEquals(p.isAbilitySpent("rewind"), true);
  // Suppress unused if walk didn't move much.
  void midX;
  void midZ;
});

Deno.test("rewind flash for VFX without re-spend on expire", () => {
  const p = makePlayer();
  const tick = walkForward(p, 0, Math.ceil(2 * TICK_HZ));
  assertEquals(p.tryActivateAbility("rewind", tick), true);
  if (INSTANT_SKILL_FLASH_TICKS > 0) {
    assertEquals(p.isAbilityActive("rewind", tick), true);
    p.tickAbilityCharges(tick + INSTANT_SKILL_FLASH_TICKS);
  }
  assertEquals(p.isAbilitySpent("rewind"), true);
});

Deno.test("door regen restores rewind charge", () => {
  const p = makePlayer();
  const tick = walkForward(p, 0, Math.ceil(2 * TICK_HZ));
  assertEquals(p.tryActivateAbility("rewind", tick), true);
  assertEquals(p.isAbilitySpent("rewind"), true);

  const idle = tick + instantLockTicks + barRegenTicks;
  p.tickAbilityCharges(idle);
  p.beginAbilityDoorRegen(idle);
  p.tickAbilityCharges(idle + abilityDoorRegenTicks());
  assertEquals(p.isAbilitySpent("rewind"), false);

  // Build more history then rewind again.
  const later = walkForward(
    p,
    idle + abilityDoorRegenTicks(),
    Math.ceil(2 * TICK_HZ),
  );
  assertEquals(p.tryActivateAbility("rewind", later), true);
});

Deno.test("snapshot includes rewind spent + pose after activate", () => {
  const p = makePlayer(["quick", "glitch", "rewind"]);
  const tick = walkForward(p, 0, Math.ceil(1 * TICK_HZ) + 10);
  assertEquals(p.tryActivateAbility("rewind", tick), true);
  const full = p.toSnapshot(tick, "full");
  assertEquals(full.abilitySpent?.includes("rewind") ?? false, true);
  assertEquals(full.abilityLockEndsAtTick, tick + instantLockTicks);
  assertAlmostEquals(full.x, p.x, 1e-6);
  assertAlmostEquals(full.z, p.z, 1e-6);
});

Deno.test("pose ring retains samples beyond old 350ms window", () => {
  const p = makePlayer();
  // Walk ~1.5s so a sample ~1s back is outside the old 350ms lag-comp ring.
  const tick = walkForward(p, 0, Math.ceil(1.5 * TICK_HZ));
  const pastTick = tick - Math.ceil(1 * TICK_HZ);
  const past = p.poseAt(pastTick);
  const now = p.poseAt(tick);
  assertEquals(Math.hypot(past.x - now.x, past.z - now.z) > 0.5, true);
});

Deno.test("short history rewinds to oldest available pose", () => {
  const p = makePlayer();
  // Only a few samples; max window requests older than history.
  // Spawn already recorded at tick 0 — that is the clamp target.
  p.x = 5;
  p.z = 6;
  p.recordPose(10);
  p.x = 9;
  p.z = 12;
  p.recordPose(20);
  assertEquals(p.tryActivateAbility("rewind", 20), true);
  // Clamps to oldest (spawn at 0,0).
  assertAlmostEquals(p.x, 0, 1e-6);
  assertAlmostEquals(p.z, 0, 1e-6);
});

Deno.test("rewind snapshot includes from* pre-warp pose for VFX", () => {
  const p = makePlayer();
  // Seed pose history so rewind has somewhere to go.
  for (let t = 0; t < 200; t++) {
    p.x = 5 + t * 0.01;
    p.z = 3 + t * 0.01;
    p.recordPose(t);
  }
  const tick = 200;
  p.x = 10;
  p.y = 1.6;
  p.z = 8;
  const fromX = p.x;
  const fromY = p.y;
  const fromZ = p.z;
  assertEquals(p.tryActivateAbility("rewind", tick), true);
  const snap = p.toSnapshot(tick, "motion");
  const entry = snap.abilities?.find((a) => a.id === "rewind");
  assertEquals(entry != null, true);
  assertEquals(entry!.fromX, fromX);
  assertEquals(entry!.fromY, fromY);
  assertEquals(entry!.fromZ, fromZ);
  // Player moved to past pose, not still at from.
  assertEquals(
    Math.abs(p.x - fromX) > 0.01 || Math.abs(p.z - fromZ) > 0.01,
    true,
  );
});
