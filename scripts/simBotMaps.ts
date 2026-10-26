/**
 * Multi-map bot simulation: load every .doors.json, run easy/hard bots for a
 * fixed duration, report stuck / no-progress / thrash issues.
 *
 * Usage (from server/):
 *   deno run -A scripts/simBotMaps.ts
 *   deno run -A scripts/simBotMaps.ts --map Courtyard --difficulty hard --seconds 45
 */

import { BotManager } from "../bots/BotManager.ts";
import { PlayerManager } from "../players/PlayerManager.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";
import { listAvailableMapPaths } from "../world/loadMap.ts";
import { TICK_HZ } from "../protocol/network.ts";
import type { BotDifficulty } from "../bots/types.ts";
import { enemyDoorTarget } from "../bots/helpers/nav.ts";
import { sampleBotHintInfluence } from "@doors/bot-engine/thoughts/helpers/hints.ts";

const DEFAULT_SECONDS = 40;
const STUCK_MOVE_EPS = 0.025; // per tick horizontal progress
const STUCK_EVENT_MIN = 120; // consecutive low-move ticks to count as stuck event
const THRASH_WINDOW = 60;
const THRASH_MIN_TURNS = 12; // many yaw flips while nearly stationary

type CliOpts = {
  maps: string[] | null;
  difficulties: BotDifficulty[];
  seconds: number;
  bots: number;
  seed: number;
  verbose: boolean;
};

function parseArgs(argv: string[]): CliOpts {
  let maps: string[] | null = null;
  let difficulties: BotDifficulty[] = ["easy", "hard"];
  let seconds = DEFAULT_SECONDS;
  let bots = 6;
  let seed = 1;
  let verbose = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--map" && argv[i + 1]) {
      maps = argv[++i]!.split(",");
    } else if (a === "--difficulty" && argv[i + 1]) {
      difficulties = argv[++i]!.split(",") as BotDifficulty[];
    } else if (a === "--seconds" && argv[i + 1]) {
      seconds = Math.max(5, Number(argv[++i]));
    } else if (a === "--bots" && argv[i + 1]) {
      bots = Math.max(2, Number(argv[++i]));
    } else if (a === "--seed" && argv[i + 1]) {
      seed = Number(argv[++i]);
    } else if (a === "--verbose" || a === "-v") {
      verbose = true;
    }
  }
  return { maps, difficulties, seconds, bots, seed, verbose };
}

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

async function listMaps(filter: string[] | null): Promise<string[]> {
  const paths = (await listAvailableMapPaths()).filter((path) => {
    const base = path.split("/").pop()?.replace(/\.doors\.json$/, "") ?? "";
    return !filter || filter.some((name) => base.toLowerCase() === name.toLowerCase());
  });
  paths.sort((a, b) => a.localeCompare(b));
  return paths;
}

type BotTelemetry = {
  id: string;
  name: string;
  team: "A" | "B";
  brainId: string;
  // Position history samples every 30 ticks
  samples: {
    tick: number;
    x: number;
    z: number;
    stuckTicks: number;
    mode?: string;
    objective?: string;
  }[];
  maxStuckStreak: number;
  stuckEvents: number;
  totalStuckTicks: number;
  // Continuous low-move counter (grounded, alive, not at intentional hold)
  lowMoveStreak: number;
  thrashEvents: number;
  // Door progress for seekers
  maxDoorProgress: number; // 1 - dist/initialDist, best
  minDistToEnemyDoor: number;
  initialDistToDoor: number;
  scores: number;
  deaths: number;
  // Time spent in each half
  ticksAlive: number;
  ticksInOwnHalf: number;
  ticksInEnemyHalf: number;
  // Last positions for thrash detect
  lastYaw: number;
  yawFlipsInWindow: number;
  windowTick: number;
  lastX: number;
  lastZ: number;
  // Hint kinds active while stuck
  stuckHintKinds: Map<string, number>;
  stuckPositions: { x: number; z: number; tick: number; stuckTicks: number }[];
};

type SimReport = {
  map: string;
  difficulty: BotDifficulty;
  ticks: number;
  scores: { A: number; B: number };
  bots: BotTelemetry[];
  issues: string[];
};

function isIntentionalHold(state: Record<string, unknown>): boolean {
  const mode = state.mode;
  const objective = state.objective;
  const phase = state.phase;
  // Easy look phase
  if (phase === "look") return true;
  // Hard camp / defend
  if (mode === "camp") return true;
  if (objective === "defend") return true;
  return false;
}

