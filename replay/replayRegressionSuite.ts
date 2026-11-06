/**
 * Epic 18.6 — regression suite.
 *
 * One deterministic script per major gameplay system, checked against the
 * stored final checkpoint for that system. The script runs twice through
 * the 18.1 harness, then once more for the golden compare. Equality is the
 * 18.2 digest plus the 9.4 field walk. A difference throws with the 18.5
 * report (tick, entity, component, expected, actual).
 *
 * The live match does not call this module. Fixture bytes are the caller's.
 */
import { TICK_HZ } from "../shared/sim/game.ts";
import type { PlayerInput } from "../protocol/network.ts";
import {
  DOOR_CAPTURE_DWELL_TICKS,
  MELEE_COOLDOWN_TICKS,
  RESPAWN_DELAY_TICKS,
  SPAWN_INVULN_TICKS,
  WEAPON_RIFLE,
  WEAPON_SWITCH_TICKS,
} from "../protocol/network.ts";
import { PlayerManager } from "../players/PlayerManager.ts";
import type { DoorsMap } from "../world/map.ts";
import { MapCollision } from "../world/MapCollision.ts";
import {
  type AuthoritativeCheckpoint,
  captureCheckpointState,
} from "./authoritativeCheckpoint.ts";
import type { CheckpointDivergence } from "./checkpointValidation.ts";
import { hashAuthoritativeCheckpoint } from "./replayStateHash.ts";
import {
  REPLAY_DETERMINISM_INVALID,
  ReplayDeterminismError,
  runDeterminismHarness,
} from "./replayDeterminismHarness.ts";
import {
  detectReplayDivergence,
  formatReplayDivergence,
} from "./replayDivergence.ts";

export const REPLAY_REGRESSION_INVALID = "replay-regression-invalid" as const;
export const REPLAY_REGRESSION_MISMATCH = "replay-regression-mismatch" as const;

export type ReplayRegressionErrorCode =
  | typeof REPLAY_REGRESSION_INVALID
  | typeof REPLAY_REGRESSION_MISMATCH;

export const REPLAY_REGRESSION_FIXTURE_IDS = [
  "movement",
  "gunfire",
  "melee",
  "weapons",
  "abilities",
  "doors",
  "scoring",
  "respawn",
] as const;

export type ReplayRegressionFixtureId =
  typeof REPLAY_REGRESSION_FIXTURE_IDS[number];

export type ReplayRegressionFixture = {
  readonly id: ReplayRegressionFixtureId;
  readonly firstTick: number;
  readonly lastTick: number;
  readonly runtimeMatchId: string;
  readonly create: () => PlayerManager;
  readonly step: (sim: PlayerManager, tick: number) => void;
};

export type ReplayRegressionResult = {
  readonly id: ReplayRegressionFixtureId;
  readonly ticks: number;
  readonly hash: string;
  readonly checkpoint: AuthoritativeCheckpoint;
};

export class ReplayRegressionError extends Error {
  readonly code: ReplayRegressionErrorCode;
  readonly fixtureId: string;
  readonly detail: string | null;
  readonly report: CheckpointDivergence | null;
  readonly expectedHash: string | null;
  readonly actualHash: string | null;

  constructor(
    code: ReplayRegressionErrorCode,
    message: string,
    opts?: {
      fixtureId?: string;
      detail?: string | null;
      report?: CheckpointDivergence | null;
      expectedHash?: string | null;
      actualHash?: string | null;
    },
  ) {
    super(message);
    this.name = "ReplayRegressionError";
    this.code = code;
    this.fixtureId = opts?.fixtureId ?? "";
    this.detail = opts?.detail ?? null;
    this.report = opts?.report ?? null;
    this.expectedHash = opts?.expectedHash ?? null;
    this.actualHash = opts?.actualHash ?? null;
  }
}

const MATCH_SEED = 0x1806;

function nowMs(tick: number): number {
  return (tick * 1000) / TICK_HZ;
}

function arenaMap(name: string, span: number): DoorsMap {
  return {
    name,
    version: 1,
    bounds: { minX: -span, maxX: span, minZ: -span, maxZ: span },
    gridSize: 1,
    walls: [],
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
  };
}

