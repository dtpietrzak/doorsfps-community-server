/**
 * Epic 7.3 — unified authoritative event source.
 *
 * Run from server-community/:
 *   deno test -A players/authoritative_event_source_test.ts
 *
 * Locks: disposition table, cross-source order, tick attachment, GameOver
 * dedup, lossless drain, and live-path non-consumption (drain is read-only).
 */

import {
  assertEquals,
  assertNotEquals,
} from "jsr:@std/assert@1";
import type { DoorsMap } from "../world/map.ts";
import { MapCollision } from "../world/MapCollision.ts";
import { PlayerManager } from "./PlayerManager.ts";
import {
  AUTHORITATIVE_EVENT_KINDS,
  AUTHORITATIVE_KIND_CATEGORY,
  makeMatchDrawEvent,
  makeMatchEndEvent,
  normalizeAuthoritativeEvent,
  sortAuthoritativeEvents,
  type AuthoritativeEvent,
} from "../shared/sim/authoritativeEvent.ts";
import {
  drainTickAuthoritativeEvents,
  mapSimTickEventToAuthoritative,
  SIM_TICK_EVENT_DISPOSITION,
  type AuthoritativeEventBuffer,
} from "./authoritativeEventSource.ts";
import { SIM_TICK_EVENT_ORDER } from "./simTickPhases.ts";
import type { SimTickEvent } from "./simTickResult.ts";
import { rosterSnapshotFromPlayer } from "./authoritativeEventDerive.ts";

const map: DoorsMap = {
  name: "auth-event-source",
  version: 2,
  bounds: { minX: -40, maxX: 40, minZ: -40, maxZ: 40 },
  gridSize: 1,
  walls: [],
  teamA: {
    corners: [0, 1],
    edge: "south",
    doorHalfWidth: 2.5,
    spawnRadius: 3,
  },
  teamB: {
    corners: [2, 3],
    edge: "north",
    doorHalfWidth: 2.5,
    spawnRadius: 3,
  },
};

function makePm(
  options?: ConstructorParameters<typeof PlayerManager>[1],
): PlayerManager {
  return new PlayerManager(new MapCollision(map), {
    matchSeed: 42,
    nowMs: 1_000_000,
    ...options,
  });
}

function kinds(events: readonly AuthoritativeEvent[]): string[] {
  return events.map((e) => e.kind);
}

function makeBuffer(events: AuthoritativeEvent[]): AuthoritativeEventBuffer {
  let stored = events.slice();
  return {
    drainAuthoritativeEvents(): AuthoritativeEvent[] {
      const out = stored;
      stored = [];
      return out;
    },
    peekAuthoritativeEvents(): readonly AuthoritativeEvent[] {
      return stored;
    },
  };
}

const sampleShot = {
  shooterId: "s1",
  origin: [0, 1.6, 0] as [number, number, number],
  direction: [0, 0, 1] as [number, number, number],
  weapon: 1,
  hitId: "v1",
  hitZone: "body" as const,
  hitPoint: [0, 1.6, 5] as [number, number, number],
};

const sampleDeath = {
  victimId: "v1",
  killerId: "s1",
  zone: "body" as const,
  weapon: 1,
  killerName: "Shooter",
  victimName: "Victim",
  killerTeam: "A" as const,
  victimTeam: "B" as const,
};

const sampleScore = {
  scorerId: "s1",
  team: "A" as const,
  scores: { A: 1, B: 0 },
  player: {
    id: "s1",
    x: 1,
    y: 1.6,
    z: 2,
    yaw: 0.1,
    pitch: 0,
    health: 100,
    alive: true,
    team: "A" as const,
  },
};

const sampleGameOver = {
  winner: "A" as const,
  scores: { A: 10, B: 3 },
  players: [],
  restartInSeconds: 8,
};

