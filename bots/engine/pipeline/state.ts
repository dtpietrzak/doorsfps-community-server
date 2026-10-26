/**
 * Closed per-bot thought latch bag.
 *
 * ScriptC lowers optional `number | undefined` / `boolean | undefined` slots as
 * heap-boxed unions. This class keeps every latch present so native layout can
 * store booleans and numbers inline. Absent numbers are NaN; absent strings are
 * empty; absent flags are false.
 */

export const UNSET = Number.NaN;

export function isSetNumber(value: number): boolean {
  return Number.isFinite(value);
}

export function storedNumber(value: number | undefined | null): number {
  return typeof value === "number" && Number.isFinite(value) ? value : UNSET;
}

export function storedString(value: string | undefined | null): string {
  return typeof value === "string" ? value : "";
}

function copyStringMap(
  source: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  const keys = Object.keys(source);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i]!;
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

function copyNumberList(source: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < source.length; i += 1) {
    const value = source[i];
    if (typeof value === "number" && Number.isFinite(value)) out.push(value);
  }
  return out;
}

function copyStringList(source: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < source.length; i += 1) {
    const value = source[i];
    if (typeof value === "string" && value.length > 0) out.push(value);
  }
  return out;
}

/** Persistent pipeline latches owned by one bot for the life of the engine. */
export class BotBrainState {
  huntActive: boolean;
  huntDoorBias: string;
  huntDoorBiasDist: number;
  huntLastAgentX: number;
  huntLastAgentZ: number;
  huntDoorsOpen: boolean;
  huntDoorsSampled: boolean;
  doorCampActive: boolean;
  doorCampPlantX: number;
  doorCampPlantZ: number;
  doorCampWantLip: boolean;
  doorCampLookIndex: number;
  doorCampViaOwn: boolean;
  doorCampNextSwitchAt: number;

  dwellBreakKey: string;
  dwellBreakSinceTick: number;
  dwellForceHuntUntilTick: number;

  pathStrafeDir: string;
  pathStrafeTicksLeft: number;
  pathStrafeFirst: string;

  halfWallVaultTicksLeft: number;
  halfWallVaultFaceYaw: number;
  halfWallVaultOption: number;
  halfWallVaultJumpHoldTicksLeft: number;
  halfWallVaultConsecCount: number;
  halfWallVaultConsecX: number;
  halfWallVaultConsecZ: number;
  halfWallVaultConsecTick: number;

  floatWallDuckTicksLeft: number;
  floatWallDuckFaceYaw: number;
  floatWallDuckOption: number;
  floatWallDuckStartX: number;
  floatWallDuckStartZ: number;
  floatWallDuckElapsed: number;
  floatWallDuckCooldownUntilTick: number;

  stuckWLastX: number;
  stuckWLastZ: number;
  stuckWElapsed: number;
  stuckWTurnTicksLeft: number;
  stuckWTurnFaceYaw: number;
  stuckWCooldownUntilTick: number;

  stickyYawPoleX: number;
  stickyYawPoleZ: number;
  yawPoleCommitKeys: string[];
  yawPoleIgnore: Record<string, number>;
  yawPoleNoise: Record<string, number>;
  yawPoleNoiseReady: boolean;
  yawPoleNoiseSpawnedAtTick: number;

  cadenceNavGoalValid: boolean;
  cadenceNavGoalMode: string;
  cadenceNavGoalX: number;
  cadenceNavGoalZ: number;
  cadenceNavGoalHasDoorDist: boolean;
  cadenceNavGoalDoorDistX: number;
  cadenceNavGoalDoorDistZ: number;
  cadenceNavGoalCampArrived: boolean;
  cadenceNavGoalForceNoiseReroll: boolean;

  cadenceYawPoleValid: boolean;
  cadenceYawPoleMode: string;
  cadenceYawPoleGoalX: number;
  cadenceYawPoleGoalZ: number;
  cadenceYawPoleCampArrived: boolean;
  cadenceYawPoleHasTarget: boolean;
  cadenceYawPoleTargetX: number;
  cadenceYawPoleTargetZ: number;
  cadenceYawPoleHasNext: boolean;
  cadenceYawPoleNextX: number;
  cadenceYawPoleNextZ: number;

  smoothedDesiredYaw: number;
  sprintChanceLatched: boolean;
  sprintChanceHasLatch: boolean;
  openSprintChanceLatched: boolean;
  openSprintChanceHasLatch: boolean;

