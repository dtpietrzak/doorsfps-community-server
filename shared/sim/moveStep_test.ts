/**
 * Movement parity audit (A5) — same inputs → same step outcomes.
 * Run: deno test -A shared/sim/moveStep_test.ts
 */
import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import {
  jumpStaminaCostSeconds,
  MELEE_LUNGE_DURATION_S,
  moveSpeedForInput,
  SLIDE_DURATION_S,
  slideStaminaCostSeconds,
  SPRINT_DURATION_S,
  SPRINT_SPEED_MULT,
  TICK_HZ,
  WALK_SPEED,
} from "./game.ts";
import {
  createMoveState,
  MOVE_CROUCH_EYE,
  MOVE_JUMP_VELOCITY,
  MOVE_STAND_EYE,
  type MoveCollision,
  moveEyeHeight,
  type MoveInput,
  type MoveState,
  NO_COLLISION,
  retargetEyeY,
  stepMove,
  stepMoveTicks,
} from "./moveStep.ts";

const DT = 1 / TICK_HZ;

function fwd(yaw = 0, extra: Partial<MoveInput> = {}): MoveInput {
  return {
    forward: true,
    backward: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
    crouch: false,
    yaw,
    ...extra,
  };
}

/** Half-wall on z=0 from x=-6..6 — same geometry as server halfWallVault_test. */
function halfWallCollision(): MoveCollision {
  const yMax = 1.2;
  const halfThick = 0.22;
  const radius = 0.35;
  return {
    resolvePosition(x, z, _r = radius, feetY = 0, headY = feetY + 1.7) {
      // Body overlaps slab [0, 1.2] when headY >= 0 && feetY < 1.2
      if (headY < 0 || feetY >= yMax) return { x, z };
      // Segment a=(-6,0) b=(6,0); push circle from infinite strip in z
      const minDist = radius + halfThick;
      if (Math.abs(z) >= minDist) return { x, z };
      if (x < -6 - minDist || x > 6 + minDist) return { x, z };
      // End-cap + body roughly: if near segment in x
      const clampedX = Math.max(-6, Math.min(6, x));
      const dx = x - clampedX;
      const dz = z - 0;
      const dist = Math.hypot(dx, dz);
      if (dist >= minDist) return { x, z };
      if (dist < 1e-8) {
        return { x, z: z >= 0 ? minDist : -minDist };
      }
      const push = minDist - dist;
      return { x: x + (dx / dist) * push, z: z + (dz / dist) * push };
    },
    hasHeadroom(x, z, feetY = 0, headY = feetY + 1.7) {
      const r = this.resolvePosition(x, z, radius, feetY, headY);
      return Math.hypot(r.x - x, r.z - z) <= 0.08;
    },
  };
}

function run(
  state: MoveState,
  input: MoveInput | null,
  ticks: number,
  col: MoveCollision = NO_COLLISION,
): MoveState {
  return stepMoveTicks(state, input, col, { dt: DT, ticks });
}

function runInputSequence(
  initial: MoveState,
  inputs: readonly (MoveInput | null)[],
  collision: MoveCollision = NO_COLLISION,
): MoveState {
  let state = { ...initial };
  for (const input of inputs) {
    state = stepMove(
      state,
      input === null ? null : { ...input },
      collision,
      { dt: DT },
    ).state;
  }
  return state;
}

Deno.test("walk forward distance matches WALK_SPEED × time", () => {
  let s = createMoveState({ x: 0, z: 0, y: MOVE_STAND_EYE });
  // yaw=π → forward is +z (server basis: forward = (−sin, −cos))
  const ticks = TICK_HZ; // 1 second
  s = run(s, fwd(Math.PI), ticks);
  const expected = WALK_SPEED * 1;
  assertAlmostEquals(s.z, expected, 0.05);
  assertAlmostEquals(s.y, MOVE_STAND_EYE, 1e-6);
  assertEquals(s.onGround, true);
});

Deno.test("sprint speed is WALK × SPRINT_SPEED_MULT while stamina remains", () => {
  let s = createMoveState({ sprintStamina: SPRINT_DURATION_S });
  const ticks = Math.floor(TICK_HZ * 0.5); // 0.5s — under full sprint bar
  s = run(s, fwd(Math.PI, { sprint: true }), ticks);
  const expected = WALK_SPEED * SPRINT_SPEED_MULT * 0.5;
  assertAlmostEquals(s.z, expected, 0.08);
  assertEquals(s.sprintStamina < SPRINT_DURATION_S, true);
});

