/**
 * Server config loaded from config.json next to the executable (or CWD),
 * same discovery style as the maps/ directory.
 */

import { DEFAULT_BOT_FILL } from "../bots/BotManager.ts";
import { DEFAULT_BOT_DIFFICULTY, isBotDifficulty } from "../bots/difficulty.ts";
import type { BotDifficulty } from "../bots/types.ts";
import { MATCH_DURATION_SECONDS } from "../protocol/network.ts";

export type ServerBotsConfig = {
  /**
   * Desired total roster size (humans + bots) for auto-fill.
   * When noBotsOnEmptyServer is true, 0 humans still yields 0 bots.
   */
  autofillBots: number;
  /**
   * AI skill tier for auto-filled and CLI-spawned bots.
   * `"easy"` | `"medium"` | `"hard"`; add tiers in bots/difficulty.ts.
   */
  difficulty: BotDifficulty;
  /**
   * When true (default), the server drops all bots once no human is connected.
   * Set to false so bots keep auto-filling and playing on an empty server.
   */
  noBotsOnEmptyServer: boolean;
  /**
   * Fill and balance brain. `"builtin"` thinks in process.
   * A command array spawns that process for fill and balance only.
   * Agents, raid, and pool pawns stay on the built-in brain.
   */
  brain: "builtin" | readonly string[];
};

export type ServerConfig = {
  /**
   * Join password for community / custom servers.
   * Required to start a community host (`null` / blank is rejected in main).
   * Official runtimes ignore this even if present in config.json.
   */
  password: string | null;
  /**
   * Hard cap on connected players (humans + bots).
   * Bots never fill past this; joins are rejected when full.
   */
  maxPlayers: number;
  /**
   * Live match length in seconds (time limit → leading team wins).
   * Score win (first to WIN_SCORE by 2) can still end earlier.
   */
  matchDurationSeconds: number;
  /**
   * Starting map at boot: map display name, stem, or filename
   * (same resolution as the CLI `map` command).
   * `null` = pick a random map from the catalog.
   */
  map: string | null;
  /**
   * Optional allow-list of map display names (DoorsMap.name).
   * When set, only those maps are loaded into the catalog / rotation.
   * Names that are not found under maps/ are skipped (with a console log).
   * Omit or leave unset to load every discovered map.
   */
  mapRotation?: string[];
  bots: ServerBotsConfig;
};

/** Default roster size when config omits maxPlayers (historical hardcoded cap). */
export const DEFAULT_MAX_PLAYERS = 8;

/** Inclusive clamps for host-tunable limits. */
export const MAX_PLAYERS_MIN = 1;
export const MAX_PLAYERS_MAX = 64;
export const MATCH_DURATION_SECONDS_MIN = 30;
export const MATCH_DURATION_SECONDS_MAX = 3 * 60 * 60; // 3 hours

/** Inclusive max length for a community join password. */
export const JOIN_PASSWORD_MAX = 64;

export const DEFAULT_SERVER_CONFIG: ServerConfig = {
  maxPlayers: DEFAULT_MAX_PLAYERS,
  matchDurationSeconds: MATCH_DURATION_SECONDS,
  map: null,
  password: null,
  bots: {
    autofillBots: DEFAULT_BOT_FILL.minPlayers,
    difficulty: DEFAULT_BOT_DIFFICULTY,
    noBotsOnEmptyServer: DEFAULT_BOT_FILL.noBotsOnEmptyServer,
    brain: "builtin",
  },
};

export type LoadedServerConfig = {
  config: ServerConfig;
  /** Path that was read, or null when defaults were used. */
  path: string | null;
};

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function tryExecutableDirConfigPath(): string | undefined {
  try {
    const executable = Deno.execPath();
    const executableDir = executable.replace(/[/\\][^/\\]*$/, "");
    return `${executableDir}/config.json`;
  } catch {
    return undefined;
  }
}

/** Config file paths in priority order for dev and compiled builds. */
export function getConfigPathCandidates(): string[] {
  return unique([
    "./config.json",
    tryExecutableDirConfigPath() ?? "",
    "./server-community/config.json",
    "./server/config.json",
  ].filter((v) => v.length > 0));
}

function clampAutofillBots(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n)) {
    return DEFAULT_SERVER_CONFIG.bots.autofillBots;
  }
  return Math.max(0, Math.floor(n));
}

