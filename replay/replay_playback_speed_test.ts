/**
 * Epic 14.4 — variable playback speed.
 *
 * Run from server-community/:
 *   deno test -A replay/replay_playback_speed_test.ts
 */

import { assertEquals, assertThrows } from "@std/assert";
import {
  DEFAULT_REPLAY_SPEED,
  REPLAY_SPEEDS,
  type ReplaySpeed,
} from "./replayClock.ts";
import {
  armReplaySpeed,
  beginReplaySpeedScrub,
  endReplaySpeedScrub,
  presentReplaySpeed,
  ReplayPlaybackSpeedError,
  replaySpeedLadder,
  type ReplaySpeedScrub,
  stepReplaySpeed,
} from "./replayPlaybackSpeed.ts";

function idle(speed: ReplaySpeed = DEFAULT_REPLAY_SPEED): ReplaySpeedScrub {
  return {
    speed,
    paused: false,
    scrubbing: false,
    pausedBeforeScrub: null,
  };
}

Deno.test("14.4 ladder: rungs are the clock set, in order, with × labels", () => {
  const ladder = replaySpeedLadder();
  assertEquals(ladder.length, REPLAY_SPEEDS.length);
  for (let i = 0; i < REPLAY_SPEEDS.length; i++) {
    assertEquals(ladder[i]!.speed, REPLAY_SPEEDS[i]);
    assertEquals(ladder[i]!.index, i);
    assertEquals(ladder[i]!.label, `${REPLAY_SPEEDS[i]}×`);
  }
  const presented = presentReplaySpeed({
    speed: DEFAULT_REPLAY_SPEED,
    paused: false,
  });
  assertEquals(presented.speed, 1);
  assertEquals(presented.index, REPLAY_SPEEDS.indexOf(1));
  assertEquals(presented.label, "1×");
  assertEquals(presented.paused, false);
  assertEquals(presented.scrubbing, false);
  assertEquals(
    presented.ladder.map((rung) => rung.speed),
    [...REPLAY_SPEEDS],
  );
});

Deno.test("14.4 step: one rung at a time, wrap at the ends", () => {
  assertEquals(stepReplaySpeed(1, 1), 2);
  assertEquals(stepReplaySpeed(2, 1), 4);
  assertEquals(stepReplaySpeed(4, 1), 0.25);
  assertEquals(stepReplaySpeed(1, -1), 0.5);
  assertEquals(stepReplaySpeed(0.5, -1), 0.25);
  assertEquals(stepReplaySpeed(0.25, -1), 4);

  const badStep = assertThrows(
    () => stepReplaySpeed(1, 2),
    ReplayPlaybackSpeedError,
  );
  assertEquals(badStep.code, "replay-speed-bad-step");

  const badSpeed = assertThrows(
    () => stepReplaySpeed(3, 1),
    ReplayPlaybackSpeedError,
  );
  assertEquals(badSpeed.code, "replay-speed-invalid");

  const armed = armReplaySpeed(idle(1), 0.25);
  assertEquals(armed.speed, 0.25);
  assertEquals(armed.paused, false);
  assertEquals(armed.scrubbing, false);
  const rejected = assertThrows(
    () => armReplaySpeed(idle(1), 0),
    ReplayPlaybackSpeedError,
  );
  assertEquals(rejected.code, "replay-speed-invalid");
});

Deno.test("14.4 scrub: pause is remembered, speed is not reset", () => {
  const playing = beginReplaySpeedScrub(idle(2));
  assertEquals(playing.paused, true);
  assertEquals(playing.scrubbing, true);
  assertEquals(playing.speed, 2);
  assertEquals(playing.pausedBeforeScrub, false);

  const again = beginReplaySpeedScrub(playing);
  assertEquals(again.pausedBeforeScrub, false);
  assertEquals(again.speed, 2);

  const faster = armReplaySpeed(again, 4);
  assertEquals(faster.paused, true);
  assertEquals(faster.scrubbing, true);
  assertEquals(faster.pausedBeforeScrub, false);

  const released = endReplaySpeedScrub(faster);
  assertEquals(released.scrubbing, false);
  assertEquals(released.paused, false);
  assertEquals(released.speed, 4);
  assertEquals(released.pausedBeforeScrub, null);

  const wasPaused = beginReplaySpeedScrub({
    speed: 0.5,
    paused: true,
    scrubbing: false,
    pausedBeforeScrub: null,
  });
  assertEquals(wasPaused.pausedBeforeScrub, true);
  const stillPaused = endReplaySpeedScrub(wasPaused);
  assertEquals(stillPaused.paused, true);
  assertEquals(stillPaused.speed, 0.5);

  const idleEnd = endReplaySpeedScrub(idle(1));
  assertEquals(idleEnd.scrubbing, false);
  assertEquals(idleEnd.paused, false);

  const broken = assertThrows(
    () =>
      endReplaySpeedScrub({
        speed: 1,
        paused: true,
        scrubbing: true,
        pausedBeforeScrub: null,
      }),
    ReplayPlaybackSpeedError,
  );
  assertEquals(broken.code, "replay-speed-bad-scrub");
});

Deno.test("14.4 source-scan: presents the clock ladder, does not copy it", async () => {
  const src = await Deno.readTextFile(
    new URL("./replayPlaybackSpeed.ts", import.meta.url),
  );
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (
    const banned of [
      "Date.now",
      "performance.now",
      "requestAnimationFrame",
      "setInterval",
      "setTimeout",
      "createReplayClock",
      ".advance(",
      "resetTo",
      "replayPlaybackSession",
      "replaySimulationRunner",
      "PlayerManager",
      "THREE",
      "document",
      "node:fs",
      "ReplayBlobStore",
      "0.25, 0.5, 1, 2, 4",
      "[0.25",
    ]
  ) {
    assertEquals(
      code.includes(banned),
      false,
      `banned token present: ${banned}`,
    );
  }
  assertEquals(code.includes("REPLAY_SPEEDS"), true);
  assertEquals(code.includes("isReplaySpeed"), true);
  assertEquals(code.includes("DEFAULT_REPLAY_SPEED"), true);
});
