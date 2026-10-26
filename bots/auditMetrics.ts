/**
 * Pure detectors + accumulators for offline bot audits.
 *
 * Used by scripts/simBotAudit.ts. Unit-testable with synthetic series so
 * thresholds are not magic buried only in the CLI.
 */

import { TICK_HZ } from "../protocol/network.ts";
import { DOOR_APPROACH_DIST } from "./helpers/nav.ts";

// ---------------------------------------------------------------------------
// Thresholds (exported for tests / CLI tuning)
// ---------------------------------------------------------------------------

/** Low horizontal move this tick ≈ stuck / plant. */
export const AUDIT_MOVE_EPS = 0.025;

/** Consecutive low-move ticks → stuck event (~2s). */
export const AUDIT_STUCK_TICKS = Math.round(2.0 * TICK_HZ);

/** Yaw flip magnitude (rad) counting as thrash sample. */
export const AUDIT_YAW_FLIP_MIN = 0.55;

/** Window for thrash / spin (~1s). */
export const AUDIT_WINDOW_TICKS = Math.round(1.0 * TICK_HZ);

/** Yaw flips in one window to count thrash. */
export const AUDIT_THRASH_FLIPS = 10;

/** Same-sign yaw accumulation for SPIN (≈ full turn). */
export const AUDIT_SPIN_YAW = Math.PI * 2;

/**
 * Wall-aim streak (~1.5s looking into slab while barely moving).
 * Short contact peels while circling a bar are normal; sustained face-scrub is not.
 */
export const AUDIT_WALL_AIM_TICKS = Math.round(1.5 * TICK_HZ);

/** Wall-ram: forward + solid + low move (~1.5s). */
export const AUDIT_WALL_RAM_TICKS = Math.round(1.5 * TICK_HZ);

/**
 * Door-lip band: outside capture but near approach distance.
 * Bots dancing here without entering is DOOR-DANCE.
 */
export const AUDIT_DOOR_LIP_MIN = 0.9;
export const AUDIT_DOOR_LIP_MAX = DOOR_APPROACH_DIST + 1.0;

/** Door-dance: time on lip with high yaw / low progress (~1.5s). */
export const AUDIT_DOOR_DANCE_TICKS = Math.round(1.5 * TICK_HZ);

/** Min |dyaw| on lip counting as restless look. */
export const AUDIT_DOOR_DANCE_YAW = 0.25;

/** Progress toward door (world units) that resets dance streak. */
export const AUDIT_DOOR_PROGRESS_EPS = 0.12;

/** Pair orbit: mutual distance band (body-range circle dance). */
export const AUDIT_ORBIT_DIST_MIN = 1.0;
export const AUDIT_ORBIT_DIST_MAX = 7.0;

/** Pair orbit: relative bearing change in window (rad) — ~1.1 turns. */
export const AUDIT_ORBIT_BEARING = Math.PI * 1.15;

/** Pair orbit: max COM travel in window (stay planted while spinning). */
export const AUDIT_ORBIT_COM_MAX = 2.4;

/**
 * Close contact band: body-proximity without mid-range gunfight plant.
 * Only OK if the pair is running *through* each other (pass), not lingering.
 */
export const AUDIT_CLOSE_DIST = 3.2;

/** Sustained close contact without a pass → CLOSE-LINGER (~1.15s). */
export const AUDIT_CLOSE_LINGER_TICKS = Math.round(1.15 * TICK_HZ);

/**
 * Ignore close-contact until this match tick — spawn clusters and team fill
 * put bots on top of each other for the first second; that is not a dance.
 */
export const AUDIT_CLOSE_SPAWN_GRACE_TICKS = Math.round(2.5 * TICK_HZ);

/**
 * Along-track signed projection must flip past this (world units) to count
 * as "ran past" rather than reverse/approach dance.
 */
export const AUDIT_PASS_CROSS_EPS = 0.45;

/**
 * Max pair-COM travel during a linger window. High COM travel = both sprinting
 * through the map (or past each other with physics bounce) — not a planted dance.
 */
export const AUDIT_CLOSE_COM_MAX = 2.6;

/** Min dist to door that still counts as "reached lip" for DOOR-REFUSE. */
export const AUDIT_DOOR_REFUSE_REACH = 4.0;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function wrapPi(a: number): number {
  let x = a;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return x;
}

