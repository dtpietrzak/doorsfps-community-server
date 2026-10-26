/**
 * Local host channel between a match process and the process that spawned it.
 *
 * The socket path is `DOORS_HOST_CHANNEL`. Community downloads never set it.
 * Messages are one JSON object per line. The host does not interpret
 * `profileData`; a step-3 shim decodes it only so pool pawns can still think
 * in-process.
 */

import type { PlayerEquipment } from "../../shared/sim/game.ts";

export type ChurnPolicy = {
  /** Roster stays within autofill center ± band. */
  band: number;
  /** Chance a human join or leave mirrors inside the band. */
  humanMirrorChance: number;
  minDelayMs: number;
  maxDelayMs: number;
};

export type VoteSeedPolicy = {
  /** Inclusive share of pool pawns that cast a map vote. */
  minShare: number;
  maxShare: number;
};

export type IdentityDropReason = "name-taken" | "pool-full" | "invalid";

export type PawnRemoveReason = "churn" | "eviction" | "rebalance" | "match-end";

export type PoolIdentitySkills = {
  ownedAbilities: string[];
  skillLoadout: (string | null)[];
};

export type PoolIdentity = {
  id: string;
  name: string;
  accountId?: string;
  equipment?: PlayerEquipment;
  skills?: PoolIdentitySkills;
  xp?: number;
  rankId?: string;
  founderBadge?: boolean;
  initialPingMs?: number;
  profile: string;
  /** Opaque base64. The host stores it and does not parse it on the wire. */
  profileData?: string;
};

export type DirectorToHost =
  | {
    type: "set-policy";
    churn: ChurnPolicy | null;
    seedMapVotes: VoteSeedPolicy | null;
  }
  | { type: "put-identities"; identities: PoolIdentity[] }
  | { type: "set-ping"; pawnId: string; pingMs: number };

export type HostToDirector =
  | { type: "hello"; runtimeId: string; map: string; maxPlayers: number }
  | { type: "pawn-took"; identityId: string; pawnId: string }
  | {
    type: "pawn-removed";
    identityId: string;
    pawnId: string;
    reason: PawnRemoveReason;
  }
  | { type: "identity-dropped"; identityId: string; reason: IdentityDropReason }
  | {
    type: "identities-accepted";
    accepted: string[];
    dropped: { id: string; reason: IdentityDropReason }[];
  }
  | { type: "map-changed"; map: string }
  | { type: "match-over" };

export type HostHello = {
  runtimeId: string;
  map: string;
  maxPlayers: number;
};

export type IdentityAccept = {
  accepted: string[];
  dropped: { id: string; reason: IdentityDropReason }[];
};

const PROFILE_DATA_MAX = 65_536;
const ID_MAX = 128;
const NAME_MAX = 64;

export function encodeHostMessage(
  message: DirectorToHost | HostToDirector,
): string {
  return JSON.stringify(message) + "\n";
}

