import { assertEquals } from "@std/assert";
import type { GameOverPacket } from "../protocol/network.ts";
import type { HeatmapIngestBody } from "../shared/world/heatmaps.ts";
import { NetEvents } from "../protocol/network.ts";
import {
  AuthorityReporter,
  type AuthorityReporterDeps,
  buildAbandonReport,
  buildMatchReport,
  buildProgressionPackets,
  type BuiltMatchReport,
  type MatchReportActor,
  type MatchReportBuildInput,
  type MatchReportBuildResult,
  type ProgressionHuman,
} from "./matchReports.ts";

function actor(overrides: Partial<MatchReportActor> = {}): MatchReportActor {
  return {
    id: "p1",
    accountUserId: "clerk-a",
    name: "Ada",
    team: "A",
    kills: 2,
    deaths: 1,
    score: 4,
    isBot: false,
    poolAccount: false,
    synthetic: false,
    afk: false,
    ...overrides,
  };
}

function reportInput(
  overrides: Partial<MatchReportBuildInput> = {},
): MatchReportBuildInput {
  return {
    ranked: true,
    authorityEnabled: true,
    voided: false,
    winner: "A",
    scores: { A: 10, B: 3 },
    actors: [],
    participation: {
      matchDurationMs: 1_000,
      liveStartedAtMs: Date.parse("2026-01-01T00:00:00.000Z"),
      byPlayerId: new Map([["p1", 250]]),
    },
    endedAtMs: Date.parse("2026-01-01T00:01:00.000Z"),
    raid: null,
    raidCredits: [],
    raidPrizeIneligible: new Set(),
    runtimeMatchId: "match-1",
    serverId: "ranked",
    modeId: "ranked",
    mapName: "Courtyard",
    ...overrides,
  };
}

function posted(result: MatchReportBuildResult): BuiltMatchReport {
  if ("skip" in result) throw new Error(`skipped ${result.skip}`);
  return result;
}

Deno.test("buildMatchReport: ranked win and loss, dedup key sorts clerk ids", () => {
  const result = posted(buildMatchReport(reportInput({
    actors: [
      actor({ id: "p2", accountUserId: "clerk-b", name: "Bea", team: "B" }),
      actor({ id: "p1", accountUserId: "clerk-a", name: "Ada", team: "A" }),
    ],
    participation: {
      matchDurationMs: 1_000,
      liveStartedAtMs: Date.parse("2026-01-01T00:00:00.000Z"),
      byPlayerId: new Map([["p1", 250], ["p2", 2_000]]),
    },
  })));

  assertEquals(result.body.outcome, "scored");
  assertEquals(result.body.winningTeam, "A");
  assertEquals(result.body.scoreA, 10);
  assertEquals(result.body.scoreB, 3);
  assertEquals(result.body.startedAt, "2026-01-01T00:00:00.000Z");
  assertEquals(result.body.endedAt, "2026-01-01T00:01:00.000Z");
  assertEquals(result.body.modeId, "ranked");
  assertEquals(result.body.raidId, undefined);
  assertEquals(
    result.reportPlayers.map((p) => [p.clerkUserId, p.result, p.participation]),
    [
      ["clerk-b", "loss", 1],
      ["clerk-a", "win", 0.25],
    ],
  );
  assertEquals(result.key, "scored|A|10|3|clerk-a|clerk-b");
});

