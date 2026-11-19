/**
 * Epic 19.7 — storage capacity.
 *
 * Run from server-community/:
 *   deno test -A --unstable-net --node-modules-dir=manual replay/replay_storage_capacity_test.ts
 */

import { assertEquals, assertThrows } from "@std/assert";
import { summarizeReplaySize, type ReplaySizeSample } from "./replaySize.ts";
import {
  checkReplayStorageCap,
  estimateReplayStorage,
  REPLAY_STORAGE_CAPACITY_INVALID,
  ReplayStorageCapacityError,
  type ReplayStorageBaseline,
  type ReplayStorageVolume,
} from "./replayStorageCapacity.ts";

/** Same number as DEFAULT_REPLAY_TOTAL_SIZE_CAP_BYTES. This module does not import it. */
const STOPGAP_CAP_BYTES = 5 * 1024 * 1024 * 1024;

function baseline(over: Partial<ReplayStorageBaseline> = {}): ReplayStorageBaseline {
  return {
    fileBytes: 3000,
    durationTicks: 3,
    playerCount: 4,
    ...over,
  };
}

function volume(over: Partial<ReplayStorageVolume> = {}): ReplayStorageVolume {
  return { matches: 10, ...over };
}

Deno.test("19.7 the same span and roster is matches times the file", () => {
  const measured = baseline();
  const plan = volume();
  const estimate = estimateReplayStorage(measured, plan);
  assertEquals(estimate, {
    matches: 10,
    durationTicks: 3,
    playerCount: 4,
    bytesPerMatch: 3000,
    requiredBytes: 30_000,
  });
  assertEquals(measured, baseline());
  assertEquals(plan, volume());
});

Deno.test("19.7 a 19.3 level is a baseline and bots are not a second axis", () => {
  const sample: ReplaySizeSample = {
    fileBytes: 3000,
    firstTick: 10,
    lastTick: 12,
    tickRate: 60,
    playerCount: 4,
    botCount: 1,
    eventCount: 6,
    inputRows: 3,
    checkpointCount: 1,
  };
  const level = summarizeReplaySize(sample);
  const estimate = estimateReplayStorage(level, { matches: 10 });
  assertEquals(level.durationTicks, 3);
  assertEquals(estimate.playerCount, 4);
  assertEquals(estimate.bytesPerMatch, 3000);
  assertEquals(estimate.requiredBytes, 30_000);
});

Deno.test("19.7 duration and roster scale the file, and a remainder rounds up", () => {
  assertEquals(
    estimateReplayStorage(baseline(), volume({ durationTicks: 6 })).bytesPerMatch,
    6000,
  );
  assertEquals(
    estimateReplayStorage(baseline(), volume({ durationTicks: 2 })).bytesPerMatch,
    2000,
  );
  assertEquals(
    estimateReplayStorage(baseline({ durationTicks: 3 }), volume({ durationTicks: 2 }))
      .bytesPerMatch,
    2000,
  );
  // 1000 * 2 / 3 rounds up to 667 per match, then the count multiplies.
  const uneven = estimateReplayStorage(
    baseline({ fileBytes: 1000, durationTicks: 3 }),
    volume({ matches: 3, durationTicks: 2 }),
  );
  assertEquals(uneven.bytesPerMatch, 667);
  assertEquals(uneven.requiredBytes, 2001);

  assertEquals(
    estimateReplayStorage(baseline(), volume({ playerCount: 8 })).bytesPerMatch,
    6000,
  );
  // Half the span and twice the roster cancel.
  const both = estimateReplayStorage(
    baseline({ fileBytes: 1000, durationTicks: 10, playerCount: 4 }),
    volume({ durationTicks: 5, playerCount: 8 }),
  );
  assertEquals(both.bytesPerMatch, 1000);
  assertEquals(both.requiredBytes, 10_000);
});

Deno.test("19.7 an empty roster does not scale, and zero matches cost nothing", () => {
  const empty = estimateReplayStorage(
    baseline({ fileBytes: 500, playerCount: 0 }),
    volume({ matches: 4, durationTicks: 6 }),
  );
  assertEquals(empty.playerCount, 0);
  assertEquals(empty.bytesPerMatch, 1000);
  assertEquals(empty.requiredBytes, 4000);

  const none = estimateReplayStorage(baseline(), volume({ matches: 0 }));
  assertEquals(none.bytesPerMatch, 3000);
  assertEquals(none.requiredBytes, 0);

  const zeroFile = estimateReplayStorage(
    baseline({ fileBytes: 0 }),
    volume({ matches: 100, durationTicks: 9, playerCount: 8 }),
  );
  assertEquals(zeroFile.bytesPerMatch, 0);
  assertEquals(zeroFile.requiredBytes, 0);
});