  targetEnemyId: string;
  targetEnemyStandGround: boolean;
  targetEnemyStrafePhase: string;
  targetEnemyStrafeTicksLeft: number;
  targetEnemyStrafeDir: string;
  targetEnemyStrafeDepth: string;
  targetEnemyStrafeDepthDuty: number;
  targetEnemyStrafeStopped: boolean;
  targetEnemyPwmAcc: number;
  targetEnemyPwmOn: boolean;
  targetEnemyPwmDwell: number;
  targetEnemyPwmSec: string;
  targetEnemySampleX: number;
  targetEnemySampleZ: number;
  targetEnemyVx: number;
  targetEnemyVz: number;
  targetEnemyVy: number;
  targetEnemySeparating: boolean;

  combatPitchMicro: number;
  combatPitchTrack: number;
  combatAimHeightForId: string;
  combatAimHeight: string;

  yawHumanizeVel: number;
  yawHumanizeMicro: number;
  yawHumanizeAimErr: number;
  yawHumanizeOvershoot: number;
  yawHumanizeLastDesired: number;
  yawHumanizeLastX: number;
  yawHumanizeLastZ: number;
  yawHumanizeVLatRing: number[];
  yawHumanizePhase: string;
  yawHumanizePlanTarget: number;
  yawHumanizePlanAnchor: number;
  yawHumanizeDeadband: number;
  yawHumanizeOvershootUsed: boolean;
  lookReactionForEnemyId: string;
  lookReactionReadyAtTick: number;
  lookOvershootPending: boolean;
  yawHumanizeSpawnedAtTick: number;
  /**
   * Look chain: noise-free servo yaw at the end of the last planned bot
   * period. Motors continue from here instead of the live (think-buffer
   * stale) body yaw — a human's own camera has no self-latency either.
   */
  yawHumanizeServoYaw: number;
  /** Look chain: yaw noise offset at the end of the last planned period. */
  yawHumanizeNoiseOut: number;
  /** Look chain: pitch at the end of the last planned bot period. */
  lookPlanPitch: number;
  /** Aim planner: a submovement (stroke) is in flight. */
  aimMoveActive: boolean;
  /** Aim planner: seconds elapsed / planned for the active stroke. */
  aimMoveElapsed: number;
  aimMoveDur: number;
  /** Aim planner: stroke start look. */
  aimMoveFromYaw: number;
  aimMoveFromPitch: number;
  /** Aim planner: stroke landing look (target × rolled gain). */
  aimMoveToYaw: number;
  aimMoveToPitch: number;
  /** Aim planner: perpendicular bow peak, zero at both stroke ends. */
  aimMoveArcYaw: number;
  aimMoveArcPitch: number;
  /** Aim planner: seconds left before a corrective stroke may start. */
  aimDwell: number;
  /** Aim planner: corrective strokes already spent on this target. */
  aimCorrections: number;
  /** Aim planner: perceived (pursuit-lagged) target. */
  aimPerceivedYaw: number;
  aimPerceivedPitch: number;
  /** Aim planner: smoothed perceived-target velocity (rad/s). */
  aimPerceivedVelYaw: number;
  aimPerceivedVelPitch: number;
  /** Aim planner: perceived target the last stroke aimed at. */
  aimPlanTargetYaw: number;
  aimPlanTargetPitch: number;

  reactionForEnemyId: string;
  reactionReadyAtTick: number;
  hitChanceMissUntilTick: number;
  /** Trigger: sim tick of this bot's own last emitted click. */
  clickLastShotTick: number;
  /** Trigger: rolled hand gap (ticks) on top of the weapon cooldown. */
  clickCadenceTicks: number;
  /** Trigger: tick the aim-settle delay ends; NaN when off target. */
  clickSettleReadyAtTick: number;

  raidStopperHasLatch: boolean;
  raidIsStopper: boolean;
  raidNextStopTick: number;
  raidStopUntilTick: number;

