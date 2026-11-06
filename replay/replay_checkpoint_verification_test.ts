/**
 * Epic 18.4 — checkpoint verification.
 *
 * Run from server-community/:
 *   deno test -A --unstable-net --node-modules-dir=manual replay/replay_checkpoint_verification_test.ts
 */

import { assertEquals, assertThrows } from "@std/assert";
import { GameServer } from "../runtime/GameServer.ts";
import { NoopAuthorityAdapter } from "../authority/adapter.ts";
import { TICK_HZ } from "../shared/sim/game.ts";
import type { PlayerInput } from "../protocol/network.ts";
import { drainTickAuthoritativeEvents } from "../players/authoritativeEventSource.ts";
import type { DoorsMap } from "../world/map.ts";
import { MapCollision } from "../world/MapCollision.ts";
import { captureCheckpointState } from "./authoritativeCheckpoint.ts";
import { replayBlobObjectName } from "./ReplayBlobStore.ts";
import { loadReplay } from "./replayLoader.ts";
import { settleRecorder, wireReplayRecorder } from "./replayTestHarness.ts";
import {
  REPLAY_CHECKPOINT_VERIFY_INVALID,
  REPLAY_CHECKPOINT_VERIFY_MISMATCH,
  ReplayCheckpointVerifyError,
  verifyReplayCheckpoints,
} from "./replayCheckpointVerification.ts";
import { serverInternals } from "../runtime/gameServerTestHarness.ts";

const LAST_TICK = 12;

