/**
 * Epic 7.1 — authoritative simulation ingress seam.
 *
 * Sole live path for transport bytes → sim queues / Player state:
 *
 * ```text
 * Transport bytes → ingress (parse / validate / rate-limit)
 *   → handleInput / pendingWeapons / immediates
 *   → stepSim → SimTickResult → driver emit
 * ```
 *
 * Session `on` handlers stay in `GameServer.registerEvents` (transport
 * binding) but must not mutate `latestInput`, `pendingWeapons`, or
 * combat state around these helpers — every accepted byte goes through here.
 *
 * Tick association (pinned; do not retime):
 * | NetEvent        | Sim entry              | Association tick              |
 * |-----------------|------------------------|-------------------------------|
 * | Input           | handleInput→queueInput | Consumption (`update`)        |
 * | Shoot / Melee   | pendingWeapons (human side; bots enqueue from apply) | Draining (`Weapons`) |
 * | Reload/Switch/Ability | immediate handlers | Arrival (`loop.tickCount`) |
 * | SkillLoadout    | config (not sim input) | N/A                           |
 *
 * Canonical normalize (`normalizeCanonicalInput`) is **not** wired here:
 * it wraps yaw / clamps pitch / finiteOrZero — that would reshape packets
 * the hand-rolled parsers accept. Delta recorded for 7.3; see plan notes.
 *
 * Tap points:
 * - 8.3 records `Player.lastTickInputSelection()` + handle* action-effect notes
 *   (via 7.5 `ReplayTickPayload.actions` — see `simActionEffect.ts`)
 * - 7.5 attaches below this seam (what entered) and above driver emit
 */

import type { PlayerInput, ShootPacket } from "../protocol/network.ts";
import type { PendingWeapon } from "./weaponsQueue.ts";

/** Flood gate surface used by movement ingress only. */
export type IngressRateGate = {
  allow(sessionId: string): boolean;
};

/** Sim-side sinks the ingress seam may write. */
export type SimIngressSinks = {
  handleInput: (playerId: string, input: PlayerInput, nowMs: number) => void;
  enqueueHumanWeapon: (req: PendingWeapon) => void;
  handleReload: (playerId: string, tick: number) => void;
  handleWeaponSwitch: (
    playerId: string,
    weapon: unknown,
    tick: number,
  ) => void;
  handleAbility: (playerId: string, ability: string, tick: number) => void;
  handleSkillLoadout: (playerId: string, slots: unknown[]) => void;
  /** Optional net-mirror volume drop for deferred Shoot/Melee. */
  volDropPctFor?: (playerId: string) => number | undefined;
};

/**
 * Parse live `NetEvents.Input` bytes.
 * Rejects non-objects and non-numeric sequence/yaw/pitch; boolean-coerces keys.
 * Does not wrap/clamp look (behavior-preserving vs pre-7.1).
 */
export function parsePlayerInput(raw: unknown): PlayerInput | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  if (typeof o.sequence !== "number") return null;
  if (typeof o.yaw !== "number" || typeof o.pitch !== "number") return null;

  return {
    sequence: o.sequence,
    forward: Boolean(o.forward),
    backward: Boolean(o.backward),
    left: Boolean(o.left),
    right: Boolean(o.right),
    jump: Boolean(o.jump),
    sprint: Boolean(o.sprint),
    crouch: Boolean(o.crouch),
    yaw: o.yaw,
    pitch: o.pitch,
  };
}

/** Parse `NetEvents.Shoot` / `Melee` aim packets. */
export function parseShootPacket(raw: unknown): ShootPacket | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.yaw !== "number" || typeof o.pitch !== "number") return null;
  if (!Number.isFinite(o.yaw) || !Number.isFinite(o.pitch)) return null;

  let origin: [number, number, number] | undefined;
  if (Array.isArray(o.origin) && o.origin.length === 3) {
    const [x, y, z] = o.origin;
    if (
      typeof x === "number" &&
      typeof y === "number" &&
      typeof z === "number" &&
      Number.isFinite(x) &&
      Number.isFinite(y) &&
      Number.isFinite(z)
    ) {
      origin = [x, y, z];
    }
  }

  let clientTick: number | undefined;
  if (typeof o.clientTick === "number" && Number.isFinite(o.clientTick)) {
    clientTick = Math.floor(o.clientTick);
  }

  let lastAppliedSnapshotTick: number | undefined;
  if (
    typeof o.lastAppliedSnapshotTick === "number" &&
    Number.isFinite(o.lastAppliedSnapshotTick) &&
    o.lastAppliedSnapshotTick > 0
  ) {
    lastAppliedSnapshotTick = Math.floor(o.lastAppliedSnapshotTick);
  }

  return {
    yaw: o.yaw,
    pitch: o.pitch,
    origin,
    sequence: typeof o.sequence === "number" ? o.sequence : undefined,
    clientTick,
    lastAppliedSnapshotTick,
  };
}