Deno.test("buildMatchReport: open draw, pawns join only beside a human", () => {
  const pawn = actor({
    id: "bot-1",
    accountUserId: "clerk-pawn",
    name: "Pawn",
    team: "B",
    isBot: true,
    poolAccount: true,
    kills: 0,
    deaths: 0,
    score: 0,
  });
  const human = actor();
  const open = {
    ranked: false,
    modeId: "tdm",
    winner: "draw" as const,
    scores: { A: 1, B: 1 },
  };

  const withHuman = posted(buildMatchReport(reportInput({
    ...open,
    actors: [human, pawn],
  })));
  assertEquals(withHuman.body.outcome, "unranked");
  assertEquals(
    withHuman.reportPlayers.map((p) => [p.clerkUserId, p.result, p.pawn]),
    [
      ["clerk-a", "draw", undefined],
      ["clerk-pawn", "draw", true],
    ],
  );
  assertEquals(withHuman.reportPlayers[1]?.participation, 1);
  assertEquals(withHuman.key, "unranked|draw|1|1|clerk-a|clerk-pawn");

  const pawnOnly = buildMatchReport(reportInput({ ...open, actors: [pawn] }));
  assertEquals(pawnOnly, { skip: "no_accounts" });

  const rankedPawn = posted(buildMatchReport(reportInput({
    actors: [human, pawn],
  })));
  assertEquals(rankedPawn.reportPlayers.map((p) => p.clerkUserId), ["clerk-a"]);
});

Deno.test("buildMatchReport: raid win credits the side and withholds the AFK prize", () => {
  const result = posted(buildMatchReport(reportInput({
    winner: "A",
    modeId: "raid",
    raid: { humanTeam: "A", raidId: "maze" },
    actors: [
      actor({ id: "p1", accountUserId: "clerk-a", afk: false, team: "B" }),
      actor({
        id: "p2",
        accountUserId: "clerk-b",
        name: "Bea",
        afk: true,
        team: "A",
      }),
    ],
    raidCredits: [
      {
        clerkUserId: "clerk-a",
        username: "Ada",
        team: "A",
        kills: 9,
        deaths: 9,
        score: 9,
      },
      {
        clerkUserId: "clerk-left",
        username: "Left",
        team: "A",
        kills: 1,
        deaths: 0,
        score: 2,
      },
      {
        clerkUserId: "itest_loadlab_1",
        username: "Synth",
        team: "A",
        kills: 0,
        deaths: 0,
        score: 0,
      },
      {
        clerkUserId: "clerk-afk-kick",
        username: "Kicked",
        team: "A",
        kills: 0,
        deaths: 0,
        score: 0,
      },
    ],
    raidPrizeIneligible: new Set(["clerk-afk-kick"]),
  })));

  assertEquals(result.body.raidId, "maze");
  assertEquals(
    result.reportPlayers.map((p) => [p.clerkUserId, p.result, p.synthetic]),
    [
      ["clerk-a", "win", undefined],
      ["clerk-b", "loss", undefined],
      ["clerk-left", "win", undefined],
      ["itest_loadlab_1", "win", true],
    ],
  );
  const seated = result.reportPlayers[0];
  assertEquals(seated?.kills, 2);
  const left = result.reportPlayers.find((p) => p.clerkUserId === "clerk-left");
  assertEquals(left?.participation, 1);
  assertEquals(left?.kills, 1);
});

Deno.test("buildMatchReport: raid loss is a loss for the side, including credits", () => {
  const result = posted(buildMatchReport(reportInput({
    winner: "B",
    raid: { humanTeam: "A", raidId: "maze" },
    actors: [actor({ afk: false })],
    raidCredits: [{
      clerkUserId: "clerk-left",
      username: "Left",
      team: "A",
      kills: 0,
      deaths: 1,
      score: 0,
    }],
  })));
  assertEquals(result.reportPlayers.map((p) => p.result), ["loss", "loss"]);
});

Deno.test("buildMatchReport: guest-only, void, and authority-off skip", () => {
  assertEquals(
    buildMatchReport(reportInput({
      actors: [actor({ accountUserId: null, name: "Guest" })],
    })),
    { skip: "no_accounts" },
  );
  assertEquals(
    buildMatchReport(reportInput({
      ranked: false,
      actors: [actor({ accountUserId: null })],
    })),
    { skip: "no_accounts" },
  );
  assertEquals(
    buildMatchReport(reportInput({
      voided: true,
      authorityEnabled: false,
      actors: [actor()],
    })),
    { skip: "void" },
  );
  assertEquals(
    buildMatchReport(
      reportInput({ authorityEnabled: false, actors: [actor()] }),
    ),
    { skip: "authority_disabled" },
  );
});

