/**
 * Square-one bot brain: face the prioritized yaw-pole and walk forward.
 *
 * Nav layers (clear separation):
 * - **navMode** — path | hunt | doorCamp from doors + personality
 * - **navGoal** — always-defined world goal (door mid / hunt agent→last→center /
 *   camp plant); hunt fallback lives here, not in the look filter
 * - **yawPole** — sticky corner pick (client blue guide); door-camp travel
 *   routes via poles toward the plant (same as path); planted camp freezes on
 *   plant only. Sticky until arrival, lost LOS, death, or mode/spawn re-roll
 * - **pathHeading** — raw look + world move (corner-round, pathStrafe, face goal)
 * - **doorCampLook** — planted sweep between enemy spawn corners via own door
 * - **yawIntent** — nav look intent pass-through (`stepYawIntent`; no low-pass)
 *
 * halfWallVault / floatWallDuck sit dormant until a half or float wall is in
 * the path (multi-distance probes), then override face + keys for a short
 * commit. Vault re-arms jump on landing if still blocked. Float duck is
 * **path-aligned** (desired move yaw), owns crouch while under a slab, aborts
 * zero-progress commits, and both vault and duck block combat stand-still so
 * bots do not freeze mid half/float. Door-camp **travel** still vaults/ducks;
 * only planted camp skips. Navigate packs vault/duck body over combat keys
 * (combat may keep look). **targetEnemy** yaws onto the highest-threat FOV
 * hostile while **PWM-remapping** WASD so average world move tracks path
 * intent (strafe-preferring reverse; high doorAggression suppresses S while
 * move progresses toward the enemy door; min tap 100ms). Before the duel,
 * `BrainHooks.combatBias` may adjust door aggression, stand-ground chance,
 * and door priority. The default returns those knobs unchanged. After
 * sticky lock is warm, combat look **leads** along an EMA of enemy velocity
 * (LOS-gated; easy 0, hard ~think-buffer lag). Under a lock, bots pick the
 * first loaded gun for the range (shotgun inside ~10 m, rifle from ~20 m,
 * pistol between). Empty active mag reloads when spare clips remain, else
 * switches; with no lock a shotgun tube with room tops up. No mag and no
 * clips skips combat so path keeps the enemy door.
 * **evalSprint** sets sprint when **world move** progresses toward the enemy
 * door: (1) map sprint zone + door FOV cone, (2) open lane + lenient N/S
 * hemisphere toward the door **and** stamina &gt; 50%, or (3) config.sprint
 * force + door FOV. Zone and open roll `sprintChance` (latched per entry).
 * Low energy only blocks open sprint — zone, force, and slides still work.
 * Navigate is mechanical.
 * **stuckWTurn** is a late protection
 * catch: intend move with tick-to-tick speed under ~0.02u for ~1.8s → ban
 * the sticky pole, peel (hint stuck disc or smart detour), walk W, then
 * re-engage so FOV re-samples. **minSeparation** backs off a face-hug
 * under combat lock (playerClip-aware).
 * **humanHeatWeight** scales residual pole heat when the frame carries
 * `humanHeatByPole` and the weight is above 0. Public configs set 0.
 * **useSkills** is situational (heal / Hawkeyes
 * / fight / stuck), not a random roll. **click** plants WASD for the
 * shot unless Hawkeyes is already up so bloom does not walk off the box.
 * **yawHumanize** plans mouse look (per-bot look τ + ballistic overshoot / micro-noise /
 * track error) with a short look-reaction delay on combat acquire (separate
 * from shoot reaction). Micro + overshoot scale with lateral (A/D) velocity
 * change over ~500 ms (plant/steady quieter; ADAD worse). **combatPitch**
 * (after targetEnemy) latches head vs torso aim from `headAim`
 * (0 → 5% head, ≥90% → always head; split from the click miss gate), adds a transient
 * up→down pitch arc on large yaw swings (wrist-like mouse path), and
 * continuous micro/track pitch wander while locked (tier
 * `pitchMicroNoiseAmp` / `pitchTrackErrorAmp`, ~3× yaw amps). On unlock,
 * navigate resets pitch to level (0). **click** holds fire while a hostile
 * sits in the tier shoot aim box (yaw + pitch from eye center; half-angle
 * from config degrees) — preferred lock uses the same lead + height latch as
 * combat look. After the first shot of a spray, **shotIntervalMs** adds extra
 * delay on top of the equipped weapon’s fire cooldown (easy +500 ms, medium
 * +50 ms, hard 0). **hitChance** is also the fraction of eligible (in-box,
 * reaction + ROF ready) shot opportunities that actually click; a fail wastes
 * a full weapon+interval cycle (intentional miss — low-rank sprays, high-rank
 * laser).
 *
 * **Personality / motors:** per-bot knobs on {@link BotBrainConfig} (e.g.
 * `targetEnemyStandGroundChance`, stand-ground ADAD timing
 * (`targetEnemyStrafeAvgMs` / pause / variation), `agentAggression`,
 * `campingAnxiety`, `pathStrafe`, `cornerRound`, `yawNavTauSec`,
 * `yawLookTauSec`, look reaction / overshoot / yaw+pitch noise,
 * `shootAimHalfAngleDeg`, `shotIntervalMs`, `hitChance`, `headAim`, `leadSec`, `minSeparation`,
 * path/hunt pole noise, optional path pole score dials) —
 * not process-wide constants. On combat lock acquire, stand-ground is rolled
 * once; on hit, path keys cancel and targetEnemy runs ADAD (or plant when
 * strafe avg is 0) — never while float-duck / under-slab is active. Miss keeps
 * door-chase PWM under combat look. Easy bots use stand-ground chance 1 + zero
 * ADAD (always stop and shoot). While doors are closed, **grey agents always hunt**
 * (doorDist own↔enemy patrol; never door-camp) and **never ADAD** (path or
 * combat) — hard-blocked on `isAgent` identity, not only config zeros.
 * Non-agent bots split by
 * `agentAggression`: **&lt; 0.5** door-camp (pole-route to a cover plant off
 * the capture lip, then freeze + look sweep; lip only when doors are about
 * to open or doorAggression is high); **≥ 0.5** enter **agent hunt** (soft poles +
 * doorDist oscillation; combat may prefer agents via agent-first chance).
 * **pathStrafe** times random L/R holds on open approaches;
 * **nudgeStrafe** times authored Nudge-line holds (and defaults to pathStrafe);
 * random lateral fades near the pole. **cornerRound** scales
 * outside-of-turn race-line (0 = pure walk to current, no look pre-yaw;
 * may over-round above 1). Path pick can override door FOV / door-dist /
 * map-center scores via config (balance bot); hunt still uses hunt weights.
 *
 * Pure-step pipeline for the soft-buffer orchestrator
 * (gate → perception → navMode → navGoal → yawPole → pathHeading →
 * doorCampLook → yawIntent → halfWallVault → floatWallDuck → targetEnemy →
 * combatPitch → evalSprint → navigate → stuckWTurn → yawHumanize → click →
 * useSkills → raidTemperament).
 *
 * **raidTemperament** is a raid-only final rewrite: no-op unless
 * `config.raidAllowRandomStops` is set (undefined for every non-raid role).
 * Half the raid roster rolls into a 2-5s rush / 1-2s pause cadence at first
 * think (bosses / opt-outs never pause); a paused tick zeroes the packed
 * WASD/jump/sprint but leaves look, crouch, and combat edges untouched.
 *
 * **Multi-rate (bot-tick periods @ 20 Hz think):** outer ReadyAction pack
 * stays 20 Hz; slow switch steps replan less often and rehydrate on skip:
 * - **2 Hz** `navMode` (strategic path|hunt|doorCamp; forced on doors edge)
 * - **5 Hz** `navGoal` (+ personality plant latches; forced on mode/noise)
 * - **10 Hz** `yawPole` (re-score; forced when sticky unlocked / noise re-roll)
 * - **20 Hz** everything else — especially `pathHeading`, `navigate`,
 *   `targetEnemy`, `combatPitch`, `yawHumanize`, `click`, `useSkills`
 * @see {@link ./pipeline/stepCadence.ts}
 *
 * **perception** builds a per-think cache (doors, hostiles, poles, yaw-pole
 * LOS memo) on ThinkContext so later steps do not re-scan the world.
 *
 * Step implementations live under {@link ./thoughts}.
 *
 * ## Think-step kinds (reorder / state ownership)
 *
 * Each step has `kind: "passive" | "switch" | "impure"` (see
 * {@link ThinkStepKind}). Does **not** change runner semantics — only documents
 * which steps may be moved around.
 *
 * | Kind | Meaning | Move freely? |
 * |------|---------|--------------|
 * | **passive** | No draft bag write; world + prior (+ ephemeral ctx) → out | Yes among passives if data deps hold |
 * | **switch** | Discrete durable latches (mode, sticky, combat lock, chance) | No — order vs key readers matters |
 * | **impure** | Motors, multi-tick commits, or ReadyAction pack | Tight — keep on their signal / priority |
 *
 * Comment subtags (not a separate enum):
 * - **commit** — multi-tick body takeover (vault jump, duck crouch)
 * - **motor** — continuous filter / plan-motor state
 * - **pack** — decision → ReadyAction
 * - **clear** — death bag wipe
 */

