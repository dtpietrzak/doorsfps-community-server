/**
 * Epic 14.5 — efficient scrubbing.
 *
 * Run from server-community/:
 *   deno test -A replay/replay_scrub_test.ts
 */

import { assertEquals, assertThrows } from "@std/assert";
import type { AuthoritativeCheckpoint } from "./authoritativeCheckpoint.ts";
import type { ReplayRunner } from "./replaySimulationRunner.ts";
import {
  planReplaySeek,
  type ReplaySeekHooks,
  type ReplaySeekPlan,
} from "./replaySeek.ts";
import {
  executeReplayScrub,
  planReplayScrub,
  replayScrubAnchorTick,
  ReplayScrubError,
} from "./replayScrub.ts";

function checkpointPlan(frameTick: number, target: number): ReplaySeekPlan {
  return {
    targetTick: target,
    anchor: {
      kind: "checkpoint",
      frame: { tick: frameTick } as AuthoritativeCheckpoint,
    },
    stepFrom: frameTick + 1,
    steps: target - frameTick,
  };
}

function initialPlan(firstTick: number, target: number): ReplaySeekPlan {
  return {
    targetTick: target,
    anchor: { kind: "initial" },
    stepFrom: firstTick,
    steps: target - firstTick + 1,
  };
}

function fakeRunner(at: number) {
  let currentTick = at;
  const calls: string[] = [];
  const stepped: number[] = [];
  const runner = {
    get currentTick() {
      return currentTick;
    },
    resetToInitial() {
      calls.push("initial");
      currentTick = 0;
    },
    resetToCheckpoint(frame: AuthoritativeCheckpoint) {
      calls.push(`checkpoint:${frame.tick}`);
      currentTick = frame.tick;
    },
    step(tick: number) {
      if (tick !== currentTick + 1) {
        throw new Error(`step ${tick} after ${currentTick}`);
      }
      currentTick = tick;
      stepped.push(tick);
    },
  };
  return {
    runner: runner as unknown as ReplayRunner,
    calls,
    stepped,
  };
}

const hooks: ReplaySeekHooks = {
  onAnchored() {},
  onStepped() {},
};

Deno.test("14.5 anchor tick is the completed checkpoint or the pre-first tick", () => {
  assertEquals(replayScrubAnchorTick(checkpointPlan(8, 12)), 8);
  assertEquals(replayScrubAnchorTick(initialPlan(1, 6)), 0);
});

Deno.test("14.5 forward inside the gap continues and does not reload", () => {
  const floor = checkpointPlan(8, 12);
  const scrub = planReplayScrub(floor, 10);
  assertEquals(scrub.resumed, true);
  assertEquals(scrub.fromTick, 10);
  assertEquals(scrub.steps, 2);
  assertEquals(scrub.stepFrom, 11);
  assertEquals(scrub.floor, floor);

  const fake = fakeRunner(10);
  executeReplayScrub(fake.runner, scrub, hooks);
  assertEquals(fake.calls, []);
  assertEquals(fake.stepped, [11, 12]);
  assertEquals(fake.runner.currentTick, 12);
});

Deno.test("14.5 sitting on the anchor skips the reload and steps the same gap", () => {
  const floor = checkpointPlan(8, 12);
  const scrub = planReplayScrub(floor, 8);
  assertEquals(scrub.resumed, true);
  assertEquals(scrub.steps, floor.steps);
  const fake = fakeRunner(8);
  executeReplayScrub(fake.runner, scrub, hooks);
  assertEquals(fake.calls, []);
  assertEquals(fake.stepped, [9, 10, 11, 12]);
});

Deno.test("14.5 an already-landed target steps nothing", () => {
  const scrub = planReplayScrub(checkpointPlan(8, 10), 10);
  assertEquals(scrub.resumed, true);
  assertEquals(scrub.steps, 0);
  const fake = fakeRunner(10);
  executeReplayScrub(fake.runner, scrub, hooks);
  assertEquals(fake.calls, []);
  assertEquals(fake.stepped, []);
  assertEquals(fake.runner.currentTick, 10);
});

