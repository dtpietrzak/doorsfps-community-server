/**
 * Epic 20.4 — replay access control.
 *
 * 15.5 owns visibility × audience. This module names the caller.
 * It does not read a store, a session, or a file.
 *
 * Roles:
 * - owner: the account stored as `replays.owner_id`
 * - shared: another real human who played the match
 * - stranger: everyone else, including anonymous
 *
 * A stranger who holds the public id is the link audience.
 * Owner and shared are the owner audience for reads. 16.8 lets the
 * owner or a match participant fetch the file. Shared is not a fourth
 * visibility and not a fourth 15.5 audience.
 * Catalog listing stays the catalog audience and does not consult a role.
 *
 * The designated owner is the first account id in sorted order. The
 * rest are shared. Both may read a private row. Neither may read a
 * deleted row. A null owner and an empty share list leave private
 * closed. Admin routes do not call this.
 *
 * Account ids are trimmed strings. Empty is not an account. The replay
 * file must not carry them (20.3). Abuse limits are 20.5. The SQL
 * checksum is 20.6. No clock, no file, no store. The status page is 23.4.
 */

import {
  type ReplayClipAudience,
  replayClipPermission,
} from "./replayClipPermission.ts";

export const REPLAY_ACCESS_ROLES = ["owner", "shared", "stranger"] as const;

export type ReplayAccessRole = (typeof REPLAY_ACCESS_ROLES)[number];

/** Request header on the runtime finalize upload. Not a file field. */
export const REPLAY_ACCESS_HEADER = "x-doors-replay-access";

/** One match cannot grant more accounts than this. */
export const REPLAY_ACCESS_ACCOUNT_CAP = 64;

/** A single account id longer than this is not an account. */
export const REPLAY_ACCESS_ACCOUNT_MAX_CHARS = 128;

/** Refuse a header larger than a capped id list. */
export const REPLAY_ACCESS_HEADER_MAX_CHARS = 8192;

/** Roster facts the grant collector reads. Not a sim snapshot. */
export type ReplayAccessCandidate = {
  readonly accountUserId?: string | null;
  readonly isBot?: boolean;
  readonly isAgent?: boolean;
  readonly synthetic?: boolean;
  readonly poolAccount?: boolean;
};

export type ReplayAccessAssignment = {
  readonly ownerId: string | null;
  readonly sharedIds: readonly string[];
};

export function isReplayAccessRole(value: unknown): value is ReplayAccessRole {
  return (
    typeof value === "string" &&
    REPLAY_ACCESS_ROLES.includes(value as ReplayAccessRole)
  );
}

/** Trimmed account id, or null when the value is not one. */
export function normalizeReplayAccountId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  if (!id || id.length > REPLAY_ACCESS_ACCOUNT_MAX_CHARS) return null;
  if (id.includes("\0")) return null;
  return id;
}

/**
 * A real human account. Bots, agents, synthetics, pool pawns, and
 * guests are not grants. A guest can still open a public or unlisted link.
 */
export function replayAccessAccountId(
  player: ReplayAccessCandidate,
): string | null {
  if (player.isBot || player.isAgent || player.synthetic || player.poolAccount) {
    return null;
  }
  return normalizeReplayAccountId(player.accountUserId);
}

/**
 * Unique real-human account ids, capped, sorted.
 * The first is the owner. The rest are shared.
 * Input order does not matter.
 */
export function assignReplayAccess(
  accountIds: readonly unknown[],
): ReplayAccessAssignment {
  const unique = new Set<string>();
  for (const raw of accountIds) {
    const id = normalizeReplayAccountId(raw);
    if (id) unique.add(id);
  }
  const capped = [...unique].sort().slice(0, REPLAY_ACCESS_ACCOUNT_CAP);
  return {
    ownerId: capped[0] ?? null,
    sharedIds: capped.slice(1),
  };
}

/** Sorted grant list: owner, then shared. Empty when nobody qualifies. */
export function collectReplayAccessAccounts(
  players: readonly ReplayAccessCandidate[],
): readonly string[] {
  const ids: string[] = [];
  for (const player of players) {
    const id = replayAccessAccountId(player);
    if (id) ids.push(id);
  }
  const assigned = assignReplayAccess(ids);
  if (!assigned.ownerId) return [];
  return [assigned.ownerId, ...assigned.sharedIds];
}

/**
 * Header JSON for the finalize upload, or null when there is nothing
 * to grant. The bytes of the replay file are a different body.
 */
export function replayAccessHeaderValue(
  accountIds: readonly string[] | undefined,
): string | null {
  if (!accountIds || accountIds.length === 0) return null;
  return JSON.stringify(accountIds);
}

/**
 * Parse the finalize header. Null means "do not stamp" (absent, too
 * long, or not a JSON array). Strings inside the array are normalized
 * later by {@link assignReplayAccess}.
 */
export function parseReplayAccessHeader(
  value: string | null,
): readonly unknown[] | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > REPLAY_ACCESS_HEADER_MAX_CHARS) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  return Array.isArray(parsed) ? parsed : null;
}

/**
 * Owner and shared read as the owner audience. A stranger reads as link.
 * Catalog is not a role.
 */
export function replayAccessAudience(role: ReplayAccessRole): ReplayClipAudience {
  return role === "stranger" ? "link" : "owner";
}

export function replayAccessRole(args: {
  callerAccountId: string | null;
  ownerAccountId: string | null;
  sharedAccountIds: readonly unknown[];
}): ReplayAccessRole {
  const caller = normalizeReplayAccountId(args.callerAccountId);
  if (!caller) return "stranger";
  if (normalizeReplayAccountId(args.ownerAccountId) === caller) return "owner";
  for (const raw of args.sharedAccountIds) {
    if (normalizeReplayAccountId(raw) === caller) return "shared";
  }
  return "stranger";
}

/** 15.5 readable bit for this caller. A bad visibility throws. */
export function replayReadAllowed(
  visibility: unknown,
  role: ReplayAccessRole,
): boolean {
  return replayClipPermission(visibility, replayAccessAudience(role)).readable;
}
