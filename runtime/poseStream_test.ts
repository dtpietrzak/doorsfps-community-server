import { assertEquals } from "@std/assert";
import { NetEvents, type SnapshotPacket } from "../protocol/network.ts";
import { POSE_HEARTBEAT_SPACING_TICKS } from "../transport/poseHeartbeat.ts";
import type { VolatileEmitResult } from "../transport/types.ts";
import { PoseStream, type PoseSession } from "./poseStream.ts";

type Sent = { event: string; payload: unknown; volatile: boolean };

function fakeSession(
  id: string,
  opts: { writable: boolean; buffer: number; volatile?: VolatileEmitResult },
): { session: PoseSession; sent: Sent[]; buffer: { value: number } } {
  const sent: Sent[] = [];
  const buffer = { value: opts.buffer };
  const session: PoseSession = {
    id,
    emit(event: string, payload?: unknown) {
      sent.push({ event, payload, volatile: false });
    },
    emitVolatile(event: string, payload?: unknown) {
      sent.push({ event, payload, volatile: true });
      return opts.volatile ?? "sent";
    },
    isWritable: () => opts.writable,
    writeBufferLength: () => buffer.value,
  };
  return { session, sent, buffer };
}

function snap(tick: number): SnapshotPacket {
  return { tick } as SnapshotPacket;
}

function hub(sessions: readonly PoseSession[]) {
  return { sessions: () => sessions };
}

Deno.test("emitTick sends when writable and heartbeats a drop", () => {
  const poses = new PoseStream();
  const open = fakeSession("open", { writable: true, buffer: 2 });
  const stuck = fakeSession("stuck", { writable: false, buffer: 9 });
  const sessions = hub([open.session, stuck.session]);

  poses.emitTick(sessions, 30, snap(30));

  assertEquals(open.sent.length, 1);
  assertEquals(open.sent[0]!.volatile, true);
  assertEquals(open.sent[0]!.event, NetEvents.Snapshot);
  const openSnap = open.sent[0]!.payload as {
    tick: number;
    transport: { emitSeq: number; kind: string; emitAtMs: number };
  };
  assertEquals(openSnap.tick, 30);
  assertEquals(openSnap.transport.kind, "volatile");
  assertEquals(openSnap.transport.emitSeq, 1);
  assertEquals(typeof openSnap.transport.emitAtMs, "number");

  assertEquals(stuck.sent.length, 1);
  assertEquals(stuck.sent[0]!.volatile, false);
  const stuckSnap = stuck.sent[0]!.payload as {
    transport: { emitSeq: number; kind: string };
  };
  assertEquals(stuckSnap.transport.kind, "heartbeat");
  assertEquals(stuckSnap.transport.emitSeq, 1);

  assertEquals(poses.summary(), {
    clients: 2,
    volatileSent: 1,
    volatileDrops: 1,
    volatileOversize: 0,
    largestVolatileBytes: 0,
    maxDatagramSize: null,
    reliableHeartbeats: 1,
    clientRequested: 0,
    peakWriteBuffer: 9,
    clientsWithDrops: 1,
  });

  // Same tick, still backed up: another drop, no second heartbeat.
  stuck.buffer.value = 3;
  poses.emitTick(sessions, 30, snap(30));
  assertEquals(stuck.sent.length, 1);
  assertEquals(poses.summary().volatileDrops, 2);
  assertEquals(poses.summary().reliableHeartbeats, 1);
  assertEquals(poses.summary().peakWriteBuffer, 9);

  poses.emitTick(sessions, 30 + POSE_HEARTBEAT_SPACING_TICKS, snap(42));
  assertEquals(stuck.sent.length, 2);
  assertEquals(poses.summary().reliableHeartbeats, 2);
  assertEquals(poses.summary().volatileDrops, 3);
});

