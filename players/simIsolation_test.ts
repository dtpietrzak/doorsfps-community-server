/**
 * Epic 4.8 Chunk 5: headless determinism + SIM allowlist forbid scan.
 *
 * Run from server-community/:
 *   deno test -A players/simIsolation_test.ts
 */

import { assertEquals } from "@std/assert";
import type { DoorsMap } from "../world/map.ts";
import { MapCollision } from "../world/MapCollision.ts";
import { BotManager } from "../bots/BotManager.ts";
import { PlayerManager } from "./PlayerManager.ts";
import type { PlayerInput } from "../protocol/network.ts";
import { createSimRng } from "../shared/sim/simRng.ts";
import {
  SIM_FILE_ALLOWLIST,
  SIM_FORBID_DIRECT_READ_PATTERNS,
  SIM_FORBID_IMPORT_SUBSTRINGS,
} from "./simIsolation.ts";

const PACKAGE_ROOT = new URL("../", import.meta.url);

const map: DoorsMap = {
  name: "sim-isolation-headless",
  version: 1,
  bounds: { minX: -30, maxX: 30, minZ: -30, maxZ: 30 },
  gridSize: 1,
  walls: [],
  teamA: { corners: [0, 1], edge: "south", doorHalfWidth: 2.5, spawnRadius: 3 },
  teamB: { corners: [2, 3], edge: "north", doorHalfWidth: 2.5, spawnRadius: 3 },
};

function input(sequence: number, overrides: Partial<PlayerInput> = {}): PlayerInput {
  return {
    sequence,
    forward: false,
    backward: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
    crouch: false,
    yaw: 0,
    pitch: 0,
    ...overrides,
  };
}

function rosterSnapshot(pm: PlayerManager) {
  return [...pm.all()]
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((p) => ({
    id: p.id,
    isBot: p.isBot,
    x: p.x,
    y: p.y,
    z: p.z,
    yaw: p.yaw,
    pitch: p.pitch,
    health: p.health,
    alive: p.alive,
    score: p.score,
    kills: p.kills,
    deaths: p.deaths,
    lastSequence: p.lastSequence,
    connectionIssue: p.connectionIssue,
    weaponId: p.weaponId,
  }));
}

/**
 * Headless tick loop: PlayerManager + BotManager apply path only.
 * No sessions hub, heatmaps, DOM, or GameServer driver.
 */
function runHeadless(ticks: number, seed: number) {
  const now0 = 2_000_000_000_000;
  const collision = new MapCollision(map);
  const pm = new PlayerManager(collision, {
    damageRandom: createSimRng(seed),
    nowMs: now0,
  });
  const human = pm.add("sock-h", "Human", "A", undefined, now0);
  const bot = pm.addBot("bot-h", "Bot", { team: "B" });
  pm.startNewMatch(0, now0);

  const bots = new BotManager(pm, {}, {
    nowMs: () => now0,
    rand: createSimRng(seed ^ 0x1111),
    autoFill: false,
  });
  bots.setAgentsRandom(createSimRng(seed ^ 0x2222));

  human.x = 0;
  human.z = -5;
  human.yaw = 0;
  human.onGround = true;
  bot.x = 0;
  bot.z = 5;
  bot.yaw = Math.PI;
  bot.onGround = true;

  for (let tick = 1; tick <= ticks; tick++) {
    const nowMs = now0 + tick * 16;
    bots.tickChurn(8, nowMs);
    bots.tickHousekeeping(tick, collision);
    bots.applyReadyActions(tick, nowMs, () => {});

    human.queueInput(
      input(tick, {
        forward: tick % 3 !== 0,
        left: tick % 7 === 0,
        yaw: (tick % 20) * 0.05,
      }),
      nowMs,
    );
    // Bot holds / apply path only — no thinkAll (replay never re-thinks).
    pm.update(tick, nowMs);
    pm.processScores(tick);
    if (pm.isRestartDue(tick)) pm.startNewMatch(tick, nowMs);
    pm.processRespawns(tick);
  }

  return rosterSnapshot(pm);
}

Deno.test("headless scripted ticks are bit-identical across runs (no hub/DOM)", () => {
  const a = runHeadless(48, 0xC0FFEE);
  const b = runHeadless(48, 0xC0FFEE);
  assertEquals(a, b);
  assertEquals(a.length >= 2, true);
});

Deno.test("headless runner constructs without sessions or heatmaps modules", () => {
  // Import lines of this test must not pull transport / GameServer / heatmaps.
  const self = Deno.readTextFileSync(new URL(import.meta.url));
  const importLines = self.split("\n").filter((l) => /^\s*import\b/.test(l));
  const joined = importLines.join("\n");
  assertEquals(/transport\//.test(joined), false);
  assertEquals(/HeatmapTracker/.test(joined), false);
  assertEquals(/GameServer/.test(joined), false);
  runHeadless(8, 1);
});

/** Default-parameter / injection escape hatches allowed in SIM sources. */
function isAllowedClockOrRngLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.startsWith("//") || trimmed.startsWith("*")) return true;
  // Signature / field defaults and nullish coalescing inject hooks.
  if (
    /=\s*Date\.now\s*\(/.test(line) ||
    /\?\?\s*Date\.now\s*\(/.test(line) ||
    /=\s*Math\.random\b/.test(line) ||
    /\?\?\s*Math\.random\b/.test(line) ||
    /=\s*\(\)\s*=>\s*Date\.now/.test(line) ||
    /options\.nowMs\s*\?\?\s*\(\)\s*=>\s*Date\.now/.test(line)
  ) {
    return true;
  }
  return false;
}

function repoFile(rel: string): URL {
  return new URL(rel, PACKAGE_ROOT);
}

Deno.test("SIM allowlist modules forbid transport/renderer imports", () => {
  const violations: string[] = [];
  for (const rel of SIM_FILE_ALLOWLIST) {
    let text: string;
    try {
      text = Deno.readTextFileSync(repoFile(rel));
    } catch {
      violations.push(`${rel}: missing`);
      continue;
    }
    const importLines = text.split("\n").filter((l) => /^\s*import\b/.test(l));
    const importBlob = importLines.join("\n");
    for (const needle of SIM_FORBID_IMPORT_SUBSTRINGS) {
      if (needle === "three") {
        if (/from\s+['"]three(?:\/[^'"]*)?['"]/.test(importBlob)) {
          violations.push(`${rel}: imports three`);
        }
        continue;
      }
      if (needle === ".tsx") {
        if (/from\s+['"][^'"]*\.tsx['"]/.test(importBlob)) {
          violations.push(`${rel}: imports .tsx`);
        }
        continue;
      }
      if (importBlob.includes(needle)) {
        violations.push(`${rel}: import contains "${needle}"`);
      }
    }
  }
  assertEquals(violations, []);
});

Deno.test("strict SIM core has no bare Date.now/performance.now/Math.random bodies", () => {
  const strictCore = [
    "shared/sim/moveStep.ts",
    "shared/sim/simRng.ts",
    "players/weaponsQueue.ts",
    "players/simTickPhases.ts",
    "players/simTickResult.ts",
    "players/simIsolation.ts",
    "bots/pipeline/applySteps.ts",
    "bots/pipeline/types.ts",
    "bots/pipeline/botInterp.ts",
  ] as const;

  const violations: string[] = [];
  for (const rel of strictCore) {
    const text = Deno.readTextFileSync(repoFile(rel));
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (isAllowedClockOrRngLine(line)) continue;
      for (const re of SIM_FORBID_DIRECT_READ_PATTERNS) {
        if (re.test(line)) {
          violations.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
      }
    }
  }
  assertEquals(violations, []);
});
