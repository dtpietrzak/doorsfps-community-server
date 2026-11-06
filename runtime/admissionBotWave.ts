/**
 * Open-admission bot fill wave (S9-PR3). Owns the settle timer and the
 * pending parties. GameServer passes the roster, the bot manager, and the
 * player cap. It never imports GameServer.
 *
 * Recording stays on GameServer: it calls `noteReplayHumanPresence()` and
 * then `onHumanSeated`.
 */

import {
  type BotAdmissionReconcileReport,
  OPEN_ADMISSION_BOT_RECONCILE_MS,
} from "../bots/BotManager.ts";
import type { TeamId } from "../protocol/network.ts";

export type AdmissionFinishReason =
  | "party_complete"
  | "timer"
  | "leave"
  | "manual";

/** Roster reads the seat and party checks already use. */
export interface AdmissionBotWavePlayers {
  nonAgentCount(): number;
  listPartyMembers(
    partyId: string | null | undefined,
  ): { readonly length: number };
}

/** Bot-manager calls the wave already makes. */
export interface AdmissionBotWaveBots {
  onHumanJoined(maxPlayers: number): void;
  startAdmissionBatch(): void;
  noteAdmissionEvictions(n: number): void;
  isAdmissionBatchActive(): boolean;
  finishAdmissionBatch(maxPlayers: number): BotAdmissionReconcileReport;
  tryEvict(n: number, preferredTeam?: TeamId): number;
}

export type AdmissionBotWaveDeps = {
  players: AdmissionBotWavePlayers;
  bots: AdmissionBotWaveBots;
  maxPlayers: () => number;
};

export type AdmissionSeatOpts = {
  partyId?: string | null;
  partySize?: number | null;
  assignmentId?: string | null;
  /** Middleware + connect-path bot removals for this seat. */
  botsEvicted?: number;
};

export class AdmissionBotWave {
  /**
   * Coalesce timer for multi-seat open admissions (S9-PR3).
   * Fires a single fill/balance bot reconcile after the settle window so
   * near-simultaneous party connections do not thrash the bot roster.
   */
  admissionBotReconcileTimer: ReturnType<typeof setTimeout> | null = null;
  /** Party ids still expected to finish connecting during the open wave. */
  readonly admissionBotPendingParties = new Map<
    string,
    { partySize: number }
  >();

  constructor(private readonly deps: AdmissionBotWaveDeps) {}

  /**
   * True while a batch is open or the settle timer is still armed.
   * Leave uses this so it can finish the wave before bot refill.
   */
  isActive(): boolean {
    return this.deps.bots.isAdmissionBatchActive() ||
      this.admissionBotReconcileTimer != null;
  }

  /**
   * Human is on the roster. Solos snap fill immediately. A party or an
   * assignment opens a wave and defers reconcile until the party is seated
   * or the settle timer fires.
   */
  onHumanSeated(opts: AdmissionSeatOpts): void {
    if (!this.shouldBatchBotReconcile(opts)) {
      // Solo / non-batch: snap fill immediately (existing community/authentic).
      this.deps.bots.onHumanJoined(this.deps.maxPlayers());
      return;
    }

    // Open wave, apply join churn with reconcile deferred, then maybe settle.
    this.deps.bots.startAdmissionBatch();
    if (opts.botsEvicted && opts.botsEvicted > 0) {
      this.deps.bots.noteAdmissionEvictions(opts.botsEvicted);
    }
    const partyId = opts.partyId?.trim() || null;
    const partySize = typeof opts.partySize === "number"
      ? Math.floor(opts.partySize)
      : 0;
    if (partyId && partySize > 1) {
      this.admissionBotPendingParties.set(partyId, { partySize });
    }

    this.deps.bots.onHumanJoined(this.deps.maxPlayers());

    if (this.allTrackedAdmissionPartiesSeated()) {
      this.finish("party_complete");
      return;
    }

    // Coalesce near-simultaneous multi-party / remaining-member connects.
    if (this.admissionBotReconcileTimer != null) {
      clearTimeout(this.admissionBotReconcileTimer);
    }
    this.admissionBotReconcileTimer = setTimeout(() => {
      this.admissionBotReconcileTimer = null;
      this.finish("timer");
    }, OPEN_ADMISSION_BOT_RECONCILE_MS);
  }