Deno.test("sprint stamina gate: empty bar walks, not sprints", () => {
  let s = createMoveState({ sprintStamina: 0 });
  const ticks = Math.floor(TICK_HZ * 0.5);
  s = run(s, fwd(Math.PI, { sprint: true }), ticks);
  const expected = WALK_SPEED * 0.5;
  assertAlmostEquals(s.z, expected, 0.08);
});

Deno.test("crouch eye height keeps feet fixed", () => {
  let s = createMoveState({ y: MOVE_STAND_EYE, crouch: false });
  // One tick crouch on ground
  s = run(s, fwd(0, { crouch: true, forward: false }), 1);
  assertEquals(s.crouch, true);
  assertAlmostEquals(s.y, MOVE_CROUCH_EYE, 1e-6);
  // Feet stay on the floor: stand/crouch eye minus stance height is 0.
  assertAlmostEquals(s.y - moveEyeHeight(true), 0, 1e-6);
});

Deno.test("retargetEyeY keeps feet when stance disagrees", () => {
  assertAlmostEquals(
    retargetEyeY(MOVE_STAND_EYE, false, true),
    MOVE_CROUCH_EYE,
    1e-6,
  );
  assertAlmostEquals(
    retargetEyeY(MOVE_CROUCH_EYE, true, false),
    MOVE_STAND_EYE,
    1e-6,
  );
  assertAlmostEquals(
    retargetEyeY(MOVE_CROUCH_EYE, true, true),
    MOVE_CROUCH_EYE,
    1e-6,
  );
});

Deno.test("grounded crouch at standing eye snaps instead of falling", () => {
  let s = createMoveState({
    y: MOVE_STAND_EYE,
    crouch: true,
    onGround: true,
    prevInputCrouch: true,
  });
  s = run(s, fwd(0, { crouch: true, forward: false }), 1);
  assertEquals(s.crouch, true);
  assertEquals(s.onGround, true);
  assertAlmostEquals(s.y, MOVE_CROUCH_EYE, 1e-6);
});

Deno.test("held crouch stays down across a dropped input after slide", () => {
  let s = createMoveState({
    sprintStamina: SPRINT_DURATION_S,
    prevInputCrouch: false,
  });
  s = run(s, fwd(Math.PI, { crouch: true }), 1);
  assertEquals(s.slideRemaining > 0, true);
  const slideTicks = Math.ceil(SLIDE_DURATION_S / DT) + 2;
  s = run(s, null, slideTicks);
  assertEquals(s.slideRemaining <= 0, true);
  assertEquals(s.crouch, true);
  assertAlmostEquals(s.y, MOVE_CROUCH_EYE, 1e-5);
  // Next moving crouch packet must not look like a fresh press.
  s = run(s, fwd(Math.PI, { crouch: true }), 1);
  assertEquals(s.slideRemaining <= 0, true);
  assertEquals(s.crouch, true);
});

Deno.test("slide start costs stamina and lasts SLIDE_DURATION_S", () => {
  let s = createMoveState({
    sprintStamina: SPRINT_DURATION_S,
    prevInputCrouch: false,
  });
  // Rising crouch + forward
  s = run(s, fwd(Math.PI, { crouch: true }), 1);
  assertEquals(s.slideRemaining > 0, true);
  assertAlmostEquals(
    s.sprintStamina,
    SPRINT_DURATION_S - slideStaminaCostSeconds(),
    1e-6,
  );

  // Hold crouch for full slide duration
  const slideTicks = Math.ceil(SLIDE_DURATION_S / DT) + 2;
  s = run(s, fwd(Math.PI, { crouch: true }), slideTicks);
  assertEquals(s.slideRemaining <= 0, true);
  // Still crouched if key held
  assertEquals(s.crouch, true);
});

Deno.test("slide starts from pure left / pure right strafe", () => {
  // yaw=0: look −Z; left = −X, right = +X
  for (const side of ["left", "right"] as const) {
    let s = createMoveState({
      sprintStamina: SPRINT_DURATION_S,
      prevInputCrouch: false,
    });
    s = run(
      s,
      fwd(0, {
        forward: false,
        left: side === "left",
        right: side === "right",
        crouch: true,
      }),
      1,
    );
    assertEquals(s.slideRemaining > 0, true, `${side} should start slide`);
    const expectX = side === "left" ? -1 : 1;
    assertAlmostEquals(s.slideDirX, expectX, 1e-6);
    assertAlmostEquals(s.slideDirZ, 0, 1e-6);
  }
});

