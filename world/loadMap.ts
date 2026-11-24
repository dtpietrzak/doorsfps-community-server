import type { DoorsMap } from "./map.ts";
import { isSupportedMapFormatVersion } from "../shared/world/doorsMapFormat.ts";
import {
  mapClosureGaps,
  resolveWallCorners,
} from "../shared/world/wallCorners.ts";
import { normalizeGunRacks } from "../shared/world/gunRacks.ts";
import { MapCollision } from "./MapCollision.ts";
import defaultMapJson from "../maps/competitive/Crossroads.doors.json" with {
  type: "json",
};

function parseMap(data: unknown, label: string): DoorsMap {
  const map = data as DoorsMap;
  if (!map || !isSupportedMapFormatVersion(map.version)) {
    throw new Error(`Invalid map (${label}): unsupported version`);
  }
  if (!map.bounds || !map.teamA || !map.teamB || !Array.isArray(map.walls)) {
    throw new Error(`Invalid map (${label}): missing fields`);
  }
  // ZombotsMatch emits no zombies without spawns, so wave 1 would never clear.
  if (map.mirrorMode === "zombots" && !(map.zombieSpawns?.length)) {
    throw new Error(
      `Invalid map (${label}): zombots map needs at least one zombieSpawns entry`,
    );
  }
  // Bad racks are dropped, not fatal: the rest of the map still plays.
  const gunRacks = normalizeGunRacks(map);
  if (gunRacks.length > 0) map.gunRacks = gunRacks;
  else delete map.gunRacks;
  // Bake nav corners: prefer stored author data, else recompute from walls.
  // Always includes automatic door poles (3 per door, on the door line).
  map.wallCorners = resolveWallCorners(
    map.walls,
    map.wallCorners,
    map.bounds,
    {
      teamA: map.teamA,
      teamB: map.teamB,
    },
    mapClosureGaps(map),
  );
  return map;
}

export interface MapBundle {
  map: DoorsMap;
  collision: MapCollision;
  path: string;
}

/** Resolve a map path relative to CWD / executable / server folder. */
export async function loadMapFile(path: string): Promise<DoorsMap> {
  const text = await Deno.readTextFile(path);
  return parseMap(JSON.parse(text), path);
}

export async function loadMapBundle(path: string): Promise<MapBundle> {
  const map = await loadMapFile(path);
  return { map, collision: new MapCollision(map), path };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function tryExecutableDirMapsPath(): string | undefined {
  try {
    const executable = Deno.execPath();
    const executableDir = executable.replace(/[/\\][^/\\]*$/, "");
    return `${executableDir}/maps`;
  } catch {
    return undefined;
  }
}

/** Find map directories in priority order for dev and compiled builds. */
export function getMapDirectoryCandidates(): string[] {
  return unique([
    "./maps",
    tryExecutableDirMapsPath() ?? "",
    "./server-community/maps",
    "./server/maps",
  ].filter((v) => v.length > 0));
}

// Arena/raid pools only. maps/zombots is never read through the maps root, so
// a raid runtime (which links the root) cannot pick up zombots maps.
const SERVER_MAP_POOLS = ["competitive", "raid"] as const;
const ZOMBOTS_MAP_POOLS = ["zombots"] as const;

export interface MapListOptions {
  /** True on a zombots server: take only zombots maps. Default false. */
  zombots?: boolean;
}

async function listDoorMapFiles(dir: string): Promise<string[]> {
  const paths: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.isFile) continue;
    if (!entry.name.endsWith(".doors.json")) continue;
    paths.push(`${dir}/${entry.name}`);
  }
  return paths;
}

/** Zombots maps only play on a zombots server, and it takes nothing else. */
export function mapFitsServerKind(
  mirrorMode: string | undefined,
  zombots: boolean,
): boolean {
  return (mirrorMode === "zombots") === zombots;
}

async function filterByServerKind(
  paths: string[],
  zombots: boolean,
): Promise<string[]> {
  const kept: string[] = [];
  for (const path of paths) {
    try {
      const raw = JSON.parse(await Deno.readTextFile(path)) as {
        mirrorMode?: string;
      };
      if (mapFitsServerKind(raw?.mirrorMode, zombots)) kept.push(path);
    } catch {
      // Unreadable: keep it so the loader reports the real error.
      kept.push(path);
    }
  }
  return kept;
}

export async function listAvailableMapPaths(
  options: MapListOptions = {},
): Promise<string[]> {
  const zombots = options.zombots === true;
  for (const dir of getMapDirectoryCandidates()) {
    try {
      // Flat folder (compiled / downloadable): may mix pools, so filter.
      const top = await filterByServerKind(
        await listDoorMapFiles(dir),
        zombots,
      );
      if (top.length > 0) {
        top.sort((a, b) => a.localeCompare(b));
        return top;
      }
      // Source tree: maps/competitive + maps/raid, or maps/zombots.
      // Campaign maps are client-only.
      const pooled: string[] = [];
      for (const pool of zombots ? ZOMBOTS_MAP_POOLS : SERVER_MAP_POOLS) {
        try {
          pooled.push(...await listDoorMapFiles(`${dir}/${pool}`));
        } catch {
          // that pool is absent
        }
      }
      const kept = await filterByServerKind(pooled, zombots);
      if (kept.length > 0) {
        kept.sort((a, b) => a.localeCompare(b));
        return kept;
      }
    } catch {
      // try next candidate directory
    }
  }
  return [];
}

/** Built-in Crossroads map (works even when compiled with no maps/ folder). */
export function loadEmbeddedDefaultMap(): DoorsMap {
  return parseMap(defaultMapJson, "embedded default");
}

export async function loadDefaultMap(mapPath?: string): Promise<{
  map: DoorsMap;
  collision: MapCollision;
  path: string;
}> {
  const candidates = [
    mapPath,
    Deno.env.get("MAP_PATH") ?? undefined,
    "./maps/default.doors.json",
    // next to the executable when run after compile
    "./default.doors.json",
  ].filter(Boolean) as string[];

  for (const p of candidates) {
    try {
      return await loadMapBundle(p);
    } catch {
      // try next
    }
  }

  // Always available fallback for deno compile
  const map = loadEmbeddedDefaultMap();
  return { map, collision: new MapCollision(map), path: "(embedded default)" };
}
