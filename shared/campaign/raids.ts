/**
 * Co-op raid catalog shared by the client and authority.
 *
 * Keep this free of rendering/gameplay dependencies: the authority uses it to
 * validate unlocks and rewards, while the client uses the same stable ids to
 * select a raid. Add new released raids here before wiring their runtime.
 */

import { RAID_RESPAWN_DELAY_MS as GAME_RAID_RESPAWN_DELAY_MS } from "../sim/game.ts";

export const RAID_MIN_PLAYERS = 2;
export const RAID_MAX_PLAYERS = 4;
export const RAID_DOOR_GOAL = 10;
/** Fallback when a catalog row omits a time limit. */
export const RAID_DEFAULT_MAX_TIME_SECONDS = 4 * 60;
/** Playtest guesses — Breezeway 10 same-map doors. */
export const RAID_BREEZEWAY_MAX_TIME_SECONDS = 4 * 60;
/** Playtest guesses — Midway two maps, agents, bosses. */
export const RAID_MIDWAY_MAX_TIME_SECONDS = 5 * 60;
/** Playtest guesses — Terminal seven maps + mixed finale. */
export const RAID_TERMINAL_MAX_TIME_SECONDS = 6 * 60;
/** First raid party to assemble holds the occupancy this long to invite, vote, and Let's Go. */
export const RAID_ASSEMBLE_LOCK_SECONDS = 5 * 60;
/** Safety cap while a holder is allocating / in-match (released on party complete). */
export const RAID_PLAYING_LOCK_SECONDS = 45 * 60;
/** Accumulated AFK during a live raid before the player is removed. */
export const RAID_AFK_MAX_MS = 60_000;
/** Spectate / respawn countdown while a teammate is still up. */
export const RAID_RESPAWN_DELAY_MS = GAME_RAID_RESPAWN_DELAY_MS;
export const RAID_WIN_REWARD = { xp: 15, coins: 15 } as const;
/** Failed co-op raids sit on game-over, then return everyone to the menu. */
export const RAID_FAIL_RETURN_SECONDS = 60;
/** Win sit so XP shows, then the exclusive slot is released. */
export const RAID_WIN_RETURN_SECONDS = 20;
/**
 * Doors stay shut until every reserved party member has loaded the map. Past
 * this wait the whole party is kicked so the slot frees for the next one.
 */
export const RAID_START_WAIT_SECONDS = 120;
/** A load-timeout party's stale join tokens are refused for this long. */
export const RAID_LOAD_TIMEOUT_PARTY_BLOCK_MS = 10 * 60_000;

/** Crossroads raid enemy count for a door and human roster size. */
export function getRaidBotCount(doors: number, players: number): number {
  const doorScaling = 0.4;
  const playerScaling = 0.7;
  return Math.ceil((doors * doorScaling * players) * playerScaling) + 1;
}

export const RAID_TEAM_IDS = ["A", "B"] as const;
export type RaidTeamId = (typeof RAID_TEAM_IDS)[number];

export type RaidAgentEncounter = {
  /** Grey agents to drop at the human team's door. */
  count: number;
  /** Seconds after the round starts before the drop. */
  delaySeconds: number;
};

export type RaidBossEncounter = {
  count: number;
  maxHealth: number;
  /** Visual and authoritative hit-volume scale. */
  scale: number;
  /** Multiplier on the normal horizontal movement budget. */
  moveSpeedScale: number;
  /** Extra bosses when the roster has 4 humans. */
  countBonusAtFourPlus?: number;
};

export type RaidMiniEncounter = {
  /** Fast, fragile bots for this round. */
  count: number;
  maxHealth: number;
  /** Visual and authoritative hit-volume scale. */
  scale: number;
  /** Multiplier on the normal horizontal movement budget. */
  moveSpeedScale: number;
  /** Extra minis when the roster has 4 humans. */
  countBonusAtFourPlus?: number;
};