export function encodeProfileData(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function decodeProfileData(encoded: string): Uint8Array | null {
  if (encoded.length === 0 || encoded.length > PROFILE_DATA_MAX) return null;
  try {
    const binary = atob(encoded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function parseDirectorMessage(line: string): DirectorToHost | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const type = (raw as { type?: unknown }).type;
  if (type === "set-policy") return parsePolicy(raw);
  if (type === "put-identities") return parsePut(raw);
  if (type === "set-ping") return parsePing(raw);
  return null;
}

export function parseHostMessage(line: string): HostToDirector | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  switch (rec.type) {
    case "hello": {
      if (typeof rec.runtimeId !== "string" || typeof rec.map !== "string") {
        return null;
      }
      const maxPlayers = finiteInt(rec.maxPlayers);
      if (maxPlayers == null || maxPlayers < 1) return null;
      return {
        type: "hello",
        runtimeId: rec.runtimeId,
        map: rec.map,
        maxPlayers,
      };
    }
    case "pawn-took":
      if (typeof rec.identityId !== "string" || typeof rec.pawnId !== "string") {
        return null;
      }
      return {
        type: "pawn-took",
        identityId: rec.identityId,
        pawnId: rec.pawnId,
      };
    case "pawn-removed":
      if (
        typeof rec.identityId !== "string" ||
        typeof rec.pawnId !== "string" ||
        !isRemoveReason(rec.reason)
      ) {
        return null;
      }
      return {
        type: "pawn-removed",
        identityId: rec.identityId,
        pawnId: rec.pawnId,
        reason: rec.reason,
      };
    case "identity-dropped":
      if (typeof rec.identityId !== "string" || !isDropReason(rec.reason)) {
        return null;
      }
      return {
        type: "identity-dropped",
        identityId: rec.identityId,
        reason: rec.reason,
      };
    case "identities-accepted":
      if (!Array.isArray(rec.accepted) || !Array.isArray(rec.dropped)) {
        return null;
      }
      return {
        type: "identities-accepted",
        accepted: rec.accepted.filter((id) => typeof id === "string"),
        dropped: rec.dropped.flatMap((row) => {
          if (!row || typeof row !== "object") return [];
          const id = (row as { id?: unknown }).id;
          const reason = (row as { reason?: unknown }).reason;
          if (typeof id !== "string" || !isDropReason(reason)) return [];
          return [{ id, reason }];
        }),
      };
    case "map-changed":
      if (typeof rec.map !== "string") return null;
      return { type: "map-changed", map: rec.map };
    case "match-over":
      return { type: "match-over" };
    default:
      return null;
  }
}

function parsePolicy(raw: object): DirectorToHost | null {
  const rec = raw as { churn?: unknown; seedMapVotes?: unknown };
  if (!("churn" in rec) || !("seedMapVotes" in rec)) return null;
  return {
    type: "set-policy",
    churn: rec.churn === null ? null : sanitizeChurn(rec.churn),
    seedMapVotes: rec.seedMapVotes === null
      ? null
      : sanitizeVotes(rec.seedMapVotes),
  };
}

function parsePut(raw: object): DirectorToHost | null {
  const identities = (raw as { identities?: unknown }).identities;
  if (!Array.isArray(identities)) return null;
  const parsed: PoolIdentity[] = [];
  for (const row of identities) {
    const identity = sanitizeIdentity(row);
    if (identity) parsed.push(identity);
  }
  return { type: "put-identities", identities: parsed };
}

function parsePing(raw: object): DirectorToHost | null {
  const rec = raw as { pawnId?: unknown; pingMs?: unknown };
  if (typeof rec.pawnId !== "string" || rec.pawnId.length === 0) return null;
  if (typeof rec.pingMs !== "number" || !Number.isFinite(rec.pingMs)) return null;
  return { type: "set-ping", pawnId: rec.pawnId, pingMs: rec.pingMs };
}

function sanitizeChurn(raw: unknown): ChurnPolicy | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const band = finiteInt(rec.band);
  const chance = finiteNumber(rec.humanMirrorChance);
  const minDelayMs = finiteInt(rec.minDelayMs);
  const maxDelayMs = finiteInt(rec.maxDelayMs);
  if (band == null || chance == null || minDelayMs == null || maxDelayMs == null) {
    return null;
  }
  return {
    band: Math.max(0, Math.min(8, band)),
    humanMirrorChance: Math.max(0, Math.min(1, chance)),
    minDelayMs: Math.max(0, Math.min(24 * 60 * 60 * 1000, minDelayMs)),
    maxDelayMs: Math.max(0, Math.min(24 * 60 * 60 * 1000, maxDelayMs)),
  };
}

function sanitizeVotes(raw: unknown): VoteSeedPolicy | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const minShare = finiteNumber(rec.minShare);
  const maxShare = finiteNumber(rec.maxShare);
  if (minShare == null || maxShare == null) return null;
  const min = Math.max(0, Math.min(1, minShare));
  const max = Math.max(min, Math.min(1, maxShare));
  return { minShare: min, maxShare: max };
}

function sanitizeIdentity(raw: unknown): PoolIdentity | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.id !== "string" || typeof rec.name !== "string") return null;
  const id = rec.id.trim();
  const name = rec.name.trim();
  if (id.length === 0 || id.length > ID_MAX) return null;
  if (name.length === 0 || name.length > NAME_MAX) return null;
  if (typeof rec.profile !== "string" || rec.profile.length === 0) return null;
  if (rec.profile.length > ID_MAX) return null;
  let profileData: string | undefined;
  if (rec.profileData !== undefined) {
    if (typeof rec.profileData !== "string") return null;
    if (decodeProfileData(rec.profileData) == null) return null;
    profileData = rec.profileData;
  }
  const identity: PoolIdentity = { id, name, profile: rec.profile };
  if (profileData !== undefined) identity.profileData = profileData;
  if (typeof rec.accountId === "string" && rec.accountId.trim()) {
    identity.accountId = rec.accountId.trim().slice(0, ID_MAX);
  }
  if (rec.equipment && typeof rec.equipment === "object") {
    identity.equipment = rec.equipment as PlayerEquipment;
  }
  const skills = sanitizeSkills(rec.skills);
  if (skills) identity.skills = skills;
  const xp = finiteInt(rec.xp);
  if (xp != null && xp >= 0) identity.xp = xp;
  if (typeof rec.rankId === "string" && rec.rankId.length > 0) {
    identity.rankId = rec.rankId.slice(0, 32);
  }
  if (rec.founderBadge === true) identity.founderBadge = true;
  const ping = finiteInt(rec.initialPingMs);
  if (ping != null && ping >= 0) identity.initialPingMs = Math.min(9999, ping);
  return identity;
}

function sanitizeSkills(raw: unknown): PoolIdentitySkills | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as { ownedAbilities?: unknown; skillLoadout?: unknown };
  if (!Array.isArray(rec.ownedAbilities) || !Array.isArray(rec.skillLoadout)) {
    return null;
  }
  const ownedAbilities = rec.ownedAbilities.filter((id) => typeof id === "string");
  const skillLoadout = rec.skillLoadout.map((id) =>
    typeof id === "string" ? id : null
  );
  return { ownedAbilities, skillLoadout };
}

function finiteInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.floor(value);
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function isDropReason(value: unknown): value is IdentityDropReason {
  return value === "name-taken" || value === "pool-full" || value === "invalid";
}

function isRemoveReason(value: unknown): value is PawnRemoveReason {
  return value === "churn" || value === "eviction" || value === "rebalance" ||
    value === "match-end";
}
