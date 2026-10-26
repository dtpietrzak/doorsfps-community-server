/**
 * Canonical per-tick player action intent (replay epic 5.1).
 *
 * One serializable vocabulary for every gameplay action a human or bot can
 * take in a tick. Recording (#8.3) and replay (#11.2) consume this shape;
 * wire packets (`PlayerInput`, `ShootPacket`, …) stay unchanged — adapters
 * in 5.3/5.4 convert into this type.
 *
 * Excluded (owned by later epics):
 * - tick / sequence / hold counting → 5.2
 * - keyboard/mouse/controller conversion → 5.3
 * - bot-brain conversion → 5.4
 * - skill loadout, joins/leaves, match config → 5.5
 * - player identity / match id (caller supplies those)
 *
 * See `CANONICAL_PLAYER_INPUT.md` for held-vs-edge semantics and handoffs.
 */

import { wrapRadians } from "../math/angles.ts";
import { HALF_PI } from "../math/constants.ts";
import { isSkillActivatable, isSkillId, type SkillId } from "./skills.ts";
import type { MoveInput } from "./moveStep.ts";
import { isWeaponId } from "./weapons.ts";

/** Pitch clamp matching `PlayerManager.handleShoot` / `handleMelee`. */
export const CANONICAL_PITCH_LIMIT = HALF_PI - 0.01;

/**
 * Canonical per-tick apply order — mirrors bot `APPLY_STEP_IDS`
 * (`input → weapon → reload → shoot → ability`).
 * Movement/look (`input`) is always projected first; edge steps run only
 * when the corresponding edge field is set.
 */
export const CANONICAL_APPLY_ORDER = [
  "input",
  "weapon",
  "reload",
  "shoot",
  "ability",
] as const;

export type CanonicalApplyStepId = (typeof CANONICAL_APPLY_ORDER)[number];

/**
 * Aim snapshot carried by a fire edge (hitscan or pistol-whip).
 * Matches `ShootPacket` / `MeleePacket` aim fields (no `sequence` — 5.2).
 */
export type CanonicalAimSnapshot = {
  yaw: number;
  pitch: number;
  /** Client eye hint; server soft-clamps toward authoritative eye. */
  origin?: [number, number, number];
  /** Lag-comp: remote world tick the client aimed at. */
  clientTick?: number;
  /** Lag-comp: latest snapshot tick the client had applied. */
  lastAppliedSnapshotTick?: number;
};

/**
 * Fire edge: one-shot per tick. `kind` selects hitscan vs pistol-whip.
 * Distinct from `meleeLunge` (movement burst consumed by `stepMove`).
 */
export type CanonicalFireEdge = CanonicalAimSnapshot & {
  kind: "shoot" | "melee";
};

/**
 * Authoritative per-tick action intent.
 *
 * **Held (level):** continuous frame state — `forward/backward/left/right`,
 * `sprint`, `crouch`, `yaw`, `pitch`.
 *
 * **Edge (one-shot):** consumed exactly once per tick apply —
 * `jump`, `meleeLunge`, `fire`, `reload`, `weaponSelect`, `ability`.
 * After apply, call {@link consumeCanonicalEdges} (or clear the field that
 * was handled) so a held packet cannot double-fire. Matches today's
 * `input.jump = false` / `meleeLunge` clear after `stepMove`.
 *
 * Pure data: JSON-serializable (no class instances). After
 * {@link normalizeCanonicalInput}, every field is present with finite
 * numbers / booleans / `null` edges — no `undefined` holes.
 */
export type CanonicalPlayerInput = {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  sprint: boolean;
  crouch: boolean;
  /** Authoritative look yaw (radians), wrapped to [-π, π]. */
  yaw: number;
  /** Authoritative look pitch (radians), clamped to ±(π/2 − 0.01). */
  pitch: number;
  /** Edge: jump once while grounded. */
  jump: boolean;
  /** Edge: standing melee lunge (movement); not pistol-whip. */
  meleeLunge: boolean;
  /** Edge: fire with aim snapshot, or null when not firing this tick. */
  fire: CanonicalFireEdge | null;
  /** Edge: reload request. */
  reload: boolean;
  /** Edge: equip this weapon id, or null (unknown ids normalize to null). */
  weaponSelect: number | null;
  /**
   * Edge: activate skill family, or null.
   * Unknown / passive ids normalize to null (matching `canActivateAbility`).
   */
  ability: SkillId | null;
};

/** Loose input accepted by {@link normalizeCanonicalInput}. */
export type CanonicalPlayerInputInit = {
  forward?: unknown;
  backward?: unknown;
  left?: unknown;
  right?: unknown;
  sprint?: unknown;
  crouch?: unknown;
  yaw?: unknown;
  pitch?: unknown;
  jump?: unknown;
  meleeLunge?: unknown;
  fire?: unknown;
  reload?: unknown;
  weaponSelect?: unknown;
  ability?: unknown;
};

