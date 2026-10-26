import { assertEquals, assertStringIncludes } from "@std/assert";
import { COMMUNITY_BOT_CONFIG } from "./botBrainConfig.ts";
import {
  BOT_DIFFICULTIES,
  DEFAULT_BOT_DIFFICULTY,
  difficultyLabel,
  isBotDifficulty,
} from "./difficulty.ts";

Deno.test("BOT_DIFFICULTIES lists easy, medium, and hard", () => {
  assertEquals([...BOT_DIFFICULTIES], ["easy", "medium", "hard"]);
});

Deno.test("isBotDifficulty accepts only known tiers", () => {
  assertEquals(isBotDifficulty("easy"), true);
  assertEquals(isBotDifficulty("medium"), true);
  assertEquals(isBotDifficulty("hard"), true);
  assertEquals(isBotDifficulty("extreme"), false);
  assertEquals(isBotDifficulty(""), false);
});

Deno.test("default difficulty stays easy", () => {
  assertEquals(DEFAULT_BOT_DIFFICULTY, "easy");
});

Deno.test("community autofill uses the community config", () => {
  assertEquals(COMMUNITY_BOT_CONFIG.id, "community");
});

Deno.test("difficultyLabel names each tier without stale door-only copy", () => {
  assertStringIncludes(difficultyLabel("easy"), "Easy");
  assertStringIncludes(difficultyLabel("medium"), "Medium");
  assertStringIncludes(difficultyLabel("hard"), "Hard");
  assertStringIncludes(difficultyLabel("easy"), "slow");
  assertStringIncludes(difficultyLabel("hard"), "snappy");
});
