import { assertEquals, assertExists } from "jsr:@std/assert";
import {
  PREMATCH_CONFIG,
  TICK_HZ,
} from "../shared/sim/game.ts";
import {
  DOOR_FULL_CYCLE_TICKS,
  DOOR_OPEN_TICKS,
  DOOR_POWER_UP_TICKS,
} from "../protocol/network.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";
import { doorCycleAt, PlayerManager } from "./PlayerManager.ts";

const miniMap: DoorsMap = {
  name: "door-cycle-test",
  version: 1,
  bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 },
  gridSize: 1,
  walls: [],
  teamA: { corners: [0, 1], edge: "south", doorHalfWidth: 2, spawnRadius: 4 },
  teamB: { corners: [2, 3], edge: "north", doorHalfWidth: 2, spawnRadius: 4 },
};

function manager(options: ConstructorParameters<typeof PlayerManager>[1] = {}): PlayerManager {
  return new PlayerManager(new MapCollision(miniMap), options);
}

Deno.test("door cycle: boundaries use half-open phases and stable change ticks", () => {
  const origin = 100;
  const cases = [
    { name: "before origin clamps to origin", tick: 95, open: true, change: origin + DOOR_OPEN_TICKS },
    { name: "origin starts open", tick: origin, open: true, change: origin + DOOR_OPEN_TICKS },
    {
      name: "last open tick remains open",
      tick: origin + DOOR_OPEN_TICKS - 1,
      open: true,
      change: origin + DOOR_OPEN_TICKS,
    },
    {
      name: "open boundary starts closed phase",
      tick: origin + DOOR_OPEN_TICKS,
      open: false,
      change: origin + DOOR_FULL_CYCLE_TICKS,
    },
    {
      name: "last closed tick remains closed",
      tick: origin + DOOR_FULL_CYCLE_TICKS - 1,
      open: false,
      change: origin + DOOR_FULL_CYCLE_TICKS,
    },
    {
      name: "full-cycle boundary starts a fresh open phase",
      tick: origin + DOOR_FULL_CYCLE_TICKS,
      open: true,
      change: origin + DOOR_FULL_CYCLE_TICKS + DOOR_OPEN_TICKS,
    },
  ];

  for (const testCase of cases) {
    const state = doorCycleAt(testCase.tick, origin);
    assertEquals(state.doorsOpen, testCase.open, testCase.name);
    assertEquals(state.doorChangeTick, testCase.change, testCase.name);
  }
});

Deno.test("door lifecycle: prematch and live transitions re-origin the cycle", () => {
  const pm = manager({ enablePrematch: true });
  const prematchStart = 500;
  const liveStart = 700;

  assertEquals(pm.enterPrematch(prematchStart, 1_000).phase, "prematch");
  assertEquals(pm.getDoorCycleState(prematchStart).doorsOpen, false);
  assertEquals(pm.getMatchClockState().matchEndTick, Number.MAX_SAFE_INTEGER);

  const live = pm.beginLiveMatch(liveStart, 2_000);
  assertEquals(live.phase, "live");
  assertEquals(live.doorsOpen, true);
  assertEquals(pm.getDoorCycleState(liveStart).doorChangeTick, liveStart + DOOR_OPEN_TICKS);
  assertEquals(pm.getDoorCycleState(liveStart + DOOR_OPEN_TICKS).doorsOpen, false);
  assertEquals(pm.getMatchClockState().matchEndTick, liveStart + 15 * 60 * TICK_HZ);
});

Deno.test("door lifecycle: power-up expiry re-origins at the exact open tick", () => {
  const pm = manager();
  const clearTick = 1_000;
  pm.beginLiveMatch(100, 3_000);
  pm.addAgent("agent-1", "Grey", "A", { x: 0, y: 1.7, z: 0, yaw: 0 });
  pm.remove("agent-1");
  pm.reopenDoorsAfterAgentsCleared(clearTick);

  assertEquals(pm.getDoorCycleState(clearTick).doorsOpen, false);
  assertEquals(
    pm.getDoorCycleState(clearTick).doorChangeTick,
    clearTick + DOOR_POWER_UP_TICKS,
  );

  const reopened = pm.getDoorCycleState(clearTick + DOOR_POWER_UP_TICKS);
  assertEquals(reopened.doorsOpen, true);
  assertEquals(
    reopened.doorChangeTick,
    clearTick + DOOR_POWER_UP_TICKS + DOOR_OPEN_TICKS,
  );
  assertEquals(
    pm.getDoorCycleState(clearTick + DOOR_POWER_UP_TICKS + DOOR_OPEN_TICKS).doorsOpen,
    false,
  );
});

Deno.test("door precedence: debug override is above raid and lifecycle locks", () => {
  const pm = manager({ enablePrematch: true });
  const tick = 200;

  pm.setRaidDoorPolicy("idle");
  assertEquals(pm.areDoorsOpen(tick), false);
  pm.setDebugForceDoorsOpen(true);
  assertEquals(pm.areDoorsOpen(tick), true);
  assertEquals(pm.getDoorCycleState(tick).doorsOpen, true);

  pm.setDebugForceDoorsOpen(false);
  pm.setRaidDoorPolicy("open");
  assertEquals(pm.areDoorsOpen(tick), true);
  assertEquals(pm.getDoorCycleState(tick).doorsOpen, true);

  pm.setRaidDoorPolicy("off");
  assertEquals(pm.areDoorsOpen(tick), false);
  assertEquals(pm.getDoorCycleState(tick).doorsOpen, false);
});

Deno.test("door lifecycle: scheduled restart lands in the configured next phase", () => {
  const pm = manager({ enablePrematch: true });
  assertEquals(pm.forceEndMatch(300, "draw", { scheduleRestart: true, restartSeconds: 2 })?.winner, "draw");
  assertEquals(pm.isRestartDue(300 + 2 * TICK_HZ - 1), false);
  assertEquals(pm.isRestartDue(300 + 2 * TICK_HZ), true);

  const next = pm.maybeRestartMatch(300 + 2 * TICK_HZ);
  assertExists(next);
  assertEquals(next.phase, "prematch");
  assertEquals(pm.getDoorCycleState(300 + 2 * TICK_HZ).doorsOpen, false);
  assertEquals(PREMATCH_CONFIG.doorsLockedClosed, true);
});
