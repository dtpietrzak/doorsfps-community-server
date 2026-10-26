/**
 * In-match heatmap sampling on the game server (authoritative Player state).
 * Humans always; bots only when botTrackingEngaged. Agents never.
 *
 * Cells are split by door phase (open / closed). Match-end payload is a
 * per-actor delta; authority merges into lifetime per-player rows.
 */

import {
  HEATMAP_ACTIONS,
  HEATMAP_CELL_SIZE,
  HEATMAP_SAMPLE_EVERY_TICKS,
  type HeatmapAction,
  type HeatmapActorKind,
  heatmapCellKey,
  type HeatmapDoorPhase,
  type HeatmapIngestBody,
  type HeatmapPhasedCellsJson,
  heatmapPhasedHasAny,
  type HeatmapSessionPayload,
} from "../shared/world/heatmaps.ts";
import type { Player } from "../players/Player.ts";
import type { MatchPhase } from "../protocol/network.ts";
import { isSyntheticUserId } from "../shared/authority/syntheticIdentity.ts";

export type HeatmapRuntimeStats = {
  botTrackingEngaged: boolean;
  active: boolean;
  actorCount: number;
  humanActorCount: number;
  botActorCount: number;
  cellEntryCount: number;
  estBytes: number;
  lastSampleMs: number;
  avgSampleMs: number;
};

type PhaseCells = Map<HeatmapAction, Map<string, number>>;

type ActorBucket = {
  actorKind: HeatmapActorKind;
  actorKey: string;
  actorName: string;
  kills: number;
  deaths: number;
  doors: number;
  open: PhaseCells;
  closed: PhaseCells;
};

/** Rough per-entry cost for status estBytes (key + count + map overhead). */
const BYTES_PER_CELL_ENTRY = 28;
const BYTES_PER_ACTOR = 192;

export class HeatmapTracker {
  botTrackingEngaged = false;
  private readonly buckets = new Map<string, ActorBucket>();
  private sampleCounter = 0;
  private readonly cellSize: number;
  private lastSampleMs = 0;
  /** Last doorsOpen passed to tick/recordShoot (default true). */
  private doorsOpen = true;
  /** Ring of recent sample-pass durations for RMS avg. */
  private readonly sampleMsRing: number[] = [];
  private sampleMsWrite = 0;
  private sampleMsCount = 0;
  private readonly sampleMsWindow: number;

  constructor(opts?: { cellSize?: number; tickHz?: number }) {
    this.cellSize = opts?.cellSize && opts.cellSize > 0
      ? opts.cellSize
      : HEATMAP_CELL_SIZE;
    const hz = opts?.tickHz && opts.tickHz > 0 ? opts.tickHz : 60;
    this.sampleMsWindow = Math.max(1, Math.floor(hz));
  }

  /**
   * Clear match buffers for the next match.
   * Does **not** change {@link botTrackingEngaged} — once an admin turns bot
   * tracking on, it stays on across match restarts until they toggle it off.
   */
  resetForNewMatch(): void {
    this.buckets.clear();
    this.sampleCounter = 0;
    this.lastSampleMs = 0;
    this.doorsOpen = true;
  }

  setBotTracking(on: boolean): void {
    this.botTrackingEngaged = Boolean(on);
  }

  toggleBotTracking(): boolean {
    this.botTrackingEngaged = !this.botTrackingEngaged;
    return this.botTrackingEngaged;
  }

  /**
   * Sample eligible players. Call after sim each tick (phase "heatmap").
   * Only runs work every HEATMAP_SAMPLE_EVERY_TICKS during live phase.
   */
  tick(
    players: Iterable<Player>,
    phase: MatchPhase,
    _tick: number,
    doorsOpen = true,
  ): void {
    this.doorsOpen = Boolean(doorsOpen);
    if (phase !== "live") {
      this.lastSampleMs = 0;
      return;
    }
    this.sampleCounter += 1;
    if (this.sampleCounter % HEATMAP_SAMPLE_EVERY_TICKS !== 0) {
      this.lastSampleMs = 0;
      return;
    }

    const t0 = performance.now();
    for (const p of players) {
      this.samplePlayer(p);
    }
    const dt = performance.now() - t0;
    this.lastSampleMs = dt;
    this.recordSampleMs(dt);
  }

