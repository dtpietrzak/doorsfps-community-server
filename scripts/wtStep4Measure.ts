/**
 * Step 4 measurement. Real UDP loss and delay in front of one local TLS
 * GameServer. Socket.IO loss is not applied here: dropping TCP bytes
 * corrupts TLS, and dnctl needs a sudo password on this machine.
 *
 *   cd server-community && deno run -A --unstable-net --node-modules-dir=manual scripts/wtStep4Measure.ts
 *
 * WT_MEASURE_MS (default 12000) is the send window.
 * WT_MEASURE_ONLY=wt:40:0 runs one cell. Loss is a percent. "burst" is the
 * bursty cell.
 */
import { io, type Socket } from "socket.io-client";
import { GameServer } from "../runtime/GameServer.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";
import {
  certificateSha256,
  writeSelfSignedDevTls,
} from "../host/tlsDev.ts";
import {
  decodeGamePacket,
  encodeGamePacket,
  GAME_PROTO,
} from "../shared/net/index.ts";
import {
  encodeAuthFrame,
  encodeStreamGameFrame,
  StreamFrameReader,
} from "../transport/webTransportFrame.ts";
import { NetEvents } from "../protocol/network.ts";

const PASSWORD = "step4-pass";
const SAMPLE_MS = Number(Deno.env.get("WT_MEASURE_MS") ?? "12000");
const ONLY = Deno.env.get("WT_MEASURE_ONLY") ?? "";

const miniMap: DoorsMap = {
  name: "wt-measure",
  version: 1,
  bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 },
  gridSize: 1,
  walls: [],
  teamA: {
    corners: [0, 1],
    edge: "south",
    doorHalfWidth: 2,
    spawnRadius: 4,
  },
  teamB: {
    corners: [2, 3],
    edge: "north",
    doorHalfWidth: 2,
    spawnRadius: 4,
  },
};

type Lane = "wt" | "ws";

type Impair = {
  label: string;
  rttMs: number;
  /** Random independent loss, 0–1. Ignored inside a burst window. */
  loss: number;
  burst?: { everyMs: number; lengthMs: number; loss: number };
};

type PlayerRow = {
  id: string;
  inOverwritten: number;
  inRepeatTicks: number;
  inAccepted: number;
  inputGapP95Ms: number | null;
  shotDelayP95Ms: number | null;
  alive: boolean;
  connectionIssue: boolean;
};

type StatusBody = {
  tick: number;
  netMirror: {
    volatileOversize: number;
    largestVolatileBytes: number;
    maxDatagramSize: number | null;
    volatileSent: number;
    volatileDrops: number;
    reliableHeartbeats: number;
    websocketSessions: number;
    webTransportSessions: number;
    players: PlayerRow[];
  };
};

type Cell = {
  lane: Lane;
  impair: string;
  rttMs: number;
  overwrittenPct: number | null;
  repeatTickPct: number | null;
  inputGapP95Ms: number | null;
  shotDelayP95Ms: number | null;
  inAccepted: number;
  inOverwritten: number;
  inRepeatTicks: number;
  ticks: number;
  shotsSent: number;
  maxDatagramSize: number | null;
  largestVolatileBytes: number;
  volatileOversize: number;
  volatileSent: number;
  volatileDrops: number;
  reliableHeartbeats: number;
  note?: string;
};

