import type { BotMapDefinition } from "../model/index.ts";
import { runtimeMap } from "../runtime/map.ts";
import { MapCollision } from "./MapCollision.ts";
import { courtyardProbeMapDefinition } from "./courtyardProbeMap.ts";
import { nextRandom } from "../core/random.ts";
import { botWorkSlot } from "../helpers/combat.ts";
import {
  beginCombatLosCacheEpoch,
  canSensePlayer,
  hasLineOfSight,
} from "../helpers/combat.ts";
import { hasAdjacentWallCover } from "../helpers/nav.ts";
import { polesForTeam } from "../../../shared/world/yawPole.ts";
import type { Player } from "../players/Player.ts";
import { getWeapon } from "../../../shared/sim/weapons.ts";

const MISS = -1;
const RNG_SAMPLES = 1024;
const WORK_IDS = ["bot", "bot2", "bot:raid-1"];
const WORK_PERIODS = [2, 3, 4, 10];
const EYE_Y = 1.7;

export type ThinkGraphRngSample = { state: number; value: number };
export type ThinkGraphWorkSample = {
  id: string;
  period: number;
  slot: number;
};
export type ThinkGraphCollisionSample = {
  qx: number;
  qz: number;
  x: number;
  z: number;
  rayT: number;
  rayFullT: number;
  adjacent: number;
};
export type ThinkGraphLosSample = {
  hasLos: number;
  canSense: number;
};
export type ThinkGraphPoleSample = { x: number; z: number };

export type ThinkGraphProbeResult = {
  rng: ThinkGraphRngSample[];
  work: ThinkGraphWorkSample[];
  collision: ThinkGraphCollisionSample[];
  los: ThinkGraphLosSample[];
  wallPoleCount: number;
  enemyDoorPoleCount: number;
  poles: ThinkGraphPoleSample[];
};

function distanceOrMiss(value: number | null): number {
  return value === null ? MISS : value;
}

function probePlayer(
  id: string,
  team: "A" | "B",
  x: number,
  z: number,
): Player {
  const weapon = getWeapon(1);
  return {
    id,
    team,
    alive: true,
    health: 100,
    x,
    y: EYE_Y,
    z,
    yaw: 0,
    pitch: 0,
    crouch: false,
    onGround: true,
    spawnedAtTick: 10,
    sprintStamina: 1,
    velocityX: 0,
    velocityY: 0,
    velocityZ: 0,
    moveYaw: null,
    lastShotAtTick: 0,
    isAgent: false,
    isBot: true,
    matchPlayer: false,
    glitchState: "inactive",
    weaponId: 1,
    weapon,
    ammoInMag: 30,
    spareClips: 3,
    reloading: false,
    weapons: [],
    skills: [],
    unlimitedAmmo: true,
  };
}

function pushCollisionSample(
  collision: MapCollision,
  samples: ThinkGraphCollisionSample[],
  qx: number,
  qz: number,
): void {
  const resolved = collision.resolvePosition(qx, qz);
  const origin = { x: qx, y: EYE_Y, z: qz };
  samples.push({
    qx,
    qz,
    x: resolved.x,
    z: resolved.z,
    rayT: distanceOrMiss(
      collision.raycastSolid(origin, { x: 0, y: 0, z: 1 }, 8),
    ),
    rayFullT: distanceOrMiss(
      collision.raycastFullSolid(origin, { x: 1, y: 0, z: 0 }, 8),
    ),
    adjacent: hasAdjacentWallCover(collision, qx, qz) ? 1 : 0,
  });
}

function pushLosPair(
  collision: MapCollision,
  samples: ThinkGraphLosSample[],
  ax: number,
  az: number,
  bx: number,
  bz: number,
): void {
  const from = { x: ax, y: EYE_Y, z: az };
  const to = { x: bx, y: EYE_Y, z: bz };
  const self = probePlayer("bot-a", "A", ax, az);
  const other = probePlayer("bot-b", "B", bx, bz);
  samples.push({
    hasLos: hasLineOfSight(collision, from, to) ? 1 : 0,
    canSense: canSensePlayer(collision, self, other, 180) ? 1 : 0,
  });
}

export function courtyardThinkGraphMap(): BotMapDefinition {
  return courtyardProbeMapDefinition();
}

export function runThinkGraphProbe(): ThinkGraphProbeResult {
  const rng: ThinkGraphRngSample[] = [];
  let state = 1234;
  for (let i = 0; i < RNG_SAMPLES; i++) {
    const sample = nextRandom(state);
    state = sample.state;
    rng.push({ state: sample.state, value: sample.value });
  }

  const work: ThinkGraphWorkSample[] = [];
  for (let i = 0; i < WORK_IDS.length; i++) {
    const id = WORK_IDS[i]!;
    for (let p = 0; p < WORK_PERIODS.length; p++) {
      const period = WORK_PERIODS[p]!;
      work.push({ id, period, slot: botWorkSlot(id, period) });
    }
  }

  const map = runtimeMap(courtyardProbeMapDefinition());
  const collision = new MapCollision(map);
  const samples: ThinkGraphCollisionSample[] = [];
  for (let z = -19; z <= 19; z += 2) {
    for (let x = -19; x <= 19; x += 2) {
      pushCollisionSample(collision, samples, x, z);
    }
  }
  const graze = [
    [0, 4.5],
    [0, 5.5],
    [2.45, 5],
    [-2.45, 5],
    [0, 4],
    [7.5, -0.4],
    [8.4, 0.4],
    [0, -1],
  ];
  for (let i = 0; i < graze.length; i++) {
    const point = graze[i]!;
    pushCollisionSample(collision, samples, point[0]!, point[1]!);
  }

  beginCombatLosCacheEpoch(180);
  const los: ThinkGraphLosSample[] = [];
  pushLosPair(collision, los, 0, -15, 1, -12);
  pushLosPair(collision, los, 0, 3, 0, 7);
  pushLosPair(collision, los, 0, -15, 1, -12);
  pushLosPair(collision, los, 5, -8, -5, -8);

  const poles = polesForTeam(map, "A");
  const poleSamples: ThinkGraphPoleSample[] = [];
  const wallN = poles.wallPoles.length;
  const doorN = poles.enemyDoorPoles.length;
  for (let i = 0; i < wallN; i++) {
    const p = poles.wallPoles[i]!;
    poleSamples.push({ x: p.x, z: p.z });
  }
  for (let i = 0; i < doorN; i++) {
    const p = poles.enemyDoorPoles[i]!;
    poleSamples.push({ x: p.x, z: p.z });
  }

  return {
    rng,
    work,
    collision: samples,
    los,
    wallPoleCount: wallN,
    enemyDoorPoleCount: doorN,
    poles: poleSamples,
  };
}

