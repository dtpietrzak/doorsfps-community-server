/**
 * Wire shape for a bot brain, plus the configs the built-in brain ships:
 * community autofill, balance filler, and grey agents.
 * Official Easy / Medium / Hard tier numbers stay in the private engine.
 */

export type BotDifficulty = "easy" | "medium" | "hard";

export type BotBrainConfig = {
  /** Stable id for logging / CLI / tests (e.g. "easy", "medium", "hard"). */
  id: string;
  /**
   * Force-hold sprint when true (OR’d with zone / open sprint), still only
   * while world move aims at the enemy door (FOV cone). Tier defaults keep
   * this false; real sprint is map-hint + open-lane driven.
   */
  sprint: boolean;
  /**
   * When zone (door FOV) or open lane (lenient door-run) would sprint,
   * P(actually sprint) for this bot. Rolled once when that condition becomes
   * true; latched until it drops (separate latches for zone vs open).
   * Easy lower; hard ~1. Force `sprint` skips chance/zone/open but still needs
   * door FOV move yaw.
   */
  sprintChance: number;

  // ── Live: lock-on reaction (suppress shoot until elapsed) ──

  /** Lock → first-shot delay base (ms). Rolled on combat lock acquire. */
  reactionBaseMs: number;
  /** Extra reaction variance window (ms): delay = base + U[0, variance]. */
  reactionVarianceMs: number;

  // ── Live: fire-rate penalty (extra on top of weapon CD) ──

  /**
   * Extra ms between shots on top of the equipped weapon’s fire cooldown.
   * Effective gap after a real shot = `weapon.fireCooldownMs + shotIntervalMs`.
   * Easy +500, medium +50, hard 0 (weapon CD only — same as today).
   */
  shotIntervalMs: number;

  // ── Live: accuracy gate (intentional miss) ──

  /**
   * Fraction of eligible shot opportunities that actually click (0..1).
   * Eligible = reaction ready + ROF ready + hostile in aim box.
   * A failed roll wastes a full weapon fireCooldown + shotInterval cycle
   * so low values spray less DPS (not re-rolled every think).
   */
  hitChance: number;

  /**
   * P(latch head vs torso) on a new combat lock (0..1). Fed to
   * {@link headAimChance} independently of {@link hitChance} so easy bots
   * torso-fire while hard bots can still head-aim.
   */
  headAim: number;

  /**
   * How far ahead (seconds) sticky combat look / click extrapolates enemy
   * motion. Easy 0 (live body); hard ≈ think→apply buffer (~0.15 s).
   * Predicted point is rejected when it has no LOS.
   */
  leadSec: number;

  /**
   * 0 → never activate skills (community / agents).
   * &gt;0 → situational pick (heal / Hawkeyes / fight / stuck) may activate
   * when the player snapshot's activation gate allows. Not a 20 Hz Bernoulli.
   */
  skillUseChance: number;
  /**
   * Scale on shared residual heat (`humanHeatMax * this`). Roamers
   * (low {@link doorAggression}) trust the prior more; rushers trust door
   * geometry. 0 disables the term. Official pool bots only — community /
   * agents skip heat entirely.
   */
  humanHeatWeight: number;

  // ── Live style (minSeparation / doorAggression) + reserved campBias ──

  /**
   * Min horizontal distance from a locked enemy before plant. Closer than
   * this, combat holds S (keeps A/D) until past the range.
   */
  minSeparation: number;
  /**
   * Personality: 0 = homebody, 1 = door rusher.
   * At/above 0.5, combat PWM suppresses S while world move progresses toward
   * the enemy door (strafe/fight instead of reverse moonwalk).
   */
  doorAggression: number;
  /**
   * Reserved personality: 0 = rarely camp, 1 = loves holds.
   * Not wired — hold preference is not driven by this yet.
   */
  campBias: number;

  // ── Live: BotBrain constructor + pipeline ──

  /**
   * Personality: P(stand ground for the whole combat lock) in [0, 1].
   * Rolled once when targetEnemy acquires a lock. Hit → cancel path keys and
   * run stand-ground ADAD (or plant when strafe avg is 0). Miss → keep PWM
   * path / door-chase under combat look until unlock.
   */
  targetEnemyStandGroundChance: number;
  /**
   * Mean active A/D hold while stand-ground (ms). 0 ⇒ pure plant-and-shoot
   * when stand-ground hits (easy / agents).
   */
  targetEnemyStrafeAvgMs: number;
  /**
   * Mean stand-still gap between A/D holds while stand-ground (ms).
   * 0 still allows rolled pauses (default band) and random ADAD exit.
   */
  targetEnemyStrafePauseAvgMs: number;
  /**
   * Relative duration jitter in [0, 1] for both strafe and pause averages.
   * 0 = fixed lengths; 0.3 ≈ ±30%.
   */
  targetEnemyStrafeVariation: number;
  /**
   * Personality: agent aggression in [0, 1] (team bots while doors closed).
   * - `< 0.5` → enemy-door camp
   * - `≥ 0.5` → agent hunt; agent-first = `clamp01(agg / 0.5)`
   *   (0 → 0% agent-first, 0.5 → 100%)
   * Grey agents always hunt (never camp); value is documentary for them.
   */
  agentAggression: number;
  /**
   * Personality: camping look-check anxiety in [0, 1].
   * Maps to hold seconds between look spots via campLookHoldRangeSec
   * (high anxiety → shorter holds). Shared helper for camping timers.
   */
  campingAnxiety: number;
  /**
   * Personality: random path ADAD intensity in [0, 1] while walking yaw-poles.
   * 0 = never; higher → more frequent / fuller lateral holds. High values
   * still rest (dead-chance floor + random burst exit).
   */
  pathStrafe: number;
  /**
   * Authored Nudge-line A/D activity in [0, 1].
   * Omit to inherit `pathStrafe`; dedicated defaults let simple and grey bots
   * follow Nudge lines without enabling random path ADAD everywhere else.
   */
  nudgeStrafe?: number;
  /**
   * Personality: corner-round intensity (may exceed 1 for over-round).
   * 1 ≈ full normal race-line; &gt;1 harder outside cut.
   */
  cornerRound: number;

  // ── Live: aim motors (tier-fixed; profile inherits base tier) ──

  /**
   * @deprecated Nav intent is pass-through (no low-pass). Kept for config
   * shape / dumb-bot compatibility; ignored by yawIntent.
   */
  yawNavTauSec: number;
  /**
   * @deprecated Legacy accel–decel responsiveness dial (seconds). The aim
   * planner takes its timing from {@link BotBrainConfig.aimFittsASec} /
   * {@link BotBrainConfig.aimFittsBSec}; kept for config shape and only read
   * when those are absent.
   */
  yawLookTauSec: number;
  /**
   * Combat lock → mouse start delay base (ms). Separate from shoot reaction.
   * Easy ~250, medium ~120, hard ~70.
   */
  lookReactionBaseMs: number;
  /** Extra look-reaction variance (ms): delay = base + U[0, variance]. */
  lookReactionVarianceMs: number;
  /**
   * Min extra landing gain on a **surprise acquire**: the primary stroke aims
   * this fraction of the amplitude past the target (easy larger). Normal aims
   * undershoot instead ({@link BotBrainConfig.aimPrimaryGainMean}).
   * Peak intensity: scaled down when still / steady, full when A/D speed
   * changes hard over ~500 ms.
   */
  yawOvershootMinFrac: number;
  /** Max extra landing gain on a surprise acquire (peak; AD-scaled). */
  yawOvershootMaxFrac: number;
  /**
   * Correlated micro-correction amplitude (radians). Slow aim wander.
   * Peak intensity: quieter when plant/steady, full on A/D acceleration.
   */
  yawMicroNoiseAmp: number;
  /**
   * Combat tracking-error kick scale (radians). Imperfect lead on movers.
   */
  yawTrackErrorAmp: number;
  /**
   * Continuous combat pitch micro-wander amplitude (radians).
   * Applied every think while combat-locked (yaw-humanize analogue for pitch).
   * Tier defaults ~3× yaw micro so vertical aim is visibly imperfect.
   */
  pitchMicroNoiseAmp: number;
  /**
   * Continuous combat pitch track-error kick scale (radians).
   * Random vertical lead error that decays while locked.
   */
  pitchTrackErrorAmp: number;
  /**
   * Half-angle of the shoot aim box in **degrees** (yaw + pitch).
   * Easy 3°, medium 2°, hard 1°. Converted to rad at click.
   */
  shootAimHalfAngleDeg: number;

  // ── Live: aim planner (mouse timing / accuracy) ──

  /**
   * Fitts intercept (seconds): floor on any aim stroke's duration.
   * With {@link BotBrainConfig.aimFittsBSec} 0 → instant look (community /
   * balance bots).
   */
  aimFittsASec: number;
  /**
   * Fitts slope (seconds per bit): how much longer a harder stroke takes.
   * Duration = `a + b·log2(1 + amplitude / width)`; easy slower, hard snappier.
   */
  aimFittsBSec: number;
  /**
   * Target width for non-combat (path) look in **degrees** — coarse, because
   * facing a corner is not a precision aim. Combat uses
   * {@link BotBrainConfig.shootAimHalfAngleDeg} instead.
   */
  aimPathWidthDeg: number;
  /**
   * Mean landing gain of a primary stroke: below 1 stops short of the target
   * (the human default) and lets a correction finish the job.
   */
  aimPrimaryGainMean: number;
  /** Uniform spread around {@link BotBrainConfig.aimPrimaryGainMean}. */
  aimPrimaryGainSpread: number;
  /** Dwell before a corrective stroke (ms) — hand settle, ±40% jitter. */
  aimCorrectionDelayMs: number;
  /** Max corrective strokes per target before living with the error. */
  aimMaxCorrections: number;
  /**
   * Stroke bow as a fraction of amplitude (0 = dead straight). Keeps yaw and
   * pitch coupled into a curved path instead of an L.
   */
  aimCurvature: number;
  /**
   * Smooth-pursuit lag against a moving target (ms): aim trails a strafing
   * enemy by about this much before catching up. Target jumps re-anchor
   * instantly (reaction delay is {@link BotBrainConfig.lookReactionBaseMs}).
   */
  aimPursuitLagMs: number;

  // ── Live: trigger discipline (when the click is allowed) ──

  /**
   * Min ms between this bot's own clicks, on top of the weapon cooldown —
   * a hand cannot spam a semi-auto at the weapon's cap. Jittered ±25% per
   * shot. 0 → weapon cooldown only (community / balance bots).
   */
  clickCadenceMs: number;
  /**
   * Settle delay (ms) after the crosshair first reaches the target before the
   * trigger is allowed: aim arrives, *then* the shot follows. Jittered ±40%.
   * Re-armed whenever the aim leaves the box.
   */
  clickSettleMs: number;

  // ── Live: yaw-pole score noise (tier-fixed; profile inherits base tier) ──

  /**
   * Inclusive min for per-bot wall-pole score noise while doors are open
   * (path / door-rush). Easy ±20 for more random routes; medium/hard ±10.
   */
  yawPoleNoiseMin: number;
  /** Inclusive max for door-open path pole noise. */
  yawPoleNoiseMax: number;
  /**
   * Inclusive min for pole noise while agent-hunting (doors closed).
   * Slightly wider than path so hunt still diversifies.
   */
  huntYawPoleNoiseMin: number;
  /** Inclusive max for hunt-phase pole noise. */
  huntYawPoleNoiseMax: number;

  // ── Live: optional path (doors-open) pole score dials ──
  // Omit → DEFAULT_YAW_POLE_WEIGHTS. Hunt still uses HUNT_YAW_POLE_WEIGHTS.

  /**
   * Path door-FOV binary score override (default {@link YAW_POLE_DOOR_FOV_SCORE}).
   * Only applied while doors are open (not agent-hunt).
   */
  yawPoleDoorFovScore?: number;
  /**
   * Path max door-distance score override (default {@link YAW_POLE_DOOR_DIST_MAX}).
   * 0 disables the “closer to enemy door” term.
   */
  yawPoleDoorDistMax?: number;
  /**
   * Path max map-center score override (default {@link YAW_POLE_MAP_CENTER_MAX}).
   * 0 disables lateral center bias.
   */
  yawPoleMapCenterMax?: number;

  // ── Live: raid temperament (raid bots only) ──

  /**
   * Raid role marker: undefined → not a raid bot, `raidTemperament` is a
   * no-op. `true` → this raid bot may roll into the "half the roster pauses"
   * cohort (2-5s rush, 1-2s pause). `false` → bosses / opt-outs, never pause.
   */
  raidAllowRandomStops?: boolean;
};

