import { assert, assertEquals, assertThrows } from "@std/assert";
import { decodeGamePacket, encodeGamePacket } from "../shared/net/index.ts";
import { certificateSha256, writeSelfSignedDevTls } from "../host/tlsDev.ts";
import {
  decodeAuthJson,
  encodeAuthFrame,
  encodeLengthPrefixed,
  StreamFrameReader,
} from "./webTransportFrame.ts";
import {
  allocateWebTransportSessionId,
  createWebTransportHub,
} from "./webTransportHub.ts";

async function readPrefixedFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<Uint8Array> {
  const frames = new StreamFrameReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done || !value) throw new Error("stream ended");
    const got = frames.push(value);
    if (got[0]) return got[0];
    if (frames.errored) throw new Error("frame overflow");
  }
}

async function withWtHub(
  fn: (opts: {
    url: string;
    hashes: Array<{ algorithm: "sha-256"; value: ArrayBuffer }>;
    hub: ReturnType<typeof createWebTransportHub>;
  }) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "doors-wt-hub-" });
  try {
    const files = await writeSelfSignedDevTls(dir);
    const hash = await certificateSha256(files.der);
    const hub = createWebTransportHub();
    hub.listen({
      hostname: "127.0.0.1",
      port: 0,
      cert: files.cert,
      key: files.key,
    });
    assert(hub.listening);
    assert(hub.listenPort != null && hub.listenPort > 0);
    try {
      await fn({
        url: `https://127.0.0.1:${hub.listenPort}/wt`,
        hashes: [{ algorithm: "sha-256", value: hash }],
        hub,
      });
    } finally {
      await hub.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("WebTransportHub: auth + Welcome stream + Snapshot datagram", async () => {
  await withWtHub(async ({ url, hashes, hub }) => {
    let connectedId = "";
    hub.authenticate((auth) => {
      if (auth.name !== "Ada") return { ok: false, error: "bad_name" };
      return { ok: true, data: { playerName: "Ada" } };
    });
    hub.onConnect((session) => {
      connectedId = session.id;
      assert(/^[A-Za-z0-9_-]{8}$/.test(session.id.slice(3)));
      assertEquals(session.id.length, 11);
      assertEquals(session.kind, "webtransport");
      assertEquals(session.data.playerName, "Ada");
      session.emit("playerLeft", { id: session.id });
      session.emitVolatile("snapshot", {
        tick: 9,
        doorsOpen: true,
        doorChangeTick: 0,
        matchEndTick: 100,
        scores: { A: 0, B: 0 },
        players: [],
        projectiles: [],
      });
    });

    const wt = new WebTransport(url, { serverCertificateHashes: hashes });
    await wt.ready;
    const stream = await wt.createBidirectionalStream();
    const writer = stream.writable.getWriter();
    await writer.write(encodeAuthFrame({ name: "Ada", proto: 1 }));

    const reader = stream.readable.getReader();
    const reliableBody = await readPrefixedFrame(reader);
    const reliable = decodeGamePacket(reliableBody);
    assertEquals(reliable?.event, "playerLeft");
    assertEquals(
      (reliable?.payload as { id?: string })?.id,
      connectedId,
    );

    const datagrams = wt.datagrams.readable.getReader();
    const { value: dgram } = await datagrams.read();
    assert(dgram);
    const snap = decodeGamePacket(dgram);
    assertEquals(snap?.event, "snapshot");
    assertEquals((snap?.payload as { tick?: number })?.tick, 9);

    const left = new Promise<void>((resolve) => {
      const session = hub.get(connectedId);
      assert(session);
      session.on("leave", () => resolve());
    });
    await writer.write(encodeLengthPrefixed(encodeGamePacket("leave")!));
    await left;

    wt.close();
    await hub.close();
    assertEquals(hub.size, 0);
  });
});

Deno.test("WebTransportHub: oversized datagram does not latch the lane", async () => {
  await withWtHub(async ({ url, hashes, hub }) => {
    hub.authenticate(() => ({ ok: true, data: { playerName: "Ada" } }));
    const connected = new Promise<ReturnType<typeof hub.get>>((resolve) => {
      hub.onConnect((session) => resolve(session));
    });

    const wt = new WebTransport(url, { serverCertificateHashes: hashes });
    await wt.ready;
    const stream = await wt.createBidirectionalStream();
    const writer = stream.writable.getWriter();
    await writer.write(encodeAuthFrame({ name: "Ada", proto: 1 }));
    const session = await connected;
    if (!session) throw new Error("session missing");
    assertEquals(session.isWritable(), true);

    const oversize = session.emitVolatile("kicked", {
      reason: "size",
      message: "x".repeat(20_000),
    });
    assertEquals(oversize, "dropped_oversize");
    assertEquals(session.isWritable(), true);
    const oversizeBytes = session.lastVolatileBytes?.() ?? 0;
    const cap = session.maxDatagramSize?.() ?? 0;
    assertEquals(cap > 0, true);
    assertEquals(oversizeBytes > cap, true);

    const small = session.emitVolatile("snapshot", {
      tick: 4,
      doorsOpen: true,
      doorChangeTick: 0,
      matchEndTick: 100,
      scores: { A: 0, B: 0 },
      players: [],
      projectiles: [],
    });
    assertEquals(small, "sent");
    const smallBytes = session.lastVolatileBytes?.() ?? 0;
    assertEquals(smallBytes > 0 && smallBytes < oversizeBytes, true);

    const datagrams = wt.datagrams.readable.getReader();
    const dgram = await Promise.race([
      datagrams.read().then(({ value }) => value),
      new Promise<undefined>((_, reject) => {
        setTimeout(() => reject(new Error("datagram timeout")), 5_000);
      }),
    ]);
    assert(dgram);
    const snap = decodeGamePacket(dgram);
    assertEquals(snap?.event, "snapshot");
    assertEquals((snap?.payload as { tick?: number })?.tick, 4);
    // desiredSize dips while that write is queued. Once it has arrived the
    // lane is writable again — the oversize packet did not stick.
    for (let i = 0; i < 20 && !session.isWritable(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assertEquals(session.isWritable(), true);

    wt.close();
    await hub.close();
    assertEquals(hub.size, 0);
  });
});

Deno.test("WebTransportHub: reject auth does not occupy a session", async () => {
  await withWtHub(async ({ url, hashes, hub }) => {
    hub.authenticate(() => ({ ok: false, error: "name_taken" }));
    let connected = false;
    hub.onConnect(() => {
      connected = true;
    });

    const wt = new WebTransport(url, { serverCertificateHashes: hashes });
    await wt.ready;
    const stream = await wt.createBidirectionalStream();
    const writer = stream.writable.getWriter();
    await writer.write(encodeAuthFrame({ name: "Bob" }));
    await wt.closed.catch(() => {});
    assertEquals(connected, false);
    assertEquals(hub.size, 0);
    assertEquals(decodeAuthJson(new TextEncoder().encode('{"name":"Bob"}'))?.name, "Bob");
  });
});

Deno.test("WebTransportHub: invalid cert fails listen without binding", async () => {
  const hub = createWebTransportHub();
  assertThrows(
    () =>
      hub.listen({
        hostname: "127.0.0.1",
        port: 0,
        cert: "not-a-cert",
        key: "not-a-key",
      }),
    Error,
  );
  assertEquals(hub.listening, false);
  await hub.close();
});

Deno.test("allocateWebTransportSessionId is wt_ plus 8 url-safe characters", () => {
  const id = allocateWebTransportSessionId(() => false);
  assertEquals(id.length, 11);
  assert(/^[A-Za-z0-9_-]{8}$/.test(id.slice(3)));
});

Deno.test("allocateWebTransportSessionId re-rolls a live id", () => {
  const draws = [
    new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]),
    new Uint8Array([1, 1, 1, 1, 1, 1, 1, 1]),
  ];
  let n = 0;
  const id = allocateWebTransportSessionId(
    (candidate) => candidate === "wt_AAAAAAAA",
    () => draws[n++]!,
  );
  assertEquals(n, 2);
  assertEquals(id, "wt_BBBBBBBB");
});

Deno.test("allocateWebTransportSessionId stops after repeated collisions", () => {
  assertThrows(
    () => allocateWebTransportSessionId(() => true, () => new Uint8Array(8)),
    Error,
    "collision",
  );
});

Deno.test("StreamFrameReader leftover is isolated from next push", () => {
  const reader = new StreamFrameReader();
  const a = encodeAuthFrame({ name: "X" });
  reader.push(a.subarray(0, 5));
  const rem = reader.remainder();
  assertEquals(rem.byteLength, 5);
  rem[0] = 99;
  const rest = reader.push(a.subarray(5));
  assertEquals(rest.length, 1);
});
