import { assertEquals } from "@std/assert";
import {
  DEFAULT_SERVER_CONFIG,
  MATCH_DURATION_SECONDS_MAX,
  MATCH_DURATION_SECONDS_MIN,
  MAX_PLAYERS_MAX,
  MAX_PLAYERS_MIN,
  parseServerConfig,
} from "./loadConfig.ts";

Deno.test("parseServerConfig: empty object uses defaults", () => {
  const cfg = parseServerConfig({});
  assertEquals(cfg.maxPlayers, DEFAULT_SERVER_CONFIG.maxPlayers);
  assertEquals(
    cfg.matchDurationSeconds,
    DEFAULT_SERVER_CONFIG.matchDurationSeconds,
  );
  assertEquals(cfg.map, null);
  assertEquals(cfg.bots.autofillBots, DEFAULT_SERVER_CONFIG.bots.autofillBots);
  assertEquals(cfg.bots.difficulty, DEFAULT_SERVER_CONFIG.bots.difficulty);
  assertEquals(cfg.bots.difficulty, "easy");
  assertEquals(cfg.bots.noBotsOnEmptyServer, true);
  assertEquals(cfg.bots.brain, "builtin");
  assertEquals(cfg.maxPlayers, 8);
  assertEquals(cfg.matchDurationSeconds, 15 * 60);
  assertEquals(cfg.password, null);
});

Deno.test("parseServerConfig: password optional", () => {
  assertEquals(parseServerConfig({}).password, null);
  assertEquals(parseServerConfig({ password: "" }).password, null);
  assertEquals(parseServerConfig({ password: "   " }).password, null);
  assertEquals(parseServerConfig({ password: 12 }).password, null);
  assertEquals(parseServerConfig({ password: " secret " }).password, "secret");
  assertEquals(
    parseServerConfig({ password: "a".repeat(80) }).password?.length,
    64,
  );
});

Deno.test("parseServerConfig: reads maxPlayers and matchDurationSeconds", () => {
  const cfg = parseServerConfig({
    maxPlayers: 12,
    matchDurationSeconds: 600,
    bots: { autofillBots: 6 },
  });
  assertEquals(cfg.maxPlayers, 12);
  assertEquals(cfg.matchDurationSeconds, 600);
  assertEquals(cfg.map, null);
  assertEquals(cfg.bots.autofillBots, 6);
  assertEquals(cfg.bots.difficulty, "easy");
  assertEquals(cfg.bots.noBotsOnEmptyServer, true);
});

Deno.test("parseServerConfig: reads map", () => {
  assertEquals(parseServerConfig({ map: "Pillars" }).map, "Pillars");
  assertEquals(parseServerConfig({ map: "  Crossroads  " }).map, "Crossroads");
  assertEquals(parseServerConfig({ map: "" }).map, null);
  assertEquals(parseServerConfig({ map: "   " }).map, null);
  assertEquals(parseServerConfig({ map: null }).map, null);
});

Deno.test("parseServerConfig: mapRotation optional", () => {
  assertEquals(parseServerConfig({}).mapRotation, undefined);
  assertEquals(parseServerConfig({ mapRotation: null }).mapRotation, undefined);
  assertEquals(
    parseServerConfig({ mapRotation: "Pillars" }).mapRotation,
    undefined,
  );
  assertEquals(parseServerConfig({ mapRotation: [] }).mapRotation, []);
  assertEquals(
    parseServerConfig({
      mapRotation: ["Pillars", "  Crossroads  ", "", "pillars", 12, null],
    }).mapRotation,
    ["Pillars", "Crossroads"],
  );
});

Deno.test("parseServerConfig: reads bots.autofillBots", () => {
  const cfg = parseServerConfig({ bots: { autofillBots: 6 } });
  assertEquals(cfg.bots.autofillBots, 6);
  assertEquals(cfg.bots.difficulty, "easy");
});

Deno.test("parseServerConfig: reads bots.difficulty", () => {
  assertEquals(
    parseServerConfig({ bots: { difficulty: "hard" } }).bots.difficulty,
    "hard",
  );
  assertEquals(
    parseServerConfig({ bots: { difficulty: "EASY" } }).bots.difficulty,
    "easy",
  );
  assertEquals(
    parseServerConfig({ bots: { difficulty: "medium" } }).bots.difficulty,
    "medium",
  );
  assertEquals(
    parseServerConfig({ bots: { difficulty: "extreme" } }).bots.difficulty,
    "easy",
  );
});