import type { BotBrainConfig } from "../config.ts";
import type { ThinkContext } from "./types.ts";
import type {
  BotAction,
  BotBrainState,
  BotWorldView,
} from "../types.ts";
import {
  DEFAULT_YAW_POLE_WEIGHTS,
  HUNT_YAW_POLE_NOISE_MAX,
  HUNT_YAW_POLE_NOISE_MIN,
  YAW_POLE_NOISE_MAX,
  YAW_POLE_NOISE_MIN,
  type YawPoleScoreWeights,
} from "../thoughts/yawPole/helpers/yawPole.ts";
import {
  runClickStep,
  runCombatPitchStep,
  runDoorCampLookStep,
  runEvalSprintStep,
  runFloatWallDuckStep,
  runGateStep,
  runHalfWallVaultStep,
  runNavGoalStep,
  runNavigateStep,
  runNavModeStep,
  runPathHeadingStep,
  runPerceptionStep,
  runRaidTemperamentStep,
  runStuckWTurnStep,
  runTargetEnemyStep,
  runUseSkillsStep,
  runYawIntentStep,
  runYawPoleStep,
} from "../thoughts/index.ts";
import { clamp, clamp01, max, PI } from "../math/index.ts";
import {
  defaultBrainHooks,
  type BrainHooks,
  type LookAimKnobs,
} from "../hooks.ts";

