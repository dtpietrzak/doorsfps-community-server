import { assertEquals } from "@std/assert";
import type { BotThinkMetrics } from "../bots/BotManager.ts";
import { TICK_HZ } from "../protocol/network.ts";
import type { TickTimingSnapshot } from "./tickTiming.ts";
import {
  buildRuntimeStatus,
  type RuntimeHostStatus,
  type RuntimeStatusSnapshot,
  runtimeHostStatus,
} from "./runtimeStatus.ts";

const host: RuntimeHostStatus = {
  platform: "darwin (aarch64)",
  os: "darwin",
  arch: "aarch64",
  hostname: "slot",
  uptimeSeconds: 12,
  cpu: { cores: 8, loadAvg: [1, 2, 3], loadPerCore: 0.125 },
  memory: {
    totalBytes: 100,
    availableBytes: 40,
    usedBytes: 60,
    usedRatio: 0.6,
  },
  disk: {
    totalBytes: 200,
    availableBytes: 50,
    usedBytes: 150,
    usedRatio: 0.75,
  },
};

const botThink: BotThinkMetrics = {
  runtime: "pipeline-js",
  softSlots: 0,
  softSlotsPeak: 0,
  softSlotsMax: 8,
  softOldestAge: null,
  lastFailureCount: 0,
  failureCountTotal: 0,
  lastApplyMs: 1.25,
  lastThinkMs: 2.5,
  lastThinkBots: 3,
  thinkBatchesTotal: 4,
  meanThinkBatchMs: 2.5,
  meanThinkMsPerBot: 0.625,
  lastBotsTotalMs: 3.75,
  stepCpu: null,
  shadowLook: null,
  compiledPipeline: null,
  codecLoop: null,
};

const phase = {
  lastMs: 1.234,
  avgMs: 2.239,
  peakMs: 3.231,
  avgLoad: 0.11119,
  peakLoad: 0.22229,
};

function snapshot(
  overrides: Partial<RuntimeStatusSnapshot> = {},
): RuntimeStatusSnapshot {
  return {
    hostIdEnv: "host-1",
    runtimeIdEnv: "runtime-1",
    rankedServerId: "g00/0",
    modeId: "open",
    instanceIdEnv: "3",
    generationEnv: "7",
    buildShaEnv: "abc",
    host,
    processId: 42,
    processStartedAt: "2026-11-04T00:00:00.000Z",
    serverName: "doors",
    tls: true,
    connections: 4,
    playerCount: 3,
    humanCount: 1,
    botCount: 2,
    maxPlayers: 8,
    maxPartySize: 4,
    map: "Courtyard",
    tick: 120,
    scores: { A: 2, B: 1 },
    maps: ["Courtyard", "Atrium"],
    matchOver: false,
    matchSecondsRemaining: 90,
    restartSecondsRemaining: null,
    phase: "live",
    matchVoided: false,
    sessionFreeSlots: 7,
    sessionJoinable: true,
    raidRuntime: false,
    raidActive: false,
    draining: false,
    joinMode: "open",
    passwordRequired: true,
    board: [{
      name: "Ada",
      team: "A",
      kills: 1,
      deaths: 0,
      score: 2,
      isBot: false,
    }],
    prematch: null,
    topPlayer: {
      id: "p1",
      name: "Ada",
      team: "A",
      kills: 1,
      deaths: 0,
      score: 2,
      rating: 1.239,
      isBot: false,
    },
    tickTiming: {
      tickHz: 20,
      budgetMs: 50.236,
      avgMs: 10.234,
      peakMs: 40.239,
      avgLoad: 0.123456,
      peakLoad: 0.987654,
      samples1s: 20,
      samples30s: 600,
      skippedDeficitTicks: 3.2,
      phases: {
        bots: phase,
        sim: { ...phase, lastMs: 2 },
        heatmap: { ...phase, lastMs: 3 },
        scores: { ...phase, lastMs: 4 },
        emit: { ...phase, lastMs: 5 },
        think: { ...phase, lastMs: 6 },
      },
    },
    botThink,
    heatmap: {
      botTrackingEngaged: true,
      active: true,
      actorCount: 3,
      humanActorCount: 1,
      botActorCount: 2,
      cellEntryCount: 9,
      estBytes: 10.6,
      lastSampleMs: 1.239,
      avgSampleMs: 2.234,
    },
    netMirror: {
      clients: 2,
      volatileSent: 10,
      volatileDrops: 1,
      reliableHeartbeats: 4,
      clientRequested: 1,
      peakWriteBuffer: 8,
      clientsWithDrops: 1,
      volatileOversize: 3,
      largestVolatileBytes: 980,
      maxDatagramSize: 1200,
      websocketSessions: 2,
      webTransportSessions: 0,
      players: [{
        id: "p1",
        inOverwritten: 2,
        inRepeatTicks: 4,
        inAccepted: 40,
        inputGapP95Ms: 50,
        shotDelayP95Ms: 67,
        alive: true,
        connectionIssue: false,
      }],
    },
    webTransport: {
      enabled: true,
      listening: true,
      port: 443,
      path: "/wt",
      proto: 9,
    },
    protocolVersion: 9,
    ...overrides,
  };
}

