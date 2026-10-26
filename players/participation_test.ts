/**
 * Live-match participation sampling for XP/coin base scaling.
 *   cd server-community && deno test -A players/participation_test.ts
 */

import { assert, assertEquals } from "jsr:@std/assert";
import { AFK_TIMEOUT_MS } from "../protocol/network.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";
import { Player } from "./Player.ts";
import { PlayerManager } from "./PlayerManager.ts";

const miniMap: DoorsMap = {
  name: "test",
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

function simObservableState(p: Player) {
  return {
    x: p.x,
    y: p.y,
    z: p.z,
    yaw: p.yaw,
    pitch: p.pitch,
    velocityX: p.velocityX,
    velocityY: p.velocityY,
    velocityZ: p.velocityZ,
    onGround: p.onGround,
    crouch: p.crouch,
    sprintStamina: p.sprintStamina,
    slideRemaining: p.slideRemaining,
    slideDirX: p.slideDirX,
    slideDirZ: p.slideDirZ,
    slideForceCrouch: p.slideForceCrouch,
    maxHealth: p.maxHealth,
    health: p.health,
    alive: p.alive,
    spawnedAtTick: p.spawnedAtTick,
    diedAtTick: p.diedAtTick,
    connectionIssue: p.connectionIssue,
    lastSequence: p.lastSequence,
    lastShotAtTick: p.lastShotAtTick,
    lastMeleeAtTick: p.lastMeleeAtTick,
    weaponId: p.weaponId,
    reloadEndsAtTick: p.reloadEndsAtTick,
    weaponSwitchEndsAtTick: p.weaponSwitchEndsAtTick,
    unlimitedAmmo: p.unlimitedAmmo,
    abilityEndsAtTick: { ...p.abilityEndsAtTick },
    abilityGlobalLockEndsAtTick: p.abilityGlobalLockEndsAtTick,
    abilityBarRegenEndsAtTick: p.abilityBarRegenEndsAtTick,
    abilityDoorRegenEndsAtTick: p.abilityDoorRegenEndsAtTick,
    abilitySpent: { ...p.abilitySpent },
  };
}

Deno.test("Player: active time accumulates while participating", () => {
  const p = new Player("h1", "Alice", "A");
  const t0 = 1_000_000;
  p.resetMatchParticipation(t0);
  p.touchActivity(t0);

  p.sampleParticipation(t0 + 5_000);
  assertEquals(p.activeMatchMs, 5_000);

  p.sampleParticipation(t0 + 10_000);
  assertEquals(p.activeMatchMs, 10_000);
});

Deno.test("Player: AFK time is excluded from activeMatchMs", () => {
  const p = new Player("h1", "Alice", "A");
  const t0 = 2_000_000;
  p.resetMatchParticipation(t0);
  // Last activity at match start; after AFK_TIMEOUT_MS player is AFK.
  p.touchActivity(t0);

  // Still within AFK grace → counts.
  p.sampleParticipation(t0 + AFK_TIMEOUT_MS - 1);
  assertEquals(p.activeMatchMs, AFK_TIMEOUT_MS - 1);
  assertEquals(p.isAfk(t0 + AFK_TIMEOUT_MS - 1), false);

  // Cross AFK threshold: was active at previous sample → this window credited,
  // then wasActive flips false.
  p.sampleParticipation(t0 + AFK_TIMEOUT_MS + 5_000);
  assertEquals(p.activeMatchMs, AFK_TIMEOUT_MS - 1 + 5_000 + 1);
  assertEquals(p.isAfk(t0 + AFK_TIMEOUT_MS + 5_000), true);
  // Further AFK time is not credited.
  p.sampleParticipation(t0 + AFK_TIMEOUT_MS + 15_000);
  assertEquals(p.activeMatchMs, AFK_TIMEOUT_MS - 1 + 5_000 + 1);
});

Deno.test("Player: connectionIssue time is excluded", () => {
  const p = new Player("h1", "Alice", "A");
  const t0 = 3_000_000;
  p.resetMatchParticipation(t0);
  p.touchActivity(t0);
  p.sampleParticipation(t0 + 2_000);
  assertEquals(p.activeMatchMs, 2_000);

  p.markConnectionIssue(t0 + 60_000);
  // Was active at previous sample → credit the straddling window once.
  p.sampleParticipation(t0 + 12_000);
  assertEquals(p.activeMatchMs, 12_000);
  // Subsequent samples while connectionIssue: no more credit.
  p.sampleParticipation(t0 + 22_000);
  assertEquals(p.activeMatchMs, 12_000);
});

Deno.test("Player: participationFactor is active/duration clamped", () => {
  const p = new Player("h1", "Alice", "A");
  const t0 = 4_000_000;
  p.resetMatchParticipation(t0);
  p.touchActivity(t0);
  p.sampleParticipation(t0 + 30_000);
  assertEquals(p.participationFactor(60_000, t0 + 30_000), 0.5);
  assertEquals(p.participationFactor(10_000, t0 + 30_000), 1); // clamp
  assertEquals(p.participationFactor(0, t0 + 30_000), 1);
});

Deno.test("PlayerManager: full live attendance → participation ≈ 1", () => {
  const pm = new PlayerManager(new MapCollision(miniMap));
  const alice = pm.add("s1", "Alice", "A", { accountUserId: "user_a" });
  pm.beginLiveMatch(0);
  assert(pm.isLive());
  assert(pm.getLiveStartedAtMs() != null);

  // Simulate ~2s of active play via update sampling.
  const start = pm.getLiveStartedAtMs()!;
  alice.touchActivity(start);
  // Manually advance samples as if wall-clock advanced.
  alice.sampleParticipation(start + 2_000);
  const { matchDurationMs, byPlayerId } = pm.getMatchParticipation(
    start + 2_000,
  );
  assertEquals(matchDurationMs, 2_000);
  assertEquals(byPlayerId.get(alice.id), 2_000);
  assertEquals(pm.participationForPlayer(alice.id, start + 2_000), 1);
});

Deno.test("PlayerManager: participation sampling is outside sim update", () => {
  const pm = new PlayerManager(new MapCollision(miniMap));
  const alice = pm.add("s1", "Alice", "A", { accountUserId: "user_a" });
  pm.beginLiveMatch(0);
  const start = pm.getLiveStartedAtMs()!;
  alice.resetMatchParticipation(start);
  alice.touchActivity(start);

  pm.update(1);
  assertEquals(alice.activeMatchMs, 0);

  const beforeSampling = simObservableState(alice);
  pm.sampleParticipation(start + 2_000);
  assertEquals(simObservableState(alice), beforeSampling);
  assertEquals(alice.activeMatchMs, 2_000);
  assertEquals(alice.participationLastSampleMs, start + 2_000);
});

Deno.test("PlayerManager: late joiner has reduced participation", () => {
  const pm = new PlayerManager(new MapCollision(miniMap));
  pm.beginLiveMatch(0);
  const liveStart = pm.getLiveStartedAtMs()!;

  // Match has already run 8s when late joiner arrives.
  const lateJoinAt = liveStart + 8_000;
  const bob = pm.add("s2", "Bob", "B", { accountUserId: "user_b" });
  // add() resets participation at join wall-clock (~now). Force test clocks:
  bob.resetMatchParticipation(lateJoinAt);
  bob.touchActivity(lateJoinAt);
  bob.sampleParticipation(lateJoinAt + 2_000);

  // End match at liveStart + 10s → bob active 2s / 10s duration.
  const endMs = liveStart + 10_000;
  // getMatchParticipation uses Date.now() for duration from liveStartedAtMs;
  // override by computing manually from known clocks.
  const active = bob.finalizeParticipation(endMs);
  assertEquals(active, 2_000);
  const factor = Math.min(1, Math.max(0, active / (endMs - liveStart)));
  assertEquals(factor, 0.2);
});

Deno.test(
  "PlayerManager: fixed metadata timestamp keeps match transition clock-independent",
  () => {
    const pm = new PlayerManager(new MapCollision(miniMap), {
      enablePrematch: true,
    });
    pm.add("s1", "Alice", "A");

    const originalNow = Date.now;
    try {
      Date.now = () => {
        throw new Error("simulation rule path read Date.now()");
      };

      const liveStartMs = 9_000_000;
      pm.beginLiveMatch(120, liveStartMs);
      assertEquals(pm.getLiveStartedAtMs(), liveStartMs);

      pm.sampleParticipation(liveStartMs + 1_000);
      assertEquals(
        pm.getMatchParticipation(liveStartMs + 1_000).matchDurationMs,
        1_000,
      );
    } finally {
      Date.now = originalNow;
    }
  },
);