  finish(reason: AdmissionFinishReason): void {
    if (this.admissionBotReconcileTimer != null) {
      clearTimeout(this.admissionBotReconcileTimer);
      this.admissionBotReconcileTimer = null;
    }
    this.admissionBotPendingParties.clear();
    if (!this.deps.bots.isAdmissionBatchActive()) return;
    const report = this.deps.bots.finishAdmissionBatch(this.deps.maxPlayers());
    this.logAdmissionBotReconcile(report, reason);
  }

  /**
   * Drop a pending admission wave without reconciling — no refill on shutdown.
   */
  cancel(): void {
    if (this.admissionBotReconcileTimer != null) {
      clearTimeout(this.admissionBotReconcileTimer);
      this.admissionBotReconcileTimer = null;
    }
    this.admissionBotPendingParties.clear();
  }

  /**
   * Free enough non-agent seats for `seats` humans by evicting ordinary bots.
   * Prefer `preferredTeam` (party join side). Grey agents never consume capacity.
   * Returns ok only when this connecting human can obtain a seat; `evicted` is
   * how many bots were removed during this call (admission-wave metrics).
   *
   * Callers pass the remaining reserved party size so a full bot lobby can
   * pre-evict for the whole group (S9-PR3) instead of one-by-one oscillation.
   */
  ensureHumanJoinSlots(
    seats: number,
    preferredTeam?: TeamId,
  ): { ok: boolean; evicted: number } {
    const want = Math.max(1, Math.floor(seats));
    const free = Math.max(
      0,
      this.deps.maxPlayers() - this.deps.players.nonAgentCount(),
    );
    if (free >= want) return { ok: true, evicted: 0 };
    const need = want - free;
    const evicted = this.deps.bots.tryEvict(need, preferredTeam);
    const freeAfter = free + evicted;
    // This connection only needs one seat; remaining party seats may still
    // free as later members arrive if not every bot could be removed.
    return { ok: freeAfter >= 1, evicted };
  }

  remainingPartySeats(opts: {
    partyId?: string | null;
    partySize?: number | null;
  }): number {
    const size = typeof opts.partySize === "number" && opts.partySize > 0
      ? Math.floor(opts.partySize)
      : 1;
    if (!opts.partyId || size <= 1) return 1;
    const seated = this.deps.players.listPartyMembers(opts.partyId).length;
    return Math.max(1, size - seated);
  }

  private shouldBatchBotReconcile(opts: {
    partyId?: string | null;
    partySize?: number | null;
    assignmentId?: string | null;
  }): boolean {
    if (opts.assignmentId) return true;
    const size = typeof opts.partySize === "number" ? opts.partySize : 0;
    return Boolean(opts.partyId) && size > 1;
  }

  private allTrackedAdmissionPartiesSeated(): boolean {
    if (this.admissionBotPendingParties.size === 0) return false;
    for (const [partyId, meta] of this.admissionBotPendingParties) {
      if (this.deps.players.listPartyMembers(partyId).length < meta.partySize) {
        return false;
      }
    }
    return true;
  }

  private logAdmissionBotReconcile(
    report: BotAdmissionReconcileReport,
    reason: string,
  ): void {
    console.log(
      `[server] open admission bot reconcile reason=${reason}` +
        ` humans=${report.humanCount}` +
        ` humanTeams=A${report.humanTeamCounts.A}/B${report.humanTeamCounts.B}` +
        ` teams=A${report.teamCounts.A}/B${report.teamCounts.B}` +
        ` fillBots=${report.fillBotCount}` +
        ` botsEvicted=${report.botsEvicted}` +
        ` balanceBot=${
          report.balanceBot ? `yes:${report.balanceBotTeam ?? "?"}` : "no"
        }`,
    );
  }
}