Deno.test("buildMatchReport: synthetic seated human and omitted mode when unset", () => {
  const result = posted(buildMatchReport(reportInput({
    ranked: false,
    modeId: null,
    participation: {
      matchDurationMs: 0,
      liveStartedAtMs: null,
      byPlayerId: new Map(),
    },
    actors: [actor({ synthetic: true })],
  })));
  assertEquals(result.body.modeId, undefined);
  assertEquals(result.body.startedAt, null);
  assertEquals(result.reportPlayers[0]?.synthetic, true);
  assertEquals(result.reportPlayers[0]?.participation, 0);
});

Deno.test("buildAbandonReport: leaver abandons, everyone else is no_score", () => {
  const built = buildAbandonReport({
    leaver: { id: "p1", name: "Ada", accountUserId: "clerk-a" },
    humans: [
      {
        id: "p2",
        name: "Bea",
        team: "B",
        kills: 1,
        deaths: 0,
        score: 3,
        accountUserId: "clerk-b",
        synthetic: false,
      },
      {
        id: "p1",
        name: "Ada",
        team: "A",
        kills: 0,
        deaths: 1,
        score: 0,
        accountUserId: "clerk-a",
        synthetic: true,
      },
      {
        id: "p3",
        name: "Guest",
        team: "A",
        kills: 0,
        deaths: 0,
        score: 0,
        accountUserId: null,
        synthetic: false,
      },
    ],
    scores: { A: 4, B: 2 },
    runtimeMatchId: "match-1",
    serverId: "ranked",
    modeId: "ranked",
    mapName: "Courtyard",
    endedAt: "2026-01-01T00:02:00.000Z",
  });

  assertEquals(built.body.outcome, "no_score");
  assertEquals(built.body.winningTeam, undefined);
  assertEquals(built.body.abandonedBy, { clerkUserId: "clerk-a" });
  assertEquals(built.body.endedAt, "2026-01-01T00:02:00.000Z");
  assertEquals(built.body.scoreA, 4);
  assertEquals(
    built.reportPlayers.map((
      p,
    ) => [p.username, p.result, p.clerkUserId, p.synthetic]),
    [
      ["Bea", "no_score", "clerk-b", undefined],
      ["Ada", "abandon", "clerk-a", true],
      ["Guest", "no_score", undefined, undefined],
    ],
  );
  assertEquals(built.key, "no_score|clerk-a|Guest|clerk-a|clerk-b");
});

Deno.test("buildAbandonReport: guest leaver is named, not given a clerk id", () => {
  const built = buildAbandonReport({
    leaver: { id: "p1", name: "Guest", accountUserId: null },
    humans: [{
      id: "p1",
      name: "Guest",
      team: "A",
      kills: 0,
      deaths: 0,
      score: 0,
      accountUserId: null,
      synthetic: false,
    }],
    scores: { A: 0, B: 0 },
    runtimeMatchId: "match-1",
    serverId: "ranked",
    modeId: null,
    mapName: "Courtyard",
    endedAt: "2026-01-01T00:02:00.000Z",
  });
  assertEquals(built.body.abandonedBy, { username: "Guest" });
  assertEquals(built.body.modeId, undefined);
  assertEquals(built.key, "no_score|Guest|Guest");
});

function gameOver(
  players: { id: string; score: number }[],
): GameOverPacket {
  return {
    winner: "A",
    scores: { A: 1, B: 0 },
    restartInSeconds: 0,
    players: players.map((p) => ({
      id: p.id,
      name: p.id,
      team: "A" as const,
      score: p.score,
      kills: 0,
      deaths: 0,
      alive: true,
      xp: 0,
      mmsRankId: "scrap" as const,
      founderBadge: false,
    })),
  };
}

