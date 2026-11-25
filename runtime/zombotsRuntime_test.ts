/**
 * zombotsRuntime glue (notes/zombots.md step 11) over a real PlayerManager
 * and collision, with a fake BotManager port and a recording session hub.
 */
import { assert, assertEquals, assertExists } from "@std/assert";
import { PlayerManager, type ShootOutcome } from "../players/PlayerManager.ts";
import { SPAWN_INVULN_TICKS, WEAPON_PISTOL } from "../protocol/network.ts";
import { PLAYER_HEIGHT } from "../players/Player.ts";
import type { ZombotsHudPacket } from "../shared/zombots/zombotsHud.ts";
import { ZOMBOTS_TUNING } from "../shared/zombots/zombotsTuning.ts";
import type { SessionHub } from "../transport/types.ts";
import { loadMapFile } from "../world/loadMap.ts";
import type { DoorsMap } from "../world/map.ts";
import { MapCollision } from "../world/MapCollision.ts";
import { TICK_HZ } from "./GameLoop.ts";
import {
  type ZombotsBotPort,
  ZombotsRuntime,
  zombotsPadMap,
} from "./zombotsRuntime.ts";

const ZOMBOTS_01 = new URL("../maps/zombots/Zombots-01.doors.json", import.meta.url);

/** Open floor, one zombie spawn: no layout, so every spawn stays live. */
const OPEN_MAP: DoorsMap = {
  name: "zombots-open-test",
  version: 1,
  bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 },
  gridSize: 1,
  walls: [],
  teamA: { corners: [0, 1], edge: "south", doorHalfWidth: 2, spawnRadius: 4 },
  teamB: { corners: [2, 3], edge: "north", doorHalfWidth: 2, spawnRadius: 4 },
  mirrorMode: "zombots",
  spawnCorner: 0,
  zombieSpawns: [{ id: "zs1", p: { x: 15, z: 15 } }],
};

type Emitted = { event: string; payload: unknown };

function harness(baseMap: DoorsMap) {
  let map = baseMap;
  const players = new PlayerManager(new MapCollision(map), {
    matchSeed: 1234,
    nowMs: 0,
    damageRandom: () => 0.5,
  });
  const emitted: Emitted[] = [];
  const zombies = new Set<string>();
  let despawned = 0;
  let cleared = 0;
  const bots: ZombotsBotPort = {
    spawnZombie: (spec) => {
      if (players.get(spec.id)) return null;
      const p = players.addBot(spec.id, spec.name, {
        team: spec.team,
        maxHealth: spec.maxHealth,
        moveSpeedScale: spec.moveSpeedScale,
        modelScale: spec.modelScale,
      });
      p.applySpawn({ x: spec.x, y: PLAYER_HEIGHT, z: spec.z, yaw: spec.yaw }, players.tick);
      zombies.add(p.id);
      return p;
    },
    despawnZombie: (id) => {
      if (!zombies.delete(id)) return false;
      players.remove(id);
      despawned++;
      return true;
    },
    clearZombies: () => {
      cleared++;
      for (const id of [...zombies]) {
        players.remove(id);
        zombies.delete(id);
      }
    },
  };
  const dismissed: string[] = [];
  /** Match identities begun (one per party's run). */
  let identities = 0;
  const runtime = new ZombotsRuntime({
    isZombotsRuntime: () => true,
    players,
    bots,
    sessions: () =>
      ({
        emit: (event: string, payload?: unknown) => {
          emitted.push({ event, payload });
        },
      }) as unknown as SessionHub,
    map: () => map,
    mapPath: () => undefined,
    setActiveMap: (entry) => {
      map = entry.map;
      players.setCollision(entry.collision);
    },
    beginRuntimeMatchIdentity: () => {
      identities += 1;
    },
    notifyMatchStart: () => {},
    resetHeatmaps: () => {},
    dismissHumanToMenu: (p) => {
      dismissed.push(p.id);
      players.remove(p.id);
    },
    kickForAfk: () => {},
  });
  runtime.activate();
  players.startNewMatch(0, 0);
  let tick = 0;
  const step = (outcomes: ShootOutcome[] = []) => {
    tick += 1;
    players.update(tick, tick * 1000 / TICK_HZ);
    const result = runtime.step(tick, outcomes, tick * 1000 / TICK_HZ);
    runtime.flush();
    return result;
  };
  const steps = (n: number) => {
    for (let i = 0; i < n; i++) step();
  };
  const huds = () =>
    emitted.filter((e) => e.event === "zombotsState").map((e) => e.payload as ZombotsHudPacket);
  const join = (id: string) => {
    const p = players.add(id, id, "A", undefined, 0);
    runtime.markLoaded(id);
    return p;
  };
  return {
    players,
    runtime,
    zombies,
    emitted,
    dismissed,
    get identities() {
      return identities;
    },
    huds,
    join,
    step,
    steps,
    get tick() {
      return tick;
    },
    get map() {
      return map;
    },
    get despawned() {
      return despawned;
    },
    get cleared() {
      return cleared;
    },
  };
}

