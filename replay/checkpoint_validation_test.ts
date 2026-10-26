/**
 * Epic 9.4 — checkpoint sufficiency harness.
 *
 * Run from server-community/:
 *   deno test -A replay/checkpoint_validation_test.ts
 */

import {
  assertEquals,
  assertNotEquals,
  assertThrows,
} from "@std/assert";
import { TICK_HZ } from "../shared/sim/game.ts";
import { WEAPON_PISTOL, WEAPON_RIFLE } from "../shared/sim/weapons.ts";
import { PlayerManager } from "../players/PlayerManager.ts";
import type { PlayerInput } from "../protocol/network.ts";
import { RESPAWN_DELAY_TICKS } from "../protocol/network.ts";
import type { DoorsMap } from "../world/map.ts";
import { MapCollision } from "../world/MapCollision.ts";
import {
  CHECKPOINT_SCHEMA_VERSION,
  captureCheckpointState,
  type AuthoritativeCheckpoint,
} from "./authoritativeCheckpoint.ts";
import {
  CheckpointAnchorMismatch,
  CheckpointInitMismatch,
  CheckpointVersionMismatch,
  loadCheckpointState,
  type CheckpointLoadInit,
} from "./checkpointLoading.ts";
import {
  compareCheckpoints,
  compareSimulationState,
  DEFAULT_HORIZON_TICKS,
  validateCheckpointAt,
  validateMutatedCheckpointAt,
  type QueuedPlayerInput,
} from "./checkpointValidation.ts";