  constructor() {
    this.huntActive = false;
    this.huntDoorBias = "";
    this.huntDoorBiasDist = UNSET;
    this.huntLastAgentX = UNSET;
    this.huntLastAgentZ = UNSET;
    this.huntDoorsOpen = false;
    this.huntDoorsSampled = false;
    this.doorCampActive = false;
    this.doorCampPlantX = UNSET;
    this.doorCampPlantZ = UNSET;
    this.doorCampWantLip = false;
    this.doorCampLookIndex = 0;
    this.doorCampViaOwn = false;
    this.doorCampNextSwitchAt = UNSET;

    this.dwellBreakKey = "";
    this.dwellBreakSinceTick = UNSET;
    this.dwellForceHuntUntilTick = UNSET;

    this.pathStrafeDir = "none";
    this.pathStrafeTicksLeft = UNSET;
    this.pathStrafeFirst = "";

    this.halfWallVaultTicksLeft = UNSET;
    this.halfWallVaultFaceYaw = UNSET;
    this.halfWallVaultOption = UNSET;
    this.halfWallVaultJumpHoldTicksLeft = UNSET;
    this.halfWallVaultConsecCount = UNSET;
    this.halfWallVaultConsecX = UNSET;
    this.halfWallVaultConsecZ = UNSET;
    this.halfWallVaultConsecTick = UNSET;

    this.floatWallDuckTicksLeft = UNSET;
    this.floatWallDuckFaceYaw = UNSET;
    this.floatWallDuckOption = UNSET;
    this.floatWallDuckStartX = UNSET;
    this.floatWallDuckStartZ = UNSET;
    this.floatWallDuckElapsed = UNSET;
    this.floatWallDuckCooldownUntilTick = UNSET;

    this.stuckWLastX = UNSET;
    this.stuckWLastZ = UNSET;
    this.stuckWElapsed = UNSET;
    this.stuckWTurnTicksLeft = UNSET;
    this.stuckWTurnFaceYaw = UNSET;
    this.stuckWCooldownUntilTick = UNSET;

    this.stickyYawPoleX = UNSET;
    this.stickyYawPoleZ = UNSET;
    this.yawPoleCommitKeys = [];
    this.yawPoleIgnore = {};
    this.yawPoleNoise = {};
    this.yawPoleNoiseReady = false;
    this.yawPoleNoiseSpawnedAtTick = UNSET;

    this.cadenceNavGoalValid = false;
    this.cadenceNavGoalMode = "";
    this.cadenceNavGoalX = UNSET;
    this.cadenceNavGoalZ = UNSET;
    this.cadenceNavGoalHasDoorDist = false;
    this.cadenceNavGoalDoorDistX = UNSET;
    this.cadenceNavGoalDoorDistZ = UNSET;
    this.cadenceNavGoalCampArrived = false;
    this.cadenceNavGoalForceNoiseReroll = false;

    this.cadenceYawPoleValid = false;
    this.cadenceYawPoleMode = "";
    this.cadenceYawPoleGoalX = UNSET;
    this.cadenceYawPoleGoalZ = UNSET;
    this.cadenceYawPoleCampArrived = false;
    this.cadenceYawPoleHasTarget = false;
    this.cadenceYawPoleTargetX = UNSET;
    this.cadenceYawPoleTargetZ = UNSET;
    this.cadenceYawPoleHasNext = false;
    this.cadenceYawPoleNextX = UNSET;
    this.cadenceYawPoleNextZ = UNSET;

    this.smoothedDesiredYaw = UNSET;
    this.sprintChanceLatched = false;
    this.sprintChanceHasLatch = false;
    this.openSprintChanceLatched = false;
    this.openSprintChanceHasLatch = false;

    this.targetEnemyId = "";
    this.targetEnemyStandGround = false;
    this.targetEnemyStrafePhase = "";
    this.targetEnemyStrafeTicksLeft = UNSET;
    this.targetEnemyStrafeDir = "";
    this.targetEnemyStrafeDepth = "";
    this.targetEnemyStrafeDepthDuty = UNSET;
    this.targetEnemyStrafeStopped = false;
    this.targetEnemyPwmAcc = UNSET;
    this.targetEnemyPwmOn = false;
    this.targetEnemyPwmDwell = UNSET;
    this.targetEnemyPwmSec = "";
    this.targetEnemySampleX = UNSET;
    this.targetEnemySampleZ = UNSET;
    this.targetEnemyVx = UNSET;
    this.targetEnemyVz = UNSET;
    this.targetEnemyVy = UNSET;
    this.targetEnemySeparating = false;

    this.combatPitchMicro = UNSET;
    this.combatPitchTrack = UNSET;
    this.combatAimHeightForId = "";
    this.combatAimHeight = "";

    this.yawHumanizeVel = UNSET;
    this.yawHumanizeMicro = UNSET;
    this.yawHumanizeAimErr = UNSET;
    this.yawHumanizeOvershoot = UNSET;
    this.yawHumanizeLastDesired = UNSET;
    this.yawHumanizeLastX = UNSET;
    this.yawHumanizeLastZ = UNSET;
    this.yawHumanizeVLatRing = [];
    this.yawHumanizePhase = "";
    this.yawHumanizePlanTarget = UNSET;
    this.yawHumanizePlanAnchor = UNSET;
    this.yawHumanizeDeadband = UNSET;
    this.yawHumanizeOvershootUsed = false;
    this.lookReactionForEnemyId = "";
    this.lookReactionReadyAtTick = UNSET;
    this.lookOvershootPending = false;
    this.yawHumanizeSpawnedAtTick = UNSET;
    this.yawHumanizeServoYaw = UNSET;
    this.yawHumanizeNoiseOut = UNSET;
    this.lookPlanPitch = UNSET;
    this.aimMoveActive = false;
    this.aimMoveElapsed = UNSET;
    this.aimMoveDur = UNSET;
    this.aimMoveFromYaw = UNSET;
    this.aimMoveFromPitch = UNSET;
    this.aimMoveToYaw = UNSET;
    this.aimMoveToPitch = UNSET;
    this.aimMoveArcYaw = UNSET;
    this.aimMoveArcPitch = UNSET;
    this.aimDwell = UNSET;
    this.aimCorrections = UNSET;
    this.aimPerceivedYaw = UNSET;
    this.aimPerceivedPitch = UNSET;
    this.aimPerceivedVelYaw = UNSET;
    this.aimPerceivedVelPitch = UNSET;
    this.aimPlanTargetYaw = UNSET;
    this.aimPlanTargetPitch = UNSET;

    this.reactionForEnemyId = "";
    this.reactionReadyAtTick = UNSET;
    this.hitChanceMissUntilTick = UNSET;
    this.clickLastShotTick = UNSET;
    this.clickCadenceTicks = UNSET;
    this.clickSettleReadyAtTick = UNSET;

    this.raidStopperHasLatch = false;
    this.raidIsStopper = false;
    this.raidNextStopTick = UNSET;
    this.raidStopUntilTick = UNSET;
  }
}

