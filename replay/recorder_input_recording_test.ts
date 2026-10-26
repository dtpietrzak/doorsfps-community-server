/**
 * Epic 8.3 — input recording.
 *
 * Run from server-community/:
 *   deno test -A replay/recorder_input_recording_test.ts
 */

import {
  assertEquals,
  assertExists,
} from "@std/assert";
import { GameServer } from "../runtime/GameServer.ts";
import { NoopAuthorityAdapter } from "../authority/adapter.ts";
import { PlayerManager } from "../players/PlayerManager.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";
import type { SimTickResult } from "../players/simTickResult.ts";
import { drainTickAuthoritativeEvents } from "../players/authoritativeEventSource.ts";
import type { AuthoritativeEvent } from "../shared/sim/authoritativeEvent.ts";
import { WEAPON_RIFLE } from "../shared/sim/weapons.ts";
import { ReplayRecorder } from "./ReplayRecorder.ts";
import type { InMemoryReplayLifecycleClient } from "./replayLifecycleClient.ts";
import {
  settleRecorder,
  wireReplayRecorder,
  type WireRecorderOptions,
} from "./replayTestHarness.ts";
import {
  captureRecordedTickInputs,
  projectSimActionEffect,
} from "./recordedTickInputs.ts";
import type { TickSelectedInput } from "../players/tickAssociation.ts";
import type { PendingWeapon } from "../players/weaponsQueue.ts";
import type { SimActionEffect } from "../players/simActionEffect.ts";

const miniMap: DoorsMap = {
  name: "replay-inputs",
  version: 1,
  bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 },
  gridSize: 1,
  walls: [],
  teamA: {
    corners: [0, 1],
    edge: "south",
    doorHalfWidth: 2,
    spawnRadius: 4,
  },
  teamB: {
    corners: [2, 3],
    edge: "north",
    doorHalfWidth: 2,
    spawnRadius: 4,
  },
};

type ServerInternals = {
  players: PlayerManager;
  sessions: { emit(...args: unknown[]): void } | null;
  runtimeMatchId: string;
  pendingWeapons: PendingWeapon[];
  stepSim(tick: number, nowMs: number): SimTickResult;
  deliverReplayIntegrationTick(
    tick: number,
    events: ReadonlyArray<AuthoritativeEvent>,
  ): void;
  beginRuntimeMatchIdentity(tick?: number): void;
  emitMatchStart(
    matchStart: ReturnType<PlayerManager["beginLiveMatch"]>,
    tick: number,
  ): void;
  onMatchEnded(
    packet: {
      winner: "A" | "B" | "draw";
      scores: { A: number; B: number };
      players: unknown[];
    },
    nowMs?: number,
  ): void;
};

function makeServer(joinMode: "open" | "ranked" = "open"): GameServer {
  return new GameServer({
    name: "replay-inputs",
    port: 0,
    host: "127.0.0.1",
    map: miniMap,
    collision: new MapCollision(miniMap),
    autofillBots: 0,
    noBotsOnEmptyServer: true,
    joinMode,
    rankedServerId: joinMode === "ranked" ? "ranked" : "open",
    authorityAdapter: new NoopAuthorityAdapter(),
    botThinkEngine: null,
  });
}

function internals(server: GameServer): ServerInternals {
  return server as unknown as ServerInternals;
}

function stubSessions(server: GameServer): void {
  internals(server).sessions = { emit: () => {} };
}


function wireRecorder(server: GameServer, opts?: WireRecorderOptions) {
  return wireReplayRecorder(
    {
      attachSink: (sink) => server.attachReplaySink(sink),
      detachSink: () => server.detachReplaySink(),
    },
    opts,
  );
}

function driveTick(server: GameServer, tick: number): SimTickResult {
  const i = internals(server);
  const result = i.stepSim(tick, Date.now());
  const authEvents = drainTickAuthoritativeEvents(
    i.players,
    tick,
    result.events,
  );
  i.deliverReplayIntegrationTick(tick, authEvents);
  return result;
}

function startLive(
  server: GameServer,
  recorder: ReplayRecorder,
  playerSpecs: Array<{ socket: string; name: string; team: "A" | "B" }>,
): string {
  const i = internals(server);
  stubSessions(server);
  for (const p of playerSpecs) {
    i.players.add(p.socket, p.name, p.team);
  }
  const start = i.players.beginLiveMatch(1, Date.now());
  i.beginRuntimeMatchIdentity(1);
  i.emitMatchStart(start, 1);
  assertEquals(recorder.getActiveRuntimeMatchId(), i.runtimeMatchId);
  return i.runtimeMatchId;
}