  /**
   * Event: shot at shooter XZ (humans + bots when allowed).
   * Uses last doorsOpen from {@link tick}, or pass explicit phase.
   */
  recordShoot(player: Player, doorsOpen?: boolean): void {
    if (!this.isEligible(player)) return;
    if (typeof doorsOpen === "boolean") this.doorsOpen = doorsOpen;
    const bucket = this.ensureBucket(player);
    this.inc(bucket, "shoot", player.x, player.z);
  }

  /** Preserve final scoreboard totals before a player leaves the live roster. */
  recordPlayerDeparture(player: Player): void {
    const bucket = this.buckets.get(player.id);
    if (!bucket) return;
    this.syncPlayerStats(bucket, player);
  }

  /**
   * Build authority ingest body. Pulls final kills/deaths/doors from live
   * Player objects when still present; otherwise uses the departure snapshot.
   */
  buildIngestPayload(
    mapName: string,
    serverId: string,
    matchKey: string | undefined,
    playersById: Map<string, Player> | Iterable<Player>,
  ): HeatmapIngestBody | null {
    if (this.buckets.size === 0) return null;

    const byId = playersById instanceof Map ? playersById : (() => {
      const m = new Map<string, Player>();
      for (const p of playersById) m.set(p.id, p);
      return m;
    })();

    // A match whose humans are all synthetic contributes nothing, including
    // bot samples collected against those sims.
    if (heatmapRosterIsSyntheticOnly(byId, this.buckets)) return null;

    const sessions: HeatmapSessionPayload[] = [];
    for (const [playerId, bucket] of this.buckets) {
      const p = byId.get(playerId);
      if (p?.synthetic || isSyntheticUserId(bucket.actorKey)) continue;
      const cells = bucketToPhasedJson(bucket);
      if (!heatmapPhasedHasAny(cells)) continue;
      sessions.push({
        actorKind: bucket.actorKind,
        actorKey: bucket.actorKey,
        actorName: p?.name ?? bucket.actorName,
        kills: p?.kills ?? bucket.kills,
        deaths: p?.deaths ?? bucket.deaths,
        doors: p?.score ?? bucket.doors,
        cells,
      });
    }
    if (sessions.length === 0) return null;

    return {
      serverId,
      mapName,
      matchKey,
      cellSize: this.cellSize,
      sessions,
    };
  }

  getRuntimeStats(phase?: MatchPhase): HeatmapRuntimeStats {
    let humanActorCount = 0;
    let botActorCount = 0;
    let cellEntryCount = 0;
    for (const b of this.buckets.values()) {
      if (b.actorKind === "human") humanActorCount += 1;
      else botActorCount += 1;
      cellEntryCount += countPhaseEntries(b.open) + countPhaseEntries(b.closed);
    }
    const actorCount = this.buckets.size;
    return {
      botTrackingEngaged: this.botTrackingEngaged,
      active: phase === "live",
      actorCount,
      humanActorCount,
      botActorCount,
      cellEntryCount,
      estBytes: actorCount * BYTES_PER_ACTOR +
        cellEntryCount * BYTES_PER_CELL_ENTRY,
      lastSampleMs: this.lastSampleMs,
      avgSampleMs: this.avgSampleMs(),
    };
  }

  // --- internals -----------------------------------------------------------

  private isEligible(p: Player): boolean {
    if (!p.alive) return false;
    // Synthetic sims must not poison human or bot priors.
    if (p.synthetic) return false;
    if (p.isAgent) return false;
    if (p.isBot) return this.botTrackingEngaged;
    return true;
  }

  private samplePlayer(p: Player): void {
    if (!this.isEligible(p)) return;

    // Jump as event: jump intent while grounded (takeoff XZ).
    if (p.isJumpIntent() && p.onGround) {
      const bucket = this.ensureBucket(p);
      this.inc(bucket, "jump", p.x, p.z);
    }

    const action = classifyLocomotion(p);
    if (!action) return;
    const bucket = this.ensureBucket(p);
    this.inc(bucket, action, p.x, p.z);
  }

  private ensureBucket(p: Player): ActorBucket {
    let b = this.buckets.get(p.id);
    if (b) {
      this.syncPlayerStats(b, p);
      return b;
    }
    const actorKind: HeatmapActorKind = p.isBot ? "bot" : "human";
    const actorKey = resolveActorKey(p);
    b = {
      actorKind,
      actorKey,
      actorName: p.name,
      kills: p.kills,
      deaths: p.deaths,
      doors: p.score,
      open: new Map(),
      closed: new Map(),
    };
    this.buckets.set(p.id, b);
    return b;
  }