const GRID: Impair[] = [
  { label: "40 ms / 0%", rttMs: 40, loss: 0 },
  { label: "40 ms / 1%", rttMs: 40, loss: 0.01 },
  { label: "40 ms / 3%", rttMs: 40, loss: 0.03 },
  { label: "100 ms / 0%", rttMs: 100, loss: 0 },
  { label: "100 ms / 1%", rttMs: 100, loss: 0.01 },
  { label: "100 ms / 3%", rttMs: 100, loss: 0.03 },
  {
    label: "40 ms / burst 150 ms at 40% each 1 s",
    rttMs: 40,
    loss: 0,
    burst: { everyMs: 1000, lengthMs: 150, loss: 0.4 },
  },
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldDrop(impair: Impair, started: number): boolean {
  const now = Date.now();
  if (impair.burst) {
    const phase = (now - started) % impair.burst.everyMs;
    if (phase < impair.burst.lengthMs) return Math.random() < impair.burst.loss;
  }
  return Math.random() < impair.loss;
}

function inputPacket(sequence: number): Record<string, unknown> {
  return {
    sequence,
    forward: true,
    backward: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
    crouch: false,
    yaw: Math.PI,
    pitch: 0,
  };
}

function shootPacket(sequence: number, clientTick: number): Record<string, unknown> {
  return {
    yaw: 0,
    pitch: 0,
    origin: [0, 1.6, 0],
    sequence,
    clientTick,
  };
}

class UdpProxy {
  private stop = false;
  private front: Deno.DatagramConn | null = null;
  private back: Deno.DatagramConn | null = null;

  constructor(
    private readonly proxyPort: number,
    private readonly serverPort: number,
    private readonly impair: Impair,
  ) {}

  start(): void {
    this.front = Deno.listenDatagram({
      hostname: "127.0.0.1",
      port: this.proxyPort,
      transport: "udp",
    });
    this.back = Deno.listenDatagram({
      hostname: "127.0.0.1",
      port: 0,
      transport: "udp",
    });
    const serverAddr: Deno.NetAddr = {
      hostname: "127.0.0.1",
      port: this.serverPort,
      transport: "udp",
    };
    const started = Date.now();
    const front = this.front;
    const back = this.back;
    let clientAddr: Deno.Addr | null = null;
    const pump = async (
      from: Deno.DatagramConn,
      send: (data: Uint8Array, addr: Deno.Addr) => Promise<unknown>,
      dest: () => Deno.Addr | null,
      remember: (addr: Deno.Addr) => void,
    ) => {
      while (!this.stop) {
        let data: Uint8Array;
        let addr: Deno.Addr;
        try {
          [data, addr] = await from.receive();
        } catch {
          return;
        }
        remember(addr);
        if (shouldDrop(this.impair, started)) continue;
        const copy = data.slice();
        const target = dest();
        if (!target) continue;
        setTimeout(() => {
          send(copy, target).catch(() => {});
        }, this.impair.rttMs / 2);
      }
    };
    void pump(
      front,
      (data, addr) => back.send(data, addr),
      () => serverAddr,
      (addr) => {
        clientAddr = addr;
      },
    );
    void pump(
      back,
      (data, addr) => front.send(data, addr),
      () => clientAddr,
      () => {},
    );
  }

  close(): void {
    this.stop = true;
    try {
      this.front?.close();
    } catch { /* already closed */ }
    try {
      this.back?.close();
    } catch { /* already closed */ }
  }
}

class TcpProxy {
  private stop = false;
  private listener: Deno.Listener | null = null;

  constructor(
    private readonly proxyPort: number,
    private readonly serverPort: number,
    private readonly impair: Impair,
  ) {}

  start(): void {
    this.listener = Deno.listen({
      hostname: "127.0.0.1",
      port: this.proxyPort,
    });
    const started = Date.now();
    void (async () => {
      const listener = this.listener;
      if (!listener) return;
      for await (const conn of listener) {
        if (this.stop) {
          conn.close();
          break;
        }
        const upstream = await Deno.connect({
          hostname: "127.0.0.1",
          port: this.serverPort,
        });
        this.relay(conn.readable, upstream.writable, started);
        this.relay(upstream.readable, conn.writable, started);
      }
    })().catch(() => {});
  }

  private relay(
    readable: ReadableStream<Uint8Array>,
    writable: WritableStream<Uint8Array>,
    started: number,
  ): void {
    const reader = readable.getReader();
    const writer = writable.getWriter();
    const impair = this.impair;
    void (async () => {
      try {
        while (!this.stop) {
          const { value, done } = await reader.read();
          if (done || !value) break;
          if (shouldDrop(impair, started)) continue;
          const copy = value.slice();
          setTimeout(() => {
            writer.write(copy).catch(() => {});
          }, impair.rttMs / 2);
        }
      } catch {
        // peer closed
      }
    })();
  }

  close(): void {
    this.stop = true;
    try {
      this.listener?.close();
    } catch { /* already closed */ }
  }
}

function reserveProxyPort(): number {
  const probe = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (probe.addr as Deno.NetAddr).port;
  probe.close();
  return port;
}

async function readStatus(
  port: number,
  cert: string,
): Promise<StatusBody> {
  const client = Deno.createHttpClient({ caCerts: [cert] });
  try {
    const res = await fetch(`https://127.0.0.1:${port}/api/status`, { client });
    if (!res.ok) throw new Error(`status ${res.status}`);
    return await res.json() as StatusBody;
  } finally {
    client.close();
  }
}

function noteSnap(raw: Uint8Array, last: { tick: number }): void {
  const decoded = decodeGamePacket(raw);
  if (decoded?.event !== NetEvents.Snapshot) return;
  const tick = (decoded.payload as { tick?: unknown } | undefined)?.tick;
  if (typeof tick === "number" && Number.isFinite(tick)) last.tick = tick;
}

async function runWt(
  port: number,
  hash: ArrayBuffer,
  sampleMs: number,
): Promise<{ id: string; shotsSent: number; close: () => void }> {
  const wt = new WebTransport(`https://127.0.0.1:${port}/wt`, {
    serverCertificateHashes: [{ algorithm: "sha-256", value: hash }],
  });
  await wt.ready;
  const stream = await wt.createBidirectionalStream();
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const frames = new StreamFrameReader();
  const last = { tick: 0 };
  let welcomeId = "";
  const deadline = Date.now() + 8_000;
  await writer.write(encodeAuthFrame({
    name: "MeasureWt",
    proto: GAME_PROTO,
    password: PASSWORD,
  }));
  while (!welcomeId && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done || !value) break;
    for (const body of frames.push(value)) {
      const decoded = decodeGamePacket(body);
      if (decoded?.event === NetEvents.Welcome) {
        welcomeId = String((decoded.payload as { id?: unknown })?.id ?? "");
      } else if (decoded?.event === NetEvents.Snapshot) {
        noteSnap(body, last);
      }
    }
  }
  if (!welcomeId) throw new Error("wt welcome missing");
  const ready = encodeStreamGameFrame(NetEvents.Ready);
  if (ready) await writer.write(ready);

  const dgramReader = wt.datagrams.readable.getReader();
  void (async () => {
    try {
      while (true) {
        const { value, done } = await dgramReader.read();
        if (done || !value) return;
        noteSnap(value, last);
      }
    } catch {
      // closed
    }
  })();
  void (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done || !value) return;
        for (const body of frames.push(value)) noteSnap(body, last);
      }
    } catch {
      // closed
    }
  })();

  let sequence = 1;
  let shotsSent = 0;
  let shotSeq = 1;
  const started = Date.now();
  while (Date.now() - started < sampleMs) {
    const frame = encodeStreamGameFrame(NetEvents.Input, inputPacket(sequence));
    if (!frame) throw new Error("input encode failed");
    await writer.write(frame);
    sequence += 1;
    if (sequence % 8 === 0 && last.tick > 0) {
      const shot = encodeStreamGameFrame(
        NetEvents.Shoot,
        shootPacket(shotSeq, last.tick),
      );
      shotSeq += 1;
      if (!shot) throw new Error("shoot encode failed");
      await writer.write(shot);
      shotsSent += 1;
    }
    await sleep(50);
  }
  return {
    id: welcomeId,
    shotsSent,
    close: () => {
      try {
        wt.close();
      } catch { /* already closing */ }
    },
  };
}

