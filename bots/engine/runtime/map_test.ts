import { assert, assertEquals } from "@std/assert";
import { computeWallCorners } from "../../../shared/world/wallCorners.ts";
import { courtyardProbeMapDefinition } from "../world/courtyardProbeMap.ts";
import { runtimeMap } from "./map.ts";

Deno.test("runtimeMap keeps stored wall corners", () => {
  const source = courtyardProbeMapDefinition();
  assert(source.wallCorners.length > 0);
  assertEquals(runtimeMap(source).wallCorners, source.wallCorners);
});

Deno.test("runtimeMap computes corners once for a map saved without them", () => {
  const source = { ...courtyardProbeMapDefinition(), wallCorners: [] };
  const map = runtimeMap(source);
  assert(map.wallCorners !== undefined && map.wallCorners.length > 0);
  assertEquals(map.wallCorners, computeWallCorners(map.walls, map.bounds));
});
