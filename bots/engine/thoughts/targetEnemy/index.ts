/**
 * If a hostile is in player FOV (with LOS), yaw onto them and either
 * stand-ground ADAD (or plant) or PWM-remap WASD so average world move tracks
 * path / vault / duck intent (not a coarse octant snap). Sticky on brain
 * state while the lock stays valid.
 *
 * **Grey agents** (`isAgent`): always stand-ground plant under combat lock
 * (no combat ADAD), unless vault/duck mobility blocks still movement.
 *
 * Ammo: under a lock, switch to the first loaded gun for the range
 * (shotgun inside ~10 m, rifle from ~20 m, pistol between). Empty active
 * mag → reload if spare clips remain, else switch. With no lock, top up a
 * shotgun tube that has room (a click on a later lock interrupts the
 * load). No mag and no clips → skip combat lock and path to the enemy door.
 *
 * @kind switch
 * Combat lock + stand-ground roll stick for the whole lock; may emit weapon.
 * After duck (float blocks stand-ground); before navigate / humanize / click.
 */

import {
  isUnarmedForCombat,
  pickBotWeaponSwitch,
  wantsBotReload,
} from "../../helpers/combat.ts";
import { isAtDoorCampPlant } from "../helpers/doorCamp.ts";
import {
  floatDuckBlocksStandStill,
  type FloatWallDuckState,
} from "../floatWallDuck/helpers/floatWallDuck.ts";
import type { HuntBrainState } from "../helpers/navLayers.ts";
import type {
  StepResult,
  ThinkContext,
  ThinkStep,
} from "../../pipeline/types.ts";
import {
  agentFirstChanceFromAggression,
  clearTargetEnemyState,
  stepTargetEnemy,
  TARGET_ENEMY_HUNT_ACQUIRE_FOV_SCALE,
  type TargetEnemyState,
  worldMoveYawFromPrior,
} from "./helpers/targetEnemy.ts";
import { applyTargetEnemyPatch, type BotBrainState } from "../../types.ts";
import type { Player } from "../../players/Player.ts";
import { YAW_PLAYER_FOV_HALF_ANGLE } from "../../../../shared/world/wallCorners.ts";
import type { AfterTargetDecision, NavDecision } from "../helpers/types.ts";
import { distance2 } from "../../math/index.ts";

export type TargetEnemyStepOpts = {
  targetEnemyStandGroundChance: number;
  targetEnemyStrafeAvgMs: number;
  targetEnemyStrafePauseAvgMs: number;
  targetEnemyStrafeVariation: number;
  agentAggression: number;
  /**
   * Door-rusher personality. At/above 0.5
   * (`DOOR_AGGRESSION_SUPPRESS_BACKWARD`), combat PWM suppresses S while
   * world move progresses toward the enemy door.
   */
  doorAggression: number;
  /**
   * Desired min horizontal distance to a locked enemy. 0 / omit → no
   * stand-ground back-off.
   */
  minSeparation: number;
  /** Combat look / click lead horizon (seconds). 0 → live body. */
  leadSec: number;
  rng: () => number;
};