/**
 * Shared dumb / non-human bot brain.
 *
 * Used by:
 * - **Community autofill** (`bot1`, `bot2`, …) — never seed profiles or tier motors
 * - **Balance filler** (`name === "bot"`) — temporary uneven-team pad
 *
 * Deliberately robotic: instant look/nav (no τ, no humanize), plant-and-shoot,
 * no path ADAD / corner race-line, slow first shot + heavy ROF lag, wide aim box,
 * weak path scoring. Not difficulty-tiered; not seed-profiled.
 */
const DUMB_BOT_BASE = {
  sprint: true,
  /** Rare zone sprint — mostly walks. */
  sprintChance: 0.25,
  /** Slow first shot after lock. */
  reactionBaseMs: 500,
  reactionVarianceMs: 500,
  /** Heavy extra ROF lag on top of weapon CD. */
  shotIntervalMs: 100,
  hitChance: 0.5,
  /** Dumb bots torso-aim at the live body. */
  headAim: 0.5,
  leadSec: 0,
  /** Community / balance bots never activate skills. */
  skillUseChance: 0.5,
  /** No residual heat — community / balance stay on geometry. */
  humanHeatWeight: 0,
  minSeparation: 1.0,
  doorAggression: 0.5,
  campBias: 0.2,
  /** Always stand-ground plant under fire (no run-and-gun / ADAD). */
  targetEnemyStandGroundChance: 0.5,
  targetEnemyStrafeAvgMs: 0,
  targetEnemyStrafePauseAvgMs: 0,
  targetEnemyStrafeVariation: 0,
  /** Always doors-closed hunt + 100% agent-first (simple, predictable). */
  agentAggression: 1,
  campingAnxiety: 0.5,
  /** Pure walk-forward — no random path ADAD. */
  pathStrafe: 0,
  /** Follow authored Nudge lines at a steady, moderate cadence. */
  nudgeStrafe: 0,
  /** No corner race-line / outside cut. */
  cornerRound: 0,
  /** Instant nav + look motors (no humanize). */
  yawNavTauSec: 0,
  yawLookTauSec: 0,
  lookReactionBaseMs: 0,
  lookReactionVarianceMs: 0,
  yawOvershootMinFrac: 0,
  yawOvershootMaxFrac: 0,
  yawMicroNoiseAmp: 0,
  yawTrackErrorAmp: 0,
  pitchMicroNoiseAmp: 0,
  pitchTrackErrorAmp: 0,
  /** Wide click box — loose aim. */
  shootAimHalfAngleDeg: 5,
  /** No aim planner: look snaps to intent (deliberately robotic). */
  aimFittsASec: 0,
  aimFittsBSec: 0,
  aimPathWidthDeg: 0,
  aimPrimaryGainMean: 1,
  aimPrimaryGainSpread: 0,
  aimCorrectionDelayMs: 0,
  aimMaxCorrections: 0,
  aimCurvature: 0,
  aimPursuitLagMs: 0,
  /** No trigger discipline: weapon cooldown only. */
  clickCadenceMs: 0,
  clickSettleMs: 0,
  /** Wide path / hunt pole noise → jittery routes, not human pathing. */
  yawPoleNoiseMin: -30,
  yawPoleNoiseMax: 30,
  huntYawPoleNoiseMin: -30,
  huntYawPoleNoiseMax: 30,
  /** Weaker door FOV; zero door-dist / map-center path pull. */
  yawPoleDoorFovScore: 5,
  yawPoleDoorDistMax: 0,
  yawPoleMapCenterMax: 0,
} as const satisfies Omit<BotBrainConfig, "id">;

