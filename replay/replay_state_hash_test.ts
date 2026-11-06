/**
 * Epic 18.2 — state hashing.
 *
 * Run from server-community/:
 *   deno test -A --unstable-net --node-modules-dir=manual replay/replay_state_hash_test.ts
 */

import { assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import { TICK_HZ } from "../shared/sim/game.ts";
import type { PlayerInput, SnapshotProjectile } from "../protocol/network.ts";
import { PlayerManager } from "../players/PlayerManager.ts";
import type { DoorsMap } from "../world/map.ts";
import { MapCollision } from "../world/MapCollision.ts";
import { captureCheckpointState } from "./authoritativeCheckpoint.ts";
import type { AuthoritativeCheckpoint } from "./authoritativeCheckpoint.ts";
import { compareCheckpoints } from "./checkpointValidation.ts";
import { CHECKPOINT_INTERVAL_SECONDS_DEFAULT } from "./checkpointInterval.ts";
import {
  authoritativeCheckpointsMatch,
  hashAuthoritativeCheckpoint,
  isReplayStateHashTick,
  REPLAY_STATE_HASH_ALGORITHM,
  REPLAY_STATE_HASH_INTERVAL_TICKS_DEFAULT,
  REPLAY_STATE_HASH_INVALID,
  ReplayStateHashError,
} from "./replayStateHash.ts";

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
  name: "state-hash",
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
    matchSeed: 0x1802,
    matchDurationSeconds: 60,
    enablePrematch: false,
    nowMs: nowMs(0),
  });
  pm.add("h2", "Second", "B", undefined, nowMs(0));
  pm.add("h1", "Human", "A", undefined, nowMs(0));
  pm.beginLiveMatch(0, nowMs(0));
  pm.drainAuthoritativeEvents();
  return pm;
}

function step(pm: PlayerManager, tick: number): void {
  pm.handleInput("h1", input(tick), nowMs(tick));
  pm.handleInput("h2", input(tick), nowMs(tick));
  pm.update(tick, nowMs(tick));
  pm.processScores(tick);
  pm.processRespawns(tick);
  pm.drainAuthoritativeEvents();
}

function captureAt(tick: number): AuthoritativeCheckpoint {
  const pm = createManager();
  for (let t = 1; t <= tick; t++) step(pm, t);
  return captureCheckpointState(pm, tick, "rt-state-hash");
}

Deno.test("18.2 hash: two fresh captures of one script match", () => {
  const left = captureAt(6);
  const right = captureAt(6);
  const digest = hashAuthoritativeCheckpoint(left);
  assertEquals(digest, hashAuthoritativeCheckpoint(left));
  assertEquals(digest, hashAuthoritativeCheckpoint(right));
  assertEquals(authoritativeCheckpointsMatch(left, right), true);
  assertEquals(digest.startsWith(`${REPLAY_STATE_HASH_ALGORITHM}:`), true);
  assertEquals(digest.length, REPLAY_STATE_HASH_ALGORITHM.length + 1 + 16);
  assertEquals(compareCheckpoints(left, right, left.tick, left.tick), null);
});

Deno.test("18.2 hash: a walked field changes the digest", () => {
  const original = captureAt(6);
  const yaw = clone(original);
  const player = yaw.players.find((row) => row.id === "h1");
  if (!player) throw new Error("missing h1");
  player.yaw += 1;
  assertEquals(
    compareCheckpoints(original, yaw, original.tick, original.tick)?.fieldPath,
    "yaw",
  );
  assertEquals(authoritativeCheckpointsMatch(original, yaw), false);

  const seed = clone(original);
  seed.matchSeed += 1;
  assertEquals(
    compareCheckpoints(original, seed, original.tick, original.tick)
      ?.fieldPath,
    "matchSeed",
  );
  assertNotEquals(
    hashAuthoritativeCheckpoint(original),
    hashAuthoritativeCheckpoint(seed),
  );

  const shotA = clone(original);
  const shotB = clone(original);
  const projectile = (id: string): SnapshotProjectile => ({
    id,
    x: 1,
    y: 2,
    z: 3,
  });
  shotA.projectiles = [projectile("p")];
  shotB.projectiles = [projectile("q")];
  assertEquals(
    compareCheckpoints(shotA, shotB, original.tick, original.tick),
    null,
  );
  assertNotEquals(
    hashAuthoritativeCheckpoint(shotA),
    hashAuthoritativeCheckpoint(shotB),
  );
});

