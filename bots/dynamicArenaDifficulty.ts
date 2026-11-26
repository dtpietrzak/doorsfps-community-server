/**
 * Per-match dynamic difficulty and door-objective allocator for Arena bots.
 *
 * Applies to all team bots (fill, balance filler, and pool pawns) in Arena
 * modes, symmetrically for Team A and Team B. Grey free-for-all agents are
 * excluded.
 *
 * - Combat modifier (`teamCombatDelayMs`): per-team slowdown (ms) adjusted
 *   gradually whenever a team bot spawns/respawns. Compares the bot team's
 *   top-2 bots' average K/D against the opposing team's single human (or
 *   top-2 humans' average K/D). Resets to 0 on every new match.
 * - Door capture modifier (`objectiveDirective`): per-bot role (`capture`,
 *   `defend`, `slay`) allocated from each team's door-capture lead/deficit,
 *   always keeping at least 1 bot on `capture`.
 * - Tiered adaptivity keyed by `BotDifficulty`:
 *     easy   = most adaptive
 *     medium = middle
 *     hard   = lightest adaptive
 */

import type { BotDifficulty } from "@doors/bot-spec/config";
import type { BotObjectiveDirective, TeamId } from "@doors/bot-spec/model";

export type { BotObjectiveDirective };

export type DynamicArenaTierConfig = Readonly<{
  minCombatDelayMs: number;
  maxCombatDelayMs: number;
  stepUpMs: number;
  stepDownMs: number;
  kdDeadband: number;
  /** Minimum combined kills+deaths on the benchmarked humans + bots before stepping. */
  minSampleEvents: number;
}>;

/**
 * Tiered adaptivity table:
 * - easy (Breezeway): most adaptive
 * - medium (Midway): middle
 * - hard (Terminal): lightest adaptive
 */
export const DYNAMIC_ARENA_TIER_CONFIGS: Record<
  BotDifficulty,
  DynamicArenaTierConfig
> = {
  easy: {
    minCombatDelayMs: 0,
    maxCombatDelayMs: 900,
    stepUpMs: 45,
    stepDownMs: 25,
    kdDeadband: 0.1,
    minSampleEvents: 4,
  },
  medium: {
    minCombatDelayMs: 0,
    maxCombatDelayMs: 600,
    stepUpMs: 30,
    stepDownMs: 25,
    kdDeadband: 0.15,
    minSampleEvents: 4,
  },
  hard: {
    minCombatDelayMs: 0,
    maxCombatDelayMs: 300,
    stepUpMs: 15,
    stepDownMs: 20,
    kdDeadband: 0.25,
    minSampleEvents: 4,
  },
};

export type DynamicArenaPlayerInput = Readonly<{
  id: string;
  team: TeamId;
  isBot: boolean;
  isAgent: boolean;
  kills: number;
  deaths: number;
  spawnedAtTick: number;
}>;

export function dynamicArenaTierConfig(
  difficulty: BotDifficulty,
): DynamicArenaTierConfig {
  return DYNAMIC_ARENA_TIER_CONFIGS[difficulty] ??
    DYNAMIC_ARENA_TIER_CONFIGS.easy;
}

/** Safe non-negative K/D: clamps teamkill-negative kills to 0, floors deaths at 1. */
export function computePlayerKd(kills: number, deaths: number): number {
  const k = Number.isFinite(kills) && kills > 0 ? kills : 0;
  const d = Number.isFinite(deaths) && deaths > 1 ? deaths : 1;
  return k / d;
}

/**
 * Average K/D of the single player (if 1) or top two players (if >= 2).
 * Returns null when the list is empty.
 */
export function topTwoAverageKd(
  players: readonly Pick<DynamicArenaPlayerInput, "kills" | "deaths">[],
): number | null {
  if (players.length === 0) return null;
  let best1 = -1;
  let best2 = -1;
  for (let i = 0; i < players.length; i += 1) {
    const p = players[i]!;
    const kd = computePlayerKd(p.kills, p.deaths);
    if (kd >= best1) {
      best2 = best1;
      best1 = kd;
    } else if (kd > best2) {
      best2 = kd;
    }
  }
  return players.length === 1 ? best1 : (best1 + best2) / 2;
}

/**
 * Step a team's combat slowdown modifier (ms) on a single bot spawn.
 * Positive `botTopKd - humanTopKd` beyond deadband adds delay (slows bots);
 * negative beyond deadband recovers delay back toward `minCombatDelayMs`.
 */
