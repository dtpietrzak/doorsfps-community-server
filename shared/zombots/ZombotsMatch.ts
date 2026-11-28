/**
 * Zombots wave rules (notes/zombots.md, step 1).
 *
 * The server runtime and the local client both drive this with `tick`. It
 * returns intents and does not spawn bots, open doors, or read the clock.
 * Time and randomness come in as arguments so the same inputs replay the
 * same intents.
 *
 * Spawn spread: the first zombie of a wave draws one `rng()` value and
 * starts a round-robin at that offset into the spawns the gate currently
 * allows, in constructor order. Later spawns step one entry from there. If
 * the gate allows nothing, the walk uses every spawn. An empty spawn list
 * never draws and never emits a zombie, and that wave does not clear — an
 * instant clear would pay out `waveCleared` with no fight.
 */

import { floor, min, round } from "../math/scalar.ts";
import type {
  ZombotsEvent,
  ZombotsIntent,
  ZombotsPhase,
  ZombotsPlayerId,
  ZombotsSpawnGate,
  ZombotsSpawnPoint,
} from "./types.ts";
import { ZOMBOTS_TUNING } from "./zombotsTuning.ts";

/**
 * Fields of {@link ZOMBOTS_TUNING} the wave machine reads.
 * Widened from the const table so a test or a later pass can override one
 * number. `ZombotsTuning` itself is a literal type, so a modified copy is
 * not assignable to it.
 */
export type ZombotsMatchTuning = {
  readonly players: { readonly min: number; readonly max: number };
  readonly timing: {
    readonly firstIntermissionMs: number;
    readonly intermissionMs: number;
    readonly spawnIntervalMs: number;
  };
  readonly waves: {
    readonly baseCount: number;
    readonly growthPerWave: number;
    readonly playerCountMultiplier: readonly number[];
    readonly maxAlive: number;
    readonly stepEveryWaves: number;
  };
  readonly zombie: {
    readonly baseHealth: number;
    readonly healthPerStep: number;
    readonly baseSpeedScale: number;
    readonly speedScalePerStep: number;
    readonly maxSpeedScale: number;
    readonly baseMeleeDamage: number;
    readonly meleeDamagePerStep: number;
    readonly miniEvery: number;
    readonly miniModelScale: number;
    readonly miniSpeedMultiplier: number;
    readonly grandpaEvery: number;
    readonly grandpaSpeedMultiplier: number;
    readonly grandpaHealthMultiplier: number;
    readonly tallEvery: number;
    readonly tallWalkSpeedMultiplier: number;
  };
};

/** One wave's crowd and the body each of its zombies spawns with. */
export type ZombotsWavePlan = {
  wave: number;
  /** Human count used for the multiplier, after clamping to the tuning cap. */
  humans: number;
  count: number;
  /** How many times health, speed and damage have stepped up. */
  step: number;
  health: number;
  speedScale: number;
  meleeDamage: number;
};

/**
 * Crowd size and per-zombie stats for a 1-based wave.
 * `humans` is clamped to the tuning player range (stock table: 1..4).
 * A wave below 1 is treated as wave 1 so a HUD read before the first
 * start cannot produce a negative crowd.
 */
export function zombotsWavePlan(
  wave: number,
  humans: number,
  tuning: ZombotsMatchTuning = ZOMBOTS_TUNING,
): ZombotsWavePlan {
  const w = clampedWave(wave);
  const h = clampedHumanCount(humans, tuning);
  const mult = multiplierFor(h, tuning);
  const raw = (tuning.waves.baseCount + tuning.waves.growthPerWave * (w - 1)) *
    mult;
  const rounded = round(raw);
  const every = tuning.waves.stepEveryWaves;
  const step = every > 0 ? floor((w - 1) / every) : 0;
  const speed = min(
    tuning.zombie.maxSpeedScale,
    tuning.zombie.baseSpeedScale + tuning.zombie.speedScalePerStep * step,
  );
  return {
    wave: w,
    humans: h,
    count: rounded > 0 ? rounded : 0,
    step,
    health: tuning.zombie.baseHealth + tuning.zombie.healthPerStep * step,
    speedScale: speed,
    meleeDamage: tuning.zombie.baseMeleeDamage +
      tuning.zombie.meleeDamagePerStep * step,
  };
}

/**
 * Wave / wipe state. Downed humans stay down across waves; only
 * {@link ZombotsMatch.markRevived} stands one back up.
 */
export class ZombotsMatch {
  private readonly spawns: readonly ZombotsSpawnPoint[];
  private readonly rng: () => number;
  private readonly tuning: ZombotsMatchTuning;

