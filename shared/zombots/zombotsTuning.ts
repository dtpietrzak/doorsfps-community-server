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
    costPerPress: 10,
    /** Eye-to-body reach for the revive prompt (world units). */
    reach: 2.0,
    /** Fraction of max HP a revived player stands up with. */
    healthFraction: 0.5,
  },

  doors: {
    /**
     * Zompoints one door press pays. A door costing more is bought in charges
     * of this size (the last one may be smaller), and anyone can pay any of
     * them, so a team can split a door.
     */
    chargeSize: 1000,
  },

  racks: {
    /** Eye-to-rack reach for taking a gun (world units). */
    reach: 2.5,
    /** Zompoints per mag from a gun rack (first take buys all mags; refill buys missing spare mags). */
    gunCostPerMag: 20,
    /** Zompoints one power recharge rack use costs. */
    powerCost: 300,
    /** Zompoints the first dis-rack-tor use costs. */
    distractorBaseCost: 2000,
    /** Extra zompoints added to the dis-rack-tor cost after each use. */
    distractorCostStep: 500,
    /** How long (ms) an activated dis-rack-tor lures all zombies to itself. */
    distractorDurationMs: 60_000,
  },

  stuck: {
    /** Planar displacement (m) from anchor that counts as real progress. */
    progressRadius: 2.0,
    /** No-progress time before relocating a stuck zombie to an open spawn. */
    relocateAfterMs: 15_000,
    /** Maximum relocates before falling back to auto-kill. */
    maxRelocates: 2,
    /** Continuous no-progress time before auto-killing a stuck zombie. */
    killAfterMs: 45_000,
    /** Hard ceiling on how long any single zombie may stay alive. */
    maxLifetimeMs: 240_000,
  },
} as const;

export type ZombotsTuning = typeof ZOMBOTS_TUNING;
