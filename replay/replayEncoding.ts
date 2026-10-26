/**
 * Epic 10.2 — replay container encoding (canonical JSON v1).
 *
 * Byte contract (locked):
 * - Form: single UTF-8 JSON document, no BOM, compact (no insignificant
 *   whitespace). Top-level member order = REPLAY_CONTAINER_SECTION_ORDER
 *   (Header first so version is checkable without stream semantics).
 * - Determinism: same container value → byte-identical output. Nested object
 *   keys are emitted in sorted order; section roots use documented field order.
 * - Numbers: verbatim full precision; ticks are integers; no quantization.
 * - Streams: input/event/checkpoint rows are arrays of `{ tick, … }` objects
 *   (not keyed maps); event drain order = array order; reserved Index/Integrity
 *   slots are always present (explicit empty), never omitted.
 * - Version-first: decoder reads `header.replayFormatVersion` before deep
 *   validate; missing/unknown → `replay-version-mismatch` via the 10.5 gate
 *   (`isSupportedReplayFormatVersion`). Compatibility policy (migration /
 *   historical sims / support windows) expands in #17.
 * - Tolerance: unknown Metadata (informational) keys ignored; unknown
 *   load-bearing top-level sections / Header keys rejected.
 * - Purity: no filesystem, blob, store, compression, hash, or `net/` imports.
 * - Swap point: 19.6 may replace the byte form (binary/compressed) while keeping
 *   section layout, version-carry, and error names.
 */

import {
  isSupportedReplayFormatVersion,
  REPLAY_FORMAT_VERSION,
} from "../shared/replay/replayFormatVersion.ts";
import { deepFreeze } from "./recordedInitialState.ts";
import {
  REPLAY_CONTAINER_SECTION_ORDER,
  validateReplayContainer,
  type ReplayContainer,
  type ReplayContainerHeader,
  type ReplayContainerIndex,
  type ReplayContainerIntegrity,
  type ReplayContainerMetadata,
  type ReplayContainerSectionName,
} from "./replayContainer.ts";
import {
  isEmptyReplayContainerIndex,
  isFilledReplayIndex,
  type ReplayIndex,
} from "./replayIndex.ts";

/** Named encoding/decoding failure codes (never raw SyntaxError to callers). */
export type ReplayEncodingErrorCode =
  | "replay-truncated"
  | "replay-bad-utf8"
  | "replay-bad-json"
  | "replay-bad-shape"
  | "replay-missing-section"
  | "replay-bad-tick"
  | "replay-unsupported-map"
  | "replay-missing-seed"
  | "replay-version-mismatch";

export class ReplayEncodingError extends Error {
  readonly code: ReplayEncodingErrorCode;
  readonly section: string | null;
  readonly detail: string | null;

  constructor(
    code: ReplayEncodingErrorCode,
    message: string,
    opts?: { section?: string | null; detail?: string | null },
  ) {
    super(message);
    this.name = "ReplayEncodingError";
    this.code = code;
    this.section = opts?.section ?? null;
    this.detail = opts?.detail ?? null;
  }
}

/** Documented Header member order (load-bearing; unknown keys rejected on decode). */
export const REPLAY_HEADER_FIELD_ORDER = [
  "replayFormatVersion",
  "runtimeMatchId",
  "captureTick",
  "firstTick",
  "lastTick",
  "matchSeed",
  "tickRate",
  "matchDurationTicks",
  "matchEndTick",
  "doorCycleOriginTick",
  "map",
  "prematchEnabled",
  "raidDoorPolicy",
  "debugForceDoorsOpen",
  "phase",
] as const satisfies ReadonlyArray<keyof ReplayContainerHeader>;

/** Documented Metadata member order (informational; unknown keys ignored on decode). */
export const REPLAY_METADATA_FIELD_ORDER = [
  "serverName",
  "serverId",
  "modeId",
  "raidId",
  "gameProto",
  "buildSha",
  "capturedAtIso",
] as const satisfies ReadonlyArray<keyof ReplayContainerMetadata>;

const HEADER_FIELD_SET = new Set<string>(REPLAY_HEADER_FIELD_ORDER);
const SECTION_SET = new Set<string>(REPLAY_CONTAINER_SECTION_ORDER);

const INDEX_EMPTY_FIELD_ORDER = ["schemaNote", "entries"] as const;
/** Documented filled-index member order (10.3). */
export const REPLAY_INDEX_FIELD_ORDER = [
  "indexVersion",
  "checkpoints",
  "markers",
  "phases",
  "playerActivity",
] as const satisfies ReadonlyArray<keyof ReplayIndex>;
const INTEGRITY_FIELD_ORDER = ["schemaNote", "digest"] as const;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

