/**
 * Open-match team switch and rebalance votes. Owns the ballots and the
 * pending swap. GameServer passes the roster, a sessions getter (the hub is
 * assigned in start()), and the ranked / raid / bot-fill flags. It never
 * imports GameServer.
 */

import type { MapCollision } from "../world/MapCollision.ts";
import {
  AUTO_REBALANCE_DELAY_MS,
  AUTO_REBALANCE_NOTICE_MESSAGE,
  type AutoTeamRebalanceCancelPacket,
  type AutoTeamRebalanceNoticePacket,
  type ChangeTeamResultPacket,
  NetEvents,
  rebalanceVotePasses,
  rebalanceVotesNeeded,
  type SnapshotPlayer,
  type TeamChangedPacket,
  type TeamId,
  type TeamRebalanceVoteResultPacket,
  type TeamRebalanceVoteStatePacket,
} from "../protocol/network.ts";

/** Roster member the rebalance path reads. Player satisfies this. */
export interface TeamRebalancePlayer {
  id: string;
  name: string;
  team: TeamId;
  isBot: boolean;
  socketId: string | null;
  connectionIssue: boolean;
  isMatchPlayer(): boolean;
  toSnapshot(
    tick: number,
    mode: "full",
    collision: MapCollision,
  ): SnapshotPlayer;
}

/** Roster queries the moved rebalance methods already call. */
export interface TeamRebalancePlayers {
  readonly tick: number;
  get(id: string): TeamRebalancePlayer | undefined;
  isLive(): boolean;
  humanCount(): number;
  needsHumanRebalance(): boolean;
  humanRebalanceSides(): { heavy: TeamId; light: TeamId } | null;
  pickGroupForRebalance(
    heavy: TeamId,
    light: TeamId,
  ): {
    memberIds: string[];
    size: number;
    anchor: TeamRebalancePlayer;
  } | null;
  changeTeam(
    playerId: string,
    opts: { autofillBots: number; team?: TeamId },
  ):
    | {
      ok: true;
      player: TeamRebalancePlayer;
      from: TeamId;
      to: TeamId;
    }
    | { ok: false; error: string };
  forceChangeTeamGroup(
    playerIds: readonly string[],
    toTeam: TeamId,
  ):
    | {
      ok: true;
      moved: TeamRebalancePlayer[];
      from: TeamId;
      to: TeamId;
    }
    | { ok: false; error: string };
  rebalanceBotTeams(): TeamRebalancePlayer[];
  getCollision(): MapCollision;
}

/** Fan-out the notice, cancel, vote-state, and team-changed packets use. */
export interface TeamRebalanceSessions {
  emit(event: string, payload?: unknown): void;
  get(id: string): { emit(event: string, payload?: unknown): void } | undefined;
}

export type TeamRebalanceDeps = {
  players: TeamRebalancePlayers;
  /** Assigned in GameServer.start(); read on each send. */
  sessions: () => TeamRebalanceSessions | undefined;
  isRanked: () => boolean;
  isRaid: () => boolean;
  reconcileBots: () => void;
  autofillBots: () => number;
};

type PendingRebalance = {
  playerIds: string[];
  from: TeamId;
  to: TeamId;
  fireAtMs: number;
};

export class TeamRebalance {
  /**
   * Open-match player votes for team rebalance (human player ids).
   * Fires when votes are strictly more than 1/3 of connected humans and
   * match-player teams differ by ≥2. Ranked never uses this.
   */
  private readonly rebalanceVotes = new Set<string>();

  /**
   * Open-match pending human rebalance (indivisible group on heavy → light
   * after delay). Only scheduled after a passing rebalance vote; ranked never
   * schedules this. `playerIds` is the whole party cohort or a single solo or pool pawn.
   */
  private pendingRebalance: PendingRebalance | null = null;

  constructor(private readonly deps: TeamRebalanceDeps) {}

  /** Ballots still recorded. Join and drop read this before deciding to sync. */
  get voteCount(): number {
    return this.rebalanceVotes.size;
  }

  /** True while a notice is out and the swap has not fired or been dropped. */
  get hasPending(): boolean {
    return this.pendingRebalance != null;
  }

