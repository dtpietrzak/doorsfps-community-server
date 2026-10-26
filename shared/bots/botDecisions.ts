/**
 * Bot brain decision switches for admin spectate debug (Y key).
 *
 * Server packs active latches into {@link SnapshotPlayer.botDec} each think;
 * the client lights dots for each bit in {@link BOT_DECISION_SWITCHES}.
 *
 * Keep bit assignments stable — clients decode by bit, not by position in the
 * label list (order of the list is display-only).
 */

/** Nav: doors open, chase enemy door along yaw-poles. */
export const BOT_DEC_PATH = 1 << 0;
/** Nav: doors closed, hunt agents / hostiles. */
export const BOT_DEC_HUNT = 1 << 1;
/** Nav: doors closed, plant at enemy door (low aggression). */
export const BOT_DEC_DOOR_CAMP = 1 << 2;
/** Door-camp: arrived at plant; look-sweep active. */
export const BOT_DEC_CAMP_PLANTED = 1 << 3;
/** Door-camp look: easing via own door (back to enemy). */
export const BOT_DEC_CAMP_VIA_OWN = 1 << 4;

/** Sticky yaw-pole target locked (blue guide). */
export const BOT_DEC_YAW_POLE = 1 << 5;
/** Path ADAD phase holding left or right. */
export const BOT_DEC_PATH_STRAFE = 1 << 6;
/** Hunt doorDist bias toward own door. */
export const BOT_DEC_HUNT_OWN = 1 << 7;
/** Hunt doorDist bias toward enemy door. */
export const BOT_DEC_HUNT_ENEMY = 1 << 8;

/** Half-wall vault commit (jump + keys). */
export const BOT_DEC_HALF_VAULT = 1 << 9;
/** Float-wall crouch-under commit. */
export const BOT_DEC_FLOAT_DUCK = 1 << 10;
/** Stuck-while-W protection turn commit. */
export const BOT_DEC_STUCK_W = 1 << 11;

/** Combat sticky lock on a hostile. */
export const BOT_DEC_TARGET_ENEMY = 1 << 12;
/** Stand-ground personality for current lock (plant / ADAD). */
export const BOT_DEC_STAND_GROUND = 1 << 13;
/** Stand-ground ADAD in active strafe phase (not pause). */
export const BOT_DEC_COMBAT_ADAD = 1 << 14;
/** Waiting for look-reaction delay before mouse starts. */
export const BOT_DEC_LOOK_REACT = 1 << 15;
/** Waiting for shoot-reaction delay before first click. */
export const BOT_DEC_SHOOT_REACT = 1 << 16;
/** Intentional miss cooldown (hitChance fail). */
export const BOT_DEC_MISS_CD = 1 << 17;
/** ReadyAction wants shoot this think. */
export const BOT_DEC_CLICK = 1 << 18;
/** Combat aim latched to head (vs torso). */
export const BOT_DEC_HEAD_AIM = 1 << 19;
/** Yaw humanize ballistic overshoot phase. */
export const BOT_DEC_YAW_BALLISTIC = 1 << 20;
/** Yaw humanize correct/settle phase. */
export const BOT_DEC_YAW_CORRECT = 1 << 21;
/** Sprint intent on ready action. */
export const BOT_DEC_SPRINT = 1 << 22;
/** Weapon switch request on ready action. */
export const BOT_DEC_WEAPON_SW = 1 << 23;
/** Reload request on ready action. */
export const BOT_DEC_RELOAD = 1 << 24;

/** One row in the spectate decision tree HUD. */
export type BotDecisionSwitch = {
  /** Bit in the packed mask. */
  bit: number;
  /** Stable id for tests / tooling. */
  id: string;
  /** Short human label shown next to the lit dot. */
  label: string;
  /** Optional group header above this row (first of group only). */
  group?: string;
};

/**
 * Display order for the Y-mode decision tree.
 * Bits that are off still render dim; on bits light the dot + label.
 */