Deno.test("buildProgressionPackets: joins authority rows by clerk id", () => {
  const humans: ProgressionHuman[] = [
    { id: "live-a", accountUserId: "clerk-a", socketId: "sock-a" },
    { id: "live-b", accountUserId: "clerk-b", socketId: "sock-b" },
  ];
  const deliveries = buildProgressionPackets({
    reportPlayers: [
      { clerkUserId: "clerk-b", username: "Bea", score: 1 },
      { clerkUserId: "clerk-a", username: "Ada", score: 1 },
    ],
    gameOver: gameOver([{ id: "live-a", score: 7 }, {
      id: "live-b",
      score: 2,
    }]),
    res: {
      matchId: 42,
      players: [
        { clerkUserId: "clerk-a", skillBefore: 9, teamShare: 3, doorBonus: 7 },
        { clerkUserId: "clerk-b", skillBefore: 4, skillDelta: 11 },
      ],
    },
    humans,
  });

  assertEquals(deliveries.map((d) => d.socketId), ["sock-b", "sock-a"]);
  assertEquals(deliveries[0]?.packet.skillBefore, 4);
  assertEquals(deliveries[0]?.packet.skillDelta, 11);
  assertEquals(deliveries[0]?.packet.doors, 2);
  assertEquals(deliveries[1]?.packet.skillBefore, 9);
  assertEquals(deliveries[1]?.packet.doors, 7);
  assertEquals(deliveries[1]?.packet.doorBonus, 7);
  assertEquals(deliveries[1]?.packet.skillDelta, 10);
  assertEquals(deliveries[1]?.packet.matchId, 42);
});

Deno.test("buildProgressionPackets: skips a missing human, an empty socket, and unkeyed misses", () => {
  const deliveries = buildProgressionPackets({
    reportPlayers: [
      { clerkUserId: "clerk-gone", username: "Gone" },
      { clerkUserId: "clerk-a", username: "Ada", score: 3 },
      { username: "NoClerk" },
    ],
    gameOver: gameOver([{ id: "live-a", score: 3 }]),
    res: {
      players: [
        { clerkUserId: "clerk-a", skillBefore: 1 },
      ],
    },
    humans: [
      { id: "live-a", accountUserId: "clerk-a", socketId: null },
    ],
  });
  assertEquals(deliveries, []);

  const positional = buildProgressionPackets({
    reportPlayers: [{ clerkUserId: "clerk-a", username: "Ada", score: 5 }],
    gameOver: gameOver([]),
    res: { players: [{ skillBefore: 8, teamSize: 2 }] },
    humans: [{ id: "live-a", accountUserId: "clerk-a", socketId: "sock-a" }],
  });
  assertEquals(positional[0]?.packet.skillBefore, 8);
  assertEquals(positional[0]?.packet.doors, 5);
  assertEquals(positional[0]?.packet.shareOfPot, 0.5);
  assertEquals(
    buildProgressionPackets({
      reportPlayers: [{ clerkUserId: "clerk-a" }],
      gameOver: gameOver([]),
      res: { players: [] },
      humans: [],
    }),
    [],
  );
});

type Posted = {
  match: unknown[];
  heatmaps: HeatmapIngestBody[];
  acks: unknown[];
};