  /**
   * Open-match team switch. Ranked rejects. On success respawns the player on
   * the new side and re-runs bot fill so a new bot can rebalance when under cap.
   */
  handleChangeTeam(
    playerId: string,
    raw: unknown,
  ): ChangeTeamResultPacket {
    if (this.deps.isRanked() || this.deps.isRaid()) {
      return {
        ok: false,
        error: this.deps.isRaid()
          ? "Team switching is disabled in raids."
          : "Team switching is only available in open matches.",
      };
    }
    let team: TeamId | undefined;
    if (raw && typeof raw === "object" && "team" in raw) {
      const t = (raw as { team: unknown }).team;
      if (t === "A" || t === "B") team = t;
    }
    const result = this.deps.players.changeTeam(playerId, {
      autofillBots: this.deps.autofillBots(),
      team,
    });
    if (!result.ok) {
      return { ok: false, error: result.error };
    }

    // Manual switch may resolve or create human imbalance — drop pending if
    // this player was in the scheduled group, then re-evaluate.
    if (this.pendingRebalance?.playerIds.includes(playerId)) {
      this.cancel("manual_switch");
    }

    this.emitTeamChanged(result.player, result.to, "manual");
    // At fill cap a new bot cannot spawn — reassign bots heavy→light instead.
    for (const bot of this.deps.players.rebalanceBotTeams()) {
      this.emitTeamChanged(bot, bot.team);
    }
    // Under fill: may add a bot on the lighter side after the flip.
    this.deps.reconcileBots();
    // Manual switch may resolve imbalance — drop votes / pending if balanced.
    this.syncAfterRosterChange();
    return { ok: true, team: result.to };
  }

  /** Welcome payload tally, including whether this player has a ballot. */
  voteStateFor(
    playerId: string,
  ): TeamRebalanceVoteStatePacket & { youVoted: boolean } {
    return {
      ...this.voteState(),
      youVoted: this.rebalanceVotes.has(playerId),
    };
  }

  /**
   * Open-match only: cast or clear a rebalance vote. When more than 1/3 of
   * humans have voted and teams need rebalancing, starts the same force-swap
   * pipeline as the former auto rebalance.
   */
  handleVote(
    playerId: string,
    raw: unknown,
  ): TeamRebalanceVoteResultPacket {
    if (this.deps.isRanked()) {
      return {
        ok: false,
        error: "Team rebalance voting is only available in open matches.",
      };
    }
    if (!this.deps.players.isLive()) {
      return {
        ok: false,
        error: "Team rebalance is only available mid-match.",
      };
    }
    const player = this.deps.players.get(playerId);
    if (!player || player.isBot) {
      return { ok: false, error: "Not in match." };
    }
    if (player.connectionIssue) {
      return { ok: false, error: "Reconnect before voting." };
    }

    let wantVote = true;
    if (raw && typeof raw === "object" && "vote" in raw) {
      const v = (raw as { vote: unknown }).vote;
      if (typeof v === "boolean") wantVote = v;
    }

    this.pruneVotes();

    if (!wantVote) {
      this.rebalanceVotes.delete(playerId);
      this.broadcastVoteState();
      return { ok: true, voted: false };
    }

    if (!this.deps.players.needsHumanRebalance() && !this.pendingRebalance) {
      return {
        ok: false,
        error: "Teams don't need rebalancing right now.",
        voted: this.rebalanceVotes.has(playerId),
      };
    }

    this.rebalanceVotes.add(playerId);
    this.broadcastVoteState();
    this.maybeSchedule();
    return { ok: true, voted: true };
  }

  /**
   * After join/leave/manual team switch: prune votes, cancel pending if no
   * longer needed, and only continue rebalance if votes still pass.
   */
  syncAfterRosterChange(): void {
    if (this.deps.isRanked()) return;
    this.pruneVotes();
    if (
      !this.deps.players.isLive() || !this.deps.players.needsHumanRebalance()
    ) {
      this.cancel("balanced");
      this.clearVotes("balanced");
      return;
    }
    this.broadcastVoteState();
    // Join/leave can push the threshold above remaining votes.
    if (
      !rebalanceVotePasses(
        this.rebalanceVotes.size,
        this.deps.players.humanCount(),
      )
    ) {
      this.cancel("votes_dropped");
      return;
    }
    this.maybeSchedule();
  }

