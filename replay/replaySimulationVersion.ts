/**
 * Epic 17.2 — simulation version recorded on a replay.
 *
 * The writer stamps `SIMULATION_VERSION` into match metadata and the
 * container metadata section. This module reads that stamp and classifies
 * it. It does not migrate, reject a load, or interpret map version (17.3).
 * Support is `replayCompatibility.ts` (17.4). Playback of a wrong
 * ruleset fails in `assertReplayPlayable` (17.5).
 *
 * `GAME_PROTO` and `buildSha` stay what they already are: packet layout
 * and build provenance. They are not this version.
 *
 * A missing stamp is `absent`. It is not filled in with the current
 * version. A catalogued `previous` value is still not a load decision.
 */

import {
  SIMULATION_VERSION,
  type SimulationVersion,
} from "../shared/sim/simulationVersion.ts";

export { SIMULATION_VERSION, type SimulationVersion };

export const REPLAY_SIMULATION_VERSION_INVALID =
  "replay-simulation-version-invalid" as const;

export type ReplaySimulationVersionErrorCode =
  typeof REPLAY_SIMULATION_VERSION_INVALID;

export class ReplaySimulationVersionError extends Error {
  readonly code: ReplaySimulationVersionErrorCode;
  readonly detail: string | null;

  constructor(message: string, opts?: { detail?: string | null }) {
    super(message);
    this.name = "ReplaySimulationVersionError";
    this.code = REPLAY_SIMULATION_VERSION_INVALID;
    this.detail = opts?.detail ?? null;
  }
}

/** `current` is the writer version. `previous` is catalogued and not current. */
export type ReplaySimulationVersionRole = "current" | "previous";

export type ReplaySimulationVersionClass =
  | "current"
  | "previous"
  | "unknown"
  | "absent"
  | "malformed";

export type ReplaySimulationVersionEntry = {
  readonly version: number;
  readonly role: ReplaySimulationVersionRole;
};

/**
 * Known simulation versions. One row: the writer version. No older numbered
 * ruleset exists, so there is no previous row. 17.4 treats a previous class
 * as a historical simulation and does not register one. The row does not
 * by itself make the file load or refuse to load.
 */
export const REPLAY_SIMULATION_VERSIONS:
  readonly ReplaySimulationVersionEntry[] = Object.freeze([
    Object.freeze({
      version: SIMULATION_VERSION,
      role: "current",
    }),
  ]);

export function assertReplaySimulationVersions(
  catalog: readonly ReplaySimulationVersionEntry[] = REPLAY_SIMULATION_VERSIONS,
): void {
  if (catalog.length === 0) {
    throw new ReplaySimulationVersionError(
      "simulation version catalog is empty",
    );
  }
  const currents = catalog.filter((row) => row.role === "current");
  if (currents.length !== 1) {
    throw new ReplaySimulationVersionError(
      `simulation version catalog must have one current row (found ${currents.length})`,
    );
  }
  const current = currents[0];
  if (current === undefined || current.version !== SIMULATION_VERSION) {
    throw new ReplaySimulationVersionError(
      "current simulation row must be the writer version",
      { detail: String(current?.version) },
    );
  }

  let previousVersion = 0;
  const seen = new Set<number>();
  for (const row of catalog) {
    if (!Number.isInteger(row.version) || row.version < 1) {
      throw new ReplaySimulationVersionError(
        "simulation version must be a positive integer",
        { detail: String(row.version) },
      );
    }
    if (row.version <= previousVersion) {
      throw new ReplaySimulationVersionError(
        "simulation version catalog must be strictly ascending",
        { detail: String(row.version) },
      );
    }
    previousVersion = row.version;
    if (seen.has(row.version)) {
      throw new ReplaySimulationVersionError(
        "duplicate simulation version",
        { detail: String(row.version) },
      );
    }
    seen.add(row.version);
    if (row.role !== "current" && row.role !== "previous") {
      throw new ReplaySimulationVersionError(
        "unknown simulation version role",
        { detail: String(row.role) },
      );
    }
    if (row.role === "previous" && row.version === SIMULATION_VERSION) {
      throw new ReplaySimulationVersionError(
        "the writer simulation version cannot be previous",
        { detail: String(row.version) },
      );
    }
  }
}

/**
 * The raw stamp. A missing key is `undefined` (absent). A present `null`
 * is returned as `null` so the classifier can call it absent without
 * inventing the current version.
 */
export function readReplaySimulationVersion(
  source: { readonly simulationVersion?: unknown } | null | undefined,
): unknown {
  if (source == null || typeof source !== "object") return undefined;
  if (!("simulationVersion" in source)) return undefined;
  return source.simulationVersion;
}

/**
 * Metadata section first, then the initial-state copy. Does not fill a
 * missing stamp with `SIMULATION_VERSION`.
 */
export function readReplayContainerSimulationVersion(container: {
  readonly metadata?: { readonly simulationVersion?: unknown } | null;
  readonly initialState?: {
    readonly metadata?: { readonly simulationVersion?: unknown } | null;
  } | null;
}): unknown {
  const fromSection = readReplaySimulationVersion(container.metadata);
  if (fromSection !== undefined) return fromSection;
  return readReplaySimulationVersion(container.initialState?.metadata);
}

/**
 * Classify a recorded simulation version. Does not throw for an unknown
 * or missing value, and does not read `gameProto`, `buildSha`, or map
 * version. An invalid catalog throws `replay-simulation-version-invalid`.
 */
export function classifyReplaySimulationVersion(
  value: unknown,
  catalog: readonly ReplaySimulationVersionEntry[] = REPLAY_SIMULATION_VERSIONS,
): ReplaySimulationVersionClass {
  assertReplaySimulationVersions(catalog);
  if (value === undefined || value === null) return "absent";
  if (value === SIMULATION_VERSION) return "current";
  if (typeof value === "number" && Number.isInteger(value)) {
    const row = catalog.find((entry) => entry.version === value);
    if (row?.role === "previous") return "previous";
    return "unknown";
  }
  return "malformed";
}