export type RaidRound = {
  map: string;
  /** Explicit normal-bot base count; otherwise the raid default applies. */
  normalBots?: number;
  /** Extra normals when the roster has 3+ humans. */
  normalBonusAtThreePlus?: number;
  agentEncounter?: RaidAgentEncounter;
  bossEncounter?: RaidBossEncounter;
  miniEncounter?: RaidMiniEncounter;
};

type RaidDefinition = {
  id: string;
  title: string;
  raidNumber: number;
  /** Initial map; `rounds` controls later in-raid map transitions. */
  map: string;
  rounds: readonly RaidRound[];
  doorGoal: number;
  maxTimeSeconds: number;
  reward: typeof RAID_WIN_REWARD;
  nextRaidId: string | null;
};

export const RAIDS = [
  {
    id: "crossroads",
    title: "Breezeway",
    raidNumber: 1,
    map: "Crossroads",
    rounds: [
      { map: "Crossroads" },
      { map: "Crossroads" },
      { map: "Crossroads" },
      { map: "Crossroads" },
      { map: "Crossroads" },
      { map: "Crossroads" },
      { map: "Crossroads" },
      { map: "Crossroads" },
      { map: "Crossroads" },
      { map: "Crossroads" },
    ],
    doorGoal: RAID_DOOR_GOAL,
    maxTimeSeconds: RAID_BREEZEWAY_MAX_TIME_SECONDS,
    reward: RAID_WIN_REWARD,
    nextRaidId: "cornfield-levels",
  },
  {
    id: "cornfield-levels",
    title: "Midway",
    raidNumber: 2,
    map: "Cornfield",
    rounds: [
      { map: "Cornfield" },
      { map: "Cornfield" },
      { map: "Cornfield" },
      { map: "Cornfield" },
      {
        map: "Cornfield",
        agentEncounter: { count: 2, delaySeconds: 5 },
      },
      { map: "Levels" },
      { map: "Levels" },
      { map: "Levels" },
      {
        map: "Levels",
        agentEncounter: { count: 3, delaySeconds: 0 },
      },
      {
        map: "Levels",
        bossEncounter: {
          count: 2,
          maxHealth: 200,
          scale: 1.3,
          moveSpeedScale: 0.65,
        },
      },
    ],
    doorGoal: RAID_DOOR_GOAL,
    maxTimeSeconds: RAID_MIDWAY_MAX_TIME_SECONDS,
    reward: RAID_WIN_REWARD,
    nextRaidId: "maze",
  },
  {
    id: "maze",
    title: "Terminal",
    raidNumber: 3,
    map: "Raid02-00",
    rounds: [
      {
        map: "Raid02-00",
        normalBots: 2,
        normalBonusAtThreePlus: 1,
      },
      {
        map: "Raid02-01",
        normalBots: 4,
        normalBonusAtThreePlus: 1,
      },
      {
        map: "Raid02-02",
        normalBots: 4,
        normalBonusAtThreePlus: 1,
        agentEncounter: { count: 2, delaySeconds: 5 },
      },
      {
        map: "Raid02-03",
        normalBots: 2,
        normalBonusAtThreePlus: 1,
        miniEncounter: {
          count: 2,
          maxHealth: 20,
          scale: 0.8,
          moveSpeedScale: 1.3,
          countBonusAtFourPlus: 1,
        },
      },
      {
        map: "Raid02-04",
        normalBots: 4,
        normalBonusAtThreePlus: 1,
        miniEncounter: {
          count: 2,
          maxHealth: 20,
          scale: 0.8,
          moveSpeedScale: 1.3,
          countBonusAtFourPlus: 1,
        },
      },
      {
        map: "Raid02-05",
        normalBots: 4,
        normalBonusAtThreePlus: 1,
        agentEncounter: { count: 3, delaySeconds: 0 },
        miniEncounter: {
          count: 4,
          maxHealth: 20,
          scale: 0.8,
          moveSpeedScale: 1.3,
          countBonusAtFourPlus: 1,
        },
      },
      {
        map: "Raid02-06",
        normalBots: 4,
        normalBonusAtThreePlus: 1,
        miniEncounter: {
          count: 4,
          maxHealth: 20,
          scale: 0.8,
          moveSpeedScale: 1.3,
          countBonusAtFourPlus: 1,
        },
        bossEncounter: {
          count: 2,
          maxHealth: 200,
          scale: 1.3,
          moveSpeedScale: 0.65,
          countBonusAtFourPlus: 1,
        },
      },
    ],
    doorGoal: 7,
    maxTimeSeconds: RAID_TERMINAL_MAX_TIME_SECONDS,
    reward: RAID_WIN_REWARD,
    nextRaidId: null,
  },
] as const satisfies readonly RaidDefinition[];

