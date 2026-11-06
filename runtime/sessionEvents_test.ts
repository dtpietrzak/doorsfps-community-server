/**
 * Socket wiring moved out of GameServer.registerEvents.
 * Roster seating stays on the host. Run from server-community/:
 *   deno test -A runtime/sessionEvents_test.ts
 */

import { assertEquals } from "@std/assert";
import type { Player } from "../players/Player.ts";
import type { PlayerManager } from "../players/PlayerManager.ts";
import type { SimIngressSinks } from "../players/simIngress.ts";
import {
  CONNECTION_ISSUE_TIMEOUT_MS,
  JoinErrors,
  NetEvents,
} from "../protocol/network.ts";
import type { RaidMatch } from "../raid/RaidMatch.ts";
import type { AuthorityPublicKeys } from "../shared/authority/authorityTokens.ts";
import { SOCKET_IO_CLIENT_DISCONNECT } from "../transport/disconnectReason.ts";
import type { InputRateLimiter } from "../transport/inputRateLimit.ts";
import type {
  ClientSession,
  SessionAuthResult,
  SessionHub,
} from "../transport/types.ts";
import type { AdminCommandHost } from "./adminCommands.ts";
import { type AdmittedJoin, sessionDataFromJoin } from "./joinAuth.ts";
import type { MapVote } from "./mapVote.ts";
import type { PoseStream } from "./poseStream.ts";
import {
  methodBody,
  readRepoSource,
  stripComments,
} from "./gameServerTestHarness.ts";
import {
  registerSessionEvents,
  type SeatedPlayer,
  type SessionEventHost,
} from "./sessionEvents.ts";
import type { TeamRebalance } from "./teamRebalance.ts";

type Sent = { event: string; payload: unknown };
type Handler = (payload?: unknown) => void;

function fakeSession(id: string, data: ClientSession["data"] = {}) {
  const sent: Sent[] = [];
  const ons = new Map<string, Handler>();
  const trace = { disconnected: false };
  const session = {
    id,
    kind: "websocket",
    auth: {},
    data: { ...data },
    emit(event: string, payload?: unknown) {
      sent.push({ event, payload });
    },
    emitVolatile() {
      return "sent" as const;
    },
    on(event: string, handler: Handler) {
      ons.set(event, handler);
    },
    disconnect() {
      trace.disconnected = true;
    },
    isWritable: () => true,
    writeBufferLength: () => 0,
  } as ClientSession;
  return { session, sent, ons, trace };
}

function fakeHub() {
  const emitted: Sent[] = [];
  const members: ClientSession[] = [];
  let auth:
    | ((auth: Record<string, unknown>) => Promise<SessionAuthResult>)
    | null = null;
  let connect: ((session: ClientSession) => void) | null = null;
  const hub = {
    size: 0,
    authenticate(
      fn: (
        auth: Record<string, unknown>,
      ) => SessionAuthResult | Promise<SessionAuthResult>,
    ) {
      auth = fn as (
        auth: Record<string, unknown>,
      ) => Promise<SessionAuthResult>;
    },
    onConnect(handler: (session: ClientSession) => void) {
      connect = handler;
    },
    emit(event: string, payload?: unknown) {
      emitted.push({ event, payload });
    },
    get: () => undefined,
    sessions: () => members,
    close: () => Promise.resolve(),
  } as SessionHub;
  return {
    hub,
    emitted,
    members,
    authenticate: (bag: Record<string, unknown>) => {
      if (!auth) throw new Error("authenticate was not wired");
      return auth(bag);
    },
    connect: (session: ClientSession) => {
      if (!connect) throw new Error("onConnect was not wired");
      connect(session);
    },
  };
}

type Trace = {
  seated: number;
  dropped: string[];
  marked: string[];
  ready: Array<{ id: string; ready: boolean }>;
  heartbeats: number;
  forgottenInput: string[];
  forgottenPose: string[];
  handleInput: string[];
  handleReload: string[];
  loaded: string[];
  snapshots: Array<{ tick: number; mode: string }>;
};