export function emptyBotBrainState(): BotBrainState {
  return new BotBrainState();
}

export function copyBotBrainState(
  source: BotBrainState,
  target: BotBrainState,
): BotBrainState {
  target.huntActive = source.huntActive;
  target.huntDoorBias = source.huntDoorBias;
  target.huntDoorBiasDist = source.huntDoorBiasDist;
  target.huntLastAgentX = source.huntLastAgentX;
  target.huntLastAgentZ = source.huntLastAgentZ;
  target.huntDoorsOpen = source.huntDoorsOpen;
  target.huntDoorsSampled = source.huntDoorsSampled;
  target.doorCampActive = source.doorCampActive;
  target.doorCampPlantX = source.doorCampPlantX;
  target.doorCampPlantZ = source.doorCampPlantZ;
  target.doorCampWantLip = source.doorCampWantLip;
  target.doorCampLookIndex = source.doorCampLookIndex;
  target.doorCampViaOwn = source.doorCampViaOwn;
  target.doorCampNextSwitchAt = source.doorCampNextSwitchAt;

  target.dwellBreakKey = source.dwellBreakKey;
  target.dwellBreakSinceTick = source.dwellBreakSinceTick;
  target.dwellForceHuntUntilTick = source.dwellForceHuntUntilTick;

  target.pathStrafeDir = source.pathStrafeDir;
  target.pathStrafeTicksLeft = source.pathStrafeTicksLeft;
  target.pathStrafeFirst = source.pathStrafeFirst;

  target.halfWallVaultTicksLeft = source.halfWallVaultTicksLeft;
  target.halfWallVaultFaceYaw = source.halfWallVaultFaceYaw;
  target.halfWallVaultOption = source.halfWallVaultOption;
  target.halfWallVaultJumpHoldTicksLeft = source.halfWallVaultJumpHoldTicksLeft;
  target.halfWallVaultConsecCount = source.halfWallVaultConsecCount;
  target.halfWallVaultConsecX = source.halfWallVaultConsecX;
  target.halfWallVaultConsecZ = source.halfWallVaultConsecZ;
  target.halfWallVaultConsecTick = source.halfWallVaultConsecTick;

  target.floatWallDuckTicksLeft = source.floatWallDuckTicksLeft;
  target.floatWallDuckFaceYaw = source.floatWallDuckFaceYaw;
  target.floatWallDuckOption = source.floatWallDuckOption;
  target.floatWallDuckStartX = source.floatWallDuckStartX;
  target.floatWallDuckStartZ = source.floatWallDuckStartZ;
  target.floatWallDuckElapsed = source.floatWallDuckElapsed;
  target.floatWallDuckCooldownUntilTick = source.floatWallDuckCooldownUntilTick;

  target.stuckWLastX = source.stuckWLastX;
  target.stuckWLastZ = source.stuckWLastZ;
  target.stuckWElapsed = source.stuckWElapsed;
  target.stuckWTurnTicksLeft = source.stuckWTurnTicksLeft;
  target.stuckWTurnFaceYaw = source.stuckWTurnFaceYaw;
  target.stuckWCooldownUntilTick = source.stuckWCooldownUntilTick;

  target.stickyYawPoleX = source.stickyYawPoleX;
  target.stickyYawPoleZ = source.stickyYawPoleZ;
  target.yawPoleCommitKeys = copyStringList(source.yawPoleCommitKeys);
  target.yawPoleIgnore = copyStringMap(source.yawPoleIgnore);
  target.yawPoleNoise = copyStringMap(source.yawPoleNoise);
  target.yawPoleNoiseReady = source.yawPoleNoiseReady;
  target.yawPoleNoiseSpawnedAtTick = source.yawPoleNoiseSpawnedAtTick;

  target.cadenceNavGoalValid = source.cadenceNavGoalValid;
  target.cadenceNavGoalMode = source.cadenceNavGoalMode;
  target.cadenceNavGoalX = source.cadenceNavGoalX;
  target.cadenceNavGoalZ = source.cadenceNavGoalZ;
  target.cadenceNavGoalHasDoorDist = source.cadenceNavGoalHasDoorDist;
  target.cadenceNavGoalDoorDistX = source.cadenceNavGoalDoorDistX;
  target.cadenceNavGoalDoorDistZ = source.cadenceNavGoalDoorDistZ;
  target.cadenceNavGoalCampArrived = source.cadenceNavGoalCampArrived;
  target.cadenceNavGoalForceNoiseReroll = source.cadenceNavGoalForceNoiseReroll;

  target.cadenceYawPoleValid = source.cadenceYawPoleValid;
  target.cadenceYawPoleMode = source.cadenceYawPoleMode;
  target.cadenceYawPoleGoalX = source.cadenceYawPoleGoalX;
  target.cadenceYawPoleGoalZ = source.cadenceYawPoleGoalZ;
  target.cadenceYawPoleCampArrived = source.cadenceYawPoleCampArrived;
  target.cadenceYawPoleHasTarget = source.cadenceYawPoleHasTarget;
  target.cadenceYawPoleTargetX = source.cadenceYawPoleTargetX;
  target.cadenceYawPoleTargetZ = source.cadenceYawPoleTargetZ;
  target.cadenceYawPoleHasNext = source.cadenceYawPoleHasNext;
  target.cadenceYawPoleNextX = source.cadenceYawPoleNextX;
  target.cadenceYawPoleNextZ = source.cadenceYawPoleNextZ;

  target.smoothedDesiredYaw = source.smoothedDesiredYaw;
  target.sprintChanceLatched = source.sprintChanceLatched;
  target.sprintChanceHasLatch = source.sprintChanceHasLatch;
  target.openSprintChanceLatched = source.openSprintChanceLatched;
  target.openSprintChanceHasLatch = source.openSprintChanceHasLatch;

  target.targetEnemyId = source.targetEnemyId;
  target.targetEnemyStandGround = source.targetEnemyStandGround;
  target.targetEnemyStrafePhase = source.targetEnemyStrafePhase;
  target.targetEnemyStrafeTicksLeft = source.targetEnemyStrafeTicksLeft;
  target.targetEnemyStrafeDir = source.targetEnemyStrafeDir;
  target.targetEnemyStrafeDepth = source.targetEnemyStrafeDepth;
  target.targetEnemyStrafeDepthDuty = source.targetEnemyStrafeDepthDuty;
  target.targetEnemyStrafeStopped = source.targetEnemyStrafeStopped;
  target.targetEnemyPwmAcc = source.targetEnemyPwmAcc;
  target.targetEnemyPwmOn = source.targetEnemyPwmOn;
  target.targetEnemyPwmDwell = source.targetEnemyPwmDwell;
  target.targetEnemyPwmSec = source.targetEnemyPwmSec;
  target.targetEnemySampleX = source.targetEnemySampleX;
  target.targetEnemySampleZ = source.targetEnemySampleZ;
  target.targetEnemyVx = source.targetEnemyVx;
  target.targetEnemyVz = source.targetEnemyVz;
  target.targetEnemyVy = source.targetEnemyVy;
  target.targetEnemySeparating = source.targetEnemySeparating;

  target.combatPitchMicro = source.combatPitchMicro;
  target.combatPitchTrack = source.combatPitchTrack;
  target.combatAimHeightForId = source.combatAimHeightForId;
  target.combatAimHeight = source.combatAimHeight;

  target.yawHumanizeVel = source.yawHumanizeVel;
  target.yawHumanizeMicro = source.yawHumanizeMicro;
  target.yawHumanizeAimErr = source.yawHumanizeAimErr;
  target.yawHumanizeOvershoot = source.yawHumanizeOvershoot;
  target.yawHumanizeLastDesired = source.yawHumanizeLastDesired;
  target.yawHumanizeLastX = source.yawHumanizeLastX;
  target.yawHumanizeLastZ = source.yawHumanizeLastZ;
  target.yawHumanizeVLatRing = copyNumberList(source.yawHumanizeVLatRing);
  target.yawHumanizePhase = source.yawHumanizePhase;
  target.yawHumanizePlanTarget = source.yawHumanizePlanTarget;
  target.yawHumanizePlanAnchor = source.yawHumanizePlanAnchor;
  target.yawHumanizeDeadband = source.yawHumanizeDeadband;
  target.yawHumanizeOvershootUsed = source.yawHumanizeOvershootUsed;
  target.lookReactionForEnemyId = source.lookReactionForEnemyId;
  target.lookReactionReadyAtTick = source.lookReactionReadyAtTick;
  target.lookOvershootPending = source.lookOvershootPending;
  target.yawHumanizeSpawnedAtTick = source.yawHumanizeSpawnedAtTick;
  target.yawHumanizeServoYaw = source.yawHumanizeServoYaw;
  target.yawHumanizeNoiseOut = source.yawHumanizeNoiseOut;
  target.lookPlanPitch = source.lookPlanPitch;
  target.aimMoveActive = source.aimMoveActive;
  target.aimMoveElapsed = source.aimMoveElapsed;
  target.aimMoveDur = source.aimMoveDur;
  target.aimMoveFromYaw = source.aimMoveFromYaw;
  target.aimMoveFromPitch = source.aimMoveFromPitch;
  target.aimMoveToYaw = source.aimMoveToYaw;
  target.aimMoveToPitch = source.aimMoveToPitch;
  target.aimMoveArcYaw = source.aimMoveArcYaw;
  target.aimMoveArcPitch = source.aimMoveArcPitch;
  target.aimDwell = source.aimDwell;
  target.aimCorrections = source.aimCorrections;
  target.aimPerceivedYaw = source.aimPerceivedYaw;
  target.aimPerceivedPitch = source.aimPerceivedPitch;
  target.aimPerceivedVelYaw = source.aimPerceivedVelYaw;
  target.aimPerceivedVelPitch = source.aimPerceivedVelPitch;
  target.aimPlanTargetYaw = source.aimPlanTargetYaw;
  target.aimPlanTargetPitch = source.aimPlanTargetPitch;

  target.reactionForEnemyId = source.reactionForEnemyId;
  target.reactionReadyAtTick = source.reactionReadyAtTick;
  target.hitChanceMissUntilTick = source.hitChanceMissUntilTick;
  target.clickLastShotTick = source.clickLastShotTick;
  target.clickCadenceTicks = source.clickCadenceTicks;
  target.clickSettleReadyAtTick = source.clickSettleReadyAtTick;

  target.raidStopperHasLatch = source.raidStopperHasLatch;
  target.raidIsStopper = source.raidIsStopper;
  target.raidNextStopTick = source.raidNextStopTick;
  target.raidStopUntilTick = source.raidStopUntilTick;
  return target;
}

