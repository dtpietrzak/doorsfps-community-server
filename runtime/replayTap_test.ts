/**
 * Replay tap. Run from server-community/:
 *   deno test -A runtime/replayTap_test.ts
 */

import { assertEquals } from "@std/assert";
import { PlayerManager } from "../players/PlayerManager.ts";
import type { SimActionEffect, SimActionEffectObserver } from "../players/simActionEffect.ts";
import type { GameOverPacket } from "../protocol/network.ts";
import type { ReplayIntegrationSink } from "../replay/replayIntegration.ts";
import type { ReplayLifecycleClient } from "../replay/replayLifecycleClient.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { DoorsMap } from "../world/map.ts";
import type { MatchMetadata } from "../shared/replay/matchMetadata.ts";
import { ReplayTap, type ReplayTapDeps } from "./replayTap.ts";

type RosterPlayer = {
  id: string;
  isBot: boolean;
  isAgent: boolean;
  synthetic: boolean;
  lastTickInputSelection(): null;
};

type SinkCall = { name: string; payload: Record<string, unknown> };

const human: RosterPlayer = {
  id: "h",
  isBot: false,
  isAgent: false,
  synthetic: false,
  lastTickInputSelection: () => null,
};

const bot: RosterPlayer = {
  id: "b",
  isBot: true,
  isAgent: false,
  synthetic: false,
  lastTickInputSelection: () => null,
};

const synthetic: RosterPlayer = {
  id: "s",
  isBot: false,
  isAgent: false,
  synthetic: true,
  lastTickInputSelection: () => null,
};

function packet(winner: "A" | "draw"): GameOverPacket {
  return { winner } as GameOverPacket;
}

function harness(opts?: {
  roster?: RosterPlayer[];
  live?: boolean;
  metadataOk?: boolean;
  initKind?: string;
  lifecycle?: ReplayLifecycleClient | null;
}) {
  const roster = opts?.roster ?? [];
  const state = {
    observer: null as SimActionEffectObserver | null,
    allCalls: 0,
    matchId: "match-1",
  };
  const players = {
    tick: 4,
    all() {
      state.allCalls++;
      return roster;
    },
    isLive: () => opts?.live ?? false,
    setActionEffectObserver(next: SimActionEffectObserver | null) {
      state.observer = next;
    },
    buildMatchInitEvent(tick: number) {
      return { kind: opts?.initKind ?? "matchInit", appliedTick: tick };
    },
  };
  const calls: SinkCall[] = [];
  const sink: ReplayIntegrationSink = {
    onMatchInit(payload) {
      calls.push({ name: "init", payload: payload as Record<string, unknown> });
    },
    onMatchStart(payload) {
      calls.push({ name: "start", payload: payload as Record<string, unknown> });
    },
    onMatchEnd(payload) {
      calls.push({ name: "end", payload: payload as Record<string, unknown> });
    },
    onMatchDraw(payload) {
      calls.push({ name: "draw", payload: payload as Record<string, unknown> });
    },
    onTick(payload) {
      calls.push({ name: "tick", payload: payload as Record<string, unknown> });
    },
    onCheckpoint(payload) {
      calls.push({
        name: "checkpoint",
        payload: payload as Record<string, unknown>,
      });
    },
  };
  const deps: ReplayTapDeps = {
    players: players as unknown as PlayerManager,
    runtimeMatchId: () => state.matchId,
    raidCheckpointState: () => ({ active: false }),
    matchMetadata: () =>
      opts?.metadataOk === false
        ? { ok: false, reason: "no" }
        : { ok: true, metadata: { captureTick: 1 } as MatchMetadata },
    createReplayLifecycleClient: () => opts?.lifecycle ?? null,
  };
  return { tap: new ReplayTap(deps), sink, calls, state };
}

Deno.test("deliverTick skips the roster when no sink is attached", () => {
  const { tap, state } = harness({ roster: [human] });
  tap.deliverTick(3, []);
  assertEquals(state.allCalls, 0);
  assertEquals(tap.payloadConstructionCount, 0);
});

Deno.test("deliverTick drains action effects and isolates a sink throw", () => {
  const { tap, sink, calls, state } = harness({ roster: [human] });
  tap.attach(sink);
  const effect = { kind: "reload", tick: 3, playerId: "h" } as SimActionEffect;
  state.observer?.(effect);
  tap.deliverTick(3, []);
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.name, "tick");
  const payload = calls[0]!.payload;
  const inputs = payload.inputs as Map<string, null>;
  const actions = payload.actions as SimActionEffect[];
  assertEquals(inputs.get("h"), null);
  assertEquals(Object.isFrozen(inputs), true);
  assertEquals(actions, [effect]);
  assertEquals(Object.isFrozen(actions), true);
  assertEquals(tap.payloadConstructionCount, 1);

  tap.deliverTick(4, []);
  assertEquals((calls[1]!.payload.actions as unknown[]).length, 0);

  calls.length = 0;
  sink.onTick = () => {
    throw new Error("boom");
  };
  const errors: unknown[][] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  try {
    tap.deliverTick(5, []);
  } finally {
    console.error = orig;
  }
  assertEquals(tap.sinkErrorCount, 1);
  assertEquals(String(errors[0]?.[0]).includes("onTick"), true);
});

