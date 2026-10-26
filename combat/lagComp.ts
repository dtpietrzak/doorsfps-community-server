/**
 * Lag-comp rewind tick selection for hitscan.
 *
 * When the client stamps ShootPacket.clientTick (render-time estimate of the
 * world they aimed at), sample that tick ±1. Do not also sample live simTick —
 * that sits ahead of the delayed remote mesh and forces players to lead movers.
 *
 * With LAG_COMP_RTT_WINDOW, the server owns the legal rewind band: clamp the
 * stamp into an RTT + last-snapshot window instead of trusting any tick in
 * the last 250 ms. Missing/invalid stamps map to the expected tick (not the
 * dense fallback search). Bots and the flag-off path keep the old behavior.
 */

import {
  LAG_COMP_FALLBACK_REWIND_TICKS,
  LAG_COMP_MAX_REWIND_TICKS,
  SNAPSHOT_EVERY_TICKS,
  TICK_HZ,
} from "../protocol/network.ts";

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Server-owned rewind window (anti-backtrack). Ship on; pad is generous so
 * honest high-jitter / one-missed-snap shots still connect.
 */
export const LAG_COMP_RTT_WINDOW = true;

/** Keep in sync with client `remoteInterp.ts` INTERP_DELAY_*. */
export const LAG_COMP_INTERP_MIN_MS = 50;
export const LAG_COMP_INTERP_DEFAULT_MS = 75;
export const LAG_COMP_INTERP_MAX_MS = 150;

/** Cap one-way delay used in the expect-tick formula. */
export const LAG_COMP_ONE_WAY_MAX_MS = 200;

/** Assumed RTT until two pongs have landed (do not treat 0 as LAN). */
export const LAG_COMP_UNKNOWN_RTT_MS = 80;

/** Base pad on each side of expectTick (ticks). */
export const LAG_COMP_PAD_BASE_TICKS = 2;

/** Oldest lastAppliedSnapshotTick, in snapshot periods (~150 ms at 20 Hz). */
export const LAG_COMP_LAST_APPLIED_MAX_SNAPS = 3;

/** volDrop % at/above which pad grows by one extra snapshot. */
export const LAG_COMP_VOLDROP_WIDEN_PCT = 15;

/** volDrop % at/above which pad grows by two extra snapshots. */
export const LAG_COMP_VOLDROP_WIDEN_HIGH_PCT = 40;

/** EWMA blend for RTT / jitter (higher = snappier). */
export const PING_EWMA_ALPHA = 0.3;

export function msToRewindTicks(ms: number): number {
  const n = typeof ms === "number" && Number.isFinite(ms) ? ms : 0;
  return Math.round((Math.max(0, n) * TICK_HZ) / 1000);
}

export type PingFilter = {
  sampleCount: number;
  ewmaMs: number;
  jitterMs: number;
};

export function createPingFilter(): PingFilter {
  return { sampleCount: 0, ewmaMs: 0, jitterMs: 0 };
}

/**
 * Fold one RTT sample. First pong is recorded but not used as a stable EWMA
 * (ignore-first). Later samples update EWMA + mean-abs-deviation jitter.
 */
export function observeRttSample(state: PingFilter, rttMs: number): PingFilter {
  if (!Number.isFinite(rttMs) || rttMs < 0 || rttMs > 15_000) {
    return state;
  }
  const sampleCount = state.sampleCount + 1;
  if (sampleCount === 1) {
    return { sampleCount, ewmaMs: rttMs, jitterMs: 0 };
  }
  const prev = state.ewmaMs > 0 ? state.ewmaMs : rttMs;
  const ewmaMs = prev * (1 - PING_EWMA_ALPHA) + rttMs * PING_EWMA_ALPHA;
  const delta = Math.abs(rttMs - ewmaMs);
  const jitterMs = state.jitterMs * (1 - PING_EWMA_ALPHA) +
    delta * PING_EWMA_ALPHA;
  return { sampleCount, ewmaMs, jitterMs };
}