export function cloneBotBrainState(source: BotBrainState): BotBrainState {
  return copyBotBrainState(source, new BotBrainState());
}

export function hasDoorCampPlant(state: {
  doorCampPlantX: number;
  doorCampPlantZ: number;
}): boolean {
  return isSetNumber(state.doorCampPlantX) && isSetNumber(state.doorCampPlantZ);
}

export function hasStickyYawPole(state: {
  stickyYawPoleX: number;
  stickyYawPoleZ: number;
}): boolean {
  return isSetNumber(state.stickyYawPoleX) && isSetNumber(state.stickyYawPoleZ);
}

function takeNumber(current: number, incoming: number | undefined): number {
  if (incoming === undefined) return current;
  return Number.isFinite(incoming) ? incoming : UNSET;
}

function takeBool(current: boolean, incoming: boolean | undefined): boolean {
  if (incoming === undefined) return current;
  return incoming === true;
}

function takeString(current: string, incoming: string | undefined): string {
  if (incoming === undefined) return current;
  return incoming;
}

/** Copy known duck latches from a helper patch onto the closed bag. */
export function applyFloatWallDuckPatch(
  state: BotBrainState,
  patch: {
    floatWallDuckTicksLeft?: number;
    floatWallDuckFaceYaw?: number;
    floatWallDuckOption?: number;
    floatWallDuckStartX?: number;
    floatWallDuckStartZ?: number;
    floatWallDuckElapsed?: number;
    floatWallDuckCooldownUntilTick?: number;
  },
): void {
  state.floatWallDuckTicksLeft = takeNumber(
    state.floatWallDuckTicksLeft,
    patch.floatWallDuckTicksLeft,
  );
  state.floatWallDuckFaceYaw = takeNumber(
    state.floatWallDuckFaceYaw,
    patch.floatWallDuckFaceYaw,
  );
  state.floatWallDuckOption = takeNumber(
    state.floatWallDuckOption,
    patch.floatWallDuckOption,
  );
  state.floatWallDuckStartX = takeNumber(
    state.floatWallDuckStartX,
    patch.floatWallDuckStartX,
  );
  state.floatWallDuckStartZ = takeNumber(
    state.floatWallDuckStartZ,
    patch.floatWallDuckStartZ,
  );
  state.floatWallDuckElapsed = takeNumber(
    state.floatWallDuckElapsed,
    patch.floatWallDuckElapsed,
  );
  state.floatWallDuckCooldownUntilTick = takeNumber(
    state.floatWallDuckCooldownUntilTick,
    patch.floatWallDuckCooldownUntilTick,
  );
}

