/**
 * Shared bot combat helpers (LOS, aim, hostility, ammo).
 */

import {
  shellReloadOf,
  WEAPON_ORDER,
  WEAPON_PISTOL,
  WEAPON_RIFLE,
  WEAPON_SHOTGUN,
} from "../../../shared/sim/weapons.ts";
import { headHitOffsetFromFeet } from "../../../shared/sim/aimPitchVisual.ts";
import {
  MOVE_CROUCH_EYE as CROUCH_EYE_HEIGHT,
  MOVE_STAND_EYE as STAND_EYE_HEIGHT,
} from "../../../shared/sim/moveStep.ts";
import { abs, distance3, floor, max } from "../math/index.ts";
import {
  clearStringBoolCache,
  createStringBoolCache,
  getStringBool,
  setStringBool,
} from "../core/stringBoolCache.ts";
import {
  playerAmmoInMagFor,
  playerSpareClipsFor,
  type Player,
} from "../players/Player.ts";
import type { MapCollision } from "../world/MapCollision.ts";
import { botTickPhase, SIM_TICKS_PER_BOT_TICK } from "../types.ts";

/**
 * Whether two players should fight each other.
 * - Normal red vs blue: different teams.
 * - Agents (grey hunters) are hostile to every non-agent, friendly to each other.
 */
export function areHostile(
  a: Pick<Player, "id" | "team" | "isAgent">,
  b: Pick<Player, "id" | "team" | "isAgent">,
): boolean {
  if (a.id === b.id) return false;
  if (a.isAgent || b.isAgent) {
    return a.isAgent !== b.isAgent;
  }
  return a.team !== b.team;
}

/** Horizontal range (u) at/under which bots prefer a loaded shotgun. */
export const BOT_CLOSE_SHOTGUN_RANGE = 10;

/** Horizontal range (u) at/over which bots prefer a loaded rifle. */
export const BOT_LONG_RIFLE_RANGE = 20;

/**
 * Band edges shift this far (u) toward the gun already in hand, so a lock
 * hovering on an edge does not flip guns (and eat a draw) every think.
 */
export const BOT_WEAPON_RANGE_HYSTERESIS = 2;

const CLOSE_PREFERENCE = [WEAPON_SHOTGUN, WEAPON_PISTOL, WEAPON_RIFLE] as const;
const MID_PREFERENCE = [WEAPON_PISTOL, WEAPON_RIFLE, WEAPON_SHOTGUN] as const;
const LONG_PREFERENCE = [WEAPON_RIFLE, WEAPON_PISTOL, WEAPON_SHOTGUN] as const;

/**
 * Gun preference for a lock at `lockDist`: shotgun inside
 * {@link BOT_CLOSE_SHOTGUN_RANGE}, rifle from {@link BOT_LONG_RIFLE_RANGE},
 * pistol between. Edges lean toward `currentWeaponId`.
 */
export function botWeaponPreferenceForRange(
  lockDist: number,
  currentWeaponId: number,
): readonly number[] {
  const m = BOT_WEAPON_RANGE_HYSTERESIS;
  const closeEdge = BOT_CLOSE_SHOTGUN_RANGE +
    (currentWeaponId === WEAPON_SHOTGUN ? m : -m);
  const longEdge = BOT_LONG_RIFLE_RANGE +
    (currentWeaponId === WEAPON_RIFLE ? -m : m);
  if (lockDist <= closeEdge) return CLOSE_PREFERENCE;
  if (lockDist >= longEdge) return LONG_PREFERENCE;
  return MID_PREFERENCE;
}

/**
 * Pick a loaded gun for this think. With a lock, the first loaded gun in
 * the range preference ({@link botWeaponPreferenceForRange}); otherwise
 * keep the active gun while it has rounds. Empty active mag falls back to
 * any holstered mag. Returns null if unlimited, the chosen gun is already
 * equipped, or nothing has rounds.
 */
