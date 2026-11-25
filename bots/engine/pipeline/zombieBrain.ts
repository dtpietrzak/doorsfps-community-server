/**
 * Zombots horde brain. Same ReadyAction as the gun brain, so BotManager
 * and the local arena driver run it without new wiring.
 *
 * Chain: gate → perception → sticky human → navMode (then forced hunt)
 * → navGoal on that human → pathHeading → navigate → stuckWTurn →
 * chest look, one melee lunge, a sideways crowd push. No guns.
 * Yaw poles stay out: pathHeading walks the goal. On zombots maps the
 * floor nav in thoughts/zombie/window.ts picks that goal instead while the
 * human is out of plain reach: in a zombie closure a waypoint toward a
 * window (and, right at it, keys and the jump straight from the plan); in
 * a player closure a waypoint round walls and through opened doors.
 */

import type { BotBrainConfig } from "../config.ts";
import type { BrainHooks } from "../hooks.ts";
import { defaultBrainHooks } from "../hooks.ts";
import { clamp01 } from "../math/index.ts";
import { isSetNumber } from "./state.ts";
import type {
  BotAction,
  BotBrainState,
  BotWorldView,
} from "../types.ts";
import type { ReadyAction, ThinkContext } from "./types.ts";
import { idleInput } from "../thoughts/navigate/helpers/inputs.ts";
import {
  runGateStep,
  runNavGoalStep,
  runNavModeStep,
  runNavigateStep,
  runPathHeadingStep,
  runPerceptionStep,
  runStuckWTurnStep,
} from "../thoughts/index.ts";
import {
  armMeleeCooldown,
  rememberZombieTarget,
  zombieLastKnown,
  zombieLookAt,
  zombieMeleeLunge,
  zombieHoldsForward,
  zombieSeparationStrafe,
  zombieStickyId,
  zombieWindowPlan,
  pickZombieTarget,
  type ZombiePlayerView,
} from "../thoughts/zombie/index.ts";
import type { PlayerInput } from "../shared/network.ts";
import type { AfterSprintDecision } from "../thoughts/helpers/types.ts";
import type { YawPoleNavDecision } from "../thoughts/helpers/navLayers.ts";

export class ZombieBrain {
  public readonly id: string;
  private readonly agentAggression: number;
  private readonly doorAggression: number;
  private readonly pathStrafe: number;
  private readonly nudgeStrafe: number;
  private readonly cornerRound: number;
  private readonly rng: () => number;
  private readonly hooks: BrainHooks;

  constructor(
    config: BotBrainConfig,
    opts?: { rng?: () => number; hooks?: BrainHooks },
  ) {
    this.id = config.id;
    this.agentAggression = config.agentAggression;
    const doorAgg = config.doorAggression;
    this.doorAggression = Number.isFinite(doorAgg) ? clamp01(doorAgg) : 0;
    this.pathStrafe = config.pathStrafe;
    this.nudgeStrafe = config.nudgeStrafe ?? config.pathStrafe;
    this.cornerRound = config.cornerRound;
    this.rng = opts?.rng ?? (() => 0.5);
    this.hooks = opts?.hooks ?? defaultBrainHooks();
  }

  public think(view: BotWorldView, state: BotBrainState): BotAction | null {
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
      if (!gate.ready) return null;
      // Match-over idle still must not fire. The gate object has no shoot field.
      return { input: gate.ready.input, shoot: false };
    }

    runPerceptionStep(ctx, gate.out, draft);

    const players = view.players as readonly ZombiePlayerView[];
    const target = pickZombieTarget(
      view.self,
      players,
      zombieStickyId(draft),
    );
    rememberZombieTarget(draft, target);

    const last = zombieLastKnown(draft);
    if (!target && !last) {
      return decorate(
        idleInput(view.self.yaw, 0),
        ctx,
        draft,
        null,
        false,
        0,
      );
    }

    // Floor nav (zombots): to and over a window, or round walls to the
    // human. Right at a window the keys come straight from the plan; no
    // swing, no crowd shove.
    const window = zombieWindowPlan(
      view.zombieWindows,
      view.self,
      target ? { x: target.x, z: target.z } : last,
      draft,
    );
    if (window.kind === "steer") {
      const steerReady: ReadyAction = {
        input: {
          ...idleInput(window.yaw, 0),
          forward: true,
          jump: window.jump,
        },
        shoot: false,
      };
      return runStuckWTurnStep(ctx, steerReady, draft, this.rng).out;
    }

