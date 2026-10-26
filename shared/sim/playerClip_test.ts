/**
 * Player–player body clip.
 * Run: deno test -A shared/sim/playerClip_test.ts
 */
import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import { MOVE_CROUCH_EYE, MOVE_STAND_EYE, NO_COLLISION } from "./moveStep.ts";
import {
  applyPlayerClip,
  bodyHitboxesOverlapY,
  clipMoverAgainstObstacles,
  moverCenterInside,
  PLAYER_CLIP_RADIUS,
} from "./playerClip.ts";

const R = PLAYER_CLIP_RADIUS;
const MIN_SEP = 2 * R;
const EYE = MOVE_STAND_EYE;

function stand(
  id: string,
  x: number,
  z: number,
  extra?: { y?: number; crouch?: boolean },
) {
  return { id, x, y: extra?.y ?? EYE, z, crouch: extra?.crouch };
}

Deno.test("walk into a static player stops at 2r", () => {
  const other = stand("b", 0, 0);
  const mover = stand("a", 0, 0.4);
  const out = clipMoverAgainstObstacles(mover, [other]);
  assertAlmostEquals(out.z, MIN_SEP, 1e-9);
  assertAlmostEquals(out.x, 0, 1e-9);
  assertEquals(out.inside, false);
});

Deno.test("no Y overlap (jumper above torso) does not clip", () => {
  const other = stand("b", 0, 0);
  // Jumper feet ~1.70 → body starts ~1.78, standing body top ~1.34.
  const mover = stand("a", 0, 0.1, { y: EYE + 1.70 });
  assertEquals(bodyHitboxesOverlapY(mover.y, false, other), false);
  const out = clipMoverAgainstObstacles(mover, [other]);
  assertAlmostEquals(out.x, 0, 1e-9);
  assertAlmostEquals(out.z, 0.1, 1e-9);
  assertEquals(out.inside, false);
});

Deno.test("crouch vs stand still clips when Y overlaps", () => {
  const other = stand("b", 0, 0);
  const mover = stand("a", 0, 0.4, { crouch: true, y: MOVE_CROUCH_EYE });
  assertEquals(bodyHitboxesOverlapY(mover.y, true, other), true);
  const out = clipMoverAgainstObstacles(mover, [other]);
  assertAlmostEquals(Math.hypot(out.x, out.z), MIN_SEP, 1e-9);
  assertEquals(out.inside, false);
});

Deno.test("coincident centers get a deterministic nonzero push", () => {
  const other = stand("b", 0, 0);
  const a = clipMoverAgainstObstacles(stand("a", 0, 0), [other]);
  assertEquals(Math.hypot(a.x, a.z) > 0.5, true);
  assertEquals(a.inside, false);
  const a2 = clipMoverAgainstObstacles(stand("a", 0, 0), [other]);
  assertAlmostEquals(a.x, a2.x, 1e-12);
  assertAlmostEquals(a.z, a2.z, 1e-12);
});

Deno.test("inside is true when map resolve undoes the clip push", () => {
  const locked = {
    resolvePosition() {
      return { x: 0, z: 0 };
    },
    hasHeadroom() {
      return true;
    },
  };
  const out = applyPlayerClip(locked, stand("a", 0, 0), [stand("b", 0, 0)]);
  assertEquals(out.inside, true);
  assertAlmostEquals(out.x, 0, 1e-12);
  assertAlmostEquals(out.z, 0, 1e-12);
});

Deno.test("center at exactly r is not inside (strict < r)", () => {
  const other = stand("b", 0, 0);
  assertEquals(moverCenterInside(stand("a", R, 0), [other]), false);
  assertEquals(moverCenterInside(stand("a", R - 1e-4, 0), [other]), true);
});

Deno.test("applyPlayerClip on open map matches clip result", () => {
  const other = stand("b", 0, 0);
  const mover = stand("a", 0, 0.2);
  const out = applyPlayerClip(NO_COLLISION, mover, [other]);
  assertAlmostEquals(out.z, MIN_SEP, 1e-9);
  assertEquals(out.inside, false);
});
