import { assertEquals } from "jsr:@std/assert@1";
import {
  consumeOpenAdmissionJti,
  openAdmissionJtiCountForTests,
  openAdmissionSubjectKey,
  resetOpenAdmissionJtisForTests,
} from "./openAdmission.ts";

Deno.test("open admission subject keys distinguish account vs guest", () => {
  assertEquals(
    openAdmissionSubjectKey({ accountUserId: "user_1", name: "Alice" }),
    "account:user_1",
  );
  assertEquals(
    openAdmissionSubjectKey({ name: "Alice" }),
    "guest:alice",
  );
});

Deno.test("open admission jti accepts once and reclaims same subject", () => {
  resetOpenAdmissionJtisForTests();
  const exp = Math.floor(Date.now() / 1000) + 60;
  const subject = openAdmissionSubjectKey({
    accountUserId: "user_a",
    name: "A",
  });
  assertEquals(consumeOpenAdmissionJti("jti_1", exp, subject), "accepted");
  assertEquals(consumeOpenAdmissionJti("jti_1", exp, subject), "reclaim");
  assertEquals(openAdmissionJtiCountForTests(), 1);
});

Deno.test("open admission jti rejects cross-subject replay", () => {
  resetOpenAdmissionJtisForTests();
  const exp = Math.floor(Date.now() / 1000) + 60;
  assertEquals(
    consumeOpenAdmissionJti(
      "jti_2",
      exp,
      openAdmissionSubjectKey({ accountUserId: "user_a", name: "A" }),
    ),
    "accepted",
  );
  assertEquals(
    consumeOpenAdmissionJti(
      "jti_2",
      exp,
      openAdmissionSubjectKey({ accountUserId: "user_b", name: "B" }),
    ),
    "replay",
  );
});

Deno.test("open admission jti rejects expired tokens", () => {
  resetOpenAdmissionJtisForTests();
  const now = Math.floor(Date.now() / 1000);
  assertEquals(
    consumeOpenAdmissionJti(
      "jti_exp",
      now - 1,
      openAdmissionSubjectKey({ name: "Gone" }),
      now,
    ),
    "replay",
  );
});
