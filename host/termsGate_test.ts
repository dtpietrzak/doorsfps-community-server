import { assertEquals, assertMatch } from "@std/assert";
import {
  isAcceptAnswer,
  isTruthyAcceptEnv,
  presetTermsAcceptance,
  TERMS_VERSION,
} from "./termsGate.ts";

Deno.test("presetTermsAcceptance: flag wins, then env, else prompt", () => {
  assertEquals(presetTermsAcceptance(["--accept-terms"], undefined), "flag");
  assertEquals(presetTermsAcceptance(["--accept-terms"], "1"), "flag");
  assertEquals(presetTermsAcceptance([], "1"), "env");
  assertEquals(presetTermsAcceptance([], undefined), null);
  assertEquals(presetTermsAcceptance(["--open"], "0"), null);
});

Deno.test("isTruthyAcceptEnv: only explicit yes values", () => {
  for (const v of ["1", "true", "TRUE", " yes "]) {
    assertEquals(isTruthyAcceptEnv(v), true, v);
  }
  for (const v of [undefined, "", "0", "false", "no", "accept"]) {
    assertEquals(isTruthyAcceptEnv(v), false, String(v));
  }
});

Deno.test("isAcceptAnswer: blank or other answers decline", () => {
  for (const a of ["accept", "Accept", "I accept", "y", "yes"]) {
    assertEquals(isAcceptAnswer(a), true, a);
  }
  for (const a of [null, "", "n", "no", "quit"]) {
    assertEquals(isAcceptAnswer(a), false, String(a));
  }
});

Deno.test("TERMS_VERSION matches the Version line in TERMS.md", async () => {
  const text = await Deno.readTextFile(
    new URL("../TERMS.md", import.meta.url),
  );
  assertMatch(text, new RegExp(`^\\*\\*Version:\\*\\* ${TERMS_VERSION}$`, "m"));
});