/** Config numbers are authored, not validated — treat junk as 0. */
function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/**
 * Clamp config noise band; fall back to shared defaults if min/max invalid.
 * Swaps if min &gt; max so the inclusive range stays well-formed.
 */
function resolveNoiseBand(
  min: number,
  max: number,
  fallbackMin: number,
  fallbackMax: number,
): { min: number; max: number } {
  let lo = Number.isFinite(min) ? min : fallbackMin;
  let hi = Number.isFinite(max) ? max : fallbackMax;
  if (lo > hi) {
    const t = lo;
    lo = hi;
    hi = t;
  }
  return { min: lo, max: hi };
}

/**
 * Optional path (doors-open) pole score dials from config.
 * Returns undefined when no overrides are set so pickers keep defaults.
 */
function pathYawPoleWeightsFromConfig(
  config: BotBrainConfig,
): YawPoleScoreWeights | undefined {
  let hasOverride = false;
  let doorFov = DEFAULT_YAW_POLE_WEIGHTS.doorFov;
  let doorDistMax = DEFAULT_YAW_POLE_WEIGHTS.doorDistMax;
  let mapCenterMax = DEFAULT_YAW_POLE_WEIGHTS.mapCenterMax;
  if (
    config.yawPoleDoorFovScore !== undefined &&
    Number.isFinite(config.yawPoleDoorFovScore)
  ) {
    doorFov = config.yawPoleDoorFovScore;
    hasOverride = true;
  }
  if (
    config.yawPoleDoorDistMax !== undefined &&
    Number.isFinite(config.yawPoleDoorDistMax)
  ) {
    doorDistMax = config.yawPoleDoorDistMax;
    hasOverride = true;
  }
  if (
    config.yawPoleMapCenterMax !== undefined &&
    Number.isFinite(config.yawPoleMapCenterMax)
  ) {
    mapCenterMax = config.yawPoleMapCenterMax;
    hasOverride = true;
  }
  if (!hasOverride) return undefined;
  return {
    doorFov,
    playerFovCenter: DEFAULT_YAW_POLE_WEIGHTS.playerFovCenter,
    playerFovEdge: DEFAULT_YAW_POLE_WEIGHTS.playerFovEdge,
    movementFovCenter: DEFAULT_YAW_POLE_WEIGHTS.movementFovCenter,
    movementFovEdge: DEFAULT_YAW_POLE_WEIGHTS.movementFovEdge,
    proximityClosest: DEFAULT_YAW_POLE_WEIGHTS.proximityClosest,
    proximitySecond: DEFAULT_YAW_POLE_WEIGHTS.proximitySecond,
    doorDistMax,
    mapCenterMax,
    doorFovHalfAngle: DEFAULT_YAW_POLE_WEIGHTS.doorFovHalfAngle,
    playerFovHalfAngle: DEFAULT_YAW_POLE_WEIGHTS.playerFovHalfAngle,
    movementFovHalfAngle: DEFAULT_YAW_POLE_WEIGHTS.movementFovHalfAngle,
    humanHeatMax: DEFAULT_YAW_POLE_WEIGHTS.humanHeatMax,
  };
}