/**
 * Community / self-hosted autofill bots (`botN`).
 * {@link BotManager} uses this when the identity pool is empty.
 */
export const COMMUNITY_BOT_CONFIG: BotBrainConfig = {
  ...DUMB_BOT_BASE,
  id: "community",
};

/**
 * Temporary team-balance filler (`name === "bot"`).
 * Same dumb brain as community autofill; separate id for logs/tests.
 */
export const BALANCE_BOT_CONFIG: BotBrainConfig = {
  ...DUMB_BOT_BASE,
  id: "balance-bot",
};

/**
 * Shared grey-agent base (door-close hunters).
 * Always door-to-door hunt patrol (never door-camp); bot-like path (no random
 * path ADAD or corner race-line); always plant under combat lock. Random path
 * and combat ADAD remain hard-blocked when `isAgent`, while authored Nudge
 * lines may opt greys into a dedicated A/D cadence.
 * Tuned softer than medium team bots so greys pressure without melting
 * players. Tier only varies reaction + extra ROF delay — see
 * {@link AGENT_BOT_CONFIGS}.
 */
const AGENT_BOT_BASE = {
  id: "agent",
  sprint: false,
  /** Less zone sprint — easier to kite than full mid-tier bots. */
  sprintChance: 0.35,
  /** Mild lock jitter so first shot is not metronomic. */
  reactionVarianceMs: 200,
  /** Intentional miss: ~half of in-box opportunities actually click. */
  hitChance: 0.5,
  /** Greys mostly torso; a little lead so movers are not totally untracked. */
  headAim: 0.1,
  leadSec: 0.05,
  /** Grey agents never activate skills. */
  skillUseChance: 0,
  /** Greys skip heat priors. */
  humanHeatWeight: 0,
  minSeparation: 1.2,
  doorAggression: 0.5,
  campBias: 0.2,
  /** Every combat lock: stand-ground plant (no ADAD / no run-and-gun). */
  targetEnemyStandGroundChance: 1,
  targetEnemyStrafeAvgMs: 0,
  targetEnemyStrafePauseAvgMs: 0,
  targetEnemyStrafeVariation: 0,
  /** Always hunt (greys never camp regardless of this). */
  agentAggression: 1,
  campingAnxiety: 0.5,
  /** Pure walk to poles — no random ADAD. */
  pathStrafe: 0,
  /** Greys respond firmly to authored Nudge lines while hunting. */
  nudgeStrafe: 0.65,
  /** No corner race-line / outside cut. */
  cornerRound: 0,
  // Robotic look: instant nav + look, no humanize (no overshoot, micro-noise,
  // track error, or look-reaction delay). Same as the community/dumb brain.
  yawNavTauSec: 0,
  yawLookTauSec: 0,
  lookReactionBaseMs: 0,
  lookReactionVarianceMs: 0,
  yawOvershootMinFrac: 0,
  yawOvershootMaxFrac: 0,
  yawMicroNoiseAmp: 0,
  yawTrackErrorAmp: 0,
  pitchMicroNoiseAmp: 0,
  pitchTrackErrorAmp: 0,
  shootAimHalfAngleDeg: 3,
  // No aim planner: look snaps to intent.
  aimFittsASec: 0,
  aimFittsBSec: 0,
  aimPathWidthDeg: 0,
  aimPrimaryGainMean: 1,
  aimPrimaryGainSpread: 0,
  aimCorrectionDelayMs: 0,
  aimMaxCorrections: 0,
  aimCurvature: 0,
  aimPursuitLagMs: 0,
  clickCadenceMs: 260,
  clickSettleMs: 120,
  yawPoleNoiseMin: -12,
  yawPoleNoiseMax: 12,
  huntYawPoleNoiseMin: -18,
  huntYawPoleNoiseMax: 18,
} as const satisfies Omit<BotBrainConfig, "reactionBaseMs" | "shotIntervalMs">;

