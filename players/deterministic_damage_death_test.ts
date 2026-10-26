/**
 * Deterministic damage, death, and respawn contract.
 * Run: deno test -A server-community/players/deterministic_damage_death_test.ts
 */

import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import {
  MAX_HEALTH,
  RESPAWN_DELAY_TICKS,
  SPAWN_INVULN_TICKS,
} from "../protocol/network.ts";
import { MOVE_CROUCH_EYE } from "../shared/sim/moveStep.ts";
import { Player, PLAYER_HEIGHT } from "./Player.ts";

const NOW_MS = 0;

type DamageCase = {
  name: string;
  health: number;
  amount: number;
  tick: number;
  spawnedAtTick: number;
  forceFieldEndsAtTick?: number;
  killed: boolean;
  expectedHealth: number;
  expectedAlive: boolean;
};

Deno.test("takeDamage is deterministic across protection and damage cases", () => {
  const cases: DamageCase[] = [
    {
      name: "nonlethal damage",
      health: 100,
      amount: 25,
      tick: 1_000,
      spawnedAtTick: 0,
      killed: false,
      expectedHealth: 75,
      expectedAlive: true,
    },
    {
      name: "lethal damage",
      health: 100,
      amount: 100,
      tick: 1_000,
      spawnedAtTick: 0,
      killed: true,
      expectedHealth: 0,
      expectedAlive: false,
    },
    {
      name: "overkill clamps health",
      health: 40,
      amount: 999,
      tick: 1_000,
      spawnedAtTick: 0,
      killed: true,
      expectedHealth: 0,
      expectedAlive: false,
    },
    {
      name: "spawn protection",
      health: 100,
      amount: 999,
      tick: 100,
      spawnedAtTick: 100,
      killed: false,
      expectedHealth: 100,
      expectedAlive: true,
    },
    {
      name: "damage at spawn protection expiry",
      health: 100,
      amount: 25,
      tick: 100 + SPAWN_INVULN_TICKS,
      spawnedAtTick: 100,
      killed: false,
      expectedHealth: 75,
      expectedAlive: true,
    },
    {
      name: "force field",
      health: 100,
      amount: 999,
      tick: 1_010,
      spawnedAtTick: 0,
      forceFieldEndsAtTick: 1_020,
      killed: false,
      expectedHealth: 100,
      expectedAlive: true,
    },
    {
      name: "after force field expiry",
      health: 100,
      amount: 999,
      tick: 1_020,
      spawnedAtTick: 0,
      forceFieldEndsAtTick: 1_020,
      killed: true,
      expectedHealth: 0,
      expectedAlive: false,
    },
  ];

  for (const testCase of cases) {
    const p = new Player(testCase.name, testCase.name, "A");
    p.health = testCase.health;
    p.spawnedAtTick = testCase.spawnedAtTick;
    if (testCase.forceFieldEndsAtTick !== undefined) {
      p.abilityEndsAtTick.forceField = testCase.forceFieldEndsAtTick;
    }

    const killed = p.takeDamage(
      testCase.amount,
      "body",
      testCase.tick,
      NOW_MS,
    );
    assertEquals(killed, testCase.killed, testCase.name);
    assertEquals(p.health, testCase.expectedHealth, testCase.name);
    assertEquals(p.alive, testCase.expectedAlive, testCase.name);
    assertEquals(
      p.diedAtTick,
      testCase.killed ? testCase.tick : null,
      testCase.name,
    );
  }
});

Deno.test("overlap death bypasses protection and resets death state", () => {
  const p = new Player("overlap", "Overlap", "A");
  p.spawnedAtTick = 100;
  p.abilityEndsAtTick.forceField = 200;
  p.health = 75;
  p.crouch = true;
  p.y = MOVE_CROUCH_EYE;
  p.velocityX = 3;
  p.velocityY = 2;
  p.velocityZ = -4;

  assertEquals(p.dieFromOverlap(100, NOW_MS), true);
  assertEquals(p.alive, false);
  assertEquals(p.health, 0);
  assertEquals(p.diedAtTick, 100);
  assertEquals(p.velocityX, 0);
  assertEquals(p.velocityY, 0);
  assertEquals(p.velocityZ, 0);
  assertEquals(p.crouch, false);
  assertAlmostEquals(p.y, PLAYER_HEIGHT, 1e-9);
  assertEquals(p.dieFromOverlap(101, NOW_MS), false);
});

Deno.test("shouldRespawn uses the exact death tick boundary", () => {
  const p = new Player("respawn", "Respawn", "A");
  const deathTick = 200;
  assertEquals(p.takeDamage(999, "body", deathTick, NOW_MS), true);

  assertEquals(
    p.shouldRespawn(deathTick + RESPAWN_DELAY_TICKS - 1),
    false,
  );
  assertEquals(p.shouldRespawn(deathTick + RESPAWN_DELAY_TICKS), true);
});

Deno.test("respawn restores authoritative lifecycle and pose state", () => {
  const p = new Player("respawn", "Respawn", "A");
  const deathTick = 300;
  assertEquals(p.takeDamage(MAX_HEALTH, "head", deathTick, NOW_MS), true);
  p.connectionIssue = false;

  p.respawn({ x: 4, y: 1.75, z: -3, yaw: 0.5, pitch: 0.25 }, 500);

  assertEquals(p.alive, true);
  assertEquals(p.health, MAX_HEALTH);
  assertEquals(p.diedAtTick, null);
  assertEquals(p.spawnedAtTick, 500);
  assertEquals(p.x, 4);
  assertEquals(p.y, 1.75);
  assertEquals(p.z, -3);
  assertEquals(p.yaw, 0.5);
  assertEquals(p.pitch, 0.25);
  assertEquals(p.velocityX, 0);
  assertEquals(p.velocityY, 0);
  assertEquals(p.velocityZ, 0);
  assertEquals(p.onGround, true);
  assertEquals(p.crouch, false);
});