function recordingHost(over: Partial<SessionEventHost> = {}): {
  host: SessionEventHost;
  trace: Trace;
} {
  const trace: Trace = {
    seated: 0,
    dropped: [],
    marked: [],
    ready: [],
    heartbeats: 0,
    forgottenInput: [],
    forgottenPose: [],
    handleInput: [],
    handleReload: [],
    loaded: [],
    snapshots: [],
  };
  const loaded = new Set<string>();
  const players = {
    tick: 9,
    getBySocket: (socketId: string) =>
      socketId === "gone"
        ? undefined
        : { id: "p1", isBot: false, observeRtt() {} },
    createSnapshot: (tick: number, mode = "motion") => {
      trace.snapshots.push({ tick, mode });
      return { tick, mode };
    },
    getCollision: () => ({ collision: true }),
    isMatchOver: () => false,
    markConnectionIssue: (id: string) => {
      trace.marked.push(id);
      return true;
    },
  };
  const poses = {
    ensure: (socketId: string) => ({ socketId }),
    stamp: (_mirror: unknown, snap: unknown) => snap,
    sendRequestedHeartbeat: () => {
      trace.heartbeats += 1;
    },
    forget: (socketId: string) => {
      trace.forgottenPose.push(socketId);
    },
  };
  const inputRate = {
    allow: () => true,
    forget: (socketId: string) => {
      trace.forgottenInput.push(socketId);
    },
  };
  const sinks = {
    handleInput: (playerId: string) => {
      trace.handleInput.push(playerId);
    },
    handleReload: (playerId: string) => {
      trace.handleReload.push(playerId);
    },
    enqueueHumanWeapon: () => {},
    handleWeaponSwitch: () => {},
    handleAbility: () => {},
    handleSkillLoadout: () => {},
    volDropPctFor: () => undefined,
  };
  const host: SessionEventHost = {
    authenticateJoin: () => Promise.resolve({ ok: false, error: "unset" }),
    welcomePayloadSpectator: (socketId) => ({ spectator: socketId }),
    welcomePayload: (playerId) => ({ playerId }),
    seatPlayer: () => {
      trace.seated += 1;
      return null;
    },
    tickCount: () => 11,
    loopReady: () => true,
    simNowMs: () => 50,
    players: players as unknown as PlayerManager,
    poses: poses as unknown as PoseStream,
    inputRate: inputRate as unknown as InputRateLimiter,
    ingressSinks: () => sinks as unknown as SimIngressSinks,
    mapVote: { cast: () => null } as unknown as MapVote,
    teamRebalance: {
      handleChangeTeam: () => ({ ok: true }),
      handleVote: () => ({ ok: true }),
    } as unknown as TeamRebalance,
    authorityTokenPublicKeys: {} as AuthorityPublicKeys,
    rankedServerId: "open",
    adminCommandHost: () => ({}) as AdminCommandHost,
    raid: () => null,
    raidLoadedPlayerIds: () => loaded,
    handleMatchReady: (id, ready) => {
      trace.ready.push({ id, ready });
    },
    dropPlayer: (id) => {
      trace.dropped.push(id);
    },
    ...over,
  };
  return { host, trace };
}

function seated(opts: Partial<SeatedPlayer> = {}): SeatedPlayer {
  const player = {
    id: "p1",
    toSnapshot: (
      tick?: number,
      mode?: string,
      collision?: unknown,
    ) => ({ id: "p1", tick, mode, collision }),
  } as unknown as Player;
  return {
    player,
    reclaimed: false,
    respawnedOnReclaim: false,
    ...opts,
  };
}

Deno.test("authenticate maps an admit and turns a throw into AuthInvalid", async () => {
  const admitted: AdmittedJoin = { ok: true, name: "Ada" };
  const { host } = recordingHost({
    authenticateJoin: () => Promise.resolve(admitted),
  });
  const wired = fakeHub();
  registerSessionEvents(wired.hub, host);
  assertEquals(
    await wired.authenticate({}),
    { ok: true, data: sessionDataFromJoin(admitted) },
  );

  const refused = fakeHub();
  registerSessionEvents(
    refused.hub,
    recordingHost({
      authenticateJoin: () => Promise.resolve({ ok: false, error: "nope" }),
    }).host,
  );
  assertEquals(await refused.authenticate({}), { ok: false, error: "nope" });

  const thrown = fakeHub();
  registerSessionEvents(
    thrown.hub,
    recordingHost({
      authenticateJoin: () => {
        throw new Error("boom");
      },
    }).host,
  );
  assertEquals(
    await thrown.authenticate({}),
    { ok: false, error: JoinErrors.AuthInvalid },
  );
});

