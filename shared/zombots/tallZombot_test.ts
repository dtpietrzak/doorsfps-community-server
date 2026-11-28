import { assertAlmostEquals, assertEquals } from "@std/assert";
import {
  isTallZombotId,
  tallZombotPacePhase,
  tallZombotSpeedFactor,
} from "./tallZombot.ts";
import { ZOMBOTS_TUNING } from "./zombotsTuning.ts";

Deno.test("isTallZombotId matches only tall zombot ids", () => {
  assertEquals(isTallZombotId("bot:zombie-tall-17"), true);
  assertEquals(isTallZombotId("bot:zombie-17"), false);
  assertEquals(isTallZombotId("bot:zombie-grandpa-7"), false);
  assertEquals(isTallZombotId("player-1"), false);
});

Deno.test("tallZombotPacePhase cycles 5.75s walk -> 1.0s sprint -> 0.75s pause every 7.5s", () => {
  const {
    tallWalkSpeedMultiplier,
    tallSprintSpeedMultiplier,
    tallCycleMs,
    tallSprintDurationMs,
    tallPauseDurationMs,
  } = ZOMBOTS_TUNING.zombie;
  assertEquals(tallCycleMs, 7_500);
  assertEquals(tallSprintDurationMs, 1_000);
  assertEquals(tallPauseDurationMs, 750);

  const walkMs = tallCycleMs - tallSprintDurationMs - tallPauseDurationMs; // 5750
  const sprintEndMs = walkMs + tallSprintDurationMs; // 6750

  // Cycle 0
  assertEquals(tallZombotPacePhase(0), "walk");
  assertEquals(tallZombotPacePhase(walkMs - 1), "walk");
  assertEquals(tallZombotPacePhase(walkMs), "sprint");
  assertEquals(tallZombotPacePhase(sprintEndMs - 1), "sprint");
  assertEquals(tallZombotPacePhase(sprintEndMs), "pause");
  assertEquals(tallZombotPacePhase(tallCycleMs - 1), "pause");

  // Cycle 1 wraps cleanly
  assertEquals(tallZombotPacePhase(tallCycleMs), "walk");
  assertEquals(tallZombotPacePhase(tallCycleMs + walkMs), "sprint");
  assertEquals(tallZombotPacePhase(tallCycleMs + sprintEndMs), "pause");

  // Speed factors relative to base walk speed (0.85x)
  assertEquals(tallZombotSpeedFactor(0), 1);
  assertAlmostEquals(
    tallZombotSpeedFactor(walkMs) * tallWalkSpeedMultiplier,
    tallSprintSpeedMultiplier,
    1e-9,
  );
  assertEquals(tallZombotSpeedFactor(sprintEndMs), 0);
});