Deno.test("slide starts on forward-strafe diagonals", () => {
  // yaw=0: forward = −Z, left = −X → diagonal (−1/√2, −1/√2)
  let s = createMoveState({
    sprintStamina: SPRINT_DURATION_S,
    prevInputCrouch: false,
  });
  s = run(s, fwd(0, { left: true, crouch: true }), 1);
  assertEquals(s.slideRemaining > 0, true);
  const inv = 1 / Math.SQRT2;
  assertAlmostEquals(s.slideDirX, -inv, 1e-6);
  assertAlmostEquals(s.slideDirZ, -inv, 1e-6);

  s = createMoveState({
    sprintStamina: SPRINT_DURATION_S,
    prevInputCrouch: false,
  });
  s = run(s, fwd(0, { right: true, crouch: true }), 1);
  assertEquals(s.slideRemaining > 0, true);
  assertAlmostEquals(s.slideDirX, inv, 1e-6);
  assertAlmostEquals(s.slideDirZ, -inv, 1e-6);
});

Deno.test("slide does not start from pure back or crouch-only", () => {
  let s = createMoveState({
    sprintStamina: SPRINT_DURATION_S,
    prevInputCrouch: false,
  });
  s = run(s, fwd(0, { forward: false, backward: true, crouch: true }), 1);
  assertEquals(s.slideRemaining <= 0, true);

  s = createMoveState({
    sprintStamina: SPRINT_DURATION_S,
    prevInputCrouch: false,
  });
  s = run(s, fwd(0, { forward: false, crouch: true }), 1);
  assertEquals(s.slideRemaining <= 0, true);
});

Deno.test("slide end stands when crouch released and headroom allows", () => {
  let s = createMoveState({
    sprintStamina: SPRINT_DURATION_S,
    prevInputCrouch: false,
  });
  // Start slide
  s = run(s, fwd(Math.PI, { crouch: true }), 1);
  assertEquals(s.slideRemaining > 0, true);
  // Release crouch while sliding — should finish slide then stand
  const slideTicks = Math.ceil(SLIDE_DURATION_S / DT) + 2;
  s = run(s, fwd(Math.PI, { crouch: false }), slideTicks);
  assertEquals(s.slideRemaining <= 0, true);
  assertEquals(s.crouch, false);
  assertAlmostEquals(s.y, MOVE_STAND_EYE, 1e-5);
});

Deno.test("jump apex feet clear half-wall height", () => {
  let s = createMoveState({ y: MOVE_STAND_EYE, onGround: true });
  s = run(s, fwd(0, { forward: false, jump: true }), 1);
  assertEquals(s.onGround, false);
  assertAlmostEquals(s.velocityY, MOVE_JUMP_VELOCITY - 20 * DT, 1e-5);

  // Integrate until apex (velocity crosses 0)
  let peakFeet = 0;
  for (let i = 0; i < 200; i++) {
    s = run(s, fwd(0, { forward: false }), 1);
    const feet = s.y - moveEyeHeight(s.crouch);
    if (feet > peakFeet) peakFeet = feet;
    if (s.onGround) break;
  }
  // Half wall 1.2; peak feet ≈ JUMP_VELOCITY²/(2·g) ≈ 1.70 with current impulse.
  assertEquals(peakFeet > 1.2, true);
  assertEquals(peakFeet < 1.85, true);
});

Deno.test("jump costs JUMP_STAMINA fraction", () => {
  let s = createMoveState({ sprintStamina: SPRINT_DURATION_S });
  s = run(s, fwd(0, { forward: false, jump: true }), 1);
  assertAlmostEquals(
    s.sprintStamina,
    SPRINT_DURATION_S - jumpStaminaCostSeconds(),
    1e-6,
  );
});

