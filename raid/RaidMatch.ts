/**
 * Co-op raid ruleset: one human team vs simple bot waves.
 *
 * GameServer owns side effects (bots, endMatch, packets). This module is the
 * wave / win / fail policy so it can be unit-tested without a live server.
 */

import {
  getRaid,
  getRaidBotCount,
  RAID_DEFAULT_MAX_TIME_SECONDS,
  RAID_DOOR_GOAL,
  RAID_FIRST_ID,
  RAID_MIN_PLAYERS,
  RAID_RESPAWN_DELAY_MS,
  RAID_START_WAIT_SECONDS,
} from "../shared/campaign/raids.ts";
import type {
  RaidAgentEncounter,
  RaidBossEncounter,
  RaidMiniEncounter,
  RaidRound,
} from "../shared/campaign/raids.ts";
import type { TeamId } from "../protocol/network.ts";

export type RaidFailReason = "wipe" | "enemy_capture" | "empty" | "timeout";

export type RaidHudState = {
  door: number;
  goal: number;
  respawnMs: number;
  title: string;
  /** Current stage map name (catalog). */
  map?: string;
  /** Previous stage map when it differs from the current one. */
  prevMap?: string;
  /** Next stage map when it differs from the current one. */
  nextMap?: string;
};

export type RaidWavePlan = {
  wave: number;
  map: string;
  /** Prior wave map when it differs from `map`; otherwise omitted. */
  prevMap?: string;
  /** Following wave map when it differs from `map`; otherwise omitted. */
  nextMap?: string;
  /** Normal enemy bots. Zero on boss-only rounds; mixed finales keep them. */
  botCount: number;
  agentEncounter?: RaidAgentEncounter;
  bossEncounter?: RaidBossEncounter;
  miniEncounter?: RaidMiniEncounter;
};

export class RaidMatch {
  readonly raidId: string;
  readonly title: string;
  readonly humanTeam: TeamId;
  readonly goal: number;
  readonly maxTimeSeconds: number;
  readonly respawnMs: number;
  readonly initialMap: string;
  readonly rounds: readonly RaidRound[];
  expectedHumans: number;
  /**
   * Authority-verified solo test (`unlock raids`): one human may start and
   * hold the raid. Once started, the usual partial-start rule applies, so
   * bot scaling follows the connected count.
   */
  readonly allowSolo: boolean;
  started = false;
  ended = false;
  failReason: RaidFailReason | null = null;
  wave = 0;
  private readonly activatedAtMs: number;
  readonly startWaitSeconds: number;

  constructor(input: {
    raidId?: string;
    title?: string;
    humanTeam: TeamId;
    expectedHumans?: number;
    allowSolo?: boolean;
    goal?: number;
    maxTimeSeconds?: number;
    nowMs?: number;
    startWaitSeconds?: number;
  }) {
    const catalog = getRaid(input.raidId ?? RAID_FIRST_ID);
    this.raidId = catalog?.id ?? input.raidId ?? RAID_FIRST_ID;
    this.title = input.title ?? catalog?.title ?? "Crossroads";
    this.initialMap = catalog?.map ?? "Crossroads";
    this.rounds = catalog?.rounds ?? [];
    this.humanTeam = input.humanTeam;
    this.allowSolo = input.allowSolo === true;
    this.goal = input.goal ?? catalog?.doorGoal ?? RAID_DOOR_GOAL;
    this.maxTimeSeconds = Math.max(
      1,
      Math.floor(
        input.maxTimeSeconds ??
          catalog?.maxTimeSeconds ??
          RAID_DEFAULT_MAX_TIME_SECONDS,
      ),
    );
    // Sent to clients for the raid spectate / respawn countdown.
    this.respawnMs = RAID_RESPAWN_DELAY_MS;
    this.expectedHumans = Math.max(
      RAID_MIN_PLAYERS,
      Math.floor(input.expectedHumans ?? RAID_MIN_PLAYERS),
    );
    this.activatedAtMs = input.nowMs ?? Date.now();
    this.startWaitSeconds = Math.max(
      1,
      Math.floor(input.startWaitSeconds ?? RAID_START_WAIT_SECONDS),
    );
  }

  startWaitElapsed(nowMs: number = Date.now()): boolean {
    return nowMs - this.activatedAtMs >= this.startWaitSeconds * 1000;
  }

  raiseExpectedHumans(count: number): void {
    if (this.started || this.ended) return;
    const next = Math.max(RAID_MIN_PLAYERS, Math.floor(count));
    if (next > this.expectedHumans) this.expectedHumans = next;
  }

  get enemyTeam(): TeamId {
    return this.humanTeam === "A" ? "B" : "A";
  }

  hud(humanScore: number): RaidHudState {
    const plan = this.planForWave(
      this.started ? this.wave : this.waveForScore(humanScore),
    );
    return {
      door: Math.max(0, Math.min(this.goal, Math.trunc(humanScore))),
      goal: this.goal,
      respawnMs: this.respawnMs,
      title: this.title,
      map: plan.map,
      ...(plan.prevMap ? { prevMap: plan.prevMap } : {}),
      ...(plan.nextMap ? { nextMap: plan.nextMap } : {}),
    };
  }