  /**
   * Drop a pending swap without a cancel packet when any id is in the group,
   * and drop those ids' ballots. Silent on purpose: dropPlayer, an admin bot
   * kick, and the connection-timeout loop must not emit cancel.
   * Returns whether any of those ids had a vote.
   */
  forgetSilently(ids: readonly string[]): boolean {
    if (
      this.pendingRebalance?.playerIds.some((id) => ids.includes(id))
    ) {
      // Group member left — cancel without packets (partial group invalid).
      this.pendingRebalance = null;
    }
    let hadVote = false;
    for (const id of ids) {
      if (this.rebalanceVotes.delete(id)) hadVote = true;
    }
    return hadVote;
  }

  /** Match ended. Cancel the notice, then drop the vote mandate. */
  onMatchOver(): void {
    this.cancel("match_over");
    this.clearVotes("match_over");
  }

  cancel(reason?: string): void {
    const pending = this.pendingRebalance;
    if (!pending) return;
    this.pendingRebalance = null;
    const sessions = this.deps.sessions();
    if (!sessions) return;
    const packet: AutoTeamRebalanceCancelPacket = reason ? { reason } : {};
    for (const id of pending.playerIds) {
      const player = this.deps.players.get(id);
      const socketId = player?.socketId;
      if (!socketId) continue;
      sessions.get(socketId)?.emit(NetEvents.AutoTeamRebalanceCancel, packet);
    }
  }

  clearVotes(reason?: string): void {
    if (this.rebalanceVotes.size === 0) return;
    this.rebalanceVotes.clear();
    if (reason) {
      console.log(`[server] rebalance votes cleared (${reason})`);
    }
    this.broadcastVoteState();
  }

  /**
   * Fire or cancel a pending open-match team rebalance. Call each tick,
   * after the AFK loop and before ScoresRules.
   */
  tick(nowMs = Date.now()): void {
    const pending = this.pendingRebalance;
    if (!pending) return;

    if (this.deps.isRanked() || !this.deps.players.isLive()) {
      this.cancel("not_live");
      this.clearVotes("not_live");
      return;
    }

    // Vote mandate dropped (e.g. enough unvotes / leavers) → cancel mid-notice.
    this.pruneVotes();
    if (
      !rebalanceVotePasses(
        this.rebalanceVotes.size,
        this.deps.players.humanCount(),
      )
    ) {
      this.cancel("votes_dropped");
      return;
    }

    const members = pending.playerIds.map((id) => this.deps.players.get(id));
    if (
      members.some((p) => !p || !p.isMatchPlayer() || p.connectionIssue)
    ) {
      this.cancel("victim_gone");
      // Imbalance may still need a different group.
      this.maybeSchedule();
      return;
    }

    // Still need rebalance with this whole group on heavy?
    const sides = this.deps.players.humanRebalanceSides();
    const allOnHeavy = members.every((p) => p!.team === sides?.heavy);
    if (!sides || !allOnHeavy) {
      this.cancel("balanced");
      if (!sides) {
        this.clearVotes("balanced");
        return;
      }
      // Different imbalance (e.g. other side heavy now) → reschedule.
      this.maybeSchedule();
      return;
    }

    if (nowMs < pending.fireAtMs) return;

    // Commit swap for the whole indivisible group.
    this.pendingRebalance = null;
    const result = this.deps.players.forceChangeTeamGroup(
      pending.playerIds,
      sides.light,
    );
    if (!result.ok) {
      this.maybeSchedule();
      return;
    }

    for (const player of result.moved) {
      this.emitTeamChanged(player, result.to, "auto_rebalance");
    }
    for (const bot of this.deps.players.rebalanceBotTeams()) {
      this.emitTeamChanged(bot, bot.team);
    }
    this.deps.reconcileBots();
    // Further imbalance (e.g. 6v2 → 5v3 still ≥2) → chain another notice.
    // Fully balanced → clear the vote mandate.
    if (!this.deps.players.needsHumanRebalance()) {
      this.clearVotes("rebalance_done");
      return;
    }
    this.maybeSchedule();
  }

