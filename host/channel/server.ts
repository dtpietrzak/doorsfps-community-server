/**
 * Unix-socket server for {@link DOORS_HOST_CHANNEL}.
 * Mode 0600: only the user that spawned the match can connect.
 */

import {
  type DirectorToHost,
  encodeHostMessage,
  type HostHello,
  type HostToDirector,
  type IdentityAccept,
  parseDirectorMessage,
} from "./protocol.ts";

export type HostControl = {
  hello(): HostHello;
  setPolicy(policy: Extract<DirectorToHost, { type: "set-policy" }>): void;
  putIdentities(
    identities: Extract<DirectorToHost, { type: "put-identities" }>["identities"],
  ): IdentityAccept;
  setPing(pawnId: string, pingMs: number): void;
};

export class HostChannel {
  private listener: Deno.Listener | null = null;
  private conn: Deno.Conn | null = null;
  private closed = false;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly encoder = new TextEncoder();
  /** Events emitted before a director connects. Flushed after hello. */
  private pendingEvents: HostToDirector[] = [];

  private constructor(
    private readonly path: string,
    private readonly control: HostControl,
  ) {}

  static listen(path: string, control: HostControl): HostChannel {
    const channel = new HostChannel(path, control);
    try {
      Deno.removeSync(path);
    } catch {
      // No stale socket.
    }
    channel.listener = Deno.listen({ path, transport: "unix" });
    try {
      Deno.chmodSync(path, 0o600);
    } catch {
      // The directory mode still limits who can connect.
    }
    void channel.acceptLoop();
    return channel;
  }

  send(event: HostToDirector): void {
    const conn = this.conn;
    if (!conn) {
      this.pendingEvents.push(event);
      if (this.pendingEvents.length > 256) this.pendingEvents.shift();
      return;
    }
    this.enqueue(conn, event);
  }

  async close(): Promise<void> {
    this.closed = true;
    try {
      this.conn?.close();
    } catch {
      // Already closed.
    }
    this.conn = null;
    try {
      this.listener?.close();
    } catch {
      // Already closed.
    }
    this.listener = null;
    try {
      Deno.removeSync(this.path);
    } catch {
      // Already gone.
    }
    await this.writeChain.catch(() => undefined);
  }

  private async acceptLoop(): Promise<void> {
    const listener = this.listener;
    if (!listener) return;
    while (!this.closed) {
      let conn: Deno.Conn;
      try {
        conn = await listener.accept();
      } catch {
        return;
      }
      if (this.closed) {
        try {
          conn.close();
        } catch {
          // Ignore.
        }
        return;
      }
      const previous = this.conn;
      this.conn = conn;
      try {
        previous?.close();
      } catch {
        // The replaced director already left.
      }
      const hello = this.control.hello();
      this.send({ type: "hello", ...hello });
      this.flushPending(conn);
      void this.readLoop(conn);
    }
  }

  private async readLoop(conn: Deno.Conn): Promise<void> {
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of conn.readable) {
        if (this.conn !== conn) return;
        buf += decoder.decode(chunk, { stream: true });
        let nl = buf.indexOf("\n");
        while (nl >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          this.dispatch(line);
          nl = buf.indexOf("\n");
        }
        if (buf.length > 1_000_000) buf = "";
      }
    } catch {
      // Director disconnected.
    } finally {
      if (this.conn === conn) this.conn = null;
    }
  }

  private dispatch(line: string): void {
    const message = parseDirectorMessage(line);
    if (!message) return;
    if (message.type === "set-policy") {
      this.control.setPolicy(message);
      return;
    }
    if (message.type === "set-ping") {
      this.control.setPing(message.pawnId, message.pingMs);
      return;
    }
    const result = this.control.putIdentities(message.identities);
    this.send({
      type: "identities-accepted",
      accepted: result.accepted,
      dropped: result.dropped,
    });
  }

  private flushPending(conn: Deno.Conn): void {
    const queued = this.pendingEvents;
    this.pendingEvents = [];
    for (const event of queued) this.enqueue(conn, event);
  }

  private enqueue(conn: Deno.Conn, event: HostToDirector): void {
    const bytes = this.encoder.encode(encodeHostMessage(event));
    this.writeChain = this.writeChain.then(() => this.writeAll(conn, bytes));
  }

  private async writeAll(conn: Deno.Conn, bytes: Uint8Array): Promise<void> {
    if (this.conn !== conn) return;
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const wrote = await conn.write(bytes.subarray(offset));
        if (wrote <= 0) return;
        offset += wrote;
      }
    } catch {
      // The read loop observes the close.
    }
  }
}
