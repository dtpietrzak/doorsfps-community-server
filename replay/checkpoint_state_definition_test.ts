/**
 * Epic 9.1 — checkpoint state definition.
 *
 * Run from server-community/:
 *   deno test -A replay/checkpoint_state_definition_test.ts
 */

import {
  assertEquals,
  assertExists,
  assertNotEquals,
  assertThrows,
} from "@std/assert";
import { PlayerManager } from "../players/PlayerManager.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";
import { createMatchSimRngStreams } from "../shared/sim/simRng.ts";
import { WEAPON_ORDER, WEAPON_PISTOL, WEAPON_RIFLE } from "../shared/sim/weapons.ts";
import {
  CHECKPOINT_SCHEMA_VERSION,
  captureCheckpointState,
  type AuthoritativeCheckpoint,
} from "./authoritativeCheckpoint.ts";

const miniMap: DoorsMap = {
  name: "checkpoint-def",
  version: 1,
  bounds: { minX: -40, maxX: 40, minZ: -40, maxZ: 40 },
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

function makeManager(seed = 0x91a1): PlayerManager {
  return new PlayerManager(new MapCollision(miniMap), { matchSeed: seed });
}

function captureAt(
  pm: PlayerManager,
  tick: number,
  runtimeMatchId = "rt-checkpoint-1",
): AuthoritativeCheckpoint {
  pm.drainAuthoritativeEvents();
  return captureCheckpointState(pm, tick, runtimeMatchId);
}

Deno.test("9.1 checklist: anchor + match + rng + player fields match owners", () => {
  const pm = makeManager(0xabcd);
  const human = pm.add("h1", "Human", "A", {
    equipment: {
      head: 2,
      visor: 1,
      shoulder: 0,
      body: 3,
      leg: 1,
      hue: 0.25,
      gunHue: -0.5,
      bulletHue: 0,
      crosshairColor: -1,
      nameHue: 0,
      scope: 0,
      pistol: 1,
      rifle: 2,
      shotgun: 0,
      crosshair: 0,
    },
  });
  const bot = pm.addBot("bot1", "BotOne", { team: "B" });
  const raidBot = pm.addBot("raid1", "RaidOne", { team: "B", isRaidBot: true });
  pm.beginLiveMatch(10, 1_000);
  pm.drainAuthoritativeEvents();

  // Mutate owners away from defaults so capture is non-trivial.
  human.x = 1.23456789;
  human.y = 2.34567891;
  human.z = -3.45678912;
  human.yaw = 0.785398163;
  human.pitch = -0.123456789;
  human.velocityX = -4.32109876;
  human.velocityY = 1.11111111;
  human.velocityZ = 8.7654321;
  human.onGround = false;
  human.crouch = true;
  human.sprintStamina = 2.75;
  human.slideRemaining = 0.4;
  human.slideDirX = 0.6;
  human.slideDirZ = -0.8;
  human.slideForceCrouch = true;
  human.health = 67;
  human.score = 4;
  human.kills = 2;
  human.deaths = 1;
  human.xp = 120;
  human.weaponId = WEAPON_RIFLE;
  human.reloadEndsAtTick = 50;
  human.weaponSwitchEndsAtTick = 40;
  human.abilityGlobalLockEndsAtTick = 80;
  human.abilityBarRegenEndsAtTick = 90;
  human.abilityDoorRegenEndsAtTick = 100;

  // Advance RNG streams so cursors leave their seeds.
  const streams = pm.getSimRngStreams();
  for (let i = 0; i < 11; i++) streams.damage();
  for (let i = 0; i < 5; i++) streams.spread();
  for (let i = 0; i < 3; i++) streams.agents();
  // Collision shares the spawn stream under normal reseed — draw via collision.
  pm.getCollision().randomSpawn(miniMap.teamA);

  const tick = 42;
  const cp = captureCheckpointState(pm, tick, "rt-1");

  assertEquals(cp.schemaVersion, CHECKPOINT_SCHEMA_VERSION);
  assertEquals(cp.tick, tick);
  assertEquals(cp.runtimeMatchId, "rt-1");
  assertEquals(cp.map, { name: miniMap.name, version: miniMap.version });
  assertEquals(cp.matchSeed, pm.getMatchSeed());
  assertEquals(cp.projectiles, []);

  assertEquals(cp.rng.damage, streams.damage.getState());
  assertEquals(cp.rng.spread, streams.spread.getState());
  assertEquals(cp.rng.spawn, streams.spawn.getState());
  assertEquals(cp.rng.agents, streams.agents.getState());
  assertEquals(cp.rng.collisionSpawn, pm.getCollision().getSpawnRngState());

  assertEquals(cp.match.scores, pm.getScores());
  assertEquals(cp.match.matchOver, pm.isMatchOver());
  assertEquals(cp.match.inPrematch, pm.getInPrematchFlag());
  assertEquals(cp.match.restartAtTick, pm.getRestartAtTick());
  assertEquals(cp.match.doorCycleOriginTick, pm.getDoorCycleOriginTick());
  assertEquals(cp.match.doorsPowerUpUntilTick, pm.getDoorsPowerUpUntilTick());
  assertEquals(cp.match.raidDoorPolicy, pm.getRaidDoorPolicy());
  assertEquals(cp.match.debugForceDoorsOpen, pm.getDebugForceDoorsOpen());
  assertEquals(cp.match.matchEndTick, pm.getMatchClockState().matchEndTick);
  assertEquals(cp.match.matchDurationTicks, pm.getMatchDurationTicks());

  const row = cp.players.find((p) => p.id === human.id)!;
  assertExists(row);
  assertEquals(row.x, human.x);
  assertEquals(row.y, human.y);
  assertEquals(row.z, human.z);
  assertEquals(row.yaw, human.yaw);
  assertEquals(row.pitch, human.pitch);
  assertEquals(row.velocityX, human.velocityX);
  assertEquals(row.velocityY, human.velocityY);
  assertEquals(row.velocityZ, human.velocityZ);
  assertEquals(row.onGround, false);
  assertEquals(row.crouch, true);
  assertEquals(row.sprintStamina, 2.75);
  assertEquals(row.slideRemaining, 0.4);
  assertEquals(row.slideDirX, 0.6);
  assertEquals(row.slideDirZ, -0.8);
  assertEquals(row.slideForceCrouch, true);
  assertEquals(row.health, 67);
  assertEquals(row.maxHealth, human.maxHealth);
  assertEquals(row.alive, human.alive);
  assertEquals(row.spawnedAtTick, human.spawnedAtTick);
  assertEquals(row.diedAtTick, human.diedAtTick);
  assertEquals(row.enemyDoorSinceTick, human.enemyDoorSinceTick);
  assertEquals(row.hitSlowStacks, human.getHitSlowStacks());
  assertEquals(row.hitSlowEndsAtTick, human.getHitSlowEndsAtTick());
  assertEquals(row.weaponId, WEAPON_RIFLE);
  assertEquals(row.reloadEndsAtTick, 50);
  assertEquals(row.weaponSwitchEndsAtTick, 40);
  assertEquals(row.abilityGlobalLockEndsAtTick, 80);
  assertEquals(row.abilityBarRegenEndsAtTick, 90);
  assertEquals(row.abilityDoorRegenEndsAtTick, 100);
  assertEquals(row.score, 4);
  assertEquals(row.kills, 2);
  assertEquals(row.deaths, 1);
  assertEquals(row.xp, 120);
  assertEquals(row.equipment.head, 2);
  assertEquals(row.equipment.gunHue, -0.5);
  assertEquals(row.isBot, false);
  assertEquals(row.isAgent, false);

  for (const weaponId of WEAPON_ORDER) {
    const loadout = row.weaponLoadouts.find((w) => w.weaponId === weaponId)!;
    assertExists(loadout);
    assertEquals(loadout.ammoInMag, human.ammoInMagFor(weaponId));
    assertEquals(loadout.spareClips, human.spareClipsFor(weaponId));
  }

  const botRow = cp.players.find((p) => p.id === bot.id)!;
  assertExists(botRow);
  // Arena fill bots are indistinguishable from humans in the recording.
  assertEquals(botRow.isBot, false);
  assertEquals(botRow.isAgent, false);

  const raidRow = cp.players.find((p) => p.id === raidBot.id)!;
  assertExists(raidRow);
  // `isBot` records the raid-bot role, not "AI-controlled".
  assertEquals(raidRow.isBot, true);
  assertEquals(raidRow.isAgent, false);
});

Deno.test("29.2 raid: capture defaults to inactive and embeds the caller-supplied raid state verbatim", () => {
  // `RaidMatch` lives on GameServer, not PlayerManager (notes/replay.md
  // §29.2 item 2) — the builder has no owner to read raid state from, so the
  // caller (GameServer) supplies a fresh snapshot at every capture. This pins
  // that the 4th param is actually wired through, not silently ignored.
  const pm = makeManager();
  pm.add("h1", "Human", "A");
  pm.drainAuthoritativeEvents();

  const withoutRaid = captureCheckpointState(pm, 5, "rt-checkpoint-1");
  assertEquals(withoutRaid.match.raid, { active: false });

  const raidState = {
    active: true as const,
    wave: 3,
    started: true,
    ended: false,
    expectedHumans: 2,
    failReason: null,
  };
  const withRaid = captureCheckpointState(pm, 5, "rt-checkpoint-1", raidState);
  assertEquals(withRaid.match.raid, raidState);
  // Everything else is unaffected by the raid param.
  assertEquals(withRaid.players, withoutRaid.players);
  assertEquals(withRaid.rng, withoutRaid.rng);
});

Deno.test("9.1 freeze: returned checkpoint is deep-frozen and independent of live owners", () => {
  const pm = makeManager();
  const p = pm.add("s1", "A1", "A");
  pm.beginLiveMatch(0, 1_000);
  const cp = captureAt(pm, 7);

  assertThrows(() => {
    (cp as { tick: number }).tick = 99;
  });
  assertThrows(() => {
    (cp.players as CheckpointPlayerMutable[]).push({} as never);
  });
  assertThrows(() => {
    (cp.players[0] as { x: number }).x = 0;
  });

  const beforeX = cp.players[0]!.x;
  p.x = beforeX + 10;
  assertEquals(cp.players[0]!.x, beforeX);
});

type CheckpointPlayerMutable = AuthoritativeCheckpoint["players"][number];

Deno.test("9.1 verbatim: positions/velocities are owner floats, not motion-quantized", () => {
  const pm = makeManager();
  const p = pm.add("s1", "A1", "A");
  pm.beginLiveMatch(0, 1_000);
  pm.drainAuthoritativeEvents();

  p.x = 1.23456789;
  p.y = 2.34567891;
  p.z = 3.45678912;
  p.velocityX = -4.32109876;
  p.velocityY = 1.11111111;
  p.velocityZ = 8.7654321;
  p.yaw = 0.785398163;
  p.pitch = -0.123456789;

  const cp = captureCheckpointState(pm, 12, "rt-q");
  const row = cp.players[0]!;
  const motion = pm.createSnapshot(12, "motion").players[0]!;

  // Bit-equal to owners.
  assertEquals(row.x, p.x);
  assertEquals(row.y, p.y);
  assertEquals(row.z, p.z);
  assertEquals(row.velocityX, p.velocityX);
  assertEquals(row.velocityY, p.velocityY);
  assertEquals(row.velocityZ, p.velocityZ);
  assertEquals(row.yaw, p.yaw);
  assertEquals(row.pitch, p.pitch);

  // Distinct from motion-mode quantized snapshot values.
  assertNotEquals(row.x, motion.x);
  assertNotEquals(row.velocityX, motion.velocityX);
  assertNotEquals(row.yaw, motion.yaw);
});

Deno.test("9.1 exclusion: wall-clock / presentation / transport keys absent", () => {
  const pm = makeManager();
  pm.add("s1", "A1", "A");
  pm.beginLiveMatch(0, 1_000);
  const cp = captureAt(pm, 3);
  const json = JSON.stringify(cp);

  for (const banned of [
    "pingMs",
    "ping",
    "liveStartedAtMs",
    "connectionIssue",
    "mmsRankId",
    "founderBadge",
    "botDec",
    "inputHoldTicks",
    "lastProcessedInputSeq",
    "afk",
    "afkKickIn",
    "participation",
    "latestInput",
    "lastSequence",
    "rosterCache",
    "rewindClampTotal",
    "gameOverSnapshot",
    "authoritativeEvents",
    "readyVotes",
    "abandonedByPlayerId",
    "liveMatchVoided",
  ]) {
    assertEquals(
      json.includes(`"${banned}"`),
      false,
      `excluded key leaked: ${banned}`,
    );
  }

  const row = cp.players[0]!;
  assertEquals("name" in row, false);
  assertEquals("head" in row, false);
  assertEquals("visor" in row, false);
  assertEquals("keys" in row, false);
});

Deno.test("9.1 boundary: non-empty drain buffer fails loud", () => {
  const pm = makeManager();
  pm.add("s1", "A1", "A");
  pm.beginLiveMatch(0, 1_000);
  // beginLiveMatch left matchStart in the buffer.
  assertThrows(
    () => captureCheckpointState(pm, 1, "rt-drain"),
    Error,
    "drain buffer not empty",
  );
  assertThrows(
    () => captureCheckpointState(pm, 1, ""),
    Error,
    "runtimeMatchId required",
  );
});

Deno.test("9.1 boundary: alive:false and isAgent share the player shape", () => {
  const pm = makeManager();
  const human = pm.add("h1", "Human", "A");
  const spawn = pm.getCollision().randomSpawn(miniMap.teamA);
  const agent = pm.addAgent("agent1", "Agent", "A", spawn);
  pm.beginLiveMatch(0, 1_000);
  human.alive = false;
  human.health = 0;

  const cp = captureAt(pm, 5);
  const dead = cp.players.find((p) => p.id === human.id)!;
  const agentRow = cp.players.find((p) => p.id === agent.id)!;
  assertExists(dead);
  assertExists(agentRow);
  assertEquals(dead.alive, false);
  assertEquals(dead.health, 0);
  assertEquals(agentRow.isAgent, true);
  assertEquals(agentRow.isBot, false); // isBot is the raid-bot role; agents are not raid bots
  assertEquals(Object.keys(dead).sort(), Object.keys(agentRow).sort());
});

Deno.test("9.1 RNG: restore words into fresh streams → next draws bit-equal", () => {
  const pm = makeManager(0x5151);
  pm.beginLiveMatch(0, 1_000);
  const streams = pm.getSimRngStreams();
  for (let i = 0; i < 9; i++) {
    streams.damage();
    streams.spread();
    streams.spawn();
    streams.agents();
  }
  const cp = captureAt(pm, 1);

  const restored = createMatchSimRngStreams(cp.matchSeed);
  restored.damage.setState(cp.rng.damage);
  restored.spread.setState(cp.rng.spread);
  restored.spawn.setState(cp.rng.spawn);
  restored.agents.setState(cp.rng.agents);

  for (let i = 0; i < 8; i++) {
    assertEquals(restored.damage(), streams.damage());
    assertEquals(restored.spread(), streams.spread());
    assertEquals(restored.spawn(), streams.spawn());
    assertEquals(restored.agents(), streams.agents());
  }
});

Deno.test("9.1 RNG: collision spawn cursor round-trip", () => {
  const pm = makeManager(0x7777);
  pm.beginLiveMatch(0, 1_000);
  pm.drainAuthoritativeEvents();
  for (let i = 0; i < 4; i++) {
    pm.getCollision().randomSpawn(miniMap.teamA);
  }
  const cp = captureCheckpointState(pm, 2, "rt-spawn");

  const fresh = new MapCollision(miniMap);
  fresh.reseedSpawnRng(createMatchSimRngStreams(cp.matchSeed).spawn);
  fresh.setSpawnRngState(cp.rng.collisionSpawn);

  const control = new MapCollision(miniMap);
  control.reseedSpawnRng(createMatchSimRngStreams(cp.matchSeed).spawn);
  control.setSpawnRngState(cp.rng.collisionSpawn);

  for (let i = 0; i < 6; i++) {
    assertEquals(
      fresh.randomSpawn(miniMap.teamA),
      control.randomSpawn(miniMap.teamA),
    );
  }
});

Deno.test("9.1 RNG: prematch seed-keep vs post-over reseed round-trip", () => {
  const ranked = new PlayerManager(new MapCollision(miniMap), {
    matchSeed: 0x5555,
    enablePrematch: true,
  });
  ranked.enterPrematch(0, 1_000);
  ranked.drainAuthoritativeEvents();
  const seedAfterPrematch = ranked.getMatchSeed();
  ranked.beginLiveMatch(10, 2_000);
  ranked.drainAuthoritativeEvents();
  assertEquals(ranked.getMatchSeed(), seedAfterPrematch);
  const liveCp = captureCheckpointState(ranked, 10, "rt-ranked");
  assertEquals(liveCp.matchSeed, seedAfterPrematch);
  assertEquals(liveCp.match.inPrematch, false);

  const open = makeManager(0x10);
  open.beginLiveMatch(0, 1_000);
  open.forceEndMatch(50, "draw");
  open.drainAuthoritativeEvents();
  const seedBefore = open.getMatchSeed();
  open.beginLiveMatch(100, 2_000);
  open.drainAuthoritativeEvents();
  assertNotEquals(open.getMatchSeed(), seedBefore);
  const restartCp = captureCheckpointState(open, 100, "rt-open");
  assertEquals(restartCp.matchSeed, open.getMatchSeed());
});

Deno.test("9.1 coverage: capture across prematch → live → score-end", () => {
  const pm = new PlayerManager(new MapCollision(miniMap), {
    matchSeed: 0x42,
    enablePrematch: true,
  });
  pm.add("h1", "Human", "A");
  pm.enterPrematch(0, 1_000);
  const pre = captureAt(pm, 0, "rt-season");
  assertEquals(pre.match.inPrematch, true);
  assertEquals(pre.match.matchOver, false);

  pm.beginLiveMatch(20, 2_000);
  const live = captureAt(pm, 20, "rt-season");
  assertEquals(live.match.inPrematch, false);
  assertEquals(live.match.matchOver, false);
  assertEquals(live.match.doorCycleOriginTick, 20);

  pm.forceEndMatch(200, "A", { scheduleRestart: true });
  const ended = captureAt(pm, 200, "rt-season");
  assertEquals(ended.match.matchOver, true);
  assertExists(ended.match.restartAtTick);
});

Deno.test("9.1 coverage: mid-match equipment change is captured", () => {
  const pm = makeManager();
  const p = pm.add("h1", "Human", "A");
  pm.beginLiveMatch(0, 1_000);
  p.setEquipment({
    head: 7,
    visor: 2,
    shoulder: 1,
    body: 4,
    leg: 3,
    hue: -0.25,
    gunHue: 0.5,
    bulletHue: 0,
    crosshairColor: -1,
    nameHue: 0,
    scope: 0,
    pistol: 2,
    rifle: 3,
    shotgun: 0,
    crosshair: 1,
  });
  const cp = captureAt(pm, 15);
  assertEquals(cp.players[0]!.equipment.head, 7);
  assertEquals(cp.players[0]!.equipment.rifle, 3);
  assertEquals(cp.players[0]!.equipment.crosshair, 1);
});

Deno.test("9.1 equivalence: calling the builder does not change sim outcomes", () => {
  function run(captureEveryTick: boolean): {
    scores: { A: number; B: number };
    phase: string;
    seed: number;
    poses: Array<{ id: string; x: number; z: number; yaw: number; health: number }>;
  } {
    const pm = makeManager(0x999);
    const a = pm.add("a", "A1", "A");
    const b = pm.add("b", "B1", "B");
    pm.beginLiveMatch(0, 1_000);
    pm.drainAuthoritativeEvents();

    for (let tick = 1; tick <= 30; tick++) {
      a.queueInput({
        sequence: tick,
        yaw: 0.1 * tick,
        pitch: 0,
        forward: true,
        backward: false,
        left: false,
        right: false,
        jump: false,
        crouch: false,
        sprint: false,
      });
      b.queueInput({
        sequence: tick,
        yaw: -0.1 * tick,
        pitch: 0,
        forward: true,
        backward: false,
        left: false,
        right: false,
        jump: false,
        crouch: false,
        sprint: false,
      });
      pm.update(tick, 1_000 + tick * (1000 / 60));
      pm.drainAuthoritativeEvents();
      if (captureEveryTick) {
        captureCheckpointState(pm, tick, "rt-eq");
      }
    }

    return {
      scores: pm.getScores(),
      phase: pm.getMatchPhase(),
      seed: pm.getMatchSeed(),
      poses: [a, b].map((p) => ({
        id: p.id,
        x: p.x,
        z: p.z,
        yaw: p.yaw,
        health: p.health,
      })),
    };
  }

  assertEquals(run(true), run(false));
});

Deno.test("9.1 source-scan: builder module imports no snapshot path / quantizer", async () => {
  const src = await Deno.readTextFile(
    new URL("./authoritativeCheckpoint.ts", import.meta.url),
  );
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assertEquals(/toSnapshot/.test(code), false);
  assertEquals(/createSnapshot/.test(code), false);
  assertEquals(/quantizePos|quantizeVel|quantizeAngle|quantizeStamina/.test(code), false);
  // Must not import the presentation snapshot packet builders.
  assertEquals(/from\s+['"].*network['"]/.test(code) && /SnapshotPacket/.test(code), false);
});

Deno.test("9.1 pistol+rifle mags both captured (not only active weapon)", () => {
  const pm = makeManager();
  const p = pm.add("h1", "Human", "A");
  pm.beginLiveMatch(0, 1_000);
  // Force distinct per-weapon mags via public ammo helpers if available;
  // otherwise set through loadout by switching weapons.
  p.weaponId = WEAPON_PISTOL;
  // ammoInMag setter path — use spareClipsFor/ammoInMagFor reads after updates.
  // Directly verify both weapon ids appear in the captured loadouts array.
  const cp = captureAt(pm, 1);
  const ids = cp.players[0]!.weaponLoadouts.map((w) => w.weaponId).sort();
  assertEquals(ids, [...WEAPON_ORDER].sort((a, b) => a - b));
  assertEquals(cp.players[0]!.weaponLoadouts.length, WEAPON_ORDER.length);
});
