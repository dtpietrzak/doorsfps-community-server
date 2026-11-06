/**
 * Construction options for GameServer. Callers import these types from
 * this file; GameServer does not re-export them.
 */

import type { TlsMaterial } from "../host/tlsConfig.ts";
import type { BotThinkEngine } from "@doors/bot-engine";
import type { BotDifficulty } from "../bots/types.ts";
import type { CompiledBotThinkPipeline } from "../bots/compiled/index.ts";
import type { AuthorityAdapter } from "../authority/adapter.ts";
import type { AuthorityPublicKeys } from "../shared/authority/authorityTokens.ts";
import type { DoorsMap } from "../world/map.ts";
import type { MapCollision } from "../world/MapCollision.ts";

/** Preloaded map available for host CLI changes and post-match voting. */
export interface MapCatalogEntry {
  name: string;
  stem: string;
  path: string;
  map: DoorsMap;
  collision: MapCollision;
}

/** open = guest name; ranked = authority join token (official only). */
export type ServerJoinMode = "open" | "ranked";

export interface GameServerOptions {
  name: string;
  port: number;
  /**
   * Interface to bind (default `0.0.0.0`).
   * Official v2 hosts still bind loopback behind Caddy until the TLS cutover;
   * when `tls` is set, this process terminates HTTPS itself.
   */
  host?: string;
  /**
   * PEM cert + key. When set, listen with `node:https` (WSS on the same port).
   * Community / local HTTP leave this unset.
   */
  tls?: TlsMaterial | null;
  /**
   * When set, overrides WEBTRANSPORT_ENABLED. Still requires `tls`.
   * Official TLS hosts default on; community HTTP stays off.
   */
  webTransport?: boolean;
  map: DoorsMap;
  collision: MapCollision;
  mapPath?: string;
  /** All maps discovered at boot (preloaded). Used for voting + CLI. */
  mapCatalog?: MapCatalogEntry[];
  /**
   * Desired total roster size for auto-fill
   * (from config.json bots.autofillBots).
   */
  autofillBots?: number;
  /**
   * Bot AI tier (from config.json bots.difficulty).
   * `"easy"` | `"hard"` — see bots/difficulty.ts to add more.
   */
  botDifficulty?: BotDifficulty;
  /**
   * When true (default), drop bots if no human is connected.
   * From config.json bots.noBotsOnEmptyServer.
   */
  noBotsOnEmptyServer?: boolean;
  /**
   * Fill/balance brain from config.json `bots.brain`.
   * Omitted and `"builtin"` keep the in-process engine.
   */
  botBrain?: "builtin" | readonly string[];
  /**
   * Official pool brain command. Omitted reads `DOORS_POOL_BRAIN_CMD`.
   * `"builtin"` keeps pool pawns on the in-process engine.
   */
  poolBrain?: "builtin" | readonly string[];
  /**
   * Hard cap on connected players (humans + bots).
   * From config.json `maxPlayers` (default 8).
   */
  maxPlayers?: number;
  /**
   * Live match length in seconds.
   * From config.json `matchDurationSeconds` (default shared MATCH_DURATION_SECONDS).
   */
  matchDurationSeconds?: number;
  /**
   * Community join password from config.json `password`.
   * Required to start a community host. Ignored on official open/ranked.
   */
  joinPassword?: string | null;
  /**
   * Join policy. Community downloadables always use `open`.
   * Official ranked instances use `ranked` + authorityTokenPublicKeys.
   */
  joinMode?: ServerJoinMode;
  /** Authority Ed25519 public keys used to verify join/admin tokens. */
  authorityTokenPublicKeys?: AuthorityPublicKeys;
  /**
   * Authentic server / runtime id that tokens must target
   * (legacy: `"ranked"` / `"easy"`; slot shape: `"g00/0"`).
   */
  rankedServerId?: string;
  /**
   * Occupancy mode for this process (`DOORS_MODE_ID`). Required for host+slot
   * runtime ids that do not encode mode in the path.
   */
  modeId?: string | null;
  /**
   * Authority base URL for match reports (official authentic only).
   * Defaults from AUTHORITY_URL env when omitted.
   */
  authorityUrl?: string | null;
  /**
   * Optional inject for tests. When omitted, built from join mode + secret + URL.
   */
  authorityAdapter?: AuthorityAdapter;
  /**
   * When true, official open joins require assignment-bearing admissions
   * (`assignmentId` + `jti`). Dual-accept is off. Ranked/community ignore this.
   * Env: OPEN_ASSIGNMENT_REQUIRED (default false).
   */
  openAssignmentRequired?: boolean;
  /**
   * Tests: force the authority release lock without polling.
   * Official processes poll AUTHORITY_URL /api/status instead.
   */
  releaseLocked?: boolean;
  /** Tests may inject/disable the complete browser/Deno thought pipeline. */
  botThinkEngine?: BotThinkEngine | null;
  /** Tests may inject/disable the persistent compiled child pipeline. */
  compiledBotThinkEngine?: CompiledBotThinkPipeline | null;
  compiledBotThinkMode?: "shadow" | "compiled";
}

export const DEFAULT_MAX_PLAYERS = 8;
