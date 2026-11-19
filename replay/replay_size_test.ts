/**
 * Epic 19.3 — replay size.
 *
 * Run from server-community/:
 *   deno test -A --unstable-net --node-modules-dir=manual replay/replay_size_test.ts
 */

import {
  assertEquals,
  assertExists,
  assertMatch,
  assertThrows,
} from "@std/assert";
import { TICK_HZ } from "../shared/sim/game.ts";
import { GameServer } from "../runtime/GameServer.ts";
import { NoopAuthorityAdapter } from "../authority/adapter.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";
import { driveTick, serverInternals } from "../runtime/gameServerTestHarness.ts";
import {
  InMemoryReplayLifecycleClient,
  ReplayRecorder,
} from "./ReplayRecorder.ts";
import {
  LocalReplayBlobStore,
  replayBlobObjectName,
} from "./ReplayBlobStore.ts";
import type { ReplayContainer } from "./replayContainer.ts";
import { parseProvisionalReplayFile } from "./serializeReplaySession.ts";
import type { ReplayBufferedSessionView } from "./replaySessionBuffer.ts";
import {
  settleRecorder,
  wireReplayRecorder,
  type WireRecorderOptions,
} from "./replayTestHarness.ts";
import {
  REPLAY_SIZE_INVALID,
  ReplaySizeError,
  ReplaySizeMeter,
  sampleReplayContainerSize,
  sampleReplaySessionSize,
  summarizeReplaySize,
  type ReplaySizeSample,
} from "./replaySize.ts";

const miniMap: DoorsMap = {
  name: "replay-size",
  version: 1,
  bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 },
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

type RosterFlag = {
  isBot?: boolean;
  isAgent?: boolean;
  isBalanceBot?: boolean;
};

function session(parts: {
  tickRate?: number;
  captureTick?: number;
  roster?: readonly RosterFlag[];
  inputs?: readonly number[];
  events?: readonly { tick: number; count: number }[];
  checkpoints?: readonly number[];
  startCheckpointTick?: number;
  init?: null;
}): ReplayBufferedSessionView {
  const roster = (parts.roster ?? []).map((player) => ({
    isBot: player.isBot === true,
    isAgent: player.isAgent === true,
    isBalanceBot: player.isBalanceBot === true,
  }));
  const captureTick = parts.captureTick ?? 0;
  return {
    runtimeMatchId: "size-match",
    startTick: captureTick,
    init: parts.init === null ? null : {
      captureTick,
      metadata: {
        tickRate: parts.tickRate ?? 60,
        matchDurationTicks: 99_999,
        roster,
      },
      ...(parts.startCheckpointTick != null
        ? { startCheckpoint: { tick: parts.startCheckpointTick, players: [] } }
        : {}),
    },
    inputs: (parts.inputs ?? []).map((tick) => ({ tick })),
    events: (parts.events ?? []).map((row) => ({
      tick: row.tick,
      events: Array.from({ length: row.count }, () => ({})),
    })),
    checkpoints: (parts.checkpoints ?? []).map((tick) => ({ tick, players: [] })),
    usageTicks: 0,
    usageBytesEstimate: 0,
    status: "finalizing",
    finalizable: true,
  } as unknown as ReplayBufferedSessionView;
}

function sample(over: Partial<ReplaySizeSample> = {}): ReplaySizeSample {
  return {
    fileBytes: 3000,
    firstTick: 12,
    lastTick: 14,
    tickRate: 60,
    playerCount: 4,
    botCount: 3,
    eventCount: 3,
    inputRows: 2,
    checkpointCount: 1,
    ...over,
  };
}

function canonicalSession(): ReplayBufferedSessionView {
  return session({
    tickRate: 60,
    captureTick: 1,
    startCheckpointTick: 1,
    roster: [
      {},
      { isBot: true },
      { isAgent: true },
      { isBalanceBot: true },
    ],
    inputs: [12, 13],
    events: [
      { tick: 13, count: 2 },
      { tick: 14, count: 1 },
    ],
    checkpoints: [12],
  });
}

