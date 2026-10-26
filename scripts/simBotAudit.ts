/**
 * Full bot-system audit: every map × brain type, with detectors for
 * door-edge dance/refuse, mid-wall aim, stuck, thrash, spin, wall-ram,
 * orbit, mobility (sprint/crouch/slide), shoot, and scores.
 *
 * Usage (from server/):
 *   deno run -A scripts/simBotAudit.ts
 *   deno run -A scripts/simBotAudit.ts --map Courtyard --type easy,hard,door-rush --seconds 50 -v
 *   deno run -A scripts/simBotAudit.ts --json /tmp/bot-audit.json --strict
 */

import { BotManager } from "../bots/BotManager.ts";
import {
  advanceBotAudit,
  advanceCloseContactPair,
  advanceOrbitPair,
  type AuditIssue,
  type BotAuditCounters,
  type BotAuditLive,
  type CloseContactPairState,
  createBotAuditLive,
  createCloseContactPairState,
  createOrbitPairState,
  issuesFromBot,
  type OrbitPairState,
  scenarioFailed,
  teamLevelIssues,
} from "../bots/auditMetrics.ts";
import {
  enemyDoorTarget,
  isFullWallAhead,
  isInEnemyDoorZone,
  isLookIntoFullWall,
} from "../bots/helpers/nav.ts";
import type { BotDifficulty } from "../bots/types.ts";
import { PlayerManager, type ShootOutcome } from "../players/PlayerManager.ts";
import type { Player } from "../players/Player.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";
import { listAvailableMapPaths } from "../world/loadMap.ts";
import { TICK_HZ } from "../protocol/network.ts";

const DEFAULT_SECONDS = 50;
const DEFAULT_BOTS = 6;

type ScenarioKind =
  | "team-easy"
  | "team-medium"
  | "team-hard"
  | "door-rush-easy"
  | "door-rush-hard"
  | "agent-hunt"
  | "balance-fill";

type CliOpts = {
  maps: string[] | null;
  types: string[] | null;
  seconds: number;
  bots: number;
  seed: number;
  verbose: boolean;
  jsonPath: string | null;
  strict: boolean;
};

function parseArgs(argv: string[]): CliOpts {
  let maps: string[] | null = null;
  let types: string[] | null = null;
  let seconds = DEFAULT_SECONDS;
  let bots = DEFAULT_BOTS;
  let seed = 1;
  let verbose = false;
  let jsonPath: string | null = null;
  let strict = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--map" && argv[i + 1]) maps = argv[++i]!.split(",");
    else if (a === "--type" && argv[i + 1]) types = argv[++i]!.split(",");
    else if (a === "--seconds" && argv[i + 1]) {
      seconds = Math.max(5, Number(argv[++i]));
    } else if (a === "--bots" && argv[i + 1]) {
      bots = Math.max(2, Number(argv[++i]));
    } else if (a === "--seed" && argv[i + 1]) seed = Number(argv[++i]);
    else if (a === "--verbose" || a === "-v") verbose = true;
    else if (a === "--json" && argv[i + 1]) jsonPath = argv[++i]!;
    else if (a === "--strict") strict = true;
  }
  return { maps, types, seconds, bots, seed, verbose, jsonPath, strict };
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

