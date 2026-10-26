/**
 * Epic 15.2 — clip creation.
 *
 * Run from server-community/:
 *   deno test -A replay/replay_clip_create_test.ts
 */

import { assertEquals, assertThrows } from "@std/assert";
import { TICK_MS } from "../shared/sim/game.ts";
import { tickToTimeMs } from "./checkpointIndex.ts";
import { defineReplayClip, ReplayClipError } from "./replayClip.ts";
import {
  createReplayClip,
  type ReplayClipSpan,
  resolveReplayClipTime,
} from "./replayClipCreate.ts";

const span: ReplayClipSpan = { firstTick: 1, lastTick: 16 };

const base = {
  replayId: "replay-1",
  playerId: "h1",
  cameraMode: "third-person" as const,
  span,
  startTimeMs: tickToTimeMs(10),
  endTimeMs: tickToTimeMs(12),
};

Deno.test("15.2 create: times floor onto ticks and the clip stores tick instants", () => {
  const startTimeMs = tickToTimeMs(10) + TICK_MS / 2;
  const endTimeMs = tickToTimeMs(12) + TICK_MS / 2;
  const clip = createReplayClip({
    ...base,
    startTimeMs,
    endTimeMs,
    playbackSpeed: 2,
  });
  const direct = defineReplayClip({
    replayId: "replay-1",
    playerId: "h1",
    cameraMode: "third-person",
    playbackSpeed: 2,
    startTick: 10,
    endTick: 12,
  });
  assertEquals(clip, direct);
  assertEquals(clip.startTimeMs, tickToTimeMs(10));
  assertEquals(clip.endTimeMs, tickToTimeMs(12));
  assertEquals(clip.startTimeMs === startTimeMs, false);
});

Deno.test("15.2 create: duration end lands on lastTick and matches the clock span", () => {
  const clip = createReplayClip({
    ...base,
    startTimeMs: tickToTimeMs(span.firstTick),
    endTimeMs: tickToTimeMs(span.firstTick) +
      tickToTimeMs(span.lastTick - span.firstTick + 1),
  });
  assertEquals(clip.startTick, span.firstTick);
  assertEquals(clip.endTick, span.lastTick);
  assertEquals(clip.endTimeMs, tickToTimeMs(span.lastTick));
  assertEquals(
    clip.durationMs,
    tickToTimeMs(span.lastTick - span.firstTick + 1),
  );
  assertEquals(
    resolveReplayClipTime(tickToTimeMs(span.lastTick + 1), span),
    span.lastTick,
  );
});

Deno.test("15.2 create: one tick when both marks floor onto the same tick", () => {
  const clip = createReplayClip({
    ...base,
    cameraMode: "free",
    startTimeMs: tickToTimeMs(4) + 1,
    endTimeMs: tickToTimeMs(5) - 0.001,
  });
  assertEquals(clip.startTick, 4);
  assertEquals(clip.endTick, 4);
  assertEquals(clip.durationMs, TICK_MS);
  assertEquals(clip.playbackSpeed, 1);
  assertEquals(clip.cameraMode, "free");
});

Deno.test("15.2 create: outside, inverted, and bad span fail loud and do not clamp", () => {
  const before = assertThrows(
    () => resolveReplayClipTime(tickToTimeMs(span.firstTick - 1), span),
    ReplayClipError,
  );
  assertEquals(before.code, "replay-clip-outside-span");

  const negative = assertThrows(
    () => resolveReplayClipTime(-1, span),
    ReplayClipError,
  );
  assertEquals(negative.code, "replay-clip-outside-span");

  const past = assertThrows(
    () =>
      resolveReplayClipTime(
        tickToTimeMs(span.lastTick + 1) + TICK_MS / 2,
        span,
      ),
    ReplayClipError,
  );
  assertEquals(past.code, "replay-clip-outside-span");

  const nan = assertThrows(
    () => createReplayClip({ ...base, endTimeMs: Number.NaN }),
    ReplayClipError,
  );
  assertEquals(nan.code, "replay-clip-bad-time");

  const infinite = assertThrows(
    () => createReplayClip({ ...base, startTimeMs: Number.POSITIVE_INFINITY }),
    ReplayClipError,
  );
  assertEquals(infinite.code, "replay-clip-bad-time");

  const inverted = assertThrows(
    () =>
      createReplayClip({
        ...base,
        startTimeMs: tickToTimeMs(12),
        endTimeMs: tickToTimeMs(8),
      }),
    ReplayClipError,
  );
  assertEquals(inverted.code, "replay-clip-bad-range");

  const badSpan = assertThrows(
    () => resolveReplayClipTime(tickToTimeMs(4), { firstTick: 8, lastTick: 3 }),
    ReplayClipError,
  );
  assertEquals(badSpan.code, "replay-clip-bad-span");

  const fractionalSpan = assertThrows(
    () =>
      resolveReplayClipTime(tickToTimeMs(4), {
        firstTick: 1.5,
        lastTick: 4,
      }),
    ReplayClipError,
  );
  assertEquals(fractionalSpan.code, "replay-clip-bad-span");
});

Deno.test("15.2 create: 15.1 still rejects a bad camera and a blank id", () => {
  const badCamera = assertThrows(
    () => createReplayClip({ ...base, cameraMode: "orbit" as "free" }),
    ReplayClipError,
  );
  assertEquals(badCamera.code, "replay-clip-bad-camera");

  const badId = assertThrows(
    () => createReplayClip({ ...base, replayId: "  " }),
    ReplayClipError,
  );
  assertEquals(badId.code, "replay-clip-bad-id");
});

Deno.test("15.2 source-scan: times in, 15.1 out, no seek clamp or storage", async () => {
  const src = await Deno.readTextFile(
    new URL("./replayClipCreate.ts", import.meta.url),
  );
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (
    const banned of [
      "Date.now",
      "performance.now",
      "requestAnimationFrame",
      "replayPlaybackSession",
      "replaySimulationRunner",
      "createReplayClock",
      "executeReplaySeek",
      "resolveReplaySeekTick",
      "Math.floor",
      "PlayerManager",
      "THREE",
      "document",
      "node:fs",
      "ReplayBlobStore",
      "sqlite",
      "killcamPlayback",
      "KillcamWindow",
      "loadReplay",
    ]
  ) {
    assertEquals(
      code.includes(banned),
      false,
      `banned token present: ${banned}`,
    );
  }
  assertEquals(code.includes("timeMsToTick"), true);
  assertEquals(code.includes("tickToTimeMs"), true);
  assertEquals(code.includes("defineReplayClip"), true);
});
