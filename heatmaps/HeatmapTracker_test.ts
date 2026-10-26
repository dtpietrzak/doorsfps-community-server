import { assertEquals } from "jsr:@std/assert@1";
import {
  HEATMAP_SAMPLE_EVERY_TICKS,
  heatmapCellKey,
} from "../shared/world/heatmaps.ts";
import {
  classifyLocomotion,
  HeatmapTracker,
  resolveActorKey,
} from "./HeatmapTracker.ts";
import type { Player } from "../players/Player.ts";

function fakePlayer(
  partial: Partial<Player> & { id: string; name: string },
): Player {
  const base = {
    isBot: false,
    isAgent: false,
    alive: true,
    accountUserId: null as string | null,
    x: 0,
    z: 0,
    crouch: false,
    onGround: true,
    kills: 0,
    deaths: 0,
    score: 0,
    isSliding: () => false,
    isMoveIntent: () => false,
    isSprintIntent: () => false,
    isJumpIntent: () => false,
    ...partial,
  };
  return base as unknown as Player;
}

Deno.test("heatmapCellKey quantizes world coords", () => {
  assertEquals(heatmapCellKey(0.1, 0.9, 1), "0,0");
  assertEquals(heatmapCellKey(1.2, -0.1, 1), "1,-1");
  assertEquals(heatmapCellKey(5.5, 5.5, 2), "2,2");
});

Deno.test("classifyLocomotion priority slide > crouch > sprint > walk", () => {
  const slide = fakePlayer({
    id: "1",
    name: "a",
    isSliding: () => true,
    crouch: true,
    isSprintIntent: () => true,
    isMoveIntent: () => true,
  });
  assertEquals(classifyLocomotion(slide), "slide");

  const crouch = fakePlayer({
    id: "1",
    name: "a",
    crouch: true,
    isMoveIntent: () => true,
  });
  assertEquals(classifyLocomotion(crouch), "crouch");

  const sprint = fakePlayer({
    id: "1",
    name: "a",
    isSprintIntent: () => true,
    isMoveIntent: () => true,
  });
  assertEquals(classifyLocomotion(sprint), "sprint");

  const walk = fakePlayer({
    id: "1",
    name: "a",
    isMoveIntent: () => true,
  });
  assertEquals(classifyLocomotion(walk), "walk");

  const idle = fakePlayer({ id: "1", name: "a" });
  assertEquals(classifyLocomotion(idle), null);
});

Deno.test("resolveActorKey prefers clerk then guest/bot", () => {
  assertEquals(
    resolveActorKey(
      fakePlayer({ id: "1", name: "Bob", accountUserId: "user_abc" }),
    ),
    "user_abc",
  );
  assertEquals(
    resolveActorKey(fakePlayer({ id: "1", name: "Bob" })),
    "guest:Bob",
  );
  assertEquals(
    resolveActorKey(fakePlayer({ id: "1", name: "bot3", isBot: true })),
    "bot:bot3",
  );
});

Deno.test("HeatmapTracker humans always, bots only when engaged", () => {
  const tracker = new HeatmapTracker({ tickHz: 60 });
  const human = fakePlayer({
    id: "h1",
    name: "Human",
    accountUserId: "user_h",
    x: 3.2,
    z: 4.8,
    isMoveIntent: () => true,
  });
  const bot = fakePlayer({
    id: "b1",
    name: "bot1",
    isBot: true,
    x: 1,
    z: 1,
    isMoveIntent: () => true,
  });

  for (let i = 0; i < HEATMAP_SAMPLE_EVERY_TICKS; i++) {
    tracker.tick([human, bot], "live", i + 1, true);
  }
  let stats = tracker.getRuntimeStats("live");
  assertEquals(stats.humanActorCount, 1);
  assertEquals(stats.botActorCount, 0);

  tracker.setBotTracking(true);
  for (let i = 0; i < HEATMAP_SAMPLE_EVERY_TICKS; i++) {
    tracker.tick([human, bot], "live", 100 + i, true);
  }
  stats = tracker.getRuntimeStats("live");
  assertEquals(stats.botActorCount, 1);
  assertEquals(stats.botTrackingEngaged, true);

  tracker.recordShoot(human, true);
  tracker.recordShoot(bot, true);

  const payload = tracker.buildIngestPayload(
    "Courtyard",
    "easy",
    undefined,
    [human, bot],
  );
  assertEquals(payload != null, true);
  assertEquals(payload!.sessions.length >= 1, true);
  assertEquals(payload!.mapName, "Courtyard");
  // Phased cells under open (doorsOpen true).
  const humanSession = payload!.sessions.find((s) => s.actorKind === "human");
  assertEquals(humanSession != null, true);
  assertEquals(humanSession!.cells.open != null, true);
  assertEquals(humanSession!.cells.closed == null, true);

  tracker.resetForNewMatch();
  stats = tracker.getRuntimeStats("live");
  assertEquals(stats.actorCount, 0);
  assertEquals(stats.botTrackingEngaged, true);

  tracker.setBotTracking(false);
  assertEquals(tracker.getRuntimeStats().botTrackingEngaged, false);
});

