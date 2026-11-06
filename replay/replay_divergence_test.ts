/**
 * Epic 18.5 — divergence detection.
 *
 * Run from server-community/:
 *   deno test -A --unstable-net --node-modules-dir=manual replay/replay_divergence_test.ts
 */

import { assertEquals } from "@std/assert";
import { TICK_HZ } from "../shared/sim/game.ts";
import type { PlayerInput } from "../protocol/network.ts";
import { PlayerManager } from "../players/PlayerManager.ts";
import type { DoorsMap } from "../world/map.ts";
import { MapCollision } from "../world/MapCollision.ts";
import { captureCheckpointState } from "./authoritativeCheckpoint.ts";
import type { AuthoritativeCheckpoint } from "./authoritativeCheckpoint.ts";
import {
  detectReplayDivergence,
  formatReplayDivergence,
  replayDivergenceFacts,
} from "./replayDivergence.ts";

type Mutable<T> = {
  -readonly [K in keyof T]: T[K] extends readonly (infer U)[] ? Mutable<U>[]
    : T[K] extends object ? Mutable<T[K]>
    : T[K];
};

function clone(
  checkpoint: AuthoritativeCheckpoint,
): Mutable<AuthoritativeCheckpoint> {
  return structuredClone(checkpoint) as Mutable<AuthoritativeCheckpoint>;
}

