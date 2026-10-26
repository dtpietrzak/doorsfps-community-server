import {
  assertEquals,
  assertAlmostEquals,
} from "jsr:@std/assert@1";
import {
  WALL_CORNER_OFFSET,
  computeDoorYawDots,
  computeWallCorners,
  resolveWallCorners,
} from "./wallCorners.ts";

const OFFSET = WALL_CORNER_OFFSET;

function hasNear(
  pts: { x: number; z: number }[],
  x: number,
  z: number,
  eps = 0.08,
): boolean {
  return pts.some((p) => Math.hypot(p.x - x, p.z - z) <= eps);
}

Deno.test("free ends: single full wall → 1u past each tip, collinear", () => {
  const corners = computeWallCorners([
    { a: { x: 0, z: 0 }, b: { x: 10, z: 0 }, kind: "full" },
  ]);
  assertEquals(corners.length, 2);
  assertEquals(hasNear(corners, -OFFSET, 0), true);
  assertEquals(hasNear(corners, 10 + OFFSET, 0), true);
});

Deno.test("freestanding L: yaw dot only outside the 90° angle", () => {
  // Walls along +X and +Z from origin → inside angle is first quadrant.
  const corners = computeWallCorners([
    { a: { x: 0, z: 0 }, b: { x: 5, z: 0 }, kind: "full" },
    { a: { x: 0, z: 0 }, b: { x: 0, z: 5 }, kind: "full" },
  ]);
  // Outside = third quadrant bisector
  const e = OFFSET / Math.SQRT2;
  assertEquals(hasNear(corners, -e, -e), true);
  // Never inside the 90° wedge
  assertEquals(hasNear(corners, e, e), false);
  // Past-tip free ends kept
  assertEquals(hasNear(corners, 5 + OFFSET, 0), true);
  assertEquals(hasNear(corners, 0, 5 + OFFSET), true);
});

Deno.test("obtuse freestanding joint: never inside the obtuse wedge", () => {
  // 135° wedge in the +X / +Z half via (5,0) and (−1,1) directions from origin? 
  // Simpler: walls (0,0)-(6,0) and (0,0)-(-3,3) → angles between +X and 135° NW.
  // dirs: +X and 135° → smaller sector 135° (obtuse), exterior 225°.
  const corners = computeWallCorners([
    { a: { x: 0, z: 0 }, b: { x: 6, z: 0 }, kind: "full" },
    { a: { x: 0, z: 0 }, b: { x: -3, z: 3 }, kind: "full" },
  ]);
  // Bisector of exterior (outside 135°): from +X CCW to 135° is 135°;
  // exterior from 135° CCW to +X is 225°, mid at 135° + 112.5° = 247.5°...
  // dirs sorted: 135° (to -3,3) then 0°/+X wraps. CCW from +X to 135° = 135° (inside).
  // CCW from 135° to +X = 225° (outside). Bisector angle = 135° + 112.5° = 247.5°.
  const mid = ((135 + 112.5) * Math.PI) / 180;
  const ox = Math.cos(mid) * OFFSET;
  const oz = Math.sin(mid) * OFFSET;
  assertEquals(hasNear(corners, ox, oz, 0.12), true);
  // Sample inside obtuse wedge should have no pin
  const insideMid = ((135 / 2) * Math.PI) / 180;
  assertEquals(
    hasNear(
      corners,
      Math.cos(insideMid) * OFFSET,
      Math.sin(insideMid) * OFFSET,
      0.15,
    ),
    false,
  );
});

Deno.test("collinear two segments: no mid-joint pink spot", () => {
  const corners = computeWallCorners([
    { a: { x: 0, z: 0 }, b: { x: 5, z: 0 }, kind: "full" },
    { a: { x: 5, z: 0 }, b: { x: 10, z: 0 }, kind: "full" },
  ]);
  assertEquals(hasNear(corners, 5, 0, 0.2), false);
  assertEquals(hasNear(corners, -OFFSET, 0), true);
  assertEquals(hasNear(corners, 10 + OFFSET, 0), true);
});

