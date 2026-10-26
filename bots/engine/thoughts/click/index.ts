/**
 * Click while a hostile (prefer combat lock) sits inside the tier shoot
 * aim box about the look the shot will actually use (the period's first
 * sample — the shot fires on the release tick).
 *
 * **Trigger discipline** (a hand, not a solenoid): the click waits for the
 * crosshair to land (`clickSettleMs` after the aim first reaches the box,
 * re-armed whenever it leaves), never fires while the planner is still
 * sweeping through the target, and spaces its own clicks by the weapon
 * cooldown + `shotIntervalMs` + `clickCadenceMs` (±25%) measured against the
 * bot's own last emitted click — the applied `lastShotAtTick` a think can see
 * is a think-buffer stale, which used to let bots free-run at the weapon cap. On each **new** combat lock,
 * roll reaction delay (base + U[0, variance]) and suppress shoot until
 * the ready tick. After a real shot (`lastShotAtTick`), also wait
 * weapon fireCooldown + shotIntervalMs before the next click
 * (easy/medium slower ROF; hard 0 = weapon CD only). Re-evaluated each
 * think after the delay — fire holds until the body leaves the box or
 * LOS breaks (subject to ROF gate).
 *
 * **hitChance** (0..1): once reaction + ROF + aim-box + still-stance all
 * pass, roll U[0,1) < hitChance to actually click. A failed roll is an
 * intentional miss: no shoot, and the same weapon+interval gap is latched
 * so the next opportunity waits a full shot cycle (re-rolling every think
 * would otherwise almost always pass at bot think rate).
 *
 * **Bloom:** on the think that will actually fire, zero WASD + sprint so
 * the hitscan cone is still (rifle walk is 1.15° vs hard's 1° box). Do
 * **not** force crouch — that was holding duck the whole gunfight.
 * Hawkeyes already up → keep moving. Vault (`input.jump`) keeps body.
 * Between shots, ADAD / PWM resume.
 *
 * @kind switch (sub: pack-ish)
 * Discrete reaction latch per combat lock; sets shoot on ReadyAction.
 * Must see final eye after yawHumanize — keep last.
 */

import { msToTicks, TICK_HZ } from "../../shared/network.ts";
import {
  inputHorizMoving,
  plantInputForShot,
  stepClick,
  weaponReadyForShot,
} from "./helpers/click.ts";
import type {
  ReadyAction,
  StepResult,
  ThinkContext,
  ThinkStep,
} from "../../pipeline/types.ts";
import type { BotBrainState } from "../../types.ts";
import { type TargetEnemyState } from "../targetEnemy/helpers/targetEnemy.ts";
import { abs, clamp01, max, round } from "../../math/index.ts";
import { yawSignedDelta } from "../helpers/yawEaseMotor.ts";
import { playerIsAbilityActive } from "../../players/Player.ts";

export type ClickStepOpts = {
  shootAimHalfAngleRad: number;
  reactionBaseMs: number;
  reactionVarianceMs: number;
  shotIntervalMs: number;
  /** Min ms between this bot's own clicks, on top of the weapon cooldown. */
  clickCadenceMs: number;
  /** Settle delay (ms) after the crosshair reaches the target. */
  clickSettleMs: number;
  /** Fraction of eligible shot opportunities that actually click (0..1). */
  hitChance: number;
  /** Combat lead horizon (seconds). 0 → live body. */
  leadSec: number;
  /** Aim planner pursuit lag (seconds) — widens the box by the hand's trail. */
  pursuitLagSec: number;
  rng: () => number;
};

