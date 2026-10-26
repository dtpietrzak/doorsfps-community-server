/**
 * Epic 13.1–13.2 — killcam death identity + window policy (pure).
 *
 * Owns the recorded-death → KillcamDeath → KillcamWindow boundary only:
 *   playerDied event stream (8.4 / 10.1 / 8.5 tail)
 *     → resolveKillcamDeath  (exact appliedTick, per-victim)
 *     → frameKillcamWindow   (clamped pre/post tick arithmetic)
 *
 * 10.3 death markers may accelerate a find; they are never the source of
 * truth (ids live on the event; marker involvedPlayerIds ordering is not
 * the contract). This module never reads markers.
 *
 * Contract (see notes/replay/13-killcams/13-killcams.md):
 * - deathTick === event.appliedTick verbatim. No ±1, no render timestamp,
 *   no tickToTimeMs rounding into the identity.
 * - Lookup key is (victimId, appliedTick). Same-tick multi-deaths resolve
 *   independently. Killer is event.killerId (eventPlayerId maps playerDied
 *   → victimId — a caller bug this module must not repeat).
 * - Window is inclusive [startTick, endTick], clamped to [firstTick, lastTick].
 *   startTick > endTick after clamp → replay-killcam-bad-window.
 *   A startTick === endTick window is one tick (not empty).
 * - Default lead 3000 ms (180 ticks) + tail 2000 ms (120 ticks). Total 5000 ms
 *   so live rewind starts 3 s before death and plays 2 s of the kill.
 *   Authoritative respawn still preempts (13.5). Never gate respawn here.
 * - Pure: no runner, clock, camera, THREE, DOM, wall-clock, fs, blob, store,
 *   net, checkpoint index. 13.3–13.5 live in killcamPlayback.ts.
 *
 * Handoffs: 13.3 sets killer focus through 12.1; 13.4 drives an 11.6 session
 * from startTick (14.3 opens that window through ReplayPlayback.seek behind
 * the same seam); 15.1 stores KillcamWindow via replayClipFromKillcamWindow;
 * 21.x calls
 * start/skip/exit.
 */

import { TICK_HZ } from "../shared/sim/game.ts";
import type {
  AuthoritativeEvent,
  PlayerDiedEvent,
  PlayerRespawnedEvent,
} from "../shared/sim/authoritativeEvent.ts";

// ---------------------------------------------------------------------------
// Window defaults (13.2). Respawn sovereignty: do not wait on this window.
// ---------------------------------------------------------------------------

/** Pre-death lead. 3000 ms @ 60 Hz → 180 ticks (what the killer did). */
export const KILLCAM_PRE_MS = 3000;

/**
 * Post-death tail. 2000 ms @ 60 Hz → 120 ticks (the kill + corpse).
 * Live rewind plays PRE + POST = 5 s so the death is on screen for 2 s.
 * Live respawn still preempts this tail — the window never extends it.
 */
export const KILLCAM_POST_MS = 2000;

