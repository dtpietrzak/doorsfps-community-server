/**
 * Apply-pipe contracts: ReadyAction → PlayerManager.
 * Think lives in `@doors/bot-engine`.
 *
 * Determinism contract (epic 4.5): see DETERMINISTIC_BOT_BOUNDARY.md.
 * ReadyAction + APPLY_STEP_IDS are the only think→sim crossing. Do not mutate
 * Player fields from bot code except via PlayerManager entry points.
 */

import type { Player } from "../../players/Player.ts";
import type { PlayerManager } from "../../players/PlayerManager.ts";
import type { PendingWeapon } from "../../players/weaponsQueue.ts";
import type { PlayerInput } from "../../protocol/network.ts";
import type { ManagedBot } from "../types.ts";

/**
 * Fully completed think output — sole handoff from think → apply pipe.
 * Same shape as {@link import("../types.ts").BotAction} on purpose.
 *
 * Think may use any AI/RNG/timing internally; only this emitted action crosses
 * into the sim. Replay records the applied stream and never re-thinks.
 */
export type ReadyAction = {
  input: PlayerInput | null;
  /**
   * Per-sim-tick look for the bot period, oldest first; last === input look.
   * Apply plays sample k on the k-th sim tick after release (see botInterp).
   */
  lookSamples?: import("../types.ts").BotLookSample[];
  shoot?: boolean;
  reload?: boolean;
  /** Equip this weapon id (edge-only through apply interp, like shoot/reload). */
  weapon?: number;
  /**
   * Activate skill family (edge-only through apply interp).
   * Apply → {@link PlayerManager.handleAbility}.
   */
  ability?: import("../../shared/sim/skills.ts").SkillId;
  /**
   * Sim tick of the world view think decided from (driver-stamped at enqueue).
   * The bot's "client render tick" — shots claim it for lag comp exactly like
   * a human client's `clientTick` (the keys-only note PR 3).
   */
  observedTick?: number;
};

export type ApplyContext = {
  tick: number;
  /** Tick-loop wall-clock timestamp used only by non-sim AFK bookkeeping. */
  nowMs: number;
  bot: ManagedBot;
  self: Player;
  players: PlayerManager;
  /**
   * Push a shoot/melee intent onto the shared Weapons queue (PR 4) — the same
   * sink shape a human's Shoot packet enqueues into. Resolution (and any
   * outcome) happens later in the Weapons-phase flush, not here.
   */
  enqueueWeapon: (req: PendingWeapon) => void;
};

/**
 * Cheap apply step — may call PlayerManager. Not part of think.
 */
export type ApplyStep = {
  readonly id: string;
  run(ctx: ApplyContext, action: ReadyAction): void;
};

/**
 * Canonical apply step ids — the only think→sim apply path (epic 4.5).
 * Order is locked: input → weapon switch → reload → shoot → ability.
 */
export const APPLY_STEP_IDS = [
  "stampAndInput",
  "weaponSwitch",
  "reload",
  "shoot",
  "ability",
] as const;

export type ApplyStepId = (typeof APPLY_STEP_IDS)[number];