export function stepCombatDelayMs(
  currentMs: number,
  botTopKd: number,
  humanTopKd: number,
  tier: DynamicArenaTierConfig,
): number {
  const cur = Number.isFinite(currentMs) ? currentMs : 0;
  const gap = botTopKd - humanTopKd;
  if (gap > tier.kdDeadband) {
    const scale = gap > 1.0 ? 1.5 : 1.0;
    const next = cur + Math.round(tier.stepUpMs * scale);
    return Math.min(tier.maxCombatDelayMs, Math.max(tier.minCombatDelayMs, next));
  }
  if (gap < -tier.kdDeadband) {
    const next = cur - tier.stepDownMs;
    return Math.min(tier.maxCombatDelayMs, Math.max(tier.minCombatDelayMs, next));
  }
  return Math.min(tier.maxCombatDelayMs, Math.max(tier.minCombatDelayMs, cur));
}

/**
 * How many bots on a team of `botCount` should target the enemy door (`capture`)
 * given `doorDiff = ownDoors - enemyDoors` and arena tier.
 * Always returns at least 1 when `botCount >= 1`.
 */
export function captureBotCountFor(
  botCount: number,
  doorDiff: number,
  difficulty: BotDifficulty,
): number {
  if (botCount <= 0) return 0;
  if (botCount === 1) return 1;

  let desired: number;
  if (difficulty === "easy") {
    // Breezeway: most adaptive — peels down to 1 capture bot as soon as leading.
    if (doorDiff <= -2) desired = Math.ceil(botCount * 0.75);
    else if (doorDiff === -1) desired = Math.ceil(botCount * 0.5);
    else desired = 1;
  } else if (difficulty === "medium") {
    // Midway: middle adaptivity.
    if (doorDiff <= -2) desired = botCount;
    else if (doorDiff === -1) desired = Math.ceil(botCount * 0.75);
    else if (doorDiff === 0) desired = Math.floor(botCount * 0.5);
    else desired = 1;
  } else {
    // Terminal (hard): lightest adaptive — holds firmer door pressure.
    if (doorDiff <= -1) desired = botCount;
    else if (doorDiff === 0) desired = Math.ceil(botCount * 0.67);
    else if (doorDiff === 1) desired = Math.floor(botCount * 0.5);
    else desired = 1;
  }

  return Math.max(1, Math.min(botCount, desired));
}

/**
 * Deterministically allocate `capture` / `defend` / `slay` directives across
 * a team's bots. Stable-sorted by bot id so assignments do not thrash.
 */
export function computeTeamObjectiveDirectives(
  teamBotIds: readonly string[],
  doorDiff: number,
  difficulty: BotDifficulty,
): Map<string, BotObjectiveDirective> {
  const out = new Map<string, BotObjectiveDirective>();
  if (teamBotIds.length === 0) return out;

  const sorted = [...teamBotIds].sort();
  const n = sorted.length;
  const captureCount = captureBotCountFor(n, doorDiff, difficulty);
  const remaining = n - captureCount;

  // How many of the non-capture bots defend own door vs roam for kills (`slay`).
  let defendCount = 0;
  if (remaining > 0) {
    if (doorDiff < 0) {
      // Trailing: non-capturers defend home door rather than aimlessly roaming.
      defendCount = remaining;
    } else if (
      (difficulty === "easy" && doorDiff >= 1) ||
      (difficulty === "medium" && doorDiff >= 2)
    ) {
      // Clear lead on Breezeway/Midway: keep 1 defender when >= 2 extras, rest slay.
      defendCount = remaining >= 2 ? 1 : 0;
    } else if (difficulty === "hard" && doorDiff === 0) {
      // Terminal tied: extra bots guard home door.
      defendCount = remaining;
    } else {
      // Balanced 50/50 split (first extra defends, second slays, etc.).
      defendCount = Math.ceil(remaining / 2);
    }
  }

  for (let i = 0; i < n; i += 1) {
    const id = sorted[i]!;
    if (i < captureCount) {
      out.set(id, "capture");
    } else if (i < captureCount + defendCount) {
      out.set(id, "defend");
    } else {
      out.set(id, "slay");
    }
  }
  return out;
}

/**
 * Stateful per-match director owned by BotManager in Arena modes.
 */
export class DynamicArenaDirector {
  private difficulty: BotDifficulty;
  private combatDelayMs: { A: number; B: number } = { A: 0, B: 0 };
  private readonly lastSpawnTickByBot = new Map<string, number>();
  private readonly directivesByBot = new Map<string, BotObjectiveDirective>();
  private lastScoreA = Number.NaN;
  private lastScoreB = Number.NaN;
  private lastRosterKey = "";

  constructor(difficulty: BotDifficulty) {
    this.difficulty = difficulty;
  }

  public setDifficulty(difficulty: BotDifficulty): void {
    if (this.difficulty === difficulty) return;
    this.difficulty = difficulty;
    const tier = dynamicArenaTierConfig(difficulty);
    this.combatDelayMs.A = Math.min(
      tier.maxCombatDelayMs,
      Math.max(tier.minCombatDelayMs, this.combatDelayMs.A),
    );
    this.combatDelayMs.B = Math.min(
      tier.maxCombatDelayMs,
      Math.max(tier.minCombatDelayMs, this.combatDelayMs.B),
    );
    // Force objective recomputation on next tick with new tier curve.
    this.lastRosterKey = "";
  }