/** Stand a player somewhere, past spawn protection, looking along `yaw`. */
function stand(
  h: ReturnType<typeof harness>,
  id: string,
  x: number,
  z: number,
  yaw: number,
): void {
  const p = h.players.get(id)!;
  p.x = x;
  p.y = PLAYER_HEIGHT;
  p.z = z;
  p.yaw = yaw;
  p.pitch = 0;
  p.spawnedAtTick = h.tick - SPAWN_INVULN_TICKS - 1;
  p.recordPose(h.tick);
}

const FIRST_WAVE_TICKS = Math.ceil(ZOMBOTS_TUNING.timing.firstIntermissionMs / (1000 / TICK_HZ)) + 2;

Deno.test("zombots: pad map pins humans to the spawn corner", () => {
  const padded = zombotsPadMap(OPEN_MAP);
  assertEquals(padded.teamA.corners, [0, 0]);
  assertEquals(zombotsPadMap(padded), padded);
});

Deno.test("zombots: humans join the run only after MapLoaded", () => {
  const h = harness(OPEN_MAP);
  h.players.add("p1", "p1", "A", undefined, 0);
  h.steps(3);
  assertEquals(h.runtime.hud()?.phase, "waiting");
  h.runtime.markLoaded("p1");
  h.step();
  const hud = h.runtime.hud()!;
  assertEquals(hud.phase, "intermission");
  assertEquals(hud.players, [{ id: "p1", points: ZOMBOTS_TUNING.points.start, downed: false }]);
  assert(hud.nextWaveAtTick > h.tick);
  // The first block after the join carries the starting purse in its feed.
  const last = h.huds().at(-1)!;
  assertEquals(last.events?.[0], {
    kind: "pointsChanged",
    playerId: "p1",
    points: ZOMBOTS_TUNING.points.start,
    delta: ZOMBOTS_TUNING.points.start,
    reason: "start",
  });
  // Spawned unarmed under the zombots sim rules.
  assertEquals(h.players.get("p1")!.armedMask(), 0);
});

Deno.test("zombots: HUD blocks go out on change only", () => {
  const h = harness(OPEN_MAP);
  h.join("p1");
  h.step();
  const after = h.huds().length;
  h.steps(30);
  // Nothing changed during the intermission countdown: no packets.
  assertEquals(h.huds().length, after);
});

Deno.test("zombots: wave 1 spawns zombies at the map's spawns with tuned stats", () => {
  const h = harness(OPEN_MAP);
  h.join("p1");
  h.steps(FIRST_WAVE_TICKS);
  assertEquals(h.runtime.hud()?.phase, "wave");
  assertEquals(h.runtime.hud()?.wave, 1);
  assert(h.zombies.size >= 1);
  const z = h.players.get([...h.zombies][0])!;
  assertEquals(z.team, "B");
  assertEquals(z.maxHealth, ZOMBOTS_TUNING.zombie.baseHealth);
  assertEquals(z.meleeDamageOverride, ZOMBOTS_TUNING.zombie.baseMeleeDamage);
  assert(Math.abs(z.x - 15) < 1e-6 && Math.abs(z.z - 15) < 1e-6);
  assert(h.huds().some((b) => b.events?.some((e) => e.kind === "waveStart" && e.wave === 1)));
});

