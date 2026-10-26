import { abs, max, min } from "./scalar.ts";

export type Normalized2 = Readonly<{ x: number; z: number; length: number }>;
export type Normalized3 = Readonly<{
  x: number;
  y: number;
  z: number;
  length: number;
}>;

export function distanceSquared2(dx: number, dz: number): number {
  return dx * dx + dz * dz;
}

export function distanceSquared3(dx: number, dy: number, dz: number): number {
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Deterministic positive square root without the global sqrt.
 *
 * Power-of-four normalization gives Newton iteration a useful starting range.
 * This is for normalization and distances whose actual magnitude is required;
 * comparisons should prefer squared distance and avoid the root entirely.
 */
export function fastSqrt(value: number): number {
  if (value <= 0) return 0;

  let normalized = value;
  let scale = 1;
  while (normalized >= 4) {
    normalized *= 0.25;
    scale *= 2;
  }
  while (normalized < 1) {
    normalized *= 4;
    scale *= 0.5;
  }

  let root = (normalized + 1) * 0.5;
  root = (root + normalized / root) * 0.5;
  root = (root + normalized / root) * 0.5;
  root = (root + normalized / root) * 0.5;
  return root * scale;
}

export function distance2(dx: number, dz: number): number {
  return fastSqrt(distanceSquared2(dx, dz));
}

export function distance3(dx: number, dy: number, dz: number): number {
  return fastSqrt(distanceSquared3(dx, dy, dz));
}

/**
 * Root-free 2D distance for scoring, ranking, and loose thresholds.
 * Maximum relative error is about 4%; do not use for collision resolution.
 */
export function approximateDistance2(dx: number, dz: number): number {
  const ax = abs(dx);
  const az = abs(dz);
  const largest = max(ax, az);
  const smallest = min(ax, az);
  return 0.960433870103 * largest + 0.397824734759 * smallest;
}

export function normalize2(x: number, z: number): Normalized2 {
  const length = distance2(x, z);
  if (length <= 0.000000001) return { x: 0, z: 0, length: 0 };
  return { x: x / length, z: z / length, length };
}

export function normalize3(x: number, y: number, z: number): Normalized3 {
  const length = distance3(x, y, z);
  if (length <= 0.000000001) return { x: 0, y: 0, z: 0, length: 0 };
  return { x: x / length, y: y / length, z: z / length, length };
}