export const BOT_DECISION_SWITCHES: readonly BotDecisionSwitch[] = [
  { bit: BOT_DEC_PATH, id: "path", label: "Path", group: "Nav mode" },
  { bit: BOT_DEC_HUNT, id: "hunt", label: "Hunt" },
  { bit: BOT_DEC_DOOR_CAMP, id: "doorCamp", label: "Door camp" },
  { bit: BOT_DEC_CAMP_PLANTED, id: "campPlanted", label: "Camp planted" },
  { bit: BOT_DEC_CAMP_VIA_OWN, id: "campViaOwn", label: "Camp via own" },

  { bit: BOT_DEC_YAW_POLE, id: "yawPole", label: "Yaw pole lock", group: "Pathing" },
  { bit: BOT_DEC_PATH_STRAFE, id: "pathStrafe", label: "Path strafe" },
  { bit: BOT_DEC_HUNT_OWN, id: "huntOwn", label: "Hunt → own door" },
  { bit: BOT_DEC_HUNT_ENEMY, id: "huntEnemy", label: "Hunt → enemy door" },

  { bit: BOT_DEC_HALF_VAULT, id: "halfVault", label: "Half-wall vault", group: "Commits" },
  { bit: BOT_DEC_FLOAT_DUCK, id: "floatDuck", label: "Float-wall duck" },
  { bit: BOT_DEC_STUCK_W, id: "stuckW", label: "Stuck W-turn" },

  { bit: BOT_DEC_TARGET_ENEMY, id: "targetEnemy", label: "Target enemy", group: "Combat" },
  { bit: BOT_DEC_STAND_GROUND, id: "standGround", label: "Stand ground" },
  { bit: BOT_DEC_COMBAT_ADAD, id: "combatAdad", label: "Combat ADAD" },
  { bit: BOT_DEC_LOOK_REACT, id: "lookReact", label: "Look reaction" },
  { bit: BOT_DEC_SHOOT_REACT, id: "shootReact", label: "Shoot reaction" },
  { bit: BOT_DEC_MISS_CD, id: "missCd", label: "Miss cooldown" },
  { bit: BOT_DEC_CLICK, id: "click", label: "Click / shoot" },
  { bit: BOT_DEC_HEAD_AIM, id: "headAim", label: "Head aim" },

  { bit: BOT_DEC_YAW_BALLISTIC, id: "yawBallistic", label: "Yaw ballistic", group: "Motors" },
  { bit: BOT_DEC_YAW_CORRECT, id: "yawCorrect", label: "Yaw correct" },
  { bit: BOT_DEC_SPRINT, id: "sprint", label: "Sprint" },
  { bit: BOT_DEC_WEAPON_SW, id: "weaponSw", label: "Weapon switch" },
  { bit: BOT_DEC_RELOAD, id: "reload", label: "Reload" },
] as const;

/** Inputs derived from brain bag + last ready action (server-only encode). */
export type BotDecisionEncodeInput = {
  /** Live sim tick (reaction / miss cooldown clocks). */
  tick: number;
  /** Brain bag after a completed think. */
  state: Record<string, unknown>;
  /** Self XZ for camp-planted check (optional). */
  selfX?: number;
  selfZ?: number;
  /** Latest completed ReadyAction (shoot / sprint / weapon / reload). */
  ready?: {
    shoot?: boolean;
    reload?: boolean;
    weapon?: number;
    input?: { sprint?: boolean } | null;
  } | null;
  /**
   * World units: plant arrival radius. Defaults to door-camp arrive eps (0.4)
   * so shared code does not import server modules.
   */
  campArriveEps?: number;
};

