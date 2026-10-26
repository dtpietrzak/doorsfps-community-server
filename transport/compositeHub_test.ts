import { assertEquals } from "@std/assert";
import { countSessionsByKind, createCompositeHub } from "./compositeHub.ts";
import type {
  ClientSession,
  SessionAuth,
  SessionAuthenticator,
  SessionData,
  SessionEventHandler,
  SessionHub,
} from "./types.ts";

class FakeSession implements ClientSession {
  readonly auth: Readonly<SessionAuth> = {};
  readonly data: SessionData = {};
  readonly emitted: Array<{ event: string; payload?: unknown; volatile: boolean }> =
    [];

  constructor(
    readonly id: string,
    readonly kind: ClientSession["kind"],
  ) {}

  emit(event: string, payload?: unknown): void {
    this.emitted.push({ event, payload, volatile: false });
  }
  emitVolatile(event: string, payload?: unknown): void {
    this.emitted.push({ event, payload, volatile: true });
  }
  on(_event: string, _handler: SessionEventHandler): void {}
  disconnect(): void {}
  isWritable(): boolean {
    return true;
  }
  writeBufferLength(): number {
    return 0;
  }
}

class FakeHub implements SessionHub {
  readonly live = new Map<string, FakeSession>();
  authenticator: SessionAuthenticator | null = null;
  connectHandler: ((session: ClientSession) => void) | null = null;
  closed = false;
  readonly broadcasts: Array<{ event: string; payload?: unknown }> = [];

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
    this.broadcasts.push({ event, payload });
    for (const session of this.live.values()) session.emit(event, payload);
  }

  get(id: string): ClientSession | undefined {
    return this.live.get(id);
  }

  sessions(): Iterable<ClientSession> {
    return this.live.values();
  }

  close(): Promise<void> {
    this.closed = true;
    this.live.clear();
    return Promise.resolve();
  }

  add(session: FakeSession): void {
    this.live.set(session.id, session);
    this.connectHandler?.(session);
  }
}

Deno.test("createCompositeHub: single child is returned as-is", () => {
  const a = new FakeHub();
  assertEquals(createCompositeHub([a]), a);
});

Deno.test("CompositeHub: union size / get / emit / close / auth", async () => {
  const ws = new FakeHub();
  const wt = new FakeHub();
  const hub = createCompositeHub([ws, wt]);

  let connected = 0;
  hub.authenticate((auth) => ({
    ok: true,
    data: { playerName: String(auth.name ?? "") },
  }));
  hub.onConnect(() => {
    connected += 1;
  });

  assertEquals(ws.authenticator !== null, true);
  assertEquals(wt.authenticator !== null, true);

  const s1 = new FakeSession("sio_1", "websocket");
  const s2 = new FakeSession("wt_1", "webtransport");
  ws.add(s1);
  wt.add(s2);

  assertEquals(hub.size, 2);
  assertEquals(connected, 2);
  assertEquals(hub.get("sio_1")?.id, "sio_1");
  assertEquals(hub.get("wt_1")?.kind, "webtransport");
  assertEquals([...hub.sessions()].map((s) => s.id).sort(), ["sio_1", "wt_1"]);
  assertEquals(countSessionsByKind(hub), {
    websocketSessions: 1,
    webTransportSessions: 1,
  });

  hub.emit("tick", { n: 3 });
  assertEquals(ws.broadcasts, [{ event: "tick", payload: { n: 3 } }]);
  assertEquals(wt.broadcasts, [{ event: "tick", payload: { n: 3 } }]);
  assertEquals(s1.emitted[0]?.event, "tick");
  assertEquals(s2.emitted[0]?.payload, { n: 3 });

  await hub.close();
  assertEquals(ws.closed, true);
  assertEquals(wt.closed, true);
  assertEquals(hub.size, 0);
});
