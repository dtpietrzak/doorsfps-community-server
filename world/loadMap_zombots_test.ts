import { assert, assertEquals, assertRejects } from "@std/assert";
import { dirname, fromFileUrl } from "@std/path";
import { listAvailableMapPaths, loadMapFile } from "./loadMap.ts";
import crossroads from "../maps/competitive/Crossroads.doors.json" with {
  type: "json",
};

function stem(path: string): string {
  return path.split("/").pop()?.replace(/\.doors\.json$/, "") ?? "";
}

async function inServerRoot<T>(fn: () => Promise<T>): Promise<T> {
  const previous = Deno.cwd();
  Deno.chdir(dirname(dirname(fromFileUrl(import.meta.url))));
  try {
    return await fn();
  } finally {
    Deno.chdir(previous);
  }
}

Deno.test("the maps root only exposes competitive and raid, never zombots", async () => {
  await inServerRoot(async () => {
    const names = (await listAvailableMapPaths()).map(stem);
    assertEquals(names.includes("Zombots-01"), false);
    assert(names.includes("Courtyard"));
  });
});

Deno.test("a zombots server takes only zombots maps", async () => {
  await inServerRoot(async () => {
    const names = (await listAvailableMapPaths({ zombots: true })).map(stem);
    assert(names.includes("Zombots-01"));
    assertEquals(names.includes("Courtyard"), false);
  });
});

Deno.test("a flat maps folder mixing pools is filtered by mirrorMode", async () => {
  const dir = await Deno.makeTempDir();
  const previous = Deno.cwd();
  try {
    const zom = {
      ...crossroads,
      mirrorMode: "zombots",
      zombieSpawns: [{ id: "z", p: { x: 0, z: 0 } }],
    };
    await Deno.mkdir(`${dir}/maps`);
    await Deno.writeTextFile(
      `${dir}/maps/Arena.doors.json`,
      JSON.stringify(crossroads),
    );
    await Deno.writeTextFile(
      `${dir}/maps/Undead.doors.json`,
      JSON.stringify(zom),
    );
    Deno.chdir(dir);
    assertEquals((await listAvailableMapPaths()).map(stem), ["Arena"]);
    assertEquals((await listAvailableMapPaths({ zombots: true })).map(stem), [
      "Undead",
    ]);
  } finally {
    Deno.chdir(previous);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a zombots map with no zombieSpawns is rejected, naming the file", async () => {
  const path = await Deno.makeTempFile({ suffix: ".doors.json" });
  try {
    await Deno.writeTextFile(
      path,
      JSON.stringify({ ...crossroads, mirrorMode: "zombots" }),
    );
    await assertRejects(() => loadMapFile(path), Error, path);
  } finally {
    await Deno.remove(path);
  }
});
