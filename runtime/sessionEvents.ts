/**
 * Socket wiring for a match. Auth, spectator sockets, seated-player
 * handlers, and disconnect live here. The host owns roster seating
 * (`seatPlayer`) and every sim or match side effect. This file does not
 * import the server class.
 */

import {
  consumeAdminActionJti,
  verifyAdminActionToken,
} from "../authority/adminAuth.ts";
import type { Player } from "../players/Player.ts";
import type { PlayerManager } from "../players/PlayerManager.ts";
import {
  ingressAbility,
  ingressMelee,
  ingressMovementInput,
  ingressReload,
  ingressShoot,
  ingressSkillLoadout,
  ingressWeaponSwitch,
  type SimIngressSinks,
} from "../players/simIngress.ts";
import {
  type ChangeTeamResultPacket,
  CONNECTION_ISSUE_TIMEOUT_MS,
  JoinErrors,
  NetEvents,
  type PingPacket,
  type TeamRebalanceVoteResultPacket,
} from "../protocol/network.ts";
import type { RaidMatch } from "../raid/RaidMatch.ts";
import type { AuthorityPublicKeys } from "../shared/authority/authorityTokens.ts";
import { isClientInitiatedDisconnect } from "../transport/disconnectReason.ts";
import type { InputRateLimiter } from "../transport/inputRateLimit.ts";
import type {
  ClientSession,
  SessionAuth,
  SessionHub,
} from "../transport/types.ts";
import {
  type AdminCommandHost,
  handleAdminCommandPacket,
} from "./adminCommands.ts";
import { type AdmittedJoin, sessionDataFromJoin } from "./joinAuth.ts";
import type { MapVote } from "./mapVote.ts";
import type { PoseStream } from "./poseStream.ts";
import type { TeamRebalance } from "./teamRebalance.ts";

/** What `seatPlayer` hands the welcome / roster announce. */
export type SeatedPlayer = {
  player: Player;
  reclaimed: boolean;
  respawnedOnReclaim: boolean;
};

/**
 * Closures and stable collaborators the wiring calls. The loop is assigned
 * in `startGameLoop`, after this wiring runs, so tick reads stay getters.
 * `raid` is assigned when the first raider sits.
 */
export type SessionEventHost = {
  authenticateJoin: (
    auth: SessionAuth,
  ) => Promise<AdmittedJoin | { ok: false; error: string }>;
  welcomePayloadSpectator: (socketId: string) => unknown;
  welcomePayload: (playerId: string) => unknown;
  seatPlayer: (session: ClientSession) => SeatedPlayer | null;
  /** `this.loop.tickCount`. Throws before startGameLoop, same as before. */
  tickCount: () => number;
  /** False until startGameLoop assigns the loop. Heartbeat bails on this. */
  loopReady: () => boolean;
  simNowMs: () => number;
  players: PlayerManager;
  poses: PoseStream;
  inputRate: InputRateLimiter;
  ingressSinks: () => SimIngressSinks;
  mapVote: MapVote;
  teamRebalance: TeamRebalance;
  authorityTokenPublicKeys: AuthorityPublicKeys;
  rankedServerId: string;
  adminCommandHost: () => AdminCommandHost;
  raid: () => RaidMatch | null;
  raidLoadedPlayerIds: () => Set<string>;
  handleMatchReady: (playerId: string, ready: boolean) => void;
  dropPlayer: (playerId: string) => void;
};