export function runClickStep(
  ctx: ThinkContext,
  prior: ReadyAction,
  draftState: BotBrainState,
  shootAimHalfAngleRad: number,
  reactionBaseMs: number,
  reactionVarianceMs: number,
  shotIntervalMs: number,
  clickCadenceMs: number,
  clickSettleMs: number,
  hitChance: number,
  leadSec: number,
  pursuitLagSec: number,
  rng: () => number,
): StepResult<ReadyAction> {
      if (!prior.input) {
        return { out: prior };
      }
      const me = ctx.view.self;
      const bag = draftState;
      const combatId = draftState.targetEnemyId;
      const locked = typeof combatId === "string" && combatId.length > 0
        ? combatId
        : null;

      let reactionOk = true;
      if (locked) {
        if (bag.reactionForEnemyId !== locked) {
          bag.reactionForEnemyId = locked;
          bag.hitChanceMissUntilTick = Number.NaN;
          const u = rng();
          const t = Number.isFinite(u) ? clamp01(u) : 0.5;
          const delayMs = reactionBaseMs + t * reactionVarianceMs;
          const delayTicks = max(
            0,
            round((delayMs / 1000) * TICK_HZ),
          );
          bag.reactionReadyAtTick = ctx.view.tick + delayTicks;
        }
        const readyAt = bag.reactionReadyAtTick;
        if (
          typeof readyAt === "number" &&
          Number.isFinite(readyAt) &&
          ctx.view.tick < readyAt
        ) {
          reactionOk = false;
        }
      } else {
        bag.reactionForEnemyId = "";
        bag.reactionReadyAtTick = Number.NaN;
        bag.hitChanceMissUntilTick = Number.NaN;
        bag.clickSettleReadyAtTick = Number.NaN;
      }

      // ── Rate gate ──
      // The applied `lastShotAtTick` this think can see is a think-buffer
      // behind, so gating on it alone lets the bot free-run at the weapon's
      // cap. Gate on the bot's own last *emitted* click (same spacing in
      // think time) plus the weapon cooldown, the tier ROF penalty, and a
      // hand cadence — a human cannot click a semi-auto at its cap.
      let rateOk = true;
      const ownLast = bag.clickLastShotTick;
      const cadenceMs = clickCadenceMs > 0 ? clickCadenceMs : 0;
      if (typeof ownLast === "number" && Number.isFinite(ownLast)) {
        const cadenceTicks = bag.clickCadenceTicks;
        const gapTicks = max(
          1,
          msToTicks(me.weapon.fireCooldownMs + shotIntervalMs) +
            (typeof cadenceTicks === "number" && Number.isFinite(cadenceTicks)
              ? cadenceTicks
              : 0),
        );
        if (ctx.view.tick - ownLast < gapTicks) rateOk = false;
      }
      if (
        rateOk && !weaponReadyForShot(
          me.lastShotAtTick,
          ctx.view.tick,
          me.weapon.fireCooldownMs,
          shotIntervalMs,
        )
      ) {
        rateOk = false;
      }

      const perc = ctx.perception;
      const heightRaw = draftState.combatAimHeight;
      const preferAimHeight = heightRaw === "head" || heightRaw === "torso"
        ? heightRaw
        : undefined;
      // The shot fires on the first sim tick of this action's period, so the
      // box must be judged with that tick's look — not the period's end.
      const samples = prior.lookSamples;
      const shotLook = samples !== undefined && samples.length > 0
        ? samples[0]!
        : { yaw: prior.input.yaw, pitch: prior.input.pitch };
      const inBox = stepClick({
        self: me,
        players: ctx.view.players,
        collision: ctx.view.collision,
        yaw: shotLook.yaw,
        pitch: shotLook.pitch,
        preferredEnemyId: locked,
        halfAngle: shootAimHalfAngleRad,
        hostiles: perc ? perc.sensedHostiles.map((h) => h.player) : undefined,
        // Same sticky lead bag as targetEnemy (vx/vz written this think).
        targetEnemyState: draftState as TargetEnemyState,
        // Match combatPitch head/torso latch so tight boxes still fire.
        preferAimHeight,
        leadSec,
        pursuitLagSec,
        tick: ctx.view.tick,
      });

      // ── Aim discipline ──
      // A hand does not fire while the mouse is still sweeping through the
      // target, and it needs a beat after the crosshair lands. Corrections
      // and pursuit (small strokes) still shoot — only the big sweep blocks.
      let aimOk = inBox;
      if (inBox) {
        const from = bag.aimMoveFromYaw;
        const to = bag.aimMoveToYaw;
        if (
          bag.aimMoveActive === true &&
          typeof from === "number" && Number.isFinite(from) &&
          typeof to === "number" && Number.isFinite(to)
        ) {
          const sweep = abs(yawSignedDelta(from, to));
          if (sweep > shootAimHalfAngleRad * 3) aimOk = false;
        }
      }
      if (aimOk) {
        // First think on target for this lock arms the settle delay.
        const settleAt = bag.clickSettleReadyAtTick;
        if (typeof settleAt !== "number" || !Number.isFinite(settleAt)) {
          const jitter = 0.6 + clamp01(rng()) * 0.8;
          bag.clickSettleReadyAtTick = ctx.view.tick +
            max(0, round((clickSettleMs * jitter / 1000) * TICK_HZ));
        }
        const readyAt = bag.clickSettleReadyAtTick;
        if (
          typeof readyAt === "number" && Number.isFinite(readyAt) &&
          ctx.view.tick < readyAt
        ) {
          aimOk = false;
        }
      } else {
        // Off target (or mid-sweep): the next arrival re-arms the settle.
        bag.clickSettleReadyAtTick = Number.NaN;
      }

      let accuracyOk = true;
      if (reactionOk && rateOk && aimOk) {
        const missUntil = bag.hitChanceMissUntilTick;
        if (
          typeof missUntil === "number" &&
          Number.isFinite(missUntil) &&
          ctx.view.tick < missUntil
        ) {
          accuracyOk = false;
        } else {
          if (typeof missUntil === "number") {
            bag.hitChanceMissUntilTick = Number.NaN;
          }
          // hitChance ≥ 1 → always fire; ≤ 0 → always waste the opportunity.
          if (hitChance < 1) {
            const u = rng();
            const roll = Number.isFinite(u) ? clamp01(u) : 0.5;
            if (roll >= hitChance) {
              accuracyOk = false;
              const gapTicks = max(
                1,
                msToTicks(me.weapon.fireCooldownMs + shotIntervalMs),
              );
              bag.hitChanceMissUntilTick = ctx.view.tick + gapTicks;
            }
          }
        }
      }

      const shoot = reactionOk && rateOk && aimOk && accuracyOk;
      if (shoot) {
        bag.clickLastShotTick = ctx.view.tick;
        // Roll the next hand gap now (±25%), so cadence is not metronomic.
        const jitter = 0.75 + clamp01(rng()) * 0.5;
        bag.clickCadenceTicks = max(
          0,
          round((cadenceMs * jitter / 1000) * TICK_HZ),
        );
      }
      let input = prior.input;
      // Plant feet only on a think that will actually fire. Hard holds
      // shoot=true every in-box think (apply owns weapon CD) — planting
      // whenever in-box made them duck/stand the whole duel.
      const hawkeyesActive = playerIsAbilityActive(
        me,
        "hawkeyes",
        ctx.view.tick,
      );
      const fireNow = shoot &&
        weaponReadyForShot(
          me.lastShotAtTick,
          ctx.view.tick,
          me.weapon.fireCooldownMs,
          shotIntervalMs,
        );
      if (
        fireNow &&
        !input.jump &&
        !hawkeyesActive &&
        inputHorizMoving(input)
      ) {
        input = plantInputForShot(input);
      }
      const ready: ReadyAction = {
        ...prior,
        input,
        shoot: shoot ? true : undefined,
      };
      return { out: ready };
}

export function createClickStep(
  opts: ClickStepOpts,
) {
  const {
    shootAimHalfAngleRad,
    reactionBaseMs,
    reactionVarianceMs,
    shotIntervalMs,
    clickCadenceMs,
    clickSettleMs,
    hitChance,
    leadSec,
    pursuitLagSec,
    rng,
  } = opts;
  return {
    id: "click",
    kind: "switch",
    run(ctx, prior, draftState) {
      return runClickStep(
        ctx,
        prior,
        draftState,
        shootAimHalfAngleRad,
        reactionBaseMs,
        reactionVarianceMs,
        shotIntervalMs,
        clickCadenceMs,
        clickSettleMs,
        hitChance,
        leadSec,
        pursuitLagSec,
        rng,
      );
    },
  } satisfies ThinkStep<ReadyAction, ReadyAction>;
}