/** Parse `NetEvents.Ability` body → ability id string. */
export function parseAbilityPacket(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.ability !== "string") return null;
  return o.ability;
}

/** Coerce `NetEvents.WeaponSwitch` weapon id from object or bare number. */
export function parseWeaponSwitchRaw(raw: unknown): unknown {
  if (raw && typeof raw === "object" && "weapon" in raw) {
    return (raw as { weapon: unknown }).weapon;
  }
  if (typeof raw === "number") return raw;
  return undefined;
}

/** Parse `NetEvents.SkillLoadout` slots array (config, not sim input). */
export function parseSkillLoadoutPacket(raw: unknown): unknown[] | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.slots)) return null;
  return o.slots;
}

/**
 * Movement ingress: rate-limit → parse → `handleInput` → `queueInput`.
 * Association tick = consumption tick inside `Player.update` (5.2).
 */
export function ingressMovementInput(
  sinks: SimIngressSinks,
  rate: IngressRateGate,
  sessionId: string,
  playerId: string,
  raw: unknown,
  nowMs: number,
): boolean {
  if (!rate.allow(sessionId)) return false;
  const input = parsePlayerInput(raw);
  if (!input) return false;
  sinks.handleInput(playerId, input, nowMs);
  return true;
}

/**
 * Deferred Shoot: parse + enqueue `pendingWeapons` (shared with bot intents).
 * Association tick = draining tick in the Weapons phase.
 */
export function ingressShoot(
  sinks: SimIngressSinks,
  playerId: string,
  raw: unknown,
): void {
  sinks.enqueueHumanWeapon({
    kind: "shoot",
    shooterId: playerId,
    packet: parseShootPacket(raw),
    volDropPct: sinks.volDropPctFor?.(playerId),
  });
}

/**
 * Deferred Melee: same queue / association rule as Shoot.
 */
export function ingressMelee(
  sinks: SimIngressSinks,
  playerId: string,
  raw: unknown,
): void {
  sinks.enqueueHumanWeapon({
    kind: "melee",
    shooterId: playerId,
    packet: parseShootPacket(raw),
    volDropPct: sinks.volDropPctFor?.(playerId),
  });
}

/** Immediate Reload at arrival tick. */
export function ingressReload(
  sinks: SimIngressSinks,
  playerId: string,
  arrivalTick: number,
): void {
  sinks.handleReload(playerId, arrivalTick);
}

/** Immediate WeaponSwitch at arrival tick. */
export function ingressWeaponSwitch(
  sinks: SimIngressSinks,
  playerId: string,
  raw: unknown,
  arrivalTick: number,
): void {
  sinks.handleWeaponSwitch(playerId, parseWeaponSwitchRaw(raw), arrivalTick);
}

/** Immediate Ability at arrival tick. */
export function ingressAbility(
  sinks: SimIngressSinks,
  playerId: string,
  raw: unknown,
  arrivalTick: number,
): boolean {
  const ability = parseAbilityPacket(raw);
  if (!ability) return false;
  sinks.handleAbility(playerId, ability, arrivalTick);
  return true;
}

/**
 * Skill loadout sync — validated config, not a per-tick sim input.
 * Listed here so registerEvents has one ingress entry point for all six
 * action intents + this config channel.
 */
export function ingressSkillLoadout(
  sinks: SimIngressSinks,
  playerId: string,
  raw: unknown,
): boolean {
  const slots = parseSkillLoadoutPacket(raw);
  if (!slots) return false;
  sinks.handleSkillLoadout(playerId, slots);
  return true;
}
