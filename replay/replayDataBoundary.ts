/**
 * Epic 20.3 — replay data boundaries.
 *
 * A replay file may carry two player-facing identity strings: the match
 * participant `id`, and the display `name`. The id is the id assigned at
 * join. For a human that id is often the first socket id. It is not an
 * account id. The name is stored as typed. This module does not read the
 * characters, so a name that looks like an email is still a name.
 *
 * Team, bot flags, pose, equipment, and loadout are sim state. They are
 * not account facts.
 *
 * The keys in `REPLAY_ACCOUNT_KEYS` must not appear anywhere in the file.
 * `socketId` may be null or absent. 19.6 omits a null `socketId` and
 * restores it, so the key itself is not forbidden. Any other value is a
 * live transport handle and is rejected. A present value is not stripped.
 *
 * `encodeReplayContainer` checks the container before it writes.
 * `decodeReplayContainer` checks the parsed document after the version
 * gate and before unknown metadata keys are dropped. The throw is
 * `replay-data-boundary`. 20.2 classifies that code as invalid. 20.4
 * gates who may fetch a file. Abuse limits are 20.5. The SQL checksum
 * is 20.6. No clock, no file, no hash. The status page is 23.4.
 */

export const REPLAY_DATA_BOUNDARY = "replay-data-boundary" as const;

export type ReplayDataBoundaryErrorCode = typeof REPLAY_DATA_BOUNDARY;

/** The only player-facing identity strings a replay file may carry. */
export const REPLAY_PLAYER_IDENTITY_KEYS = ["id", "name"] as const;

/**
 * Account, credential, and contact keys. Closed set. A key not listed
 * here is not an account fact, including an unknown metadata key.
 */
export const REPLAY_ACCOUNT_KEYS: ReadonlySet<string> = new Set([
  "accountUserId",
  "accountId",
  "clerkUserId",
  "clerkId",
  "poolAccount",
  "email",
  "ip",
  "ipAddress",
  "password",
  "joinPassword",
  "token",
  "accessToken",
  "refreshToken",
  "sessionToken",
  "secret",
]);

export class ReplayDataBoundaryError extends Error {
  readonly code: ReplayDataBoundaryErrorCode;
  readonly path: string;
  readonly key: string;

  constructor(path: string, key: string, message: string) {
    super(message);
    this.name = "ReplayDataBoundaryError";
    this.code = REPLAY_DATA_BOUNDARY;
    this.path = path;
    this.key = key;
  }
}

function fail(path: string, key: string, message: string): never {
  throw new ReplayDataBoundaryError(path, key, message);
}

function walk(value: unknown, path: string, seen: WeakSet<object>): void {
  if (value == null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      walk(value[i], `${path}[${i}]`, seen);
    }
    return;
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    const here = path.length > 0 ? `${path}.${key}` : key;
    if (REPLAY_ACCOUNT_KEYS.has(key)) {
      fail(here, key, `replay file must not carry ${key} at ${here}`);
    }
    if (key === "socketId" && obj[key] != null) {
      fail(here, key, `replay file must not carry a live socket id at ${here}`);
    }
    walk(obj[key], here, seen);
  }
}

/**
 * Refuse account keys and a live socket id. Does not mutate `value`.
 * Does not inspect display-name or id characters.
 */
export function assertReplayDataBoundary(value: unknown): void {
  walk(value, "", new WeakSet());
}
