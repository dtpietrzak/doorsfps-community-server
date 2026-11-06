/**
 * Epic 17.3 — map version recorded on a replay.
 *
 * The match already stores `map.name` and `map.version` on the header and
 * the initial state. This module reads that pair and classifies the version.
 * It does not migrate or reject a load. Support is
 * `replayCompatibility.ts` (17.4).
 *
 * `map.version` is the doors map schema (`MAP_FORMAT_VERSION` on a current
 * map file). It is not the replay file format and not the simulation version.
 * The replay keeps the version the match used. A missing version is `absent`.
 * It is not filled in with the current schema.
 *
 * `isSupportedMapFormatVersion` stays the map-file gate. This module does
 * not call it. Schema 1 is the previous row. A previous row is not itself
 * a load decision. 17.4 says this build plays that schema directly.
 * Playback of a map the policy rejects fails in `assertReplayPlayable`
 * (17.5).
 */

import {
  MAP_FORMAT_VERSION,
  type MapFormatVersion,
} from "../shared/world/doorsMapFormat.ts";

export { MAP_FORMAT_VERSION, type MapFormatVersion };

export const REPLAY_MAP_VERSION_INVALID = "replay-map-version-invalid" as const;

export type ReplayMapVersionErrorCode = typeof REPLAY_MAP_VERSION_INVALID;

export class ReplayMapVersionError extends Error {
  readonly code: ReplayMapVersionErrorCode;
  readonly detail: string | null;

  constructor(message: string, opts?: { detail?: string | null }) {
    super(message);
    this.name = "ReplayMapVersionError";
    this.code = REPLAY_MAP_VERSION_INVALID;
    this.detail = opts?.detail ?? null;
  }
}

/** `current` is the schema this build writes. `previous` is catalogued and not current. */
export type ReplayMapVersionRole = "current" | "previous";

export type ReplayMapVersionClass =
  | "current"
  | "previous"
  | "unknown"
  | "absent"
  | "malformed";

export type ReplayMapVersionEntry = {
  readonly version: number;
  readonly role: ReplayMapVersionRole;
};

/**
 * The map the replay names. `version` is the recorded schema number, which
 * may be older than `MAP_FORMAT_VERSION`.
 */
export type ReplayMapRecord = {
  readonly name: string;
  readonly version: number;
};

/**
 * Known map schema versions. Schema 1 (`mirrorMode` optional) is previous:
 * this build still reads it. The current row is the schema a new map file
 * uses. A previous row is not a load decision. 17.4 plays schema 1 directly.
 */
export const REPLAY_MAP_VERSIONS: readonly ReplayMapVersionEntry[] = Object
  .freeze([
    Object.freeze({
      version: 1,
      role: "previous",
    }),
    Object.freeze({
      version: MAP_FORMAT_VERSION,
      role: "current",
    }),
  ]);

export function assertReplayMapVersions(
  catalog: readonly ReplayMapVersionEntry[] = REPLAY_MAP_VERSIONS,
): void {
  if (catalog.length === 0) {
    throw new ReplayMapVersionError("map version catalog is empty");
  }
  const currents = catalog.filter((row) => row.role === "current");
  if (currents.length !== 1) {
    throw new ReplayMapVersionError(
      `map version catalog must have one current row (found ${currents.length})`,
    );
  }
  const current = currents[0];
  if (current === undefined || current.version !== MAP_FORMAT_VERSION) {
    throw new ReplayMapVersionError(
      "current map row must be the writer schema version",
      { detail: String(current?.version) },
    );
  }

  let previousVersion = 0;
  const seen = new Set<number>();
  for (const row of catalog) {
    if (!Number.isInteger(row.version) || row.version < 1) {
      throw new ReplayMapVersionError(
        "map version must be a positive integer",
        { detail: String(row.version) },
      );
    }
    if (row.version <= previousVersion) {
      throw new ReplayMapVersionError(
        "map version catalog must be strictly ascending",
        { detail: String(row.version) },
      );
    }
    previousVersion = row.version;
    if (seen.has(row.version)) {
      throw new ReplayMapVersionError(
        "duplicate map version",
        { detail: String(row.version) },
      );
    }
    seen.add(row.version);
    if (row.role !== "current" && row.role !== "previous") {
      throw new ReplayMapVersionError(
        "unknown map version role",
        { detail: String(row.role) },
      );
    }
    if (row.role === "previous" && row.version === MAP_FORMAT_VERSION) {
      throw new ReplayMapVersionError(
        "the writer map schema version cannot be previous",
        { detail: String(row.version) },
      );
    }
  }
}

