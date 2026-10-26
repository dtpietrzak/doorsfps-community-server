import { assertEquals } from "jsr:@std/assert@1";
import {
  availableRaidIds,
  formatRaidMaxTime,
  getRaid,
  getRaidBotCount,
  getRaidByTitle,
  intersectAvailableRaidIds,
  isRaidId,
  isRaidOnlyMapName,
  isRaidTeamId,
  nextLockedRaidId,
  RAID_ASSEMBLE_LOCK_SECONDS,
  RAID_BREEZEWAY_MAX_TIME_SECONDS,
  RAID_DEFAULT_MAX_TIME_SECONDS,
  RAID_MIDWAY_MAX_TIME_SECONDS,
  RAID_TERMINAL_MAX_TIME_SECONDS,
  RAID_DOOR_GOAL,
  RAID_FAIL_RETURN_SECONDS,
  RAID_FIRST_ID,
  RAID_MAX_PLAYERS,
  RAID_MIN_PLAYERS,
  RAID_RESPAWN_DELAY_MS,
  RAID_START_WAIT_SECONDS,
  RAID_WIN_RETURN_SECONDS,
  RAID_WIN_REWARD,
  RAIDS,
  raidStageMaps,
  raidUnlocked,
  resolveRaidVotes,
} from "./raids.ts";

Deno.test("raid catalog exposes Breezeway as raid 01", () => {
  assertEquals(RAIDS.length, 3);
  const raid = getRaid("crossroads");
  assertEquals(raid?.id, RAID_FIRST_ID);
  assertEquals(raid?.title, "Breezeway");
  assertEquals(raid?.raidNumber, 1);
  assertEquals(raid?.map, "Crossroads");
  assertEquals(raid?.doorGoal, RAID_DOOR_GOAL);
  assertEquals(raid?.maxTimeSeconds, RAID_BREEZEWAY_MAX_TIME_SECONDS);
  assertEquals(raid?.maxTimeSeconds, RAID_DEFAULT_MAX_TIME_SECONDS);
  assertEquals(formatRaidMaxTime(raid!.maxTimeSeconds), "4 min");
  assertEquals(RAID_ASSEMBLE_LOCK_SECONDS, 5 * 60);
  assertEquals(getRaid("cornfield-levels")?.maxTimeSeconds, RAID_MIDWAY_MAX_TIME_SECONDS);
  assertEquals(getRaid("maze")?.maxTimeSeconds, RAID_TERMINAL_MAX_TIME_SECONDS);
  assertEquals(formatRaidMaxTime(90), "1:30");
  assertEquals(raid?.reward, RAID_WIN_REWARD);
  assertEquals(raid?.nextRaidId, "cornfield-levels");
  assertEquals(RAID_MIN_PLAYERS, 2);
  assertEquals(RAID_MAX_PLAYERS, 4);
  assertEquals(RAID_DOOR_GOAL, 10);
  assertEquals(RAID_WIN_REWARD, { xp: 15, coins: 15 });
  assertEquals(RAID_RESPAWN_DELAY_MS, 30_000);
  assertEquals(RAID_FAIL_RETURN_SECONDS, 60);
  assertEquals(RAID_WIN_RETURN_SECONDS, 20);
  assertEquals(RAID_START_WAIT_SECONDS, 120);
});

Deno.test("raidStageMaps keeps distinct Cornfield↔Levels neighbors across runs", () => {
  const raid = getRaid("cornfield-levels")!;
  assertEquals(getRaidByTitle("Midway")?.id, "cornfield-levels");
  assertEquals(raidStageMaps(raid, 1), {
    map: "Cornfield",
    nextMap: "Levels",
  });
  assertEquals(raidStageMaps(raid, 5), {
    map: "Cornfield",
    nextMap: "Levels",
  });
  assertEquals(raidStageMaps(raid, 6), {
    map: "Levels",
    prevMap: "Cornfield",
  });
  assertEquals(raidStageMaps(raid, 10), {
    map: "Levels",
    prevMap: "Cornfield",
  });
});

