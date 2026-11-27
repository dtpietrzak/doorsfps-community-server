/**
 * Stuck-zombie safety net (2026-11-24, notes/zombots.md "Stuck zombies").
 *
 * A zombie that makes no progress gets moved to another open spawn, a few
 * times at most, and is removed (no points) after a long stall. Every zombie
 * is also removed at a hard lifetime ceiling, so a wave can never soft-lock.
 * "Progress" is moving {@link ZOMBOTS_TUNING.stuck.progressRadius} from the
 * last anchor, taking damage, or landing a hit. A zombie holding near an
 * active dis-rack-tor lure is waiting on purpose, not stuck.
 *
 * Pure: the glue passes in tick, positions and the spawn gate, and applies
 * the decisions (teleport, despawn, log). The server runtime and the local
 * singleplayer driver both drive this.
 */

import { distanceSquared2 } from "../math/distance.ts";
import type { ZombotsSpawnGate, ZombotsSpawnPoint } from "./types.ts";
import { ZOMBOTS_TUNING } from "./zombotsTuning.ts";

type Vec2 = { x: number; z: number };

export type ZombieWatchTuning = {
  readonly progressRadius: number;
  readonly relocateAfterMs: number;
  readonly maxRelocates: number;
  readonly killAfterMs: number;
  readonly maxLifetimeMs: number;
  readonly lureHoldRadius: number;
  readonly relocateClearRadius: number;
};

/** One live zombie as the watch sees it this tick. */
export type ZombieWatchBody = { id: string; x: number; z: number; health: number };

/** What the watch knew about a zombie when it decided. For logs. */
export type ZombieWatchStats = {
  ageMs: number;
  noProgressMs: number;
  relocates: number;
};

export type ZombieWatchDecision =
  | { kind: "kill"; id: string; reason: "lifetime" | "stagnant"; stats: ZombieWatchStats }
  | {
    kind: "relocate";
    id: string;
    from: Vec2;
    spawn: ZombotsSpawnPoint;
    /** Counted after this relocate. */
    stats: ZombieWatchStats;
  };

export type ZombieWatchStepInput = {
  tick: number;
  tickMs: number;
  /** Every live zombie, in a stable order (the glue's spawn order). */
  zombies: readonly ZombieWatchBody[];
  /** Living humans, so a relocate never drops a zombie on someone. */
  humans: readonly Vec2[];
  /** Active dis-rack-tor lure point, or null. */
  lure: Vec2 | null;
  /** Every zombie spawn on the map, in map order. */
  spawns: readonly ZombotsSpawnPoint[];
  spawnGate: ZombotsSpawnGate;
  /** Rotates relocate picks between calls (the glue's zombie counter). */
  seq: number;
};

type Row = {
  spawnedAtTick: number;
  anchorX: number;
  anchorZ: number;
  lastProgressTick: number;
  stagnantSinceTick: number;
  lastHealth: number;
  relocates: number;
};

export class ZombieWatch {
  private readonly rows = new Map<string, Row>();
  private readonly tuning: ZombieWatchTuning;

  constructor(tuning: ZombieWatchTuning = ZOMBOTS_TUNING.stuck) {
    this.tuning = tuning;
  }

  /** Start watching a zombie that just spawned. */
  track(id: string, at: Vec2, health: number, tick: number): void {
    this.rows.set(id, {
      spawnedAtTick: tick,
      anchorX: at.x,
      anchorZ: at.z,
      lastProgressTick: tick,
      stagnantSinceTick: tick,
      lastHealth: health,
      relocates: 0,
    });
  }

  forget(id: string): void {
    this.rows.delete(id);
  }

  clear(): void {
    this.rows.clear();
  }

  get size(): number {
    return this.rows.size;
  }

  /** A hit landed by or on this zombie counts as progress. */
  markProgress(id: string, tick: number, health: number): void {
    const row = this.rows.get(id);
    if (!row) return;
    row.lastProgressTick = tick;
    row.stagnantSinceTick = tick;
    row.lastHealth = health;
  }