/** Held field names (level semantics). */
export const CANONICAL_HELD_FIELDS = [
  "forward",
  "backward",
  "left",
  "right",
  "sprint",
  "crouch",
  "yaw",
  "pitch",
] as const;

/** Edge field names (one-shot semantics). */
export const CANONICAL_EDGE_FIELDS = [
  "jump",
  "meleeLunge",
  "fire",
  "reload",
  "weaponSelect",
  "ability",
] as const;

export type CanonicalHeldField = (typeof CANONICAL_HELD_FIELDS)[number];
export type CanonicalEdgeField = (typeof CANONICAL_EDGE_FIELDS)[number];

/** Neutral held state with all edges cleared. */
export function emptyCanonicalInput(): CanonicalPlayerInput {
  return {
    forward: false,
    backward: false,
    left: false,
    right: false,
    sprint: false,
    crouch: false,
    yaw: 0,
    pitch: 0,
    jump: false,
    meleeLunge: false,
    fire: null,
    reload: false,
    weaponSelect: null,
    ability: null,
  };
}

function asBool(value: unknown): boolean {
  return value === true;
}

function finiteOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function clampPitch(pitch: number): number {
  if (pitch > CANONICAL_PITCH_LIMIT) return CANONICAL_PITCH_LIMIT;
  if (pitch < -CANONICAL_PITCH_LIMIT) return -CANONICAL_PITCH_LIMIT;
  return pitch;
}

function normalizeOrigin(
  raw: unknown,
): [number, number, number] | undefined {
  if (!Array.isArray(raw) || raw.length < 3) return undefined;
  const x = raw[0];
  const y = raw[1];
  const z = raw[2];
  if (
    typeof x !== "number" || !Number.isFinite(x) ||
    typeof y !== "number" || !Number.isFinite(y) ||
    typeof z !== "number" || !Number.isFinite(z)
  ) {
    return undefined;
  }
  return [x, y, z];
}

function normalizeOptionalTick(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  return raw;
}

