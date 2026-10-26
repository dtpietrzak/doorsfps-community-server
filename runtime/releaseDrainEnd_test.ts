import { assertEquals } from "@std/assert";
import { io } from "socket.io-client";
import { GAME_PROTO, decodeGamePacket } from "../shared/net/index.ts";
import { GameServer } from "./GameServer.ts";
import { PlayerManager } from "../players/PlayerManager.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";
import type { GameOverPacket } from "../protocol/network.ts";
import { NetEvents } from "../protocol/network.ts";

const miniMap: DoorsMap = {
  name: "drain-end",
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

type DrainHarness = {
  releaseLocked: boolean;
  players: PlayerManager;
  decorateGameOver: (packet: GameOverPacket) => GameOverPacket;
  finishIntermission: (tick: number) => void;
};

Deno.test("release drain returns endgame humans as a real leave", async () => {
  const server = new GameServer({
    name: "drain-end",
    port: 0,
    host: "127.0.0.1",
    map: miniMap,
    collision: new MapCollision(miniMap),
    autofillBots: 0,
    noBotsOnEmptyServer: true,
    joinMode: "open",
    rankedServerId: "community-drain-end",
    joinPassword: "drain-pass",
  });
  await server.start();
  try {
    const port = server.getPort();
    const kicked = new Promise<string>((resolve, reject) => {
      const socket = io(`http://127.0.0.1:${port}`, {
        transports: ["websocket"],
        timeout: 8_000,
        autoConnect: false,
        auth: { name: "DrainSit", proto: GAME_PROTO, password: "drain-pass" },
      });
      const timer = setTimeout(() => {
        socket.disconnect();
        reject(new Error("drain leave timeout"));
      }, 8_000);
      socket.on("g", (raw: unknown) => {
        const decoded = decodeGamePacket(raw);
        if (decoded?.event !== NetEvents.Welcome) return;
        assertEquals(server.getHumanCount(), 1);

        const harness = server as unknown as DrainHarness;
        harness.releaseLocked = true;
        const over = harness.players.forceEndMatch(harness.players.tick, "A", {
          scheduleRestart: true,
          restartSeconds: 1,
        });
        const decorated = harness.decorateGameOver(over!);
        assertEquals(decorated.returnToMenu, true);
        assertEquals(decorated.mapVote, undefined);

        harness.finishIntermission(harness.players.tick + 100);
      });
      socket.on("g", (raw: unknown) => {
        const decoded = decodeGamePacket(raw);
        if (decoded?.event !== NetEvents.Kicked) return;
        const payload = decoded.payload as { reason?: string };
        clearTimeout(timer);
        socket.disconnect();
        resolve(payload.reason ?? "");
      });
      socket.once("connect_error", (err) => {
        clearTimeout(timer);
        socket.disconnect();
        reject(err);
      });
      socket.connect();
    });

    assertEquals(await kicked, "return_to_menu");
    assertEquals(server.getHumanCount(), 0);

    const res = await fetch(`http://127.0.0.1:${port}/api/status`);
    const body = await res.json() as { humanCount?: number };
    assertEquals(body.humanCount, 0);
  } finally {
    await server.stop();
  }
});