async function runWs(
  port: number,
  sampleMs: number,
): Promise<{ id: string; shotsSent: number; close: () => void }> {
  const socket: Socket = io(`https://127.0.0.1:${port}`, {
    transports: ["websocket"],
    rejectUnauthorized: false,
    timeout: 8_000,
    autoConnect: false,
    auth: { name: "MeasureWs", proto: GAME_PROTO, password: PASSWORD },
  });
  const last = { tick: 0 };
  const welcomeId = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.disconnect();
      reject(new Error("ws welcome timeout"));
    }, 8_000);
    socket.on("g", (raw: unknown) => {
      if (!(raw instanceof Uint8Array)) return;
      const decoded = decodeGamePacket(raw);
      if (decoded?.event === NetEvents.Welcome) {
        clearTimeout(timer);
        resolve(String((decoded.payload as { id?: unknown })?.id ?? ""));
        return;
      }
      noteSnap(raw, last);
    });
    socket.once("connect_error", (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.connect();
  });
  const ready = encodeGamePacket(NetEvents.Ready);
  if (ready) socket.emit("g", ready);

  let sequence = 1;
  let shotsSent = 0;
  let shotSeq = 1;
  const started = Date.now();
  while (Date.now() - started < sampleMs) {
    const packet = encodeGamePacket(NetEvents.Input, inputPacket(sequence));
    if (!packet) throw new Error("input encode failed");
    socket.emit("g", packet);
    sequence += 1;
    if (sequence % 8 === 0 && last.tick > 0) {
      const shot = encodeGamePacket(
        NetEvents.Shoot,
        shootPacket(shotSeq, last.tick),
      );
      shotSeq += 1;
      if (!shot) throw new Error("shoot encode failed");
      socket.emit("g", shot);
      shotsSent += 1;
    }
    await sleep(50);
  }
  return {
    id: welcomeId,
    shotsSent,
    close: () => {
      socket.disconnect();
    },
  };
}