Deno.test("a spectator is welcomed and never seated", () => {
  const { host, trace } = recordingHost();
  const wired = fakeHub();
  registerSessionEvents(wired.hub, host);
  const spec = fakeSession("spec", {
    isSpectator: true,
    accountUserId: "acct",
  });
  wired.connect(spec.session);
  assertEquals(trace.seated, 0);
  assertEquals(spec.sent[0], {
    event: NetEvents.Welcome,
    payload: { spectator: "spec" },
  });
  spec.ons.get(NetEvents.Ready)?.();
  assertEquals(spec.sent.at(-1), {
    event: NetEvents.Snapshot,
    payload: { tick: 11, mode: "full" },
  });
  host.loopReady = () => false;
  spec.ons.get(NetEvents.RequestPoseHeartbeat)?.();
  assertEquals(trace.heartbeats, 0);
  host.loopReady = () => true;
  spec.ons.get(NetEvents.RequestPoseHeartbeat)?.();
  assertEquals(trace.heartbeats, 1);
  spec.ons.get(NetEvents.Disconnect)?.();
  assertEquals(trace.forgottenInput, ["spec"]);
  assertEquals(trace.forgottenPose, ["spec"]);
});

Deno.test("a refused seat binds no handlers and sends no welcome", () => {
  const { host, trace } = recordingHost();
  const wired = fakeHub();
  registerSessionEvents(wired.hub, host);
  const joiner = fakeSession("sock", { playerName: "Ada" });
  wired.connect(joiner.session);
  assertEquals(trace.seated, 1);
  assertEquals(joiner.sent, []);
  assertEquals(joiner.ons.size, 0);
});

Deno.test("a fresh seat announces once and routes input through ingress", () => {
  const { host, trace } = recordingHost({
    seatPlayer: () => seated(),
  });
  const wired = fakeHub();
  const other = fakeSession("other");
  wired.members.push(other.session);
  registerSessionEvents(wired.hub, host);
  const joiner = fakeSession("sock", { playerName: "Ada" });
  wired.members.push(joiner.session);
  wired.connect(joiner.session);

  assertEquals(joiner.sent[0]?.event, NetEvents.Welcome);
  assertEquals(other.sent, [{
    event: NetEvents.PlayerJoined,
    payload: {
      id: "p1",
      tick: 9,
      mode: "full",
      collision: { collision: true },
    },
  }]);
  assertEquals(
    joiner.sent.some((packet) => packet.event === NetEvents.PlayerJoined),
    false,
  );

  joiner.ons.get(NetEvents.Input)?.({
    sequence: 1,
    yaw: 0,
    pitch: 0,
  });
  assertEquals(trace.handleInput, ["p1"]);
  joiner.ons.get(NetEvents.Reload)?.();
  assertEquals(trace.handleReload, ["p1"]);
  joiner.ons.get(NetEvents.MatchReady)?.({ ready: false });
  assertEquals(trace.ready, [{ id: "p1", ready: false }]);
});

Deno.test("a reclaim announces restore and respawn without PlayerJoined", () => {
  const { host } = recordingHost({
    seatPlayer: () => seated({ reclaimed: true, respawnedOnReclaim: true }),
  });
  const wired = fakeHub();
  const other = fakeSession("other");
  wired.members.push(other.session);
  registerSessionEvents(wired.hub, host);
  const joiner = fakeSession("sock");
  wired.connect(joiner.session);
  assertEquals(wired.emitted.map((packet) => packet.event), [
    NetEvents.PlayerConnectionRestored,
    NetEvents.PlayerRespawned,
  ]);
  assertEquals(other.sent, []);
});

