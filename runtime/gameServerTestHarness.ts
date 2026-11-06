/**
 * Test-only door to GameServer's private members.
 * One cast lives here so later splits change this file instead of every test.
 */
import { BotManager } from "../bots/BotManager.ts";
import { HeatmapTracker } from "../heatmaps/HeatmapTracker.ts";
import { drainTickAuthoritativeEvents } from "../players/authoritativeEventSource.ts";
import type { PlayerManager } from "../players/PlayerManager.ts";
import type { PendingWeapon } from "../players/weaponsQueue.ts";
import type { SimIngressSinks } from "../players/simIngress.ts";
import type { SimTickEvent, SimTickResult } from "../players/simTickResult.ts";
import type { GameOverPacket, TeamId } from "../protocol/network.ts";
import type { ReplayIntegrationSink } from "../replay/replayIntegration.ts";
import type { ReplayRecorder } from "../replay/ReplayRecorder.ts";
import type { AuthoritativeEvent } from "../shared/sim/authoritativeEvent.ts";
import { GameServer } from "./GameServer.ts";

const PACKAGE_ROOT = new URL("../", import.meta.url);

/** Sessions tests install when they do not bind a real hub. */
export type TestSessionHub = {
  emit(...args: unknown[]): void;
  get?(id: string): unknown;
  sessions?(): unknown[];
};

/**
 * Raid fields tests read and write. `activatedAtMs` is private on RaidMatch;
 * the load-timeout tests set it directly.
 */
export type TestRaidView = {
  tryStart(loadedHumans: number): boolean;
  started: boolean;
  ended: boolean;
  failReason: string | null;
  activatedAtMs: number;
  expectedHumans: number;
};

/** Shape the replay tests pass to onMatchEnded (restartInSeconds omitted). */
export type TestGameOverCall = {
  winner: "A" | "B" | "draw";
  scores: { A: number; B: number };
  players: unknown[];
};

/** Every private member a test reaches today. */
export type GameServerInternals = {
  players: PlayerManager;
  sessions: TestSessionHub | null | undefined;
  runtimeMatchId: string;
  maxPlayers: number;
  lastSimNowMs: number;
  replayRecorder: ReplayRecorder | null;
  replaySink: ReplayIntegrationSink | null;
  pendingReplayMatchEnd: GameOverPacket | null;
  replayPayloadConstructionCount: number;
  bots: BotManager;
  pendingWeapons: PendingWeapon[];
  lastReportedMatchKey: string | null;
  lastHeatmapReportKey: string | null;
  raid: TestRaidView | null;
  raidLoadedPlayerIds: Set<string>;
  releaseLocked: boolean;
  mapVotes: Map<string, string>;
  admissionBotReconcileTimer: ReturnType<typeof setTimeout> | null;
  admissionBotPendingParties: Map<string, { partySize: number }>;
  heatmaps: HeatmapTracker;

  stepSim(tick: number, nowMs: number): SimTickResult;
  deliverReplayIntegrationTick(
    tick: number,
    events: ReadonlyArray<AuthoritativeEvent>,
  ): void;
  flushPendingReplayMatchEnd(tick?: number): void;
  beginRuntimeMatchIdentity(tick?: number): void;
  emitMatchStart(
    matchStart: ReturnType<PlayerManager["beginLiveMatch"]>,
    tick: number,
  ): void;
  onMatchEnded(packet: TestGameOverCall, nowMs?: number): void;
  handleMatchReady(playerId: string, ready: boolean): void;
  maybeResetEmptyRankedInstance(): boolean;
  noteReplayHumanPresence(tick?: number): void;
  emitSimTickEvents(tick: number, events: readonly SimTickEvent[]): void;
  simIngressSinks(): SimIngressSinks;
  finishIntermission(tick: number, nowMs?: number): void;
  decorateGameOver(packet: GameOverPacket): GameOverPacket;
  onHumanSeatedForBots(opts: {
    partyId?: string | null;
    partySize?: number | null;
    assignmentId?: string | null;
    botsEvicted?: number;
  }): void;
  dropPlayer(playerId: string): void;
  activateRaidFromJoin(input: {
    team?: TeamId;
    raidId?: string;
    partySize?: number;
    soloRaid?: boolean;
  }): void;
  commitRaidJoin(session: {
    data: {
      raidJoin?: {
        team?: TeamId;
        raidId?: string;
        partySize?: number;
        soloRaid?: boolean;
      };
    };
    emit(event: string, payload?: unknown): void;
    disconnect(): void;
  }): boolean;
  resetIdleRaidRuntime(): void;
  handleRaidScores(
    scores: { team: TeamId }[],
  ): GameOverPacket | null;
  handleRaidFailConditions(): GameOverPacket | null;
  raidPartyTimedOut(partyId: string | undefined, nowMs?: number): boolean;
  returnHumansToMenuAfterDrain(): void;
  authenticateJoin(
    authBag: Record<string, unknown>,
  ): Promise<
    | {
      ok: true;
      name: string;
      synthetic?: boolean;
      spectator?: boolean;
      raidJoin?: {
        team?: TeamId;
        raidId?: string;
        partySize?: number;
        soloRaid?: boolean;
      };
    }
    | { ok: false; error: string }
  >;
};

export function serverInternals(server: GameServer): GameServerInternals {
  return server as unknown as GameServerInternals;
}

/**
 * The tick tail startGameLoop runs after stepSim:
 * drain → deliverReplayIntegrationTick → flushPendingReplayMatchEnd.
 */
export function driveTick(
  server: GameServer,
  tick: number,
  nowMs: number = Date.now(),
): { result: SimTickResult; events: AuthoritativeEvent[] } {
  const internals = serverInternals(server);
  const result = internals.stepSim(tick, nowMs);
  const events = drainTickAuthoritativeEvents(
    internals.players,
    tick,
    result.events,
  );
  internals.deliverReplayIntegrationTick(tick, events);
  internals.flushPendingReplayMatchEnd(tick);
  return { result, events };
}

/** Read a file relative to the server-community package root. */
export function readRepoSource(path: string): string {
  return Deno.readTextFileSync(new URL(path, PACKAGE_ROOT));
}

export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Body of `public|private name(`, including the outer braces.
 * Callers pass comment-stripped source so a mention in a comment cannot win.
 */
export function methodBody(src: string, name: string): string {
  const re = new RegExp(`(?:public|private)\\s+${name}\\s*\\(`);
  const m = re.exec(src);
  if (!m) throw new Error(`missing method ${name}`);
  let i = m.index + m[0].length;
  let depth = 1;
  while (i < src.length && depth > 0) {
    const ch = src[i++];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
  }
  while (i < src.length && src[i] !== "{") i++;
  if (src[i] !== "{") throw new Error(`no body for ${name}`);
  const start = i;
  depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced body for ${name}`);
}