function fail(
  code: ReplayEncodingErrorCode,
  message: string,
  opts?: { section?: string | null; detail?: string | null },
): never {
  throw new ReplayEncodingError(code, message, opts);
}

/**
 * Recursively rebuild a JSON-safe value with sorted object keys.
 * Arrays preserve order (drain / tick order). `undefined` is dropped.
 */
function canonicalizeValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeValue(item));
  }
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src).sort()) {
    const next = canonicalizeValue(src[key]);
    if (next !== undefined) out[key] = next;
  }
  return out;
}

function pickOrdered(
  src: Record<string, unknown>,
  order: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of order) {
    if (!(key in src)) continue;
    const next = canonicalizeValue(src[key]);
    if (next !== undefined) out[key] = next;
  }
  return out;
}

function canonicalizeHeader(header: ReplayContainerHeader): Record<string, unknown> {
  return pickOrdered(
    header as unknown as Record<string, unknown>,
    REPLAY_HEADER_FIELD_ORDER,
  );
}

function canonicalizeMetadata(
  metadata: ReplayContainerMetadata,
): Record<string, unknown> {
  return pickOrdered(
    metadata as unknown as Record<string, unknown>,
    REPLAY_METADATA_FIELD_ORDER,
  );
}

function canonicalizeIndex(index: ReplayContainerIndex): Record<string, unknown> {
  if (isEmptyReplayContainerIndex(index)) {
    return pickOrdered(
      index as unknown as Record<string, unknown>,
      INDEX_EMPTY_FIELD_ORDER,
    );
  }
  if (isFilledReplayIndex(index)) {
    return pickOrdered(
      index as unknown as Record<string, unknown>,
      REPLAY_INDEX_FIELD_ORDER,
    );
  }
  fail("replay-bad-shape", "index section is neither empty reserved nor filled ReplayIndex", {
    section: "index",
  });
}

function canonicalizeIntegrity(
  integrity: ReplayContainerIntegrity,
): Record<string, unknown> {
  return pickOrdered(
    integrity as unknown as Record<string, unknown>,
    INTEGRITY_FIELD_ORDER,
  );
}

function canonicalizeSection(
  name: ReplayContainerSectionName,
  value: ReplayContainer[ReplayContainerSectionName],
): unknown {
  switch (name) {
    case "header":
      return canonicalizeHeader(value as ReplayContainerHeader);
    case "metadata":
      return canonicalizeMetadata(value as ReplayContainerMetadata);
    case "index":
      return canonicalizeIndex(value as ReplayContainerIndex);
    case "integrity":
      return canonicalizeIntegrity(value as ReplayContainerIntegrity);
    case "initialState":
    case "inputStream":
    case "eventStream":
    case "checkpoints":
      return canonicalizeValue(value);
  }
}

/**
 * Encode a frozen (or freeze-compatible) container to canonical v1 UTF-8 JSON.
 * Never mutates `container`. Compact form only — no caller formatting options.
 */
export function encodeReplayContainer(container: ReplayContainer): Uint8Array {
  const doc: Record<string, unknown> = {};
  for (const section of REPLAY_CONTAINER_SECTION_ORDER) {
    doc[section] = canonicalizeSection(section, container[section]);
  }
  // Compact JSON: no space arg. Insertion order of `doc` = section order.
  const text = JSON.stringify(doc);
  return textEncoder.encode(text);
}

