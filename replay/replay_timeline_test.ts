/**
 * Epic 14.1 — replay timeline.
 *
 * Run from server-community/:
 *   deno test -A replay/replay_timeline_test.ts
 */

import { assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import { TICK_MS } from "../shared/sim/game.ts";
import {
  tickToTimeMs,
  tickToTimeSec,
  timeMsToTick,
} from "./checkpointIndex.ts";
import { createReplayClock } from "./replayClock.ts";
import { replayTimeline, ReplayTimelineError } from "./replayTimeline.ts";

function viewOf(clock: {
  firstTick: number;
  lastTick: number;
  currentTick: number;
  carryMs: number;
  isEnded: boolean;
}) {
  return replayTimeline({
    firstTick: clock.firstTick,
    lastTick: clock.lastTick,
    currentTick: clock.currentTick,
    carryMs: clock.carryMs,
    isEnded: clock.isEnded,
  });
}

Deno.test("14.1 span: start, end, and duration match the clock", () => {
  const firstTick = 10;
  const lastTick = 18;
  const clock = createReplayClock({ firstTick, lastTick });
  const view = viewOf(clock);

  assertEquals(view.start.tick, firstTick);
  assertEquals(view.start.timeMs, tickToTimeMs(firstTick));
  assertEquals(view.start.timeSec, tickToTimeSec(firstTick));
  assertEquals(view.end.tick, lastTick);
  assertEquals(view.end.timeMs, tickToTimeMs(lastTick));
  assertEquals(view.end.timeSec, tickToTimeSec(lastTick));
  assertEquals(view.durationMs, clock.durationMs);
  assertEquals(view.durationMs, tickToTimeMs(lastTick - firstTick + 1));
  assertEquals(view.durationSec, tickToTimeSec(lastTick - firstTick + 1));
  // Right edge of the span is one tick past the end tick's instant.
  assertEquals(view.start.timeMs + view.durationMs, tickToTimeMs(lastTick + 1));
  assertEquals(view.position.tick, firstTick);
  assertEquals(view.position.fraction, 0);
  assertEquals(view.position.elapsedMs, 0);
  assertEquals(view.progress, 0);
  assertEquals(view.isEnded, false);
});

Deno.test("14.1 position: carry moves the playhead inside the current tick", () => {
  const clock = createReplayClock({ firstTick: 10, lastTick: 18 });
  clock.advance(TICK_MS * 0.5);

  const beforeTick = clock.currentTick;
  const beforeCarry = clock.carryMs;
  const view = viewOf(clock);

  assertEquals(clock.currentTick, beforeTick);
  assertEquals(clock.carryMs, beforeCarry);
  assertEquals(view.position.tick, 10);
  assertAlmostEquals(view.position.fraction, 0.5, 1e-9);
  assertAlmostEquals(
    view.position.presentedMs,
    tickToTimeMs(10) + TICK_MS * 0.5,
    1e-9,
  );
  assertAlmostEquals(view.position.elapsedMs, TICK_MS * 0.5, 1e-9);
  assertEquals(timeMsToTick(view.position.presentedMs), view.position.tick);
  assertAlmostEquals(view.progress, 0.5 / (18 - 10), 1e-9);
});

Deno.test("14.1 position: completed ticks advance the playhead, pause clears carry", () => {
  const clock = createReplayClock({ firstTick: 10, lastTick: 18 });
  clock.advance(TICK_MS);
  let view = viewOf(clock);
  assertEquals(view.position.tick, 10);
  assertEquals(view.position.fraction, 0);
  assertEquals(view.isEnded, false);

  clock.advance(TICK_MS);
  view = viewOf(clock);
  assertEquals(view.position.tick, 11);
  assertAlmostEquals(view.progress, 1 / 8, 1e-9);
  assertEquals(view.position.elapsedMs, tickToTimeMs(1));

  clock.advance(TICK_MS * 0.25);
  clock.pause();
  clock.advance(TICK_MS * 5);
  view = viewOf(clock);
  assertEquals(view.position.tick, 11);
  assertEquals(view.position.fraction, 0);
  assertEquals(clock.isPaused, true);
});

Deno.test("14.1 end: progress is 1 on the last tick and the cursor stays there", () => {
  const firstTick = 10;
  const lastTick = 18;
  const clock = createReplayClock({ firstTick, lastTick });
  while (!clock.isEnded) clock.advance(TICK_MS);

  const cursor = clock.currentTick;
  const view = viewOf(clock);
  viewOf(clock);

  assertEquals(clock.currentTick, cursor);
  assertEquals(view.isEnded, true);
  assertEquals(view.progress, 1);
  assertEquals(view.position.tick, lastTick);
  assertEquals(view.position.fraction, 0);
  assertEquals(view.position.elapsedMs, tickToTimeMs(lastTick - firstTick));
  assertEquals(view.durationMs, tickToTimeMs(lastTick - firstTick + 1));
  assertEquals(clock.carryMs, 0);
});

Deno.test("14.1 single tick: fraction until the tick ends, then progress 1", () => {
  const clock = createReplayClock({ firstTick: 5, lastTick: 5 });
  clock.advance(TICK_MS * 0.4);
  let view = viewOf(clock);
  assertEquals(view.isEnded, false);
  assertEquals(view.position.tick, 5);
  assertAlmostEquals(view.progress, 0.4, 1e-9);
  assertEquals(view.durationMs, TICK_MS);

  clock.advance(TICK_MS);
  view = viewOf(clock);
  assertEquals(view.isEnded, true);
  assertEquals(view.progress, 1);
  assertEquals(view.position.fraction, 0);
  assertEquals(view.position.elapsedMs, 0);
});

Deno.test("14.1 rejects a cursor it would have to invent", () => {
  const badTick = assertThrows(
    () => replayTimeline({ firstTick: 1.5, lastTick: 4, currentTick: 2 }),
    ReplayTimelineError,
  );
  assertEquals(badTick.code, "replay-timeline-bad-tick");

  const badRange = assertThrows(
    () => replayTimeline({ firstTick: 8, lastTick: 3, currentTick: 3 }),
    ReplayTimelineError,
  );
  assertEquals(badRange.code, "replay-timeline-bad-range");

  const outside = assertThrows(
    () => replayTimeline({ firstTick: 1, lastTick: 4, currentTick: 0 }),
    ReplayTimelineError,
  );
  assertEquals(outside.code, "replay-timeline-bad-position");

  const carry = assertThrows(
    () =>
      replayTimeline({
        firstTick: 1,
        lastTick: 4,
        currentTick: 2,
        carryMs: TICK_MS,
      }),
    ReplayTimelineError,
  );
  assertEquals(carry.code, "replay-timeline-bad-carry");

  const endedEarly = assertThrows(
    () =>
      replayTimeline({
        firstTick: 1,
        lastTick: 4,
        currentTick: 2,
        isEnded: true,
      }),
    ReplayTimelineError,
  );
  assertEquals(endedEarly.code, "replay-timeline-bad-ended");

  const onEnd = assertThrows(
    () =>
      replayTimeline({
        firstTick: 1,
        lastTick: 4,
        currentTick: 4,
        isEnded: false,
      }),
    ReplayTimelineError,
  );
  assertEquals(onEnd.code, "replay-timeline-bad-ended");
});

Deno.test("14.1 source-scan: presentation only, no clock or sim imports", async () => {
  const src = await Deno.readTextFile(
    new URL("./replayTimeline.ts", import.meta.url),
  );
  for (
    const banned of [
      "Date.now",
      "performance.now",
      "requestAnimationFrame",
      "setInterval",
      "setTimeout",
      "replayClock",
      "replaySimulationRunner",
      "replayLoader",
      "replayPlaybackSession",
      "GameLoop.ts",
      "PlayerManager",
      "BotManager",
      "Deno.",
      "node:fs",
      "ReplayBlobStore",
      "createStore",
      'from "../net/',
      "findPriorCheckpoint",
      "loadCheckpointState",
    ]
  ) {
    assertEquals(
      src.includes(banned),
      false,
      `banned token present: ${banned}`,
    );
  }
  assertEquals(src.includes("tickToTimeMs"), true);
  assertEquals(src.includes("tickToTimeSec"), true);
});
