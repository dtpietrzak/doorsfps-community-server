/**
 * Wire contracts for official-open placement requests and seat reservations.
 *
 * S6-PR1 owns persistence and pure allocation; later PRs issue assignment-
 * bearing admissions and expose the Drop In API.
 */

import {
  isOpenPartyModeId,
  type OpenPartyId,
  type OpenPartyModeId,
  type OpenPartyView,
} from "../social/openParty.ts";
import type { FindFleetFunding } from "./findFleetFunding.ts";

export const OPEN_PLACEMENT_REQUEST_STATES = [
  "queued",
  "provisioning",
  "reserved",
  "connecting",
  "completed",
  "failed",
  "cancelled",
  "expired",
] as const;
export type OpenPlacementRequestState =
  (typeof OPEN_PLACEMENT_REQUEST_STATES)[number];

/** Non-terminal states that still occupy the placement pipeline. */
export const OPEN_PLACEMENT_ACTIVE_REQUEST_STATES = [
  "queued",
  "provisioning",
  "reserved",
  "connecting",
] as const;
export type OpenPlacementActiveRequestState =
  (typeof OPEN_PLACEMENT_ACTIVE_REQUEST_STATES)[number];

export const OPEN_PLACEMENT_TERMINAL_REQUEST_STATES = [
  "completed",
  "failed",
  "cancelled",
  "expired",
] as const;
export type OpenPlacementTerminalRequestState =
  (typeof OPEN_PLACEMENT_TERMINAL_REQUEST_STATES)[number];

export const OPEN_SEAT_RESERVATION_STATES = [
  "active",
  "released",
  "expired",
  "completed",
] as const;
export type OpenSeatReservationState =
  (typeof OPEN_SEAT_RESERVATION_STATES)[number];

export const OPEN_PLACEMENT_KINDS = ["solo", "party"] as const;
export type OpenPlacementKind = (typeof OPEN_PLACEMENT_KINDS)[number];

/** Opaque identifiers; formats are authority-owned. */
export type OpenPlacementRequestId = string;
export type OpenSeatReservationId = string;
export type OpenPlacementIdempotencyKey = string;

/**
 * Immutable roster snapshot captured at final Drop In submission.
 * Solo requests use a single-member list.
 */
export type OpenPlacementRosterMember = {
  playerId: number;
};

export type OpenPlacementRequestView = {
  id: OpenPlacementRequestId;
  kind: OpenPlacementKind;
  modeId: OpenPartyModeId;
  seatCount: number;
  state: OpenPlacementRequestState;
  partyId: OpenPartyId | null;
  requesterPlayerId: number | null;
  assignedRuntimeId: string | null;
  reservationId: OpenSeatReservationId | null;
  failureReason: string | null;
  roster: OpenPlacementRosterMember[];
  createdAt: number;
  updatedAt: number;
};

export type OpenSeatReservationView = {
  id: OpenSeatReservationId;
  requestId: OpenPlacementRequestId;
  runtimeId: string;
  seatCount: number;
  state: OpenSeatReservationState;
  expiresAt: number;
  connectedCount: number;
  createdAt: number;
  updatedAt: number;
};

export function isOpenPlacementRequestState(
  value: unknown,
): value is OpenPlacementRequestState {
  return typeof value === "string" &&
    (OPEN_PLACEMENT_REQUEST_STATES as readonly string[]).includes(value);
}

export function isOpenPlacementActiveRequestState(
  value: unknown,
): value is OpenPlacementActiveRequestState {
  return typeof value === "string" &&
    (OPEN_PLACEMENT_ACTIVE_REQUEST_STATES as readonly string[]).includes(value);
}

export function isOpenPlacementTerminalRequestState(
  value: unknown,
): value is OpenPlacementTerminalRequestState {
  return typeof value === "string" &&
    (OPEN_PLACEMENT_TERMINAL_REQUEST_STATES as readonly string[]).includes(
      value,
    );
}

export function isOpenSeatReservationState(
  value: unknown,
): value is OpenSeatReservationState {
  return typeof value === "string" &&
    (OPEN_SEAT_RESERVATION_STATES as readonly string[]).includes(value);
}

export function isOpenPlacementKind(
  value: unknown,
): value is OpenPlacementKind {
  return typeof value === "string" &&
    (OPEN_PLACEMENT_KINDS as readonly string[]).includes(value);
}

export function isOpenPlacementModeId(
  value: unknown,
): value is OpenPartyModeId {
  return isOpenPartyModeId(value);
}

/**
 * Default post-assignment connection lease (technical, not a lobby timer).
 * Authority seat reservations and runtime party-team connect locks should stay
 * aligned with this window so late party members can still join the same team.
 */
export const DEFAULT_OPEN_SEAT_RESERVATION_LEASE_MS = 30_000;

