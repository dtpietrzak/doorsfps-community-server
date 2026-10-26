/**
 * Epic 16.1 / 16.5 — ranged read on the local blob store.
 *
 * Run from server-community/:
 *   deno test -A replay/replay_blob_range_test.ts
 */

import { assertEquals, assertThrows } from "@std/assert";
import { LocalReplayBlobStore } from "./ReplayBlobStore.ts";

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

Deno.test("16.5 blob read returns a byte window and nothing else", async () => {
  const dir = await Deno.makeTempDir({ prefix: "replay-blob-range-" });
  try {
    const store = new LocalReplayBlobStore(dir);
    const name = "match-range.replay.json";
    const payload = new TextEncoder().encode("abcdefghijklmnopqrstuvwxyz");
    store.put(name, payload);

    assertEquals(text(store.read(name, 0, 4)!), "abcd");
    assertEquals(text(store.read(name, 20, 26)!), "uvwxyz");
    assertEquals(store.read(name, 26, 26)!.byteLength, 0);
    assertEquals(store.read(name, 0, 26)!.byteLength, 26);
    assertEquals(store.read("missing.replay.json", 0, 1), null);
    assertThrows(() => store.read(name, 27, 28));
    assertThrows(() => store.read(name, 4, 2));
    assertThrows(() => store.read("../x.replay.json", 0, 1));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
