/**
 * Epic 17.1 — replay format-version catalog.
 *
 * Expands the 10.5 gate from "is this exactly the writer version?" into a
 * described catalog of file-format versions. The catalog names the version
 * this build writes, the container sections that version carries, and the
 * section dialects the writer stamps.
 *
 * Load acceptance does not move. `isSupportedReplayFormatVersion` still
 * accepts only `REPLAY_FORMAT_VERSION`. A `previous` row, if one is added,
 * is classified and still refused by that gate. 17.4 names that class
 * `migrate` in `replayCompatibility.ts` and does not change the gate.
 *
 * This module does not record a simulation version (17.2), record the map
 * version (17.3), decide which versions play (17.4), or reject an
 * incompatible load (17.5). It does not decode, load, or rewrite a file.
 *
 * Lineage: 7.4 planted the constant, 10.5 locked the fail-closed gate,
 * 17.1 describes the catalog. The older "#14 expands policy" wording was
 * the pre-split number for this section.
 */

import {
  isSupportedReplayFormatVersion,
  REPLAY_FORMAT_VERSION,
} from "../shared/replay/replayFormatVersion.ts";
import { CHECKPOINT_SCHEMA_VERSION } from "./authoritativeCheckpoint.ts";
import {
  REPLAY_CONTAINER_SECTION_ORDER,
  type ReplayContainerSectionName,
} from "./replayContainer.ts";
import { REPLAY_INDEX_VERSION } from "./replayIndex.ts";

export const REPLAY_FORMAT_CATALOG_INVALID =
  "replay-format-catalog-invalid" as const;
export const REPLAY_FORMAT_BUMP_UNKNOWN = "replay-format-bump-unknown" as const;

export type ReplayFormatCatalogErrorCode =
  | typeof REPLAY_FORMAT_CATALOG_INVALID
  | typeof REPLAY_FORMAT_BUMP_UNKNOWN;

export class ReplayFormatCatalogError extends Error {
  readonly code: ReplayFormatCatalogErrorCode;
  readonly detail: string | null;

  constructor(
    code: ReplayFormatCatalogErrorCode,
    message: string,
    opts?: { detail?: string | null },
  ) {
    super(message);
    this.name = "ReplayFormatCatalogError";
    this.code = code;
    this.detail = opts?.detail ?? null;
  }
}

/** `current` is the writer version. `previous` is catalogued and not loadable. */
export type ReplayFormatCatalogRole = "current" | "previous";

/**
 * Result of reading a stamped `replayFormatVersion`.
 * `previous` is not permission to load.
 */
export type ReplayFormatVersionClass =
  | "current"
  | "previous"
  | "unknown"
  | "absent"
  | "malformed";

export type ReplayFormatDialect =
  | {
    readonly kind: "index";
    readonly version: typeof REPLAY_INDEX_VERSION;
    readonly when: "filled-index";
  }
  | {
    readonly kind: "checkpoint";
    readonly version: typeof CHECKPOINT_SCHEMA_VERSION;
    readonly when: "every-frame";
  }
  | {
    readonly kind: "integrity";
    readonly version: null;
    readonly when: "reserved";
  };

export type ReplayFormatCatalogEntry = {
  readonly version: number;
  readonly role: ReplayFormatCatalogRole;
  readonly sections: readonly ReplayContainerSectionName[];
  readonly dialects: readonly ReplayFormatDialect[];
};

const V1_DIALECTS: readonly ReplayFormatDialect[] = Object.freeze([
  Object.freeze({
    kind: "index",
    version: REPLAY_INDEX_VERSION,
    when: "filled-index",
  }),
  Object.freeze({
    kind: "checkpoint",
    version: CHECKPOINT_SCHEMA_VERSION,
    when: "every-frame",
  }),
  Object.freeze({
    kind: "integrity",
    version: null,
    when: "reserved",
  }),
]);

/**
 * Known file-format versions. One row: the writer version. No previous
 * format version exists. A previous row, if added, stays unloadable.
 * The 10.5 gate still accepts only this version. 17.4 does not change it.
 */