/** Runtime → authority reservation progress (S6-PR2). */
export const OPEN_RESERVATION_ACK_STATUSES = [
  "member_connected",
  "completed",
  "released",
  "server_full",
] as const;
export type OpenReservationAckStatus =
  (typeof OPEN_RESERVATION_ACK_STATUSES)[number];

/**
 * Authenticated callback body from an official open runtime after admission
 * consume, reconnect reclaim, server-full mismatch, or successful connect batch.
 */
export type OpenReservationAckBody = {
  hostId: string;
  runtimeId: string;
  serverId: string;
  reservationId: OpenSeatReservationId;
  status: OpenReservationAckStatus;
  /** Absolute connected human count for this reservation (not a delta). */
  connectedCount?: number;
  /** Optional member admission jti for audit / reconnect correlation. */
  jti?: string;
};

export type OpenReservationAckResponse = {
  ok: boolean;
  reservation: OpenSeatReservationView | null;
  request: OpenPlacementRequestView | null;
  error?: string;
};

export function isOpenReservationAckStatus(
  value: unknown,
): value is OpenReservationAckStatus {
  return typeof value === "string" &&
    (OPEN_RESERVATION_ACK_STATUSES as readonly string[]).includes(value);
}

// ── S6-PR3: final Drop In API ───────────────────────────────────────────────

export const OPEN_PLACEMENT_OUTCOMES = ["assigned", "waiting"] as const;
export type OpenPlacementOutcome = (typeof OPEN_PLACEMENT_OUTCOMES)[number];

export const OPEN_PLACEMENT_ERROR_CODES = [
  "NOT_AUTHENTICATED",
  "NO_USERNAME",
  "NOT_LEADER",
  "NOT_MEMBER",
  "NOT_READY",
  "PENDING_INVITES",
  "STALE_ROSTER",
  "INVALID_MODE",
  "INVALID_STATE",
  "FEATURE_DISABLED",
  "NOT_FOUND",
  "MODE_LEVEL_LOCKED",
  "INVALID_INPUT",
  "NAME_REJECTED",
  "SERVER_UNAVAILABLE",
  "INTERNAL",
  /** Caller is not the placement requester / party leader for cancel. */
  "NOT_REQUESTER",
] as const;
export type OpenPlacementErrorCode =
  (typeof OPEN_PLACEMENT_ERROR_CODES)[number];

export type OpenPlacementErrorResponse = {
  error: string;
  code: OpenPlacementErrorCode;
};

/**
 * Final Drop In body. Solo uses a session (Clerk or reservation) only.
 * Party supplies partyId.
 */
export type OpenPlacementDropInBody = {
  modeId: OpenPartyModeId;
  /**
   * Client-generated key so retries of the same Let's Go click reuse one
   * placement request (and its reservation when already assigned).
   */
  idempotencyKey: string;
  /** Official-open party id. Leader creates/allocates; members claim admission. */
  partyId?: OpenPartyId;
  /**
   * Verified-admin raid testing bypass, per request only (never persisted).
   * The authority re-checks the admin role; non-admins are treated as normal.
   */
  unlockRaids?: boolean;
};

/** Concrete runtime assignment after a seat reservation is held. */
export type OpenPlacementAssignmentView = {
  reservationId: OpenSeatReservationId;
  /**
   * Opaque assigned runtime id (host+slot after cutover, e.g. `g00/0`).
   * Always pair with {@link modeId} for policy; never parse mode from the id.
   */
  runtimeId: string;
  /** Same as runtimeId for official authentic catalog rows. */
  serverId: string;
  /** Occupancy mode this assignment is for (placement request mode). */
  modeId: OpenPartyModeId;
  joinUrl: string;
  /** Wall-clock ms when the connection lease expires. */
  expiresAt: number;
};

/**
 * Caller's short-lived admission for the assigned runtime.
 * Account and reservation paths both use joinToken.
 */
export type OpenPlacementAdmissionView = {
  joinToken?: string;
  exp: number;
  /** Runtime connect name (account or reservation username). */
  name: string;
  jti?: string;
};

export type OpenPlacementDropInResponse = {
  request: OpenPlacementRequestView;
  outcome: OpenPlacementOutcome;
  assignment: OpenPlacementAssignmentView | null;
  /** Present only when outcome is assigned and the caller is on the roster. */
  admission: OpenPlacementAdmissionView | null;
  /**
   * Party snapshot after the Drop In transition (party path only).
   * Solo responses leave this null.
   */
  party: OpenPartyView | null;
};

export function isOpenPlacementOutcome(
  value: unknown,
): value is OpenPlacementOutcome {
  return typeof value === "string" &&
    (OPEN_PLACEMENT_OUTCOMES as readonly string[]).includes(value);
}

