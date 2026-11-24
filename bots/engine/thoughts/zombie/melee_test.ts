import { assertEquals } from "@std/assert";
import { ZOMBOTS_TUNING } from "../../../../shared/zombots/zombotsTuning.ts";
import { PI } from "../../math/index.ts";
import { yawToward } from "../../navigation/heading.ts";
import type { Player } from "../../players/Player.ts";
import {
  zombieMeleeLunge,
  ZOMBIE_MELEE_YAW_TOLERANCE,
} from "./melee.ts";

function body(x: number, z: number, yaw = 0): Player {
  return { x, y: 1.6, z, yaw, crouch: false } as Player;
}

/** Inside the bite. The old pistol-whip reach (2.8) is not a bite. */
const target = body(0, -0.4);

Deno.test("zombieMeleeLunge: in reach, in front, and off cooldown", () => {
  const self = body(0, 0, yawToward(0, 0, target.x, target.z));
  assertEquals(
    zombieMeleeLunge({ self, target, tick: 0, readyAtTick: Number.NaN }),
    true,
  );
});

Deno.test("zombieMeleeLunge: out of reach or facing away does not swing", () => {
  const close = body(0, 0, 0);
  const farTarget = body(0, -12);
  assertEquals(
    zombieMeleeLunge({
      self: close,
      target: farTarget,
      tick: 0,
      readyAtTick: Number.NaN,
    }),
    false,
  );

  const away = body(0, 0, PI);
  assertEquals(
    zombieMeleeLunge({
      self: away,
      target,
      tick: 0,
      readyAtTick: Number.NaN,
    }),
    false,
  );
});

Deno.test("zombieMeleeLunge: reach is the bite, inclusive", () => {
  const reach = ZOMBOTS_TUNING.zombie.meleeRange;
  const yaw = yawToward(0, 0, 0, -1);
  const onEdge = body(0, 0, yaw);
  const touching = body(0, -reach);
  assertEquals(
    zombieMeleeLunge({
      self: onEdge,
      target: touching,
      tick: 0,
      readyAtTick: Number.NaN,
    }),
    true,
  );
  const apart = body(0, -(reach + 0.05));
  assertEquals(
    zombieMeleeLunge({
      self: onEdge,
      target: apart,
      tick: 0,
      readyAtTick: Number.NaN,
    }),
    false,
  );
});

Deno.test("zombieMeleeLunge: yaw tolerance is inclusive", () => {
  const bearing = yawToward(0, 0, target.x, target.z);
  const onEdge = body(0, 0, bearing + ZOMBIE_MELEE_YAW_TOLERANCE);
  const past = body(0, 0, bearing + ZOMBIE_MELEE_YAW_TOLERANCE + 0.05);
  assertEquals(
    zombieMeleeLunge({
      self: onEdge,
      target,
      tick: 10,
      readyAtTick: Number.NaN,
    }),
    true,
  );
  assertEquals(
    zombieMeleeLunge({
      self: past,
      target,
      tick: 10,
      readyAtTick: Number.NaN,
    }),
    false,
  );
});

Deno.test("zombieMeleeLunge: cooldown uses the think tick", () => {
  const self = body(0, 0, yawToward(0, 0, target.x, target.z));
  assertEquals(
    zombieMeleeLunge({ self, target, tick: 49, readyAtTick: 50 }),
    false,
  );
  assertEquals(
    zombieMeleeLunge({ self, target, tick: 50, readyAtTick: 50 }),
    true,
  );
});