Deno.test("19.3 size rates use the recorded span, roster flags, and event records", () => {
  const view = canonicalSession();
  const taken = sampleReplaySessionSize(view, 3000);
  assertEquals(taken, {
    fileBytes: 3000,
    firstTick: 12,
    lastTick: 14,
    tickRate: 60,
    playerCount: 4,
    botCount: 3,
    eventCount: 3,
    inputRows: 2,
    checkpointCount: 1,
  });
  const level = summarizeReplaySize(taken);
  assertEquals(level, {
    fileBytes: 3000,
    durationTicks: 3,
    durationMs: 50,
    tickRate: 60,
    playerCount: 4,
    botCount: 3,
    humanCount: 1,
    eventCount: 3,
    inputRows: 2,
    checkpointCount: 1,
    bytesPerTick: 1000,
    bytesPerSecond: 60_000,
    bytesPerPlayer: 750,
    bytesPerBot: 1000,
    eventsPerTick: 1,
    eventsPerSecond: 60,
  });
});

Deno.test("19.3 one player with every bot flag counts once", () => {
  const taken = sampleReplaySessionSize(session({
    roster: [
      { isBot: true, isAgent: true, isBalanceBot: true },
      {},
    ],
    inputs: [4],
  }), 100);
  assertEquals(taken.playerCount, 2);
  assertEquals(taken.botCount, 1);
  const level = summarizeReplaySize(taken);
  assertEquals(level.humanCount, 1);
  assertEquals(level.bytesPerBot, 100);
  assertEquals(level.bytesPerPlayer, 50);
});

Deno.test("19.3 an empty roster and no bot flags rate at zero", () => {
  const level = summarizeReplaySize(sampleReplaySessionSize(session({
    roster: [],
    inputs: [1],
  }), 80));
  assertEquals(level.playerCount, 0);
  assertEquals(level.botCount, 0);
  assertEquals(level.humanCount, 0);
  assertEquals(level.bytesPerPlayer, 0);
  assertEquals(level.bytesPerBot, 0);
});

Deno.test("19.3 an earlier event or the opening checkpoint does not pull the span backward", () => {
  const earlier = sampleReplaySessionSize(session({
    captureTick: 1,
    startCheckpointTick: 1,
    inputs: [12],
    events: [{ tick: 5, count: 1 }],
    checkpoints: [3],
  }), 10);
  assertEquals(earlier.firstTick, 12);
  assertEquals(earlier.lastTick, 12);
  assertEquals(earlier.eventCount, 1);
  assertEquals(earlier.checkpointCount, 1);
  assertEquals(summarizeReplaySize(earlier).durationTicks, 1);

  const emptyInputs = sampleReplaySessionSize(session({
    captureTick: 8,
    events: [{ tick: 10, count: 1 }],
    checkpoints: [9],
  }), 10);
  assertEquals(emptyInputs.firstTick, 8);
  assertEquals(emptyInputs.lastTick, 10);
  assertEquals(summarizeReplaySize(emptyInputs).durationTicks, 3);
});

Deno.test("19.3 a container sample matches the session sample", () => {
  const view = canonicalSession();
  const fileBytes = 3000;
  const fromSession = sampleReplaySessionSize(view, fileBytes);
  const fromContainer = sampleReplayContainerSize({
    header: {
      firstTick: fromSession.firstTick,
      lastTick: fromSession.lastTick,
      tickRate: fromSession.tickRate,
    },
    initialState: view.init,
    inputStream: view.inputs,
    eventStream: view.events,
    checkpoints: view.checkpoints,
  } as unknown as ReplayContainer, fileBytes);
  assertEquals(fromContainer, fromSession);
  assertEquals(
    summarizeReplaySize(fromContainer),
    summarizeReplaySize(fromSession),
  );
});

