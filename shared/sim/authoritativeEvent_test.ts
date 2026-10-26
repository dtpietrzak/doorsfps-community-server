import {
  assertEquals,
  assertNotEquals,
} from "jsr:@std/assert@1";
import {
  AUTHORITATIVE_EVENT_KINDS,
  AUTHORITATIVE_KIND_CATEGORY,
  emptyAuthoritativePose,
  emptyAuthoritativeRosterSnapshot,
  makeAgentAddEvent,
  makeBotAddEvent,
  makeCombatBurstEvent,
  makeGameOverEvent,
  makeHumanJoinEvent,
  makeLoadoutCommitEvent,
  makeMatchConfigEvent,
  makeMatchDrawEvent,
  makeMatchEndEvent,
  makeMatchInitEvent,
  makeMatchStartEvent,
  makePlayerDiedEvent,
  makePlayerRemoveEvent,
  makePlayerRespawnedEvent,
  makeReadyVoteEvent,
  makeScoreEvent,
  makeTeamAssignEvent,
  normalizeAuthoritativeEvent,
  normalizeAuthoritativePose,
  normalizeAuthoritativeTeamId,
  sortAuthoritativeEvents,
  type AuthoritativeEvent,
} from "./authoritativeEvent.ts";
import { defaultPlayerEquipment } from "./game.ts";

Deno.test("closed inventory: every kind has a category", () => {
  for (const kind of AUTHORITATIVE_EVENT_KINDS) {
    assertEquals(typeof AUTHORITATIVE_KIND_CATEGORY[kind], "string");
  }
});

Deno.test("normalize: rejects negative / non-finite appliedTick", () => {
  assertEquals(
    normalizeAuthoritativeEvent({
      kind: "playerRemove",
      appliedTick: -1,
      playerId: "p1",
    }),
    null,
  );
  assertEquals(
    normalizeAuthoritativeEvent({
      kind: "playerRemove",
      appliedTick: NaN,
      playerId: "p1",
    }),
    null,
  );
  assertEquals(
    normalizeAuthoritativeEvent(
      makePlayerRemoveEvent(0, "p1"),
    )?.appliedTick,
    0,
  );
});

Deno.test("normalize: rejects non-finite pose and bad team", () => {
  assertEquals(
    normalizeAuthoritativePose({ x: 1, y: 2, z: 3, yaw: NaN, pitch: 0 }),
    null,
  );
  assertEquals(normalizeAuthoritativeTeamId("C"), null);
  assertEquals(normalizeAuthoritativeTeamId("A"), "A");

  const bad = makeHumanJoinEvent({
    appliedTick: 1,
    player: emptyAuthoritativeRosterSnapshot({
      id: "h1",
      team: "A",
      pose: { x: 1, y: 2, z: 3, yaw: 0, pitch: Number.POSITIVE_INFINITY },
    }),
  });
  // Bypass typecheck by mutating after construct.
  (bad.player.pose as { pitch: number }).pitch = Number.POSITIVE_INFINITY;
  assertEquals(normalizeAuthoritativeEvent(bad), null);

  assertEquals(
    normalizeAuthoritativeEvent(
      makeHumanJoinEvent({
        appliedTick: 1,
        player: emptyAuthoritativeRosterSnapshot({
          id: "h1",
          team: "A",
          pose: emptyAuthoritativePose(),
        }),
      }),
    )?.kind,
    "humanJoin",
  );
});

Deno.test("normalize: loadout unknown skill ids → null slots", () => {
  const n = normalizeAuthoritativeEvent(
    makeLoadoutCommitEvent({
      appliedTick: 3,
      playerId: "h1",
      loadout: ["quick", "nope", "quick", "selfHeal"] as never,
    }),
  );
  assertEquals(n?.kind, "loadoutCommit");
  if (n?.kind === "loadoutCommit") {
    assertEquals(n.loadout?.[0], "quick");
    assertEquals(n.loadout?.[1], null);
    // Duplicate quick cleared.
    assertEquals(n.loadout?.[2], null);
    assertEquals(n.loadout?.[3], "selfHeal");
  }
});

Deno.test("normalize: matchConfig requires a patch field", () => {
  assertEquals(
    normalizeAuthoritativeEvent({ kind: "matchConfig", appliedTick: 1 }),
    null,
  );
  assertEquals(
    normalizeAuthoritativeEvent(
      makeMatchConfigEvent({
        appliedTick: 1,
        raidDoorPolicy: "open",
      }),
    )?.kind,
    "matchConfig",
  );
});