Deno.test("HeatmapTracker splits open vs closed door phases", () => {
  const tracker = new HeatmapTracker({ tickHz: 60 });
  const human = fakePlayer({
    id: "h1",
    name: "H",
    accountUserId: "user_h",
    x: 1,
    z: 2,
    isMoveIntent: () => true,
  });

  for (let i = 0; i < HEATMAP_SAMPLE_EVERY_TICKS; i++) {
    tracker.tick([human], "live", i + 1, true);
  }
  for (let i = 0; i < HEATMAP_SAMPLE_EVERY_TICKS; i++) {
    tracker.tick([human], "live", 100 + i, false);
  }

  const payload = tracker.buildIngestPayload("Cornfield", "easy", undefined, [
    human,
  ]);
  assertEquals(payload != null, true);
  const cells = payload!.sessions[0]!.cells;
  assertEquals(cells.open?.walk?.["1,2"] != null, true);
  assertEquals(cells.closed?.walk?.["1,2"] != null, true);
});

Deno.test("HeatmapTracker keeps departed player cells with actual match stats", () => {
  const tracker = new HeatmapTracker({ tickHz: 60 });
  const departed = fakePlayer({
    id: "h1",
    name: "Departed",
    accountUserId: "user_departed",
    kills: 1,
    x: 2,
    z: 5,
    isMoveIntent: () => true,
  });

  for (let i = 0; i < HEATMAP_SAMPLE_EVERY_TICKS; i++) {
    tracker.tick([departed], "live", i + 1, true);
  }

  departed.kills = 4;
  departed.deaths = 2;
  departed.score = 3;
  tracker.recordPlayerDeparture(departed);

  // The match-end roster no longer contains this player, so the payload uses
  // the final scoreboard values captured immediately before removal.
  const payload = tracker.buildIngestPayload(
    "Courtyard",
    "ranked",
    "match-1",
    [],
  );
  assertEquals(payload?.sessions, [{
    actorKind: "human",
    actorKey: "user_departed",
    actorName: "Departed",
    kills: 4,
    deaths: 2,
    doors: 3,
    cells: { open: { walk: { "2,5": 1 } } },
  }]);
});

Deno.test("HeatmapTracker skips non-live and agents", () => {
  const tracker = new HeatmapTracker({ tickHz: 60 });
  const agent = fakePlayer({
    id: "a1",
    name: "Agent",
    isBot: true,
    isAgent: true,
    isMoveIntent: () => true,
  });
  tracker.setBotTracking(true);
  for (let i = 0; i < HEATMAP_SAMPLE_EVERY_TICKS; i++) {
    tracker.tick([agent], "live", i + 1, true);
  }
  assertEquals(tracker.getRuntimeStats().actorCount, 0);

  const human = fakePlayer({
    id: "h1",
    name: "H",
    isMoveIntent: () => true,
  });
  for (let i = 0; i < HEATMAP_SAMPLE_EVERY_TICKS; i++) {
    tracker.tick([human], "prematch", i + 1, true);
  }
  assertEquals(tracker.getRuntimeStats().actorCount, 0);
});

function walk(id: string, name: string, accountUserId: string, synthetic = false) {
  return fakePlayer({
    id,
    name,
    accountUserId,
    synthetic,
    x: 1,
    z: 2,
    isMoveIntent: () => true,
  });
}

Deno.test("HeatmapTracker drops synthetic subjects and sim-only reports", () => {
  const tracker = new HeatmapTracker({ tickHz: 60 });
  const real = walk("h-real", "Real", "user_real");
  const sim = walk("h-sim", "LL_1", "itest_alpha_1", true);
  const bot = fakePlayer({
    id: "b1",
    name: "bot1",
    isBot: true,
    x: 4,
    z: 4,
    isMoveIntent: () => true,
  });
  tracker.setBotTracking(true);

  for (let i = 0; i < HEATMAP_SAMPLE_EVERY_TICKS; i++) {
    tracker.tick([real, sim, bot], "live", i + 1, true);
  }
  const mixed = tracker.buildIngestPayload("Courtyard", "easy", undefined, [
    real,
    sim,
    bot,
  ]);
  assertEquals(mixed != null, true);
  const keys = mixed!.sessions.map((s) => s.actorKey);
  assertEquals(keys.includes("user_real"), true);
  assertEquals(keys.includes("itest_alpha_1"), false);
  assertEquals(keys.includes("bot:bot1"), true);

  const onlySims = new HeatmapTracker({ tickHz: 60 });
  onlySims.setBotTracking(true);
  for (let i = 0; i < HEATMAP_SAMPLE_EVERY_TICKS; i++) {
    onlySims.tick([sim, bot], "live", i + 1, true);
  }
  assertEquals(
    onlySims.buildIngestPayload("Courtyard", "easy", undefined, [sim, bot]),
    null,
  );

  const departed = new HeatmapTracker({ tickHz: 60 });
  for (let i = 0; i < HEATMAP_SAMPLE_EVERY_TICKS; i++) {
    departed.tick([real, sim], "live", i + 1, true);
  }
  departed.recordPlayerDeparture(real);
  const afterLeave = departed.buildIngestPayload(
    "Courtyard",
    "easy",
    undefined,
    [sim],
  );
  assertEquals(afterLeave != null, true);
  assertEquals(
    afterLeave!.sessions.some((s) => s.actorKey === "user_real"),
    true,
  );
  assertEquals(
    afterLeave!.sessions.some((s) => s.actorKey === "itest_alpha_1"),
    false,
  );
});