Deno.test("deferMatchEnd stores inside a step and notifies outside it", () => {
  const { tap, sink, calls } = harness();
  tap.attach(sink);
  const scored = packet("A");
  tap.enterStep();
  tap.deferMatchEnd(scored);
  assertEquals(tap.pendingMatchEnd, scored);
  assertEquals(calls.length, 0);
  tap.exitStep();
  tap.flushPendingEnd(9);
  assertEquals(tap.pendingMatchEnd, null);
  assertEquals(calls[0]!.name, "end");
  assertEquals(calls[0]!.payload.tick, 9);
  assertEquals(calls[0]!.payload.transition, "matchEnd");

  tap.deferMatchEnd(packet("draw"));
  assertEquals(calls[1]!.name, "draw");
  assertEquals(calls[1]!.payload.tick, 4);
  assertEquals(calls[1]!.payload.transition, "matchDraw");

  const before = calls.length;
  tap.flushPendingEnd(10);
  assertEquals(calls.length, before);
});

Deno.test("onIdentityRotated discards a bot-only match and opens a human match", () => {
  const botsOnly = harness({ roster: [bot, synthetic] });
  const discarded: string[] = [];
  botsOnly.tap.recorder = {
    ensureAttached() {
      discarded.push("attach");
    },
    discardActiveWithoutRecording() {
      discarded.push("discard");
    },
  } as unknown as ReplayTap["recorder"];
  botsOnly.tap.attach(botsOnly.sink);
  botsOnly.tap.onIdentityRotated("old", 2);
  assertEquals(discarded, ["attach", "discard"]);
  assertEquals(botsOnly.calls.length, 0);

  const humans = harness({ roster: [human], live: true });
  humans.state.matchId = "new-id";
  humans.tap.attach(humans.sink);
  humans.tap.onIdentityRotated("old-id", 6);
  assertEquals(humans.calls.map((c) => c.name), ["start", "init"]);
  assertEquals(humans.calls[0]!.payload.transition, "runtimeMatchIdRotated");
  assertEquals(humans.calls[0]!.payload.runtimeMatchId, "new-id");
  assertEquals(humans.calls[0]!.payload.previousRuntimeMatchId, "old-id");
  assertEquals(humans.calls[0]!.payload.tick, 6);
});

Deno.test("noteHumanPresence ignores synthetics and does not backfill a late sink", () => {
  const late = harness({ roster: [synthetic] });
  late.tap.attach(late.sink);
  late.tap.noteHumanPresence(5);
  assertEquals(late.calls.length, 0);

  late.tap.detach();
  const seated = harness({ roster: [human], live: true });
  seated.tap.noteHumanPresence(5);
  seated.tap.attach(seated.sink);
  seated.tap.noteHumanPresence(6);
  assertEquals(seated.calls.length, 0);

  const live = harness({ roster: [human], live: true });
  live.state.matchId = "late";
  live.tap.attach(live.sink);
  live.tap.noteHumanPresence(8);
  assertEquals(live.calls.map((c) => c.name), ["start", "init", "start"]);
  assertEquals(live.calls[0]!.payload.transition, "runtimeMatchIdRotated");
  assertEquals(live.calls[0]!.payload.previousRuntimeMatchId, undefined);
  assertEquals(live.calls[2]!.payload.transition, "matchStart");
  assertEquals(live.calls[2]!.payload.tick, 8);
});

Deno.test("attach arms the observer and detach drops buffered effects", () => {
  const { tap, sink, calls, state } = harness({ roster: [human] });
  tap.attach(sink);
  state.observer?.({ kind: "reload", tick: 1, playerId: "h" } as SimActionEffect);
  tap.detach();
  assertEquals(tap.sink, null);
  assertEquals(state.observer, null);
  tap.attach(sink);
  tap.deliverTick(2, []);
  assertEquals((calls[0]!.payload.actions as unknown[]).length, 0);
});

Deno.test("startRecorder returns null without a lifecycle client and stop clears it", () => {
  const missing = harness();
  assertEquals(missing.tap.startRecorder(), null);
  assertEquals(missing.tap.recorder, null);

  const { tap, state } = harness({
    lifecycle: {} as ReplayLifecycleClient,
  });
  const first = tap.startRecorder();
  assertEquals(first != null, true);
  assertEquals(state.observer != null, true);
  assertEquals(tap.startRecorder(), first);
  tap.stopRecorder();
  assertEquals(tap.recorder, null);
  assertEquals(state.observer, null);
});

Deno.test("captureCheckpoint fans out only while a sink is attached", () => {
  const pm = new PlayerManager(new MapCollision(miniMap), { matchSeed: 1 });
  pm.drainAuthoritativeEvents();
  const calls: SinkCall[] = [];
  const sink: ReplayIntegrationSink = {
    onMatchInit() {},
    onMatchStart() {},
    onMatchEnd() {},
    onMatchDraw() {},
    onTick() {},
    onCheckpoint(payload) {
      calls.push({
        name: "checkpoint",
        payload: payload as unknown as Record<string, unknown>,
      });
    },
  };
  const tap = new ReplayTap({
    players: pm,
    runtimeMatchId: () => "rt-tap",
    raidCheckpointState: () => ({ active: false }),
    matchMetadata: () => ({ ok: false, reason: "unused" }),
    createReplayLifecycleClient: () => null,
  });
  const plain = tap.captureCheckpoint(5);
  assertEquals(calls.length, 0);
  assertEquals(tap.payloadConstructionCount, 0);
  tap.attach(sink);
  const fanned = tap.captureCheckpoint(5);
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.payload.tick, 5);
  assertEquals(calls[0]!.payload.checkpoint, fanned);
  assertEquals(fanned, plain);
  assertEquals(tap.payloadConstructionCount, 1);
});

const miniMap: DoorsMap = {
  name: "replay-tap",
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
