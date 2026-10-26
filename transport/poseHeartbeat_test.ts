/**
 * Run with: deno test -A server/poseHeartbeat_test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyVolatileEmit,
  createClientNetMirror,
  isTransportWritable,
  noteMirrorPingInterval,
  POSE_HEARTBEAT_SPACING_TICKS,
  readWriteBufferLength,
  shouldSendReliablePose,
  summarizeNetMirrors,
  volatileDropPct,
} from "./poseHeartbeat.ts";

Deno.test("classifyVolatileEmit: send when writable, drop otherwise", () => {
  assertEquals(classifyVolatileEmit(true), "send");
  assertEquals(classifyVolatileEmit(false), "drop");
});

Deno.test("shouldSendReliablePose: backpressure + cooldown", () => {
  assertEquals(
    shouldSendReliablePose({
      tick: 100,
      transportWritable: false,
      clientRequested: false,
      lastReliablePoseTick: 0,
      spacingTicks: 12,
    }),
    true,
  );
  assertEquals(
    shouldSendReliablePose({
      tick: 100,
      transportWritable: false,
      clientRequested: false,
      lastReliablePoseTick: 95,
      spacingTicks: 12,
    }),
    false,
  );
  assertEquals(
    shouldSendReliablePose({
      tick: 100,
      transportWritable: true,
      clientRequested: false,
      lastReliablePoseTick: 0,
    }),
    false,
  );
  assertEquals(
    shouldSendReliablePose({
      tick: 100,
      transportWritable: true,
      clientRequested: true,
      lastReliablePoseTick: 0,
      spacingTicks: 12,
    }),
    true,
  );
});

Deno.test("shouldSendReliablePose: default spacing is positive", () => {
  assertEquals(POSE_HEARTBEAT_SPACING_TICKS >= 1, true);
});

Deno.test("isTransportWritable / readWriteBufferLength: defensive", () => {
  assertEquals(isTransportWritable(null), true);
  assertEquals(isTransportWritable({ transport: { writable: false } }), false);
  assertEquals(isTransportWritable({ transport: { writable: true } }), true);
  assertEquals(readWriteBufferLength(null), 0);
  assertEquals(readWriteBufferLength({ writeBuffer: [1, 2, 3] }), 3);
});

Deno.test("summarizeNetMirrors: aggregates per-client counters", () => {
  const a = createClientNetMirror();
  a.volatileSent = 10;
  a.volatileDrops = 2;
  a.reliableHeartbeats = 1;
  a.peakWriteBuffer = 4;
  const b = createClientNetMirror();
  b.volatileSent = 8;
  b.clientRequested = 3;
  b.peakWriteBuffer = 1;
  const s = summarizeNetMirrors([a, b]);
  assertEquals(s.clients, 2);
  assertEquals(s.volatileSent, 18);
  assertEquals(s.volatileDrops, 2);
  assertEquals(s.reliableHeartbeats, 1);
  assertEquals(s.clientRequested, 3);
  assertEquals(s.peakWriteBuffer, 4);
  assertEquals(s.clientsWithDrops, 1);
});

Deno.test("volatileDropPct: drops / (sent+drops)", () => {
  assertEquals(volatileDropPct(0, 0), 0);
  assertEquals(volatileDropPct(10, 0), 0);
  assertEquals(volatileDropPct(0, 5), 100);
  assertEquals(volatileDropPct(10, 10), 50);
  assertEquals(volatileDropPct(18, 2), 10);
});

Deno.test("noteMirrorPingInterval: recent volDrop% from ping deltas", () => {
  const m = createClientNetMirror();
  m.volatileSent = 20;
  m.volatileDrops = 0;
  assertEquals(noteMirrorPingInterval(m), 0);
  m.volatileSent = 30;
  m.volatileDrops = 10;
  assertEquals(noteMirrorPingInterval(m), 50);
  m.volatileSent = 40;
  m.volatileDrops = 10;
  assertEquals(noteMirrorPingInterval(m), 0);
});
