/**
 * Pose heartbeat under volatile starvation (rubberbanding Phase 3 — A4 / C5).
 *
 * Volatile 20 Hz snapshots drop when a client's transport is not writable.
 * A low-rate *reliable* keyframe keeps poses flowing without re-queuing full
 * 20 Hz reliable traffic (which reintroduces freeze Mode A).
 */

import { TICK_HZ } from "../protocol/network.ts";

/** Min ticks between reliable pose keyframes per client (~200ms at 60 Hz). */
export const POSE_HEARTBEAT_MIN_TICKS = Math.max(1, Math.round(TICK_HZ * 0.2));

/** Cap reliable heartbeats (~5 Hz) even under sustained backpressure. */
export const POSE_HEARTBEAT_MAX_HZ = 5;
export const POSE_HEARTBEAT_MIN_TICKS_CAP = Math.max(
  1,
  Math.round(TICK_HZ / POSE_HEARTBEAT_MAX_HZ),
);

/** Effective min spacing (max of floor and rate cap). */
export const POSE_HEARTBEAT_SPACING_TICKS = Math.max(
  POSE_HEARTBEAT_MIN_TICKS,
  POSE_HEARTBEAT_MIN_TICKS_CAP,
);

/** Client may request a reliable pose after this recv silence (ms). */
export const CLIENT_POSE_STARVE_MS = 350;

/** Client request cooldown (ms). */
export const CLIENT_POSE_REQUEST_COOLDOWN_MS = 300;

export type ClientNetMirror = {
  /** Monotonic per-connection pose-stream emit sequence for client diagnostics. */
  emitSeq: number;
  /** Volatile snapshot emits that left the host (transport writable). */
  volatileSent: number;
  /** Volatile snapshots dropped because transport was not writable. */
  volatileDrops: number;
  /** Reliable pose keyframes (backpressure recovery). */
  reliableHeartbeats: number;
  /** Client-requested reliable poses. */
  clientRequested: number;
  /** Last tick we sent a reliable pose to this client. */
  lastReliablePoseTick: number;
  /** Last observed write-buffer / not-writable sample. */
  lastBackedUpTick: number;
  /** Peak write-buffer length observed (engine.io; 0 if unknown). */
  peakWriteBuffer: number;
  /** Last ping-interval volatile sent (for recent volDrop%). */
  lastPingVolatileSent: number;
  /** Last ping-interval volatile drops. */
  lastPingVolatileDrops: number;
  /** Recent volDrop% between pings (0–100). Used to widen lag-comp pad. */
  recentVolDropPct: number;
};

export function createClientNetMirror(): ClientNetMirror {
  return {
    emitSeq: 0,
    volatileSent: 0,
    volatileDrops: 0,
    reliableHeartbeats: 0,
    clientRequested: 0,
    lastReliablePoseTick: -1e9,
    lastBackedUpTick: -1e9,
    peakWriteBuffer: 0,
    lastPingVolatileSent: 0,
    lastPingVolatileDrops: 0,
    recentVolDropPct: 0,
  };
}

/** Fold cumulative volatile counters into a recent drop % (~1 Hz ping). */
export function noteMirrorPingInterval(m: ClientNetMirror): number {
  const dSent = Math.max(0, m.volatileSent - m.lastPingVolatileSent);
  const dDrop = Math.max(0, m.volatileDrops - m.lastPingVolatileDrops);
  const den = dSent + dDrop;
  m.recentVolDropPct = den > 0 ? (100 * dDrop) / den : 0;
  m.lastPingVolatileSent = m.volatileSent;
  m.lastPingVolatileDrops = m.volatileDrops;
  return m.recentVolDropPct;
}

/**
 * Should we send a reliable pose keyframe now?
 * - Transport not writable (volatile would drop), or
 * - Client explicitly requested after silence,
 * and cooldown spacing has elapsed.
 */
export function shouldSendReliablePose(opts: {
  tick: number;
  transportWritable: boolean;
  clientRequested: boolean;
  lastReliablePoseTick: number;
  spacingTicks?: number;
}): boolean {
  const spacing = opts.spacingTicks ?? POSE_HEARTBEAT_SPACING_TICKS;
  const cooled = opts.tick - opts.lastReliablePoseTick >= spacing;
  if (!cooled) return false;
  if (opts.clientRequested) return true;
  if (!opts.transportWritable) return true;
  return false;
}

/** Prefer volatile when writable; otherwise count as a drop. */
export function classifyVolatileEmit(
  transportWritable: boolean,
): "send" | "drop" {
  return transportWritable ? "send" : "drop";
}

/**
 * Best-effort read of engine.io write-buffer length (private field).
 * Returns 0 when unavailable.
 */
export function readWriteBufferLength(conn: unknown): number {
  if (!conn || typeof conn !== "object") return 0;
  const wb = (conn as { writeBuffer?: unknown }).writeBuffer;
  if (Array.isArray(wb)) return wb.length;
  return 0;
}

/** Transport.writable probe (false → volatile will be discarded). */
export function isTransportWritable(conn: unknown): boolean {
  if (!conn || typeof conn !== "object") return true;
  const transport = (conn as { transport?: { writable?: boolean } }).transport;
  if (!transport || typeof transport.writable !== "boolean") return true;
  return transport.writable;
}

export type NetMirrorSummary = {
  clients: number;
  volatileSent: number;
  volatileDrops: number;
  reliableHeartbeats: number;
  clientRequested: number;
  peakWriteBuffer: number;
  /** Clients with at least one volatile drop. */
  clientsWithDrops: number;
};

export function summarizeNetMirrors(
  mirrors: Iterable<ClientNetMirror>,
): NetMirrorSummary {
  let clients = 0;
  let volatileSent = 0;
  let volatileDrops = 0;
  let reliableHeartbeats = 0;
  let clientRequested = 0;
  let peakWriteBuffer = 0;
  let clientsWithDrops = 0;
  for (const m of mirrors) {
    clients += 1;
    volatileSent += m.volatileSent;
    volatileDrops += m.volatileDrops;
    reliableHeartbeats += m.reliableHeartbeats;
    clientRequested += m.clientRequested;
    if (m.peakWriteBuffer > peakWriteBuffer) {
      peakWriteBuffer = m.peakWriteBuffer;
    }
    if (m.volatileDrops > 0) clientsWithDrops += 1;
  }
  return {
    clients,
    volatileSent,
    volatileDrops,
    reliableHeartbeats,
    clientRequested,
    peakWriteBuffer,
    clientsWithDrops,
  };
}

/**
 * Application volatile drop rate: drops / (sent + drops) as 0–100.
 * 0 when no attempts yet. Used by host TUI + client MIRR HUD (honest loss).
 */
export function volatileDropPct(sent: number, drops: number): number {
  const s = Math.max(0, sent);
  const d = Math.max(0, drops);
  const total = s + d;
  if (total <= 0) return 0;
  return (100 * d) / total;
}