/** Copy known vault latches from a helper patch onto the closed bag. */
export function applyHalfWallVaultPatch(
  state: BotBrainState,
  patch: {
    halfWallVaultTicksLeft?: number;
    halfWallVaultFaceYaw?: number;
    halfWallVaultOption?: number;
    halfWallVaultJumpHoldTicksLeft?: number;
    halfWallVaultConsecCount?: number;
    halfWallVaultConsecX?: number;
    halfWallVaultConsecZ?: number;
    halfWallVaultConsecTick?: number;
  },
): void {
  state.halfWallVaultTicksLeft = takeNumber(
    state.halfWallVaultTicksLeft,
    patch.halfWallVaultTicksLeft,
  );
  state.halfWallVaultFaceYaw = takeNumber(
    state.halfWallVaultFaceYaw,
    patch.halfWallVaultFaceYaw,
  );
  state.halfWallVaultOption = takeNumber(
    state.halfWallVaultOption,
    patch.halfWallVaultOption,
  );
  state.halfWallVaultJumpHoldTicksLeft = takeNumber(
    state.halfWallVaultJumpHoldTicksLeft,
    patch.halfWallVaultJumpHoldTicksLeft,
  );
  state.halfWallVaultConsecCount = takeNumber(
    state.halfWallVaultConsecCount,
    patch.halfWallVaultConsecCount,
  );
  state.halfWallVaultConsecX = takeNumber(
    state.halfWallVaultConsecX,
    patch.halfWallVaultConsecX,
  );
  state.halfWallVaultConsecZ = takeNumber(
    state.halfWallVaultConsecZ,
    patch.halfWallVaultConsecZ,
  );
  state.halfWallVaultConsecTick = takeNumber(
    state.halfWallVaultConsecTick,
    patch.halfWallVaultConsecTick,
  );
}