export function yawDelta(from: number, to: number): number {
  return wrapPi(to - from);
}

// ---------------------------------------------------------------------------
// Per-bot rolling state
// ---------------------------------------------------------------------------

export type BotAuditCounters = {
  id: string;
  name: string;
  team: string;
  brainId: string;

  ticksAlive: number;
  sprintTicks: number;
  crouchTicks: number;
  slideTicks: number;
  slideStarts: number;
  shotsResolved: number;
  /** Enemy damage events landed (team-hit mirror excluded). */
  hitsLanded: number;
  damageDealt: number;
  kills: number;
  deaths: number;
  scores: number;

  minDoorDist: number;
  maxDoorProgress: number;
  initialDoorDist: number;
  enteredEnemyDoor: boolean;
  ticksOnDoorLip: number;
  ticksInEnemyHalf: number;
  ticksInOwnHalf: number;

  maxStuckStreak: number;
  stuckEvents: number;
  thrashEvents: number;
  spinEvents: number;
  wallAimEvents: number;
  wallRamEvents: number;
  doorDanceEvents: number;

  /** Sample positions for issues. */
  samples: IssueSample[];
};

export type IssueSample = {
  code: string;
  tick: number;
  x: number;
  z: number;
  detail?: string;
};

export type BotAuditLive = {
  counters: BotAuditCounters;
  lastX: number;
  lastZ: number;
  lastYaw: number;
  lastSliding: boolean;
  lowMoveStreak: number;
  wallAimStreak: number;
  wallRamStreak: number;
  doorDanceStreak: number;
  lastDoorDist: number;
  // thrash / spin window
  windowTick: number;
  yawFlipsInWindow: number;
  signedYawAccum: number;
  // orbit helpers filled by pair pass
  x: number;
  z: number;
  alive: boolean;
};

export function createBotAuditLive(
  id: string,
  name: string,
  team: string,
  brainId: string,
  x: number,
  z: number,
  yaw: number,
  initialDoorDist: number,
): BotAuditLive {
  return {
    counters: {
      id,
      name,
      team,
      brainId,
      ticksAlive: 0,
      sprintTicks: 0,
      crouchTicks: 0,
      slideTicks: 0,
      slideStarts: 0,
      shotsResolved: 0,
      hitsLanded: 0,
      damageDealt: 0,
      kills: 0,
      deaths: 0,
      scores: 0,
      minDoorDist: initialDoorDist,
      maxDoorProgress: 0,
      initialDoorDist,
      enteredEnemyDoor: false,
      ticksOnDoorLip: 0,
      ticksInEnemyHalf: 0,
      ticksInOwnHalf: 0,
      maxStuckStreak: 0,
      stuckEvents: 0,
      thrashEvents: 0,
      spinEvents: 0,
      wallAimEvents: 0,
      wallRamEvents: 0,
      doorDanceEvents: 0,
      samples: [],
    },
    lastX: x,
    lastZ: z,
    lastYaw: yaw,
    lastSliding: false,
    lowMoveStreak: 0,
    wallAimStreak: 0,
    wallRamStreak: 0,
    doorDanceStreak: 0,
    lastDoorDist: initialDoorDist,
    windowTick: 0,
    yawFlipsInWindow: 0,
    signedYawAccum: 0,
    x,
    z,
    alive: true,
  };
}

function pushSample(
  c: BotAuditCounters,
  code: string,
  tick: number,
  x: number,
  z: number,
  detail?: string,
  max = 8,
): void {
  if (c.samples.filter((s) => s.code === code).length >= max) return;
  c.samples.push({ code, tick, x, z, detail });
}

export type TickAuditInput = {
  tick: number;
  x: number;
  z: number;
  yaw: number;
  alive: boolean;
  onGround: boolean;
  crouch: boolean;
  sliding: boolean;
  /** Applied sprint intent this tick (from last applied ReadyAction or stamina). */
  sprint: boolean;
  /** Forward key / intent (approx: moving toward yaw or brain forward). */
  forwardIntent: boolean;
  /** Full wall contact look (isLookIntoFullWall). */
  lookIntoWall: boolean;
  /** Solid / blocked immediately ahead of move yaw. */
  wallAhead: boolean;
  doorDist: number;
  inEnemyDoorZone: boolean;
  doorsOpen: boolean;
  /** Intentional still (camp / look / spawn grace). */
  intentionalHold: boolean;
  inOwnHalf: boolean;
  score: number;
  kills: number;
  shotsThisTick: number;
  hitsThisTick?: number;
  damageThisTick?: number;
};

