import { assertEquals } from "@std/assert";
import type { AdminCommandResultPacket } from "../protocol/network.ts";
import {
  ADMIN_ACTION_TYP,
  type AdminActionClaims,
} from "../shared/admin/adminCommands.ts";
import type { AuthorityPublicKeys } from "../shared/authority/authorityTokens.ts";
import {
  type AdminCommandHost,
  type AdminCommandPacketCtx,
  type AdminKickTarget,
  executeAdminCommand,
  handleAdminCommandPacket,
} from "./adminCommands.ts";
import type { MapCatalogEntry } from "./gameServerOptions.ts";

function claims(
  cmd: string,
  args: Record<string, unknown> = {},
  sub = "admin-1",
): AdminActionClaims {
  return {
    typ: ADMIN_ACTION_TYP,
    sub,
    cmd,
    args,
    exp: 1_800_000_000,
    jti: "jti-1",
  };
}

function entry(name: string, path = `${name}.json`): MapCatalogEntry {
  return {
    name,
    stem: name.toLowerCase(),
    path,
    map: { name } as MapCatalogEntry["map"],
    collision: {} as MapCatalogEntry["collision"],
  };
}

function target(overrides: Partial<AdminKickTarget> = {}): AdminKickTarget {
  const isBot = overrides.isBot ?? false;
  return {
    id: "p1",
    name: "Ada",
    isBot,
    accountUserId: null,
    isAgent: false,
    isBalanceBot: false,
    socketId: isBot ? null : "sock-1",
    isMatchPlayer: () => !isBot,
    ...overrides,
  };
}

type HostCalls = {
  find: string[];
  change: MapCatalogEntry[];
  toggle: number;
  force: Array<boolean | undefined>;
  findPlayer: string[];
  kickBot: string[];
  remove: Array<{ id: string; socketId: string | null }>;
  forget: string[][];
  sync: number;
};

function testHost(opts?: {
  maps?: MapCatalogEntry[];
  current?: { name: string; path: string | undefined };
  players?: AdminKickTarget[];
  kickOk?: boolean;
  live?: boolean;
  tracking?: boolean;
  doors?: boolean;
  draw?: boolean;
}): { host: AdminCommandHost; calls: HostCalls } {
  const maps = opts?.maps ?? [entry("Courtyard"), entry("Yard")];
  const players = opts?.players ?? [];
  const calls: HostCalls = {
    find: [],
    change: [],
    toggle: 0,
    force: [],
    findPlayer: [],
    kickBot: [],
    remove: [],
    forget: [],
    sync: 0,
  };
  let tracking = opts?.tracking ?? false;
  let doors = opts?.doors ?? false;
  const host: AdminCommandHost = {
    findMap(query) {
      calls.find.push(query);
      return maps.find((map) => map.name === query) ?? null;
    },
    mapNames: () => maps.map((map) => map.name),
    currentMap: () =>
      opts?.current ?? { name: "Courtyard", path: "Courtyard.json" },
    changeMap(next) {
      calls.change.push(next);
      return { endedAsDraw: opts?.draw ?? false };
    },
    toggleBotTracking() {
      calls.toggle += 1;
      tracking = !tracking;
      return tracking;
    },
    forceDoors(enabled) {
      calls.force.push(enabled);
      doors = enabled ?? !doors;
      return doors;
    },
    findPlayer(name) {
      calls.findPlayer.push(name);
      return players.find((player) => player.name === name) ?? null;
    },
    kickBot(id) {
      calls.kickBot.push(id);
      return opts?.kickOk ?? true;
    },
    removeHuman(player) {
      calls.remove.push(player);
    },
    forgetSilently(ids) {
      calls.forget.push([...ids]);
      return true;
    },
    syncAfterRosterChange() {
      calls.sync += 1;
    },
    isLive: () => opts?.live ?? true,
  };
  return { host, calls };
}

function assertCode(
  result: AdminCommandResultPacket,
  code: string,
  error: string,
) {
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertEquals(result.code, code);
  assertEquals(result.error, error);
}

Deno.test("change_map reports unknown maps and passes the query through", () => {
  const { host, calls } = testHost();
  const unknown = executeAdminCommand(
    claims("change_map", { mapName: " Missing " }),
    host,
  );
  assertCode(
    unknown,
    "admin_unknown_map",
    'Unknown map " Missing ". Available: Courtyard, Yard',
  );
  assertEquals(calls.find, [" Missing "]);
  assertEquals(calls.change, []);

  const empty = testHost({ maps: [] });
  const noCatalog = executeAdminCommand(
    claims("change_map", { mapName: "Nope" }),
    empty.host,
  );
  assertCode(noCatalog, "admin_unknown_map", 'Unknown map "Nope".');
});