Deno.test("normalize: matchEnd winner must be A/B; draw is separate kind", () => {
  assertEquals(
    normalizeAuthoritativeEvent({
      kind: "matchEnd",
      appliedTick: 10,
      winner: "draw",
      scheduleRestart: false,
      restartSeconds: 0,
      restartAtTick: null,
      scores: { A: 1, B: 1 },
    }),
    null,
  );
  assertEquals(
    normalizeAuthoritativeEvent(
      makeMatchEndEvent({
        appliedTick: 10,
        winner: "A",
        scheduleRestart: true,
        restartSeconds: 30,
        restartAtTick: 10 + 30 * 60,
        scores: { A: 21, B: 19 },
      }),
    )?.kind,
    "matchEnd",
  );
  assertEquals(
    normalizeAuthoritativeEvent(
      makeMatchDrawEvent({
        appliedTick: 10,
        scheduleRestart: false,
        restartSeconds: 0,
        restartAtTick: null,
        scores: { A: 5, B: 5 },
      }),
    )?.kind,
    "matchDraw",
  );
});

Deno.test("snapshot-not-delta: join carries resulting roster state", () => {
  const pose = { x: 4, y: 1.6, z: -2, yaw: 1.2, pitch: 0 };
  const event = normalizeAuthoritativeEvent(
    makeBotAddEvent({
      appliedTick: 5,
      player: emptyAuthoritativeRosterSnapshot({
        id: "bot-1",
        name: "Bot",
        team: "B",
        isBot: true,
        pose,
        equipment: defaultPlayerEquipment(),
        skillLoadout: null,
      }),
    }),
  );
  assertEquals(event?.kind, "botAdd");
  if (event?.kind === "botAdd") {
    assertEquals(event.player.pose, pose);
    assertEquals(event.player.team, "B");
    assertEquals(event.player.isBot, true);
    // No live lookup needed — payload is self-contained.
    assertNotEquals(event.player.id, "");
  }
});

Deno.test("same-tick multi-event canonical order", () => {
  const tick = 42;
  const events: AuthoritativeEvent[] = [
    makeLoadoutCommitEvent({
      appliedTick: tick,
      playerId: "z",
      loadout: null,
    }),
    makeHumanJoinEvent({
      appliedTick: tick,
      player: emptyAuthoritativeRosterSnapshot({ id: "z", team: "A" }),
    }),
    makeHumanJoinEvent({
      appliedTick: tick,
      player: emptyAuthoritativeRosterSnapshot({ id: "a", team: "B" }),
    }),
    makeMatchConfigEvent({
      appliedTick: tick,
      debugForceDoorsOpen: true,
    }),
    makeTeamAssignEvent({
      appliedTick: tick,
      reason: "switch",
      playerId: "m",
      from: "A",
      to: "B",
      player: emptyAuthoritativeRosterSnapshot({ id: "m", team: "B" }),
    }),
    makeReadyVoteEvent({
      appliedTick: tick,
      playerId: "a",
      ready: true,
    }),
    makeMatchStartEvent({
      appliedTick: tick,
      phase: "live",
      matchSeed: 1,
      matchEndTick: tick + 100,
      doorCycleOriginTick: tick,
      scores: { A: 0, B: 0 },
      roster: [],
    }),
  ];

  const sorted = sortAuthoritativeEvents(events).map((e) => e.kind);
  assertEquals(sorted, [
    "matchConfig",
    "matchStart",
    "humanJoin", // a before z
    "humanJoin",
    "teamAssign",
    "loadoutCommit",
    "readyVote",
  ]);
  const joins = sortAuthoritativeEvents(events).filter((e) =>
    e.kind === "humanJoin"
  );
  assertEquals(
    joins.map((e) => e.kind === "humanJoin" ? e.player.id : ""),
    ["a", "z"],
  );
});

Deno.test("matchInit normalizes full snapshot payload", () => {
  const n = normalizeAuthoritativeEvent(
    makeMatchInitEvent({
      appliedTick: 0,
      map: { name: "yard", version: 2 },
      matchSeed: 99,
      matchDurationTicks: 54000,
      prematchEnabled: true,
      phase: "prematch",
      raidDoorPolicy: "off",
      debugForceDoorsOpen: false,
      scores: { A: 0, B: 0 },
      roster: [
        emptyAuthoritativeRosterSnapshot({ id: "h1", team: "A" }),
      ],
    }),
  );
  assertEquals(n?.kind, "matchInit");
  if (n?.kind === "matchInit") {
    assertEquals(n.map.name, "yard");
    assertEquals(n.roster.length, 1);
    assertEquals(n.matchSeed, 99);
  }
});

