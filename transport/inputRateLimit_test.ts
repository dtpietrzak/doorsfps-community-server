import { assertEquals } from "jsr:@std/assert@1";
import { InputRateLimiter } from "./inputRateLimit.ts";

Deno.test("InputRateLimiter allows a burst up to the window cap", () => {
  const lim = new InputRateLimiter(120, 100);
  const cap = lim.getMaxPerWindow();
  assertEquals(cap, 12);
  const t0 = 1_000_000;
  for (let i = 0; i < cap; i++) {
    assertEquals(lim.allow("s1", t0), true, `event ${i} should pass`);
  }
  assertEquals(lim.allow("s1", t0 + 50), false);
});

Deno.test("InputRateLimiter resets after the window", () => {
  const lim = new InputRateLimiter(120, 100);
  const t0 = 2_000_000;
  const cap = lim.getMaxPerWindow();
  for (let i = 0; i < cap; i++) lim.allow("s1", t0);
  assertEquals(lim.allow("s1", t0 + 50), false);
  assertEquals(lim.allow("s1", t0 + 100), true);
});

Deno.test("InputRateLimiter is per-socket", () => {
  const lim = new InputRateLimiter(120, 100);
  const t0 = 3_000_000;
  const cap = lim.getMaxPerWindow();
  for (let i = 0; i < cap; i++) lim.allow("a", t0);
  assertEquals(lim.allow("a", t0), false);
  assertEquals(lim.allow("b", t0), true);
});

Deno.test("InputRateLimiter.forget clears a socket", () => {
  const lim = new InputRateLimiter(120, 100);
  const t0 = 4_000_000;
  const cap = lim.getMaxPerWindow();
  for (let i = 0; i < cap; i++) lim.allow("s1", t0);
  lim.forget("s1");
  assertEquals(lim.allow("s1", t0), true);
});