/** Copy known stuck-W latches from a helper patch onto the closed bag. */
export function applyStuckWTurnPatch(
  state: BotBrainState,
  patch: {
    stuckWLastX?: number;
    stuckWLastZ?: number;
    stuckWElapsed?: number;
    stuckWTurnTicksLeft?: number;
    stuckWTurnFaceYaw?: number;
    stuckWCooldownUntilTick?: number;
    yawPoleIgnore?: Record<string, number>;
  },
): void {
  state.stuckWLastX = takeNumber(state.stuckWLastX, patch.stuckWLastX);
  state.stuckWLastZ = takeNumber(state.stuckWLastZ, patch.stuckWLastZ);
  state.stuckWElapsed = takeNumber(state.stuckWElapsed, patch.stuckWElapsed);
  state.stuckWTurnTicksLeft = takeNumber(
    state.stuckWTurnTicksLeft,
    patch.stuckWTurnTicksLeft,
  );
  state.stuckWTurnFaceYaw = takeNumber(
    state.stuckWTurnFaceYaw,
    patch.stuckWTurnFaceYaw,
  );
  state.stuckWCooldownUntilTick = takeNumber(
    state.stuckWCooldownUntilTick,
    patch.stuckWCooldownUntilTick,
  );
  if (patch.yawPoleIgnore !== undefined) {
    state.yawPoleIgnore = patch.yawPoleIgnore;
  }
}

