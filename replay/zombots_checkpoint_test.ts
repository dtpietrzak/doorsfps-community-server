/**
 * Zombots checkpoints and replay facts (notes/zombots.md step 14): the rules
 * flag, per-player zombots state and open doors survive capture → JSON →
 * restore; other modes keep their checkpoint shape; the `zombots` event
 * kind normalizes and drains.
 */
import { assertEquals, assertExists } from "@std/assert";
import { drainTickAuthoritativeEvents } from "../players/authoritativeEventSource.ts";
import { PlayerManager } from "../players/PlayerManager.ts";
import { ZOMBOTS_SIM_RULES } from "../players/zombotsSimRules.ts";
import { WEAPON_PISTOL, WEAPON_RIFLE } from "../protocol/network.ts";
import { normalizeAuthoritativeEvent } from "../shared/sim/authoritativeEvent.ts";
import { loadMapFile } from "../world/loadMap.ts";
import type { DoorsMap } from "../world/map.ts";
import { MapCollision } from "../world/MapCollision.ts";
import {
  type AuthoritativeCheckpoint,
  captureCheckpointState,
} from "./authoritativeCheckpoint.ts";

const ZOMBOTS_01 = new URL("../maps/zombots/Zombots-01.doors.json", import.meta.url);
const DOOR = "door_ei1akqdg";

const ARENA: DoorsMap = {
  name: "arena-test",
  version: 1,
  bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 },
  gridSize: 1,
  walls: [],
  teamA: { corners: [0, 1], edge: "south", doorHalfWidth: 2, spawnRadius: 4 },
  teamB: { corners: [2, 3], edge: "north", doorHalfWidth: 2, spawnRadius: 4 },
};

function viaJson(cp: AuthoritativeCheckpoint): AuthoritativeCheckpoint {
  return JSON.parse(JSON.stringify(cp)) as AuthoritativeCheckpoint;
}

Deno.test("zombots checkpoint: rules, player state and open doors round-trip", async () => {
  const map = await loadMapFile(ZOMBOTS_01.pathname);
  const live = new PlayerManager(new MapCollision(map), { matchSeed: 7, nowMs: 0 });
  live.setZombotsRules({ ...ZOMBOTS_SIM_RULES });
  live.add("p1", "p1", "A", undefined, 0);
  live.add("p2", "p2", "A", undefined, 0);
  live.addBot("bot:zombie-1", "zombie", { team: "B", maxHealth: 140 });
  live.setMeleeDamageOverride("bot:zombie-1", 25);
  live.armPlayer("p1", WEAPON_PISTOL);
  live.get("p2")!.dieFromOverlap(1, 0);
  live.getCollision().openSlidingDoor(DOOR);
  live.drainAuthoritativeEvents();

  const run = {
    phase: "wave" as const,
    wave: 3,
    zombiesLeft: 9,
    msUntilNextWave: 0,
    humans: ["p1", "p2"],
    downed: ["p2"],
    purses: [{ id: "p1", points: 750 }, { id: "p2", points: 120 }],
    revives: [],
    armed: [{ id: "p1", weapons: [WEAPON_PISTOL] }, { id: "p2", weapons: [] }],
    zombies: ["bot:zombie-1"],
  };
  const cp = viaJson(captureCheckpointState(live, 1, "match-1", { active: false }, {
    zombotsRun: run,
  }));
  assertExists(cp.match.zombots);
  assertEquals(cp.match.zombots.rules, ZOMBOTS_SIM_RULES);
  assertEquals(cp.match.zombots.openDoorIds, [DOOR]);
  assertEquals(cp.match.zombots.run, run);
  const p2 = cp.players.find((p) => p.id === "p2")!;
  assertEquals(p2.zombots?.downed, true);

  // Restore onto a fresh collision: the door opens from the checkpoint.
  const rebuilt = new PlayerManager(new MapCollision(map), { matchSeed: 7, nowMs: 0 });
  rebuilt.restoreFromCheckpoint(cp);
  assertEquals(rebuilt.getZombotsRules(), ZOMBOTS_SIM_RULES);
  assertEquals(rebuilt.getCollision().isSlidingDoorOpen(DOOR), true);
  assertEquals(rebuilt.get("p1")!.isWeaponArmed(WEAPON_PISTOL), true);
  assertEquals(rebuilt.get("p1")!.isWeaponArmed(WEAPON_RIFLE), false);
  assertEquals(rebuilt.isDowned("p2"), true);
  assertEquals(rebuilt.get("bot:zombie-1")!.meleeDamageOverride, 25);
  // A second capture of the rebuilt sim matches, minus the runtime block.
  const again = viaJson(captureCheckpointState(rebuilt, 1, "match-1"));
  assertEquals(again.players, cp.players);
  assertEquals(again.match.zombots?.openDoorIds, [DOOR]);
});

Deno.test("zombots checkpoint: other modes keep their shape", () => {
  const pm = new PlayerManager(new MapCollision(ARENA), { matchSeed: 7, nowMs: 0 });
  pm.add("p1", "p1", "A", undefined, 0);
  pm.drainAuthoritativeEvents();
  const cp = captureCheckpointState(pm, 1, "match-1");
  assertEquals("zombots" in cp.match, false);
  assertEquals(cp.players.some((p) => "zombots" in p), false);
  // Restoring an arena checkpoint turns zombots rules off.
  const other = new PlayerManager(new MapCollision(ARENA), { matchSeed: 7, nowMs: 0 });
  other.setZombotsRules({ ...ZOMBOTS_SIM_RULES });
  other.restoreFromCheckpoint(viaJson(cp));
  assertEquals(other.getZombotsRules(), null);
});

Deno.test("zombots events: every op normalizes; junk is dropped", () => {
  const ops = [
    { kind: "zombots", appliedTick: 5, op: "doorOpened", doorId: DOOR, by: "p1" },
    { kind: "zombots", appliedTick: 5, op: "revived", playerId: "p2", by: "p1", healthFraction: 0.5 },
    { kind: "zombots", appliedTick: 5, op: "armed", playerId: "p1", weaponId: 1, refill: false },
  ];
  for (const op of ops) assertEquals(normalizeAuthoritativeEvent(op), op as unknown);
  assertEquals(normalizeAuthoritativeEvent({ kind: "zombots", appliedTick: 5, op: "nope" }), null);
  assertEquals(
    normalizeAuthoritativeEvent({ kind: "zombots", appliedTick: 5, op: "doorOpened", by: "p1" }),
    null,
  );
});

Deno.test("zombots events: the tick drain records Zombots sim facts in place", () => {
  const pm = new PlayerManager(new MapCollision(ARENA), { matchSeed: 7, nowMs: 0 });
  pm.drainAuthoritativeEvents();
  const drained = drainTickAuthoritativeEvents(pm, 9, [
    { type: "Zombots", fact: { op: "doorOpened", doorId: DOOR, by: "p1" } },
    {
      type: "Zombots",
      fact: { op: "armed", playerId: "p1", weaponId: WEAPON_PISTOL, refill: true },
    },
  ]);
  assertEquals(drained, [
    { kind: "zombots", appliedTick: 9, op: "doorOpened", doorId: DOOR, by: "p1" },
    {
      kind: "zombots",
      appliedTick: 9,
      op: "armed",
      playerId: "p1",
      weaponId: WEAPON_PISTOL,
      refill: true,
    },
  ]);
});