/**
 * Door-rusher brain via yaw-poles. Config (including personality values) is
 * frozen at construction so each bot instance can differ.
 */
export class BotBrain {
  public readonly id: string;
  private readonly sprint: boolean;
  /** P(sprint) when zone + door-facing would allow; latched per zone entry. */
  private readonly sprintChance: number;
  /** Personality: P(stand ground for a targetEnemy lock). */
  private readonly targetEnemyStandGroundChance: number;
  /** Mean A/D hold while stand-ground (ms). */
  private readonly targetEnemyStrafeAvgMs: number;
  /** Mean stand-still gap between holds (ms). */
  private readonly targetEnemyStrafePauseAvgMs: number;
  /** Relative ADAD duration jitter [0, 1]. */
  private readonly targetEnemyStrafeVariation: number;
  /**
   * Personality: &lt;0.5 door-camp, ≥0.5 hunt + agent-first
   * ({@link agentFirstChanceFromAggression}).
   */
  private readonly agentAggression: number;
  /**
   * Door-rusher personality. High values suppress combat reverse (S) while
   * world move progresses toward the enemy door.
   */
  private readonly doorAggression: number;
  /**
   * Desired min horizontal distance to a locked enemy before plant.
   * 0 → no back-off.
   */
  private readonly minSeparation: number;
  /** Personality: camp look-check anxiety (hold band between spots). */
  private readonly campingAnxiety: number;
  /** Personality: random path ADAD intensity while walking yaw-poles. */
  private readonly pathStrafe: number;
  /** Authored Nudge-line A/D activity; defaults to pathStrafe. */
  private readonly nudgeStrafe: number;
  /** Personality: corner-round intensity (may exceed 1 for over-round). */
  private readonly cornerRound: number;
  /** Look/mouse plan-motor τ (seconds); ≤0 instant. */
  private readonly yawLookTauSec: number;
  /** Combat lock → mouse start delay base (ms). */
  private readonly lookReactionBaseMs: number;
  /** Extra look-reaction variance (ms). */
  private readonly lookReactionVarianceMs: number;
  private readonly yawOvershootMinFrac: number;
  private readonly yawOvershootMaxFrac: number;
  private readonly yawMicroNoiseAmp: number;
  private readonly yawTrackErrorAmp: number;
  /** Continuous combat pitch micro-wander (rad). */
  private readonly pitchMicroNoiseAmp: number;
  /** Continuous combat pitch track-error kick (rad). */
  private readonly pitchTrackErrorAmp: number;
  /** Shoot aim half-angle (radians) for click + planner combat width. */
  private readonly shootAimHalfAngleRad: number;
  /** Aim-planner knobs (stroke timing, landing gain, bow, pursuit lag). */
  private readonly lookAim: LookAimKnobs;
  private readonly pursuitLagSec: number;
  /** Lock → first-shot delay base (ms). */
  private readonly reactionBaseMs: number;
  /** Extra reaction variance window (ms). */
  private readonly reactionVarianceMs: number;
  /**
   * Extra ms between shots on top of the equipped weapon fire cooldown
   * (0 = weapon CD only).
   */
  private readonly shotIntervalMs: number;
  /** Min ms between this bot's own clicks (hand cadence, ±25% jitter). */
  private readonly clickCadenceMs: number;
  /** Settle delay (ms) after the crosshair reaches the target. */
  private readonly clickSettleMs: number;
  /**
   * Fraction of eligible shot opportunities that actually click (0..1).
   * 1 = always fire when in box; lower = intentional misses that consume ROF.
   */
  private readonly hitChance: number;
  /** P(latch head vs torso). Split from hitChance. */
  private readonly headAim: number;
  /** Combat look / click lead horizon (seconds). */
  private readonly leadSec: number;
  /** 0 disables skills; &gt;0 situational activate when charged. */
  private readonly skillUseChance: number;
  /**
   * Scale on residual pole heat. Scored only when the frame carries
   * `humanHeatByPole` and this is above 0.
   */
  private readonly humanHeatWeight: number;
  /** Door-open path pole score noise [min, max]. */
  private readonly yawPoleNoiseMin: number;
  private readonly yawPoleNoiseMax: number;
  /** Agent-hunt pole score noise [min, max]. */
  private readonly huntYawPoleNoiseMin: number;
  private readonly huntYawPoleNoiseMax: number;
  /**
   * Path (doors-open) pole score weight overrides; undefined → defaults.
   * Hunt still uses hunt weights.
   */
  private readonly pathYawPoleWeights: Partial<YawPoleScoreWeights> | undefined;
  /** Raid role marker: config.raidAllowRandomStops !== undefined. */
  private readonly isRaidBot: boolean;
  /** Bosses / opt-outs (isRaidBot && !this) never pause. */
  private readonly raidAllowRandomStops: boolean;
  private readonly rng: () => number;
  private readonly hooks: BrainHooks;

