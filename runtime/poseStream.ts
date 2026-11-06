/**
 * Per-socket pose stream (A4 / C5).
 * Owns the net mirrors: volatile drops, reliable heartbeats, write-buffer
 * peaks. Keyed by session.id.
 *
 * Volatile 20 Hz snapshots drop when a client's transport is not writable,
 * or when a WebTransport datagram does not fit. A miss drops that pose only.
 * A low-rate reliable keyframe keeps poses flowing without re-queuing full
 * 20 Hz reliable traffic.
 */

import {
  NetEvents,
  type PingPacket,
  type SnapshotPacket,
} from "../protocol/network.ts";
import {
  classifyVolatileEmit,
  type ClientNetMirror,
  createClientNetMirror,
  noteMirrorPingInterval,
  type NetMirrorSummary,
  shouldSendReliablePose,
  summarizeNetMirrors,
} from "../transport/poseHeartbeat.ts";
import type { VolatileEmitResult } from "../transport/types.ts";

/** One connected peer the pose stream can emit to. */
export type PoseSession = {
  readonly id: string;
  emit(event: string, payload?: unknown): void;
  emitVolatile(event: string, payload?: unknown): VolatileEmitResult;
  isWritable(): boolean;
  writeBufferLength(): number;
  /** Encoded size of the last volatile packet attempted. 0 if none yet. */
  lastVolatileBytes?(): number;
  /** Current datagram ceiling. 0 when this transport has none. */
  maxDatagramSize?(): number;
};

/** Fan-out of the peers currently connected. */
export type PoseSessionHub = {
  sessions(): Iterable<PoseSession>;
};

/** Roster fields the ~1 Hz ping copies onto `net`. */
export type PosePingRoster = {
  readonly rewindClampTotal: number;
  getBySocket(socketId: string): {
    rewindClampCount: number;
    rewindClampForward: number;
    rewindClampBack: number;
  } | undefined;
};

/** Tick-timing fields copied onto ping `srv`. */
export type PosePingTiming = {
  tickHz: number;
  avgLoad: number;
  peakLoad: number;
  budgetMs: number;
  samples1s: number;
};

export class PoseStream {
  private readonly clientNetMirrors = new Map<string, ClientNetMirror>();

  ensure(socketId: string): ClientNetMirror {
    let m = this.clientNetMirrors.get(socketId);
    if (!m) {
      m = createClientNetMirror();
      this.clientNetMirrors.set(socketId, m);
    }
    return m;
  }

  forget(socketId: string): void {
    this.clientNetMirrors.delete(socketId);
  }

  /** Attach a per-recipient marker without mutating the shared world snapshot. */
  stamp(
    mirror: ClientNetMirror,
    snap: SnapshotPacket,
    kind: "volatile" | "heartbeat" | "catchup",
  ) {
    return {
      ...snap,
      transport: {
        emitSeq: ++mirror.emitSeq,
        emitAtMs: performance.now(),
        kind,
      },
    };
  }

  /**
   * Per-client pose stream (A4 / C5).
   * - Volatile when transport is writable (latest pose only).
   * - Reliable keyframe when backed up, or when this datagram did not go out
   *   (rate-limited) so clients do not starve.
   */
  emitTick(
    sessions: PoseSessionHub | null | undefined,
    tick: number,
    snap: SnapshotPacket,
  ): void {
    if (!sessions) return;
    for (const session of sessions.sessions()) {
      const mirror = this.ensure(session.id);
      let transportWritable = session.isWritable();
      const wbLen = session.writeBufferLength();
      if (wbLen > mirror.peakWriteBuffer) mirror.peakWriteBuffer = wbLen;

      // Sample even when this tick does not send, so a backed-up session
      // still reports its ceiling. A later higher cap does not raise the low.
      const cap = session.maxDatagramSize?.() ?? 0;
      if (cap > 0) {
        const seen = mirror.maxDatagramSize;
        mirror.maxDatagramSize = seen == null ? cap : Math.min(seen, cap);
      }

      const kind = classifyVolatileEmit(transportWritable);
      if (kind === "send") {
        // This is deliberately stamped per session, immediately before emit.
        // It distinguishes a host production/emit gap from a later delivery
        // or browser scheduling stall without mutating the shared `snap`.
        const result = session.emitVolatile(
          NetEvents.Snapshot,
          this.stamp(mirror, snap, "volatile"),
        );
        const bytes = session.lastVolatileBytes?.() ?? 0;
        if (bytes > mirror.largestVolatileBytes) {
          mirror.largestVolatileBytes = bytes;
        }
        if (result === "sent") {
          mirror.volatileSent += 1;
        } else {
          // Oversize or a failed write costs this pose only. Count the drop
          // and treat the tick as unwritable so the ≤5 Hz keyframe still fires.
          // The lane itself stays open for the next tick.
          if (result === "dropped_oversize") mirror.volatileOversize += 1;
          mirror.volatileDrops += 1;
          mirror.lastBackedUpTick = tick;
          transportWritable = false;
        }
      } else {
        mirror.volatileDrops += 1;
        mirror.lastBackedUpTick = tick;
      }

      if (
        shouldSendReliablePose({
          tick,
          transportWritable,
          clientRequested: false,
          lastReliablePoseTick: mirror.lastReliablePoseTick,
        })
      ) {
        session.emit(
          NetEvents.Snapshot,
          this.stamp(mirror, snap, "heartbeat"),
        );
        mirror.lastReliablePoseTick = tick;
        mirror.reliableHeartbeats += 1;
      }
    }
  }