Deno.test("7.3 disposition: every SimTickEvent kind has a row", () => {
  for (const type of SIM_TICK_EVENT_ORDER) {
    assertEquals(
      typeof SIM_TICK_EVENT_DISPOSITION[type],
      "string",
      `missing disposition for ${type}`,
    );
  }
  assertEquals(SIM_TICK_EVENT_DISPOSITION.CombatBurst, "record-as");
  assertEquals(SIM_TICK_EVENT_DISPOSITION.PlayerDied, "record-as");
  assertEquals(SIM_TICK_EVENT_DISPOSITION.Score, "record-as");
  assertEquals(SIM_TICK_EVENT_DISPOSITION.GameOver, "dedup-or-record");
  assertEquals(SIM_TICK_EVENT_DISPOSITION.PlayerRespawned, "record-as");
});

Deno.test("7.3 schema: sim-outcome kinds are in AUTHORITATIVE_EVENT_KINDS", () => {
  for (const kind of [
    "combatBurst",
    "playerDied",
    "score",
    "gameOver",
    "playerRespawned",
  ] as const) {
    assertEquals(
      (AUTHORITATIVE_EVENT_KINDS as readonly string[]).includes(kind),
      true,
    );
    assertEquals(AUTHORITATIVE_KIND_CATEGORY[kind], "simOutcome");
  }
});

Deno.test("7.3 map: all five sim kinds become AuthoritativeEvent", () => {
  const pm = makePm();
  const human = pm.add("sock", "Human", "A");
  pm.drainAuthoritativeEvents();

  const tick = 12;
  const mapped = [
    mapSimTickEventToAuthoritative(tick, {
      type: "CombatBurst",
      outcomes: [{ shot: sampleShot, damages: [{
        targetId: "v1",
        shooterId: "s1",
        damage: 25,
        health: 75,
        zone: "body",
        alive: true,
        killed: false,
        critical: false,
      }] }],
    }),
    mapSimTickEventToAuthoritative(tick, {
      type: "PlayerDied",
      death: sampleDeath,
    }),
    mapSimTickEventToAuthoritative(tick, {
      type: "Score",
      score: sampleScore,
    }),
    mapSimTickEventToAuthoritative(tick, {
      type: "GameOver",
      gameOver: sampleGameOver,
    }),
    mapSimTickEventToAuthoritative(tick, {
      type: "PlayerRespawned",
      player: human,
    }),
  ];

  assertEquals(kinds(mapped as AuthoritativeEvent[]), [
    "combatBurst",
    "playerDied",
    "score",
    "gameOver",
    "playerRespawned",
  ]);
  for (const ev of mapped) {
    assertNotEquals(ev, null);
    assertEquals(normalizeAuthoritativeEvent(ev!)?.appliedTick, tick);
  }
  const respawn = mapped[4];
  assertEquals(respawn?.kind, "playerRespawned");
  if (respawn?.kind === "playerRespawned") {
    assertEquals(respawn.player.id, human.id);
    assertEquals(respawn.player.pose.x, rosterSnapshotFromPlayer(human).pose.x);
  }
});

