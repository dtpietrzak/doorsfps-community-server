/**
 * Admin console commands. The packet handler verifies the action token,
 * matches the connected account, consumes the jti, runs the command, logs,
 * and sends the bot-heatmap tracking reply. GameServer passes the host:
 * map change, bot tracking, doors, player lookup, bot kick, human removal,
 * and silent rebalance. It never imports GameServer.
 */

import {
  consumeAdminActionJti,
  verifyAdminActionToken,
} from "../authority/adminAuth.ts";
import type { AdminCommandResultPacket } from "../protocol/network.ts";
import type { AdminActionClaims } from "../shared/admin/adminCommands.ts";
import type { AuthorityPublicKeys } from "../shared/authority/authorityTokens.ts";
import type { MapCatalogEntry } from "./gameServerOptions.ts";

/** Roster member an admin kick reads. Player satisfies this. */
export interface AdminKickTarget {
  id: string;
  name: string;
  isBot: boolean;
  accountUserId: string | null;
  isAgent: boolean;
  isBalanceBot: boolean;
  socketId: string | null;
  isMatchPlayer(): boolean;
}

/**
 * What GameServer still owns. `forceDoors(undefined)` toggles; a boolean sets
 * the flag. `forgetSilently` is TeamRebalance's silent drop.
 */
export interface AdminCommandHost {
  findMap(query: string): MapCatalogEntry | null;
  mapNames(): readonly string[];
  currentMap(): { name: string; path: string | undefined };
  changeMap(entry: MapCatalogEntry): { endedAsDraw: boolean };
  toggleBotTracking(): boolean;
  forceDoors(enabled: boolean | undefined): boolean;
  findPlayer(name: string): AdminKickTarget | null;
  kickBot(id: string): boolean;
  removeHuman(target: { id: string; socketId: string | null }): void;
  forgetSilently(ids: readonly string[]): boolean;
  syncAfterRosterChange(): void;
  isLive(): boolean;
}

export type AdminTokenVerify = typeof verifyAdminActionToken;
export type AdminJtiConsume = typeof consumeAdminActionJti;

/** Packet-handler deps. Getters are read at the same points as before. */
export interface AdminCommandPacketCtx {
  authorityTokenPublicKeys: AuthorityPublicKeys;
  rankedServerId: string;
  /** `session.data.accountUserId`, read after the token verifies. */
  accountUserId(): unknown;
  /** Connected player id, read when the result is logged. */
  playerId(): string | null | undefined;
  reply(packet: AdminCommandResultPacket): void;
  emitBotHeatmapTracking(engaged: boolean): void;
  host: AdminCommandHost;
  /**
   * Production passes `verifyAdminActionToken` and `consumeAdminActionJti`.
   * Tests pass fakes so a case can reach every later error code.
   */
  verifyToken: AdminTokenVerify;
  consumeJti: AdminJtiConsume;
}

/**
 * Execute a verified admin action (identity already checked by caller).
 */
export function executeAdminCommand(
  claims: AdminActionClaims,
  host: AdminCommandHost,
): AdminCommandResultPacket {
  if (claims.cmd === "change_map") {
    const mapName = String(claims.args.mapName ?? "");
    const entry = host.findMap(mapName);
    if (!entry) {
      const available = host.mapNames().join(", ");
      return {
        ok: false,
        command: claims.cmd,
        error: available
          ? `Unknown map "${mapName}". Available: ${available}`
          : `Unknown map "${mapName}".`,
        code: "admin_unknown_map",
        jti: claims.jti,
      };
    }
    const current = host.currentMap();
    if (
      entry.name === current.name &&
      entry.path === current.path
    ) {
      return {
        ok: true,
        command: claims.cmd,
        message: `Already on map "${entry.name}".`,
        data: { mapName: entry.name },
        jti: claims.jti,
      };
    }
    const result = host.changeMap(entry);
    const drawNote = result.endedAsDraw
      ? " (previous match recorded as a draw)"
      : "";
    return {
      ok: true,
      command: claims.cmd,
      message: `Changed map to "${entry.name}"${drawNote}.`,
      data: {
        mapName: entry.name,
        endedAsDraw: result.endedAsDraw,
      },
      jti: claims.jti,
    };
  }

  if (claims.cmd === "kick") {
    return executeAdminKick(claims, host);
  }

  if (claims.cmd === "track_bots") {
    const engaged = host.toggleBotTracking();
    return {
      ok: true,
      command: claims.cmd,
      message: engaged ? "Bot tracking engaged." : "Bot tracking disengaged.",
      data: { engaged },
      jti: claims.jti,
    };
  }

  if (claims.cmd === "force_doors") {
    const enabled = host.forceDoors(
      typeof claims.args.enabled === "boolean"
        ? claims.args.enabled
        : undefined,
    );
    return {
      ok: true,
      command: claims.cmd,
      message: enabled
        ? "Doors forced open (debug — no closures)."
        : "Door cycle restored.",
      data: { enabled },
      jti: claims.jti,
    };
  }

  return {
    ok: false,
    command: claims.cmd,
    error: `Unhandled admin command: ${claims.cmd}`,
    code: "admin_unknown_command",
    jti: claims.jti,
  };
}

