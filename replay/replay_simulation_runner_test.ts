/**
 * Epic 11.2 — replay simulation runner.
 *
 * Run from server-community/:
 *   deno test -A replay/replay_simulation_runner_test.ts
 */

import {
  assertEquals,
  assertThrows,
} from "@std/assert";
import {
  emptyAuthoritativeRosterSnapshot,
  makeHumanJoinEvent,
  makeMatchInitEvent,
  type AuthoritativeEvent,
  type MatchInitEvent,
} from "../shared/sim/authoritativeEvent.ts";
import { TICK_HZ } from "../shared/sim/game.ts";
import {
  buildMatchMetadata,
  type MatchMetadata,
} from "../shared/replay/matchMetadata.ts";
import { PlayerManager } from "../players/PlayerManager.ts";
import type { TickSelectedInput } from "../players/tickAssociation.ts";
import type { DoorsMap } from "../world/map.ts";
import type { PlayerInput } from "../protocol/network.ts";
import { MapCollision } from "../world/MapCollision.ts";
import {
  captureCheckpointState,
  type AuthoritativeCheckpoint,
} from "./authoritativeCheckpoint.ts";
import { loadCheckpointState } from "./checkpointLoading.ts";
import { compareSimulationState } from "./checkpointValidation.ts";
import {
  deepFreeze,
  type RecordedInitialState,
} from "./recordedInitialState.ts";
import type { RecordedTickInputs } from "./recordedTickInputs.ts";
import {
  __replayTickNowMsForTest,
  createReplayRunner,
  ReplayEventDispositionError,
  ReplayInputGapError,
  ReplayRaidUnsupportedError,
  ReplayStepOrderError,
  ReplayUnknownPlayerInputError,
  type ReplayRunSession,
} from "./replaySimulationRunner.ts";