export const REPLAY_FORMAT_CATALOG: readonly ReplayFormatCatalogEntry[] = Object
  .freeze([
    Object.freeze({
      version: REPLAY_FORMAT_VERSION,
      role: "current",
      sections: REPLAY_CONTAINER_SECTION_ORDER,
      dialects: V1_DIALECTS,
    }),
  ]);

/**
 * What a change bumps. Only `file-sections` bumps `REPLAY_FORMAT_VERSION`.
 * Section dialects, clip settings, sim version, and map version do not.
 */
export const REPLAY_FORMAT_CHANGE_KINDS = [
  "file-sections",
  "index-dialect",
  "checkpoint-dialect",
  "integrity-dialect",
  "clip-presentation",
  "simulation",
  "map",
  "support-policy",
  "load-rejection",
] as const;

export type ReplayFormatChangeKind =
  (typeof REPLAY_FORMAT_CHANGE_KINDS)[number];

export type ReplayFormatBumpRule = {
  readonly kind: ReplayFormatChangeKind;
  /** True only when the change adds a catalog row and moves the writer constant. */
  readonly bumpsFormatVersion: boolean;
  readonly owner: string;
  /** Constant or field that carries the change. Null when nothing is stamped yet. */
  readonly stamp: string | null;
};

export const REPLAY_FORMAT_BUMP_RULES: readonly ReplayFormatBumpRule[] = Object
  .freeze([
    Object.freeze({
      kind: "file-sections",
      bumpsFormatVersion: true,
      owner: "17.1",
      stamp: "REPLAY_FORMAT_VERSION",
    }),
    Object.freeze({
      kind: "index-dialect",
      bumpsFormatVersion: false,
      owner: "10.3",
      stamp: "REPLAY_INDEX_VERSION",
    }),
    Object.freeze({
      kind: "checkpoint-dialect",
      bumpsFormatVersion: false,
      owner: "9.1",
      stamp: "CHECKPOINT_SCHEMA_VERSION",
    }),
    Object.freeze({
      kind: "integrity-dialect",
      bumpsFormatVersion: false,
      owner: "10.4",
      stamp: null,
    }),
    Object.freeze({
      kind: "clip-presentation",
      bumpsFormatVersion: false,
      owner: "15.6",
      stamp: "REPLAY_CLIP_CAMERA_SETTINGS_VERSION",
    }),
    Object.freeze({
      kind: "simulation",
      bumpsFormatVersion: false,
      owner: "17.2",
      stamp: "SIMULATION_VERSION",
    }),
    Object.freeze({
      kind: "map",
      bumpsFormatVersion: false,
      owner: "17.3",
      stamp: "map.version",
    }),
    Object.freeze({
      kind: "support-policy",
      bumpsFormatVersion: false,
      owner: "17.4",
      stamp: null,
    }),
    Object.freeze({
      kind: "load-rejection",
      bumpsFormatVersion: false,
      owner: "17.5",
      stamp: null,
    }),
  ]);

function failCatalog(message: string, detail?: string): never {
  throw new ReplayFormatCatalogError(
    REPLAY_FORMAT_CATALOG_INVALID,
    message,
    detail !== undefined ? { detail } : undefined,
  );
}

/**
 * The catalog matches the live writer stamps. A `previous` row must fail
 * the 10.5 gate. Callers that pass a catalog (tests) get the same checks.
 * 17.4 does not add a previous format row and does not widen the gate.
 */