function manager(name: string, span: number): PlayerManager {
  const sim = new PlayerManager(new MapCollision(arenaMap(name, span)), {
    matchSeed: MATCH_SEED,
    matchDurationSeconds: 60,
    enablePrematch: false,
    nowMs: nowMs(0),
  });
  return sim;
}

function finishCreate(sim: PlayerManager): PlayerManager {
  sim.drainAuthoritativeEvents();
  return sim;
}

function settle(sim: PlayerManager, tick: number): void {
  sim.update(tick, nowMs(tick));
  sim.processScores(tick);
  sim.processRespawns(tick);
  sim.drainAuthoritativeEvents();
}

function actor(sim: PlayerManager, id: string) {
  const row = sim.get(id);
  if (!row) {
    throw new Error(`regression fixture missing player ${id}`);
  }
  return row;
}

/** Hold a still pose so a fixture measures its own system. */
function pin(sim: PlayerManager, id: string): void {
  const row = actor(sim, id);
  row.x = 0;
  row.y = 1.6;
  row.z = 0;
  row.yaw = 0;
  row.pitch = 0;
  row.velocityX = 0;
  row.velocityY = 0;
  row.velocityZ = 0;
}

/** yaw 0 looks toward -Z. Stamp a lag-comp window at the current pose. */
function stampPose(
  sim: PlayerManager,
  id: string,
  tick: number,
  pose: { x: number; y: number; z: number; yaw: number; pitch: number },
): void {
  const row = actor(sim, id);
  row.x = pose.x;
  row.y = pose.y;
  row.z = pose.z;
  row.yaw = pose.yaw;
  row.pitch = pose.pitch;
  row.spawnedAtTick = 0;
  const from = Math.max(0, tick - 16);
  for (let t = from; t <= tick; t++) row.recordPose(t);
}

const SHOOTER = { x: 0, y: 1.7, z: 5, yaw: 0, pitch: 0 };
const VICTIM = { x: 0, y: 1.7, z: 0, yaw: 0, pitch: 0 };
const MELEE_GAP = { x: 0, y: 1.7, z: 2.5, yaw: 0, pitch: 0 };

function placeDuel(sim: PlayerManager, tick: number, gap: number): void {
  stampPose(sim, "h1", tick, gap === 2.5 ? MELEE_GAP : SHOOTER);
  stampPose(sim, "h2", tick, VICTIM);
}

function addPair(sim: PlayerManager): void {
  sim.add("h1", "Human", "A", undefined, nowMs(0));
  sim.add("h2", "Rival", "B", undefined, nowMs(0));
  sim.beginLiveMatch(0, nowMs(0));
}

function movementInput(tick: number): PlayerInput {
  return {
    sequence: tick,
    forward: true,
    backward: false,
    left: tick % 5 === 0,
    right: false,
    jump: tick % 11 === 0,
    sprint: true,
    crouch: false,
    meleeLunge: false,
    yaw: 0.4,
    pitch: 0.05,
  };
}

function fixture(
  id: ReplayRegressionFixtureId,
  firstTick: number,
  lastTick: number,
  create: () => PlayerManager,
  step: (sim: PlayerManager, tick: number) => void,
): ReplayRegressionFixture {
  return {
    id,
    firstTick,
    lastTick,
    runtimeMatchId: `regression-${id}`,
    create,
    step,
  };
}

const FIRE_TICK = SPAWN_INVULN_TICKS + 1;
const SWING_TICKS = [0, 1, 2].map((i) => FIRE_TICK + i * MELEE_COOLDOWN_TICKS);
const LAST_SWING = SWING_TICKS[SWING_TICKS.length - 1]!;
const SWITCH_TICK = 2;
const SHOOT_TICK = SWITCH_TICK + WEAPON_SWITCH_TICKS + 1;
const RELOAD_TICK = SHOOT_TICK + 2;