Deno.test("emitTick counts an oversize datagram as a drop and heartbeats", () => {
  const poses = new PoseStream();
  const fat = fakeSession("fat", {
    writable: true,
    buffer: 0,
    volatile: "dropped_oversize",
  });
  const sessions = hub([fat.session]);

  poses.emitTick(sessions, 30, snap(30));

  assertEquals(fat.sent.map((row) => row.volatile), [true, false]);
  const heartbeat = fat.sent[1]!.payload as {
    transport: { kind: string; emitSeq: number };
  };
  assertEquals(heartbeat.transport.kind, "heartbeat");
  assertEquals(heartbeat.transport.emitSeq, 2);
  assertEquals(poses.summary(), {
    clients: 1,
    volatileSent: 0,
    volatileDrops: 1,
    volatileOversize: 1,
    largestVolatileBytes: 0,
    maxDatagramSize: null,
    reliableHeartbeats: 1,
    clientRequested: 0,
    peakWriteBuffer: 0,
    clientsWithDrops: 1,
  });

  // Still too big on the same tick: another drop, no second heartbeat.
  poses.emitTick(sessions, 30, snap(30));
  assertEquals(poses.summary().volatileOversize, 2);
  assertEquals(fat.sent.length, 3);
  assertEquals(fat.sent[2]!.volatile, true);
  assertEquals(poses.summary().volatileSent, 0);
  assertEquals(poses.summary().volatileDrops, 2);
  assertEquals(poses.summary().reliableHeartbeats, 1);
});

Deno.test("emitTick tracks oversize bytes and the lowest datagram cap", () => {
  const poses = new PoseStream();
  let bytes = 1_500;
  let cap = 1_400;
  let result: VolatileEmitResult = "dropped_oversize";
  const session: PoseSession = {
    id: "wt",
    emit() {},
    emitVolatile() {
      return result;
    },
    isWritable: () => true,
    writeBufferLength: () => 0,
    lastVolatileBytes: () => bytes,
    maxDatagramSize: () => cap,
  };
  const tcp: PoseSession = {
    id: "tcp",
    emit() {},
    emitVolatile() {
      return "dropped";
    },
    isWritable: () => true,
    writeBufferLength: () => 0,
    lastVolatileBytes: () => 80,
    maxDatagramSize: () => 0,
  };

  poses.emitTick(hub([session, tcp]), 10, snap(10));
  assertEquals(poses.summary().volatileOversize, 1);
  assertEquals(poses.summary().volatileDrops, 2);
  assertEquals(poses.summary().largestVolatileBytes, 1_500);
  assertEquals(poses.summary().maxDatagramSize, 1_400);

  bytes = 1_600;
  cap = 1_600;
  result = "sent";
  poses.emitTick(
    hub([session]),
    10 + POSE_HEARTBEAT_SPACING_TICKS,
    snap(20),
  );
  assertEquals(poses.summary().volatileOversize, 1);
  assertEquals(poses.summary().volatileSent, 1);
  assertEquals(poses.summary().largestVolatileBytes, 1_600);
  assertEquals(poses.summary().maxDatagramSize, 1_400);

  cap = 1_100;
  bytes = 100;
  poses.emitTick(
    hub([session]),
    10 + POSE_HEARTBEAT_SPACING_TICKS * 2,
    snap(30),
  );
  assertEquals(poses.summary().maxDatagramSize, 1_100);
  assertEquals(poses.summary().largestVolatileBytes, 1_600);
  assertEquals(poses.summary().clients, 2);
});

Deno.test("sendRequestedHeartbeat shares the cooldown and skips the snapshot builder", () => {
  const poses = new PoseStream();
  const peer = fakeSession("req", { writable: true, buffer: 0 });
  let built = 0;
  const build = () => {
    built += 1;
    return snap(7);
  };

  poses.sendRequestedHeartbeat(peer.session, 10, build);
  assertEquals(built, 1);
  assertEquals(peer.sent.length, 1);
  assertEquals(peer.sent[0]!.volatile, false);
  const payload = peer.sent[0]!.payload as {
    tick: number;
    transport: { kind: string; emitSeq: number };
  };
  assertEquals(payload.tick, 7);
  assertEquals(payload.transport.kind, "heartbeat");
  assertEquals(payload.transport.emitSeq, 1);
  assertEquals(poses.summary().clientRequested, 1);
  assertEquals(poses.summary().reliableHeartbeats, 1);

  poses.sendRequestedHeartbeat(peer.session, 10, build);
  assertEquals(built, 1);
  assertEquals(peer.sent.length, 1);

  poses.sendRequestedHeartbeat(
    peer.session,
    10 + POSE_HEARTBEAT_SPACING_TICKS,
    build,
  );
  assertEquals(built, 2);
  assertEquals(peer.sent.length, 2);
  assertEquals(poses.summary().clientRequested, 2);
  assertEquals(poses.summary().reliableHeartbeats, 2);
});

