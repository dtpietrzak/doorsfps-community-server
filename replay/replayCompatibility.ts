/**
 * Epic 17.4 — replay compatibility policy.
 *
 * Names how this build treats a classified format version, simulation
 * version, and map schema version. The three classifiers (17.1–17.3)
 * stay the readers. This module decides support.
 *
 * Modes:
 * - `current` — this build's version. Playable.
 * - `previous` — an older version this build plays directly. Playable.
 * - `migrate` — an older file format. No migrator is registered, so the
 *   file is not playable. The 10.5 gate still accepts only format version 1.
 * - `historical-sim` — an older simulation ruleset. The same inputs would
 *   differ under the current rules, so migration is the wrong treatment.
 *   No historical simulator is registered, so the file is not playable.
 * - `unsupported` — no play path for that class.
 *
 * An omitted simulation stamp plays on the current rules. The recorded
 * class stays `absent`. The number 1 is not written back.
 *
 * A combined verdict uses the strongest axis: unsupported, then
 * historical-sim, then migrate, then previous, else current. Playable
 * means the combined mode is current or previous.
 *
 * `replayCompatibility` does not decode a file, migrate bytes, or run a
 * simulation. `assertReplayPlayable` (17.5) throws `replay-incompatible`
 * when the verdict is not playable. Decode stays open so the file can
 * still be catalogued. Load and the runner call the assert before any step.
 */

import {
  classifyReplayFormatVersion,
  type ReplayFormatVersionClass,
} from "./replayFormatCatalog.ts";
import {
  classifyReplayMapVersion,
  readReplayContainerMapVersion,
  type ReplayMapVersionClass,
} from "./replayMapVersion.ts";
import {
  classifyReplaySimulationVersion,
  readReplayContainerSimulationVersion,
  type ReplaySimulationVersionClass,
} from "./replaySimulationVersion.ts";

export const REPLAY_COMPATIBILITY_INVALID =
  "replay-compatibility-invalid" as const;

export type ReplayCompatibilityErrorCode = typeof REPLAY_COMPATIBILITY_INVALID;

export class ReplayCompatibilityError extends Error {
  readonly code: ReplayCompatibilityErrorCode;
  readonly detail: string | null;

  constructor(message: string, opts?: { detail?: string | null }) {
    super(message);
    this.name = "ReplayCompatibilityError";
    this.code = REPLAY_COMPATIBILITY_INVALID;
    this.detail = opts?.detail ?? null;
  }
}

export type ReplayCompatibilityMode =
  | "current"
  | "previous"
  | "migrate"
  | "historical-sim"
  | "unsupported";

export type ReplayCompatibilityAxis = {
  readonly versionClass:
    | ReplayFormatVersionClass
    | ReplaySimulationVersionClass
    | ReplayMapVersionClass;
  readonly mode: ReplayCompatibilityMode;
  readonly playable: boolean;
};

export type ReplayCompatibilityClasses = {
  readonly format: ReplayFormatVersionClass;
  readonly simulation: ReplaySimulationVersionClass;
  readonly map: ReplayMapVersionClass;
};

export type ReplayCompatibility = {
  readonly mode: ReplayCompatibilityMode;
  readonly playable: boolean;
  readonly format: ReplayCompatibilityAxis;
  readonly simulation: ReplayCompatibilityAxis;
  readonly map: ReplayCompatibilityAxis;
};

/** Format class → support mode. A previous format needs a migration. */
export const REPLAY_FORMAT_SUPPORT: Readonly<
  Record<ReplayFormatVersionClass, ReplayCompatibilityMode>
> = Object.freeze({
  current: "current",
  previous: "migrate",
  unknown: "unsupported",
  absent: "unsupported",
  malformed: "unsupported",
});

/**
 * Simulation class → support mode. `absent` plays on the current rules
 * and is not reported as version 1. A previous ruleset needs a historical
 * simulator.
 */
export const REPLAY_SIMULATION_SUPPORT: Readonly<
  Record<ReplaySimulationVersionClass, ReplayCompatibilityMode>
> = Object.freeze({
  current: "current",
  previous: "historical-sim",
  unknown: "unsupported",
  absent: "current",
  malformed: "unsupported",
});

/** Map schema class → support mode. Schema 1 is previous and plays directly. */
export const REPLAY_MAP_SUPPORT: Readonly<
  Record<ReplayMapVersionClass, ReplayCompatibilityMode>
> = Object.freeze({
  current: "current",
  previous: "previous",
  unknown: "unsupported",
  absent: "unsupported",
  malformed: "unsupported",
});

const SEVERITY: Readonly<Record<ReplayCompatibilityMode, number>> = Object
  .freeze({
    current: 0,
    previous: 1,
    migrate: 2,
    "historical-sim": 3,
    unsupported: 4,
  });

function axis<Class extends ReplayCompatibilityAxis["versionClass"]>(
  versionClass: Class,
  table: Readonly<Record<Class, ReplayCompatibilityMode>>,
): ReplayCompatibilityAxis {
  const mode = table[versionClass];
  if (mode === undefined) {
    throw new ReplayCompatibilityError(
      "unknown compatibility class",
      { detail: versionClass },
    );
  }
  return Object.freeze({
    versionClass,
    mode,
    playable: mode === "current" || mode === "previous",
  });
}