function buildFixtures(): readonly ReplayRegressionFixture[] {
  return [
    fixture("movement", 1, 36, () => {
      const sim = manager("regression-movement", 40);
      sim.add("h1", "Human", "A", undefined, nowMs(0));
      sim.beginLiveMatch(0, nowMs(0));
      return finishCreate(sim);
    }, (sim, tick) => {
      sim.handleInput("h1", movementInput(tick), nowMs(tick));
      settle(sim, tick);
    }),
    fixture("gunfire", FIRE_TICK, FIRE_TICK, () => {
      const sim = manager("regression-gunfire", 40);
      addPair(sim);
      placeDuel(sim, FIRE_TICK, 5);
      return finishCreate(sim);
    }, (sim, tick) => {
      placeDuel(sim, tick, 5);
      sim.handleShoot("h1", tick, {
        yaw: 0,
        pitch: 0,
        clientTick: tick,
        origin: [SHOOTER.x, SHOOTER.y, SHOOTER.z],
      }, { nowMs: nowMs(tick) });
      settle(sim, tick);
    }),
    fixture("melee", FIRE_TICK, FIRE_TICK, () => {
      const sim = manager("regression-melee", 40);
      addPair(sim);
      placeDuel(sim, FIRE_TICK, 2.5);
      return finishCreate(sim);
    }, (sim, tick) => {
      placeDuel(sim, tick, 2.5);
      sim.handleMelee("h1", tick, {
        yaw: 0,
        pitch: 0,
        clientTick: tick,
        origin: [MELEE_GAP.x, MELEE_GAP.y, MELEE_GAP.z],
      });
      settle(sim, tick);
    }),
    fixture("weapons", 1, RELOAD_TICK + 2, () => {
      const sim = manager("regression-weapons", 40);
      sim.add("h1", "Human", "A", undefined, nowMs(0));
      sim.beginLiveMatch(0, nowMs(0));
      return finishCreate(sim);
    }, (sim, tick) => {
      pin(sim, "h1");
      if (tick === SWITCH_TICK) {
        sim.handleWeaponSwitch("h1", WEAPON_RIFLE, tick);
      }
      if (tick === SHOOT_TICK) {
        sim.handleShoot("h1", tick, {
          yaw: 0,
          pitch: 0,
          clientTick: tick,
        }, { nowMs: nowMs(tick) });
      }
      if (tick === RELOAD_TICK) sim.handleReload("h1", tick);
      settle(sim, tick);
      pin(sim, "h1");
    }),
    fixture("abilities", 1, 6, () => {
      const sim = manager("regression-abilities", 40);
      sim.add("h1", "Human", "A", undefined, nowMs(0));
      sim.beginLiveMatch(0, nowMs(0));
      sim.handleSkillLoadout("h1", ["quick", null, null, null]);
      // Charges stay locked until a door capture. This fixture restores
      // them so the script measures the ability, which doors already cover.
      actor(sim, "h1").restoreAbilityCharges();
      return finishCreate(sim);
    }, (sim, tick) => {
      pin(sim, "h1");
      if (tick === 3) sim.handleAbility("h1", "quick", tick);
      settle(sim, tick);
      pin(sim, "h1");
    }),
    fixture("doors", 1, 8, () => {
      const sim = manager("regression-doors", 20);
      sim.add("h1", "Human", "A", undefined, nowMs(0));
      sim.beginLiveMatch(0, nowMs(0));
      return finishCreate(sim);
    }, (sim, tick) => {
      sim.update(tick, nowMs(tick));
      const row = actor(sim, "h1");
      row.x = 0;
      row.y = 1.6;
      row.z = 19.5;
      row.alive = true;
      sim.processScores(tick);
      sim.processRespawns(tick);
      sim.drainAuthoritativeEvents();
    }),
    fixture("scoring", 1, 1 + DOOR_CAPTURE_DWELL_TICKS, () => {
      const sim = manager("regression-scoring", 20);
      sim.add("h1", "Human", "A", undefined, nowMs(0));
      sim.beginLiveMatch(0, nowMs(0));
      return finishCreate(sim);
    }, (sim, tick) => {
      sim.update(tick, nowMs(tick));
      const row = actor(sim, "h1");
      row.x = 0;
      row.y = 1.6;
      row.z = 19.5;
      row.alive = true;
      sim.processScores(tick);
      sim.processRespawns(tick);
      sim.drainAuthoritativeEvents();
    }),
    fixture("respawn", 1, LAST_SWING + RESPAWN_DELAY_TICKS + 2, () => {
      const sim = manager("regression-respawn", 40);
      addPair(sim);
      return finishCreate(sim);
    }, (sim, tick) => {
      const victim = actor(sim, "h2");
      if (victim.alive && tick <= LAST_SWING && SWING_TICKS.includes(tick)) {
        placeDuel(sim, tick, 2.5);
        sim.handleMelee("h1", tick, {
          yaw: 0,
          pitch: 0,
          clientTick: tick,
          origin: [MELEE_GAP.x, MELEE_GAP.y, MELEE_GAP.z],
        });
      }
      settle(sim, tick);
    }),
  ];
}

