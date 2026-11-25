import { assertEquals } from "@std/assert";
import {
  DISTRACTOR_LURE_OFFSET,
  distractorCostForUses,
  distractorLurePoint,
  DistractorTracker,
  type DistractorActivateInput,
} from "./distractorRack.ts";
import { ZOMBOTS_TUNING } from "./zombotsTuning.ts";

function makeInput(
  over: Partial<DistractorActivateInput> = {},
): DistractorActivateInput & { spent: number[] } {
  const spent: number[] = [];
  return {
    rackId: "rack-d1",
    rackCenter: { x: 0, z: 0 },
    lurePoint: { x: 1, z: 0 },
    eye: { x: 1, z: 0 },
    isDowned: false,
    tick: 100,
    durationTicks: 3600,
    trySpend: (cost) => {
      spent.push(cost);
      return { ok: true };
    },
    ...over,
    spent,
  };
}

Deno.test("dis-rack-tor tuning: 2000 base, +500 per use, 60s duration", () => {
  assertEquals(ZOMBOTS_TUNING.racks.distractorBaseCost, 2000);
  assertEquals(ZOMBOTS_TUNING.racks.distractorCostStep, 500);
  assertEquals(ZOMBOTS_TUNING.racks.distractorDurationMs, 60_000);
  assertEquals(distractorCostForUses(0), 2000);
  assertEquals(distractorCostForUses(1), 2500);
  assertEquals(distractorCostForUses(2), 3000);
  assertEquals(distractorCostForUses(-3), 2000);
});

Deno.test("cost escalates by 500 on each activation after expiry", () => {
  const tracker = new DistractorTracker();
  assertEquals(tracker.uses, 0);
  assertEquals(tracker.nextCost, 2000);

  const first = makeInput({ tick: 100, durationTicks: 3600 });
  assertEquals(tracker.tryActivate(first), {
    kind: "ok",
    cost: 2000,
    rackId: "rack-d1",
    point: { x: 1, z: 0 },
    endsAtTick: 3700,
    uses: 1,
  });
  assertEquals(first.spent, [2000]);
  assertEquals(tracker.uses, 1);
  assertEquals(tracker.nextCost, 2500);
  assertEquals(tracker.isActive(3699), true);
  assertEquals(tracker.isActive(3700), false);

  // Refused while still active, without debiting the purse.
  const during = makeInput({ tick: 2000 });
  assertEquals(tracker.tryActivate(during), {
    kind: "refused",
    reason: "alreadyActive",
  });
  assertEquals(during.spent, []);
  assertEquals(tracker.uses, 1);

  // Expire at tick 3700, then second activation costs 2500.
  assertEquals(tracker.expire(3699), false);
  assertEquals(tracker.expire(3700), true);
  assertEquals(tracker.expire(3701), false);

  const second = makeInput({ tick: 3700, durationTicks: 3600 });
  assertEquals(tracker.tryActivate(second), {
    kind: "ok",
    cost: 2500,
    rackId: "rack-d1",
    point: { x: 1, z: 0 },
    endsAtTick: 7300,
    uses: 2,
  });
  assertEquals(second.spent, [2500]);
  assertEquals(tracker.nextCost, 3000);
});

Deno.test("refusals (downed, outOfReach, notEnough) do not increment uses", () => {
  const tracker = new DistractorTracker();
  const downed = makeInput({ isDowned: true });
  assertEquals(tracker.tryActivate(downed), { kind: "refused", reason: "downed" });

  const far = makeInput({ eye: { x: ZOMBOTS_TUNING.racks.reach + 0.1, z: 0 } });
  assertEquals(tracker.tryActivate(far), { kind: "refused", reason: "outOfReach" });
  assertEquals([...downed.spent, ...far.spent], []);

  const broke = makeInput({
    trySpend: (cost) => {
      broke.spent.push(cost);
      return { ok: false };
    },
  });
  assertEquals(tracker.tryActivate(broke), { kind: "refused", reason: "notEnough" });
  assertEquals(broke.spent, [2000]);
  assertEquals(tracker.uses, 0);
  assertEquals(tracker.nextCost, 2000);
  assertEquals(tracker.isActive(100), false);
});

Deno.test("distractorLurePoint offsets off the wall along the rack facing normal", () => {
  assertEquals(
    distractorLurePoint({ x: 5, z: -2 }, { x: 0, z: 1 }),
    { x: 5, z: -2 + DISTRACTOR_LURE_OFFSET },
  );
  assertEquals(
    distractorLurePoint({ x: 5, z: -2 }, null),
    { x: 5, z: -2 },
  );
});
