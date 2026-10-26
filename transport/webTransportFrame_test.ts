import { assert, assertEquals } from "@std/assert";
import {
  decodeGamePacket,
  encodeGamePacket,
} from "../shared/net/index.ts";
import {
  decodeAuthJson,
  decodeStreamGameFrame,
  encodeAuthFrame,
  encodeLengthPrefixed,
  encodeStreamGameFrame,
  StreamFrameReader,
} from "./webTransportFrame.ts";
import { WEBTRANSPORT_MAX_FRAME_BYTES } from "./webTransportConfig.ts";

Deno.test("encode/decode auth JSON", () => {
  const frame = encodeAuthFrame({ name: "Ada", proto: 1 });
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const len = view.getUint32(0);
  assertEquals(len, frame.byteLength - 4);
  const auth = decodeAuthJson(frame.subarray(4));
  assertEquals(auth?.name, "Ada");
  assertEquals(auth?.proto, 1);
});

Deno.test("decodeAuthJson rejects junk", () => {
  assertEquals(decodeAuthJson(new TextEncoder().encode("not-json")), null);
  assertEquals(decodeAuthJson(new TextEncoder().encode("[]")), null);
  assertEquals(decodeAuthJson(new TextEncoder().encode("null")), null);
});

Deno.test("stream game frame round-trips Snapshot and empty Ready", () => {
  const snap = encodeStreamGameFrame("snapshot", {
    tick: 12,
    doorsOpen: true,
    doorChangeTick: 30,
    matchEndTick: 36000,
    scores: { A: 1, B: 0 },
    players: [{
      id: "p1",
      x: 1,
      y: 2,
      z: 3,
      yaw: 0.5,
      pitch: 0,
      health: 100,
      alive: true,
      team: "A",
    }],
    projectiles: [],
  });
  assert(snap);
  const snapView = new DataView(snap.buffer, snap.byteOffset, snap.byteLength);
  const decoded = decodeStreamGameFrame(snap.subarray(4, 4 + snapView.getUint32(0)));
  assert(decoded);
  assertEquals(decoded.event, "snapshot");
  assertEquals((decoded.payload as { tick: number }).tick, 12);

  const ready = encodeStreamGameFrame("ready");
  assert(ready);
  const readyView = new DataView(
    ready.buffer,
    ready.byteOffset,
    ready.byteLength,
  );
  const readyDecoded = decodeStreamGameFrame(
    ready.subarray(4, 4 + readyView.getUint32(0)),
  );
  assert(readyDecoded);
  assertEquals(readyDecoded.event, "ready");

  assertEquals(encodeStreamGameFrame("not-a-game-event"), null);
});

Deno.test("StreamFrameReader assembles split frames", () => {
  const a = encodeLengthPrefixed(new TextEncoder().encode("hi"));
  const b = encodeStreamGameFrame("leave");
  assert(b);
  const joined = new Uint8Array(a.byteLength + b.byteLength);
  joined.set(a, 0);
  joined.set(b, a.byteLength);

  const reader = new StreamFrameReader();
  const first = reader.push(joined.subarray(0, 3));
  assertEquals(first.length, 0);
  const rest = reader.push(joined.subarray(3));
  assertEquals(rest.length, 2);
  assertEquals(new TextDecoder().decode(rest[0]!), "hi");
  const leave = decodeGamePacket(rest[1]!);
  assertEquals(leave?.event, "leave");
});

Deno.test("StreamFrameReader rejects oversized length", () => {
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, WEBTRANSPORT_MAX_FRAME_BYTES + 1);
  const reader = new StreamFrameReader();
  assertEquals(reader.push(header).length, 0);
  assertEquals(reader.errored, true);
});

Deno.test("datagram body is a raw game packet (no length prefix)", () => {
  const packet = encodeGamePacket("snapshot", {
    tick: 1,
    doorsOpen: false,
    doorChangeTick: 0,
    matchEndTick: 100,
    scores: { A: 0, B: 0 },
    players: [],
    projectiles: [],
  });
  assert(packet);
  const decoded = decodeGamePacket(packet);
  assertEquals(decoded?.event, "snapshot");
});