export function isOpenPlacementErrorCode(
  value: unknown,
): value is OpenPlacementErrorCode {
  return typeof value === "string" &&
    (OPEN_PLACEMENT_ERROR_CODES as readonly string[]).includes(value);
}

// ── S6-PR4: waiting-state status, cancel, and recovery ──────────────────────

/**
 * Client-facing wait phase while a placement request is not yet assigned.
 * Distinct from ranked's offer countdown — no user-facing assembly timer.
 */
export const OPEN_PLACEMENT_WAIT_PHASES = [
  /** Looking for a fit among healthy static runtimes (or still packing). */
  "finding",
  /** Capacity is being provisioned (Stories 7/8); stay in the same modal. */
  "provisioning",
] as const;
export type OpenPlacementWaitPhase =
  (typeof OPEN_PLACEMENT_WAIT_PHASES)[number];

export const OPEN_PLACEMENT_FINDING_MESSAGE = "Finding a server";
export const OPEN_PLACEMENT_RAID_QUEUE_MESSAGE =
  "This raid is in progress. Waiting for the next opening.";
export const OPEN_PLACEMENT_PROVISIONING_MESSAGE =
  "Server loading - please wait";

/** Map durable request state → user-facing wait copy. */
export function openPlacementWaitPhase(
  state: OpenPlacementRequestState,
): OpenPlacementWaitPhase | null {
  if (state === "queued") return "finding";
  if (state === "provisioning") return "provisioning";
  return null;
}

export function openPlacementWaitMessage(
  state: OpenPlacementRequestState,
  modeId?: OpenPartyModeId | null,
): string | null {
  const phase = openPlacementWaitPhase(state);
  if (phase === "finding") {
    return modeId === "raid"
      ? OPEN_PLACEMENT_RAID_QUEUE_MESSAGE
      : OPEN_PLACEMENT_FINDING_MESSAGE;
  }
  if (phase === "provisioning") return OPEN_PLACEMENT_PROVISIONING_MESSAGE;
  return null;
}

/**
 * Human-readable recovery messaging for terminal placement failures.
 * Recoverable party failures return the lobby to assembling (not cancelled).
 */
export function openPlacementFailureMessage(
  failureReason: string | null | undefined,
  state: OpenPlacementRequestState,
): string {
  if (state === "cancelled") {
    return "Placement cancelled.";
  }
  const reason = (failureReason ?? "").trim().toLowerCase();
  if (state === "expired" || reason === "reservation_expired") {
    return "Connection lease expired before everyone joined. Try Drop In again.";
  }
  if (reason === "server_full") {
    return "That server filled up. Try Drop In again.";
  }
  if (reason === "reservation_released") {
    return "The reserved seats were released. Try Drop In again.";
  }
  if (reason === "runtime_unavailable" || reason === "allocation_lost") {
    return "That server became unavailable. Try Drop In again.";
  }
  if (failureReason && failureReason.trim()) {
    return failureReason.trim();
  }
  if (state === "failed") {
    return "Could not reserve a server. Try Drop In again.";
  }
  return "Placement ended. Try Drop In again.";
}

/**
 * Status poll response. Same shape as Drop In so the client can reuse join
 * handling when a wait flips to assigned. `waitPhase` / `message` clarify
 * queued vs provisioning while still waiting.
 */
/** Why a waiting placement cannot start another EC2. Null when a start is allowed or not required. */
export type OpenPlacementCapacityBlock =
  | null
  | "donation_ceiling"
  | "hard_cap"
  | "physical_cap"
  | "host_launch_failed";

export type OpenPlacementStatusResponse = OpenPlacementDropInResponse & {
  waitPhase: OpenPlacementWaitPhase | null;
  /** User-facing status or recovery message. */
  message: string | null;
  /**
   * Present while the request is still waiting. `donation_ceiling`,
   * `hard_cap`, `physical_cap`, or `host_launch_failed` when another EC2 is
   * required and refused. Null when a process can start or another EC2 is
   * allowed.
   */
  blockedBy?: OpenPlacementCapacityBlock;
  /**
   * True when another EC2 is allowed, or a launch is already in flight.
   * The capacity controller performs the launch. This payload does not.
   */
  hostLaunchAllowed?: boolean;
  /** Host-slot operation id while that launch is still starting. */
  hostOperationId?: string;
  /** Ledger figures for the Find panel. Absent once the request is no longer waiting. */
  funding?: FindFleetFunding;
};

export type OpenPlacementCancelResponse = {
  request: OpenPlacementRequestView;
  /** Party snapshot after recoverable return to assembling (party path). */
  party: OpenPartyView | null;
  message: string;
};

export function isOpenPlacementWaitPhase(
  value: unknown,
): value is OpenPlacementWaitPhase {
  return typeof value === "string" &&
    (OPEN_PLACEMENT_WAIT_PHASES as readonly string[]).includes(value);
}
