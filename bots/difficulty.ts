/**
 * Grey-agent difficulty registry.
 *
 * `bots.difficulty` selects the agent's reaction and fire-rate config from
 * `@doors/bot-spec`. Official Easy / Medium / Hard brains are not in this
 * package. Think for fill and balance uses the built-in brain unless
 * `bots.brain` spawns a command.
 */

import type { BotDifficulty } from "./types.ts";

/** All currently implemented difficulties (order is display-friendly). */
export const BOT_DIFFICULTIES: readonly BotDifficulty[] = [
  "easy",
  "medium",
  "hard",
] as const;

export const DEFAULT_BOT_DIFFICULTY: BotDifficulty = "easy";

export function isBotDifficulty(value: unknown): value is BotDifficulty {
  return value === "easy" || value === "medium" || value === "hard";
}

/** Human-readable label for CLI / logs (authentic tier pool). */
export function difficultyLabel(difficulty: BotDifficulty): string {
  switch (difficulty) {
    case "easy":
      return "Easy (slow aim / reaction / ROF, soft path, less sprint)";
    case "medium":
      return "Medium (mid aim / path / sprint / ROF)";
    case "hard":
      return "Hard (snappy aim, full ROF, over-round corners, full sprint)";
    default: {
      const _exhaustive: never = difficulty;
      return String(_exhaustive);
    }
  }
}
