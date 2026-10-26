import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import { PhaseTimingBundle, rms, TickTimingStats } from "./tickTiming.ts";

Deno.test("rms of constants equals the constant", () => {
  assertEquals(rms([]), 0);
  assertEquals(rms([4, 4, 4]), 4);
  assertAlmostEquals(rms([3, 4]), Math.sqrt((9 + 16) / 2), 1e-9);
});

Deno.test("TickTimingStats RMS over 1s and peak over 30s", () => {
  const hz = 10; // small for test: 1s = 10 samples, 30s = 300
  const stats = new TickTimingStats(hz);

  // First second: alternating 2ms / 4ms → RMS = sqrt((4+16)/2) = sqrt(10)
  for (let i = 0; i < hz; i++) {
    stats.record(i % 2 === 0 ? 2 : 4);
  }
  let snap = stats.snapshot();
  assertEquals(snap.tickHz, hz);
  assertAlmostEquals(snap.budgetMs, 100, 1e-9);
  assertAlmostEquals(snap.avgMs, Math.sqrt(10), 1e-9);
  assertEquals(snap.peakMs, 4);
  assertEquals(snap.samples1s, hz);
  assertEquals(stats.last(), 4);

  // Inject a spike, then fill the rest of 30s with quiet ticks so peak holds.
  stats.record(50);
  for (let i = 0; i < hz * 29 - 1; i++) {
    stats.record(1);
  }
  snap = stats.snapshot();
  assertEquals(snap.peakMs, 50);
  // Last 1s is all 1ms quiet ticks.
  assertAlmostEquals(snap.avgMs, 1, 1e-9);
  assertAlmostEquals(snap.peakLoad, 50 / 100, 1e-9);
  assertAlmostEquals(snap.avgLoad, 1 / 100, 1e-9);
});

Deno.test("TickTimingStats peak ages out after 30s window", () => {
  const hz = 5;
  const stats = new TickTimingStats(hz);
  stats.record(99);
  // Exactly 30s of samples after the spike → spike is oldest and still in window
  // when count reaches window size; one more sample drops it.
  for (let i = 0; i < hz * 30; i++) {
    stats.record(1);
  }
  const snap = stats.snapshot();
  assertEquals(snap.peakMs, 1);
  assertEquals(snap.samples30s, hz * 30);
});

Deno.test("PhaseTimingBundle tracks each phase independently", () => {
  const hz = 10;
  const phases = new PhaseTimingBundle(hz);

  for (let i = 0; i < hz; i++) {
    phases.record({ bots: 5, sim: 2, scores: 1, emit: 3 });
  }
  // One spike on bots only.
  phases.record({ bots: 40, sim: 2, scores: 1, emit: 3 });

  const snap = phases.snapshot();
  assertAlmostEquals(snap.bots.peakMs, 40, 1e-9);
  assertAlmostEquals(snap.sim.peakMs, 2, 1e-9);
  assertEquals(snap.bots.lastMs, 40);
  assertEquals(snap.emit.lastMs, 3);
  // Loads vs full budget (100ms at 10 Hz).
  assertAlmostEquals(snap.bots.peakLoad, 40 / 100, 1e-9);
  assertAlmostEquals(snap.sim.avgLoad, 2 / 100, 1e-9);
});

Deno.test("PhaseTimingBundle treats missing phases as zero", () => {
  const phases = new PhaseTimingBundle(5);
  phases.record({ bots: 7 });
  const snap = phases.snapshot();
  assertEquals(snap.bots.lastMs, 7);
  assertEquals(snap.sim.lastMs, 0);
  assertEquals(snap.scores.lastMs, 0);
  assertEquals(snap.emit.lastMs, 0);
});