  private phaseValue: ZombotsPhase = "waiting";
  /** Last wave that has started. 0 until wave 1 begins. */
  private waveValue = 0;
  private intermissionLeftMs = 0;
  private wavePlan: ZombotsWavePlan | null = null;

  /** Connected humans, join order. Downed ids stay in this set. */
  private readonly humanIds = new Set<ZombotsPlayerId>();
  /** Subset of {@link humanIds} waiting on a revive. */
  private readonly downedIds = new Set<ZombotsPlayerId>();

  /** Emitted spawn intents not yet confirmed with `zombieSpawned`. */
  private pending = 0;
  /** Still to emit this wave. */
  private remaining = 0;
  private readonly aliveIds = new Set<string>();
  /** Killed this wave, so a duplicate spawn event cannot refill the cap. */
  private readonly deadIds = new Set<string>();

  private spawnWaitMs = 0;
  private cursor = 0;
  private cursorReady = false;
  /** Total zombies emitted across the run (1-based on emit) for mini cadence. */
  private spawnSeq = 0;

  constructor(input: {
    zombieSpawns: readonly ZombotsSpawnPoint[];
    /** Uniform draw in [0, 1). Called once per wave, on the first spawn. */
    rng: () => number;
    tuning?: ZombotsMatchTuning;
  }) {
    this.spawns = input.zombieSpawns.map((spawn) => ({
      id: spawn.id,
      p: { x: spawn.p.x, z: spawn.p.z },
    }));
    this.rng = input.rng;
    this.tuning = input.tuning ?? ZOMBOTS_TUNING;
  }

  /**
   * Apply `events` in order, then advance `dtMs`.
   * Events are what already happened this step; a kill that clears a wave
   * spends the same `dtMs` on the intermission that follows.
   * Once the run is over, further ticks return no intents.
   */
  tick(
    dtMs: number,
    events: readonly ZombotsEvent[],
    spawnGate: ZombotsSpawnGate,
  ): ZombotsIntent[] {
    const intents: ZombotsIntent[] = [];
    // Copy the phase out. A direct `=== "over"` check narrows the field for
    // the rest of the method, and the compiler then treats later checks as dead
    // even after applyEvent moves the run to "over".
    if (this.phaseNow() === "over") return intents;
    for (const event of events) {
      this.applyEvent(event, intents);
      if (this.phaseNow() === "over") return intents;
    }
    this.advance(dtMs > 0 ? dtMs : 0, spawnGate, intents);
    return intents;
  }

  private phaseNow(): ZombotsPhase {
    return this.phaseValue;
  }

  /**
   * Glue calls this when revive.ts finishes a revive.
   * No effect once the run is over, or if that human is not down.
   */
  markRevived(playerId: ZombotsPlayerId): void {
    if (this.phaseValue === "over") return;
    this.downedIds.delete(playerId);
  }

  get phase(): ZombotsPhase {
    return this.phaseValue;
  }

  /**
   * 0 before wave 1 starts. After a clear, stays on the cleared wave until
   * the next one starts, so `msUntilNextWave` counts down to `wave + 1`.
   */
  get wave(): number {
    return this.waveValue;
  }

  /**
   * Zombies still owed this wave: not yet emitted, emitted but not confirmed,
   * and confirmed still standing. Pending is included so the HUD does not
   * dip in the gap between a spawn intent and `zombieSpawned`. 0 outside a wave.
   */
  get zombiesLeft(): number {
    if (this.phaseValue !== "wave") return 0;
    return this.remaining + this.pending + this.aliveIds.size;
  }

  /** Milliseconds of intermission left. 0 in every other phase. */
  get msUntilNextWave(): number {
    if (this.phaseValue !== "intermission") return 0;
    return this.intermissionLeftMs > 0 ? this.intermissionLeftMs : 0;
  }

  /** Live view, join order. Do not mutate. */
  get downed(): ReadonlySet<ZombotsPlayerId> {
    return this.downedIds;
  }

  /** Connected humans, including downed, in join order. Do not mutate. */
  get humans(): ReadonlySet<ZombotsPlayerId> {
    return this.humanIds;
  }

  private applyEvent(event: ZombotsEvent, intents: ZombotsIntent[]): void {
    if (this.phaseValue === "over") return;
    switch (event.kind) {
      case "playerJoined":
        this.onJoined(event.playerId);
        return;
      case "playerLeft":
        this.onLeft(event.playerId, intents);
        return;
      case "playerDowned":
        this.onDowned(event.playerId, intents);
        return;
      case "zombieSpawned":
        this.onSpawned(event.zombieId);
        return;
      case "zombieKilled":
        this.onKilled(event.zombieId, intents);
        return;
      case "zombieHit":
        // Points for a hit are awarded by zompoints.ts, not here.
        return;
    }
  }

