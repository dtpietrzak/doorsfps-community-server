import {
  applyHintMoveYaw,
  listCampHints,
  mixYaw,
  nearestNudgeLine,
  NUDGE_MAX_DIST,
  pointInPolygon,
  sampleBotHintInfluence,
  sampleNudgeStrafe,
  spawnHintYaw,
  STUCK_BLEND,
} from "./hints.ts";
import type { BotHint, DoorsMap } from "../../shared/map.ts";

function miniMap(hints: BotHint[]): DoorsMap {
  return {
    version: 1,
    name: "hint-test",
    bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 },
    gridSize: 1,
    teamA: {
      corners: [0, 1],
      edge: "south",
      doorHalfWidth: 2,
      spawnRadius: 3,
    },
    teamB: {
      corners: [2, 3],
      edge: "north",
      doorHalfWidth: 2,
      spawnRadius: 3,
    },
    walls: [],
    botHints: hints,
  };
}

Deno.test("pointInPolygon: simple square", () => {
  const poly = [
    { x: 0, z: 0 },
    { x: 4, z: 0 },
    { x: 4, z: 4 },
    { x: 0, z: 4 },
  ];
  if (!pointInPolygon({ x: 2, z: 2 }, poly)) {
    throw new Error("center should be inside");
  }
  if (pointInPolygon({ x: 5, z: 2 }, poly)) {
    throw new Error("outside should be false");
  }
});

Deno.test("nearestNudgeLine: closest same-team segment within 5u wins", () => {
  const map = miniMap([
    {
      id: "far-a",
      kind: "nudge",
      team: "A",
      points: [
        { x: -3, z: -10 },
        { x: -3, z: 10 },
      ],
    },
    {
      id: "near-a",
      kind: "nudge",
      team: "A",
      points: [
        { x: 2, z: -10 },
        { x: 2, z: 0 },
        { x: 4, z: 0 },
      ],
    },
    {
      id: "nearer-b",
      kind: "nudge",
      team: "B",
      points: [
        { x: 1.1, z: -10 },
        { x: 1.1, z: 10 },
      ],
    },
  ]);
  const hit = nearestNudgeLine(map, "A", 1, -2);
  if (!hit || hit.hintId !== "near-a" || hit.segmentIndex !== 0) {
    throw new Error(`unexpected nearest Nudge: ${JSON.stringify(hit)}`);
  }
  if (Math.abs(hit.dist - 1) > 1e-6 || hit.point.x !== 2) {
    throw new Error(`unexpected nearest point: ${JSON.stringify(hit)}`);
  }
  if (nearestNudgeLine(map, "A", 2 + NUDGE_MAX_DIST + 0.01, 5)) {
    throw new Error("Nudge must be inactive beyond 5u");
  }
});

Deno.test("sampleNudgeStrafe: resolves literal A/D toward the line", () => {
  const map = miniMap([
    {
      id: "centerline",
      kind: "nudge",
      team: "A",
      points: [
        { x: 2, z: -10 },
        { x: 2, z: 10 },
      ],
    },
  ]);
  // Yaw 0 faces -Z, so player-right is +X.
  if (sampleNudgeStrafe(map, "A", 0, 0, 0)?.dir !== "right") {
    throw new Error("line at +X should press D/right");
  }
  if (sampleNudgeStrafe(map, "A", 4, 0, 0)?.dir !== "left") {
    throw new Error("line at -X should press A/left");
  }
  if (sampleNudgeStrafe(map, "A", 2, 0, 0)?.dir !== "none") {
    throw new Error("bot centered on line should not strafe");
  }
  if (sampleNudgeStrafe(map, "B", 0, 0, 0) !== null) {
    throw new Error("other team must ignore this Nudge");
  }
});

Deno.test("sampleBotHintInfluence: stuck nearest disc", () => {
  const map = miniMap([
    {
      id: "st1",
      kind: "stuck",
      team: "A",
      center: { x: 0, z: 0 },
      radius: 3,
      yaw: 0.5,
    },
    {
      id: "st2",
      kind: "stuck",
      team: "A",
      center: { x: 10, z: 0 },
      radius: 3,
      yaw: 1.2,
    },
  ]);
  const inf = sampleBotHintInfluence(map, "A", 0.2, 0.1);
  if (inf.stuckYaw !== 0.5) throw new Error(`stuck yaw ${inf.stuckYaw}`);
  if (inf.stuckBlend !== STUCK_BLEND) throw new Error("stuck blend");
  const outside = sampleBotHintInfluence(map, "A", 8, 8);
  if (outside.stuckYaw !== undefined) throw new Error("outside disc");
});

Deno.test("applyHintMoveYaw: only stuck discs steer movement yaw", () => {
  const natural = 0;
  const stuck = Math.PI;
  const yaw = applyHintMoveYaw(natural, {
    stuckYaw: stuck,
    stuckBlend: STUCK_BLEND,
    kinds: ["stuck"],
  });
  const expected = mixYaw(natural, stuck, STUCK_BLEND);
  if (Math.abs(yaw - expected) > 1e-6) {
    throw new Error(`got ${yaw} expected ${expected}`);
  }
});

Deno.test("listCampHints + spawnHintYaw", () => {
  const map = miniMap([
    { id: "c", kind: "camp", team: "A", p: { x: 3, z: -8 } },
    {
      id: "sp",
      kind: "spawn",
      team: "A",
      a: { x: -10, z: -18 },
      b: { x: -10, z: -10 },
    },
  ]);
  const camps = listCampHints(map, "A");
  if (camps.length !== 1 || camps[0]!.x !== 3) {
    throw new Error("camp list");
  }
  const yaw = spawnHintYaw(map, "A", -10, -17);
  if (yaw === null) throw new Error("spawn yaw expected");
  if (listCampHints(map, "B").length !== 0) {
    throw new Error("B should have no camps");
  }
});

Deno.test("legacy map without botHints is a no-op", () => {
  const map = miniMap([]);
  delete (map as { botHints?: BotHint[] }).botHints;
  const inf = sampleBotHintInfluence(map, "A", 0, 0);
  if (inf.stuckYaw !== undefined || inf.kinds.length !== 0) {
    throw new Error("empty legacy should be neutral");
  }
  if (nearestNudgeLine(map, "A", 0, 0) !== null) {
    throw new Error("empty legacy should have no Nudge");
  }
});