function agentConfigForTier(
  reactionBaseMs: number,
  shotIntervalMs: number,
): BotBrainConfig {
  return {
    ...AGENT_BOT_BASE,
    reactionBaseMs,
    shotIntervalMs,
  };
}

/**
 * Grey free-for-all agents by match difficulty.
 * Easy / medium / hard only change lock→first-shot delay and extra ROF gap.
 * Values are deliberately slower than pre-nerf so greys stay threatening
 * but less laser-DPS.
 */
export const AGENT_BOT_CONFIGS: Record<BotDifficulty, BotBrainConfig> = {
  // Easy: slow first shot, heavy ROF lag.
  easy: agentConfigForTier(1400, 700),
  // Medium: still a beat before first shot + clear ROF gap.
  medium: agentConfigForTier(650, 350),
  // Hard: snappier greys, still not weapon-CD-only.
  hard: agentConfigForTier(300, 200),
};

/** Default agent config (easy / DEFAULT_BOT_DIFFICULTY). */
export const AGENT_BOT_CONFIG: BotBrainConfig = AGENT_BOT_CONFIGS.easy;

export function agentBrainConfigFor(difficulty: BotDifficulty): BotBrainConfig {
  return AGENT_BOT_CONFIGS[difficulty];
}

/** Raid waves play like the balance bot and may stop at random. */
export const RAID_BOT_CONFIG: BotBrainConfig = {
  ...BALANCE_BOT_CONFIG,
  raidAllowRandomStops: true,
};

/** Raid waves whose map turned random stops off. */
export const RAID_NO_STOPS_BOT_CONFIG: BotBrainConfig = {
  ...BALANCE_BOT_CONFIG,
  raidAllowRandomStops: false,
};
