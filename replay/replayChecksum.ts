/**
 * Epic 20.6 — validate the checksum stored beside a replay file.
 *
 * 16.2 stores SHA-256 of the finalized bytes in `replays.checksum`.
 * That column is not a field of the file. This module compares the
 * stored text to a digest the caller computed. It does not hash, read
 * a file, or write a digest.
 *
 * A null or blank checksum is unverified. The file may still be served.
 * Any other value must be 64 hex digits. A mismatch or a malformed
 * value is not served. A stamped size that is not the blob length is
 * truncated and is not served.
 *
 * 10.4 still owns the integrity trailer. The loader stays unverified.
 * 18.2 state hashes are not this checksum. No clock, no file, no store.
 * The status page is 23.4.
 */

export const REPLAY_CHECKSUM_ALGORITHM = "sha256";

export const REPLAY_CHECKSUM_HEX_LENGTH = 64;

export type ReplayChecksumVerdict =
  | "match"
  | "unverified"
  | "mismatch"
  | "malformed";

export type ReplayFileSizeVerdict = "match" | "unstamped" | "truncated";

const SHA256_HEX = /^[0-9a-fA-F]{64}$/;

export function isReplayChecksumHex(value: string): boolean {
  return SHA256_HEX.test(value);
}

/**
 * Compare a stored checksum to the hex the caller computed over the
 * whole file. Does not hash. Case differs only in the hex alphabet.
 */
export function replayChecksumVerdict(
  stored: string | null | undefined,
  actualHex: string,
): ReplayChecksumVerdict {
  if (stored == null) return "unverified";
  const expected = stored.trim();
  if (expected === "") return "unverified";
  if (typeof actualHex !== "string") return "malformed";
  const actual = actualHex.trim();
  if (!isReplayChecksumHex(expected) || !isReplayChecksumHex(actual)) {
    return "malformed";
  }
  return expected.toLowerCase() === actual.toLowerCase() ? "match" : "mismatch";
}

/** Stamped `file_size_bytes` against the blob length. Null means unstamped. */
export function replayFileSizeVerdict(
  stamped: number | null | undefined,
  actualBytes: number,
): ReplayFileSizeVerdict {
  if (stamped == null) return "unstamped";
  if (!Number.isSafeInteger(stamped) || stamped < 0) return "truncated";
  if (!Number.isSafeInteger(actualBytes) || actualBytes < 0) return "truncated";
  return stamped === actualBytes ? "match" : "truncated";
}

/**
 * A truncated blob is not served. A checksum mismatch or a malformed
 * checksum is not served. Unverified (no checksum) is served.
 */
export function replayBytesServable(args: {
  readonly size: ReplayFileSizeVerdict;
  readonly checksum: ReplayChecksumVerdict;
}): boolean {
  if (args.size === "truncated") return false;
  if (args.checksum === "mismatch" || args.checksum === "malformed") return false;
  return args.checksum === "match" || args.checksum === "unverified";
}