function executeAdminKick(
  claims: AdminActionClaims,
  host: AdminCommandHost,
): AdminCommandResultPacket {
  const name = String(claims.args.name ?? "").trim();
  if (!name) {
    return {
      ok: false,
      command: claims.cmd,
      error: "kick requires a player name.",
      code: "admin_kick_bad_args",
      jti: claims.jti,
    };
  }

  const target = host.findPlayer(name);
  if (!target) {
    return {
      ok: false,
      command: claims.cmd,
      error: `No player named "${name}" on this server.`,
      code: "admin_kick_not_found",
      jti: claims.jti,
    };
  }

  // Do not let an admin boot themselves mid-command.
  if (
    !target.isBot &&
    target.accountUserId &&
    target.accountUserId === claims.sub
  ) {
    return {
      ok: false,
      command: claims.cmd,
      error: "You cannot kick yourself.",
      code: "admin_kick_self",
      jti: claims.jti,
    };
  }

  if (target.isBot) {
    const wasSeed = target.isMatchPlayer();
    const kind = target.isAgent
      ? "agent"
      : target.isBalanceBot
      ? "balance bot"
      : wasSeed
      ? "pool pawn"
      : "fill bot";
    const kickedName = target.name;
    const kickedId = target.id;
    const ok = host.kickBot(target.id);
    if (!ok) {
      return {
        ok: false,
        command: claims.cmd,
        error: `Failed to kick ${kind} "${kickedName}".`,
        code: "admin_kick_failed",
        jti: claims.jti,
      };
    }
    // Clear pending rebalance if we kicked a scheduled group member.
    // Silent: a bot has no client waiting on the cancel packet.
    host.forgetSilently([kickedId]);
    // Pool pawns count as real players — may change rebalance need / votes.
    // Fill/balance/agent kicks do not change match-player counts.
    if (wasSeed && host.isLive()) {
      host.syncAfterRosterChange();
    }
    // After removing a fill bot, do not force reconcile (would re-add).
    console.log(
      `[server] admin kick ${kind} name=${kickedName} id=${kickedId}` +
        ` by=${claims.sub}`,
    );
    return {
      ok: true,
      command: claims.cmd,
      message: `Kicked ${kind} "${kickedName}".`,
      data: {
        name: kickedName,
        id: kickedId,
        isBot: true,
        isSeed: wasSeed,
        isAgent: target.isAgent,
        isBalanceBot: target.isBalanceBot,
      },
      jti: claims.jti,
    };
  }

  // Human: permanent leave (same path as intentional Leave).
  const kickedName = target.name;
  const kickedId = target.id;
  const socketId = target.socketId;
  host.removeHuman({ id: kickedId, socketId });
  console.log(
    `[server] admin kick human name=${kickedName} id=${kickedId}` +
      ` by=${claims.sub}`,
  );
  return {
    ok: true,
    command: claims.cmd,
    message: `Kicked "${kickedName}".`,
    data: {
      name: kickedName,
      id: kickedId,
      isBot: false,
    },
    jti: claims.jti,
  };
}

/** Token verify, account match, jti consume, execute, log, tracking reply. */
export async function handleAdminCommandPacket(
  raw: unknown,
  ctx: AdminCommandPacketCtx,
): Promise<void> {
  const reply = ctx.reply;

  if (Object.keys(ctx.authorityTokenPublicKeys).length === 0) {
    reply({
      ok: false,
      error:
        "Admin commands are unavailable on this server (not an official authentic instance).",
      code: "admin_unavailable",
    });
    return;
  }

  const token = raw && typeof raw === "object" && "token" in raw
    ? (raw as { token: unknown }).token
    : typeof raw === "string"
    ? raw
    : null;

  const verified = await ctx.verifyToken(
    token,
    ctx.authorityTokenPublicKeys,
    ctx.rankedServerId,
  );
  if (!verified.ok) {
    reply({
      ok: false,
      error: verified.error,
      code: verified.code,
    });
    return;
  }

  const rawAccountUserId = ctx.accountUserId();
  const accountUserId = typeof rawAccountUserId === "string"
    ? rawAccountUserId
    : null;
  if (!accountUserId) {
    reply({
      ok: false,
      error:
        "Join with your account (ranked / official account join) before using admin commands.",
      code: "admin_account_required",
      command: verified.claims.cmd,
      jti: verified.claims.jti,
    });
    return;
  }
  if (accountUserId !== verified.claims.sub) {
    reply({
      ok: false,
      error: "Admin token does not match the connected account.",
      code: "admin_identity_mismatch",
      command: verified.claims.cmd,
      jti: verified.claims.jti,
    });
    return;
  }

  if (
    !ctx.consumeJti(
      verified.claims.jti,
      verified.claims.exp,
    )
  ) {
    reply({
      ok: false,
      error: "Admin token already used.",
      code: "admin_token_replay",
      command: verified.claims.cmd,
      jti: verified.claims.jti,
    });
    return;
  }

  const result = executeAdminCommand(verified.claims, ctx.host);
  console.log(
    `[server] admin cmd=${verified.claims.cmd}` +
      ` user=${verified.claims.sub}` +
      ` player=${ctx.playerId() ?? "?"}` +
      ` ok=${result.ok}` +
      (result.ok ? ` msg=${result.message}` : ` err=${result.error}`),
  );
  reply(result);
  if (
    result.ok &&
    verified.claims.cmd === "track_bots" &&
    result.data &&
    typeof result.data.engaged === "boolean"
  ) {
    ctx.emitBotHeatmapTracking(result.data.engaged);
  }
}
