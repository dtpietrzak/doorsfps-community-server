/**
 * Epic 20.4 — access control.
 *
 * Run from server-community/:
 *   deno test -A --unstable-net --node-modules-dir=manual replay/replay_access_test.ts
 */

import { assertEquals } from "@std/assert";
import { GameServer } from "../runtime/GameServer.ts";
import { NoopAuthorityAdapter } from "../authority/adapter.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";
import { serverInternals, driveTick } from "../runtime/gameServerTestHarness.ts";
import {
  InMemoryReplayLifecycleClient,
} from "./replayLifecycleClient.ts";
import {
  assignReplayAccess,
  collectReplayAccessAccounts,
  normalizeReplayAccountId,
  parseReplayAccessHeader,
  REPLAY_ACCESS_ACCOUNT_CAP,
  REPLAY_ACCESS_HEADER,
  replayAccessAccountId,
  replayAccessAudience,
  replayAccessHeaderValue,
  replayAccessRole,
  replayReadAllowed,
} from "./replayAccess.ts";
import { replayBlobObjectName } from "./ReplayBlobStore.ts";
import {
  settleRecorder,
  wireReplayRecorder,
} from "./replayTestHarness.ts";

Deno.test("20.4 account ids trim, and a blank or huge value is not an account", () => {
  assertEquals(normalizeReplayAccountId("  user_a  "), "user_a");
  assertEquals(normalizeReplayAccountId(""), null);
  assertEquals(normalizeReplayAccountId("   "), null);
  assertEquals(normalizeReplayAccountId(12), null);
  assertEquals(normalizeReplayAccountId("user_a\0"), null);
  assertEquals(normalizeReplayAccountId("x".repeat(129)), null);
  assertEquals(normalizeReplayAccountId("x".repeat(128)), "x".repeat(128));
});

Deno.test("20.4 grants skip bots, agents, synthetics, pawns, and guests", () => {
  assertEquals(
    replayAccessAccountId({ accountUserId: " user_a " }),
    "user_a",
  );
  assertEquals(
    replayAccessAccountId({ accountUserId: "user_bot", isBot: true }),
    null,
  );
  assertEquals(
    replayAccessAccountId({ accountUserId: "user_agent", isAgent: true }),
    null,
  );
  assertEquals(
    replayAccessAccountId({ accountUserId: "user_syn", synthetic: true }),
    null,
  );
  assertEquals(
    replayAccessAccountId({ accountUserId: "user_pawn", poolAccount: true }),
    null,
  );
  assertEquals(replayAccessAccountId({ accountUserId: null }), null);
  assertEquals(
    collectReplayAccessAccounts([
      { accountUserId: "user_b" },
      { accountUserId: "user_a" },
      { accountUserId: "user_a" },
      { accountUserId: "user_bot", isBot: true },
      { accountUserId: null },
    ]),
    ["user_a", "user_b"],
  );
});

Deno.test("20.4 assignment is sorted, capped, and order-independent", () => {
  assertEquals(assignReplayAccess([" user_b ", "user_a", "user_b", ""]), {
    ownerId: "user_a",
    sharedIds: ["user_b"],
  });
  assertEquals(assignReplayAccess([]), { ownerId: null, sharedIds: [] });
  assertEquals(assignReplayAccess(["", "  "]), {
    ownerId: null,
    sharedIds: [],
  });
  const many = Array.from(
    { length: REPLAY_ACCESS_ACCOUNT_CAP + 5 },
    (_, i) => `user_${String(i).padStart(3, "0")}`,
  );
  const assigned = assignReplayAccess(many.reverse());
  assertEquals(assigned.ownerId, "user_000");
  assertEquals(assigned.sharedIds.length, REPLAY_ACCESS_ACCOUNT_CAP - 1);
  assertEquals(assigned.sharedIds[assigned.sharedIds.length - 1], "user_063");
});

Deno.test("20.4 header round-trips, and a bad header does not stamp", () => {
  assertEquals(replayAccessHeaderValue(undefined), null);
  assertEquals(replayAccessHeaderValue([]), null);
  const raw = replayAccessHeaderValue(["user_a", "user_b"]);
  assertEquals(raw, '["user_a","user_b"]');
  assertEquals(parseReplayAccessHeader(raw), ["user_a", "user_b"]);
  assertEquals(parseReplayAccessHeader(null), null);
  assertEquals(parseReplayAccessHeader(""), null);
  assertEquals(parseReplayAccessHeader("not-json"), null);
  assertEquals(parseReplayAccessHeader('{"owner":"user_a"}'), null);
  assertEquals(parseReplayAccessHeader("x".repeat(9000)), null);
  assertEquals(REPLAY_ACCESS_HEADER, "x-doors-replay-access");
});

