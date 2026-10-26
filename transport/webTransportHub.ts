import {
  decodeGamePacket,
  encodeGamePacket,
} from "../shared/net/index.ts";
import type {
  ClientSession,
  SessionAuth,
  SessionAuthenticator,
  SessionData,
  SessionEventHandler,
  SessionHub,
  SessionTransportKind,
} from "./types.ts";
import {
  WEBTRANSPORT_AUTH_TIMEOUT_MS,
  WEBTRANSPORT_PATH,
  webTransportPathMatches,
} from "./webTransportConfig.ts";
import {
  decodeAuthJson,
  encodeStreamGameFrame,
  StreamFrameReader,
} from "./webTransportFrame.ts";

export type WebTransportListenOptions = {
  hostname: string;
  port: number;
  cert: string;
  key: string;
};

export type WebTransportHubOptions = {
  path?: string;
  authTimeoutMs?: number;
};

export interface WebTransportHub extends SessionHub {
  readonly listening: boolean;
  readonly listenPort: number | null;
  readonly path: string;
  listen(opts: WebTransportListenOptions): void;
}

type WtSessionTransport = WebTransport & { url: string };

class WebTransportSession implements ClientSession {
  readonly kind: SessionTransportKind = "webtransport";
  readonly id: string;
  readonly auth: Readonly<SessionAuth>;
  readonly data: SessionData;
  private readonly handlers = new Map<string, Set<SessionEventHandler>>();
  private readonly disconnectHandlers = new Set<SessionEventHandler>();
  private writeChain: Promise<void> = Promise.resolve();
  private streamWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private datagramWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private lastDatagramOk = true;
  private pendingBytes = 0;
  private closed = false;

  constructor(
    id: string,
    auth: SessionAuth,
    data: SessionData,
    private readonly transport: WtSessionTransport,
    private readonly stream: {
      readable: ReadableStream<Uint8Array>;
      writable: WritableStream<Uint8Array>;
    },
  ) {
    this.id = id;
    this.auth = Object.freeze({ ...auth });
    this.data = data;
    this.streamWriter = stream.writable.getWriter();
    try {
      this.datagramWriter = this.transport.datagrams.writable.getWriter();
    } catch {
      this.datagramWriter = null;
    }
    void this.transport.closed.then(() => this.markClosed()).catch(() =>
      this.markClosed()
    );
  }

  /**
   * Call after onConnect so GameServer handlers exist before leftover
   * auth-chunk frames or the control-stream loop run.
   */
  start(pendingGame: Uint8Array[], leftover: Uint8Array): void {
    for (const body of pendingGame) {
      const decoded = decodeGamePacket(body);
      if (!decoded) continue;
      this.dispatch(
        decoded.event,
        decoded.payload === undefined ? undefined : decoded.payload,
      );
    }
    void this.readControl(this.stream.readable, leftover);
    void this.readDatagrams();
  }

  emit(event: string, payload?: unknown): void {
    if (event === "disconnect") return;
    const frame = encodeStreamGameFrame(event, payload);
    if (!frame || !this.streamWriter) return;
    this.enqueueStream(frame);
  }

  emitVolatile(event: string, payload?: unknown): void {
    const packet = encodeGamePacket(event, payload);
    if (!packet || !this.datagramWriter) {
      this.lastDatagramOk = false;
      return;
    }
    const max = this.maxDatagramSize();
    if (max > 0 && packet.byteLength > max) {
      this.lastDatagramOk = false;
      return;
    }
    this.pendingBytes += packet.byteLength;
    const writer = this.datagramWriter;
    void writer.write(packet).then(() => {
      this.lastDatagramOk = true;
      this.pendingBytes = Math.max(0, this.pendingBytes - packet.byteLength);
    }).catch(() => {
      this.lastDatagramOk = false;
      this.pendingBytes = Math.max(0, this.pendingBytes - packet.byteLength);
    });
  }

  on(event: string, handler: SessionEventHandler): void {
    if (event === "disconnect") {
      this.disconnectHandlers.add(handler);
      return;
    }
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
  }

  disconnect(): void {
    if (this.closed) return;
    try {
      this.transport.close();
    } catch {
      // already closing
    }
    this.markClosed();
  }