const miniMap: DoorsMap = {
  name: "divergence",
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

function captureAt(tick: number): AuthoritativeCheckpoint {
  const pm = new PlayerManager(new MapCollision(miniMap), {
    matchSeed: 0x1805,
    matchDurationSeconds: 60,
    enablePrematch: false,
    nowMs: nowMs(0),
  });
  pm.add("h1", "Human", "A", undefined, nowMs(0));
  pm.beginLiveMatch(0, nowMs(0));
  pm.drainAuthoritativeEvents();
  for (let t = 1; t <= tick; t++) {
    pm.handleInput("h1", input(t), nowMs(t));
    pm.update(t, nowMs(t));
    pm.processScores(t);
    pm.processRespawns(t);
    pm.drainAuthoritativeEvents();
  }
  return captureCheckpointState(pm, tick, "rt-divergence");
}

Deno.test("18.5 divergence: identical captures report nothing", () => {
  const expected = captureAt(4);
  const actual = clone(expected);
  assertEquals(
    detectReplayDivergence(expected, actual, expected.tick),
    null,
  );
});

Deno.test("18.5 divergence: a yaw change names tick, entity, and component", () => {
  const expected = captureAt(4);
  const actual = clone(expected);
  const player = actual.players.find((row) => row.id === "h1");
  if (!player) throw new Error("missing h1");
  const before = player.yaw;
  player.yaw += 1;

  const report = detectReplayDivergence(expected, actual, expected.tick);
  if (!report) throw new Error("expected a divergence");
  assertEquals(report.entityId, "h1");
  assertEquals(report.fieldPath, "yaw");
  assertEquals(report.tick, expected.tick);
  assertEquals(report.checkpointTick, expected.tick);
  assertEquals(report.horizonOffset, 0);
  assertEquals(report.expected, before);
  assertEquals(report.actual, before + 1);
  assertEquals(Object.keys(report).sort(), [
    "actual",
    "checkpointTick",
    "entityId",
    "expected",
    "fieldPath",
    "horizonOffset",
    "tick",
  ]);

  const facts = replayDivergenceFacts(report);
  assertEquals(Object.isFrozen(facts), true);
  assertEquals(Object.keys(facts).sort(), [
    "actual",
    "component",
    "entity",
    "expected",
    "tick",
  ]);
  assertEquals(facts.tick, report.tick);
  assertEquals(facts.entity, "h1");
  assertEquals(facts.component, "yaw");
  assertEquals(facts.expected, before);
  assertEquals(facts.actual, before + 1);
  assertEquals(
    formatReplayDivergence(report),
    `tick ${report.tick} entity "h1" component "yaw" expected ${
      JSON.stringify(before)
    } actual ${JSON.stringify(before + 1)}`,
  );

  const later = detectReplayDivergence(
    expected,
    actual,
    expected.tick + 3,
    expected.tick,
  );
  if (!later) throw new Error("expected a divergence");
  assertEquals(later.tick, expected.tick + 3);
  assertEquals(later.checkpointTick, expected.tick);
  assertEquals(later.horizonOffset, 3);
  assertEquals(replayDivergenceFacts(later).tick, expected.tick + 3);
});

Deno.test("18.5 divergence: match seed is the checkpoint entity", () => {
  const expected = captureAt(4);
  const actual = clone(expected);
  actual.matchSeed += 1;
  const report = detectReplayDivergence(expected, actual, expected.tick);
  if (!report) throw new Error("expected a divergence");
  const facts = replayDivergenceFacts(report);
  assertEquals(facts.entity, "checkpoint");
  assertEquals(facts.component, "matchSeed");
  assertEquals(facts.expected, expected.matchSeed);
  assertEquals(facts.actual, expected.matchSeed + 1);
});

Deno.test("18.5 divergence: negative zero stays visible in the report", () => {
  const expected = captureAt(4);
  const actual = clone(expected);
  const right = actual.players.find((row) => row.id === "h1");
  if (!right) throw new Error("missing h1");
  const signed = clone(expected);
  const poked = signed.players.find((row) => row.id === "h1");
  if (!poked) throw new Error("missing h1");
  poked.yaw = -0;
  right.yaw = 0;

  const report = detectReplayDivergence(signed, actual, expected.tick);
  if (!report) throw new Error("expected a divergence");
  const facts = replayDivergenceFacts(report);
  assertEquals(facts.entity, "h1");
  assertEquals(facts.component, "yaw");
  assertEquals(Object.is(facts.expected, -0), true);
  assertEquals(Object.is(facts.actual, 0), true);
  assertEquals(
    formatReplayDivergence(report),
    `tick ${expected.tick} entity "h1" component "yaw" expected -0 actual 0`,
  );
});

Deno.test("18.5 divergence: strings and objects render as JSON", () => {
  const expected = captureAt(4);
  const renamed = clone(expected);
  renamed.runtimeMatchId = "other";
  const idReport = detectReplayDivergence(expected, renamed, expected.tick);
  if (!idReport) throw new Error("expected a divergence");
  assertEquals(
    formatReplayDivergence(idReport),
    `tick ${expected.tick} entity "checkpoint" component "runtimeMatchId" expected "rt-divergence" actual "other"`,
  );

  const mapped = clone(expected);
  mapped.map.name = "other-map";
  const mapReport = detectReplayDivergence(expected, mapped, expected.tick);
  if (!mapReport) throw new Error("expected a divergence");
  assertEquals(replayDivergenceFacts(mapReport).component, "map");
  assertEquals(
    formatReplayDivergence(mapReport),
    `tick ${expected.tick} entity "checkpoint" component "map" expected ${
      JSON.stringify(expected.map)
    } actual ${JSON.stringify(mapped.map)}`,
  );
});

Deno.test("18.5 exclusion: detection does not record, hash, or sort keys", async () => {
  const src = await Deno.readTextFile(
    new URL("./replayDivergence.ts", import.meta.url),
  );
  const code = src
    .split("\n")
    .filter((line) =>
      !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//")
    )
    .join("\n");
  const banned = [
    /ReplayRecorder|GameServer|loadReplay|encodeReplayContainer|createReplayRunner/,
    /thinkAll|BotManager/,
    /Date\.now|Math\.random/,
    /createHash|sha256|crypto\.subtle/,
    /Deno\.(read|write)/,
    /extends CheckpointDivergence/,
    /sortKeys|\.sort\(/,
  ];
  for (const pattern of banned) {
    assertEquals(pattern.test(code), false, `banned pattern: ${pattern}`);
  }
  assertEquals(code.includes("compareCheckpoints"), true);
});