export function encodeThinkGraphProbeResult(
  result: ThinkGraphProbeResult,
): Uint8Array {
  const bytes = 4 +
    4 + result.rng.length * 16 +
    4 + result.work.length * 8 +
    4 + result.collision.length * 56 +
    4 + result.los.length * 16 +
    8 + result.poles.length * 16;
  const out = new Uint8Array(bytes);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  let offset = 0;
  view.setUint32(offset, 0x54484731, true);
  offset += 4;

  view.setUint32(offset, result.rng.length, true);
  offset += 4;
  for (let i = 0; i < result.rng.length; i++) {
    const sample = result.rng[i]!;
    view.setFloat64(offset, sample.state, true);
    offset += 8;
    view.setFloat64(offset, sample.value, true);
    offset += 8;
  }

  view.setUint32(offset, result.work.length, true);
  offset += 4;
  for (let i = 0; i < result.work.length; i++) {
    const sample = result.work[i]!;
    view.setUint32(offset, sample.period, true);
    offset += 4;
    view.setUint32(offset, sample.slot, true);
    offset += 4;
  }

  view.setUint32(offset, result.collision.length, true);
  offset += 4;
  for (let i = 0; i < result.collision.length; i++) {
    const sample = result.collision[i]!;
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
    view.setFloat64(offset, sample.adjacent, true);
    offset += 8;
  }

  view.setUint32(offset, result.los.length, true);
  offset += 4;
  for (let i = 0; i < result.los.length; i++) {
    const sample = result.los[i]!;
    view.setFloat64(offset, sample.hasLos, true);
    offset += 8;
    view.setFloat64(offset, sample.canSense, true);
    offset += 8;
  }

  view.setUint32(offset, result.wallPoleCount, true);
  offset += 4;
  view.setUint32(offset, result.enemyDoorPoleCount, true);
  offset += 4;
  for (let i = 0; i < result.poles.length; i++) {
    const sample = result.poles[i]!;
    view.setFloat64(offset, sample.x, true);
    offset += 8;
    view.setFloat64(offset, sample.z, true);
    offset += 8;
  }
  return out;
}

export function decodeThinkGraphProbeResult(
  bytes: Uint8Array,
): ThinkGraphProbeResult {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  const magic = view.getUint32(offset, true);
  offset += 4;
  if (magic !== 0x54484731) {
    throw new Error(`think-graph probe magic mismatch: ${magic}`);
  }

  const rngCount = view.getUint32(offset, true);
  offset += 4;
  const rng: ThinkGraphRngSample[] = [];
  for (let i = 0; i < rngCount; i++) {
    const state = view.getFloat64(offset, true);
    offset += 8;
    const value = view.getFloat64(offset, true);
    offset += 8;
    rng.push({ state, value });
  }

  const workCount = view.getUint32(offset, true);
  offset += 4;
  const work: ThinkGraphWorkSample[] = [];
  for (let i = 0; i < workCount; i++) {
    const period = view.getUint32(offset, true);
    offset += 4;
    const slot = view.getUint32(offset, true);
    offset += 4;
    work.push({ id: "", period, slot });
  }

  const collisionCount = view.getUint32(offset, true);
  offset += 4;
  const collision: ThinkGraphCollisionSample[] = [];
  for (let i = 0; i < collisionCount; i++) {
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
    const adjacent = view.getFloat64(offset, true);
    offset += 8;
    collision.push({ qx, qz, x, z, rayT, rayFullT, adjacent });
  }

  const losCount = view.getUint32(offset, true);
  offset += 4;
  const los: ThinkGraphLosSample[] = [];
  for (let i = 0; i < losCount; i++) {
    const hasLos = view.getFloat64(offset, true);
    offset += 8;
    const canSense = view.getFloat64(offset, true);
    offset += 8;
    los.push({ hasLos, canSense });
  }

  const wallPoleCount = view.getUint32(offset, true);
  offset += 4;
  const enemyDoorPoleCount = view.getUint32(offset, true);
  offset += 4;
  const poles: ThinkGraphPoleSample[] = [];
  const poleCount = wallPoleCount + enemyDoorPoleCount;
  for (let i = 0; i < poleCount; i++) {
    const x = view.getFloat64(offset, true);
    offset += 8;
    const z = view.getFloat64(offset, true);
    offset += 8;
    poles.push({ x, z });
  }

  return {
    rng,
    work,
    collision,
    los,
    wallPoleCount,
    enemyDoorPoleCount,
    poles,
  };
}
