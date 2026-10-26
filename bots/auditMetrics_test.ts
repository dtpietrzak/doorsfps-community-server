import { assert, assertEquals } from "@std/assert";
import {
  advanceBotAudit,
  advanceCloseContactPair,
  advanceOrbitPair,
  AUDIT_CLOSE_DIST,
  AUDIT_CLOSE_LINGER_TICKS,
  AUDIT_DOOR_DANCE_TICKS,
  AUDIT_SPIN_YAW,
  AUDIT_STUCK_TICKS,
  AUDIT_WALL_AIM_TICKS,
  AUDIT_WINDOW_TICKS,
  createBotAuditLive,
  createCloseContactPairState,
  createOrbitPairState,
  issuesFromBot,
  wrapPi,
  yawDelta,
} from "./auditMetrics.ts";

function baseInput(over: Partial<Parameters<typeof advanceBotAudit>[1]> = {}) {
  return {
    tick: 0,
    x: 0,
    z: 0,
    yaw: 0,
    alive: true,
    onGround: true,
    crouch: false,
    sliding: false,
    sprint: false,
    forwardIntent: true,
    lookIntoWall: false,
    wallAhead: false,
    doorDist: 20,
    inEnemyDoorZone: false,
    doorsOpen: true,
    intentionalHold: false,
    inOwnHalf: true,
    score: 0,
    kills: 0,
    shotsThisTick: 0,
    ...over,
  };
}

Deno.test("yawDelta wraps across ±π", () => {
  assertEquals(Math.abs(yawDelta(3, -3)) < 1, true);
  assertEquals(wrapPi(Math.PI + 0.1) < 0, true);
});

Deno.test("stuck detector fires after AUDIT_STUCK_TICKS low-move", () => {
  const live = createBotAuditLive("b1", "bot1", "A", "hard", 0, 0, 0, 30);
  for (let t = 0; t < AUDIT_STUCK_TICKS; t++) {
    advanceBotAudit(live, baseInput({ tick: t, x: 0.001, z: 0.001 }));
  }
  assertEquals(live.counters.stuckEvents, 1);
  assertEquals(live.counters.maxStuckStreak >= AUDIT_STUCK_TICKS, true);
});

Deno.test("wall-aim detector fires on sustained lookIntoWall while still", () => {
  const live = createBotAuditLive("b1", "bot1", "A", "hard", 0, 0, 0, 30);
  for (let t = 0; t < AUDIT_WALL_AIM_TICKS; t++) {
    advanceBotAudit(
      live,
      baseInput({
        tick: t,
        x: 0.001,
        z: 0.001,
        lookIntoWall: true,
        forwardIntent: true,
      }),
    );
  }
  assertEquals(live.counters.wallAimEvents, 1);
});

Deno.test("door-dance fires on lip with restless yaw and no progress", () => {
  const live = createBotAuditLive("b1", "bot1", "A", "seek-door", 0, 2, 0, 2.0);
  // Sit on lip: constant doorDist, large yaw steps, tiny position noise
  for (let t = 0; t < AUDIT_DOOR_DANCE_TICKS + 2; t++) {
    advanceBotAudit(
      live,
      baseInput({
        tick: t,
        x: Math.sin(t * 0.4) * 0.01,
        z: 2.0,
        yaw: t * 0.5,
        doorDist: 2.0,
        doorsOpen: true,
        inEnemyDoorZone: false,
      }),
    );
  }
  assertEquals(live.counters.doorDanceEvents >= 1, true);
});

Deno.test("door-dance does not fire when entering capture", () => {
  const live = createBotAuditLive("b1", "bot1", "A", "seek-door", 0, 2, 0, 30);
  for (let t = 0; t < AUDIT_DOOR_DANCE_TICKS; t++) {
    advanceBotAudit(
      live,
      baseInput({
        tick: t,
        x: 0,
        z: 0.5,
        doorDist: 0.5,
        inEnemyDoorZone: true,
        doorsOpen: true,
      }),
    );
  }
  assertEquals(live.counters.doorDanceEvents, 0);
  assertEquals(live.counters.enteredEnemyDoor, true);
});

