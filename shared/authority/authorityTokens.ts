/**
 * Asymmetric authority token envelope shared by the authority and runtimes.
 *
 * The authority is the only service that receives a PKCS#8 private key.
 * Runtimes receive a rotatable `kid -> SPKI public key` set and can therefore
 * verify admissions/admin actions without gaining token-issuing capability.
 */

import type { SkillLoadout, SkillProductId } from "../sim/skills.ts";
import type { MmsRankId } from "../progression/mmsRanks.ts";

export const JOIN_TOKEN_TYPE = "doors-join+jwt";
export const ADMIN_TOKEN_TYPE = "doors-admin+jwt";

export type AuthorityTokenType =
  | typeof JOIN_TOKEN_TYPE
  | typeof ADMIN_TOKEN_TYPE;

export type AuthorityPublicKeys = Readonly<Record<string, string>>;

/**
 * Open-placement assignment fields (S6-PR2). Present on official open admissions
 * once placement issues assignment-bearing tokens. Ranked tokens leave these off.
 */
export type OpenAssignmentClaims = {
  /**
   * Unique token id for single-use / reconnect reclaim. Required whenever
   * `assignmentId` is set.
   */
  jti: string;
  /** Authority seat reservation id this admission is bound to. */
  assignmentId: string;
};

export type RankedJoinClaims = {
  sub: string;
  username: string;
  /**
   * Assigned runtime id (token target). After host+slot cutover this is opaque
   * (`g00/0`); it does not encode mode. Prefer {@link modeId} for policy.
   */
  serverId: string;
  exp: number;
  /**
   * Occupancy mode at issue time (`easy` | `medium` | `hard` | `ranked` | `raid`).
   * Optional claim for unlock / mismatch detection when serverId is host+slot.
   */
  modeId?: string;
  partyId?: string;
  partySize?: number;
  /** Co-op raid catalog id when matchKind is raid. */
  raidId?: string;
  /** Forced human team for a raid admission. */
  team?: "A" | "B";
  /** Distinguishes raid admissions from official-open PvP. */
  matchKind?: "raid";
  /**
   * Authority-verified solo raid test: this admission may start the raid
   * below RAID_MIN_PLAYERS. Set only when a verified admin queued the raid
   * with the `unlock raids` bypass.
   */
  soloRaid?: boolean;
  /** Open placement: unique admission id (anti-replay + reconnect reclaim). */
  jti?: string;
  /** Open placement: seat reservation this join is bound to. */
  assignmentId?: string;
  head?: number;
  visor?: number;
  shoulder?: number;
  body?: number;
  leg?: number;
  hue?: number;
  gunHue?: number;
  bulletHue?: number;
  /** Packed crosshair color; -1 / omitted = default. */
  crosshairColor?: number;
  /** Own name tag hue shift -2…2 off team color; omitted = 0. */
  nameHue?: number;
  pistol?: number;
  rifle?: number;
  shotgun?: number;
  /** Rifle optic 0…4. Omitted joins use Standard. */
  scope?: number;
  crosshair?: number;
  ownedAbilities?: SkillProductId[];
  /**
   * Account-persisted Ability 1–4 bar. Omitted when the player has never
   * saved a loadout; the runtime then waits for `NetEvents.SkillLoadout`
   * (or uses the owned default).
   */
  skillLoadout?: SkillLoadout;
  /** Lifetime XP used for the in-match level badge. */
  xp?: number;
  /** Live percentile prestige band used for the in-match MMS badge. */
  mmsRankId?: MmsRankId;
  /** Permanent Founder’s Badge entitlement. */
  founderBadge?: boolean;
  /**
   * Itest/loadlab account. Emitted only when true. Runtimes copy this onto
   * `Player.synthetic` for heatmap and replay decisions. Authority persistence
   * still decides by `isSyntheticUserId`, not this flag.
   */
  synthetic?: boolean;
};

/** Parse optional open-assignment fields. Both present or both absent. */
export function parseOpenAssignmentClaims(
  payload: Record<string, unknown>,
  options: { required?: boolean } = {},
): OpenAssignmentClaims | null | undefined {
  const assignmentRaw = typeof payload.assignmentId === "string"
    ? payload.assignmentId.trim()
    : "";
  const jtiRaw = typeof payload.jti === "string" ? payload.jti.trim() : "";
  const hasAssignment = assignmentRaw.length > 0;
  const hasJti = jtiRaw.length > 0;
  if (options.required && (!hasAssignment || !hasJti)) return null;
  if (!hasAssignment && !hasJti) return undefined;
  // Partial assignment claims are always invalid (cannot anti-replay).
  if (hasAssignment !== hasJti) return null;
  if (assignmentRaw.length > 128 || jtiRaw.length > 128) return null;
  return { assignmentId: assignmentRaw, jti: jtiRaw };
}