/**
 * Advance one bot's audit state for a sim tick.
 * Call only when tracking this bot; handles death reset of streaks.
 */
export function advanceBotAudit(
  live: BotAuditLive,
  input: TickAuditInput,
): void {
  const c = live.counters;
  live.x = input.x;
  live.z = input.z;
  live.alive = input.alive;

  if (!input.alive) {
    live.lowMoveStreak = 0;
    live.wallAimStreak = 0;
    live.wallRamStreak = 0;
    live.doorDanceStreak = 0;
    live.windowTick = 0;
    live.yawFlipsInWindow = 0;
    live.signedYawAccum = 0;
    live.lastX = input.x;
    live.lastZ = input.z;
    live.lastYaw = input.yaw;
    live.lastSliding = false;
    return;
  }

  c.ticksAlive += 1;
  c.scores = input.score;
  c.kills = input.kills;
  c.shotsResolved += input.shotsThisTick;
  c.hitsLanded += input.hitsThisTick ?? 0;
  c.damageDealt += input.damageThisTick ?? 0;

  if (input.sprint) c.sprintTicks += 1;
  if (input.crouch) c.crouchTicks += 1;
  if (input.sliding) {
    c.slideTicks += 1;
    if (!live.lastSliding) c.slideStarts += 1;
  }
  live.lastSliding = input.sliding;

  c.minDoorDist = Math.min(c.minDoorDist, input.doorDist);
  if (c.initialDoorDist > 1) {
    const prog = 1 - input.doorDist / c.initialDoorDist;
    c.maxDoorProgress = Math.max(c.maxDoorProgress, prog);
  }
  if (input.inEnemyDoorZone) c.enteredEnemyDoor = true;
  if (input.inOwnHalf) c.ticksInOwnHalf += 1;
  else c.ticksInEnemyHalf += 1;

  const moved = Math.hypot(input.x - live.lastX, input.z - live.lastZ);
  const dyaw = yawDelta(live.lastYaw, input.yaw);

  // --- stuck ---
  if (
    input.onGround && !input.intentionalHold && !input.inEnemyDoorZone &&
    moved < AUDIT_MOVE_EPS
  ) {
    live.lowMoveStreak += 1;
    c.maxStuckStreak = Math.max(c.maxStuckStreak, live.lowMoveStreak);
    if (live.lowMoveStreak === AUDIT_STUCK_TICKS) {
      c.stuckEvents += 1;
      pushSample(c, "STUCK", input.tick, input.x, input.z);
    }
  } else {
    live.lowMoveStreak = 0;
  }

  // --- wall aim (face-scrub): look into full wall + little progress ---
  if (
    input.lookIntoWall && !input.intentionalHold && !input.inEnemyDoorZone &&
    moved < AUDIT_MOVE_EPS * 3
  ) {
    live.wallAimStreak += 1;
    if (live.wallAimStreak === AUDIT_WALL_AIM_TICKS) {
      c.wallAimEvents += 1;
      pushSample(
        c,
        "WALL-AIM",
        input.tick,
        input.x,
        input.z,
        `yaw=${input.yaw.toFixed(2)}`,
      );
    }
  } else {
    live.wallAimStreak = 0;
  }

  // --- wall ram ---
  if (
    input.forwardIntent && input.wallAhead && moved < AUDIT_MOVE_EPS &&
    !input.intentionalHold && !input.inEnemyDoorZone
  ) {
    live.wallRamStreak += 1;
    if (live.wallRamStreak === AUDIT_WALL_RAM_TICKS) {
      c.wallRamEvents += 1;
      pushSample(c, "WALL-RAM", input.tick, input.x, input.z);
    }
  } else {
    live.wallRamStreak = 0;
  }

  // --- door dance (lip only, doors open, never entered capture) ---
  // Once a bot has been inside the zone, lip wiggles while scoring/respawning
  // are not refuse dances.
  const onLip = input.doorsOpen &&
    !input.inEnemyDoorZone &&
    !c.enteredEnemyDoor &&
    input.doorDist >= AUDIT_DOOR_LIP_MIN &&
    input.doorDist <= AUDIT_DOOR_LIP_MAX;

  if (onLip) {
    c.ticksOnDoorLip += 1;
    const progressed =
      live.lastDoorDist - input.doorDist >= AUDIT_DOOR_PROGRESS_EPS;
    const restless = Math.abs(dyaw) >= AUDIT_DOOR_DANCE_YAW ||
      (moved < AUDIT_MOVE_EPS * 2 && !progressed);
    if (restless && !progressed) {
      live.doorDanceStreak += 1;
      if (live.doorDanceStreak === AUDIT_DOOR_DANCE_TICKS) {
        c.doorDanceEvents += 1;
        pushSample(
          c,
          "DOOR-DANCE",
          input.tick,
          input.x,
          input.z,
          `doorDist=${input.doorDist.toFixed(2)}`,
        );
      }
    } else {
      live.doorDanceStreak = 0;
    }
  } else {
    live.doorDanceStreak = 0;
  }

  // --- thrash / spin windows ---
  if (Math.abs(dyaw) > AUDIT_YAW_FLIP_MIN && moved < 0.05) {
    live.yawFlipsInWindow += 1;
  }
  if (moved < AUDIT_MOVE_EPS * 2) {
    live.signedYawAccum += dyaw;
  } else {
    live.signedYawAccum = 0;
  }
  live.windowTick += 1;
  if (live.windowTick >= AUDIT_WINDOW_TICKS) {
    if (live.yawFlipsInWindow >= AUDIT_THRASH_FLIPS && !input.intentionalHold) {
      c.thrashEvents += 1;
      pushSample(c, "THRASH", input.tick, input.x, input.z);
    }
    if (
      Math.abs(live.signedYawAccum) >= AUDIT_SPIN_YAW && !input.intentionalHold
    ) {
      c.spinEvents += 1;
      pushSample(c, "SPIN", input.tick, input.x, input.z);
    }
    live.yawFlipsInWindow = 0;
    live.signedYawAccum = 0;
    live.windowTick = 0;
  }

  live.lastX = input.x;
  live.lastZ = input.z;
  live.lastYaw = input.yaw;
  live.lastDoorDist = input.doorDist;
}

