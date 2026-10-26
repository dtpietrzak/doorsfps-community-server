/**
 * Authority-issued admin action tokens. Runtimes verify Ed25519 signatures
 * with public keys only; the token type prevents join/admin cross-use.
 */

import {
  ADMIN_ACTION_TYP,
  type AdminActionClaims,
  parseAdminCommandRequest,
} from "../shared/admin/adminCommands.ts";
import {
  ADMIN_TOKEN_TYPE,
  type AuthorityPublicKeys,
  verifyAuthorityToken,
} from "../shared/authority/authorityTokens.ts";

/** In-memory jti anti-replay (per process). */
const usedJti = new Map<string, number>();
const JTI_PRUNE_EVERY = 32;
let jtiOps = 0;

function pruneJti(now: number): void {
  jtiOps += 1;
  if (jtiOps % JTI_PRUNE_EVERY !== 0) return;
  for (const [id, until] of usedJti) {
    if (until < now) usedJti.delete(id);
  }
}

/**
 * Mark a verified token's jti as used. Returns false if already used.
 * Call only after identity checks succeed so failed attempts can retry.
 */
export function consumeAdminActionJti(jti: string, exp: number): boolean {
  const now = Math.floor(Date.now() / 1000);
  pruneJti(now);
  if (usedJti.has(jti)) return false;
  usedJti.set(jti, exp);
  return true;
}

/**
 * Verify an admin action token (does not consume jti — call consumeAdminActionJti after authz).
 */
export async function verifyAdminActionToken(
  token: unknown,
  publicKeys: AuthorityPublicKeys,
  expectedServerId?: string,
): Promise<
  | { ok: true; claims: AdminActionClaims }
  | { ok: false; error: string; code: string }
> {
  const raw = await verifyAuthorityToken(token, publicKeys, ADMIN_TOKEN_TYPE);
  if (!raw) {
    return {
      ok: false,
      error: "Invalid admin token payload.",
      code: "admin_token_invalid",
    };
  }

  if (raw.typ !== ADMIN_ACTION_TYP) {
    return {
      ok: false,
      error: "Token is not an admin action token.",
      code: "admin_token_invalid",
    };
  }
  if (typeof raw.sub !== "string" || !raw.sub.trim()) {
    return {
      ok: false,
      error: "Invalid admin token subject.",
      code: "admin_token_invalid",
    };
  }
  if (typeof raw.cmd !== "string" || !raw.cmd.trim()) {
    return {
      ok: false,
      error: "Invalid admin token command.",
      code: "admin_token_invalid",
    };
  }
  if (typeof raw.exp !== "number" || !Number.isFinite(raw.exp)) {
    return {
      ok: false,
      error: "Invalid admin token expiry.",
      code: "admin_token_invalid",
    };
  }
  if (typeof raw.jti !== "string" || !raw.jti.trim()) {
    return {
      ok: false,
      error: "Invalid admin token id.",
      code: "admin_token_invalid",
    };
  }

  const now = Math.floor(Date.now() / 1000);
  if (raw.exp < now) {
    return {
      ok: false,
      error: "Admin token expired.",
      code: "admin_token_expired",
    };
  }

  const serverId = typeof raw.serverId === "string" && raw.serverId.trim()
    ? raw.serverId.trim()
    : undefined;
  if (expectedServerId && serverId && serverId !== expectedServerId) {
    return {
      ok: false,
      error: "Admin token is for a different server.",
      code: "admin_server_mismatch",
    };
  }

  const parsed = parseAdminCommandRequest(raw.cmd, raw.args ?? {});
  if (!parsed.ok) {
    return { ok: false, error: parsed.error, code: "admin_args_invalid" };
  }

  const jti = raw.jti.trim();
  if (usedJti.has(jti)) {
    return {
      ok: false,
      error: "Admin token already used.",
      code: "admin_token_replay",
    };
  }

  const claims: AdminActionClaims = {
    typ: ADMIN_ACTION_TYP,
    sub: raw.sub.trim(),
    cmd: parsed.command,
    args: parsed.args,
    exp: raw.exp,
    jti,
    ...(serverId ? { serverId } : {}),
  };

  return { ok: true, claims };
}
