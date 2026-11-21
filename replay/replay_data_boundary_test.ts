/**
 * Epic 20.3 — replay data boundaries.
 *
 * Run from server-community/:
 *   deno test -A --unstable-net --node-modules-dir=manual replay/replay_data_boundary_test.ts
 */

import { assertEquals, assertThrows } from "@std/assert";
import { ReplayFormatVersionError } from "../shared/replay/replayFormatVersion.ts";
import { encodeCatalogFixture } from "./replayCatalogFixture.ts";
import { decodeReplayContainer, encodeReplayContainer } from "./replayEncoding.ts";
import { loadReplay } from "./replayLoader.ts";
import { createReplayPlayback } from "./replayPlaybackSession.ts";
import {
  acceptReplayBytes,
  REPLAY_VALIDATION_REJECTED,
  ReplayValidationError,
} from "./replayValidation.ts";
import {
  assertReplayDataBoundary,
  REPLAY_ACCOUNT_KEYS,
  REPLAY_DATA_BOUNDARY,
  REPLAY_PLAYER_IDENTITY_KEYS,
  ReplayDataBoundaryError,
} from "./replayDataBoundary.ts";

const text = new TextEncoder();

function catalogDoc(): Record<string, unknown> {
  return JSON.parse(
    new TextDecoder().decode(encodeCatalogFixture().bytes),
  ) as Record<string, unknown>;
}

function bytesOf(doc: Record<string, unknown>): Uint8Array {
  return text.encode(JSON.stringify(doc));
}

Deno.test("20.3 a clean file keeps id and name and still round-trips", () => {
  assertEquals(REPLAY_PLAYER_IDENTITY_KEYS, ["id", "name"]);
  const { container, bytes } = encodeCatalogFixture();
  const session = loadReplay(bytes);
  assertEquals(decodeReplayContainer(bytes), container);
  assertEquals(session.initialState.init.roster[0]!.id, "p1");
  assertEquals(session.initialState.init.roster[0]!.name, "P1");
  assertEquals(session.integrityStatus, "unverified");
  assertReplayDataBoundary({ id: "sock-1", name: "ada@example.com" });
});

Deno.test("20.3 a display name that looks like an email still loads", () => {
  const doc = catalogDoc();
  const init = doc.initialState as {
    init: { roster: Array<{ name: string }> };
    metadata: { roster: Array<{ name: string }> };
  };
  init.init.roster[0]!.name = "ada@example.com";
  init.metadata.roster[0]!.name = "ada@example.com";
  const session = loadReplay(bytesOf(doc));
  assertEquals(session.initialState.init.roster[0]!.name, "ada@example.com");
  assertEquals(session.initialState.init.roster[0]!.id, "p1");
});

Deno.test("20.3 account keys are rejected and do not become a session", () => {
  for (const key of REPLAY_ACCOUNT_KEYS) {
    const doc = catalogDoc();
    (doc.metadata as Record<string, unknown>)[key] = "user_1";
    const bytes = bytesOf(doc);
    const before = bytes.slice();
    const loaded = assertThrows(
      () => loadReplay(bytes),
      ReplayDataBoundaryError,
      undefined,
      key,
    );
    assertEquals(loaded.code, REPLAY_DATA_BOUNDARY, key);
    assertEquals(loaded.key, key, key);
    assertEquals(loaded.path, `metadata.${key}`, key);
    assertEquals(bytes, before, key);

    const wrapped = assertThrows(
      () => acceptReplayBytes(bytes),
      ReplayValidationError,
      undefined,
      key,
    );
    assertEquals(wrapped.code, REPLAY_VALIDATION_REJECTED, key);
    assertEquals(wrapped.kind, "invalid", key);
    assertEquals(wrapped.reason, REPLAY_DATA_BOUNDARY, key);
    assertEquals(wrapped.cause instanceof ReplayDataBoundaryError, true, key);
  }
});

Deno.test("20.3 a nested account key is rejected with its path", () => {
  const doc = catalogDoc();
  const roster = ((doc.initialState as {
    init: { roster: Array<Record<string, unknown>> };
  }).init.roster);
  roster[0]!.accountUserId = "user_real";
  const err = assertThrows(
    () => loadReplay(bytesOf(doc)),
    ReplayDataBoundaryError,
  );
  assertEquals(err.key, "accountUserId");
  assertEquals(err.path, "initialState.init.roster[0].accountUserId");
});

