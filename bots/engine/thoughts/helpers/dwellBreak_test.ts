import { assertEquals } from "jsr:@std/assert@1";
import {
  applyDwellBreak,
  CAMP_PLANT_DWELL_MS_TICKS,
  DWELL_FORCE_HUNT_UNTIL_TICK_KEY,
  DWELL_KEY,
  DWELL_SINCE_TICK_KEY,
  type DwellBreakBag,
  isDwellForceHuntActive,
  resolveDwellAnchor,
  stepDwellBreak,
  YAW_POLE_DWELL_BAN_CLEARS,
  YAW_POLE_DWELL_MS_TICKS,
  YAW_POLE_DWELL_NEAR_RADIUS,
} from "./dwellBreak.ts";
import { yawPoleKey } from "../../../../shared/world/yawPole.ts";

Deno.test("resolveDwellAnchor: sticky wins over camp when both near", () => {
  const sticky = { x: 0, z: 0 };
  const plant = { x: 0.5, z: 0.5 };
  const a = resolveDwellAnchor({
    x: 0.1,
    z: 0.1,
    sticky,
    campPlant: plant,
    campArrived: true,
  });
  assertEquals(a?.kind, "sticky");
  assertEquals(a?.key, yawPoleKey(0, 0));
});

Deno.test("resolveDwellAnchor: null when far from sticky and plant", () => {
  const a = resolveDwellAnchor({
    x: 20,
    z: 20,
    sticky: { x: 0, z: 0 },
    campPlant: { x: 1, z: 1 },
    campArrived: true,
  });
  assertEquals(a, null);
});

Deno.test("stepDwellBreak: combat resets without break", () => {
  const bag: DwellBreakBag = {
    [DWELL_KEY]: yawPoleKey(0, 0),
    [DWELL_SINCE_TICK_KEY]: 0,
  };
  const r = stepDwellBreak(bag, {
    x: 0,
    z: 0,
    tick: YAW_POLE_DWELL_MS_TICKS + 100,
    inCombat: true,
    sticky: { x: 0, z: 0 },
    campPlant: null,
    campArrived: false,
  });
  assertEquals(r.breakKey, null);
  assertEquals(r.dwellKey, null);
});

Deno.test("stepDwellBreak: sticky dwell past limit breaks", () => {
  const key = yawPoleKey(1, 2);
  const bag: DwellBreakBag = {
    [DWELL_KEY]: key,
    [DWELL_SINCE_TICK_KEY]: 10,
  };
  const r = stepDwellBreak(bag, {
    x: 1,
    z: 2,
    tick: 10 + YAW_POLE_DWELL_MS_TICKS,
    inCombat: false,
    sticky: { x: 1, z: 2 },
    campPlant: null,
    campArrived: false,
  });
  assertEquals(r.breakKey, key);
  assertEquals(r.clearSticky, true);
  assertEquals(r.clearCampPlant, false);
});

Deno.test("stepDwellBreak: camp plant dwell past limit breaks plant", () => {
  const key = yawPoleKey(3, 4);
  const bag: DwellBreakBag = {
    [DWELL_KEY]: key,
    [DWELL_SINCE_TICK_KEY]: 5,
  };
  const r = stepDwellBreak(bag, {
    x: 3,
    z: 4,
    tick: 5 + CAMP_PLANT_DWELL_MS_TICKS,
    inCombat: false,
    sticky: null,
    campPlant: { x: 3, z: 4 },
    campArrived: true,
  });
  assertEquals(r.breakKey, key);
  assertEquals(r.clearCampPlant, true);
});

Deno.test("stepDwellBreak: short dwell only starts timer", () => {
  const bag: DwellBreakBag = {};
  const r = stepDwellBreak(bag, {
    x: 0,
    z: 0,
    tick: 100,
    inCombat: false,
    sticky: { x: 0, z: 0 },
    campPlant: null,
    campArrived: false,
  });
  assertEquals(r.breakKey, null);
  assertEquals(r.dwellKey, yawPoleKey(0, 0));
  assertEquals(r.dwellSinceTick, 100);
});

Deno.test("applyDwellBreak: bans key and schedules force-hunt on camp", () => {
  const bag: DwellBreakBag = {
    stickyYawPole: { x: 1, z: 1 },
    doorCampPlantX: 1,
    doorCampPlantZ: 1,
    doorCampActive: true,
  };
  const key = yawPoleKey(1, 1);
  applyDwellBreak(
    bag,
    {
      breakKey: key,
      clearSticky: true,
      clearCampPlant: true,
      dwellKey: null,
      dwellSinceTick: null,
    },
    { tick: 500, banClears: YAW_POLE_DWELL_BAN_CLEARS },
  );
  assertEquals(bag.yawPoleIgnore?.[key], YAW_POLE_DWELL_BAN_CLEARS);
  assertEquals(bag.stickyYawPole, undefined);
  assertEquals(bag.doorCampPlantX, undefined);
  assertEquals(bag.doorCampActive, undefined);
  assertEquals(isDwellForceHuntActive(bag, 500), true);
  assertEquals(
    isDwellForceHuntActive(bag, bag[DWELL_FORCE_HUNT_UNTIL_TICK_KEY]!),
    false,
  );
});

Deno.test("YAW_POLE_DWELL_NEAR_RADIUS covers plant shimmy", () => {
  assertEquals(YAW_POLE_DWELL_NEAR_RADIUS > 1, true);
});