    // Door edges still clear sticky poles. The mode itself is then forced
    // to hunt so an open score-door does not send the horde to a pad.
    runNavModeStep(
      ctx,
      null,
      draft,
      this.agentAggression,
      this.rng,
    );
    draft.huntActive = true;
    draft.doorCampActive = false;

    if (ctx.perception) {
      ctx.perception.nearestHuntGoal = window.kind === "walk"
        ? { x: window.goal.x, z: window.goal.z, playerId: target?.id ?? "" }
        : target
        ? { x: target.x, z: target.z, playerId: target.id }
        : null;
    }
    // navMode wipes the hunt-last slot whenever the score doors are open.
    // Put the latched XZ back so a dead target is still walked toward.
    if (!target && last && window.kind === "none") {
      draft.huntLastAgentX = last.x;
      draft.huntLastAgentZ = last.z;
    }

    const navGoal = runNavGoalStep(
      ctx,
      { mode: "hunt", forceNoiseReroll: true },
      draft,
      this.rng,
      this.doorAggression,
    );
    const pole: YawPoleNavDecision = {
      mode: "hunt",
      goal: navGoal.out.goal,
      campArrived: false,
      target: null,
      next: null,
    };
    const heading = runPathHeadingStep(
      ctx,
      pole,
      draft,
      this.pathStrafe,
      this.nudgeStrafe,
      this.cornerRound,
      this.rng,
    );

    let desiredYaw = heading.out.rawLook;
    let pitch = 0;
    // On the way to a window, look where it walks, not through the wall.
    if (target && window.kind === "none") {
      const look = zombieLookAt(view.self, target);
      desiredYaw = look.yaw;
      pitch = look.pitch;
    }
    const paced: AfterSprintDecision = {
      target: heading.out.target,
      next: heading.out.next,
      desiredYaw,
      moveYaw: heading.out.moveYaw,
      nudgeDir: heading.out.nudgeDir,
      vault: null,
      duck: null,
      combat: null,
      sprint: false,
    };
    const navigate = runNavigateStep(ctx, paced, draft);
    const stuck = runStuckWTurnStep(ctx, navigate.out, draft, this.rng);
    const peeling = isSetNumber(draft.stuckWTurnTicksLeft) &&
      draft.stuckWTurnTicksLeft > 0;
    const input = stuck.out.input;
    if (!input) return { input: null, shoot: false };
    return decorate(
      input,
      ctx,
      draft,
      target,
      peeling,
      pitch,
      window.kind === "walk" ? window.goal : null,
    );
  }
}

function decorate(
  input: PlayerInput,
  ctx: ThinkContext,
  draft: BotBrainState,
  target: ZombiePlayerView | null,
  peeling: boolean,
  pitch: number,
  /** Floor-nav waypoint (window.ts): no swing, no stand-off hold. */
  walkGoal: { x: number; z: number } | null = null,
): ReadyAction {
  // A peel owns facing and keys until it finishes. Don't swing or shove.
  if (peeling) return { input, shoot: false };

  const yaw = input.yaw;
  let nextPitch = input.pitch;
  let lunge = false;
  if (target && walkGoal === null) {
    nextPitch = pitch;
    // Body yaw, not the look command: the swing has to be facing them now.
    lunge = zombieMeleeLunge({
      self: ctx.view.self,
      target,
      tick: ctx.view.tick,
      readyAtTick: draft.reactionReadyAtTick,
    });
    if (lunge) armMeleeCooldown(draft, ctx.view.tick);
  }
  const side = zombieSeparationStrafe(ctx.view.self, yaw, ctx.view.players);
  // The stand-off ring is for the target; a walk goal is just a waypoint.
  const hold = target !== null && walkGoal === null &&
    zombieHoldsForward(ctx.view.self, target, ctx.view.players);
  const steered: PlayerInput = {
    ...input,
    forward: hold ? false : input.forward,
    yaw,
    pitch: nextPitch,
    left: side === "left" ? true : side === "right" ? false : input.left,
    right: side === "right" ? true : side === "left" ? false : input.right,
  };
  return {
    input: steered,
    shoot: false,
    ...(lunge ? { melee: true } : {}),
  };
}