export function pickBotWeaponSwitch(
  p: Player,
  opts?: { lockDist?: number },
): number | null {
  if (p.unlimitedAmmo) return null;

  const lockDist = opts?.lockDist;
  if (typeof lockDist === "number" && Number.isFinite(lockDist)) {
    const order = botWeaponPreferenceForRange(lockDist, p.weaponId);
    for (let i = 0; i < order.length; i++) {
      const id = order[i]!;
      if (playerAmmoInMagFor(p, id) > 0) {
        return id === p.weaponId ? null : id;
      }
    }
    return null;
  }
  if (p.ammoInMag > 0) return null;

  if (
    p.weaponId !== WEAPON_RIFLE &&
    playerAmmoInMagFor(p, WEAPON_RIFLE) > 0
  ) {
    return WEAPON_RIFLE;
  }
  for (let i = 0; i < WEAPON_ORDER.length; i++) {
    const id = WEAPON_ORDER[i]!;
    if (id === p.weaponId) continue;
    if (playerAmmoInMagFor(p, id) > 0) return id;
  }
  return null;
}

/**
 * True when the bot should emit reload this think:
 * - active mag empty, spare clips remain, and no holstered gun still has a
 *   loaded mag (those switch instead so the bot keeps shooting); or
 * - `idle` (no combat lock) with a shell gun in hand whose tube has room
 *   and spare shells remain. A fire click mid-load interrupts it (server
 *   shell reload), so an enemy showing up never waits on the tube.
 * Never while already reloading.
 */
export function wantsBotReload(
  p: Player,
  opts?: { idle?: boolean },
): boolean {
  if (p.unlimitedAmmo) return false;
  if (p.reloading) return false;
  if (p.spareClips <= 0) return false;
  if (p.ammoInMag > 0) {
    return Boolean(opts?.idle) &&
      shellReloadOf(p.weapon) !== null &&
      p.ammoInMag < p.weapon.magSize;
  }
  for (let i = 0; i < WEAPON_ORDER.length; i++) {
    const id = WEAPON_ORDER[i]!;
    if (id === p.weaponId) continue;
    if (playerAmmoInMagFor(p, id) > 0) return false;
  }
  return true;
}

/**
 * True when nothing can fire or be reloaded: every mag empty and no spare
 * clips on any gun. Unlimited ammo never unarmed.
 */
export function isUnarmedForCombat(
  p: Player,
): boolean {
  if (p.unlimitedAmmo) return false;
  if (p.ammoInMag > 0 || p.spareClips > 0) return false;
  for (let i = 0; i < WEAPON_ORDER.length; i++) {
    const id = WEAPON_ORDER[i]!;
    if (
      playerAmmoInMagFor(p, id) > 0 ||
      playerSpareClipsFor(p, id) > 0
    ) {
      return false;
    }
  }
  return true;
}

function feetY(p: Player): number {
  const eyeH = p.crouch ? CROUCH_EYE_HEIGHT : STAND_EYE_HEIGHT;
  return p.y - eyeH;
}

/**
 * Per AI-segment LOS board. Static geometry + frozen player snapshot for the
 * think drain make repeated eye→aim / pair queries shareable across bots and
 * helpers (sense / chase). Call {@link beginCombatLosCacheEpoch} once per
 * bot-official drain.
 */
let combatLosEpoch = -1;
/** Geometric hasLineOfSight results (quantized eye→aim). */
const geometricLosCache = createStringBoolCache();
/** canSensePlayer(self, other) by id pair. */
const sensePairCache = createStringBoolCache();

/** Start / advance the shared combat LOS board for this AI segment. */
export function beginCombatLosCacheEpoch(tick: number): void {
  const t = tick | 0;
  if (t === combatLosEpoch) return;
  combatLosEpoch = t;
  clearStringBoolCache(geometricLosCache);
  clearStringBoolCache(sensePairCache);
}

/** @internal test helper — drop LOS board between cases. */
export function clearCombatLosCache(): void {
  combatLosEpoch = -1;
  clearStringBoolCache(geometricLosCache);
  clearStringBoolCache(sensePairCache);
}

function quantizeLosCoord(v: number, cellsPerMeter: number): number {
  return (v * cellsPerMeter + (v >= 0 ? 0.5 : -0.5)) | 0;
}

function geometricLosKey(
  from: { x: number; y: number; z: number },
  to: { x: number; y: number; z: number },
): string {
  // 0.25 m XZ / 0.125 m Y — enough hits for re-queries without grazing flips.
  const qxz = (v: number) => quantizeLosCoord(v, 4);
  const qy = (v: number) => quantizeLosCoord(v, 8);
  return `${qxz(from.x)},${qy(from.y)},${qxz(from.z)}>${qxz(to.x)},${
    qy(to.y)
  },${qxz(to.z)}`;
}