export function replayRegressionFixtures(): readonly ReplayRegressionFixture[] {
  return buildFixtures();
}

/** Object key order is not state. The 9.4 walk stringifies maps in insertion order. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeys(obj[key]);
    }
    return sorted;
  }
  return value;
}

function failInvalid(
  fixtureId: string,
  message: string,
  detail?: string,
): never {
  throw new ReplayRegressionError(REPLAY_REGRESSION_INVALID, message, {
    fixtureId,
    detail: detail ?? null,
  });
}

/** Final authoritative frame of one fixture script. */
export function playReplayRegressionFixture(
  fixture: ReplayRegressionFixture,
): AuthoritativeCheckpoint {
  const sim = fixture.create();
  for (let tick = fixture.firstTick; tick <= fixture.lastTick; tick++) {
    fixture.step(sim, tick);
  }
  try {
    return captureCheckpointState(
      sim,
      fixture.lastTick,
      fixture.runtimeMatchId,
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    failInvalid(
      fixture.id,
      `regression fixture ${fixture.id} could not capture its final tick`,
      detail,
    );
  }
}

/**
 * Replay one fixture and require the final checkpoint to match `golden`.
 * `golden` is the stored final frame for that system.
 */
export function checkReplayRegressionFixture(
  fixture: ReplayRegressionFixture,
  golden: AuthoritativeCheckpoint,
): ReplayRegressionResult {
  if (
    golden == null || typeof golden !== "object" ||
    golden.tick !== fixture.lastTick ||
    golden.runtimeMatchId !== fixture.runtimeMatchId
  ) {
    failInvalid(
      fixture.id,
      `regression fixture ${fixture.id} golden checkpoint does not match the script`,
      golden == null ? "missing" : `tick ${golden.tick}`,
    );
  }

  try {
    runDeterminismHarness({
      runs: 2,
      firstTick: fixture.firstTick,
      lastTick: fixture.lastTick,
      runtimeMatchId: fixture.runtimeMatchId,
      create: fixture.create,
      step: fixture.step,
    });
  } catch (err) {
    if (err instanceof ReplayDeterminismError) {
      const code = err.code === REPLAY_DETERMINISM_INVALID
        ? REPLAY_REGRESSION_INVALID
        : REPLAY_REGRESSION_MISMATCH;
      const line = err.report ? ` ${formatReplayDivergence(err.report)}` : "";
      throw new ReplayRegressionError(
        code,
        `regression fixture ${fixture.id} is not deterministic.${line}`,
        {
          fixtureId: fixture.id,
          detail: err.detail,
          report: err.report,
        },
      );
    }
    throw err;
  }

  const actual = playReplayRegressionFixture(fixture);
  const expectedSorted = sortKeys(golden) as AuthoritativeCheckpoint;
  const actualSorted = sortKeys(actual) as AuthoritativeCheckpoint;
  const report = detectReplayDivergence(
    expectedSorted,
    actualSorted,
    actual.tick,
    actual.tick,
  );
  const expectedHash = hashAuthoritativeCheckpoint(expectedSorted);
  const actualHash = hashAuthoritativeCheckpoint(actualSorted);
  if (report || expectedHash !== actualHash) {
    const line = report ? ` ${formatReplayDivergence(report)}` : "";
    throw new ReplayRegressionError(
      REPLAY_REGRESSION_MISMATCH,
      `regression fixture ${fixture.id} diverged.${line}`,
      {
        fixtureId: fixture.id,
        report,
        expectedHash,
        actualHash,
      },
    );
  }

  return Object.freeze({
    id: fixture.id,
    ticks: fixture.lastTick - fixture.firstTick + 1,
    hash: actualHash,
    checkpoint: actual,
  });
}