  private onJoined(playerId: ZombotsPlayerId): void {
    if (this.humanIds.has(playerId)) return;
    // A rejoin after playerLeft is a new living human. Leaving already
    // dropped any downed flag; wave starts never do that on their own.
    this.humanIds.add(playerId);
    if (this.phaseValue === "waiting") {
      this.phaseValue = "intermission";
      this.intermissionLeftMs = this.tuning.timing.firstIntermissionMs;
    }
  }

  private onLeft(playerId: ZombotsPlayerId, intents: ZombotsIntent[]): void {
    if (!this.humanIds.delete(playerId)) return;
    this.downedIds.delete(playerId);
    // Waiting means nobody has loaded. An empty room after that is over,
    // not a fresh lobby — the host builds a new match to play again.
    if (this.phaseValue === "waiting") return;
    if (this.humanIds.size === 0 || this.allHumansDowned()) this.endRun(intents);
  }

  private onDowned(playerId: ZombotsPlayerId, intents: ZombotsIntent[]): void {
    if (!this.humanIds.has(playerId)) return;
    if (this.downedIds.has(playerId)) return;
    this.downedIds.add(playerId);
    if (this.allHumansDowned()) this.endRun(intents);
  }

  private onSpawned(zombieId: string): void {
    if (this.phaseValue !== "wave") return;
    if (this.aliveIds.has(zombieId) || this.deadIds.has(zombieId)) return;
    if (this.pending <= 0) return;
    this.pending -= 1;
    this.aliveIds.add(zombieId);
  }

  private onKilled(zombieId: string, intents: ZombotsIntent[]): void {
    if (this.phaseValue !== "wave") return;
    if (!this.aliveIds.delete(zombieId)) return;
    this.deadIds.add(zombieId);
    // Still owed means the wave is not over, even if nobody is standing.
    if (this.remaining > 0 || this.pending > 0 || this.aliveIds.size > 0) return;
    this.clearWave(intents);
  }

  private clearWave(intents: ZombotsIntent[]): void {
    intents.push({ kind: "waveCleared", wave: this.waveValue });
    this.phaseValue = "intermission";
    this.intermissionLeftMs = this.tuning.timing.intermissionMs;
    this.wavePlan = null;
    this.remaining = 0;
    this.pending = 0;
    this.spawnWaitMs = 0;
    this.aliveIds.clear();
    this.deadIds.clear();
  }

  private endRun(intents: ZombotsIntent[]): void {
    if (this.phaseValue === "over") return;
    const waveReached = this.waveValue;
    this.phaseValue = "over";
    intents.push({ kind: "runOver", waveReached });
  }

  private allHumansDowned(): boolean {
    if (this.humanIds.size === 0) return false;
    for (const id of this.humanIds) {
      if (!this.downedIds.has(id)) return false;
    }
    return true;
  }

  private advance(
    dt: number,
    spawnGate: ZombotsSpawnGate,
    intents: ZombotsIntent[],
  ): void {
    let time = dt;
    if (this.phaseValue === "intermission") {
      if (time < this.intermissionLeftMs) {
        this.intermissionLeftMs -= time;
        return;
      }
      time -= this.intermissionLeftMs;
      this.intermissionLeftMs = 0;
      this.beginWave(intents);
    }
    if (this.phaseValue === "wave") this.spawnDuring(time, spawnGate, intents);
  }

  private beginWave(intents: ZombotsIntent[]): void {
    if (this.humanIds.size === 0 || this.allHumansDowned()) {
      this.endRun(intents);
      return;
    }
    this.waveValue += 1;
    this.phaseValue = "wave";
    // Locked here. A join mid-wave counts toward the next wave, not this one.
    // Downed humans still count: the crowd does not shrink because someone fell.
    this.wavePlan = zombotsWavePlan(
      this.waveValue,
      this.humanIds.size,
      this.tuning,
    );
    this.remaining = this.wavePlan.count;
    this.pending = 0;
    this.spawnWaitMs = 0;
    this.cursor = 0;
    this.cursorReady = false;
    this.aliveIds.clear();
    this.deadIds.clear();
    intents.push({
      kind: "waveStart",
      wave: this.waveValue,
      zombieCount: this.wavePlan.count,
    });
  }