Deno.test("stallStaminaSpend: sprint drain is skipped", () => {
  let s = createMoveState({ sprintStamina: SPRINT_DURATION_S });
  const ticks = Math.floor(TICK_HZ * 0.5);
  s = stepMoveTicks(s, fwd(Math.PI, { sprint: true }), NO_COLLISION, {
    dt: DT,
    ticks,
    stallStaminaSpend: true,
  });
  assertAlmostEquals(s.sprintStamina, SPRINT_DURATION_S, 1e-6);
  // Still moves at sprint speed (stamina remains > 0).
  const expected = WALK_SPEED * SPRINT_SPEED_MULT * 0.5;
  assertAlmostEquals(s.z, expected, 0.08);
});

Deno.test("stallStaminaSpend: slide starts without paying cost", () => {
  let s = createMoveState({
    sprintStamina: SPRINT_DURATION_S,
    prevInputCrouch: false,
  });
  s = stepMoveTicks(
    s,
    fwd(Math.PI, { crouch: true }),
    NO_COLLISION,
    { dt: DT, ticks: 1, stallStaminaSpend: true },
  );
  assertEquals(s.slideRemaining > 0, true);
  assertAlmostEquals(s.sprintStamina, SPRINT_DURATION_S, 1e-6);
});

Deno.test("stallStaminaSpend: jump costs nothing", () => {
  let s = createMoveState({ sprintStamina: SPRINT_DURATION_S });
  s = stepMoveTicks(
    s,
    fwd(0, { forward: false, jump: true }),
    NO_COLLISION,
    { dt: DT, ticks: 1, stallStaminaSpend: true },
  );
  assertAlmostEquals(s.sprintStamina, SPRINT_DURATION_S, 1e-6);
  assertEquals(s.onGround, false);
});

Deno.test("stallStaminaSpend: slide gate still requires stamina threshold", () => {
  const cost = slideStaminaCostSeconds();
  const startStamina = Math.max(0, cost - 0.01);
  let s = createMoveState({
    sprintStamina: startStamina,
    prevInputCrouch: false,
  });
  s = stepMoveTicks(
    s,
    fwd(Math.PI, { crouch: true }),
    NO_COLLISION,
    { dt: DT, ticks: 1, stallStaminaSpend: true },
  );
  // No free slide from below threshold (stall only skips *paying* cost).
  assertEquals(s.slideRemaining <= 0, true);
  // May crouch-regen a tick; must not drop (no cost charged).
  assertEquals(s.sprintStamina >= startStamina - 1e-9, true);
});

Deno.test("stallStaminaSpend: regen still works while stalled", () => {
  // Bar is SPRINT_DURATION_S (=1); start half-empty so cap does not hide regen.
  let s = createMoveState({
    sprintStamina: 0.5,
    onGround: true,
  });
  // Standing still — should regen even with spend stall.
  s = stepMoveTicks(
    s,
    fwd(0, { forward: false }),
    NO_COLLISION,
    { dt: DT, ticks: Math.floor(TICK_HZ * 0.5), stallStaminaSpend: true },
  );
  assertEquals(s.sprintStamina > 0.5, true);
});

Deno.test("without stall, costs resume after stall window", () => {
  let s = createMoveState({ sprintStamina: SPRINT_DURATION_S });
  // 0.25s stalled sprint — no drain
  s = stepMoveTicks(s, fwd(Math.PI, { sprint: true }), NO_COLLISION, {
    dt: DT,
    ticks: Math.floor(TICK_HZ * 0.25),
    stallStaminaSpend: true,
  });
  assertAlmostEquals(s.sprintStamina, SPRINT_DURATION_S, 1e-6);
  // 0.25s normal sprint — drains
  s = stepMoveTicks(s, fwd(Math.PI, { sprint: true }), NO_COLLISION, {
    dt: DT,
    ticks: Math.floor(TICK_HZ * 0.25),
    stallStaminaSpend: false,
  });
  assertEquals(s.sprintStamina < SPRINT_DURATION_S, true);
});

Deno.test("half-wall vault: crouch-jump clears while holding crouch", () => {
  const col = halfWallCollision();
  let s = createMoveState({
    x: 0,
    z: -2.5,
    y: MOVE_STAND_EYE,
    sprintStamina: SPRINT_DURATION_S,
  });
  let crossed = false;
  for (let tick = 0; tick < 200; tick++) {
    const shouldJump = s.onGround && s.z > -1.8 && s.z < -0.2;
    s = run(
      s,
      {
        forward: true,
        backward: false,
        left: false,
        right: false,
        jump: shouldJump,
        sprint: false,
        crouch: true,
        yaw: Math.PI,
      },
      1,
      col,
    );
    if (s.z > 1.0) {
      crossed = true;
      break;
    }
  }
  assertEquals(crossed, true);
  assertEquals(s.crouch, true);
});