Deno.test("near-coincident L endpoints still form one outside joint target", () => {
  const corners = computeWallCorners([
    { a: { x: 0, z: 0 }, b: { x: 5, z: 0 }, kind: "full" },
    { a: { x: 5 + 1e-5, z: 0 }, b: { x: 5, z: 4 }, kind: "full" },
  ]);
  const nearJoint = corners.filter(
    (p) => Math.hypot(p.x - 5, p.z - 0) < OFFSET + 0.15,
  );
  assertEquals(nearJoint.length, 1);
  // Outside L at (5,0) with arms −X and +Z → outside is SE (+x, −z)
  const j = nearJoint[0]!;
  assertEquals(j.x > 5, true);
  assertEquals(j.z < 0, true);
});

Deno.test("skips half and float walls", () => {
  const corners = computeWallCorners([
    { a: { x: 0, z: 0 }, b: { x: 3, z: 0 }, kind: "half" },
    { a: { x: 1, z: 1 }, b: { x: 2, z: 2 }, kind: "float" },
    { a: { x: 8, z: 8 }, b: { x: 9, z: 8 }, kind: "full" },
  ]);
  assertEquals(corners.length, 2);
  assertEquals(hasNear(corners, 8 - OFFSET, 8), true);
  assertEquals(hasNear(corners, 9 + OFFSET, 8), true);
});

Deno.test("omitted kind counts as full", () => {
  const corners = computeWallCorners([
    { a: { x: 1, z: 1 }, b: { x: 2, z: 1 } },
  ]);
  assertEquals(corners.length, 2);
});

Deno.test("solid axis-aligned box: corners offset outward, not into fill", () => {
  const walls = [
    { a: { x: 0, z: 0 }, b: { x: 4, z: 0 }, kind: "full" as const },
    { a: { x: 4, z: 0 }, b: { x: 4, z: 4 }, kind: "full" as const },
    { a: { x: 4, z: 4 }, b: { x: 0, z: 4 }, kind: "full" as const },
    { a: { x: 0, z: 4 }, b: { x: 0, z: 0 }, kind: "full" as const },
  ];
  const corners = computeWallCorners(walls);
  assertEquals(hasNear(corners, -OFFSET / Math.SQRT2, -OFFSET / Math.SQRT2), true);
  assertEquals(hasNear(corners, 4 + OFFSET / Math.SQRT2, -OFFSET / Math.SQRT2), true);
  assertEquals(hasNear(corners, 4 + OFFSET / Math.SQRT2, 4 + OFFSET / Math.SQRT2), true);
  assertEquals(hasNear(corners, -OFFSET / Math.SQRT2, 4 + OFFSET / Math.SQRT2), true);
  assertEquals(
    corners.every((p) => p.x < -0.01 || p.x > 4.01 || p.z < -0.01 || p.z > 4.01),
    true,
  );
});

Deno.test("T-junction: no inside-angle pins; past-tip free ends only", () => {
  // Horizontal bar (−5,0)–(5,0) and stem (0,0)–(0,5)
  // All open sectors at T are 90° (inside angles) → no joint yaw dots.
  const corners = computeWallCorners([
    { a: { x: -5, z: 0 }, b: { x: 5, z: 0 }, kind: "full" },
    { a: { x: 0, z: 0 }, b: { x: 0, z: 5 }, kind: "full" },
  ]);
  const e = OFFSET / Math.SQRT2;
  assertEquals(hasNear(corners, e, e), false);
  assertEquals(hasNear(corners, -e, e), false);
  assertEquals(hasNear(corners, 0, 0, 0.15), false);
  // Free ends kept
  assertEquals(hasNear(corners, -5 - OFFSET, 0), true);
  assertEquals(hasNear(corners, 5 + OFFSET, 0), true);
  assertEquals(hasNear(corners, 0, 5 + OFFSET), true);
});