export const KILLCAM_PRE_TICKS = Math.ceil(
  (KILLCAM_PRE_MS * TICK_HZ) / 1000,
);
export const KILLCAM_POST_TICKS = Math.ceil(
  (KILLCAM_POST_MS * TICK_HZ) / 1000,
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type KillcamDeath = {
  readonly deathTick: number;
  readonly victimId: string;
  readonly killerId: string;
  readonly victimName: string;
  readonly killerName: string;
};

/**
 * Inclusive tick window around a death. Playback steps every tick in
 * `[startTick, endTick]` (one tick when startTick === endTick). Clock
 * `advance` still reports half-open `[fromTick, toTick)` per step batch.
 */
export type KillcamWindow = {
  readonly startTick: number;
  readonly deathTick: number;
  readonly endTick: number;
};

export type KillcamSessionEvents = {
  readonly eventsAt: (tick: number) => ReadonlyArray<AuthoritativeEvent>;
  readonly firstTick?: number;
  readonly lastTick?: number;
};

export type KillcamEventSource =
  | ReadonlyArray<AuthoritativeEvent>
  | KillcamSessionEvents;

export type KillcamDeathQuery = {
  readonly victimId: string;
  readonly deathTick?: number;
  /**
   * Inclusive search half-width in ticks. Default 0 = exact `deathTick`
   * only. "Near" is never implied — the caller must pass this explicitly.
   */
  readonly searchTicks?: number;
};

export type FrameKillcamWindowBounds = {
  readonly firstTick: number;
  readonly lastTick: number;
  readonly preMs?: number;
  readonly postMs?: number;
};

export type KillcamErrorCode =
  | "replay-killcam-unknown-death"
  | "replay-killcam-unknown-killer"
  | "replay-killcam-bad-window"
  | "replay-killcam-empty-source";

export class KillcamError extends Error {
  readonly code: KillcamErrorCode;
  readonly detail: string | null;

  constructor(
    code: KillcamErrorCode,
    message: string,
    opts?: { detail?: string | null; cause?: unknown },
  ) {
    super(
      message,
      opts?.cause !== undefined ? { cause: opts.cause } : undefined,
    );
    this.name = "KillcamError";
    this.code = code;
    this.detail = opts?.detail ?? null;
  }
}

export type KillcamCameraMode = "first-person" | "third-person";

export type KillcamExitReason =
  | "window-end"
  | "victim-respawned"
  | "skip"
  | "unknown-killer"
  | "session-end";

// ---------------------------------------------------------------------------
// 13.1 Death identity
// ---------------------------------------------------------------------------

/**
 * Self-kill (environmental / overlap): observe the victim, not a third
 * player. Killer chase uses `killerId` otherwise.
 */
export function killcamFocusPlayerId(death: KillcamDeath): string {
  return death.killerId === death.victimId ? death.victimId : death.killerId;
}

export function resolveKillcamDeath(
  source: KillcamEventSource | null | undefined,
  query: KillcamDeathQuery,
): KillcamDeath {
  if (source == null) {
    throw new KillcamError(
      "replay-killcam-empty-source",
      "Killcam: no event stream in the session",
    );
  }
  if (!isEventSource(source)) {
    throw new KillcamError(
      "replay-killcam-empty-source",
      "Killcam: no event stream in the session",
    );
  }

  const victimId = query.victimId;
  if (typeof victimId !== "string" || victimId.length === 0) {
    throw new KillcamError(
      "replay-killcam-unknown-death",
      "Killcam: victimId is empty",
      { detail: typeof victimId === "string" ? victimId : null },
    );
  }

  const events = collectDiedEvents(source, query);
  const matches: PlayerDiedEvent[] = [];
  for (const event of events) {
    if (event.kind !== "playerDied") continue;
    // Killer is event.killerId — never eventPlayerId (that is victimId).
    if (event.victimId === victimId) matches.push(event);
  }

  if (matches.length !== 1) {
    throw new KillcamError(
      "replay-killcam-unknown-death",
      matches.length === 0
        ? `Killcam: no playerDied for victim "${victimId}" at the requested tick`
        : `Killcam: ${matches.length} playerDied events for victim "${victimId}" (need exact tick)`,
      {
        detail: query.deathTick != null
          ? `victimId=${victimId} deathTick=${query.deathTick}`
          : `victimId=${victimId}`,
      },
    );
  }

  const event = matches[0];
  return Object.freeze({
    deathTick: event.appliedTick,
    victimId: event.victimId,
    killerId: event.killerId,
    victimName: event.victimName,
    killerName: event.killerName,
  });
}

export function victimRespawnedInEvents(
  events: ReadonlyArray<AuthoritativeEvent>,
  victimId: string,
): boolean {
  for (const event of events) {
    if (event.kind !== "playerRespawned") continue;
    if ((event as PlayerRespawnedEvent).player.id === victimId) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 13.2 Window arithmetic
// ---------------------------------------------------------------------------

export function killcamMsToTicks(ms: number): number {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
    throw new KillcamError(
      "replay-killcam-bad-window",
      `Killcam: duration ms must be a finite number ≥ 0 (got ${String(ms)})`,
      { detail: String(ms) },
    );
  }
  return Math.ceil((ms * TICK_HZ) / 1000);
}

export function frameKillcamWindow(
  deathTick: number,
  bounds: FrameKillcamWindowBounds,
): KillcamWindow {
  const death = requireTick(deathTick, "deathTick");
  const firstTick = requireTick(bounds.firstTick, "firstTick");
  const lastTick = requireTick(bounds.lastTick, "lastTick");
  if (firstTick > lastTick) {
    throw new KillcamError(
      "replay-killcam-bad-window",
      `Killcam: firstTick ${firstTick} > lastTick ${lastTick}`,
      { detail: `firstTick=${firstTick} lastTick=${lastTick}` },
    );
  }

  const preMs = bounds.preMs ?? KILLCAM_PRE_MS;
  const postMs = bounds.postMs ?? KILLCAM_POST_MS;
  const preTicks = killcamMsToTicks(preMs);
  const postTicks = killcamMsToTicks(postMs);

  const startTick = Math.max(firstTick, death - preTicks);
  const endTick = Math.min(lastTick, death + postTicks);
  if (startTick > endTick) {
    throw new KillcamError(
      "replay-killcam-bad-window",
      `Killcam: clamped window is empty (startTick ${startTick} > endTick ${endTick})`,
      {
        detail:
          `startTick=${startTick} endTick=${endTick} deathTick=${death} bounds=[${firstTick}, ${lastTick}]`,
      },
    );
  }

  return Object.freeze({ startTick, deathTick: death, endTick });
}

export function killcamPlayTickCount(window: KillcamWindow): number {
  return window.endTick - window.startTick + 1;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function isEventSource(
  source: KillcamEventSource,
): source is KillcamEventSource {
  if (Array.isArray(source)) return true;
  if (source != null && typeof source === "object") {
    const eventsAt = (source as { eventsAt?: unknown }).eventsAt;
    return typeof eventsAt === "function";
  }
  return false;
}

function collectDiedEvents(
  source: KillcamEventSource,
  query: KillcamDeathQuery,
): PlayerDiedEvent[] {
  if (Array.isArray(source)) {
    return filterDiedInList(source, query);
  }
  const stream = source as KillcamSessionEvents;

  const search = query.searchTicks ?? 0;
  if (
    typeof search !== "number" || !Number.isFinite(search) || search < 0 ||
    !Number.isInteger(search)
  ) {
    throw new KillcamError(
      "replay-killcam-unknown-death",
      `Killcam: searchTicks must be a non-negative integer (got ${
        String(query.searchTicks)
      })`,
      { detail: String(query.searchTicks) },
    );
  }

  if (query.deathTick == null) {
    if (
      typeof stream.firstTick !== "number" ||
      typeof stream.lastTick !== "number"
    ) {
      throw new KillcamError(
        "replay-killcam-unknown-death",
        "Killcam: deathTick is required when scanning a session event stream",
      );
    }
    const out: PlayerDiedEvent[] = [];
    for (let tick = stream.firstTick; tick <= stream.lastTick; tick++) {
      pushDied(out, stream.eventsAt(tick));
    }
    return out;
  }

  const center = requireTick(query.deathTick, "deathTick");
  const lo = center - search;
  const hi = center + search;
  const out: PlayerDiedEvent[] = [];
  for (let tick = lo; tick <= hi; tick++) {
    pushDied(out, stream.eventsAt(tick));
  }
  return out;
}

function filterDiedInList(
  events: ReadonlyArray<AuthoritativeEvent>,
  query: KillcamDeathQuery,
): PlayerDiedEvent[] {
  const search = query.searchTicks ?? 0;
  if (
    typeof search !== "number" || !Number.isFinite(search) || search < 0 ||
    !Number.isInteger(search)
  ) {
    throw new KillcamError(
      "replay-killcam-unknown-death",
      `Killcam: searchTicks must be a non-negative integer (got ${
        String(query.searchTicks)
      })`,
      { detail: String(query.searchTicks) },
    );
  }
  const out: PlayerDiedEvent[] = [];
  for (const event of events) {
    if (event.kind !== "playerDied") continue;
    if (query.deathTick == null) {
      out.push(event);
      continue;
    }
    const lo = query.deathTick - search;
    const hi = query.deathTick + search;
    if (event.appliedTick >= lo && event.appliedTick <= hi) out.push(event);
  }
  return out;
}

function pushDied(
  out: PlayerDiedEvent[],
  events: ReadonlyArray<AuthoritativeEvent>,
): void {
  for (const event of events) {
    if (event.kind === "playerDied") out.push(event);
  }
}

function requireTick(value: number, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    !Number.isInteger(value)
  ) {
    throw new KillcamError(
      "replay-killcam-bad-window",
      `Killcam: ${label} must be a finite integer ≥ 0 (got ${String(value)})`,
      { detail: `${label}=${String(value)}` },
    );
  }
  return value;
}