const STATUS_KEYS = [
  "online",
  "hostId",
  "runtimeId",
  "modeId",
  "instanceId",
  "generation",
  "buildSha",
  "host",
  "processId",
  "processStartedAt",
  "serverName",
  "tls",
  "connections",
  "playerCount",
  "humanCount",
  "botCount",
  "maxPlayers",
  "maxPartySize",
  "map",
  "tick",
  "tickRate",
  "scores",
  "maps",
  "matchOver",
  "matchSecondsRemaining",
  "restartSecondsRemaining",
  "phase",
  "matchVoided",
  "freeSlots",
  "draining",
  "joinable",
  "joinMode",
  "ranked",
  "passwordRequired",
  "board",
  "lobby",
  "topPlayer",
  "tickTiming",
  "botThink",
  "heatmap",
  "netMirror",
  "webTransport",
  "protocolVersion",
];

Deno.test("buildRuntimeStatus pins the /api/status body", () => {
  const body = buildRuntimeStatus(snapshot());
  const roundedPhase = {
    lastMs: 1.23,
    avgMs: 2.24,
    peakMs: 3.23,
    avgLoad: 0.1112,
    peakLoad: 0.2223,
  };
  assertEquals(Object.keys(body), STATUS_KEYS);
  assertEquals(body, {
    online: true,
    hostId: "host-1",
    runtimeId: "runtime-1",
    modeId: "open",
    instanceId: "3",
    generation: 7,
    buildSha: "abc",
    host,
    processId: 42,
    processStartedAt: "2026-11-04T00:00:00.000Z",
    serverName: "doors",
    tls: true,
    connections: 4,
    playerCount: 3,
    humanCount: 1,
    botCount: 2,
    maxPlayers: 8,
    maxPartySize: 4,
    map: "Courtyard",
    tick: 120,
    tickRate: TICK_HZ,
    scores: { A: 2, B: 1 },
    maps: ["Courtyard", "Atrium"],
    matchOver: false,
    matchSecondsRemaining: 90,
    restartSecondsRemaining: null,
    phase: "live",
    matchVoided: false,
    freeSlots: 7,
    draining: false,
    joinable: true,
    joinMode: "open",
    ranked: false,
    passwordRequired: true,
    board: snapshot().board,
    lobby: null,
    topPlayer: {
      name: "Ada",
      team: "A",
      kills: 1,
      deaths: 0,
      score: 2,
      rating: 1.24,
      isBot: false,
    },
    tickTiming: {
      tickHz: 20,
      budgetMs: 50.24,
      avgMs: 10.23,
      peakMs: 40.24,
      avgLoad: 0.1235,
      peakLoad: 0.9877,
      samples1s: 20,
      samples30s: 600,
      phases: {
        bots: roundedPhase,
        sim: { ...roundedPhase, lastMs: 2 },
        heatmap: { ...roundedPhase, lastMs: 3 },
        scores: { ...roundedPhase, lastMs: 4 },
        emit: { ...roundedPhase, lastMs: 5 },
        think: { ...roundedPhase, lastMs: 6 },
      },
      skippedDeficitTicks: 3,
    },
    botThink,
    heatmap: {
      botTrackingEngaged: true,
      active: true,
      actorCount: 3,
      humanActorCount: 1,
      botActorCount: 2,
      cellEntryCount: 9,
      estBytes: 11,
      lastSampleMs: 1.24,
      avgSampleMs: 2.23,
    },
    netMirror: snapshot().netMirror,
    webTransport: snapshot().webTransport,
    protocolVersion: 9,
  });
});