Deno.test("20.4 owner and shared read private; a stranger needs the link; deleted is closed", () => {
  assertEquals(replayAccessAudience("owner"), "owner");
  assertEquals(replayAccessAudience("shared"), "owner");
  assertEquals(replayAccessAudience("stranger"), "link");

  assertEquals(
    replayAccessRole({
      callerAccountId: " user_a ",
      ownerAccountId: "user_a",
      sharedAccountIds: ["user_b"],
    }),
    "owner",
  );
  assertEquals(
    replayAccessRole({
      callerAccountId: "user_b",
      ownerAccountId: "user_a",
      sharedAccountIds: ["user_b"],
    }),
    "shared",
  );
  assertEquals(
    replayAccessRole({
      callerAccountId: "user_c",
      ownerAccountId: "user_a",
      sharedAccountIds: ["user_b"],
    }),
    "stranger",
  );
  assertEquals(
    replayAccessRole({
      callerAccountId: null,
      ownerAccountId: "user_a",
      sharedAccountIds: ["user_b"],
    }),
    "stranger",
  );

  for (const role of ["owner", "shared"] as const) {
    assertEquals(replayReadAllowed("private", role), true);
    assertEquals(replayReadAllowed("unlisted", role), true);
    assertEquals(replayReadAllowed("public", role), true);
    assertEquals(replayReadAllowed("deleted", role), false);
  }
  assertEquals(replayReadAllowed("private", "stranger"), false);
  assertEquals(replayReadAllowed("unlisted", "stranger"), true);
  assertEquals(replayReadAllowed("public", "stranger"), true);
  assertEquals(replayReadAllowed("deleted", "stranger"), false);
});

Deno.test("20.4 source-scan: names the caller, no store or file", async () => {
  const src = await Deno.readTextFile(
    new URL("./replayAccess.ts", import.meta.url),
  );
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (
    const banned of [
      "sqlite",
      "ReplayBlobStore",
      "node:fs",
      "PlayerManager",
      "encodeReplayContainer",
      "Date.now",
      "performance.now",
    ]
  ) {
    assertEquals(code.includes(banned), false, `banned token present: ${banned}`);
  }
  assertEquals(code.includes("replayClipPermission"), true);
  assertEquals(code.includes("REPLAY_ACCESS_HEADER"), true);
});

const miniMap: DoorsMap = {
  name: "replay-access",
  version: 1,
  bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 },
  gridSize: 1,
  walls: [],
  teamA: { corners: [0, 1], edge: "south", doorHalfWidth: 2, spawnRadius: 4 },
  teamB: { corners: [2, 3], edge: "north", doorHalfWidth: 2, spawnRadius: 4 },
};

Deno.test("20.4 finalize forwards real human accounts and the file omits them", async () => {
  const server = new GameServer({
    name: "replay-access",
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
  const internals = serverInternals(server);
  const { recorder, lifecycle, blobDir, blobStore } = wireReplayRecorder({
    attachSink: (sink) => server.attachReplaySink(sink),
    detachSink: () => server.detachReplaySink(),
  });
  const mem = lifecycle as InMemoryReplayLifecycleClient;
  try {
    internals.sessions = { emit: () => {} };
    internals.players.add("s1", "Ada", "A", { accountUserId: "user_owner" });
    internals.players.add("s2", "Bea", "B", { accountUserId: "user_shared" });
    internals.players.add("s3", "Guest", "A");
    const start = internals.players.beginLiveMatch(1, Date.now());
    internals.beginRuntimeMatchIdentity(1);
    internals.emitMatchStart(start, 1);
    await settleRecorder(recorder);
    const matchId = internals.runtimeMatchId;
    driveTick(server, 2);
    internals.onMatchEnded({
      winner: "A",
      scores: { A: 1, B: 0 },
      players: [],
    });
    await settleRecorder(recorder);

    const row = (await mem.getByRuntimeMatchId(matchId))!;
    assertEquals(row.status, "finalized");
    assertEquals(mem.getAccessAccountIds(row.id)?.slice().sort(), [
      "user_owner",
      "user_shared",
    ]);
    const bytes = blobStore?.get(replayBlobObjectName(matchId)) ??
      mem.getMemoryBytes(row.id);
    const text = new TextDecoder().decode(bytes ?? new Uint8Array());
    assertEquals(text.includes("user_owner"), false);
    assertEquals(text.includes("user_shared"), false);
  } finally {
    if (blobDir) {
      try {
        Deno.removeSync(blobDir, { recursive: true });
      } catch {
        // best-effort
      }
    }
  }
});
