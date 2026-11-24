import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import { SLIDING_DOOR_WIDTH } from "./slidingDoors.ts";
import {
  authoredWallSpans,
  cutWallOpenings,
  interiorOpeningGaps,
  wallPlanSegments,
  WINDOW_HEAD_Y,
  WINDOW_SILL_Y,
  WINDOW_WIDTH,
} from "./wallWindows.ts";

const WALL_HEIGHT = 3.45;
const a = { x: -4, z: 0 };
const b = { x: 4, z: 0 };
const center = { x: 0, z: 0 };

Deno.test("no windows leaves the slab whole", () => {
  const spans = cutWallOpenings(a, b, 0, WALL_HEIGHT, []);
  assertEquals(spans.length, 1);
  assertEquals(spans[0]!.yMin, 0);
  assertEquals(spans[0]!.yMax, WALL_HEIGHT);
  assertEquals(spans[0]!.a, a);
  assertEquals(spans[0]!.b, b);
});

Deno.test("one window cuts two piers, a sill, and a header", () => {
  const spans = authoredWallSpans(
    { id: "w", a, b },
    [{ wallId: "w", center }],
    0,
    WALL_HEIGHT,
  );
  assertEquals(spans.length, 4);
  const [left, sill, header, right] = spans;
  assertAlmostEquals(left!.a.x, -4, 1e-6);
  assertAlmostEquals(left!.b.x, -WINDOW_WIDTH / 2, 1e-6);
  assertEquals(left!.yMin, 0);
  assertEquals(left!.yMax, WALL_HEIGHT);
  assertAlmostEquals(sill!.a.x, -WINDOW_WIDTH / 2, 1e-6);
  assertAlmostEquals(sill!.b.x, WINDOW_WIDTH / 2, 1e-6);
  assertEquals(sill!.yMin, 0);
  assertEquals(sill!.yMax, WINDOW_SILL_Y);
  assertEquals(header!.yMin, WINDOW_HEAD_Y);
  assertEquals(header!.yMax, WALL_HEIGHT);
  assertAlmostEquals(header!.a.z, 0, 1e-6);
  assertAlmostEquals(right!.a.x, WINDOW_WIDTH / 2, 1e-6);
  assertAlmostEquals(right!.b.x, 4, 1e-6);
  assertEquals(right!.yMax, WALL_HEIGHT);
});

Deno.test("a center off the wall does not cut", () => {
  const spans = cutWallOpenings(a, b, 0, WALL_HEIGHT, [{ x: 0, z: 1 }]);
  assertEquals(spans.length, 1);
  assertEquals(spans[0]!.yMax, WALL_HEIGHT);
});

Deno.test("a slab that does not cover the opening stays whole", () => {
  const spans = cutWallOpenings(a, b, 0, 1.2, [center]);
  assertEquals(spans.length, 1);
  assertEquals(spans[0]!.yMax, 1.2);
});

Deno.test("half and float walls ignore windows", () => {
  for (const kind of ["half", "float"] as const) {
    const spans = authoredWallSpans(
      { id: "w", a, b, kind },
      [{ wallId: "w", center }],
      0,
      WALL_HEIGHT,
    );
    assertEquals(spans.length, 1);
    assertEquals(spans[0]!.b.x, 4);
  }
});

Deno.test("overlapping windows merge into one opening", () => {
  const spans = cutWallOpenings(a, b, 0, WALL_HEIGHT, [
    center,
    { x: 0.5, z: 0 },
  ]);
  assertEquals(spans.length, 4);
  assertAlmostEquals(spans[1]!.a.x, -WINDOW_WIDTH / 2, 1e-6);
  assertAlmostEquals(spans[1]!.b.x, 0.5 + WINDOW_WIDTH / 2, 1e-6);
});

Deno.test("plan view is the piers only", () => {
  const plan = wallPlanSegments(
    { id: "w", a, b },
    [{ wallId: "w", center }],
  );
  assertEquals(plan.length, 2);
  assertAlmostEquals(plan[0]!.b.x, -WINDOW_WIDTH / 2, 1e-6);
  assertAlmostEquals(plan[1]!.a.x, WINDOW_WIDTH / 2, 1e-6);
  const half = wallPlanSegments(
    { id: "w", a, b, kind: "half" },
    [{ wallId: "w", center }],
  );
  assertEquals(half.length, 1);
  assertEquals(half[0]!.b.x, 4);
});

