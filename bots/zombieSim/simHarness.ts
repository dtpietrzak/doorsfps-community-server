/**
 * Test and bench support: a tiny world around the real think engine.
 * {@link walkOneSimTick} is kinematic: pawns walk where the brain's keys
 * say, through the same engine collision the brains read, with no gravity.
 * {@link simOneTick} runs the real shared `stepMove` (jump arc included) on
 * any collision, for window climbs. Neither has pawn-vs-pawn push.
 */
import { ZOMBIE_BOT_CONFIG } from "@doors/bot-spec/config";
import type {
  BotInputIntent,
  BotMapDefinition,
  PlayerSnapshot,
  ThinkFrame,
} from "../engine/model/index.ts";
import { runtimeMap } from "../engine/runtime/map.ts";
import { MapCollision } from "../engine/world/MapCollision.ts";
import { DT } from "../../shared/sim/game.ts";
import {
  createMoveState,
  type MoveCollision,
  type MoveState,
  stepMove,
} from "../../shared/sim/moveStep.ts";
import {
  stepWindowCrawl,
  tryStartWindowCrawl,
  type WindowCrawlPortal,
  type WindowCrawlState,
} from "../../shared/zombots/windowCrawl.ts";

/** Sim rate and per-tick step; mirrors shared/sim/game.ts WALK_SPEED. */
export const HARNESS_SIM_HZ = 60;
export const HARNESS_WALK_SPEED = 6;

export type SimPawn = {
  id: string;
  kind: "human" | "bot";
  team: "A" | "B";
  x: number;
  z: number;
  yaw: number;
  pitch: number;
  spawnedAtTick: number;
  input: BotInputIntent | null;
  /** Fraction of walk speed, e.g. a zombie's speed scale. */
  speedScale: number;
  /** Full mobility pose once {@link simOneTick} has moved this pawn. */
  move?: MoveState;
  /** Active hardcoded window crawl (zombots). */
  windowCrawl?: WindowCrawlState | null;
  /** Observed crawl variants triggered during tests. */
  crawlsStarted?: number[];
};

export function simPawn(
  id: string,
  kind: SimPawn["kind"],
  x: number,
  z: number,
  extra: Partial<SimPawn> = {},
): SimPawn {
  return {
    id,
    kind,
    team: kind === "human" ? "A" : "B",
    x,
    z,
    yaw: 0,
    pitch: 0,
    spawnedAtTick: 10,
    input: null,
    speedScale: 1,
    ...extra,
  };
}

export function snapshotOf(p: SimPawn): PlayerSnapshot {
  return {
    id: p.id,
    kind: p.kind,
    team: p.team,
    alive: true,
    health: 100,
    score: 0,
    spawnedAtTick: p.spawnedAtTick,
    x: p.x,
    y: p.move ? p.move.y : 1.7,
    z: p.z,
    velocityX: 0,
    velocityY: 0,
    velocityZ: 0,
    yaw: p.yaw,
    pitch: p.pitch,
    crouch: p.move ? p.move.crouch : false,
    onGround: p.move ? p.move.onGround : true,
    sprintStamina: 1,
    weapon: {
      id: 1,
      ammoInMagazine: 12,
      spareClips: 3,
      reloading: false,
      lastShotTick: 0,
    },
    skills: [],
  };
}

export function frameOf(
  tick: number,
  revision: string,
  pawns: readonly SimPawn[],
  open?: readonly string[],
): ThinkFrame {
  return {
    tick,
    simDelta: 3,
    mapRevision: revision,
    doorsOpen: true,
    doorChangeTick: 1,
    teamScoreA: 0,
    teamScoreB: 0,
    players: pawns.map(snapshotOf),
    ...(open === undefined ? {} : { openSlidingDoorIds: open }),
  };
}

/** The harness's own collision, with the same doors opened as the frame. */
export function harnessCollision(def: BotMapDefinition): MapCollision {
  return new MapCollision(runtimeMap(def));
}