export function runTargetEnemyStep(
  ctx: ThinkContext,
  prior: NavDecision,
  draftState: BotBrainState,
  targetEnemyStandGroundChance: number,
  targetEnemyStrafeAvgMs: number,
  targetEnemyStrafePauseAvgMs: number,
  targetEnemyStrafeVariation: number,
  agentAggression: number,
  doorAggression: number,
  minSeparation: number,
  leadSec: number,
  rng: () => number,
): StepResult<AfterTargetDecision> {
      const me = ctx.view.self;
      const bag = draftState as HuntBrainState;
      const campPlanted = Boolean(
        bag.doorCampActive &&
          Number.isFinite(bag.doorCampPlantX) &&
          Number.isFinite(bag.doorCampPlantZ) &&
          isAtDoorCampPlant(
            me.x,
            me.z,
            bag.doorCampPlantX,
            bag.doorCampPlantZ,
          ),
      );

      // Nothing can fire or reload: no duel — keep door path (yaw poles).
      if (isUnarmedForCombat(me)) {
        clearTargetEnemyState(draftState);
        const out: AfterTargetDecision = {
          target: prior.target,
          next: prior.next,
          desiredYaw: prior.desiredYaw,
          moveYaw: prior.moveYaw,
          nudgeDir: prior.nudgeDir,
          vault: prior.vault,
          duck: prior.duck,
          combat: null,
          weapon: undefined,
          reload: undefined,
        };
        return {
          out,
        };
      }

      // Continuous world move: path moveYaw, or vault/duck wish from face+keys.
      let worldMoveYaw = prior.moveYaw;
      if (prior.vault) {
        worldMoveYaw = worldMoveYawFromPrior(
          prior.vault.faceYaw,
          {
            forward: prior.vault.forward,
            backward: false,
            left: prior.vault.left,
            right: prior.vault.right,
          },
          prior.moveYaw,
        );
      } else if (prior.duck) {
        worldMoveYaw = worldMoveYawFromPrior(
          prior.duck.faceYaw,
          {
            forward: prior.duck.forward,
            backward: false,
            left: prior.duck.left,
            right: prior.duck.right,
          },
          prior.moveYaw,
        );
      }

      const huntActive = Boolean(bag.huntActive);
      // Never stand-ground under a float / mid duck — Crossroads mid freezes.
      // Same for vault: stand-ground ADAD strands half-wall hops mid-air.
      const duckBlocksStill = floatDuckBlocksStandStill(
        draftState as FloatWallDuckState,
        ctx.view.collision,
        me.x,
        me.z,
      ) || prior.duck !== null;
      const vaultBlocksStill = prior.vault !== null;
      const mobilityBlocksStill = duckBlocksStill || vaultBlocksStill;
      // V1 door camp + grey agents: stand-ground plant (no combat ADAD).
      // Vault / float-duck must keep body keys even for greys.
      const biased = ctx.hooks.combatBias(me, ctx.view, {
        doorAggression,
        standGroundChance: mobilityBlocksStill
          ? 0
          : campPlanted || me.isAgent
          ? 1
          : targetEnemyStandGroundChance,
        ignoreDoorPriority: huntActive,
        doorPriorityRatio: 1,
      }, { campPlanted, huntActive });
      const effectiveStandGround = biased.standGroundChance;
      const effectiveDoorAggression = biased.doorAggression;
      const ignoreDoorPriority = biased.ignoreDoorPriority;
      const doorPriorityRatio = biased.doorPriorityRatio;
      // Greys never combat-ADAD (plant only); camp lip stays fully still (v1).
      const noCombatAdad = campPlanted || Boolean(me.isAgent);
      // Greys do not prefer other greys (friendly); only team hunters use
      // agent-first chance.
      const perc = ctx.perception;
      const sensedHostiles: Player[] = [];
      if (perc) {
        const sensed = perc.sensedHostiles;
        for (let i = 0; i < sensed.length; i++) {
          sensedHostiles.push(sensed[i]!.player);
        }
      }
      const result = stepTargetEnemy({
        self: me,
        players: ctx.view.players,
        collision: ctx.view.collision,
        worldMoveYaw,
        state: draftState as TargetEnemyState,
        standGroundChance: effectiveStandGround,
        strafeAvgMs: noCombatAdad ? 0 : targetEnemyStrafeAvgMs,
        strafePauseAvgMs: noCombatAdad ? 0 : targetEnemyStrafePauseAvgMs,
        strafeVariation: noCombatAdad ? 0 : targetEnemyStrafeVariation,
        doorAggression: effectiveDoorAggression,
        minSeparation,
        rng,
        ignoreDoorPriority,
        doorPriorityRatio,
        acquireFovHalf: huntActive
          ? YAW_PLAYER_FOV_HALF_ANGLE * TARGET_ENEMY_HUNT_ACQUIRE_FOV_SCALE
          : undefined,
        agentFirstChance: huntActive && !me.isAgent
          ? agentFirstChanceFromAggression(agentAggression)
          : undefined,
        hostiles: perc ? sensedHostiles : undefined,
        assumeLos: Boolean(perc),
        enemyDoor: perc?.enemyDoor,
        distToEnemyDoor: perc?.distToEnemyDoor,
        tick: ctx.view.tick,
        holdIntentYaw: draftState.yawHumanizeLastDesired,
        leadSec,
      });

      // Force zero combat keys when planted (camp lip or grey agent stand-ground)
      // even if lock was sticky-moving. Under-float / active duck still needs
      // WASD — mobility override below restores vault/duck keys.
      let combat = result.combat;
      if (combat && (campPlanted || (me.isAgent && !mobilityBlocksStill))) {
        combat = {
          lookYaw: combat.lookYaw,
          lookPitch: combat.lookPitch,
          enemyId: combat.enemyId,
          forward: false,
          backward: false,
          left: false,
          right: false,
        };
      }
      // Sticky stand-ground from an earlier lock must not freeze mid-duck/vault.
      if (combat && duckBlocksStill && prior.duck) {
        combat = {
          lookYaw: combat.lookYaw,
          lookPitch: combat.lookPitch,
          enemyId: combat.enemyId,
          forward: prior.duck.forward,
          backward: false,
          left: prior.duck.left,
          right: prior.duck.right,
        };
      }
      if (combat && vaultBlocksStill && prior.vault) {
        combat = {
          lookYaw: combat.lookYaw,
          lookPitch: combat.lookPitch,
          enemyId: combat.enemyId,
          forward: prior.vault.forward,
          backward: false,
          left: prior.vault.left,
          right: prior.vault.right,
        };
      }

      let foe;
      if (combat) {
        const roster = ctx.view.players;
        for (let i = 0; i < roster.length; i++) {
          const player = roster[i]!;
          if (player.id === combat.enemyId) {
            foe = player;
            break;
          }
        }
      }
      const lockDist = foe ? distance2(foe.x - me.x, foe.z - me.z) : undefined;
      const switchWeapon = pickBotWeaponSwitch(
        me,
        lockDist !== undefined ? { lockDist } : undefined,
      ) ?? undefined;
      const reload = wantsBotReload(me, { idle: combat === null }) || undefined;
      applyTargetEnemyPatch(draftState, result.statePatch);

      const out: AfterTargetDecision = {
        target: prior.target,
        next: prior.next,
        desiredYaw: prior.desiredYaw,
        moveYaw: prior.moveYaw,
        nudgeDir: prior.nudgeDir,
        vault: prior.vault,
        duck: prior.duck,
        combat,
        weapon: switchWeapon,
        reload,
      };
      return {
        out,
      };
}

export function createTargetEnemyStep(
  opts: TargetEnemyStepOpts,
) {
  const {
    targetEnemyStandGroundChance,
    targetEnemyStrafeAvgMs,
    targetEnemyStrafePauseAvgMs,
    targetEnemyStrafeVariation,
    agentAggression,
    doorAggression,
    minSeparation,
    leadSec,
    rng,
  } = opts;
  return {
    id: "targetEnemy",
    kind: "switch",
    run(ctx, prior, draftState) {
      return runTargetEnemyStep(
        ctx,
        prior,
        draftState,
        targetEnemyStandGroundChance,
        targetEnemyStrafeAvgMs,
        targetEnemyStrafePauseAvgMs,
        targetEnemyStrafeVariation,
        agentAggression,
        doorAggression,
        minSeparation,
        leadSec,
        rng,
      );
    },
  } satisfies ThinkStep<NavDecision, AfterTargetDecision>;
}
