import { assertEquals } from "@std/assert";
import { loadMapFile } from "./loadMap.ts";
import crossroads from "../maps/competitive/Crossroads.doors.json" with { type: "json" };

async function loadWith(patch: Record<string, unknown>) {
  const path = await Deno.makeTempFile({ suffix: ".doors.json" });
  try {
    await Deno.writeTextFile(path, JSON.stringify({ ...crossroads, ...patch }));
    return await loadMapFile(path);
  } finally {
    await Deno.remove(path);
  }
}

Deno.test("loader keeps good zombots racks and drops the rest", async () => {
  const wall = { id: "rackWall", a: { x: -4, z: 0 }, b: { x: 4, z: 0 } };
  const map = await loadWith({
    mirrorMode: "zombots",
    zombieSpawns: [{ id: "z1", p: { x: 0, z: 0 } }],
    walls: [...crossroads.walls, wall],
    gunRacks: [
      { id: "r1", wallId: "rackWall", center: { x: 1, z: 0 }, weapon: "pistol" },
      { id: "r2", wallId: "missing", center: { x: 1, z: 0 }, weapon: "rifle" },
    ],
  });
  assertEquals(map.gunRacks, [
    { id: "r1", wallId: "rackWall", center: { x: 1, z: 0 }, weapon: "pistol" },
  ]);
});

Deno.test("loader strips racks from a non-zombots map", async () => {
  const map = await loadWith({
    gunRacks: [{ id: "r1", wallId: crossroads.walls[0]!.id, center: { x: 0, z: 0 }, weapon: "pistol" }],
  });
  assertEquals(map.gunRacks, undefined);
});
