/**
 * Navigation-focused bot sim: solo door-rushers (no combat opponents) on each
 * map. Detects true pathing stucks vs intentional still (spawn hold / look).
 *
 *   deno run -A scripts/simBotNav.ts
 *   deno run -A scripts/simBotNav.ts --map Pillars --seconds 45
 */

import { BotManager } from "../bots/BotManager.ts";
import { PlayerManager } from "../players/PlayerManager.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";
import { listAvailableMapPaths } from "../world/loadMap.ts";
import { TICK_HZ } from "../protocol/network.ts";
import { enemyDoorTarget } from "../bots/helpers/nav.ts";
import { sampleBotHintInfluence } from "@doors/bot-engine/thoughts/helpers/hints.ts";


type CliOpts = {
  maps: string[] | null;
  seconds: number;
  verbose: boolean;
};

function parseArgs(argv: string[]): CliOpts {
  let maps: string[] | null = null;
  let seconds = 40;
  let verbose = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--map" && argv[i + 1]) maps = argv[++i]!.split(",");
    else if (a === "--seconds" && argv[i + 1]) {
      seconds = Math.max(5, Number(argv[++i]));
    } else if (a === "--verbose" || a === "-v") verbose = true;
  }
  return { maps, seconds, verbose };
}

async function listMaps(filter: string[] | null): Promise<string[]> {
  const paths = (await listAvailableMapPaths()).filter((path) => {
    const base = path.split("/").pop()?.replace(/\.doors\.json$/, "") ?? "";
    return !filter || filter.some((name) => base.toLowerCase() === name.toLowerCase());
  });
  paths.sort((a, b) => a.localeCompare(b));
  return paths;
}

type StuckSample = {
  tick: number;
  x: number;
  z: number;
  brainStuck: number;
  phase?: string;
  mode?: string;
  objective?: string;
  hints: string;
  forward: boolean;
  blocked: boolean;
};

type BotResult = {
  id: string;
  team: "A" | "B";
  brain: string;
  scored: number;
  minDoorDist: number;
  maxDoorProgress: number;
  // True pathing stuck: walking intent, not hold/look/spawn, little move, long streak
  pathStuckEvents: StuckSample[];
  maxBrainStuck: number;
  maxPathStuckStreak: number;
  finalX: number;
  finalZ: number;
  path: { t: number; x: number; z: number }[];
};