async function oneCell(
  lane: Lane,
  impair: Impair,
  cert: string,
  key: string,
  der: Uint8Array,
): Promise<Cell> {
  const server = new GameServer({
    name: "wt-measure",
    port: 0,
    host: "127.0.0.1",
    map: miniMap,
    collision: new MapCollision(miniMap),
    autofillBots: 0,
    noBotsOnEmptyServer: true,
    joinMode: "open",
    rankedServerId: "community-wt-measure",
    joinPassword: PASSWORD,
    tls: { cert, key },
  });
  await server.start();
  const serverPort = server.getPort();
  const proxyPort = reserveProxyPort();
  const udp = lane === "wt" ? new UdpProxy(proxyPort, serverPort, impair) : null;
  const tcp = lane === "ws" ? new TcpProxy(proxyPort, serverPort, impair) : null;
  if (udp) await udp.start();
  if (tcp) tcp.start();
  const hash = await certificateSha256(der);
  try {
    const before = await readStatus(serverPort, cert);
    let stopPoll = false;
    const poller = (async () => {
      while (!stopPoll) {
        await sleep(2_000);
        if (stopPoll) return;
        try {
          const mid = await readStatus(serverPort, cert);
          const row = mid.netMirror.players[0];
          console.log(
            `POLL ${lane} ${impair.label} tick=${mid.tick} player=${
              JSON.stringify(row ?? null)
            } volatileSent=${mid.netMirror.volatileSent} volatileDrops=${
              mid.netMirror.volatileDrops
            } heartbeats=${mid.netMirror.reliableHeartbeats} cap=${
              mid.netMirror.maxDatagramSize
            } largest=${mid.netMirror.largestVolatileBytes}`,
          );
        } catch (err) {
          console.log(
            `POLL ${lane} ${impair.label} ERR ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    })();
    let run: Awaited<ReturnType<typeof runWt>>;
    try {
      run = lane === "wt"
        ? await runWt(proxyPort, hash, SAMPLE_MS)
        : await runWs(proxyPort, SAMPLE_MS);
    } finally {
      stopPoll = true;
    }
    await poller;
    // Let the delayed proxy deliver the last inputs before the session ends.
    await sleep(impair.rttMs + 300);
    const after = await readStatus(serverPort, cert);
    run.close();
    const player = after.netMirror.players.find((row) => row.id === run.id);
    if (!player) {
      throw new Error(
        `player ${run.id} missing; players=${JSON.stringify(after.netMirror.players)}`,
      );
    }
    const ticks = Math.max(0, after.tick - before.tick);
    const accepted = player.inAccepted;
    return {
      lane,
      impair: impair.label,
      rttMs: impair.rttMs,
      overwrittenPct: accepted > 0
        ? (100 * player.inOverwritten) / accepted
        : null,
      repeatTickPct: ticks > 0 ? (100 * player.inRepeatTicks) / ticks : null,
      inputGapP95Ms: player.inputGapP95Ms,
      shotDelayP95Ms: player.shotDelayP95Ms,
      inAccepted: player.inAccepted,
      inOverwritten: player.inOverwritten,
      inRepeatTicks: player.inRepeatTicks,
      ticks,
      shotsSent: run.shotsSent,
      maxDatagramSize: after.netMirror.maxDatagramSize,
      largestVolatileBytes: after.netMirror.largestVolatileBytes,
      volatileOversize: after.netMirror.volatileOversize,
      volatileSent: after.netMirror.volatileSent,
      volatileDrops: after.netMirror.volatileDrops,
      reliableHeartbeats: after.netMirror.reliableHeartbeats,
    };
  } finally {
    udp?.close();
    tcp?.close();
    await server.stop();
  }
}

async function probeOutgoingMaxAge(
  cert: string,
  key: string,
  der: Uint8Array,
): Promise<unknown> {
  const endpoint = new Deno.QuicEndpoint({ hostname: "127.0.0.1", port: 0 });
  const listener = endpoint.listen({
    cert,
    key,
    alpnProtocols: ["h3"],
  });
  const hash = await certificateSha256(der);
  type Upgraded = Awaited<ReturnType<typeof Deno.upgradeWebTransport>>;
  let settle!: (value: Upgraded) => void;
  let fail!: (err: unknown) => void;
  const incoming = new Promise<Upgraded>((res, rej) => {
    settle = res;
    fail = rej;
  });
  const accept = (async () => {
    try {
      for await (const next of listener) {
        const conn = await next.accept();
        const transport = await Deno.upgradeWebTransport(conn);
        await transport.ready;
        settle(transport);
        return;
      }
    } catch (err) {
      fail(err);
    }
  })();
  const client = new WebTransport(
    `https://127.0.0.1:${endpoint.addr.port}/wt`,
    { serverCertificateHashes: [{ algorithm: "sha-256", value: hash }] },
  );
  try {
    await client.ready;
    const server = await incoming;
    const writable = server.datagrams.writable;
    const names = (value: object): string[] => {
      const out: string[] = [];
      let cursor: object | null = value;
      while (cursor && cursor !== Object.prototype) {
        out.push(...Object.getOwnPropertyNames(cursor));
        cursor = Object.getPrototypeOf(cursor);
      }
      return out;
    };
    const before = server.datagrams.outgoingMaxAge;
    let assign = "absent";
    try {
      server.datagrams.outgoingMaxAge = 1;
      assign = `datagrams=${String(server.datagrams.outgoingMaxAge)}`;
    } catch (err) {
      assign = `throw:${err instanceof Error ? err.message : String(err)}`;
    }
    // Hold the client reader so anything still queued can age out.
    const writer = writable.getWriter();
    const wrote = 32;
    const desiredBefore = writer.desiredSize;
    for (let i = 0; i < wrote; i++) {
      const marker = new Uint8Array([i]);
      writer.write(marker).catch(() => {});
    }
    const capBeforeRead = server.datagrams.maxDatagramSize;
    await sleep(200);
    const reader = client.datagrams.readable.getReader();
    let got = 0;
    let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
    const readUntil = Date.now() + 400;
    while (Date.now() < readUntil) {
      if (!pending) pending = reader.read();
      const next = await Promise.race([
        pending.then((chunk) => chunk),
        sleep(40).then(() => null),
      ]);
      if (!next) continue;
      pending = null;
      if (next.done || !next.value) break;
      got += 1;
    }
    return {
      deno: Deno.version.deno,
      serverDatagramKeys: names(server.datagrams),
      serverWritableKeys: names(writable),
      clientDatagramKeys: names(client.datagrams),
      outgoingMaxAgeBefore: before,
      assign,
      desiredSizeBeforeWrite: desiredBefore,
      serverMaxDatagramSize: capBeforeRead,
      clientMaxDatagramSize: client.datagrams.maxDatagramSize,
      wrote,
      receivedAfter200ms: got,
    };
  } finally {
    try {
      client.close();
    } catch { /* ignore */ }
    try {
      listener.stop();
    } catch { /* ignore */ }
    try {
      endpoint.close();
    } catch { /* ignore */ }
    await accept.catch(() => {});
  }
}

function cellWanted(lane: Lane, impair: Impair): boolean {
  if (!ONLY) return true;
  const loss = impair.burst ? "burst" : String(Math.round(impair.loss * 100));
  return ONLY === `${lane}:${impair.rttMs}:${loss}`;
}

async function main(): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "doors-wt-measure-" });
  const files = await writeSelfSignedDevTls(dir);
  const cells: Cell[] = [];
  try {
    const probe = await probeOutgoingMaxAge(files.cert, files.key, files.der);
    console.log(`OUTGOING_MAX_AGE ${JSON.stringify(probe)}`);
    for (const impair of GRID) {
      for (const lane of ["wt", "ws"] as const) {
        if (!cellWanted(lane, impair)) continue;
        if (lane === "ws" && (impair.loss > 0 || impair.burst)) {
          cells.push({
            lane,
            impair: impair.label,
            rttMs: impair.rttMs,
            overwrittenPct: null,
            repeatTickPct: null,
            inputGapP95Ms: null,
            shotDelayP95Ms: null,
            inAccepted: 0,
            inOverwritten: 0,
            inRepeatTicks: 0,
            ticks: 0,
            shotsSent: 0,
            maxDatagramSize: null,
            largestVolatileBytes: 0,
            volatileOversize: 0,
            volatileSent: 0,
            volatileDrops: 0,
            reliableHeartbeats: 0,
            note: "tcp segment loss needs dnctl; sudo password was required",
          });
          console.log(`SKIP ${lane} ${impair.label}`);
          continue;
        }
        console.log(`RUN ${lane} ${impair.label}`);
        try {
          const cell = await oneCell(
            lane,
            impair,
            files.cert,
            files.key,
            files.der,
          );
          cells.push(cell);
          console.log(`CELL ${JSON.stringify(cell)}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.log(`FAIL ${lane} ${impair.label} ${message}`);
          cells.push({
            lane,
            impair: impair.label,
            rttMs: impair.rttMs,
            overwrittenPct: null,
            repeatTickPct: null,
            inputGapP95Ms: null,
            shotDelayP95Ms: null,
            inAccepted: 0,
            inOverwritten: 0,
            inRepeatTicks: 0,
            ticks: 0,
            shotsSent: 0,
            maxDatagramSize: null,
            largestVolatileBytes: 0,
            volatileOversize: 0,
            volatileSent: 0,
            volatileDrops: 0,
            reliableHeartbeats: 0,
            note: message,
          });
        }
      }
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
  console.log(`RESULT ${JSON.stringify(cells)}`);
}

if (import.meta.main) {
  await main();
}