// ---------------------------------------------------------------------------
// Pair orbit (circle-dance)
// ---------------------------------------------------------------------------

export type OrbitPairSample = {
  aId: string;
  bId: string;
  tick: number;
  x: number;
  z: number;
};

export type OrbitPairState = {
  bearingAccum: number;
  lastBearing: number | null;
  lastComX: number;
  lastComZ: number;
  comTravel: number;
  windowTick: number;
  events: number;
};

/**
 * Track relative orbit between two bots. Returns true when a new ORBIT event fires.
 * Classic pair-orbit: relative bearing sweeps while the pair COM barely travels.
 */
export function advanceOrbitPair(
  state: OrbitPairState,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): boolean {
  const dist = Math.hypot(ax - bx, az - bz);
  if (dist < AUDIT_ORBIT_DIST_MIN || dist > AUDIT_ORBIT_DIST_MAX) {
    state.windowTick = 0;
    state.bearingAccum = 0;
    state.comTravel = 0;
    state.lastBearing = null;
    return false;
  }
  const bearing = Math.atan2(bx - ax, bz - az);
  const comX = (ax + bx) / 2;
  const comZ = (az + bz) / 2;
  if (state.lastBearing !== null) {
    state.bearingAccum += Math.abs(yawDelta(state.lastBearing, bearing));
    state.comTravel += Math.hypot(comX - state.lastComX, comZ - state.lastComZ);
  }
  state.lastBearing = bearing;
  state.lastComX = comX;
  state.lastComZ = comZ;
  state.windowTick += 1;
  if (state.windowTick >= AUDIT_WINDOW_TICKS) {
    const fire = state.bearingAccum >= AUDIT_ORBIT_BEARING &&
      state.comTravel <= AUDIT_ORBIT_COM_MAX;
    state.windowTick = 0;
    state.bearingAccum = 0;
    state.comTravel = 0;
    if (fire) {
      state.events += 1;
      return true;
    }
  }
  return false;
}

