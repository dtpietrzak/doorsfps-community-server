/** Wire-only runtime → authority match-report contract. */

export type MatchOutcome = "scored" | "unranked" | "no_score" | "cancelled";
export type MatchPlayerResult =
  | "win"
  | "loss"
  | "draw"
  | "no_score"
  | "abandon"
  | "cancelled";

export type MatchReportPlayerRef = {
  clerkUserId?: string;
  username?: string;
  playerId?: number;
};

export type MatchReportPlayer = MatchReportPlayerRef & {
  team?: string | null;
  kills?: number;
  deaths?: number;
  score?: number;
  result?: MatchPlayerResult;
  mmrDelta?: number;
  xpEarned?: number;
  coinsEarned?: number;
  /** Active match time divided by total match duration, clamped to 0..1. */
  participation?: number;
  /**
   * Informational. Set when the runtime's join claim marked this player
   * synthetic. Authority persistence still decides by user id.
   */
  synthetic?: true;
  /**
   * Pool pawn. Authority credits the row only when the clerk id is a fake
   * seed and the report also has a non-pawn row.
   */
  pawn?: true;
};

export type MatchReportBody = {
  hostId?: string;
  runtimeId?: string;
  runtimeMatchId?: string;
  /**
   * Runtime id (equals runtimeId for official reports). Opaque host+slot after
   * cutover — do not parse mode from this field. Prefer {@link modeId}.
   */
  serverId: string;
  /**
   * Occupancy mode at report time. Authority may also resolve mode from the
   * authentic catalog; runtimes should send this when mode is not in serverId.
   */
  modeId?: string;
  /** Co-op raid catalog id when modeId is raid. */
  raidId?: string;
  mapName?: string | null;
  winningTeam?: string | null;
  scoreA?: number | null;
  scoreB?: number | null;
  startedAt?: string | null;
  endedAt?: string | null;
  outcome?: MatchOutcome;
  abandonedBy?: MatchReportPlayerRef | null;
  players: MatchReportPlayer[];
  raw?: unknown;
};
