import { assertEquals } from "@std/assert";
import { BotManager } from "../bots/BotManager.ts";
import { PlayerManager } from "../players/PlayerManager.ts";
import type { GameOverPacket } from "../protocol/network.ts";
import { RaidMatch } from "../raid/RaidMatch.ts";
import {
  RAID_AFK_MAX_MS,
  RAID_FAIL_RETURN_SECONDS,
  RAID_WIN_RETURN_SECONDS,
} from "../shared/campaign/raids.ts";
import { TICK_HZ } from "./GameLoop.ts";
import type { MapCatalogEntry } from "./gameServerOptions.ts";
import { RaidRuntime, type RaidRuntimeDeps } from "./raidRuntime.ts";
import type { SessionHub } from "../transport/types.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";

const miniMap: DoorsMap = {
  name: "Holding",
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

function entryFor(name: string, collision: MapCollision): MapCatalogEntry {
  return {
    name,
    stem: name,
    path: `${name}.doors.json`,
    map: { ...miniMap, name },
    collision,
  };
}

function harness(opts?: {
  raid?: boolean;
  mapName?: string;
  mapPath?: string;
  find?: RaidRuntimeDeps["findMapEntry"];
}) {
  const collision = new MapCollision(miniMap);
  const players = new PlayerManager(collision);
  const bots = {
    clearRaidBots() {},
    setRaidMode(_on: boolean) {},
    setRaidWave(_count: number, _team: "A" | "B") {},
    setRaidBossWave() {},
    setRaidMixedWave() {},
    spawnAgentsAtDoor() {},
  } as unknown as BotManager;
  const sent: { event: string; payload: unknown }[] = [];
  const dismissed: string[] = [];
  const kicked: string[] = [];
  let identity = 0;
  let starts = 0;
  let heatmaps = 0;
  const maps: string[] = [];
  let currentName = opts?.mapName ?? miniMap.name;
  let currentPath = opts?.mapPath;
  const runtime = new RaidRuntime({
    isRaidRuntime: () => opts?.raid !== false,
    players,
    bots,
    sessions: () =>
      ({
        emit(event: string, payload: unknown) {
          sent.push({ event, payload });
        },
      }) as SessionHub,
    map: () => ({ ...miniMap, name: currentName }),
    mapPath: () => currentPath,
    findMapEntry: opts?.find ?? ((name) => entryFor(name, collision)),
    setActiveMap: (entry) => {
      currentName = entry.map.name;
      currentPath = entry.path;
      maps.push(entry.map.name);
      players.setCollision(entry.collision);
    },
    beginRuntimeMatchIdentity: () => {
      identity += 1;
    },
    notifyMatchStart: () => {
      starts += 1;
    },
    resetHeatmaps: () => {
      heatmaps += 1;
    },
    dismissHumanToMenu: (player) => {
      dismissed.push(player.id);
    },
    kickForAfk: (player) => {
      kicked.push(player.id);
    },
  });
  return {
    runtime,
    players,
    sent,
    dismissed,
    kicked,
    maps,
    get identity() {
      return identity;
    },
    get starts() {
      return starts;
    },
    get heatmaps() {
      return heatmaps;
    },
  };
}

Deno.test("raid join conflict follows the live match", () => {
  const { runtime } = harness();
  assertEquals(runtime.joinConflict({ team: "B", raidId: "other" }), false);
  runtime.activateFromJoin({ team: "A", raidId: "crossroads", partySize: 2 });
  assertEquals(runtime.joinConflict({ team: "A", raidId: "crossroads" }), false);
  assertEquals(runtime.joinConflict({ team: "B" }), true);
  assertEquals(runtime.joinConflict({ raidId: "other" }), true);
});

Deno.test("activating a raid rotates identity once and a later member only raises the party", () => {
  const h = harness();
  h.runtime.activateFromJoin({ team: "A", raidId: "crossroads", partySize: 2 });
  assertEquals(h.identity, 1);
  assertEquals(h.starts, 1);
  assertEquals(h.heatmaps, 1);
  assertEquals(h.runtime.match?.expectedHumans, 2);
  assertEquals(h.maps.length, 1);
  h.runtime.activateFromJoin({ team: "A", raidId: "crossroads", partySize: 4 });
  assertEquals(h.identity, 1);
  assertEquals(h.starts, 1);
  assertEquals(h.runtime.match?.expectedHumans, 4);
  assertEquals(h.maps.length, 1);
});

Deno.test("a non-raid runtime ignores activation", () => {
  const h = harness({ raid: false });
  h.runtime.activateFromJoin({ team: "A", raidId: "crossroads", partySize: 2 });
  assertEquals(h.runtime.match, null);
  assertEquals(h.identity, 0);
});

Deno.test("switchMap misses, skips the current map, and emits a stage change", () => {
  const collision = new MapCollision(miniMap);
  const probe = new RaidMatch({ humanTeam: "A", raidId: "crossroads" });
  const waveMap = probe.planForWave(1).map;
  const missing = harness({
    find: () => null,
  });
  assertEquals(missing.runtime.switchMap("Nowhere"), false);

  const same = harness({
    mapName: waveMap,
    mapPath: `${waveMap}.doors.json`,
  });
  assertEquals(same.runtime.switchMap(waveMap, false), true);
  assertEquals(same.maps.length, 0);

  const swapped = harness();
  assertEquals(swapped.runtime.switchMap(waveMap, true), true);
  assertEquals(swapped.maps, [waveMap]);
  assertEquals(swapped.sent.map((row) => row.event), [
    "mapChange",
    "snapshot",
  ]);
  void collision;
});

Deno.test("a load timeout kicks the party and blocks that party id", () => {
  const { runtime, players, dismissed } = harness();
  runtime.activateFromJoin({ team: "A", raidId: "crossroads", partySize: 2 });
  players.add("p1", "Ada", "A", { partyId: "party-1", accountUserId: "acct-1" });
  (runtime.match as unknown as { activatedAtMs: number }).activatedAtMs =
    Date.now() - 121_000;
  assertEquals(runtime.handleFailConditions(), null);
  assertEquals(runtime.match, null);
  assertEquals(dismissed, ["p1"]);
  assertEquals(runtime.partyTimedOut("party-1"), true);
  assertEquals(runtime.partyTimedOut("party-2"), false);
  assertEquals(runtime.loadedPlayerIds.size, 0);
});

Deno.test("decorateGameOver fills the raid return and leaves a non-raid packet alone", () => {
  const { runtime } = harness();
  const packet = {
    scores: { A: 3, B: 1 },
    winner: "A",
    restartInSeconds: 0,
  } as GameOverPacket;
  assertEquals(runtime.decorateGameOver(packet, () => "unranked"), null);
  runtime.activateFromJoin({ team: "A", raidId: "crossroads", partySize: 2 });
  const win = runtime.decorateGameOver(packet, () => "unranked");
  assertEquals(win?.restartInSeconds, RAID_WIN_RETURN_SECONDS);
  assertEquals(win?.returnToMenu, true);
  assertEquals(win?.matchKind, "raid");
  assertEquals(win?.xpMode, "unranked");
  const loss = runtime.decorateGameOver(
    { ...packet, winner: "B" },
    () => undefined,
  );
  assertEquals(loss?.restartInSeconds, RAID_FAIL_RETURN_SECONDS);
  assertEquals(loss?.xpMode, undefined);
});

Deno.test("metadata and checkpoint stay inactive until a raid is activated", () => {
  const { runtime } = harness();
  assertEquals(runtime.metadataState(), { active: false });
  assertEquals(runtime.checkpointState(), { active: false });
  runtime.activateFromJoin({ team: "B", raidId: "crossroads", partySize: 2 });
  const meta = runtime.metadataState();
  assertEquals(meta.active, true);
  if (meta.active) {
    assertEquals(meta.humanTeam, "B");
    assertEquals(meta.raidId, runtime.match?.raidId);
  }
  assertEquals(runtime.checkpointState().active, true);
});

Deno.test("resetIdle drops the live raid", () => {
  const { runtime } = harness();
  runtime.activateFromJoin({ team: "A", raidId: "crossroads", partySize: 2 });
  runtime.loadedPlayerIds.add("p1");
  runtime.resetIdle();
  assertEquals(runtime.match, null);
  assertEquals(runtime.loadedPlayerIds.size, 0);
});

Deno.test("a live raider who stays AFK is kicked, and a dead raider is not", () => {
  const { runtime, players, kicked } = harness();
  runtime.activateFromJoin({ team: "A", raidId: "crossroads", partySize: 2 });
  const alive = players.add("p1", "Ada", "A", { accountUserId: "acct-1" });
  const dead = players.add("p2", "Bea", "A", { accountUserId: "acct-2" });
  runtime.match!.started = true;
  const now = Date.now();
  alive.lastActivityAtMs = now - 20_000;
  alive.raidAfkAccumMs = RAID_AFK_MAX_MS - (1000 / TICK_HZ) / 2;
  dead.alive = false;
  dead.lastActivityAtMs = now - 120_000;
  runtime.afkTick(now);
  assertEquals(kicked, ["p1"]);
  runtime.markPrizeIneligible(alive);
  assertEquals(runtime.prizeIneligible.has("acct-1"), true);
  runtime.snapshotCredit(alive);
  assertEquals(runtime.credits.get("acct-1")?.username, "Ada");
});