export function assertReplayFormatCatalog(
  catalog: readonly ReplayFormatCatalogEntry[] = REPLAY_FORMAT_CATALOG,
): void {
  if (catalog.length === 0) failCatalog("replay format catalog is empty");

  const currents = catalog.filter((row) => row.role === "current");
  if (currents.length !== 1) {
    failCatalog(
      `replay format catalog must have one current row (found ${currents.length})`,
    );
  }
  const current = currents[0];
  if (current === undefined) {
    failCatalog("replay format catalog is missing its current row");
  }
  if (current.version !== REPLAY_FORMAT_VERSION) {
    failCatalog(
      "current format row must be the writer version",
      `${current.version} !== ${REPLAY_FORMAT_VERSION}`,
    );
  }
  if (!isSupportedReplayFormatVersion(current.version)) {
    failCatalog("current format row is not loadable");
  }

  if (
    current.sections.length !== REPLAY_CONTAINER_SECTION_ORDER.length ||
    current.sections.some((name, i) =>
      name !== REPLAY_CONTAINER_SECTION_ORDER[i]
    )
  ) {
    failCatalog("current format sections drifted from the container order");
  }

  const index = current.dialects.find((row) => row.kind === "index");
  const checkpoint = current.dialects.find((row) => row.kind === "checkpoint");
  const integrity = current.dialects.find((row) => row.kind === "integrity");
  if (
    current.dialects.length !== 3 ||
    index?.kind !== "index" ||
    index.version !== REPLAY_INDEX_VERSION ||
    index.when !== "filled-index" ||
    checkpoint?.kind !== "checkpoint" ||
    checkpoint.version !== CHECKPOINT_SCHEMA_VERSION ||
    checkpoint.when !== "every-frame" ||
    integrity?.kind !== "integrity" ||
    integrity.version !== null ||
    integrity.when !== "reserved"
  ) {
    failCatalog("current format dialects drifted from the writer stamps");
  }

  let previousVersion = 0;
  const seen = new Set<number>();
  for (const row of catalog) {
    if (!Number.isInteger(row.version) || row.version < 1) {
      failCatalog(
        "format version must be a positive integer",
        String(row.version),
      );
    }
    if (row.version <= previousVersion) {
      failCatalog(
        "format catalog must be strictly ascending",
        String(row.version),
      );
    }
    previousVersion = row.version;
    if (seen.has(row.version)) {
      failCatalog("duplicate format version", String(row.version));
    }
    seen.add(row.version);
    if (row.role !== "current" && row.role !== "previous") {
      failCatalog("unknown format catalog role", String(row.role));
    }
    if (row.role === "previous") {
      if (isSupportedReplayFormatVersion(row.version)) {
        failCatalog(
          "a previous format version must not pass the load gate",
          String(row.version),
        );
      }
      if (row.sections.length === 0) {
        failCatalog(
          "a previous format row needs its section list",
          String(row.version),
        );
      }
    }
  }
}

export function currentReplayFormatEntry(
  catalog: readonly ReplayFormatCatalogEntry[] = REPLAY_FORMAT_CATALOG,
): ReplayFormatCatalogEntry {
  assertReplayFormatCatalog(catalog);
  const current = catalog.find((row) => row.role === "current");
  if (current === undefined) {
    failCatalog("replay format catalog is missing its current row");
  }
  return current;
}

export function replayFormatCatalogEntry(
  version: number,
  catalog: readonly ReplayFormatCatalogEntry[] = REPLAY_FORMAT_CATALOG,
): ReplayFormatCatalogEntry | null {
  return catalog.find((row) => row.version === version) ?? null;
}

/**
 * Classify a stamped format version. Does not throw the load-gate error
 * and does not read map, seed, gameProto, or buildSha.
 *
 * A catalog that is not the writer catalog throws
 * `replay-format-catalog-invalid` instead of classifying.
 * `previous` is an integer the catalog lists and the load gate rejects.
 */
export function classifyReplayFormatVersion(
  value: unknown,
  catalog: readonly ReplayFormatCatalogEntry[] = REPLAY_FORMAT_CATALOG,
): ReplayFormatVersionClass {
  assertReplayFormatCatalog(catalog);
  if (value === undefined || value === null) return "absent";
  if (isSupportedReplayFormatVersion(value)) return "current";
  if (typeof value === "number" && Number.isInteger(value)) {
    const row = catalog.find((entry) => entry.version === value);
    if (row?.role === "previous") return "previous";
    return "unknown";
  }
  return "malformed";
}

export function replayFormatBumpOwner(kind: string): ReplayFormatBumpRule {
  const rule = REPLAY_FORMAT_BUMP_RULES.find((row) => row.kind === kind);
  if (rule === undefined) {
    throw new ReplayFormatCatalogError(
      REPLAY_FORMAT_BUMP_UNKNOWN,
      `unknown replay format change kind: ${kind}`,
      { detail: kind },
    );
  }
  return rule;
}