Deno.test("change_map stays put only when name and path both match", () => {
  const same = testHost();
  const already = executeAdminCommand(
    claims("change_map", { mapName: "Courtyard" }),
    same.host,
  );
  assertEquals(already, {
    ok: true,
    command: "change_map",
    message: 'Already on map "Courtyard".',
    data: { mapName: "Courtyard" },
    jti: "jti-1",
  });
  assertEquals(same.calls.change, []);

  const moved = testHost({
    current: { name: "Courtyard", path: "other.json" },
    draw: true,
  });
  const draw = executeAdminCommand(
    claims("change_map", { mapName: "Courtyard" }),
    moved.host,
  );
  assertEquals(draw.ok, true);
  if (!draw.ok) return;
  assertEquals(
    draw.message,
    'Changed map to "Courtyard" (previous match recorded as a draw).',
  );
  assertEquals(draw.data, { mapName: "Courtyard", endedAsDraw: true });
  assertEquals(moved.calls.change.length, 1);

  const quiet = testHost({ draw: false });
  const next = executeAdminCommand(
    claims("change_map", { mapName: "Yard" }),
    quiet.host,
  );
  assertEquals(next.ok, true);
  if (!next.ok) return;
  assertEquals(next.message, 'Changed map to "Yard".');
  assertEquals(next.data, { mapName: "Yard", endedAsDraw: false });
});

Deno.test("kick error codes, including kicking yourself", () => {
  const missing = testHost();
  assertCode(
    executeAdminCommand(claims("kick", {}), missing.host),
    "admin_kick_bad_args",
    "kick requires a player name.",
  );
  assertCode(
    executeAdminCommand(claims("kick", { name: "   " }), missing.host),
    "admin_kick_bad_args",
    "kick requires a player name.",
  );
  assertEquals(missing.calls.findPlayer, []);

  const absent = testHost();
  assertCode(
    executeAdminCommand(claims("kick", { name: "Nobody" }), absent.host),
    "admin_kick_not_found",
    'No player named "Nobody" on this server.',
  );
  assertEquals(absent.calls.findPlayer, ["Nobody"]);

  const self = testHost({
    players: [target({ accountUserId: "admin-1" })],
  });
  assertCode(
    executeAdminCommand(claims("kick", { name: "Ada" }), self.host),
    "admin_kick_self",
    "You cannot kick yourself.",
  );
  assertEquals(self.calls.remove, []);
  assertEquals(self.calls.kickBot, []);

  const failed = testHost({
    players: [target({ isBot: true, name: "bot1", id: "b1" })],
    kickOk: false,
  });
  assertCode(
    executeAdminCommand(claims("kick", { name: "bot1" }), failed.host),
    "admin_kick_failed",
    'Failed to kick fill bot "bot1".',
  );
  assertEquals(failed.calls.forget, []);
  assertEquals(failed.calls.sync, 0);
});

Deno.test("bot kind labels, and a pool pawn syncs only while the match is live", () => {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    const cases: Array<{
      player: AdminKickTarget;
      kind: string;
      live: boolean;
      sync: boolean;
    }> = [
      {
        player: target({
          isBot: true,
          isAgent: true,
          name: "Grey",
          id: "agent-1",
          isMatchPlayer: () => false,
        }),
        kind: "agent",
        live: true,
        sync: false,
      },
      {
        player: target({
          isBot: true,
          isBalanceBot: true,
          name: "bot",
          id: "bal-1",
          isMatchPlayer: () => false,
        }),
        kind: "balance bot",
        live: true,
        sync: false,
      },
      {
        player: target({
          isBot: true,
          name: "Pawn",
          id: "pawn-1",
          accountUserId: "admin-1",
          isMatchPlayer: () => true,
        }),
        kind: "pool pawn",
        live: true,
        sync: true,
      },
      {
        player: target({
          isBot: true,
          name: "Pawn",
          id: "pawn-2",
          isMatchPlayer: () => true,
        }),
        kind: "pool pawn",
        live: false,
        sync: false,
      },
      {
        player: target({
          isBot: true,
          name: "bot3",
          id: "fill-1",
          isMatchPlayer: () => false,
        }),
        kind: "fill bot",
        live: true,
        sync: false,
      },
    ];
    for (const row of cases) {
      const { host, calls } = testHost({
        players: [row.player],
        live: row.live,
      });
      const result = executeAdminCommand(
        claims("kick", { name: row.player.name }),
        host,
      );
      assertEquals(result.ok, true);
      if (!result.ok) continue;
      assertEquals(result.message, `Kicked ${row.kind} "${row.player.name}".`);
      assertEquals(result.data, {
        name: row.player.name,
        id: row.player.id,
        isBot: true,
        isSeed: row.player.isMatchPlayer(),
        isAgent: row.player.isAgent,
        isBalanceBot: row.player.isBalanceBot,
      });
      assertEquals(calls.kickBot, [row.player.id]);
      assertEquals(calls.forget, [[row.player.id]]);
      assertEquals(calls.sync, row.sync ? 1 : 0);
      assertEquals(calls.remove, []);
    }
    assertEquals(logs, [
      "[server] admin kick agent name=Grey id=agent-1 by=admin-1",
      "[server] admin kick balance bot name=bot id=bal-1 by=admin-1",
      "[server] admin kick pool pawn name=Pawn id=pawn-1 by=admin-1",
      "[server] admin kick pool pawn name=Pawn id=pawn-2 by=admin-1",
      "[server] admin kick fill bot name=bot3 id=fill-1 by=admin-1",
    ]);
  } finally {
    console.log = orig;
  }
});

