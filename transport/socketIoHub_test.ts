import { assert, assertEquals } from "@std/assert";
import { createServer } from "node:http";
import { io as ioClient } from "socket.io-client";

import { createSocketIoHub } from "./socketIoHub.ts";
import type { SessionHub } from "./types.ts";

async function listen(
  server: ReturnType<typeof createServer>,
): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr !== "object") {
    throw new Error("expected tcp address");
  }
  return addr.port;
}

async function withHub(
  fn: (hub: SessionHub, url: string) => Promise<void>,
): Promise<void> {
  const httpServer = createServer();
  const hub = createSocketIoHub(httpServer, { cors: { origin: "*" } });
  const port = await listen(httpServer);
  try {
    await fn(hub, `http://127.0.0.1:${port}`);
  } finally {
    await hub.close();
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => {
        if (err && !/not running/i.test(err.message)) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }
}

function connectClient(
  url: string,
  auth?: Record<string, unknown>,
): ReturnType<typeof ioClient> {
  return ioClient(url, {
    transports: ["websocket"],
    timeout: 8_000,
    auth,
  });
}

function waitFor(
  pred: () => boolean,
  label: string,
  timeoutMs = 8_000,
): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (pred()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`${label} timeout`));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

function onceEvent<T>(
  socket: ReturnType<typeof ioClient>,
  event: string,
  timeoutMs = 8_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`${event} timeout`));
    }, timeoutMs);
    const onEvent = (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    };
    socket.once(event, onEvent);
  });
}

Deno.test("SocketIoHub: accept + onConnect + emit + size", async () => {
  await withHub(async (hub, url) => {
    let connectedId = "";
    hub.authenticate((auth) => {
      if (auth.name !== "Ada") return { ok: false, error: "bad_name" };
      return { ok: true, data: { playerName: "Ada" } };
    });
    hub.onConnect((session) => {
      connectedId = session.id;
      assertEquals(session.kind, "websocket");
      assertEquals(session.data.playerName, "Ada");
      assertEquals(session.auth.name, "Ada");
      assertEquals(typeof session.isWritable(), "boolean");
      assertEquals(typeof session.writeBufferLength(), "number");
      session.emit("hello", { ok: true });
    });

    const hello = await new Promise<{ id: string; ok: boolean }>(
      (resolve, reject) => {
        const socket = connectClient(url, { name: "Ada" });
        const timer = setTimeout(() => {
          socket.disconnect();
          reject(new Error("hello timeout"));
        }, 8_000);
        socket.once("hello", (payload: { ok?: boolean }) => {
          const id = socket.id ?? "";
          clearTimeout(timer);
          socket.once("disconnect", () => {
            resolve({ id, ok: payload?.ok === true });
          });
          socket.disconnect();
        });
        socket.once("connect_error", (err) => {
          clearTimeout(timer);
          socket.disconnect();
          reject(err);
        });
      },
    );

    assertEquals(hello.ok, true);
    assertEquals(hello.id, connectedId);
    await waitFor(() => hub.size === 0, "hub empty after client leave");
  });
});

Deno.test("SocketIoHub: reject auth becomes connect_error", async () => {
  await withHub(async (hub, url) => {
    hub.authenticate(() => ({ ok: false, error: "name_taken" }));

    const message = await new Promise<string>((resolve, reject) => {
      const socket = connectClient(url, { name: "Bob" });
      const timer = setTimeout(() => {
        socket.disconnect();
        reject(new Error("connect_error timeout"));
      }, 8_000);
      socket.once("connect_error", (err) => {
        clearTimeout(timer);
        socket.disconnect();
        resolve(err.message);
      });
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.disconnect();
        reject(new Error("expected reject"));
      });
    });

    assertEquals(message, "name_taken");
    assertEquals(hub.size, 0);
  });
});

Deno.test("SocketIoHub: get / sessions / emitVolatile / disconnect", async () => {
  await withHub(async (hub, url) => {
    hub.authenticate(() => ({ ok: true, data: { playerName: "Cara" } }));

    const socket = connectClient(url, { name: "Cara" });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("connect timeout")), 8_000);
        socket.once("connect", () => {
          clearTimeout(timer);
          resolve();
        });
        socket.once("connect_error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      const id = socket.id;
      assert(typeof id === "string" && id.length > 0);
      const session = hub.get(id);
      assert(session);
      assertEquals(session.id, id);
      assertEquals([...hub.sessions()].map((s) => s.id), [id]);
      assertEquals(hub.size, 1);

      const gotReliable = onceEvent<{ t: string }>(socket, "note");
      session.emit("note", { t: "reliable" });
      assertEquals((await gotReliable).t, "reliable");

      // Volatile may be dropped while Engine.IO is not writable; the contract
      // is that the call is safe. When writable, the client should still see it.
      session.emitVolatile("snap", { t: "volatile" });
      if (session.isWritable()) {
        const gotVolatile = await onceEvent<{ t: string }>(socket, "snap");
        assertEquals(gotVolatile.t, "volatile");
      }

      const disconnected = onceEvent<void>(socket, "disconnect");
      session.disconnect();
      await disconnected;
      await waitFor(() => hub.get(id) === undefined, "session removed");
      assertEquals(hub.size, 0);
    } finally {
      socket.disconnect();
    }
  });
});

Deno.test("SocketIoHub: gameplay Snapshot is binary on g and decodes", async () => {
  const { decodeGamePacket, GAME_PACKET_EVENT } = await import(
    "../shared/net/index.ts"
  );
  await withHub(async (hub, url) => {
    hub.authenticate(() => ({ ok: true, data: {} }));
    hub.onConnect((session) => {
      session.emit("snapshot", {
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
    });

    const socket = connectClient(url, { name: "Ada" });
    try {
      const raw = await onceEvent<unknown>(socket, GAME_PACKET_EVENT);
      const decoded = decodeGamePacket(raw);
      assert(decoded);
      assertEquals(decoded.event, "snapshot");
      const payload = decoded.payload as { tick: number; players: { id: string }[] };
      assertEquals(payload.tick, 12);
      assertEquals(payload.players[0]?.id, "p1");
    } finally {
      socket.disconnect();
    }
  });
});

Deno.test("SocketIoHub: broadcast emit reaches every session", async () => {
  await withHub(async (hub, url) => {
    hub.authenticate(() => ({ ok: true, data: {} }));

    const a = connectClient(url, { name: "A" });
    const b = connectClient(url, { name: "B" });
    try {
      await Promise.all([
        onceEvent<void>(a, "connect"),
        onceEvent<void>(b, "connect"),
      ]);
      assertEquals(hub.size, 2);

      const seen = Promise.all([
        new Promise<number>((resolve) => {
          a.once("tick", (payload: { n: number }) => resolve(payload.n));
        }),
        new Promise<number>((resolve) => {
          b.once("tick", (payload: { n: number }) => resolve(payload.n));
        }),
      ]);
      hub.emit("tick", { n: 7 });
      assertEquals(await seen, [7, 7]);
    } finally {
      a.disconnect();
      b.disconnect();
    }
  });
});