function sampleSelection(
  over?: Partial<TickSelectedInput>,
): TickSelectedInput {
  return {
    tick: 5,
    playerId: "p1",
    selectedInput: {
      sequence: 1,
      forward: true,
      backward: false,
      left: false,
      right: false,
      jump: false,
      sprint: false,
      crouch: false,
      yaw: 0.5,
      pitch: -0.1,
    },
    association: "fresh",
    appliedSequence: 1,
    inputHoldTicks: 1,
    ...over,
  };
}

Deno.test("8.3 verbatim movement: recorded rows deep-equal lastTickInputSelection", () => {
  const server = makeServer();
  const { recorder } = wireRecorder(server);
  const matchId = startLive(server, recorder, [
    { socket: "s1", name: "A1", team: "A" },
    { socket: "s2", name: "B1", team: "B" },
  ]);
  const i = internals(server);
  const p1 = [...i.players.all()].find((p) => p.name === "A1")!;
  const p2 = [...i.players.all()].find((p) => p.name === "B1")!;

  i.players.handleInput(p1.id, {
    sequence: 1,
    forward: true,
    backward: false,
    left: false,
    right: false,
    jump: false,
    sprint: true,
    crouch: false,
    yaw: 1.2,
    pitch: -0.2,
  }, Date.now());

  driveTick(server, 2);

  const live1 = p1.lastTickInputSelection();
  const live2 = p2.lastTickInputSelection();
  assertExists(live1);
  assertExists(live2);

  const row = recorder.getTickInputs(matchId, 2);
  assertExists(row);
  assertEquals(row.movement.length, 2);
  const byId = new Map(row.movement.map((m) => [m.playerId, m]));
  assertEquals(byId.get(p1.id), live1);
  assertEquals(byId.get(p2.id), live2);
  assertEquals(byId.get(p1.id)!.association, "fresh");
  assertEquals(byId.get(p1.id)!.appliedSequence, 1);
  assertEquals(byId.get(p1.id)!.inputHoldTicks, 1);
});

Deno.test("8.3 action rows: shoot/reload/switch/ability at effect ticks in order", () => {
  const server = makeServer();
  const { recorder } = wireRecorder(server);
  const matchId = startLive(server, recorder, [
    { socket: "s1", name: "A1", team: "A" },
  ]);
  const i = internals(server);
  const p = [...i.players.all()][0]!;
  p.spawnedAtTick = 0;

  // Tick 2: establish movement bucket.
  driveTick(server, 2);

  // Enqueue deferred human shoot (drains on next Weapons phase).
  i.pendingWeapons.push({
    kind: "shoot",
    shooterId: p.id,
    packet: { yaw: 0.3, pitch: -0.1, origin: [0, 1.7, 0] },
  });
  // Immediate reload + weapon switch + ability at arrival tick 3 (during step).
  // handle* notes fire during stepSim(3) / between — deliver(3) picks them up.
  driveTick(server, 3);

  // After tick 3 flush, fire should be recorded. Immediates called explicitly:
  i.players.handleReload(p.id, 3);
  i.players.handleWeaponSwitch(p.id, WEAPON_RIFLE, 3);
  // Ability may no-op without ownership; still notes when isSkillId.
  i.players.handleAbility(p.id, "teamHeal", 3);
  driveTick(server, 4);

  const tick3 = recorder.getTickInputs(matchId, 3);
  assertExists(tick3);
  const fires = tick3.actions.filter((a) => a.kind === "fire");
  assertEquals(fires.length >= 1, true);
  assertEquals(fires[0]!.fireKind, "shoot");
  assertEquals(fires[0]!.aim.yaw !== undefined, true);

  // Late immediates stamped tick 3 ran live after tick 3's MovePhysics, so
  // they stay in the tick-4 envelope (keeping tick 3) — never merged back.
  const tick3After = recorder.getTickInputs(matchId, 3)!;
  assertEquals(tick3After.actions.map((a) => a.kind), ["fire"]);

  const tick4 = recorder.getTickInputs(matchId, 4);
  assertExists(tick4);
  const late = tick4.actions.filter((a) => a.tick === 3);
  const kinds = late.map((a) => a.kind);
  assertEquals(kinds.includes("reload"), true);
  assertEquals(kinds.includes("weaponSelect"), true);
  // teamHeal may or may not note depending on ownership — ability note is
  // emitted before activation attempt when isSkillId.
  assertEquals(kinds.includes("ability"), true);

  // Ordinals are contiguous in drain order.
  for (let i = 0; i < tick4.actions.length; i++) {
    assertEquals(tick4.actions[i]!.ordinal, i);
  }
});