  constructor(
    config: BotBrainConfig,
    opts?: { rng?: () => number; hooks?: BrainHooks },
  ) {
    this.id = config.id;
    this.sprint = config.sprint;
    const sc = config.sprintChance;
    this.sprintChance = Number.isFinite(sc) ? clamp01(sc) : 1;
    this.targetEnemyStandGroundChance = config.targetEnemyStandGroundChance;
    this.targetEnemyStrafeAvgMs = max(
      0,
      Number.isFinite(config.targetEnemyStrafeAvgMs)
        ? config.targetEnemyStrafeAvgMs
        : 0,
    );
    this.targetEnemyStrafePauseAvgMs = max(
      0,
      Number.isFinite(config.targetEnemyStrafePauseAvgMs)
        ? config.targetEnemyStrafePauseAvgMs
        : 0,
    );
    const svar = config.targetEnemyStrafeVariation;
    this.targetEnemyStrafeVariation = Number.isFinite(svar)
      ? clamp01(svar)
      : 0;
    this.agentAggression = config.agentAggression;
    const doorAgg = config.doorAggression;
    this.doorAggression = Number.isFinite(doorAgg)
      ? clamp01(doorAgg)
      : 0;
    const minSep = config.minSeparation;
    this.minSeparation = Number.isFinite(minSep) && minSep > 0 ? minSep : 0;
    this.campingAnxiety = config.campingAnxiety;
    this.pathStrafe = config.pathStrafe;
    this.nudgeStrafe = config.nudgeStrafe ?? config.pathStrafe;
    this.cornerRound = config.cornerRound;
    this.yawLookTauSec = config.yawLookTauSec;
    this.lookReactionBaseMs = max(
      0,
      Number.isFinite(config.lookReactionBaseMs)
        ? config.lookReactionBaseMs
        : 0,
    );
    this.lookReactionVarianceMs = max(
      0,
      Number.isFinite(config.lookReactionVarianceMs)
        ? config.lookReactionVarianceMs
        : 0,
    );
    this.yawOvershootMinFrac = max(
      0,
      Number.isFinite(config.yawOvershootMinFrac)
        ? config.yawOvershootMinFrac
        : 0,
    );
    this.yawOvershootMaxFrac = max(
      0,
      Number.isFinite(config.yawOvershootMaxFrac)
        ? config.yawOvershootMaxFrac
        : 0,
    );
    this.yawMicroNoiseAmp = max(
      0,
      Number.isFinite(config.yawMicroNoiseAmp) ? config.yawMicroNoiseAmp : 0,
    );
    this.yawTrackErrorAmp = max(
      0,
      Number.isFinite(config.yawTrackErrorAmp) ? config.yawTrackErrorAmp : 0,
    );
    this.pitchMicroNoiseAmp = max(
      0,
      Number.isFinite(config.pitchMicroNoiseAmp)
        ? config.pitchMicroNoiseAmp
        : 0,
    );
    this.pitchTrackErrorAmp = max(
      0,
      Number.isFinite(config.pitchTrackErrorAmp)
        ? config.pitchTrackErrorAmp
        : 0,
    );
    const deg = config.shootAimHalfAngleDeg;
    this.shootAimHalfAngleRad = Number.isFinite(deg) && deg > 0
      ? (deg * PI) / 180
      : PI / 180;
    this.lookAim = {
      fittsASec: max(0, finiteOrZero(config.aimFittsASec)),
      fittsBSec: max(0, finiteOrZero(config.aimFittsBSec)),
      pathWidthDeg: max(0, finiteOrZero(config.aimPathWidthDeg)),
      primaryGainMean: Number.isFinite(config.aimPrimaryGainMean)
        ? config.aimPrimaryGainMean
        : 1,
      primaryGainSpread: max(0, finiteOrZero(config.aimPrimaryGainSpread)),
      correctionDelayMs: max(0, finiteOrZero(config.aimCorrectionDelayMs)),
      maxCorrections: max(0, finiteOrZero(config.aimMaxCorrections)),
      curvature: max(0, finiteOrZero(config.aimCurvature)),
      pursuitLagMs: max(0, finiteOrZero(config.aimPursuitLagMs)),
      combatWidthRad: this.shootAimHalfAngleRad,
    };
    this.pursuitLagSec = this.lookAim.pursuitLagMs / 1000;
    this.reactionBaseMs = max(
      0,
      Number.isFinite(config.reactionBaseMs) ? config.reactionBaseMs : 0,
    );
    this.reactionVarianceMs = max(
      0,
      Number.isFinite(config.reactionVarianceMs)
        ? config.reactionVarianceMs
        : 0,
    );
    this.shotIntervalMs = max(
      0,
      Number.isFinite(config.shotIntervalMs) ? config.shotIntervalMs : 0,
    );
    this.clickCadenceMs = max(0, finiteOrZero(config.clickCadenceMs));
    this.clickSettleMs = max(0, finiteOrZero(config.clickSettleMs));
    const hc = config.hitChance;
    this.hitChance = Number.isFinite(hc) ? clamp01(hc) : 1;
    const ha = config.headAim;
    this.headAim = Number.isFinite(ha) ? clamp01(ha) : 0;
    const ls = config.leadSec;
    this.leadSec = Number.isFinite(ls) && ls > 0 ? ls : 0;
    const suc = config.skillUseChance;
    this.skillUseChance = Number.isFinite(suc)
      ? clamp01(suc)
      : 0;
    const hhw = config.humanHeatWeight;
    this.humanHeatWeight = Number.isFinite(hhw)
      ? clamp(hhw, 0, 2)
      : 1;
    const pathNoise = resolveNoiseBand(
      config.yawPoleNoiseMin,
      config.yawPoleNoiseMax,
      YAW_POLE_NOISE_MIN,
      YAW_POLE_NOISE_MAX,
    );
    this.yawPoleNoiseMin = pathNoise.min;
    this.yawPoleNoiseMax = pathNoise.max;
    const huntNoise = resolveNoiseBand(
      config.huntYawPoleNoiseMin,
      config.huntYawPoleNoiseMax,
      HUNT_YAW_POLE_NOISE_MIN,
      HUNT_YAW_POLE_NOISE_MAX,
    );
    this.huntYawPoleNoiseMin = huntNoise.min;
    this.huntYawPoleNoiseMax = huntNoise.max;
    this.pathYawPoleWeights = pathYawPoleWeightsFromConfig(config);
    const raidStops = config.raidAllowRandomStops;
    this.isRaidBot = raidStops !== undefined;
    this.raidAllowRandomStops = raidStops === true;
    this.rng = opts?.rng ?? (() => 0.5);
    this.hooks = opts?.hooks ?? defaultBrainHooks();
  }

