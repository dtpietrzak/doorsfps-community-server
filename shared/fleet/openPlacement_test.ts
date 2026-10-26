import { assertEquals } from "jsr:@std/assert@1";
import {
  isOpenPlacementActiveRequestState,
  isOpenPlacementErrorCode,
  isOpenPlacementKind,
  isOpenPlacementOutcome,
  isOpenPlacementRequestState,
  isOpenPlacementTerminalRequestState,
  isOpenReservationAckStatus,
  isOpenSeatReservationState,
  OPEN_PLACEMENT_FINDING_MESSAGE,
  OPEN_PLACEMENT_PROVISIONING_MESSAGE,
  OPEN_PLACEMENT_RAID_QUEUE_MESSAGE,
  openPlacementFailureMessage,
  openPlacementWaitMessage,
  openPlacementWaitPhase,
  type OpenPlacementRequestView,
} from "./openPlacement.ts";

Deno.test("open placement contract serializes request + reservation ids", () => {
  const request: OpenPlacementRequestView = {
    id: "opr_abc",
    kind: "party",
    modeId: "hard",
    seatCount: 3,
    state: "reserved",
    partyId: "op_xyz",
    requesterPlayerId: 10,
    assignedRuntimeId: "g00/1",
    reservationId: "osr_def",
    failureReason: null,
    roster: [
      { playerId: 10 },
      { playerId: 11 },
      { playerId: 12 },
    ],
    createdAt: 1_000,
    updatedAt: 1_100,
  };

  const wire = JSON.parse(JSON.stringify(request));
  assertEquals(wire.state, "reserved");
  assertEquals(wire.seatCount, 3);
  // assignedRuntimeId is opaque host+slot; mode lives on request.modeId.
  assertEquals(wire.assignedRuntimeId, "g00/1");
  assertEquals(wire.modeId, "hard");
  assertEquals(wire.roster.length, 3);
});

Deno.test("open placement state guards cover active and terminal sets", () => {
  assertEquals(isOpenPlacementRequestState("queued"), true);
  assertEquals(isOpenPlacementRequestState("bogus"), false);
  assertEquals(isOpenPlacementActiveRequestState("connecting"), true);
  assertEquals(isOpenPlacementActiveRequestState("completed"), false);
  assertEquals(isOpenPlacementTerminalRequestState("cancelled"), true);
  assertEquals(isOpenPlacementTerminalRequestState("queued"), false);
  assertEquals(isOpenSeatReservationState("active"), true);
  assertEquals(isOpenSeatReservationState("pending"), false);
  assertEquals(isOpenPlacementKind("solo"), true);
  assertEquals(isOpenPlacementKind("duo"), false);
  assertEquals(isOpenReservationAckStatus("member_connected"), true);
  assertEquals(isOpenReservationAckStatus("server_full"), true);
  assertEquals(isOpenReservationAckStatus("pending"), false);
  assertEquals(isOpenPlacementOutcome("assigned"), true);
  assertEquals(isOpenPlacementOutcome("waiting"), true);
  assertEquals(isOpenPlacementOutcome("failed"), false);
  assertEquals(isOpenPlacementErrorCode("NOT_LEADER"), true);
  assertEquals(isOpenPlacementErrorCode("NOT_READY"), true);
  assertEquals(isOpenPlacementErrorCode("NOT_REQUESTER"), true);
  assertEquals(isOpenPlacementErrorCode("BOGUS"), false);
});

Deno.test("open placement wait phase maps queued vs provisioning copy", () => {
  assertEquals(openPlacementWaitPhase("queued"), "finding");
  assertEquals(openPlacementWaitPhase("provisioning"), "provisioning");
  assertEquals(openPlacementWaitPhase("reserved"), null);
  assertEquals(
    openPlacementWaitMessage("queued"),
    OPEN_PLACEMENT_FINDING_MESSAGE,
  );
  assertEquals(
    openPlacementWaitMessage("queued", "raid"),
    OPEN_PLACEMENT_RAID_QUEUE_MESSAGE,
  );
  assertEquals(
    openPlacementWaitMessage("provisioning"),
    OPEN_PLACEMENT_PROVISIONING_MESSAGE,
  );
  assertEquals(
    openPlacementFailureMessage("reservation_expired", "expired"),
    "Connection lease expired before everyone joined. Try Drop In again.",
  );
  assertEquals(
    openPlacementFailureMessage(null, "cancelled"),
    "Placement cancelled.",
  );
});
