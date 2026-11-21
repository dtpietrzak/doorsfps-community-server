/**
 * Epic 20.6 — checksum verdicts. The module does not hash.
 *
 * Run from server-community/:
 *   deno test -A --unstable-net --node-modules-dir=manual replay/replay_checksum_test.ts
 */

import { assertEquals } from "jsr:@std/assert@1";
import {
  REPLAY_CHECKSUM_ALGORITHM,
  isReplayChecksumHex,
  replayBytesServable,
  replayChecksumVerdict,
  replayFileSizeVerdict,
} from "./replayChecksum.ts";

const HEX = "ab".repeat(32);
const OTHER = "cd".repeat(32);

Deno.test("20.6 checksum verdicts", () => {
  assertEquals(REPLAY_CHECKSUM_ALGORITHM, "sha256");
  assertEquals(isReplayChecksumHex(HEX), true);
  assertEquals(isReplayChecksumHex(HEX.slice(1)), false);
  assertEquals(replayChecksumVerdict(null, HEX), "unverified");
  assertEquals(replayChecksumVerdict("   ", HEX), "unverified");
  assertEquals(replayChecksumVerdict(HEX, HEX), "match");
  assertEquals(replayChecksumVerdict(HEX.toUpperCase(), HEX), "match");
  assertEquals(replayChecksumVerdict(HEX, OTHER), "mismatch");
  assertEquals(replayChecksumVerdict("zz", HEX), "malformed");
  assertEquals(replayChecksumVerdict(HEX, "nope"), "malformed");
});

Deno.test("20.6 size verdicts and what may be served", () => {
  assertEquals(replayFileSizeVerdict(null, 10), "unstamped");
  assertEquals(replayFileSizeVerdict(undefined, 10), "unstamped");
  assertEquals(replayFileSizeVerdict(10, 10), "match");
  assertEquals(replayFileSizeVerdict(10, 9), "truncated");
  assertEquals(replayFileSizeVerdict(1.5, 1), "truncated");
  assertEquals(replayFileSizeVerdict(-1, 1), "truncated");
  assertEquals(
    replayBytesServable({ size: "match", checksum: "match" }),
    true,
  );
  assertEquals(
    replayBytesServable({ size: "unstamped", checksum: "unverified" }),
    true,
  );
  assertEquals(
    replayBytesServable({ size: "match", checksum: "mismatch" }),
    false,
  );
  assertEquals(
    replayBytesServable({ size: "match", checksum: "malformed" }),
    false,
  );
  assertEquals(
    replayBytesServable({ size: "truncated", checksum: "match" }),
    false,
  );
  assertEquals(
    replayBytesServable({ size: "truncated", checksum: "unverified" }),
    false,
  );
});

Deno.test("20.6 source-scan: compare only, trailer stays 10.4", async () => {
  const src = await Deno.readTextFile(
    new URL("./replayChecksum.ts", import.meta.url),
  );
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assertEquals(/\bDate\.now\b/.test(code), false);
  assertEquals(/\bDeno\./.test(code), false);
  assertEquals(/subtle\.digest|node:crypto|sqlite|encodeReplay|loadReplay/.test(code), false);
  assertEquals(code.includes("reserved-for-10.4"), false);
});