Deno.test("14.5 backward seeks and cursors before the anchor still load", () => {
  const floor = checkpointPlan(8, 12);

  const backward = planReplayScrub(floor, 14);
  assertEquals(backward.resumed, false);
  assertEquals(backward.steps, floor.steps);
  assertEquals(backward.fromTick, null);
  const rewound = fakeRunner(14);
  executeReplayScrub(rewound.runner, backward, hooks);
  assertEquals(rewound.calls, ["checkpoint:8"]);
  assertEquals(rewound.stepped, [9, 10, 11, 12]);

  const early = planReplayScrub(floor, 3);
  assertEquals(early.resumed, false);
  assertEquals(early.steps, 4);
  const behind = fakeRunner(3);
  executeReplayScrub(behind.runner, early, hooks);
  assertEquals(behind.calls, ["checkpoint:8"]);
  assertEquals(behind.stepped, [9, 10, 11, 12]);
});

Deno.test("14.5 a session without a checkpoint continues from the initial cursor", () => {
  const floor = initialPlan(1, 12);
  const fresh = planReplayScrub(floor, 0);
  assertEquals(fresh.resumed, true);
  assertEquals(fresh.steps, floor.steps);

  const mid = planReplayScrub(floor, 10);
  assertEquals(mid.resumed, true);
  assertEquals(mid.steps, 2);
  const fake = fakeRunner(10);
  executeReplayScrub(fake.runner, mid, hooks);
  assertEquals(fake.calls, []);
  assertEquals(fake.stepped, [11, 12]);

  const backFloor = initialPlan(1, 6);
  const back = planReplayScrub(backFloor, 12);
  assertEquals(back.resumed, false);
  const rewound = fakeRunner(12);
  executeReplayScrub(rewound.runner, back, hooks);
  assertEquals(rewound.calls, ["initial"]);
  assertEquals(rewound.runner.currentTick, 6);
});

Deno.test("14.5 a non-integer cursor and a drifted runner fail loud", () => {
  const floor = checkpointPlan(8, 12);
  const bad = assertThrows(
    () => planReplayScrub(floor, 10.5),
    ReplayScrubError,
  );
  assertEquals(bad.code, "replay-scrub-bad-cursor");

  const scrub = planReplayScrub(floor, 10);
  const drifted = fakeRunner(9);
  const mismatch = assertThrows(
    () => executeReplayScrub(drifted.runner, scrub, hooks),
    ReplayScrubError,
  );
  assertEquals(mismatch.code, "replay-scrub-bad-continue");
  assertEquals(drifted.calls, []);
});

Deno.test("14.5 floor lookup stays one call; scrub does not search again", () => {
  let calls = 0;
  const floor = planReplaySeek(12, 1, 16, () => {
    calls += 1;
    return {
      kind: "hit",
      frame: { tick: 8 } as AuthoritativeCheckpoint,
    };
  });
  const scrub = planReplayScrub(floor, 10);
  assertEquals(calls, 1);
  assertEquals(scrub.resumed, true);
  assertEquals(scrub.steps, 2);
  assertEquals(scrub.floor.anchor.kind, "checkpoint");
});

Deno.test("14.5 source-scan: continuation only, the floor stays in 14.3", async () => {
  const src = await Deno.readTextFile(
    new URL("./replayScrub.ts", import.meta.url),
  );
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (
    const banned of [
      "Date.now",
      "performance.now",
      "requestAnimationFrame",
      "replayClock",
      "replayPlaybackSession",
      "createReplayClock",
      "THREE",
      "document",
      "node:fs",
      "ReplayBlobStore",
      "findPriorOrEqual",
      "CheckpointIndex",
      "new PlayerManager",
      "resetToCheckpoint",
      "resetToInitial",
    ]
  ) {
    assertEquals(
      code.includes(banned),
      false,
      `banned token present: ${banned}`,
    );
  }
  assertEquals(code.includes("executeReplaySeek"), true);
});
