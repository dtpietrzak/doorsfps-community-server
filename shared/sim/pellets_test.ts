import { assert, assertAlmostEquals, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import {
  PELLET_JITTER_RADIUS_FRAC,
  PELLET_RING_RADIUS_FRAC,
  pelletCount,
  pelletDirections,
  pelletDrawCount,
} from "./pellets.ts";
import type { HitVec3 as Vec3 } from "./playerHitVolumes.ts";
import { PISTOL, RIFLE, type WeaponDef } from "./weapons.ts";

/** Shotgun-shaped fixture; the real def lands in PR 3. */
const SCATTER: WeaponDef = {
  ...PISTOL,
  id: 99,
  name: "Scatter",
  pellets: 8,
  pelletSpreadDeg: 4.5,
};

const DEG = Math.PI / 180;

function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

function countingRng(inner: () => number): { rng: () => number; draws: () => number } {
  let n = 0;
  return {
    rng: () => {
      n++;
      return inner();
    },
    draws: () => n,
  };
}

function throwingRng(): number {
  throw new Error("rng must not be called");
}

function angleBetween(a: Vec3, b: Vec3): number {
  const dot = a.x * b.x + a.y * b.y + a.z * b.z;
  return Math.acos(Math.min(1, Math.max(-1, dot)));
}

function norm(v: Vec3): Vec3 {
  const len = Math.hypot(v.x, v.y, v.z);
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

const AIMS: Vec3[] = [
  { x: 0, y: 0, z: -1 },
  { x: 1, y: 0, z: 0 },
  norm({ x: 0.3, y: -0.4, z: 0.8 }),
  norm({ x: -2, y: 5, z: 1 }),
  { x: 0, y: 1, z: 0 }, // straight up: fallback basis
  { x: 0, y: -1, z: 0 },
];

Deno.test("pelletDirections: single-pellet weapons return the aim and draw nothing", () => {
  for (const weapon of [PISTOL, RIFLE]) {
    assertEquals(pelletCount(weapon), 1);
    assertEquals(pelletDrawCount(weapon, false), 0);
    assertEquals(pelletDrawCount(weapon, true), 0);
    const aim = { x: 0, y: 0, z: -2 };
    assertEquals(pelletDirections(aim, weapon, {}, throwingRng), [{ x: 0, y: 0, z: -1 }]);
    assertEquals(pelletDirections(aim, weapon, { uniform: true }, throwingRng), [
      { x: 0, y: 0, z: -1 },
    ]);
  }
});

Deno.test("pelletDirections: deterministic for a given RNG sequence", () => {
  for (const aim of AIMS) {
    const a = pelletDirections(aim, SCATTER, {}, seededRng(42));
    const b = pelletDirections(aim, SCATTER, {}, seededRng(42));
    assertEquals(a, b);
    const c = pelletDirections(aim, SCATTER, {}, seededRng(7));
    assertNotEquals(a, c);
  }
});

Deno.test("pelletDirections: pellet count, unit length and a centre pellet on the aim", () => {
  for (const aim of AIMS) {
    for (const uniform of [false, true]) {
      const dirs = pelletDirections(aim, SCATTER, { uniform }, seededRng(1));
      assertEquals(dirs.length, 8);
      for (const d of dirs) assertAlmostEquals(Math.hypot(d.x, d.y, d.z), 1, 1e-9);
      assertAlmostEquals(angleBetween(dirs[0]!, norm(aim)), 0, 1e-6);
    }
  }
});

Deno.test("pelletDirections: every pellet stays inside the (scaled) cone", () => {
  for (const coneScale of [1, 0.5]) {
    const half = SCATTER.pelletSpreadDeg! * coneScale * DEG;
    const maxRing = half * (PELLET_RING_RADIUS_FRAC + PELLET_JITTER_RADIUS_FRAC);
    const minRing = half * (PELLET_RING_RADIUS_FRAC - PELLET_JITTER_RADIUS_FRAC);
    const rng = seededRng(123);
    for (let trial = 0; trial < 200; trial++) {
      for (const aim of AIMS) {
        const dirs = pelletDirections(aim, SCATTER, { coneScale }, rng);
        for (const d of dirs.slice(1)) {
          const a = angleBetween(d, norm(aim));
          assert(a <= half, `pellet ${a / DEG}° outside ${half / DEG}° cone`);
          assert(a <= maxRing + 1e-9 && a >= minRing - 1e-9);
        }
      }
    }
  }
});

Deno.test("pelletDirections: extreme RNG values still stay inside the cone", () => {
  const half = SCATTER.pelletSpreadDeg! * DEG;
  for (const v of [0, 0.999999999]) {
    const dirs = pelletDirections({ x: 0, y: 0, z: -1 }, SCATTER, {}, () => v);
    for (const d of dirs) assert(angleBetween(d, { x: 0, y: 0, z: -1 }) <= half);
  }
});

Deno.test("pelletDirections: uniform mode draws nothing and gives an evenly spaced ring", () => {
  for (const aim of AIMS) {
    for (const coneScale of [1, 0.5]) {
      const dirs = pelletDirections(aim, SCATTER, { uniform: true, coneScale }, throwingRng);
      const ring = dirs.slice(1);
      const expected = SCATTER.pelletSpreadDeg! * coneScale * DEG * PELLET_RING_RADIUS_FRAC;
      for (const d of ring) assertAlmostEquals(angleBetween(d, norm(aim)), expected, 1e-9);
      // Evenly spaced: every neighbour pair (wrapping) is the same distance apart.
      const gap = angleBetween(ring[0]!, ring[1]!);
      assert(gap > 0);
      for (let i = 0; i < ring.length; i++) {
        assertAlmostEquals(angleBetween(ring[i]!, ring[(i + 1) % ring.length]!), gap, 1e-9);
      }
      // Same aim → identical pattern every time.
      assertEquals(
        pelletDirections(aim, SCATTER, { uniform: true, coneScale }, throwingRng),
        dirs,
      );
    }
  }
});

Deno.test("pelletDirections: uniform pattern is tighter than normal under Hawkeyes cone scale", () => {
  const aim = { x: 0, y: 0, z: -1 };
  const hawk = pelletDirections(aim, SCATTER, { uniform: true, coneScale: 0.5 }, throwingRng);
  const normal = pelletDirections(aim, SCATTER, {}, seededRng(9));
  const widest = (dirs: Vec3[]) => Math.max(...dirs.map((d) => angleBetween(d, aim)));
  assert(widest(hawk) < widest(normal));
});

Deno.test("pelletDirections: draw count depends only on the mode", () => {
  assertEquals(pelletDrawCount(SCATTER, false), 1 + 7 * 2);
  assertEquals(pelletDrawCount(SCATTER, true), 0);
  const zeroCone: WeaponDef = { ...SCATTER, pelletSpreadDeg: 0 };
  for (const weapon of [SCATTER, zeroCone]) {
    for (const aim of AIMS) {
      for (const coneScale of [1, 0.5, 0]) {
        for (const uniform of [false, true]) {
          const counter = countingRng(seededRng(5));
          pelletDirections(aim, weapon, { uniform, coneScale }, counter.rng);
          assertEquals(counter.draws(), pelletDrawCount(weapon, uniform));
        }
      }
    }
  }
});

Deno.test("pelletDirections: zero cone collapses every pellet onto the aim", () => {
  const zeroCone: WeaponDef = { ...SCATTER, pelletSpreadDeg: 0 };
  const aim = norm({ x: 1, y: 1, z: 1 });
  for (const d of pelletDirections(aim, zeroCone, {}, seededRng(3))) {
    assertAlmostEquals(angleBetween(d, aim), 0, 1e-6);
  }
});