Deno.test("7.3 order: buffer sorted then sim in SIM_TICK_EVENT_ORDER", () => {
  const tick = 5;
  const bufferEvents: AuthoritativeEvent[] = [
    {
      kind: "readyVote",
      appliedTick: tick,
      playerId: "z-player",
      ready: true,
    },
    {
      kind: "humanJoin",
      appliedTick: tick,
      player: {
        id: "a-player",
        name: "A",
        team: "A",
        isBot: false,
        isAgent: false,
        isBalanceBot: false,
        alive: true,
        connectionIssue: false,
        unlimitedAmmo: false,
        maxHealth: 100,
        modelScale: 1,
        moveSpeedScale: 1,
        pose: { x: 0, y: 1.6, z: 0, yaw: 0, pitch: 0 },
        equipment: {
          head: 0,
          visor: 0,
          shoulder: 0,
          body: 0,
          leg: 0,
          hue: 0,
          gunHue: 0,
          bulletHue: 0,
          crosshairColor: -1,
          nameHue: 0,
          scope: 0,
          pistol: 0,
          rifle: 0,
          shotgun: 0,
          crosshair: 0,
        },
        skillLoadout: null,
        ownedAbilities: null,
      },
    },
    {
      kind: "matchConfig",
      appliedTick: tick,
      raidDoorPolicy: "open",
    },
  ];

  const simEvents: SimTickEvent[] = [
    { type: "CombatBurst", outcomes: [{ shot: sampleShot }] },
    { type: "PlayerDied", death: sampleDeath },
    { type: "Score", score: sampleScore },
    { type: "PlayerRespawned", player: makePm().add("r", "R", "A") },
  ];

  const unified = drainTickAuthoritativeEvents(
    makeBuffer(bufferEvents),
    tick,
    simEvents,
  );

  assertEquals(kinds(unified), [
    // buffer: lifecycleConfig → roster → commit (sorted)
    "matchConfig",
    "humanJoin",
    "readyVote",
    // sim: SIM_TICK_EVENT_ORDER construction order
    "combatBurst",
    "playerDied",
    "score",
    "playerRespawned",
  ]);

  // Buffer portion alone matches sortAuthoritativeEvents.
  assertEquals(
    kinds(unified.slice(0, 3)),
    kinds(sortAuthoritativeEvents(bufferEvents)),
  );
});

Deno.test("7.3 tick attachment: buffer keeps appliedTick; sim uses drain tick", () => {
  const bufferTick = 3;
  const drainTick = 9;
  const buffer = makeBuffer([
    makeMatchEndEvent({
      appliedTick: bufferTick,
      winner: "A",
      scheduleRestart: true,
      restartSeconds: 8,
      restartAtTick: bufferTick + 480,
      scores: { A: 10, B: 0 },
    }),
  ]);
  const unified = drainTickAuthoritativeEvents(buffer, drainTick, [
    { type: "PlayerDied", death: sampleDeath },
  ]);
  assertEquals(unified[0]?.kind, "matchEnd");
  assertEquals(unified[0]?.appliedTick, bufferTick);
  assertEquals(unified[1]?.kind, "playerDied");
  assertEquals(unified[1]?.appliedTick, drainTick);
});

Deno.test("7.3 dedup: GameOver omitted when matchEnd/matchDraw present", () => {
  const tick = 20;
  const withEnd = drainTickAuthoritativeEvents(
    makeBuffer([
      makeMatchEndEvent({
        appliedTick: tick,
        winner: "B",
        scheduleRestart: true,
        restartSeconds: 8,
        restartAtTick: tick + 480,
        scores: { A: 0, B: 10 },
      }),
    ]),
    tick,
    [{ type: "GameOver", gameOver: { ...sampleGameOver, winner: "B" } }],
  );
  assertEquals(kinds(withEnd), ["matchEnd"]);

  const withDraw = drainTickAuthoritativeEvents(
    makeBuffer([
      makeMatchDrawEvent({
        appliedTick: tick,
        scheduleRestart: true,
        restartSeconds: 8,
        restartAtTick: tick + 480,
        scores: { A: 5, B: 5 },
      }),
    ]),
    tick,
    [{ type: "GameOver", gameOver: { ...sampleGameOver, winner: "draw" } }],
  );
  assertEquals(kinds(withDraw), ["matchDraw"]);

  // Fallback: GameOver alone is recorded.
  const onlyGo = drainTickAuthoritativeEvents(makeBuffer([]), tick, [
    { type: "GameOver", gameOver: sampleGameOver },
  ]);
  assertEquals(kinds(onlyGo), ["gameOver"]);
});

Deno.test("7.3 lossless: drain clears buffer; empty tick returns []", () => {
  const pm = makePm();
  pm.add("h1", "H1", "A");
  pm.addBot("b1", "B1", { team: "B" });
  assertEquals(pm.peekAuthoritativeEvents().length > 0, true);

  const unified = drainTickAuthoritativeEvents(pm, 1, []);
  // Roster kinds sorted by ascending stable player id (not construction order).
  // Keys-only bots: the fill bot is a second humanJoin.
  assertEquals(kinds(unified), ["humanJoin", "humanJoin"]);
  assertEquals(unified.length, 2);
  assertEquals(pm.peekAuthoritativeEvents().length, 0);

  const empty = drainTickAuthoritativeEvents(pm, 2, []);
  assertEquals(empty, []);
});

