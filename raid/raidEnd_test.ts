import { assertEquals } from "jsr:@std/assert@1";
import {
  RAID_DEFAULT_MAX_TIME_SECONDS,
  RAID_FAIL_RETURN_SECONDS,
  RAID_WIN_RETURN_SECONDS,
} from "../shared/campaign/raids.ts";
import { TICK_HZ } from "../protocol/network.ts";
import type { DoorsMap } from "../world/map.ts";
import { MapCollision } from "../world/MapCollision.ts";
import { PlayerManager } from "../players/PlayerManager.ts";

const miniMap: DoorsMap = {
  version: 1,
  name: "raid-end",
  bounds: { minX: -10, maxX: 10, minZ: -10, maxZ: 10 },
  gridSize: 1,
  walls: [],
  teamA: {
    corners: [0, 1],
    edge: "south",
    doorHalfWidth: 2,
    spawnRadius: 2,
  },
  teamB: {
    corners: [2, 3],
    edge: "north",
    doorHalfWidth: 2,
    spawnRadius: 2,
  },
};

Deno.test("raid fail schedules a 60s return, not a rematch clock of 0/30", () => {
  const pm = new PlayerManager(new MapCollision(miniMap));
  pm.add("h1", "Ada");
  const over = pm.forceEndMatch(10, "B", {
    scheduleRestart: true,
    restartSeconds: RAID_FAIL_RETURN_SECONDS,
  });
  assertEquals(over?.restartInSeconds, RAID_FAIL_RETURN_SECONDS);
  assertEquals(pm.isRestartDue(10), false);
  assertEquals(pm.isRestartDue(10 + RAID_FAIL_RETURN_SECONDS * TICK_HZ), true);
});

Deno.test("raid clock can be armed to the catalog max time", () => {
  const pm = new PlayerManager(new MapCollision(miniMap));
  pm.add("h1", "Ada");
  pm.setMatchClock(10, RAID_DEFAULT_MAX_TIME_SECONDS);
  assertEquals(pm.isMatchTimeExpired(10), false);
  assertEquals(
    pm.isMatchTimeExpired(10 + RAID_DEFAULT_MAX_TIME_SECONDS * TICK_HZ),
    true,
  );
  const clock = pm.getMatchClockState();
  assertEquals(
    clock.matchEndTick,
    10 + RAID_DEFAULT_MAX_TIME_SECONDS * TICK_HZ,
  );
});

Deno.test("idle reset after a raid fail must not leave game-over for the next join", () => {
  const pm = new PlayerManager(new MapCollision(miniMap));
  pm.add("h1", "Ada");
  pm.forceEndMatch(10, "B", {
    scheduleRestart: true,
    restartSeconds: RAID_FAIL_RETURN_SECONDS,
  });
  // Old idle path: drop the rematch timer only. Joins still received gameOver.
  pm.clearScheduledRestart();
  assertEquals(pm.isMatchOver(), true);
  assertEquals(pm.getGameOverForJoin()?.winner, "B");

  pm.startNewMatch(20);
  assertEquals(pm.isMatchOver(), false);
  assertEquals(pm.getGameOverForJoin(), null);
});

Deno.test("raid win schedules a short return so the exclusive slot frees", () => {
  const pm = new PlayerManager(new MapCollision(miniMap));
  pm.add("h1", "Ada");
  const over = pm.forceEndMatch(10, "A", {
    scheduleRestart: true,
    restartSeconds: RAID_WIN_RETURN_SECONDS,
  });
  assertEquals(over?.restartInSeconds, RAID_WIN_RETURN_SECONDS);
  assertEquals(pm.isRestartDue(10), false);
  assertEquals(pm.isRestartDue(10 + RAID_WIN_RETURN_SECONDS * TICK_HZ), true);
});
