/**
 * Epic 14.2 — replay event markers.
 *
 * Run from server-community/:
 *   deno test -A replay/replay_event_markers_test.ts
 */

import { assertEquals, assertThrows } from "@std/assert";
import {
  type AuthoritativeEvent,
  emptyAuthoritativePose,
  emptyAuthoritativeRosterSnapshot,
  makeAgentAddEvent,
  makeAgentRemoveEvent,
  makeCombatBurstEvent,
  makeGameOverEvent,
  makeHumanJoinEvent,
  makeMatchEndEvent,
  makeMatchStartEvent,
  makePlayerDiedEvent,
  makePlayerRespawnedEvent,
  makeScoreEvent,
} from "../shared/sim/authoritativeEvent.ts";
import {
  tickToTimeMs,
  tickToTimeSec,
  timeMsToTick,
} from "./checkpointIndex.ts";
import {
  type ReplayEventMarker,
  replayEventMarkers,
  ReplayEventMarkersError,
  type ReplayEventMarkersInput,
} from "./replayEventMarkers.ts";
import type { ReplayIndexMarker } from "./replayIndex.ts";

const FIRST = 10;
const LAST = 50;

function marker(
  over:
    & Partial<ReplayIndexMarker>
    & Pick<ReplayIndexMarker, "tick" | "markerKind" | "eventKind">,
): ReplayIndexMarker {
  return {
    tick: over.tick,
    markerKind: over.markerKind,
    eventKind: over.eventKind,
    involvedPlayerIds: over.involvedPlayerIds ?? [],
  };
}

function died(
  tick: number,
  victimId: string,
  killerId: string,
): AuthoritativeEvent {
  return makePlayerDiedEvent({
    appliedTick: tick,
    victimId,
    killerId,
    zone: "body",
    weapon: 1,
    killerName: killerId,
    victimName: victimId,
    killerTeam: "A",
    victimTeam: "B",
  });
}

function roster(id: string, isAgent = false) {
  return emptyAuthoritativeRosterSnapshot({
    id,
    name: id,
    team: "A",
    isAgent,
  });
}

function present(
  markers: readonly ReplayIndexMarker[],
  events?: Record<number, AuthoritativeEvent[]>,
  span?: { firstTick: number; lastTick: number },
) {
  const input: ReplayEventMarkersInput = {
    firstTick: span?.firstTick ?? FIRST,
    lastTick: span?.lastTick ?? LAST,
    markers,
  };
  if (events) {
    return replayEventMarkers({
      ...input,
      eventsAt: (tick) => events[tick] ?? [],
    });
  }
  return replayEventMarkers(input);
}