Deno.test("zombots: hits and kills pay the shooter and despawn the zombie", () => {
  const h = harness(OPEN_MAP);
  h.join("p1");
  h.steps(FIRST_WAVE_TICKS);
  const zid = [...h.zombies][0];
  h.players.get(zid)!.takeDamage(10_000, "body", h.tick, 0);
  const outcome: ShootOutcome = {
    shot: {
      shooterId: "p1",
      origin: [0, 0, 0],
      direction: [0, 0, 1],
      weapon: WEAPON_PISTOL,
      hitId: zid,
      hitZone: "body",
      hitPoint: null,
    },
    damages: [{
      targetId: zid,
      shooterId: "p1",
      damage: 100,
      health: 0,
      zone: "body",
      alive: false,
      killed: true,
      critical: false,
    }],
  };
  h.step([outcome]);
  const start = ZOMBOTS_TUNING.points.start;
  assertEquals(
    h.runtime.hud()!.players[0].points,
    start + ZOMBOTS_TUNING.points.hit + ZOMBOTS_TUNING.points.kill,
  );
  assertEquals(h.players.get(zid), undefined);
  assertEquals(h.despawned, 1);
});

Deno.test("zombots: a downed human is revived by 20 paid presses", () => {
  const h = harness(OPEN_MAP);
  h.join("helper");
  h.join("down");
  h.step();
  const helper = h.players.get("helper")!;
  const down = h.players.get("down")!;
  stand(h, "down", 0, 0, 0);
  stand(h, "helper", 0, 1.5, 0);
  down.dieFromOverlap(h.tick, 0);
  assertEquals(down.downed, true);
  h.step();
  assertEquals(h.runtime.hud()!.players.find((p) => p.id === "down")?.downed, true);
  const presses = ZOMBOTS_TUNING.revive.presses;
  const cost = ZOMBOTS_TUNING.revive.costPerPress;
  // Not enough points for a full revive: earn some by fiat first.
  const ledgerTopUp = presses * cost;
  for (let i = 0; i < ledgerTopUp / ZOMBOTS_TUNING.points.kill; i++) {
    (h.runtime as unknown as { run: { ledger: { award(id: string, r: string): void } } })
      .run.ledger.award("helper", "kill");
  }
  const before = h.runtime.hud()!.players.find((p) => p.id === "helper")!.points;
  for (let i = 0; i < presses - 1; i++) {
    h.runtime.queueInteract("helper", { yaw: 0, pitch: 0 });
    stand(h, "helper", 0, 1.5, 0);
    h.step();
  }
  assertEquals(h.runtime.hud()!.revives, [{ reviverId: "helper", targetId: "down", presses: presses - 1 }]);
  h.runtime.queueInteract("helper", { yaw: 0, pitch: 0 });
  const done = h.step();
  assertEquals(down.downed, false);
  assertEquals(down.alive, true);
  assertEquals(down.health, Math.round(down.maxHealth * ZOMBOTS_TUNING.revive.healthFraction));
  assertEquals(done.facts, [{
    op: "revived",
    playerId: "down",
    by: "helper",
    healthFraction: ZOMBOTS_TUNING.revive.healthFraction,
  }]);
  const after = h.runtime.hud()!.players.find((p) => p.id === "helper")!.points;
  assertEquals(before - after, presses * cost);
  assertEquals(helper.alive, true);
});

Deno.test("zombots: looking away drops the revive count", () => {
  const h = harness(OPEN_MAP);
  h.join("helper");
  h.join("down");
  h.step();
  stand(h, "down", 0, 0, 0);
  stand(h, "helper", 0, 1.5, 0);
  h.players.get("down")!.dieFromOverlap(h.tick, 0);
  h.step();
  const ledger = (h.runtime as unknown as {
    run: { ledger: { get(id: string): number; award(id: string, r: string): void } };
  }).run.ledger;
  while (ledger.get("helper") < 3 * ZOMBOTS_TUNING.revive.costPerPress) {
    ledger.award("helper", "kill");
  }
  for (let i = 0; i < 3; i++) {
    h.runtime.queueInteract("helper", { yaw: 0, pitch: 0 });
    stand(h, "helper", 0, 1.5, 0);
    h.step();
  }
  assertEquals(h.runtime.hud()!.revives[0]?.presses, 3);
  stand(h, "helper", 0, 1.5, Math.PI);
  h.step();
  assertEquals(h.runtime.hud()!.revives, []);
});