function num(state: Record<string, unknown>, key: string): number | undefined {
  const v = state[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function str(state: Record<string, unknown>, key: string): string | undefined {
  const v = state[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function bool(state: Record<string, unknown>, key: string): boolean {
  return state[key] === true;
}

/**
 * Pack active bot-brain switches into a bitfield for snapshots.
 * Pure — no I/O. Safe to call from BotManager after each completed think.
 */
export function encodeBotDecisions(input: BotDecisionEncodeInput): number {
  const { tick, state } = input;
  const ready = input.ready ?? null;
  let bits = 0;

  const doorCamp = bool(state, "doorCampActive");
  const hunt = bool(state, "huntActive");
  if (doorCamp) bits |= BOT_DEC_DOOR_CAMP;
  else if (hunt) bits |= BOT_DEC_HUNT;
  else bits |= BOT_DEC_PATH;

  if (doorCamp) {
    const plantX = num(state, "doorCampPlantX");
    const plantZ = num(state, "doorCampPlantZ");
    const sx = input.selfX;
    const sz = input.selfZ;
    const eps = input.campArriveEps ?? 0.4;
    if (
      plantX !== undefined &&
      plantZ !== undefined &&
      typeof sx === "number" &&
      typeof sz === "number" &&
      Number.isFinite(sx) &&
      Number.isFinite(sz)
    ) {
      const dx = sx - plantX;
      const dz = sz - plantZ;
      if (dx * dx + dz * dz <= eps * eps) bits |= BOT_DEC_CAMP_PLANTED;
    }
    if (bool(state, "doorCampViaOwn")) bits |= BOT_DEC_CAMP_VIA_OWN;
  }

  const sticky = state.stickyYawPole;
  if (
    sticky &&
    typeof sticky === "object" &&
    typeof (sticky as { x?: unknown }).x === "number" &&
    typeof (sticky as { z?: unknown }).z === "number"
  ) {
    bits |= BOT_DEC_YAW_POLE;
  }

  const strafeDir = state.pathStrafeDir;
  if (strafeDir === "left" || strafeDir === "right") {
    bits |= BOT_DEC_PATH_STRAFE;
  }

  if (hunt) {
    if (state.huntDoorBias === "own") bits |= BOT_DEC_HUNT_OWN;
    if (state.huntDoorBias === "enemy") bits |= BOT_DEC_HUNT_ENEMY;
  }

  if ((num(state, "halfWallVaultTicksLeft") ?? 0) > 0) {
    bits |= BOT_DEC_HALF_VAULT;
  }
  if ((num(state, "floatWallDuckTicksLeft") ?? 0) > 0) {
    bits |= BOT_DEC_FLOAT_DUCK;
  }
  if ((num(state, "stuckWTurnTicksLeft") ?? 0) > 0) {
    bits |= BOT_DEC_STUCK_W;
  }

  const targetId = str(state, "targetEnemyId");
  if (targetId) {
    bits |= BOT_DEC_TARGET_ENEMY;
    if (bool(state, "targetEnemyStandGround")) {
      bits |= BOT_DEC_STAND_GROUND;
      if (state.targetEnemyStrafePhase === "strafe") {
        bits |= BOT_DEC_COMBAT_ADAD;
      }
    }

    const lookReady = num(state, "lookReactionReadyAtTick");
    if (
      state.lookReactionForEnemyId === targetId &&
      lookReady !== undefined &&
      tick < lookReady
    ) {
      bits |= BOT_DEC_LOOK_REACT;
    }

    const shootReady = num(state, "reactionReadyAtTick");
    if (
      state.reactionForEnemyId === targetId &&
      shootReady !== undefined &&
      tick < shootReady
    ) {
      bits |= BOT_DEC_SHOOT_REACT;
    }

    const missUntil = num(state, "hitChanceMissUntilTick");
    if (missUntil !== undefined && tick < missUntil) {
      bits |= BOT_DEC_MISS_CD;
    }

    if (state.combatAimHeight === "head") {
      bits |= BOT_DEC_HEAD_AIM;
    }
  }

  const phase = state.yawHumanizePhase;
  if (phase === "ballistic") bits |= BOT_DEC_YAW_BALLISTIC;
  else if (phase === "correct") bits |= BOT_DEC_YAW_CORRECT;

  if (ready?.shoot) bits |= BOT_DEC_CLICK;
  if (ready?.reload) bits |= BOT_DEC_RELOAD;
  if (typeof ready?.weapon === "number") bits |= BOT_DEC_WEAPON_SW;
  if (ready?.input?.sprint) bits |= BOT_DEC_SPRINT;

  return bits;
}

/** True when the given switch bit is set. */
export function botDecisionOn(mask: number, bit: number): boolean {
  return (mask & bit) !== 0;
}
