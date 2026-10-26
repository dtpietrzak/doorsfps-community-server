/**
 * DO NOT REMOVE OR BYPASS THE TERMS OF USE CHECK (`requireTermsAcceptance`
 * in main() below).
 *
 * The MIT License lets you modify this file, but it does not let you off the
 * DoorsFPS Community Server Terms of Use (TERMS.md). Removing or bypassing
 * the acceptance check, or shipping builds without it, does not release you
 * or your players from those Terms, and DoorsFPS treats it as bad faith when
 * deciding enforcement (TERMS.md Sections 3 and 8). That enforcement can
 * include permanent bans of your DoorsFPS accounts and blocking your IP
 * addresses, networks, devices, or servers from official DoorsFPS services.
 */
import "./shared/env/loadRepoEnv.ts";

import { createElement } from "react";
import { render } from "ink";
import { GameServer, type MapCatalogEntry } from "./runtime/GameServer.ts";
import { loadTlsMaterialFromEnv } from "./host/tlsConfig.ts";
import {
  findMapCandidate,
  type MapCandidate,
  ServerTui,
} from "./host/ServerTui.tsx";
import {
  requireTermsAcceptance,
  TERMS_ACCEPT_ENV,
  TERMS_VERSION,
} from "./host/termsGate.ts";
import { resolveHostAddresses } from "./host/hostInfo.ts";
import { SERVER_VERSION } from "./host/version.ts";
import {
  COMMUNITY_JOIN_PASSWORD_REQUIRED,
  getConfigPathCandidates,
  loadServerConfig,
} from "./host/loadConfig.ts";
import {
  isOpenOfficialServerId,
  isRankedModeFromEnv,
  loadOpenAssignmentRequiredFromEnv,
  loadTokenPublicKeysFromEnv,
  rankedServerIdFromEnv,
} from "./authority/rankedAuth.ts";
import { loadAuthorityUrlFromEnv } from "./authority/adapter.ts";
import {
  getMapDirectoryCandidates,
  listAvailableMapPaths,
  loadMapBundle,
  loadMapFile,
} from "./world/loadMap.ts";

const DEFAULT_PORT = 3000;
const DEFAULT_NAME = "Doors Server";

function parseArgs(args: string[]): {
  port: number;
  host: string;
  name: string;
  help: boolean;
  ranked: boolean;
} {
  let port = Number(Deno.env.get("PORT") ?? DEFAULT_PORT);
  let host = Deno.env.get("LISTEN_HOST")?.trim() ||
    Deno.env.get("HOST")?.trim() ||
    "0.0.0.0";
  let name = Deno.env.get("SERVER_NAME") ?? DEFAULT_NAME;
  let help = false;
  let ranked = isRankedModeFromEnv();

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--help" || a === "-h") {
      help = true;
      continue;
    }
    if ((a === "--port" || a === "-p") && args[i + 1]) {
      port = Number(args[++i]);
      continue;
    }
    if ((a === "--host" || a === "--listen") && args[i + 1]) {
      host = args[++i]!;
      continue;
    }
    if ((a === "--name" || a === "-n") && args[i + 1]) {
      name = args[++i]!;
      continue;
    }
    if (a === "--ranked") {
      ranked = true;
      continue;
    }
    if (a === "--open") {
      ranked = false;
      continue;
    }
  }

  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    port = DEFAULT_PORT;
  }
  if (!host) host = "0.0.0.0";

  return { port, host, name, help, ranked };
}