function decodeUtf8(bytes: Uint8Array): string {
  if (bytes.byteLength === 0) {
    fail("replay-truncated", "replay bytes are empty", { detail: "length=0" });
  }
  try {
    return textDecoder.decode(bytes);
  } catch (err) {
    fail("replay-bad-utf8", "replay bytes are not valid UTF-8", {
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

function parseJsonDocument(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    fail("replay-bad-json", "replay bytes are not valid JSON", {
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

function assertTopLevelObject(parsed: unknown): Record<string, unknown> {
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("replay-bad-shape", "replay top-level value must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Version-first extraction. Does not deep-validate streams.
 * Returns the numeric version even when it is not the supported major (callers
 * that need strict accept use decodeReplayContainer).
 */
export function getReplayFormatVersionFromBytes(bytes: Uint8Array): number {
  const text = decodeUtf8(bytes);
  const parsed = assertTopLevelObject(parseJsonDocument(text));
  return readReplayFormatVersion(parsed);
}

function readReplayFormatVersion(doc: Record<string, unknown>): number {
  const header = doc.header;
  if (header == null || typeof header !== "object" || Array.isArray(header)) {
    fail("replay-version-mismatch", "replay header missing; cannot read format version", {
      section: "header",
    });
  }
  const version = (header as Record<string, unknown>).replayFormatVersion;
  if (typeof version !== "number" || !Number.isFinite(version) || !Number.isInteger(version)) {
    fail("replay-version-mismatch", "replayFormatVersion missing or not an integer", {
      section: "header",
      detail: `got=${String(version)}`,
    });
  }
  return version;
}

function rejectUnknownSections(doc: Record<string, unknown>): void {
  for (const key of Object.keys(doc)) {
    if (!SECTION_SET.has(key)) {
      fail("replay-bad-shape", `unknown load-bearing section: ${key}`, {
        section: key,
      });
    }
  }
}

function rejectUnknownHeaderKeys(header: Record<string, unknown>): void {
  for (const key of Object.keys(header)) {
    if (!HEADER_FIELD_SET.has(key)) {
      fail("replay-bad-shape", `unknown load-bearing header field: ${key}`, {
        section: "header",
        detail: key,
      });
    }
  }
}

function projectMetadata(raw: Record<string, unknown>): ReplayContainerMetadata {
  const out: Record<string, unknown> = {};
  for (const key of REPLAY_METADATA_FIELD_ORDER) {
    if (key in raw) out[key] = raw[key];
  }
  return out as unknown as ReplayContainerMetadata;
}

function mapValidateReason(reason: string): ReplayEncodingError {
  const lower = reason.toLowerCase();

  if (
    lower.includes("replayformatversion") ||
    lower.includes("unsupported replayformatversion")
  ) {
    return new ReplayEncodingError("replay-version-mismatch", reason, {
      section: "header",
      detail: reason,
    });
  }
  if (lower.includes("missing required section") || lower.includes("missing reserved section")) {
    const m = reason.match(/section:\s*(\w+)/i);
    return new ReplayEncodingError("replay-missing-section", reason, {
      section: m?.[1] ?? null,
      detail: reason,
    });
  }
  if (lower.includes("unsupported map version")) {
    return new ReplayEncodingError("replay-unsupported-map", reason, {
      section: "header",
      detail: reason,
    });
  }
  if (lower.includes("matchseed") && (lower.includes("missing") || lower.includes("invalid"))) {
    return new ReplayEncodingError("replay-missing-seed", reason, {
      section: "header",
      detail: reason,
    });
  }
  if (
    lower.includes("tick") &&
    (lower.includes("must be") ||
      lower.includes("out of range") ||
      lower.includes("ascending") ||
      lower.includes("gap") ||
      lower.includes("cover") ||
      lower.includes("duplicate") ||
      lower.includes("start at"))
  ) {
    return new ReplayEncodingError("replay-bad-tick", reason, {
      detail: reason,
    });
  }
  if (lower.includes("must not carry location") || lower.includes("container must be")) {
    return new ReplayEncodingError("replay-bad-shape", reason, { detail: reason });
  }
  return new ReplayEncodingError("replay-bad-shape", reason, { detail: reason });
}

/**
 * Decode canonical v1 UTF-8 JSON bytes to a frozen validated container.
 * Version is checked before deep stream validation; failures use the named
 * taxonomy only (never a raw SyntaxError / partial container).
 */
export function decodeReplayContainer(bytes: Uint8Array): ReplayContainer {
  const text = decodeUtf8(bytes);
  const parsed = assertTopLevelObject(parseJsonDocument(text));

  // Version-first (10.5): fail before validateReplayContainer walks streams.
  const version = readReplayFormatVersion(parsed);
  if (!isSupportedReplayFormatVersion(version)) {
    fail(
      "replay-version-mismatch",
      `unsupported replayFormatVersion: ${version} (expected ${REPLAY_FORMAT_VERSION})`,
      { section: "header", detail: `got=${version}` },
    );
  }

  rejectUnknownSections(parsed);

  const headerRaw = parsed.header;
  if (headerRaw == null || typeof headerRaw !== "object" || Array.isArray(headerRaw)) {
    fail("replay-missing-section", "missing required section: header", {
      section: "header",
    });
  }
  rejectUnknownHeaderKeys(headerRaw as Record<string, unknown>);

  // Metadata: drop unknown informational keys (forward-tolerant).
  if (
    parsed.metadata != null &&
    typeof parsed.metadata === "object" &&
    !Array.isArray(parsed.metadata)
  ) {
    parsed.metadata = projectMetadata(parsed.metadata as Record<string, unknown>);
  }

  const validated = validateReplayContainer(parsed);
  if (!validated.ok) {
    throw mapValidateReason(validated.reason);
  }
  return deepFreeze(validated.container);
}
