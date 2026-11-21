/**
 * Epic 20.2 — replay validation.
 *
 * Run from server-community/:
 *   deno test -A --unstable-net --node-modules-dir=manual replay/replay_validation_test.ts
 */

import { assertEquals, assertThrows } from "@std/assert";
import { ReplayFormatVersionError } from "../shared/replay/replayFormatVersion.ts";
import { encodeCatalogFixture } from "./replayCatalogFixture.ts";
import { ReplayEncodingError } from "./replayEncoding.ts";
import { isLoadedReplay } from "./replayLoader.ts";
import { createReplayPlayback } from "./replayPlaybackSession.ts";
import {
  acceptReplayBytes,
  classifyReplayRejection,
  REPLAY_VALIDATION_REJECTED,
  ReplayValidationError,
} from "./replayValidation.ts";

const text = new TextEncoder();

function coded(code: string): Error {
  const error = new Error(code);
  return Object.assign(error, { code });
}

Deno.test("20.2 malformed bytes are rejected and not a session", () => {
  const cases: Array<[string, Uint8Array, string]> = [
    ["empty", new Uint8Array(0), "replay-truncated"],
    ["bad utf-8", new Uint8Array([0x61, 0x80, 0x62]), "replay-bad-utf8"],
    ["bad json", text.encode("{not-json"), "replay-bad-json"],
    ["array", text.encode("[]"), "replay-bad-shape"],
  ];
  for (const [label, bytes, reason] of cases) {
    const before = bytes.slice();
    const err = assertThrows(
      () => acceptReplayBytes(bytes),
      ReplayValidationError,
      undefined,
      label,
    );
    assertEquals(err.code, REPLAY_VALIDATION_REJECTED, label);
    assertEquals(err.kind, "malformed", label);
    assertEquals(err.reason, reason, label);
    assertEquals(err.cause instanceof ReplayEncodingError, true, label);
    assertEquals(bytes, before, label);
  }
});

Deno.test("20.2 an unsupported version is invalid, and a real file is accepted", () => {
  const version = text.encode('{"header":{"replayFormatVersion":2}}');
  const rejected = assertThrows(
    () => acceptReplayBytes(version),
    ReplayValidationError,
  );
  assertEquals(rejected.kind, "invalid");
  assertEquals(rejected.reason, "replay-version-mismatch");
  assertEquals(rejected.cause instanceof ReplayFormatVersionError, true);

  const { bytes } = encodeCatalogFixture();
  const before = bytes.slice();
  const session = acceptReplayBytes(bytes);
  assertEquals(isLoadedReplay(session), true);
  assertEquals(session.integrityStatus, "unverified");
  assertEquals(bytes, before);
});

Deno.test("20.2 playback rejects bad bytes before it builds a session", () => {
  const err = assertThrows(
    () => createReplayPlayback(new Uint8Array(0), null as never),
    ReplayValidationError,
  );
  assertEquals(err.kind, "malformed");
  assertEquals(err.reason, "replay-truncated");
});

Deno.test("20.2 the kind follows the loader code, and other throws stay thrown", () => {
  const malformed = [
    "replay-truncated",
    "replay-bad-utf8",
    "replay-bad-json",
    "replay-bad-shape",
    "replay-missing-section",
  ];
  const invalid = [
    "replay-bad-tick",
    "replay-unsupported-map",
    "replay-missing-seed",
    "replay-version-mismatch",
    "replay-incompatible",
    "replay-compatibility-invalid",
    "replay-data-boundary",
  ];
  for (const reason of malformed) {
    assertEquals(classifyReplayRejection(coded(reason)), {
      kind: "malformed",
      reason,
    });
  }
  for (const reason of invalid) {
    assertEquals(classifyReplayRejection(coded(reason)), {
      kind: "invalid",
      reason,
    });
  }
  assertEquals(classifyReplayRejection(new TypeError("bug")), null);
  assertEquals(classifyReplayRejection({ code: "replay-truncated" }), null);
  assertEquals(classifyReplayRejection("replay-truncated"), null);
});

Deno.test("20.2 validation calls the loader and does not hash or store", async () => {
  const src = await Deno.readTextFile(
    new URL("./replayValidation.ts", import.meta.url),
  );
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assertEquals(code.includes("loadReplay"), true);
  assertEquals(/\bDeno\./.test(code), false);
  assertEquals(/\bperformance\.now\b/.test(code), false);
  assertEquals(/\bJSON\.stringify\s*\(/.test(code), false);
  assertEquals(/subtle\.digest|sha256|verifyReplay|GameServer|quarantine/.test(code), false);

  const playback = await Deno.readTextFile(
    new URL("./replayPlaybackSession.ts", import.meta.url),
  );
  const playbackCode = playback
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  const resolve = playbackCode.slice(
    playbackCode.indexOf("function resolveSession"),
    playbackCode.indexOf("function viewFromRunner"),
  );
  assertEquals(resolve.includes("acceptReplayBytes"), true);
  assertEquals(resolve.includes("loadReplay"), false);
  assertEquals(resolve.includes("decodeReplayContainer"), false);
});