function printCliHelp(): void {
  console.log(`
Doors game server ${SERVER_VERSION}

Usage:
  doors-server [options]
  deno task dev
  deno task compile

Options:
  -p, --port <n>     TCP port (default ${DEFAULT_PORT}, or PORT env)
  --host <addr>      Bind address (default 0.0.0.0, or LISTEN_HOST env).

HTTPS (optional; official / local proof):
  TLS_CERT + TLS_KEY  PEM paths. When both are set, this process terminates
                      TLS (HTTPS + Socket.IO WSS). Community downloads leave
                      both unset and stay on HTTP.
  WEBTRANSPORT_ENABLED  Official TLS hosts also bind QUIC/WebTransport on the
                        same UDP port (path /wt). Set 0 to leave WSS-only.
                        Fail-soft: a QUIC listen error does not block WSS.
  -n, --name <str>   Server name shown to clients
  --ranked           Require authority join tokens (official competitive)
  --open             Guest name joins only (default for community hosts)
  --accept-terms     Accept the Terms of Use (TERMS.md) without the prompt.
                     Needed when there is no terminal (service / pipe), or set
                     DOORS_ACCEPT_TERMS=1. A terminal is asked on every start.
  -h, --help         Show this help

Join modes:
  open (default)     Players enter a display name. Unranked. Community default.
  ranked             Requires AUTHORITY_TOKEN_PUBLIC_KEYS + authority tokens.
                     Reports match results to AUTHORITY_URL (official only).
                     Downloadable community servers should stay --open.

Release packages unpack to a doors/ folder next to the binary:
  doors/
    doors-server[.exe]
    config.json
    TERMS.md
    maps/*.doors.json

Maps are discovered from maps/ next to the executable (or CWD).
A random map is chosen on startup. Players stay connected when you change maps.

Settings load from config.json next to the executable (or CWD / server/config.json).
Example:
  {
    "maxPlayers": 8,
    "matchDurationSeconds": 900,
    "password": "pick-a-secret",
    "map": "Pillars",
    "mapRotation": ["Pillars", "Crossroads", "Hourglass"],
    "bots": {
      "autofillBots": 4,
      "difficulty": "easy",
      "noBotsOnEmptyServer": true
    }
  }

Host options:
  maxPlayers            Hard cap on humans + bots (1–64, default 8)
  matchDurationSeconds  Match time limit in seconds (30–10800, default 900 = 15 min)
                        Score win can still end the match earlier.
  password              Required join password. Friends must type the exact IP:port
                        AND this secret. The server will not start if this is missing
                        or blank. Official servers ignore this.
  map                   Starting map name/stem/filename (omit or null = random).
                        Useful for authority Easy/Hard where the host CLI has no TTY.
  mapRotation           Optional list of map display names to load (omit = all maps).
                        Matched by map name only; unknown names are logged and skipped.

Bot options (config.json → bots):
  autofillBots          Desired total roster (humans + bots) for auto-fill (default 4)
  difficulty            Bot AI tier: easy | hard (default easy)
  noBotsOnEmptyServer   true (default): drop all bots when no human is connected.
                        false: bots keep auto-filling and playing on an empty server.

Bot difficulty:
  easy   Rush enemy door, look pauses, slow inaccurate shots (default)
  hard   Continuous nav, shoots on sight, camps when doors close
  (Add more tiers later in server/bots/difficulty.ts)

Interactive console (Ink TUI):
  map <name>        Change to a map by internal name or filename (e.g. map Pillars)
  maps              List available maps
  bots              List bots / fill status
  bots add [n]      Add n bots (default 1)
  bots remove [n]   Remove n bots (default 1)
  help              Show runtime commands
  quit / exit       Stop the server

Bots auto-fill to the config autofillBots total. With noBotsOnEmptyServer true
(default), zero humans clears bots. Set it false to keep bots running alone.

Changing the map during an active match ends that match as a draw. Changing
during the post-match intermission just loads the new map and starts fresh.

After each match, players vote for the next map on the game-over screen.
A clear majority wins; ties are broken randomly. No votes picks a random map
from this server's map list.
`);
}

function fileNameFromPath(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx >= 0 ? path.slice(idx + 1) : path;
}

/** Filename without extension (e.g. Pillars.doors.json → Pillars). */
function mapStemFromPath(path: string): string {
  const file = fileNameFromPath(path);
  return file.replace(/\.doors\.json$/i, "").replace(/\.json$/i, "");
}

function pickRandomMap(paths: MapCandidate[]): MapCandidate {
  const i = Math.floor(Math.random() * paths.length);
  return paths[i]!;
}

/**
 * When mapRotation is set, keep only maps whose display name is listed.
 * Matching is by DoorsMap.name (case-insensitive), not path or filename.
 * Missing names are logged and skipped.
 */
function applyMapRotation(
  candidates: MapCandidate[],
  rotation: string[] | undefined,
): MapCandidate[] {
  if (rotation === undefined) return candidates;

  const selected: MapCandidate[] = [];
  const usedPaths = new Set<string>();

  for (const name of rotation) {
    const match = candidates.find(
      (c) => c.name.toLowerCase() === name.toLowerCase(),
    );
    if (!match) {
      console.log(`map: ${name} not found in ./maps`);
      continue;
    }
    if (usedPaths.has(match.path)) continue;
    usedPaths.add(match.path);
    selected.push(match);
  }

  return selected;
}

async function waitForever(): Promise<never> {
  return await new Promise(() => {
    // Keep process alive until SIGINT / SIGTERM when stdin is not a TTY.
  });
}