function normalizeFireEdge(raw: unknown): CanonicalFireEdge | null {
  if (raw == null || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const kind = obj.kind === "melee" ? "melee" : obj.kind === "shoot"
    ? "shoot"
    : null;
  if (kind == null) return null;
  const yaw = wrapRadians(finiteOrZero(obj.yaw));
  const pitch = clampPitch(finiteOrZero(obj.pitch));
  const edge: CanonicalFireEdge = { kind, yaw, pitch };
  const origin = normalizeOrigin(obj.origin);
  if (origin) edge.origin = origin;
  const clientTick = normalizeOptionalTick(obj.clientTick);
  if (clientTick !== undefined) edge.clientTick = clientTick;
  const lastApplied = normalizeOptionalTick(obj.lastAppliedSnapshotTick);
  if (lastApplied !== undefined) edge.lastAppliedSnapshotTick = lastApplied;
  return edge;
}

function normalizeWeaponSelect(raw: unknown): number | null {
  // Unknown / non-weapon → null (no-op). Do not map to cycle — cycling is a
  // separate omitted-weapon path on `handleWeaponSwitch`, not a canonical edge.
  return isWeaponId(raw) ? raw : null;
}

function normalizeAbility(raw: unknown): SkillId | null {
  if (typeof raw !== "string") return null;
  if (!isSkillId(raw)) return null;
  if (!isSkillActivatable(raw)) return null;
  return raw;
}

/**
 * Total normalization: finite numbers, yaw wrap, pitch clamp, boolean coerce,
 * unknown weapon/ability cleared. Always returns a fully-populated struct.
 */
export function normalizeCanonicalInput(
  raw: CanonicalPlayerInputInit | null | undefined,
): CanonicalPlayerInput {
  if (raw == null) return emptyCanonicalInput();
  return {
    forward: asBool(raw.forward),
    backward: asBool(raw.backward),
    left: asBool(raw.left),
    right: asBool(raw.right),
    sprint: asBool(raw.sprint),
    crouch: asBool(raw.crouch),
    yaw: wrapRadians(finiteOrZero(raw.yaw)),
    pitch: clampPitch(finiteOrZero(raw.pitch)),
    jump: asBool(raw.jump),
    meleeLunge: asBool(raw.meleeLunge),
    fire: normalizeFireEdge(raw.fire),
    reload: asBool(raw.reload),
    weaponSelect: normalizeWeaponSelect(raw.weaponSelect),
    ability: normalizeAbility(raw.ability),
  };
}

/**
 * Clear all edge fields after a tick's apply. Held look/move keys stay.
 * Call once after projecting handler args (or after each edge is handled).
 */
export function consumeCanonicalEdges(
  input: CanonicalPlayerInput,
): CanonicalPlayerInput {
  return {
    ...input,
    jump: false,
    meleeLunge: false,
    fire: null,
    reload: false,
    weaponSelect: null,
    ability: null,
  };
}

/** Project held + jump/meleeLunge edges into pure `MoveInput` for `stepMove`. */
export function toMoveInput(input: CanonicalPlayerInput): MoveInput {
  return {
    forward: input.forward,
    backward: input.backward,
    left: input.left,
    right: input.right,
    jump: input.jump,
    sprint: input.sprint,
    crouch: input.crouch,
    meleeLunge: input.meleeLunge,
    yaw: input.yaw,
  };
}

/** Aim fields suitable for `handleShoot` / `handleMelee` packets. */
export type CanonicalFirePacket = {
  yaw: number;
  pitch: number;
  origin?: [number, number, number];
  clientTick?: number;
  lastAppliedSnapshotTick?: number;
};

export function toFirePacket(fire: CanonicalFireEdge): CanonicalFirePacket {
  const packet: CanonicalFirePacket = {
    yaw: fire.yaw,
    pitch: fire.pitch,
  };
  if (fire.origin) packet.origin = fire.origin;
  if (fire.clientTick !== undefined) packet.clientTick = fire.clientTick;
  if (fire.lastAppliedSnapshotTick !== undefined) {
    packet.lastAppliedSnapshotTick = fire.lastAppliedSnapshotTick;
  }
  return packet;
}

/**
 * Lossless projection onto the existing `handle*` argument surface, in
 * {@link CANONICAL_APPLY_ORDER}. Does not call handlers — pure data only.
 *
 * Dead / spectating players: callers (queueInput / adapters) still decide
 * whether movement is applied; this projection always emits the `input` step
 * so AFK look tracking can observe yaw/pitch.
 */
export type CanonicalHandlerCall =
  | {
    kind: "input";
    move: MoveInput;
    yaw: number;
    pitch: number;
  }
  | { kind: "weapon"; weapon: number }
  | { kind: "reload" }
  | { kind: "shoot"; packet: CanonicalFirePacket }
  | { kind: "melee"; packet: CanonicalFirePacket }
  | { kind: "ability"; ability: SkillId };

export function projectCanonicalHandlerCalls(
  input: CanonicalPlayerInput,
): CanonicalHandlerCall[] {
  const calls: CanonicalHandlerCall[] = [
    {
      kind: "input",
      move: toMoveInput(input),
      yaw: input.yaw,
      pitch: input.pitch,
    },
  ];
  if (input.weaponSelect != null) {
    calls.push({ kind: "weapon", weapon: input.weaponSelect });
  }
  if (input.reload) {
    calls.push({ kind: "reload" });
  }
  if (input.fire) {
    const packet = toFirePacket(input.fire);
    if (input.fire.kind === "melee") {
      calls.push({ kind: "melee", packet });
    } else {
      calls.push({ kind: "shoot", packet });
    }
  }
  if (input.ability != null) {
    calls.push({ kind: "ability", ability: input.ability });
  }
  return calls;
}

/**
 * Build a canonical value from today's split wire/action channels.
 * Used by equivalence probes and (later) human/bot adapters.
 * Sequence/tick fields on wire packets are ignored (5.2).
 */
export function canonicalFromWireParts(parts: {
  /** Movement + look (+ jump / meleeLunge edges). */
  input?: {
    forward?: unknown;
    backward?: unknown;
    left?: unknown;
    right?: unknown;
    jump?: unknown;
    sprint?: unknown;
    crouch?: unknown;
    meleeLunge?: unknown;
    yaw?: unknown;
    pitch?: unknown;
  } | null;
  /** Hitscan fire aim snapshot. */
  shoot?: {
    yaw?: unknown;
    pitch?: unknown;
    origin?: unknown;
    clientTick?: unknown;
    lastAppliedSnapshotTick?: unknown;
  } | null;
  /** Pistol-whip aim snapshot (mutually exclusive with shoot in one tick). */
  melee?: {
    yaw?: unknown;
    pitch?: unknown;
    origin?: unknown;
    clientTick?: unknown;
    lastAppliedSnapshotTick?: unknown;
  } | null;
  reload?: unknown;
  weapon?: unknown;
  ability?: unknown;
}): CanonicalPlayerInput {
  const move = parts.input ?? {};
  let fire: CanonicalFireEdge | null = null;
  if (parts.melee != null) {
    fire = normalizeFireEdge({ kind: "melee", ...parts.melee });
  } else if (parts.shoot != null) {
    fire = normalizeFireEdge({ kind: "shoot", ...parts.shoot });
  }
  return normalizeCanonicalInput({
    forward: move.forward,
    backward: move.backward,
    left: move.left,
    right: move.right,
    sprint: move.sprint,
    crouch: move.crouch,
    yaw: move.yaw,
    pitch: move.pitch,
    jump: move.jump,
    meleeLunge: move.meleeLunge,
    fire,
    reload: parts.reload,
    weaponSelect: parts.weapon,
    ability: parts.ability,
  });
}