Deno.test("20.3 socketId may be null or absent, and a value is rejected", () => {
  assertReplayDataBoundary({ socketId: null, id: "p1", name: "Ada" });
  assertReplayDataBoundary({ id: "p1", name: "Ada" });

  const absent = catalogDoc();
  assertEquals(loadReplay(bytesOf(absent)).header.runtimeMatchId, "rt-encoding-1");

  const nulled = catalogDoc();
  (nulled.metadata as Record<string, unknown>).socketId = null;
  assertEquals(loadReplay(bytesOf(nulled)).header.runtimeMatchId, "rt-encoding-1");

  for (const value of ["sock-live", "", 1]) {
    const doc = catalogDoc();
    const events = doc.eventStream as Array<Record<string, unknown>>;
    events.push({
      tick: 12,
      events: [{ kind: "connectionStatus", socketId: value, playerId: "p1" }],
    });
    const err = assertThrows(
      () => loadReplay(bytesOf(doc)),
      ReplayDataBoundaryError,
      undefined,
      String(value),
    );
    assertEquals(err.key, "socketId");
    assertEquals(err.path, "eventStream[3].events[0].socketId");
  }
});

Deno.test("20.3 encode refuses a live socket or an account key and does not mutate", () => {
  const { container } = encodeCatalogFixture();
  const withAccount = {
    ...container,
    metadata: { ...container.metadata, accountUserId: "user_1" },
  };
  const beforeAccount = structuredClone(withAccount);
  const accountErr = assertThrows(
    () => encodeReplayContainer(withAccount),
    ReplayDataBoundaryError,
  );
  assertEquals(accountErr.key, "accountUserId");
  assertEquals(withAccount, beforeAccount);

  const withSocket = {
    ...container,
    eventStream: container.eventStream.map((row, i) => {
      if (i !== 1) return row;
      return {
        ...row,
        events: [{ ...row.events[0]!, socketId: "sock-live" }, ...row.events.slice(1)],
      };
    }),
  };
  const beforeSocket = structuredClone(withSocket);
  const socketErr = assertThrows(
    () => encodeReplayContainer(withSocket),
    ReplayDataBoundaryError,
  );
  assertEquals(socketErr.key, "socketId");
  assertEquals(withSocket, beforeSocket);
});

Deno.test("20.3 playback wraps the boundary, and a bad version still wins", () => {
  const doc = catalogDoc();
  (doc.metadata as Record<string, unknown>).clerkUserId = "user_1";
  const err = assertThrows(
    () => createReplayPlayback(bytesOf(doc), null as never),
    ReplayValidationError,
  );
  assertEquals(err.kind, "invalid");
  assertEquals(err.reason, REPLAY_DATA_BOUNDARY);

  const version = text.encode(
    '{"header":{"replayFormatVersion":2},"metadata":{"accountUserId":"user_1"}}',
  );
  const rejected = assertThrows(
    () => loadReplay(version),
    ReplayFormatVersionError,
  );
  assertEquals(rejected.code, "replay-version-mismatch");
});

Deno.test("20.3 the boundary walks the file and does not hash or store", async () => {
  const src = await Deno.readTextFile(
    new URL("./replayDataBoundary.ts", import.meta.url),
  );
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assertEquals(/^\s*import\s/m.test(code), false);
  assertEquals(/\bDeno\./.test(code), false);
  assertEquals(/subtle\.digest|sha256|GameServer|quarantine|JSON\.stringify/.test(code), false);
  for (const key of REPLAY_ACCOUNT_KEYS) {
    assertEquals(code.includes(`"${key}"`), true, key);
  }
  assertEquals(code.includes('"socketId"'), true);

  const encoding = await Deno.readTextFile(
    new URL("./replayEncoding.ts", import.meta.url),
  );
  const encodingCode = encoding
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  const encode = encodingCode.slice(
    encodingCode.indexOf("export function encodeReplayContainer"),
    encodingCode.indexOf("function decodeUtf8"),
  );
  assertEquals(encode.includes("assertReplayDataBoundary"), true);
  assertEquals(
    encode.indexOf("assertReplayDataBoundary") < encode.indexOf("JSON.stringify"),
    true,
  );
  const decode = encodingCode.slice(
    encodingCode.indexOf("export function decodeReplayContainer"),
  );
  assertEquals(
    decode.indexOf("readReplayFormatVersion") <
      decode.indexOf("assertReplayDataBoundary"),
    true,
  );
  assertEquals(
    decode.indexOf("assertReplayDataBoundary") < decode.indexOf("projectMetadata"),
    true,
  );
});