Deno.test("14.2 kinds: kill, death, door, agent appearance, match event", () => {
  const pins = present(
    [
      marker({
        tick: 10,
        markerKind: "phaseChange",
        eventKind: "matchStart",
      }),
      marker({
        tick: 22,
        markerKind: "death",
        eventKind: "playerDied",
        involvedPlayerIds: ["killer-first", "victim-first"],
      }),
      marker({
        tick: 25,
        markerKind: "roster",
        eventKind: "playerRespawned",
        involvedPlayerIds: ["p2"],
      }),
      marker({
        tick: 28,
        markerKind: "doorCapture",
        eventKind: "score",
        involvedPlayerIds: ["not-the-scorer"],
      }),
      marker({
        tick: 32,
        markerKind: "agent",
        eventKind: "agentAdd",
        involvedPlayerIds: ["not-the-agent"],
      }),
      marker({
        tick: 35,
        markerKind: "agent",
        eventKind: "agentRemove",
        involvedPlayerIds: ["a1"],
      }),
      marker({
        tick: 45,
        markerKind: "phaseChange",
        eventKind: "matchEnd",
      }),
      marker({
        tick: 45,
        markerKind: "phaseChange",
        eventKind: "gameOver",
      }),
    ],
    {
      10: [
        makeMatchStartEvent({
          appliedTick: 10,
          phase: "live",
          matchSeed: 1,
          matchEndTick: 1000,
          doorCycleOriginTick: 0,
          scores: { A: 0, B: 0 },
          roster: [roster("p1")],
        }),
      ],
      22: [died(22, "p2", "p1")],
      25: [
        makePlayerRespawnedEvent({ appliedTick: 25, player: roster("p2") }),
      ],
      28: [
        makeScoreEvent({
          appliedTick: 28,
          scorerId: "p1",
          team: "A",
          scores: { A: 1, B: 0 },
          playerPose: emptyAuthoritativePose(),
          playerAlive: true,
        }),
        makeCombatBurstEvent({ appliedTick: 28, outcomes: [] }),
      ],
      32: [
        makeAgentAddEvent({
          appliedTick: 32,
          player: roster("a1", true),
        }),
      ],
      35: [makeAgentRemoveEvent(35, "a1")],
      45: [
        makeMatchEndEvent({
          appliedTick: 45,
          winner: "A",
          scheduleRestart: false,
          restartSeconds: 0,
          restartAtTick: null,
          scores: { A: 1, B: 0 },
        }),
        makeGameOverEvent({
          appliedTick: 45,
          winner: "A",
          scores: { A: 1, B: 0 },
          restartInSeconds: 0,
        }),
      ],
    },
  );

  assertEquals(pins.markers.map((pin) => pin.kind), [
    "matchEvent",
    "death",
    "kill",
    "doorCapture",
    "agentAppearance",
    "matchEvent",
    "matchEvent",
  ]);
  assertEquals(pins.kills.length, 1);
  assertEquals(pins.deaths.length, 1);
  assertEquals(pins.doorCaptures.length, 1);
  assertEquals(pins.agentAppearances.length, 1);
  assertEquals(pins.matchEvents.map((pin) => pin.eventKind), [
    "matchStart",
    "matchEnd",
    "gameOver",
  ]);

  const death = pins.deaths[0]!;
  assertEquals(death.victimId, "p2");
  assertEquals(death.killerId, "p1");
  assertEquals(death.victimName, "p2");
  assertEquals(death.killerName, "p1");
  assertEquals(death.playerIds, ["p2", "p1"]);
  const kill = pins.kills[0]!;
  assertEquals(kill.killerId, "p1");
  assertEquals(kill.victimId, "p2");
  assertEquals(kill.playerIds, ["p1"]);
  assertEquals(kill.tick, 22);
  assertEquals(pins.markers[1]!.kind, "death");
  assertEquals(pins.markers[2]!.kind, "kill");

  assertEquals(pins.doorCaptures[0]!.scorerId, "p1");
  assertEquals(pins.doorCaptures[0]!.team, "A");
  assertEquals(pins.doorCaptures[0]!.playerIds, ["p1"]);
  assertEquals(pins.agentAppearances[0]!.playerId, "a1");
  assertEquals(
    pins.markers.some((pin) => pin.eventKind === "playerRespawned"),
    false,
  );
  assertEquals(
    pins.markers.some((pin) => pin.eventKind === "agentRemove"),
    false,
  );
  assertEquals(
    pins.markers.some((pin) => pin.eventKind === "combatBurst"),
    false,
  );
});

Deno.test("14.2 death: same-tick trades stay independent; self-kill has no kill pin", () => {
  const pins = present(
    [
      marker({
        tick: 30,
        markerKind: "death",
        eventKind: "playerDied",
        involvedPlayerIds: ["p1", "p2"],
      }),
      marker({
        tick: 30,
        markerKind: "death",
        eventKind: "playerDied",
        involvedPlayerIds: ["p2", "p1"],
      }),
      marker({
        tick: 40,
        markerKind: "death",
        eventKind: "playerDied",
        involvedPlayerIds: ["p1"],
      }),
    ],
    {
      30: [died(30, "p2", "p1"), died(30, "p1", "p2")],
      40: [died(40, "p1", "p1")],
    },
  );

  assertEquals(pins.deaths.map((pin) => pin.victimId), ["p2", "p1", "p1"]);
  assertEquals(pins.deaths.map((pin) => pin.killerId), ["p1", "p2", "p1"]);
  assertEquals(pins.kills.map((pin) => [pin.killerId, pin.victimId]), [
    ["p1", "p2"],
    ["p2", "p1"],
  ]);
  assertEquals(pins.markers.map((pin) => pin.kind), [
    "death",
    "kill",
    "death",
    "kill",
    "death",
  ]);
});

