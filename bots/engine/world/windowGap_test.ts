import { assertEquals } from "jsr:@std/assert@1";
import type { BotMapDefinition } from "../../spec/src/model/index.ts";
import {
  decodeBotThinkPipelineRequestFrame,
  encodeBotThinkPipelineRequestFrame,
} from "../../spec/src/protocol/pipeline.ts";
import { buildBotMapDefinition } from "../../shadow/frame.ts";
import { runtimeMap } from "../runtime/map.ts";
import { MapCollision as ServerCollision } from "../../../world/MapCollision.ts";
import type { DoorsMap } from "../../../world/map.ts";
import { STAND_EYE_HEIGHT } from "../../../shared/sim/playerHitVolumes.ts";
import { WINDOW_HEAD_Y, WINDOW_SILL_Y } from "../../../shared/world/wallWindows.ts";
import { MapCollision } from "./MapCollision.ts";

function doorsMap(withWindow: boolean): DoorsMap {
  return {
    version: 1,
    name: "gap",
    bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 },
    gridSize: 1,
    walls: [{ id: "w1", a: { x: -4, z: 0 }, b: { x: 4, z: 0 } }],
    teamA: { corners: [0, 1], edge: "south", doorHalfWidth: 1.5, spawnRadius: 3 },
    teamB: { corners: [2, 3], edge: "north", doorHalfWidth: 1.5, spawnRadius: 3 },
    ...(withWindow
      ? { windows: [{ id: "win", wallId: "w1", center: { x: 0, z: 0 } }] }
      : {}),
  };
}

function botMap(withWindow: boolean): BotMapDefinition {
  return {
    id: "gap",
    revision: "gap:1:00000000",
    formatVersion: 1,
    bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 },
    teamA: { edge: "south", doorHalfWidth: 1.5, spawnRadius: 3 },
    teamB: { edge: "north", doorHalfWidth: 1.5, spawnRadius: 3 },
    walls: [{ id: "w1", ax: -4, az: 0, bx: 4, bz: 0, kind: "full" }],
    wallCorners: [],
    hints: {
      nudges: [{ id: "n", team: "A", points: [{ x: 1, z: 2 }] }],
      camps: [],
      sprints: [],
      spawns: [],
      stuck: [],
    },
    ...(withWindow
      ? { windows: [{ id: "win", wallId: "w1", center: { x: 0, z: 0 } }] }
      : {}),
  };
}

Deno.test("bot collision sees the same window the runtime map copied", () => {
  assertEquals(STAND_EYE_HEIGHT > WINDOW_SILL_Y, true);
  assertEquals(STAND_EYE_HEIGHT < WINDOW_HEAD_Y, true);
  const mapped = runtimeMap(botMap(true));
  assertEquals(mapped.windows?.[0]?.center, { x: 0, z: 0 });
  const open = new MapCollision(mapped);
  assertEquals(
    open.raycastSolid({ x: 0, y: STAND_EYE_HEIGHT, z: -2 }, { x: 0, y: 0, z: 1 }, 6),
    null,
  );
  assertEquals(
    open.raycastSolid({ x: 0, y: WINDOW_SILL_Y / 2, z: -2 }, { x: 0, y: 0, z: 1 }, 6) !== null,
    true,
  );
  const closed = runtimeMap(botMap(false));
  assertEquals(closed.windows, undefined);
  assertEquals(
    new MapCollision(closed).raycastSolid(
      { x: 0, y: STAND_EYE_HEIGHT, z: -2 },
      { x: 0, y: 0, z: 1 },
      6,
    ) !== null,
    true,
  );
});

Deno.test("buildBotMapDefinition keeps windows and they change the revision", () => {
  const withWindow = buildBotMapDefinition(new ServerCollision(doorsMap(true)));
  const plain = buildBotMapDefinition(new ServerCollision(doorsMap(false)));
  assertEquals(withWindow.windows, [{ id: "win", wallId: "w1", center: { x: 0, z: 0 } }]);
  assertEquals(plain.windows, undefined);
  assertEquals(withWindow.revision === plain.revision, false);
});