  /** Reset all per-match dynamic state back to baseline (0 delay, fresh spawns). */
  public reset(): void {
    this.combatDelayMs = { A: 0, B: 0 };
    this.lastSpawnTickByBot.clear();
    this.directivesByBot.clear();
    this.lastScoreA = Number.NaN;
    this.lastScoreB = Number.NaN;
    this.lastRosterKey = "";
  }

  public getCombatDelayMs(team: TeamId): number {
    return this.combatDelayMs[team];
  }

  public getDirective(botId: string): BotObjectiveDirective | undefined {
    return this.directivesByBot.get(botId);
  }

  /**
   * Observe the live roster and team scores once per think frame.
   * Steps combat delay whenever a team bot spawns/respawns and updates
   * objective directives when scores or team bot rosters change.
   */
  public onTick(
    players: readonly DynamicArenaPlayerInput[],
    teamScores: Readonly<{ A: number; B: number }>,
    matchOver: boolean,
  ): void {
    if (matchOver) return;

    const liveBotIds = new Set<string>();
    const teamBotsA: string[] = [];
    const teamBotsB: string[] = [];

    for (let i = 0; i < players.length; i += 1) {
      const p = players[i]!;
      if (!p.isBot || p.isAgent) continue;
      liveBotIds.add(p.id);
      if (p.team === "A") teamBotsA.push(p.id);
      else teamBotsB.push(p.id);

      const prevSpawn = this.lastSpawnTickByBot.get(p.id);
      if (prevSpawn === undefined) {
        this.lastSpawnTickByBot.set(p.id, p.spawnedAtTick);
        // Mid-match bot join (past tick 0) counts as a spawn nudge.
        if (p.spawnedAtTick > 0) {
          this.adjustForTeam(p.team, players);
        }
      } else if (p.spawnedAtTick !== prevSpawn) {
        this.lastSpawnTickByBot.set(p.id, p.spawnedAtTick);
        if (p.spawnedAtTick > 0) {
          this.adjustForTeam(p.team, players);
        }
      }
    }

    // Prune departed bots.
    for (const id of this.lastSpawnTickByBot.keys()) {
      if (!liveBotIds.has(id)) this.lastSpawnTickByBot.delete(id);
    }

    teamBotsA.sort();
    teamBotsB.sort();
    const rosterKey = `A:${teamBotsA.join(",")}|B:${teamBotsB.join(",")}`;
    if (
      rosterKey !== this.lastRosterKey ||
      teamScores.A !== this.lastScoreA ||
      teamScores.B !== this.lastScoreB
    ) {
      this.lastRosterKey = rosterKey;
      this.lastScoreA = teamScores.A;
      this.lastScoreB = teamScores.B;
      this.directivesByBot.clear();
      const mapA = computeTeamObjectiveDirectives(
        teamBotsA,
        teamScores.A - teamScores.B,
        this.difficulty,
      );
      for (const [id, dir] of mapA) this.directivesByBot.set(id, dir);
      const mapB = computeTeamObjectiveDirectives(
        teamBotsB,
        teamScores.B - teamScores.A,
        this.difficulty,
      );
      for (const [id, dir] of mapB) this.directivesByBot.set(id, dir);
    }
  }

  private adjustForTeam(
    botTeam: TeamId,
    players: readonly DynamicArenaPlayerInput[],
  ): void {
    const enemyTeam: TeamId = botTeam === "A" ? "B" : "A";
    const enemyHumans: DynamicArenaPlayerInput[] = [];
    const teamBots: DynamicArenaPlayerInput[] = [];
    let sampleEvents = 0;

    for (let i = 0; i < players.length; i += 1) {
      const p = players[i]!;
      if (p.isAgent) continue;
      if (!p.isBot && p.team === enemyTeam) {
        enemyHumans.push(p);
        sampleEvents += Math.max(0, p.kills) + Math.max(0, p.deaths);
      } else if (p.isBot && p.team === botTeam) {
        teamBots.push(p);
        sampleEvents += Math.max(0, p.kills) + Math.max(0, p.deaths);
      }
    }

    const humanTargetKd = topTwoAverageKd(enemyHumans);
    const botTopKd = topTwoAverageKd(teamBots);
    if (humanTargetKd === null || botTopKd === null) return;

    const tier = dynamicArenaTierConfig(this.difficulty);
    if (sampleEvents < tier.minSampleEvents) return;

    this.combatDelayMs[botTeam] = stepCombatDelayMs(
      this.combatDelayMs[botTeam],
      botTopKd,
      humanTargetKd,
      tier,
    );
  }
}