Deno.test("14.2 death: without eventsAt, ids stay uninterpreted and kills are absent", () => {
  const ids = ["p1", "p2"];
  const pins = present([
    marker({
      tick: 22,
      markerKind: "death",
      eventKind: "playerDied",
      involvedPlayerIds: ids,
    }),
    marker({
      tick: 28,
      markerKind: "doorCapture",
      eventKind: "score",
      involvedPlayerIds: ["p1"],
    }),
    marker({
      tick: 29,
      markerKind: "doorCapture",
      eventKind: "score",
      involvedPlayerIds: ["p1", "p2"],
    }),
    marker({
      tick: 32,
      markerKind: "agent",
      eventKind: "agentAdd",
      involvedPlayerIds: ["a1"],
    }),
  ]);

  assertEquals(pins.kills, []);
  assertEquals(pins.deaths[0]!.victimId, null);
  assertEquals(pins.deaths[0]!.killerId, null);
  assertEquals(pins.deaths[0]!.playerIds, ["p1", "p2"]);
  assertEquals(pins.doorCaptures[0]!.scorerId, "p1");
  assertEquals(pins.doorCaptures[0]!.team, null);
  assertEquals(pins.doorCaptures[1]!.scorerId, null);
  assertEquals(pins.agentAppearances[0]!.playerId, "a1");
  ids.push("mutated");
  assertEquals(pins.deaths[0]!.playerIds, ["p1", "p2"]);
});

Deno.test("14.2 time: tick is canonical; progress matches the timeline denominator", () => {
  const pins = present(
    [
      marker({ tick: 10, markerKind: "phaseChange", eventKind: "matchStart" }),
      marker({
        tick: 30,
        markerKind: "death",
        eventKind: "playerDied",
        involvedPlayerIds: ["p2", "p1"],
      }),
      marker({ tick: 50, markerKind: "phaseChange", eventKind: "gameOver" }),
    ],
    {
      10: [
        makeMatchStartEvent({
          appliedTick: 10,
          phase: "live",
          matchSeed: 1,
          matchEndTick: 1000,
          doorCycleOriginTick: 0,
          scores: { A: 0, B: 0 },
          roster: [],
        }),
      ],
      30: [died(30, "p2", "p1")],
      50: [
        makeGameOverEvent({
          appliedTick: 50,
          winner: "draw",
          scores: { A: 0, B: 0 },
          restartInSeconds: 0,
        }),
      ],
    },
  );

  const start = pins.matchEvents[0]!;
  const mid = pins.deaths[0]!;
  const end = pins.matchEvents[1]!;
  assertEquals(start.timeMs, tickToTimeMs(10));
  assertEquals(start.timeSec, tickToTimeSec(10));
  assertEquals(start.elapsedMs, 0);
  assertEquals(start.progress, 0);
  assertEquals(timeMsToTick(start.timeMs), 10);
  assertEquals(mid.timeMs, tickToTimeMs(30));
  assertEquals(mid.elapsedMs, tickToTimeMs(20));
  assertEquals(mid.progress, 0.5);
  assertEquals(mid.elapsedSec, mid.elapsedMs / 1000);
  assertEquals(end.progress, 1);
  assertEquals(end.elapsedMs, tickToTimeMs(40));
  assertEquals(end.timeMs, tickToTimeMs(50));

  const only = present(
    [marker({ tick: 4, markerKind: "phaseChange", eventKind: "matchStart" })],
    {
      4: [
        makeMatchStartEvent({
          appliedTick: 4,
          phase: "live",
          matchSeed: 1,
          matchEndTick: 10,
          doorCycleOriginTick: 0,
          scores: { A: 0, B: 0 },
          roster: [],
        }),
      ],
    },
    { firstTick: 4, lastTick: 4 },
  );
  assertEquals(only.matchEvents[0]!.progress, 0);
  assertEquals(only.matchEvents[0]!.elapsedMs, 0);
});

Deno.test("14.2 empty: no markers is a valid empty presentation", () => {
  let calls = 0;
  const pins = replayEventMarkers({
    firstTick: FIRST,
    lastTick: LAST,
    markers: [],
    eventsAt: () => {
      calls++;
      return [died(22, "p2", "p1")];
    },
  });
  assertEquals(pins.markers, []);
  assertEquals(pins.kills, []);
  assertEquals(pins.deaths, []);
  assertEquals(pins.doorCaptures, []);
  assertEquals(pins.agentAppearances, []);
  assertEquals(pins.matchEvents, []);
  assertEquals(calls, 0);
  assertEquals(Object.isFrozen(pins.markers), true);
  assertThrows(() => {
    (pins.markers as ReplayEventMarker[]).push(pins.markers[0]!);
  });
});

