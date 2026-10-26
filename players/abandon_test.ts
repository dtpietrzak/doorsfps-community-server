import { assertEquals, assertExists } from "jsr:@std/assert";
import { PlayerManager } from "./PlayerManager.ts";
import { CONNECTION_ISSUE_TIMEOUT_MS } from "../protocol/network.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";

const miniMap: DoorsMap = {
  name: "test",
  version: 1,
  bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 },
  gridSize: 1,
  walls: [],
  teamA: {
    corners: [0, 1],
    edge: "south",
    doorHalfWidth: 2,
    spawnRadius: 4,
  },
  teamB: {
    corners: [2, 3],
    edge: "north",
    doorHalfWidth: 2,
    spawnRadius: 4,
  },
};

function makeRankedLive(): PlayerManager {
  const pm = new PlayerManager(new MapCollision(miniMap), {
    enablePrematch: true,
  });
  for (const id of ["s1", "s2", "s3", "s4"]) {
    pm.add(id, `P-${id}`, undefined, { accountUserId: `user_${id}` });
  }
  for (const id of ["s1", "s2", "s3", "s4"]) {
    pm.setMatchReady(id, true);
  }
  assertExists(pm.tryStartLiveFromReady(10));
  assertEquals(pm.isLive(), true);
  return pm;
}

Deno.test("abandon: first live leave marks void once", () => {
  const pm = makeRankedLive();
  assertEquals(pm.isLiveMatchVoided(), false);

  assertEquals(pm.markLiveMatchVoided("s1"), true);
  assertEquals(pm.isLiveMatchVoided(), true);
  assertEquals(pm.getAbandonedByPlayerId(), "s1");

  // Second leave: free (no re-void).
  assertEquals(pm.markLiveMatchVoided("s2"), false);
  assertEquals(pm.getAbandonedByPlayerId(), "s1");
});

Deno.test("abandon: prematch leave does not void", () => {
  const pm = new PlayerManager(new MapCollision(miniMap), {
    enablePrematch: true,
  });
  pm.add("s1", "Alice", undefined, { accountUserId: "user_a" });
  assertEquals(pm.isPrematch(), true);
  assertEquals(pm.markLiveMatchVoided("s1"), false);
  assertEquals(pm.isLiveMatchVoided(), false);
});

Deno.test("abandon: intermission leave does not void", () => {
  const pm = makeRankedLive();
  assertExists(pm.forceDraw(50));
  assertEquals(pm.getMatchPhase(), "intermission");
  assertEquals(pm.markLiveMatchVoided("s1"), false);
  assertEquals(pm.isLiveMatchVoided(), false);
});

Deno.test("abandon: open/community live can still mark void (server gates ranked)", () => {
  // PlayerManager void tracking is phase-based; GameServer gates isRanked().
  const pm = new PlayerManager(new MapCollision(miniMap));
  pm.add("s1", "A");
  assertEquals(pm.isLive(), true);
  assertEquals(pm.markLiveMatchVoided("s1"), true);
});

Deno.test("abandon: void clears when starting next prematch/live", () => {
  const pm = makeRankedLive();
  assertEquals(pm.markLiveMatchVoided("s2"), true);
  assertEquals(pm.isLiveMatchVoided(), true);

  const next = pm.startNewMatch(200);
  assertEquals(next.phase, "prematch");
  assertEquals(pm.isLiveMatchVoided(), false);
  assertEquals(pm.getAbandonedByPlayerId(), null);
});

Deno.test("abandon: void clears on beginLiveMatch", () => {
  const pm = makeRankedLive();
  pm.markLiveMatchVoided("s1");
  // Force back through prematch → live
  pm.enterPrematch(100);
  assertEquals(pm.isLiveMatchVoided(), false);
  for (const id of ["s1", "s2", "s3", "s4"]) {
    if (pm.get(id)) pm.setMatchReady(id, true);
  }
  // May have 4 still
  if (pm.canStartFromPrematch()) {
    pm.tryStartLiveFromReady(110);
    assertEquals(pm.isLiveMatchVoided(), false);
  }
});

Deno.test("abandon: connection-issue grace is not abandon until expired", () => {
  const pm = makeRankedLive();
  const p = pm.get("s1")!;
  const now = 10_000;
  assertEquals(pm.markConnectionIssue(p.id, now), true);
  assertEquals(pm.getConnectionIssueExpired(now + 1).length, 0);
  assertEquals(pm.isLiveMatchVoided(), false);

  // Still reclaimable — no void yet.
  assertEquals(pm.findReclaimableByName("P-s1")?.id, p.id);

  const expired = pm.getConnectionIssueExpired(
    now + CONNECTION_ISSUE_TIMEOUT_MS,
  );
  assertEquals(expired.length, 1);
  assertEquals(expired[0]!.id, p.id);

  // Simulate GameServer: mark void then process timeouts.
  assertEquals(pm.markLiveMatchVoided(p.id), true);
  const dropped = pm.processConnectionIssueTimeouts(
    now + CONNECTION_ISSUE_TIMEOUT_MS,
  );
  assertEquals(dropped, [p.id]);
  assertEquals(pm.get("s1"), undefined);
  assertEquals(pm.isLiveMatchVoided(), true);
});

Deno.test("abandon: reconnect within grace avoids void", () => {
  const pm = makeRankedLive();
  const p = pm.get("s1")!;
  const now = 5_000;
  pm.markConnectionIssue(p.id, now);
  const restored = pm.restoreConnection(p.id, "sock-new", 20);
  assertExists(restored);
  assertEquals(
    pm.getConnectionIssueExpired(now + CONNECTION_ISSUE_TIMEOUT_MS)
      .length,
    0,
  );
  assertEquals(pm.isLiveMatchVoided(), false);
});

Deno.test("abandon: natural end after void keeps voided flag until next match", () => {
  const pm = makeRankedLive();
  pm.markLiveMatchVoided("s3");
  const over = pm.forceDraw(500);
  assertExists(over);
  // Intermission after void still remembers void so scored report is skipped.
  assertEquals(pm.isLiveMatchVoided(), true);
  assertEquals(pm.getMatchPhase(), "intermission");

  pm.startNewMatch(600);
  assertEquals(pm.isLiveMatchVoided(), false);
});