Deno.test("outer walls count: wall into south bounds is not a free past-tip OOB", () => {
  const bounds = { minX: -10, maxX: 10, minZ: -10, maxZ: 10 };
  // Wall from (0,0) south to bounds at (0,-10)
  const corners = computeWallCorners(
    [{ a: { x: 0, z: 0 }, b: { x: 0, z: -10 }, kind: "full" }],
    bounds,
  );
  // Contact with outer wall → no past-tip south of bounds
  assertEquals(hasNear(corners, 0, -10 - OFFSET, 0.2), false);
  // No pin inside the two 90° angles at the T with the outer wall
  assertEquals(hasNear(corners, OFFSET / Math.SQRT2, -10 + OFFSET / Math.SQRT2), false);
  assertEquals(hasNear(corners, -OFFSET / Math.SQRT2, -10 + OFFSET / Math.SQRT2), false);
  // Free end at north tip kept
  assertEquals(hasNear(corners, 0, OFFSET), true);
});

Deno.test("outer walls + freestanding L near corner uses bounds in graph", () => {
  const bounds = { minX: -20, maxX: 20, minZ: -20, maxZ: 20 };
  const corners = computeWallCorners(
    [
      { a: { x: 0, z: 0 }, b: { x: 5, z: 0 }, kind: "full" },
      { a: { x: 0, z: 0 }, b: { x: 0, z: 5 }, kind: "full" },
    ],
    bounds,
  );
  const e = OFFSET / Math.SQRT2;
  // Still only outside the L
  assertEquals(hasNear(corners, -e, -e), true);
  assertEquals(hasNear(corners, e, e), false);
});

Deno.test("resolveWallCorners: prefers stored when present", () => {
  const stored = [{ x: 1, z: 2 }];
  const walls = [
    { a: { x: 0, z: 0 }, b: { x: 10, z: 0 }, kind: "full" as const },
  ];
  assertEquals(resolveWallCorners(walls, stored), [{ x: 1, z: 2 }]);
});

Deno.test("resolveWallCorners: recomputes when stored missing/empty", () => {
  const walls = [
    { a: { x: 0, z: 0 }, b: { x: 4, z: 0 }, kind: "full" as const },
  ];
  assertEquals(resolveWallCorners(walls, undefined).length, 2);
  assertEquals(resolveWallCorners(walls, []).length, 2);
});

Deno.test("computeDoorYawDots: 3 poles per door, on the door line", () => {
  const bounds = { minX: -20, maxX: 20, minZ: -20, maxZ: 20 };
  const teamA = { edge: "south" as const, doorHalfWidth: 2.5 };
  const teamB = { edge: "north" as const, doorHalfWidth: 2.5 };
  const dots = computeDoorYawDots(bounds, teamA, teamB);
  assertEquals(dots.length, 6);

  // South door: z = minZ (on the door), center at x=0, edges ±halfWidth.
  const south = dots.filter((p) => Math.abs(p.z - (-20)) < 1e-9);
  assertEquals(south.length, 3);
  const sx = south.map((p) => p.x).sort((a, b) => a - b);
  assertAlmostEquals(sx[0]!, -2.5, 1e-6);
  assertAlmostEquals(sx[1]!, 0, 1e-6);
  assertAlmostEquals(sx[2]!, 2.5, 1e-6);

  // North door: z = maxZ (on the door).
  const north = dots.filter((p) => Math.abs(p.z - 20) < 1e-9);
  assertEquals(north.length, 3);
  const nx = north.map((p) => p.x).sort((a, b) => a - b);
  assertAlmostEquals(nx[0]!, -2.5, 1e-6);
  assertAlmostEquals(nx[1]!, 0, 1e-6);
  assertAlmostEquals(nx[2]!, 2.5, 1e-6);
});

Deno.test("resolveWallCorners: appends door poles when doors provided", () => {
  const bounds = { minX: -20, maxX: 20, minZ: -20, maxZ: 20 };
  const doors = {
    teamA: { edge: "south" as const, doorHalfWidth: 2.5 },
    teamB: { edge: "north" as const, doorHalfWidth: 2.5 },
  };
  const stored = [{ x: 1, z: 2 }];
  const all = resolveWallCorners([], stored, bounds, doors);
  assertEquals(all.length, 1 + 6);
  assertEquals(all.some((p) => p.x === 1 && p.z === 2), true);
});

Deno.test("bounds: pure map corners without interior walls emit nothing", () => {
  const corners = computeWallCorners([], {
    minX: -10,
    maxX: 10,
    minZ: -10,
    maxZ: 10,
  });
  assertEquals(corners.length, 0);
});