  /** Execute the complete, statically typed thought chain in canonical order. */
  public think(view: BotWorldView, state: BotBrainState): BotAction | null {
    // The persistent full engine owns this state exclusively. Mutating the
    // closed monomorphic bag directly also keeps JS and ScriptC aligned; object
    // spread/Object.assign over dozens of optional union fields can compile but
    // materialize absent fields differently in the native runtime.
    const draft = state;
    const ctx: ThinkContext = {
      logicalTick: view.tick,
      view,
      botId: view.self.id,
      rng: this.rng,
      hooks: this.hooks,
    };

    const gate = runGateStep(ctx, null, draft);
    if (gate.done === true) {
      return gate.ready;
    }

    const perception = runPerceptionStep(ctx, gate.out, draft);
    const navMode = runNavModeStep(
      ctx,
      perception.out,
      draft,
      this.agentAggression,
      this.rng,
    );
    const navGoal = runNavGoalStep(
      ctx,
      navMode.out,
      draft,
      this.rng,
      this.doorAggression,
    );
    const yawPole = runYawPoleStep(
      ctx,
      navGoal.out,
      draft,
      this.yawPoleNoiseMin,
      this.yawPoleNoiseMax,
      this.huntYawPoleNoiseMin,
      this.huntYawPoleNoiseMax,
      this.pathYawPoleWeights,
      this.rng,
      this.humanHeatWeight,
    );
    const pathHeading = runPathHeadingStep(
      ctx,
      yawPole.out,
      draft,
      this.pathStrafe,
      this.nudgeStrafe,
      this.cornerRound,
      this.rng,
    );
    const doorCampLook = runDoorCampLookStep(
      ctx,
      pathHeading.out,
      draft,
      this.campingAnxiety,
      this.rng,
    );
    const yawIntent = runYawIntentStep(ctx, doorCampLook.out, draft);
    const halfWallVault = runHalfWallVaultStep(ctx, yawIntent.out, draft);
    const floatWallDuck = runFloatWallDuckStep(
      ctx,
      halfWallVault.out,
      draft,
    );
    const targetEnemy = runTargetEnemyStep(
      ctx,
      floatWallDuck.out,
      draft,
      this.targetEnemyStandGroundChance,
      this.targetEnemyStrafeAvgMs,
      this.targetEnemyStrafePauseAvgMs,
      this.targetEnemyStrafeVariation,
      this.agentAggression,
      this.doorAggression,
      this.minSeparation,
      this.leadSec,
      this.rng,
    );
    const combatPitch = runCombatPitchStep(
      ctx,
      targetEnemy.out,
      draft,
      this.hitChance,
      this.headAim,
      this.leadSec,
      this.pitchMicroNoiseAmp,
      this.pitchTrackErrorAmp,
      this.rng,
    );
    const evalSprint = runEvalSprintStep(
      ctx,
      combatPitch.out,
      draft,
      this.sprint,
      this.sprintChance,
      this.rng,
    );
    const navigate = runNavigateStep(ctx, evalSprint.out, draft);
    const stuckWTurn = runStuckWTurnStep(
      ctx,
      navigate.out,
      draft,
      this.rng,
    );
    const yawHumanize = ctx.hooks.look(
      ctx,
      stuckWTurn.out,
      draft,
      this.lookReactionBaseMs,
      this.lookReactionVarianceMs,
      this.rng,
      this.yawLookTauSec,
      this.yawOvershootMinFrac,
      this.yawOvershootMaxFrac,
      this.yawMicroNoiseAmp,
      this.yawTrackErrorAmp,
      this.lookAim,
    );
    const click = runClickStep(
      ctx,
      yawHumanize.out,
      draft,
      this.shootAimHalfAngleRad,
      this.reactionBaseMs,
      this.reactionVarianceMs,
      this.shotIntervalMs,
      this.clickCadenceMs,
      this.clickSettleMs,
      this.hitChance,
      this.leadSec,
      this.pursuitLagSec,
      this.rng,
    );
    const useSkills = runUseSkillsStep(
      ctx,
      click.out,
      draft,
      this.skillUseChance,
    );
    const raidTemperament = runRaidTemperamentStep(
      ctx,
      useSkills.out,
      draft,
      this.isRaidBot,
      this.raidAllowRandomStops,
      this.rng,
    );

    return raidTemperament.out;
  }
}

export function createBotBrain(
  config: BotBrainConfig,
  opts?: { rng?: () => number; hooks?: BrainHooks },
): BotBrain {
  return new BotBrain(config, opts);
}
