import { assertEquals } from "jsr:@std/assert@1";
import {
  RAID_DEFAULT_MAX_TIME_SECONDS,
  RAID_RESPAWN_DELAY_MS,
} from "../shared/campaign/raids.ts";
import { RaidMatch } from "./RaidMatch.ts";

Deno.test("raid waves: 10th door wins", () => {
  const raid = new RaidMatch({ humanTeam: "A", expectedHumans: 2 });
  assertEquals(raid.maxTimeSeconds, RAID_DEFAULT_MAX_TIME_SECONDS);
  assertEquals(raid.respawnMs, RAID_RESPAWN_DELAY_MS);
  assertEquals(raid.hud(0).respawnMs, RAID_RESPAWN_DELAY_MS);
  assertEquals(raid.tryStart(2), true);
  assertEquals(raid.wave, 1);
  assertEquals(raid.botName(1), "bot");
  assertEquals(raid.botName(2), "bot2");
  assertEquals(raid.botName(10), "bot10");
  assertEquals(raid.waveForScore(0), 1);
  assertEquals(raid.waveForScore(3), 4);
  assertEquals(raid.onHumanCapture(9), "wave");
  assertEquals(raid.wave, 10);
  assertEquals(raid.onHumanCapture(10), "win");
  assertEquals(raid.ended, true);
});

Deno.test("raid fails on wipe, enemy capture, or empty lobby", () => {
  const wipe = new RaidMatch({ humanTeam: "B", expectedHumans: 2 });
  wipe.tryStart(2);
  assertEquals(
    wipe.allHumansDead([
      { team: "B", alive: false },
      { team: "B", alive: false },
    ]),
    true,
  );
  assertEquals(wipe.onWipe(), "fail");
  assertEquals(wipe.failReason, "wipe");

  const capture = new RaidMatch({ humanTeam: "A", expectedHumans: 2 });
  capture.tryStart(2);
  assertEquals(capture.onEnemyCapture(), "fail");
  assertEquals(capture.failReason, "enemy_capture");

  const empty = new RaidMatch({ humanTeam: "A", expectedHumans: 2 });
  empty.tryStart(2);
  assertEquals(empty.onEmpty(), "fail");
  assertEquals(empty.failReason, "empty");

  const timeout = new RaidMatch({ humanTeam: "A", expectedHumans: 2 });
  timeout.tryStart(2);
  assertEquals(timeout.onTimeout(), "fail");
  assertEquals(timeout.failReason, "timeout");
});

Deno.test("raid does not start with fewer than the reserved humans", () => {
  const raid = new RaidMatch({ humanTeam: "A", expectedHumans: 3 });
  assertEquals(raid.tryStart(1), false);
  assertEquals(raid.tryStart(2), false);
  assertEquals(raid.tryStart(3), true);
});

Deno.test("solo unlock raid starts immediately with one human", () => {
  const raid = new RaidMatch({
    humanTeam: "A",
    expectedHumans: 2,
    allowSolo: true,
    nowMs: 1_000,
    startWaitSeconds: 30,
  });
  assertEquals(raid.allowSolo, true);
  // Unlock testing skips the start wait: doors open on the first human.
  assertEquals(raid.startWaitElapsed(1_000), false);
  assertEquals(raid.tryStart(1), true);
  assertEquals(raid.started, true);
  assertEquals(raid.expectedHumans, 1);

  const empty = new RaidMatch({
    humanTeam: "A",
    allowSolo: true,
    nowMs: 1_000,
  });
  assertEquals(empty.tryStart(0), false);

  const locked = new RaidMatch({ humanTeam: "A", expectedHumans: 2 });
  assertEquals(locked.allowSolo, false);
  assertEquals(locked.tryStart(1), false);
});

Deno.test("a reserved raid never starts short-handed, even past the start wait", () => {
  const raid = new RaidMatch({
    humanTeam: "A",
    expectedHumans: 3,
    nowMs: 1_000,
    startWaitSeconds: 120,
  });
  assertEquals(raid.startWaitElapsed(120_999), false);
  assertEquals(raid.tryStart(2), false);
  assertEquals(raid.startWaitElapsed(121_000), true);
  assertEquals(raid.tryStart(2), false);
  assertEquals(raid.tryStart(3), true);
  assertEquals(raid.expectedHumans, 3);
});

Deno.test("later joins can raise the reserved human count before start", () => {
  const raid = new RaidMatch({ humanTeam: "A", expectedHumans: 2 });
  raid.raiseExpectedHumans(4);
  assertEquals(raid.expectedHumans, 4);
  assertEquals(raid.tryStart(2), false);
  assertEquals(raid.tryStart(4), true);
});

Deno.test("Crossroads raid bot count uses door and player scaling", () => {
  const raid = new RaidMatch({
    raidId: "crossroads",
    humanTeam: "A",
    expectedHumans: 2,
  });
  assertEquals(raid.planForWave(1).botCount, 2);
  assertEquals(raid.planForWave(2).botCount, 3);
  assertEquals(raid.planForWave(10).botCount, 7);
  raid.raiseExpectedHumans(4);
  assertEquals(raid.planForWave(1).botCount, 3);
});