Deno.test("a human kick removes that player", () => {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    const human = testHost({
      players: [target({
        id: "human-1",
        name: "Bea",
        accountUserId: "other",
        socketId: "sock-bea",
      })],
    });
    const result = executeAdminCommand(
      claims("kick", { name: "  Bea  " }),
      human.host,
    );
    assertEquals(result, {
      ok: true,
      command: "kick",
      message: 'Kicked "Bea".',
      data: { name: "Bea", id: "human-1", isBot: false },
      jti: "jti-1",
    });
    assertEquals(human.calls.findPlayer, ["Bea"]);
    assertEquals(human.calls.remove, [{ id: "human-1", socketId: "sock-bea" }]);
    assertEquals(human.calls.kickBot, []);
    assertEquals(logs, [
      "[server] admin kick human name=Bea id=human-1 by=admin-1",
    ]);
  } finally {
    console.log = orig;
  }
});

Deno.test("track_bots, force_doors, and an unhandled command", () => {
  const tracking = testHost({ tracking: false });
  const on = executeAdminCommand(claims("track_bots"), tracking.host);
  assertEquals(on.ok, true);
  if (on.ok) {
    assertEquals(on.message, "Bot tracking engaged.");
    assertEquals(on.data, { engaged: true });
  }
  const off = executeAdminCommand(claims("track_bots"), tracking.host);
  assertEquals(off.ok, true);
  if (off.ok) {
    assertEquals(off.message, "Bot tracking disengaged.");
    assertEquals(off.data, { engaged: false });
  }
  assertEquals(tracking.calls.toggle, 2);

  const doors = testHost({ doors: false });
  const opened = executeAdminCommand(
    claims("force_doors", { enabled: true }),
    doors.host,
  );
  const closed = executeAdminCommand(
    claims("force_doors", { enabled: false }),
    doors.host,
  );
  const toggled = executeAdminCommand(
    claims("force_doors", { enabled: "yes" }),
    doors.host,
  );
  assertEquals(doors.calls.force, [true, false, undefined]);
  assertEquals(
    opened.ok && opened.message,
    "Doors forced open (debug — no closures).",
  );
  assertEquals(closed.ok && closed.message, "Door cycle restored.");
  assertEquals(toggled.ok && toggled.data, { enabled: true });

  const unknown = executeAdminCommand(claims("spectate"), testHost().host);
  assertCode(
    unknown,
    "admin_unknown_command",
    "Unhandled admin command: spectate",
  );
});

type PacketProbe = {
  ctx: AdminCommandPacketCtx;
  replies: AdminCommandResultPacket[];
  tracking: boolean[];
  order: string[];
};

function packetProbe(opts?: {
  keys?: AuthorityPublicKeys;
  account?: unknown;
  verify?: AdminCommandPacketCtx["verifyToken"];
  consume?: AdminCommandPacketCtx["consumeJti"];
  host?: AdminCommandHost;
  playerId?: () => string | null | undefined;
}): PacketProbe {
  const replies: AdminCommandResultPacket[] = [];
  const tracking: boolean[] = [];
  const order: string[] = [];
  const ctx: AdminCommandPacketCtx = {
    authorityTokenPublicKeys: opts?.keys ?? { kid: "spki" },
    rankedServerId: "ranked",
    accountUserId: () => {
      order.push("account");
      return opts && "account" in opts ? opts.account : "admin-1";
    },
    playerId: () => {
      order.push("player");
      return opts?.playerId ? opts.playerId() : "p-admin";
    },
    reply: (packet) => {
      order.push("reply");
      replies.push(packet);
    },
    emitBotHeatmapTracking: (engaged) => {
      order.push("tracking");
      tracking.push(engaged);
    },
    host: opts?.host ?? testHost().host,
    verifyToken: opts?.verify ?? ((token, keys, serverId) => {
      order.push(
        `verify:${String(token)}:${serverId}:${Object.keys(keys).join(",")}`,
      );
      return Promise.resolve({
        ok: true as const,
        claims: claims("kick", { name: "Ada" }),
      });
    }),
    consumeJti: opts?.consume ?? ((jti, exp) => {
      order.push(`consume:${jti}:${exp}`);
      return true;
    }),
  };
  return { ctx, replies, tracking, order };
}