export type LagCompWindowInput = {
  simTick: number;
  clientTick?: number;
  lastSnapTick: number;
  lastAppliedSnapshotTick?: number;
  /** EWMA RTT; ignored when pingReady is false. */
  pingEwmaMs?: number;
  pingJitterMs?: number;
  /** True after the second successful pong. */
  pingReady?: boolean;
  volDropPct?: number;
  /**
   * Client interp delay, accepted only in [50, 150]. May narrow, or shift
   * expect older when volDrop / jitter say the link is actually bad.
   */
  interpDelayMs?: number;
};

export type LagCompClampDir = "none" | "forward" | "back";

export type LagCompWindow = {
  /** Stamp to sample (±1 still applied by {@link buildLagCompTicks}). */
  tick: number;
  lo: number;
  hi: number;
  expectTick: number;
  clamped: boolean;
  clampDir: LagCompClampDir;
};

function parseOptionalTick(n: number | undefined): number | undefined {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

/**
 * Accept lastAppliedSnapshotTick only if it is a tick we could have emitted
 * and it is not older than ~3 snapshot periods (or RTT+jitter, whichever is
 * larger). Cheaters cannot name an arbitrary history tick this way.
 */
export function sanitizeLastAppliedSnapshotTick(opts: {
  lastApplied: number | undefined;
  lastSnap: number;
  rttMs: number;
  jitterMs: number;
}): number | undefined {
  const tick = parseOptionalTick(opts.lastApplied);
  if (tick == null) return undefined;
  const lastSnap = Math.max(0, Math.floor(opts.lastSnap));
  if (tick > lastSnap) return undefined;
  const onGrid = tick % SNAPSHOT_EVERY_TICKS === 0 || tick === lastSnap;
  if (!onGrid) return undefined;
  const rttAge = msToRewindTicks(opts.rttMs + opts.jitterMs) +
    SNAPSHOT_EVERY_TICKS;
  const maxAge = Math.max(
    LAG_COMP_LAST_APPLIED_MAX_SNAPS * SNAPSHOT_EVERY_TICKS,
    rttAge,
  );
  if (lastSnap - tick > maxAge) return undefined;
  return tick;
}

/**
 * Legal rewind band for one shot. Always returns a tick in [lo, hi] ∩
 * [simTick − maxRewind, simTick]. Does not reject the shot.
 */
export function resolveLagCompWindow(
  input: LagCompWindowInput,
): LagCompWindow {
  const simTick = Math.max(0, Math.floor(input.simTick));
  const snapMod = simTick % SNAPSHOT_EVERY_TICKS;
  const inferredSnap = simTick - snapMod;
  const lastSnap = Math.min(
    simTick,
    Math.max(
      0,
      Math.floor(
        input.lastSnapTick > 0 ? input.lastSnapTick : inferredSnap,
      ),
    ),
  );

  const pingReady = input.pingReady === true;
  const rttMs = pingReady &&
      typeof input.pingEwmaMs === "number" &&
      Number.isFinite(input.pingEwmaMs) &&
      input.pingEwmaMs > 0
    ? input.pingEwmaMs
    : LAG_COMP_UNKNOWN_RTT_MS;
  const jitterMs = pingReady &&
      typeof input.pingJitterMs === "number" &&
      Number.isFinite(input.pingJitterMs) &&
      input.pingJitterMs > 0
    ? input.pingJitterMs
    : 0;

  const oneWayMs = clamp(rttMs / 2, 0, LAG_COMP_ONE_WAY_MAX_MS);

  const applied = sanitizeLastAppliedSnapshotTick({
    lastApplied: input.lastAppliedSnapshotTick,
    lastSnap,
    rttMs,
    jitterMs,
  });
  const snapBase = applied ?? lastSnap;

  let interpMs = LAG_COMP_INTERP_DEFAULT_MS;
  const claimed = input.interpDelayMs;
  if (typeof claimed === "number" && Number.isFinite(claimed)) {
    const c = clamp(
      claimed,
      LAG_COMP_INTERP_MIN_MS,
      LAG_COMP_INTERP_MAX_MS,
    );
    if (c <= interpMs) {
      interpMs = c;
    } else if (
      (input.volDropPct ?? 0) >= LAG_COMP_VOLDROP_WIDEN_PCT ||
      jitterMs > 20
    ) {
      interpMs = c;
    }
  }

  // Client stamps lastApplied − interp. oneWay is only a proxy for "which
  // snapshot they have" when lastApplied is missing.
  const delayMs = applied != null ? interpMs : interpMs + oneWayMs;
  const expectRaw = snapBase - msToRewindTicks(delayMs);

  const interpMinTicks = msToRewindTicks(LAG_COMP_INTERP_MIN_MS);
  const jitterTicks = msToRewindTicks(jitterMs);
  let padLo = LAG_COMP_PAD_BASE_TICKS + SNAPSHOT_EVERY_TICKS + jitterTicks;
  const vol = typeof input.volDropPct === "number" &&
      Number.isFinite(input.volDropPct)
    ? Math.max(0, input.volDropPct)
    : 0;
  if (vol >= LAG_COMP_VOLDROP_WIDEN_HIGH_PCT) {
    padLo += SNAPSHOT_EVERY_TICKS * 2;
  } else if (vol >= LAG_COMP_VOLDROP_WIDEN_PCT) {
    padLo += SNAPSHOT_EVERY_TICKS;
  }
  const padHi = LAG_COMP_PAD_BASE_TICKS;

  const minTick = Math.max(0, simTick - LAG_COMP_MAX_REWIND_TICKS);
  let lo = expectRaw - padLo;
  let hi = Math.min(
    simTick,
    snapBase - interpMinTicks,
    expectRaw + padHi,
  );
  lo = Math.max(minTick, lo);
  hi = Math.min(simTick, hi);
  if (hi < lo) hi = lo;

  const raw = parseOptionalTick(input.clientTick);
  const source = raw ?? expectRaw;
  const tick = clamp(source, lo, hi);
  let clampDir: LagCompClampDir = "none";
  if (raw != null && tick !== source) {
    clampDir = source < lo ? "forward" : "back";
  }

  return {
    tick,
    lo,
    hi,
    expectTick: clamp(expectRaw, lo, hi),
    clamped: clampDir !== "none",
    clampDir,
  };
}

/**
 * Ticks to sample for lag-comp (newest-first).
 * Returns a new array each call (safe to store / assert in tests).
 *
 * `resolved` means `clientTick` already passed {@link resolveLagCompWindow}
 * (including the missing-stamp → expectTick mapping). Do not fall back to
 * the dense recent-window search in that case — that search is a backtrack
 * gift if the client omits the stamp.
 */
export function buildLagCompTicks(
  simTick: number,
  clientTick: number | undefined,
  opts?: { resolved?: boolean },
): number[] {
  const minTick = simTick - LAG_COMP_MAX_REWIND_TICKS;
  const ticks: number[] = [];
  const resolved = opts?.resolved === true;

  const pushUnique = (t: number) => {
    if (t < minTick || t > simTick) return;
    for (let i = 0; i < ticks.length; i++) {
      if (ticks[i] === t) return;
    }
    ticks.push(t);
  };

  const hasStamp = typeof clientTick === "number" &&
    Number.isFinite(clientTick) &&
    (resolved ? clientTick >= 0 : clientTick > 0);

  if (hasStamp) {
    const base = clamp(Math.round(clientTick as number), minTick, simTick);
    // Primary: world the shooter reported. ±1 covers snap quantize / 1-tick skew.
    // Intentionally omit live simTick — that is ahead of remote interp delay.
    for (const t of [base - 1, base, base + 1]) {
      pushUnique(t);
    }
  } else {
    for (const rewind of LAG_COMP_FALLBACK_REWIND_TICKS) {
      pushUnique(simTick - rewind);
    }
  }

  ticks.sort((a, b) => b - a);
  return ticks;
}