Deno.test("raid 02 wave plans switch maps and expose scripted encounters", () => {
  const raid = new RaidMatch({
    raidId: "cornfield-levels",
    humanTeam: "A",
    expectedHumans: 2,
  });
  assertEquals(raid.planForWave(1), {
    wave: 1,
    map: "Cornfield",
    nextMap: "Levels",
    botCount: 1,
  });
  assertEquals(raid.planForWave(5), {
    wave: 5,
    map: "Cornfield",
    nextMap: "Levels",
    botCount: 5,
    agentEncounter: { count: 2, delaySeconds: 5 },
  });
  assertEquals(raid.planForWave(6), {
    wave: 6,
    map: "Levels",
    prevMap: "Cornfield",
    botCount: 6,
  });
  assertEquals(raid.planForWave(9).agentEncounter, {
    count: 3,
    delaySeconds: 0,
  });
  assertEquals(raid.planForWave(10), {
    wave: 10,
    map: "Levels",
    prevMap: "Cornfield",
    botCount: 0,
    bossEncounter: {
      count: 2,
      maxHealth: 200,
      scale: 1.3,
      moveSpeedScale: 0.65,
    },
  });
});

Deno.test("Midway bot counts scale with 3 and 4 humans", () => {
  const duo = new RaidMatch({
    raidId: "cornfield-levels",
    humanTeam: "A",
    expectedHumans: 2,
  });
  const trio = new RaidMatch({
    raidId: "cornfield-levels",
    humanTeam: "A",
    expectedHumans: 3,
  });
  const quad = new RaidMatch({
    raidId: "cornfield-levels",
    humanTeam: "A",
    expectedHumans: 4,
  });
  assertEquals(duo.planForWave(1).botCount, 1);
  assertEquals(trio.planForWave(1).botCount, 2);
  assertEquals(quad.planForWave(1).botCount, 3);
  assertEquals(duo.planForWave(6).botCount, 6);
  assertEquals(trio.planForWave(6).botCount, 7);
  assertEquals(quad.planForWave(6).botCount, 8);
  assertEquals(duo.planForWave(10).botCount, 0);
  assertEquals(quad.planForWave(10).botCount, 0);
});

const MAZE_MINI = {
  count: 2,
  maxHealth: 20,
  scale: 0.8,
  moveSpeedScale: 1.3,
  countBonusAtFourPlus: 1,
};

Deno.test("maze raid wins on the 7th door", () => {
  const raid = new RaidMatch({ raidId: "maze", humanTeam: "A" });
  assertEquals(raid.goal, 7);
  assertEquals(raid.initialMap, "Raid02-00");
  assertEquals(raid.tryStart(2), true);
  assertEquals(raid.wave, 1);
  assertEquals(raid.waveForScore(0), 1);
  assertEquals(raid.onHumanCapture(6), "wave");
  assertEquals(raid.wave, 7);
  assertEquals(raid.onHumanCapture(7), "win");
  assertEquals(raid.ended, true);
});

Deno.test("maze wave plans resolve the 2-human rosters", () => {
  const raid = new RaidMatch({
    raidId: "maze",
    humanTeam: "A",
    expectedHumans: 2,
  });
  assertEquals(raid.planForWave(1), {
    wave: 1,
    map: "Raid02-00",
    nextMap: "Raid02-01",
    botCount: 2,
  });
  assertEquals(raid.planForWave(2).botCount, 4);
  assertEquals(raid.planForWave(3), {
    wave: 3,
    map: "Raid02-02",
    prevMap: "Raid02-01",
    nextMap: "Raid02-03",
    botCount: 4,
    agentEncounter: { count: 2, delaySeconds: 5 },
  });
  assertEquals(raid.planForWave(4), {
    wave: 4,
    map: "Raid02-03",
    prevMap: "Raid02-02",
    nextMap: "Raid02-04",
    botCount: 2,
    miniEncounter: MAZE_MINI,
  });
  assertEquals(raid.planForWave(6).agentEncounter, {
    count: 3,
    delaySeconds: 0,
  });
  assertEquals(raid.planForWave(6).miniEncounter?.count, 4);
  assertEquals(raid.planForWave(7), {
    wave: 7,
    map: "Raid02-06",
    prevMap: "Raid02-05",
    botCount: 4,
    miniEncounter: { ...MAZE_MINI, count: 4 },
    bossEncounter: {
      count: 2,
      maxHealth: 200,
      scale: 1.3,
      moveSpeedScale: 0.65,
      countBonusAtFourPlus: 1,
    },
  });
});

Deno.test("maze wave plans scale normals and minis for 3 and 4 humans", () => {
  const trio = new RaidMatch({
    raidId: "maze",
    humanTeam: "A",
    expectedHumans: 3,
  });
  assertEquals(trio.planForWave(1).botCount, 3);
  assertEquals(trio.planForWave(4).botCount, 3);
  assertEquals(trio.planForWave(4).miniEncounter?.count, 2);
  assertEquals(trio.planForWave(7).botCount, 5);
  assertEquals(trio.planForWave(7).miniEncounter?.count, 4);
  assertEquals(trio.planForWave(7).bossEncounter?.count, 2);

  const quad = new RaidMatch({
    raidId: "maze",
    humanTeam: "B",
    expectedHumans: 4,
  });
  assertEquals(quad.planForWave(1).botCount, 3);
  assertEquals(quad.planForWave(2).botCount, 5);
  assertEquals(quad.planForWave(3).botCount, 5);
  assertEquals(quad.planForWave(3).miniEncounter, undefined);
  assertEquals(quad.planForWave(4).botCount, 3);
  assertEquals(quad.planForWave(4).miniEncounter?.count, 3);
  assertEquals(quad.planForWave(5).botCount, 5);
  assertEquals(quad.planForWave(5).miniEncounter?.count, 3);
  assertEquals(quad.planForWave(6).botCount, 5);
  assertEquals(quad.planForWave(6).miniEncounter?.count, 5);
  assertEquals(quad.planForWave(7).botCount, 5);
  assertEquals(quad.planForWave(7).miniEncounter?.count, 5);
  assertEquals(quad.planForWave(7).bossEncounter?.count, 3);
});
