/**
 * Epic 16.3 / 16.7 — stable public ids and share paths.
 *
 * Run from server-community/:
 *   deno test -A replay/replay_share_id_test.ts
 */

import { assertEquals } from "@std/assert";
import {
  CLIP_PUBLIC_ID_RE,
  clipApiPath,
  clipWatchPath,
  createClipPublicId,
  createReplayPublicId,
  isClipPublicId,
  isReplayPublicId,
  matchReplayWatchPath,
  REPLAY_PUBLIC_ID_RE,
  replayApiPath,
  replayFilePath,
  replayWatchPath,
} from "../shared/replay/replayShare.ts";

Deno.test("16.3 public ids are unguessable and only match their own kind", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 24; i++) {
    const id = createReplayPublicId();
    assertEquals(REPLAY_PUBLIC_ID_RE.test(id), true);
    assertEquals(id.length, 24);
    assertEquals(isReplayPublicId(id), true);
    assertEquals(isClipPublicId(id), false);
    seen.add(id);
  }
  assertEquals(seen.size, 24);
  const clip = createClipPublicId();
  assertEquals(CLIP_PUBLIC_ID_RE.test(clip), true);
  assertEquals(isClipPublicId(clip), true);
  assertEquals(isReplayPublicId(clip), false);
  assertEquals(isReplayPublicId(`r_${"a".repeat(21)}`), false);
  assertEquals(isReplayPublicId(`r_${"a".repeat(23)}`), false);
});

Deno.test("16.7 share paths match the public id and ignore a trailing slash", () => {
  const replay = createReplayPublicId();
  const clip = createClipPublicId();
  assertEquals(replayWatchPath(replay), `/replay/${replay}`);
  assertEquals(replayApiPath(replay), `/api/replays/s/${replay}`);
  assertEquals(replayFilePath(replay), `/api/replays/s/${replay}/file`);
  assertEquals(clipWatchPath(clip), `/clip/${clip}`);
  assertEquals(clipApiPath(clip), `/api/clips/s/${clip}`);
  assertEquals(matchReplayWatchPath(replayWatchPath(replay)), {
    kind: "replay",
    publicId: replay,
  });
  assertEquals(matchReplayWatchPath(`${replayWatchPath(replay)}/`), {
    kind: "replay",
    publicId: replay,
  });
  assertEquals(matchReplayWatchPath(clipWatchPath(clip)), {
    kind: "clip",
    publicId: clip,
  });
  assertEquals(matchReplayWatchPath(`/replay/${clip}`), null);
  assertEquals(matchReplayWatchPath("/replay/nope"), null);
  assertEquals(matchReplayWatchPath("/watch/" + replay), null);
});
