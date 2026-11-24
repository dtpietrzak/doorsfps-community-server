import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import type { BotMapDefinition } from "../../spec/src/model/index.ts";
import { runtimeMap } from "../runtime/map.ts";
import { MapCollision as ServerCollision } from "../../../world/MapCollision.ts";
import type { DoorsMap } from "../../../world/map.ts";
import { STAND_EYE_HEIGHT } from "../../../shared/sim/playerHitVolumes.ts";
import { MapCollision } from "./MapCollision.ts";
import { PI } from "../math/index.ts";

const DOOR = { id: "d", wallId: "w1", center: { x: 0, z: 0 }, cost: 500 };

function botMap(): BotMapDefinition {
  return {
    id: "door",
    revision: "door:1:00000000",
    formatVersion: 1,
    bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 },
    teamA: { edge: "south", doorHalfWidth: 1.5, spawnRadius: 3 },
    teamB: { edge: "north", doorHalfWidth: 1.5, spawnRadius: 3 },
    walls: [{ id: "w1", ax: -4, az: 0, bx: 4, bz: 0, kind: "full" }],
    wallCorners: [],
    hints: { nudges: [], camps: [], sprints: [], spawns: [], stuck: [] },
    doors: [DOOR],
    mirrorMode: "zombots",
    spawnCorner: 0,
  };
}

function serverMap(): DoorsMap {
  return {
    version: 1,
    name: "door",
    bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 },
    gridSize: 1,
    mirrorMode: "zombots",
    spawnCorner: 0,
    walls: [{ id: "w1", a: { x: -4, z: 0 }, b: { x: 4, z: 0 } }],
    teamA: { corners: [0, 1], edge: "south", doorHalfWidth: 1.5, spawnRadius: 3 },
    teamB: { corners: [2, 3], edge: "north", doorHalfWidth: 1.5, spawnRadius: 3 },
    doors: [DOOR],
  };
}

Deno.test("bot collision opens a sliding door once and probes agree", () => {
  const bot = new MapCollision(runtimeMap(botMap()));
  const eye = { x: 0, y: STAND_EYE_HEIGHT, z: -2 };
  const north = { x: 0, y: 0, z: 1 };
  assertEquals(bot.raycastSolid(eye, north, 6) !== null, true);
  assertEquals(bot.classifyProbe(0, 0), "blocked");

  assertEquals(bot.openSlidingDoor("nope"), false);
  assertEquals(bot.openSlidingDoor("d"), true);
  assertEquals(bot.openSlidingDoor("d"), false);
  assertEquals(bot.isSlidingDoorOpen("d"), true);
  assertEquals(bot.openSlidingDoorIds(), ["d"]);

  assertEquals(bot.raycastSolid(eye, north, 6), null);
  assertEquals(bot.raycastFullSolid(eye, north, 6), null);
  assertEquals(bot.classifyProbe(0, 0), "clear");
  assertEquals(bot.classifyForward(0, -1, PI, 1), "clear");
  assertEquals(
    bot.raycastSolid({ x: 3, y: STAND_EYE_HEIGHT, z: -2 }, north, 6) !== null,
    true,
  );
});

Deno.test("bot and server collision match before and after the door opens", () => {
  const bot = new MapCollision(runtimeMap(botMap()));
  const server = new ServerCollision(serverMap());
  const compare = () => {
    for (let x = -5; x <= 5; x += 0.41) {
      for (let z = -2; z <= 2; z += 0.33) {
        // The two copies already differ by float rounding, so allow noise.
        const a = bot.resolvePosition(x, z);
        const b = server.resolvePosition(x, z);
        assertAlmostEquals(a.x, b.x, 1e-9);
        assertAlmostEquals(a.z, b.z, 1e-9);
        assertEquals(bot.classifyProbe(x, z), server.classifyProbe(x, z));
        const hitA = bot.raycastSolid({ x, y: 1, z: -3 }, { x: 0.05, y: 0, z: 1 }, 8);
        const hitB = server.raycastSolid({ x, y: 1, z: -3 }, { x: 0.05, y: 0, z: 1 }, 8);
        assertEquals(hitA === null, hitB === null);
        if (hitA !== null && hitB !== null) assertAlmostEquals(hitA, hitB, 1e-9);
      }
    }
  };
  bot.doorWalkInEnabled = false;
  server.doorWalkInEnabled = false;
  compare();
  bot.openSlidingDoor("d");
  server.openSlidingDoor("d");
  compare();
});