Deno.test("airborne crouch keeps walk speed (vault clearance)", () => {
  // Ground crouch is half; air crouch is full walk — moveSpeedForInput contract.
  assertAlmostEquals(
    moveSpeedForInput(false, true, 1, false, true),
    WALK_SPEED,
    1e-9,
  );
  let s = createMoveState({ onGround: true });
  s = run(s, fwd(Math.PI, { jump: true, crouch: true }), 1);
  assertEquals(s.onGround, false);
  const z0 = s.z;
  s = run(s, fwd(Math.PI, { crouch: true }), 10);
  const dz = s.z - z0;
  // 10 ticks at walk ≈ 6 * 10/60 = 1.0
  assertAlmostEquals(dz, WALK_SPEED * (10 / TICK_HZ), 0.08);
});

Deno.test("stepMove is pure — input state object not mutated", () => {
  const s0 = createMoveState();
  const input = fwd(Math.PI, { jump: true });
  const snap = { ...s0 };
  stepMove(s0, input, NO_COLLISION, { dt: DT });
  assertEquals(s0.x, snap.x);
  assertEquals(s0.velocityY, snap.velocityY);
  assertEquals(input.jump, true);
});

Deno.test("stepMove repeated runs are bit-identical", () => {
  const cases: Array<{
    name: string;
    initial: MoveState;
    inputs: readonly (MoveInput | null)[];
    collision?: MoveCollision;
  }> = [
    {
      name: "sprinting yaw movement",
      initial: createMoveState({ x: -1.25, z: 0.75 }),
      inputs: Array.from(
        { length: 45 },
        (_, i) => fwd(Math.PI, { sprint: i < 30 }),
      ),
    },
    {
      name: "jump and airborne crouch",
      initial: createMoveState({ sprintStamina: SPRINT_DURATION_S }),
      inputs: [
        fwd(Math.PI, { jump: true, crouch: true }),
        ...Array.from({ length: 75 }, () => fwd(Math.PI, { crouch: true })),
      ],
      collision: halfWallCollision(),
    },
    {
      name: "slide and dropped input",
      initial: createMoveState({ sprintStamina: SPRINT_DURATION_S }),
      inputs: [
        fwd(Math.PI, { crouch: true }),
        ...Array.from({ length: 30 }, () => null),
      ],
    },
    {
      name: "null-input falling",
      initial: createMoveState({
        y: MOVE_STAND_EYE + 1,
        velocityY: 2.5,
        onGround: false,
      }),
      inputs: Array.from({ length: 90 }, () => null),
    },
  ];

  for (const testCase of cases) {
    const expected = runInputSequence(
      testCase.initial,
      testCase.inputs,
      testCase.collision,
    );
    for (let repeat = 0; repeat < 4; repeat += 1) {
      assertEquals(
        runInputSequence(
          testCase.initial,
          testCase.inputs,
          testCase.collision,
        ),
        expected,
        testCase.name,
      );
    }
  }
});

Deno.test("melee lunge spends slide cost, stands, and locks forward dir", () => {
  let s = createMoveState({
    sprintStamina: SPRINT_DURATION_S,
    crouch: false,
  });
  const { state, meleeLungeStarted, slideStarted } = stepMove(
    s,
    fwd(Math.PI, { meleeLunge: true }),
    NO_COLLISION,
    { dt: DT },
  );
  s = state;
  assertEquals(meleeLungeStarted, true);
  assertEquals(slideStarted, false);
  // Same step also counts the timer down by dt.
  assertAlmostEquals(s.slideRemaining, MELEE_LUNGE_DURATION_S - DT, 1e-6);
  assertEquals(s.slideForceCrouch, false);
  assertEquals(s.crouch, false);
  assertAlmostEquals(
    s.sprintStamina,
    SPRINT_DURATION_S - slideStaminaCostSeconds(),
    1e-6,
  );
  // yaw=π → forward +Z
  assertAlmostEquals(s.slideDirX, 0, 1e-6);
  assertAlmostEquals(s.slideDirZ, 1, 1e-6);
});