  isWritable(): boolean {
    if (this.closed || !this.lastDatagramOk || !this.datagramWriter) return false;
    const desired = this.datagramWriter.desiredSize;
    if (desired == null) return true;
    return desired > 0;
  }

  writeBufferLength(): number {
    return this.pendingBytes;
  }

  dispatch(event: string, payload?: unknown): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const handler of set) handler(payload);
  }

  private maxDatagramSize(): number {
    const raw = (this.transport.datagrams as { maxDatagramSize?: number })
      .maxDatagramSize;
    return typeof raw === "number" && raw > 0 ? raw : 0;
  }

  private enqueueStream(bytes: Uint8Array): void {
    const writer = this.streamWriter;
    if (!writer) return;
    this.pendingBytes += bytes.byteLength;
    this.writeChain = this.writeChain
      .then(() => writer.write(bytes))
      .then(() => {
        this.pendingBytes = Math.max(0, this.pendingBytes - bytes.byteLength);
      })
      .catch(() => {
        this.pendingBytes = Math.max(0, this.pendingBytes - bytes.byteLength);
        this.disconnect();
      });
  }

  private async readControl(
    readable: ReadableStream<Uint8Array>,
    leftover: Uint8Array,
  ): Promise<void> {
    const reader = readable.getReader();
    const frames = new StreamFrameReader();
    if (leftover.byteLength > 0) {
      for (const body of frames.push(leftover)) {
        const decoded = decodeGamePacket(body);
        if (!decoded) continue;
        this.dispatch(
          decoded.event,
          decoded.payload === undefined ? undefined : decoded.payload,
        );
      }
      if (frames.errored) {
        this.disconnect();
        return;
      }
    }
    try {
      while (!this.closed) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        for (const body of frames.push(value)) {
          const decoded = decodeGamePacket(body);
          if (!decoded) continue;
          this.dispatch(
            decoded.event,
            decoded.payload === undefined ? undefined : decoded.payload,
          );
        }
        if (frames.errored) {
          this.disconnect();
          return;
        }
      }
    } catch {
      // stream closed
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
      this.markClosed();
    }
  }

  private async readDatagrams(): Promise<void> {
    const incoming = this.transport.datagrams.readable;
    const reader = incoming.getReader();
    try {
      while (!this.closed) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        const decoded = decodeGamePacket(value);
        if (!decoded) continue;
        this.dispatch(
          decoded.event,
          decoded.payload === undefined ? undefined : decoded.payload,
        );
      }
    } catch {
      // datagrams closed
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
    }
  }

  private markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.streamWriter?.releaseLock();
    } catch {
      // ignore
    }
    try {
      this.datagramWriter?.releaseLock();
    } catch {
      // ignore
    }
    this.streamWriter = null;
    this.datagramWriter = null;
    for (const handler of this.disconnectHandlers) handler();
    this.disconnectHandlers.clear();
  }
}

class WebTransportHubImpl implements WebTransportHub {
  readonly path: string;
  private readonly authTimeoutMs: number;
  private authenticator: SessionAuthenticator | null = null;
  private connectHandler: ((session: ClientSession) => void) | null = null;
  private readonly live = new Map<string, WebTransportSession>();
  private endpoint: Deno.QuicEndpoint | null = null;
  private listener: Deno.QuicListener | null = null;
  private acceptLoop: Promise<void> | null = null;
  private running = false;
  listenPort: number | null = null;

  constructor(options?: WebTransportHubOptions) {
    this.path = options?.path ?? WEBTRANSPORT_PATH;
    this.authTimeoutMs = options?.authTimeoutMs ?? WEBTRANSPORT_AUTH_TIMEOUT_MS;
  }

  get listening(): boolean {
    return this.listener != null;
  }

  get size(): number {
    return this.live.size;
  }

  authenticate(fn: SessionAuthenticator): void {
    this.authenticator = fn;
  }

  onConnect(handler: (session: ClientSession) => void): void {
    this.connectHandler = handler;
  }

  emit(event: string, payload?: unknown): void {
    for (const session of this.live.values()) session.emit(event, payload);
  }

  get(id: string): ClientSession | undefined {
    return this.live.get(id);
  }

  sessions(): Iterable<ClientSession> {
    return this.live.values();
  }