  private syncPlayerStats(bucket: ActorBucket, player: Player): void {
    bucket.actorName = player.name;
    bucket.kills = player.kills;
    bucket.deaths = player.deaths;
    bucket.doors = player.score;
  }

  private inc(
    bucket: ActorBucket,
    action: HeatmapAction,
    x: number,
    z: number,
  ): void {
    const phaseMap = this.doorsOpen ? bucket.open : bucket.closed;
    let layer = phaseMap.get(action);
    if (!layer) {
      layer = new Map();
      phaseMap.set(action, layer);
    }
    const key = heatmapCellKey(x, z, this.cellSize);
    layer.set(key, (layer.get(key) ?? 0) + 1);
  }

  private recordSampleMs(ms: number): void {
    if (this.sampleMsRing.length < this.sampleMsWindow) {
      this.sampleMsRing.push(ms);
      this.sampleMsCount = this.sampleMsRing.length;
      this.sampleMsWrite = this.sampleMsRing.length % this.sampleMsWindow;
      return;
    }
    this.sampleMsRing[this.sampleMsWrite] = ms;
    this.sampleMsWrite = (this.sampleMsWrite + 1) % this.sampleMsWindow;
    this.sampleMsCount = this.sampleMsWindow;
  }

  private avgSampleMs(): number {
    if (this.sampleMsCount === 0) return 0;
    let sumSq = 0;
    for (let i = 0; i < this.sampleMsCount; i++) {
      const v = this.sampleMsRing[i] ?? 0;
      sumSq += v * v;
    }
    return Math.sqrt(sumSq / this.sampleMsCount);
  }
}

/** Exported for unit tests. */
export function classifyLocomotion(p: Player): HeatmapAction | null {
  if (p.isSliding()) return "slide";
  if (p.crouch) return "crouch";
  if (p.isSprintIntent() && p.isMoveIntent()) return "sprint";
  if (p.isMoveIntent()) return "walk";
  return null;
}

/** Exported for unit tests. */
export function resolveActorKey(p: Player): string {
  if (p.accountUserId) return p.accountUserId;
  if (p.isBot) return `bot:${p.name}`;
  return `guest:${p.name}`;
}

/**
 * True when the match has at least one human and every human is synthetic.
 * Departed humans still count via their heatmap bucket actor key.
 */
function heatmapRosterIsSyntheticOnly(
  players: Map<string, Player>,
  buckets: Map<string, ActorBucket>,
): boolean {
  let sawHuman = false;
  let sawReal = false;
  for (const player of players.values()) {
    if (player.isBot || player.isAgent) continue;
    sawHuman = true;
    if (!player.synthetic) sawReal = true;
  }
  for (const [playerId, bucket] of buckets) {
    if (bucket.actorKind !== "human") continue;
    if (players.has(playerId)) continue;
    sawHuman = true;
    if (!isSyntheticUserId(bucket.actorKey)) sawReal = true;
  }
  return sawHuman && !sawReal;
}

function countPhaseEntries(phase: PhaseCells): number {
  let n = 0;
  for (const m of phase.values()) n += m.size;
  return n;
}

function phaseToJson(
  phase: PhaseCells,
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const action of HEATMAP_ACTIONS) {
    const layer = phase.get(action);
    if (!layer || layer.size === 0) continue;
    const rec: Record<string, number> = {};
    for (const [k, n] of layer) {
      if (n > 0) rec[k] = n;
    }
    if (Object.keys(rec).length > 0) out[action] = rec;
  }
  return out;
}

function bucketToPhasedJson(bucket: ActorBucket): HeatmapPhasedCellsJson {
  const out: HeatmapPhasedCellsJson = {};
  const open = phaseToJson(bucket.open);
  const closed = phaseToJson(bucket.closed);
  if (Object.keys(open).length > 0) out.open = open;
  if (Object.keys(closed).length > 0) out.closed = closed;
  return out;
}

/** Door phase for a boolean doorsOpen flag. */
export function heatmapPhaseFromDoorsOpen(
  doorsOpen: boolean,
): HeatmapDoorPhase {
  return doorsOpen ? "open" : "closed";
}