Deno.test("19.3 invalid size samples throw", () => {
  const cases: Array<[string, () => void]> = [
    ["tick 0", () => sampleReplaySessionSize(session({ tickRate: 0, inputs: [1] }), 1)],
    ["tick 1.5", () => sampleReplaySessionSize(session({ tickRate: 1.5, inputs: [1] }), 1)],
    ["tick NaN", () => sampleReplaySessionSize(session({ tickRate: Number.NaN, inputs: [1] }), 1)],
    ["missing init", () => sampleReplaySessionSize(session({ init: null }), 1)],
    ["negative bytes", () => summarizeReplaySize(sample({ fileBytes: -1 }))],
    ["fractional bytes", () => summarizeReplaySize(sample({ fileBytes: 1.5 }))],
    ["negative zero", () => summarizeReplaySize(sample({ fileBytes: -0 }))],
    ["tick rate 0", () => summarizeReplaySize(sample({ tickRate: 0 }))],
    ["reversed span", () => summarizeReplaySize(sample({ firstTick: 5, lastTick: 4 }))],
    ["too many bots", () => summarizeReplaySize(sample({ playerCount: 1, botCount: 2 }))],
  ];
  for (const [label, run] of cases) {
    const err = assertThrows(run, ReplaySizeError, undefined, label);
    assertEquals(err.code, REPLAY_SIZE_INVALID, label);
  }
});

Deno.test("19.3 the meter keeps the latest file and the largest file", () => {
  const meter = new ReplaySizeMeter();
  const empty = meter.report();
  assertEquals(empty.files, 0);
  assertEquals(empty.totalBytes, 0);
  assertEquals(empty.current, null);
  assertEquals(empty.largest, null);

  meter.note(sample({ fileBytes: 1000, firstTick: 0, lastTick: 0, playerCount: 2, botCount: 0, eventCount: 0, inputRows: 1, checkpointCount: 0 }));
  meter.note(sample({ fileBytes: 500, firstTick: 0, lastTick: 0, playerCount: 1, botCount: 0, eventCount: 0, inputRows: 1, checkpointCount: 0 }));
  const mid = meter.report();
  assertEquals(mid.files, 2);
  assertEquals(mid.totalBytes, 1500);
  assertEquals(mid.current!.fileBytes, 500);
  assertEquals(mid.current!.playerCount, 1);
  assertEquals(mid.largest!.fileBytes, 1000);
  assertEquals(mid.largest!.playerCount, 2);

  meter.note(sample({ fileBytes: 1000, firstTick: 0, lastTick: 9, playerCount: 4, botCount: 0, eventCount: 0, inputRows: 1, checkpointCount: 0 }));
  const tied = meter.report();
  assertEquals(tied.files, 3);
  assertEquals(tied.totalBytes, 2500);
  assertEquals(tied.current!.playerCount, 4);
  assertEquals(tied.current!.durationTicks, 10);
  assertEquals(tied.largest!.playerCount, 4);
  assertEquals(tied.largest!.durationTicks, 10);

  const again = meter.report();
  assertEquals(again.files, tied.files);
  assertEquals(again.totalBytes, tied.totalBytes);
  (again.current as { fileBytes: number }).fileBytes = 1;
  assertEquals(meter.report().current!.fileBytes, 1000);
});

Deno.test("19.3 a note past the safe integer total does not stick", () => {
  const meter = new ReplaySizeMeter();
  meter.note(sample({ fileBytes: Number.MAX_SAFE_INTEGER }));
  const err = assertThrows(
    () => meter.note(sample({ fileBytes: 1 })),
    ReplaySizeError,
  );
  assertEquals(err.code, REPLAY_SIZE_INVALID);
  const report = meter.report();
  assertEquals(report.files, 1);
  assertEquals(report.totalBytes, Number.MAX_SAFE_INTEGER);
  assertEquals(report.current!.fileBytes, Number.MAX_SAFE_INTEGER);
});

Deno.test("19.3 noting copies the sample", () => {
  const meter = new ReplaySizeMeter();
  const row = sample({ fileBytes: 40, firstTick: 1, lastTick: 1 });
  meter.note(row);
  (row as { fileBytes: number }).fileBytes = 9;
  assertEquals(meter.report().current!.fileBytes, 40);
  assertEquals(meter.report().files, 1);
});

