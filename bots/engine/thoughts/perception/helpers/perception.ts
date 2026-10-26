/**
 * Per-think perception bag for bot brains.
 *
 * Built once after gate so nav / combat / sprint / yaw-pole steps share doors,
 * hostile lists, pole lists, and a memoized full-wall belly LOS probe.
 * Lives on {@link ThinkContext.perception} only — never sticky brain state.
 */

import type { Player } from "../../../players/Player.ts";
import type { MapCollision } from "../../../world/MapCollision.ts";
import type { YawPolePoint } from "../../../../../shared/world/yawPole.ts";
import { polesForTeam } from "../../../../../shared/world/yawPole.ts";
import {
  areHostile,
  BOT_FULL_LOS_EVERY_TICKS,
  botCadenceWorkTick,
  botWorkSlot,
  canSensePlayer,
  isHiddenByGlitch,
  pickCombatAimPoint,
} from "../../../helpers/combat.ts";
import { enemyDoorTarget, ownDoorTarget } from "../../../helpers/nav.ts";
import type { BotWorldView } from "../../../types.ts";
import { wallBlocksYawPoleLos } from "../../yawPole/helpers/yawPole.ts";
import { distance2 } from "../../../math/index.ts";
import {
  createStringBoolCache,
  getStringBool,
  setStringBool,
} from "../../../core/stringBoolCache.ts";

export type PerceivedPlayer = {
  /** Reference into {@link BotWorldView.players} — do not clone. */
  player: Player;
  /** Horizontal xz distance from self. */
  dist: number;
  /**
   * Eye→body aim from this think's sense ray (torso, else head).
   * Only set on {@link BotPerception.sensedHostiles}.
   */
  aim?: { x: number; y: number; z: number };
};

export type HuntGoalPose = {
  x: number;
  z: number;
  playerId: string;
};

export type BotPerception = {
  /** Think tick this bag was built for. */
  tick: number;
  selfId: string;
  doorsOpen: boolean;

  ownDoor: { x: number; z: number };
  enemyDoor: { x: number; z: number };
  distToOwnDoor: number;
  distToEnemyDoor: number;

  /**
   * Living hostiles (team/agent rules), nearest-first. No LOS filter.
   * Glitch-hidden players are omitted (fully invisible to bots).
   */
  hostiles: readonly PerceivedPlayer[];
  /** Hostiles with clear eye→torso LOS (also excludes Glitch-hidden). */
  sensedHostiles: readonly PerceivedPlayer[];
  nearestHostile: PerceivedPlayer | null;
  nearestSensedHostile: PerceivedPlayer | null;

  /**
   * Hunt goal class only (greys for team hunters; non-agents for greys),
   * nearest living, no LOS. Glitch-hidden omitted. Matches
   * {@link nearestHuntGoalFrom} when that path also filters Glitch.
   */
  nearestHuntGoal: HuntGoalPose | null;

  /** One {@link polesForTeam} for this bot. */
  wallPoles: readonly YawPolePoint[];
  enemyDoorPoles: readonly YawPolePoint[];

  /**
   * Per-think memo for full-wall belly LOS (yaw-pole sticky/pick/next).
   * Not shared with combat eye→torso LOS.
   */
  blocksYawPoleLos: (
    ox: number,
    oz: number,
    tx: number,
    tz: number,
  ) => boolean;
};

/** @internal expose for tests — cells per meter for XZ quantization. */
export const YAW_POLE_LOS_CELLS_PER_M = 4;

function quantizeCoord(v: number, cellsPerMeter: number): number {
  return (v * cellsPerMeter + (v >= 0 ? 0.5 : -0.5)) | 0;
}

/**
 * Quantized key for origin→target belly LOS (crouch band in key).
 */
export function yawPoleLosCacheKey(
  ox: number,
  oz: number,
  tx: number,
  tz: number,
  crouch: boolean,
): string {
  const q = (v: number) => quantizeCoord(v, YAW_POLE_LOS_CELLS_PER_M);
  return `${q(ox)},${q(oz)}>${q(tx)},${q(tz)}|${crouch ? 1 : 0}`;
}

/**
 * Memoized full-wall belly LOS for one bot think.
 * Misses call {@link wallBlocksYawPoleLos}; hits return the stored bool.
 */
export function createYawPoleLosMemo(
  collision: MapCollision | null | undefined,
  opts: { crouch: boolean; eyeY: number },
): {
  cacheCount: number;
  blocksYawPoleLos: (
    ox: number,
    oz: number,
    tx: number,
    tz: number,
  ) => boolean;
} {
  const cache = createStringBoolCache();
  const crouch = Boolean(opts.crouch);
  const eyeY = opts.eyeY;
  const memo = {
    cacheCount: 0,
    blocksYawPoleLos: (
      ox: number,
      oz: number,
      tx: number,
      tz: number,
    ): boolean => {
      if (!collision) return false;
      const key = yawPoleLosCacheKey(ox, oz, tx, tz, crouch);
      const hit = getStringBool(cache, key);
      if (hit === 2) return true;
      if (hit === 1) return false;
      const blocked = wallBlocksYawPoleLos(collision, ox, oz, tx, tz, {
        crouch,
        eyeY,
      });
      setStringBool(cache, key, blocked);
      memo.cacheCount = cache.count;
      return blocked;
    },
  };

  return memo;
}