export function replayFormatSupport(
  versionClass: ReplayFormatVersionClass,
): ReplayCompatibilityAxis {
  return axis(versionClass, REPLAY_FORMAT_SUPPORT);
}

export function replaySimulationSupport(
  versionClass: ReplaySimulationVersionClass,
): ReplayCompatibilityAxis {
  return axis(versionClass, REPLAY_SIMULATION_SUPPORT);
}

export function replayMapSupport(
  versionClass: ReplayMapVersionClass,
): ReplayCompatibilityAxis {
  return axis(versionClass, REPLAY_MAP_SUPPORT);
}

export function replayCompatibility(
  classes: ReplayCompatibilityClasses,
): ReplayCompatibility {
  const format = replayFormatSupport(classes.format);
  const simulation = replaySimulationSupport(classes.simulation);
  const map = replayMapSupport(classes.map);
  let mode: ReplayCompatibilityMode = "current";
  for (const part of [format, simulation, map]) {
    if (SEVERITY[part.mode] > SEVERITY[mode]) mode = part.mode;
  }
  return Object.freeze({
    mode,
    playable: mode === "current" || mode === "previous",
    format,
    simulation,
    map,
  });
}

export function replayCompatibilityFromVersions(versions: {
  readonly format: unknown;
  readonly simulation: unknown;
  readonly map: unknown;
}): ReplayCompatibility {
  return replayCompatibility({
    format: classifyReplayFormatVersion(versions.format),
    simulation: classifyReplaySimulationVersion(versions.simulation),
    map: classifyReplayMapVersion(versions.map),
  });
}

/**
 * Reads the stamped format, simulation, and map versions. Does not fill
 * a missing simulation stamp and does not decode the file.
 */
export function replayCompatibilityFromContainer(container: {
  readonly header?: {
    readonly replayFormatVersion?: unknown;
    readonly map?: { readonly version?: unknown } | null;
  } | null;
  readonly metadata?: { readonly simulationVersion?: unknown } | null;
  readonly initialState?: {
    readonly metadata?: {
      readonly simulationVersion?: unknown;
      readonly map?: { readonly version?: unknown } | null;
    } | null;
    readonly init?: {
      readonly map?: { readonly version?: unknown } | null;
    } | null;
  } | null;
}): ReplayCompatibility {
  return replayCompatibilityFromVersions({
    format: container.header?.replayFormatVersion,
    simulation: readReplayContainerSimulationVersion(container),
    map: readReplayContainerMapVersion(container),
  });
}

/**
 * A reconstructed session. A file header wins. An in-memory session with
 * no format stamp is this process's session: the format axis is current,
 * and the missing stamp is not written back. A missing simulation stamp
 * stays absent.
 */
export function replayCompatibilityFromRunSession(session: {
  readonly header?: {
    readonly replayFormatVersion?: unknown;
    readonly map?: { readonly version?: unknown } | null;
  } | null;
  readonly metadata?: { readonly simulationVersion?: unknown } | null;
  readonly initialState: {
    readonly metadata?: {
      readonly simulationVersion?: unknown;
      readonly replayFormatVersion?: unknown;
      readonly map?: { readonly version?: unknown } | null;
    } | null;
    readonly init?: {
      readonly map?: { readonly version?: unknown } | null;
    } | null;
  };
}): ReplayCompatibility {
  const header = session.header;
  if (header != null && "replayFormatVersion" in header) {
    return replayCompatibilityFromContainer(session);
  }
  const meta = session.initialState.metadata;
  const format = meta != null && "replayFormatVersion" in meta
    ? classifyReplayFormatVersion(meta.replayFormatVersion)
    : "current";
  return replayCompatibility({
    format,
    simulation: classifyReplaySimulationVersion(
      readReplayContainerSimulationVersion(session),
    ),
    map: classifyReplayMapVersion(readReplayContainerMapVersion(session)),
  });
}

export const REPLAY_INCOMPATIBLE = "replay-incompatible" as const;

export type ReplayIncompatibleErrorCode = typeof REPLAY_INCOMPATIBLE;

/** Thrown when playing the replay would resimulate under the wrong rules. */
export class ReplayIncompatibleError extends Error {
  readonly code: ReplayIncompatibleErrorCode;
  readonly detail: string | null;
  readonly mode: ReplayCompatibilityMode;

  constructor(verdict: ReplayCompatibility) {
    const detail =
      `format=${verdict.format.versionClass} simulation=${verdict.simulation.versionClass} map=${verdict.map.versionClass}`;
    super(`replay is incompatible (${verdict.mode})`);
    this.name = "ReplayIncompatibleError";
    this.code = REPLAY_INCOMPATIBLE;
    this.detail = detail;
    this.mode = verdict.mode;
  }
}

/**
 * Fail closed before a step. A playable verdict (`current` or `previous`)
 * returns. Every other mode throws `replay-incompatible`.
 */
export function assertReplayPlayable(
  verdict: ReplayCompatibility,
): asserts verdict is ReplayCompatibility & {
  readonly playable: true;
  readonly mode: "current" | "previous";
} {
  if (verdict.playable) return;
  throw new ReplayIncompatibleError(verdict);
}