Deno.test("Raid02 maps are raid-only vote names", () => {
  assertEquals(isRaidOnlyMapName("Raid02-00"), true);
  assertEquals(isRaidOnlyMapName("Raid02-06"), true);
  assertEquals(isRaidOnlyMapName("Crossroads"), false);
  assertEquals(isRaidOnlyMapName("Levels"), false);
});

Deno.test("isRaidId and isRaidTeamId reject unrelated values", () => {
  assertEquals(isRaidId("crossroads"), true);
  assertEquals(isRaidId("cornfield-levels"), true);
  assertEquals(isRaidId("raid-02"), false);
  assertEquals(isRaidId(""), false);
  assertEquals(isRaidId(null), false);
  assertEquals(isRaidTeamId("A"), true);
  assertEquals(isRaidTeamId("B"), true);
  assertEquals(isRaidTeamId("C"), false);
});

Deno.test("raid 02 unlocks after Breezeway; unknown ids stay locked", () => {
  assertEquals(raidUnlocked([], "crossroads"), true);
  assertEquals(raidUnlocked(["crossroads"], "crossroads"), true);
  assertEquals(raidUnlocked([], "raid-02"), false);
  assertEquals(raidUnlocked(["crossroads"], "unknown"), false);
  assertEquals(availableRaidIds([]), ["crossroads"]);
  assertEquals(raidUnlocked([], "cornfield-levels"), false);
  assertEquals(raidUnlocked(["crossroads"], "cornfield-levels"), true);
  assertEquals(availableRaidIds(["crossroads"]), [
    "crossroads",
    "cornfield-levels",
  ]);
  assertEquals(nextLockedRaidId([]), "cornfield-levels");
  assertEquals(nextLockedRaidId(["crossroads"]), "maze");
  assertEquals(nextLockedRaidId(["crossroads", "cornfield-levels"]), null);
  assertEquals(raidUnlocked(["crossroads"], "maze"), false);
  assertEquals(
    raidUnlocked(["crossroads", "cornfield-levels"], "maze"),
    true,
  );
  assertEquals(availableRaidIds(["crossroads", "cornfield-levels"]), [
    "crossroads",
    "cornfield-levels",
    "maze",
  ]);
  assertEquals(isRaidId("maze"), true);
  assertEquals(getRaidByTitle("Terminal")?.id, "maze");
});

Deno.test("party available raids are the intersection of unlocks", () => {
  assertEquals(intersectAvailableRaidIds([]), ["crossroads"]);
  assertEquals(intersectAvailableRaidIds([[], ["crossroads"]]), ["crossroads"]);
  assertEquals(
    intersectAvailableRaidIds([
      ["crossroads"],
      ["crossroads", "cornfield-levels"],
    ]),
    ["crossroads", "cornfield-levels"],
  );
});

Deno.test("raid 02 scripts five Cornfield and five Levels rounds", () => {
  const raid = getRaid("cornfield-levels");
  assertEquals(raid?.title, "Midway");
  assertEquals(raid?.rounds.map((round) => round.map), [
    "Cornfield",
    "Cornfield",
    "Cornfield",
    "Cornfield",
    "Cornfield",
    "Levels",
    "Levels",
    "Levels",
    "Levels",
    "Levels",
  ]);
  const round5 = raid?.rounds[4];
  const round9 = raid?.rounds[8];
  const round10 = raid?.rounds[9];
  assertEquals(
    round5 && "agentEncounter" in round5 ? round5.agentEncounter : undefined,
    {
      count: 2,
      delaySeconds: 5,
    },
  );
  assertEquals(
    round9 && "agentEncounter" in round9 ? round9.agentEncounter : undefined,
    {
      count: 3,
      delaySeconds: 0,
    },
  );
  assertEquals(
    round10 && "bossEncounter" in round10 ? round10.bossEncounter : undefined,
    {
      count: 2,
      maxHealth: 200,
      scale: 1.3,
      moveSpeedScale: 0.65,
    },
  );
});