const miniMap: DoorsMap = {
  name: "checkpoint-validate",
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

const RUNTIME_ID = "rt-validate-1";

function makeManager(seed = 0x91a1): PlayerManager {
  return new PlayerManager(new MapCollision(miniMap), { matchSeed: seed });
}

function anchorFor(
  pm: PlayerManager,
  runtimeMatchId = RUNTIME_ID,
): CheckpointLoadInit {
  const initEvent = pm.buildMatchInitEvent(pm.tick);
  if (initEvent.kind !== "matchInit") throw new Error("expected matchInit");
  return {
    runtimeMatchId,
    init: {
      map: initEvent.map,
      matchSeed: initEvent.matchSeed,
      roster: initEvent.roster.map((r) => ({ id: r.id, name: r.name })),
    },
  };
}

function moveInput(sequence: number, yaw = 0.1): PlayerInput {
  return {
    sequence,
    yaw,
    pitch: 0,
    forward: true,
    backward: false,
    left: false,
    right: false,
    jump: false,
    crouch: false,
    sprint: false,
  };
}

function recordInputs(
  map: Map<number, QueuedPlayerInput[]>,
  tick: number,
  rows: QueuedPlayerInput[],
): void {
  map.set(tick, rows);
}

/** Advance reference to `targetTick`, recording per-tick inputs for the roster. */
function warmToTick(
  pm: PlayerManager,
  targetTick: number,
  playerIds: string[],
  inputsByTick: Map<number, QueuedPlayerInput[]>,
  startTick = 1,
): void {
  for (let tick = startTick; tick <= targetTick; tick++) {
    const rows: QueuedPlayerInput[] = playerIds.map((id, i) => ({
      playerId: id,
      input: moveInput(tick, 0.05 * tick + i * 0.01),
    }));
    recordInputs(inputsByTick, tick, rows);
    for (const row of rows) {
      pm.get(row.playerId)?.queueInput(row.input);
    }
    pm.update(tick, 1_000 + tick * (1000 / TICK_HZ));
    pm.drainAuthoritativeEvents();
  }
}

function fillHorizonInputs(
  inputsByTick: Map<number, QueuedPlayerInput[]>,
  fromTick: number,
  toTick: number,
  playerIds: string[],
): void {
  for (let tick = fromTick; tick <= toTick; tick++) {
    if (inputsByTick.has(tick)) continue;
    recordInputs(
      inputsByTick,
      tick,
      playerIds.map((id, i) => ({
        playerId: id,
        input: moveInput(tick, 0.05 * tick + i * 0.01),
      })),
    );
  }
}

Deno.test("9.4 pass: duel mid-match resumes over default horizon", () => {
  const seed = 0x1111;
  const pm = makeManager(seed);
  pm.add("a", "Alpha", "A");
  pm.addBot("b", "Bravo", { team: "B" });
  pm.beginLiveMatch(0, 1_000);
  pm.drainAuthoritativeEvents();

  const inputs = new Map<number, QueuedPlayerInput[]>();
  const T = 30;
  warmToTick(pm, T, ["a", "b"], inputs);
  fillHorizonInputs(inputs, T + 1, T + DEFAULT_HORIZON_TICKS, ["a", "b"]);

  const result = validateCheckpointAt(pm, {
    checkpointTick: T,
    runtimeMatchId: RUNTIME_ID,
    expectedInit: anchorFor(pm),
    inputsByTick: inputs,
    createManager: () => makeManager(seed),
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.checkpointTick, T);
    assertEquals(result.horizonEndTick, T + DEFAULT_HORIZON_TICKS);
  }
});

Deno.test("9.4 pass: dead player + diedAtTick survives past respawn delay", () => {
  const seed = 0x2222;
  const pm = makeManager(seed);
  const human = pm.add("a", "Alpha", "A");
  pm.addBot("b", "Bravo", { team: "B" });
  pm.beginLiveMatch(0, 1_000);
  pm.drainAuthoritativeEvents();

  const inputs = new Map<number, QueuedPlayerInput[]>();
  const T = 20;
  warmToTick(pm, T, ["a", "b"], inputs);

  // Kill after the capture tick's warm-up update — mutate owners post-drain.
  // Re-warm one more tick so death is committed inside sim, then capture.
  // Simpler: force dead state post-update at T (same as 9.3 roster rows).
  human.alive = false;
  human.health = 0;
  human.diedAtTick = T - 5;
  human.deaths = 1;

  const horizon = RESPAWN_DELAY_TICKS + 30;
  fillHorizonInputs(inputs, T + 1, T + horizon, ["a", "b"]);

  const result = validateCheckpointAt(pm, {
    checkpointTick: T,
    horizonTicks: horizon,
    runtimeMatchId: RUNTIME_ID,
    expectedInit: anchorFor(pm),
    inputsByTick: inputs,
    createManager: () => makeManager(seed),
  });
  assertEquals(result.ok, true, result.ok ? "" : JSON.stringify(result));
});

Deno.test("9.4 pass: T+1-only and multi-tick horizon both certify", () => {
  const seed = 0x3333;
  const pm = makeManager(seed);
  pm.add("a", "Alpha", "A");
  pm.addBot("b", "Bravo", { team: "B" });
  pm.beginLiveMatch(0, 1_000);
  pm.drainAuthoritativeEvents();

  const inputs = new Map<number, QueuedPlayerInput[]>();
  const T = 15;
  warmToTick(pm, T, ["a", "b"], inputs);
  fillHorizonInputs(inputs, T + 1, T + 60, ["a", "b"]);
  const anchor = anchorFor(pm);

  // Snapshot managers: run T+1 on a clone path via two separate validates.
  // First: short horizon on this manager (advances it).
  const short = validateCheckpointAt(pm, {
    checkpointTick: T,
    horizonTicks: 1,
    runtimeMatchId: RUNTIME_ID,
    expectedInit: anchor,
    inputsByTick: inputs,
    createManager: () => makeManager(seed),
  });
  assertEquals(short.ok, true);

  // Fresh pair for longer horizon.
  const pm2 = makeManager(seed);
  pm2.add("a", "Alpha", "A");
  pm2.addBot("b", "Bravo", { team: "B" });
  pm2.beginLiveMatch(0, 1_000);
  pm2.drainAuthoritativeEvents();
  const inputs2 = new Map<number, QueuedPlayerInput[]>();
  warmToTick(pm2, T, ["a", "b"], inputs2);
  fillHorizonInputs(inputs2, T + 1, T + 60, ["a", "b"]);
  const long = validateCheckpointAt(pm2, {
    checkpointTick: T,
    horizonTicks: 60,
    runtimeMatchId: RUNTIME_ID,
    expectedInit: anchorFor(pm2),
    inputsByTick: inputs2,
    createManager: () => makeManager(seed),
  });
  assertEquals(long.ok, true);
});

Deno.test("9.4 pass: bot-heavy + agent + mid-match equipment change", () => {
  const seed = 0x4444;
  const pm = makeManager(seed);
  const human = pm.add("h1", "Human", "A");
  pm.addBot("b1", "Bot1", { team: "B" });
  pm.addBot("b2", "Bot2", { team: "A" });
  pm.addBot("b3", "Bot3", { team: "B" });
  pm.addAgent("ag1", "Agent", "A", { x: 2, y: 1.6, z: -2, yaw: 0.2 });
  pm.beginLiveMatch(0, 1_000);
  pm.drainAuthoritativeEvents();

  const ids = ["h1", "b1", "b2", "b3", "ag1"];
  const inputs = new Map<number, QueuedPlayerInput[]>();
  const T = 25;
  warmToTick(pm, T, ids, inputs);

  human.setEquipment({
    head: 3,
    visor: 2,
    shoulder: 1,
    body: 4,
    leg: 2,
    hue: 0.4,
    gunHue: -0.2,
    bulletHue: 0,
    crosshairColor: -1,
    nameHue: 0,
    scope: 0,
    pistol: 2,
    rifle: 1,
    shotgun: 0,
    crosshair: 1,
  });
  human.weaponId = WEAPON_RIFLE;

  const horizon = 45;
  fillHorizonInputs(inputs, T + 1, T + horizon, ids);
  const result = validateCheckpointAt(pm, {
    checkpointTick: T,
    horizonTicks: horizon,
    runtimeMatchId: RUNTIME_ID,
    expectedInit: anchorFor(pm),
    inputsByTick: inputs,
    createManager: () => makeManager(seed),
  });
  assertEquals(result.ok, true, result.ok ? "" : JSON.stringify(result));
});

Deno.test("9.4 pass: prematch → live edge frame", () => {
  const seed = 0x5555;
  const pm = new PlayerManager(new MapCollision(miniMap), {
    matchSeed: seed,
    enablePrematch: true,
  });
  pm.add("a", "Alpha", "A");
  pm.add("b", "Bravo", "B");
  pm.drainAuthoritativeEvents();

  const inputs = new Map<number, QueuedPlayerInput[]>();
  // Warm a few prematch ticks.
  warmToTick(pm, 5, ["a", "b"], inputs, 1);
  pm.beginLiveMatch(10, 2_000);
  pm.drainAuthoritativeEvents();
  // Stamp live tick 10 via update.
  const rows10: QueuedPlayerInput[] = [
    { playerId: "a", input: moveInput(10) },
    { playerId: "b", input: moveInput(10, -0.1) },
  ];
  recordInputs(inputs, 10, rows10);
  for (const row of rows10) pm.get(row.playerId)?.queueInput(row.input);
  pm.update(10, 2_000);
  pm.drainAuthoritativeEvents();

  const T = 10;
  const horizon = 40;
  fillHorizonInputs(inputs, T + 1, T + horizon, ["a", "b"]);
  const result = validateCheckpointAt(pm, {
    checkpointTick: T,
    horizonTicks: horizon,
    runtimeMatchId: RUNTIME_ID,
    expectedInit: anchorFor(pm),
    inputsByTick: inputs,
    createManager: () =>
      new PlayerManager(new MapCollision(miniMap), {
        matchSeed: seed,
        enablePrematch: true,
      }),
  });
  assertEquals(result.ok, true, result.ok ? "" : JSON.stringify(result));
});

Deno.test("9.4 arrival-path: missing / duplicate / stale sequences match live", () => {
  const seed = 0x6666;
  const pm = makeManager(seed);
  pm.add("a", "Alpha", "A");
  pm.addBot("b", "Bravo", { team: "B" });
  pm.beginLiveMatch(0, 1_000);
  pm.drainAuthoritativeEvents();

  const inputs = new Map<number, QueuedPlayerInput[]>();
  const T = 12;
  warmToTick(pm, T, ["a", "b"], inputs);

  // T+1: fresh; T+2: missing a (repeat_missing); T+3: duplicate seq on a;
  // T+4: stale seq on a (dropped).
  recordInputs(inputs, T + 1, [
    { playerId: "a", input: moveInput(T + 1) },
    { playerId: "b", input: moveInput(T + 1, -0.2) },
  ]);
  recordInputs(inputs, T + 2, [
    // a missing
    { playerId: "b", input: moveInput(T + 2, -0.2) },
  ]);
  recordInputs(inputs, T + 3, [
    { playerId: "a", input: moveInput(T + 1) }, // hold / same seq
    { playerId: "a", input: moveInput(T + 3) }, // last-write-wins
    { playerId: "b", input: moveInput(T + 3, -0.2) },
  ]);
  recordInputs(inputs, T + 4, [
    { playerId: "a", input: moveInput(T + 2) }, // stale < lastSequence
    { playerId: "a", input: moveInput(T + 4) },
    { playerId: "b", input: moveInput(T + 4, -0.2) },
  ]);

  const result = validateCheckpointAt(pm, {
    checkpointTick: T,
    horizonTicks: 4,
    runtimeMatchId: RUNTIME_ID,
    expectedInit: anchorFor(pm),
    inputsByTick: inputs,
    createManager: () => makeManager(seed),
  });
  assertEquals(result.ok, true, result.ok ? "" : JSON.stringify(result));
});

Deno.test("9.4 verbatim: restored floats bit-equal owners, not motion-quantized", () => {
  const seed = 0x7777;
  const pm = makeManager(seed);
  const human = pm.add("a", "Alpha", "A");
  pm.beginLiveMatch(0, 1_000);
  pm.drainAuthoritativeEvents();
  pm.update(1, 1_000);
  pm.drainAuthoritativeEvents();
  human.x = 1.234567890123;
  human.velocityX = 0.987654321098;
  // Capture without another movement step.
  const cp = captureCheckpointState(pm, 1, RUNTIME_ID);
  const fresh = makeManager(seed);
  loadCheckpointState(fresh, cp, { expectedInit: anchorFor(pm) });
  assertEquals(fresh.get("a")!.x, 1.234567890123);
  const snap = fresh.get("a")!.toSnapshot(1, "motion", fresh.getCollision());
  assertNotEquals(snap.x, 1.234567890123);
  assertEquals(
    compareSimulationState(pm, fresh, 1, RUNTIME_ID),
    null,
  );
});

function assertNamedDivergence(
  result: ReturnType<typeof validateMutatedCheckpointAt>,
  fieldPath: string,
  entityId?: string,
): void {
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertEquals(result.kind, "divergence");
  if (result.kind !== "divergence") return;
  assertEquals(result.report.fieldPath.includes(fieldPath), true, JSON.stringify(result.report));
  if (entityId) assertEquals(result.report.entityId, entityId);
}

Deno.test("9.4 calibration: dropped RNG word / spawnedAtTick / mag / door-hold / restart / ability / diedAtTick", () => {
  const seed = 0x8888;

  const setupAt = (T: number) => {
    const pm = makeManager(seed);
    const human = pm.add("a", "Alpha", "A");
    pm.addBot("b", "Bravo", { team: "B" });
    pm.beginLiveMatch(0, 1_000);
    pm.drainAuthoritativeEvents();
    const inputs = new Map<number, QueuedPlayerInput[]>();
    warmToTick(pm, T, ["a", "b"], inputs);
    // Non-default match / ability fields so drops are visible.
    human.abilityGlobalLockEndsAtTick = T + 50;
    human.abilityEndsAtTick = { ...human.abilityEndsAtTick, quick: T + 40 };
    // Force a door-hold + restart markers on the match block via owner writes
    // through a capture-mutate path (calibration mutates the frame).
    fillHorizonInputs(inputs, T + 1, T + 5, ["a", "b"]);
    return { pm, inputs, human };
  };

  const T = 18;
  const baseOpts = (pm: PlayerManager, inputs: Map<number, QueuedPlayerInput[]>) => ({
    checkpointTick: T,
    horizonTicks: 0 as number,
    runtimeMatchId: RUNTIME_ID,
    expectedInit: anchorFor(pm),
    inputsByTick: inputs,
    createManager: () => makeManager(seed),
  });

  {
    const { pm, inputs } = setupAt(T);
    assertNamedDivergence(
      validateMutatedCheckpointAt(
        pm,
        (cp) => ({
          ...cp,
          rng: { ...cp.rng, damage: (cp.rng.damage + 1) >>> 0 },
        }),
        baseOpts(pm, inputs),
      ),
      "damage",
      "rng",
    );
  }

  {
    const { pm, inputs } = setupAt(T);
    assertNamedDivergence(
      validateMutatedCheckpointAt(
        pm,
        (cp) => ({
          ...cp,
          players: cp.players.map((p) =>
            p.id === "a" ? { ...p, spawnedAtTick: p.spawnedAtTick + 9 } : p
          ),
        }),
        baseOpts(pm, inputs),
      ),
      "spawnedAtTick",
      "a",
    );
  }

  {
    const { pm, inputs } = setupAt(T);
    assertNamedDivergence(
      validateMutatedCheckpointAt(
        pm,
        (cp) => ({
          ...cp,
          players: cp.players.map((p) =>
            p.id === "a"
              ? {
                ...p,
                weaponLoadouts: p.weaponLoadouts.map((w) =>
                  w.weaponId === WEAPON_PISTOL
                    ? { ...w, ammoInMag: Math.max(0, w.ammoInMag - 1) }
                    : w
                ),
              }
              : p
          ),
        }),
        baseOpts(pm, inputs),
      ),
      "weaponLoadouts",
      "a",
    );
  }

  {
    const { pm, inputs } = setupAt(T);
    assertNamedDivergence(
      validateMutatedCheckpointAt(
        pm,
        (cp) => ({
          ...cp,
          match: {
            ...cp.match,
            doorsPowerUpUntilTick: (cp.match.doorsPowerUpUntilTick ?? T) + 99,
          },
        }),
        baseOpts(pm, inputs),
      ),
      "doorsPowerUpUntilTick",
      "match",
    );
  }

  {
    const { pm, inputs } = setupAt(T);
    assertNamedDivergence(
      validateMutatedCheckpointAt(
        pm,
        (cp) => ({
          ...cp,
          match: { ...cp.match, restartAtTick: T + 500 },
        }),
        baseOpts(pm, inputs),
      ),
      "restartAtTick",
      "match",
    );
  }

  {
    const { pm, inputs } = setupAt(T);
    assertNamedDivergence(
      validateMutatedCheckpointAt(
        pm,
        (cp) => ({
          ...cp,
          players: cp.players.map((p) =>
            p.id === "a"
              ? { ...p, abilityGlobalLockEndsAtTick: T + 999 }
              : p
          ),
        }),
        baseOpts(pm, inputs),
      ),
      "abilityGlobalLockEndsAtTick",
      "a",
    );
  }

  {
    const { pm, inputs, human } = setupAt(T);
    human.alive = false;
    human.health = 0;
    human.diedAtTick = T - 3;
    // Re-capture path: mutate diedAtTick away from owner.
    assertNamedDivergence(
      validateMutatedCheckpointAt(
        pm,
        (cp) => ({
          ...cp,
          players: cp.players.map((p) =>
            p.id === "a" ? { ...p, diedAtTick: T - 1 } : p
          ),
        }),
        baseOpts(pm, inputs),
      ),
      "diedAtTick",
      "a",
    );
  }
});

Deno.test("9.4 mismatch: wrong version / id / map / seed aborts before stepping", () => {
  const seed = 0x9999;
  const pm = makeManager(seed);
  pm.add("a", "Alpha", "A");
  pm.beginLiveMatch(0, 1_000);
  pm.drainAuthoritativeEvents();
  const inputs = new Map<number, QueuedPlayerInput[]>();
  warmToTick(pm, 5, ["a"], inputs);
  fillHorizonInputs(inputs, 6, 10, ["a"]);
  const tickBefore = pm.tick;

  const badInit = {
    runtimeMatchId: "other-id",
    init: {
      map: { name: miniMap.name, version: miniMap.version },
      matchSeed: seed,
    },
  };
  const mismatch = validateCheckpointAt(pm, {
    checkpointTick: 5,
    horizonTicks: 5,
    runtimeMatchId: RUNTIME_ID,
    expectedInit: badInit,
    inputsByTick: inputs,
    createManager: () => makeManager(seed),
  });
  assertEquals(mismatch.ok, false);
  if (!mismatch.ok) {
    assertEquals(mismatch.kind, "mismatch");
    if (mismatch.kind === "mismatch") {
      assertEquals(mismatch.error instanceof CheckpointAnchorMismatch, true);
    }
  }
  // Reference untouched (still at T; harness aborts before horizon steps).
  assertEquals(pm.tick, tickBefore);

  // Direct typed errors still surface from loader.
  const cp = captureCheckpointState(pm, 5, RUNTIME_ID);
  assertThrows(
    () =>
      loadCheckpointState(makeManager(seed), {
        ...structuredClone(cp),
        schemaVersion: 99 as typeof CHECKPOINT_SCHEMA_VERSION,
      }, { expectedInit: anchorFor(pm) }),
    CheckpointVersionMismatch,
  );
  assertThrows(
    () =>
      loadCheckpointState(makeManager(seed), cp, {
        expectedInit: {
          runtimeMatchId: RUNTIME_ID,
          init: {
            map: { name: "nope", version: 1 },
            matchSeed: seed,
          },
        },
      }),
    CheckpointInitMismatch,
  );
});

Deno.test("9.4 source-scan: harness imports no snapshot / store / fs / bot-AI", async () => {
  const src = await Deno.readTextFile(
    new URL("./checkpointValidation.ts", import.meta.url),
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
    "BotManager",
    "bot-official",
    "@doors/bot-official",
  ]) {
    assertEquals(src.includes(banned), false, `banned token: ${banned}`);
  }
  assertEquals(src.includes("captureCheckpointState"), true);
  assertEquals(src.includes("loadCheckpointState"), true);
});

