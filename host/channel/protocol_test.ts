import { assert, assertEquals } from "@std/assert";
import {
  decodeProfileData,
  encodeHostMessage,
  encodeProfileData,
  type ChurnPolicy,
  parseDirectorMessage,
  parseHostMessage,
  type VoteSeedPolicy,
} from "./protocol.ts";

const CHURN: ChurnPolicy = {
  band: 1,
  humanMirrorChance: 0.3,
  minDelayMs: 1_000,
  maxDelayMs: 2_000,
};
const VOTES: VoteSeedPolicy = { minShare: 0.2, maxShare: 0.8 };

Deno.test("host channel: policy round-trips and null turns knobs off", () => {
  const line = encodeHostMessage({
    type: "set-policy",
    churn: CHURN,
    seedMapVotes: VOTES,
  });
  assertEquals(parseDirectorMessage(line), {
    type: "set-policy",
    churn: CHURN,
    seedMapVotes: VOTES,
  });
  assertEquals(
    parseDirectorMessage(
      JSON.stringify({ type: "set-policy", churn: null, seedMapVotes: null }),
    ),
    { type: "set-policy", churn: null, seedMapVotes: null },
  );
});

Deno.test("host channel: bad lines and unknown types are ignored", () => {
  assertEquals(parseDirectorMessage(""), null);
  assertEquals(parseDirectorMessage("{"), null);
  assertEquals(parseDirectorMessage("[]"), null);
  assertEquals(parseDirectorMessage(JSON.stringify({ type: "nope" })), null);
  assertEquals(parseHostMessage(JSON.stringify({ type: "hello" })), null);
  assertEquals(parseHostMessage(JSON.stringify({ type: "match-over" })), {
    type: "match-over",
  });
});

Deno.test("host channel: put keeps valid rows and drops a bad profileData", () => {
  const ok = encodeProfileData(new TextEncoder().encode("{\"id\":\"easy\"}"));
  const parsed = parseDirectorMessage(JSON.stringify({
    type: "put-identities",
    identities: [
      { id: "a", name: "Ada", profile: "easy", profileData: ok },
      { id: "b", name: "Bea", profile: "easy", profileData: "@@@" },
      { id: "", name: "Cara", profile: "easy" },
    ],
  }));
  assert(parsed && parsed.type === "put-identities");
  if (!parsed || parsed.type !== "put-identities") return;
  assertEquals(parsed.identities.map((row) => row.id), ["a"]);
  assert(decodeProfileData(parsed.identities[0]!.profileData!) != null);
});

Deno.test("host channel: profileData over the cap is rejected", () => {
  assertEquals(decodeProfileData(""), null);
  assertEquals(decodeProfileData("a".repeat(65_537)), null);
});