/** Copy known combat-lock latches from a helper patch onto the closed bag. */
export function applyTargetEnemyPatch(
  state: BotBrainState,
  patch: {
    targetEnemyId?: string;
    targetEnemyStandGround?: boolean;
    targetEnemyStrafePhase?: string;
    targetEnemyStrafeTicksLeft?: number;
    targetEnemyStrafeDir?: string;
    targetEnemyStrafeDepth?: string;
    targetEnemyStrafeDepthDuty?: number;
    targetEnemyStrafeStopped?: boolean;
    targetEnemyPwmAcc?: number;
    targetEnemyPwmOn?: boolean;
    targetEnemyPwmDwell?: number;
    targetEnemyPwmSec?: string;
    targetEnemySampleX?: number;
    targetEnemySampleZ?: number;
    targetEnemyVx?: number;
    targetEnemyVz?: number;
    targetEnemyVy?: number;
    targetEnemySeparating?: boolean;
  },
): void {
  state.targetEnemyId = takeString(state.targetEnemyId, patch.targetEnemyId);
  state.targetEnemyStandGround = takeBool(
    state.targetEnemyStandGround,
    patch.targetEnemyStandGround,
  );
  state.targetEnemyStrafePhase = takeString(
    state.targetEnemyStrafePhase,
    patch.targetEnemyStrafePhase,
  );
  state.targetEnemyStrafeTicksLeft = takeNumber(
    state.targetEnemyStrafeTicksLeft,
    patch.targetEnemyStrafeTicksLeft,
  );
  state.targetEnemyStrafeDir = takeString(
    state.targetEnemyStrafeDir,
    patch.targetEnemyStrafeDir,
  );
  state.targetEnemyStrafeDepth = takeString(
    state.targetEnemyStrafeDepth,
    patch.targetEnemyStrafeDepth,
  );
  state.targetEnemyStrafeDepthDuty = takeNumber(
    state.targetEnemyStrafeDepthDuty,
    patch.targetEnemyStrafeDepthDuty,
  );
  state.targetEnemyStrafeStopped = takeBool(
    state.targetEnemyStrafeStopped,
    patch.targetEnemyStrafeStopped,
  );
  state.targetEnemyPwmAcc = takeNumber(
    state.targetEnemyPwmAcc,
    patch.targetEnemyPwmAcc,
  );
  state.targetEnemyPwmOn = takeBool(state.targetEnemyPwmOn, patch.targetEnemyPwmOn);
  state.targetEnemyPwmDwell = takeNumber(
    state.targetEnemyPwmDwell,
    patch.targetEnemyPwmDwell,
  );
  state.targetEnemyPwmSec = takeString(
    state.targetEnemyPwmSec,
    patch.targetEnemyPwmSec,
  );
  state.targetEnemySampleX = takeNumber(
    state.targetEnemySampleX,
    patch.targetEnemySampleX,
  );
  state.targetEnemySampleZ = takeNumber(
    state.targetEnemySampleZ,
    patch.targetEnemySampleZ,
  );
  state.targetEnemyVx = takeNumber(state.targetEnemyVx, patch.targetEnemyVx);
  state.targetEnemyVz = takeNumber(state.targetEnemyVz, patch.targetEnemyVz);
  state.targetEnemyVy = takeNumber(state.targetEnemyVy, patch.targetEnemyVy);
  state.targetEnemySeparating = takeBool(
    state.targetEnemySeparating,
    patch.targetEnemySeparating,
  );
}