  /**
   * Client-requested reliable pose.
   * `snap` may be a builder. It runs only when the cooldown allows a send:
   * `createSnapshot` advances `lastSnapshotTick`, and a skipped request must
   * not move that tick.
   */
  sendRequestedHeartbeat(
    session: PoseSession,
    tick: number,
    snap: SnapshotPacket | (() => SnapshotPacket),
  ): void {
    const mirror = this.ensure(session.id);
    if (
      !shouldSendReliablePose({
        tick,
        transportWritable: true,
        clientRequested: true,
        lastReliablePoseTick: mirror.lastReliablePoseTick,
      })
    ) {
      return;
    }
    const packet = typeof snap === "function" ? snap() : snap;
    session.emit(
      NetEvents.Snapshot,
      this.stamp(mirror, packet, "heartbeat"),
    );
    mirror.lastReliablePoseTick = tick;
    mirror.reliableHeartbeats += 1;
    mirror.clientRequested += 1;
  }

  /**
   * ~1 Hz ping. One shared `t` / `srv`, then per-socket `net` from the mirror
   * plus that socket's rewind clamps.
   */
  emitPings(
    sessions: PoseSessionHub,
    players: PosePingRoster,
    timing: PosePingTiming | undefined,
  ): void {
    const hostMirror = summarizeNetMirrors(this.clientNetMirrors.values());
    const base: PingPacket = { t: Date.now() };
    if (timing && timing.samples1s > 0) {
      base.srv = {
        hz: timing.tickHz,
        avg: Math.round(timing.avgLoad * 10000) / 10000,
        peak: Math.round(timing.peakLoad * 10000) / 10000,
        budgetMs: Math.round(timing.budgetMs * 100) / 100,
      };
    }
    const hRwClamp = players.rewindClampTotal;
    for (const session of sessions.sessions()) {
      const m = this.clientNetMirrors.get(session.id);
      if (m) noteMirrorPingInterval(m);
      const p = players.getBySocket(session.id);
      const packet: PingPacket = {
        t: base.t,
        srv: base.srv,
        net: {
          vSent: m?.volatileSent ?? 0,
          vDrop: m?.volatileDrops ?? 0,
          hb: m?.reliableHeartbeats ?? 0,
          peakWb: m?.peakWriteBuffer ?? 0,
          hSent: hostMirror.volatileSent,
          hDrop: hostMirror.volatileDrops,
          hPeakWb: hostMirror.peakWriteBuffer,
          hDropClients: hostMirror.clientsWithDrops,
          rwClamp: p?.rewindClampCount ?? 0,
          rwFwd: p?.rewindClampForward ?? 0,
          rwBack: p?.rewindClampBack ?? 0,
          hRwClamp,
        },
      };
      session.emit(NetEvents.Ping, packet);
    }
  }

  summary(): NetMirrorSummary {
    return summarizeNetMirrors(this.clientNetMirrors.values());
  }

  /** Recent volDrop% for lag-comp. Missing sockets stay undefined. */
  volDropPct(socketId: string): number | undefined {
    return this.clientNetMirrors.get(socketId)?.recentVolDropPct;
  }
}
