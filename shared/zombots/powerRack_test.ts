import { assertEquals } from "@std/assert";
import { tryPowerRecharge, type PowerRechargeInput } from "./powerRack.ts";
import { ZOMBOTS_TUNING } from "./zombotsTuning.ts";

function input(over: Partial<PowerRechargeInput> = {}): PowerRechargeInput & { spent: number[] } {
  const spent: number[] = [];
  return {
    rackCenter: { x: 0, z: 0 },
    eye: { x: 1, z: 0 },
    isDowned: false,
    canRecharge: true,
    trySpend: (cost) => {
      spent.push(cost);
      return { ok: true };
    },
    ...over,
    spent,
  };
}

Deno.test("a power recharge costs 500 zompoints", () => {
  assertEquals(ZOMBOTS_TUNING.racks.powerCost, 500);
  const i = input();
  assertEquals(tryPowerRecharge(i), { kind: "ok", cost: 500 });
  assertEquals(i.spent, [500]);
});

Deno.test("reach is inclusive and planar", () => {
  const reach = ZOMBOTS_TUNING.racks.reach;
  assertEquals(tryPowerRecharge(input({ eye: { x: reach, z: 0 } })).kind, "ok");
  assertEquals(
    tryPowerRecharge(input({ eye: { x: reach + 0.01, z: 0 } })),
    { kind: "refused", reason: "outOfReach" },
  );
});

Deno.test("refusals never debit the purse", () => {
  const downed = input({ isDowned: true });
  assertEquals(tryPowerRecharge(downed), { kind: "refused", reason: "downed" });
  const far = input({ eye: { x: 50, z: 0 } });
  assertEquals(tryPowerRecharge(far), { kind: "refused", reason: "outOfReach" });
  const nothing = input({ canRecharge: false });
  assertEquals(tryPowerRecharge(nothing), { kind: "refused", reason: "nothingSpent" });
  assertEquals([...downed.spent, ...far.spent, ...nothing.spent], []);
});

Deno.test("a purse that can't cover it is refused after the cost was tried once", () => {
  const broke = input({
    trySpend: (cost) => {
      broke.spent.push(cost);
      return { ok: false };
    },
  });
  assertEquals(tryPowerRecharge(broke), { kind: "refused", reason: "notEnough" });
  assertEquals(broke.spent, [500]);
});

Deno.test("non-finite positions are out of reach", () => {
  assertEquals(
    tryPowerRecharge(input({ eye: { x: Number.NaN, z: 0 } })),
    { kind: "refused", reason: "outOfReach" },
  );
});

Deno.test("a gun rack use costs 100 zompoints", () => {
  assertEquals(ZOMBOTS_TUNING.racks.gunCost, 100);
});
