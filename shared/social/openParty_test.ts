import { assertEquals } from "jsr:@std/assert@1";
import {
  isOpenPartyModeId,
  isOpenPartyState,
  type OpenPartySnapshotResponse,
} from "./openParty.ts";

Deno.test("open-party contract serializes authority maxSize", () => {
  const response: OpenPartySnapshotResponse = {
    party: {
      id: "op_123",
      leaderPlayerId: 10,
      modeId: "medium",
      state: "assembling",
      members: [{
        playerId: 10,
        username: "leader",
        usernameDisplay: "Leader",
        joinedAt: 1_000,
        isLeader: true,
        ready: true,
      }],
      pendingInvitations: [{
        id: "opi_456",
        partyId: "op_123",
        modeId: "medium",
        status: "pending",
        inviter: {
          playerId: 10,
          username: "leader",
          usernameDisplay: "Leader",
        },
        invitee: {
          playerId: 11,
          username: "friend",
          usernameDisplay: "Friend",
        },
        createdAt: 1_100,
      }],
      maxSize: 6,
      createdAt: 1_000,
      updatedAt: 1_100,
    },
  };

  const wire = JSON.parse(JSON.stringify(response));
  assertEquals(wire.party.maxSize, 6);
  assertEquals(wire.party.modeId, "medium");
  assertEquals(wire.party.pendingInvitations[0].status, "pending");
  assertEquals(wire.party.pendingInvitations[0].inviter.username, "leader");
});

Deno.test("open-party modes and lifecycle states reject unrelated values", () => {
  assertEquals(isOpenPartyModeId("easy"), true);
  assertEquals(isOpenPartyModeId("raid"), true);
  assertEquals(isOpenPartyModeId("ranked"), false);
  assertEquals(isOpenPartyState("connecting"), true);
  assertEquals(isOpenPartyState("queued"), false);
});
