import { assertEquals } from "jsr:@std/assert@1";
import { decideCatchUp, MAX_CATCH_UP_CHAIN, TICK_MS } from "./GameLoop.ts";

Deno.test("MAX_CATCH_UP_CHAIN is a small positive limit", () => {
  assertEquals(MAX_CATCH_UP_CHAIN >= 2, true);
  assertEquals(MAX_CATCH_UP_CHAIN <= 5, true);
});

Deno.test("catch-up decision resets after a normal scheduler gap", () => {
  assertEquals(decideCatchUp(0, 100, 0), {
    shouldDrop: false,
    catchUpChain: 0,
  });
  assertEquals(decideCatchUp(100, 100 + TICK_MS, 2), {
    shouldDrop: false,
    catchUpChain: 0,
  });
});

Deno.test("catch-up decision drops surplus steps at the chain cap", () => {
  let decision = decideCatchUp(100, 100 + TICK_MS * 0.1, 0);
  assertEquals(decision, { shouldDrop: false, catchUpChain: 1 });

  decision = decideCatchUp(
    100,
    100 + TICK_MS * 0.1,
    decision.catchUpChain,
  );
  assertEquals(decision, { shouldDrop: false, catchUpChain: 2 });

  decision = decideCatchUp(
    100,
    100 + TICK_MS * 0.1,
    decision.catchUpChain,
  );
  assertEquals(decision, {
    shouldDrop: true,
    catchUpChain: MAX_CATCH_UP_CHAIN - 1,
  });

  decision = decideCatchUp(
    100,
    100 + TICK_MS * 0.1,
    decision.catchUpChain,
  );
  assertEquals(decision.shouldDrop, true);
  assertEquals(decision.catchUpChain, MAX_CATCH_UP_CHAIN - 1);
});
