import { assertEquals } from "@std/assert";
import { ReviveTracker, type RevivePressContext } from "./revive.ts";
import { ZompointsLedger } from "./zompoints.ts";
import { ZOMBOTS_TUNING } from "./zombotsTuning.ts";

const PRESSES = ZOMBOTS_TUNING.revive.presses;
const COST = ZOMBOTS_TUNING.revive.costPerPress;
const HEALTH = ZOMBOTS_TUNING.revive.healthFraction;

type Body = { alive: boolean; downed: boolean };

function fund(ledger: ZompointsLedger, playerId: string, atLeast: number): void {
  ledger.join(playerId);
  let spins = 0;
  while (ledger.get(playerId) < atLeast) {
    ledger.award(playerId, "kill");
    if (++spins > 1000) throw new Error("purse did not grow");
  }
}

function ctx(
  ledger: ZompointsLedger,
  bodies: Record<string, Body>,
  inReach: boolean,
  spent?: number[],
): RevivePressContext {
  return {
    isAlive: (id) => bodies[id]?.alive ?? false,
    isDowned: (id) => bodies[id]?.downed ?? false,
    inReach,
    trySpend: (id, cost) => {
      spent?.push(cost);
      return ledger.trySpend(id, cost, "revivePress").ok;
    },
  };
}

Deno.test("a revive is exactly 20 presses and costs 200", () => {
  assertEquals(PRESSES, 20);
  assertEquals(COST, 10);
  assertEquals(PRESSES * COST, 200);
  assertEquals(HEALTH, 0.5);

  const ledger = new ZompointsLedger();
  const total = PRESSES * COST;
  fund(ledger, "a", total);
  const before = ledger.get("a");
  const bodies: Record<string, Body> = {
    a: { alive: true, downed: false },
    t: { alive: true, downed: true },
  };
  const spent: number[] = [];
  const tracker = new ReviveTracker();
  tracker.observeLook("a", "t");

  for (let n = 1; n < PRESSES; n++) {
    assertEquals(tracker.press("a", ctx(ledger, bodies, true, spent)), {
      kind: "progress",
      presses: n,
    });
  }
  // health is a fraction of max HP; the glue multiplies.
  assertEquals(tracker.press("a", ctx(ledger, bodies, true, spent)), {
    kind: "revived",
    targetId: "t",
    health: HEALTH,
    intent: { kind: "playerRevived", playerId: "t", by: "a", health: HEALTH },
  });
  assertEquals(spent, Array.from({ length: PRESSES }, () => COST));
  assertEquals(ledger.get("a"), before - total);
  assertEquals(tracker.progress("a"), null);
});

Deno.test("a press the reviver cannot afford is refused and does not reset", () => {
  assertEquals(ZOMBOTS_TUNING.points.start < PRESSES * COST, true);
  const ledger = new ZompointsLedger();
  ledger.join("a");
  const affordable = Math.floor(ledger.get("a") / COST);
  const bodies: Record<string, Body> = {
    a: { alive: true, downed: false },
    t: { alive: true, downed: true },
  };
  const tracker = new ReviveTracker();
  tracker.observeLook("a", "t");
  for (let n = 0; n < affordable; n++) {
    tracker.press("a", ctx(ledger, bodies, true));
  }
  assertEquals(ledger.get("a"), ZOMBOTS_TUNING.points.start - affordable * COST);
  const purse = ledger.get("a");
  assertEquals(tracker.press("a", ctx(ledger, bodies, true)), {
    kind: "refused",
    reason: "cantAfford",
  });
  assertEquals(ledger.get("a"), purse);
  assertEquals(tracker.progress("a"), { targetId: "t", presses: affordable });

  ledger.award("a", "kill");
  assertEquals(tracker.press("a", ctx(ledger, bodies, true)), {
    kind: "progress",
    presses: affordable + 1,
  });
});

