import { assertEquals } from "jsr:@std/assert@1";
import {
  admissionLocked,
  authorityStatusUrl,
  releaseLockedFromAuthorityStatus,
  shouldHoldMatchRestart,
  startReleaseLockPoll,
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

Deno.test("startReleaseLockPoll keeps the last lock when a poll fails", async () => {
  const fetches: Array<{ url: string; init: RequestInit }> = [];
  const timeouts: number[] = [];
  const script = ["draining", "http", "throw", "ready"] as const;
  let step = 0;
  let intervalMs = 0;
  let intervalCb: (() => void) | null = null;
  const cleared: number[] = [];
  const seen: boolean[] = [];

  const stop = startReleaseLockPoll(
    "http://127.0.0.1:9/api/status",
    (locked) => {
      seen.push(locked);
    },
    {
      fetch: (input, init) => {
        fetches.push({ url: input, init });
        const next = script[step]!;
        step += 1;
        if (next === "throw") return Promise.reject(new Error("down"));
        if (next === "http") {
          return Promise.resolve(new Response("no", { status: 503 }));
        }
        return Promise.resolve(Response.json({ state: next }));
      },
      setInterval: (cb, ms) => {
        intervalCb = cb;
        intervalMs = ms;
        return 42 as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval: (id) => {
        cleared.push(Number(id));
      },
      timeoutSignal: (ms) => {
        timeouts.push(ms);
        return new AbortController().signal;
      },
    },
  );

  const settle = async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };

  await settle();
  assertEquals(seen, [true]);
  assertEquals(fetches.length, 1);
  assertEquals(fetches[0]!.url, "http://127.0.0.1:9/api/status");
  assertEquals(fetches[0]!.init.cache, "no-store");
  assertEquals(timeouts, [4_000]);
  assertEquals(intervalMs, 5_000);

  intervalCb!();
  await settle();
  assertEquals(seen, [true]);
  assertEquals(timeouts, [4_000, 4_000]);

  intervalCb!();
  await settle();
  assertEquals(seen, [true]);

  intervalCb!();
  await settle();
  assertEquals(seen, [true, false]);
  assertEquals(timeouts.length, 4);
  assertEquals(timeouts.every((ms) => ms === 4_000), true);

  stop();
  stop();
  assertEquals(cleared, [42]);
});
