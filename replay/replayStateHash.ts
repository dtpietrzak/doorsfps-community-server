/**
 * Epic 18.2 — state hashing.
 *
 * Digests one 9.1 authoritative checkpoint so two captures can be compared
 * by a short string. The sample cadence matches the shipped checkpoint
 * interval (5s, 300 ticks at 60 Hz). The caller decides which ticks to
 * hash; this module does not read the recorder env or write a file.
 *
 * Numbers are IEEE-754 little-endian, so -0 and 0 stay distinct. Object
 * keys are sorted. Players are ordered by id. Weapon slots are ordered by
 * weapon id. A missing shell-gun `chambered` matches `true`, and a missing
 * shell timer matches null, the same equivalences the 9.4 field walk uses.
 *
 * The 18.1 harness still walks fields. A record-and-replay round trip is
 * 18.3. Checkpoint horizon certification is 18.4. Extending the divergence
 * columns is 18.5. Regression fixtures are 18.6. The live match does not
 * call this module.
 */
import { TICK_HZ } from "../shared/sim/game.ts";
import type {
  AuthoritativeCheckpoint,
  CheckpointPlayerState,
  CheckpointWeaponLoadout,
} from "./authoritativeCheckpoint.ts";
import { CHECKPOINT_INTERVAL_SECONDS_DEFAULT } from "./checkpointInterval.ts";

/** Synchronous comparison digest. Not a file checksum. */
export const REPLAY_STATE_HASH_ALGORITHM = "fnv1a64" as const;

/**
 * Ticks between comparison samples. Matches the shipped checkpoint
 * interval (`round(5 * TICK_HZ)` → 300) without reading the recorder env.
 */
export const REPLAY_STATE_HASH_INTERVAL_TICKS_DEFAULT = Math.round(
  CHECKPOINT_INTERVAL_SECONDS_DEFAULT * TICK_HZ,
);

export const REPLAY_STATE_HASH_INVALID = "replay-state-hash-invalid" as const;

export type ReplayStateHashErrorCode = typeof REPLAY_STATE_HASH_INVALID;

export class ReplayStateHashError extends Error {
  readonly code: ReplayStateHashErrorCode;
  readonly detail: string | null;

  constructor(message: string, detail?: string | null) {
    super(message);
    this.name = "ReplayStateHashError";
    this.code = REPLAY_STATE_HASH_INVALID;
    this.detail = detail ?? null;
  }
}

const FNV64_OFFSET = 14695981039346656037n;
const FNV64_PRIME = 1099511628211n;
const FNV64_MASK = (1n << 64n) - 1n;
const textEncoder = new TextEncoder();
const floatScratch = new ArrayBuffer(8);
const floatView = new DataView(floatScratch);

function fail(message: string, detail?: string): never {
  throw new ReplayStateHashError(message, detail ?? null);
}

/** True when `tick` is a comparison sample. Tick 0 is a sample. */
export function isReplayStateHashTick(
  tick: number,
  intervalTicks: number = REPLAY_STATE_HASH_INTERVAL_TICKS_DEFAULT,
): boolean {
  if (!Number.isInteger(tick) || tick < 0) {
    fail("state hash tick must be an integer >= 0", String(tick));
  }
  if (!Number.isInteger(intervalTicks) || intervalTicks < 1) {
    fail("state hash interval must be an integer >= 1", String(intervalTicks));
  }
  return tick % intervalTicks === 0;
}

function weaponForHash(slot: CheckpointWeaponLoadout): CheckpointWeaponLoadout {
  const base: CheckpointWeaponLoadout = {
    weaponId: slot.weaponId,
    ammoInMag: slot.ammoInMag,
    spareClips: slot.spareClips,
  };
  if (slot.chambered === false) return { ...base, chambered: false };
  return base;
}

function playerForHash(player: CheckpointPlayerState): CheckpointPlayerState {
  const { shellReloadNextAtTick, pumpEndsAtTick, weaponLoadouts, ...rest } =
    player;
  return {
    ...rest,
    weaponLoadouts: weaponLoadouts.map(weaponForHash).sort((a, b) =>
      a.weaponId - b.weaponId
    ),
    ...(shellReloadNextAtTick != null ? { shellReloadNextAtTick } : {}),
    ...(pumpEndsAtTick != null ? { pumpEndsAtTick } : {}),
  };
}

function checkpointForHash(
  checkpoint: AuthoritativeCheckpoint,
): AuthoritativeCheckpoint {
  return {
    ...checkpoint,
    players: checkpoint.players.map(playerForHash).sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    ),
  };
}

function float64Hex(n: number): string {
  floatView.setFloat64(0, n, true);
  let hex = "";
  for (let i = 0; i < 8; i++) {
    hex += floatView.getUint8(i).toString(16).padStart(2, "0");
  }
  return hex;
}

function encode(value: unknown, out: string[]): void {
  if (value === null) {
    out.push("z;");
    return;
  }
  const kind = typeof value;
  if (kind === "number") {
    out.push("n:");
    out.push(float64Hex(value as number));
    out.push(";");
    return;
  }
  if (kind === "boolean") {
    out.push(value ? "b:1;" : "b:0;");
    return;
  }
  if (kind === "string") {
    const text = value as string;
    out.push("s:");
    out.push(String(text.length));
    out.push(":");
    out.push(text);
    out.push(";");
    return;
  }
  if (kind !== "object") {
    fail("state hash cannot encode this value", kind);
  }
  if (
    value instanceof Date || value instanceof Map || value instanceof Set ||
    ArrayBuffer.isView(value)
  ) {
    fail("state hash cannot encode this value", value.constructor.name);
  }
  if (Array.isArray(value)) {
    out.push("a:");
    out.push(String(value.length));
    out.push(";");
    for (const item of value) encode(item, out);
    return;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((key) => obj[key] !== undefined).sort();
  out.push("o:");
  out.push(String(keys.length));
  out.push(";");
  for (const key of keys) {
    encode(key, out);
    encode(obj[key], out);
  }
}

function fnv1a64(text: string): string {
  const bytes = textEncoder.encode(text);
  let hash = FNV64_OFFSET;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= BigInt(bytes[i]!);
    hash = (hash * FNV64_PRIME) & FNV64_MASK;
  }
  return hash.toString(16).padStart(16, "0");
}

/** Stable digest of one checkpoint. Does not mutate `checkpoint`. */
export function hashAuthoritativeCheckpoint(
  checkpoint: AuthoritativeCheckpoint,
): string {
  if (checkpoint == null || typeof checkpoint !== "object") {
    fail("state hash needs a checkpoint");
  }
  const parts: string[] = [];
  encode(checkpointForHash(checkpoint), parts);
  return `${REPLAY_STATE_HASH_ALGORITHM}:${fnv1a64(parts.join(""))}`;
}

/** True when the two checkpoints digest to the same string. */
export function authoritativeCheckpointsMatch(
  expected: AuthoritativeCheckpoint,
  actual: AuthoritativeCheckpoint,
): boolean {
  return hashAuthoritativeCheckpoint(expected) ===
    hashAuthoritativeCheckpoint(actual);
}