  listen(opts: WebTransportListenOptions): void {
    if (this.listener) return;
    if (typeof Deno.QuicEndpoint !== "function") {
      throw new Error("Deno.QuicEndpoint unavailable (need --unstable-net)");
    }
    const endpoint = new Deno.QuicEndpoint({
      hostname: opts.hostname,
      port: opts.port,
    });
    const listener = endpoint.listen({
      cert: opts.cert,
      key: opts.key,
      alpnProtocols: ["h3"],
    });
    this.endpoint = endpoint;
    this.listener = listener;
    this.listenPort = endpoint.addr.port;
    this.running = true;
    this.acceptLoop = this.runAccept(listener);
  }

  async close(): Promise<void> {
    this.running = false;
    for (const session of [...this.live.values()]) {
      session.disconnect();
    }
    this.live.clear();
    try {
      this.listener?.stop();
    } catch {
      // ignore
    }
    try {
      this.endpoint?.close();
    } catch {
      // ignore
    }
    this.listener = null;
    this.endpoint = null;
    if (this.acceptLoop) {
      await this.acceptLoop.catch(() => {});
      this.acceptLoop = null;
    }
  }

  private async runAccept(listener: Deno.QuicListener): Promise<void> {
    try {
      for await (const incoming of listener) {
        if (!this.running) {
          try {
            incoming.refuse();
          } catch {
            // ignore
          }
          break;
        }
        void this.handleIncoming(incoming);
      }
    } catch {
      // listener stopped
    }
  }

  private async handleIncoming(incoming: Deno.QuicIncoming): Promise<void> {
    let conn: Deno.QuicConn | null = null;
    try {
      conn = await incoming.accept();
      const transport = await Deno.upgradeWebTransport(conn);
      await transport.ready;
      if (!webTransportPathMatches(transport.url, this.path)) {
        try {
          transport.close();
        } catch {
          // ignore
        }
        return;
      }
      await this.acceptSession(transport);
    } catch {
      try {
        conn?.close();
      } catch {
        // ignore
      }
    }
  }

  private async acceptSession(
    transport: WtSessionTransport,
  ): Promise<void> {
    const control = await this.waitControlStream(transport);
    if (!control) {
      try {
        transport.close();
      } catch {
        // ignore
      }
      return;
    }
    const reader = control.readable.getReader();
    const frames = new StreamFrameReader();
    let auth: SessionAuth | null = null;
    const pendingGame: Uint8Array[] = [];
    const deadline = Date.now() + this.authTimeoutMs;
    try {
      while (!auth) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const chunk = await readWithTimeout(reader, remaining);
        if (!chunk) break;
        for (const body of frames.push(chunk)) {
          if (!auth) {
            auth = decodeAuthJson(body);
            continue;
          }
          pendingGame.push(body);
        }
        if (frames.errored) break;
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
    }
    if (!auth) {
      try {
        transport.close();
      } catch {
        // ignore
      }
      return;
    }

    let data: SessionData = {};
    if (this.authenticator) {
      const result = await this.authenticator(auth);
      if (!result.ok) {
        try {
          transport.close();
        } catch {
          // ignore
        }
        return;
      }
      data = { ...result.data };
    }

    const id = `wt_${crypto.randomUUID()}`;
    const session = new WebTransportSession(
      id,
      auth,
      data,
      transport,
      control,
    );
    this.live.set(id, session);
    session.on("disconnect", () => {
      this.live.delete(id);
    });
    this.connectHandler?.(session);
    session.start(pendingGame, frames.remainder());
  }

  private async waitControlStream(
    transport: WtSessionTransport,
  ): Promise<
    | {
      readable: ReadableStream<Uint8Array>;
      writable: WritableStream<Uint8Array>;
    }
    | null
  > {
    const incoming = transport.incomingBidirectionalStreams.getReader();
    try {
      const result = await Promise.race([
        incoming.read(),
        sleep(this.authTimeoutMs).then(() => null),
      ]);
      if (!result || result.done || !result.value) return null;
      return result.value;
    } catch {
      return null;
    } finally {
      try {
        incoming.releaseLock();
      } catch {
        // ignore
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<Uint8Array | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      reader.read(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), Math.max(1, timeoutMs));
      }),
    ]);
    if (!result) return null;
    if (result.done || !result.value) return null;
    return result.value;
  } catch {
    return null;
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}

export function createWebTransportHub(
  options?: WebTransportHubOptions,
): WebTransportHub {
  return new WebTransportHubImpl(options);
}
