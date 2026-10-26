import { assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import {
  ADMIN_TOKEN_TYPE,
  JOIN_TOKEN_TYPE,
  signAuthorityToken,
  validateAuthorityPrivateKey,
  verifyAuthorityToken,
} from "./authorityTokens.ts";

function base64(value: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

Deno.test("authority private-key validation reports malformed configuration", async () => {
  let message = "";
  try {
    await validateAuthorityPrivateKey("not-a-pkcs8-key");
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assertEquals(
    message.startsWith(
      "AUTHORITY_TOKEN_PRIVATE_KEY must be an Ed25519 PKCS#8 private key",
    ),
    true,
  );
});

Deno.test("authority tokens are asymmetric, typed, and selected by kid", async () => {
  const pair = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const privateKey = base64(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  );
  const publicKey = base64(
    await crypto.subtle.exportKey("spki", pair.publicKey),
  );
  assertNotEquals(privateKey, publicKey);

  const token = await signAuthorityToken(
    {
      sub: "user_1",
      username: "Player1",
      serverId: "ranked",
      exp: 4_000_000_000,
    },
    privateKey,
    "2026-08",
    JOIN_TOKEN_TYPE,
  );
  assertEquals(
    await verifyAuthorityToken(
      token,
      { "2026-08": publicKey },
      JOIN_TOKEN_TYPE,
    ),
    {
      sub: "user_1",
      username: "Player1",
      serverId: "ranked",
      exp: 4_000_000_000,
    },
  );
  assertEquals(
    await verifyAuthorityToken(
      token,
      { "2026-08": publicKey },
      ADMIN_TOKEN_TYPE,
    ),
    null,
  );
  assertEquals(
    await verifyAuthorityToken(
      token,
      { "old-key": publicKey },
      JOIN_TOKEN_TYPE,
    ),
    null,
  );
});