export type Raid = (typeof RAIDS)[number];
export type RaidId = Raid["id"];

export const RAID_FIRST_ID: RaidId = "crossroads";

/** Occupancy modeId used by placement / inventory. Not an OfficialModeId. */
export const RAID_OCCUPANCY_MODE_ID = "raid" as const;

export function isRaidOccupancyModeId(value: unknown): value is "raid" {
  return value === RAID_OCCUPANCY_MODE_ID;
}

export function isRaidTeamId(value: unknown): value is RaidTeamId {
  return typeof value === "string" &&
    (RAID_TEAM_IDS as readonly string[]).includes(value);
}

/** Raid02-* maps are raid-only and must not appear in community map votes. */
export function isRaidOnlyMapName(name: string): boolean {
  return /^Raid02-\d+$/i.test(name.trim());
}

export function isRaidId(value: unknown): value is RaidId {
  return typeof value === "string" && RAIDS.some((raid) => raid.id === value);
}

export function getRaid(raidId: unknown): Raid | null {
  if (typeof raidId !== "string") return null;
  return RAIDS.find((raid) => raid.id === raidId) ?? null;
}

export function getRaidByTitle(title: unknown): Raid | null {
  if (typeof title !== "string" || !title.trim()) return null;
  const needle = title.trim().toLowerCase();
  return RAIDS.find((raid) => raid.title.toLowerCase() === needle) ?? null;
}

/** 1-based wave map name from a raid catalog entry. */
export function raidMapForWave(
  raid: Pick<Raid, "map" | "rounds" | "doorGoal">,
  wave: number,
): string {
  const goal = Math.max(1, Math.floor(raid.doorGoal));
  const n = Math.max(1, Math.min(goal, Math.trunc(wave)));
  return raid.rounds[n - 1]?.map ?? raid.map;
}

/**
 * Current / previous / next stage map names for a 1-based wave.
 * Neighbors are the nearest *distinct* catalog maps (so Levels waves keep
 * Cornfield as `prevMap` after the switch).
 */
export function raidStageMaps(
  raid: Pick<Raid, "map" | "rounds" | "doorGoal">,
  wave: number,
): { map: string; prevMap?: string; nextMap?: string } {
  const goal = Math.max(1, Math.floor(raid.doorGoal));
  const n = Math.max(1, Math.min(goal, Math.trunc(wave)));
  const map = raidMapForWave(raid, n);
  let prevName: string | null = null;
  for (let i = n - 1; i >= 1; i--) {
    const name = raidMapForWave(raid, i);
    if (name !== map) {
      prevName = name;
      break;
    }
  }
  let nextName: string | null = null;
  for (let i = n + 1; i <= goal; i++) {
    const name = raidMapForWave(raid, i);
    if (name !== map) {
      nextName = name;
      break;
    }
  }
  return {
    map,
    ...(prevName ? { prevMap: prevName } : {}),
    ...(nextName ? { nextMap: nextName } : {}),
  };
}

/** Compact lobby label: `5 min` when exact, otherwise `m:ss`. */
export function formatRaidMaxTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  if (total % 60 === 0) {
    const minutes = total / 60;
    return `${minutes} min`;
  }
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

