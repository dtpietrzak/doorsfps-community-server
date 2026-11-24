/**
 * Door opens arrive on the think frame. Collision drops each block once.
 * Nav corners rebuild only when the open set changes. A frame with no list
 * leaves both as loaded.
 */
import { assertEquals } from "@std/assert";
import {
  decodeBotThinkPipelineRequestFrame,
  encodeBotThinkPipelineRequestFrame,
} from "@doors/bot-spec/protocol";
import type {
  BotMapDefinition,
  PlayerSnapshot,
  ThinkBatchInput,
  ThinkFrame,
} from "../model/index.ts";
import { COMMUNITY_BOT_CONFIG } from "../config.ts";
import { runtimeMap } from "../runtime/map.ts";
import { runPublicLookStep } from "../thoughts/publicLook.ts";
import {
  computeWallCorners,
  mapClosureGaps,
} from "../../../shared/world/wallCorners.ts";
import { createBotThinkEngine } from "./batch.ts";

const AUTHORED = { x: 1.25, z: -8.5 };

function roomDefinition(revision: string): BotMapDefinition {
  return {
    id: "room",
    revision,
    formatVersion: 2,
    bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 },
    teamA: { edge: "south", doorHalfWidth: 2.5, spawnRadius: 3 },
    teamB: { edge: "north", doorHalfWidth: 2.5, spawnRadius: 3 },
    walls: [
      { id: "s", ax: 0, az: 0, bx: 6, bz: 0, kind: "full" },
      { id: "e", ax: 6, az: 0, bx: 6, bz: 6, kind: "full" },
      { id: "n", ax: 6, az: 6, bx: 0, bz: 6, kind: "full" },
      { id: "w", ax: 0, az: 6, bx: 0, bz: 0, kind: "full" },
      { id: "stub", ax: 3, az: 0, bx: 3, bz: 2, kind: "full" },
    ],
    wallCorners: [AUTHORED],
    hints: { nudges: [], camps: [], sprints: [], spawns: [], stuck: [] },
    doors: [
      { id: "d", wallId: "n", center: { x: 3, z: 6 }, cost: 500 },
      { id: "side", wallId: "e", center: { x: 6, z: 3 }, cost: 500 },
    ],
    mirrorMode: "zombots",
    spawnCorner: 0,
  };
}

function pawn(id: string): PlayerSnapshot {
  return {
    id,
    kind: "bot",
    team: "A",
    alive: true,
    health: 100,
    score: 0,
    spawnedAtTick: 10,
    x: 1.25,
    y: 1.7,
    z: -8.5,
    velocityX: 0,
    velocityY: 0,
    velocityZ: 0,
    yaw: 0,
    pitch: 0,
    crouch: false,
    onGround: true,
    weapon: {
      id: 1,
      ammoInMagazine: 3,
      spareClips: 2,
      reloading: false,
      lastShotTick: 0,
    },
    skills: [],
  };
}

function input(
  revision: string,
  open: readonly string[] | undefined,
): ThinkBatchInput {
  return {
    frame: {
      tick: 30,
      simDelta: 3,
      mapRevision: revision,
      doorsOpen: true,
      doorChangeTick: 1,
      teamScoreA: 0,
      teamScoreB: 0,
      players: [pawn("pawn")],
      ...(open === undefined ? {} : { openSlidingDoorIds: open }),
    },
    applyTick: 39,
    bots: [{ botId: "pawn", spawnedAtTick: 10 }],
  };
}

type Seen = {
  ids: readonly string[];
  corners: { x: number; z: number }[];
  cornerList: readonly { x: number; z: number }[] | undefined;
};

function expectedCorners(open: readonly string[] | undefined) {
  const map = runtimeMap(roomDefinition("probe"));
  if (open === undefined) return map.wallCorners ?? [];
  return computeWallCorners(
    map.walls,
    map.bounds,
    mapClosureGaps({
      walls: map.walls,
      windows: map.windows,
      doors: map.doors,
      openDoorIds: open,
      bounds: map.bounds,
      mirrorMode: map.mirrorMode,
      teamA: map.teamA,
      teamB: map.teamB,
    }),
  );
}

function openEngine(seen: Seen[]) {
  const engine = createBotThinkEngine({
    hooks: {
      look(ctx, prior, draft, baseMs, varianceMs, rng) {
        seen.push({
          ids: ctx.view.collision.openSlidingDoorIds(),
          corners: (ctx.view.map.wallCorners ?? []).map((point) => ({
            x: point.x,
            z: point.z,
          })),
          cornerList: ctx.view.map.wallCorners,
        });
        return runPublicLookStep(ctx, prior, draft, baseMs, varianceMs, rng);
      },
    },
  });
  engine.synchronizeBots([{
    id: "pawn",
    role: "fill",
    profile: "fill",
    randomSeed: 11,
    config: COMMUNITY_BOT_CONFIG,
  }]);
  return engine;
}

