import type { BotMapDefinition } from "../model/index.ts";
import { runtimeMap } from "../runtime/map.ts";
import { MapCollision } from "./MapCollision.ts";

const MISS = -1;

export function collisionProbeMapDefinition(): BotMapDefinition {
  return {
    id: "collision-probe",
    revision: "collision-probe:1",
    formatVersion: 2,
    bounds: { minX: -20, maxX: 20, minZ: -16, maxZ: 16 },
    teamA: { edge: "south", doorHalfWidth: 2.5, spawnRadius: 3 },
    teamB: { edge: "north", doorHalfWidth: 2.5, spawnRadius: 3 },
    walls: [
      { id: "mid", ax: -8, az: 0, bx: 8, bz: 0, kind: "full" },
      { id: "tee", ax: 8, az: 0, bx: 8, bz: 8, kind: "full" },
      { id: "neg", ax: -12, az: -8, bx: -4, bz: -8, kind: "full" },
      { id: "half", ax: -6, az: 6, bx: 0, bz: 6, kind: "half" },
      { id: "float", ax: 2, az: -6, bx: 8, bz: -6, kind: "float" },
    ],
    wallCorners: [
      { x: -8, z: 0 },
      { x: 8, z: 0 },
      { x: 8, z: 8 },
      { x: -12, z: -8 },
      { x: -4, z: -8 },
    ],
    hints: { nudges: [], camps: [], sprints: [], spawns: [], stuck: [] },
  };
}

export type CollisionProbeSample = {
  qx: number;
  qz: number;
  x: number;
  z: number;
  rayT: number;
  rayFullT: number;
};

function distanceOrMiss(value: number | null): number {
  return value === null ? MISS : value;
}

export function runCollisionProbe(
  collision: MapCollision,
): CollisionProbeSample[] {
  const queries: Array<{
    x: number;
    z: number;
    dx: number;
    dz: number;
    range: number;
  }> = [
    { x: 0, z: -8, dx: 0, dz: 1, range: 20 },
    { x: 0, z: -1, dx: 0, dz: 1, range: 8 },
    { x: -7.5, z: -0.4, dx: 1, dz: 0, range: 12 },
    { x: 7.6, z: 0.4, dx: 1, dz: 0, range: 4 },
    { x: 8.4, z: 0.4, dx: -1, dz: 0, range: 4 },
    { x: -8, z: -7.5, dx: 0, dz: -1, range: 6 },
    { x: -3, z: 5.5, dx: 0, dz: 1, range: 4 },
    { x: 5, z: -5.5, dx: 0, dz: -1, range: 4 },
    { x: 7.5, z: -0.5, dx: 1, dz: 1, range: 3 },
    { x: 0, z: 0.5, dx: 0, dz: 1, range: 20 },
    { x: -19, z: 0, dx: 1, dz: 0, range: 4 },
    { x: 0, z: 15, dx: 0, dz: 1, range: 8 },
  ];
  const samples: CollisionProbeSample[] = [];
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i]!;
    const resolved = collision.resolvePosition(q.x, q.z);
    const origin = { x: q.x, y: 1, z: q.z };
    const dir = { x: q.dx, y: 0, z: q.dz };
    samples.push({
      qx: q.x,
      qz: q.z,
      x: resolved.x,
      z: resolved.z,
      rayT: distanceOrMiss(collision.raycastSolid(origin, dir, q.range)),
      rayFullT: distanceOrMiss(
        collision.raycastFullSolid(origin, dir, q.range),
      ),
    });
  }
  return samples;
}

export function createCollisionProbeCollision(): MapCollision {
  return new MapCollision(runtimeMap(collisionProbeMapDefinition()));
}

export function encodeCollisionProbeResult(
  samples: readonly CollisionProbeSample[],
): Uint8Array {
  const bytes = new Uint8Array(4 + samples.length * 48);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(0, samples.length, true);
  let offset = 4;
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i]!;
    view.setFloat64(offset, sample.qx, true);
    offset += 8;
    view.setFloat64(offset, sample.qz, true);
    offset += 8;
    view.setFloat64(offset, sample.x, true);
    offset += 8;
    view.setFloat64(offset, sample.z, true);
    offset += 8;
    view.setFloat64(offset, sample.rayT, true);
    offset += 8;
    view.setFloat64(offset, sample.rayFullT, true);
    offset += 8;
  }
  return bytes;
}

export function decodeCollisionProbeResult(
  bytes: Uint8Array,
): CollisionProbeSample[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(0, true);
  const samples: CollisionProbeSample[] = [];
  let offset = 4;
  for (let i = 0; i < count; i++) {
    const qx = view.getFloat64(offset, true);
    offset += 8;
    const qz = view.getFloat64(offset, true);
    offset += 8;
    const x = view.getFloat64(offset, true);
    offset += 8;
    const z = view.getFloat64(offset, true);
    offset += 8;
    const rayT = view.getFloat64(offset, true);
    offset += 8;
    const rayFullT = view.getFloat64(offset, true);
    offset += 8;
    samples.push({ qx, qz, x, z, rayT, rayFullT });
  }
  return samples;
}