Deno.test("admin packet error codes stop before the later steps", async () => {
  const unavailable = packetProbe({ keys: {} });
  await handleAdminCommandPacket({ token: "t" }, unavailable.ctx);
  assertEquals(unavailable.replies, [{
    ok: false,
    error:
      "Admin commands are unavailable on this server (not an official authentic instance).",
    code: "admin_unavailable",
  }]);
  assertEquals(unavailable.order, ["reply"]);

  for (
    const code of [
      "admin_token_invalid",
      "admin_token_expired",
      "admin_server_mismatch",
      "admin_args_invalid",
      "admin_token_replay",
    ]
  ) {
    const denied = packetProbe({
      verify: () =>
        Promise.resolve({
          ok: false as const,
          error: `nope ${code}`,
          code,
        }),
    });
    await handleAdminCommandPacket("raw-token", denied.ctx);
    assertEquals(denied.replies, [{
      ok: false,
      error: `nope ${code}`,
      code,
    }]);
    assertEquals(denied.order, ["reply"]);
  }

  const guest = packetProbe({ account: null });
  await handleAdminCommandPacket({ token: "t" }, guest.ctx);
  assertEquals(guest.replies[0], {
    ok: false,
    error:
      "Join with your account (ranked / official account join) before using admin commands.",
    code: "admin_account_required",
    command: "kick",
    jti: "jti-1",
  });
  assertEquals(guest.order.includes("consume:jti-1:1800000000"), false);

  const mismatch = packetProbe({ account: "someone-else" });
  await handleAdminCommandPacket({ token: "t" }, mismatch.ctx);
  assertEquals(mismatch.replies[0], {
    ok: false,
    error: "Admin token does not match the connected account.",
    code: "admin_identity_mismatch",
    command: "kick",
    jti: "jti-1",
  });
  assertEquals(mismatch.order.includes("consume:jti-1:1800000000"), false);

  const replay = packetProbe({
    consume: () => false,
  });
  await handleAdminCommandPacket({ token: "t" }, replay.ctx);
  assertEquals(replay.replies, [{
    ok: false,
    error: "Admin token already used.",
    code: "admin_token_replay",
    command: "kick",
    jti: "jti-1",
  }]);
  assertEquals(replay.order.includes("player"), false);
});

Deno.test("admin packet logs after execute and emits tracking only for track_bots", async () => {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    const { host, calls } = testHost({
      players: [target({ name: "Ada", accountUserId: "other" })],
    });
    const kick = packetProbe({ host });
    await handleAdminCommandPacket({ token: "signed" }, kick.ctx);
    assertEquals(calls.remove.length, 1);
    assertEquals(kick.replies.length, 1);
    assertEquals(kick.replies[0]?.ok, true);
    assertEquals(kick.tracking, []);
    assertEquals(kick.order, [
      "verify:signed:ranked:kid",
      "account",
      "consume:jti-1:1800000000",
      "player",
      "reply",
    ]);
    assertEquals(logs, [
      "[server] admin kick human name=Ada id=p1 by=admin-1",
      '[server] admin cmd=kick user=admin-1 player=p-admin ok=true msg=Kicked "Ada".',
    ]);

    const none = packetProbe({ playerId: () => undefined });
    await handleAdminCommandPacket(42, none.ctx);
    assertEquals(
      logs[2],
      '[server] admin cmd=kick user=admin-1 player=? ok=false err=No player named "Ada" on this server.',
    );
    assertEquals(none.order[0], "verify:null:ranked:kid");

    const tracking = packetProbe({
      verify: () =>
        Promise.resolve({
          ok: true as const,
          claims: claims("track_bots"),
        }),
      host: testHost({ tracking: false }).host,
    });
    await handleAdminCommandPacket({ token: 7 }, tracking.ctx);
    assertEquals(tracking.tracking, [true]);
    assertEquals(tracking.order.at(-1), "tracking");
    assertEquals(tracking.order.at(-2), "reply");
  } finally {
    console.log = orig;
  }
});