/** Run one solo door-seeker per team (2 bots), force door-seeker behavior. */
function runDoorRush(
  map: DoorsMap,
  difficulty: "easy" | "hard",
  seconds: number,
  spawnSeeds: { team: "A" | "B"; x: number; z: number }[],
): BotResult[] {
  const collision = new MapCollision(map);
  const players = new PlayerManager(collision);

  // Manually spawn exactly 2 bots with forced door-walk brains.
  const bots = new BotManager(players, {}, {
    difficulty,
    // Allow bots with zero humans so this offline sim actually spawns.
    fill: { minPlayers: 0, noBotsOnEmptyServer: false },
    autoFill: false,
  });

  // Place one bot per seed
  for (let i = 0; i < spawnSeeds.length; i++) {
    bots.addBots(1, 8);
  }

  // Force positions/teams
  const list = bots.list();
  const managed = (bots as unknown as {
    bots: Map<string, {
      state: Record<string, unknown>;
      playerId: string;
      brain: { id: string };
    }>;
  }).bots;

  // Reassign teams and positions (only seeded door-rushers; skip balance bot extras)
  const results: BotResult[] = [];
  let si = 0;
  for (const info of list) {
    if (si >= spawnSeeds.length) break;
    const p = players.get(info.id);
    if (!p) continue;
    const seed = spawnSeeds[si++]!;
    p.team = seed.team;
    p.x = seed.x;
    p.z = seed.z;
    p.y = 1.7;
    p.yaw = seed.team === "A" ? Math.PI : 0; // face north / south-ish
    p.spawnedAtTick = 0;
    p.alive = true;

    const door = enemyDoorTarget(map, p.team);
    const initDist = Math.hypot(door.x - p.x, door.z - p.z);
    results.push({
      id: p.id,
      team: p.team,
      brain: info.brainId,
      scored: 0,
      minDoorDist: initDist,
      maxDoorProgress: 0,
      pathStuckEvents: [],
      maxBrainStuck: 0,
      maxPathStuckStreak: 0,
      finalX: p.x,
      finalZ: p.z,
      path: [{ t: 0, x: p.x, z: p.z }],
    });
  }

  // For hard: force attack mode every life
  const totalTicks = seconds * TICK_HZ;
  const pathStreak = new Map<string, number>();
  const lastPos = new Map<string, { x: number; z: number }>();
  const lastInputForward = new Map<string, boolean>();

  for (let tick = 0; tick < totalTicks; tick++) {
    // Force hard bots to attack the door (no camping)
    if (difficulty === "hard") {
      for (const mb of managed.values()) {
        // doorSprinter = attack door. Role "seeker" is mid-hunt, not scoring.
        mb.state.mode = "rush";
        mb.state.objective = "attack";
        mb.state.role = "doorSprinter";
        mb.state.campX = undefined;
        mb.state.campZ = undefined;
        mb.state.openPushReadyTick = undefined;
      }
    }

    bots.tick(tick, collision);
    players.update(tick);
    const scores = players.processScores(tick);
    players.processRespawns(tick);

    for (const r of results) {
      const p = players.get(r.id);
      if (!p) continue;
      const mb = managed.get(r.id);
      const s = (mb?.state ?? {}) as Record<string, unknown>;

      // After score home / respawn, re-force attack for hard
      if (difficulty === "hard" && p.alive) {
        s.mode = "rush";
        s.objective = "attack";
        s.role = "doorSprinter";
        s.campX = undefined;
        s.campZ = undefined;
        s.openPushReadyTick = undefined;
      }

      if (!p.alive) {
        pathStreak.set(r.id, 0);
        continue;
      }

      r.scored = p.score;
      const door = enemyDoorTarget(map, p.team);
      const dist = Math.hypot(door.x - p.x, door.z - p.z);
      r.minDoorDist = Math.min(r.minDoorDist, dist);
      const initDist = Math.hypot(
        door.x - (spawnSeeds.find((s) => s.team === p.team)?.x ?? p.x),
        door.z - (spawnSeeds.find((s) => s.team === p.team)?.z ?? p.z),
      );
      if (initDist > 1) {
        r.maxDoorProgress = Math.max(r.maxDoorProgress, 1 - dist / initDist);
      }

      const stuckWElapsed = typeof s.stuckWElapsed === "number"
        ? s.stuckWElapsed
        : 0;
      const stuckWTurn = typeof s.stuckWTurnTicksLeft === "number"
        ? s.stuckWTurnTicksLeft
        : 0;
      const brainStuck = Math.max(stuckWElapsed, stuckWTurn);
      r.maxBrainStuck = Math.max(r.maxBrainStuck, brainStuck);

      const phase = typeof s.phase === "string" ? s.phase : undefined;
      const mode = typeof s.mode === "string" ? s.mode : undefined;
      const SPAWN_HOLD = difficulty === "easy" ? 2 * TICK_HZ : 1 * TICK_HZ;
      const inSpawnHold = tick - p.spawnedAtTick < SPAWN_HOLD;
      const inLook = phase === "look";
      const holding = mode === "camp" || s.objective === "defend";

      const prev = lastPos.get(r.id) ?? { x: p.x, z: p.z };
      const moved = Math.hypot(p.x - prev.x, p.z - prev.z);
      lastPos.set(r.id, { x: p.x, z: p.z });

      // Pathing stuck: not spawn/look/hold, on ground, not near door, little move
      const nearDoor = dist < 2.0;
      const wantPath = !inSpawnHold && !inLook && !holding && !nearDoor &&
        p.onGround;

      if (wantPath && moved < 0.03) {
        const st = (pathStreak.get(r.id) ?? 0) + 1;
        pathStreak.set(r.id, st);
        r.maxPathStuckStreak = Math.max(r.maxPathStuckStreak, st);
        // Record event at 1.5s of real path stuck
        if (
          st === Math.round(1.5 * TICK_HZ) || st === Math.round(3 * TICK_HZ)
        ) {
          const inf = sampleBotHintInfluence(map, p.team, p.x, p.z);
          // Probe if wall blocks forward toward door
          // yawToward style: atan2(dx, dz) — check nav.ts
          const pathYaw = Math.atan2(door.x - p.x, door.z - p.z);
          const probeX = p.x + Math.sin(pathYaw) * 1.2;
          const probeZ = p.z + Math.cos(pathYaw) * 1.2;
          const kind = collision.classifyProbe(probeX, probeZ);
          r.pathStuckEvents.push({
            tick,
            x: p.x,
            z: p.z,
            brainStuck,
            phase,
            mode,
            objective: typeof s.objective === "string"
              ? s.objective
              : undefined,
            hints: inf.kinds.length ? inf.kinds.join("+") : "(none)",
            forward: true,
            blocked: kind === "solid" || kind === "blocked" || kind === "wall",
          });
        }
      } else {
        pathStreak.set(r.id, 0);
      }

      if (tick % 45 === 0) {
        r.path.push({ t: tick, x: +p.x.toFixed(2), z: +p.z.toFixed(2) });
      }
      r.finalX = p.x;
      r.finalZ = p.z;
    }

    void scores;
    void lastInputForward;
  }

  return results;
}

