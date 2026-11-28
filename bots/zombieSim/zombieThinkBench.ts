/**
 * Zombie think cost vs the sim tick budget. Not a test.
 *
 *   deno run -A --unstable-net --node-modules-dir=manual \
 *     bots/zombieSim/zombieThinkBench.ts [map.doors.json]
 *
 * Loads a real competitive map through the normal loader, treats it as
 * zombots, parks 4 humans, and times PersistentBotThinkEngine.thinkBatch,
 * the call BotManager makes. Like BotManager, each sim tick thinks one
 * roster shard (the bots whose phase is this tick), so every bot thinks
 * once per bot period. Env: ZB_TICKS (bot ticks per N, default 2000),
 * ZB_WARMUP (default 300).
 *
 * Not timed: frame building, packet/sim work, the walking harness.
 */
import { BOT_TICK_HZ, SIM_TICKS_PER_BOT_TICK } from "@doors/bot-spec/schedule";
import { BALANCE_BOT_CONFIG, ZOMBIE_BOT_CONFIG } from "@doors/bot-spec/config";
import { TICK_HZ } from "../../protocol/network.ts";
import { buildBotMapDefinition } from "../shadow/frame.ts";
import { loadMapFile } from "../../world/loadMap.ts";
import { MapCollision as ServerCollision } from "../../world/MapCollision.ts";
import { botThinksOnSimPhase } from "../engine/helpers/combat.ts";
import { createBotThinkEngine } from "../engine/engine/batch.ts";
import {
  frameOf,
  harnessCollision,
  type SimPawn,
  simPawn,
  walkOneSimTick,
} from "./simHarness.ts";
import type { BotDefinition } from "../engine/model/index.ts";

const MAP_PATH = Deno.args[0] ??
  new URL("../../maps/competitive/Pillars.doors.json", import.meta.url)
    .pathname;
const TIMED_BOT_TICKS = Number(Deno.env.get("ZB_TICKS") ?? 2000);
const WARMUP_BOT_TICKS = Number(Deno.env.get("ZB_WARMUP") ?? 300);
const WAVE_BOT_TICKS = 400; // re-scatter the horde so it keeps chasing
const HUMANS = 4;
const COUNTS = [0, 8, 16, 24, 32, 48];

// Budgets: tickTiming.ts:140 budgetMs = 1000 / tickHz, TICK_HZ from
// shared/sim/game.ts:18; bot period = SIM_TICKS_PER_BOT_TICK sim ticks.
const SIM_TICK_BUDGET_MS = 1000 / TICK_HZ;
const BOT_PERIOD_BUDGET_MS = SIM_TICK_BUDGET_MS * SIM_TICKS_PER_BOT_TICK;

function rngFrom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s * 2.3283064365386963e-10;
  };
}

const loaded = await loadMapFile(MAP_PATH);
const map = { ...loaded, mirrorMode: "zombots" as const, spawnCorner: 0 as const };
const def = buildBotMapDefinition(new ServerCollision(map));
const walk = harnessCollision(def);

/** Largest connected set of free 1 m cells; zombies and humans share it. */
function reachableCells(): Array<{ x: number; z: number }> {
  const { minX, maxX, minZ, maxZ } = def.bounds;
  const free = (x: number, z: number) => {
    const r = walk.resolvePosition(x, z);
    return Math.abs(r.x - x) < 0.02 && Math.abs(r.z - z) < 0.02;
  };
  const key = (x: number, z: number) => `${x},${z}`;
  const seen = new Set<string>();
  let best: Array<{ x: number; z: number }> = [];
  for (let sx = Math.ceil(minX); sx <= maxX; sx++) {
    for (let sz = Math.ceil(minZ); sz <= maxZ; sz++) {
      if (seen.has(key(sx, sz)) || !free(sx, sz)) continue;
      seen.add(key(sx, sz));
      const out = [{ x: sx, z: sz }];
      for (let i = 0; i < out.length; i++) {
        const c = out[i]!;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const x = c.x + dx;
          const z = c.z + dz;
          if (x < minX || x > maxX || z < minZ || z > maxZ) continue;
          const k = key(x, z);
          if (seen.has(k) || !free(x, z)) continue;
          // The step itself must be open, not just both ends.
          if (!free(c.x + dx * 0.5, c.z + dz * 0.5)) continue;
          seen.add(k);
          out.push({ x, z });
        }
      }
      if (out.length > best.length) best = out;
    }
  }
  return best;
}
const cells = reachableCells();

function spread(rng: () => number, count: number, from: number, to: number) {
  const picks: Array<{ x: number; z: number }> = [];
  const lo = Math.floor(cells.length * from);
  const hi = Math.max(lo + 1, Math.floor(cells.length * to));
  for (let i = 0; i < count; i++) {
    picks.push(cells[lo + Math.floor(rng() * (hi - lo))]!);
  }
  return picks;
}

type Result = {
  label: string;
  bots: number;
  shard: number[];
  period: number[];
};

