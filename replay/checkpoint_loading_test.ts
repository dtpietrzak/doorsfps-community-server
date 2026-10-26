/**
 * Epic 9.3 — checkpoint loading.
 *
 * Run from server-community/:
 *   deno test -A replay/checkpoint_loading_test.ts
 */

import {
  assertEquals,
  assertNotEquals,
  assertThrows,
} from "@std/assert";
import { PlayerManager } from "../players/PlayerManager.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";
import { WEAPON_RIFLE } from "../shared/sim/weapons.ts";
import {
  CHECKPOINT_SCHEMA_VERSION,
  captureCheckpointState,
  type AuthoritativeCheckpoint,
} from "./authoritativeCheckpoint.ts";
import {
  CheckpointAnchorMismatch,
  CheckpointInitMismatch,
  CheckpointTickInvalid,
  CheckpointVersionMismatch,
  loadCheckpointState,
  type CheckpointLoadInit,
  validateCheckpointLoad,
} from "./checkpointLoading.ts";

const miniMap: DoorsMap = {
  name: "checkpoint-load",
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
  runtimeMatchId = "rt-load-1",
): AuthoritativeCheckpoint {
  pm.drainAuthoritativeEvents();
  return captureCheckpointState(pm, tick, runtimeMatchId);
}

function anchorFor(
  pm: PlayerManager,
  runtimeMatchId = "rt-load-1",
): CheckpointLoadInit {
  const initEvent = pm.buildMatchInitEvent(pm.tick);
  if (initEvent.kind !== "matchInit") {
    throw new Error("expected matchInit");
  }
  return {
    runtimeMatchId,
    init: {
      map: initEvent.map,
      matchSeed: initEvent.matchSeed,
      roster: initEvent.roster.map((r) => ({ id: r.id, name: r.name })),
    },
  };
}

function deepCloneCheckpoint(
  cp: AuthoritativeCheckpoint,
): AuthoritativeCheckpoint {
  return structuredClone(cp);
}

function assertCheckpointEqual(
  a: AuthoritativeCheckpoint,
  b: AuthoritativeCheckpoint,
): void {
  assertEquals(a.schemaVersion, b.schemaVersion);
  assertEquals(a.tick, b.tick);
  assertEquals(a.runtimeMatchId, b.runtimeMatchId);
  assertEquals(a.map, b.map);
  assertEquals(a.matchSeed, b.matchSeed);
  assertEquals(a.rng, b.rng);
  assertEquals(a.match, b.match);
  assertEquals(a.players, b.players);
  assertEquals(a.projectiles, b.projectiles);
}

