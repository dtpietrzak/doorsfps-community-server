import { assertEquals } from "jsr:@std/assert@1";
import { envFileName } from "./loadRepoEnv.ts";

Deno.test("envFileName defaults to development", () => {
  assertEquals(envFileName(undefined), ".env.development");
  assertEquals(envFileName(""), ".env.development");
  assertEquals(envFileName("development"), ".env.development");
});

Deno.test("envFileName treats prod and production as .env.prod", () => {
  assertEquals(envFileName("prod"), ".env.prod");
  assertEquals(envFileName("production"), ".env.prod");
  assertEquals(envFileName("PROD"), ".env.prod");
});
