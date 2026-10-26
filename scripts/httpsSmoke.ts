/**
 * Local proof that GameServer can terminate TLS:
 *   GET /api/status over HTTPS + Socket.IO welcome over WSS.
 *
 * Usage:
 *   cd server-community && deno task https-smoke
 *
 * Generates a self-signed localhost cert, starts an in-process server, then exits.
 */

import { io } from "socket.io-client";
import { GameServer } from "../runtime/GameServer.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";
import { decodeGamePacket, GAME_PROTO } from "../shared/net/index.ts";
import { NetEvents } from "../protocol/network.ts";
import { writeSelfSignedDevTls } from "../host/tlsDev.ts";

const miniMap: DoorsMap = {
  name: "https-smoke",
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

async function expectWelcome(url: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const socket = io(url, {
      transports: ["websocket"],
      rejectUnauthorized: false,
      timeout: 8_000,
      autoConnect: false,
      auth: {
        name: "HttpsSmoke",
        proto: GAME_PROTO,
        password: "smoke-pass",
      },
    });
    const timer = setTimeout(() => {
      socket.disconnect();
      reject(new Error(`welcome timeout for ${url}`));
    }, 8_000);
    socket.on("g", (raw: unknown) => {
      const decoded = decodeGamePacket(raw);
      if (decoded?.event !== NetEvents.Welcome) return;
      clearTimeout(timer);
      socket.disconnect();
      const payload = decoded.payload as { id?: string };
      if (typeof payload?.id !== "string") {
        reject(new Error("welcome missing id"));
        return;
      }
      resolve(payload.id);
    });
    socket.once("connect_error", (err) => {
      clearTimeout(timer);
      socket.disconnect();
      reject(err);
    });
    socket.connect();
  });
}

async function main(): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "doors-https-smoke-" });
  const files = await writeSelfSignedDevTls(dir);

  const httpServer = new GameServer({
    name: "https-smoke-http",
    port: 0,
    host: "127.0.0.1",
    map: miniMap,
    collision: new MapCollision(miniMap),
    autofillBots: 0,
    noBotsOnEmptyServer: true,
    joinMode: "open",
    rankedServerId: "community-https-smoke",
    joinPassword: "smoke-pass",
  });
  const httpsServer = new GameServer({
    name: "https-smoke",
    port: 0,
    host: "127.0.0.1",
    map: miniMap,
    collision: new MapCollision(miniMap),
    autofillBots: 0,
    noBotsOnEmptyServer: true,
    joinMode: "open",
    rankedServerId: "community-https-smoke",
    joinPassword: "smoke-pass",
    tls: { cert: files.cert, key: files.key },
  });

  try {
    await httpServer.start();
    const httpPort = httpServer.getPort();
    const httpRes = await fetch(`http://127.0.0.1:${httpPort}/api/status`);
    const httpBody = await httpRes.json() as {
      online?: boolean;
      tls?: boolean;
    };
    if (!httpRes.ok || httpBody.online !== true || httpBody.tls !== false) {
      throw new Error(`HTTP status unexpected: ${JSON.stringify(httpBody)}`);
    }
    console.log(`ok  HTTP  /api/status tls=${httpBody.tls} port=${httpPort}`);

    await httpsServer.start();
    const httpsPort = httpsServer.getPort();
    const client = Deno.createHttpClient({ caCerts: [files.cert] });
    try {
      const httpsRes = await fetch(
        `https://127.0.0.1:${httpsPort}/api/status`,
        {
          client,
        },
      );
      const httpsBody = await httpsRes.json() as {
        online?: boolean;
        tls?: boolean;
        webTransport?: { enabled?: boolean; listening?: boolean; path?: string };
      };
      if (!httpsRes.ok || httpsBody.online !== true || httpsBody.tls !== true) {
        throw new Error(
          `HTTPS status unexpected: ${JSON.stringify(httpsBody)}`,
        );
      }
      if (
        httpsBody.webTransport?.enabled !== true ||
        httpsBody.webTransport?.listening !== true ||
        httpsBody.webTransport?.path !== "/wt"
      ) {
        throw new Error(
          `HTTPS webTransport unexpected: ${JSON.stringify(httpsBody.webTransport)}`,
        );
      }
      console.log(
        `ok  HTTPS /api/status tls=${httpsBody.tls} port=${httpsPort}` +
          ` wt=${httpsBody.webTransport.listening}`,
      );
    } finally {
      client.close();
    }

    const id = await expectWelcome(`https://127.0.0.1:${httpsPort}`);
    console.log(`ok  WSS   welcome id=${id}`);
    console.log("https smoke passed");
  } finally {
    await httpsServer.stop().catch(() => {});
    await httpServer.stop().catch(() => {});
    await Deno.remove(dir, { recursive: true });
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`https smoke failed: ${message}`);
    Deno.exit(1);
  }
}