export function createOrbitPairState(): OrbitPairState {
  return {
    bearingAccum: 0,
    lastBearing: null,
    lastComX: 0,
    lastComZ: 0,
    comTravel: 0,
    windowTick: 0,
    events: 0,
  };
}

// ---------------------------------------------------------------------------
// Close contact without running past (body-stack / reverse-dance)
// ---------------------------------------------------------------------------

export type CloseContactPairState = {
  inContact: boolean;
  contactTicks: number;
  passed: boolean;
  /** Along-track axis for A at contact start (unit xz). */
  axisAx: number;
  axisAz: number;
  /** Along-track axis for B at contact start. */
  axisBx: number;
  axisBz: number;
  /** Signed projection of (B−A)·axisA at contact start. */
  sA0: number;
  /** Signed projection of (A−B)·axisB at contact start. */
  sB0: number;
  lastAx: number;
  lastAz: number;
  lastBx: number;
  lastBz: number;
  lastComX: number;
  lastComZ: number;
  comTravel: number;
  hasLast: boolean;
  events: number;
  /** Cooldown so one linger doesn't multi-fire every tick. */
  cooldownTicks: number;
};

export function createCloseContactPairState(): CloseContactPairState {
  return {
    inContact: false,
    contactTicks: 0,
    passed: false,
    axisAx: 0,
    axisAz: 1,
    axisBx: 0,
    axisBz: 1,
    sA0: 0,
    sB0: 0,
    lastAx: 0,
    lastAz: 0,
    lastBx: 0,
    lastBz: 0,
    lastComX: 0,
    lastComZ: 0,
    comTravel: 0,
    hasLast: false,
    events: 0,
    cooldownTicks: 0,
  };
}

function unitOrForward(dx: number, dz: number): { x: number; z: number } {
  const len = Math.hypot(dx, dz);
  if (len < 1e-4) return { x: 0, z: 1 };
  return { x: dx / len, z: dz / len };
}

/**
 * Track two entities getting body-close. Returns true on a new CLOSE-LINGER
 * event: stayed inside {@link AUDIT_CLOSE_DIST} for linger ticks without a
 * clear run-past (projection sign flip along travel axis).
 *
 * Running *through* each other is allowed — only lingering / reverse-dancing
 * at body range is flagged.
 *
 * @param tick  Optional sim tick; contact is ignored during spawn grace.
 */