Deno.test("14.2 stream: extra death on a marked tick is a mismatch", () => {
  const err = assertThrows(
    () =>
      present(
        [
          marker({
            tick: 28,
            markerKind: "doorCapture",
            eventKind: "score",
            involvedPlayerIds: ["p1"],
          }),
        ],
        {
          28: [
            died(28, "p2", "p1"),
            makeScoreEvent({
              appliedTick: 28,
              scorerId: "p1",
              team: "A",
              scores: { A: 1, B: 0 },
              playerPose: emptyAuthoritativePose(),
              playerAlive: true,
            }),
          ],
        },
      ),
    ReplayEventMarkersError,
  );
  assertEquals(err.code, "replay-markers-stream-mismatch");
});

Deno.test("14.2 stream: phase order must follow the events", () => {
  const err = assertThrows(
    () =>
      present(
        [
          marker({
            tick: 45,
            markerKind: "phaseChange",
            eventKind: "matchEnd",
          }),
          marker({
            tick: 45,
            markerKind: "phaseChange",
            eventKind: "gameOver",
          }),
        ],
        {
          45: [
            makeGameOverEvent({
              appliedTick: 45,
              winner: "A",
              scores: { A: 1, B: 0 },
              restartInSeconds: 0,
            }),
            makeMatchEndEvent({
              appliedTick: 45,
              winner: "A",
              scheduleRestart: false,
              restartSeconds: 0,
              restartAtTick: null,
              scores: { A: 1, B: 0 },
            }),
          ],
        },
      ),
    ReplayEventMarkersError,
  );
  assertEquals(err.code, "replay-markers-stream-mismatch");
});

Deno.test("14.2 stream: roster-only tick still notices a missing death row", () => {
  const err = assertThrows(
    () =>
      present(
        [
          marker({
            tick: 15,
            markerKind: "roster",
            eventKind: "humanJoin",
            involvedPlayerIds: ["p2"],
          }),
        ],
        {
          15: [
            makeHumanJoinEvent({ appliedTick: 15, player: roster("p2") }),
            died(15, "p2", "p1"),
          ],
        },
      ),
    ReplayEventMarkersError,
  );
  assertEquals(err.code, "replay-markers-stream-mismatch");
});

Deno.test("14.2 rejects bad span, order, range, and kind", () => {
  const badTick = assertThrows(
    () =>
      replayEventMarkers({
        firstTick: 1.5,
        lastTick: 2,
        markers: [],
      }),
    ReplayEventMarkersError,
  );
  assertEquals(badTick.code, "replay-markers-bad-tick");

  const badRange = assertThrows(
    () =>
      replayEventMarkers({
        firstTick: 8,
        lastTick: 3,
        markers: [],
      }),
    ReplayEventMarkersError,
  );
  assertEquals(badRange.code, "replay-markers-bad-range");

  const order = assertThrows(
    () =>
      present([
        marker({ tick: 20, markerKind: "phaseChange", eventKind: "matchEnd" }),
        marker({
          tick: 12,
          markerKind: "phaseChange",
          eventKind: "matchStart",
        }),
      ]),
    ReplayEventMarkersError,
  );
  assertEquals(order.code, "replay-markers-bad-order");

  const outside = assertThrows(
    () =>
      present([
        marker({ tick: 9, markerKind: "phaseChange", eventKind: "matchStart" }),
      ]),
    ReplayEventMarkersError,
  );
  assertEquals(outside.code, "replay-markers-out-of-range");

  const kind = assertThrows(
    () =>
      present([
        marker({
          tick: 12,
          markerKind: "highlight" as ReplayIndexMarker["markerKind"],
          eventKind: "combatBurst",
        }),
      ]),
    ReplayEventMarkersError,
  );
  assertEquals(kind.code, "replay-markers-unknown-kind");
});

Deno.test("14.2 exclusion: presentation module does not own sim, clock, or I/O", async () => {
  const src = await Deno.readTextFile(
    new URL("./replayEventMarkers.ts", import.meta.url),
  );
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assertEquals(
    /replaySimulationRunner|ReplayRecorder|replayClock/.test(code),
    false,
  );
  assertEquals(/\bDeno\./.test(code), false);
  assertEquals(/\bDate\.now\b|\bperformance\.now\b/.test(code), false);
  assertEquals(/from\s+["'].*\/net\//.test(code), false);
  assertEquals(/from\s+["'].*ReplayBlobStore/.test(code), false);
  assertEquals(/three|document\.|window\./.test(code), false);
});
