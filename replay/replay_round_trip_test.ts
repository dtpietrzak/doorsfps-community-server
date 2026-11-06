/**
 * Epic 18.3 — replay round trip.
 *
 * Run from server-community/:
 *   deno test -A --unstable-net --node-modules-dir=manual replay/replay_round_trip_test.ts
 */

import { assertEquals, assertThrows } from "@std/assert";
import { GameServer } from "../runtime/GameServer.ts";
import { NoopAuthorityAdapter } from "../authority/adapter.ts";
import { TICK_HZ } from "../shared/sim/game.ts";
import type { PlayerInput } from "../protocol/network.ts";
import { drainTickAuthoritativeEvents } from "../players/authoritativeEventSource.ts";
import type { DoorsMap } from "../world/map.ts";
import { MapCollision } from "../world/MapCollision.ts";
import {
  type AuthoritativeCheckpoint,
  captureCheckpointState,
} from "./authoritativeCheckpoint.ts";
import { replayBlobObjectName } from "./ReplayBlobStore.ts";
import { settleRecorder, wireReplayRecorder } from "./replayTestHarness.ts";
import {
  REPLAY_ROUND_TRIP_INVALID,
  REPLAY_ROUND_TRIP_MISMATCH,
  ReplayRoundTripError,
  runReplayRoundTrip,
} from "./replayRoundTrip.ts";
import { serverInternals } from "../runtime/gameServerTestHarness.ts";

type Mutable<T> = {
  -readonly [K in keyof T]: T[K] extends readonly (infer U)[] ? Mutable<U>[]
    : T[K] extends object ? Mutable<T[K]>
    : T[K];
};

const LAST_TICK = 12;

const miniMap: DoorsMap = {
  name: "round-trip",
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

type Recording = {
  bytes: Uint8Array;
  collision: MapCollision;
  live: Map<number, AuthoritativeCheckpoint>;
};

async function recordMatch(): Promise<Recording> {
  const collision = new MapCollision(miniMap);
  const server = new GameServer({
    name: "replay-round-trip",
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
      captureCheckpointState: (tick, runtimeMatchId) =>
        captureCheckpointState(players, tick, runtimeMatchId),
      captureStartState: (tick, runtimeMatchId) =>
        captureCheckpointState(players, tick, runtimeMatchId, undefined, {
          allowPendingEvents: true,
        }),
    },
  );
  const live = new Map<number, AuthoritativeCheckpoint>();
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
      live.set(
        tick,
        captureCheckpointState(players, tick, internals.runtimeMatchId),
      );
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
    return { bytes, collision, live };
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

Deno.test("18.3 round trip: a recorded match replays onto the live captures", async () => {
  const recorded = await recordMatch();
  const result = runReplayRoundTrip({
    bytes: recorded.bytes,
    collision: recorded.collision,
    liveAt: (tick) => recorded.live.get(tick),
    hashIntervalTicks: 4,
  });
  assertEquals(result.firstTick >= 2, true);
  assertEquals(result.lastTick, LAST_TICK);
  assertEquals(result.comparedTicks, result.lastTick - result.firstTick + 1);
  let hashed = 0;
  for (let tick = result.firstTick; tick <= result.lastTick; tick++) {
    if (tick % 4 === 0) hashed++;
  }
  assertEquals(result.hashedTicks, hashed);
  assertEquals(hashed > 0, true);

  const coarse = runReplayRoundTrip({
    bytes: recorded.bytes,
    collision: recorded.collision,
    liveAt: (tick) => recorded.live.get(tick),
  });
  assertEquals(coarse.comparedTicks, result.comparedTicks);
  assertEquals(coarse.hashedTicks, 0);
});

Deno.test("18.3 round trip: a live field that differs is a mismatch", async () => {
  const recorded = await recordMatch();
  const error = assertThrows(
    () =>
      runReplayRoundTrip({
        bytes: recorded.bytes,
        collision: recorded.collision,
        hashIntervalTicks: 4,
        liveAt: (tick) => {
          const captured = recorded.live.get(tick);
          if (!captured || tick !== 6) return captured;
          const copy = structuredClone(captured) as Mutable<
            AuthoritativeCheckpoint
          >;
          const row = copy.players.find((player) => player.id === "h1");
          if (!row) throw new Error("missing h1");
          row.yaw += 1;
          return copy;
        },
      }),
    ReplayRoundTripError,
  );
  assertEquals(error.code, REPLAY_ROUND_TRIP_MISMATCH);
  assertEquals(error.tick, 6);
  assertEquals(error.report?.entityId, "h1");
  assertEquals(error.report?.fieldPath, "yaw");
});

Deno.test("18.3 round trip: a missing live capture is rejected", async () => {
  const recorded = await recordMatch();
  const error = assertThrows(
    () =>
      runReplayRoundTrip({
        bytes: recorded.bytes,
        collision: recorded.collision,
        liveAt: () => undefined,
      }),
    ReplayRoundTripError,
  );
  assertEquals(error.code, REPLAY_ROUND_TRIP_INVALID);
  assertEquals(error.report, null);
});

Deno.test("18.3 round trip: bad options are rejected", () => {
  const error = assertThrows(
    () =>
      runReplayRoundTrip({
        bytes: new Uint8Array(),
        collision: new MapCollision(miniMap),
        liveAt: () => undefined,
      }),
    ReplayRoundTripError,
  );
  assertEquals(error.code, REPLAY_ROUND_TRIP_INVALID);
  assertEquals(error.tick, null);
  assertThrows(
    () =>
      runReplayRoundTrip({
        bytes: new Uint8Array([1]),
        collision: new MapCollision(miniMap),
        liveAt: () => undefined,
        hashIntervalTicks: 0,
      }),
    ReplayRoundTripError,
  );
});

Deno.test("18.3 exclusion: the round trip does not record, seek, or own fixtures", async () => {
  const src = await Deno.readTextFile(
    new URL("./replayRoundTrip.ts", import.meta.url),
  );
  const code = src
    .split("\n")
    .filter((line) =>
      !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//")
    )
    .join("\n");
  const banned = [
    /ReplayRecorder|wireReplayRecorder|GameServer|thinkAll|BotManager/,
    /resetToCheckpoint|encodeReplayContainer/,
    /Date\.now|Math\.random/,
    /createHash|sha256|crypto\.subtle/,
    /Deno\.(read|write|open|stat|mkdir)/,
  ];
  for (const pattern of banned) {
    assertEquals(pattern.test(code), false, `banned pattern: ${pattern}`);
  }
});
