import { assertEquals, assertNotEquals } from "@std/assert";
import { io } from "socket.io-client";
import { GameServer, parseBotThinkRuntimeMode } from "./GameServer.ts";
import {
  type AuthorityAdapter,
  type HeatmapIngestBody,
  NoopAuthorityAdapter,
} from "../authority/adapter.ts";
import { HeatmapTracker } from "../heatmaps/HeatmapTracker.ts";
import { PlayerManager } from "../players/PlayerManager.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";
import { certificateSha256, writeSelfSignedDevTls } from "../host/tlsDev.ts";
import { decodeGamePacket, GAME_PROTO } from "../shared/net/index.ts";
import { JoinErrors, NetEvents, TICK_HZ } from "../protocol/network.ts";
import { encodeAuthFrame, StreamFrameReader } from "../transport/webTransportFrame.ts";

const miniMap: DoorsMap = {
  name: "tls-test",
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

const TEST_JOIN_PASSWORD = "test-pass";

function makeServer(tls?: { cert: string; key: string } | null): GameServer {
  return new GameServer({
    name: "tls-test",
    port: 0,
    host: "127.0.0.1",
    map: miniMap,
    collision: new MapCollision(miniMap),
    autofillBots: 0,
    noBotsOnEmptyServer: true,
    joinMode: "open",
    rankedServerId: "community-tls-test",
    joinPassword: TEST_JOIN_PASSWORD,
    tls: tls ?? null,
  });
}

Deno.test("parseBotThinkRuntimeMode names Deno-compiled child hosts", () => {
  assertEquals(parseBotThinkRuntimeMode(undefined), "pipeline-js");
  assertEquals(parseBotThinkRuntimeMode("pipeline-compiled"), "pipeline-compiled");
  assertEquals(
    parseBotThinkRuntimeMode("pipeline-compiled-shadow"),
    "pipeline-compiled-shadow",
  );
  assertEquals(
    parseBotThinkRuntimeMode("pipeline-compiled-deno"),
    "pipeline-compiled-deno",
  );
  assertEquals(parseBotThinkRuntimeMode("compiled-deno"), "pipeline-compiled-deno");
  assertEquals(
    parseBotThinkRuntimeMode("pipeline-compiled-deno-shadow"),
    "pipeline-compiled-deno-shadow",
  );
});

Deno.test("GameServer gives every raid session a fresh reward identity", () => {
  const map = { ...miniMap, name: "Crossroads" };
  const server = new GameServer({
    name: "raid-identity-test",
    port: 0,
    host: "127.0.0.1",
    map,
    collision: new MapCollision(map),
    autofillBots: 0,
    noBotsOnEmptyServer: true,
    joinMode: "open",
    rankedServerId: "raid",
    modeId: "raid",
    authorityAdapter: new NoopAuthorityAdapter(),
  });
  const internals = server as unknown as {
    runtimeMatchId: string;
    lastReportedMatchKey: string | null;
    lastHeatmapReportKey: string | null;
    activateRaidFromJoin(input: {
      team?: "A" | "B";
      raidId?: string;
      partySize?: number;
    }): void;
    resetIdleRaidRuntime(): void;
  };

  const processIdentity = internals.runtimeMatchId;
  internals.lastReportedMatchKey = "previous-report";
  internals.lastHeatmapReportKey = "previous-heatmap";
  internals.activateRaidFromJoin({
    team: "A",
    raidId: "crossroads",
    partySize: 2,
  });
  const firstRaidIdentity = internals.runtimeMatchId;
  assertNotEquals(firstRaidIdentity, processIdentity);
  assertEquals(internals.lastReportedMatchKey, null);
  assertEquals(internals.lastHeatmapReportKey, null);

  internals.lastReportedMatchKey = "first-raid-report";
  internals.lastHeatmapReportKey = "first-raid-heatmap";
  internals.resetIdleRaidRuntime();
  internals.activateRaidFromJoin({
    team: "A",
    raidId: "crossroads",
    partySize: 2,
  });
  assertNotEquals(internals.runtimeMatchId, firstRaidIdentity);
  assertEquals(internals.lastReportedMatchKey, null);
  assertEquals(internals.lastHeatmapReportKey, null);
});

Deno.test("intermission map-vote switch changes the map", () => {
  const mapA = { ...miniMap, name: "VoteA" };
  const mapB = { ...miniMap, name: "VoteB" };
  const collisionA = new MapCollision(mapA);
  const server = new GameServer({
    name: "vote-prior-test",
    port: 0,
    host: "127.0.0.1",
    map: mapA,
    collision: collisionA,
    mapPath: "vote-a",
    mapCatalog: [
      { name: "VoteA", stem: "VoteA", path: "vote-a", map: mapA, collision: collisionA },
      {
        name: "VoteB",
        stem: "VoteB",
        path: "vote-b",
        map: mapB,
        collision: new MapCollision(mapB),
      },
    ],
    autofillBots: 0,
    noBotsOnEmptyServer: true,
    joinMode: "open",
    authorityAdapter: new NoopAuthorityAdapter(),
    botThinkEngine: null,
  });
  const internals = server as unknown as {
    players: PlayerManager;
    sessions: { emit(...args: unknown[]): void } | undefined;
    mapVotes: Map<string, string>;
    finishIntermission(tick: number, nowMs: number): void;
  };
  internals.sessions = { emit: () => {} };
  internals.players.forceEndMatch(10, "A", {
    scheduleRestart: true,
    restartSeconds: 1,
  });
  internals.mapVotes.set("voter", "VoteB");

  internals.finishIntermission(10 + TICK_HZ, Date.now());

  assertEquals(server.getMapName(), "VoteB");
});

Deno.test("stop cancels a pending admission bot reconcile timer", async () => {
  const server = new GameServer({
    name: "admission-timer-stop",
    port: 0,
    host: "127.0.0.1",
    map: miniMap,
    collision: new MapCollision(miniMap),
    autofillBots: 0,
    noBotsOnEmptyServer: true,
    joinMode: "open",
    authorityAdapter: new NoopAuthorityAdapter(),
    botThinkEngine: null,
  });
  const internals = server as unknown as {
    admissionBotReconcileTimer: ReturnType<typeof setTimeout> | null;
    admissionBotPendingParties: Map<string, { partySize: number }>;
    onHumanSeatedForBots(opts: {
      partyId?: string | null;
      partySize?: number | null;
    }): void;
  };
  // First member of a 2-player party: wave stays open, settle timer armed.
  internals.onHumanSeatedForBots({ partyId: "party-1", partySize: 2 });
  assertNotEquals(internals.admissionBotReconcileTimer, null);

  await server.stop();

  // Deno's op sanitizer also fails this test if the timer is still pending.
  assertEquals(internals.admissionBotReconcileTimer, null);
  assertEquals(internals.admissionBotPendingParties.size, 0);
});

Deno.test("same-tick human and bot captures fail the raid (dealer wins)", () => {
  const map = { ...miniMap, name: "Crossroads" };
  const server = new GameServer({
    name: "raid-same-tick",
    port: 0,
    host: "127.0.0.1",
    map,
    collision: new MapCollision(map),
    autofillBots: 0,
    noBotsOnEmptyServer: true,
    joinMode: "open",
    rankedServerId: "raid",
    modeId: "raid",
    authorityAdapter: new NoopAuthorityAdapter(),
  });
  const internals = server as unknown as {
    raid: { tryStart(n: number): boolean; ended: boolean; failReason: string | null };
    players: PlayerManager;
    handleRaidScores(scores: { team: "A" | "B" }[]): { winner: string } | null;
    activateRaidFromJoin(input: {
      team?: "A" | "B";
      raidId?: string;
      partySize?: number;
    }): void;
  };
  internals.activateRaidFromJoin({
    team: "A",
    raidId: "crossroads",
    partySize: 2,
  });
  assertEquals(internals.raid.tryStart(2), true);
  internals.players.setRaidDoorPolicy("open");
  const over = internals.handleRaidScores([{ team: "A" }, { team: "B" }]);
  assertEquals(over?.winner, "B");
  assertEquals(internals.raid.ended, true);
  assertEquals(internals.raid.failReason, "enemy_capture");
});

function raidLoadGateServer(name: string) {
  const map = { ...miniMap, name: "Crossroads" };
  const server = new GameServer({
    name,
    port: 0,
    host: "127.0.0.1",
    map,
    collision: new MapCollision(map),
    autofillBots: 0,
    noBotsOnEmptyServer: true,
    joinMode: "open",
    rankedServerId: "raid",
    modeId: "raid",
    authorityAdapter: new NoopAuthorityAdapter(),
  });
  const internals = server as unknown as {
    raid: { started: boolean; activatedAtMs: number } | null;
    players: PlayerManager;
    sessions: { emit(...args: unknown[]): void; get(id: string): undefined };
    raidLoadedPlayerIds: Set<string>;
    handleRaidFailConditions(): unknown;
    raidPartyTimedOut(partyId: string | undefined): boolean;
    activateRaidFromJoin(input: {
      team?: "A" | "B";
      raidId?: string;
      partySize?: number;
    }): void;
  };
  internals.sessions = { emit: () => {}, get: () => undefined };
  internals.activateRaidFromJoin({
    team: "A",
    raidId: "crossroads",
    partySize: 2,
  });
  const partyOpts = { partyId: "party-1", partySize: 2 };
  internals.players.add("p1", "Alpha", "A", partyOpts);
  internals.players.add("p2", "Bravo", "A", partyOpts);
  return internals;
}

Deno.test("raid holds doors until every party member has loaded the map", () => {
  const internals = raidLoadGateServer("raid-load-gate");
  // Both connected, nobody loaded: still holding.
  internals.handleRaidFailConditions();
  assertEquals(internals.raid?.started, false);
  internals.raidLoadedPlayerIds.add("p1");
  internals.handleRaidFailConditions();
  assertEquals(internals.raid?.started, false);
  internals.raidLoadedPlayerIds.add("p2");
  internals.handleRaidFailConditions();
  assertEquals(internals.raid?.started, true);
});

Deno.test("raid kicks the whole party when someone has not loaded after the wait", () => {
  const internals = raidLoadGateServer("raid-load-timeout");
  internals.raidLoadedPlayerIds.add("p1");
  internals.raid!.activatedAtMs = Date.now() - 119_000;
  internals.handleRaidFailConditions();
  assertEquals(internals.raid?.started, false);
  assertEquals(internals.players.humanCount(), 2);

  internals.raid!.activatedAtMs = Date.now() - 121_000;
  internals.handleRaidFailConditions();
  assertEquals(internals.raid, null);
  assertEquals(internals.players.humanCount(), 0);
  assertEquals(internals.raidLoadedPlayerIds.size, 0);
  // A straggler's old token cannot reopen the idled slot alone.
  assertEquals(internals.raidPartyTimedOut("party-1"), true);
  assertEquals(internals.raidPartyTimedOut("party-2"), false);
});

Deno.test("raid match state is recorded in metadata identity and checkpoints (notes/replay.md §29.2)", () => {
  const map = { ...miniMap, name: "Crossroads" };
  const server = new GameServer({
    name: "raid-recording-test",
    port: 0,
    host: "127.0.0.1",
    map,
    collision: new MapCollision(map),
    autofillBots: 0,
    noBotsOnEmptyServer: true,
    joinMode: "open",
    rankedServerId: "raid",
    modeId: "raid",
    authorityAdapter: new NoopAuthorityAdapter(),
  });
  const internals = server as unknown as {
    players: PlayerManager;
    activateRaidFromJoin(input: {
      team?: "A" | "B";
      raidId?: string;
      partySize?: number;
    }): void;
  };

  // Off-raid: both recording surfaces report the inactive sentinel, never null.
  const offIdentity = server.getMatchMetadataIdentity();
  assertEquals(offIdentity.raidMatch, { active: false });
  internals.players.drainAuthoritativeEvents();
  const offCheckpoint = server.captureCheckpoint(internals.players.tick);
  assertEquals(offCheckpoint.match.raid, { active: false });

  internals.activateRaidFromJoin({
    team: "A",
    raidId: "crossroads",
    partySize: 2,
  });

  const identity = server.getMatchMetadataIdentity();
  const raidMatch = identity.raidMatch;
  assertEquals(raidMatch.active, true);
  if (!raidMatch.active) return;
  assertEquals(raidMatch.raidId, "crossroads");
  assertEquals(raidMatch.humanTeam, "A");
  assertEquals(raidMatch.started, false);
  assertEquals(raidMatch.wave, 0);
  assertEquals(raidMatch.failReason, null);
  assertEquals(raidMatch.expectedHumans >= 2, true);

  // MatchMetadata (the recorded initial-state half) carries the same state.
  const meta = server.requireMatchMetadata(internals.players.tick, {
    capturedAtIso: "2026-01-01T00:00:00.000Z",
  });
  assertEquals(meta.raidMatch, raidMatch);

  internals.players.drainAuthoritativeEvents();
  const checkpoint = server.captureCheckpoint(internals.players.tick);
  const cpRaid = checkpoint.match.raid;
  assertEquals(cpRaid.active, true);
  if (!cpRaid.active) return;
  assertEquals(cpRaid.started, false);
  assertEquals(cpRaid.wave, 0);
  assertEquals(cpRaid.failReason, null);

  // Wave/started state changes (tryStart) are reflected live, not cached.
  internals.players.add("p1", "Alpha", "A");
  internals.players.add("p2", "Bravo", "A");
  const started = (server as unknown as {
    raid: { tryStart(n: number): boolean };
  }).raid.tryStart(2);
  assertEquals(started, true);

  internals.players.drainAuthoritativeEvents();
  const afterStart = server.captureCheckpoint(internals.players.tick).match.raid;
  assertEquals(afterStart.active, true);
  if (!afterStart.active) return;
  assertEquals(afterStart.started, true);
  assertEquals(afterStart.wave, 1);
});

Deno.test("empty live ranked reset flushes actual heatmap stats then clears them", () => {
  const heatmapReports: HeatmapIngestBody[] = [];
  const authority: AuthorityAdapter = {
    enabled: true,
    reportMatch: () => Promise.resolve({ ok: true }),
    reportHeatmaps: (body) => {
      heatmapReports.push(body);
      return Promise.resolve({ ok: true, inserted: body.sessions.length });
    },
  };
  const server = new GameServer({
    name: "ranked-empty-heatmap-test",
    port: 0,
    host: "127.0.0.1",
    map: miniMap,
    collision: new MapCollision(miniMap),
    autofillBots: 0,
    noBotsOnEmptyServer: true,
    joinMode: "ranked",
    rankedServerId: "ranked",
    authorityAdapter: authority,
    botThinkEngine: null,
  });
  const internals = server as unknown as {
    players: PlayerManager;
    heatmaps: HeatmapTracker;
    sessions: { emit(...args: unknown[]): void };
    dropPlayer(playerId: string): void;
  };
  internals.sessions = { emit: () => {} };

  const player = internals.players.add("p1", "Early Leaver", "A", {
    accountUserId: "user_early",
  });
  const others = [
    internals.players.add("p2", "Two", "B"),
    internals.players.add("p3", "Three", "A"),
    internals.players.add("p4", "Four", "B"),
  ];
  for (const human of [player, ...others]) {
    internals.players.setMatchReady(human.id, true);
  }
  assertEquals(
    internals.players.tryStartLiveFromReady(10)?.phase,
    "live",
  );
  player.kills = 2;
  player.deaths = 1;
  player.score = 1;
  internals.heatmaps.recordShoot(player, true);

  // Exercise the actual leave path. The fourth departure makes ranked empty,
  // which flushes the batch and clears its in-memory tracker.
  for (const human of [player, ...others]) {
    internals.dropPlayer(human.id);
  }

  assertEquals(heatmapReports.length, 1);
  assertEquals(heatmapReports[0]?.sessions[0]?.actorName, "Early Leaver");
  assertEquals(heatmapReports[0]?.sessions[0]?.kills, 2);
  assertEquals(heatmapReports[0]?.sessions[0]?.deaths, 1);
  assertEquals(heatmapReports[0]?.sessions[0]?.doors, 1);
  assertEquals(
    heatmapReports[0]?.sessions[0]?.cells.open?.shoot != null,
    true,
  );
  assertEquals(internals.heatmaps.getRuntimeStats().actorCount, 0);
  assertEquals(internals.players.getMatchPhase(), "prematch");
});

function tryOpenJoin(
  port: number,
  auth: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; message: string }> {
  return new Promise((resolve) => {
    const socket = io(`http://127.0.0.1:${port}`, {
      transports: ["websocket"],
      timeout: 8_000,
      autoConnect: false,
      auth,
    });
    const timer = setTimeout(() => {
      socket.disconnect();
      resolve({ ok: false, message: "welcome timeout" });
    }, 8_000);
    socket.on("g", (raw: unknown) => {
      const decoded = decodeGamePacket(raw);
      if (decoded?.event !== NetEvents.Welcome) return;
      clearTimeout(timer);
      socket.disconnect();
      resolve({ ok: true });
    });
    socket.once("connect_error", (err) => {
      clearTimeout(timer);
      socket.disconnect();
      resolve({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
    });
    socket.connect();
  });
}

Deno.test("GameServer HTTP: community host refuses to start without a join password", async () => {
  const server = new GameServer({
    name: "pw-missing",
    port: 0,
    host: "127.0.0.1",
    map: miniMap,
    collision: new MapCollision(miniMap),
    autofillBots: 0,
    noBotsOnEmptyServer: true,
    joinMode: "open",
    rankedServerId: "community-pw-missing",
  });
  try {
    await server.start();
    throw new Error("expected start() to reject without a join password");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    assertEquals(
      message.includes("require a join password"),
      true,
    );
  } finally {
    await server.stop().catch(() => {});
  }
});

Deno.test("GameServer HTTP: community join password is advertised and enforced", async () => {
  const server = new GameServer({
    name: "pw-test",
    port: 0,
    host: "127.0.0.1",
    map: miniMap,
    collision: new MapCollision(miniMap),
    autofillBots: 0,
    noBotsOnEmptyServer: true,
    joinMode: "open",
    rankedServerId: "community-pw-test",
    joinPassword: "let-me-in",
  });
  await server.start();
  try {
    const port = server.getPort();
    const res = await fetch(`http://127.0.0.1:${port}/api/status`);
    const body = await res.json() as { passwordRequired?: boolean };
    assertEquals(res.ok, true);
    assertEquals(body.passwordRequired, true);
    assertEquals(server.hasJoinPassword(), true);

    const missing = await tryOpenJoin(port, {
      name: "Ada",
      proto: GAME_PROTO,
    });
    assertEquals(missing, {
      ok: false,
      message: JoinErrors.PasswordRequired,
    });

    const wrong = await tryOpenJoin(port, {
      name: "Ada",
      proto: GAME_PROTO,
      password: "nope",
    });
    assertEquals(wrong, {
      ok: false,
      message: JoinErrors.PasswordInvalid,
    });

    const ok = await tryOpenJoin(port, {
      name: "Ada",
      proto: GAME_PROTO,
      password: "let-me-in",
    });
    assertEquals(ok, { ok: true });
  } finally {
    await server.stop();
  }
});

Deno.test("GameServer HTTP: /api/status has tls=false and stays joinable", async () => {
  const server = makeServer();
  assertEquals(server.isUsingTls(), false);
  await server.start();
  try {
    const port = server.getPort();
    const res = await fetch(`http://127.0.0.1:${port}/api/status`);
    const body = await res.json() as {
      online?: boolean;
      tls?: boolean;
      tick?: number;
      tickRate?: number;
      tickTiming?: {
        tickHz?: number;
        skippedDeficitTicks?: number;
      } | null;
      webTransport?: { enabled?: boolean; listening?: boolean };
    };
    assertEquals(res.ok, true);
    assertEquals(body.online, true);
    assertEquals(body.tls, false);
    assertEquals(body.webTransport?.enabled, false);
    assertEquals(body.webTransport?.listening, false);
    assertEquals(typeof body.tick, "number");
    assertEquals(body.tickRate, TICK_HZ);
    assertEquals(body.tickTiming?.tickHz, TICK_HZ);
    assertEquals(typeof body.tickTiming?.skippedDeficitTicks, "number");
    assertEquals((body as { passwordRequired?: boolean }).passwordRequired, true);
    assertEquals((body as { protocolVersion?: number }).protocolVersion, GAME_PROTO);
  } finally {
    await server.stop();
  }
});

Deno.test("GameServer HTTPS: /api/status + Socket.IO welcome", async () => {
  const dir = await Deno.makeTempDir({ prefix: "doors-https-" });
  try {
    const files = await writeSelfSignedDevTls(dir);
    const tlsServer = makeServer({ cert: files.cert, key: files.key });
    assertEquals(tlsServer.isUsingTls(), true);
    await tlsServer.start();
    try {
      const port = tlsServer.getPort();
      const client = Deno.createHttpClient({ caCerts: [files.cert] });
      try {
        const res = await fetch(`https://127.0.0.1:${port}/api/status`, {
          client,
        });
        const body = await res.json() as {
          online?: boolean;
          tls?: boolean;
          webTransport?: {
            enabled?: boolean;
            listening?: boolean;
            path?: string;
            port?: number;
          };
          netMirror?: {
            websocketSessions?: number;
            webTransportSessions?: number;
          };
        };
        assertEquals(res.ok, true);
        assertEquals(body.online, true);
        assertEquals(body.tls, true);
        assertEquals(body.webTransport?.enabled, true);
        assertEquals(body.webTransport?.listening, true);
        assertEquals(body.webTransport?.path, "/wt");
        assertEquals(body.webTransport?.port, port);
        assertEquals(body.netMirror?.websocketSessions, 0);
        assertEquals(body.netMirror?.webTransportSessions, 0);
      } finally {
        client.close();
      }

      const welcome = await new Promise<unknown>((resolve, reject) => {
        const socket = io(`https://127.0.0.1:${port}`, {
          transports: ["websocket"],
          rejectUnauthorized: false,
          timeout: 8_000,
          autoConnect: false,
          auth: {
            name: "TlsSmoke",
            proto: GAME_PROTO,
            password: TEST_JOIN_PASSWORD,
          },
        });
        const timer = setTimeout(() => {
          socket.disconnect();
          reject(new Error("welcome timeout"));
        }, 8_000);
        socket.on("g", (raw: unknown) => {
          const decoded = decodeGamePacket(raw);
          if (decoded?.event !== NetEvents.Welcome) return;
          clearTimeout(timer);
          socket.disconnect();
          resolve(decoded.payload);
        });
        socket.once("connect_error", (err) => {
          clearTimeout(timer);
          socket.disconnect();
          reject(err);
        });
        socket.connect();
      });
      const payload = welcome as { id?: string };
      assertEquals(typeof payload.id, "string");
    } finally {
      await tlsServer.stop();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("GameServer HTTPS: WebTransport client receives Welcome", async () => {
  const dir = await Deno.makeTempDir({ prefix: "doors-https-wt-" });
  try {
    const files = await writeSelfSignedDevTls(dir);
    const hash = await certificateSha256(files.der);
    const tlsServer = makeServer({ cert: files.cert, key: files.key });
    await tlsServer.start();
    try {
      const port = tlsServer.getPort();
      const wt = new WebTransport(`https://127.0.0.1:${port}/wt`, {
        serverCertificateHashes: [{ algorithm: "sha-256", value: hash }],
      });
      await wt.ready;
      const stream = await wt.createBidirectionalStream();
      const writer = stream.writable.getWriter();
      await writer.write(encodeAuthFrame({
        name: "WtJoin",
        proto: GAME_PROTO,
        password: TEST_JOIN_PASSWORD,
      }));
      const reader = stream.readable.getReader();
      const frames = new StreamFrameReader();
      let welcome: { event?: string; payload?: { id?: string } } | null = null;
      const deadline = Date.now() + 8_000;
      while (!welcome && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done || !value) break;
        for (const body of frames.push(value)) {
          const decoded = decodeGamePacket(body);
          if (decoded?.event === NetEvents.Welcome) {
            welcome = decoded as { event: string; payload: { id?: string } };
            break;
          }
        }
      }
      assertEquals(welcome?.event, NetEvents.Welcome);
      assertEquals(typeof welcome?.payload?.id, "string");
      wt.close();
    } finally {
      await tlsServer.stop();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("GameServer HTTPS: WEBTRANSPORT_ENABLED off still serves WSS", async () => {
  const dir = await Deno.makeTempDir({ prefix: "doors-https-wt-off-" });
  try {
    const files = await writeSelfSignedDevTls(dir);
    const tlsServer = new GameServer({
      name: "tls-wt-off",
      port: 0,
      host: "127.0.0.1",
      map: miniMap,
      collision: new MapCollision(miniMap),
      autofillBots: 0,
      noBotsOnEmptyServer: true,
      joinMode: "open",
      rankedServerId: "community-tls-test",
      joinPassword: TEST_JOIN_PASSWORD,
      tls: { cert: files.cert, key: files.key },
      webTransport: false,
    });
    await tlsServer.start();
    try {
      const port = tlsServer.getPort();
      const client = Deno.createHttpClient({ caCerts: [files.cert] });
      try {
        const res = await fetch(`https://127.0.0.1:${port}/api/status`, {
          client,
        });
        const body = await res.json() as {
          tls?: boolean;
          webTransport?: { enabled?: boolean; listening?: boolean };
        };
        assertEquals(body.tls, true);
        assertEquals(body.webTransport?.enabled, false);
        assertEquals(body.webTransport?.listening, false);
      } finally {
        client.close();
      }
    } finally {
      await tlsServer.stop();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
