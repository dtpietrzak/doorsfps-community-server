import { assertEquals } from "@std/assert";
import {
  AUTO_REBALANCE_DELAY_MS,
  NetEvents,
  type SnapshotPlayer,
  type TeamChangedPacket,
  type TeamId,
} from "../protocol/network.ts";
import type { MapCollision } from "../world/MapCollision.ts";
import {
  TeamRebalance,
  type TeamRebalancePlayer,
  type TeamRebalancePlayers,
  type TeamRebalanceSessions,
} from "./teamRebalance.ts";

type Sent = { event: string; payload: unknown; to?: string };

function player(id: string, team: TeamId = "A"): TeamRebalancePlayer {
  return {
    id,
    name: id,
    team,
    isBot: false,
    socketId: id,
    connectionIssue: false,
    isMatchPlayer: () => true,
    toSnapshot: () => ({ id }) as SnapshotPlayer,
  };
}

function groupOf(member: TeamRebalancePlayer) {
  return { memberIds: [member.id], size: 1, anchor: member };
}

/**
 * Three humans on A. Sides stay A→B until the test says otherwise.
 * `pick` and `force` default to moving p1.
 */
function openMatch(opts?: {
  humans?: string[];
  needs?: () => boolean;
  sides?: () => { heavy: TeamId; light: TeamId } | null;
  pick?: TeamRebalancePlayers["pickGroupForRebalance"];
  force?: TeamRebalancePlayers["forceChangeTeamGroup"];
}) {
  const ids = opts?.humans ?? ["p1", "p2", "p3"];
  const roster = new Map<string, TeamRebalancePlayer>();
  const sent: Sent[] = [];
  const peers = new Map<string, { emit(event: string, payload?: unknown): void }>();
  for (const id of ids) {
    roster.set(id, player(id));
    peers.set(id, {
      emit(event, payload) {
        sent.push({ event, payload, to: id });
      },
    });
  }
  const sessions: TeamRebalanceSessions = {
    emit(event, payload) {
      sent.push({ event, payload });
    },
    get(id) {
      return peers.get(id);
    },
  };
  let reconciles = 0;
  const players: TeamRebalancePlayers = {
    tick: 1,
    get: (id) => roster.get(id),
    isLive: () => true,
    humanCount: () => [...roster.values()].filter((p) => !p.isBot).length,
    needsHumanRebalance: () => opts?.needs?.() ?? true,
    humanRebalanceSides: () => opts?.sides?.() ?? { heavy: "A", light: "B" },
    pickGroupForRebalance: opts?.pick ??
      (() => groupOf(roster.get("p1")!)),
    changeTeam: () => {
      throw new Error("changeTeam is not used by these tests");
    },
    forceChangeTeamGroup: opts?.force ?? ((playerIds, to) => ({
      ok: true,
      moved: playerIds.map((id) => roster.get(id)!),
      from: "A" as TeamId,
      to,
    })),
    rebalanceBotTeams: () => [],
    getCollision: () => ({}) as MapCollision,
  };
  const rebalance = new TeamRebalance({
    players,
    sessions: () => sessions,
    isRanked: () => false,
    isRaid: () => false,
    reconcileBots: () => {
      reconciles += 1;
    },
    autofillBots: () => 0,
  });
  return {
    rebalance,
    roster,
    sent,
    reconciles: () => reconciles,
  };
}

function events(sent: Sent[], event: string): Sent[] {
  return sent.filter((row) => row.event === event);
}

Deno.test("vote threshold: 1 of 3 does not schedule, 2 of 3 sends the notice", () => {
  const { rebalance, sent } = openMatch();

  assertEquals(rebalance.handleVote("p1", { vote: true }), {
    ok: true,
    voted: true,
  });
  assertEquals(events(sent, NetEvents.AutoTeamRebalanceNotice), []);
  assertEquals(rebalance.hasPending, false);

  assertEquals(rebalance.handleVote("p2", { vote: true }).ok, true);
  const notices = events(sent, NetEvents.AutoTeamRebalanceNotice);
  assertEquals(notices.length, 1);
  assertEquals(notices[0]!.to, "p1");
  assertEquals(
    (notices[0]!.payload as { delayMs: number }).delayMs,
    AUTO_REBALANCE_DELAY_MS,
  );
  assertEquals(rebalance.hasPending, true);
  assertEquals(rebalance.voteCount, 2);
});

