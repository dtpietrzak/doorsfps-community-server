import { assertEquals } from "jsr:@std/assert@1";
import {
  issueRankedJoinToken,
} from "../shared/authority/tokenIssuer.ts";
import {
  isOpenOfficialServerId,
  loadOpenAssignmentRequiredFromEnv,
  OPEN_OFFICIAL_SERVER_IDS,
  verifyRankedJoinToken,
} from "./rankedAuth.ts";
import { parseOpenAssignmentClaims } from "../shared/authority/authorityTokens.ts";

function base64(value: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function keys() {
  const pair = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  return {
    privateKey: base64(
      await crypto.subtle.exportKey("pkcs8", pair.privateKey),
    ),
    publicKeys: {
      current: base64(await crypto.subtle.exportKey("spki", pair.publicKey)),
    },
  };
}

Deno.test("OPEN_OFFICIAL_SERVER_IDS includes easy, medium, and hard", () => {
  assertEquals([...OPEN_OFFICIAL_SERVER_IDS], ["easy", "medium", "hard"]);
});

Deno.test("isOpenOfficialServerId accepts all open authentic ids", () => {
  assertEquals(isOpenOfficialServerId("easy"), true);
  assertEquals(isOpenOfficialServerId("medium"), true);
  assertEquals(isOpenOfficialServerId("hard"), true);
  assertEquals(isOpenOfficialServerId("g01/hard"), true);
  assertEquals(isOpenOfficialServerId("g01/hard/2"), true);
  assertEquals(isOpenOfficialServerId("MEDIUM"), true);
  assertEquals(isOpenOfficialServerId(" hard "), true);
  // Host+slot runtime ids need explicit modeId.
  assertEquals(isOpenOfficialServerId("g00/0", "easy"), true);
  assertEquals(isOpenOfficialServerId("g00/1", "hard"), true);
  assertEquals(isOpenOfficialServerId("g00/3", "medium"), true);
});

Deno.test("isOpenOfficialServerId rejects ranked and unknown ids", () => {
  assertEquals(isOpenOfficialServerId("ranked"), false);
  assertEquals(isOpenOfficialServerId(""), false);
  assertEquals(isOpenOfficialServerId(null), false);
  assertEquals(isOpenOfficialServerId(undefined), false);
  assertEquals(isOpenOfficialServerId("open-medium"), false);
  assertEquals(isOpenOfficialServerId("g00/0"), false);
  assertEquals(isOpenOfficialServerId("g00/2", "ranked"), false);
  assertEquals(isOpenOfficialServerId("g00/4", "community"), false);
});

Deno.test("parseOpenAssignmentClaims requires both or neither fields", () => {
  assertEquals(parseOpenAssignmentClaims({}), undefined);
  assertEquals(
    parseOpenAssignmentClaims({ assignmentId: "osr_1", jti: "jti_1" }),
    { assignmentId: "osr_1", jti: "jti_1" },
  );
  assertEquals(parseOpenAssignmentClaims({ assignmentId: "osr_1" }), null);
  assertEquals(parseOpenAssignmentClaims({ jti: "jti_1" }), null);
  assertEquals(
    parseOpenAssignmentClaims({}, { required: true }),
    null,
  );
});

Deno.test("expired assignment-bearing join tokens are rejected", async () => {
  const key = await keys();
  const expired = await issueRankedJoinToken(
    {
      sub: "user_x",
      username: "ExpiredOpen",
      serverId: "g00/0",
      modeId: "easy",
      assignmentId: "osr_exp",
    },
    key.privateKey,
    "current",
    -1,
  );
  assertEquals(
    await verifyRankedJoinToken(
      expired.joinToken,
      key.publicKeys,
      "g00/0",
      { requireOpenAssignment: true },
    ),
    null,
  );
});

Deno.test("join token scope round-trips and omitted scope is Standard", async () => {
  const key = await keys();
  const issued = await issueRankedJoinToken(
    {
      sub: "user_scope",
      username: "Scoped",
      serverId: "ranked",
      shotgun: 1,
      scope: 4,
      crosshair: 2,
    },
    key.privateKey,
    "current",
  );
  const claims = await verifyRankedJoinToken(
    issued.joinToken,
    key.publicKeys,
    "ranked",
  );
  assertEquals(claims?.shotgun, 1);
  assertEquals(claims?.scope, 4);
  assertEquals(claims?.crosshair, 2);

  const omitted = await issueRankedJoinToken(
    {
      sub: "user_scope0",
      username: "Plain",
      serverId: "ranked",
    },
    key.privateKey,
    "current",
  );
  const plain = await verifyRankedJoinToken(
    omitted.joinToken,
    key.publicKeys,
    "ranked",
  );
  assertEquals(plain?.scope, 0);
});

Deno.test("cancelled-style partial assignment claims are rejected", async () => {
  const key = await keys();
  // Issue without going through withAssignmentJti — force partial payload.
  const { signAuthorityToken, JOIN_TOKEN_TYPE } = await import(
    "../shared/authority/authorityTokens.ts"
  );
  const token = await signAuthorityToken(
    {
      sub: "user_partial",
      username: "Partial",
      serverId: "g00/0",
      exp: Math.floor(Date.now() / 1000) + 60,
      assignmentId: "osr_partial",
      // jti intentionally omitted
    },
    key.privateKey,
    "current",
    JOIN_TOKEN_TYPE,
  );
  assertEquals(
    await verifyRankedJoinToken(token, key.publicKeys, "g00/0"),
    null,
  );
});

Deno.test("feature-flag rollback accepts open join tokens without assignment claims", async () => {
  const key = await keys();
  // When OPEN_ASSIGNMENT_REQUIRED is off, tokens without assignment still verify.
  const issued = await issueRankedJoinToken(
    {
      sub: "user_open",
      username: "OpenPlayer",
      serverId: "g00/0",
      modeId: "easy",
    },
    key.privateKey,
    "current",
  );
  assertEquals(
    (await verifyRankedJoinToken(
      issued.joinToken,
      key.publicKeys,
      "g00/0",
      { requireOpenAssignment: false },
    ))?.username,
    "OpenPlayer",
  );
  assertEquals(
    await verifyRankedJoinToken(
      issued.joinToken,
      key.publicKeys,
      "g00/0",
      { requireOpenAssignment: true },
    ),
    null,
  );
});

Deno.test("solo raid admissions round-trip the soloRaid claim", async () => {
  const key = await keys();
  const issued = await issueRankedJoinToken(
    {
      sub: "user_solo",
      username: "SoloRaid",
      serverId: "g00/2",
      modeId: "raid",
      matchKind: "raid",
      raidId: "maze",
      team: "A",
      partyId: "op_solo",
      partySize: 1,
      assignmentId: "osr_solo",
      soloRaid: true,
    },
    key.privateKey,
    "current",
  );
  const claims = await verifyRankedJoinToken(
    issued.joinToken,
    key.publicKeys,
    "g00/2",
    { requireOpenAssignment: true },
  );
  assertEquals(claims?.soloRaid, true);
  assertEquals(claims?.raidId, "maze");
  assertEquals(claims?.partySize, 1);

  const plain = await issueRankedJoinToken(
    {
      sub: "user_duo",
      username: "DuoRaid",
      serverId: "g00/2",
      modeId: "raid",
      matchKind: "raid",
      raidId: "crossroads",
      partySize: 2,
      assignmentId: "osr_duo",
    },
    key.privateKey,
    "current",
  );
  const plainClaims = await verifyRankedJoinToken(
    plain.joinToken,
    key.publicKeys,
    "g00/2",
    { requireOpenAssignment: true },
  );
  assertEquals(plainClaims?.soloRaid, undefined);
});

Deno.test("synthetic join claim round-trips only when true", async () => {
  const key = await keys();
  const issued = await issueRankedJoinToken(
    {
      sub: "itest_ll_01",
      username: "LL_one",
      serverId: "g00/0",
      modeId: "hard",
      assignmentId: "osr_syn",
      synthetic: true,
    },
    key.privateKey,
    "current",
  );
  const claims = await verifyRankedJoinToken(
    issued.joinToken,
    key.publicKeys,
    "g00/0",
    { requireOpenAssignment: true },
  );
  assertEquals(claims?.synthetic, true);
  assertEquals(claims != null && "synthetic" in claims, true);

  const plain = await issueRankedJoinToken(
    {
      sub: "user_plain",
      username: "Plain",
      serverId: "g00/0",
      assignmentId: "osr_plain",
    },
    key.privateKey,
    "current",
  );
  const plainClaims = await verifyRankedJoinToken(
    plain.joinToken,
    key.publicKeys,
    "g00/0",
    { requireOpenAssignment: true },
  );
  assertEquals(plainClaims != null && "synthetic" in plainClaims, false);

  const explicitFalse = await issueRankedJoinToken(
    {
      sub: "user_false",
      username: "FalseBit",
      serverId: "g00/0",
      assignmentId: "osr_false",
      synthetic: false,
    },
    key.privateKey,
    "current",
  );
  const falseClaims = await verifyRankedJoinToken(
    explicitFalse.joinToken,
    key.publicKeys,
    "g00/0",
    { requireOpenAssignment: true },
  );
  assertEquals(falseClaims != null && "synthetic" in falseClaims, false);
});

Deno.test("loadOpenAssignmentRequiredFromEnv defaults off", () => {
  const prev = Deno.env.get("OPEN_ASSIGNMENT_REQUIRED");
  try {
    Deno.env.delete("OPEN_ASSIGNMENT_REQUIRED");
    assertEquals(loadOpenAssignmentRequiredFromEnv(), false);
    Deno.env.set("OPEN_ASSIGNMENT_REQUIRED", "true");
    assertEquals(loadOpenAssignmentRequiredFromEnv(), true);
    Deno.env.set("OPEN_ASSIGNMENT_REQUIRED", "false");
    assertEquals(loadOpenAssignmentRequiredFromEnv(), false);
  } finally {
    if (prev === undefined) Deno.env.delete("OPEN_ASSIGNMENT_REQUIRED");
    else Deno.env.set("OPEN_ASSIGNMENT_REQUIRED", prev);
  }
});