Deno.test("zombots: everyone down ends the run; the sit sends them to the menu", () => {
  const h = harness(OPEN_MAP);
  h.join("p1");
  h.steps(FIRST_WAVE_TICKS);
  assertEquals(h.identities, 1, "the run's first join begins its identity");
  stand(h, "p1", 0, 0, 0);
  h.players.get("p1")!.dieFromOverlap(h.tick, 0);
  const res = h.step();
  assertExists(res.gameOver);
  assertEquals(res.gameOver.winner, "B");
  assertEquals(h.runtime.hud()!.phase, "over");
  assertEquals(h.zombies.size, 0);
  const decorated = h.runtime.decorateGameOver(res.gameOver)!;
  assertEquals(decorated.matchKind, "zombots");
  assertEquals(decorated.returnToMenu, true);
  assertEquals(decorated.zombots?.wave, 1);
  // The sit ends: back to the menu, never a new run in place.
  h.runtime.closeEnded();
  assertEquals(h.dismissed, ["p1"]);
  assertEquals(h.players.humanCount(), 0);
  assertEquals(h.players.isMatchOver(), false);
  assertEquals(h.runtime.hud()!.phase, "waiting");
  assert(!h.emitted.some((e) => e.event === "mapChange"), "a new run started in place");
  // The next party gets a fresh run and its own identity.
  h.join("p2");
  h.step();
  assertEquals(h.identities, 2);
  assertEquals(h.runtime.hud()!.players.map((p) => p.id), ["p2"]);
  assertEquals(h.players.get("p2")!.armedMask(), 0);
});

Deno.test("zombots: the last human leaving idles the slot", () => {
  const h = harness(OPEN_MAP);
  h.join("p1");
  h.steps(FIRST_WAVE_TICKS);
  h.players.remove("p1");
  h.step();
  assertEquals(h.runtime.hud()!.phase, "waiting");
  assertEquals(h.zombies.size, 0);
  assertEquals(h.runtime.loadedPlayerIds.size, 0);
});

Deno.test("zombots: an unloaded human goes back to the menu after the load timeout", () => {
  const h = harness(OPEN_MAP);
  h.players.add("slow", "slow", "A", undefined, 0);
  h.runtime.afkTick(0);
  h.runtime.afkTick(59_000);
  assertEquals(h.dismissed, []);
  h.runtime.afkTick(60_001);
  assertEquals(h.dismissed, ["slow"]);
});

Deno.test("zombots: buying a door debits the purse and opens collision", async () => {
  const h = harness(await loadMapFile(ZOMBOTS_01.pathname));
  h.join("p1");
  h.step();
  const ledger = (h.runtime as unknown as {
    run: { ledger: { get(id: string): number; award(id: string, r: string): void } };
  }).run.ledger;
  while (ledger.get("p1") < 2000) ledger.award("p1", "kill");
  const before = ledger.get("p1");
  const doorId = "door_ei1akqdg";
  // East of the x = 5 wall, looking west at the door (forward = -x).
  stand(h, "p1", 6.5, -5, Math.PI / 2);
  // A 2000 door is two 1000 charges: the first leaves it shut, part paid.
  h.runtime.queueInteract("p1", { yaw: Math.PI / 2, pitch: 0 });
  assertEquals(h.step().facts, []);
  assertEquals(h.players.getCollision().isSlidingDoorOpen(doorId), false);
  assertEquals(h.runtime.hud()!.doorPaid, [{ doorId, paid: 1000 }]);
  assertEquals(h.runtime.hud()!.players[0].points, before - 1000);
  h.runtime.queueInteract("p1", { yaw: Math.PI / 2, pitch: 0 });
  const res = h.step();
  assertEquals(res.facts, [{ op: "doorOpened", doorId, by: "p1" }]);
  assertEquals(h.runtime.hud()!.doorPaid, []);
  assertEquals(h.players.getCollision().isSlidingDoorOpen(doorId), true);
  const hud = h.runtime.hud()!;
  assertEquals(hud.openDoorIds, [doorId]);
  assertEquals(hud.players[0].points, before - 2000);
  // Broke now: the second door is refused and stays shut.
  stand(h, "p1", -14, -18, -Math.PI / 2);
  h.runtime.queueInteract("p1", { yaw: -Math.PI / 2, pitch: 0 });
  assertEquals(h.step().facts, []);
  // The run ends and the slot idles: a fresh collision, every door shut.
  h.runtime.closeEnded();
  assertEquals(h.players.getCollision().isSlidingDoorOpen(doorId), false);
});

