/**
 * Epic 10.5 — minimal replay format-version gate.
 *
 * Version contract (locked):
 * - Stamp: file identity is `REPLAY_FORMAT_VERSION` (= 1) as
 *   `header.replayFormatVersion`. One constant only (Decision 1 — no second
 *   top-level schema version).
 * - Check-first: callers (8.6 verify, 11.1 load, 16.x serve, 10.2 decode) must
 *   assert acceptance before trusting streams, checkpoints, index, integrity,
 *   or the sim.
 * - Strict accept: exactly integer `1`. Missing / `0` / `≥ 2` / non-integer /
 *   string / NaN → `replay-version-mismatch` with `{ expected: 1, seen }`.
 *   No defaults, no warn-and-continue, no partial container.
 * - Sub-versions (`indexVersion`, `integrityVersion`) are carried verbatim and
 *   gated only by their own sections — never by this top-level gate.
 * - Companions (map name+version, matchSeed, tickRate, gameProto, buildSha) may
 *   be echoed in rejection context; 10.5 assigns them no accept/reject meaning
 *   (#17 owns sim/map/support policy).
 * - #17 expands acceptance / migration / historical sims under a version bump;
 *   never silently widen the v1 set here.
 *
 * Purity (scan-locked): imports only the planted constant from matchMetadata —
 * no sim, network, blob, store, codec, compression, hash, signature, or
 * filesystem modules.
 */

import {
  REPLAY_FORMAT_VERSION,
  type ReplayFormatVersion,
} from "./matchMetadata.ts";

export { REPLAY_FORMAT_VERSION, type ReplayFormatVersion };

/** 10.2 taxonomy name reused by the gate (never redefined). */
export const REPLAY_FORMAT_VERSION_MISMATCH = "replay-version-mismatch" as const;

export type ReplayFormatVersionMismatchCode =
  typeof REPLAY_FORMAT_VERSION_MISMATCH;

/** Opaque companion fields echoed in rejection context only (never gated). */
export type ReplayFormatVersionCompanionEcho = {
  readonly map?: { readonly name?: unknown; readonly version?: unknown };
  readonly matchSeed?: unknown;
  readonly tickRate?: unknown;
  readonly gameProto?: unknown;
  readonly buildSha?: unknown;
};

export type ReplayFormatVersionHeader = {
  readonly replayFormatVersion?: unknown;
  readonly map?: { readonly name?: unknown; readonly version?: unknown };
  readonly matchSeed?: unknown;
  readonly tickRate?: unknown;
  readonly gameProto?: unknown;
  readonly buildSha?: unknown;
};

/**
 * Strict v1 acceptance: `value === REPLAY_FORMAT_VERSION` (exactly `1`).
 * Rejects missing, non-numbers, non-integers-as-distinct-values, strings, NaN.
 */
export function isSupportedReplayFormatVersion(
  value: unknown,
): value is ReplayFormatVersion {
  return value === REPLAY_FORMAT_VERSION;
}

/**
 * Fail-closed gate: missing / unknown version → `ReplayFormatVersionError`
 * (`replay-version-mismatch`) with `{ expected, seen }`. Never mutates input.
 */
export function assertReplayFormatVersion(
  header: ReplayFormatVersionHeader | null | undefined,
  companions?: ReplayFormatVersionCompanionEcho,
): asserts header is ReplayFormatVersionHeader & {
  readonly replayFormatVersion: ReplayFormatVersion;
} {
  if (header == null || typeof header !== "object") {
    throw new ReplayFormatVersionError(undefined, {
      companions: companions ?? null,
      message: missingVersionMessage(companions ?? null),
    });
  }
  const seen = (header as ReplayFormatVersionHeader).replayFormatVersion;
  const echo = companions ?? extractCompanions(header);
  if (!isSupportedReplayFormatVersion(seen)) {
    if (seen === undefined) {
      throw new ReplayFormatVersionError(seen, {
        companions: echo,
        message: missingVersionMessage(echo),
      });
    }
    throw new ReplayFormatVersionError(seen, { companions: echo });
  }
}

export class ReplayFormatVersionError extends Error {
  readonly code: ReplayFormatVersionMismatchCode = REPLAY_FORMAT_VERSION_MISMATCH;
  readonly expected: typeof REPLAY_FORMAT_VERSION = REPLAY_FORMAT_VERSION;
  readonly seen: unknown;
  readonly companions: ReplayFormatVersionCompanionEcho | null;

  constructor(
    seen: unknown,
    opts?: {
      companions?: ReplayFormatVersionCompanionEcho | null;
      message?: string;
    },
  ) {
    const companions = opts?.companions ?? null;
    const message = opts?.message ??
      `unsupported replayFormatVersion: ${stringifySeen(seen)} (expected ${REPLAY_FORMAT_VERSION})${formatCompanionEcho(companions)}`;
    super(message);
    this.name = "ReplayFormatVersionError";
    this.seen = seen;
    this.companions = companions;
  }
}

function extractCompanions(
  header: ReplayFormatVersionHeader,
): ReplayFormatVersionCompanionEcho {
  const out: {
    map?: { name?: unknown; version?: unknown };
    matchSeed?: unknown;
    tickRate?: unknown;
    gameProto?: unknown;
    buildSha?: unknown;
  } = {};
  if (header.map != null && typeof header.map === "object") {
    out.map = { name: header.map.name, version: header.map.version };
  }
  if ("matchSeed" in header) out.matchSeed = header.matchSeed;
  if ("tickRate" in header) out.tickRate = header.tickRate;
  if ("gameProto" in header) out.gameProto = header.gameProto;
  if ("buildSha" in header) out.buildSha = header.buildSha;
  return out;
}

function missingVersionMessage(
  companions: ReplayFormatVersionCompanionEcho | null,
): string {
  return `replayFormatVersion missing (expected ${REPLAY_FORMAT_VERSION})${formatCompanionEcho(companions)}`;
}

function formatCompanionEcho(
  companions: ReplayFormatVersionCompanionEcho | null,
): string {
  if (companions == null) return "";
  const parts: string[] = [];
  if (companions.map != null) {
    const name = companions.map.name;
    const version = companions.map.version;
    if (name != null || version != null) {
      parts.push(`map ${String(name ?? "?")} v${String(version ?? "?")}`);
    }
  }
  if (companions.matchSeed !== undefined) {
    parts.push(`seed ${String(companions.matchSeed)}`);
  }
  if (companions.tickRate !== undefined) {
    parts.push(`tickRate ${String(companions.tickRate)}`);
  }
  if (companions.gameProto !== undefined) {
    parts.push(`gameProto ${String(companions.gameProto)}`);
  }
  if (companions.buildSha !== undefined) {
    parts.push(`buildSha ${String(companions.buildSha)}`);
  }
  return parts.length === 0 ? "" : `; ${parts.join(", ")}`;
}

function stringifySeen(seen: unknown): string {
  if (typeof seen === "number" && Number.isNaN(seen)) return "NaN";
  if (typeof seen === "string") return JSON.stringify(seen);
  return String(seen);
}