Deno.test("notice then swap after AUTO_REBALANCE_DELAY_MS", () => {
  let swapped = false;
  const { rebalance, sent, reconciles } = openMatch({
    needs: () => !swapped,
    force: (playerIds, to) => {
      swapped = true;
      return {
        ok: true,
        moved: playerIds.map((id) => player(id)),
        from: "A",
        to,
      };
    },
  });
  rebalance.handleVote("p1", { vote: true });
  rebalance.handleVote("p2", { vote: true });
  assertEquals(events(sent, NetEvents.TeamChanged), []);

  rebalance.tick(Date.now());
  assertEquals(events(sent, NetEvents.TeamChanged), []);
  assertEquals(swapped, false);

  rebalance.tick(Date.now() + AUTO_REBALANCE_DELAY_MS);
  const changed = events(sent, NetEvents.TeamChanged);
  assertEquals(changed.length, 1);
  const packet = changed[0]!.payload as TeamChangedPacket;
  assertEquals(packet.id, "p1");
  assertEquals(packet.team, "B");
  assertEquals(packet.reason, "auto_rebalance");
  assertEquals(reconciles(), 1);
  assertEquals(rebalance.hasPending, false);
  assertEquals(rebalance.voteCount, 0);
  const states = events(sent, NetEvents.TeamRebalanceVoteState);
  assertEquals(
    (states[states.length - 1]!.payload as { votes: number }).votes,
    0,
  );
});

Deno.test("a member leaving mid-notice drops the swap without a cancel packet", () => {
  const { rebalance, roster, sent } = openMatch({ humans: ["p1", "p2", "p3", "p4"] });
  rebalance.handleVote("p1", { vote: true });
  rebalance.handleVote("p2", { vote: true });
  assertEquals(events(sent, NetEvents.AutoTeamRebalanceNotice).length, 1);

  roster.delete("p1");
  assertEquals(rebalance.forgetSilently(["p1"]), true);
  assertEquals(rebalance.forgetSilently(["p1"]), false);
  assertEquals(rebalance.hasPending, false);
  // p2's ballot is still in, so the roster sync runs, same as dropPlayer.
  assertEquals(rebalance.voteCount > 0 || rebalance.hasPending, true);
  rebalance.syncAfterRosterChange();

  assertEquals(events(sent, NetEvents.AutoTeamRebalanceCancel), []);
  assertEquals(events(sent, NetEvents.AutoTeamRebalanceNotice).length, 1);
  rebalance.tick(Date.now() + AUTO_REBALANCE_DELAY_MS);
  assertEquals(events(sent, NetEvents.TeamChanged), []);
  assertEquals(rebalance.hasPending, false);
});

Deno.test("a chained rebalance schedules the next group after the first swap", () => {
  let swaps = 0;
  let picks = 0;
  const match = openMatch({
    needs: () => swaps < 2,
    pick: () => {
      picks += 1;
      const id = picks === 1 ? "p1" : "p2";
      return groupOf(match.roster.get(id)!);
    },
    force: (playerIds, to) => {
      swaps += 1;
      return {
        ok: true,
        moved: playerIds.map((id) => match.roster.get(id)!),
        from: "A",
        to,
      };
    },
  });
  match.rebalance.handleVote("p1", { vote: true });
  match.rebalance.handleVote("p2", { vote: true });
  assertEquals(events(match.sent, NetEvents.AutoTeamRebalanceNotice).length, 1);

  match.rebalance.tick(Date.now());
  assertEquals(swaps, 0);

  match.rebalance.tick(Date.now() + AUTO_REBALANCE_DELAY_MS);
  assertEquals(swaps, 1);
  assertEquals(events(match.sent, NetEvents.TeamChanged).length, 1);
  assertEquals(events(match.sent, NetEvents.AutoTeamRebalanceNotice).length, 2);
  assertEquals(
    events(match.sent, NetEvents.AutoTeamRebalanceNotice)[1]!.to,
    "p2",
  );
  assertEquals(match.rebalance.voteCount, 2);
  assertEquals(match.rebalance.hasPending, true);

  match.rebalance.tick(Date.now());
  assertEquals(swaps, 1);

  match.rebalance.tick(Date.now() + AUTO_REBALANCE_DELAY_MS);
  assertEquals(swaps, 2);
  const changed = events(match.sent, NetEvents.TeamChanged);
  assertEquals(changed.length, 2);
  assertEquals((changed[1]!.payload as TeamChangedPacket).id, "p2");
  assertEquals(match.reconciles(), 2);
  assertEquals(match.rebalance.hasPending, false);
  assertEquals(match.rebalance.voteCount, 0);
});
