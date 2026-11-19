/**
 * Epic 19.7 — storage capacity.
 *
 * Estimates how many bytes an expected match volume needs, from one
 * measured file. The baseline is `fileBytes`, the recorded span
 * `durationTicks` (`lastTick - firstTick + 1`), and `playerCount`.
 * A 19.3 `ReplaySizeLevel` has those fields and can be passed directly.
 * The volume is how many finalized matches to keep, and optionally a
 * different span or roster.
 *
 * The same span and roster cost `matches * fileBytes`. A different span
 * or roster scales that file in proportion. Inputs dominate a packed
 * file, so ticks and roster are the two axes. The roster already counts
 * bots (19.3). Event rate and tick rate stay inside the measured file:
 * a higher tick rate is a longer span, and a chattier match needs its
 * own baseline. The header is inside the rate, so a much shorter or
 * smaller match is estimated a little low and a much longer or larger
 * match a little high. Pass a baseline close to the volume.
 *
 * Each match rounds up, then the match count multiplies. A product that
 * is not a safe integer throws. A roster of 0 does not scale: an empty
 * baseline cannot grow a roster, and a non-empty baseline cannot shrink
 * to none.
 *
 * The cap check compares the estimate with a cap the caller supplies.
 * A total equal to the cap fits. 16.6 purges only when the stored sum
 * is over `REPLAY_TOTAL_SIZE_CAP_BYTES`, so the same edge holds here.
 * This module does not read that constant, does not delete a file, and
 * does not block a recording. `matchesAtCap` is how many matches of
 * this shape fit. A zero-byte match does not consume the cap, so that
 * count is null.
 *
 * No clock, no file, no encode. The status page is 23.4. The 16.6 sweep
 * is unchanged.
 */

export const REPLAY_STORAGE_CAPACITY_INVALID =
  "replay-storage-capacity-invalid" as const;

export type ReplayStorageCapacityErrorCode =
  typeof REPLAY_STORAGE_CAPACITY_INVALID;

export class ReplayStorageCapacityError extends Error {
  readonly code: ReplayStorageCapacityErrorCode;
  readonly detail: string | null;

  constructor(message: string, detail?: string | null) {
    super(message);
    this.name = "ReplayStorageCapacityError";
    this.code = REPLAY_STORAGE_CAPACITY_INVALID;
    this.detail = detail ?? null;
  }
}

/** One measured file. A 19.3 level is a valid baseline. */
export type ReplayStorageBaseline = {
  readonly fileBytes: number;
  readonly durationTicks: number;
  readonly playerCount: number;
};

/**
 * Matches kept at once. Omitted span and roster use the baseline.
 * Span is the recorded tick count, not the configured match length.
 */
export type ReplayStorageVolume = {
  readonly matches: number;
  readonly durationTicks?: number;
  readonly playerCount?: number;
};

export type ReplayStorageEstimate = {
  readonly matches: number;
  readonly durationTicks: number;
  readonly playerCount: number;
  readonly bytesPerMatch: number;
  readonly requiredBytes: number;
};

export type ReplayStorageCapCheck = {
  readonly requiredBytes: number;
  readonly capBytes: number;
  readonly bytesPerMatch: number;
  readonly fits: boolean;
  /** Cap minus required when it fits. Otherwise 0. */
  readonly headroomBytes: number;
  /** Required minus cap when it does not fit. Otherwise 0. */
  readonly overBytes: number;
  /**
   * Whole matches of this shape that fit in the cap.
   * Null when a match is 0 bytes.
   */
  readonly matchesAtCap: number | null;
};

function fail(message: string, detail?: string): never {
  throw new ReplayStorageCapacityError(message, detail ?? null);
}

function assertCount(name: string, value: number): void {
  if (
    !Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)
  ) {
    fail(`${name} must be an integer >= 0`, String(value));
  }
}

function assertSpan(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || Object.is(value, -0)) {
    fail(`${name} must be an integer >= 1`, String(value));
  }
}

function gcd(a: number, b: number): number {
  let x = a;
  let y = b;
  while (y !== 0) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x;
}