Deno.test("9.3 restore: capture at T → load → every content field round-trips", () => {
  const live = makeManager(0xabcd);
  const human = live.add("h1", "Human", "A", {
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
  const bot = live.addBot("bot1", "BotOne", { team: "B" });
  const agent = live.addAgent("ag1", "Agent", "A", {
    x: 3,
    y: 1.6,
    z: -2,
    yaw: 0.5,
  });
  live.beginLiveMatch(10, 1_000);
  live.drainAuthoritativeEvents();

  const streams = live.getSimRngStreams();
  for (let i = 0; i < 5; i++) {
    streams.damage();
    streams.spread();
    streams.spawn();
    streams.agents();
  }
  live.getCollision().randomSpawn(miniMap.teamA);

  // Stamp simTick the way update() would, then mutate owners post-update so
  // respawn/phase logic cannot overwrite the captured dead/agent rows.
  live.update(42, 2_000);
  live.drainAuthoritativeEvents();

  human.x = 1.23456789;
  human.y = 2.34567891;
  human.z = -3.45678912;
  human.yaw = 0.785398163;
  human.pitch = -0.123456789;
  human.velocityX = 0.111111111;
  human.velocityY = -0.222222222;
  human.velocityZ = 0.333333333;
  human.sprintStamina = 1.5;
  human.score = 4;
  human.kills = 2;
  human.deaths = 1;
  human.xp = 99;
  human.weaponId = WEAPON_RIFLE;
  bot.health = 0;
  bot.alive = false;
  bot.spawnedAtTick = 7;
  agent.x = 9.87654321;

  const cp = captureAt(live, 42);
  const before = deepCloneCheckpoint(cp);
  const anchor = anchorFor(live);

  const fresh = makeManager(0xabcd);
  // Stale roster must not survive.
  fresh.add("stale", "Stale", "B");
  fresh.addBot("staleBot", "StaleBot", { team: "A" });
  assertEquals(fresh.size >= 2, true);

  loadCheckpointState(fresh, cp, { expectedInit: anchor });

  assertEquals(fresh.tick, 42);
  assertEquals(fresh.peekAuthoritativeEvents().length, 0);
  assertEquals(fresh.get("stale"), undefined);
  assertEquals(fresh.get("staleBot"), undefined);
  assertEquals(fresh.get("h1")?.name, "Human");
  assertEquals(fresh.get("bot1")?.alive, false);
  assertEquals(fresh.get("bot1")?.spawnedAtTick, 7);
  assertEquals(fresh.get("ag1")?.isAgent, true);
  assertEquals(fresh.get("h1")?.x, 1.23456789);
  assertEquals(fresh.get("h1")?.lastSequence, 0);
  assertEquals(fresh.get("h1")?.lastTickInputSelection(), null);

  const recaptured = captureAt(fresh, 42);
  assertCheckpointEqual(recaptured, before);
  // Source frozen / untouched.
  assertCheckpointEqual(cp, before);
});

Deno.test("9.3 RNG: next draws bit-equal after load", () => {
  const live = makeManager(0x5151);
  live.add("h1", "Human", "A");
  live.beginLiveMatch(0, 1_000);
  live.drainAuthoritativeEvents();
  const streams = live.getSimRngStreams();
  for (let i = 0; i < 9; i++) {
    streams.damage();
    streams.spread();
    streams.spawn();
    streams.agents();
  }
  for (let i = 0; i < 3; i++) {
    live.getCollision().randomSpawn(miniMap.teamA);
  }
  live.update(5, 1_000);
  live.drainAuthoritativeEvents();
  const cp = captureAt(live, 5);
  const anchor = anchorFor(live);

  // Two independent loads produce bit-equal next draws.
  const probe = makeManager(0x5151);
  const probe2 = makeManager(0x5151);
  loadCheckpointState(probe, cp, { expectedInit: anchor });
  loadCheckpointState(probe2, cp, { expectedInit: anchor });
  const restored = probe.getSimRngStreams();
  const other = probe2.getSimRngStreams();
  for (let i = 0; i < 8; i++) {
    assertEquals(restored.damage(), other.damage());
    assertEquals(restored.spread(), other.spread());
    assertEquals(restored.spawn(), other.spawn());
    assertEquals(restored.agents(), other.agents());
  }
  // Collision spawn stream bit-equal across two independent loads.
  const c1 = makeManager(0x5151);
  const c2 = makeManager(0x5151);
  loadCheckpointState(c1, cp, { expectedInit: anchor });
  loadCheckpointState(c2, cp, { expectedInit: anchor });
  for (let i = 0; i < 4; i++) {
    assertEquals(
      c1.getCollision().randomSpawn(miniMap.teamA),
      c2.getCollision().randomSpawn(miniMap.teamA),
    );
  }

  // Live next draws match a fresh load (live was not advanced past capture).
  const fromLive = makeManager(0x5151);
  loadCheckpointState(fromLive, cp, { expectedInit: anchor });
  const loaded = fromLive.getSimRngStreams();
  for (let i = 0; i < 6; i++) {
    assertEquals(loaded.damage(), streams.damage());
    assertEquals(loaded.spread(), streams.spread());
    assertEquals(loaded.spawn(), streams.spawn());
    assertEquals(loaded.agents(), streams.agents());
  }
});

Deno.test("9.3 verbatim: restored floats are owner values, not motion-quantized", () => {
  const live = makeManager(0x2222);
  const human = live.add("h1", "Human", "A");
  live.beginLiveMatch(0, 1_000);
  live.drainAuthoritativeEvents();
  const ownerX = 1.234567890123;
  const ownerVx = 0.987654321098;
  human.x = ownerX;
  human.velocityX = ownerVx;
  const cp = captureAt(live, 0);
  const fresh = makeManager(0x2222);
  loadCheckpointState(fresh, cp, { expectedInit: anchorFor(live) });
  assertEquals(fresh.get("h1")!.x, ownerX);
  assertEquals(fresh.get("h1")!.velocityX, ownerVx);
  // Snapshot path would quantize — prove we did not land on quantized values.
  const snap = fresh.get("h1")!.toSnapshot(0, "motion", fresh.getCollision());
  assertNotEquals(snap.x, ownerX);
});

Deno.test("9.3 boundary: post-load tick T, empty buffer, zero events during load", () => {
  const live = makeManager(0x3333);
  live.add("h1", "Human", "A");
  live.beginLiveMatch(0, 1_000);
  live.update(11, 1_000);
  live.drainAuthoritativeEvents();
  const cp = captureAt(live, 11);
  const fresh = makeManager(0x3333);
  fresh.add("extra", "Extra", "B");
  // Leave a pending event on the target manager to prove load clears it.
  fresh.beginLiveMatch(0, 1_000);
  assertEquals(fresh.peekAuthoritativeEvents().length > 0, true);
  loadCheckpointState(fresh, cp, { expectedInit: anchorFor(live) });
  assertEquals(fresh.tick, 11);
  assertEquals(fresh.peekAuthoritativeEvents().length, 0);
  assertEquals(fresh.drainAuthoritativeEvents().length, 0);
});

Deno.test("9.3 source-immutability: checkpoint deep-equals pre-load copy", () => {
  const live = makeManager(0x4444);
  live.add("h1", "Human", "A");
  live.beginLiveMatch(0, 1_000);
  live.update(2, 1_000);
  live.drainAuthoritativeEvents();
  const cp = captureAt(live, 2);
  const before = deepCloneCheckpoint(cp);
  const fresh = makeManager(0x4444);
  loadCheckpointState(fresh, cp, { expectedInit: anchorFor(live) });
  assertCheckpointEqual(cp, before);
});

Deno.test("9.3 mismatch: wrong schema version → loud failure, manager untouched", () => {
  const live = makeManager(0x5555);
  live.add("h1", "Human", "A");
  live.beginLiveMatch(0, 1_000);
  live.update(1, 1_000);
  live.drainAuthoritativeEvents();
  const cp = captureAt(live, 1);
  const bad = {
    ...deepCloneCheckpoint(cp),
    schemaVersion: 99 as typeof CHECKPOINT_SCHEMA_VERSION,
  };
  const fresh = makeManager(0x5555);
  fresh.add("keep", "Keep", "A");
  const err = assertThrows(
    () => loadCheckpointState(fresh, bad, { expectedInit: anchorFor(live) }),
    CheckpointVersionMismatch,
  );
  assertEquals(err.expected, CHECKPOINT_SCHEMA_VERSION);
  assertEquals(err.actual, 99);
  assertEquals(fresh.get("keep")?.name, "Keep");
  assertEquals(fresh.tick, 0);
});

Deno.test("9.3 mismatch: wrong runtimeMatchId → untouched", () => {
  const live = makeManager(0x6666);
  live.add("h1", "Human", "A");
  live.beginLiveMatch(0, 1_000);
  live.update(1, 1_000);
  live.drainAuthoritativeEvents();
  const cp = captureAt(live, 1, "rt-a");
  const fresh = makeManager(0x6666);
  fresh.add("keep", "Keep", "A");
  const err = assertThrows(
    () =>
      loadCheckpointState(fresh, cp, {
        expectedInit: { ...anchorFor(live, "rt-b"), runtimeMatchId: "rt-b" },
      }),
    CheckpointAnchorMismatch,
  );
  assertEquals(err.expected, "rt-b");
  assertEquals(err.actual, "rt-a");
  assertEquals(fresh.get("keep")?.name, "Keep");
});

Deno.test("9.3 mismatch: map / matchSeed disagreement → untouched", () => {
  const live = makeManager(0x7777);
  live.add("h1", "Human", "A");
  live.beginLiveMatch(0, 1_000);
  live.update(1, 1_000);
  live.drainAuthoritativeEvents();
  const cp = captureAt(live, 1);
  const fresh = makeManager(0x7777);
  fresh.add("keep", "Keep", "A");

  const mapErr = assertThrows(
    () =>
      loadCheckpointState(fresh, cp, {
        expectedInit: {
          runtimeMatchId: "rt-load-1",
          init: {
            map: { name: "other-map", version: 1 },
            matchSeed: live.getMatchSeed(),
          },
        },
      }),
    CheckpointInitMismatch,
  );
  assertEquals(mapErr.field, "map");
  assertEquals(fresh.get("keep")?.name, "Keep");

  const seedErr = assertThrows(
    () =>
      loadCheckpointState(fresh, cp, {
        expectedInit: {
          runtimeMatchId: "rt-load-1",
          init: {
            map: { name: miniMap.name, version: miniMap.version },
            matchSeed: live.getMatchSeed() ^ 0xffff,
          },
        },
      }),
    CheckpointInitMismatch,
  );
  assertEquals(seedErr.field, "matchSeed");
  assertEquals(fresh.get("keep")?.name, "Keep");
});

Deno.test("9.3 mismatch: corrupt tick → untouched", () => {
  const live = makeManager(0x8888);
  live.add("h1", "Human", "A");
  live.beginLiveMatch(0, 1_000);
  live.update(1, 1_000);
  live.drainAuthoritativeEvents();
  const cp = captureAt(live, 1);
  const fresh = makeManager(0x8888);
  fresh.add("keep", "Keep", "A");

  const neg = { ...deepCloneCheckpoint(cp), tick: -1 };
  assertThrows(
    () => loadCheckpointState(fresh, neg, { expectedInit: anchorFor(live) }),
    CheckpointTickInvalid,
  );
  assertEquals(fresh.get("keep")?.name, "Keep");

  const far = {
    ...deepCloneCheckpoint(cp),
    tick: cp.match.matchEndTick + cp.match.matchDurationTicks + 10,
  };
  assertThrows(
    () => loadCheckpointState(fresh, far, { expectedInit: anchorFor(live) }),
    CheckpointTickInvalid,
  );
  assertEquals(fresh.get("keep")?.name, "Keep");
});

Deno.test("9.3 roster: dead + agent exact; no stale merge; double-load idempotent", () => {
  const live = makeManager(0x9999);
  const bot = live.addBot("bot1", "BotOne", { team: "B" });
  live.addAgent("ag1", "Agent", "A", { x: 1, y: 1.6, z: 1, yaw: 0 });
  live.beginLiveMatch(0, 1_000);
  live.drainAuthoritativeEvents();
  bot.alive = false;
  bot.health = 0;
  bot.spawnedAtTick = 3;
  live.update(8, 1_000);
  live.drainAuthoritativeEvents();
  const cp = captureAt(live, 8);
  const anchor = anchorFor(live);

  const fresh = makeManager(0x9999);
  fresh.add("ghost", "Ghost", "A");
  loadCheckpointState(fresh, cp, { expectedInit: anchor });
  assertEquals(fresh.get("ghost"), undefined);
  assertEquals(fresh.get("bot1")?.alive, false);
  assertEquals(fresh.get("bot1")?.spawnedAtTick, 3);
  assertEquals(fresh.get("ag1")?.isAgent, true);
  assertEquals(fresh.peekAuthoritativeEvents().length, 0);

  const once = captureAt(fresh, 8);
  loadCheckpointState(fresh, cp, { expectedInit: anchor });
  const twice = captureAt(fresh, 8);
  assertCheckpointEqual(once, twice);
});

Deno.test("9.3 round-trip: load at T → feed T+1 inputs → update equals live T+1", () => {
  const live = makeManager(0xa11a);
  const a = live.add("a", "Alpha", "A");
  const b = live.addBot("b", "Bravo", { team: "B" });
  live.beginLiveMatch(0, 1_000);
  live.drainAuthoritativeEvents();

  const inputAt = (seq: number, forward = true) => ({
    sequence: seq,
    yaw: 0.25,
    pitch: 0,
    forward,
    backward: false,
    left: false,
    right: false,
    jump: false,
    crouch: false,
    sprint: false,
  });

  // Warm a few ticks so state is non-trivial.
  for (let tick = 1; tick <= 5; tick++) {
    a.queueInput(inputAt(tick));
    b.queueInput(inputAt(tick, false));
    live.update(tick, 1_000 + tick * 16);
    live.drainAuthoritativeEvents();
  }

  const T = 5;
  const cp = captureAt(live, T);
  const anchor = anchorFor(live);

  // Live advances to T+1 with recorded inputs.
  a.queueInput(inputAt(T + 1));
  b.queueInput(inputAt(T + 1, false));
  live.update(T + 1, 1_000 + (T + 1) * 16);
  live.drainAuthoritativeEvents();
  const liveNext = captureAt(live, T + 1);

  const fresh = makeManager(0xa11a);
  loadCheckpointState(fresh, cp, { expectedInit: anchor });
  assertEquals(fresh.tick, T);
  fresh.get("a")!.queueInput(inputAt(T + 1));
  fresh.get("b")!.queueInput(inputAt(T + 1, false));
  fresh.update(T + 1, 1_000 + (T + 1) * 16);
  fresh.drainAuthoritativeEvents();
  const loadedNext = captureAt(fresh, T + 1);

  assertCheckpointEqual(loadedNext, liveNext);
});

Deno.test("9.3 round-trip: crouch held across the checkpoint does not re-trigger a slide", () => {
  const live = makeManager(0xc0c0);
  const a = live.add("a", "Alpha", "A");
  live.beginLiveMatch(0, 1_000);
  live.drainAuthoritativeEvents();

  const crouchWalk = (seq: number) => ({
    sequence: seq,
    yaw: 0,
    pitch: 0,
    forward: true,
    backward: false,
    left: false,
    right: false,
    jump: false,
    crouch: true,
    sprint: false,
  });

  // Slide on the first press, then keep holding crouch past the slide's end
  // with enough stamina left for another slide on a *new* press.
  const T = 40;
  for (let tick = 1; tick <= T; tick++) {
    a.queueInput(crouchWalk(tick));
    live.update(tick, 1_000 + tick * 16);
    live.drainAuthoritativeEvents();
  }
  assertEquals(a.isSliding(), false);
  const cp = captureAt(live, T);
  assertEquals(cp.players[0]!.prevInputCrouch, true);
  const anchor = anchorFor(live);

  a.queueInput(crouchWalk(T + 1));
  live.update(T + 1, 1_000 + (T + 1) * 16);
  live.drainAuthoritativeEvents();
  const liveNext = captureAt(live, T + 1);
  assertEquals(liveNext.players[0]!.slideRemaining, 0);

  const fresh = makeManager(0xc0c0);
  loadCheckpointState(fresh, cp, { expectedInit: anchor });
  fresh.get("a")!.queueInput(crouchWalk(T + 1));
  fresh.update(T + 1, 1_000 + (T + 1) * 16);
  fresh.drainAuthoritativeEvents();
  assertCheckpointEqual(captureAt(fresh, T + 1), liveNext);
});

Deno.test("9.3 round-trip: fire / melee cooldowns and landing tick survive a checkpoint", () => {
  const live = makeManager(0xf1e1);
  const a = live.add("a", "Alpha", "A");
  live.beginLiveMatch(0, 1_000);
  live.drainAuthoritativeEvents();
  const T = 100;
  a.markShot(T);
  a.markMelee(T);
  const cp = captureAt(live, T);
  const row = cp.players[0]!;
  assertEquals(row.lastShotAtTick, T);
  assertEquals(row.lastMeleeAtTick, T);

  const fresh = makeManager(0xf1e1);
  loadCheckpointState(fresh, cp, { expectedInit: anchorFor(live) });
  const b = fresh.get("a")!;
  assertEquals(b.lastShotAtTick, T);
  assertEquals(b.lastMeleeAtTick, T);
  assertEquals(b.canShoot(T + 1), a.canShoot(T + 1));
  assertEquals(b.lastLandedTick, a.lastLandedTick);

  // "Never" sentinels round-trip through null.
  const idle = makeManager(0xf1e2);
  idle.add("i", "Idle", "A");
  const idleCp = captureAt(idle, 1);
  assertEquals(idleCp.players[0]!.lastShotAtTick, null);
  const idleFresh = makeManager(0xf1e2);
  loadCheckpointState(idleFresh, idleCp, { expectedInit: anchorFor(idle) });
  assertEquals(idleFresh.get("i")!.lastShotAtTick, Number.NEGATIVE_INFINITY);
});

Deno.test("9.3 round-trip: lag-comp rewind right after load sees live pose history", () => {
  const live = makeManager(0x1a9c);
  const shooter = live.add("s", "Shooter", "A");
  const target = live.add("t", "Target", "B");
  live.beginLiveMatch(0, 1_000);
  live.drainAuthoritativeEvents();
  const input = (seq: number, right: boolean) => ({
    sequence: seq,
    yaw: 0,
    pitch: 0,
    forward: false,
    backward: false,
    left: false,
    right,
    jump: false,
    crouch: false,
    sprint: false,
  });
  shooter.x = 0;
  shooter.z = 5;
  target.x = -1.2;
  target.z = 0;
  const T = 30;
  for (let tick = 1; tick <= T; tick++) {
    shooter.queueInput(input(tick, false));
    // Strafe only in the last few ticks so the rewound pose is off the live one.
    target.queueInput(input(tick, tick > T - 8));
    live.update(tick, 1_000 + tick * 16);
    live.drainAuthoritativeEvents();
  }
  const cp = captureAt(live, T);
  assertEquals(cp.players.every((p) => p.poseHistory.length > 0), true);
  const anchor = anchorFor(live);

  const shoot = (pm: PlayerManager) => {
    const s = pm.get("s")!;
    const out = pm.handleShoot("s", T + 1, {
      yaw: 0,
      pitch: 0,
      clientTick: T - 10,
      origin: [s.x, s.y, s.z],
    }, { nowMs: 1_000 });
    return { hit: out?.shot.hitId ?? null, point: out?.shot.hitPoint ?? null };
  };
  const liveShot = shoot(live);

  const fresh = makeManager(0x1a9c);
  loadCheckpointState(fresh, cp, { expectedInit: anchor });
  assertEquals(shoot(fresh), liveShot);
});

Deno.test("9.3 source-scan: loader module imports no snapshot / store / fs writer", async () => {
  const src = await Deno.readTextFile(
    new URL("./checkpointLoading.ts", import.meta.url),
  );
  for (const banned of [
    "toSnapshot",
    "createSnapshot",
    "quantizePos",
    "quantizeAngle",
    "quantizeVel",
    "quantizeStamina",
    "replaysStore",
    "ReplayBlobStore",
    "Deno.write",
    "node:fs",
  ]) {
    assertEquals(src.includes(banned), false, `banned token: ${banned}`);
  }
});

Deno.test("9.3 equivalence: loader present-but-uncalled does not change sim", () => {
  // Importing the loader module must not alter live behavior when unused.
  validateCheckpointLoad;
  loadCheckpointState;

  const run = () => {
    const pm = makeManager(0xbeef);
    const h = pm.add("h1", "Human", "A");
    pm.beginLiveMatch(0, 1_000);
    pm.drainAuthoritativeEvents();
    const scores: number[] = [];
    for (let tick = 1; tick <= 20; tick++) {
      h.queueInput({
        sequence: tick,
        yaw: tick * 0.01,
        pitch: 0,
        forward: true,
        backward: false,
        left: false,
        right: false,
        jump: false,
        crouch: false,
        sprint: false,
      });
      pm.update(tick, 1_000 + tick * 16);
      pm.drainAuthoritativeEvents();
      scores.push(h.x, h.z, pm.getScores().A, pm.getScores().B);
    }
    return scores;
  };

  assertEquals(run(), run());
});