Deno.test("spin detector accumulates same-sign yaw while still", () => {
  const live = createBotAuditLive("b1", "bot1", "A", "hard", 0, 0, 0, 30);
  const step = AUDIT_SPIN_YAW / (AUDIT_WINDOW_TICKS - 1);
  for (let t = 0; t < AUDIT_WINDOW_TICKS; t++) {
    advanceBotAudit(
      live,
      baseInput({
        tick: t,
        yaw: t * step,
        x: 0,
        z: 0,
      }),
    );
  }
  assertEquals(live.counters.spinEvents >= 1, true);
});

Deno.test("orbit pair fires when bots circle with low COM travel", () => {
  const st = createOrbitPairState();
  let fired = false;
  const r = 2.5;
  for (let t = 0; t < AUDIT_WINDOW_TICKS; t++) {
    const a = (t / AUDIT_WINDOW_TICKS) * Math.PI * 2;
    const ax = Math.sin(a) * r;
    const az = Math.cos(a) * r;
    const bx = Math.sin(a + Math.PI) * r;
    const bz = Math.cos(a + Math.PI) * r;
    if (advanceOrbitPair(st, ax, az, bx, bz)) fired = true;
  }
  assert(fired, "expected orbit event");
});

Deno.test("orbit pair does not fire when pair translates together (run past lane)", () => {
  const st = createOrbitPairState();
  let fired = false;
  // Side-by-side sprint: relative bearing fixed, COM travels far.
  for (let t = 0; t < AUDIT_WINDOW_TICKS; t++) {
    const z = t * 0.35;
    if (advanceOrbitPair(st, -1.5, z, 1.5, z)) fired = true;
  }
  assertEquals(fired, false);
});

Deno.test("close-linger fires when bots stay body-close without passing", () => {
  const st = createCloseContactPairState();
  let fired = false;
  // Face each other and reverse-dance in place (tiny noise, no cross).
  for (let t = 0; t < AUDIT_CLOSE_LINGER_TICKS + 5; t++) {
    const ax = Math.sin(t * 0.3) * 0.05;
    const az = 0;
    const bx = Math.sin(t * 0.3 + 1) * 0.05;
    const bz = AUDIT_CLOSE_DIST * 0.55; // ~1.76m apart
    if (advanceCloseContactPair(st, ax, az, bx, bz)) fired = true;
  }
  assert(fired, "expected CLOSE-LINGER for body dance");
});

Deno.test("close-linger does not fire when A runs straight through B", () => {
  const st = createCloseContactPairState();
  let fired = false;
  // A sprints +z through B parked at origin; starts south of B.
  for (let t = 0; t < AUDIT_CLOSE_LINGER_TICKS + 20; t++) {
    const az = -4 + t * 0.22; // ~13 m/s at 60hz → clear pass
    const ax = 0.05;
    const bx = 0;
    const bz = 0;
    if (advanceCloseContactPair(st, ax, az, bx, bz)) fired = true;
  }
  assertEquals(fired, false, "run-through must not flag CLOSE-LINGER");
  assertEquals(st.passed, true, "pass flag should set when crossing");
});

Deno.test("close-linger ignores brief brush under linger window", () => {
  const st = createCloseContactPairState();
  let fired = false;
  const brief = Math.max(3, Math.floor(AUDIT_CLOSE_LINGER_TICKS * 0.35));
  for (let t = 0; t < brief; t++) {
    if (advanceCloseContactPair(st, 0, 0, 0, 1.5)) fired = true;
  }
  // Separate cleanly
  for (let t = 0; t < 10; t++) {
    if (advanceCloseContactPair(st, 0, 0, 0, 8 + t)) fired = true;
  }
  assertEquals(fired, false);
});

Deno.test("issuesFromBot flags DOOR-REFUSE when close but never entered", () => {
  const live = createBotAuditLive("b1", "bot1", "A", "hard", 0, 0, 0, 30);
  live.counters.ticksAlive = 60 * 20;
  live.counters.minDoorDist = 2.5;
  live.counters.enteredEnemyDoor = false;
  live.counters.scores = 0;
  live.counters.ticksOnDoorLip = 60; // lingered on lip
  const issues = issuesFromBot(live.counters, {
    scenario: "team-match",
    seconds: 50,
    teamScores: { A: 0, B: 0 },
  });
  assert(issues.some((i) => i.code === "DOOR-REFUSE"));
});