Deno.test("a sliding door removes the whole wall height, including a window sill", () => {
  const spans = authoredWallSpans(
    { id: "w", a, b },
    [{ wallId: "w", center }],
    0,
    WALL_HEIGHT,
    [{ wallId: "w", center }],
  );
  const half = SLIDING_DOOR_WIDTH / 2;
  const covering = spans.filter((span) =>
    span.a.x < half - 0.01 && span.b.x > -half + 0.01
  );
  assertEquals(covering, []);
  const plan = wallPlanSegments(
    { id: "w", a, b },
    [{ wallId: "w", center }],
    [{ wallId: "w", center }],
  );
  assertEquals(plan.length, 2);
  assertAlmostEquals(plan[0]!.b.x, -half, 1e-6);
  assertAlmostEquals(plan[1]!.a.x, half, 1e-6);
});

Deno.test("closure gaps are the window and the wider sliding door", () => {
  const wall = { id: "w", a, b };
  const windows = [{ wallId: "w", center }];
  const doors = [{ wallId: "w", center: { x: 2, z: 0 } }];
  const gaps = interiorOpeningGaps([wall], windows, doors);
  assertEquals(gaps.length, 2);
  assertAlmostEquals(gaps[0]!.a.x, -WINDOW_WIDTH / 2, 1e-6);
  assertAlmostEquals(gaps[0]!.b.x, WINDOW_WIDTH / 2, 1e-6);
  assertAlmostEquals(gaps[1]!.a.x, 2 - SLIDING_DOOR_WIDTH / 2, 1e-6);
  assertAlmostEquals(gaps[1]!.b.x, 2 + SLIDING_DOOR_WIDTH / 2, 1e-6);

  const merged = interiorOpeningGaps([wall], windows, [{ wallId: "w", center }]);
  assertEquals(merged.length, 1);
  assertAlmostEquals(merged[0]!.a.x, -SLIDING_DOOR_WIDTH / 2, 1e-6);
  assertAlmostEquals(merged[0]!.b.x, SLIDING_DOOR_WIDTH / 2, 1e-6);
});

Deno.test("closure gaps skip half walls, off-wall centers, and a missing id", () => {
  const gaps = interiorOpeningGaps(
    [
      { id: "h", a, b, kind: "half" },
      { id: "f", a, b, kind: "float" },
      { a, b },
      { id: "v", a: { x: 0, z: -4 }, b: { x: 0, z: 4 } },
    ],
    [
      { wallId: "h", center },
      { wallId: "v", center: { x: 1, z: 0 } },
      { wallId: "v", center: { x: 0, z: 0 } },
    ],
    undefined,
  );
  assertEquals(gaps.length, 1);
  assertAlmostEquals(gaps[0]!.a.x, 0, 1e-6);
  assertAlmostEquals(gaps[0]!.a.z, -WINDOW_WIDTH / 2, 1e-6);
  assertAlmostEquals(gaps[0]!.b.z, WINDOW_WIDTH / 2, 1e-6);
});

Deno.test("a sliding door that covers a short wall is the whole wall", () => {
  const gaps = interiorOpeningGaps(
    [{ id: "t", a: { x: -0.4, z: 0 }, b: { x: 0.4, z: 0 } }],
    undefined,
    [{ wallId: "t", center }],
  );
  assertEquals(gaps.length, 1);
  assertAlmostEquals(gaps[0]!.a.x, -0.4, 1e-6);
  assertAlmostEquals(gaps[0]!.b.x, 0.4, 1e-6);
});

Deno.test("a closed sliding door is not a gap until its id is open", () => {
  const wall = { id: "w", a, b };
  const door = { id: "d", wallId: "w", center };
  const open = interiorOpeningGaps([wall], undefined, [door]);
  const named = interiorOpeningGaps([wall], undefined, [door], ["d"]);
  const sealed = interiorOpeningGaps([wall], undefined, [door], []);
  const other = interiorOpeningGaps([wall], undefined, [door], ["nope"]);
  assertEquals(named, open);
  assertEquals(sealed, []);
  assertEquals(other, []);
  // No id: still a gap when the caller does not pass a set.
  const legacy = interiorOpeningGaps(
    [wall],
    undefined,
    [{ wallId: "w", center }],
  );
  assertEquals(legacy.length, 1);
  assertEquals(
    interiorOpeningGaps([wall], undefined, [{ wallId: "w", center }], []),
    [],
  );
});
