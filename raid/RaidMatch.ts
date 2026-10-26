/** Public build: the raid ruleset is not part of the community server. */

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
  map?: string;
  prevMap?: string;
  nextMap?: string;
};

export type RaidWavePlan = {
  wave: number;
  map: string;
  prevMap?: string;
  nextMap?: string;
  botCount: number;
  agentEncounter?: RaidAgentEncounter;
  bossEncounter?: RaidBossEncounter;
  miniEncounter?: RaidMiniEncounter;
};

export const RAID_UNAVAILABLE_MESSAGE =
  "Raid mode is not available in the community server.";

export class RaidMatch {
  readonly raidId: string = "";
  readonly title: string = "";
  readonly humanTeam: TeamId = "A";
  readonly goal: number = 0;
  readonly maxTimeSeconds: number = 0;
  readonly respawnMs: number = 0;
  readonly initialMap: string = "";
  readonly rounds: readonly RaidRound[] = [];
  expectedHumans = 0;
  readonly allowSolo: boolean = false;
  started = false;
  ended = false;
  failReason: RaidFailReason | null = null;
  wave = 0;
  readonly startWaitSeconds: number = 0;

  constructor(_input: {
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
    throw new Error(RAID_UNAVAILABLE_MESSAGE);
  }

  startWaitElapsed(_nowMs?: number): boolean {
    return false;
  }
  raiseExpectedHumans(_count: number): void {}
  get enemyTeam(): TeamId {
    return "B";
  }
  hud(_humanScore: number): RaidHudState {
    throw new Error(RAID_UNAVAILABLE_MESSAGE);
  }
  waveForScore(_humanScore: number): number {
    return 0;
  }
  mapForWave(_wave: number): string {
    return "";
  }
  planForWave(_wave?: number): RaidWavePlan {
    throw new Error(RAID_UNAVAILABLE_MESSAGE);
  }
  botName(_index: number): string {
    return "";
  }
  botId(_index: number): string {
    return "";
  }
  tryStart(_loadedHumans: number): boolean {
    return false;
  }
  onHumanCapture(_humanScore: number): "wave" | "win" {
    return "wave";
  }
  onEnemyCapture(): "fail" {
    return "fail";
  }
  onWipe(): "fail" {
    return "fail";
  }
  onEmpty(): "fail" {
    return "fail";
  }
  onTimeout(): "fail" {
    return "fail";
  }
  allHumansDead(
    _humans: readonly { team: TeamId; alive: boolean }[],
  ): boolean {
    return false;
  }
}