Deno.test("looking away resets the count and does not refund", () => {
  const ledger = new ZompointsLedger();
  fund(ledger, "a", 4 * COST);
  const start = ledger.get("a");
  const bodies: Record<string, Body> = {
    a: { alive: true, downed: false },
    t: { alive: true, downed: true },
    u: { alive: true, downed: true },
  };
  const tracker = new ReviveTracker();
  tracker.observeLook("a", "t");
  tracker.press("a", ctx(ledger, bodies, true));
  tracker.press("a", ctx(ledger, bodies, true));
  tracker.press("a", ctx(ledger, bodies, true));
  const purse = ledger.get("a");
  assertEquals(purse, start - 3 * COST);

  tracker.observeLook("a", null);
  assertEquals(tracker.progress("a"), null);
  assertEquals(ledger.get("a"), purse);
  assertEquals(tracker.press("a", ctx(ledger, bodies, true)), {
    kind: "refused",
    reason: "noTarget",
  });

  tracker.observeLook("a", "t");
  assertEquals(tracker.progress("a"), { targetId: "t", presses: 0 });
  assertEquals(tracker.press("a", ctx(ledger, bodies, true)), {
    kind: "progress",
    presses: 1,
  });
  const afterRestart = ledger.get("a");

  tracker.observeLook("a", "u");
  assertEquals(tracker.progress("a"), { targetId: "u", presses: 0 });
  assertEquals(ledger.get("a"), afterRestart);
});

Deno.test("idle looks at the same target never time out", () => {
  const ledger = new ZompointsLedger();
  fund(ledger, "a", 3 * COST);
  const bodies: Record<string, Body> = {
    a: { alive: true, downed: false },
    t: { alive: true, downed: true },
  };
  const tracker = new ReviveTracker();
  tracker.observeLook("a", "t");
  tracker.press("a", ctx(ledger, bodies, true));
  tracker.press("a", ctx(ledger, bodies, true));
  const purse = ledger.get("a");
  const held = tracker.progress("a");
  for (let i = 0; i < 3000; i++) tracker.observeLook("a", "t");
  assertEquals(tracker.progress("a"), held);
  assertEquals(ledger.get("a"), purse);
  assertEquals(tracker.press("a", ctx(ledger, bodies, true)), {
    kind: "progress",
    presses: 3,
  });
});

Deno.test("a living player and a downed reviver are refused", () => {
  const ledger = new ZompointsLedger();
  ledger.join("a");
  const bodies: Record<string, Body> = {
    a: { alive: true, downed: false },
    t: { alive: true, downed: false },
  };
  const tracker = new ReviveTracker();
  tracker.observeLook("a", "t");
  const spent: number[] = [];
  assertEquals(tracker.press("a", ctx(ledger, bodies, true, spent)), {
    kind: "refused",
    reason: "notDowned",
  });
  assertEquals(spent, []);
  assertEquals(ledger.get("a"), ZOMBOTS_TUNING.points.start);
  assertEquals(tracker.progress("a"), { targetId: "t", presses: 0 });

  // Standing player looking at themselves is not downed.
  tracker.observeLook("a", "a");
  assertEquals(tracker.press("a", ctx(ledger, bodies, true, spent)), {
    kind: "refused",
    reason: "notDowned",
  });

  bodies.a = { alive: true, downed: true };
  bodies.t = { alive: true, downed: true };
  tracker.observeLook("a", "t");
  assertEquals(tracker.press("a", ctx(ledger, bodies, true, spent)), {
    kind: "refused",
    reason: "reviverDown",
  });
  assertEquals(spent, []);
  assertEquals(ledger.get("a"), ZOMBOTS_TUNING.points.start);

  bodies.a = { alive: false, downed: false };
  assertEquals(tracker.press("a", ctx(ledger, bodies, true, spent)), {
    kind: "refused",
    reason: "reviverDown",
  });
});

