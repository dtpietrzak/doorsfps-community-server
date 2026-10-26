import { assertEquals } from "jsr:@std/assert@1";
import {
  admissionLocked,
  authorityStatusUrl,
  releaseLockedFromAuthorityStatus,
  shouldHoldMatchRestart,
} from "./releaseLock.ts";

Deno.test("authority status locks play except when ready", () => {
  assertEquals(releaseLockedFromAuthorityStatus(null), false);
  assertEquals(releaseLockedFromAuthorityStatus({ version: "a", state: "ready" }), false);
  assertEquals(
    releaseLockedFromAuthorityStatus({ version: "a", state: "draining" }),
    true,
  );
  assertEquals(
    releaseLockedFromAuthorityStatus({ version: "a", state: "deploying" }),
    true,
  );
  assertEquals(
    releaseLockedFromAuthorityStatus({ version: "a", state: "maintenance" }),
    true,
  );
  assertEquals(releaseLockedFromAuthorityStatus({ version: "a", state: "nope" }), false);
});

Deno.test("release lock holds rematch, then returns players to the menu", () => {
  assertEquals(shouldHoldMatchRestart(true), true);
  assertEquals(shouldHoldMatchRestart(false), false);
  assertEquals(admissionLocked(false, false), false);
  assertEquals(admissionLocked(true, false), true);
  assertEquals(admissionLocked(false, true), true);
});

Deno.test("authority status URL is the public release endpoint", () => {
  assertEquals(authorityStatusUrl(null), null);
  assertEquals(authorityStatusUrl("  "), null);
  assertEquals(
    authorityStatusUrl("http://127.0.0.1:4000/"),
    "http://127.0.0.1:4000/api/status",
  );
});