Deno.test("9.4 equivalence: harness present-but-uncalled does not change sim", () => {
  void compareCheckpoints;
  void validateCheckpointAt;
  void DEFAULT_HORIZON_TICKS;

  const run = () => {
    const pm = makeManager(0xabcd);
    const h = pm.add("h1", "Human", "A");
    pm.beginLiveMatch(0, 1_000);
    pm.drainAuthoritativeEvents();
    const out: number[] = [];
    for (let tick = 1; tick <= 25; tick++) {
      h.queueInput(moveInput(tick, tick * 0.01));
      pm.update(tick, 1_000 + tick * (1000 / TICK_HZ));
      pm.drainAuthoritativeEvents();
      out.push(h.x, h.z, pm.getScores().A);
    }
    return out;
  };
  assertEquals(run(), run());
});

Deno.test("9.4 compareCheckpoints: identical frames → null; field tweak → report", () => {
  const pm = makeManager(0xcccc);
  pm.add("a", "Alpha", "A");
  pm.beginLiveMatch(0, 1_000);
  pm.update(1, 1_000);
  pm.drainAuthoritativeEvents();
  const a = captureCheckpointState(pm, 1, RUNTIME_ID);
  const b = structuredClone(a) as AuthoritativeCheckpoint;
  assertEquals(compareCheckpoints(a, b, 1), null);
  b.match.scores.A = 99;
  const div = compareCheckpoints(a, b, 1);
  assertEquals(div?.fieldPath, "scores.A");
  assertEquals(div?.entityId, "match");
  assertEquals(div?.expected, 0);
  assertEquals(div?.actual, 99);
});