Deno.test("19.3 size module does not read a clock, encode, or write a file", async () => {
  const src = await Deno.readTextFile(
    new URL("./replaySize.ts", import.meta.url),
  );
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  assertEquals(stripped.includes("performance.now"), false);
  assertEquals(/Deno\.write(?:File|TextFile)/.test(stripped), false);
  assertEquals(/\bJSON\.stringify\s*\(/.test(stripped), false);
  assertEquals(stripped.includes("serializeReplaySession"), false);
});

function makeServer(): GameServer {
  return new GameServer({
    name: "replay-size",
    port: 0,
    host: "127.0.0.1",
    map: miniMap,
    collision: new MapCollision(miniMap),
    autofillBots: 0,
    noBotsOnEmptyServer: true,
    joinMode: "open",
    rankedServerId: "open",
    authorityAdapter: new NoopAuthorityAdapter(),
    botThinkEngine: null,
  });
}

function internals(server: GameServer) {
  return serverInternals(server);
}

function wireRecorder(server: GameServer, opts?: WireRecorderOptions) {
  return wireReplayRecorder(
    {
      attachSink: (sink) => server.attachReplaySink(sink),
      detachSink: () => server.detachReplaySink(),
    },
    opts,
  );
}

async function startLive(
  server: GameServer,
  recorder: ReplayRecorder,
): Promise<string> {
  internals(server).sessions = { emit: () => {} };
  const i = internals(server);
  i.players.add("s1", "A1", "A");
  const start = i.players.beginLiveMatch(1, Date.now());
  i.beginRuntimeMatchIdentity(1);
  i.emitMatchStart(start, 1);
  await settleRecorder(recorder);
  return i.runtimeMatchId;
}

function removeDir(dir: string | null): void {
  if (!dir) return;
  try {
    Deno.removeSync(dir, { recursive: true });
  } catch {
    // temp dir already gone
  }
}

Deno.test("19.3 recorder notes the finalized file against the container span", async () => {
  const server = makeServer();
  const i = internals(server);
  const { recorder, lifecycle, blobDir, blobStore } = wireRecorder(server);
  const mem = lifecycle as InMemoryReplayLifecycleClient;
  try {
    assertEquals(recorder.getReplaySize().files, 0);
    assertEquals(recorder.getReplaySize().current, null);
    const matchId = await startLive(server, recorder);
    driveTick(server, 2);
    driveTick(server, 3);
    assertEquals(recorder.getReplaySize().files, 0);

    i.onMatchEnded({
      winner: "A",
      scores: { A: 1, B: 0 },
      players: [],
    });
    await settleRecorder(recorder);

    const row = (await mem.getByRuntimeMatchId(matchId))!;
    assertEquals(row.status, "finalized");
    assertExists(blobStore);
    const bytes = blobStore.get(replayBlobObjectName(matchId))!;
    assertEquals(bytes.byteLength, row.fileSizeBytes);
    const parsed = parseProvisionalReplayFile(bytes);
    const fromFile = summarizeReplaySize(
      sampleReplayContainerSize(parsed, bytes.byteLength),
    );
    const report = recorder.getReplaySize();
    assertEquals(report.files, 1);
    assertEquals(report.totalBytes, bytes.byteLength);
    assertEquals(report.current, fromFile);
    assertEquals(report.largest, fromFile);
    assertEquals(report.current!.tickRate, TICK_HZ);
    assertEquals(
      report.current!.durationTicks,
      parsed.header.lastTick - parsed.header.firstTick + 1,
    );
    assertEquals(
      report.current!.playerCount,
      parsed.initialState.metadata.roster.length,
    );
    assertEquals(report.current!.playerCount > 0, true);
    let bots = 0;
    for (const player of parsed.initialState.metadata.roster) {
      if (player.isBot || player.isAgent || player.isBalanceBot) bots += 1;
    }
    assertEquals(bots, 0);
    assertEquals(report.current!.botCount, 0);
    assertEquals(report.current!.humanCount, report.current!.playerCount);
    assertEquals(report.current!.bytesPerBot, 0);
    assertEquals(report.current!.inputRows, parsed.inputStream.length);
    assertEquals(report.current!.checkpointCount, 0);
    assertEquals(parsed.checkpoints.length, 0);
    let events = 0;
    for (const eventRow of parsed.eventStream) events += eventRow.events.length;
    assertEquals(report.current!.eventCount, events);
    assertEquals(report.current!.fileBytes, bytes.byteLength);

    const again = recorder.getReplaySize();
    assertEquals(again.files, 1);
    assertEquals(again.totalBytes, report.totalBytes);
  } finally {
    removeDir(blobDir);
  }
});

Deno.test("19.3 a custom serializer notes the session against the stub length", async () => {
  const server = makeServer();
  const i = internals(server);
  let seen: ReplayBufferedSessionView | null = null;
  const { recorder, lifecycle, blobDir } = wireRecorder(server, {
    serializeSession: (sessionView) => {
      seen = sessionView;
      return new Uint8Array(7);
    },
  });
  const mem = lifecycle as InMemoryReplayLifecycleClient;
  try {
    const matchId = await startLive(server, recorder);
    driveTick(server, 2);
    i.onMatchEnded({
      winner: "A",
      scores: { A: 1, B: 0 },
      players: [],
    });
    await settleRecorder(recorder);
    const row = (await mem.getByRuntimeMatchId(matchId))!;
    assertEquals(row.status, "finalized");
    assertEquals(row.fileSizeBytes, 7);
    const captured = seen as ReplayBufferedSessionView | null;
    assertExists(captured);
    const expected = summarizeReplaySize(sampleReplaySessionSize(captured, 7));
    const report = recorder.getReplaySize();
    assertEquals(report.files, 1);
    assertEquals(report.current, expected);
    assertEquals(report.current!.fileBytes, 7);
    assertEquals(report.current!.inputRows, captured.inputs.length);
    assertEquals(report.current!.checkpointCount, captured.checkpoints.length);
  } finally {
    removeDir(blobDir);
  }
});

Deno.test("19.3 empty bytes do not note a file", async () => {
  const server = makeServer();
  const i = internals(server);
  const { recorder, lifecycle, blobDir } = wireRecorder(server, {
    serializeSession: () => new Uint8Array(0),
  });
  const mem = lifecycle as InMemoryReplayLifecycleClient;
  try {
    const matchId = await startLive(server, recorder);
    driveTick(server, 2);
    i.onMatchEnded({
      winner: "A",
      scores: { A: 1, B: 0 },
      players: [],
    });
    await settleRecorder(recorder);
    const row = (await mem.getByRuntimeMatchId(matchId))!;
    assertEquals(row.status, "failed");
    assertMatch(row.error ?? "", /empty-bytes/);
    assertEquals(recorder.getReplaySize().files, 0);
    assertEquals(recorder.getReplaySize().current, null);
  } finally {
    removeDir(blobDir);
  }
});

Deno.test("19.3 a serialize throw does not note a file", async () => {
  const server = makeServer();
  const i = internals(server);
  const { recorder, lifecycle, blobDir } = wireRecorder(server, {
    serializeSession: () => {
      throw new Error("serialize-boom");
    },
  });
  const mem = lifecycle as InMemoryReplayLifecycleClient;
  try {
    const matchId = await startLive(server, recorder);
    driveTick(server, 2);
    i.onMatchEnded({
      winner: "A",
      scores: { A: 1, B: 0 },
      players: [],
    });
    await settleRecorder(recorder);
    const row = (await mem.getByRuntimeMatchId(matchId))!;
    assertEquals(row.status, "failed");
    assertMatch(row.error ?? "", /serialize-boom/);
    assertEquals(recorder.getReplaySize().files, 0);
  } finally {
    removeDir(blobDir);
  }
});

Deno.test("19.3 a thrown size note still finalizes the file", async () => {
  const errors: unknown[][] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  const server = makeServer();
  const i = internals(server);
  const { recorder, lifecycle, blobDir } = wireRecorder(server, {
    serializeSession: (sessionView) => {
      const view = sessionView as unknown as { init: unknown };
      view.init = {
        captureTick: sessionView.init!.captureTick,
        metadata: { tickRate: 0, roster: [] },
      };
      return new Uint8Array([4, 5, 6]);
    },
  });
  const mem = lifecycle as InMemoryReplayLifecycleClient;
  try {
    const matchId = await startLive(server, recorder);
    driveTick(server, 2);
    i.onMatchEnded({
      winner: "A",
      scores: { A: 1, B: 0 },
      players: [],
    });
    await settleRecorder(recorder);
    const row = (await mem.getByRuntimeMatchId(matchId))!;
    assertEquals(row.status, "finalized");
    assertEquals(row.fileSizeBytes, 3);
    assertEquals(recorder.getReplaySize().files, 0);
    assertEquals(recorder.getReplaySize().current, null);
    assertEquals(
      errors.some((args) => args.map(String).join(" ").includes(
        "replay size note failed",
      )),
      true,
    );
  } finally {
    console.error = orig;
    removeDir(blobDir);
  }
});

Deno.test("19.3 a failed upload keeps the size note", async () => {
  const server = makeServer();
  const i = internals(server);
  const blobDir = Deno.makeTempDirSync({ prefix: "replay-size-upload-" });
  const blobStore = new LocalReplayBlobStore(blobDir, {
    beforeRename: () => {
      throw new Error("rename-boom");
    },
  });
  const { recorder, lifecycle } = wireRecorder(server, { blobStore });
  const mem = lifecycle as InMemoryReplayLifecycleClient;
  try {
    const matchId = await startLive(server, recorder);
    driveTick(server, 2);
    i.onMatchEnded({
      winner: "A",
      scores: { A: 1, B: 0 },
      players: [],
    });
    await settleRecorder(recorder);
    const row = (await mem.getByRuntimeMatchId(matchId))!;
    assertEquals(row.status, "failed");
    assertMatch(row.error ?? "", /rename-boom/);
    const report = recorder.getReplaySize();
    assertEquals(report.files, 1);
    assertEquals(report.current!.fileBytes > 0, true);
    assertEquals(report.totalBytes, report.current!.fileBytes);
    assertEquals(report.current!.tickRate, TICK_HZ);
    assertEquals(report.current!.botCount, 0);
    assertEquals(report.largest!.fileBytes, report.current!.fileBytes);
  } finally {
    removeDir(blobDir);
  }
});

Deno.test("19.3 recorder notes size after a non-empty serialize and before upload", async () => {
  const src = await Deno.readTextFile(
    new URL("./ReplayRecorder.ts", import.meta.url),
  );
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  const fnStart = stripped.indexOf("private async completeFinalizationAsync");
  const fnEnd = stripped.indexOf("private failFinalizingClaim(", fnStart);
  const fn = stripped.slice(fnStart, fnEnd);
  const empty = fn.indexOf("empty-bytes");
  const note = fn.indexOf("this.noteReplaySize(");
  const upload = fn.indexOf("this.lifecycle.finalize(");
  assertEquals(empty > 0, true);
  assertEquals(note > empty, true);
  assertEquals(upload > note, true);

  const helperStart = stripped.indexOf("private noteReplaySize(");
  const helperBody = stripped.slice(
    helperStart,
    stripped.indexOf("\n  }", helperStart),
  );
  assertEquals(helperBody.includes("try {"), true);
  assertEquals(helperBody.includes("console.error"), true);
  assertEquals(helperBody.includes("sampleReplaySessionSize"), true);

  const getterStart = stripped.indexOf("getReplaySize():");
  const getterBody = stripped.slice(
    getterStart,
    stripped.indexOf("\n  }", getterStart),
  );
  assertEquals(getterBody.includes("this.replaySize.report()"), true);
  assertEquals(getterBody.includes(".note("), false);
});