/**
 * Raid 01 is always unlocked. Later catalog entries require the previous
 * raid's completion (by raidNumber).
 */
export function raidUnlocked(
  playedIds: readonly string[],
  raidId: string,
): boolean {
  const raid = getRaid(raidId);
  if (!raid) return false;
  if (raid.raidNumber <= 1) return true;
  const previous = RAIDS.find((entry) =>
    entry.raidNumber === raid.raidNumber - 1
  );
  if (!previous) return false;
  return playedIds.includes(previous.id);
}

export function availableRaidIds(playedIds: readonly string[]): RaidId[] {
  return RAIDS.filter((raid) => raidUnlocked(playedIds, raid.id)).map(
    (raid) => raid.id,
  );
}

/** First locked catalog entry after the latest completion, if any. */
export function nextLockedRaidId(
  playedIds: readonly string[],
): RaidId | null {
  const next = RAIDS.find((raid) => !raidUnlocked(playedIds, raid.id));
  return next?.id ?? null;
}

/** Raids every listed player has unlocked. Empty input → raid 01 only. */
export function intersectAvailableRaidIds(
  memberCompletedIds: readonly (readonly string[])[],
): RaidId[] {
  if (memberCompletedIds.length === 0) return availableRaidIds([]);
  return RAIDS.filter((raid) =>
    memberCompletedIds.every((played) => raidUnlocked(played, raid.id))
  ).map((raid) => raid.id);
}

export type RaidBallot = {
  playerId: number;
  raidId?: string | null;
  team?: string | null;
};

export type RaidVoteResolution = {
  raidCounts: Record<RaidId, number>;
  teamCounts: Record<RaidTeamId, number>;
  winningRaidId: RaidId | null;
  winningTeam: RaidTeamId | null;
  completeVoteCount: number;
};

function pluralityWinner<T extends string>(
  counts: Readonly<Record<T, number>>,
  leaderChoice: T | null,
  candidates: readonly T[],
): T | null {
  let best = 0;
  const tied: T[] = [];
  for (const id of candidates) {
    const n = counts[id] ?? 0;
    if (n > best) {
      best = n;
      tied.length = 0;
      tied.push(id);
    } else if (n === best && n > 0) {
      tied.push(id);
    }
  }
  if (best === 0) return null;
  if (tied.length === 1) return tied[0]!;
  if (leaderChoice && tied.includes(leaderChoice)) return leaderChoice;
  return null;
}

/**
 * Plurality vote among party ballots. Invalid raid picks are ignored.
 * Ties break to the leader's vote when they picked one of the tied options.
 */
export function resolveRaidVotes(
  ballots: readonly RaidBallot[],
  available: readonly RaidId[],
  leaderPlayerId: number,
): RaidVoteResolution {
  const availableSet = new Set(available);
  const raidCounts = Object.fromEntries(
    RAIDS.map((raid) => [raid.id, 0]),
  ) as Record<RaidId, number>;
  const teamCounts: Record<RaidTeamId, number> = { A: 0, B: 0 };
  let completeVoteCount = 0;
  let leaderRaid: RaidId | null = null;
  let leaderTeam: RaidTeamId | null = null;

  for (const ballot of ballots) {
    const raidId = isRaidId(ballot.raidId) && availableSet.has(ballot.raidId)
      ? ballot.raidId
      : null;
    const team = isRaidTeamId(ballot.team) ? ballot.team : null;
    if (raidId) {
      raidCounts[raidId] += 1;
      if (ballot.playerId === leaderPlayerId) leaderRaid = raidId;
    }
    if (team) {
      teamCounts[team] += 1;
      if (ballot.playerId === leaderPlayerId) leaderTeam = team;
    }
    if (raidId && team) completeVoteCount += 1;
  }

  return {
    raidCounts,
    teamCounts,
    winningRaidId: pluralityWinner(raidCounts, leaderRaid, available),
    winningTeam: pluralityWinner(teamCounts, leaderTeam, RAID_TEAM_IDS),
    completeVoteCount,
  };
}