Deno.test("parseServerConfig: reads bots.noBotsOnEmptyServer", () => {
  assertEquals(
    parseServerConfig({ bots: { noBotsOnEmptyServer: false } }).bots
      .noBotsOnEmptyServer,
    false,
  );
  assertEquals(
    parseServerConfig({ bots: { noBotsOnEmptyServer: true } }).bots
      .noBotsOnEmptyServer,
    true,
  );
  assertEquals(
    parseServerConfig({ bots: {} }).bots.noBotsOnEmptyServer,
    true,
  );
});

Deno.test("parseServerConfig: floors and clamps autofillBots", () => {
  assertEquals(
    parseServerConfig({ bots: { autofillBots: 3.9 } }).bots.autofillBots,
    3,
  );
  assertEquals(
    parseServerConfig({ bots: { autofillBots: -2 } }).bots.autofillBots,
    0,
  );
});

Deno.test("parseServerConfig: clamps maxPlayers", () => {
  assertEquals(parseServerConfig({ maxPlayers: 12.9 }).maxPlayers, 12);
  assertEquals(
    parseServerConfig({ maxPlayers: 0 }).maxPlayers,
    MAX_PLAYERS_MIN,
  );
  assertEquals(
    parseServerConfig({ maxPlayers: -5 }).maxPlayers,
    MAX_PLAYERS_MIN,
  );
  assertEquals(
    parseServerConfig({ maxPlayers: 999 }).maxPlayers,
    MAX_PLAYERS_MAX,
  );
});

Deno.test("parseServerConfig: clamps matchDurationSeconds", () => {
  assertEquals(
    parseServerConfig({ matchDurationSeconds: 90.7 }).matchDurationSeconds,
    90,
  );
  assertEquals(
    parseServerConfig({ matchDurationSeconds: 10 }).matchDurationSeconds,
    MATCH_DURATION_SECONDS_MIN,
  );
  assertEquals(
    parseServerConfig({ matchDurationSeconds: 99_999 }).matchDurationSeconds,
    MATCH_DURATION_SECONDS_MAX,
  );
});

Deno.test("parseServerConfig: invalid types fall back to default", () => {
  assertEquals(
    parseServerConfig({ bots: { autofillBots: "nope" } }).bots.autofillBots,
    DEFAULT_SERVER_CONFIG.bots.autofillBots,
  );
  assertEquals(
    parseServerConfig(null).bots.autofillBots,
    DEFAULT_SERVER_CONFIG.bots.autofillBots,
  );
  assertEquals(
    parseServerConfig({ bots: { difficulty: 12 } }).bots.difficulty,
    DEFAULT_SERVER_CONFIG.bots.difficulty,
  );
  assertEquals(
    parseServerConfig({ bots: { noBotsOnEmptyServer: "yes" } }).bots
      .noBotsOnEmptyServer,
    DEFAULT_SERVER_CONFIG.bots.noBotsOnEmptyServer,
  );
  assertEquals(
    parseServerConfig({ maxPlayers: "lots" }).maxPlayers,
    DEFAULT_SERVER_CONFIG.maxPlayers,
  );
  assertEquals(
    parseServerConfig({ matchDurationSeconds: "long" }).matchDurationSeconds,
    DEFAULT_SERVER_CONFIG.matchDurationSeconds,
  );
  assertEquals(parseServerConfig({ map: 12 }).map, null);
  assertEquals(parseServerConfig({ map: true }).map, null);
  assertEquals(parseServerConfig({ mapRotation: 12 }).mapRotation, undefined);
  assertEquals(parseServerConfig({}).bots.brain, "builtin");
  assertEquals(
    parseServerConfig({ bots: { brain: "builtin" } }).bots.brain,
    "builtin",
  );
  assertEquals(parseServerConfig({ bots: { brain: [] } }).bots.brain, "builtin");
  assertEquals(
    parseServerConfig({ bots: { brain: ["deno", ""] } }).bots.brain,
    "builtin",
  );
  assertEquals(
    parseServerConfig({ bots: { brain: ["deno", 1] } }).bots.brain,
    "builtin",
  );
  assertEquals(
    parseServerConfig({ bots: { brain: "deno run brain.ts" } }).bots.brain,
    "builtin",
  );
  assertEquals(
    parseServerConfig({
      bots: { brain: ["deno", "run", "-A", " brain.ts "] },
    }).bots.brain,
    ["deno", "run", "-A", "brain.ts"],
  );
});