function run(label: string, kind: "zombie" | "balance", count: number): Result {
  const rng = rngFrom(0xC0FFEE + count);
  // Humans in the first slice of the flood order, zombies anywhere.
  const humanSpots = spread(rng, HUMANS, 0, 0.25);
  const humans = humanSpots.map((p, i) =>
    simPawn(`h${i}`, "human", p.x, p.z, { speedScale: 0 })
  );
  const bots: SimPawn[] = [];
  const defs: BotDefinition[] = [];
  for (let i = 0; i < count; i++) {
    const id = `${kind[0]}${i}`;
    bots.push(simPawn(id, "bot", 0, 0, {
      team: kind === "zombie" || i % 2 === 0 ? "B" : "A",
      speedScale: kind === "zombie" ? 0.75 : 1,
      yaw: rng() * 6,
    }));
    defs.push({
      id,
      role: kind === "zombie" ? "raid" : "balance",
      profile: kind === "zombie" ? "zombie" : "balance-bot",
      randomSeed: 1000 + i,
      config: kind === "zombie" ? ZOMBIE_BOT_CONFIG : BALANCE_BOT_CONFIG,
    });
  }
  const pawns = [...humans, ...bots];
  const scatter = () => {
    const spots = spread(rng, bots.length, 0.5, 1);
    bots.forEach((b, i) => {
      b.x = spots[i]!.x;
      b.z = spots[i]!.z;
      b.input = null;
    });
  };
  scatter();

  const engine = createBotThinkEngine();
  engine.loadMap(def);
  engine.synchronizeBots(defs);

  const shard: number[] = [];
  const period: number[] = [];
  let periodMs = 0;
  let tick = 60;
  const total = WARMUP_BOT_TICKS + TIMED_BOT_TICKS;
  for (let bt = 0; bt < total; bt++) {
    if (bt > 0 && bt % WAVE_BOT_TICKS === 0) scatter();
    const timed = bt >= WARMUP_BOT_TICKS;
    for (let s = 0; s < SIM_TICKS_PER_BOT_TICK; s++) {
      const mine = bots.filter((b) => botThinksOnSimPhase(b.id, tick));
      const input = {
        frame: frameOf(tick, def.revision, pawns, kind === "zombie" ? [] : undefined),
        applyTick: tick + 9,
        bots: mine.map((b) => ({ botId: b.id, spawnedAtTick: b.spawnedAtTick })),
      };
      const t0 = performance.now();
      const out = engine.thinkBatch(input);
      const ms = performance.now() - t0;
      if (timed) {
        shard.push(ms);
        periodMs += ms;
      }
      for (const d of out.decisions) {
        const pawn = bots.find((b) => b.id === d.botId)!;
        if (d.action?.input) pawn.input = d.action.input;
      }
      for (const b of bots) walkOneSimTick(walk, b);
      tick++;
    }
    if (timed) {
      period.push(periodMs);
      periodMs = 0;
    }
  }
  return { label, bots: count, shard, period };
}

function stats(xs: readonly number[]) {
  const sorted = [...xs].sort((a, b) => a - b);
  const mean = xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
  return { mean, p95, max: sorted[sorted.length - 1] ?? 0 };
}

const results: Result[] = [];
// Throwaway pass so the first row is not paying for JIT of shared code.
run("jit", "zombie", 8);
const baseline = run("8 balance (baseline)", "balance", 8);
results.push(baseline);
for (const n of COUNTS) {
  results.push(run(n === 0 ? "0 (humans only)" : `${n} zombies`, "zombie", n));
}

const base = stats(baseline.period);
const baseShard = stats(baseline.shard);
const f = (n: number, d = 3) => n.toFixed(d);
console.log(`map            ${MAP_PATH.split("/").pop()} as zombots, ${cells.length} reachable 1 m cells`);
console.log(`humans         ${HUMANS} standing still`);
console.log(`bot ticks      ${TIMED_BOT_TICKS} timed after ${WARMUP_BOT_TICKS} warm-up (x${SIM_TICKS_PER_BOT_TICK} sim ticks each)`);
console.log(`budget         sim tick ${f(SIM_TICK_BUDGET_MS, 2)} ms (${TICK_HZ} Hz, tickTiming.ts); bot period ${f(BOT_PERIOD_BUDGET_MS, 2)} ms (${BOT_TICK_HZ} Hz think, shard of ~1/${SIM_TICKS_PER_BOT_TICK} bots per sim tick)`);
console.log("");
console.log("A. Whole bot period (all N bots think once = the 3 shard batches summed), ms");
console.log("case                     mean     p95     max   mean/base p95/base  %50ms(mean) %50ms(p95)");
for (const r of results) {
  const s = stats(r.period);
  console.log(
    `${r.label.padEnd(22)} ${f(s.mean).padStart(7)} ${f(s.p95).padStart(7)} ${f(s.max).padStart(7)}  ${
      f(s.mean / base.mean, 2).padStart(8)} ${f(s.p95 / base.p95, 2).padStart(8)}  ${
      f(100 * s.mean / BOT_PERIOD_BUDGET_MS, 1).padStart(10)}% ${f(100 * s.p95 / BOT_PERIOD_BUDGET_MS, 1).padStart(10)}%`,
  );
}
console.log("");
console.log("B. Per sim tick (one shard batch of ~N/3 bots), the stall-risk view, ms");
console.log("case                     mean     p95     max   mean/base p95/base  %16.7ms(mean) %(p95) %(max)");
for (const r of results) {
  const s = stats(r.shard);
  console.log(
    `${r.label.padEnd(22)} ${f(s.mean).padStart(7)} ${f(s.p95).padStart(7)} ${f(s.max).padStart(7)}  ${
      f(s.mean / baseShard.mean, 2).padStart(8)} ${f(s.p95 / baseShard.p95, 2).padStart(8)}  ${
      f(100 * s.mean / SIM_TICK_BUDGET_MS, 1).padStart(10)}% ${f(100 * s.p95 / SIM_TICK_BUDGET_MS, 1).padStart(6)}% ${f(100 * s.max / SIM_TICK_BUDGET_MS, 1).padStart(6)}%`,
  );
}