Deno.test("18.2 hash: id order, key order, and chambered true are the same state", () => {
  const original = captureAt(4);
  const reversed = clone(original);
  reversed.players.reverse();
  assertEquals(
    compareCheckpoints(original, reversed, original.tick, original.tick),
    null,
  );
  assertEquals(
    hashAuthoritativeCheckpoint(original),
    hashAuthoritativeCheckpoint(reversed),
  );

  const keyedA = clone(original);
  const keyedB = clone(original);
  const rowA = keyedA.players.find((row) => row.id === "h1");
  const rowB = keyedB.players.find((row) => row.id === "h1");
  if (!rowA || !rowB) throw new Error("missing h1");
  rowA.abilityEndsAtTick = { quick: 3, glitch: 9 };
  rowB.abilityEndsAtTick = { glitch: 9, quick: 3 };
  assertEquals(
    hashAuthoritativeCheckpoint(keyedA),
    hashAuthoritativeCheckpoint(keyedB),
  );

  const slot = original.players[0]?.weaponLoadouts[0];
  if (!slot) throw new Error("missing loadout");
  const { chambered: _ignored, ...bare } = slot;
  const cocked = clone(original);
  const open = clone(original);
  const uncocked = clone(original);
  cocked.players[0]!.weaponLoadouts[0] = { ...bare, chambered: true };
  open.players[0]!.weaponLoadouts[0] = bare;
  uncocked.players[0]!.weaponLoadouts[0] = { ...bare, chambered: false };
  assertEquals(
    hashAuthoritativeCheckpoint(cocked),
    hashAuthoritativeCheckpoint(open),
  );
  assertNotEquals(
    hashAuthoritativeCheckpoint(cocked),
    hashAuthoritativeCheckpoint(uncocked),
  );

  const timed = clone(original);
  const cleared = clone(original);
  timed.players[0]!.shellReloadNextAtTick = 12;
  (cleared.players[0] as { shellReloadNextAtTick?: number | null })
    .shellReloadNextAtTick = null;
  assertNotEquals(
    hashAuthoritativeCheckpoint(original),
    hashAuthoritativeCheckpoint(timed),
  );
  assertEquals(
    hashAuthoritativeCheckpoint(original),
    hashAuthoritativeCheckpoint(cleared),
  );
});

Deno.test("18.2 hash: -0 and 0 are different states", () => {
  const positive = captureAt(2);
  const negative = clone(positive);
  const row = negative.players.find((player) => player.id === "h1");
  if (!row) throw new Error("missing h1");
  row.yaw = -0;
  const zeroed = clone(negative);
  const zeroRow = zeroed.players.find((player) => player.id === "h1");
  if (!zeroRow) throw new Error("missing h1");
  zeroRow.yaw = 0;
  assertEquals(JSON.stringify(-0), "0");
  assertEquals(Object.is(row.yaw, zeroRow.yaw), false);
  assertNotEquals(
    hashAuthoritativeCheckpoint(negative),
    hashAuthoritativeCheckpoint(zeroed),
  );

  const nan = clone(zeroed);
  const nanRow = nan.players.find((player) => player.id === "h1");
  if (!nanRow) throw new Error("missing h1");
  nanRow.yaw = Number.NaN;
  assertNotEquals(
    hashAuthoritativeCheckpoint(nan),
    hashAuthoritativeCheckpoint(zeroed),
  );
  const nanAgain = clone(nan);
  assertEquals(
    hashAuthoritativeCheckpoint(nan),
    hashAuthoritativeCheckpoint(nanAgain),
  );
});

Deno.test("18.2 hash: samples land on the checkpoint cadence", () => {
  assertEquals(
    REPLAY_STATE_HASH_INTERVAL_TICKS_DEFAULT,
    Math.round(CHECKPOINT_INTERVAL_SECONDS_DEFAULT * TICK_HZ),
  );
  assertEquals(REPLAY_STATE_HASH_INTERVAL_TICKS_DEFAULT, 300);
  assertEquals(isReplayStateHashTick(0), true);
  assertEquals(isReplayStateHashTick(300), true);
  assertEquals(isReplayStateHashTick(600), true);
  assertEquals(isReplayStateHashTick(1), false);
  assertEquals(isReplayStateHashTick(299), false);
  assertEquals(isReplayStateHashTick(4, 4), true);
  assertEquals(isReplayStateHashTick(5, 4), false);

  const badTick = assertThrows(
    () => isReplayStateHashTick(-1),
    ReplayStateHashError,
  );
  assertEquals(badTick.code, REPLAY_STATE_HASH_INVALID);
  assertEquals(badTick.detail, "-1");
  assertThrows(() => isReplayStateHashTick(1.5), ReplayStateHashError);
  assertThrows(() => isReplayStateHashTick(0, 0), ReplayStateHashError);
  assertThrows(() => isReplayStateHashTick(0, 1.5), ReplayStateHashError);
});

Deno.test("18.2 exclusion: the digest is not a file checksum or a harness", async () => {
  const src = await Deno.readTextFile(
    new URL("./replayStateHash.ts", import.meta.url),
  );
  const code = src
    .split("\n")
    .filter((line) =>
      !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//")
    )
    .join("\n");
  const banned = [
    /createHash|sha256|crypto\.subtle|node:crypto/,
    /JSON\.stringify/,
    /loadReplay|encodeReplayContainer|ReplayRecorder/,
    /resolveCheckpointInterval|REPLAY_CHECKPOINT_INTERVAL_SECONDS_ENV/,
    /Date\.now|Math\.random/,
    /GameServer|thinkAll|BotManager|runDeterminismHarness/,
    /Deno\.(read|write|open|stat|mkdir)/,
  ];
  for (const pattern of banned) {
    assertEquals(pattern.test(code), false, `banned pattern: ${pattern}`);
  }
});
