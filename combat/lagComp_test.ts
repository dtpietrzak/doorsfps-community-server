/**
 * Run with: deno test -A server-community/combat/lagComp_test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { LAG_COMP_MAX_REWIND_TICKS } from "../protocol/network.ts";
import {
  buildLagCompTicks,
  createPingFilter,
  LAG_COMP_INTERP_DEFAULT_MS,
  msToRewindTicks,
  observeRttSample,
  resolveLagCompWindow,
  sanitizeLastAppliedSnapshotTick,
} from "./lagComp.ts";

Deno.test("buildLagCompTicks: with clientTick samples base ±1 only (no live simTick)", () => {
  const simTick = 1000;
  const clientTick = 990;
  const ticks = buildLagCompTicks(simTick, clientTick);
  assertEquals(ticks.includes(989), true);
  assertEquals(ticks.includes(990), true);
  assertEquals(ticks.includes(991), true);
  // Live pose must not be included — that sat ahead of remote interp delay.
  assertEquals(ticks.includes(simTick), false);
  assertEquals(
    ticks.every((t) => t >= simTick - LAG_COMP_MAX_REWIND_TICKS),
    true,
  );
  assertEquals(ticks.every((t) => t <= simTick), true);
});

Deno.test("buildLagCompTicks: clamps clientTick into rewind window", () => {
  const simTick = 100;
  // Far older than max rewind — clamp to min.
  const ticks = buildLagCompTicks(simTick, 1);
  const minTick = simTick - LAG_COMP_MAX_REWIND_TICKS;
  assertEquals(ticks.includes(minTick), true);
  assertEquals(ticks.includes(simTick), false);
});

Deno.test("buildLagCompTicks: clientTick near now still omits pure-live-only bias", () => {
  const simTick = 500;
  const ticks = buildLagCompTicks(simTick, 500);
  // base and base-1 are fine; base+1 clamps to simTick so simTick may appear
  // as base+1 neighbor when clientTick === simTick — that is OK (same pose).
  assertEquals(ticks.includes(499), true);
  assertEquals(ticks.includes(500), true);
  // When base === simTick, base+1 is clamped out; simTick is only present as base.
  assertEquals(new Set(ticks).size, ticks.length);
});

Deno.test("buildLagCompTicks: without clientTick uses fallback window including now", () => {
  const simTick = 200;
  const ticks = buildLagCompTicks(simTick, undefined);
  assertEquals(ticks.includes(simTick), true); // rewind 0
  assertEquals(ticks.includes(simTick - 1), true);
  assertEquals(ticks.length > 3, true);
});

Deno.test("buildLagCompTicks: invalid clientTick falls back", () => {
  const simTick = 80;
  const ticks = buildLagCompTicks(simTick, 0);
  assertEquals(ticks.includes(simTick), true);
  const ticksNaN = buildLagCompTicks(simTick, Number.NaN);
  assertEquals(ticksNaN.includes(simTick), true);
});

Deno.test("buildLagCompTicks: resolved missing stamp does not use fallback search", () => {
  const simTick = 200;
  const window = resolveLagCompWindow({
    simTick,
    lastSnapTick: 198,
    pingReady: true,
    pingEwmaMs: 40,
    lastAppliedSnapshotTick: 198,
  });
  const ticks = buildLagCompTicks(simTick, window.tick, { resolved: true });
  assertEquals(ticks.includes(window.tick), true);
  assertEquals(ticks.length <= 3, true);
  assertEquals(ticks.includes(simTick), false);
});

Deno.test("observeRttSample: ignores first pong for ready EWMA", () => {
  let s = createPingFilter();
  s = observeRttSample(s, 40);
  assertEquals(s.sampleCount, 1);
  assertEquals(s.ewmaMs, 40);
  s = observeRttSample(s, 60);
  assertEquals(s.sampleCount, 2);
  assertEquals(s.ewmaMs > 40 && s.ewmaMs < 60, true);
  s = observeRttSample(s, -1);
  assertEquals(s.sampleCount, 2);
});

Deno.test("sanitizeLastAppliedSnapshotTick: grid + age", () => {
  assertEquals(
    sanitizeLastAppliedSnapshotTick({
      lastApplied: 240,
      lastSnap: 240,
      rttMs: 40,
      jitterMs: 0,
    }),
    240,
  );
  assertEquals(
    sanitizeLastAppliedSnapshotTick({
      lastApplied: 237,
      lastSnap: 240,
      rttMs: 40,
      jitterMs: 0,
    }),
    237,
  );
  // Off grid and not lastSnap.
  assertEquals(
    sanitizeLastAppliedSnapshotTick({
      lastApplied: 238,
      lastSnap: 240,
      rttMs: 40,
      jitterMs: 0,
    }),
    undefined,
  );
  // Older than 3 snaps on LAN.
  assertEquals(
    sanitizeLastAppliedSnapshotTick({
      lastApplied: 228,
      lastSnap: 240,
      rttMs: 40,
      jitterMs: 0,
    }),
    undefined,
  );
});

const LAN = {
  simTick: 240,
  lastSnapTick: 240,
  lastAppliedSnapshotTick: 240,
  pingEwmaMs: 40,
  pingJitterMs: 0,
  pingReady: true,
  volDropPct: 0,
} as const;

Deno.test("resolveLagCompWindow: LAN honest stamp is unclamped", () => {
  const expectTicks = msToRewindTicks(LAG_COMP_INTERP_DEFAULT_MS);
  const honest = 240 - expectTicks;
  const w = resolveLagCompWindow({ ...LAN, clientTick: honest });
  assertEquals(w.clamped, false);
  assertEquals(w.tick, honest);
  assertEquals(w.expectTick, honest);
});

Deno.test("resolveLagCompWindow: LAN rejects 250ms backtrack (forward clamp)", () => {
  const w = resolveLagCompWindow({
    ...LAN,
    clientTick: 240 - LAG_COMP_MAX_REWIND_TICKS,
  });
  assertEquals(w.clampDir, "forward");
  assertEquals(w.tick, w.lo);
  assertEquals(w.tick > 240 - LAG_COMP_MAX_REWIND_TICKS, true);
});

Deno.test("resolveLagCompWindow: live stamp clamps back (not simTick)", () => {
  const w = resolveLagCompWindow({ ...LAN, clientTick: 240 });
  assertEquals(w.clampDir, "back");
  assertEquals(w.tick, w.hi);
  assertEquals(w.tick < 240, true);
});

Deno.test("resolveLagCompWindow: missing clientTick uses expectTick, not fallback", () => {
  const w = resolveLagCompWindow({ ...LAN });
  assertEquals(w.clamped, false);
  assertEquals(w.tick, w.expectTick);
  assertEquals(w.tick < 240, true);
});

Deno.test("resolveLagCompWindow: unknown ping does not shrink to 0 RTT", () => {
  const ready = resolveLagCompWindow({ ...LAN, clientTick: 235 });
  const unknown = resolveLagCompWindow({
    simTick: 240,
    lastSnapTick: 240,
    clientTick: 235,
  });
  // Unknown assumes ~80ms RTT, so expect is older than a ready 40ms LAN.
  assertEquals(unknown.expectTick <= ready.expectTick, true);
  assertEquals(unknown.lo <= ready.lo, true);
});

Deno.test("resolveLagCompWindow: lastApplied older snap shifts expect", () => {
  const fresh = resolveLagCompWindow({ ...LAN, clientTick: 230 });
  const delayed = resolveLagCompWindow({
    ...LAN,
    lastAppliedSnapshotTick: 234,
    clientTick: 230,
  });
  assertEquals(delayed.expectTick < fresh.expectTick, true);
  assertEquals(delayed.lo < fresh.lo, true);
});

Deno.test("resolveLagCompWindow: volDrop widens lo", () => {
  const healthy = resolveLagCompWindow({ ...LAN, clientTick: 220 });
  const lossy = resolveLagCompWindow({
    ...LAN,
    volDropPct: 40,
    clientTick: 220,
  });
  assertEquals(lossy.lo < healthy.lo, true);
});

Deno.test("resolveLagCompWindow: client interp 150 only shifts when lossy", () => {
  const healthy = resolveLagCompWindow({
    ...LAN,
    interpDelayMs: 150,
    clientTick: 230,
  });
  const lossy = resolveLagCompWindow({
    ...LAN,
    interpDelayMs: 150,
    volDropPct: 20,
    clientTick: 230,
  });
  assertEquals(healthy.expectTick, resolveLagCompWindow({ ...LAN }).expectTick);
  assertEquals(lossy.expectTick < healthy.expectTick, true);
});

Deno.test("resolveLagCompWindow: interp 50 may narrow", () => {
  const def = resolveLagCompWindow({ ...LAN });
  const tight = resolveLagCompWindow({
    ...LAN,
    interpDelayMs: 50,
  });
  assertEquals(tight.expectTick >= def.expectTick, true);
});

Deno.test("resolveLagCompWindow: lastSnap cannot sit ahead of simTick", () => {
  const w = resolveLagCompWindow({
    simTick: 30,
    lastSnapTick: 10_000,
    pingReady: true,
    pingEwmaMs: 40,
    lastAppliedSnapshotTick: 27,
  });
  assertEquals(w.hi <= 30, true);
  assertEquals(w.tick <= 30, true);
});

Deno.test("resolveLagCompWindow: absent filter inputs use fixed defaults", () => {
  // Epic 4.4: replay must supply recorded ping/volDrop/interp or accept these
  // defaults — never re-derive live EWMA here.
  const w = resolveLagCompWindow({
    simTick: 600,
    lastSnapTick: 600,
  });
  const withUnknownReady = resolveLagCompWindow({
    simTick: 600,
    lastSnapTick: 600,
    pingReady: false,
  });
  // Without pingReady, expectTick uses LAG_COMP_UNKNOWN_RTT_MS path (same as
  // not-ready), not a zero-RTT LAN window.
  assertEquals(w.expectTick, withUnknownReady.expectTick);
  assertEquals(w.tick, w.expectTick);
});