/**
 * True when a solid wall is closer than the target along the eye→body ray.
 * Half-walls only block if the ray hits their slab (eye-height shots often clear).
 * Full walls always occlude: bots must not aim, chase, peel, or yaw-lock
 * onto anything on the far side.
 *
 * When {@link beginCombatLosCacheEpoch} is active, results are memoized for the
 * epoch (quantized endpoints) so multi-helper / multi-bot queries share rays.
 */
export function hasLineOfSight(
  collision: MapCollision,
  from: { x: number; y: number; z: number },
  to: { x: number; y: number; z: number },
): boolean {
  const useCache = combatLosEpoch >= 0;
  let key = "";
  if (useCache) {
    key = geometricLosKey(from, to);
    const hit = getStringBool(geometricLosCache, key);
    if (hit === 2) return true;
    if (hit === 1) return false;
  }

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const dist = distance3(dx, dy, dz);
  if (dist < 0.05) {
    if (useCache) setStringBool(geometricLosCache, key, true);
    return true;
  }
  const wallDist = collision.raycastSolid(
    from,
    { x: dx, y: dy, z: dz },
    dist,
  );
  // Allow a small epsilon so grazing wall edges don't false-block.
  const clear = wallDist === null || wallDist >= dist - 0.08;
  if (useCache) setStringBool(geometricLosCache, key, clear);
  return clear;
}

/** Combat reticle height preference (latched per lock by combatPitch). */
export type CombatAimHeight = "head" | "torso";

/**
 * Prefer torso aim; if half-cover clips it, fall back to head so standing
 * enemies behind half walls stay visible. Full walls still block both.
 * Returns null when no clear eye→body ray exists.
 */
export function pickCombatAimPoint(
  collision: MapCollision,
  eye: { x: number; y: number; z: number },
  target: Player,
): { x: number; y: number; z: number } | null {
  return pickCombatAimPointPreferred(collision, eye, target, "torso");
}

/**
 * Aim point with sticky height preference. Preferred height first; if that
 * ray is blocked (half cover), fall back to the other clear height so the
 * lock does not die. Full walls still block both.
 */
export function pickCombatAimPointPreferred(
  collision: MapCollision,
  eye: { x: number; y: number; z: number },
  target: Player,
  prefer: CombatAimHeight,
): { x: number; y: number; z: number } | null {
  const torso = aimPointOnPlayer(target);
  const head = aimPointHead(target);
  if (prefer === "head") {
    if (hasLineOfSight(collision, eye, head)) return head;
    if (hasLineOfSight(collision, eye, torso)) return torso;
    return null;
  }
  if (hasLineOfSight(collision, eye, torso)) return torso;
  if (hasLineOfSight(collision, eye, head)) return head;
  return null;
}

/**
 * True when Glitch fully hides `player` from remote observers (bots + other
 * clients). Matches wire `glitch: "hidden"` — door-revealed Glitch still
 * counts as visible.
 */
export function isHiddenByGlitch(
  player: Player,
): boolean {
  return player.glitchState === "hidden";
}

/**
 * Whether `self` can sense another player (eye → torso, else head).
 * Full walls between them = no knowledge: no chase, spacing, or look-at.
 * Half walls only hide what they actually occlude — standing foes remain
 * visible over the slab; crouched cover still works when both rays hit it.
 * Glitch-hidden players are never sensed when `tick` is provided.
 */
export function canSensePlayer(
  collision: MapCollision,
  self: Player,
  other: Player,
  tick?: number,
): boolean {
  if (!other.alive || other.id === self.id) return false;
  if (
    typeof tick === "number" &&
    isHiddenByGlitch(other)
  ) {
    return false;
  }
  const useCache = combatLosEpoch >= 0;
  let pairKey = "";
  if (useCache) {
    pairKey = `${self.id}\0${other.id}`;
    const hit = getStringBool(sensePairCache, pairKey);
    if (hit === 2) return true;
    if (hit === 1) return false;
  }
  const eye = { x: self.x, y: self.y, z: self.z };
  const ok = pickCombatAimPoint(collision, eye, other) !== null;
  if (useCache) setStringBool(sensePairCache, pairKey, ok);
  return ok;
}