Deno.test("7.3 storm: roster + config + lifecycle + sim facts drain 1:1", () => {
  const pm = makePm({ enablePrematch: true });
  pm.add("h1", "H1", "A");
  pm.add("h2", "H2", "B");
  pm.drainAuthoritativeEvents();

  const human = pm.get("h1")!;
  pm.addBot("b1", "B1", { team: "B" });
  pm.setRaidDoorPolicy("open");
  pm.changeTeam("h1", { autofillBots: 0, team: "B" });
  pm.handleSkillLoadout(human.id, ["quick", null, null, null]);
  pm.setMatchReady("h1", true);
  pm.beginLiveMatch(7, 1_000_000);
  // Force end → matchEnd in buffer (same tick as drain).
  pm.forceEndMatch(7, "A", { scheduleRestart: true, restartSeconds: 5 });

  const bufferPeek = pm.peekAuthoritativeEvents();
  const bufferCount = bufferPeek.length;
  assertEquals(bufferCount > 0, true);

  const simEvents: SimTickEvent[] = [
    { type: "CombatBurst", outcomes: [{ shot: sampleShot }] },
    { type: "CombatBurst", outcomes: [{ shot: { ...sampleShot, shooterId: "s2" } }] },
    { type: "PlayerDied", death: sampleDeath },
    { type: "Score", score: sampleScore },
    {
      type: "GameOver",
      gameOver: sampleGameOver,
    },
    { type: "PlayerRespawned", player: human },
  ];

  const unified = drainTickAuthoritativeEvents(pm, 7, simEvents);

  // Buffer portion: all drained events, sorted.
  const bufferKinds = kinds(sortAuthoritativeEvents(bufferPeek));
  const simKinds = [
    "combatBurst",
    "combatBurst",
    "playerDied",
    "score",
    // GameOver deduped against matchEnd from forceEndMatch
    "playerRespawned",
  ];
  assertEquals(kinds(unified), [...bufferKinds, ...simKinds]);
  assertEquals(pm.peekAuthoritativeEvents().length, 0);

  // No duplicate match-end fact.
  const endFacts = unified.filter(
    (e) =>
      e.kind === "matchEnd" || e.kind === "matchDraw" || e.kind === "gameOver",
  );
  assertEquals(endFacts.length, 1);
  assertEquals(endFacts[0]?.kind, "matchEnd");
});

Deno.test("7.3 live path: drain is read-only — emit order helpers unchanged", () => {
  // Source-scan: startGameLoop drains then (7.5) fans out then emitSimTickEvents.
  // Transport still emits from SimTickResult; sink consumes the drain result.
  const PACKAGE_ROOT = new URL("../", import.meta.url);
  const src = Deno.readTextFileSync(
    new URL("runtime/GameServer.ts", PACKAGE_ROOT),
  );
  assertEquals(
    src.includes("drainTickAuthoritativeEvents("),
    true,
  );
  assertEquals(src.includes("this.deliverReplayIntegrationTick(tick, authEvents)"), true);
  assertEquals(src.includes("this.emitSimTickEvents(tick, result.events)"), true);
  // Drain precedes sink fan-out precedes emit (tap point above broadcast).
  const drainIdx = src.indexOf("drainTickAuthoritativeEvents(");
  const sinkIdx = src.indexOf("this.deliverReplayIntegrationTick(tick, authEvents)");
  const emitIdx = src.indexOf("this.emitSimTickEvents(tick, result.events)");
  assertEquals(
    drainIdx >= 0 && sinkIdx > drainIdx && emitIdx > sinkIdx,
    true,
  );
});
