import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import {
  findClosedWallPolygons,
  type WallPolyPoint,
  type WallSegment,
} from "./wallPolygons.ts";

function areaOf(poly: readonly WallPolyPoint[]): number {
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    area += p.x * q.z - q.x * p.z;
  }
  return Math.abs(area * 0.5);
}

function square(x0: number, z0: number, size: number): WallSegment[] {
  const x1 = x0 + size;
  const z1 = z0 + size;
  return [
    { a: { x: x0, z: z0 }, b: { x: x1, z: z0 } },
    { a: { x: x1, z: z0 }, b: { x: x1, z: z1 } },
    { a: { x: x1, z: z1 }, b: { x: x0, z: z1 } },
    { a: { x: x0, z: z1 }, b: { x: x0, z: z0 } },
  ];
}

const bounds = { minX: -20, maxX: 20, minZ: -20, maxZ: 20 };

Deno.test("a closed square is one closure", () => {
  const polys = findClosedWallPolygons(square(0, 0, 6));
  assertEquals(polys.length, 1);
  assertAlmostEquals(areaOf(polys[0]!), 36, 1e-6);
});

Deno.test("a window or a sliding door opens the square", () => {
  const walls = square(0, 0, 6);
  const windowGap = [{ a: { x: 2.25, z: 0 }, b: { x: 3.75, z: 0 } }];
  assertEquals(findClosedWallPolygons(walls, null, windowGap).length, 0);
  const doorGap = [{ a: { x: 6, z: 2.075 }, b: { x: 6, z: 3.925 } }];
  assertEquals(findClosedWallPolygons(walls, null, doorGap).length, 0);
});

Deno.test("a gap off the wall, or past its end, leaves the square closed", () => {
  const walls = square(0, 0, 6);
  const off = [{ a: { x: 2, z: 0.05 }, b: { x: 4, z: 0.05 } }];
  assertEquals(findClosedWallPolygons(walls, null, off).length, 1);
  const past = [{ a: { x: 7, z: 0 }, b: { x: 9, z: 0 } }];
  assertEquals(findClosedWallPolygons(walls, null, past).length, 1);
});

Deno.test("only the square without an opening is filled", () => {
  const walls = [...square(0, 0, 4), ...square(10, 0, 4)];
  const gap = [{ a: { x: 11, z: 0 }, b: { x: 12.5, z: 0 } }];
  const polys = findClosedWallPolygons(walls, null, gap);
  assertEquals(polys.length, 1);
  assertAlmostEquals(areaOf(polys[0]!), 16, 1e-6);
  const xs = polys[0]!.map((p) => p.x);
  assertEquals(Math.max(...xs) <= 4.01, true);
});

Deno.test("sealed bounds drop the arena and keep the interior room", () => {
  const polys = findClosedWallPolygons(square(0, 0, 4), bounds);
  assertEquals(polys.length, 1);
  assertAlmostEquals(areaOf(polys[0]!), 16, 1e-6);
});

Deno.test("an energy-door gap does not fill the arena", () => {
  const door = [{ a: { x: -2.5, z: -20 }, b: { x: 2.5, z: -20 } }];
  assertEquals(findClosedWallPolygons([], bounds, door).length, 0);
  const polys = findClosedWallPolygons(square(0, 0, 4), bounds, door);
  assertEquals(polys.length, 1);
  assertAlmostEquals(areaOf(polys[0]!), 16, 1e-6);
});

Deno.test("an alcove beside the energy door stays closed; the door pocket does not", () => {
  const door = [{ a: { x: -2.5, z: -20 }, b: { x: 2.5, z: -20 } }];
  const beside = [
    { a: { x: -10, z: -20 }, b: { x: -10, z: -10 } },
    { a: { x: -10, z: -10 }, b: { x: -20, z: -10 } },
  ];
  const kept = findClosedWallPolygons(beside, bounds, door);
  assertEquals(kept.length, 1);
  assertAlmostEquals(areaOf(kept[0]!), 100, 1e-6);

  // Full-width wall. The south pocket uses the door span. The room behind
  // the wall does not, so it stays a closure once the perimeter is open.
  const across = [{ a: { x: -20, z: -10 }, b: { x: 20, z: -10 } }];
  const opened = findClosedWallPolygons(across, bounds, door);
  assertEquals(opened.length, 1);
  assertAlmostEquals(areaOf(opened[0]!), 1200, 1e-6);
  const sealed = findClosedWallPolygons(across, bounds);
  assertEquals(sealed.length, 1);
  assertAlmostEquals(areaOf(sealed[0]!), 400, 1e-6);
});

Deno.test("a side that is entirely an opening is not a closure", () => {
  const walls = square(0, 0, 6);
  const gone = [{ a: { x: 0, z: 0 }, b: { x: 6, z: 0 } }];
  assertEquals(findClosedWallPolygons(walls, null, gone).length, 0);
});
