import type { Server as NodeHttpServer } from "node:http";
import type { Server as NodeHttpsServer } from "node:https";
import { Server, type Socket } from "socket.io";

import {
  decodeGamePacket,
  GAME_PACKET_EVENT,
  isEmptyGameEvent,
  isGameEvent,
  sendGame,
} from "../shared/net/index.ts";
import {
  isTransportWritable,
  readWriteBufferLength,
} from "./poseHeartbeat.ts";
import type {
  ClientSession,
  SessionAuth,
  SessionAuthenticator,
  SessionData,
  SessionEventHandler,
  SessionHub,
  SessionTransportKind,
} from "./types.ts";

export type SocketIoHubOptions = {
  cors?: { origin: string };
};

class SocketIoSession implements ClientSession {
  readonly kind: SessionTransportKind = "websocket";
  readonly auth: Readonly<SessionAuth>;
  readonly data: SessionData;
  private readonly gameHandlers = new Map<string, Set<SessionEventHandler>>();

  constructor(private readonly socket: Socket, data: SessionData) {
    this.auth = Object.freeze({ ...(socket.handshake.auth ?? {}) });
    this.data = data;
    this.socket.on(GAME_PACKET_EVENT, (raw: unknown) => {
      const decoded = decodeGamePacket(raw);
      if (!decoded) return;
      const set = this.gameHandlers.get(decoded.event);
      if (!set) return;
      for (const handler of set) handler(decoded.payload);
    });
  }

  get id(): string {
    return this.socket.id;
  }

  emit(event: string, payload?: unknown): void {
    sendGame(this.socket, event, payload);
  }

  emitVolatile(event: string, payload?: unknown): void {
    sendGame(this.socket.volatile, event, payload);
  }

  on(event: string, handler: SessionEventHandler): void {
    if (!isGameEvent(event) || isEmptyGameEvent(event)) {
      this.socket.on(event, handler);
      return;
    }
    let set = this.gameHandlers.get(event);
    if (!set) {
      set = new Set();
      this.gameHandlers.set(event, set);
    }
    set.add(handler);
  }

  disconnect(): void {
    this.socket.disconnect(true);
  }

  isWritable(): boolean {
    return isTransportWritable(this.socket.conn);
  }

  writeBufferLength(): number {
    return readWriteBufferLength(this.socket.conn);
  }
}

class SocketIoHub implements SessionHub {
  private readonly io: Server;
  private readonly live = new Map<string, SocketIoSession>();
  private authenticator: SessionAuthenticator | null = null;
  private connectHandler: ((session: ClientSession) => void) | null = null;

  constructor(
    httpServer: NodeHttpServer | NodeHttpsServer,
    options?: SocketIoHubOptions,
  ) {
    this.io = new Server(httpServer, {
      cors: options?.cors ?? { origin: "*" },
      transports: ["websocket"],
      perMessageDeflate: false,
    });

    this.io.use((socket, next) => {
      void this.runAuth(socket)
        .then(() => next())
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          next(new Error(message));
        });
    });

    this.io.on("connection", (socket) => {
      const pending = socket.data.sessionData as SessionData | undefined;
      const session = new SocketIoSession(socket, pending ?? {});
      this.live.set(session.id, session);
      socket.on("disconnect", () => {
        this.live.delete(session.id);
      });
      this.connectHandler?.(session);
    });
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
    sendGame(this.io, event, payload);
  }

  get(id: string): ClientSession | undefined {
    return this.live.get(id);
  }

  sessions(): Iterable<ClientSession> {
    return this.live.values();
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.io.close(() => resolve());
    });
  }

  private async runAuth(socket: Socket): Promise<void> {
    if (!this.authenticator) return;
    const auth = (socket.handshake.auth ?? {}) as SessionAuth;
    const result = await this.authenticator(auth);
    if (!result.ok) {
      throw new Error(result.error);
    }
    socket.data.sessionData = { ...result.data };
  }
}

export function createSocketIoHub(
  httpServer: NodeHttpServer | NodeHttpsServer,
  options?: SocketIoHubOptions,
): SessionHub {
  return new SocketIoHub(httpServer, options);
}
