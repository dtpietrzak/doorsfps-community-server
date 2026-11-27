import { assert, assertEquals } from "@std/assert";
import { ZombieWatch, type ZombieWatchStepInput, type ZombieWatchTuning } from "./zombieWatch.ts";
import type { ZombotsSpawnPoint } from "./types.ts";

// One tick = 1000 ms keeps the arithmetic readable.
const T: ZombieWatchTuning = {
  progressRadius: 2,
  relocateAfterMs: 10_000,
  maxRelocates: 2,
  killAfterMs: 30_000,
  maxLifetimeMs: 100_000,
  lureHoldRadius: 4,
  relocateClearRadius: 1.5,
};
const SPAWNS: ZombotsSpawnPoint[] = [
  { id: "s0", p: { x: 0, z: 0 } },
  { id: "s1", p: { x: 20, z: 0 } },
  { id: "s2", p: { x: 40, z: 0 } },
];

function input(
  tick: number,
  zombies: ZombieWatchStepInput["zombies"],
  extra: Partial<ZombieWatchStepInput> = {},
): ZombieWatchStepInput {
  return {
    tick,
    tickMs: 1000,
    zombies,
    humans: [],
    lure: null,
    spawns: SPAWNS,
    spawnGate: () => true,
    seq: 0,
    ...extra,
  };
}

Deno.test("zombieWatch: a stalled zombie relocates after relocateAfterMs, to a far open spawn", () => {
  const w = new ZombieWatch(T);
  w.track("z", { x: 0.5, z: 0 }, 100, 0);
  const z = { id: "z", x: 0.5, z: 0, health: 100 };
  assertEquals(w.step(input(9, [z])), []);
  const out = w.step(input(10, [z]));
  assertEquals(out.length, 1);
  const d = out[0]!;
  assert(d.kind === "relocate");
  // s0 is under the zombie (not far), so the pick comes from s1/s2.
  assert(d.spawn.id !== "s0");
  assertEquals(d.stats.relocates, 1);
  assertEquals(d.from, { x: 0.5, z: 0 });
});

Deno.test("zombieWatch: moving, taking damage or a marked hit all count as progress", () => {
  const w = new ZombieWatch(T);
  w.track("z", { x: 0, z: 0 }, 100, 0);
  // Moves 3 m at tick 8: the stall clock restarts there.
  assertEquals(w.step(input(8, [{ id: "z", x: 3, z: 0, health: 100 }])), []);
  assertEquals(w.step(input(17, [{ id: "z", x: 3, z: 0, health: 100 }])), []);
  // Takes damage at tick 17 (above): restart again.
  assertEquals(w.step(input(26, [{ id: "z", x: 3, z: 0, health: 90 }])), []);
  w.markProgress("z", 35, 90);
  assertEquals(w.step(input(44, [{ id: "z", x: 3, z: 0, health: 90 }])), []);
  assertEquals(w.step(input(45, [{ id: "z", x: 3, z: 0, health: 90 }]))[0]?.kind, "relocate");
});

Deno.test("zombieWatch: after maxRelocates, a long stall is a kill", () => {
  const w = new ZombieWatch({ ...T, maxRelocates: 0 });
  w.track("z", { x: 0, z: 0 }, 100, 0);
  const z = { id: "z", x: 0, z: 0, health: 100 };
  assertEquals(w.step(input(29, [z])), []);
  const out = w.step(input(30, [z]));
  assertEquals(out.map((d) => d.kind === "kill" ? d.reason : d.kind), ["stagnant"]);
  assertEquals(w.size, 0);
});

Deno.test("zombieWatch: every zombie dies at the lifetime ceiling, even a moving one", () => {
  const w = new ZombieWatch(T);
  w.track("z", { x: 0, z: 0 }, 100, 0);
  for (let t = 1; t < 100; t++) {
    assertEquals(w.step(input(t, [{ id: "z", x: t * 3, z: 0, health: 100 }])), []);
  }
  const out = w.step(input(100, [{ id: "z", x: 300, z: 0, health: 100 }]));
  assertEquals(out.map((d) => d.kind === "kill" ? d.reason : d.kind), ["lifetime"]);
});

Deno.test("zombieWatch: holding near an active lure is never stuck", () => {
  const w = new ZombieWatch(T);
  w.track("z", { x: 10, z: 10 }, 100, 0);
  const z = { id: "z", x: 10, z: 10, health: 100 };
  for (let t = 1; t <= 60; t++) {
    assertEquals(w.step(input(t, [z], { lure: { x: 12, z: 10 } })), []);
  }
});

Deno.test("zombieWatch: a relocate avoids spawns with a body on them and prefers gate-open spawns", () => {
  const w = new ZombieWatch(T);
  w.track("z", { x: 60, z: 0 }, 100, 0);
  const out = w.step(input(10, [{ id: "z", x: 60, z: 0, health: 100 }], {
    // s1 is closed, a human stands on s0: only s2 is left.
    spawnGate: (id) => id !== "s1",
    humans: [{ x: 0, z: 0 }],
  }));
  const d = out[0]!;
  assert(d.kind === "relocate");
  assertEquals(d.spawn.id, "s2");
});

Deno.test("zombieWatch: an untracked zombie starts being watched, nothing decided", () => {
  const w = new ZombieWatch(T);
  assertEquals(w.step(input(50, [{ id: "new", x: 0, z: 0, health: 100 }])), []);
  assertEquals(w.size, 1);
  w.forget("new");
  assertEquals(w.size, 0);
});