Deno.test("batch applies open sliding doors once and rebuilds corners", () => {
  const sealed = expectedCorners([]);
  const opened = expectedCorners(["d"]);
  assertEquals(sealed.length === opened.length && sealed.every((point, index) =>
    point.x === opened[index]!.x && point.z === opened[index]!.z
  ), false);

  const seen: Seen[] = [];
  const engine = openEngine(seen);
  const rev = "room:1";
  engine.loadMap(roomDefinition(rev));

  engine.thinkBatch(input(rev, undefined));
  assertEquals(seen.length, 1);
  assertEquals(seen[0]!.ids, []);
  assertEquals(seen[0]!.corners, [AUTHORED]);

  engine.thinkBatch(input(rev, undefined));
  assertEquals(seen[1]!.ids, []);
  assertEquals(seen[1]!.corners, [AUTHORED]);
  assertEquals(seen[1]!.cornerList, seen[0]!.cornerList);

  engine.thinkBatch(input(rev, []));
  assertEquals(seen[2]!.ids, []);
  assertEquals(seen[2]!.corners, sealed);

  engine.thinkBatch(input(rev, ["d", "d"]));
  assertEquals(seen[3]!.ids, ["d"]);
  assertEquals(seen[3]!.corners, opened);

  engine.thinkBatch(input(rev, ["d"]));
  assertEquals(seen[4]!.ids, ["d"]);
  assertEquals(seen[4]!.corners, opened);
  assertEquals(seen[4]!.cornerList, seen[3]!.cornerList);

  engine.loadMap(roomDefinition("room:2"));
  engine.thinkBatch(input("room:2", undefined));
  assertEquals(seen[5]!.ids, []);
  assertEquals(seen[5]!.corners, [AUTHORED]);
});

function wireFrame(open: readonly string[] | undefined): ThinkFrame {
  return {
    tick: 3,
    simDelta: 3,
    mapRevision: "m",
    doorsOpen: false,
    doorChangeTick: null,
    teamScoreA: 1,
    teamScoreB: 2,
    players: [pawn("p")],
    ...(open === undefined ? {} : { openSlidingDoorIds: [...open] }),
  };
}

function roundTrip(open: readonly string[] | undefined) {
  const request = {
    type: "pipeline-think-batch" as const,
    requestId: 4,
    input: {
      frame: wireFrame(open),
      applyTick: 9,
      bots: [{ botId: "p", spawnedAtTick: 10 }],
    },
  };
  const bytes = encodeBotThinkPipelineRequestFrame(request);
  const decoded = decodeBotThinkPipelineRequestFrame(bytes);
  assertEquals(encodeBotThinkPipelineRequestFrame(decoded), bytes);
  assertEquals(decoded.type, "pipeline-think-batch");
  if (decoded.type !== "pipeline-think-batch") return decoded;
  return decoded;
}

Deno.test("think frame round trip keeps an absent door list off the wire", () => {
  const absent = roundTrip(undefined);
  if (absent.type !== "pipeline-think-batch") return;
  assertEquals(absent.input.frame.openSlidingDoorIds, undefined);
  assertEquals(absent.input.frame.doorsOpen, false);
  assertEquals(absent.input.applyTick, 9);
  assertEquals(absent.input.bots[0]!.botId, "p");

  const empty = roundTrip([]);
  if (empty.type !== "pipeline-think-batch") return;
  assertEquals(empty.input.frame.openSlidingDoorIds, []);
  assertEquals(empty.input.frame.doorsOpen, false);
  assertEquals(
    encodeBotThinkPipelineRequestFrame({
      type: "pipeline-think-batch",
      requestId: 4,
      input: {
        frame: wireFrame(undefined),
        applyTick: 9,
        bots: [{ botId: "p", spawnedAtTick: 10 }],
      },
    }).every((byte, index) =>
      byte === encodeBotThinkPipelineRequestFrame({
        type: "pipeline-think-batch",
        requestId: 4,
        input: {
          frame: wireFrame([]),
          applyTick: 9,
          bots: [{ botId: "p", spawnedAtTick: 10 }],
        },
      })[index]
    ),
    false,
  );

  const named = roundTrip(["side", "d"]);
  if (named.type !== "pipeline-think-batch") return;
  assertEquals(named.input.frame.openSlidingDoorIds, ["side", "d"]);
  assertEquals(named.input.frame.doorsOpen, false);

  const openDoors = roundTrip(["d"]);
  if (openDoors.type !== "pipeline-think-batch") return;
  const withDoorsOpen = encodeBotThinkPipelineRequestFrame({
    type: "pipeline-think-batch",
    requestId: 4,
    input: {
      frame: { ...wireFrame(["d"]), doorsOpen: true },
      applyTick: 9,
      bots: [{ botId: "p", spawnedAtTick: 10 }],
    },
  });
  const back = decodeBotThinkPipelineRequestFrame(withDoorsOpen);
  assertEquals(back.type, "pipeline-think-batch");
  if (back.type !== "pipeline-think-batch") return;
  assertEquals(back.input.frame.doorsOpen, true);
  assertEquals(back.input.frame.openSlidingDoorIds, ["d"]);
});