const miniMap: DoorsMap = {
  name: "replay-runner",
  version: 1,
  bounds: { minX: -40, maxX: 40, minZ: -40, maxZ: 40 },
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

function makeCollision(): MapCollision {
  return new MapCollision(miniMap);
}

function sampleMetadata(
  init: MatchInitEvent,
  over?: Partial<MatchMetadata>,
): MatchMetadata {
  const built = buildMatchMetadata(
    init.appliedTick,
    {
      matchSeed: init.matchSeed,
      matchDurationTicks: init.matchDurationTicks,
      matchEndTick: init.appliedTick + init.matchDurationTicks,
      doorCycleOriginTick: init.appliedTick,
      map: init.map,
      prematchEnabled: init.prematchEnabled,
      raidDoorPolicy: init.raidDoorPolicy,
      debugForceDoorsOpen: init.debugForceDoorsOpen,
      phase: init.phase,
      scores: init.scores,
      roster: init.roster,
    },
    {
      runtimeMatchId: "rt-runner-1",
      serverName: "runner-test",
      serverId: "srv-runner",
      modeId: "standard",
      raidId: null,
      buildSha: "deadbeef",
      raidMatch: { active: false },
    },
    { capturedAtIso: "2026-01-01T00:00:00.000Z" },
  );
  if (!built.ok) throw new Error(built.reason);
  return { ...built.metadata, ...over };
}

function emptyLiveInit(seed = 0x51f0): {
  initialState: RecordedInitialState;
  collision: MapCollision;
} {
  const collision = makeCollision();
  const live = new PlayerManager(collision, {
    matchSeed: seed,
    matchDurationSeconds: 60,
    enablePrematch: false,
    nowMs: __replayTickNowMsForTest(0),
  });
  const captureTick = 0;
  live.beginLiveMatch(captureTick, __replayTickNowMsForTest(captureTick));
  live.drainAuthoritativeEvents();
  const initRaw = live.buildMatchInitEvent(captureTick);
  if (initRaw.kind !== "matchInit") throw new Error("expected matchInit");
  const init = initRaw;
  const metadata = sampleMetadata(init);
  return {
    collision,
    initialState: {
      runtimeMatchId: metadata.runtimeMatchId,
      captureTick,
      init,
      metadata,
    },
  };
}

function liveCapturedSession(opts?: {
  seed?: number;
  ticks?: number;
  withBot?: boolean;
}): {
  session: ReplayRunSession;
  collision: MapCollision;
  checkpoints: Map<number, AuthoritativeCheckpoint>;
} {
  const seed = opts?.seed ?? 0xa11ce;
  const tickCount = opts?.ticks ?? 8;
  const collision = makeCollision();
  const live = new PlayerManager(collision, {
    matchSeed: seed,
    matchDurationSeconds: 120,
    enablePrematch: false,
    nowMs: __replayTickNowMsForTest(0),
  });

  live.add("h1", "Human", "A", undefined, __replayTickNowMsForTest(0));
  if (opts?.withBot !== false) {
    live.addBot("b1", "BotOne", { team: "B" });
  }
  const captureTick = 0;
  live.beginLiveMatch(captureTick, __replayTickNowMsForTest(captureTick));
  live.drainAuthoritativeEvents();

  const initRaw = live.buildMatchInitEvent(captureTick);
  if (initRaw.kind !== "matchInit") throw new Error("expected matchInit");
  const init = initRaw;
  const metadata = sampleMetadata(init);
  const initialState: RecordedInitialState = {
    runtimeMatchId: metadata.runtimeMatchId,
    captureTick,
    init,
    metadata,
  };

  const inputs = new Map<number, RecordedTickInputs>();
  const events = new Map<number, AuthoritativeEvent[]>();
  const checkpoints = new Map<number, AuthoritativeCheckpoint>();

  const firstTick = 1;
  const lastTick = tickCount;

  for (let tick = firstTick; tick <= lastTick; tick++) {
    const nowMs = __replayTickNowMsForTest(tick);
    const human = live.get("h1");
    if (human?.alive) {
      const packet: PlayerInput = {
        sequence: tick,
        forward: tick % 2 === 0,
        backward: false,
        left: tick % 3 === 0,
        right: false,
        jump: false,
        sprint: false,
        crouch: false,
        meleeLunge: false,
        yaw: 0.1 * tick,
        pitch: -0.05,
      };
      live.handleInput("h1", packet, nowMs);
    }

    live.update(tick, nowMs);
    live.processScores(tick);
    live.checkMatchEnd(tick);
    live.checkMatchTimeLimit(tick);
    live.processRespawns(tick);

    const movement: TickSelectedInput[] = [];
    for (const p of live.all()) {
      const sel = p.lastTickInputSelection();
      if (!sel) {
        throw new Error(`missing selection for ${p.id} at tick ${tick}`);
      }
      movement.push(sel);
    }
    inputs.set(tick, { tick, movement, actions: [] });
    events.set(tick, []);

    if (
      tick === firstTick ||
      tick === Math.floor((firstTick + lastTick) / 2) ||
      tick === lastTick
    ) {
      live.drainAuthoritativeEvents();
      checkpoints.set(
        tick,
        captureCheckpointState(live, tick, initialState.runtimeMatchId),
      );
    }
    live.drainAuthoritativeEvents();
  }

  const session: ReplayRunSession = {
    initialState,
    firstTick,
    lastTick,
    inputAt(tick) {
      const row = inputs.get(tick);
      if (!row) throw new Error(`no inputs for ${tick}`);
      return row;
    },
    eventsAt(tick) {
      return events.get(tick) ?? [];
    },
    checkpointFrameAt(tick) {
      return checkpoints.get(tick) ?? null;
    },
  };

  return { session, collision, checkpoints };
}

function sessionFromParts(
  initialState: RecordedInitialState,
  firstTick: number,
  lastTick: number,
  inputAt: (tick: number) => RecordedTickInputs,
  eventsAt: (tick: number) => ReadonlyArray<AuthoritativeEvent> = () => [],
): ReplayRunSession {
  return { initialState, firstTick, lastTick, inputAt, eventsAt };
}

// ---------------------------------------------------------------------------
// Raid scope
// ---------------------------------------------------------------------------

Deno.test("11.2 raid: createReplayRunner fails closed when raidMatch.active", () => {
  const { initialState, collision } = emptyLiveInit();
  const raidMeta = sampleMetadata(initialState.init, {
    raidMatch: {
      active: true,
      raidId: "raid-1",
      humanTeam: "A",
      goal: 10,
      maxTimeSeconds: 600,
      respawnMs: 5000,
      initialMap: "replay-runner",
      expectedHumans: 1,
      startWaitSeconds: 30,
      started: true,
      ended: false,
      wave: 1,
      failReason: null,
    },
  });
  const session = sessionFromParts(
    { ...initialState, metadata: raidMeta },
    1,
    1,
    () => ({ tick: 1, movement: [], actions: [] }),
  );
  assertThrows(
    () => createReplayRunner(session, { collision }),
    ReplayRaidUnsupportedError,
  );
});

Deno.test("11.2 raid: resetToInitial fails closed if metadata flipped to raid", () => {
  const { initialState, collision } = emptyLiveInit();
  const session = sessionFromParts(
    initialState,
    1,
    1,
    () => ({ tick: 1, movement: [], actions: [] }),
  );
  const runner = createReplayRunner(session, { collision });
  (session as { initialState: RecordedInitialState }).initialState = {
    ...initialState,
    metadata: sampleMetadata(initialState.init, {
      raidMatch: {
        active: true,
        raidId: "raid-2",
        humanTeam: "B",
        goal: 5,
        maxTimeSeconds: 300,
        respawnMs: 3000,
        initialMap: "replay-runner",
        expectedHumans: 2,
        startWaitSeconds: 10,
        started: false,
        ended: false,
        wave: 0,
        failReason: null,
      },
    }),
  };
  assertThrows(() => runner.resetToInitial(), ReplayRaidUnsupportedError);
});

// ---------------------------------------------------------------------------
// Reset / step order / rejection
// ---------------------------------------------------------------------------

Deno.test("11.2 resetToInitial: empty roster scores/match-block self-check", () => {
  const { initialState, collision } = emptyLiveInit(0xbee1);
  const session = sessionFromParts(
    initialState,
    1,
    3,
    (tick) => ({ tick, movement: [], actions: [] }),
  );
  const runner = createReplayRunner(session, { collision });
  assertEquals(runner.currentTick, 0);
  assertEquals(runner.simulation.getScores(), { A: 0, B: 0 });
  assertEquals(runner.simulation.getMatchPhase(), "live");
  assertEquals([...runner.simulation.all()].length, 0);
});

Deno.test("11.2 step: advances exactly once; out-of-order / double-step loud", () => {
  const { initialState, collision } = emptyLiveInit();
  const session = sessionFromParts(
    initialState,
    1,
    3,
    (tick) => ({ tick, movement: [], actions: [] }),
  );
  const runner = createReplayRunner(session, { collision });
  assertThrows(() => runner.step(2), ReplayStepOrderError);
  runner.step(1);
  assertEquals(runner.currentTick, 1);
  assertThrows(() => runner.step(1), ReplayStepOrderError);
  runner.step(2);
  assertEquals(runner.currentTick, 2);
});

Deno.test("11.2 input: frozen jump edges are cloned before consume", () => {
  const captured = liveCapturedSession({ ticks: 2, withBot: false });
  const base = captured.session;
  const frozenSession: ReplayRunSession = {
    ...base,
    inputAt(tick) {
      const row = base.inputAt(tick);
      return deepFreeze({
        tick: row.tick,
        actions: row.actions,
        movement: row.movement.map((m) => {
          if (m.playerId !== "h1" || m.selectedInput == null) return m;
          return {
            ...m,
            association: "fresh" as const,
            selectedInput: {
              ...m.selectedInput,
              jump: true,
              sequence: tick,
            },
          };
        }),
      });
    },
  };
  const runner = createReplayRunner(frozenSession, {
    collision: captured.collision,
  });
  // Would throw "Cannot assign to read only property 'jump'" without cloning.
  runner.step(1);
  runner.step(2);
  assertEquals(runner.currentTick, 2);
});

Deno.test("11.2 input: gap and unknown-player rows fail closed", () => {
  const captured = liveCapturedSession({ ticks: 2, withBot: false });
  const base = captured.session;

  const gapSession: ReplayRunSession = {
    ...base,
    inputAt(tick) {
      const row = base.inputAt(tick);
      return { ...row, movement: [] };
    },
  };
  const gapRunner = createReplayRunner(gapSession, {
    collision: makeCollision(),
  });
  assertThrows(() => gapRunner.step(1), ReplayInputGapError);

  const unknownSession: ReplayRunSession = {
    ...base,
    inputAt(tick) {
      const row = base.inputAt(tick);
      return {
        ...row,
        movement: [
          ...row.movement,
          {
            tick,
            playerId: "ghost",
            association: "neutral",
            appliedSequence: 0,
            inputHoldTicks: 0,
            selectedInput: null,
          },
        ],
      };
    },
  };
  const unknownRunner = createReplayRunner(unknownSession, {
    collision: makeCollision(),
  });
  assertThrows(() => unknownRunner.step(1), ReplayUnknownPlayerInputError);
});

Deno.test("11.2 events: matchInit in-stream and unclassified kind fail closed", () => {
  const { initialState, collision } = emptyLiveInit();
  const initInStream = sessionFromParts(
    initialState,
    1,
    1,
    (tick) => ({ tick, movement: [], actions: [] }),
    () => [
      makeMatchInitEvent({
        appliedTick: 1,
        map: initialState.init.map,
        matchSeed: initialState.init.matchSeed,
        matchDurationTicks: initialState.init.matchDurationTicks,
        prematchEnabled: false,
        phase: "live",
        raidDoorPolicy: "off",
        debugForceDoorsOpen: false,
        scores: { A: 0, B: 0 },
        roster: [],
      }),
    ],
  );
  const runner = createReplayRunner(initInStream, { collision });
  assertThrows(() => runner.step(1), ReplayEventDispositionError);

  const bogus = sessionFromParts(
    initialState,
    1,
    1,
    (tick) => ({ tick, movement: [], actions: [] }),
    () =>
      [{ kind: "notARealKind", appliedTick: 1 } as unknown as AuthoritativeEvent],
  );
  const runner2 = createReplayRunner(bogus, { collision: makeCollision() });
  assertThrows(() => runner2.step(1), ReplayEventDispositionError);
});

// ---------------------------------------------------------------------------
// Membership / movement / determinism
// ---------------------------------------------------------------------------

Deno.test("11.2 membership: mid-match humanJoin applies at churn position", () => {
  const { initialState, collision } = emptyLiveInit(0x7011);
  const join = makeHumanJoinEvent({
    appliedTick: 1,
    player: emptyAuthoritativeRosterSnapshot({
      id: "late",
      name: "LateJoin",
      team: "A",
    }),
  });
  const session = sessionFromParts(
    initialState,
    1,
    2,
    (tick) => ({
      tick,
      movement: [{
        tick,
        playerId: "late",
        association: "neutral",
        appliedSequence: 0,
        inputHoldTicks: 0,
        selectedInput: null,
      }],
      actions: [],
    }),
    (tick) => tick === 1 ? [join] : [],
  );
  const runner = createReplayRunner(session, { collision });
  const out = runner.step(1);
  assertEquals(out.rosterDigest.map((r) => r.id), ["late"]);
  assertEquals(runner.simulation.get("late")?.name, "LateJoin");
});

Deno.test("11.2 round-trip: resetToInitial + step matches live checkpoints", () => {
  const { session, checkpoints } = liveCapturedSession({
    ticks: 10,
    withBot: true,
  });
  // Fresh collision for the runner (same map; independent spawn stream owned
  // by the runner's private manager via matchSeed reseed).
  const runner = createReplayRunner(session, { collision: makeCollision() });

  for (let tick = session.firstTick; tick <= session.lastTick; tick++) {
    runner.step(tick);
    const frame = checkpoints.get(tick);
    if (!frame) continue;

    const ref = new PlayerManager(makeCollision(), {
      matchSeed: session.initialState.init.matchSeed,
      matchDurationSeconds:
        session.initialState.init.matchDurationTicks / TICK_HZ,
      nowMs: __replayTickNowMsForTest(0),
    });
    loadCheckpointState(ref, frame, {
      expectedInit: session.initialState,
    });
    const divergence = compareSimulationState(
      ref,
      runner.simulation,
      tick,
      session.initialState.runtimeMatchId,
      tick,
    );
    assertEquals(divergence, null, `divergence at tick ${tick}`);
  }
});

Deno.test("11.2 parity: resetToCheckpoint + step-forward ≡ resetToInitial path", () => {
  const { session, checkpoints } = liveCapturedSession({
    ticks: 12,
    withBot: true,
  });
  const mid = Math.floor((session.firstTick + session.lastTick) / 2);
  const frame = checkpoints.get(mid);
  if (!frame) throw new Error(`missing checkpoint at ${mid}`);

  const fromInit = createReplayRunner(session, { collision: makeCollision() });
  for (let tick = session.firstTick; tick <= session.lastTick; tick++) {
    fromInit.step(tick);
  }

  const fromCp = createReplayRunner(session, { collision: makeCollision() });
  fromCp.resetToCheckpoint(frame);
  for (let tick = mid + 1; tick <= session.lastTick; tick++) {
    fromCp.step(tick);
  }

  const divergence = compareSimulationState(
    fromInit.simulation,
    fromCp.simulation,
    session.lastTick,
    session.initialState.runtimeMatchId,
    mid,
  );
  assertEquals(divergence, null);
});

Deno.test("11.2 association: connection_issue forces sitting-duck without event apply", () => {
  const captured = liveCapturedSession({ ticks: 3, withBot: false });
  const session: ReplayRunSession = {
    ...captured.session,
    inputAt(tick) {
      const row = captured.session.inputAt(tick);
      if (tick !== 2) return row;
      return {
        tick,
        movement: row.movement.map((m) => ({
          ...m,
          association: "connection_issue" as const,
          selectedInput: null,
        })),
        actions: [],
      };
    },
  };
  const runner = createReplayRunner(session, { collision: makeCollision() });
  runner.step(1);
  runner.step(2);
  const human = runner.simulation.get("h1");
  assertEquals(human?.connectionIssue, true);
});

Deno.test("11.2 source-scan: runner module has no BotManager / Date.now / fs imports", async () => {
  const src = await Deno.readTextFile(
    new URL("./replaySimulationRunner.ts", import.meta.url),
  );
  // Import / call-site scan (comments may mention excluded owners).
  assertEquals(/^\s*import[\s\S]*BotManager/m.test(src), false);
  assertEquals(/from\s+["'][^"']*BotManager/.test(src), false);
  assertEquals(/from\s+["'][^"']*bot-official/.test(src), false);
  assertEquals(/[^\/\*]Date\.now\s*\(/.test(src), false);
  assertEquals(/from\s+["'][^"']*\/fs["']/.test(src), false);
  assertEquals(/from\s+["'].*ReplayBlobStore/.test(src), false);
  assertEquals(/from\s+["'].*storeFactory/.test(src), false);
});

Deno.test("11.2 tick time: helper is tick-derived (no wall clock)", () => {
  assertEquals(__replayTickNowMsForTest(0), 0);
  assertEquals(__replayTickNowMsForTest(TICK_HZ), 1000);
  assertEquals(__replayTickNowMsForTest(2 * TICK_HZ), 2000);
});
