import { assert, assertEquals } from "@std/assert";
import { loadMapFile } from "../../world/loadMap.ts";
import { MOVE_STAND_EYE } from "../sim/moveStep.ts";
import {
  buildWindowCrawlPortals,
  pickWindowCrawlVariant,
  sampleWindowCrawlPose,
  stepWindowCrawl,
  tryStartWindowCrawl,
  WINDOW_CRAWL_EXIT_DEPTH,
  WINDOW_CRAWL_TICKS,
  type WindowCrawlVariant,
} from "./windowCrawl.ts";

const MAP_PATH = new URL(
  "../../maps/zombots/Zombots-01.doors.json",
  import.meta.url,
).pathname;

Deno.test("pickWindowCrawlVariant deterministically spans all 3 variants", () => {
  const seen = new Set<WindowCrawlVariant>();
  for (let i = 0; i < 60; i++) {
    const v = pickWindowCrawlVariant(`z:${i}`, i * 7, "win-1");
    assert(v === 1 || v === 2 || v === 3);
    assertEquals(v, pickWindowCrawlVariant(`z:${i}`, i * 7, "win-1"));
    seen.add(v);
  }
  assertEquals(seen.size, 3);
});

Deno.test("Zombots-01 portals are one-way (outside to inside only)", async () => {
  const map = await loadMapFile(MAP_PATH);
  const portals = buildWindowCrawlPortals(map);
  assert(portals.length > 0);
  const p = portals[0]!;
  assertEquals(p.twoWay, false);

  // Outside approaching inward triggers crawl.
  const outsidePos = {
    x: p.centerX + p.outX * 0.8,
    z: p.centerZ + p.outZ * 0.8,
  };
  const inward = { x: -p.outX, z: -p.outZ };
  const started = tryStartWindowCrawl(portals, outsidePos, inward, "z1", 42);
  assert(started !== null);
  assert(started.variant === 1 || started.variant === 2 || started.variant === 3);

  // Inside pushing outward does NOT trigger crawl.
  const insidePos = {
    x: p.centerX - p.outX * 0.8,
    z: p.centerZ - p.outZ * 0.8,
  };
  const outward = { x: p.outX, z: p.outZ };
  assertEquals(
    tryStartWindowCrawl(portals, insidePos, outward, "z1", 42),
    null,
  );

  // Stepping the crawl finishes cleanly on the inside floor.
  let last = sampleWindowCrawlPose(started, 0);
  assertEquals(last.feetLift, 0);
  let maxLift = 0;
  let done = false;
  for (let i = 0; i < WINDOW_CRAWL_TICKS; i++) {
    const res = stepWindowCrawl(started);
    last = res.pose;
    maxLift = Math.max(maxLift, res.pose.feetLift);
    done = res.done;
  }
  assertEquals(done, true);
  assert(maxLift > 0.25, `expected sill lift during crawl, got ${maxLift}`);
  assertEquals(last.feetLift, 0);
  assertEquals(last.y, MOVE_STAND_EYE);
  assertEquals(last.onGround, true);
  const endDepth = (last.x - p.centerX) * p.outX +
    (last.z - p.centerZ) * p.outZ;
  assert(
    Math.abs(endDepth + WINDOW_CRAWL_EXIT_DEPTH) < 1e-6,
    `expected inside landing at -${WINDOW_CRAWL_EXIT_DEPTH}, got ${endDepth}`,
  );
});
