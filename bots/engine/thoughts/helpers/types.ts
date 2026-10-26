/**
 * Shared decision types passed between BotBrain think steps.
 */

import type { YawPolePoint } from "../yawPole/helpers/yawPole.ts";
import type { CombatPitchMotorInput } from "../combatPitch/helpers/motor.ts";

/**
 * After yawIntent: pole goal + nav-channel smoothed **look** heading + world
 * move yaw (corner-round may split look vs move).
 * Vault/duck probe along `moveYaw`; navigate maps keys from body vs move.
 */
export type YawIntentDecision = {
  target: YawPolePoint | null;
  next: YawPolePoint | null;
  /** Smoothed look intent (nav low-pass only). */
  desiredYaw: number;
  /** World move heading (toward current, outside-strafe when rounding). */
  moveYaw: number;
  /** Timed authored Nudge input; applied as literal A/D in navigate. */
  nudgeDir: "left" | "right" | "none";
};

export type VaultOverride = {
  faceYaw: number;
  forward: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
};

export type DuckOverride = {
  faceYaw: number;
  forward: boolean;
  left: boolean;
  right: boolean;
};

/** After halfWallVault: intent + optional jump vault. */
export type AfterVaultDecision = {
  target: YawPolePoint | null;
  next: YawPolePoint | null;
  desiredYaw: number;
  moveYaw: number;
  nudgeDir: "left" | "right" | "none";
  vault: VaultOverride | null;
};

/** After floatWallDuck: intent + vault or crouch-under override. */
export type NavDecision = {
  target: YawPolePoint | null;
  next: YawPolePoint | null;
  desiredYaw: number;
  moveYaw: number;
  nudgeDir: "left" | "right" | "none";
  vault: VaultOverride | null;
  duck: DuckOverride | null;
};

/** Combat look lock + WASD remapped to hold world move. */
export type CombatOverride = {
  lookYaw: number;
  lookPitch: number;
  enemyId: string;
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  /** Internal normalized frame for the extracted persistent pitch motor. */
  compiledPitchInput?: CombatPitchMotorInput;
};

/** After targetEnemy: nav decision + optional combat look/keys + weapon switch. */
export type AfterTargetDecision = NavDecision & {
  combat: CombatOverride | null;
  /** Equip this weapon id on the ready action (empty mag → other gun). */
  weapon?: number;
  /** Start a reload when the active mag is dry and spare clips remain. */
  reload?: boolean;
};

/** After evalSprint: prior decision + whether to hold sprint this think. */
export type AfterSprintDecision = AfterTargetDecision & {
  sprint: boolean;
};