/** Several spawn corners / mid-spawn positions to exercise routes. */
function spawnVariants(
  map: DoorsMap,
): { team: "A" | "B"; x: number; z: number }[][] {
  const b = map.bounds;
  const pad = 2.5;
  // Team A south-ish, Team B north-ish based on edges
  const aSouth = map.teamA.edge === "south";
  const aZ = aSouth ? b.minZ + pad + 1 : b.maxZ - pad - 1;
  const bZ = aSouth ? b.maxZ - pad - 1 : b.minZ + pad + 1;
  const midX = (b.minX + b.maxX) / 2;
  const span = b.maxX - b.minX;
  // Avoid wall-corner spawns that land on perimeter float corridors.
  const leftX = b.minX + span * 0.3;
  const rightX = b.minX + span * 0.7;

  return [
    // Center spawns
    [
      { team: "A", x: midX, z: aZ },
      { team: "B", x: midX, z: bZ },
    ],
    // Left-ish
    [
      { team: "A", x: leftX, z: aZ },
      { team: "B", x: leftX, z: bZ },
    ],
    // Right-ish
    [
      { team: "A", x: rightX, z: aZ },
      { team: "B", x: rightX, z: bZ },
    ],
    // Off-center
    [
      { team: "A", x: midX + (rightX - midX) * 0.5, z: aZ },
      { team: "B", x: midX - (rightX - midX) * 0.5, z: bZ },
    ],
  ];
}

async function main() {
  const opts = parseArgs(Deno.args);
  const paths = await listMaps(opts.maps);
  console.log(
    `Nav sim: ${paths.length} maps, ${opts.seconds}s door-rush (easy+hard)\n`,
  );

  type Issue = {
    map: string;
    difficulty: string;
    variant: number;
    team: string;
    msg: string;
    sample?: StuckSample;
  };
  const issues: Issue[] = [];

  for (const path of paths) {
    const mapName = path.replace(/^.*\//, "").replace(/\.doors\.json$/, "");
    const map = JSON.parse(await Deno.readTextFile(path)) as DoorsMap;
    const variants = spawnVariants(map);

    for (const diff of ["easy", "hard"] as const) {
      for (let vi = 0; vi < variants.length; vi++) {
        const seeds = variants[vi]!;
        // Reset Math.random for reproducibility per scenario
        let seed =
          (mapName.length * 100 + vi * 10 + (diff === "easy" ? 1 : 2)) >>> 0;
        Math.random = () => {
          seed = (seed + 0x6d2b79f5) >>> 0;
          let t = seed;
          t = Math.imul(t ^ (t >>> 15), 1 | t);
          t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };

        const results = runDoorRush(map, diff, opts.seconds, seeds);
        for (const r of results) {
          const scoredOk = r.scored > 0 || r.minDoorDist < 3;
          const badStuck = r.pathStuckEvents.filter((e) =>
            e.brainStuck >= 12 || e.blocked || e.hints.includes("maze") ||
            e.hints.includes("long") || e.hints.includes("stuck")
          );

          if (!scoredOk) {
            issues.push({
              map: mapName,
              difficulty: diff,
              variant: vi,
              team: r.team,
              msg: `NO-DOOR team ${r.team} scored=${r.scored} minDist=${
                r.minDoorDist.toFixed(1)
              } prog=${(r.maxDoorProgress * 100).toFixed(0)}% final=(${
                r.finalX.toFixed(1)
              },${
                r.finalZ.toFixed(1)
              }) maxBrainStuck=${r.maxBrainStuck} pathStuckStreak=${r.maxPathStuckStreak}`,
            });
          }

          for (const s of badStuck) {
            issues.push({
              map: mapName,
              difficulty: diff,
              variant: vi,
              team: r.team,
              msg: `PATH-STUCK team ${r.team} @ (${s.x.toFixed(1)},${
                s.z.toFixed(1)
              }) t=${s.tick} brainStuck=${s.brainStuck} hints=${s.hints} blocked=${s.blocked} phase=${
                s.phase ?? "-"
              } mode=${s.mode ?? "-"}`,
              sample: s,
            });
          }

          if (opts.verbose) {
            console.log(
              `  ${mapName}/${diff}/v${vi} ${r.team}: score=${r.scored} minDoor=${
                r.minDoorDist.toFixed(1)
              } prog=${
                (r.maxDoorProgress * 100).toFixed(0)
              }% pathStuck=${r.pathStuckEvents.length} maxBrainStuck=${r.maxBrainStuck} final=(${
                r.finalX.toFixed(1)
              },${r.finalZ.toFixed(1)})`,
            );
          }
        }
      }
    }
  }

  // Cluster issues by map + approximate position
  console.log("========== ISSUES ==========");
  const byMap = new Map<string, Issue[]>();
  for (const i of issues) {
    const list = byMap.get(i.map) ?? [];
    list.push(i);
    byMap.set(i.map, list);
  }

  if (issues.length === 0) {
    console.log("All door-rush scenarios clean.");
  } else {
    for (const [map, list] of byMap) {
      console.log(`\n### ${map} (${list.length} issues)`);
      // Dedupe similar messages
      const seen = new Set<string>();
      for (const i of list) {
        const key = i.msg.replace(/t=\d+/g, "t=?").replace(
          /\d+\.\d/g,
          (m) => Number(m).toFixed(0),
        );
        if (seen.has(key)) continue;
        seen.add(key);
        console.log(`  [${i.difficulty}/v${i.variant}] ${i.msg}`);
      }
    }
  }

  console.log(`\nTotal raw issues: ${issues.length}`);
}

if (import.meta.main) await main();