Deno.test("zombots: a rack arms from its own side only, then refills", async () => {
  const h = harness(await loadMapFile(ZOMBOTS_01.pathname));
  h.join("p1");
  h.step();
  // Pistol rack on the z = -10 wall at x = 28, facing +z.
  stand(h, "p1", 28, -11, Math.PI);
  h.runtime.queueInteract("p1", { yaw: Math.PI, pitch: 0 });
  assertEquals(h.step().facts, []);
  stand(h, "p1", 28, -9, 0);
  h.runtime.queueInteract("p1", { yaw: 0, pitch: 0 });
  assertEquals(h.step().facts, [{
    op: "armed",
    playerId: "p1",
    weaponId: WEAPON_PISTOL,
    refill: false,
  }]);
  assertEquals(h.players.get("p1")!.isWeaponArmed(WEAPON_PISTOL), true);
  // Spares are full: a second press is refused and facts stay empty.
  h.runtime.queueInteract("p1", { yaw: 0, pitch: 0 });
  assertEquals(h.step().facts, []);
  // Spend a spare mag and fund the purse: now it refills.
  (h.players.get("p1")! as unknown as { loadouts: Record<number, { spareClips: number }> })
    .loadouts[WEAPON_PISTOL]!.spareClips -= 1;
  // The first take cost the whole starting purse; earn the next use's price.
  for (let i = 0; i < 2; i++) {
    (h.runtime as unknown as { run: { ledger: { award(id: string, r: string): void } } })
      .run.ledger.award("p1", "kill");
  }
  h.runtime.queueInteract("p1", { yaw: 0, pitch: 0 });
  assertEquals(h.step().facts[0], {
    op: "armed",
    playerId: "p1",
    weaponId: WEAPON_PISTOL,
    refill: true,
  });
});

Deno.test("zombots: checkpoint run state lists purses, armed sets and zombies", () => {
  const h = harness(OPEN_MAP);
  h.join("p1");
  h.steps(FIRST_WAVE_TICKS);
  const cp = h.runtime.checkpointState()!;
  assertEquals(cp.phase, "wave");
  assertEquals(cp.wave, 1);
  assertEquals(cp.humans, ["p1"]);
  assertEquals(cp.purses, [{ id: "p1", points: ZOMBOTS_TUNING.points.start }]);
  assertEquals(cp.armed, [{ id: "p1", weapons: [] }]);
  assertEquals(cp.zombies, [...h.zombies]);
});

Deno.test("zombots: 10th zombot spawns smaller and twice as fast", () => {
  const spacedMap: DoorsMap = {
    ...OPEN_MAP,
    zombieSpawns: Array.from({ length: 10 }, (_, i) => ({
      id: `zs${i + 1}`,
      p: { x: -16 + i * 3.5, z: 15 },
    })),
  };
  const h = harness(spacedMap);
  // 2 humans → wave 1 spawns 10 zombies.
  h.join("p1");
  h.join("p2");
  const spawnTicks = Math.ceil(
    (ZOMBOTS_TUNING.timing.firstIntermissionMs +
      ZOMBOTS_TUNING.timing.spawnIntervalMs * 10) /
      (1000 / TICK_HZ),
  ) + 5;
  h.steps(spawnTicks);
  assertEquals(h.zombies.size, 10);

  const z1 = h.players.get("bot:zombie-1")!;
  const z9 = h.players.get("bot:zombie-9")!;
  const z10 = h.players.get("bot:zombie-10")!;
  assertEquals(z1.modelScale, 1);
  assertEquals(z1.moveSpeedScale, ZOMBOTS_TUNING.zombie.baseSpeedScale);
  assertEquals(z9.modelScale, 1);
  assertEquals(z9.moveSpeedScale, ZOMBOTS_TUNING.zombie.baseSpeedScale);
  assertEquals(z10.modelScale, ZOMBOTS_TUNING.zombie.miniModelScale);
  assertEquals(
    z10.moveSpeedScale,
    ZOMBOTS_TUNING.zombie.baseSpeedScale * ZOMBOTS_TUNING.zombie.miniSpeedMultiplier,
  );
});