/** One sim tick of the pawn's held keys. Look snaps to the command. */
export function walkOneSimTick(c: MapCollision, p: SimPawn): void {
  const input = p.input;
  if (input === null) return;
  p.yaw = input.yaw;
  p.pitch = input.pitch;
  const sin = Math.sin(input.yaw);
  const cos = Math.cos(input.yaw);
  let mx = 0;
  let mz = 0;
  if (input.forward) {
    mx -= sin;
    mz -= cos;
  }
  if (input.backward) {
    mx += sin;
    mz += cos;
  }
  if (input.left) {
    mx -= cos;
    mz += sin;
  }
  if (input.right) {
    mx += cos;
    mz -= sin;
  }
  const len = Math.sqrt(mx * mx + mz * mz);
  if (len < 1e-6) return;
  const step = HARNESS_WALK_SPEED * p.speedScale / HARNESS_SIM_HZ / len;
  const next = c.resolvePosition(p.x + mx * step, p.z + mz * step);
  p.x = next.x;
  p.z = next.z;
}

/**
 * One fixed sim tick of the pawn's held keys through the shared `stepMove`,
 * the same step `Player` runs on the server. Pass the collision that body
 * moves through (a server `bodyCollision(...)` view, say).
 */
export function simOneTick(
  c: MoveCollision,
  p: SimPawn,
  crawl?: { portals: readonly WindowCrawlPortal[]; tick: number },
): void {
  const before = p.move ?? createMoveState({ x: p.x, z: p.z });
  before.x = p.x;
  before.z = p.z;
  const input = p.input;
  if (input !== null && !p.windowCrawl) {
    p.yaw = input.yaw;
    p.pitch = input.pitch;
  }
  if (crawl && !p.windowCrawl && before.onGround && input !== null) {
    const sin = Math.sin(input.yaw);
    const cos = Math.cos(input.yaw);
    let mx = 0;
    let mz = 0;
    if (input.forward) {
      mx -= sin;
      mz -= cos;
    }
    if (input.backward) {
      mx += sin;
      mz += cos;
    }
    if (input.left) {
      mx -= cos;
      mz += sin;
    }
    if (input.right) {
      mx += cos;
      mz -= sin;
    }
    const len = Math.sqrt(mx * mx + mz * mz);
    if (len > 1e-6) {
      const invLen = 1 / len;
      const started = tryStartWindowCrawl(
        crawl.portals,
        { x: before.x, z: before.z },
        { x: mx * invLen, z: mz * invLen },
        p.id,
        crawl.tick,
      );
      if (started) {
        p.windowCrawl = started;
        if (!p.crawlsStarted) p.crawlsStarted = [];
        p.crawlsStarted.push(started.variant);
      }
    }
  }
  if (p.windowCrawl) {
    const stepped = stepWindowCrawl(p.windowCrawl);
    before.x = stepped.pose.x;
    before.y = stepped.pose.y;
    before.z = stepped.pose.z;
    before.velocityY = 0;
    before.onGround = stepped.pose.onGround;
    before.crouch = false;
    p.yaw = stepped.pose.yaw;
    p.pitch = stepped.pose.pitch;
    p.move = before;
    p.x = before.x;
    p.z = before.z;
    if (stepped.done) p.windowCrawl = null;
    return;
  }
  const { state } = stepMove(
    before,
    input === null ? null : {
      forward: input.forward,
      backward: input.backward,
      left: input.left,
      right: input.right,
      jump: input.jump,
      sprint: input.sprint,
      crouch: input.crouch,
      yaw: input.yaw,
    },
    c,
    { dt: DT, moveSpeedScale: p.speedScale },
  );
  p.move = state;
  p.x = state.x;
  p.z = state.z;
}

export const ZOMBIE_CONFIG = ZOMBIE_BOT_CONFIG;