Deno.test("19.7 a cap holds a total at the cap, and counts whole matches", () => {
  const estimate = estimateReplayStorage(baseline(), volume());
  const held = checkReplayStorageCap(estimate, 30_000);
  assertEquals(held.fits, true);
  assertEquals(held.headroomBytes, 0);
  assertEquals(held.overBytes, 0);
  assertEquals(held.matchesAtCap, 10);

  const over = checkReplayStorageCap(estimate, 29_999);
  assertEquals(over.fits, false);
  assertEquals(over.headroomBytes, 0);
  assertEquals(over.overBytes, 1);
  assertEquals(over.matchesAtCap, 9);

  const room = checkReplayStorageCap(estimate, 30_500);
  assertEquals(room.fits, true);
  assertEquals(room.headroomBytes, 500);
  assertEquals(room.matchesAtCap, 10);

  const free = checkReplayStorageCap(
    estimateReplayStorage(baseline({ fileBytes: 0 }), volume()),
    STOPGAP_CAP_BYTES,
  );
  assertEquals(free.fits, true);
  assertEquals(free.matchesAtCap, null);
  assertEquals(free.headroomBytes, STOPGAP_CAP_BYTES);
});

Deno.test("19.7 the 5GB stopgap is a cap argument, not a new policy", () => {
  // A 1-second 8-player file scaled to the default 15-minute span.
  const estimate = estimateReplayStorage(
    { fileBytes: 8_000, durationTicks: 60, playerCount: 8 },
    { matches: 170, durationTicks: 900 * 60 },
  );
  assertEquals(estimate.bytesPerMatch, 7_200_000);
  assertEquals(estimate.requiredBytes, 1_224_000_000);
  const check = checkReplayStorageCap(estimate, STOPGAP_CAP_BYTES);
  assertEquals(check.fits, true);
  assertEquals(check.overBytes, 0);
  assertEquals(check.headroomBytes, STOPGAP_CAP_BYTES - 1_224_000_000);
  assertEquals(check.matchesAtCap, Math.floor(STOPGAP_CAP_BYTES / 7_200_000));
});

Deno.test("19.7 invalid volumes and products throw", () => {
  const cases: Array<[string, () => void]> = [
    ["negative bytes", () => estimateReplayStorage(baseline({ fileBytes: -1 }), volume())],
    ["fractional bytes", () => estimateReplayStorage(baseline({ fileBytes: 1.5 }), volume())],
    ["negative zero", () => estimateReplayStorage(baseline({ fileBytes: -0 }), volume())],
    ["NaN bytes", () => estimateReplayStorage(baseline({ fileBytes: Number.NaN }), volume())],
    ["span 0", () => estimateReplayStorage(baseline({ durationTicks: 0 }), volume())],
    ["volume span 0", () => estimateReplayStorage(baseline(), volume({ durationTicks: 0 }))],
    ["negative matches", () => estimateReplayStorage(baseline(), volume({ matches: -1 }))],
    ["fractional matches", () => estimateReplayStorage(baseline(), volume({ matches: 1.5 }))],
    [
      "grow an empty roster",
      () => estimateReplayStorage(baseline({ playerCount: 0 }), volume({ playerCount: 4 })),
    ],
    [
      "shrink to an empty roster",
      () => estimateReplayStorage(baseline(), volume({ playerCount: 0 })),
    ],
    [
      "product overflow",
      () =>
        estimateReplayStorage(
          baseline({ fileBytes: Number.MAX_SAFE_INTEGER, durationTicks: 1, playerCount: 1 }),
          volume({ matches: 1, durationTicks: 2 }),
        ),
    ],
    [
      "total overflow",
      () =>
        estimateReplayStorage(
          baseline({ fileBytes: Number.MAX_SAFE_INTEGER, durationTicks: 1, playerCount: 1 }),
          volume({ matches: 2 }),
        ),
    ],
    [
      "negative cap",
      () => checkReplayStorageCap(estimateReplayStorage(baseline(), volume()), -1),
    ],
    [
      "fractional cap",
      () => checkReplayStorageCap(estimateReplayStorage(baseline(), volume()), 1.5),
    ],
  ];
  for (const [label, run] of cases) {
    const err = assertThrows(run, ReplayStorageCapacityError, undefined, label);
    assertEquals(err.code, REPLAY_STORAGE_CAPACITY_INVALID, label);
  }
});

Deno.test("19.7 capacity module does not touch a clock, a file, or an encode", async () => {
  const src = await Deno.readTextFile(
    new URL("./replayStorageCapacity.ts", import.meta.url),
  );
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assertEquals(/\bDeno\./.test(code), false);
  assertEquals(/\bperformance\.now\b/.test(code), false);
  assertEquals(/\bJSON\.stringify\s*\(/.test(code), false);
  assertEquals(/\bgzip\b|\bdeflate\b|\bbrotli\b|CompressionStream/.test(code), false);
  assertEquals(/from\s+["']/.test(code), false);
});