function runSim(
  mapPath: string,
  map: DoorsMap,
  difficulty: BotDifficulty,
  opts: CliOpts,
  rng: () => number,
): SimReport {
  // Seed Math.random for brain dice rolls
  const originalRandom = Math.random;
  Math.random = rng;

  const collision = new MapCollision(map);
  // Fixed match seed + ids: bot apply order is ascending id and bot-official
  // hashes ids into personality, so both must repeat per --seed.
  const players = new PlayerManager(collision, {
    matchSeed: Math.floor(rng() * 0x7fff_ffff) >>> 0,
  });
  let idSuffix = 0;
  const bots = new BotManager(players, {}, {
    botIdFactory: (i) => `bot:sim-${String(i).padStart(3, "0")}`,
    idSuffix: () => `sim${String(++idSuffix).padStart(5, "0")}`,
    difficulty,
    fill: { minPlayers: opts.bots, noBotsOnEmptyServer: false },
  });
  bots.reconcile(opts.bots);

  const totalTicks = Math.floor(opts.seconds * TICK_HZ);
  const telemetry = new Map<string, BotTelemetry>();

  for (const info of bots.list()) {
    const p = players.get(info.id)!;
    const door = enemyDoorTarget(map, p.team);
    const initDist = Math.hypot(door.x - p.x, door.z - p.z);
    telemetry.set(info.id, {
      id: info.id,
      name: info.name,
      team: p.team,
      brainId: info.brainId,
      samples: [],
      maxStuckStreak: 0,
      stuckEvents: 0,
      totalStuckTicks: 0,
      lowMoveStreak: 0,
      thrashEvents: 0,
      maxDoorProgress: 0,
      minDistToEnemyDoor: initDist,
      initialDistToDoor: initDist,
      scores: 0,
      deaths: 0,
      ticksAlive: 0,
      ticksInOwnHalf: 0,
      ticksInEnemyHalf: 0,
      lastYaw: p.yaw,
      yawFlipsInWindow: 0,
      windowTick: 0,
      lastX: p.x,
      lastZ: p.z,
      stuckHintKinds: new Map(),
      stuckPositions: [],
    });
  }

  // Access managed bot state via private map — use list + think state through bots
  // BotManager doesn't expose state; re-read from a hack: we track via positions only.
  // For stuckTicks we need brain state — expose via (bots as any)
  const managed = (bots as unknown as {
    bots: Map<string, { state: Record<string, unknown>; playerId: string }>;
  }).bots;

  const prevAlive = new Map<string, boolean>();
  for (const p of players.allCached()) prevAlive.set(p.id, p.alive);

  for (let tick = 0; tick < totalTicks; tick++) {
    bots.tick(tick, collision);
    players.update(tick);
    players.processScores(tick);
    // Prevent match end from freezing bots
    if (players.isMatchOver()) {
      // Force continue by starting new match semantics if needed
      break;
    }
    players.processRespawns(tick);

    for (const p of players.allCached()) {
      if (!p.isBot) continue;
      const t = telemetry.get(p.id);
      if (!t) continue;
      const mb = managed.get(p.id);
      const state = (mb?.state ?? {}) as Record<string, unknown>;
      const stuckWElapsed = typeof state.stuckWElapsed === "number"
        ? state.stuckWElapsed
        : 0;
      const stuckWTurn = typeof state.stuckWTurnTicksLeft === "number"
        ? state.stuckWTurnTicksLeft
        : 0;
      const stuckTicks = Math.max(stuckWElapsed, stuckWTurn);

      const wasAlive = prevAlive.get(p.id) ?? true;
      if (wasAlive && !p.alive) t.deaths += 1;
      prevAlive.set(p.id, p.alive);

      if (!p.alive) {
        t.lowMoveStreak = 0;
        continue;
      }

      t.ticksAlive += 1;
      t.scores = p.score;

      const door = enemyDoorTarget(map, p.team);
      const distDoor = Math.hypot(door.x - p.x, door.z - p.z);
      t.minDistToEnemyDoor = Math.min(t.minDistToEnemyDoor, distDoor);
      const progress = t.initialDistToDoor > 1
        ? 1 - distDoor / t.initialDistToDoor
        : 0;
      t.maxDoorProgress = Math.max(t.maxDoorProgress, progress);

      const midZ = (map.bounds.minZ + map.bounds.maxZ) / 2;
      const ownIsSouth = map.teamA.edge === "south"
        ? p.team === "A"
        : p.team === "B";
      // Own half: for south team, z < mid
      const inOwn = ownIsSouth ? p.z < midZ : p.z > midZ;
      if (inOwn) t.ticksInOwnHalf += 1;
      else t.ticksInEnemyHalf += 1;

      const moved = Math.hypot(p.x - t.lastX, p.z - t.lastZ);
      const hold = isIntentionalHold(state);
      // Door capture crouch / standing still near door is OK
      const nearDoor = distDoor < 2.5;
      const nearCamp = typeof state.campX === "number" &&
        typeof state.campZ === "number" &&
        Math.hypot(
            p.x - (state.campX as number),
            p.z - (state.campZ as number),
          ) < 1.5;

      // Ignore spawn hold / follow window (easy 2s hold + 2s follow; hard 1s+2s).
      const sinceSpawn = tick - p.spawnedAtTick;
      const inSpawnGrace = sinceSpawn < Math.round(4.5 * TICK_HZ);
      // Intentional still: look pauses, camps, combat ADAD stop phase.
      const combatPlant = state.combatStrafe === true &&
        state.strafePhase === "stop";

      if (
        p.onGround && !hold && !nearDoor && !nearCamp && !inSpawnGrace &&
        !combatPlant
      ) {
        if (moved < STUCK_MOVE_EPS) {
          t.lowMoveStreak += 1;
          t.totalStuckTicks += 1;
          t.maxStuckStreak = Math.max(t.maxStuckStreak, t.lowMoveStreak);
          if (t.lowMoveStreak === STUCK_EVENT_MIN) {
            t.stuckEvents += 1;
            t.stuckPositions.push({
              x: p.x,
              z: p.z,
              tick,
              stuckTicks,
            });
            const inf = sampleBotHintInfluence(map, p.team, p.x, p.z);
            const key = inf.kinds.length
              ? inf.kinds.slice().sort().join("+")
              : "(none)";
            t.stuckHintKinds.set(key, (t.stuckHintKinds.get(key) ?? 0) + 1);
          }
        } else {
          t.lowMoveStreak = 0;
        }
      } else {
        t.lowMoveStreak = 0;
      }

      // Thrash: many yaw flips while barely moving
      let dyaw = p.yaw - t.lastYaw;
      while (dyaw > Math.PI) dyaw -= Math.PI * 2;
      while (dyaw < -Math.PI) dyaw += Math.PI * 2;
      if (Math.abs(dyaw) > 0.6 && moved < 0.05) {
        t.yawFlipsInWindow += 1;
      }
      t.windowTick += 1;
      if (t.windowTick >= THRASH_WINDOW) {
        if (t.yawFlipsInWindow >= THRASH_MIN_TURNS && !hold) {
          t.thrashEvents += 1;
        }
        t.yawFlipsInWindow = 0;
        t.windowTick = 0;
      }

      if (tick % 30 === 0) {
        t.samples.push({
          tick,
          x: +p.x.toFixed(2),
          z: +p.z.toFixed(2),
          stuckTicks,
          mode: typeof state.mode === "string" ? state.mode : undefined,
          objective: typeof state.objective === "string"
            ? state.objective
            : undefined,
        });
      }

      t.lastX = p.x;
      t.lastZ = p.z;
      t.lastYaw = p.yaw;
    }
  }

  Math.random = originalRandom;

  const issues: string[] = [];
  const botList = [...telemetry.values()];

  for (const t of botList) {
    if (t.stuckEvents >= 2) {
      const pos = t.stuckPositions.slice(0, 3)
        .map((p) => `(${p.x.toFixed(1)},${p.z.toFixed(1)})@${p.tick}`)
        .join(", ");
      const hints = [...t.stuckHintKinds.entries()]
        .map(([k, n]) => `${k}×${n}`)
        .join(", ");
      issues.push(
        `STUCK ${t.name}/${t.team} (${t.brainId}): ${t.stuckEvents} events, maxStreak=${t.maxStuckStreak}, totalLowMove=${t.totalStuckTicks}, pos=[${pos}], hints={${hints}}`,
      );
    } else if (t.maxStuckStreak >= STUCK_EVENT_MIN) {
      const pos = t.stuckPositions[0];
      issues.push(
        `STUCK-ONCE ${t.name}/${t.team}: maxStreak=${t.maxStuckStreak} at (${
          pos?.x.toFixed(1)
        },${pos?.z.toFixed(1)})`,
      );
    }

    if (t.thrashEvents >= 3) {
      issues.push(
        `THRASH ${t.name}/${t.team}: ${t.thrashEvents} thrash windows`,
      );
    }

    // Door seekers (easy brain seeker or hard attack) should make progress
    // Heuristic: if never left own half after 15s+ and never got near mid
    const ownFrac = t.ticksAlive > 0 ? t.ticksInOwnHalf / t.ticksAlive : 1;
    if (
      t.ticksAlive > TICK_HZ * 15 &&
      ownFrac > 0.95 &&
      t.maxDoorProgress < 0.15 &&
      t.scores === 0
    ) {
      issues.push(
        `NO-PROGRESS ${t.name}/${t.team}: ${
          (ownFrac * 100).toFixed(0)
        }% own half, maxDoorProg=${
          (t.maxDoorProgress * 100).toFixed(0)
        }%, minDoorDist=${t.minDistToEnemyDoor.toFixed(1)}`,
      );
    }

    // Never got within 12u of enemy door over full sim and no scores — may be fine for campers
    if (
      difficulty === "easy" &&
      t.ticksAlive > TICK_HZ * 20 &&
      t.minDistToEnemyDoor > 18 &&
      t.scores === 0 &&
      t.maxDoorProgress < 0.2
    ) {
      // Only flag if this is likely a seeker (easy: one per team tends to push)
      // Soft issue — note only if also stuck
      if (t.stuckEvents > 0) {
        issues.push(
          `CAGED ${t.name}/${t.team}: stuck + never approached door (minDist=${
            t.minDistToEnemyDoor.toFixed(1)
          })`,
        );
      }
    }
  }

  // Team-level: if both teams scored 0 in 40s with 6 bots, something is wrong
  const scores = players.getScores();
  if (scores.A + scores.B === 0 && opts.seconds >= 30) {
    issues.push(
      `NO-SCORES: neither team scored in ${opts.seconds}s (may indicate blocked doors or total camp)`,
    );
  }

  // Half of bots with stuck events is a map-level problem
  const stuckBots = botList.filter((b) => b.stuckEvents >= 1).length;
  if (stuckBots >= Math.ceil(botList.length / 2)) {
    issues.push(
      `MAP-WIDE-STUCK: ${stuckBots}/${botList.length} bots had stuck events`,
    );
  }

  return {
    map: mapPath.replace(/^.*\//, "").replace(/\.doors\.json$/, ""),
    difficulty,
    ticks: totalTicks,
    scores,
    bots: botList,
    issues,
  };
}

function printReport(r: SimReport, verbose: boolean) {
  const tag = r.issues.length ? "FAIL" : "ok  ";
  console.log(
    `\n[${tag}] ${r.map} / ${r.difficulty}  scores A=${r.scores.A} B=${r.scores.B}  issues=${r.issues.length}`,
  );
  if (r.issues.length) {
    for (const i of r.issues) console.log(`  ! ${i}`);
  }
  if (verbose || r.issues.length) {
    for (const b of r.bots) {
      console.log(
        `    ${b.name}/${b.team} stuckEv=${b.stuckEvents} maxStreak=${b.maxStuckStreak} thrash=${b.thrashEvents} doorProg=${
          (b.maxDoorProgress * 100).toFixed(0)
        }% minDoor=${
          b.minDistToEnemyDoor.toFixed(1)
        } scores=${b.scores} deaths=${b.deaths} enemyHalf=${
          b.ticksAlive
            ? ((b.ticksInEnemyHalf / b.ticksAlive) * 100).toFixed(0)
            : 0
        }%`,
      );
      if (b.stuckPositions.length && verbose) {
        for (const p of b.stuckPositions.slice(0, 5)) {
          console.log(
            `      stuck@ t=${p.tick} (${p.x.toFixed(2)},${
              p.z.toFixed(2)
            }) brainStuck=${p.stuckTicks}`,
          );
        }
      }
    }
  }
}

async function main() {
  const opts = parseArgs(Deno.args);
  const paths = await listMaps(opts.maps);
  if (paths.length === 0) {
    console.error("No maps found");
    Deno.exit(1);
  }
  console.log(
    `Simulating ${paths.length} map(s), difficulties=${
      opts.difficulties.join(",")
    }, ${opts.seconds}s, ${opts.bots} bots, seed=${opts.seed}`,
  );

  let failCount = 0;
  const allReports: SimReport[] = [];
  let seed = opts.seed;

  for (const path of paths) {
    const map = JSON.parse(await Deno.readTextFile(path)) as DoorsMap;
    for (const diff of opts.difficulties) {
      const rng = mulberry32(seed++);
      const report = runSim(path, map, diff, opts, rng);
      allReports.push(report);
      printReport(report, opts.verbose);
      if (report.issues.length) failCount += 1;
    }
  }

  console.log("\n========== SUMMARY ==========");
  const byMap = new Map<string, SimReport[]>();
  for (const r of allReports) {
    const list = byMap.get(r.map) ?? [];
    list.push(r);
    byMap.set(r.map, list);
  }
  for (const [map, reps] of byMap) {
    const issues = reps.flatMap((r) =>
      r.issues.map((i) => `${r.difficulty}: ${i}`)
    );
    console.log(
      `${map}: ${issues.length === 0 ? "CLEAN" : issues.length + " issues"}`,
    );
    for (const i of issues) console.log(`  - ${i}`);
  }
  console.log(
    `\n${failCount}/${allReports.length} scenarios had issues`,
  );
  // Always exit 0 — this is a diagnostic tool, not a CI gate yet
}

if (import.meta.main) {
  await main();
}