export function advanceCloseContactPair(
  state: CloseContactPairState,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  tick = AUDIT_CLOSE_SPAWN_GRACE_TICKS,
): boolean {
  if (state.cooldownTicks > 0) state.cooldownTicks -= 1;

  // Spawn / fill grace: do not accumulate contact while teams unpack.
  if (tick < AUDIT_CLOSE_SPAWN_GRACE_TICKS) {
    state.inContact = false;
    state.contactTicks = 0;
    state.lastAx = ax;
    state.lastAz = az;
    state.lastBx = bx;
    state.lastBz = bz;
    state.hasLast = true;
    return false;
  }

  const dist = Math.hypot(ax - bx, az - bz);
  const dAx = state.hasLast ? ax - state.lastAx : 0;
  const dAz = state.hasLast ? az - state.lastAz : 0;
  const dBx = state.hasLast ? bx - state.lastBx : 0;
  const dBz = state.hasLast ? bz - state.lastBz : 0;

  let fired = false;

  const comX = (ax + bx) / 2;
  const comZ = (az + bz) / 2;

  if (dist <= AUDIT_CLOSE_DIST) {
    if (!state.inContact) {
      state.inContact = true;
      state.contactTicks = 0;
      state.passed = false;
      state.comTravel = 0;
      state.lastComX = comX;
      state.lastComZ = comZ;
      // Prefer live velocity; fall back to line through the other body.
      const aMove = unitOrForward(
        Math.hypot(dAx, dAz) > 0.01 ? dAx : (bx - ax),
        Math.hypot(dAx, dAz) > 0.01 ? dAz : (bz - az),
      );
      const bMove = unitOrForward(
        Math.hypot(dBx, dBz) > 0.01 ? dBx : (ax - bx),
        Math.hypot(dBx, dBz) > 0.01 ? dBz : (az - bz),
      );
      state.axisAx = aMove.x;
      state.axisAz = aMove.z;
      state.axisBx = bMove.x;
      state.axisBz = bMove.z;
      state.sA0 = (bx - ax) * state.axisAx + (bz - az) * state.axisAz;
      state.sB0 = (ax - bx) * state.axisBx + (az - bz) * state.axisBz;
    } else {
      state.comTravel += Math.hypot(
        comX - state.lastComX,
        comZ - state.lastComZ,
      );
      state.lastComX = comX;
      state.lastComZ = comZ;
    }
    state.contactTicks += 1;

    // Pass check: either entity crossed through the other along their entry axis.
    const sA = (bx - ax) * state.axisAx + (bz - az) * state.axisAz;
    const sB = (ax - bx) * state.axisBx + (az - bz) * state.axisBz;
    if (
      (state.sA0 > AUDIT_PASS_CROSS_EPS && sA < -AUDIT_PASS_CROSS_EPS) ||
      (state.sA0 < -AUDIT_PASS_CROSS_EPS && sA > AUDIT_PASS_CROSS_EPS) ||
      (state.sB0 > AUDIT_PASS_CROSS_EPS && sB < -AUDIT_PASS_CROSS_EPS) ||
      (state.sB0 < -AUDIT_PASS_CROSS_EPS && sB > AUDIT_PASS_CROSS_EPS)
    ) {
      state.passed = true;
    }
    // Soft pass: pair COM traveled far while close → running a lane together /
    // bounce-through, not a planted face-to-face dance.
    if (state.comTravel >= AUDIT_CLOSE_COM_MAX * 1.35) {
      state.passed = true;
    }

    const planted = state.comTravel <= AUDIT_CLOSE_COM_MAX;
    if (
      !state.passed &&
      planted &&
      state.contactTicks === AUDIT_CLOSE_LINGER_TICKS &&
      state.cooldownTicks === 0
    ) {
      state.events += 1;
      state.cooldownTicks = AUDIT_CLOSE_LINGER_TICKS;
      fired = true;
    }
  } else if (state.inContact) {
    // Left close band without a pass after a long planted contact — also a linger.
    const planted = state.comTravel <= AUDIT_CLOSE_COM_MAX;
    if (
      !state.passed &&
      planted &&
      state.contactTicks >= AUDIT_CLOSE_LINGER_TICKS &&
      state.cooldownTicks === 0
    ) {
      state.events += 1;
      state.cooldownTicks = AUDIT_CLOSE_LINGER_TICKS;
      fired = true;
    }
    // Keep `passed` sticky until the next contact starts so tests/callers can
    // observe a completed run-through after the pair separates.
    state.inContact = false;
    state.contactTicks = 0;
    state.comTravel = 0;
  }

  state.lastAx = ax;
  state.lastAz = az;
  state.lastBx = bx;
  state.lastBz = bz;
  state.hasLast = true;
  return fired;
}

// ---------------------------------------------------------------------------
// Issue aggregation
// ---------------------------------------------------------------------------

export type AuditIssue = {
  code: string;
  severity: "high" | "med" | "low";
  botId?: string;
  botName?: string;
  team?: string;
  msg: string;
  x?: number;
  z?: number;
};

export type ScenarioIssueOpts = {
  /** team-match | door-rush | agent-hunt | balance-fill */
  scenario: string;
  seconds: number;
  teamScores: { A: number; B: number };
  /** Skip NO-SPRINT for balance brain. */
  isBalance?: boolean;
  /** Skip door scoring expectations (agents). */
  ignoreDoors?: boolean;
};

