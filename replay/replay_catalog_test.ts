/**
 * Epic 16.2 — catalog fields copied out of a finalized file.
 *
 * Run from server-community/:
 *   deno test -A replay/replay_catalog_test.ts
 */

import { assertEquals } from "@std/assert";
import { GAME_PROTO } from "../shared/net/opcodes.ts";
import { REPLAY_FORMAT_VERSION } from "../shared/replay/replayFormatVersion.ts";
import { encodeCatalogFixture } from "./replayCatalogFixture.ts";
import { extractReplayCatalog, sha256Hex } from "./replayCatalog.ts";
import { decodeReplayContainer } from "./replayEncoding.ts";
import { isFilledReplayIndex } from "./replayIndex.ts";

Deno.test("16.2 catalog: searchable fields, checksum stays out of the file", async () => {
  const { container, bytes } = encodeCatalogFixture({ rosterName: "café" });
  const stamp = await extractReplayCatalog(bytes);
  if (!stamp) throw new Error("catalog was null");

  assertEquals(stamp.mapName, "encoding-map");
  assertEquals(stamp.mapVersion, "1");
  assertEquals(stamp.gameMode, "standard");
  assertEquals(stamp.firstTick, container.header.firstTick);
  assertEquals(stamp.lastTick, container.header.lastTick);
  assertEquals(
    stamp.durationTicks,
    container.header.lastTick - container.header.firstTick + 1,
  );
  assertEquals(stamp.roster, [
    { id: "p1", name: "café", team: "A", isBot: false },
  ]);
  assertEquals(stamp.teams.scores, { A: 0, B: 0 });
  assertEquals(stamp.teams.ids, ["A"]);
  assertEquals(stamp.gameProto, GAME_PROTO);
  assertEquals(stamp.replayFormatVersion, REPLAY_FORMAT_VERSION);
  assertEquals(stamp.buildSha, "cafebabe");
  assertEquals(stamp.checksum, await sha256Hex(bytes));
  assertEquals(stamp.checksum.length, 64);
  assertEquals(stamp.index, null);
  assertEquals(stamp.byteMap?.fileSizeBytes, bytes.byteLength);

  const text = new TextDecoder().decode(bytes);
  assertEquals(text.includes(stamp.checksum), false);
  assertEquals(text.includes("byteOffset"), false);
  assertEquals(decodeReplayContainer(bytes).integrity.digest, null);
});

Deno.test("16.2 catalog: a filled index is stored, an empty one is not", async () => {
  const { container, bytes } = encodeCatalogFixture({ filledIndex: true });
  const stamp = await extractReplayCatalog(bytes);
  if (!stamp?.index) throw new Error("filled index was dropped");
  assertEquals(isFilledReplayIndex(container.index), true);
  assertEquals(stamp.index, container.index);
});

Deno.test("16.2 catalog: bytes that are not a container yield null", async () => {
  const junk = new TextEncoder().encode('{"ok":true}');
  assertEquals(await extractReplayCatalog(junk), null);
});
