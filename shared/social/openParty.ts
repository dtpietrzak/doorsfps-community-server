/** Wire contracts shared by the authority and client for official-open parties. */

export const OPEN_PARTY_FIND_MODE_IDS = ["easy", "medium", "hard"] as const;
export type OpenPartyFindModeId = (typeof OPEN_PARTY_FIND_MODE_IDS)[number];

export const OPEN_PARTY_MODE_IDS = [
  ...OPEN_PARTY_FIND_MODE_IDS,
  "raid",
] as const;
export type OpenPartyModeId = (typeof OPEN_PARTY_MODE_IDS)[number];

export const OPEN_PARTY_STATES = [
  "assembling",
  "allocating",
  "connecting",
  "completed",
  "cancelled",
] as const;
export type OpenPartyState = (typeof OPEN_PARTY_STATES)[number];

export const OPEN_PARTY_INVITATION_STATES = [
  "pending",
  "accepted",
  "declined",
  "revoked",
  "expired",
] as const;
export type OpenPartyInvitationState =
  (typeof OPEN_PARTY_INVITATION_STATES)[number];

/** Opaque identifiers on the wire. Their formats remain authority-owned. */
export type OpenPartyId = string;
export type OpenPartyInvitationId = string;

export type OpenPartyPlayerView = {
  playerId: number;
  /** Unique, normalized account username. */
  username: string;
  /** Server-resolved username intended for display. */
  usernameDisplay: string;
};

export type OpenPartyMemberView = OpenPartyPlayerView & {
  joinedAt: number;
  isLeader: boolean;
  /** Exact matching lobby readiness; ignored for raid leaders. */
  ready: boolean;
};

/** A pending invitation shown in an open-party lobby. */
export type OpenPartyPendingInvitationView = {
  id: OpenPartyInvitationId;
  partyId: OpenPartyId;
  modeId: OpenPartyModeId;
  status: "pending";
  inviter: OpenPartyPlayerView;
  invitee: OpenPartyPlayerView;
  createdAt: number;
};

export type OpenPartyInvitationView =
  & Omit<
    OpenPartyPendingInvitationView,
    "status"
  >
  & {
    status: OpenPartyInvitationState;
    updatedAt: number;
    actedAt: number | null;
  };

export type OpenPartyInviteResponse = {
  party: OpenPartyView;
  invitation: OpenPartyInvitationView;
  /** True when a retry reused the existing pending invitation. */
  deduplicated: boolean;
};

export type OpenPartyRevokeInviteResponse = {
  party: OpenPartyView;
  invitation: OpenPartyInvitationView;
};

export type OpenPartyInvitationNavigationPayload = {
  partyId: OpenPartyId;
  modeId: OpenPartyModeId;
};

/** Recipient action result. Terminal retries return the same invitation state. */
export type OpenPartyInvitationActionResponse = {
  invitation: OpenPartyInvitationView;
  /** Present only while an accepted recipient is still joined to the party. */
  party: OpenPartyView | null;
  /** A runtime is deliberately not selected at invitation time. */
  navigation: OpenPartyInvitationNavigationPayload | null;
};

export type OpenPartyRaidVoteView = {
  playerId: number;
  raidId: string | null;
  team: "A" | "B" | null;
};

/** Live raid lobby vote. Present only when modeId is raid. */
export type OpenPartyRaidBallotState = {
  availableRaidIds: string[];
  votes: OpenPartyRaidVoteView[];
  winningRaidId: string | null;
  winningTeam: "A" | "B" | null;
  /** True when every current member has a complete raid + team ballot. */
  allVoted: boolean;
  /** Server plurality counts (unavailable ballots already dropped). */
  raidCounts: Record<string, number>;
  teamCounts: Record<"A" | "B", number>;
};

/** Exclusive raid occupancy: first assembling party holds the slot. */
export type OpenPartyRaidOccupancyView = {
  /** This party currently holds the assemble/play lock. */
  holder: boolean;
  /** Another party holds the lock (or a live raid is in progress). */
  occupied: boolean;
  /** Wall-clock ms when the assemble lock expires; null while playing. */
  expiresAt: number | null;
};

export type OpenPartyView = {
  id: OpenPartyId;
  leaderPlayerId: number;
  modeId: OpenPartyModeId;
  state: OpenPartyState;
  members: OpenPartyMemberView[];
  pendingInvitations: OpenPartyPendingInvitationView[];
  /** Authority-configured capacity; clients must not substitute a literal. */
  maxSize: number;
  /** Present when modeId is raid. */
  raidId?: string | null;
  /** Human team for this raid session. */
  team?: "A" | "B" | null;
  /** Raid/team vote among current members. Absent for find-mode parties. */
  raidVote?: OpenPartyRaidBallotState | null;
  /** Present for raid parties: who holds the exclusive occupancy lock. */
  raidOccupancy?: OpenPartyRaidOccupancyView | null;
  createdAt: number;
  updatedAt: number;
};

export type OpenPartySnapshotResponse = {
  party: OpenPartyView | null;
};

/** Exact modal context used by the ephemeral readiness service. */
export type OpenPartyPresenceContext = {
  partyId: OpenPartyId;
  modeId: OpenPartyModeId;
  modalInstanceId: string;
  /** Raid non-leaders must explicitly ready up; omitted keeps legacy presence behavior. */
  ready?: boolean;
};

/** Presence writes return a fresh party view so readiness changes immediately. */
export type OpenPartyPresenceResponse = {
  party: OpenPartyView | null;
  /** Null after explicitly clearing this exact modal instance. */
  presenceExpiresAt: number | null;
  /** Authority-derived refresh cadence; clients do not duplicate the grace. */
  heartbeatIntervalMs: number;
};

export const OPEN_PARTY_ERROR_CODES = [
  "NOT_AUTHENTICATED",
  "NO_USERNAME",
  "UNKNOWN_USERNAME",
  "SELF_INVITE",
  "ALREADY_MEMBER",
  "PLAYER_COMMITTED",
  "CONFLICT",
  "FULL_PARTY",
  "INVALID_MODE",
  "RAID_LOCKED",
  /** Caller lacks the admin role for a privileged testing bypass. */
  "ADMIN_REQUIRED",
  "NOT_LEADER",
  "NOT_RECIPIENT",
  "INVALID_STATE",
  "FEATURE_DISABLED",
  "NOT_FOUND",
  "INTERNAL",
] as const;
export type OpenPartyErrorCode = (typeof OPEN_PARTY_ERROR_CODES)[number];

export type OpenPartyErrorResponse = {
  error: string;
  code: OpenPartyErrorCode;
};

export function isOpenPartyFindModeId(
  value: unknown,
): value is OpenPartyFindModeId {
  return typeof value === "string" &&
    (OPEN_PARTY_FIND_MODE_IDS as readonly string[]).includes(value);
}

export function isOpenPartyModeId(value: unknown): value is OpenPartyModeId {
  return typeof value === "string" &&
    (OPEN_PARTY_MODE_IDS as readonly string[]).includes(value);
}

export function isOpenPartyState(value: unknown): value is OpenPartyState {
  return typeof value === "string" &&
    (OPEN_PARTY_STATES as readonly string[]).includes(value);
}