/**
 * Aim point: upper body for reliable body hits (hard tier).
 * Standing torso (~1.1) sits below half-wall tops (1.2) — use
 * {@link pickCombatAimPoint} when LOS may clip half cover.
 */
export function aimPointOnPlayer(
  target: Player,
): { x: number; y: number; z: number } {
  const fy = feetY(target);
  // Chest / upper torso — between body mid and head.
  const bodyY = fy + (target.crouch ? 0.55 : 1.1);
  return { x: target.x, y: bodyY, z: target.z };
}

/** Head-height aim (peek over half walls when torso ray is occluded). */
export function aimPointHead(
  target: Player,
): { x: number; y: number; z: number } {
  const fy = feetY(target);
  const off = headHitOffsetFromFeet({
    yaw: target.yaw,
    pitch: target.pitch,
    crouch: target.crouch,
  });
  return {
    x: target.x + off.x,
    y: fy + off.y,
    z: target.z + off.z,
  };
}

/**
 * How often bots run a full O(enemies) LOS sweep when they have no lock.
 * Counted in **bot ticks** (see {@link botCadenceWorkTick}) so 20 Hz think
 * does not collapse the stagger onto phase-0 sim ticks.
 * 2 = full scan every other bot think per bot (staggered by id hash).
 */
export const BOT_FULL_LOS_EVERY_TICKS = 2;

/**
 * How often free-path bots run expensive wall planners (half-wall / float).
 * Mid-maneuver and stuck bots always probe.
 * Counted in **bot ticks** so probes actually skip between 20 Hz thinks.
 */
export const BOT_NAV_PROBE_EVERY_TICKS = 2;

/** Stable 0..n-1 bucket from player id (for staggered work). */
export function botWorkSlot(playerId: string, n: number): number {
  const mod = max(1, floor(n));
  let h = 0;
  for (let i = 0; i < playerId.length; i++) {
    h = (h * 31 + playerId.charCodeAt(i)) | 0;
  }
  return abs(h) % mod;
}

/**
 * Whether this bot should start a think on this sim tick's phase shard.
 * Spreads roster AI across {@link SIM_TICKS_PER_BOT_TICK} sim ticks so each bot
 * still thinks once per bot period (20 Hz) without a full-roster phase-0 spike.
 * Uses the same slot function as LOS/nav stagger (acceptable shared modulus).
 * @see bot-spread.md
 */
export function botThinksOnSimPhase(
  playerId: string,
  simTick: number,
): boolean {
  return botWorkSlot(playerId, SIM_TICKS_PER_BOT_TICK) ===
    botTickPhase(simTick);
}

/**
 * Work-slot index for staggered AI. Uses bot-tick cadence so thinks that only
 * run on simTick % 3 === 0 still spread probes/LOS across bots and time.
 * Unit tests that advance `tick` by 1 still get a monotone counter every
 * {@link SIM_TICKS_PER_BOT_TICK} calls.
 */
export function botCadenceWorkTick(simTick: number): number {
  const step = max(1, SIM_TICKS_PER_BOT_TICK);
  return floor(simTick / step);
}

/**
 * Whether this tick should run full nav planners (half-wall / float).
 * Always true mid-commit or when stuck; otherwise staggered every N **bot ticks**.
 */
export function shouldRunExpensiveNavProbes(
  state: {
    /** Live halfWallVault think-step commit. */
    halfWallVaultTicksLeft?: number;
    /** Pure floatWallDuck think-step commit. */
    floatWallDuckTicksLeft?: number;
    /** Speed-based peel watch — treat as stuck when accumulating. */
    stuckWElapsed?: number;
    stuckWTurnTicksLeft?: number;
  },
  tick: number,
  playerId: string,
  every: number = BOT_NAV_PROBE_EVERY_TICKS,
): boolean {
  if ((state.halfWallVaultTicksLeft ?? 0) > 0) return true;
  if ((state.floatWallDuckTicksLeft ?? 0) > 0) return true;
  if ((state.stuckWTurnTicksLeft ?? 0) > 0) return true;
  // Approaching stuck threshold — keep probing so we can detour/vault soon.
  if ((state.stuckWElapsed ?? 0) >= 3) return true;
  const n = max(1, floor(every));
  return botCadenceWorkTick(tick) % n === botWorkSlot(playerId, n);
}