Deno.test("JSON round-trip preserves normalized events", () => {
  const event = normalizeAuthoritativeEvent(
    makeAgentAddEvent({
      appliedTick: 7,
      player: emptyAuthoritativeRosterSnapshot({
        id: "agent-1",
        isBot: true,
        isAgent: true,
        unlimitedAmmo: true,
        team: "A",
      }),
    }),
  );
  assertEquals(event?.kind, "agentAdd");
  const round = normalizeAuthoritativeEvent(
    JSON.parse(JSON.stringify(event)),
  );
  assertEquals(round, event);
});

Deno.test("7.3 simOutcome: normalize + sort after commits", () => {
  const tick = 4;
  const burst = normalizeAuthoritativeEvent(
    makeCombatBurstEvent({
      appliedTick: tick,
      outcomes: [{
        shot: {
          shooterId: "s1",
          origin: [0, 1, 0],
          direction: [0, 0, 1],
          weapon: 1,
          hitId: null,
          hitZone: null,
          hitPoint: null,
        },
      }],
    }),
  );
  const died = normalizeAuthoritativeEvent(
    makePlayerDiedEvent({
      appliedTick: tick,
      victimId: "v1",
      killerId: "s1",
      zone: "head",
      weapon: 1,
      killerName: "S",
      victimName: "V",
      killerTeam: "A",
      victimTeam: "B",
    }),
  );
  const score = normalizeAuthoritativeEvent(
    makeScoreEvent({
      appliedTick: tick,
      scorerId: "s1",
      team: "A",
      scores: { A: 1, B: 0 },
      playerPose: emptyAuthoritativePose(),
      playerAlive: true,
    }),
  );
  const go = normalizeAuthoritativeEvent(
    makeGameOverEvent({
      appliedTick: tick,
      winner: "A",
      scores: { A: 10, B: 0 },
      restartInSeconds: 8,
    }),
  );
  const respawn = normalizeAuthoritativeEvent(
    makePlayerRespawnedEvent({
      appliedTick: tick,
      player: emptyAuthoritativeRosterSnapshot({ id: "v1", team: "B" }),
    }),
  );
  assertEquals(
    [burst, died, score, go, respawn].map((e) => e?.kind),
    ["combatBurst", "playerDied", "score", "gameOver", "playerRespawned"],
  );

  const mixed: AuthoritativeEvent[] = [
    respawn!,
    makeReadyVoteEvent({ appliedTick: tick, playerId: "a", ready: true }),
    go!,
    score!,
    died!,
    burst!,
    makeMatchConfigEvent({ appliedTick: tick, raidDoorPolicy: "open" }),
  ];
  assertEquals(sortAuthoritativeEvents(mixed).map((e) => e.kind), [
    "matchConfig",
    "readyVote",
    "combatBurst",
    "playerDied",
    "score",
    "gameOver",
    "playerRespawned",
  ]);
});

Deno.test("combatBurst: shotgun pellets survive normalize (replay events)", () => {
  const shot = {
    shooterId: "s1",
    origin: [0, 1.7, 8] as [number, number, number],
    direction: [0, 0, -1] as [number, number, number],
    weapon: 2,
    hitId: "v1",
    hitZone: "head" as const,
    hitPoint: [0, 1.7, 0.3] as [number, number, number],
    pellets: [
      {
        direction: [0, 0, -1] as [number, number, number],
        hitId: "v1",
        hitZone: "head" as const,
        hitPoint: [0, 1.7, 0.3] as [number, number, number],
      },
      {
        direction: [0.05, 0, -0.99] as [number, number, number],
        hitId: null,
        hitZone: null,
        hitPoint: [0.2, 1.7, 3] as [number, number, number],
      },
    ],
  };
  const event = makeCombatBurstEvent({
    appliedTick: 9,
    outcomes: [{ shot }],
  });
  const round = normalizeAuthoritativeEvent(
    JSON.parse(JSON.stringify(event)),
  );
  assertEquals(round, event);

  // A malformed pellet rejects the whole event (fail closed).
  const bad = JSON.parse(JSON.stringify(event));
  bad.outcomes[0].shot.pellets[1].direction = [0, "x", 1];
  assertEquals(normalizeAuthoritativeEvent(bad), null);
});
