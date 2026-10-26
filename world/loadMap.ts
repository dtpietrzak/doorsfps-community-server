import type { DoorsMap } from "./map.ts";
import { isSupportedMapFormatVersion } from "../shared/world/doorsMapFormat.ts";
import { resolveWallCorners } from "../shared/world/wallCorners.ts";
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
  // Bake nav corners: prefer stored author data, else recompute from walls.
  // Always includes automatic door poles (3 per door, on the door line).
  map.wallCorners = resolveWallCorners(map.walls, map.wallCorners, map.bounds, {
    teamA: map.teamA,
    teamB: map.teamB,
  });
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

const SERVER_MAP_POOLS = ["competitive", "raid"] as const;

async function listDoorMapFiles(dir: string): Promise<string[]> {
  const paths: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.isFile) continue;
    if (!entry.name.endsWith(".doors.json")) continue;
    paths.push(`${dir}/${entry.name}`);
  }
  return paths;
}

export async function listAvailableMapPaths(): Promise<string[]> {
  for (const dir of getMapDirectoryCandidates()) {
    try {
      const top = await listDoorMapFiles(dir);
      if (top.length > 0) {
        top.sort((a, b) => a.localeCompare(b));
        return top;
      }
      // Source tree: maps/competitive and maps/raid. Campaign maps are client-only.
      const pooled: string[] = [];
      for (const pool of SERVER_MAP_POOLS) {
        try {
          pooled.push(...await listDoorMapFiles(`${dir}/${pool}`));
        } catch {
          // that pool is absent
        }
      }
      if (pooled.length > 0) {
        pooled.sort((a, b) => a.localeCompare(b));
        return pooled;
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
