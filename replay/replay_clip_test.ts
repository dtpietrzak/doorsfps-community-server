/**
 * Epic 15.1 — clip definition.
 *
 * Run from server-community/:
 *   deno test -A replay/replay_clip_test.ts
 */

import { assertEquals, assertThrows } from "@std/assert";
import { TICK_MS } from "../shared/sim/game.ts";
import { tickToTimeMs, tickToTimeSec } from "./checkpointIndex.ts";
import type { KillcamWindow } from "./killcam.ts";
import { REPLAY_SPEEDS } from "./replayClock.ts";
import {
  defaultReplayClipCameraSettings,
  defineReplayClip,
  ReplayClipError,
  replayClipFromKillcamWindow,
} from "./replayClip.ts";
import {
  DEFAULT_SPECTATOR_CAMERA_MODE,
  SPECTATOR_CAMERA_MODES,
} from "./spectatorSelection.ts";

const base = {
  replayId: "replay-1",
  startTick: 10,
  endTick: 20,
  cameraMode: "third-person" as const,
  playerId: "h1",
};

Deno.test("15.1 define: ticks are canonical and times are derived", () => {
  const clip = defineReplayClip({ ...base, playbackSpeed: 2 });
  assertEquals(clip.replayId, "replay-1");
  assertEquals(clip.startTick, 10);
  assertEquals(clip.endTick, 20);
  assertEquals(clip.startTimeMs, tickToTimeMs(10));
  assertEquals(clip.endTimeMs, tickToTimeMs(20));
  assertEquals(clip.startTimeSec, tickToTimeSec(10));
  assertEquals(clip.endTimeSec, tickToTimeSec(20));
  assertEquals(clip.durationMs, tickToTimeMs(11));
  assertEquals(clip.durationSec, tickToTimeSec(11));
  assertEquals(clip.cameraMode, "third-person");
  assertEquals(clip.playerId, "h1");
  assertEquals(clip.playbackSpeed, 2);
  assertEquals(clip.cameraSettings, defaultReplayClipCameraSettings());
});

Deno.test("15.1 define: one tick is one tick of duration, speed defaults to 1", () => {
  const clip = defineReplayClip({
    ...base,
    startTick: 4,
    endTick: 4,
    cameraMode: "free",
  });
  assertEquals(clip.durationMs, TICK_MS);
  assertEquals(clip.playbackSpeed, 1);
  assertEquals(clip.cameraMode, "free");
});

Deno.test("15.1 define: every landed camera mode and speed is accepted", () => {
  for (const cameraMode of SPECTATOR_CAMERA_MODES) {
    assertEquals(
      defineReplayClip({ ...base, cameraMode }).cameraMode,
      cameraMode,
    );
  }
  for (const playbackSpeed of REPLAY_SPEEDS) {
    assertEquals(
      defineReplayClip({ ...base, playbackSpeed }).playbackSpeed,
      playbackSpeed,
    );
  }
  assertEquals(DEFAULT_SPECTATOR_CAMERA_MODE, "first-person");
});

Deno.test("15.1 define: bad id, range, camera, speed, and settings fail loud", () => {
  const badId = assertThrows(
    () => defineReplayClip({ ...base, replayId: "  " }),
    ReplayClipError,
  );
  assertEquals(badId.code, "replay-clip-bad-id");

  const badPlayer = assertThrows(
    () => defineReplayClip({ ...base, playerId: "" }),
    ReplayClipError,
  );
  assertEquals(badPlayer.code, "replay-clip-bad-player");

  const badTick = assertThrows(
    () => defineReplayClip({ ...base, startTick: 1.5 }),
    ReplayClipError,
  );
  assertEquals(badTick.code, "replay-clip-bad-tick");

  const inverted = assertThrows(
    () => defineReplayClip({ ...base, startTick: 8, endTick: 3 }),
    ReplayClipError,
  );
  assertEquals(inverted.code, "replay-clip-bad-range");

  const badCamera = assertThrows(
    () => defineReplayClip({ ...base, cameraMode: "orbit" as "free" }),
    ReplayClipError,
  );
  assertEquals(badCamera.code, "replay-clip-bad-camera");

  const badSpeed = assertThrows(
    () => defineReplayClip({ ...base, playbackSpeed: 3 as 1 }),
    ReplayClipError,
  );
  assertEquals(badSpeed.code, "replay-clip-bad-speed");

  const badSettings = assertThrows(
    () =>
      defineReplayClip({
        ...base,
        cameraSettings: { version: 1, boom: 2 } as { version: 1 },
      }),
    ReplayClipError,
  );
  assertEquals(badSettings.code, "replay-clip-bad-settings");
});

Deno.test("15.1 killcam window: start and end ticks are stored unchanged", () => {
  const window: KillcamWindow = {
    startTick: 9,
    deathTick: 12,
    endTick: 14,
  };
  const clip = replayClipFromKillcamWindow({
    replayId: "replay-9",
    window,
    playerId: "b1",
  });
  assertEquals(clip.startTick, window.startTick);
  assertEquals(clip.endTick, window.endTick);
  assertEquals(clip.cameraMode, "first-person");
  assertEquals(clip.playbackSpeed, 1);
  assertEquals(clip.playerId, "b1");
  assertEquals("deathTick" in clip, false);

  const third = replayClipFromKillcamWindow({
    replayId: "replay-9",
    window,
    playerId: "b1",
    cameraMode: "third-person",
    playbackSpeed: 0.5,
  });
  assertEquals(third.cameraMode, "third-person");
  assertEquals(third.playbackSpeed, 0.5);
  assertEquals(third.startTick, 9);
  assertEquals(third.endTick, 14);
});

Deno.test("15.1 source-scan: definition only, no playback or storage", async () => {
  const src = await Deno.readTextFile(
    new URL("./replayClip.ts", import.meta.url),
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
      "PlayerManager",
      "THREE",
      "document",
      "node:fs",
      "ReplayBlobStore",
      "sqlite",
      "killcamPlayback",
    ]
  ) {
    assertEquals(
      code.includes(banned),
      false,
      `banned token present: ${banned}`,
    );
  }
  assertEquals(code.includes("SPECTATOR_CAMERA_MODES"), true);
  assertEquals(code.includes("isReplaySpeed"), true);
  assertEquals(code.includes("tickToTimeMs"), true);
});
