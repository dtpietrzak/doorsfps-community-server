import { assertEquals } from "@std/assert";
import { SIM_TICKS_PER_BOT_TICK } from "../types.ts";
import {
  beginApplyInterp,
  botInterpAlpha,
  buildInterpolatedReadyAction,
  lerpAngle,
  lerpPitch,
  lookFromAction,
} from "./botInterp.ts";
import type { ReadyAction } from "./types.ts";

Deno.test("botInterpAlpha reaches 1 on last sim tick of period", () => {
  const start = 6;
  assertEquals(botInterpAlpha(start, start), 1 / SIM_TICKS_PER_BOT_TICK);
  assertEquals(
    botInterpAlpha(start + SIM_TICKS_PER_BOT_TICK - 1, start),
    1,
  );
  assertEquals(botInterpAlpha(start + SIM_TICKS_PER_BOT_TICK, start), 1);
});

Deno.test("lerpAngle takes shortest path across ±π", () => {
  const from = Math.PI - 0.1;
  const to = -Math.PI + 0.1;
  const mid = lerpAngle(from, to, 0.5);
  // Mid should be near ±π, not 0.
  assertEquals(Math.abs(Math.abs(mid) - Math.PI) < 0.05, true);
});

Deno.test("lerpPitch is linear", () => {
  assertEquals(Math.abs(lerpPitch(-0.4, 0.2, 0.5) - (-0.1)) < 1e-12, true);
});

Deno.test("buildInterpolatedReadyAction lerps look and holds keys", () => {
  const curr: ReadyAction = {
    input: {
      sequence: 0,
      forward: true,
      backward: false,
      left: false,
      right: false,
      jump: false,
      sprint: true,
      crouch: false,
      yaw: 1.0,
      pitch: 0.2,
    },
    shoot: true,
    reload: false,
    weapon: 1,
    ability: "quick",
  };
  const interp = beginApplyInterp({ yaw: 0, pitch: 0 }, curr, 9);
  const a0 = buildInterpolatedReadyAction(interp, 9);
  assertEquals(a0.input?.forward, true);
  assertEquals(a0.input?.sprint, true);
  assertEquals(a0.shoot, true);
  assertEquals(a0.weapon, 1);
  assertEquals(a0.ability, "quick");
  // α = 1/3 → yaw ≈ 0.333
  assertEquals(Math.abs((a0.input?.yaw ?? 0) - 1 / 3) < 1e-9, true);

  interp.combatEdgeDone = true;
  const a1 = buildInterpolatedReadyAction(interp, 10);
  assertEquals(a1.shoot, false, "combat edge only once");
  assertEquals(a1.weapon, undefined, "weapon switch edge only once");
  assertEquals(a1.ability, undefined, "ability edge only once");
  assertEquals(a1.input?.forward, true, "keys still held");
  assertEquals(Math.abs((a1.input?.yaw ?? 0) - 2 / 3) < 1e-9, true);

  const a2 = buildInterpolatedReadyAction(interp, 11);
  assertEquals(Math.abs((a2.input?.yaw ?? 0) - 1) < 1e-9, true);
});

Deno.test("lookFromAction falls back when input null", () => {
  assertEquals(
    lookFromAction({ input: null }, { yaw: 2, pitch: 0.1 }),
    { yaw: 2, pitch: 0.1 },
  );
});