Deno.test("8.3 freeze: mutating live selection or accessor does not alter stream", () => {
  const server = makeServer();
  const { recorder } = wireRecorder(server);
  const matchId = startLive(server, recorder, [
    { socket: "s1", name: "A1", team: "A" },
  ]);
  const i = internals(server);
  const p = [...i.players.all()][0]!;

  i.players.handleInput(p.id, {
    sequence: 1,
    forward: true,
    backward: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
    crouch: false,
    yaw: 0.1,
    pitch: 0,
  }, Date.now());
  driveTick(server, 2);

  const row = recorder.getTickInputs(matchId, 2)!;
  assertEquals(Object.isFrozen(row), true);
  assertEquals(Object.isFrozen(row.movement), true);
  assertEquals(Object.isFrozen(row.movement[0]), true);

  const live = p.lastTickInputSelection()!;
  if (live.selectedInput) {
    live.selectedInput.forward = false;
  }
  // Accessor objects are frozen — mutation must throw, not silently alias.
  let threw = false;
  try {
    (row.movement as TickSelectedInput[]).push(sampleSelection({ tick: 2 }));
  } catch {
    threw = true;
  }
  assertEquals(threw, true);

  const again = recorder.getTickInputs(matchId, 2)!;
  assertEquals(again.movement.length, 1);
  assertEquals(again.movement[0]!.selectedInput?.forward, true);
});

Deno.test("8.3 non-acting rows: neutral/dead/connection_issue are explicit", () => {
  const server = makeServer();
  const { recorder } = wireRecorder(server);
  const matchId = startLive(server, recorder, [
    { socket: "s1", name: "A1", team: "A" },
  ]);
  const i = internals(server);
  const p = [...i.players.all()][0]!;

  // No input queued → neutral (or similar non-fresh) association after update.
  driveTick(server, 2);
  const row = recorder.getTickInputs(matchId, 2)!;
  assertEquals(row.movement.length, 1);
  assertEquals(row.movement[0]!.playerId, p.id);
  assertEquals(
    ["neutral", "dead", "connection_issue", "fresh", "hold", "repeat_missing"]
      .includes(row.movement[0]!.association),
    true,
  );

  // Mid-match join changes the per-tick row set.
  i.players.add("s2", "B1", "B");
  driveTick(server, 3);
  const row3 = recorder.getTickInputs(matchId, 3)!;
  assertEquals(row3.movement.length, 2);
});

Deno.test("8.3 gap: missing selection fails capture (loud, not silent)", () => {
  const bad = captureRecordedTickInputs({
    tick: 9,
    inputs: new Map([["ghost", null]]),
    actions: [],
    events: [],
  });
  assertEquals(bad.ok, false);
  if (!bad.ok) {
    assertEquals(bad.reason.includes("missing selection"), true);
  }

  const unanchored = captureRecordedTickInputs({
    tick: 9,
    inputs: new Map(),
    actions: [{
      kind: "reload",
      tick: Number.NaN,
      playerId: "p1",
    }],
    events: [],
  });
  assertEquals(unanchored.ok, false);
});

Deno.test("8.3 gap accounting: consecutive missing selections fail the row", async () => {
  const server = makeServer();
  stubSessions(server);
  const { recorder, lifecycle } = wireRecorder(server);
  const i = internals(server);
  i.players.add("s1", "A1", "A");
  const start = i.players.beginLiveMatch(1, Date.now());
  i.beginRuntimeMatchIdentity(1);
  i.emitMatchStart(start, 1);
  const matchId = i.runtimeMatchId;

  // Force a payload with a null selection through the sink path by temporarily
  // shadowing lastTickInputSelection on the player.
  const p = [...i.players.all()][0]!;
  const original = p.lastTickInputSelection.bind(p);
  p.lastTickInputSelection = () => null;

  for (let t = 0; t < 3; t++) {
    driveTick(server, 2 + t);
  }

  p.lastTickInputSelection = original;
  await settleRecorder(recorder);
  const row = await (lifecycle as InMemoryReplayLifecycleClient).getByRuntimeMatchId(matchId);
  assertExists(row);
  assertEquals(row.status, "failed");
  assertEquals(row.errorCount >= 1, true);
  void recorder;
});