  /** Live open-match rebalance vote tallies for clients. */
  private voteState(): TeamRebalanceVoteStatePacket {
    this.pruneVotes();
    const humans = this.deps.players.humanCount();
    return {
      votes: this.rebalanceVotes.size,
      needed: rebalanceVotesNeeded(humans),
      humans,
      neededByBalance: this.deps.players.needsHumanRebalance(),
    };
  }

  private broadcastVoteState(): void {
    const sessions = this.deps.sessions();
    if (!sessions || this.deps.isRanked()) return;
    sessions.emit(NetEvents.TeamRebalanceVoteState, this.voteState());
  }

  /** Drop votes from players who left or are no longer human. */
  private pruneVotes(): void {
    for (const id of [...this.rebalanceVotes]) {
      const p = this.deps.players.get(id);
      if (!p || p.isBot) this.rebalanceVotes.delete(id);
    }
  }

  /**
   * Open live matches only, after a passing rebalance vote: if match players
   * (humans + pool pawns) differ by ≥2, pick an indivisible group on the heavy
   * side (solo or pool pawn preferred, whole party only when that improves balance)
   * and schedule a force-swap after {@link AUTO_REBALANCE_DELAY_MS}.
   * Humans get a client notice; pool pawns swap silently after the delay.
   * Chains while imbalance remains and the vote mandate is still active.
   */
  private maybeSchedule(): void {
    const sessions = this.deps.sessions();
    if (this.deps.isRanked() || !sessions) return;
    if (!this.deps.players.isLive()) return;
    if (this.pendingRebalance) return;

    this.pruneVotes();
    const humans = this.deps.players.humanCount();
    if (!rebalanceVotePasses(this.rebalanceVotes.size, humans)) return;

    const sides = this.deps.players.humanRebalanceSides();
    if (!sides) {
      // Votes passed but already balanced — clear mandate.
      this.clearVotes("already_balanced");
      return;
    }

    const group = this.deps.players.pickGroupForRebalance(
      sides.heavy,
      sides.light,
    );
    if (!group) {
      // Imbalance exists but no legal whole-group move (e.g. only a party that
      // would not improve |diff|). Drop mandate rather than splitting.
      this.clearVotes("no_legal_group_move");
      return;
    }

    const fireAtMs = Date.now() + AUTO_REBALANCE_DELAY_MS;
    this.pendingRebalance = {
      playerIds: group.memberIds,
      from: sides.heavy,
      to: sides.light,
      fireAtMs,
    };

    const notice: AutoTeamRebalanceNoticePacket = {
      delayMs: AUTO_REBALANCE_DELAY_MS,
      from: sides.heavy,
      to: sides.light,
      message: AUTO_REBALANCE_NOTICE_MESSAGE,
    };
    let notified = 0;
    for (const id of group.memberIds) {
      const member = this.deps.players.get(id);
      if (member?.socketId) {
        sessions.get(member.socketId)?.emit(
          NetEvents.AutoTeamRebalanceNotice,
          notice,
        );
        notified++;
      }
    }
    if (notified === 0) {
      console.log(
        `[server] rebalance scheduled group size=${group.size}` +
          ` anchor=${group.anchor.name}` +
          ` ${sides.heavy}→${sides.light} in ${AUTO_REBALANCE_DELAY_MS}ms`,
      );
    }
  }

  private emitTeamChanged(
    player: TeamRebalancePlayer,
    team: TeamId,
    reason?: TeamChangedPacket["reason"],
  ): void {
    const sessions = this.deps.sessions();
    if (!sessions) return;
    const packet: TeamChangedPacket = {
      id: player.id,
      team,
      player: player.toSnapshot(
        this.deps.players.tick,
        "full",
        this.deps.players.getCollision(),
      ),
      ...(reason ? { reason } : {}),
    };
    sessions.emit(NetEvents.TeamChanged, packet);
  }
}
