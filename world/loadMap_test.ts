import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl } from "@std/path";
import { listAvailableMapPaths } from "./loadMap.ts";

function stem(path: string): string {
  return path.split("/").pop()?.replace(/\.doors\.json$/, "") ?? "";
}

Deno.test("server catalog loads the competitive pool, not campaign", async () => {
  const previous = Deno.cwd();
  const serverRoot = dirname(dirname(fromFileUrl(import.meta.url)));
  Deno.chdir(serverRoot);
  try {
    const names = (await listAvailableMapPaths()).map(stem);
    assert(names.includes("Courtyard"));
    assertEquals(names.some((name) => name.startsWith("Act01-")), false);
    assertEquals(names.includes("Arrival"), false);
    assertEquals(names.some((name) => name.startsWith("TrainingRoom")), false);
  } finally {
    Deno.chdir(previous);
  }
});