Deno.test("out of reach and a standing target do not reset or spend", () => {
  const ledger = new ZompointsLedger();
  fund(ledger, "a", 3 * COST);
  const bodies: Record<string, Body> = {
    a: { alive: true, downed: false },
    t: { alive: true, downed: true },
  };
  const tracker = new ReviveTracker();
  tracker.observeLook("a", "t");
  tracker.press("a", ctx(ledger, bodies, true));
  tracker.press("a", ctx(ledger, bodies, true));
  const purse = ledger.get("a");
  const spent: number[] = [];

  assertEquals(tracker.press("a", ctx(ledger, bodies, false, spent)), {
    kind: "refused",
    reason: "outOfReach",
  });
  assertEquals(spent, []);
  assertEquals(tracker.progress("a"), { targetId: "t", presses: 2 });
  assertEquals(ledger.get("a"), purse);

  bodies.t.downed = false;
  assertEquals(tracker.press("a", ctx(ledger, bodies, true, spent)), {
    kind: "refused",
    reason: "notDowned",
  });
  assertEquals(spent, []);
  assertEquals(tracker.progress("a"), { targetId: "t", presses: 2 });
  bodies.t.downed = true;
  assertEquals(tracker.press("a", ctx(ledger, bodies, true, spent)), {
    kind: "progress",
    presses: 3,
  });
});

Deno.test("two revivers keep their own counts and the first to finish wins", () => {
  const ledger = new ZompointsLedger();
  const total = PRESSES * COST;
  fund(ledger, "a", total);
  fund(ledger, "b", total);
  const bodies: Record<string, Body> = {
    a: { alive: true, downed: false },
    b: { alive: true, downed: false },
    t: { alive: true, downed: true },
  };
  const tracker = new ReviveTracker();
  tracker.observeLook("a", "t");
  tracker.observeLook("b", "t");
  for (let n = 0; n < 5; n++) tracker.press("a", ctx(ledger, bodies, true));
  for (let n = 0; n < 7; n++) tracker.press("b", ctx(ledger, bodies, true));
  assertEquals(tracker.progress("a"), { targetId: "t", presses: 5 });
  assertEquals(tracker.progress("b"), { targetId: "t", presses: 7 });

  const bPurse = ledger.get("b");
  for (let n = 5; n < PRESSES - 1; n++) {
    tracker.press("a", ctx(ledger, bodies, true));
  }
  assertEquals(tracker.progress("b"), { targetId: "t", presses: 7 });
  const revived = tracker.press("a", ctx(ledger, bodies, true));
  assertEquals(revived.kind, "revived");
  if (revived.kind === "revived") assertEquals(revived.intent.by, "a");
  assertEquals(tracker.progress("a"), null);
  assertEquals(tracker.progress("b"), null);
  assertEquals(ledger.get("b"), bPurse);

  // B's old count is gone. The glue marks t standing, so B cannot continue.
  tracker.observeLook("b", "t");
  assertEquals(tracker.progress("b"), { targetId: "t", presses: 0 });
  bodies.t.downed = false;
  const spent: number[] = [];
  assertEquals(tracker.press("b", ctx(ledger, bodies, true, spent)), {
    kind: "refused",
    reason: "notDowned",
  });
  assertEquals(spent, []);
  assertEquals(ledger.get("b"), bPurse);
});

Deno.test("leaving clears the leaver's count and anyone reviving them", () => {
  const ledger = new ZompointsLedger();
  ledger.join("a");
  ledger.join("b");
  const bodies: Record<string, Body> = {
    a: { alive: true, downed: false },
    b: { alive: true, downed: false },
    t: { alive: true, downed: true },
    u: { alive: true, downed: true },
  };
  const tracker = new ReviveTracker();
  tracker.observeLook("a", "t");
  tracker.observeLook("b", "u");
  tracker.press("a", ctx(ledger, bodies, true));
  tracker.press("b", ctx(ledger, bodies, true));
  const aPurse = ledger.get("a");

  tracker.leave("a");
  assertEquals(tracker.progress("a"), null);
  assertEquals(tracker.progress("b"), { targetId: "u", presses: 1 });
  assertEquals(ledger.get("a"), aPurse);

  tracker.observeLook("a", "t");
  tracker.press("a", ctx(ledger, bodies, true));
  tracker.leave("t");
  assertEquals(tracker.progress("a"), null);
  assertEquals(tracker.progress("b"), { targetId: "u", presses: 1 });
  assertEquals(ledger.get("a"), aPurse - COST);
});