  /** After a human capture at score S, next wave is S+1. */
  waveForScore(humanScore: number): number {
    return Math.max(1, Math.min(this.goal, Math.trunc(humanScore) + 1));
  }

  /** Catalog map name for a 1-based wave (clamped). */
  mapForWave(wave: number): string {
    const n = Math.max(1, Math.min(this.goal, Math.trunc(wave)));
    return this.rounds[n - 1]?.map ?? this.initialMap;
  }

  /** Nearest earlier wave whose map name differs from `map`. */
  private distinctPrevMap(wave: number, map: string): string | null {
    for (let i = wave - 1; i >= 1; i--) {
      const name = this.mapForWave(i);
      if (name !== map) return name;
    }
    return null;
  }

  /** Nearest later wave whose map name differs from `map`. */
  private distinctNextMap(wave: number, map: string): string | null {
    for (let i = wave + 1; i <= this.goal; i++) {
      const name = this.mapForWave(i);
      if (name !== map) return name;
    }
    return null;
  }

  /** Catalogued map and encounter policy for a 1-based raid wave. */
  planForWave(wave: number = this.wave): RaidWavePlan {
    const n = Math.max(1, Math.min(this.goal, Math.trunc(wave)));
    const round = this.rounds[n - 1];
    const humans = this.expectedHumans;
    const catalogBoss = round?.bossEncounter;
    // Explicit per-round counts win; otherwise boss-only rounds field zero
    // normals and older raids keep their default (formula or wave number).
    const midwayPartyBonus = this.raidId === "cornfield-levels" && !catalogBoss
      ? (humans >= 3 ? 1 : 0) + (humans >= 4 ? 1 : 0)
      : 0;
    const normalBase = round?.normalBots ??
      (catalogBoss
        ? 0
        : this.raidId === RAID_FIRST_ID
        ? getRaidBotCount(n, humans)
        : n + midwayPartyBonus);
    const botCount = normalBase +
      (humans >= 3 ? round?.normalBonusAtThreePlus ?? 0 : 0);
    const bossCount = catalogBoss
      ? catalogBoss.count +
        (humans >= 4 ? catalogBoss.countBonusAtFourPlus ?? 0 : 0)
      : 0;
    const catalogMini = round?.miniEncounter;
    const miniCount = catalogMini
      ? catalogMini.count +
        (humans >= 4 ? catalogMini.countBonusAtFourPlus ?? 0 : 0)
      : 0;
    const map = round?.map ?? this.initialMap;
    const prevName = this.distinctPrevMap(n, map);
    const nextName = this.distinctNextMap(n, map);
    return {
      wave: n,
      map,
      ...(prevName ? { prevMap: prevName } : {}),
      ...(nextName ? { nextMap: nextName } : {}),
      botCount,
      ...(round?.agentEncounter
        ? { agentEncounter: round.agentEncounter }
        : {}),
      ...(catalogBoss ? { bossEncounter: { ...catalogBoss, count: bossCount } } : {}),
      ...(catalogMini ? { miniEncounter: { ...catalogMini, count: miniCount } } : {}),
    };
  }

  botName(index: number): string {
    return index <= 1 ? "bot" : `bot${index}`;
  }

  botId(index: number): string {
    return `bot:raid-${index}`;
  }

  /**
   * `loadedHumans` counts party members whose client finished building the
   * map. The whole reserved party must be in before doors open; a straggler
   * past the start wait gets the party kicked instead (GameServer).
   */
  tryStart(loadedHumans: number): boolean {
    if (this.started || this.ended) return false;
    if (loadedHumans < 1) return false;
    // Authority-verified solo tests start on the first human instead of
    // holding closed doors through the start wait.
    if (!this.allowSolo && loadedHumans < this.expectedHumans) return false;
    this.expectedHumans = Math.min(this.expectedHumans, loadedHumans);
    this.started = true;
    this.wave = 1;
    return true;
  }

  onHumanCapture(humanScore: number): "wave" | "win" {
    if (this.ended) return "win";
    if (humanScore >= this.goal) {
      this.ended = true;
      return "win";
    }
    this.wave = this.waveForScore(humanScore);
    return "wave";
  }

  onEnemyCapture(): "fail" {
    this.ended = true;
    this.failReason = "enemy_capture";
    return "fail";
  }

  onWipe(): "fail" {
    this.ended = true;
    this.failReason = "wipe";
    return "fail";
  }

  onEmpty(): "fail" {
    this.ended = true;
    this.failReason = "empty";
    return "fail";
  }

  onTimeout(): "fail" {
    this.ended = true;
    this.failReason = "timeout";
    return "fail";
  }

  /** Every connected human on the raid team is dead at once. */
  allHumansDead(humans: readonly { team: TeamId; alive: boolean }[]): boolean {
    const ours = humans.filter((h) => h.team === this.humanTeam);
    return ours.length > 0 && ours.every((h) => !h.alive);
  }
}
