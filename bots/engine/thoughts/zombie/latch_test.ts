import { assertEquals } from "@std/assert";
import { emptyBotBrainState, isSetNumber } from "../../pipeline/state.ts";
import {
  armMeleeCooldown,
  meleeCooldownTicks,
  rememberZombieTarget,
  zombieLastKnown,
  zombieStickyId,
} from "./latch.ts";

Deno.test("rememberZombieTarget: drop the id, keep the last XZ", () => {
  const state = emptyBotBrainState();
  rememberZombieTarget(state, { id: "h", x: 3, z: -4 });
  assertEquals(zombieStickyId(state), "h");
  assertEquals(zombieLastKnown(state), { x: 3, z: -4 });

  rememberZombieTarget(state, null);
  assertEquals(zombieStickyId(state), "");
  assertEquals(zombieLastKnown(state), { x: 3, z: -4 });
});

Deno.test("armMeleeCooldown: ready tick is think tick plus the weapon gap", () => {
  const state = emptyBotBrainState();
  assertEquals(isSetNumber(state.reactionReadyAtTick), false);
  armMeleeCooldown(state, 20);
  assertEquals(state.reactionReadyAtTick, 20 + meleeCooldownTicks());
  const held = state.reactionReadyAtTick;
  armMeleeCooldown(state, Number.NaN);
  assertEquals(state.reactionReadyAtTick, held);
});