function clampMaxPlayers(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n)) {
    return DEFAULT_SERVER_CONFIG.maxPlayers;
  }
  return Math.min(
    MAX_PLAYERS_MAX,
    Math.max(MAX_PLAYERS_MIN, Math.floor(n)),
  );
}

function clampMatchDurationSeconds(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n)) {
    return DEFAULT_SERVER_CONFIG.matchDurationSeconds;
  }
  return Math.min(
    MATCH_DURATION_SECONDS_MAX,
    Math.max(MATCH_DURATION_SECONDS_MIN, Math.floor(n)),
  );
}

function parseDifficulty(value: unknown): BotDifficulty {
  if (typeof value === "string") {
    const key = value.trim().toLowerCase();
    if (isBotDifficulty(key)) return key;
  }
  return DEFAULT_SERVER_CONFIG.bots.difficulty;
}

function parseNoBotsOnEmptyServer(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  return DEFAULT_SERVER_CONFIG.bots.noBotsOnEmptyServer;
}

/**
 * Missing, `"builtin"`, empty, and non-string arrays fall back to builtin.
 * A non-empty string array is the fill/balance command.
 */
function parseBrain(value: unknown): "builtin" | string[] {
  if (value === undefined || value === "builtin") return "builtin";
  if (!Array.isArray(value) || value.length === 0) return "builtin";
  const command: string[] = [];
  for (const part of value) {
    if (typeof part !== "string") return "builtin";
    const trimmed = part.trim();
    if (trimmed.length === 0) return "builtin";
    command.push(trimmed);
  }
  return command;
}

export const COMMUNITY_JOIN_PASSWORD_REQUIRED =
  'Community servers require a join password. Set "password" in config.json to a secret you will share with friends, then start again.';

/**
 * Join password. Missing / blank / non-string → null (rejected at community boot).
 * Trimmed; capped at JOIN_PASSWORD_MAX.
 */
export function parseJoinPassword(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > JOIN_PASSWORD_MAX
    ? trimmed.slice(0, JOIN_PASSWORD_MAX)
    : trimmed;
}

/** Non-empty string → map query; missing/blank/invalid → null (random). */
function parseStartingMap(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Optional map-name allow-list. Invalid / missing → undefined (all maps).
 * Empty array after cleaning stays empty (load none from rotation).
 */
function parseMapRotation(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(trimmed);
  }
  return names;
}

/** Parse unknown JSON into a validated ServerConfig (partials merge with defaults). */
export function parseServerConfig(data: unknown): ServerConfig {
  const root = (data && typeof data === "object")
    ? data as Record<string, unknown>
    : {};
  const botsRaw = (root.bots && typeof root.bots === "object")
    ? root.bots as Record<string, unknown>
    : {};

  const mapRotation = "mapRotation" in root
    ? parseMapRotation(root.mapRotation)
    : undefined;

  return {
    maxPlayers: clampMaxPlayers(
      root.maxPlayers ?? DEFAULT_SERVER_CONFIG.maxPlayers,
    ),
    matchDurationSeconds: clampMatchDurationSeconds(
      root.matchDurationSeconds ?? DEFAULT_SERVER_CONFIG.matchDurationSeconds,
    ),
    map: parseStartingMap(root.map),
    password: parseJoinPassword(root.password),
    ...(mapRotation !== undefined ? { mapRotation } : {}),
    bots: {
      autofillBots: clampAutofillBots(
        botsRaw.autofillBots ?? DEFAULT_SERVER_CONFIG.bots.autofillBots,
      ),
      difficulty: parseDifficulty(
        botsRaw.difficulty ?? DEFAULT_SERVER_CONFIG.bots.difficulty,
      ),
      noBotsOnEmptyServer: parseNoBotsOnEmptyServer(
        botsRaw.noBotsOnEmptyServer ??
          DEFAULT_SERVER_CONFIG.bots.noBotsOnEmptyServer,
      ),
      brain: parseBrain(botsRaw.brain),
    },
  };
}

/**
 * Load the first readable config.json from candidate paths.
 * Missing / invalid files fall through; total miss uses defaults.
 */
export async function loadServerConfig(): Promise<LoadedServerConfig> {
  for (const path of getConfigPathCandidates()) {
    try {
      const text = await Deno.readTextFile(path);
      const parsed = JSON.parse(text) as unknown;
      return { config: parseServerConfig(parsed), path };
    } catch {
      // try next candidate
    }
  }
  return {
    config: {
      ...DEFAULT_SERVER_CONFIG,
      bots: { ...DEFAULT_SERVER_CONFIG.bots },
    },
    path: null,
  };
}