Deno.test("emitPings net fields match the tick-loop packet", () => {
  const poses = new PoseStream();
  const open = fakeSession("open", { writable: true, buffer: 4 });
  const stuck = fakeSession("stuck", { writable: false, buffer: 7 });
  const quiet = fakeSession("quiet", { writable: true, buffer: 0 });
  poses.emitTick(hub([open.session, stuck.session]), 12, snap(12));

  assertEquals(poses.volDropPct("open"), 0);
  assertEquals(poses.volDropPct("stuck"), 0);
  assertEquals(poses.volDropPct("missing"), undefined);

  const players = {
    rewindClampTotal: 9,
    getBySocket(id: string) {
      if (id === "open") {
        return {
          rewindClampCount: 3,
          rewindClampForward: 2,
          rewindClampBack: 1,
        };
      }
      return undefined;
    },
  };
  poses.emitPings(hub([open.session, stuck.session, quiet.session]), players, {
    tickHz: 60,
    avgLoad: 0.123456,
    peakLoad: 0.987654,
    budgetMs: 16.666,
    samples1s: 3,
  });

  assertEquals(poses.volDropPct("open"), 0);
  assertEquals(poses.volDropPct("stuck"), 100);

  const pings = [open, stuck, quiet].map((peer) => {
    const ping = peer.sent.find((row) => row.event === NetEvents.Ping);
    return ping!.payload as {
      t: number;
      srv?: { hz: number; avg: number; peak: number; budgetMs: number };
      net: Record<string, number>;
    };
  });
  assertEquals(pings[0]!.t, pings[1]!.t);
  assertEquals(pings[1]!.t, pings[2]!.t);
  assertEquals(pings[0]!.srv, {
    hz: 60,
    avg: 0.1235,
    peak: 0.9877,
    budgetMs: 16.67,
  });
  assertEquals(pings[0]!.net, {
    vSent: 1,
    vDrop: 0,
    hb: 0,
    peakWb: 4,
    hSent: 1,
    hDrop: 1,
    hPeakWb: 7,
    hDropClients: 1,
    rwClamp: 3,
    rwFwd: 2,
    rwBack: 1,
    hRwClamp: 9,
  });
  assertEquals(pings[1]!.net, {
    vSent: 0,
    vDrop: 1,
    hb: 1,
    peakWb: 7,
    hSent: 1,
    hDrop: 1,
    hPeakWb: 7,
    hDropClients: 1,
    rwClamp: 0,
    rwFwd: 0,
    rwBack: 0,
    hRwClamp: 9,
  });
  assertEquals(pings[2]!.net, {
    vSent: 0,
    vDrop: 0,
    hb: 0,
    peakWb: 0,
    hSent: 1,
    hDrop: 1,
    hPeakWb: 7,
    hDropClients: 1,
    rwClamp: 0,
    rwFwd: 0,
    rwBack: 0,
    hRwClamp: 9,
  });

  open.sent.length = 0;
  poses.emitPings(hub([open.session]), players, {
    tickHz: 60,
    avgLoad: 1,
    peakLoad: 1,
    budgetMs: 16,
    samples1s: 0,
  });
  const bare = open.sent[0]!.payload as { srv?: unknown };
  assertEquals(bare.srv, undefined);
});

Deno.test("forget drops the mirror from summary and volDropPct", () => {
  const poses = new PoseStream();
  const peer = fakeSession("gone", { writable: false, buffer: 1 });
  poses.emitTick(hub([peer.session]), 1, snap(1));
  poses.emitPings(hub([peer.session]), {
    rewindClampTotal: 0,
    getBySocket: () => undefined,
  }, undefined);
  assertEquals(poses.volDropPct("gone"), 100);
  assertEquals(poses.summary().clients, 1);

  poses.forget("gone");
  assertEquals(poses.volDropPct("gone"), undefined);
  assertEquals(poses.summary(), {
    clients: 0,
    volatileSent: 0,
    volatileDrops: 0,
    volatileOversize: 0,
    largestVolatileBytes: 0,
    maxDatagramSize: null,
    reliableHeartbeats: 0,
    clientRequested: 0,
    peakWriteBuffer: 0,
    clientsWithDrops: 0,
  });
});

Deno.test("emitTick does nothing without a hub", () => {
  const poses = new PoseStream();
  poses.emitTick(undefined, 1, snap(1));
  poses.emitTick(null, 1, snap(1));
  assertEquals(poses.summary().clients, 0);
});