const miniMap: DoorsMap = {
  name: "checkpoint-verify",
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

async function recordMatch(): Promise<{
  bytes: Uint8Array;
  collision: MapCollision;
}> {
  const collision = new MapCollision(miniMap);
  const server = new GameServer({
    name: "replay-checkpoint-verify",
    port: 0,
    host: "127.0.0.1",
    map: miniMap,
    collision,
    autofillBots: 0,
    noBotsOnEmptyServer: true,
    joinMode: "open",
    rankedServerId: "open",
    authorityAdapter: new NoopAuthorityAdapter(),
    botThinkEngine: null,
    matchDurationSeconds: 60,
  });
  const internals = serverInternals(server);
  internals.sessions = { emit: () => {} };
  const players = internals.players;
  const { recorder, blobDir, blobStore } = wireReplayRecorder(
    {
      attachSink: (sink) => server.attachReplaySink(sink),
      detachSink: () => server.detachReplaySink(),
    },
    {
      checkpointIntervalSeconds: 4 / TICK_HZ,
      captureCheckpointState: (tick, runtimeMatchId) =>
        captureCheckpointState(players, tick, runtimeMatchId),
      captureStartState: (tick, runtimeMatchId) =>
        captureCheckpointState(players, tick, runtimeMatchId, undefined, {
          allowPendingEvents: true,
        }),
    },
  );
  try {
    players.add("h1", "Human", "A", undefined, nowMs(0));
    const start = players.beginLiveMatch(1, nowMs(1));
    internals.beginRuntimeMatchIdentity(1);
    internals.emitMatchStart(start, 1);
    await settleRecorder(recorder);

    for (let tick = 2; tick <= LAST_TICK; tick++) {
      players.handleInput("h1", input(tick), nowMs(tick));
      const result = internals.stepSim(tick, nowMs(tick));
      const events = drainTickAuthoritativeEvents(players, tick, result.events);
      internals.deliverReplayIntegrationTick(tick, events);
    }
    internals.onMatchEnded({
      winner: "A",
      scores: players.getScores(),
      players: [],
    }, nowMs(players.tick));
    await settleRecorder(recorder);

    const bytes = blobStore?.get(
      replayBlobObjectName(internals.runtimeMatchId),
    );
    if (!bytes) throw new Error("finalized replay bytes missing");
    return { bytes, collision };
  } finally {
    if (blobDir) {
      try {
        Deno.removeSync(blobDir, { recursive: true });
      } catch {
        // The file was already read into memory.
      }
    }
  }
}

function rewrite(
  bytes: Uint8Array,
  edit: (doc: Record<string, unknown>) => void,
): Uint8Array {
  const doc = JSON.parse(new TextDecoder().decode(bytes)) as Record<
    string,
    unknown
  >;
  edit(doc);
  return new TextEncoder().encode(JSON.stringify(doc));
}

Deno.test("18.4 checkpoints: replay state matches every stored frame", async () => {
  const recorded = await recordMatch();
  const result = verifyReplayCheckpoints(recorded);
  assertEquals(result.resumed >= 2, true);
  assertEquals(result.horizons >= 1, true);
  assertEquals(result.ticks.length, result.resumed);
  for (let i = 1; i < result.ticks.length; i++) {
    assertEquals(result.ticks[i]! > result.ticks[i - 1]!, true);
  }
  const loaded = loadReplay(recorded.bytes);
  assertEquals(
    result.ticks.includes(loaded.container.checkpoints.at(-1)!.tick),
    true,
  );
});

Deno.test("18.4 checkpoints: a stored frame that the replay did not reach is a mismatch", async () => {
  const recorded = await recordMatch();
  const loaded = loadReplay(recorded.bytes);
  const target = loaded.container.checkpoints.at(-1);
  if (!target) throw new Error("recording has no checkpoint");
  const bumped = rewrite(recorded.bytes, (doc) => {
    const frames = doc.checkpoints as Array<{
      tick: number;
      players: Array<{ id: string; yaw: number }>;
    }>;
    const frame = frames.find((row) => row.tick === target.tick);
    const player = frame?.players.find((row) => row.id === "h1");
    if (!player) throw new Error("missing h1 on the last checkpoint");
    player.yaw += 1;
  });
  const error = assertThrows(
    () =>
      verifyReplayCheckpoints({
        bytes: bumped,
        collision: recorded.collision,
      }),
    ReplayCheckpointVerifyError,
  );
  assertEquals(error.code, REPLAY_CHECKPOINT_VERIFY_MISMATCH);
  assertEquals(error.tick, target.tick);
  assertEquals(error.report?.entityId, "h1");
  assertEquals(error.report?.fieldPath, "yaw");
});

Deno.test("18.4 checkpoints: a file with no checkpoints is rejected", async () => {
  const recorded = await recordMatch();
  const emptied = rewrite(recorded.bytes, (doc) => {
    doc.checkpoints = [];
    const index = doc.index as { checkpoints?: unknown };
    if (Array.isArray(index.checkpoints)) index.checkpoints = [];
    const initial = doc.initialState as Record<string, unknown>;
    delete initial.startCheckpoint;
  });
  const error = assertThrows(
    () =>
      verifyReplayCheckpoints({
        bytes: emptied,
        collision: recorded.collision,
      }),
    ReplayCheckpointVerifyError,
  );
  assertEquals(error.code, REPLAY_CHECKPOINT_VERIFY_INVALID);
  assertEquals(error.report, null);
});

Deno.test("18.4 checkpoints: bad options are rejected", () => {
  const error = assertThrows(
    () =>
      verifyReplayCheckpoints({
        bytes: new Uint8Array(),
        collision: new MapCollision(miniMap),
      }),
    ReplayCheckpointVerifyError,
  );
  assertEquals(error.code, REPLAY_CHECKPOINT_VERIFY_INVALID);
  assertEquals(error.tick, null);
});

Deno.test("18.4 exclusion: verification does not record or extend the report", async () => {
  const src = await Deno.readTextFile(
    new URL("./replayCheckpointVerification.ts", import.meta.url),
  );
  const code = src
    .split("\n")
    .filter((line) =>
      !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//")
    )
    .join("\n");
  const banned = [
    /ReplayRecorder|wireReplayRecorder|GameServer|thinkAll|BotManager/,
    /runReplayRoundTrip|runDeterminismHarness/,
    /Date\.now|Math\.random/,
    /createHash|sha256|crypto\.subtle/,
    /Deno\.(read|write|open|stat|mkdir)/,
  ];
  for (const pattern of banned) {
    assertEquals(pattern.test(code), false, `banned pattern: ${pattern}`);
  }
});