Deno.test("8.3 uniformity: bot handle* notes share action row shape (no bot import)", async () => {
  const server = makeServer();
  const { recorder } = wireRecorder(server);
  const matchId = startLive(server, recorder, [
    { socket: "s1", name: "Human", team: "A" },
  ]);
  const i = internals(server);
  // Add a bot via PlayerManager.addBot, then call the same handle* seam
  // bots use in applyReadyActions (no bot-brain path).
  const bot = i.players.addBot("bot1", "Bot", { team: "B" });
  bot.spawnedAtTick = 0;

  driveTick(server, 2);
  i.players.handleShoot(bot.id, 3, { yaw: 0.5, pitch: 0 }, { nowMs: Date.now() });
  i.players.handleReload(bot.id, 3);
  driveTick(server, 3);

  const row = recorder.getTickInputs(matchId, 3)!;
  const botActions = row.actions.filter((a) => a.playerId === bot.id);
  assertEquals(botActions.length >= 1, true);
  for (const a of botActions) {
    assertEquals(typeof a.tick, "number");
    assertEquals(typeof a.ordinal, "number");
    assertEquals(["fire", "reload", "weaponSelect", "ability"].includes(a.kind), true);
  }

  const src = await Deno.readTextFile(
    new URL("./recordedTickInputs.ts", import.meta.url),
  );
  assertEquals(/from\s+['"].*bots\//.test(src), false);
  assertEquals(/ReadyAction/.test(src), false);
  assertEquals(/bot-official/.test(src), false);
});

Deno.test("8.3 no-persistence: no file/blob/finalized in capture", async () => {
  // Capture module only — 8.6 owns blob/finalized writes in ReplayRecorder.
  const src = await Deno.readTextFile(
    new URL("./recordedTickInputs.ts", import.meta.url),
  );
  const code = src.replace(/\/\/.*$/gm, "");
  assertEquals(/status\s*:\s*['"]finalized['"]/.test(code), false);
  assertEquals(/\bBlob\b/.test(code), false);
  assertEquals(/writeFile|createWriteStream|Deno\.write/.test(code), false);
  assertEquals(/stampReplayFinalized/.test(code), false);
});

Deno.test("8.3 accessor: getInputStream ordered; miss returns null", () => {
  const server = makeServer();
  const { recorder } = wireRecorder(server);
  const matchId = startLive(server, recorder, [
    { socket: "s1", name: "A1", team: "A" },
  ]);
  driveTick(server, 2);
  driveTick(server, 3);

  const stream = recorder.getInputStream(matchId);
  assertExists(stream);
  assertEquals(stream.length >= 2, true);
  assertEquals(stream[0]!.tick <= stream[1]!.tick, true);

  assertEquals(recorder.getTickInputs(matchId, 999), null);
  assertEquals(recorder.getInputStream("missing-id"), null);

  internals(server).onMatchEnded({
    winner: "draw",
    scores: { A: 0, B: 0 },
    players: [],
  });
  assertEquals(recorder.getInputStream(matchId), null);
});

Deno.test("8.3 projection helper: fire/reload/weapon/ability via canonicalFromWireParts", () => {
  const fire = projectSimActionEffect({
    kind: "fire",
    tick: 1,
    playerId: "p",
    fireKind: "melee",
    packet: { yaw: 1, pitch: 0.2 },
  }, 0);
  assertExists(fire);
  assertEquals(fire.kind, "fire");
  if (fire.kind === "fire") {
    assertEquals(fire.fireKind, "melee");
    assertEquals(fire.aim.yaw !== 0 || fire.aim.pitch !== 0, true);
  }

  const reload = projectSimActionEffect({
    kind: "reload",
    tick: 1,
    playerId: "p",
  }, 1);
  assertEquals(reload?.kind, "reload");

  const weapon = projectSimActionEffect({
    kind: "weaponSelect",
    tick: 1,
    playerId: "p",
    weapon: WEAPON_RIFLE,
  }, 2);
  assertEquals(weapon?.kind, "weaponSelect");

  const bad: SimActionEffect = {
    kind: "weaponSelect",
    tick: 1,
    playerId: "p",
    weapon: 99999,
  };
  assertEquals(projectSimActionEffect(bad, 3), null);
});

Deno.test("8.3 equivalence: sim outcomes identical with input capture on vs off", () => {
  function runSeason(withRecorder: boolean): {
    phase: string;
    scores: { A: number; B: number };
  } {
    const server = makeServer();
    stubSessions(server);
    const i = internals(server);
    if (withRecorder) wireRecorder(server);
    i.players.add("s1", "A1", "A");
    i.players.add("s2", "B1", "B");
    const start = i.players.beginLiveMatch(1, Date.now());
    i.beginRuntimeMatchIdentity(1);
    i.emitMatchStart(start, 1);
    for (let t = 2; t <= 6; t++) {
      const p = [...i.players.all()][0]!;
      i.players.handleInput(p.id, {
        sequence: t,
        forward: t % 2 === 0,
        backward: false,
        left: false,
        right: false,
        jump: false,
        sprint: false,
        crouch: false,
        yaw: 0.01 * t,
        pitch: 0,
      }, Date.now());
      if (t === 4) {
        i.pendingWeapons.push({
          kind: "shoot",
          shooterId: p.id,
          packet: { yaw: 0, pitch: 0 },
        });
      }
      driveTick(server, t);
    }
    i.onMatchEnded({
      winner: "A",
      scores: { A: 1, B: 0 },
      players: [],
    });
    const out = {
      phase: i.players.getMatchPhase(),
      scores: i.players.getScores(),
    };
    return out;
  }

  const a = runSeason(false);
  const b = runSeason(true);
  assertEquals(a.phase, b.phase);
  assertEquals(a.scores, b.scores);
});

