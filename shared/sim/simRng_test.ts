import { assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import {
  createMatchSimRngStreams,
  createSimRng,
  deriveDomainSeed,
  generateMatchSeed,
  normalizeSeed,
  type SimRngDomain,
} from "./simRng.ts";

Deno.test("normalizeSeed: zero maps to stable non-zero; u32 wrap preserved", () => {
  assertEquals(normalizeSeed(0), 0x6d2b79f5);
  assertEquals(normalizeSeed(0x9e3779b9), 0x9e3779b9);
  assertEquals(normalizeSeed(-1), 0xffffffff);
});

Deno.test("createSimRng: same seed → identical sample sequence", () => {
  const a = createSimRng(0xc0ffee);
  const b = createSimRng(0xc0ffee);
  for (let i = 0; i < 32; i++) {
    assertEquals(a(), b());
  }
});

Deno.test("createSimRng: different seeds diverge", () => {
  const a = createSimRng(1);
  const b = createSimRng(2);
  const seqA = Array.from({ length: 8 }, () => a());
  const seqB = Array.from({ length: 8 }, () => b());
  assertNotEquals(seqA.join(","), seqB.join(","));
});

Deno.test("createSimRng: samples stay in [0, 1)", () => {
  const rng = createSimRng(0xdeadbeef);
  for (let i = 0; i < 10_000; i++) {
    const v = rng();
    assertEquals(v >= 0 && v < 1, true);
  }
});

Deno.test("deriveDomainSeed: domains differ under the same match seed", () => {
  const matchSeed = 0x12345678;
  const domains: SimRngDomain[] = ["damage", "spread", "spawn", "agents"];
  const seeds = domains.map((d) => deriveDomainSeed(matchSeed, d));
  assertEquals(new Set(seeds).size, domains.length);
});

Deno.test("createMatchSimRngStreams: domain independence", () => {
  const streams = createMatchSimRngStreams(0xabcdef01);
  // Advance damage only — spread/spawn/agents sequences from a fresh build
  // with the same match seed must still match.
  for (let i = 0; i < 17; i++) streams.damage();

  const again = createMatchSimRngStreams(0xabcdef01);
  for (let i = 0; i < 8; i++) {
    assertEquals(streams.spread(), again.spread());
    assertEquals(streams.spawn(), again.spawn());
    assertEquals(streams.agents(), again.agents());
  }
});

Deno.test("createMatchSimRngStreams: reseed resets all domains", () => {
  const first = createMatchSimRngStreams(42);
  const seq = {
    damage: Array.from({ length: 5 }, () => first.damage()),
    spread: Array.from({ length: 5 }, () => first.spread()),
    spawn: Array.from({ length: 5 }, () => first.spawn()),
    agents: Array.from({ length: 5 }, () => first.agents()),
  };
  // Burn more samples so state would drift without reseed.
  for (let i = 0; i < 20; i++) {
    first.damage();
    first.spread();
  }
  const second = createMatchSimRngStreams(42);
  assertEquals(
    Array.from({ length: 5 }, () => second.damage()),
    seq.damage,
  );
  assertEquals(
    Array.from({ length: 5 }, () => second.spread()),
    seq.spread,
  );
  assertEquals(
    Array.from({ length: 5 }, () => second.spawn()),
    seq.spawn,
  );
  assertEquals(
    Array.from({ length: 5 }, () => second.agents()),
    seq.agents,
  );
});

Deno.test("createSimRng: getState/setState round-trip without advancing", () => {
  const a = createSimRng(0xc0ffee);
  for (let i = 0; i < 7; i++) a();
  const cursor = a.getState();
  const expected = Array.from({ length: 5 }, () => a());

  const b = createSimRng(1);
  for (let i = 0; i < 3; i++) b();
  b.setState(cursor);
  assertEquals(b.getState(), cursor);
  assertEquals(Array.from({ length: 5 }, () => b()), expected);

  // setState alone must not advance.
  const c = createSimRng(0xc0ffee);
  for (let i = 0; i < 7; i++) c();
  const before = c.getState();
  c.setState(before);
  assertEquals(c.getState(), before);
});

Deno.test("generateMatchSeed: uses injected bytes and normalizes zero", () => {
  assertEquals(
    generateMatchSeed((out) => {
      out[0] = 0;
    }),
    0x6d2b79f5,
  );
  assertEquals(
    generateMatchSeed((out) => {
      out[0] = 0x11111111;
    }),
    0x11111111,
  );
});
