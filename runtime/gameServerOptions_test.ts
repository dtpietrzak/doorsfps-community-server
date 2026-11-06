import { assertEquals } from "@std/assert";
import { DEFAULT_MAX_PLAYERS } from "./gameServerOptions.ts";

Deno.test("DEFAULT_MAX_PLAYERS stays 8", () => {
  assertEquals(DEFAULT_MAX_PLAYERS, 8);
});