Deno.test("maze raid scripts seven Raid02 rounds with minis and a boss finale", () => {
  const raid = getRaid("maze");
  assertEquals(raid?.title, "Terminal");
  assertEquals(raid?.raidNumber, 3);
  assertEquals(raid?.map, "Raid02-00");
  assertEquals(raid?.doorGoal, 7);
  assertEquals(raid?.rounds.length, 7);
  assertEquals(raid?.rounds.map((round) => round.map), [
    "Raid02-00",
    "Raid02-01",
    "Raid02-02",
    "Raid02-03",
    "Raid02-04",
    "Raid02-05",
    "Raid02-06",
  ]);
  assertEquals(raid?.nextRaidId, null);
  assertEquals(getRaid("cornfield-levels")?.nextRaidId, "maze");
  const round3 = raid?.rounds[2];
  assertEquals(
    round3 && "agentEncounter" in round3 ? round3.agentEncounter : undefined,
    { count: 2, delaySeconds: 5 },
  );
  const round4 = raid?.rounds[3];
  assertEquals(
    round4 && "miniEncounter" in round4 ? round4.miniEncounter : undefined,
    {
      count: 2,
      maxHealth: 20,
      scale: 0.8,
      moveSpeedScale: 1.3,
      countBonusAtFourPlus: 1,
    },
  );
  const round6 = raid?.rounds[5];
  assertEquals(
    round6 && "agentEncounter" in round6 ? round6.agentEncounter : undefined,
    { count: 3, delaySeconds: 0 },
  );
  assertEquals(
    round6 && "miniEncounter" in round6 ? round6.miniEncounter : undefined,
    {
      count: 4,
      maxHealth: 20,
      scale: 0.8,
      moveSpeedScale: 1.3,
      countBonusAtFourPlus: 1,
    },
  );
  const round7 = raid?.rounds[6];
  assertEquals(
    round7 && "bossEncounter" in round7 ? round7.bossEncounter : undefined,
    {
      count: 2,
      maxHealth: 200,
      scale: 1.3,
      moveSpeedScale: 0.65,
      countBonusAtFourPlus: 1,
    },
  );
  assertEquals(
    raid?.rounds.map((round) =>
      "normalBots" in round ? round.normalBots : undefined
    ),
    [2, 4, 4, 2, 4, 4, 4],
  );
});

Deno.test("raid vote plurality elects raid and team independently", () => {
  const result = resolveRaidVotes(
    [
      { playerId: 1, raidId: "crossroads", team: "A" },
      { playerId: 2, raidId: "crossroads", team: "B" },
      { playerId: 3, raidId: "crossroads", team: "B" },
    ],
    ["crossroads"],
    1,
  );
  assertEquals(result.winningRaidId, "crossroads");
  assertEquals(result.winningTeam, "B");
  assertEquals(result.completeVoteCount, 3);
  assertEquals(result.raidCounts.crossroads, 3);
  assertEquals(result.teamCounts, { A: 1, B: 2 });
});

Deno.test("tied raid votes break to the leader's ballot", () => {
  const result = resolveRaidVotes(
    [
      { playerId: 1, raidId: "crossroads", team: "A" },
      { playerId: 2, raidId: "crossroads", team: "B" },
    ],
    ["crossroads"],
    1,
  );
  assertEquals(result.winningRaidId, "crossroads");
  assertEquals(result.winningTeam, "A");
});

Deno.test("incomplete or invalid ballots do not count as complete votes", () => {
  const result = resolveRaidVotes(
    [
      { playerId: 1, raidId: "crossroads", team: null },
      { playerId: 2, raidId: "unknown", team: "B" },
    ],
    ["crossroads"],
    1,
  );
  assertEquals(result.completeVoteCount, 0);
  assertEquals(result.winningRaidId, "crossroads");
  assertEquals(result.winningTeam, "B");
});

Deno.test("Crossroads raid bot count scales with door and players", () => {
  assertEquals(getRaidBotCount(1, 2), 2);
  assertEquals(getRaidBotCount(2, 2), 3);
  assertEquals(getRaidBotCount(10, 2), 7);
  assertEquals(getRaidBotCount(1, 4), 3);
});