Deno.test("pipeline load-map roundtrips windows and omits them when absent", () => {
  const withWindow = botMap(true);
  const decoded = decodeBotThinkPipelineRequestFrame(
    encodeBotThinkPipelineRequestFrame({
      type: "pipeline-load-map",
      requestId: 7,
      map: withWindow,
    }),
  );
  assertEquals(decoded.type, "pipeline-load-map");
  if (decoded.type !== "pipeline-load-map") return;
  assertEquals(decoded.map.windows, withWindow.windows);
  assertEquals(decoded.map.hints.nudges, withWindow.hints.nudges);

  const plain = botMap(false);
  const empty = { ...plain, windows: [] as const };
  const plainBytes = encodeBotThinkPipelineRequestFrame({
    type: "pipeline-load-map",
    requestId: 7,
    map: plain,
  });
  const emptyBytes = encodeBotThinkPipelineRequestFrame({
    type: "pipeline-load-map",
    requestId: 7,
    map: empty,
  });
  assertEquals(emptyBytes, plainBytes);
  const back = decodeBotThinkPipelineRequestFrame(plainBytes);
  assertEquals(back.type, "pipeline-load-map");
  if (back.type !== "pipeline-load-map") return;
  assertEquals(back.map.windows, undefined);
  assertEquals(back.map.hints.nudges[0]?.id, "n");
});

Deno.test("pipeline load-map roundtrips zombots doors without touching a plain map", () => {
  const zombots: BotMapDefinition = {
    ...botMap(false),
    doors: [{ id: "d", wallId: "w1", center: { x: 0, z: 0 }, cost: 500 }],
    mirrorMode: "zombots",
    spawnCorner: 1,
  };
  const decoded = decodeBotThinkPipelineRequestFrame(
    encodeBotThinkPipelineRequestFrame({
      type: "pipeline-load-map",
      requestId: 3,
      map: zombots,
    }),
  );
  assertEquals(decoded.type, "pipeline-load-map");
  if (decoded.type !== "pipeline-load-map") return;
  assertEquals(decoded.map.doors, zombots.doors);
  assertEquals(decoded.map.mirrorMode, "zombots");
  assertEquals(decoded.map.spawnCorner, 1);
  assertEquals(decoded.map.windows, undefined);

  const doorsOnly: BotMapDefinition = {
    ...botMap(false),
    doors: [{ id: "d", wallId: "w1", center: { x: 1, z: 0 }, cost: 250 }],
  };
  const doorsBack = decodeBotThinkPipelineRequestFrame(
    encodeBotThinkPipelineRequestFrame({
      type: "pipeline-load-map",
      requestId: 3,
      map: doorsOnly,
    }),
  );
  assertEquals(doorsBack.type, "pipeline-load-map");
  if (doorsBack.type !== "pipeline-load-map") return;
  assertEquals(doorsBack.map.doors, doorsOnly.doors);
  assertEquals(doorsBack.map.mirrorMode, undefined);

  const emptyDoors: BotMapDefinition = { ...botMap(false), doors: [] };
  assertEquals(
    encodeBotThinkPipelineRequestFrame({
      type: "pipeline-load-map",
      requestId: 7,
      map: emptyDoors,
    }),
    encodeBotThinkPipelineRequestFrame({
      type: "pipeline-load-map",
      requestId: 7,
      map: botMap(false),
    }),
  );

  const mapped = runtimeMap(zombots);
  assertEquals(mapped.mirrorMode, "zombots");
  assertEquals(mapped.spawnCorner, 1);
  assertEquals(mapped.doors?.[0]?.center, { x: 0, z: 0 });
  assertEquals(mapped.doors?.[0]?.cost, undefined);
  const sealed = new MapCollision(mapped);
  assertEquals(
    sealed.raycastSolid(
      { x: 0, y: STAND_EYE_HEIGHT, z: -18 },
      { x: 0, y: 0, z: -1 },
      6,
    ) !== null,
    true,
  );
  assertEquals(
    sealed.raycastSolid(
      { x: 0, y: STAND_EYE_HEIGHT, z: -2 },
      { x: 0, y: 0, z: 1 },
      6,
    ) !== null,
    true,
  );

  const defined = buildBotMapDefinition(new ServerCollision({
    ...doorsMap(false),
    mirrorMode: "zombots",
    spawnCorner: 1,
    doors: [{ id: "d", wallId: "w1", center: { x: 0, z: 0 } }],
  }));
  assertEquals(defined.mirrorMode, "zombots");
  assertEquals(defined.spawnCorner, 1);
  assertEquals(defined.doors, [{
    id: "d",
    wallId: "w1",
    center: { x: 0, z: 0 },
    cost: 500,
  }]);
  const plain = buildBotMapDefinition(new ServerCollision(doorsMap(false)));
  assertEquals(plain.doors, undefined);
  assertEquals(plain.mirrorMode, undefined);
  assertEquals(defined.revision === plain.revision, false);
});