Deno.test("shotgun PR8: pre-shotgun 2-slot loadouts verify against 3-slot re-sim", () => {
  const pm = makeManager(0x9f11);
  pm.add("a", "Alpha", "A");
  pm.beginLiveMatch(0, 1_000);
  pm.update(1, 1_000);
  pm.drainAuthoritativeEvents();
  const full = captureCheckpointState(pm, 1, RUNTIME_ID);
  assertEquals(full.players[0]!.weaponLoadouts.length, 3);
  // A recording from before the shotgun joined WEAPON_ORDER: pistol + rifle
  // slots only. The recorded slots must still verify (no version bump).
  const old: AuthoritativeCheckpoint = {
    ...full,
    players: full.players.map((p) => ({
      ...p,
      weaponLoadouts: p.weaponLoadouts.filter(
        (w) => w.weaponId === WEAPON_PISTOL || w.weaponId === WEAPON_RIFLE,
      ),
    })),
  };
  assertEquals(compareCheckpoints(old, full, 1), null);
  // …but a real divergence in a recorded slot still reports.
  const tweaked: AuthoritativeCheckpoint = {
    ...old,
    players: old.players.map((p) => ({
      ...p,
      weaponLoadouts: p.weaponLoadouts.map((w) =>
        w.weaponId === WEAPON_PISTOL
          ? { ...w, ammoInMag: Math.max(0, w.ammoInMag - 1) }
          : w
      ),
    })),
  };
  const div = compareCheckpoints(tweaked, full, 1);
  assertEquals(div?.fieldPath, `weaponLoadouts[${WEAPON_PISTOL}]`);
  assertEquals(div?.entityId, "a");
});