type AuthorityTokenHeader = {
  alg: "EdDSA";
  kid: string;
  typ: AuthorityTokenType;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64UrlEncode(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const pad = value.length % 4 === 0 ? "" : "=".repeat(4 - (value.length % 4));
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function decodeKeyMaterial(value: string, label: string): Uint8Array {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is empty`);
  const pem = trimmed.match(
    /-----BEGIN [^-]+-----([\s\S]+?)-----END [^-]+-----/,
  );
  const encoded = (pem?.[1] ?? trimmed).replace(/\s+/g, "");
  try {
    return base64UrlDecode(encoded);
  } catch {
    throw new Error(`${label} must be PEM or base64/base64url DER`);
  }
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

async function importPrivateKey(material: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "pkcs8",
    asArrayBuffer(decodeKeyMaterial(material, "Authority token private key")),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
}

/** Fail fast when authority is configured with malformed signing material. */
export async function validateAuthorityPrivateKey(
  material: string,
): Promise<void> {
  try {
    await importPrivateKey(material);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      "AUTHORITY_TOKEN_PRIVATE_KEY must be an Ed25519 PKCS#8 private key " +
        `(PEM or base64/base64url DER): ${detail}`,
    );
  }
}

async function importPublicKey(material: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "spki",
    asArrayBuffer(decodeKeyMaterial(material, "Authority token public key")),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
}

export async function signAuthorityToken(
  payload: Record<string, unknown>,
  privateKey: string,
  keyId: string,
  type: AuthorityTokenType,
): Promise<string> {
  const kid = keyId.trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(kid) || kid === "__proto__") {
    throw new Error("Authority token key id must be URL/header safe");
  }
  const header: AuthorityTokenHeader = { alg: "EdDSA", kid, typ: type };
  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${
    base64UrlEncode(JSON.stringify(payload))
  }`;
  const signature = await crypto.subtle.sign(
    "Ed25519",
    await importPrivateKey(privateKey),
    encoder.encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export async function verifyAuthorityToken(
  token: unknown,
  publicKeys: AuthorityPublicKeys,
  expectedType: AuthorityTokenType,
): Promise<Record<string, unknown> | null> {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts;
  if (!headerPart || !payloadPart || !signaturePart) return null;

  let header: AuthorityTokenHeader;
  let payload: Record<string, unknown>;
  let signature: Uint8Array;
  try {
    header = JSON.parse(decoder.decode(base64UrlDecode(headerPart)));
    payload = JSON.parse(decoder.decode(base64UrlDecode(payloadPart)));
    signature = base64UrlDecode(signaturePart);
  } catch {
    return null;
  }
  if (
    !header || header.alg !== "EdDSA" || header.typ !== expectedType ||
    typeof header.kid !== "string" || !header.kid.trim() ||
    !payload || typeof payload !== "object" || Array.isArray(payload)
  ) {
    return null;
  }

  const material = publicKeys[header.kid];
  if (!material) return null;
  try {
    const ok = await crypto.subtle.verify(
      "Ed25519",
      await importPublicKey(material),
      asArrayBuffer(signature),
      encoder.encode(`${headerPart}.${payloadPart}`),
    );
    return ok ? payload : null;
  } catch {
    return null;
  }
}

/**
 * Load a rotatable public-key set. `AUTHORITY_TOKEN_PUBLIC_KEYS` is a JSON
 * object keyed by kid; the singular variables make local development simple.
 */
export function loadAuthorityPublicKeysFromEnv(): AuthorityPublicKeys {
  const env = (globalThis as typeof globalThis & {
    Deno?: { env?: { get(name: string): string | undefined } };
  }).Deno?.env;
  const raw = env?.get("AUTHORITY_TOKEN_PUBLIC_KEYS")?.trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const keys: Record<string, string> = Object.create(null);
      for (const [kid, value] of Object.entries(parsed)) {
        if (
          /^[A-Za-z0-9._-]{1,64}$/.test(kid) && kid !== "__proto__" &&
          typeof value === "string" && value.trim()
        ) {
          keys[kid.trim()] = value.trim();
        }
      }
      if (Object.keys(keys).length > 0) return keys;
    } catch {
      // The caller will report the resulting missing configuration.
    }
  }
  const single = env?.get("AUTHORITY_TOKEN_PUBLIC_KEY")?.trim();
  if (!single) return {};
  const kid = env?.get("AUTHORITY_TOKEN_KEY_ID")?.trim() || "v1";
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(kid) || kid === "__proto__") return {};
  return { [kid]: single };
}