export function issuesFromBot(
  c: BotAuditCounters,
  opts: ScenarioIssueOpts,
): AuditIssue[] {
  const out: AuditIssue[] = [];
  const tag = (
    code: string,
    severity: AuditIssue["severity"],
    msg: string,
    s?: IssueSample,
  ): AuditIssue => ({
    code,
    severity,
    botId: c.id,
    botName: c.name,
    team: c.team,
    msg: `${c.name}/${c.team}: ${msg}`,
    x: s?.x,
    z: s?.z,
  });

  // Brief combat plants / corner peeks are normal; chronic freezes are not.
  // High: multi-event freeze OR one very long freeze (8s+).
  if (
    (c.stuckEvents >= 3 && c.maxStuckStreak >= Math.round(4 * TICK_HZ)) ||
    c.maxStuckStreak >= Math.round(8 * TICK_HZ)
  ) {
    const s = c.samples.find((x) => x.code === "STUCK");
    out.push(tag(
      "STUCK",
      "high",
      `${c.stuckEvents} stuck events, maxStreak=${c.maxStuckStreak}`,
      s,
    ));
  } else if (
    c.stuckEvents >= 2 ||
    c.maxStuckStreak >= Math.round(4 * TICK_HZ)
  ) {
    const s = c.samples.find((x) => x.code === "STUCK");
    out.push(tag("STUCK", "med", `maxStreak=${c.maxStuckStreak}`, s));
  }

  if (c.thrashEvents >= 5) {
    out.push(
      tag(
        "THRASH",
        "high",
        `${c.thrashEvents} thrash windows`,
        c.samples.find((x) => x.code === "THRASH"),
      ),
    );
  } else if (c.thrashEvents >= 3) {
    out.push(
      tag(
        "THRASH",
        "med",
        `${c.thrashEvents} thrash windows`,
        c.samples.find((x) => x.code === "THRASH"),
      ),
    );
  }
  if (c.spinEvents >= 3) {
    out.push(
      tag(
        "SPIN",
        "high",
        `${c.spinEvents} spin windows`,
        c.samples.find((x) => x.code === "SPIN"),
      ),
    );
  } else if (c.spinEvents >= 2) {
    out.push(
      tag(
        "SPIN",
        "med",
        `${c.spinEvents} spin windows`,
        c.samples.find((x) => x.code === "SPIN"),
      ),
    );
  }
  // Brief contact peels while sliding bars are normal; sustained scrub is bad.
  if (c.wallAimEvents >= 3) {
    out.push(tag(
      "WALL-AIM",
      "high",
      `${c.wallAimEvents} look-into-wall streaks`,
      c.samples.find((x) => x.code === "WALL-AIM"),
    ));
  } else if (c.wallAimEvents >= 2) {
    out.push(tag(
      "WALL-AIM",
      "med",
      `${c.wallAimEvents} look-into-wall streaks`,
      c.samples.find((x) => x.code === "WALL-AIM"),
    ));
  }
  if (c.wallRamEvents >= 3) {
    out.push(tag(
      "WALL-RAM",
      "high",
      `${c.wallRamEvents} wall-ram streaks`,
      c.samples.find((x) => x.code === "WALL-RAM"),
    ));
  } else if (c.wallRamEvents >= 2) {
    out.push(tag(
      "WALL-RAM",
      "med",
      `${c.wallRamEvents} wall-ram streaks`,
      c.samples.find((x) => x.code === "WALL-RAM"),
    ));
  }
  // Only flag if they never entered / scored — dances while lining up a score
  // that eventually succeed are noise (Crossroads lip → capture).
  if (
    c.doorDanceEvents >= 1 &&
    !c.enteredEnemyDoor &&
    c.scores === 0
  ) {
    out.push(tag(
      "DOOR-DANCE",
      "high",
      `${c.doorDanceEvents} door-lip dances (minDoor=${
        c.minDoorDist.toFixed(1)
      }, entered=${c.enteredEnemyDoor})`,
      c.samples.find((x) => x.code === "DOOR-DANCE"),
    ));
  }

  // Door refuse: got close, never entered, never scored.
  // Skip when progress was excellent but doors were closed on arrival (minDist
  // can be ~2–3 without zone enter if capture radius is tight).
  if (
    !opts.ignoreDoors &&
    opts.scenario !== "agent-hunt" &&
    c.ticksAlive > TICK_HZ * 12 &&
    c.minDoorDist <= AUDIT_DOOR_REFUSE_REACH &&
    c.minDoorDist > 1.2 &&
    !c.enteredEnemyDoor &&
    c.scores === 0 &&
    c.ticksOnDoorLip >= Math.round(0.8 * TICK_HZ)
  ) {
    out.push(tag(
      "DOOR-REFUSE",
      "high",
      `minDoor=${
        c.minDoorDist.toFixed(1)
      } never entered capture, score=0, lipTicks=${c.ticksOnDoorLip}`,
    ));
  }

  // Mobility / combat expectations (team + door-rush)
  if (
    opts.scenario === "team-match" || opts.scenario === "door-rush" ||
    opts.scenario === "agent-hunt"
  ) {
    if (
      c.ticksAlive > TICK_HZ * 15 &&
      c.shotsResolved === 0 &&
      opts.scenario !== "door-rush"
    ) {
      // Soft: may never see LOS in pure rush; flag only in combat scenarios
      out.push(
        tag(
          "NO-SHOOT",
          "med",
          `0 shots in ${(c.ticksAlive / TICK_HZ).toFixed(0)}s alive`,
        ),
      );
    }
    if (
      !opts.isBalance &&
      opts.scenario === "team-match" &&
      c.ticksAlive > TICK_HZ * 20 &&
      c.sprintTicks === 0 &&
      (c.brainId === "hard" || c.brainId === "medium" ||
        c.brainId.includes("hard") ||
        c.brainId.includes("medium") || c.brainId === "seek-door")
    ) {
      out.push(tag("NO-SPRINT", "med", `0 sprint ticks`));
    }
    if (
      opts.scenario === "team-match" &&
      c.ticksAlive > TICK_HZ * 25 &&
      c.slideStarts === 0 &&
      (c.brainId === "hard" || c.brainId === "medium" ||
        c.brainId.includes("hard") ||
        c.brainId.includes("medium"))
    ) {
      out.push(tag("NO-SLIDE", "med", `0 crouch-slides`));
    }
  }

  // Door-rush: must score or enter / get very close.
  // High only when clearly stuck mid-map; near-miss (prog 70%+, minDoor < 8)
  // is med so a long fight / closed-door wait doesn't FAIL the scenario alone.
  if (opts.scenario === "door-rush") {
    if (c.scores === 0 && !c.enteredEnemyDoor && c.minDoorDist > 3) {
      const nearMiss = c.minDoorDist < 8 && c.maxDoorProgress >= 0.65;
      out.push(tag(
        "NO-DOOR",
        nearMiss ? "med" : "high",
        `scored=0 entered=${c.enteredEnemyDoor} minDoor=${
          c.minDoorDist.toFixed(1)
        } prog=${(c.maxDoorProgress * 100).toFixed(0)}%`,
      ));
    }
  }

  // No progress own half
  const ownFrac = c.ticksAlive > 0 ? c.ticksInOwnHalf / c.ticksAlive : 1;
  if (
    !opts.ignoreDoors &&
    opts.scenario === "team-match" &&
    c.ticksAlive > TICK_HZ * 20 &&
    ownFrac > 0.95 &&
    c.maxDoorProgress < 0.15 &&
    c.scores === 0 &&
    c.stuckEvents > 0
  ) {
    out.push(tag(
      "NO-PROGRESS",
      "med",
      `${(ownFrac * 100).toFixed(0)}% own half, doorProg=${
        (c.maxDoorProgress * 100).toFixed(0)
      }%`,
    ));
  }

  return out;
}

