import type {
  ClientSession,
  SessionAuthenticator,
  SessionHub,
} from "./types.ts";

class CompositeHub implements SessionHub {
  constructor(private readonly children: readonly SessionHub[]) {
    if (children.length === 0) {
      throw new Error("CompositeHub requires at least one child hub");
    }
  }

  get size(): number {
    let n = 0;
    for (const child of this.children) n += child.size;
    return n;
  }

  authenticate(fn: SessionAuthenticator): void {
    for (const child of this.children) child.authenticate(fn);
  }

  onConnect(handler: (session: ClientSession) => void): void {
    for (const child of this.children) child.onConnect(handler);
  }

  emit(event: string, payload?: unknown): void {
    for (const child of this.children) child.emit(event, payload);
  }

  get(id: string): ClientSession | undefined {
    for (const child of this.children) {
      const found = child.get(id);
      if (found) return found;
    }
    return undefined;
  }

  *sessions(): Iterable<ClientSession> {
    for (const child of this.children) {
      yield* child.sessions();
    }
  }

  async close(): Promise<void> {
    for (const child of this.children) {
      await child.close();
    }
  }
}

export function createCompositeHub(children: readonly SessionHub[]): SessionHub {
  if (children.length === 1) return children[0]!;
  return new CompositeHub(children);
}

export function countSessionsByKind(hub: SessionHub | undefined): {
  websocketSessions: number;
  webTransportSessions: number;
} {
  let websocketSessions = 0;
  let webTransportSessions = 0;
  if (!hub) return { websocketSessions, webTransportSessions };
  for (const session of hub.sessions()) {
    if (session.kind === "webtransport") webTransportSessions += 1;
    else websocketSessions += 1;
  }
  return { websocketSessions, webTransportSessions };
}