  private spawnDuring(
    time: number,
    spawnGate: ZombotsSpawnGate,
    intents: ZombotsIntent[],
  ): void {
    const interval = this.tuning.timing.spawnIntervalMs;
    // Each pass either waits out the gap or emits one zombie. Emitting
    // spends budget, so a zero interval cannot spin: the cap or the budget stops it.
    while (this.phaseValue === "wave") {
      if (this.spawnWaitMs > 0) {
        if (time < this.spawnWaitMs) {
          this.spawnWaitMs -= time;
          return;
        }
        time -= this.spawnWaitMs;
        this.spawnWaitMs = 0;
      }
      if (!this.emitSpawn(spawnGate, intents)) return;
      if (interval > 0) this.spawnWaitMs = interval;
    }
  }

  private emitSpawn(
    spawnGate: ZombotsSpawnGate,
    intents: ZombotsIntent[],
  ): boolean {
    const plan = this.wavePlan;
    if (!plan || this.remaining <= 0) return false;
    // Pending counts against the cap so a burst of intents cannot overshoot
    // before the glue answers with zombieSpawned.
    if (this.pending + this.aliveIds.size >= this.tuning.waves.maxAlive) {
      return false;
    }
    const pool = this.spawnPool(spawnGate);
    if (pool.length === 0) return false;
    const spawn = pool[this.nextSpawnIndex(pool.length)];
    this.remaining -= 1;
    this.pending += 1;
    this.spawnSeq += 1;
    const miniEvery = this.tuning.zombie.miniEvery;
    const isMini = miniEvery > 0 && this.spawnSeq % miniEvery === 0;
    const grandpaEvery = this.tuning.zombie.grandpaEvery;
    const isGrandpa = !isMini && grandpaEvery > 0 &&
      this.spawnSeq % grandpaEvery === 0;
    const tallEvery = this.tuning.zombie.tallEvery;
    const isTall = !isMini && !isGrandpa && tallEvery > 0 &&
      this.spawnSeq % tallEvery === 0;
    const speedScale = isMini
      ? plan.speedScale * this.tuning.zombie.miniSpeedMultiplier
      : isGrandpa
      ? plan.speedScale * this.tuning.zombie.grandpaSpeedMultiplier
      : isTall
      ? plan.speedScale * this.tuning.zombie.tallWalkSpeedMultiplier
      : plan.speedScale;
    const health = isGrandpa
      ? round(plan.health * this.tuning.zombie.grandpaHealthMultiplier)
      : plan.health;
    const modelScale = isMini ? this.tuning.zombie.miniModelScale : 1;
    intents.push({
      kind: "spawnZombie",
      wave: this.waveValue,
      spawnId: spawn.id,
      p: { x: spawn.p.x, z: spawn.p.z },
      health,
      speedScale,
      modelScale,
      grandpa: isGrandpa,
      tall: isTall,
      meleeDamage: plan.meleeDamage,
    });
    return true;
  }

  /**
   * Gate-open spawns in constructor order. When every spawn is closed, the
   * whole list is the pool so a sealed map still has a way in.
   */
  private spawnPool(spawnGate: ZombotsSpawnGate): readonly ZombotsSpawnPoint[] {
    const open: ZombotsSpawnPoint[] = [];
    for (let i = 0; i < this.spawns.length; i++) {
      const spawn = this.spawns[i];
      if (spawnGate(spawn.id)) open.push(spawn);
    }
    return open.length > 0 ? open : this.spawns;
  }

  /** Round-robin index. The first call of a wave draws the start offset. */
  private nextSpawnIndex(poolLength: number): number {
    if (!this.cursorReady) {
      let offset = floor(this.rng() * poolLength);
      if (offset < 0) offset = 0;
      if (offset >= poolLength) offset = poolLength - 1;
      this.cursor = offset;
      this.cursorReady = true;
    }
    const index = this.cursor % poolLength;
    this.cursor += 1;
    return index;
  }
}

function clampedWave(wave: number): number {
  const n = floor(wave);
  return n < 1 ? 1 : n;
}

/** Stock tuning clamps to 1..4 via `players.min` / `players.max`. */
function clampedHumanCount(humans: number, tuning: ZombotsMatchTuning): number {
  const n = floor(humans);
  const lo = tuning.players.min;
  const hi = tuning.players.max;
  if (hi < lo) return lo;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function multiplierFor(humans: number, tuning: ZombotsMatchTuning): number {
  const table = tuning.waves.playerCountMultiplier;
  if (table.length === 0) return 1;
  let index = humans - 1;
  if (index < 0) index = 0;
  if (index >= table.length) index = table.length - 1;
  return table[index];
}