function reporter(overrides: Partial<AuthorityReporterDeps> & {
  enabled?: boolean;
  posted?: Posted;
} = {}): {
  reports: AuthorityReporter;
  posted: Posted;
  sessions: Map<string, { event: string; packet: unknown }[]>;
} {
  const posted: Posted = overrides.posted ??
    { match: [], heatmaps: [], acks: [] };
  const sessions = new Map<string, { event: string; packet: unknown }[]>();
  const enabled = overrides.enabled ?? true;
  const reports = new AuthorityReporter({
    authority: {
      enabled,
      reportMatch: (body) => {
        posted.match.push(body);
        return Promise.resolve({ ok: true, matchId: 7, players: [] });
      },
      reportHeatmaps: (body) => {
        posted.heatmaps.push(body);
        return Promise.resolve({ ok: true, inserted: 2 });
      },
      reportOpenReservationAck: (body) => {
        posted.acks.push(body);
        return Promise.resolve({ ok: true });
      },
    },
    sessions: () => ({
      size: 0,
      authenticate: () => {},
      onConnect: () => {},
      emit: () => {},
      get: (id) => ({
        id,
        kind: "websocket",
        auth: {},
        data: {},
        emit: (event, packet) => {
          const list = sessions.get(id) ?? [];
          list.push({ event, packet });
          sessions.set(id, list);
        },
        emitVolatile: () => "sent" as const,
        on: () => {},
        disconnect: () => {},
        isWritable: () => true,
        writeBufferLength: () => 0,
      }),
      sessions: () => [],
      close: () => Promise.resolve(),
    }),
    humans: () => [],
    heatmaps: {
      buildIngestPayload: () => ({
        serverId: "ranked",
        mapName: "Courtyard",
        sessions: [
          {
            actorKind: "human",
            actorKey: "b",
            actorName: "Bea",
            kills: 0,
            deaths: 0,
            doors: 0,
            cells: {},
          },
          {
            actorKind: "human",
            actorKey: "a",
            actorName: "Ada",
            kills: 0,
            deaths: 0,
            doors: 0,
            cells: {},
          },
        ],
      }),
    },
    mapName: () => "Courtyard",
    serverId: () => "ranked",
    runtimeMatchId: () => "match-1",
    heatmapBatchId: () => "batch-1",
    players: () => [],
    ...overrides,
  });
  return { reports, posted, sessions };
}

function scored(): BuiltMatchReport {
  return posted(buildMatchReport(reportInput({ actors: [actor()] })));
}

Deno.test("AuthorityReporter: match post is once per key, then progression on success", async () => {
  const humans: ProgressionHuman[] = [
    { id: "p1", accountUserId: "clerk-a", socketId: "sock-a" },
  ];
  const posted: Posted = { match: [], heatmaps: [], acks: [] };
  const { reports, sessions } = reporter({
    posted,
    humans: () => humans,
    authority: {
      enabled: true,
      reportMatch: (body) => {
        posted.match.push(body);
        return Promise.resolve({
          ok: true,
          matchId: 7,
          players: [{ clerkUserId: "clerk-a", skillBefore: 3, skillDelta: 1 }],
        });
      },
      reportHeatmaps: () => Promise.resolve({ ok: true }),
    },
  });
  const built = scored();
  const over = gameOver([{ id: "p1", score: 4 }]);
  reports.reportMatch(built, over);
  reports.reportMatch(built, over);
  await Promise.resolve();
  assertEquals(posted.match.length, 1);
  assertEquals(reports.lastReportedMatchKey, built.key);
  assertEquals(sessions.get("sock-a")?.[0]?.event, NetEvents.MatchProgression);
  assertEquals(
    (sessions.get("sock-a")?.[0]?.packet as { skillBefore: number })
      .skillBefore,
    3,
  );
});

Deno.test("AuthorityReporter: failed match report keeps the key and skips progression", async () => {
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    const postedMatch: unknown[] = [];
    const { reports, sessions } = reporter({
      authority: {
        enabled: true,
        reportMatch: (body) => {
          postedMatch.push(body);
          return Promise.resolve({ ok: false, error: "db down" });
        },
        reportHeatmaps: () => Promise.resolve({ ok: true }),
      },
      humans:
        () => [{ id: "p1", accountUserId: "clerk-a", socketId: "sock-a" }],
    });
    const built = scored();
    reports.reportMatch(built, gameOver([{ id: "p1", score: 1 }]));
    await Promise.resolve();
    assertEquals(postedMatch.length, 1);
    assertEquals(reports.lastReportedMatchKey, built.key);
    assertEquals(sessions.size, 0);
    assertEquals(warnings, ["[server] Match report failed: db down"]);
    reports.reportMatch(built, gameOver([{ id: "p1", score: 1 }]));
    await Promise.resolve();
    assertEquals(postedMatch.length, 1);
  } finally {
    console.warn = orig;
  }
});