/** ceil(numerator / denominator) for safe integers. Denominator is >= 1. */
function ceilDiv(numerator: number, denominator: number): number {
  if (denominator === 1) return numerator;
  const q = Math.floor(numerator / denominator);
  const qd = q * denominator;
  if (!Number.isSafeInteger(qd)) {
    fail("replay storage quotient exceeds a safe integer", String(qd));
  }
  const rem = numerator - qd;
  if (rem === 0) return q;
  if (rem < 0) {
    fail("replay storage quotient is not exact", String(q));
  }
  const next = q + 1;
  if (!Number.isSafeInteger(next)) {
    fail("replay storage total exceeds a safe integer", String(next));
  }
  return next;
}

/** ceil(value * numerator / denominator). */
function ceilMulDiv(value: number, numerator: number, denominator: number): number {
  if (numerator === denominator) return value;
  const g = gcd(numerator, denominator);
  const num = numerator / g;
  const den = denominator / g;
  if (num === 1) return ceilDiv(value, den);
  const product = value * num;
  if (!Number.isSafeInteger(product)) {
    fail("replay storage product exceeds a safe integer", String(product));
  }
  return ceilDiv(product, den);
}

function scaledMatchBytes(
  fileBytes: number,
  durationTicks: number,
  playerCount: number,
  baseDuration: number,
  basePlayers: number,
): number {
  if (durationTicks === baseDuration && playerCount === basePlayers) {
    return fileBytes;
  }
  if (playerCount === basePlayers) {
    return ceilMulDiv(fileBytes, durationTicks, baseDuration);
  }
  if (durationTicks === baseDuration) {
    return ceilMulDiv(fileBytes, playerCount, basePlayers);
  }
  const num = durationTicks * playerCount;
  const den = baseDuration * basePlayers;
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den)) {
    fail("replay storage scale exceeds a safe integer", `${num}/${den}`);
  }
  return ceilMulDiv(fileBytes, num, den);
}

/** Bytes for one volume. Does not read a clock or a file. */
export function estimateReplayStorage(
  baseline: ReplayStorageBaseline,
  volume: ReplayStorageVolume,
): ReplayStorageEstimate {
  assertCount("fileBytes", baseline.fileBytes);
  assertSpan("durationTicks", baseline.durationTicks);
  assertCount("playerCount", baseline.playerCount);
  assertCount("matches", volume.matches);
  const durationTicks = volume.durationTicks ?? baseline.durationTicks;
  const playerCount = volume.playerCount ?? baseline.playerCount;
  assertSpan("durationTicks", durationTicks);
  assertCount("playerCount", playerCount);
  if (baseline.playerCount === 0 && playerCount !== 0) {
    fail(
      "playerCount cannot scale from an empty roster",
      `${playerCount} from 0`,
    );
  }
  if (baseline.playerCount !== 0 && playerCount === 0) {
    fail(
      "playerCount cannot scale to an empty roster",
      `0 from ${baseline.playerCount}`,
    );
  }
  const bytesPerMatch = scaledMatchBytes(
    baseline.fileBytes,
    durationTicks,
    playerCount,
    baseline.durationTicks,
    baseline.playerCount,
  );
  let requiredBytes = 0;
  if (volume.matches !== 0 && bytesPerMatch !== 0) {
    if (volume.matches === 1) {
      requiredBytes = bytesPerMatch;
    } else {
      const total = bytesPerMatch * volume.matches;
      if (!Number.isSafeInteger(total)) {
        fail("replay storage total exceeds a safe integer", String(total));
      }
      requiredBytes = total;
    }
  }
  return {
    matches: volume.matches,
    durationTicks,
    playerCount,
    bytesPerMatch,
    requiredBytes,
  };
}

/**
 * Does this estimate fit in `capBytes`? Equal fits. A 0-byte match
 * leaves `matchesAtCap` null.
 */
export function checkReplayStorageCap(
  estimate: ReplayStorageEstimate,
  capBytes: number,
): ReplayStorageCapCheck {
  assertCount("requiredBytes", estimate.requiredBytes);
  assertCount("bytesPerMatch", estimate.bytesPerMatch);
  assertCount("capBytes", capBytes);
  const fits = estimate.requiredBytes <= capBytes;
  const matchesAtCap = estimate.bytesPerMatch === 0
    ? null
    : Math.floor(capBytes / estimate.bytesPerMatch);
  return {
    requiredBytes: estimate.requiredBytes,
    capBytes,
    bytesPerMatch: estimate.bytesPerMatch,
    fits,
    headroomBytes: fits ? capBytes - estimate.requiredBytes : 0,
    overBytes: fits ? 0 : estimate.requiredBytes - capBytes,
    matchesAtCap,
  };
}
