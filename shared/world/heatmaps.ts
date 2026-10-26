/**
 * Shared heatmap types: action channels, sparse cell JSON, ingest body.
 * Server samples → authority SQLite → admin UI.
 *
 * Cells are **door-phase split**: open / closed (plus unknown for legacy).
 * Authority storage is **per player** (map + kind + actorKey), not per match.
 */

export const HEATMAP_ACTIONS = [
  "walk",
  "sprint",
  "jump",
  "crouch",
  "slide",
  "shoot",
] as const;

export type HeatmapAction = (typeof HEATMAP_ACTIONS)[number];

export type HeatmapActorKind = "human" | "bot";

/**
 * Door cycle phase at sample time.
 * - open / closed: live match sampling
 * - unknown: migrated pre-phase session data (do not use for open/closed priors)
 */
export const HEATMAP_DOOR_PHASES = ["open", "closed", "unknown"] as const;

export type HeatmapDoorPhase = (typeof HEATMAP_DOOR_PHASES)[number];

/** Sparse: only non-zero cells. Key = `${cellX},${cellZ}`. */
export type HeatmapCellsJson = Partial<
  Record<HeatmapAction, Record<string, number>>
>;

/** Per door-phase sparse action cells. */
export type HeatmapPhasedCellsJson = Partial<
  Record<HeatmapDoorPhase, HeatmapCellsJson>
>;

/**
 * One actor's contribution for a match (delta). Authority merges into the
 * per-player row for (map, kind, actorKey).
 */
export type HeatmapSessionPayload = {
  actorKind: HeatmapActorKind;
  actorKey: string;
  actorName: string;
  kills: number;
  deaths: number;
  doors: number;
  /** Phased cells (open/closed). Legacy flat cells accepted on ingest only. */
  cells: HeatmapPhasedCellsJson;
};

export type HeatmapIngestBody = {
  /** Stable game-host identity used for authority-side replay protection. */
  hostId?: string;
  /** Stable child-runtime identity (normally the official server id). */
  runtimeId?: string;
  /** Immutable id for this additive heatmap delta batch. */
  batchId?: string;
  serverId: string;
  mapName: string;
  matchKey?: string;
  cellSize?: number;
  sessions: HeatmapSessionPayload[];
};

/** Default grid size (world units) — matches mapBuilder GRID_SIZE. */
export const HEATMAP_CELL_SIZE = 1;

/** Sample every N sim ticks (~10 Hz at 60 Hz). */
export const HEATMAP_SAMPLE_EVERY_TICKS = 6;

export function isHeatmapAction(v: unknown): v is HeatmapAction {
  return (
    typeof v === "string" &&
    (HEATMAP_ACTIONS as readonly string[]).includes(v)
  );
}

export function isHeatmapActorKind(v: unknown): v is HeatmapActorKind {
  return v === "human" || v === "bot";
}

export function isHeatmapDoorPhase(v: unknown): v is HeatmapDoorPhase {
  return (
    typeof v === "string" &&
    (HEATMAP_DOOR_PHASES as readonly string[]).includes(v)
  );
}

/** Quantize world XZ to cell key. */
export function heatmapCellKey(
  x: number,
  z: number,
  cellSize: number = HEATMAP_CELL_SIZE,
): string {
  const s = cellSize > 0 ? cellSize : 1;
  const cx = Math.floor(x / s);
  const cz = Math.floor(z / s);
  return `${cx},${cz}`;
}

export function parseHeatmapCellKey(
  key: string,
): { cx: number; cz: number } | null {
  const i = key.indexOf(",");
  if (i <= 0) return null;
  const cx = Number(key.slice(0, i));
  const cz = Number(key.slice(i + 1));
  if (!Number.isFinite(cx) || !Number.isFinite(cz)) return null;
  return { cx, cz };
}

/** K/D for display; deaths=0 → kills as ratio numerator over 1. */
export function heatmapKd(kills: number, deaths: number): number {
  const k = Number.isFinite(kills) ? Math.max(0, kills) : 0;
  const d = Number.isFinite(deaths) ? Math.max(0, deaths) : 0;
  return k / Math.max(1, d);
}

/** True when any action layer has at least one positive cell. */
export function heatmapCellsHasAny(cells: HeatmapCellsJson): boolean {
  for (const action of HEATMAP_ACTIONS) {
    const layer = cells[action];
    if (layer && Object.keys(layer).length > 0) return true;
  }
  return false;
}

/** True when any phase has any cells. */
export function heatmapPhasedHasAny(cells: HeatmapPhasedCellsJson): boolean {
  for (const phase of HEATMAP_DOOR_PHASES) {
    const layer = cells[phase];
    if (layer && heatmapCellsHasAny(layer)) return true;
  }
  return false;
}

/** Sum action counts from multiple phases into one flat layer set. */
export function flattenHeatmapPhases(
  phased: HeatmapPhasedCellsJson,
  phases: readonly HeatmapDoorPhase[] = HEATMAP_DOOR_PHASES,
): HeatmapCellsJson {
  const out: HeatmapCellsJson = {};
  for (const phase of phases) {
    const src = phased[phase];
    if (!src) continue;
    for (const action of HEATMAP_ACTIONS) {
      const layer = src[action];
      if (!layer) continue;
      let dest = out[action];
      if (!dest) {
        dest = {};
        out[action] = dest;
      }
      for (const [k, n] of Object.entries(layer)) {
        dest[k] = (dest[k] ?? 0) + n;
      }
    }
  }
  return out;
}

/**
 * Detect legacy flat cells (action → cell map) vs phased (open/closed/unknown).
 * Flat has at least one HEATMAP_ACTIONS key at top level.
 */
/** Walk-cell merge for one map — official runtimes compile this into pole priors. */
export type HeatmapMapWalkLayers = {
  mapName: string;
  cellSize: number;
  /** Merged open + closed walk (legacy unknown omitted). */
  humanWalk: Record<string, number>;
  botWalk: Record<string, number>;
  /** Door-open walk only — omitted when empty. */
  humanWalkOpen?: Record<string, number>;
  botWalkOpen?: Record<string, number>;
  /** Door-closed walk only — omitted when empty. */
  humanWalkClosed?: Record<string, number>;
  botWalkClosed?: Record<string, number>;
};

export type HeatmapPriorsBody = {
  ok: true;
  maps: HeatmapMapWalkLayers[];
};

export function isLegacyFlatHeatmapCells(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const bag = raw as Record<string, unknown>;
  for (const action of HEATMAP_ACTIONS) {
    if (action in bag) return true;
  }
  return false;
}
