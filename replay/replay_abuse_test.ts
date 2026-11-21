/**
 * Epic 20.5 — abuse policy.
 *
 * Run from server-community/:
 *   deno test -A --unstable-net --node-modules-dir=manual replay/replay_abuse_test.ts
 */

import { assertEquals } from "jsr:@std/assert@1";
import { MAX_BUFFERED_BYTES_EST } from "./replaySessionBuffer.ts";
import {
  REPLAY_ABUSE_LIMITS,
  REPLAY_ABUSE_UPLOAD_CAP_BYTES,
  REPLAY_ACCOUNT_STORAGE_QUOTA_BYTES,
  REPLAY_REPORT_CAP,
  allowReplayAbuse,
  createReplayAbuseWindow,
  normalizeReplayReportReason,
  replayDeclaredUploadBytes,
  replayFinalizeAbuseKey,
  replayReportDisposition,
  replayReporterKey,
  replayUploadFits,
  replayUploadRejected,
} from "./replayAbuse.ts";

Deno.test("20.5 rate limit allows the cap, then the next, then a new window", () => {
  const window = createReplayAbuseWindow();
  const spec = REPLAY_ABUSE_LIMITS.report;
  for (let i = 0; i < spec.limit; i++) {
    assertEquals(
      allowReplayAbuse({ kind: "report", key: "ip:203.0.113.9", nowMs: 1_000, window })
        .allowed,
      true,
    );
  }
  const blocked = allowReplayAbuse({
    kind: "report",
    key: "ip:203.0.113.9",
    nowMs: 1_000,
    window,
  });
  assertEquals(blocked.allowed, false);
  assertEquals(blocked.retryAfterMs, spec.windowMs);
  const again = allowReplayAbuse({
    kind: "report",
    key: "ip:203.0.113.9",
    nowMs: 1_000 + spec.windowMs,
    window,
  });
  assertEquals(again.allowed, true);
  assertEquals(again.retryAfterMs, 0);
});

Deno.test("20.5 rate limit fails closed on a bad key or a bad clock", () => {
  const window = createReplayAbuseWindow();
  for (const key of ["", "   ", "a\0b", "x".repeat(300)]) {
    assertEquals(
      allowReplayAbuse({ kind: "catalog", key, nowMs: 0, window }).allowed,
      false,
    );
  }
  assertEquals(
    allowReplayAbuse({ kind: "catalog", key: "ok", nowMs: Number.NaN, window })
      .allowed,
    false,
  );
  assertEquals(window.size, 0);
});

Deno.test("20.5 windows do not share a key across kinds", () => {
  const window = createReplayAbuseWindow();
  const spec = REPLAY_ABUSE_LIMITS.file;
  for (let i = 0; i < spec.limit; i++) {
    allowReplayAbuse({ kind: "file", key: "203.0.113.8", nowMs: 5, window });
  }
  assertEquals(
    allowReplayAbuse({ kind: "file", key: "203.0.113.8", nowMs: 5, window }).allowed,
    false,
  );
  assertEquals(
    allowReplayAbuse({ kind: "metadata", key: "203.0.113.8", nowMs: 5, window })
      .allowed,
    true,
  );
});

Deno.test("20.5 upload cap matches the recorder buffer and rejects a larger body", () => {
  assertEquals(REPLAY_ABUSE_UPLOAD_CAP_BYTES, MAX_BUFFERED_BYTES_EST);
  assertEquals(replayUploadFits(0), false);
  assertEquals(replayUploadFits(1), true);
  assertEquals(replayUploadFits(REPLAY_ABUSE_UPLOAD_CAP_BYTES), true);
  assertEquals(replayUploadFits(REPLAY_ABUSE_UPLOAD_CAP_BYTES + 1), false);
  assertEquals(replayUploadFits(1.5), false);
  assertEquals(replayDeclaredUploadBytes(null), null);
  assertEquals(replayDeclaredUploadBytes(" 12 "), 12);
  assertEquals(replayDeclaredUploadBytes("12abc"), null);
  assertEquals(replayDeclaredUploadBytes("-1"), null);
  assertEquals(
    replayUploadRejected(REPLAY_ABUSE_UPLOAD_CAP_BYTES + 1, null),
    true,
  );
  assertEquals(
    replayUploadRejected(null, REPLAY_ABUSE_UPLOAD_CAP_BYTES + 1),
    true,
  );
  assertEquals(replayUploadRejected(3, 3), false);
});

Deno.test("20.5 storage quota stays unset and a report does not change the row", () => {
  assertEquals(REPLAY_ACCOUNT_STORAGE_QUOTA_BYTES, null);
  assertEquals(replayReportDisposition(), {
    changesVisibility: false,
    deletesReplay: false,
  });
  assertEquals(REPLAY_REPORT_CAP, 64);
});

Deno.test("20.5 report reasons and reporter keys", () => {
  assertEquals(normalizeReplayReportReason(" malicious "), "malicious");
  assertEquals(normalizeReplayReportReason("personal-info"), "personal-info");
  assertEquals(normalizeReplayReportReason("other"), "other");
  assertEquals(normalizeReplayReportReason("spam"), null);
  assertEquals(normalizeReplayReportReason(1), null);
  assertEquals(replayReporterKey(" user ", "203.0.113.1"), "account:user");
  assertEquals(replayReporterKey(null, " 203.0.113.1 "), "ip:203.0.113.1");
  assertEquals(replayReporterKey("  ", ""), null);
  assertEquals(replayFinalizeAbuseKey(" easy "), "server:easy");
  assertEquals(replayFinalizeAbuseKey(" "), null);
});

Deno.test("20.5 source-scan: policy does not touch a clock, store, or hash", async () => {
  const src = await Deno.readTextFile(new URL("./replayAbuse.ts", import.meta.url));
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assertEquals(/\bDate\.now\b/.test(code), false);
  assertEquals(/\bDeno\./.test(code), false);
  assertEquals(/\bsqlite\b|\bDeno\.write|\bsubtle\.digest\b|\bsha256\b/.test(code), false);
  assertEquals(/deleteReplay|sweepReplay|GameServer|encodeReplay/.test(code), false);
});
