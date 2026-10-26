/**
 * Loadlab join claim lands on Player.synthetic.
 *   cd server-community && deno test -A syntheticJoin_test.ts
 */

import { assertEquals } from "jsr:@std/assert@1";
import { GAME_PROTO } from "../shared/net/opcodes.ts";
import { issueRankedJoinToken } from "../shared/authority/tokenIssuer.ts";
import { GameServer } from "./GameServer.ts";
import { NoopAuthorityAdapter } from "../authority/adapter.ts";
import { Player } from "../players/Player.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";

const miniMap: DoorsMap = {
  name: "synthetic-join",
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

function base64(value: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function keys() {
  const pair = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  return {
    privateKey: base64(
      await crypto.subtle.exportKey("pkcs8", pair.privateKey),
    ),
    publicKeys: {
      current: base64(await crypto.subtle.exportKey("spki", pair.publicKey)),
    },
  };
}

Deno.test("Player.synthetic defaults false and copies the join claim", () => {
  const plain = new Player("s0", "Plain", "A", {});
  assertEquals(plain.synthetic, false);
  const sim = new Player("s1", "LL_1", "A", {
    accountUserId: "itest_alpha_1",
    synthetic: true,
  });
  assertEquals(sim.synthetic, true);
});

Deno.test("ranked join token synthetic claim authenticates as synthetic", async () => {
  const key = await keys();
  const issued = await issueRankedJoinToken(
    {
      sub: "itest_alpha_1",
      username: "LL_1",
      serverId: "ranked",
      synthetic: true,
    },
    key.privateKey,
    "current",
  );
  const server = new GameServer({
    name: "synthetic-join",
    port: 0,
    host: "127.0.0.1",
    map: miniMap,
    collision: new MapCollision(miniMap),
    autofillBots: 0,
    noBotsOnEmptyServer: true,
    joinMode: "ranked",
    rankedServerId: "ranked",
    authorityTokenPublicKeys: key.publicKeys,
    authorityAdapter: new NoopAuthorityAdapter(),
    botThinkEngine: null,
  });
  const auth = await (server as unknown as {
    authenticateJoin(bag: Record<string, unknown>): Promise<
      { ok: true; synthetic?: boolean } | { ok: false; error: string }
    >;
  }).authenticateJoin({
    proto: GAME_PROTO,
    joinToken: issued.joinToken,
  });
  assertEquals(auth.ok, true);
  if (!auth.ok) return;
  assertEquals(auth.synthetic, true);

  const player = new Player("sock-1", "LL_1", "A", {
    accountUserId: "itest_alpha_1",
    synthetic: auth.synthetic === true,
  });
  assertEquals(player.synthetic, true);
});