export type BuildBotPerceptionOpts = {
  /** Combat lock — always re-ray even on staggered sense ticks. */
  lockTargetId?: string;
  /**
   * When true, only the lock + nearest hostile get sense rays except on
   * {@link BOT_FULL_LOS_EVERY_TICKS} slots (or {@link forceFullScan}).
   */
  staggerSense?: boolean;
  /** Ignore stagger and ray every hostile (tests / first think). */
  forceFullScan?: boolean;
};

/**
 * Build the per-think perception bag from a frozen world view.
 */
export function buildBotPerception(
  view: BotWorldView,
  opts?: BuildBotPerceptionOpts,
): BotPerception {
  const me = view.self;
  const ownDoor = ownDoorTarget(view.map, me.team);
  const enemyDoor = enemyDoorTarget(view.map, me.team);
  const distToOwnDoor = distance2(me.x - ownDoor.x, me.z - ownDoor.z);
  const distToEnemyDoor = distance2(me.x - enemyDoor.x, me.z - enemyDoor.z);

  const hostiles: PerceivedPlayer[] = [];
  const sensedHostiles: PerceivedPlayer[] = [];
  // Hunt class: team hunters seek greys; grey agents seek non-agents.
  const preferAgents = !me.isAgent;
  let nearestHuntGoal: HuntGoalPose | null = null;
  let bestHuntD2 = 1e30;

  const roster = view.players;
  for (let i = 0; i < roster.length; i++) {
    const p = roster[i]!;
    if (!p.alive || p.id === me.id) continue;
    // Glitch "hidden" = fully invisible: no combat, chase, or hunt knowledge.
    // Door-revealed Glitch still counts as visible (same as remote clients).
    if (isHiddenByGlitch(p)) continue;

    // Hunt-goal class (no hostility/LOS filter — matches nearestHuntGoalFrom).
    if (preferAgents ? p.isAgent : !p.isAgent) {
      const dx = p.x - me.x;
      const dz = p.z - me.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestHuntD2) {
        bestHuntD2 = d2;
        nearestHuntGoal = { x: p.x, z: p.z, playerId: p.id };
      }
    }

    if (!areHostile(me, p)) continue;
    const dist = distance2(p.x - me.x, p.z - me.z);
    hostiles.push({ player: p, dist });
  }

  for (let i = 1; i < hostiles.length; i++) {
    const cur = hostiles[i]!;
    let j = i;
    while (j > 0 && hostiles[j - 1]!.dist > cur.dist) {
      hostiles[j] = hostiles[j - 1]!;
      j -= 1;
    }
    hostiles[j] = cur;
  }

  const lockId = opts?.lockTargetId;
  const every = BOT_FULL_LOS_EVERY_TICKS;
  const workTick = botCadenceWorkTick(view.tick);
  const fullSense = opts?.staggerSense !== true ||
    opts?.forceFullScan === true ||
    workTick % every === botWorkSlot(me.id, every);
  const nearestHostile = hostiles.length > 0 ? hostiles[0]! : null;

  for (let i = 0; i < hostiles.length; i++) {
    const entry = hostiles[i]!;
    const always = entry.player.id === lockId ||
      (nearestHostile !== null && entry.player.id === nearestHostile.player.id);
    if (!fullSense && !always) continue;
    if (canSensePlayer(view.collision, me, entry.player, view.tick)) {
      const eye = { x: me.x, y: me.y, z: me.z };
      const aim = pickCombatAimPoint(view.collision, eye, entry.player);
      if (aim) {
        sensedHostiles.push({
          player: entry.player,
          dist: entry.dist,
          aim,
        });
      } else {
        sensedHostiles.push({ player: entry.player, dist: entry.dist });
      }
    }
  }

  const { wallPoles, enemyDoorPoles } = polesForTeam(view.map, me.team);
  const losMemo = createYawPoleLosMemo(view.collision, {
    crouch: Boolean(me.crouch),
    eyeY: me.y,
  });
  const nearestSensedHostile = sensedHostiles.length > 0
    ? sensedHostiles[0]!
    : null;

  return {
    tick: view.tick,
    selfId: me.id,
    doorsOpen: Boolean(view.doorsOpen),
    ownDoor: { x: ownDoor.x, z: ownDoor.z },
    enemyDoor: { x: enemyDoor.x, z: enemyDoor.z },
    distToOwnDoor,
    distToEnemyDoor,
    hostiles,
    sensedHostiles,
    nearestHostile,
    nearestSensedHostile,
    nearestHuntGoal,
    wallPoles,
    enemyDoorPoles,
    blocksYawPoleLos: losMemo.blocksYawPoleLos,
  };
}
