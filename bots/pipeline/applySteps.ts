/**
 * Shared apply pipe: ReadyAction → PlayerManager (input / reload / shoot / ability).
 *
 * Cheap and side-effecting — not part of the AI budget pipe.
 * Determinism contract: DETERMINISTIC_BOT_BOUNDARY.md (epic 4.5).
 *
 * **No AI rewrites.** Keys and look are exactly what the brain put on the
 * ReadyAction (after think-buffer delay + hold/interp between bot ticks).
 * Yaw easing, crouch-under, wall peels, etc. belong in BotBrain think steps.
 *
 * Apply only (sole think→sim path; do not write Player fields here except via
 * PlayerManager.handleInput / handleWeaponSwitch / handleReload / handleShoot /
 * handleAbility):
 *   1. stamps sequence and queues the packet as-is
 *   2. reload immediately; shoot enqueues onto the shared Weapons queue
 *      (PR 4) exactly like a human client's Shoot packet — no aim "smarts",
 *      no apply-time cap; resolution happens later in the Weapons flush.
 *   3. ability activate via handleAbility (teamHeal / teleport safe)
 */

import type { ShootPacket } from "../../protocol/network.ts";
import { buildShootAimSnapshot, stampBotInput } from "./botInputAdapter.ts";
import type { ApplyContext, ApplyStep, ReadyAction } from "./types.ts";

const stampAndInput: ApplyStep = {
  id: "stampAndInput",
  run(ctx: ApplyContext, action: ReadyAction): void {
    if (!action.input) return;
    const input = stampBotInput(ctx.bot, action.input);
    ctx.players.handleInput(ctx.bot.playerId, input);
  },
};

const weaponSwitch: ApplyStep = {
  id: "weaponSwitch",
  run(ctx: ApplyContext, action: ReadyAction): void {
    if (typeof action.weapon !== "number") return;
    ctx.players.handleWeaponSwitch(
      ctx.bot.playerId,
      action.weapon,
      ctx.tick,
    );
  },
};

const reload: ApplyStep = {
  id: "reload",
  run(ctx: ApplyContext, action: ReadyAction): void {
    if (!action.reload) return;
    ctx.players.handleReload(ctx.bot.playerId, ctx.tick);
  },
};

const shoot: ApplyStep = {
  id: "shoot",
  run(ctx: ApplyContext, action: ReadyAction): void {
    if (!action.shoot) return;

    const self = ctx.self;
    const aim = buildShootAimSnapshot(
      action,
      { yaw: self.yaw, pitch: self.pitch },
      ctx.tick,
    );
    const packet: ShootPacket = {
      yaw: aim.yaw,
      pitch: aim.pitch,
      clientTick: aim.clientTick,
      lastAppliedSnapshotTick: aim.lastAppliedSnapshotTick,
    };

    ctx.enqueueWeapon({
      kind: "shoot",
      shooterId: ctx.bot.playerId,
      packet,
    });
  },
};

const ability: ApplyStep = {
  id: "ability",
  run(ctx: ApplyContext, action: ReadyAction): void {
    if (action.ability == null) return;
    ctx.players.handleAbility(
      ctx.bot.playerId,
      action.ability,
      ctx.tick,
    );
  },
};

/** Canonical apply order: input → weapon switch → reload → shoot → ability. */
export const DEFAULT_APPLY_STEPS: readonly ApplyStep[] = [
  stampAndInput,
  weaponSwitch,
  reload,
  shoot,
  ability,
];

/**
 * Run the apply pipe for one bot's ReadyAction.
 * This is sim-input conversion, not sim-logic — same seed + same ReadyAction
 * stream must yield the same handle* calls.
 */
export function runApplyPipe(
  steps: readonly ApplyStep[],
  ctx: ApplyContext,
  action: ReadyAction | null,
): void {
  if (!action) return;
  for (const step of steps) {
    step.run(ctx, action);
  }
}