Deno.test("melee lunge lasts half a crouch-slide at sprint speed", () => {
  let s = createMoveState({ sprintStamina: SPRINT_DURATION_S, z: 0 });
  const z0 = s.z;
  // Exact burst window — no trailing walk ticks after the lunge ends.
  const lungeTicks = Math.round(MELEE_LUNGE_DURATION_S / DT);
  s = run(s, fwd(Math.PI, { meleeLunge: true }), lungeTicks);
  assertEquals(s.slideRemaining <= 1e-9, true);
  // Half of slide distance: sprint × 0.2s (vs slide's 0.4s).
  const expected = WALK_SPEED * SPRINT_SPEED_MULT * MELEE_LUNGE_DURATION_S;
  assertAlmostEquals(s.z - z0, expected, 0.08);
  assertAlmostEquals(MELEE_LUNGE_DURATION_S, SLIDE_DURATION_S * 0.5, 1e-9);
});

Deno.test("melee lunge denied without stamina still leaves swing host free", () => {
  let s = createMoveState({
    sprintStamina: 0,
  });
  const { state, meleeLungeStarted } = stepMove(
    s,
    fwd(Math.PI, { meleeLunge: true }),
    NO_COLLISION,
    { dt: DT },
  );
  s = state;
  assertEquals(meleeLungeStarted, false);
  assertEquals(s.slideRemaining <= 0, true);
  // May crouch/walk-regen a tick; must not pay the slide cost from empty.
  assertEquals(s.sprintStamina < slideStaminaCostSeconds(), true);
});

Deno.test("melee lunge denied while holding back", () => {
  let s = createMoveState({ sprintStamina: SPRINT_DURATION_S });
  const { state, meleeLungeStarted } = stepMove(
    s,
    fwd(Math.PI, {
      forward: false,
      backward: true,
      meleeLunge: true,
    }),
    NO_COLLISION,
    { dt: DT },
  );
  s = state;
  assertEquals(meleeLungeStarted, false);
  assertEquals(s.slideRemaining <= 0, true);
  assertAlmostEquals(s.sprintStamina, SPRINT_DURATION_S, 1e-6);
});

Deno.test("melee lunge denied while airborne", () => {
  let s = createMoveState({
    sprintStamina: SPRINT_DURATION_S,
    onGround: false,
    y: MOVE_STAND_EYE + 1,
  });
  const { state, meleeLungeStarted } = stepMove(
    s,
    fwd(Math.PI, { meleeLunge: true }),
    NO_COLLISION,
    { dt: DT },
  );
  s = state;
  assertEquals(meleeLungeStarted, false);
  assertEquals(s.slideRemaining <= 0, true);
});

Deno.test("melee lunge denied while already bursting", () => {
  let s = createMoveState({
    sprintStamina: SPRINT_DURATION_S,
    prevInputCrouch: false,
  });
  s = run(s, fwd(Math.PI, { crouch: true }), 1);
  assertEquals(s.slideRemaining > 0, true);
  assertEquals(s.slideForceCrouch, true);
  const staminaAfterSlide = s.sprintStamina;
  const { state, meleeLungeStarted } = stepMove(
    s,
    fwd(Math.PI, { crouch: true, meleeLunge: true }),
    NO_COLLISION,
    { dt: DT },
  );
  s = state;
  assertEquals(meleeLungeStarted, false);
  assertAlmostEquals(s.sprintStamina, staminaAfterSlide, 1e-6);
});

Deno.test("stallStaminaSpend: melee lunge starts without paying cost", () => {
  let s = createMoveState({ sprintStamina: SPRINT_DURATION_S });
  const { state, meleeLungeStarted } = stepMove(
    s,
    fwd(Math.PI, { meleeLunge: true }),
    NO_COLLISION,
    { dt: DT, stallStaminaSpend: true },
  );
  s = state;
  assertEquals(meleeLungeStarted, true);
  assertEquals(s.slideForceCrouch, false);
  assertAlmostEquals(s.sprintStamina, SPRINT_DURATION_S, 1e-6);
});

Deno.test("crouch-slide still forces crouch via slideForceCrouch", () => {
  let s = createMoveState({
    sprintStamina: SPRINT_DURATION_S,
    prevInputCrouch: false,
  });
  const { state, slideStarted } = stepMove(
    s,
    fwd(Math.PI, { crouch: true }),
    NO_COLLISION,
    { dt: DT },
  );
  s = state;
  assertEquals(slideStarted, true);
  assertEquals(s.slideForceCrouch, true);
  assertEquals(s.crouch, true);
});
