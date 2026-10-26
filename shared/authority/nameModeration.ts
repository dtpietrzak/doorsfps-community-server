/**
 * Backend name content checks (format + profanity / mean-word filter).
 *
 * Uses the `obscenity` package so the word list stays off the client bundle.
 * Import only from Deno backends (authority, game server) — not from the Vite client.
 */

import {
  RegExpMatcher,
  englishDataset,
  englishRecommendedTransformers,
} from "npm:obscenity@0.4.6";
import {
  ACCOUNT_USERNAME_MAX,
  ACCOUNT_USERNAME_MIN,
  NAME_CHAR_PATTERN,
  PLAYER_NAME_MAX,
  PLAYER_NAME_MIN,
  normalizeAccountUsername,
  normalizePlayerName,
} from "../sim/game.ts";

export type NameKind = "player" | "username";

export type NameCheckReason = "required" | "format" | "profanity" | "reserved";

export type NameCheckResult =
  | { ok: true; name: string; kind: NameKind }
  | {
    ok: false;
    kind: NameKind;
    reason: NameCheckReason;
    message: string;
  };

/**
 * Balance-bot display name (`"bot"`). Reserved so ranked accounts cannot
 * collide with the temporary team-balance filler.
 */
export const RESERVED_BALANCE_BOT_USERNAME = "bot";

const matcher = new RegExpMatcher({
  ...englishDataset.build(),
  ...englishRecommendedTransformers,
});

/**
 * Extra insults / mean terms not covered (or weakly covered) by obscenity.
 * Matched as whole tokens on underscore-split parts and on the collapsed form
 * when the term is long enough to avoid common substring false positives.
 */
const EXTRA_BLOCKED_WHOLE = new Set([
  "idiot",
  "idiots",
  "stupid",
  "moron",
  "morons",
  "loser",
  "losers",
  "retard",
  "retarded",
  "retards",
  "dumbass",
  "jackass",
  "asshat",
  "asswipe",
  "kys",
  "stfu",
  "gtfo",
  "noob",
  "n00b",
  "fag",
  "faggot",
  "faggots",
  "tranny",
  "whore",
  "whores",
  "slut",
  "sluts",
  "rape",
  "rapist",
  "nazi",
  "hitler",
]);

const EXTRA_BLOCKED_SUBSTRING = [
  "killmyself",
  "killyourself",
  "killurself",
  "hangmyself",
  "neckmyself",
];

function formatMessage(kind: NameKind): string {
  if (kind === "username") {
    return (
      `Username must be ${ACCOUNT_USERNAME_MIN}–${ACCOUNT_USERNAME_MAX} characters: ` +
      "letters, numbers, and underscore only (start with a letter or number)."
    );
  }
  return (
    `Name must be ${PLAYER_NAME_MIN}–${PLAYER_NAME_MAX} characters: ` +
    "letters, numbers, and underscore only (start with a letter or number)."
  );
}

function profanityMessage(kind: NameKind): string {
  return kind === "username"
    ? "That username is not allowed. Choose a different one."
    : "That name is not allowed. Choose a different one.";
}

function reservedUsernameMessage(): string {
  return "That username is reserved. Choose a different one.";
}

/**
 * True when a ranked account must not claim this handle because it is the
 * balance-bot name `"bot"` (case-insensitive).
 */
export function isReservedAccountUsername(name: string): boolean {
  const key = name.trim().toLocaleLowerCase();
  if (!key) return false;
  return key === RESERVED_BALANCE_BOT_USERNAME;
}

/** Collapse underscores so f_u_c_k / a_s_s still match word lists. */
export function collapsedForModeration(name: string): string {
  return name.replace(/_/g, "");
}

export function containsProfanity(text: string): boolean {
  const raw = text.trim();
  if (!raw) return false;

  if (matcher.hasMatch(raw)) return true;

  const collapsed = collapsedForModeration(raw);
  if (collapsed !== raw && matcher.hasMatch(collapsed)) return true;

  const lower = raw.toLowerCase();
  const lowerCollapsed = collapsed.toLowerCase();

  for (const part of lower.split("_")) {
    if (part && EXTRA_BLOCKED_WHOLE.has(part)) return true;
  }
  if (EXTRA_BLOCKED_WHOLE.has(lowerCollapsed)) return true;

  for (const term of EXTRA_BLOCKED_SUBSTRING) {
    if (lowerCollapsed.includes(term)) return true;
  }

  return false;
}

/**
 * Full validation for open/custom guest display names.
 */
export function checkPlayerName(raw: unknown): NameCheckResult {
  const kind: NameKind = "player";
  if (typeof raw !== "string" || !raw.trim()) {
    return {
      ok: false,
      kind,
      reason: "required",
      message: "Enter a player name before joining.",
    };
  }
  const name = normalizePlayerName(raw);
  if (!name) {
    return { ok: false, kind, reason: "format", message: formatMessage(kind) };
  }
  if (containsProfanity(name)) {
    return {
      ok: false,
      kind,
      reason: "profanity",
      message: profanityMessage(kind),
    };
  }
  return { ok: true, name, kind };
}

/**
 * Full validation for ranked account usernames.
 * Rejects the reserved balance-bot name. Pass `isReserved` to add more
 * reserved handles without putting that list in this module.
 */
export function checkAccountUsername(
  raw: unknown,
  isReserved: (name: string) => boolean = isReservedAccountUsername,
): NameCheckResult {
  const kind: NameKind = "username";
  if (typeof raw !== "string" || !raw.trim()) {
    return {
      ok: false,
      kind,
      reason: "required",
      message: "Enter a username.",
    };
  }
  const name = normalizeAccountUsername(raw);
  if (!name) {
    return { ok: false, kind, reason: "format", message: formatMessage(kind) };
  }
  if (isReserved(name)) {
    return {
      ok: false,
      kind,
      reason: "reserved",
      message: reservedUsernameMessage(),
    };
  }
  if (containsProfanity(name)) {
    return {
      ok: false,
      kind,
      reason: "profanity",
      message: profanityMessage(kind),
    };
  }
  return { ok: true, name, kind };
}

export function checkName(
  raw: unknown,
  kind: NameKind = "player",
): NameCheckResult {
  return kind === "username" ? checkAccountUsername(raw) : checkPlayerName(raw);
}

/** True when the string matches the shared alphanumeric+underscore charset. */
export function matchesNameCharset(raw: string): boolean {
  return NAME_CHAR_PATTERN.test(raw.trim());
}
