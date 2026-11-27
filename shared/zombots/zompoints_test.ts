import { assertEquals } from "@std/assert";
import { ZompointsLedger } from "./zompoints.ts";
import { ZOMBOTS_TUNING } from "./zombotsTuning.ts";

const START = ZOMBOTS_TUNING.points.start;
const HIT = ZOMBOTS_TUNING.points.hit;
const KILL = ZOMBOTS_TUNING.points.kill;
const WAVE = ZOMBOTS_TUNING.points.waveSurvived;

Deno.test("join seeds the starting purse once", () => {
  assertEquals(START, 100);
  const ledger = new ZompointsLedger();
  assertEquals(ledger.get("a"), 0);
  assertEquals(ledger.join("a"), {
    kind: "pointsChanged",
    playerId: "a",
    points: START,
    delta: START,
    reason: "start",
  });
  assertEquals(ledger.get("a"), START);
  ledger.award("a", "hit");
  // A repeated join must not wipe points already earned.
  assertEquals(ledger.join("a"), null);
  assertEquals(ledger.get("a"), START + HIT);
});

Deno.test("awards pay the tuning table", () => {
  assertEquals(HIT, 5);
  assertEquals(KILL, 50);
  assertEquals(WAVE, 250);
  const ledger = new ZompointsLedger();
  ledger.join("a");
  assertEquals(ledger.award("a", "hit"), {
    kind: "pointsChanged",
    playerId: "a",
    points: START + HIT,
    delta: HIT,
    reason: "hit",
  });
  assertEquals(ledger.award("a", "kill"), {
    kind: "pointsChanged",
    playerId: "a",
    points: START + HIT + KILL,
    delta: KILL,
    reason: "kill",
  });
  assertEquals(ledger.award("a", "waveSurvived"), {
    kind: "pointsChanged",
    playerId: "a",
    points: START + HIT + KILL + WAVE,
    delta: WAVE,
    reason: "waveSurvived",
  });
  assertEquals(ledger.get("a"), START + HIT + KILL + WAVE);
  // Unknown players are not enrolled by an award.
  assertEquals(ledger.award("ghost", "hit"), {
    kind: "pointsChanged",
    playerId: "ghost",
    points: 0,
    delta: 0,
    reason: "hit",
  });
  assertEquals(ledger.get("ghost"), 0);
});

Deno.test("wave survived pays only the living ids it is given", () => {
  const ledger = new ZompointsLedger();
  // Join order is not the payout order. The downed player is left off the list.
  ledger.join("downed");
  ledger.join("b");
  ledger.join("a");
  ledger.award("a", "kill");
  const intents = ledger.awardWaveSurvived(["a", "a", "ghost", "b"]);
  assertEquals(intents, [
    {
      kind: "pointsChanged",
      playerId: "a",
      points: START + KILL + WAVE,
      delta: WAVE,
      reason: "waveSurvived",
    },
    {
      kind: "pointsChanged",
      playerId: "b",
      points: START + WAVE,
      delta: WAVE,
      reason: "waveSurvived",
    },
  ]);
  assertEquals(ledger.get("downed"), START);
  assertEquals(ledger.get("ghost"), 0);
  assertEquals(ledger.awardWaveSurvived([]), []);
});

Deno.test("spend refuses and leaves the purse untouched", () => {
  const ledger = new ZompointsLedger();
  ledger.join("a");
  assertEquals(ledger.trySpend("a", START + 1, "door"), { ok: false, points: START });
  assertEquals(ledger.get("a"), START);
  assertEquals(ledger.trySpend("a", -5, "door"), { ok: false, points: START });
  assertEquals(ledger.trySpend("a", Number.NaN, "door"), { ok: false, points: START });
  assertEquals(ledger.get("a"), START);

  assertEquals(ledger.trySpend("a", KILL, "revivePress"), {
    ok: true,
    points: START - KILL,
    intent: {
      kind: "pointsChanged",
      playerId: "a",
      points: START - KILL,
      delta: -KILL,
      reason: "revivePress",
    },
  });
  const left = ledger.get("a");
  const drained = ledger.trySpend("a", left, "door");
  assertEquals(drained.ok, true);
  if (drained.ok) {
    assertEquals(drained.points, 0);
    assertEquals(drained.intent.delta, -left);
  }
  assertEquals(ledger.trySpend("a", 1, "door"), { ok: false, points: 0 });
  assertEquals(ledger.get("a"), 0);
  assertEquals(ledger.total("a"), START);
  assertEquals(ledger.trySpend("ghost", 1, "door"), { ok: false, points: 0 });
  assertEquals(ledger.total("ghost"), 0);
});

Deno.test("total tracks all gathered zompoints across awards and spends", () => {
  const ledger = new ZompointsLedger();
  ledger.join("a");
  assertEquals(ledger.total("a"), START);
  ledger.award("a", "hit");
  ledger.award("a", "kill");
  ledger.awardWaveSurvived(["a"]);
  const gathered = START + HIT + KILL + WAVE;
  assertEquals(ledger.get("a"), gathered);
  assertEquals(ledger.total("a"), gathered);
  assertEquals(ledger.trySpend("a", KILL + WAVE, "door").ok, true);
  assertEquals(ledger.get("a"), START + HIT);
  assertEquals(ledger.total("a"), gathered);
});

Deno.test("leave drops the purse and the next join reseeds", () => {
  const ledger = new ZompointsLedger();
  ledger.join("a");
  ledger.award("a", "kill");
  ledger.leave("a");
  assertEquals(ledger.get("a"), 0);
  assertEquals(ledger.total("a"), 0);
  ledger.leave("a");
  assertEquals(ledger.join("a")?.points, START);
  assertEquals(ledger.get("a"), START);
  assertEquals(ledger.total("a"), START);
});

Deno.test("a head hit pays headHit, a body hit pays hit", () => {
  const HEAD_HIT = ZOMBOTS_TUNING.points.headHit;
  assertEquals(HEAD_HIT, 10);
  const ledger = new ZompointsLedger();
  ledger.join("a");
  assertEquals(ledger.awardHit("a", true), {
    kind: "pointsChanged",
    playerId: "a",
    points: START + HEAD_HIT,
    delta: HEAD_HIT,
    reason: "hit",
  });
  assertEquals(ledger.awardHit("a", false).points, START + HEAD_HIT + HIT);
  assertEquals(ledger.total("a"), START + HEAD_HIT + HIT);
});
