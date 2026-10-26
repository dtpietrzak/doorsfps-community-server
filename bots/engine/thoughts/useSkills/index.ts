/**
 * Activate an equipped skill when the situation matches — not a 20 Hz
 * Bernoulli over whatever is charged.
 *
 * Priority (first match among usable):
 *   selfHeal / teamHeal / forceField when hurt
 *   Hawkeyes when locked + (moving or rifle)
 *   bullets / rapidFire / oneShot while fighting
 *   Glitch only when sensed and losing (and not about to shoot)
 *   Rewind / Teleport only when stuck
 *   Quick on a door-run (moving, not locked)
 *
 * `skillUseChance` ≤ 0 disables the step (community / agents). Otherwise
 * a situational pick always fires — charge / global lock still gate
 * the player snapshot's authoritative activation gate.
 *
 * @kind switch (sub: pack-ish)
 */

import { MAX_HEALTH } from "../../../../shared/sim/game.ts";
import type { SkillId } from "../../../../shared/sim/skills.ts";
import { isSkillActivatable } from "../../../../shared/sim/skills.ts";
import { WEAPON_RIFLE } from "../../../../shared/sim/weapons.ts";
import { inputHorizMoving } from "../click/helpers/click.ts";
import type {
  ReadyAction,
  StepResult,
  ThinkContext,
  ThinkStep,
} from "../../pipeline/types.ts";
import type { BotBrainState } from "../../types.ts";
import { clamp01 } from "../../math/index.ts";
import {
  playerCanActivateAbility,
  playerIsAbilityActive,
  playerSnapshotSkillLoadout,
  type Player,
} from "../../players/Player.ts";

/** HP at/below this counts as "hurt" for heal / force-field / Glitch. */
export const SKILL_HURT_HP = 70;
/** HP at/below this is "losing" — Glitch / force-field. */
export const SKILL_LOSING_HP = 50;
/** oneShot only inside this horizontal range. */
export const SKILL_ONESHOT_RANGE = 12;

export type UseSkillsStepOpts = {
  /**
   * 0 → never activate (community / agents).
   * &gt;0 → situational pick may activate (charge still gates).
   */
  skillUseChance: number;
  rng: () => number;
};

export type SkillSituation = {
  usable: readonly SkillId[];
  health: number;
  locked: boolean;
  shooting: boolean;
  moving: boolean;
  hawkeyesActive: boolean;
  sensedHostileCount: number;
  nearestSensedDist: number | null;
  weaponId: number;
  stuck: boolean;
};

/**
 * Collect equipped activatable skills that may start at `tick`.
 * Pure helper for tests.
 */
export function usableEquippedSkills(
  self: Player,
  tick: number,
): SkillId[] {
  const loadout = playerSnapshotSkillLoadout(self);
  if (loadout == null) return [];
  const out: SkillId[] = [];
  for (let i = 0; i < loadout.length; i++) {
    const slot = loadout[i];
    if (slot == null) continue;
    let duplicate = false;
    for (let j = 0; j < out.length; j++) {
      if (out[j] === slot) {
        duplicate = true;
        break;
      }
    }
    if (duplicate) continue;
    if (!isSkillActivatable(slot)) continue;
    if (!playerCanActivateAbility(self, slot, tick)) continue;
    out.push(slot);
  }
  return out;
}

function has(usable: readonly SkillId[], id: SkillId): boolean {
  return usable.includes(id);
}

/**
 * First situational match among `usable`. Returns null when nothing fits
 * (do not fall back to a random charged skill).
 */
export function pickSituationalSkill(sit: SkillSituation): SkillId | null {
  const { usable } = sit;
  if (usable.length === 0) return null;

  const hurt = sit.health <= SKILL_HURT_HP;
  const losing = sit.health <= SKILL_LOSING_HP;
  const fighting = sit.locked || sit.shooting;
  const close = sit.nearestSensedDist !== null &&
    sit.nearestSensedDist <= SKILL_ONESHOT_RANGE;

  if (hurt && has(usable, "selfHeal")) return "selfHeal";
  if (hurt && has(usable, "teamHeal")) return "teamHeal";
  if (losing && sit.sensedHostileCount > 0 && has(usable, "forceField")) {
    return "forceField";
  }

  if (
    sit.locked &&
    !sit.hawkeyesActive &&
    (sit.moving || sit.weaponId === WEAPON_RIFLE) &&
    has(usable, "hawkeyes")
  ) {
    return "hawkeyes";
  }

  if (fighting && has(usable, "bullets")) return "bullets";
  if (fighting && has(usable, "rapidFire")) return "rapidFire";
  if (fighting && close && has(usable, "oneShot")) return "oneShot";

  if (
    losing &&
    sit.sensedHostileCount > 0 &&
    !sit.shooting &&
    has(usable, "glitch")
  ) {
    return "glitch";
  }

  if (sit.stuck && has(usable, "rewind")) return "rewind";
  if (sit.stuck && has(usable, "teleport")) return "teleport";

  if (sit.moving && !sit.locked && has(usable, "quick")) return "quick";

  return null;
}

export function runUseSkillsStep(
  ctx: ThinkContext,
  prior: ReadyAction,
  draftState: BotBrainState,
  skillUseChance: number,
): StepResult<ReadyAction> {
      if (skillUseChance <= 0) {
        return { out: prior };
      }
      const me = ctx.view.self;
      const usable = usableEquippedSkills(me, ctx.view.tick);
      if (usable.length === 0) {
        return { out: prior };
      }

      const combatId = draftState.targetEnemyId;
      const locked = typeof combatId === "string" && combatId.length > 0;
      const perc = ctx.perception;
      const input = prior.input;
      const moving = input ? inputHorizMoving(input) : false;
      const stuckTicks = draftState.stuckWTurnTicksLeft;
      const stuck = typeof stuckTicks === "number" &&
        Number.isFinite(stuckTicks) &&
        stuckTicks > 0;
      const health = typeof me.health === "number" && Number.isFinite(me.health)
        ? me.health
        : MAX_HEALTH;
      const hawkeyesActive = playerIsAbilityActive(
        me,
        "hawkeyes",
        ctx.view.tick,
      );
      const weaponId = typeof me.weaponId === "number"
        ? me.weaponId
        : WEAPON_RIFLE;

      const skill = pickSituationalSkill({
        usable,
        health,
        locked,
        shooting: prior.shoot === true,
        moving,
        hawkeyesActive,
        sensedHostileCount: perc?.sensedHostiles.length ?? 0,
        nearestSensedDist: perc?.nearestSensedHostile?.dist ?? null,
        weaponId,
        stuck,
      });
      if (!skill) {
        return { out: prior };
      }

      const ready: ReadyAction = { ...prior, ability: skill };
      return { out: ready };
}

export function createUseSkillsStep(
  opts: UseSkillsStepOpts,
) {
  const chanceRaw = opts.skillUseChance;
  const skillUseChance = Number.isFinite(chanceRaw) ? clamp01(chanceRaw) : 0;
  return {
    id: "useSkills",
    kind: "switch",
    run(ctx, prior, draftState) {
      return runUseSkillsStep(ctx, prior, draftState, skillUseChance);
    },
  } satisfies ThinkStep<ReadyAction, ReadyAction>;
}