export function teamLevelIssues(
  bots: BotAuditCounters[],
  opts: ScenarioIssueOpts,
): AuditIssue[] {
  const out: AuditIssue[] = [];
  // 40s hard camp can legitimately go scoreless once; flag sustained drought.
  if (
    !opts.ignoreDoors &&
    opts.scenario === "team-match" &&
    opts.seconds >= 35 &&
    opts.teamScores.A + opts.teamScores.B === 0
  ) {
    out.push({
      code: "NO-SCORES",
      severity: opts.seconds >= 50 ? "high" : "med",
      msg: `neither team scored in ${opts.seconds}s (A=0 B=0)`,
    });
  }
  // Require repeated stuck events so one 2s plant mid-fight doesn't fail the map.
  const stuckBots = bots.filter((b) => b.stuckEvents >= 2).length;
  if (bots.length >= 4 && stuckBots >= Math.ceil(bots.length / 2)) {
    out.push({
      code: "MAP-WIDE-STUCK",
      severity: "high",
      msg: `${stuckBots}/${bots.length} bots had repeated stuck events`,
    });
  }
  return out;
}

export function scenarioFailed(issues: AuditIssue[]): boolean {
  // High = real bug. Med needs a pile of signals so combat noise doesn't FAIL.
  return issues.some((i) => i.severity === "high") ||
    issues.filter((i) => i.severity === "med").length >= 6;
}
