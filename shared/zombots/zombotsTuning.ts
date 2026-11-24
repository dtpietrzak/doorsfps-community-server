/**
 * The one zombots tuning table (notes/zombots.md, decisions 3–5 and step 3).
 * Every wave, economy, revive and timing number lives here, nowhere else.
 * First-pass values; Phase 2 step 10 perf numbers may lower crowd sizes.
 */

export const ZOMBOTS_TUNING = {
  players: { min: 1, max: 4 },

  timing: {
    /** Before wave 1 once the first human has loaded. */
    firstIntermissionMs: 10_000,
    /** Between waves. */
    intermissionMs: 15_000,
    /** Minimum gap between two zombie spawns inside a wave. */
    spawnIntervalMs: 900,
  },

  waves: {
    /** Zombies in wave 1 with one human. */
    baseCount: 6,
    /** Extra zombies per wave after the first, with one human. */
    growthPerWave: 2,
    /** Count multiplier by human count (index = humans - 1). */
    playerCountMultiplier: [1, 1.6, 2.2, 2.8] as const,
    /** Hard cap on zombies alive at once (tick budget; see step 10). */
    maxAlive: 24,
    /** Health / speed / damage step up once every N waves. */
    stepEveryWaves: 3,
  },

  zombie: {
    baseHealth: 70,
    healthPerStep: 30,
    // Fraction of player walk speed. Half the first-pass 0.75 / 0.05 / 1.1.
    baseSpeedScale: 0.4,
    speedScalePerStep: 0.05,
    maxSpeedScale: 0.75,
    baseMeleeDamage: 10,
    meleeDamagePerStep: 5,
    /**
     * Planar center distance at which a bite connects. Two bodies touch
     * near 0.7, so a zombie has to be on the target.
     */
    meleeRange: 0.7,
    /** Every Nth zombie spawned in a run (10, 20, 30, ...) is a fast mini. */
    miniEvery: 10,
    /** Uniform model / hit-volume scale for a fast mini zombie. */
    miniModelScale: 0.75,
    /** Speed multiplier for a fast mini zombie relative to normal wave zombies. */
    miniSpeedMultiplier: 2,
  },

  points: {
    start: 100,
    hit: 5,
    kill: 50,
    waveSurvived: 250,
  },

  revive: {
    presses: 20,
    costPerPress: 50,
    /** Eye-to-body reach for the revive prompt (world units). */
    reach: 2.0,
    /** Fraction of max HP a revived player stands up with. */
    healthFraction: 0.5,
  },

  racks: {
    /** Eye-to-rack reach for taking a gun (world units). */
    reach: 2.5,
  },
} as const;

export type ZombotsTuning = typeof ZOMBOTS_TUNING;