type MapVersionSource = {
  readonly name?: unknown;
  readonly version?: unknown;
};

/**
 * The raw `version` key. A missing key is `undefined` (absent). A present
 * `null` is returned as `null` so the classifier can call it absent without
 * inventing `MAP_FORMAT_VERSION`.
 */
export function readReplayMapVersion(
  source: MapVersionSource | null | undefined,
): unknown {
  if (source == null || typeof source !== "object") return undefined;
  if (!("version" in source)) return undefined;
  return source.version;
}

function mapCopies(container: {
  readonly header?: { readonly map?: MapVersionSource | null } | null;
  readonly initialState?: {
    readonly metadata?: { readonly map?: MapVersionSource | null } | null;
    readonly init?: { readonly map?: MapVersionSource | null } | null;
  } | null;
}): MapVersionSource[] {
  return [
    container.header?.map,
    container.initialState?.metadata?.map,
    container.initialState?.init?.map,
  ].filter((map): map is MapVersionSource =>
    map != null && typeof map === "object"
  );
}

/** Header first, then metadata, then the init event. Does not fill a missing version. */
export function readReplayContainerMapVersion(container: {
  readonly header?: { readonly map?: MapVersionSource | null } | null;
  readonly initialState?: {
    readonly metadata?: { readonly map?: MapVersionSource | null } | null;
    readonly init?: { readonly map?: MapVersionSource | null } | null;
  } | null;
}): unknown {
  for (const map of mapCopies(container)) {
    const version = readReplayMapVersion(map);
    if (version !== undefined) return version;
  }
  return undefined;
}

/**
 * Name and version from the first copy that carries a version key.
 * Null when that copy is not a non-empty name plus a positive integer.
 * Does not substitute the current schema.
 */
export function readReplayContainerMap(container: {
  readonly header?: { readonly map?: MapVersionSource | null } | null;
  readonly initialState?: {
    readonly metadata?: { readonly map?: MapVersionSource | null } | null;
    readonly init?: { readonly map?: MapVersionSource | null } | null;
  } | null;
}): ReplayMapRecord | null {
  for (const map of mapCopies(container)) {
    if (!("version" in map)) continue;
    const version = map.version;
    if (typeof map.name !== "string" || map.name.length === 0) return null;
    if (
      typeof version !== "number" || !Number.isInteger(version) || version < 1
    ) {
      return null;
    }
    return { name: map.name, version };
  }
  return null;
}

/**
 * Classify a recorded map schema version. Does not throw for an unknown
 * or missing value, and does not read the map name, the simulation version,
 * or the replay format. An invalid catalog throws `replay-map-version-invalid`.
 */
export function classifyReplayMapVersion(
  value: unknown,
  catalog: readonly ReplayMapVersionEntry[] = REPLAY_MAP_VERSIONS,
): ReplayMapVersionClass {
  assertReplayMapVersions(catalog);
  if (value === undefined || value === null) return "absent";
  if (value === MAP_FORMAT_VERSION) return "current";
  if (typeof value === "number" && Number.isInteger(value)) {
    const row = catalog.find((entry) => entry.version === value);
    if (row?.role === "previous") return "previous";
    return "unknown";
  }
  return "malformed";
}
