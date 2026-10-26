import type { BotMapDefinition } from "../model/index.ts";
import {
  EDGE_CORNERS,
  MAP_FORMAT_VERSION,
  type BotHint,
  type DoorsMap,
  type TeamSide,
} from "../shared/map.ts";
import { computeWallCorners } from "../../../shared/world/wallCorners.ts";

function side(source: BotMapDefinition["teamA"]): TeamSide {
  const corners = EDGE_CORNERS[source.edge];
  return {
    edge: source.edge,
    corners: [corners[0], corners[1]],
    doorHalfWidth: source.doorHalfWidth,
    spawnRadius: source.spawnRadius,
  };
}

function copyPoints(
  source: readonly { x: number; z: number }[],
): { x: number; z: number }[] {
  const points: { x: number; z: number }[] = [];
  for (let i = 0; i < source.length; i++) {
    const point = source[i]!;
    points.push({ x: point.x, z: point.z });
  }
  return points;
}

/** Convert the compact cache/wire map into the geometry model thoughts use. */
export function runtimeMap(source: BotMapDefinition): DoorsMap {
  const hints: BotHint[] = [];
  const nudges = source.hints.nudges;
  for (let i = 0; i < nudges.length; i++) {
    const hint = nudges[i]!;
    hints.push({
      id: hint.id,
      kind: "nudge",
      team: hint.team,
      points: copyPoints(hint.points),
    });
  }
  const camps = source.hints.camps;
  for (let i = 0; i < camps.length; i++) {
    const hint = camps[i]!;
    hints.push({
      id: hint.id,
      kind: "camp",
      team: hint.team,
      p: { x: hint.point.x, z: hint.point.z },
    });
  }
  const sprints = source.hints.sprints;
  for (let i = 0; i < sprints.length; i++) {
    const hint = sprints[i]!;
    hints.push({
      id: hint.id,
      kind: "sprint",
      team: hint.team,
      polygon: copyPoints(hint.polygon),
    });
  }
  const spawns = source.hints.spawns;
  for (let i = 0; i < spawns.length; i++) {
    const hint = spawns[i]!;
    hints.push({
      id: hint.id,
      kind: "spawn",
      team: hint.team,
      a: { x: hint.start.x, z: hint.start.z },
      b: { x: hint.end.x, z: hint.end.z },
    });
  }
  const stuck = source.hints.stuck;
  for (let i = 0; i < stuck.length; i++) {
    const hint = stuck[i]!;
    hints.push({
      id: hint.id,
      kind: "stuck",
      team: hint.team,
      center: { x: hint.center.x, z: hint.center.z },
      radius: hint.radius,
      yaw: hint.yaw,
    });
  }

  const walls: DoorsMap["walls"] = [];
  for (let i = 0; i < source.walls.length; i++) {
    const wall = source.walls[i]!;
    walls.push({
      id: wall.id,
      a: { x: wall.ax, z: wall.az },
      b: { x: wall.bx, z: wall.bz },
      kind: wall.kind,
    });
  }
  // Maps saved without corners (every campaign map) get them once here, so
  // polesForTeam never rebuilds wall polygons inside a think.
  const wallCorners = source.wallCorners.length > 0
    ? copyPoints(source.wallCorners)
    : computeWallCorners(walls, source.bounds);

  return {
    version: source.formatVersion === 1 ? 1 : MAP_FORMAT_VERSION,
    name: source.id,
    bounds: {
      minX: source.bounds.minX,
      maxX: source.bounds.maxX,
      minZ: source.bounds.minZ,
      maxZ: source.bounds.maxZ,
    },
    gridSize: 1,
    teamA: side(source.teamA),
    teamB: side(source.teamB),
    walls,
    wallCorners,
    botHints: hints,
  };
}