function mapNameFromPath(path: string): string {
  return path.replace(/^.*\//, "").replace(/\.doors\.json$/, "");
}

function countShotsByShooter(
  outcomes: { shot: { shooterId: string } }[],
): Map<string, number> {
  const shotById = new Map<string, number>();
  for (const o of outcomes) {
    const id = o.shot.shooterId;
    shotById.set(id, (shotById.get(id) ?? 0) + 1);
  }
  return shotById;
}

function wantsType(opts: CliOpts, kind: ScenarioKind): boolean {
  if (!opts.types) return true;
  const t = opts.types.map((x) => x.toLowerCase());
  if (kind.startsWith("team-")) {
    const d = kind.replace("team-", "");
    return t.includes(d) || t.includes("team") || t.includes(kind);
  }
  if (kind.startsWith("door-rush")) {
    return t.includes("door-rush") || t.includes("door") || t.includes(kind) ||
      (kind.includes("easy") && t.includes("easy")) ||
      (kind.includes("hard") && t.includes("hard") && t.includes("door-rush"));
  }
  if (kind === "agent-hunt") {
    return t.includes("agent") || t.includes("agent-hunt");
  }
  if (kind === "balance-fill") {
    return t.includes("balance") || t.includes("balance-fill");
  }
  return t.includes(kind);
}

type ManagedPeek = {
  /**
   * Legacy in-process brain state. Think now runs in `@doors/bot-engine`, so
   * this is absent — mode-dependent detectors fall back to spawn grace only.
   */
  state?: Record<string, unknown>;
  playerId: string;
  pipelineConfig?: { id: string };
  lastAppliedAction?: {
    input?: { sprint?: boolean; forward?: boolean; crouch?: boolean } | null;
    shoot?: boolean;
  } | null;
  readyAction?:
    | { input?: { sprint?: boolean; forward?: boolean } | null }
    | null;
  isBalanceBot?: boolean;
};

function brainIdOf(mb: ManagedPeek | undefined, fallback: string): string {
  return mb?.pipelineConfig?.id ?? fallback;
}

/** Stable per-scenario ids so apply order (ascending id) repeats per seed. */
function simBotId(nameIndex: number): string {
  return `bot:sim-${String(nameIndex).padStart(3, "0")}`;
}

/** Counter suffix for agent / balance-bot ids (bot-official hashes ids). */
function simIdSuffix(): () => string {
  let n = 0;
  return () => `sim${String(++n).padStart(5, "0")}`;
}

/** Sim RNG seed derived from the scenario rng so `--seed` fixes the match. */
function simMatchSeed(rng: () => number): number {
  return Math.floor(rng() * 0x7fff_ffff) >>> 0;
}

/** Enemy hits and damage dealt per shooter (team-hit mirror events excluded). */
function countHitsByShooter(
  outcomes: ShootOutcome[],
): Map<string, { hits: number; damage: number }> {
  const byId = new Map<string, { hits: number; damage: number }>();
  for (const o of outcomes) {
    for (const d of o.damages ?? []) {
      if (d.targetId === d.shooterId) continue;
      const row = byId.get(d.shooterId) ?? { hits: 0, damage: 0 };
      row.hits += 1;
      row.damage += d.damage;
      byId.set(d.shooterId, row);
    }
  }
  return byId;
}

function managedMaps(bots: BotManager): {
  bots: Map<string, ManagedPeek>;
  agents: Map<string, ManagedPeek>;
} {
  const raw = bots as unknown as {
    bots: Map<string, ManagedPeek>;
    agents: Map<string, ManagedPeek>;
    spawnAgent: (c: MapCollision) => boolean;
  };
  return { bots: raw.bots, agents: raw.agents };
}

function forceSpawnAgents(
  bots: BotManager,
  collision: MapCollision,
  n: number,
): void {
  const raw = bots as unknown as {
    spawnAgent: (c: MapCollision) => boolean;
  };
  for (let i = 0; i < n; i++) {
    raw.spawnAgent(collision);
  }
}

function isIntentionalHold(
  state: Record<string, unknown>,
  tick: number,
  p: Player,
): boolean {
  const mode = state.mode;
  const objective = state.objective;
  const phase = state.phase;
  if (phase === "look") return true;
  if (mode === "camp") return true;
  if (objective === "defend") return true;
  const sinceSpawn = tick - p.spawnedAtTick;
  if (sinceSpawn < Math.round(3.5 * TICK_HZ)) return true;
  if (state.combatStrafe === true && state.strafePhase === "stop") return true;
  return false;
}

function inOwnHalf(map: DoorsMap, team: "A" | "B", z: number): boolean {
  const midZ = (map.bounds.minZ + map.bounds.maxZ) / 2;
  const ownIsSouth = map.teamA.edge === "south" ? team === "A" : team === "B";
  return ownIsSouth ? z < midZ : z > midZ;
}

type ScenarioReport = {
  map: string;
  scenario: string;
  seconds: number;
  scores: { A: number; B: number };
  bots: BotAuditCounters[];
  issues: AuditIssue[];
  failed: boolean;
};

function runTeamMatch(
  map: DoorsMap,
  mapLabel: string,
  difficulty: BotDifficulty,
  seconds: number,
  botCount: number,
  rng: () => number,
): ScenarioReport {
  const originalRandom = Math.random;
  Math.random = rng;

  const collision = new MapCollision(map);
  const players = new PlayerManager(collision, {
    matchDurationSeconds: Math.max(120, seconds + 30),
    matchSeed: simMatchSeed(rng),
  });
  const bots = new BotManager(players, {}, {
    botIdFactory: simBotId,
    idSuffix: simIdSuffix(),
    difficulty,
    fill: { minPlayers: botCount, noBotsOnEmptyServer: false },
  });
  bots.reconcile(botCount);

  const scenario = `team-${difficulty}`;
  const { bots: managed, agents: managedAgents } = managedMaps(bots);
  const lives = new Map<string, BotAuditLive>();
  const orbitStates = new Map<string, OrbitPairState>();
  const closeStates = new Map<string, CloseContactPairState>();
  const orbitEvents: { a: string; b: string; tick: number }[] = [];
  const closeEvents: { a: string; b: string; tick: number }[] = [];

  const initBot = (p: Player, brainId: string) => {
    const door = enemyDoorTarget(map, p.team);
    const initDist = Math.hypot(door.x - p.x, door.z - p.z);
    lives.set(
      p.id,
      createBotAuditLive(
        p.id,
        p.name,
        p.team,
        brainId,
        p.x,
        p.z,
        p.yaw,
        initDist,
      ),
    );
  };

  for (const info of bots.list()) {
    const p = players.get(info.id);
    if (p) initBot(p, info.brainId);
  }

  const totalTicks = Math.floor(seconds * TICK_HZ);
  const prevAlive = new Map<string, boolean>();
  for (const p of players.allCached()) prevAlive.set(p.id, p.alive);

  for (let tick = 0; tick < totalTicks; tick++) {
    // Continue past match-over so late thrash/door issues still record
    if (players.isMatchOver()) {
      // Soft-reset: processRespawns still runs; brains freeze when match over
      // via BotManager — so break only if we cannot continue AI.
      // Prefer long match duration above; if we still hit win, stop cleanly.
      break;
    }

    const outcomes = bots.tick(tick, collision);
    players.update(tick);
    players.processScores(tick);
    players.processRespawns(tick);

    const shotById = countShotsByShooter(outcomes);
    const hitById = countHitsByShooter(outcomes);
    const doorsOpen = players.areDoorsOpen(tick);

    for (const p of players.allCached()) {
      if (!p.isBot && !p.isAgent) continue;
      let live = lives.get(p.id);
      if (!live) {
        const mb = managed.get(p.id) ?? managedAgents.get(p.id);
        initBot(p, brainIdOf(mb, "unknown"));
        live = lives.get(p.id)!;
      }

      const wasAlive = prevAlive.get(p.id) ?? true;
      if (wasAlive && !p.alive) live.counters.deaths += 1;
      prevAlive.set(p.id, p.alive);

      const mb = managed.get(p.id) ?? managedAgents.get(p.id);
      const state = (mb?.state ?? {}) as Record<string, unknown>;
      const action = mb?.lastAppliedAction ?? mb?.readyAction;
      const sprint = Boolean(action?.input?.sprint) ||
        (p.sprintStamina < 7.5 && !p.crouch && p.alive);
      const forwardIntent = action?.input?.forward !== false;

      const door = enemyDoorTarget(map, p.team as "A" | "B");
      const doorDist = Math.hypot(door.x - p.x, door.z - p.z);
      const lookIntoWall = isLookIntoFullWall(collision, p.x, p.z, p.yaw);
      const wallAhead = isFullWallAhead(collision, p.x, p.z, p.yaw, 1.0);

      advanceBotAudit(live, {
        tick,
        x: p.x,
        z: p.z,
        yaw: p.yaw,
        alive: p.alive,
        onGround: p.onGround,
        crouch: p.crouch,
        sliding: p.isSliding(),
        sprint,
        forwardIntent,
        lookIntoWall,
        wallAhead,
        doorDist,
        inEnemyDoorZone: isInEnemyDoorZone(
          collision,
          p.x,
          p.z,
          p.team as "A" | "B",
        ),
        doorsOpen,
        intentionalHold: isIntentionalHold(state, tick, p),
        inOwnHalf: inOwnHalf(map, p.team as "A" | "B", p.z),
        score: p.score,
        kills: p.kills,
        shotsThisTick: shotById.get(p.id) ?? 0,
        hitsThisTick: hitById.get(p.id)?.hits ?? 0,
        damageThisTick: hitById.get(p.id)?.damage ?? 0,
      });
    }

    // Pair orbit + close-linger among alive bots (and agents)
    const aliveIds = [...lives.values()].filter((l) => l.alive).map((l) =>
      l.counters.id
    );
    for (let i = 0; i < aliveIds.length; i++) {
      for (let j = i + 1; j < aliveIds.length; j++) {
        const a = aliveIds[i]!;
        const b = aliveIds[j]!;
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        let st = orbitStates.get(key);
        if (!st) {
          st = createOrbitPairState();
          orbitStates.set(key, st);
        }
        let cst = closeStates.get(key);
        if (!cst) {
          cst = createCloseContactPairState();
          closeStates.set(key, cst);
        }
        const la = lives.get(a)!;
        const lb = lives.get(b)!;
        if (advanceOrbitPair(st, la.x, la.z, lb.x, lb.z)) {
          orbitEvents.push({ a, b, tick });
        }
        if (advanceCloseContactPair(cst, la.x, la.z, lb.x, lb.z, tick)) {
          closeEvents.push({ a, b, tick });
        }
      }
    }
  }

  Math.random = originalRandom;

  const botList = [...lives.values()].map((l) => l.counters);
  const scores = players.getScores();
  const issueOpts = {
    scenario: "team-match" as const,
    seconds,
    teamScores: scores,
  };
  const issues: AuditIssue[] = [
    ...botList.flatMap((c) =>
      issuesFromBot(c, {
        ...issueOpts,
        isBalance: c.brainId === "balance-bot",
      })
    ),
    ...teamLevelIssues(botList, issueOpts),
    ...pairProximityIssues(orbitEvents, closeEvents),
  ];

  return {
    map: mapLabel,
    scenario,
    seconds,
    scores,
    bots: botList,
    issues,
    failed: scenarioFailed(issues),
  };
}

/**
 * Pair dance / body-linger issues.
 * One brief brush can be combat noise; repeated events are a real dance.
 */
function pairProximityIssues(
  orbitEvents: { a: string; b: string; tick: number }[],
  closeEvents: { a: string; b: string; tick: number }[],
): AuditIssue[] {
  const issues: AuditIssue[] = [];
  // Any orbit window is high — circling is never OK.
  for (const ev of orbitEvents.slice(0, 5)) {
    issues.push({
      code: "ORBIT",
      severity: "high",
      msg: `pair orbit (circle dance) ${ev.a} ↔ ${ev.b} @ t=${ev.tick}`,
      botId: ev.a,
    });
  }
  if (orbitEvents.length > 5) {
    issues.push({
      code: "ORBIT",
      severity: "high",
      msg: `${orbitEvents.length} pair-orbit windows total`,
    });
  }
  // CLOSE-LINGER: single planted contact = med; 2+ = high (systemic).
  const closeSev: AuditIssue["severity"] = closeEvents.length >= 2
    ? "high"
    : "med";
  for (const ev of closeEvents.slice(0, 5)) {
    issues.push({
      code: "CLOSE-LINGER",
      severity: closeSev,
      msg: `close without run-past ${ev.a} ↔ ${ev.b} @ t=${ev.tick}`,
      botId: ev.a,
    });
  }
  if (closeEvents.length > 5) {
    issues.push({
      code: "CLOSE-LINGER",
      severity: "high",
      msg: `${closeEvents.length} close-linger events total`,
    });
  }
  return issues;
}

function spawnVariants(
  map: DoorsMap,
): { team: "A" | "B"; x: number; z: number }[][] {
  const b = map.bounds;
  // Keep spawns off perimeter float corridors (Courtyard x=±10) — pad in enough
  // that left/right variants still have a clean lane to the mid bars.
  const pad = 2.5;
  const aSouth = map.teamA.edge === "south";
  const aZ = aSouth ? b.minZ + pad + 1 : b.maxZ - pad - 1;
  const bZ = aSouth ? b.maxZ - pad - 1 : b.minZ + pad + 1;
  const midX = (b.minX + b.maxX) / 2;
  const span = b.maxX - b.minX;
  // 30% / 70% across instead of wall corners (avoids float walls on Courtyard).
  const leftX = b.minX + span * 0.3;
  const rightX = b.minX + span * 0.7;
  return [
    [
      { team: "A", x: midX, z: aZ },
      { team: "B", x: midX, z: bZ },
    ],
    [
      { team: "A", x: leftX, z: aZ },
      { team: "B", x: leftX, z: bZ },
    ],
    [
      { team: "A", x: rightX, z: aZ },
      { team: "B", x: rightX, z: bZ },
    ],
  ];
}

function runDoorRush(
  map: DoorsMap,
  mapLabel: string,
  difficulty: "easy" | "hard",
  seconds: number,
  seeds: { team: "A" | "B"; x: number; z: number }[],
  variant: number,
  rng: () => number,
): ScenarioReport {
  const originalRandom = Math.random;
  Math.random = rng;

  const collision = new MapCollision(map);
  const players = new PlayerManager(collision, {
    matchDurationSeconds: Math.max(120, seconds + 30),
    matchSeed: simMatchSeed(rng),
  });
  const bots = new BotManager(players, {}, {
    botIdFactory: simBotId,
    idSuffix: simIdSuffix(),
    difficulty,
    fill: { minPlayers: 0, noBotsOnEmptyServer: false },
    autoFill: false,
  });

  bots.addBots(seeds.length, 8);
  const { bots: managed } = managedMaps(bots);
  const list = bots.list();
  const lives = new Map<string, BotAuditLive>();
  const orbitStates = new Map<string, OrbitPairState>();
  const closeStates = new Map<string, CloseContactPairState>();
  const orbitEvents: { a: string; b: string; tick: number }[] = [];
  const closeEvents: { a: string; b: string; tick: number }[] = [];

  let si = 0;
  for (const info of list) {
    if (si >= seeds.length) break;
    const p = players.get(info.id);
    if (!p) continue;
    const seed = seeds[si++]!;
    p.team = seed.team;
    p.x = seed.x;
    p.z = seed.z;
    p.y = 1.7;
    p.yaw = seed.team === "A" ? Math.PI : 0;
    p.spawnedAtTick = 0;
    p.alive = true;
    const door = enemyDoorTarget(map, p.team);
    const initDist = Math.hypot(door.x - p.x, door.z - p.z);
    lives.set(
      p.id,
      createBotAuditLive(
        p.id,
        p.name,
        p.team,
        info.brainId,
        p.x,
        p.z,
        p.yaw,
        initDist,
      ),
    );
  }

  const totalTicks = Math.floor(seconds * TICK_HZ);
  for (let tick = 0; tick < totalTicks; tick++) {
    if (difficulty === "hard") {
      for (const mb of managed.values()) {
        // doorSprinter → attack objective. "seeker" role is mid-hunt, not door.
        // No-op since think moved into @doors/bot-engine (no in-process state).
        if (!mb.state) continue;
        mb.state.mode = "rush";
        mb.state.objective = "attack";
        mb.state.role = "doorSprinter";
        mb.state.campX = undefined;
        mb.state.campZ = undefined;
        mb.state.openPushReadyTick = undefined;
      }
    }

    if (players.isMatchOver()) break;
    const outcomes = bots.tick(tick, collision);
    players.update(tick);
    players.processScores(tick);
    players.processRespawns(tick);

    const shotById = countShotsByShooter(outcomes);
    const hitById = countHitsByShooter(outcomes);
    const doorsOpen = players.areDoorsOpen(tick);

    for (const [id, live] of lives) {
      const p = players.get(id);
      if (!p) continue;
      const mb = managed.get(id);
      const state = (mb?.state ?? {}) as Record<string, unknown>;
      if (difficulty === "hard" && p.alive) {
        state.mode = "rush";
        state.objective = "attack";
        state.role = "doorSprinter";
        state.campX = undefined;
        state.campZ = undefined;
        state.openPushReadyTick = undefined;
      }
      const action = mb?.lastAppliedAction ?? mb?.readyAction;
      const door = enemyDoorTarget(map, p.team as "A" | "B");
      const doorDist = Math.hypot(door.x - p.x, door.z - p.z);

      advanceBotAudit(live, {
        tick,
        x: p.x,
        z: p.z,
        yaw: p.yaw,
        alive: p.alive,
        onGround: p.onGround,
        crouch: p.crouch,
        sliding: p.isSliding(),
        sprint: Boolean(action?.input?.sprint),
        forwardIntent: action?.input?.forward !== false,
        lookIntoWall: isLookIntoFullWall(collision, p.x, p.z, p.yaw),
        wallAhead: isFullWallAhead(collision, p.x, p.z, p.yaw, 1.0),
        doorDist,
        inEnemyDoorZone: isInEnemyDoorZone(
          collision,
          p.x,
          p.z,
          p.team as "A" | "B",
        ),
        doorsOpen,
        intentionalHold: isIntentionalHold(state, tick, p),
        inOwnHalf: inOwnHalf(map, p.team as "A" | "B", p.z),
        score: p.score,
        kills: p.kills,
        shotsThisTick: shotById.get(p.id) ?? 0,
        hitsThisTick: hitById.get(p.id)?.hits ?? 0,
        damageThisTick: hitById.get(p.id)?.damage ?? 0,
      });
    }

    const aliveIds = [...lives.values()].filter((l) => l.alive).map((l) =>
      l.counters.id
    );
    for (let i = 0; i < aliveIds.length; i++) {
      for (let j = i + 1; j < aliveIds.length; j++) {
        const a = aliveIds[i]!;
        const b = aliveIds[j]!;
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        let st = orbitStates.get(key);
        if (!st) {
          st = createOrbitPairState();
          orbitStates.set(key, st);
        }
        let cst = closeStates.get(key);
        if (!cst) {
          cst = createCloseContactPairState();
          closeStates.set(key, cst);
        }
        const la = lives.get(a)!;
        const lb = lives.get(b)!;
        if (advanceOrbitPair(st, la.x, la.z, lb.x, lb.z)) {
          orbitEvents.push({ a, b, tick });
        }
        if (advanceCloseContactPair(cst, la.x, la.z, lb.x, lb.z, tick)) {
          closeEvents.push({ a, b, tick });
        }
      }
    }
  }

  Math.random = originalRandom;

  const botList = [...lives.values()].map((l) => l.counters);
  const scores = players.getScores();
  const issues = [
    ...botList.flatMap((c) =>
      issuesFromBot(c, {
        scenario: "door-rush",
        seconds,
        teamScores: scores,
      })
    ),
    ...pairProximityIssues(orbitEvents, closeEvents),
  ];

  return {
    map: mapLabel,
    scenario: `door-rush-${difficulty}-v${variant}`,
    seconds,
    scores,
    bots: botList,
    issues,
    failed: scenarioFailed(issues),
  };
}

function runAgentHunt(
  map: DoorsMap,
  mapLabel: string,
  seconds: number,
  rng: () => number,
): ScenarioReport {
  const originalRandom = Math.random;
  Math.random = rng;

  const collision = new MapCollision(map);
  const players = new PlayerManager(collision, {
    matchDurationSeconds: Math.max(120, seconds + 30),
    matchSeed: simMatchSeed(rng),
  });
  // Bait team bots
  const bots = new BotManager(players, {}, {
    botIdFactory: simBotId,
    idSuffix: simIdSuffix(),
    difficulty: "hard",
    fill: { minPlayers: 4, noBotsOnEmptyServer: false },
  });
  bots.reconcile(4);
  forceSpawnAgents(bots, collision, 2);

  const { bots: managed, agents: managedAgents } = managedMaps(bots);
  const lives = new Map<string, BotAuditLive>();
  const orbitStates = new Map<string, OrbitPairState>();
  const closeStates = new Map<string, CloseContactPairState>();
  const orbitEvents: { a: string; b: string; tick: number }[] = [];
  const closeEvents: { a: string; b: string; tick: number }[] = [];

  for (const p of players.allCached()) {
    if (!p.isBot && !p.isAgent) continue;
    const mb = managed.get(p.id) ?? managedAgents.get(p.id);
    const door = enemyDoorTarget(map, p.team as "A" | "B");
    const initDist = Math.hypot(door.x - p.x, door.z - p.z);
    lives.set(
      p.id,
      createBotAuditLive(
        p.id,
        p.name,
        p.team,
        brainIdOf(mb, p.isAgent ? "agent" : "hard"),
        p.x,
        p.z,
        p.yaw,
        initDist,
      ),
    );
  }

  const totalTicks = Math.floor(seconds * TICK_HZ);
  for (let tick = 0; tick < totalTicks; tick++) {
    if (players.isMatchOver()) break;
    const outcomes = bots.tick(tick, collision);
    players.update(tick);
    players.processScores(tick);
    players.processRespawns(tick);

    const shotById = countShotsByShooter(outcomes);
    const hitById = countHitsByShooter(outcomes);
    const doorsOpen = players.areDoorsOpen(tick);

    for (const [id, live] of lives) {
      const p = players.get(id);
      if (!p) continue;
      const mb = managed.get(id) ?? managedAgents.get(id);
      const state = (mb?.state ?? {}) as Record<string, unknown>;
      const action = mb?.lastAppliedAction ?? mb?.readyAction;
      const door = enemyDoorTarget(map, p.team as "A" | "B");
      const doorDist = Math.hypot(door.x - p.x, door.z - p.z);

      advanceBotAudit(live, {
        tick,
        x: p.x,
        z: p.z,
        yaw: p.yaw,
        alive: p.alive,
        onGround: p.onGround,
        crouch: p.crouch,
        sliding: p.isSliding(),
        sprint: Boolean(action?.input?.sprint),
        forwardIntent: action?.input?.forward !== false,
        lookIntoWall: isLookIntoFullWall(collision, p.x, p.z, p.yaw),
        wallAhead: isFullWallAhead(collision, p.x, p.z, p.yaw, 1.0),
        doorDist,
        inEnemyDoorZone: p.isAgent
          ? false
          : isInEnemyDoorZone(collision, p.x, p.z, p.team as "A" | "B"),
        doorsOpen,
        intentionalHold: isIntentionalHold(state, tick, p),
        inOwnHalf: inOwnHalf(map, p.team as "A" | "B", p.z),
        score: p.score,
        kills: p.kills,
        shotsThisTick: shotById.get(p.id) ?? 0,
        hitsThisTick: hitById.get(p.id)?.hits ?? 0,
        damageThisTick: hitById.get(p.id)?.damage ?? 0,
      });
    }

    const aliveIds = [...lives.values()].filter((l) => l.alive).map((l) =>
      l.counters.id
    );
    for (let i = 0; i < aliveIds.length; i++) {
      for (let j = i + 1; j < aliveIds.length; j++) {
        const a = aliveIds[i]!;
        const b = aliveIds[j]!;
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        let st = orbitStates.get(key);
        if (!st) {
          st = createOrbitPairState();
          orbitStates.set(key, st);
        }
        let cst = closeStates.get(key);
        if (!cst) {
          cst = createCloseContactPairState();
          closeStates.set(key, cst);
        }
        const la = lives.get(a)!;
        const lb = lives.get(b)!;
        if (advanceOrbitPair(st, la.x, la.z, lb.x, lb.z)) {
          orbitEvents.push({ a, b, tick });
        }
        if (advanceCloseContactPair(cst, la.x, la.z, lb.x, lb.z, tick)) {
          closeEvents.push({ a, b, tick });
        }
      }
    }
  }

  Math.random = originalRandom;
  const botList = [...lives.values()].map((l) => l.counters);
  const scores = players.getScores();
  const issues = [
    ...botList.flatMap((c) =>
      issuesFromBot(c, {
        scenario: "agent-hunt",
        seconds,
        teamScores: scores,
        ignoreDoors: c.brainId === "agent",
      })
    ),
    ...pairProximityIssues(orbitEvents, closeEvents),
  ];

  // Agents should shoot something
  const agents = botList.filter((b) => b.brainId === "agent");
  if (agents.length === 0) {
    issues.push({
      code: "NO-AGENT",
      severity: "high",
      msg: "no agents spawned for agent-hunt",
    });
  }

  return {
    map: mapLabel,
    scenario: "agent-hunt",
    seconds,
    scores,
    bots: botList,
    issues,
    failed: scenarioFailed(issues),
  };
}

function runBalanceFill(
  map: DoorsMap,
  mapLabel: string,
  seconds: number,
  rng: () => number,
): ScenarioReport {
  const originalRandom = Math.random;
  Math.random = rng;

  const collision = new MapCollision(map);
  const players = new PlayerManager(collision, {
    matchDurationSeconds: Math.max(120, seconds + 30),
    matchSeed: simMatchSeed(rng),
  });
  // One human creates uneven potential; fill bots; force all bots to one team
  players.add("sim-human", "SimHuman", "A");
  const bots = new BotManager(players, {}, {
    botIdFactory: simBotId,
    idSuffix: simIdSuffix(),
    difficulty: "easy",
    fill: { minPlayers: 3, noBotsOnEmptyServer: false },
  });
  bots.reconcile(8);

  // Force uneven: put all non-balance bots on A so balance should sit on B
  for (const p of players.allCached()) {
    if (p.isBot && !p.isBalanceBot && !p.isAgent) {
      p.team = "A";
    }
  }
  bots.reconcile(8);

  const { bots: managed } = managedMaps(bots);
  const lives = new Map<string, BotAuditLive>();
  for (const p of players.allCached()) {
    if (!p.isBot) continue;
    const mb = managed.get(p.id);
    const door = enemyDoorTarget(map, p.team as "A" | "B");
    const initDist = Math.hypot(door.x - p.x, door.z - p.z);
    lives.set(
      p.id,
      createBotAuditLive(
        p.id,
        p.name,
        p.team,
        brainIdOf(mb, "unknown"),
        p.x,
        p.z,
        p.yaw,
        initDist,
      ),
    );
  }

  const totalTicks = Math.floor(seconds * TICK_HZ);
  for (let tick = 0; tick < totalTicks; tick++) {
    if (players.isMatchOver()) break;
    // Keep teams uneven so balance bot stays
    bots.reconcile(8);
    const outcomes = bots.tick(tick, collision);
    players.update(tick);
    players.processScores(tick);
    players.processRespawns(tick);

    const shotById = countShotsByShooter(outcomes);
    const hitById = countHitsByShooter(outcomes);
    const doorsOpen = players.areDoorsOpen(tick);

    for (const [id, live] of lives) {
      const p = players.get(id);
      if (!p) continue;
      const mb = managed.get(id);
      if (!mb) continue;
      const state = mb.state ?? {};
      const action = mb.lastAppliedAction ?? mb.readyAction;
      const door = enemyDoorTarget(map, p.team as "A" | "B");
      const doorDist = Math.hypot(door.x - p.x, door.z - p.z);

      advanceBotAudit(live, {
        tick,
        x: p.x,
        z: p.z,
        yaw: p.yaw,
        alive: p.alive,
        onGround: p.onGround,
        crouch: p.crouch,
        sliding: p.isSliding(),
        sprint: Boolean(action?.input?.sprint),
        forwardIntent: action?.input?.forward !== false,
        lookIntoWall: isLookIntoFullWall(collision, p.x, p.z, p.yaw),
        wallAhead: isFullWallAhead(collision, p.x, p.z, p.yaw, 1.0),
        doorDist,
        inEnemyDoorZone: isInEnemyDoorZone(
          collision,
          p.x,
          p.z,
          p.team as "A" | "B",
        ),
        doorsOpen,
        intentionalHold: isIntentionalHold(state, tick, p),
        inOwnHalf: inOwnHalf(map, p.team as "A" | "B", p.z),
        score: p.score,
        kills: p.kills,
        shotsThisTick: shotById.get(p.id) ?? 0,
        hitsThisTick: hitById.get(p.id)?.hits ?? 0,
        damageThisTick: hitById.get(p.id)?.damage ?? 0,
      });
    }
  }

  Math.random = originalRandom;
  const botList = [...lives.values()].map((l) => l.counters);
  const scores = players.getScores();
  const issues = botList.flatMap((c) =>
    issuesFromBot(c, {
      scenario: "balance-fill",
      seconds,
      teamScores: scores,
      isBalance: c.brainId === "balance-bot" || c.name === "bot",
    })
  );
  if (!botList.some((b) => b.brainId === "balance-bot" || b.name === "bot")) {
    issues.push({
      code: "NO-BALANCE",
      severity: "med",
      msg: "balance bot never appeared",
    });
  }

  return {
    map: mapLabel,
    scenario: "balance-fill",
    seconds,
    scores,
    bots: botList,
    issues,
    failed: scenarioFailed(issues),
  };
}

function printReport(r: ScenarioReport, verbose: boolean) {
  const tag = r.failed ? "FAIL" : "ok  ";
  console.log(
    `\n[${tag}] ${r.map} / ${r.scenario}  scores A=${r.scores.A} B=${r.scores.B}  issues=${r.issues.length}`,
  );
  for (const i of r.issues) {
    const pos = i.x !== undefined
      ? ` @(${i.x.toFixed(1)},${i.z?.toFixed(1)})`
      : "";
    console.log(`  ! [${i.severity}/${i.code}] ${i.msg}${pos}`);
  }
  if (verbose || r.failed) {
    for (const b of r.bots) {
      console.log(
        `    ${b.name}/${b.team}(${b.brainId}) stuck=${b.stuckEvents} thrash=${b.thrashEvents} spin=${b.spinEvents} wallAim=${b.wallAimEvents} wallRam=${b.wallRamEvents} doorDance=${b.doorDanceEvents} shots=${b.shotsResolved} hits=${b.hitsLanded} dmg=${b.damageDealt} sprint=${b.sprintTicks} crouch=${b.crouchTicks} slides=${b.slideStarts} minDoor=${
          b.minDoorDist.toFixed(1)
        } entered=${b.enteredEnemyDoor} score=${b.scores} kills=${b.kills}`,
      );
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
    `Bot audit: ${paths.length} map(s), ${opts.seconds}s, ${opts.bots} bots, seed=${opts.seed}`,
  );
  console.log(`Types filter: ${opts.types?.join(",") ?? "all"}`);

  const reports: ScenarioReport[] = [];
  let seed = opts.seed;

  const balanceMaps = new Set(["Crossroads", "Courtyard", "Hourglass"]);

  for (const path of paths) {
    const map = JSON.parse(await Deno.readTextFile(path)) as DoorsMap;
    const label = mapNameFromPath(path);

    for (const diff of ["easy", "medium", "hard"] as BotDifficulty[]) {
      const kind = `team-${diff}` as ScenarioKind;
      if (!wantsType(opts, kind)) continue;
      const report = runTeamMatch(
        map,
        label,
        diff,
        opts.seconds,
        opts.bots,
        mulberry32(seed++),
      );
      reports.push(report);
      printReport(report, opts.verbose);
    }

    for (const diff of ["easy", "hard"] as const) {
      if (!wantsType(opts, `door-rush-${diff}`)) {
        // Also allow --type door-rush to run both
        if (!opts.types?.some((t) => t.toLowerCase() === "door-rush")) continue;
      }
      if (
        opts.types &&
        !opts.types.some((t) => {
          const x = t.toLowerCase();
          return x === "door-rush" || x === `door-rush-${diff}` || x === "door";
        }) &&
        !wantsType(opts, `door-rush-${diff}`)
      ) {
        // If types only lists easy/hard without door-rush, skip door-rush
        if (!opts.types.some((t) => t.toLowerCase() === "door-rush")) {
          // fall through only if door-rush explicitly wanted via wantsType
        }
      }
    }

    // Door-rush: run if no type filter, or door-rush / easy / hard as appropriate
    const runDoor = !opts.types ||
      opts.types.some((t) => {
        const x = t.toLowerCase();
        return x === "door-rush" || x === "door" || x.startsWith("door-rush");
      });
    if (runDoor) {
      const variants = spawnVariants(map);
      for (const diff of ["easy", "hard"] as const) {
        if (
          opts.types &&
          !opts.types.some((t) => {
            const x = t.toLowerCase();
            return x === "door-rush" || x === "door" ||
              x === `door-rush-${diff}` ||
              (x === diff &&
                opts.types!.some((y) => y.toLowerCase().includes("door")));
          })
        ) {
          // if types is only "easy" without door-rush, still skip unless only door-rush types
          const onlyTeam = opts.types.every((t) =>
            ["easy", "medium", "hard", "team"].includes(t.toLowerCase())
          );
          if (onlyTeam) continue;
          if (!opts.types.some((t) => t.toLowerCase().includes("door"))) {
            continue;
          }
        }
        for (let vi = 0; vi < variants.length; vi++) {
          const report = runDoorRush(
            map,
            label,
            diff,
            opts.seconds,
            variants[vi]!,
            vi,
            mulberry32(seed++),
          );
          reports.push(report);
          printReport(report, opts.verbose);
        }
      }
    }

    if (wantsType(opts, "agent-hunt")) {
      const report = runAgentHunt(map, label, opts.seconds, mulberry32(seed++));
      reports.push(report);
      printReport(report, opts.verbose);
    }

    if (wantsType(opts, "balance-fill") && balanceMaps.has(label)) {
      const report = runBalanceFill(
        map,
        label,
        opts.seconds,
        mulberry32(seed++),
      );
      reports.push(report);
      printReport(report, opts.verbose);
    }
  }

  // Summary
  console.log("\n========== AUDIT SUMMARY ==========");
  const failed = reports.filter((r) => r.failed);
  const byCode = new Map<string, number>();
  for (const r of reports) {
    for (const i of r.issues) {
      byCode.set(i.code, (byCode.get(i.code) ?? 0) + 1);
    }
  }
  console.log(
    `Scenarios: ${reports.length}  FAIL: ${failed.length}  ok: ${
      reports.length - failed.length
    }`,
  );
  console.log("Issue counts by code:");
  for (const [code, n] of [...byCode.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${code}: ${n}`);
  }
  if (failed.length) {
    console.log("\nFailed scenarios:");
    for (const r of failed) {
      const codes = [
        ...new Set(
          r.issues.filter((i) => i.severity === "high").map((i) => i.code),
        ),
      ];
      console.log(
        `  ${r.map}/${r.scenario}: ${
          codes.join(", ") || r.issues.map((i) => i.code).join(", ")
        }`,
      );
    }
  }

  if (opts.jsonPath) {
    const payload = {
      generatedAt: new Date().toISOString(),
      seconds: opts.seconds,
      seed: opts.seed,
      reports: reports.map((r) => ({
        map: r.map,
        scenario: r.scenario,
        scores: r.scores,
        failed: r.failed,
        issues: r.issues,
        bots: r.bots.map((b) => ({
          name: b.name,
          team: b.team,
          brainId: b.brainId,
          stuckEvents: b.stuckEvents,
          thrashEvents: b.thrashEvents,
          spinEvents: b.spinEvents,
          wallAimEvents: b.wallAimEvents,
          wallRamEvents: b.wallRamEvents,
          doorDanceEvents: b.doorDanceEvents,
          shotsResolved: b.shotsResolved,
          hitsLanded: b.hitsLanded,
          damageDealt: b.damageDealt,
          deaths: b.deaths,
          ticksAlive: b.ticksAlive,
          maxStuckStreak: b.maxStuckStreak,
          maxDoorProgress: b.maxDoorProgress,
          sprintTicks: b.sprintTicks,
          crouchTicks: b.crouchTicks,
          slideStarts: b.slideStarts,
          minDoorDist: b.minDoorDist,
          enteredEnemyDoor: b.enteredEnemyDoor,
          scores: b.scores,
          kills: b.kills,
          samples: b.samples,
        })),
      })),
    };
    await Deno.writeTextFile(opts.jsonPath, JSON.stringify(payload, null, 2));
    console.log(`\nWrote ${opts.jsonPath}`);
  }

  if (opts.strict && failed.length > 0) {
    Deno.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