function authenticateSession(hub: SessionHub, host: SessionEventHost): void {
  // Validate display name (open) or ranked join token before the session is
  // fully accepted so a taken name never occupies a player slot.
  // Same-user reclaim / session replace reuses an existing roster slot.
  hub.authenticate(async (auth) => {
    try {
      const result = await host.authenticateJoin(auth);
      if (!result.ok) return result;
      return { ok: true, data: sessionDataFromJoin(result) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[server] join auth error: ${message}`);
      return { ok: false, error: JoinErrors.AuthInvalid };
    }
  });
}

function onSpectatorConnect(
  session: ClientSession,
  host: SessionEventHost,
): void {
  console.log(
    `[server] spectator connected socket=${session.id}` +
      ` user=${
        typeof session.data.accountUserId === "string"
          ? session.data.accountUserId
          : "?"
      }`,
  );
  session.emit(
    NetEvents.Welcome,
    host.welcomePayloadSpectator(session.id),
  );
  session.on(NetEvents.Ready, () => {
    session.emit(
      NetEvents.Welcome,
      host.welcomePayloadSpectator(session.id),
    );
    session.emit(
      NetEvents.Snapshot,
      host.poses.stamp(
        host.poses.ensure(session.id),
        host.players.createSnapshot(host.tickCount(), "full"),
        "catchup",
      ),
    );
  });
  session.on(NetEvents.Leave, () => {
    session.data.intentionalLeave = true;
    session.disconnect();
  });
  session.on(NetEvents.Pong, (raw: unknown) => {
    // Spectators are not on the roster — ignore latency samples.
    void raw;
  });
  session.on(NetEvents.RequestPoseHeartbeat, () => {
    if (!host.loopReady()) return;
    const tick = host.tickCount();
    host.poses.sendRequestedHeartbeat(
      session,
      tick,
      () => host.players.createSnapshot(tick, "motion"),
    );
  });
  session.on(NetEvents.Disconnect, () => {
    host.inputRate.forget(session.id);
    host.poses.forget(session.id);
    console.log(`[server] spectator disconnected socket=${session.id}`);
  });
}

function announceSeated(
  hub: SessionHub,
  session: ClientSession,
  seated: SeatedPlayer,
  host: SessionEventHost,
): void {
  const { player, reclaimed, respawnedOnReclaim } = seated;
  const welcome = host.welcomePayload(player.id)!;
  session.emit(NetEvents.Welcome, welcome);

  if (reclaimed) {
    // Other clients already know this roster id; refresh connection-issue /
    // pose after reclaim or live session takeover (no second PlayerJoined).
    hub.emit(NetEvents.PlayerConnectionRestored, {
      id: player.id,
      player: player.toSnapshot(
        host.players.tick,
        "full",
        host.players.getCollision(),
      ),
    });
    if (respawnedOnReclaim) {
      hub.emit(NetEvents.PlayerRespawned, {
        player: player.toSnapshot(
          host.players.tick,
          "full",
          host.players.getCollision(),
        ),
      });
    }
  } else {
    for (const other of hub.sessions()) {
      if (other.id === session.id) continue;
      other.emit(
        NetEvents.PlayerJoined,
        player.toSnapshot(
          host.players.tick,
          "full",
          host.players.getCollision(),
        ),
      );
    }
  }
}

function onSessionDisconnect(
  hub: SessionHub,
  session: ClientSession,
  host: SessionEventHost,
  reason: unknown,
): void {
  host.inputRate.forget(session.id);
  host.poses.forget(session.id);
  // Already removed via Leave / kick / session replace.
  if (session.data.intentionalLeave) return;

  const player = host.players.getBySocket(session.id);
  if (!player) return;

  // Official Leave + immediate local close can lose the Leave packet.
  // A clean client disconnect() is still an intentional exit — do not
  // park the roster in connection-issue grace (status keeps counting).
  if (isClientInitiatedDisconnect(reason)) {
    host.dropPlayer(player.id);
    return;
  }

  if (host.players.markConnectionIssue(player.id, Date.now())) {
    hub.emit(NetEvents.PlayerConnectionIssue, {
      id: player.id,
      timeoutSeconds: Math.ceil(CONNECTION_ISSUE_TIMEOUT_MS / 1000),
    });
  }
}

function bindPlayerHandlers(
  hub: SessionHub,
  session: ClientSession,
  host: SessionEventHost,
): void {
  const playerIdFor = (): string | null => {
    return host.players.getBySocket(session.id)?.id ?? null;
  };

  session.on(NetEvents.Ready, () => {
    const id = playerIdFor();
    if (!id) return;
    const payload = host.welcomePayload(id);
    if (!payload) return;
    session.emit(NetEvents.Welcome, payload);
    // Full identity snapshot on catch-up (reconnect). High-rate stream is motion-only.
    session.emit(
      NetEvents.Snapshot,
      host.players.createSnapshot(host.tickCount(), "full"),
    );
  });

  // Epic 7.1: all live action intents go through `simIngress` — handlers
  // only resolve playerId and delegate (no direct queue / combat writes).
  session.on(NetEvents.Input, (raw: unknown) => {
    const id = playerIdFor();
    if (!id) return;
    // Drop flood above ~2× tick rate so a laggy client cannot stall the loop.
    ingressMovementInput(
      host.ingressSinks(),
      host.inputRate,
      session.id,
      id,
      raw,
      host.simNowMs(),
    );
  });

  session.on(NetEvents.Shoot, (raw: unknown) => {
    const id = playerIdFor();
    if (!id) return;
    // Epic 4.7: defer to Weapons phase (next tick flush). Association
    // tick = the tick whose weapons phase drains this queue.
    const player = host.players.getBySocket(session.id);
    if (player && raw && typeof raw === "object" && "clientTick" in raw) {
      const clientTick = (raw as { clientTick?: unknown }).clientTick;
      if (typeof clientTick === "number") {
        player.noteShotArrival(clientTick, host.tickCount());
      }
    }
    ingressShoot(host.ingressSinks(), id, raw);
  });

  session.on(NetEvents.Melee, (raw: unknown) => {
    const id = playerIdFor();
    if (!id) return;
    ingressMelee(host.ingressSinks(), id, raw);
  });

  session.on(NetEvents.Reload, () => {
    const id = playerIdFor();
    if (!id) return;
    ingressReload(host.ingressSinks(), id, host.tickCount());
  });

  session.on(NetEvents.WeaponSwitch, (raw: unknown) => {
    const id = playerIdFor();
    if (!id) return;
    ingressWeaponSwitch(
      host.ingressSinks(),
      id,
      raw,
      host.tickCount(),
    );
  });

  session.on(NetEvents.Ability, (raw: unknown) => {
    const id = playerIdFor();
    if (!id) return;
    // Do not share Input flood limiter — rare discrete event (like Reload).
    ingressAbility(host.ingressSinks(), id, raw, host.tickCount());
  });

  // PR-2: My Skills loadout → Ability 1–4 (owned + unique validated).
  // Config channel (not per-tick sim input); still routed via ingress.
  session.on(NetEvents.SkillLoadout, (raw: unknown) => {
    const id = playerIdFor();
    if (!id) return;
    ingressSkillLoadout(host.ingressSinks(), id, raw);
  });

  // Latency probe reply — stamp was sent on NetEvents.Ping.
  session.on(NetEvents.Pong, (raw: unknown) => {
    const t = raw && typeof raw === "object" && "t" in raw &&
        typeof (raw as PingPacket).t === "number"
      ? (raw as PingPacket).t
      : null;
    if (t == null || !Number.isFinite(t)) return;
    const rtt = Date.now() - t;
    // Ignore stale / clock-skewed samples (probe interval is ~1s).
    if (rtt < 0 || rtt > 15_000) return;
    const p = host.players.getBySocket(session.id);
    if (!p || p.isBot) return;
    p.observeRtt(rtt);
  });

  session.on(NetEvents.MapVote, (raw: unknown) => {
    const id = playerIdFor();
    if (!id) return;
    const mapName = raw && typeof raw === "object" && "mapName" in raw
      ? String((raw as { mapName: unknown }).mapName ?? "")
      : typeof raw === "string"
      ? raw
      : "";
    const state = host.mapVote.cast(
      id,
      mapName,
      host.players.isMatchOver(),
    );
    if (!state) return;
    hub.emit(NetEvents.MapVoteState, state);
  });

  // Admin console: authority-signed action token → execute on this server.
  session.on(NetEvents.AdminCommand, (raw: unknown) => {
    void handleAdminCommandPacket(raw, {
      authorityTokenPublicKeys: host.authorityTokenPublicKeys,
      rankedServerId: host.rankedServerId,
      accountUserId: () => session.data.accountUserId,
      playerId: () => playerIdFor(),
      reply: (packet) => {
        session.emit(NetEvents.AdminCommandResult, packet);
      },
      emitBotHeatmapTracking: (engaged) => {
        session.emit(NetEvents.BotHeatmapTracking, { engaged });
      },
      host: host.adminCommandHost(),
      verifyToken: verifyAdminActionToken,
      consumeJti: consumeAdminActionJti,
    });
  });

  // Raid start gate: this client finished building the map.
  session.on(NetEvents.MapLoaded, () => {
    const id = playerIdFor();
    if (!id || !host.raid() || host.raid()!.started) return;
    host.raidLoadedPlayerIds().add(id);
  });

  // Ranked pre-match ready vote (distinct from NetEvents.Ready re-sync).
  session.on(NetEvents.MatchReady, (raw: unknown) => {
    const id = playerIdFor();
    if (!id) return;
    let ready = true;
    if (raw && typeof raw === "object" && "ready" in raw) {
      ready = Boolean((raw as { ready: unknown }).ready);
    } else if (typeof raw === "boolean") {
      ready = raw;
    }
    host.handleMatchReady(id, ready);
  });

  // Open-match team switch (validated against balance / bot fill rules).
  session.on(NetEvents.ChangeTeam, (raw: unknown) => {
    const id = playerIdFor();
    if (!id) {
      session.emit(
        NetEvents.ChangeTeamResult,
        {
          ok: false,
          error: "Not in match.",
        } satisfies ChangeTeamResultPacket,
      );
      return;
    }
    const result = host.teamRebalance.handleChangeTeam(id, raw);
    session.emit(NetEvents.ChangeTeamResult, result);
  });

  // Open-match vote to rebalance teams (>1/3 humans → force-swap pipeline).
  session.on(NetEvents.TeamRebalanceVote, (raw: unknown) => {
    const id = playerIdFor();
    if (!id) {
      session.emit(
        NetEvents.TeamRebalanceVoteResult,
        {
          ok: false,
          error: "Not in match.",
        } satisfies TeamRebalanceVoteResultPacket,
      );
      return;
    }
    const result = host.teamRebalance.handleVote(id, raw);
    session.emit(NetEvents.TeamRebalanceVoteResult, result);
  });

  // Explicit leave skips the connection-issue grace period.
  session.on(NetEvents.Leave, () => {
    session.data.intentionalLeave = true;
    const id = playerIdFor();
    if (id) host.dropPlayer(id);
    session.disconnect();
  });

  // A4: client requests a reliable thin pose after snap silence.
  session.on(NetEvents.RequestPoseHeartbeat, () => {
    if (!host.loopReady()) return;
    const tick = host.tickCount();
    host.poses.sendRequestedHeartbeat(
      session,
      tick,
      () => host.players.createSnapshot(tick, "motion"),
    );
  });

  session.on(NetEvents.Disconnect, (reason) => {
    onSessionDisconnect(hub, session, host, reason);
  });
}

/** Wire auth and connect on the hub `start` just built. */
export function registerSessionEvents(
  hub: SessionHub,
  host: SessionEventHost,
): void {
  authenticateSession(hub, host);
  hub.onConnect((session) => {
    if (session.data.isSpectator) {
      onSpectatorConnect(session, host);
      return;
    }
    const seated = host.seatPlayer(session);
    if (!seated) return;
    announceSeated(hub, session, seated, host);
    bindPlayerHandlers(hub, session, host);
  });
}
