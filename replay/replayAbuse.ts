/**
 * Epic 20.5 — replay abuse controls.
 *
 * Rate limits, one upload cap, and report disposition. This module does
 * not read a store, a file, or a clock. The caller passes `nowMs` and
 * may pass its own window. The process window is the default.
 *
 * Reads, finalize, and reports each have a fixed window. A bad key or a
 * bad clock is refused. The upload cap is the same 512 MiB the recorder
 * will hold. A larger body is not a replay this server recorded.
 *
 * There is no per-account byte quota. Retention stays 16.6: disk pressure
 * and the total cap, oldest finalized file first. A report does not
 * delete a replay and does not change its visibility. Deleting the replay
 * row removes its reports. That delete stays in the store.
 *
 * A body that is not a replay container can still be finalized (16.2).
 * Playback rejection stays 20.2. The SQL checksum is 20.6. The file
 * trailer stays 10.4. No status-page surface (23.4).
 */

export const REPLAY_ABUSE_KINDS = [
  "catalog",
  "metadata",
  "file",
  "clip",
  "finalize",
  "report",
] as const;

export type ReplayAbuseKind = (typeof REPLAY_ABUSE_KINDS)[number];

/** Same ceiling as the recorder buffer. This module does not import it. */
export const REPLAY_ABUSE_UPLOAD_CAP_BYTES = 512 * 1024 * 1024;

/** A caller key longer than this is not a caller. */
export const REPLAY_ABUSE_KEY_MAX_CHARS = 256;

/**
 * No per-account storage quota. 16.6 is the storage control.
 * Null is the decision, not an unset default.
 */
export const REPLAY_ACCOUNT_STORAGE_QUOTA_BYTES = null;

export const REPLAY_REPORT_REASONS = [
  "malicious",
  "personal-info",
  "other",
] as const;

export type ReplayReportReason = (typeof REPLAY_REPORT_REASONS)[number];

/** One replay keeps at most this many distinct reporters. */
export const REPLAY_REPORT_CAP = 64;

/** A report body larger than this is not a report. */
export const REPLAY_REPORT_BODY_MAX_CHARS = 1024;

export const REPLAY_ABUSE_LIMITS: Readonly<
  Record<ReplayAbuseKind, { readonly limit: number; readonly windowMs: number }>
> = {
  catalog: { limit: 60, windowMs: 60_000 },
  metadata: { limit: 120, windowMs: 60_000 },
  file: { limit: 30, windowMs: 60_000 },
  clip: { limit: 120, windowMs: 60_000 },
  finalize: { limit: 120, windowMs: 60_000 },
  report: { limit: 5, windowMs: 60_000 },
};

export type ReplayAbuseBucket = {
  count: number;
  resetAt: number;
};

export type ReplayAbuseWindow = Map<string, ReplayAbuseBucket>;

export type ReplayAbuseDecision = {
  readonly allowed: boolean;
  readonly retryAfterMs: number;
};

export type ReplayAbuseClock = {
  readonly nowMs?: number;
  readonly window?: ReplayAbuseWindow;
};

const processWindow: ReplayAbuseWindow = new Map();

export function createReplayAbuseWindow(): ReplayAbuseWindow {
  return new Map();
}

function windowOf(explicit: ReplayAbuseWindow | undefined): ReplayAbuseWindow {
  return explicit ?? processWindow;
}

function normalizeAbuseKey(value: string): string | null {
  if (typeof value !== "string") return null;
  const key = value.trim();
  if (!key || key.length > REPLAY_ABUSE_KEY_MAX_CHARS) return null;
  if (key.includes("\0")) return null;
  return key;
}

function refused(windowMs: number): ReplayAbuseDecision {
  return { allowed: false, retryAfterMs: windowMs };
}

/**
 * Count one attempt. Allowed when the key is still inside its limit.
 * Does not read a clock. A non-finite `nowMs` is refused.
 */
export function allowReplayAbuse(args: {
  readonly kind: ReplayAbuseKind;
  readonly key: string;
  readonly nowMs: number;
  readonly window?: ReplayAbuseWindow;
}): ReplayAbuseDecision {
  const spec = REPLAY_ABUSE_LIMITS[args.kind];
  if (!spec) return refused(60_000);
  if (typeof args.nowMs !== "number" || !Number.isFinite(args.nowMs)) {
    return refused(spec.windowMs);
  }
  const key = normalizeAbuseKey(args.key);
  if (!key) return refused(spec.windowMs);
  const window = windowOf(args.window);
  const bucketKey = `${args.kind}:${key}`;
  const existing = window.get(bucketKey);
  if (!existing || args.nowMs >= existing.resetAt) {
    window.set(bucketKey, {
      count: 1,
      resetAt: args.nowMs + spec.windowMs,
    });
    return { allowed: true, retryAfterMs: 0 };
  }
  existing.count += 1;
  if (existing.count > spec.limit) {
    return {
      allowed: false,
      retryAfterMs: Math.max(0, existing.resetAt - args.nowMs),
    };
  }
  return { allowed: true, retryAfterMs: 0 };
}

/** Authentic server id, the finalize bucket. Empty is not a server. */
export function replayFinalizeAbuseKey(serverId: string): string | null {
  const id = normalizeAbuseKey(serverId);
  if (!id) return null;
  return `server:${id}`;
}

/**
 * One report per account. With no account, one report per IP.
 * The account id is not a file field.
 */
export function replayReporterKey(
  accountId: string | null,
  ip: string,
): string | null {
  if (accountId != null) {
    const id = normalizeAbuseKey(accountId);
    if (id) return `account:${id}`;
  }
  const host = normalizeAbuseKey(ip);
  if (!host) return null;
  return `ip:${host}`;
}

export function normalizeReplayReportReason(
  value: unknown,
): ReplayReportReason | null {
  if (typeof value !== "string") return null;
  const reason = value.trim();
  if (REPLAY_REPORT_REASONS.includes(reason as ReplayReportReason)) {
    return reason as ReplayReportReason;
  }
  return null;
}

/** A report never changes the row. The store enforces that by not writing it. */
export function replayReportDisposition(): {
  readonly changesVisibility: false;
  readonly deletesReplay: false;
} {
  return { changesVisibility: false, deletesReplay: false };
}

/** Decimal Content-Length, or null when the header is absent or not a count. */
export function replayDeclaredUploadBytes(header: string | null): number | null {
  if (header == null) return null;
  const raw = header.trim();
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) return null;
  return n;
}

/** True when a declared or actual length is past the upload cap. */
export function replayUploadRejected(
  declared: number | null,
  actual: number | null,
): boolean {
  if (declared != null && declared > REPLAY_ABUSE_UPLOAD_CAP_BYTES) return true;
  if (actual != null && actual > REPLAY_ABUSE_UPLOAD_CAP_BYTES) return true;
  return false;
}

/** A length the recorder could have produced. Zero is empty, not a cap miss. */
export function replayUploadFits(byteLength: number): boolean {
  return Number.isSafeInteger(byteLength) &&
    byteLength > 0 &&
    byteLength <= REPLAY_ABUSE_UPLOAD_CAP_BYTES;
}
