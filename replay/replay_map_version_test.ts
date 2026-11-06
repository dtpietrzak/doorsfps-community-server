/**
 * Epic 17.3 — map version recorded on a replay.
 *
 * Run from server-community/:
 *   deno test -A replay/replay_map_version_test.ts
 */

import { assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import { MAP_FORMAT_VERSION } from "../shared/world/doorsMapFormat.ts";
import { encodeCatalogFixture } from "./replayCatalogFixture.ts";
import { extractReplayCatalog } from "./replayCatalog.ts";
import {
  decodeReplayContainer,
  ReplayEncodingError,
} from "./replayEncoding.ts";
import { replayFormatBumpOwner } from "./replayFormatCatalog.ts";
import {
  classifyReplayMapVersion,
  readReplayContainerMap,
  readReplayContainerMapVersion,
  REPLAY_MAP_VERSION_INVALID,
  REPLAY_MAP_VERSIONS,
  ReplayMapVersionError,
} from "./replayMapVersion.ts";

function rewrite(
  bytes: Uint8Array,
  edit: (doc: Record<string, unknown>) => void,
): Uint8Array {
  const doc = JSON.parse(new TextDecoder().decode(bytes)) as Record<
    string,
    unknown
  >;
  edit(doc);
  return new TextEncoder().encode(JSON.stringify(doc));
}

function mapObjects(doc: Record<string, unknown>): Record<string, unknown>[] {
  const header = doc.header as Record<string, unknown>;
  const initial = doc.initialState as Record<string, unknown>;
  const metadata = initial.metadata as Record<string, unknown>;
  const init = initial.init as Record<string, unknown>;
  return [
    header.map as Record<string, unknown>,
    metadata.map as Record<string, unknown>,
    init.map as Record<string, unknown>,
  ];
}

Deno.test("17.3 stamp: the map schema is its own constant", async () => {
  assertEquals(MAP_FORMAT_VERSION, 2);
  assertEquals(REPLAY_MAP_VERSIONS[0]?.version, 1);
  assertEquals(REPLAY_MAP_VERSIONS[0]?.role, "previous");
  assertEquals(REPLAY_MAP_VERSIONS[1]?.version, MAP_FORMAT_VERSION);
  assertEquals(REPLAY_MAP_VERSIONS[1]?.role, "current");
  assertEquals(replayFormatBumpOwner("map").stamp, "map.version");
  assertEquals(replayFormatBumpOwner("map").bumpsFormatVersion, false);

  const src = await Deno.readTextFile(
    new URL("./replayMapVersion.ts", import.meta.url),
  );
  const code = src
    .split("\n")
    .filter((line) =>
      !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//")
    )
    .join("\n");
  assertEquals(
    /SIMULATION_VERSION|REPLAY_FORMAT_VERSION|GAME_PROTO|buildSha/.test(code),
    false,
  );
  assertEquals(code.includes("MAP_FORMAT_VERSION"), true);
});

Deno.test("17.3 record: a file keeps the map version it was played on", async () => {
  const { bytes } = encodeCatalogFixture();
  const decoded = decodeReplayContainer(bytes);
  assertEquals(decoded.header.map, { name: "encoding-map", version: 1 });
  assertEquals(decoded.initialState.metadata.map.version, 1);
  assertEquals(decoded.initialState.init.map.version, 1);
  assertNotEquals(decoded.header.map.version, MAP_FORMAT_VERSION);
  assertEquals(readReplayContainerMapVersion(decoded), 1);
  assertEquals(readReplayContainerMap(decoded), {
    name: "encoding-map",
    version: 1,
  });
  assertEquals(classifyReplayMapVersion(1), "previous");
  assertEquals(
    classifyReplayMapVersion(1, [
      { version: MAP_FORMAT_VERSION, role: "current" },
    ]),
    "unknown",
  );
  assertEquals(classifyReplayMapVersion(MAP_FORMAT_VERSION), "current");

  const stamp = await extractReplayCatalog(bytes);
  assertEquals(stamp?.mapName, "encoding-map");
  assertEquals(stamp?.mapVersion, "1");
});

Deno.test("17.3 record: the current schema is kept when that is the map's version", () => {
  const { bytes } = encodeCatalogFixture();
  const decoded = decodeReplayContainer(rewrite(bytes, (doc) => {
    for (const map of mapObjects(doc)) map.version = MAP_FORMAT_VERSION;
  }));
  assertEquals(readReplayContainerMap(decoded), {
    name: "encoding-map",
    version: MAP_FORMAT_VERSION,
  });
  assertEquals(classifyReplayMapVersion(decoded.header.map.version), "current");
});

Deno.test("17.3 record: a missing or other schema is not rewritten into the current one", () => {
  assertEquals(classifyReplayMapVersion(undefined), "absent");
  assertEquals(classifyReplayMapVersion(null), "absent");
  assertEquals(classifyReplayMapVersion(99), "unknown");
  assertEquals(classifyReplayMapVersion(0), "unknown");
  assertEquals(classifyReplayMapVersion("2"), "malformed");
  assertEquals(classifyReplayMapVersion(1.5), "malformed");

  const { bytes } = encodeCatalogFixture();
  const unsupported = assertThrows(
    () =>
      decodeReplayContainer(rewrite(bytes, (doc) => {
        for (const map of mapObjects(doc)) map.version = 99;
      })),
    ReplayEncodingError,
  );
  assertEquals(unsupported.code, "replay-unsupported-map");

  assertThrows(() =>
    decodeReplayContainer(rewrite(bytes, (doc) => {
      for (const map of mapObjects(doc)) delete map.version;
    }))
  );
  assertThrows(() =>
    decodeReplayContainer(rewrite(bytes, (doc) => {
      const maps = mapObjects(doc);
      maps[0]!.version = MAP_FORMAT_VERSION;
      maps[1]!.version = 1;
      maps[2]!.version = 1;
    }))
  );
});

Deno.test("17.3 catalog: the writer schema cannot be labeled previous", () => {
  const error = assertThrows(
    () =>
      classifyReplayMapVersion(MAP_FORMAT_VERSION, [
        { version: MAP_FORMAT_VERSION, role: "previous" },
      ]),
    ReplayMapVersionError,
  );
  assertEquals(error.code, REPLAY_MAP_VERSION_INVALID);
});
