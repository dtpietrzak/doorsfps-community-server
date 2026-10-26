/**
 * Epic 15.5 — clip permissions.
 *
 * Run from server-community/:
 *   deno test -A replay/replay_clip_permission_test.ts
 */

import { assertEquals, assertThrows } from "@std/assert";
import { ReplayClipError } from "./replayClip.ts";
import {
  DEFAULT_REPLAY_CLIP_VISIBILITY,
  isReplayClipAudience,
  isReplayClipVisibility,
  REPLAY_CLIP_AUDIENCES,
  REPLAY_CLIP_VISIBILITIES,
  type ReplayClipAudience,
  replayClipPermission,
  type ReplayClipVisibility,
} from "./replayClipPermission.ts";

Deno.test("15.5 states follow the note order and default to private", () => {
  assertEquals([...REPLAY_CLIP_VISIBILITIES], [
    "public",
    "unlisted",
    "private",
    "deleted",
  ]);
  assertEquals([...REPLAY_CLIP_AUDIENCES], ["owner", "link", "catalog"]);
  assertEquals(DEFAULT_REPLAY_CLIP_VISIBILITY, "private");
  assertEquals(isReplayClipVisibility("private"), true);
  assertEquals(isReplayClipVisibility("secret"), false);
  assertEquals(isReplayClipVisibility(" public"), false);
  assertEquals(isReplayClipVisibility("Public"), false);
  assertEquals(isReplayClipAudience("link"), true);
  assertEquals(isReplayClipAudience("user"), false);
});

Deno.test("15.5 permission: catalog is public-only; readable follows the audience", () => {
  const cases: ReadonlyArray<
    readonly [ReplayClipVisibility, ReplayClipAudience, boolean, boolean]
  > = [
    ["public", "owner", true, true],
    ["public", "link", true, true],
    ["public", "catalog", true, true],
    ["unlisted", "owner", false, true],
    ["unlisted", "link", false, true],
    ["unlisted", "catalog", false, false],
    ["private", "owner", false, true],
    ["private", "link", false, false],
    ["private", "catalog", false, false],
    ["deleted", "owner", false, false],
    ["deleted", "link", false, false],
    ["deleted", "catalog", false, false],
  ];
  for (const [visibility, audience, catalog, readable] of cases) {
    assertEquals(replayClipPermission(visibility, audience), {
      visibility,
      catalog,
      readable,
    });
  }
});

Deno.test("15.5 invalid visibility throws before the audience is checked", () => {
  const badVisibility = assertThrows(
    () => replayClipPermission("secret", "nope"),
    ReplayClipError,
  );
  assertEquals(badVisibility.code, "replay-clip-bad-visibility");

  const badAudience = assertThrows(
    () => replayClipPermission("private", "friend"),
    ReplayClipError,
  );
  assertEquals(badAudience.code, "replay-clip-bad-audience");
});

Deno.test("15.5 source-scan: states only, no store or playback", async () => {
  const src = await Deno.readTextFile(
    new URL("./replayClipPermission.ts", import.meta.url),
  );
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (
    const banned of [
      "sqlite",
      "ReplayBlobStore",
      "node:fs",
      "defineReplayClip",
      "createReplayPlayback",
      "Date.now",
    ]
  ) {
    assertEquals(
      code.includes(banned),
      false,
      `banned token present: ${banned}`,
    );
  }
  assertEquals(code.includes("REPLAY_CLIP_VISIBILITIES"), true);
  assertEquals(code.includes("isReplayClipVisibility"), true);
  assertEquals(code.includes("replayClipPermission"), true);
});