Deno.test("zombots: stuck zombie relocates to another open spawn then auto-kills if still stagnant", () => {
  // 8 spaced spawns (> wave 1's 6 zombies) so no two zombies overlap on spawn.
  const spacedMap: DoorsMap = {
    ...OPEN_MAP,
    zombieSpawns: Array.from({ length: 8 }, (_, i) => ({
      id: `zs${i + 1}`,
      p: { x: -16 + i * 4.5, z: 15 },
    })),
  };
  const h = harness(spacedMap);
  h.join("p1");
  h.steps(FIRST_WAVE_TICKS);
  const zid = [...h.zombies][0]!;
  const z = h.players.get(zid)!;
  const startX = z.x;
  const startZ = z.z;

  // After relocateAfterMs without moving, zombie relocates to another open spawn.
  const relocateTicks = Math.ceil(ZOMBOTS_TUNING.stuck.relocateAfterMs / (1000 / TICK_HZ)) + 2;
  h.steps(relocateTicks);
  assert(h.zombies.has(zid), "zombie should still be alive after first relocate");
  assert(
    Math.hypot(z.x - startX, z.z - startZ) >= ZOMBOTS_TUNING.stuck.progressRadius,
    `expected zombie to relocate away from (${startX}, ${startZ}), still at (${z.x}, ${z.z})`,
  );

  // If it remains stagnant until killAfterMs, it is auto-killed with no points.
  const remainingKillTicks = Math.ceil(
    (ZOMBOTS_TUNING.stuck.killAfterMs - ZOMBOTS_TUNING.stuck.relocateAfterMs) / (1000 / TICK_HZ),
  ) + 5;
  h.steps(remainingKillTicks);
  assertEquals(h.zombies.has(zid), false);
  // No kill points were paid to the human for a timeout auto-kill.
  const p1Points = h.runtime.hud()!.players.find((p) => p.id === "p1")!.points;
  assertEquals(p1Points, ZOMBOTS_TUNING.points.start);
});

Deno.test("zombots: moving zombie is not relocated and hits maxLifetimeMs cap", () => {
  const spacedMap: DoorsMap = {
    ...OPEN_MAP,
    zombieSpawns: Array.from({ length: 8 }, (_, i) => ({
      id: `zs${i + 1}`,
      p: { x: -16 + i * 4.5, z: 15 },
    })),
  };
  const h = harness(spacedMap);
  h.join("p1");
  h.steps(FIRST_WAVE_TICKS);
  const zid = [...h.zombies][0]!;
  const z = h.players.get(zid)!;
  // Move our tracked zombie onto its own clear lane away from all spawns.
  z.x = 0;
  z.z = 0;

  // Walk back and forth > progressRadius every 5s: never triggers stagnation kill.
  const stepChunk = Math.ceil(5_000 / (1000 / TICK_HZ));
  const pastKillChunks = Math.ceil(ZOMBOTS_TUNING.stuck.killAfterMs / 5_000) + 1;
  let dir = 1;
  for (let c = 0; c < pastKillChunks; c++) {
    z.x += dir * (ZOMBOTS_TUNING.stuck.progressRadius + 1);
    dir = -dir;
    h.steps(stepChunk);
  }
  assert(h.zombies.has(zid), "actively moving zombie must not be killed by stagnation");

  // Keep moving past maxLifetimeMs: hard lifetime cap eventually kills it.
  const totalChunks = Math.ceil(ZOMBOTS_TUNING.stuck.maxLifetimeMs / 5_000) + 2;
  for (let c = pastKillChunks; c < totalChunks && h.zombies.has(zid); c++) {
    z.x += dir * (ZOMBOTS_TUNING.stuck.progressRadius + 1);
    dir = -dir;
    h.steps(stepChunk);
  }
  assertEquals(h.zombies.has(zid), false, "zombie must be auto-killed at maxLifetimeMs");
});
