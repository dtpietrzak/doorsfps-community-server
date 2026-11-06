/**
 * Epic 18.1 — determinism harness.
 *
 * Run from server-community/:
 *   deno test -A replay/replay_determinism_harness_test.ts
 */

import { assertEquals, assertThrows } from "@std/assert";
import { TICK_HZ } from "../shared/sim/game.ts";
import type { PlayerInput } from "../protocol/network.ts";
import { PlayerManager } from "../players/PlayerManager.ts";
import type { DoorsMap } from "../world/map.ts";
import { MapCollision } from "../world/MapCollision.ts";
import {
  REPLAY_DETERMINISM_INVALID,
  REPLAY_DETERMINISM_MISMATCH,
  ReplayDeterminismError,
  runDeterminismHarness,
} from "./replayDeterminismHarness.ts";

const miniMap: DoorsMap = {
  name: "determinism-harness",
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

function nowMs(tick: number): number {
  return (tick * 1000) / TICK_HZ;
}

function input(tick: number): PlayerInput {
  return {
    sequence: tick,
    forward: tick % 2 === 0,
    backward: false,
    left: tick % 3 === 0,
    right: false,
    jump: tick % 5 === 0,
    sprint: false,
    crouch: false,
    meleeLunge: false,
    yaw: 0.02 * tick,
    pitch: -0.01,
  };
}

function createManager(): PlayerManager {
  const pm = new PlayerManager(new MapCollision(miniMap), {
    matchSeed: 0x1801,
    matchDurationSeconds: 60,
    enablePrematch: false,
    nowMs: nowMs(0),
  });
  pm.add("h1", "Human", "A", undefined, nowMs(0));
  pm.beginLiveMatch(0, nowMs(0));
  pm.drainAuthoritativeEvents();
  return pm;
}

function step(pm: PlayerManager, tick: number): void {
  pm.handleInput("h1", input(tick), nowMs(tick));
  pm.update(tick, nowMs(tick));
  pm.processScores(tick);
  pm.processRespawns(tick);
  pm.drainAuthoritativeEvents();
}

Deno.test("18.1 harness: repeated runs of one script match at every tick", () => {
  let created = 0;
  const result = runDeterminismHarness({
    runs: 3,
    firstTick: 1,
    lastTick: 12,
    runtimeMatchId: "rt-determinism",
    create() {
      created += 1;
      return createManager();
    },
    step,
  });
  assertEquals(created, 3);
  assertEquals(result, { runs: 3, firstTick: 1, lastTick: 12 });
});

Deno.test("18.1 harness: the default is two runs", () => {
  const result = runDeterminismHarness({
    firstTick: 1,
    lastTick: 1,
    runtimeMatchId: "rt-determinism",
    create: createManager,
    step,
  });
  assertEquals(result.runs, 2);
});

Deno.test("18.1 harness: a diverging run names the tick and the field", () => {
  const created: PlayerManager[] = [];
  const error = assertThrows(
    () =>
      runDeterminismHarness({
        runs: 2,
        firstTick: 1,
        lastTick: 8,
        runtimeMatchId: "rt-determinism",
        create() {
          const pm = createManager();
          created.push(pm);
          return pm;
        },
        step(pm, tick) {
          step(pm, tick);
          if (pm === created[1] && tick === 4) {
            const human = pm.get("h1");
            if (!human) throw new Error("missing human");
            human.yaw += 1;
          }
        },
      }),
    ReplayDeterminismError,
  );
  assertEquals(error.code, REPLAY_DETERMINISM_MISMATCH);
  assertEquals(error.run, 1);
  assertEquals(error.report?.tick, 4);
  assertEquals(error.report?.entityId, "h1");
  assertEquals(error.report?.fieldPath, "yaw");
});

Deno.test("18.1 harness: a tick that still has events is not a match", () => {
  const error = assertThrows(
    () =>
      runDeterminismHarness({
        firstTick: 1,
        lastTick: 1,
        runtimeMatchId: "rt-determinism",
        create: createManager,
        step(pm, tick) {
          pm.add("late", "Late", "B", undefined, nowMs(tick));
        },
      }),
    ReplayDeterminismError,
  );
  assertEquals(error.code, REPLAY_DETERMINISM_INVALID);
  assertEquals(error.run, 0);
  assertEquals(error.report, null);
});

Deno.test("18.1 harness: fewer than two runs is rejected", () => {
  const error = assertThrows(
    () =>
      runDeterminismHarness({
        runs: 1,
        firstTick: 1,
        lastTick: 1,
        runtimeMatchId: "rt-determinism",
        create: createManager,
        step,
      }),
    ReplayDeterminismError,
  );
  assertEquals(error.code, REPLAY_DETERMINISM_INVALID);
  assertEquals(error.report, null);
  assertThrows(() =>
    runDeterminismHarness({
      firstTick: 4,
      lastTick: 3,
      runtimeMatchId: "rt-determinism",
      create: createManager,
      step,
    })
  );
});

Deno.test("18.1 exclusion: harness does not hash, record, or read the clock", async () => {
  const src = await Deno.readTextFile(
    new URL("./replayDeterminismHarness.ts", import.meta.url),
  );
  const code = src
    .split("\n")
    .filter((line) =>
      !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//")
    )
    .join("\n");
  const banned = [
    /createHash|sha256|crypto\.subtle/,
    /loadReplay|encodeReplayContainer|ReplayRecorder/,
    /Date\.now|Math\.random/,
    /GameServer|thinkAll|BotManager/,
    /Deno\.(read|write|open|stat|mkdir)/,
  ];
  for (const pattern of banned) {
    assertEquals(pattern.test(code), false, `banned pattern: ${pattern}`);
  }
});