  /**
   * One tick of watching. Returns kills and relocates in zombie order. A
   * killed zombie is forgotten here; the glue still despawns it. A relocated
   * zombie's new anchor is the spawn, and later zombies in the same call see
   * it there.
   */
  step(input: ZombieWatchStepInput): ZombieWatchDecision[] {
    const out: ZombieWatchDecision[] = [];
    if (input.zombies.length === 0) return out;
    const t = this.tuning;
    const { tick, tickMs } = input;
    const progress2 = t.progressRadius * t.progressRadius;
    const lure2 = t.lureHoldRadius * t.lureHoldRadius;
    // Positions as they stand after this call's relocates.
    const bodies = input.zombies.map((z) => ({ ...z }));

    for (const z of bodies) {
      const row = this.rows.get(z.id);
      if (!row) {
        this.track(z.id, z, z.health, tick);
        continue;
      }

      if (input.lure && distanceSquared2(z.x - input.lure.x, z.z - input.lure.z) <= lure2) {
        row.lastProgressTick = tick;
        row.stagnantSinceTick = tick;
        row.lastHealth = z.health;
        continue;
      }

      const stats = (): ZombieWatchStats => ({
        ageMs: (tick - row.spawnedAtTick) * tickMs,
        noProgressMs: (tick - row.lastProgressTick) * tickMs,
        relocates: row.relocates,
      });

      if ((tick - row.spawnedAtTick) * tickMs >= t.maxLifetimeMs) {
        out.push({ kind: "kill", id: z.id, reason: "lifetime", stats: stats() });
        this.rows.delete(z.id);
        continue;
      }

      if (distanceSquared2(z.x - row.anchorX, z.z - row.anchorZ) >= progress2) {
        row.anchorX = z.x;
        row.anchorZ = z.z;
        row.lastProgressTick = tick;
        row.stagnantSinceTick = tick;
      } else if (z.health < row.lastHealth) {
        row.lastProgressTick = tick;
        row.stagnantSinceTick = tick;
      }
      row.lastHealth = z.health;

      if ((tick - row.lastProgressTick) * tickMs >= t.killAfterMs) {
        out.push({ kind: "kill", id: z.id, reason: "stagnant", stats: stats() });
        this.rows.delete(z.id);
        continue;
      }

      const stagnantMs = (tick - row.stagnantSinceTick) * tickMs;
      if (stagnantMs < t.relocateAfterMs || row.relocates >= t.maxRelocates) continue;
      const spawn = this.pickRelocateSpawn(input, bodies, z, row.relocates, progress2);
      if (!spawn) continue;
      const from = { x: z.x, z: z.z };
      z.x = spawn.p.x;
      z.z = spawn.p.z;
      row.anchorX = spawn.p.x;
      row.anchorZ = spawn.p.z;
      row.stagnantSinceTick = tick;
      row.relocates += 1;
      out.push({ kind: "relocate", id: z.id, from, spawn, stats: stats() });
    }
    return out;
  }

  /**
   * An open spawn (any spawn when none is open) far from where the zombie is
   * stuck and clear of every other body, rotating with `seq + relocates`.
   * Each filter falls back to the step before it when it would leave nothing.
   */
  private pickRelocateSpawn(
    input: ZombieWatchStepInput,
    bodies: readonly ZombieWatchBody[],
    self: ZombieWatchBody,
    relocates: number,
    minDist2: number,
  ): ZombotsSpawnPoint | null {
    const all = input.spawns;
    if (all.length === 0) return null;
    const open = all.filter((s) => input.spawnGate(s.id));
    const pool = open.length > 0 ? open : all;
    const far = pool.filter((s) => distanceSquared2(s.p.x - self.x, s.p.z - self.z) >= minDist2);
    const base = far.length > 0 ? far : pool;
    const clearR = this.tuning.relocateClearRadius;
    const clear2 = clearR * clearR;
    const clear = base.filter((s) => {
      for (const other of bodies) {
        if (other.id === self.id) continue;
        if (distanceSquared2(s.p.x - other.x, s.p.z - other.z) < clear2) return false;
      }
      for (const h of input.humans) {
        if (distanceSquared2(s.p.x - h.x, s.p.z - h.z) < clear2) return false;
      }
      return true;
    });
    const candidates = clear.length > 0 ? clear : base;
    return candidates[(input.seq + relocates) % candidates.length]!;
  }
}