Deno.test("disconnect drops a clean close and marks a transport drop", () => {
  const { host, trace } = recordingHost({
    seatPlayer: () => seated(),
  });
  const wired = fakeHub();
  registerSessionEvents(wired.hub, host);

  const leave = fakeSession("sock");
  wired.connect(leave.session);
  leave.ons.get(NetEvents.Leave)?.();
  assertEquals(leave.session.data.intentionalLeave, true);
  assertEquals(trace.dropped, ["p1"]);
  assertEquals(leave.trace.disconnected, true);

  const clean = fakeSession("sock");
  wired.connect(clean.session);
  clean.ons.get(NetEvents.Disconnect)?.(SOCKET_IO_CLIENT_DISCONNECT);
  assertEquals(trace.dropped, ["p1", "p1"]);
  assertEquals(trace.marked, []);

  const blip = fakeSession("sock");
  wired.connect(blip.session);
  blip.ons.get(NetEvents.Disconnect)?.("transport close");
  assertEquals(trace.marked, ["p1"]);
  assertEquals(wired.emitted.at(-1), {
    event: NetEvents.PlayerConnectionIssue,
    payload: {
      id: "p1",
      timeoutSeconds: Math.ceil(CONNECTION_ISSUE_TIMEOUT_MS / 1000),
    },
  });

  const gone = fakeSession("gone");
  host.players = {
    getBySocket: () => undefined,
  } as unknown as PlayerManager;
  wired.connect(gone.session);
  gone.ons.get(NetEvents.Disconnect)?.("transport close");
  assertEquals(trace.marked, ["p1"]);

  const intentional = fakeSession("sock");
  host.players = {
    getBySocket: () => ({ id: "p1", isBot: false }),
    markConnectionIssue: (id: string) => {
      trace.marked.push(id);
      return true;
    },
  } as unknown as PlayerManager;
  wired.connect(intentional.session);
  intentional.session.data.intentionalLeave = true;
  intentional.ons.get(NetEvents.Disconnect)?.("transport close");
  assertEquals(trace.marked, ["p1"]);
  assertEquals(trace.forgottenInput.at(-1), "sock");
});

Deno.test("map loaded notes the player only before the raid starts", () => {
  const loaded = new Set<string>();
  let started = false;
  const { host } = recordingHost({
    seatPlayer: () => seated(),
    raid: () => ({ started }) as RaidMatch,
    raidLoadedPlayerIds: () => loaded,
  });
  const wired = fakeHub();
  registerSessionEvents(wired.hub, host);
  const joiner = fakeSession("sock");
  wired.connect(joiner.session);
  joiner.ons.get(NetEvents.MapLoaded)?.();
  assertEquals([...loaded], ["p1"]);
  started = true;
  joiner.ons.get(NetEvents.MapLoaded)?.();
  assertEquals([...loaded], ["p1"]);
});

Deno.test("a missing roster id refuses a team change", () => {
  const { host } = recordingHost({
    seatPlayer: () => seated(),
    players: {
      getBySocket: () => undefined,
      isMatchOver: () => false,
    } as unknown as PlayerManager,
  });
  const wired = fakeHub();
  registerSessionEvents(wired.hub, host);
  const joiner = fakeSession("sock");
  wired.connect(joiner.session);
  joiner.ons.get(NetEvents.ChangeTeam)?.({});
  assertEquals(joiner.sent.at(-1), {
    event: NetEvents.ChangeTeamResult,
    payload: { ok: false, error: "Not in match." },
  });
  joiner.ons.get(NetEvents.TeamRebalanceVote)?.({});
  assertEquals(joiner.sent.at(-1), {
    event: NetEvents.TeamRebalanceVoteResult,
    payload: { ok: false, error: "Not in match." },
  });
});

Deno.test("session event source-scan: wiring delegates, handlers stay on one file", () => {
  const events = stripComments(readRepoSource("runtime/sessionEvents.ts"));
  assertEquals(/from\s+["'][^"']*GameServer/.test(events), false);
  const wiringBody = events.slice(
    events.indexOf("export function registerSessionEvents"),
  );
  const seatAt = wiringBody.indexOf("host.seatPlayer(");
  const announceAt = wiringBody.indexOf("announceSeated(");
  const bindAt = wiringBody.indexOf("bindPlayerHandlers(");
  const spectatorAt = wiringBody.indexOf("onSpectatorConnect(");
  assertEquals(
    spectatorAt >= 0 && spectatorAt < seatAt && announceAt > seatAt &&
      bindAt > announceAt,
    true,
  );
  for (
    const name of [
      "ingressMovementInput",
      "ingressShoot",
      "ingressMelee",
      "ingressReload",
      "ingressWeaponSwitch",
      "ingressAbility",
      "ingressSkillLoadout",
    ]
  ) {
    assertEquals(events.includes(name), true, name);
  }
  assertEquals(/^function parsePlayerInput\b/m.test(events), false);

  const server = stripComments(readRepoSource("runtime/GameServer.ts"));
  const wiring = methodBody(server, "registerEvents");
  assertEquals(wiring.includes("registerSessionEvents("), true);
  assertEquals(wiring.includes("ingressMovementInput"), false);
  assertEquals(wiring.includes("session.on("), false);
});