Deno.test("AuthorityReporter: abandon dedups, and a disabled authority still stores the key", () => {
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    const { reports, posted } = reporter();
    const built = buildAbandonReport({
      leaver: { id: "p1", name: "Ada", accountUserId: "clerk-a" },
      humans: [{
        id: "p1",
        name: "Ada",
        team: "A",
        kills: 0,
        deaths: 0,
        score: 0,
        accountUserId: "clerk-a",
        synthetic: false,
      }],
      scores: { A: 0, B: 0 },
      runtimeMatchId: "match-1",
      serverId: "ranked",
      modeId: "ranked",
      mapName: "Courtyard",
      endedAt: "2026-01-01T00:02:00.000Z",
    });
    reports.reportAbandon(built);
    reports.reportAbandon(built);
    assertEquals(posted.match.length, 1);
    assertEquals(reports.lastReportedMatchKey, built.key);

    const off = reporter({ enabled: false });
    off.reports.reportAbandon(built);
    off.reports.reportAbandon(built);
    assertEquals(off.posted.match.length, 0);
    assertEquals(off.reports.lastReportedMatchKey, built.key);
    assertEquals(warnings, [
      "[server] Match voided but authority reports disabled — local void only",
    ]);
  } finally {
    console.warn = orig;
  }
});

Deno.test("AuthorityReporter: heatmap flush dedups and stamps the batch", () => {
  const { reports, posted } = reporter();
  reports.flushHeatmapsToAuthority();
  reports.flushHeatmapsToAuthority();
  assertEquals(posted.heatmaps.length, 1);
  assertEquals(posted.heatmaps[0]?.batchId, "batch-1");
  assertEquals(
    reports.lastHeatmapReportKey,
    "hm|Courtyard|2|a,b",
  );

  const off = reporter({ enabled: false });
  off.reports.flushHeatmapsToAuthority();
  assertEquals(off.posted.heatmaps.length, 0);
  assertEquals(off.reports.lastHeatmapReportKey, null);
});

Deno.test("AuthorityReporter: reservation ack posts, and skips when authority is off", async () => {
  const { reports, posted } = reporter();
  reports.reportOpenReservationAck({
    reservationId: "res-1",
    status: "member_connected",
    jti: "jti-1",
  });
  const hostId = Deno.env.get("DOORS_HOST_ID")?.trim() || "local";
  assertEquals(posted.acks, [{
    hostId,
    runtimeId: "ranked",
    serverId: "ranked",
    reservationId: "res-1",
    status: "member_connected",
    jti: "jti-1",
  }]);

  const off = reporter({ enabled: false });
  off.reports.reportOpenReservationAck({
    reservationId: "res-1",
    status: "server_full",
  });
  assertEquals(off.posted.acks.length, 0);

  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    const failing = reporter({
      authority: {
        enabled: true,
        reportMatch: () => Promise.resolve({ ok: true }),
        reportHeatmaps: () => Promise.resolve({ ok: true }),
        reportOpenReservationAck: () => Promise.reject(new Error("timeout")),
      },
    });
    failing.reports.reportOpenReservationAck({
      reservationId: "res-9",
      status: "released",
    });
    await Promise.resolve();
    await Promise.resolve();
    assertEquals(warnings, [
      "[server] open reservation ack failed reservation=res-9 status=released: timeout",
    ]);
  } finally {
    console.warn = orig;
  }
});