Deno.test("buildRuntimeStatus identity fallbacks and generation", () => {
  const blank = buildRuntimeStatus(snapshot({
    hostIdEnv: "  ",
    runtimeIdEnv: "",
    modeId: null,
    instanceIdEnv: undefined,
    generationEnv: "",
    buildShaEnv: "  ",
    joinMode: "ranked",
  }));
  assertEquals(blank.hostId, "local");
  assertEquals(blank.runtimeId, "g00/0");
  assertEquals(blank.modeId, "g00/0");
  assertEquals(blank.instanceId, "0");
  assertEquals(blank.generation, 0);
  assertEquals(blank.buildSha, null);
  assertEquals(blank.ranked, true);

  assertEquals(buildRuntimeStatus(snapshot({ modeId: "" })).modeId, "g00/0");
  assertEquals(buildRuntimeStatus(snapshot({ generationEnv: "1.5" })).generation, 0);
  assertEquals(buildRuntimeStatus(snapshot({ generationEnv: "-3" })).generation, 0);
  assertEquals(buildRuntimeStatus(snapshot({ generationEnv: "nope" })).generation, 0);
  assertEquals(buildRuntimeStatus(snapshot({ generationEnv: " 12 " })).generation, 12);
  assertEquals(
    buildRuntimeStatus(snapshot({ buildShaEnv: " sha " })).buildSha,
    "sha",
  );
});

Deno.test("buildRuntimeStatus raid occupancy, drain, lobby, and empty timing", () => {
  const occupied = buildRuntimeStatus(snapshot({
    raidRuntime: true,
    raidActive: true,
    humanCount: 2,
    sessionFreeSlots: 6,
    sessionJoinable: true,
  }));
  assertEquals(occupied.freeSlots, 0);
  assertEquals(occupied.joinable, false);

  const idle = buildRuntimeStatus(snapshot({
    raidRuntime: true,
    raidActive: false,
    humanCount: 0,
    sessionFreeSlots: 6,
    sessionJoinable: true,
  }));
  assertEquals(idle.freeSlots, 6);
  assertEquals(idle.joinable, true);

  const draining = buildRuntimeStatus(snapshot({
    draining: true,
    sessionFreeSlots: 4,
    sessionJoinable: true,
  }));
  assertEquals(draining.freeSlots, 4);
  assertEquals(draining.joinable, false);
  assertEquals(draining.draining, true);

  const lobby = buildRuntimeStatus(snapshot({
    prematch: {
      phase: "prematch",
      humanCount: 2,
      humansReady: 1,
      minHumans: 2,
      canVote: false,
      readyPlayerIds: ["p1"],
      teamHumans: { A: 1, B: 1 },
      requireEvenTeams: true,
    },
    topPlayer: null,
    tickTiming: null,
    heatmap: {
      ...snapshot().heatmap,
      estBytes: -1.2,
    },
  }));
  assertEquals(lobby.lobby, {
    humanCount: 2,
    humansReady: 1,
    minHumans: 2,
    canVote: false,
    teamHumans: { A: 1, B: 1 },
    requireEvenTeams: true,
  });
  assertEquals(lobby.topPlayer, null);
  assertEquals(lobby.tickTiming, null);
  assertEquals(lobby.heatmap.estBytes, 0);
});

Deno.test("buildRuntimeStatus omits a missing tick phase and an absent skip count", () => {
  const timing: TickTimingSnapshot = {
    tickHz: 20,
    budgetMs: 50,
    avgMs: 1,
    peakMs: 1,
    avgLoad: 0,
    peakLoad: 0,
    samples1s: 1,
    samples30s: 1,
    phases: {
      bots: {
        lastMs: 1.234,
        avgMs: 1,
        peakMs: 1,
        avgLoad: 0,
        peakLoad: 0,
      },
    } as TickTimingSnapshot["phases"],
  };
  const body = buildRuntimeStatus(snapshot({ tickTiming: timing }));
  assertEquals(body.tickTiming, {
    tickHz: 20,
    budgetMs: 50,
    avgMs: 1,
    peakMs: 1,
    avgLoad: 0,
    peakLoad: 0,
    samples1s: 1,
    samples30s: 1,
    phases: {
      bots: {
        lastMs: 1.23,
        avgMs: 1,
        peakMs: 1,
        avgLoad: 0,
        peakLoad: 0,
      },
    },
  } as TickTimingSnapshot);
  assertEquals(
    body.tickTiming !== null && "skippedDeficitTicks" in body.tickTiming,
    false,
  );
});

Deno.test("runtimeHostStatus reports the host key set", () => {
  const live = runtimeHostStatus();
  assertEquals(Object.keys(live), [
    "platform",
    "os",
    "arch",
    "hostname",
    "uptimeSeconds",
    "cpu",
    "memory",
    "disk",
  ]);
  assertEquals(Object.keys(live.cpu), ["cores", "loadAvg", "loadPerCore"]);
  assertEquals(typeof live.platform, "string");
  assertEquals(live.platform.includes(live.os), true);
});
