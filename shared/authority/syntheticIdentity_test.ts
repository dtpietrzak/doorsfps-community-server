import { assertEquals } from "jsr:@std/assert@1";
import {
  isSyntheticUserId,
  LOADLAB_USERNAME_PREFIX,
  SYNTHETIC_USER_ID_PREFIX,
} from "./syntheticIdentity.ts";

Deno.test("synthetic user ids match the itest_ prefix only", () => {
  assertEquals(SYNTHETIC_USER_ID_PREFIX, "itest_");
  assertEquals(isSyntheticUserId("itest_ll_01"), true);
  assertEquals(isSyntheticUserId("itest_"), true);
  assertEquals(isSyntheticUserId("itest"), false);
  assertEquals(isSyntheticUserId("user_itest_clerk"), false);
  assertEquals(isSyntheticUserId("user_2abc"), false);
  assertEquals(isSyntheticUserId("rsv_public"), false);
  assertEquals(isSyntheticUserId(""), false);
  assertEquals(isSyntheticUserId(null), false);
  assertEquals(isSyntheticUserId(undefined), false);
  // Usernames are display-only. A LL_ name is not a policy identity.
  assertEquals(LOADLAB_USERNAME_PREFIX, "LL_");
  assertEquals(isSyntheticUserId("LL_wander01"), false);
  assertEquals(isSyntheticUserId(`${LOADLAB_USERNAME_PREFIX}x`), false);
});