async function main() {
  const { port, host, name, help, ranked } = parseArgs(Deno.args);
  if (help) {
    printCliHelp();
    Deno.exit(0);
  }

  console.log(`Doors server ${SERVER_VERSION}`);
  const termsAcceptance = requireTermsAcceptance(Deno.args);
  console.log(
    `Terms of Use ${TERMS_VERSION} accepted (${
      termsAcceptance === "env" ? TERMS_ACCEPT_ENV : termsAcceptance
    }).`,
  );

  const joinMode = ranked ? "ranked" : "open";
  const rankedServerId = rankedServerIdFromEnv();
  const modeId = Deno.env.get("DOORS_MODE_ID")?.trim() || null;
  const authorityUrl = loadAuthorityUrlFromEnv();
  // Official runtimes verify authority tokens with public keys only.
  // Community downloadables leave RANKED_SERVER_ID unset (defaults to
  // "ranked"); open reporting is enabled only for known authentic ids.
  // Prefer DOORS_MODE_ID when runtime ids are host+slot (no mode segment).
  const openOfficialId = !ranked &&
    isOpenOfficialServerId(rankedServerId, modeId);
  const authorityTokenPublicKeys = ranked || openOfficialId
    ? loadTokenPublicKeysFromEnv()
    : {};
  const openAssignmentRequired = openOfficialId
    ? loadOpenAssignmentRequiredFromEnv()
    : false;

  const { config, path: configPath } = await loadServerConfig();
  const joinPassword = (ranked || openOfficialId) ? null : config.password;
  if (!ranked && !openOfficialId && !joinPassword) {
    console.error(COMMUNITY_JOIN_PASSWORD_REQUIRED);
    if (configPath) console.error(`Config file: ${configPath}`);
    else {
      console.error("Looked for config.json in:");
      for (const candidate of getConfigPathCandidates()) {
        console.error(`  - ${candidate}`);
      }
    }
    Deno.exit(1);
  }
  const rotationSummary = config.mapRotation
    ? `mapRotation=[${config.mapRotation.join(", ")}]`
    : "mapRotation=(all)";
  const configSummary =
    `maxPlayers=${config.maxPlayers}, matchDurationSeconds=${config.matchDurationSeconds}, ` +
    `map=${
      config.map ?? "(random)"
    }, ${rotationSummary}, joinMode=${joinMode}, ` +
    `bots.autofillBots=${config.bots.autofillBots}, difficulty=${config.bots.difficulty}, ` +
    `noBotsOnEmptyServer=${config.bots.noBotsOnEmptyServer}, ` +
    `password=${config.password ? "set" : "none"}`;
  if (configPath) {
    console.log(`Config: ${configPath} (${configSummary})`);
  } else {
    console.log(`Config: defaults (${configSummary})`);
    console.log("Looked for config.json in:");
    for (const candidate of getConfigPathCandidates()) {
      console.log(`  - ${candidate}`);
    }
  }
  if (ranked && Object.keys(authorityTokenPublicKeys).length === 0) {
    console.warn(
      "WARNING: --ranked / SERVER_JOIN_MODE=ranked but AUTHORITY_TOKEN_PUBLIC_KEYS is unset. " +
        "All joins will be rejected.",
    );
  }
  if ((ranked || openOfficialId) && !authorityUrl) {
    console.warn(
      "WARNING: official mode has no AUTHORITY_URL — match results will not be reported. " +
        "Set AUTHORITY_URL (e.g. http://127.0.0.1:4000).",
    );
  }

  const mapPaths = await listAvailableMapPaths();
  const discoveredMaps: MapCandidate[] = [];
  for (const p of mapPaths) {
    try {
      const m = await loadMapFile(p);
      discoveredMaps.push({
        path: p,
        name: m.name || mapStemFromPath(p),
        stem: mapStemFromPath(p),
      });
    } catch {
      discoveredMaps.push({
        path: p,
        name: mapStemFromPath(p),
        stem: mapStemFromPath(p),
      });
    }
  }

  if (discoveredMaps.length === 0) {
    console.error("No map files found.");
    console.error("Searched directories:");
    for (const candidate of getMapDirectoryCandidates()) {
      console.error(`  - ${candidate}`);
    }
    Deno.exit(1);
  }

  const mapCandidates = applyMapRotation(discoveredMaps, config.mapRotation);

  if (mapCandidates.length === 0) {
    console.error(
      config.mapRotation
        ? "No maps from mapRotation could be resolved."
        : "No map files found.",
    );
    if (config.mapRotation) {
      console.error(
        `Requested: ${config.mapRotation.join(", ")}. ` +
          `Available: ${discoveredMaps.map((c) => c.name).join(", ")}`,
      );
    } else {
      console.error("Searched directories:");
      for (const candidate of getMapDirectoryCandidates()) {
        console.error(`  - ${candidate}`);
      }
    }
    Deno.exit(1);
  }

  // Preload every allowed map so votes / CLI can switch instantly without disk I/O mid-loop.
  const mapCatalog: MapCatalogEntry[] = [];
  for (const c of mapCandidates) {
    try {
      const bundle = await loadMapBundle(c.path);
      mapCatalog.push({
        name: bundle.map.name || c.name,
        stem: c.stem,
        path: bundle.path,
        map: bundle.map,
        collision: bundle.collision,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Skipping map ${c.path}: ${message}`);
    }
  }

  if (mapCatalog.length === 0) {
    console.error("No valid map files could be loaded.");
    Deno.exit(1);
  }

  const catalogCandidates: MapCandidate[] = mapCatalog.map((m) => ({
    path: m.path,
    name: m.name,
    stem: m.stem,
  }));

  let selected: MapCandidate;
  if (config.map) {
    const match = findMapCandidate(catalogCandidates, config.map);
    if (match) {
      selected = match;
      console.log(`Starting map from config: ${match.name} (${match.path})`);
    } else {
      console.warn(
        `Config map "${config.map}" not found; falling back to random. ` +
          `Available: ${catalogCandidates.map((c) => c.name).join(", ")}`,
      );
      selected = pickRandomMap(catalogCandidates);
    }
  } else {
    selected = pickRandomMap(catalogCandidates);
  }

  const mapBundle = mapCatalog.find((m) => m.path === selected.path) ??
    mapCatalog[0]!;

  let tls = null;
  try {
    tls = loadTlsMaterialFromEnv();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`TLS config error: ${message}`);
    Deno.exit(1);
  }
  if (tls) {
    console.log("[server] Deno TLS enabled (TLS_CERT / TLS_KEY)");
  }

  if (joinPassword) {
    console.log(
      "Join password: set — friends need this plus the IP (the password is not printed).",
    );
  }

  const gameServer = new GameServer({
    name,
    port,
    host,
    tls,
    map: mapBundle.map,
    collision: mapBundle.collision,
    mapPath: mapBundle.path,
    mapCatalog,
    maxPlayers: config.maxPlayers,
    matchDurationSeconds: config.matchDurationSeconds,
    autofillBots: config.bots.autofillBots,
    botDifficulty: config.bots.difficulty,
    noBotsOnEmptyServer: config.bots.noBotsOnEmptyServer,
    botBrain: config.bots.brain,
    joinPassword,
    joinMode,
    authorityTokenPublicKeys,
    rankedServerId,
    modeId,
    authorityUrl,
    openAssignmentRequired,
  });

  try {
    await gameServer.start();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `Failed to start server on ${host}:${port}: ${message}`,
    );
    console.error("Is another process already using that address/port?");
    Deno.exit(1);
  }

  let shutdownStarted = false;
  const shutdown = async (signal: string) => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    console.log(`\n[server] Shutting down (${signal})…`);
    try {
      await gameServer.stop();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Warning: server shutdown error: ${message}`);
    }
    Deno.exit(0);
  };
  Deno.addSignalListener("SIGINT", () => void shutdown("SIGINT"));
  try {
    Deno.addSignalListener("SIGTERM", () => void shutdown("SIGTERM"));
  } catch {
    // Windows may not support SIGTERM.
  }

  const { local, publicIp } = await resolveHostAddresses();

  try {
    if (Deno.stdin.isTerminal()) {
      const { waitUntilExit, unmount } = render(
        createElement(ServerTui, {
          gameServer,
          maps: mapCandidates,
          host: { local, publicIp, port },
          initialMapPath: mapBundle.path,
        }),
      );
      try {
        await waitUntilExit();
      } finally {
        unmount();
      }
    } else {
      // Non-interactive (piped / service): log once and stay up.
      console.log(
        `Doors server ${SERVER_VERSION} running · ${name} · ${mapBundle.map.name} · ${host}:${port}`,
      );
      if (publicIp && host !== "127.0.0.1" && host !== "localhost") {
        console.log(`Public IP: ${publicIp}:${port}`);
      }
      console.log(`Maps: ${mapCandidates.map((c) => c.name).join(", ")}`);
      await waitForever();
    }
  } finally {
    try {
      await gameServer.stop();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Warning: server shutdown error: ${message}`);
    }
  }

  Deno.exit(0);
}

main();
