/**
 * Raid activation waits until the connection is seated.
 * A refused join leaves the slot idle.
 */
import { assertEquals } from "@std/assert";
import { NoopAuthorityAdapter } from "../authority/adapter.ts";
import { JoinErrors } from "../protocol/network.ts";
import { GAME_PROTO } from "../shared/net/opcodes.ts";
import { issueRankedJoinToken } from "../shared/authority/tokenIssuer.ts";
import type { DoorsMap } from "../world/map.ts";
import { MapCollision } from "../world/MapCollision.ts";
import { GameServer } from "./GameServer.ts";
import {
  methodBody,
  readRepoSource,
  serverInternals,
  stripComments,
} from "./gameServerTestHarness.ts";

const miniMap: DoorsMap = {
  name: "Crossroads",
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

function base64(value: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function keys() {
  const pair = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  return {
    privateKey: base64(
      await crypto.subtle.exportKey("pkcs8", pair.privateKey),
    ),
    publicKeys: {
      current: base64(await crypto.subtle.exportKey("spki", pair.publicKey)),
    },
  };
}

function raidServer(
  name: string,
  publicKeys: { current: string },
  opts?: { releaseLocked?: boolean },
) {
  const server = new GameServer({
    name,
    port: 0,
    host: "127.0.0.1",
    map: miniMap,
    collision: new MapCollision(miniMap),
    autofillBots: 0,
    noBotsOnEmptyServer: true,
    joinMode: "open",
    rankedServerId: "raid",
    modeId: "raid",
    authorityTokenPublicKeys: publicKeys,
    authorityAdapter: new NoopAuthorityAdapter(),
    botThinkEngine: null,
    releaseLocked: opts?.releaseLocked,
  });
  return serverInternals(server);
}

type RaidClaims = {
  team?: "A" | "B";
  raidId?: string;
  partySize?: number;
  soloRaid?: boolean;
};

function seatSession(raidJoin: RaidClaims) {
  const trace = {
    disconnected: false,
    sent: [] as { event: string; payload: unknown }[],
  };
  const session = {
    data: { raidJoin },
    emit(event: string, payload?: unknown) {
      trace.sent.push({ event, payload });
    },
    disconnect() {
      trace.disconnected = true;
    },
  };
  return { trace, session };
}

Deno.test("a refused raid join leaves the slot idle", async () => {
  const key = await keys();

  const taken = raidServer("raid-seat-name-taken", key.publicKeys);
  const takenBefore = taken.runtimeMatchId;
  taken.players.add("resident", "Raider", "A", { accountUserId: "other" });
  const takenToken = await issueRankedJoinToken(
    {
      sub: "user_taken",
      username: "Raider",
      serverId: "raid",
      matchKind: "raid",
      modeId: "raid",
      team: "A",
      raidId: "crossroads",
      partySize: 2,
    },
    key.privateKey,
    "current",
  );
  assertEquals(
    await taken.authenticateJoin({
      proto: GAME_PROTO,
      joinToken: takenToken.joinToken,
    }),
    { ok: false, error: JoinErrors.NameTaken },
  );
  assertEquals(taken.raid, null);
  assertEquals(taken.runtimeMatchId, takenBefore);

  const replay = raidServer("raid-seat-replay", key.publicKeys);
  const replayBefore = replay.runtimeMatchId;
  const replayToken = await issueRankedJoinToken(
    {
      sub: "user_replay",
      username: "Replay",
      serverId: "raid",
      matchKind: "raid",
      modeId: "raid",
      team: "A",
      raidId: "crossroads",
      partyId: "party-replay",
      partySize: 2,
      assignmentId: "asg_replay",
    },
    key.privateKey,
    "current",
  );
  const replayJti = replayToken.jti;
  if (!replayJti) throw new Error("assignment token missing jti");
  const replayOther = await issueRankedJoinToken(
    {
      sub: "user_replay_other",
      username: "Other",
      serverId: "raid",
      matchKind: "raid",
      modeId: "raid",
      team: "A",
      raidId: "crossroads",
      partyId: "party-replay",
      partySize: 2,
      assignmentId: "asg_replay",
      jti: replayJti,
    },
    key.privateKey,
    "current",
  );
  const first = await replay.authenticateJoin({
    proto: GAME_PROTO,
    joinToken: replayToken.joinToken,
  });
  assertEquals(first.ok, true);
  assertEquals(replay.raid, null);
  assertEquals(replay.runtimeMatchId, replayBefore);
  assertEquals(
    await replay.authenticateJoin({
      proto: GAME_PROTO,
      joinToken: replayOther.joinToken,
    }),
    { ok: false, error: JoinErrors.AdmissionReplay },
  );
  assertEquals(replay.raid, null);
  assertEquals(replay.runtimeMatchId, replayBefore);

  const draining = raidServer("raid-seat-draining", key.publicKeys, {
    releaseLocked: true,
  });
  const drainingBefore = draining.runtimeMatchId;
  const drainingToken = await issueRankedJoinToken(
    {
      sub: "user_drain",
      username: "Drain",
      serverId: "raid",
      matchKind: "raid",
      modeId: "raid",
      team: "A",
      raidId: "crossroads",
      partySize: 2,
    },
    key.privateKey,
    "current",
  );
  assertEquals(
    await draining.authenticateJoin({
      proto: GAME_PROTO,
      joinToken: drainingToken.joinToken,
    }),
    { ok: false, error: JoinErrors.ServerDraining },
  );
  assertEquals(draining.raid, null);
  assertEquals(draining.runtimeMatchId, drainingBefore);
});

Deno.test("a 2-member party authenticates twice, seats twice, and activates once", async () => {
  const key = await keys();
  const internals = raidServer("raid-seat-party", key.publicKeys);
  const before = internals.runtimeMatchId;
  const issued = await Promise.all([
    issueRankedJoinToken(
      {
        sub: "user_a",
        username: "Alpha",
        serverId: "raid",
        matchKind: "raid",
        modeId: "raid",
        team: "A",
        raidId: "crossroads",
        partyId: "party-1",
        partySize: 2,
      },
      key.privateKey,
      "current",
    ),
    issueRankedJoinToken(
      {
        sub: "user_b",
        username: "Bravo",
        serverId: "raid",
        matchKind: "raid",
        modeId: "raid",
        team: "A",
        raidId: "crossroads",
        partyId: "party-1",
        partySize: 2,
      },
      key.privateKey,
      "current",
    ),
  ]);
  const authed = [];
  for (const token of issued) {
    const auth = await internals.authenticateJoin({
      proto: GAME_PROTO,
      joinToken: token.joinToken,
    });
    assertEquals(auth.ok, true);
    if (!auth.ok) return;
    authed.push(auth.raidJoin);
  }
  assertEquals(internals.raid, null);
  assertEquals(internals.runtimeMatchId, before);

  const first = seatSession(authed[0]!);
  assertEquals(internals.commitRaidJoin(first.session), true);
  const activated = internals.raid;
  const activatedId = internals.runtimeMatchId;
  assertEquals(activated != null, true);
  assertEquals(activated?.expectedHumans, 2);
  internals.players.add("sock-a", "Alpha", "A", {
    accountUserId: "user_a",
    partyId: "party-1",
    partySize: 2,
  });

  const second = seatSession(authed[1]!);
  assertEquals(internals.commitRaidJoin(second.session), true);
  assertEquals(internals.raid, activated);
  assertEquals(internals.runtimeMatchId, activatedId);
  assertEquals(internals.raid?.expectedHumans, 2);
  internals.players.add("sock-b", "Bravo", "A", {
    accountUserId: "user_b",
    partyId: "party-1",
    partySize: 2,
  });
  assertEquals(internals.players.humanCount(), 2);
  assertEquals(first.trace.disconnected, false);
  assertEquals(second.trace.disconnected, false);
});

Deno.test("a conflicting raid token is refused at seat time", async () => {
  const key = await keys();
  const internals = raidServer("raid-seat-conflict", key.publicKeys);
  const tokens = await Promise.all([
    issueRankedJoinToken(
      {
        sub: "user_a",
        username: "Alpha",
        serverId: "raid",
        matchKind: "raid",
        modeId: "raid",
        team: "A",
        raidId: "crossroads",
        partyId: "party-a",
        partySize: 2,
      },
      key.privateKey,
      "current",
    ),
    issueRankedJoinToken(
      {
        sub: "user_b",
        username: "Bravo",
        serverId: "raid",
        matchKind: "raid",
        modeId: "raid",
        team: "B",
        raidId: "other-raid",
        partyId: "party-b",
        partySize: 2,
      },
      key.privateKey,
      "current",
    ),
  ]);
  const claims = [];
  for (const token of tokens) {
    const auth = await internals.authenticateJoin({
      proto: GAME_PROTO,
      joinToken: token.joinToken,
    });
    assertEquals(auth.ok, true);
    if (!auth.ok) return;
    claims.push(auth.raidJoin);
  }
  assertEquals(internals.raid, null);

  const first = seatSession(claims[0]!);
  assertEquals(internals.commitRaidJoin(first.session), true);
  const identity = internals.runtimeMatchId;
  internals.players.add("sock-a", "Alpha", "A", { accountUserId: "user_a" });

  const second = seatSession(claims[1]!);
  assertEquals(internals.commitRaidJoin(second.session), false);
  assertEquals(second.trace.disconnected, true);
  assertEquals(second.trace.sent, [{
    event: "error",
    payload: { message: JoinErrors.AuthInvalid },
  }]);
  assertEquals(internals.runtimeMatchId, identity);
  assertEquals(internals.players.humanCount(), 1);
  assertEquals(internals.raid?.expectedHumans, 2);
});

Deno.test("a reclaim seat raises the party and does not rotate identity", async () => {
  const key = await keys();
  const internals = raidServer("raid-seat-reclaim", key.publicKeys);
  const issued = await issueRankedJoinToken(
    {
      sub: "user_a",
      username: "Alpha",
      serverId: "raid",
      matchKind: "raid",
      modeId: "raid",
      team: "A",
      raidId: "crossroads",
      partyId: "party-1",
      partySize: 4,
    },
    key.privateKey,
    "current",
  );
  const auth = await internals.authenticateJoin({
    proto: GAME_PROTO,
    joinToken: issued.joinToken,
  });
  assertEquals(auth.ok, true);
  if (!auth.ok || !auth.raidJoin) return;
  const opening = seatSession({ ...auth.raidJoin, partySize: 2 });
  assertEquals(internals.commitRaidJoin(opening.session), true);
  const identity = internals.runtimeMatchId;
  const reclaim = seatSession(auth.raidJoin);
  assertEquals(internals.commitRaidJoin(reclaim.session), true);
  assertEquals(internals.runtimeMatchId, identity);
  assertEquals(internals.raid?.expectedHumans, 4);
  assertEquals(reclaim.trace.disconnected, false);
});

Deno.test("raid seat source-scan: auth carries claims, connect commits first", () => {
  const auth = stripComments(readRepoSource("runtime/joinAuth.ts"));
  assertEquals(auth.includes("activateRaidFromJoin"), false);

  const server = stripComments(readRepoSource("runtime/GameServer.ts"));
  const seat = methodBody(server, "seatPlayer");
  const gate = seat.indexOf("this.commitRaidJoin(");
  const team = seat.indexOf("this.raid.humanTeam");
  assertEquals(gate >= 0 && team > gate, true);

  const body = methodBody(server, "commitRaidJoin");
  const conflict = body.indexOf("raidJoinConflict");
  const disconnect = body.indexOf("disconnect()");
  const activate = body.indexOf("activateRaidFromJoin");
  assertEquals(
    conflict >= 0 && disconnect > conflict && activate > disconnect,
    true,
  );
});
