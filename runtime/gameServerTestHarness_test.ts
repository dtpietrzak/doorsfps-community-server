import { assertEquals, assertMatch, assertThrows } from "@std/assert";
import {
  methodBody,
  readRepoSource,
  stripComments,
} from "./gameServerTestHarness.ts";

Deno.test("harness stripComments drops line and block comments", () => {
  const src = stripComments(
    "keep();\n// gone\n/* block\n * still gone */\nstay(); // tail\nhttp://ok",
  );
  assertEquals(src.includes("gone"), false);
  assertEquals(src.includes("keep();"), true);
  assertEquals(src.includes("stay();"), true);
  assertEquals(src.includes("http://ok"), true);
});

Deno.test("harness methodBody reads stepSimBody, not the stepSim wrapper", () => {
  const src = stripComments(readRepoSource("runtime/GameServer.ts"));
  const wrapper = methodBody(src, "stepSim");
  const body = methodBody(src, "stepSimBody");
  assertEquals(wrapper.includes("checkMatchEnd"), false);
  assertMatch(body, /checkMatchEnd/);
  assertMatch(body, /finishIntermission/);
  assertThrows(() => methodBody(src, "notARealMethod"));
});
