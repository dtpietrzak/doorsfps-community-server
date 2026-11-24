import {
  assertEquals,
  assertAlmostEquals,
} from "jsr:@std/assert@1";
import { findClosedWallPolygons } from "./wallPolygons.ts";
import {
  WALL_CORNER_OFFSET,
  computeDoorYawDots,
  computeWallCorners,
  doorLineSegment,
  mapClosureGaps,
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

Deno.test("opening gaps keep the yaw graph, but a windowed room is not solid", () => {
  const walls = [
    { a: { x: 0, z: 0 }, b: { x: 6, z: 0 }, kind: "full" as const },
    { a: { x: 6, z: 0 }, b: { x: 6, z: 6 }, kind: "full" as const },
    { a: { x: 6, z: 6 }, b: { x: 0, z: 6 }, kind: "full" as const },
    { a: { x: 0, z: 6 }, b: { x: 0, z: 0 }, kind: "full" as const },
    { a: { x: 3, z: 0 }, b: { x: 3, z: 2 }, kind: "full" as const },
  ];
  const gap = [{ a: { x: 2.25, z: 6 }, b: { x: 3.75, z: 6 } }];
  const closed = computeWallCorners(walls);
  const open = computeWallCorners(walls, null, gap);
  assertEquals(hasNear(closed, 3, 2 + OFFSET), false);
  assertEquals(hasNear(open, 3, 2 + OFFSET), true);
  assertEquals(hasNear(open, 3, 6, 0.05), false);
});

Deno.test("mapClosureGaps: windows, sliding doors, and energy doors", () => {
  const bounds = { minX: -20, maxX: 20, minZ: -20, maxZ: 20 };
  const walls = [
    { id: "s", a: { x: -4, z: 0 }, b: { x: 4, z: 0 }, kind: "full" as const },
    { id: "h", a: { x: 0, z: 2 }, b: { x: 4, z: 2 }, kind: "half" as const },
  ];
  const windows = [{ wallId: "s", center: { x: -2, z: 0 } }];
  const doors = [{ wallId: "s", center: { x: 2, z: 0 } }];
  const teamA = { edge: "south" as const, doorHalfWidth: 2.5 };
  const teamB = { edge: "north" as const, doorHalfWidth: 2.5 };
  const gaps = mapClosureGaps({ walls, windows, doors, bounds, teamA, teamB });
  assertEquals(gaps.length, 4);
  const south = doorLineSegment(bounds, teamA);
  const north = doorLineSegment(bounds, teamB);
  assertEquals(gaps[2]!.a, south[0]);
  assertEquals(gaps[2]!.b, south[1]);
  assertEquals(gaps[3]!.a, north[0]);
  assertEquals(gaps[3]!.b, north[1]);

  const zombots = mapClosureGaps({
    walls,
    windows,
    doors,
    bounds,
    teamA,
    teamB,
    mirrorMode: "zombots",
  });
  assertEquals(zombots.length, 2);
});

Deno.test("a room across the energy door is not a closure; zombots seals it", () => {
  const bounds = { minX: -20, maxX: 20, minZ: -20, maxZ: 20 };
  const walls = [
    { id: "n", a: { x: -20, z: -10 }, b: { x: 20, z: -10 }, kind: "full" as const },
  ];
  const base = {
    walls,
    bounds,
    teamA: { edge: "south" as const, doorHalfWidth: 2.5 },
    teamB: { edge: "north" as const, doorHalfWidth: 2.5 },
  };
  assertEquals(
    findClosedWallPolygons(walls, bounds, mapClosureGaps(base)).length,
    0,
  );
  const sealed = findClosedWallPolygons(
    walls,
    bounds,
    mapClosureGaps({ ...base, mirrorMode: "zombots" }),
  );
  assertEquals(sealed.length, 1);
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

Deno.test("a closed sliding door is solid; opening it is a gap", () => {
  const bounds = { minX: -20, maxX: 20, minZ: -20, maxZ: 20 };
  const walls = [
    { id: "s", a: { x: 0, z: 0 }, b: { x: 6, z: 0 }, kind: "full" as const },
    { id: "e", a: { x: 6, z: 0 }, b: { x: 6, z: 6 }, kind: "full" as const },
    { id: "n", a: { x: 6, z: 6 }, b: { x: 0, z: 6 }, kind: "full" as const },
    { id: "w", a: { x: 0, z: 6 }, b: { x: 0, z: 0 }, kind: "full" as const },
    { id: "stub", a: { x: 3, z: 0 }, b: { x: 3, z: 2 }, kind: "full" as const },
  ];
  const doors = [{ id: "d", wallId: "n", center: { x: 3, z: 6 } }];
  const base = { walls, doors, bounds, mirrorMode: "zombots" };
  const allOpen = mapClosureGaps(base);
  const namedOpen = mapClosureGaps({ ...base, openDoorIds: ["d"] });
  const sealed = mapClosureGaps({ ...base, openDoorIds: [] });
  assertEquals(namedOpen, allOpen);
  assertEquals(sealed, []);
  assertEquals(allOpen.length, 1);

  const closedCorners = computeWallCorners(walls, bounds, sealed);
  const openCorners = computeWallCorners(walls, bounds, allOpen);
  assertEquals(hasNear(closedCorners, 3, 2 + OFFSET), false);
  assertEquals(hasNear(openCorners, 3, 2 + OFFSET), true);

  const withWindow = mapClosureGaps({
    walls,
    windows: [{ wallId: "s", center: { x: 1, z: 0 } }],
    doors,
    bounds,
    teamA: { edge: "south", doorHalfWidth: 2.5 },
    teamB: { edge: "north", doorHalfWidth: 2.5 },
    openDoorIds: [],
  });
  // Window stays, both energy doors stay, the sliding door does not.
  assertEquals(withWindow.length, 3);
});

Deno.test("corner recompute stays cheap on a map with many doors", async () => {
  const rooms = 48;
  const span = 6;
  const walls: {
    id: string;
    a: { x: number; z: number };
    b: { x: number; z: number };
    kind: "full";
  }[] = [
    { id: "south", a: { x: 0, z: 0 }, b: { x: rooms * span, z: 0 }, kind: "full" },
    { id: "north", a: { x: 0, z: span }, b: { x: rooms * span, z: span }, kind: "full" },
  ];
  const doors: { id: string; wallId: string; center: { x: number; z: number } }[] = [];
  for (let i = 0; i <= rooms; i++) {
    walls.push({
      id: `v${i}`,
      a: { x: i * span, z: 0 },
      b: { x: i * span, z: span },
      kind: "full",
    });
    if (i < rooms) {
      doors.push({
        id: `d${i}`,
        wallId: `v${i}`,
        center: { x: i * span, z: span / 2 },
      });
    }
  }
  const bounds = {
    minX: -5,
    maxX: rooms * span + 5,
    minZ: -5,
    maxZ: span + 5,
  };
  const once = (openDoorIds: readonly string[]) =>
    computeWallCorners(
      walls,
      bounds,
      mapClosureGaps({ walls, doors, bounds, mirrorMode: "zombots", openDoorIds }),
    );
  const gapCount = (openDoorIds: readonly string[]) =>
    mapClosureGaps({
      walls,
      doors,
      bounds,
      mirrorMode: "zombots",
      openDoorIds,
    }).length;
  const allIds = doors.map((door) => door.id);
  assertEquals(gapCount([]), 0);
  assertEquals(gapCount(["d0"]), 1);
  assertEquals(gapCount(allIds), doors.length);
  once([]);
  const t0 = performance.now();
  once([]);
  once(allIds);
  once(["d0"]);
  const ms = performance.now() - t0;
  // One door-open rebuilds corners once. This is that walk, three times.
  assertEquals(
    ms < 250,
    true,
    `recompute ${doors.length} doors took ${ms.toFixed(2)} ms`,
  );

  let fullest: { name: string; walls: typeof walls } | null = null;
  const dir = new URL("../../maps/competitive/", import.meta.url);
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.name.endsWith(".doors.json")) continue;
    const raw = JSON.parse(await Deno.readTextFile(new URL(entry.name, dir))) as {
      name?: string;
      walls?: {
        id: string;
        a: { x: number; z: number };
        b: { x: number; z: number };
        kind?: string;
      }[];
      bounds?: typeof bounds;
      teamA?: { edge: "south" | "east" | "north" | "west"; doorHalfWidth: number };
      teamB?: { edge: "south" | "east" | "north" | "west"; doorHalfWidth: number };
    };
    const full = (raw.walls ?? []).filter((wall) =>
      wall.kind !== "half" && wall.kind !== "float"
    );
    if (fullest === null || full.length > fullest.walls.length) {
      fullest = {
        name: raw.name ?? entry.name,
        walls: full.map((wall) => ({
          id: wall.id,
          a: wall.a,
          b: wall.b,
          kind: "full" as const,
        })),
      };
    }
  }
  if (fullest === null || fullest.walls.length === 0) return;
  const mapDoors = fullest.walls.map((wall, index) => ({
    id: `door-${index}`,
    wallId: wall.id,
    center: {
      x: (wall.a.x + wall.b.x) / 2,
      z: (wall.a.z + wall.b.z) / 2,
    },
  }));
  const mapBounds = { minX: -20, maxX: 20, minZ: -20, maxZ: 20 };
  const rebuild = (openDoorIds: readonly string[]) =>
    computeWallCorners(
      fullest.walls,
      mapBounds,
      mapClosureGaps({
        walls: fullest.walls,
        doors: mapDoors,
        bounds: mapBounds,
        openDoorIds,
      }),
    );
  const liveIds = mapDoors.map((door) => door.id);
  const liveGaps = (openDoorIds: readonly string[]) =>
    mapClosureGaps({
      walls: fullest.walls,
      doors: mapDoors,
      bounds: mapBounds,
      openDoorIds,
    }).length;
  assertEquals(liveGaps([]) < liveGaps(liveIds), true);
  rebuild([]);
  const live0 = performance.now();
  rebuild([]);
  rebuild(liveIds);
  const liveMs = performance.now() - live0;
  assertEquals(
    liveMs < 250,
    true,
    `${fullest.name}: recompute ${mapDoors.length} doors took ${liveMs.toFixed(2)} ms`,
  );
});
