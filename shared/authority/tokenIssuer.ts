/**
 * Clerk-free authority token issuance helpers.
 *
 * These helpers use the authority's private key but do not perform identity
 * verification. Keeping them separate lets runtime contract tests issue tokens
 * without loading the Clerk SDK.
 */

import {
  JOIN_TOKEN_TYPE,
  type RankedJoinClaims,
  signAuthorityToken,
} from "./authorityTokens.ts";

const JOIN_TOKEN_TTL_SECONDS = 60;

/** Unique admission id for open assignment-bearing tokens. */
export function newAdmissionJti(): string {
  return `jti_${crypto.randomUUID().replaceAll("-", "")}`;
}

function withAssignmentJti<T extends { assignmentId?: string; jti?: string }>(
  claims: T,
): T {
  const assignmentId = typeof claims.assignmentId === "string"
    ? claims.assignmentId.trim()
    : "";
  if (!assignmentId) {
    // Strip partial/empty assignment fields so verification stays dual-accept safe.
    const { assignmentId: _a, jti: _j, ...rest } = claims;
    return rest as T;
  }
  const jti = typeof claims.jti === "string" && claims.jti.trim()
    ? claims.jti.trim()
    : newAdmissionJti();
  return { ...claims, assignmentId, jti };
}

/** Issue a short-lived join token for a ranked authentic server. */
export async function issueRankedJoinToken(
  claims: Omit<RankedJoinClaims, "exp">,
  privateKey: string,
  keyId: string,
  ttlSeconds = JOIN_TOKEN_TTL_SECONDS,
): Promise<{ joinToken: string; exp: number; jti?: string }> {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const withAssign = withAssignmentJti(claims);
  const payload: RankedJoinClaims = { ...withAssign, exp };
  const joinToken = await signAuthorityToken(
    payload as Record<string, unknown>,
    privateKey,
    keyId,
    JOIN_TOKEN_TYPE,
  );
  return {
    joinToken,
    exp,
    ...(payload.jti ? { jti: payload.jti } : {}),
  };
}
