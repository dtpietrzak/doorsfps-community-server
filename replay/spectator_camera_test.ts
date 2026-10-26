/**
 * Epic 12.2 — first-person camera.
 *
 * Run from server-community/:
 *   deno test -A replay/spectator_camera_test.ts
 */

import {
  assertEquals,
  assertNotEquals,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { TICK_MS } from "../shared/sim/game.ts";
import {
  buildMatchMetadata,
  type MatchMetadata,
} from "../shared/replay/matchMetadata.ts";
import {
  makePlayerRemoveEvent,
  type AuthoritativeEvent,
  type MatchInitEvent,
} from "../shared/sim/authoritativeEvent.ts";
import { PlayerManager } from "../players/PlayerManager.ts";
import type { TickSelectedInput } from "../players/tickAssociation.ts";
import type { DoorsMap } from "../world/map.ts";
import type { PlayerInput, SnapshotPacket } from "../protocol/network.ts";
import { MapCollision } from "../world/MapCollision.ts";
import {
  captureCheckpointState,
  type AuthoritativeCheckpoint,
} from "./authoritativeCheckpoint.ts";
import type { RecordedInitialState } from "./recordedInitialState.ts";
import type { RecordedTickInputs } from "./recordedTickInputs.ts";
import {
  __replayTickNowMsForTest,
  createReplayRunner,
  type ReplayRunSession,
} from "./replaySimulationRunner.ts";
import {
  createReplayPlayback,
  type ReplayPlayback,
} from "./replayPlaybackSession.ts";
import {
  interpolateReplayPose,
  type ReplayInterpPose,
} from "./replayInterpolation.ts";
import {
  ReplayStateAccessError,
  extractReplayInterpPairs,
  projectReplayRenderFeed,
  type ReplayRenderFeedState,
  type ReplayViewState,
} from "./replayStateAccess.ts";
import type { CheckpointPlayerState } from "./authoritativeCheckpoint.ts";
import { moveEyeHeight } from "../shared/sim/moveStep.ts";
import {
  firstPersonCamera,
  SpectatorCameraError,
  type CameraPose,
  type SpectatorCameraErrorCode,
} from "./spectatorCamera.ts";

// ---------------------------------------------------------------------------
// Independent live eye formula (client renderCameraFromSimLayers + renderFromSim)
// Copied here so equivalence is not tautological with spectatorCamera.ts.
// ---------------------------------------------------------------------------

function liveRenderCameraFromSimLayers(
  prev: { x: number; y: number; z: number },
  sim: { x: number; y: number; z: number },
  accum: number,
  simDt: number,
  offset: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  const dt = simDt > 0 ? simDt : 1;
  const a = Math.min(1, Math.max(0, accum / dt));
  const body = {
    x: prev.x + (sim.x - prev.x) * a,
    y: prev.y + (sim.y - prev.y) * a,
    z: prev.z + (sim.z - prev.z) * a,
  };
  return {
    x: body.x + (Number.isFinite(offset.x) ? offset.x : 0),
    y: body.y + (Number.isFinite(offset.y) ? offset.y : 0),
    z: body.z + (Number.isFinite(offset.z) ? offset.z : 0),
  };
}

function literalFeed(
  over: Partial<ReplayRenderFeedState> & {
    localSim?: ReplayRenderFeedState["localSim"];
  } = {},
): ReplayRenderFeedState {
  const body = over.localSim ?? { x: 1, y: 2, z: 3 };
  return {
    localSim: body,
    prevSim: over.prevSim ?? { ...body },
    localSimAccum: over.localSimAccum ?? 0,
    localSimDt: over.localSimDt ?? TICK_MS,
    viewOffset: over.viewOffset ?? { x: 0, y: 0.25, z: 0 },
    yaw: over.yaw ?? 0.4,
    pitch: over.pitch ?? -0.15,
    alive: over.alive ?? true,
  };
}

function assertCameraCode(
  fn: () => unknown,
  code: SpectatorCameraErrorCode,
): SpectatorCameraError {
  const err = assertThrows(fn, SpectatorCameraError);
  assertEquals(err.code, code);
  return err;
}

function isRenderFeedShaped(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const f = value as Record<string, unknown>;
  const xyz = (v: unknown) =>
    v !== null &&
    typeof v === "object" &&
    typeof (v as { x: unknown }).x === "number" &&
    typeof (v as { y: unknown }).y === "number" &&
    typeof (v as { z: unknown }).z === "number";
  if (!xyz(f.localSim) || !xyz(f.prevSim) || !xyz(f.viewOffset)) return false;
  return (
    typeof f.localSimAccum === "number" && typeof f.localSimDt === "number"
  );
}

// ---------------------------------------------------------------------------
// 11.5 view fixtures (for Q4A / dead-present via projector)
// ---------------------------------------------------------------------------

function playerRow(
  overrides: Partial<CheckpointPlayerState> & Pick<CheckpointPlayerState, "id">,
): CheckpointPlayerState {
  return {
    team: "A",
    isBot: false,
    isAgent: false,
    x: 0,
    y: moveEyeHeight(false),
    z: 0,
    yaw: 0,
    pitch: 0,
    velocityX: 0,
    velocityY: 0,
    velocityZ: 0,
    onGround: true,
    crouch: false,
    sprintStamina: 3,
    slideRemaining: 0,
    slideDirX: 0,
    slideDirZ: 0,
    slideForceCrouch: false,
    prevInputCrouch: false,
    lastLandedAtTick: null,
    poseHistory: [],
    health: 100,
    maxHealth: 100,
    alive: true,
    spawnedAtTick: 0,
    diedAtTick: null,
    enemyDoorSinceTick: null,
    hitSlowStacks: 0,
    hitSlowEndsAtTick: 0,
    weaponId: 0,
    weaponLoadouts: [
      { weaponId: 0, ammoInMag: 12, spareClips: 3 },
      { weaponId: 1, ammoInMag: 30, spareClips: 2 },
    ],
    reloadEndsAtTick: null,
    weaponSwitchEndsAtTick: null,
    lastShotAtTick: null,
    lastMeleeAtTick: null,
    pausedReloadRemainingTicks: {},
    unlimitedAmmo: false,
    abilityEndsAtTick: {},
    abilityFxOrigin: {},
    abilitySpent: {},
    abilityGlobalLockEndsAtTick: null,
    abilityBarRegenEndsAtTick: null,
    abilityDoorRegenEndsAtTick: null,
    abilityNoSpendOnEnd: {},
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
    score: 0,
    kills: 0,
    deaths: 0,
    xp: 0,
    ...overrides,
  };
}

function view(
  overrides: Partial<ReplayViewState> & {
    players?: readonly CheckpointPlayerState[];
  } = {},
): ReplayViewState {
  return {
    tick: 10,
    players: overrides.players ?? [playerRow({ id: "p1" })],
    scores: { A: 1, B: 2 },
    phase: "live",
    doorsOpen: true,
    doorChangeTick: 100,
    matchEndTick: 1000,
    projectiles: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Runner fixtures (copied style from 12.1)
// ---------------------------------------------------------------------------

const miniMap: DoorsMap = {
  name: "replay-fp-camera",
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
      runtimeMatchId: "rt-fp-camera-1",
      serverName: "fp-camera-test",
      serverId: "srv-fp-camera",
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

function liveCapturedSession(opts?: {
  seed?: number;
  ticks?: number;
  withBot?: boolean;
  leaveAt?: { playerId: string; tick: number };
}): {
  session: ReplayRunSession;
  collision: MapCollision;
} {
  const seed = opts?.seed ?? 0xc4e2;
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
    const tickEvents: AuthoritativeEvent[] = [];
    if (opts?.leaveAt && tick === opts.leaveAt.tick) {
      live.remove(opts.leaveAt.playerId);
      live.drainAuthoritativeEvents();
      tickEvents.push(
        makePlayerRemoveEvent(tick, opts.leaveAt.playerId),
      );
    }

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
    events.set(tick, tickEvents);

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

  return { session, collision };
}

function clockSlice(playback: ReplayPlayback) {
  return {
    currentTick: playback.state.currentTick,
    firstTick: playback.state.firstTick,
    lastTick: playback.state.lastTick,
    isEnded: playback.state.isEnded,
    isPaused: playback.state.isPaused,
    speed: playback.state.speed,
    replayTimeMs: playback.state.replayTimeMs,
    carryMs: playback.state.carryMs,
  };
}

function snapshotFingerprint(packet: SnapshotPacket | null): string {
  if (!packet) return "null";
  return JSON.stringify({
    tick: packet.tick,
    scores: packet.scores,
    players: packet.players.map((p) => ({
      id: p.id,
      x: p.x,
      y: p.y,
      z: p.z,
      yaw: p.yaw,
      pitch: p.pitch,
      health: p.health,
      alive: p.alive,
    })),
  });
}

function poseFromFeed(feed: ReplayRenderFeedState): CameraPose {
  return firstPersonCamera({ kind: "feed", feed });
}

// ---------------------------------------------------------------------------
// Eye equivalence
// ---------------------------------------------------------------------------

Deno.test("12.2 eyes: 11.5 prev==local accum=0 + viewOffset matches live formula", () => {
  const feed = literalFeed({
    localSim: { x: 4, y: 1.6, z: -2 },
    prevSim: { x: 4, y: 1.6, z: -2 },
    localSimAccum: 0,
    localSimDt: TICK_MS,
    viewOffset: { x: 0, y: 0.3, z: 0 },
    yaw: 1.1,
    pitch: -0.2,
  });
  const pose = poseFromFeed(feed);
  const live = liveRenderCameraFromSimLayers(
    feed.prevSim,
    feed.localSim,
    feed.localSimAccum,
    feed.localSimDt,
    feed.viewOffset,
  );
  assertStrictEquals(pose.x, live.x);
  assertStrictEquals(pose.y, live.y);
  assertStrictEquals(pose.z, live.z);
  assertStrictEquals(pose.y, 1.6 + 0.3);
  assertEquals(pose.presence, "present");
});

Deno.test("12.2 eyes: accum>0 lerp branch matches live formula", () => {
  const feed = literalFeed({
    localSim: { x: 10, y: 2, z: 4 },
    prevSim: { x: 0, y: 0, z: 0 },
    localSimAccum: 0.5,
    localSimDt: 1,
    viewOffset: { x: 0.1, y: 0.2, z: -0.1 },
    yaw: 0.5,
    pitch: 0.1,
  });
  const pose = poseFromFeed(feed);
  const live = liveRenderCameraFromSimLayers(
    feed.prevSim,
    feed.localSim,
    feed.localSimAccum,
    feed.localSimDt,
    feed.viewOffset,
  );
  assertStrictEquals(pose.x, live.x);
  assertStrictEquals(pose.y, live.y);
  assertStrictEquals(pose.z, live.z);
  assertStrictEquals(pose.x, 5.1);
  assertStrictEquals(pose.y, 1.2);
  assertStrictEquals(pose.z, 1.9);
});

// ---------------------------------------------------------------------------
// Orientation
// ---------------------------------------------------------------------------

Deno.test("12.2 orientation: feed yaw/pitch copied exactly; no extra blend", () => {
  const feed = literalFeed({ yaw: 1.2345, pitch: -0.6789 });
  const pose = poseFromFeed(feed);
  assertStrictEquals(pose.yaw, 1.2345);
  assertStrictEquals(pose.pitch, -0.6789);
});

Deno.test("12.2 orientation: missing yaw/pitch fails loud", () => {
  const missing = {
    localSim: { x: 1, y: 2, z: 3 },
    prevSim: { x: 1, y: 2, z: 3 },
    localSimAccum: 0,
    localSimDt: TICK_MS,
    viewOffset: { x: 0, y: 0, z: 0 },
  } as ReplayRenderFeedState;
  assertCameraCode(
    () => firstPersonCamera({ kind: "feed", feed: missing }),
    "replay-spectator-camera-orientation-missing",
  );

  const nanYaw = literalFeed({ yaw: Number.NaN, pitch: 0 });
  assertCameraCode(
    () => firstPersonCamera({ kind: "feed", feed: nanYaw }),
    "replay-spectator-camera-orientation-missing",
  );
});

Deno.test("12.2 Q4A: projectReplayRenderFeed yaw/pitch match 11.4 pose", () => {
  const prev = view({
    tick: 10,
    players: [
      playerRow({
        id: "p1",
        x: 0,
        z: 0,
        yaw: 0,
        pitch: 0,
        y: moveEyeHeight(false),
      }),
    ],
  });
  const next = view({
    tick: 11,
    players: [
      playerRow({
        id: "p1",
        x: 4,
        z: 8,
        yaw: Math.PI / 2,
        pitch: 0.2,
        y: moveEyeHeight(false),
      }),
    ],
  });
  const u = 0.5;
  const feed = projectReplayRenderFeed(prev, next, "p1", u)!;
  const pairs = extractReplayInterpPairs(prev, next);
  const blended = interpolateReplayPose(
    pairs[0]!.prev as ReplayInterpPose,
    pairs[0]!.next as ReplayInterpPose,
    u,
  );
  assertStrictEquals(feed.yaw, blended.pose.yaw);
  assertStrictEquals(feed.pitch, blended.pose.pitch);
  assertEquals(isRenderFeedShaped(feed), true);
  const pose = poseFromFeed(feed);
  assertStrictEquals(pose.yaw, feed.yaw);
  assertStrictEquals(pose.pitch, feed.pitch);
});

// ---------------------------------------------------------------------------
// Dead ≠ absent
// ---------------------------------------------------------------------------

Deno.test("12.2 dead-but-present: current feed + eliminated; not lastPose", () => {
  const lastPose: CameraPose = Object.freeze({
    x: 99,
    y: 99,
    z: 99,
    yaw: 3,
    pitch: 1,
    presence: "present",
  });
  const feed = literalFeed({
    localSim: { x: 7, y: 2, z: 9 },
    prevSim: { x: 7, y: 2, z: 9 },
    viewOffset: { x: 0, y: 0.1, z: 0 },
    yaw: 0.4,
    pitch: -0.1,
    alive: false,
  });
  const pose = poseFromFeed(feed);
  assertEquals(pose.presence, "eliminated");
  assertStrictEquals(pose.x, 7);
  assertStrictEquals(pose.y, 2.1);
  assertStrictEquals(pose.z, 9);
  assertNotEquals(pose.x, lastPose.x);
});

Deno.test("12.2 dead-but-present: 11.5 exact-T corpse feed is eliminated", () => {
  const v = view({
    players: [
      playerRow({
        id: "p1",
        x: 5,
        y: 1.6,
        z: 8,
        yaw: 0.3,
        pitch: -0.05,
        alive: false,
      }),
    ],
  });
  const feed = projectReplayRenderFeed(v, null, "p1", 0)!;
  assertEquals(feed.alive, false);
  const pose = poseFromFeed(feed);
  assertEquals(pose.presence, "eliminated");
  assertStrictEquals(pose.x, 5);
  assertStrictEquals(pose.z, 8);
  assertStrictEquals(pose.yaw, 0.3);
});

// ---------------------------------------------------------------------------
// Absent hold
// ---------------------------------------------------------------------------

Deno.test("12.2 absent: hold last pose; never zero; presence absent", () => {
  const last = poseFromFeed(literalFeed({
    localSim: { x: 2, y: 3, z: 4 },
    yaw: 0.8,
    pitch: -0.25,
  }));
  const held = firstPersonCamera({ kind: "absent", lastPose: last });
  assertEquals(held.presence, "absent");
  assertStrictEquals(held.x, last.x);
  assertStrictEquals(held.y, last.y);
  assertStrictEquals(held.z, last.z);
  assertStrictEquals(held.yaw, last.yaw);
  assertStrictEquals(held.pitch, last.pitch);
  assertNotEquals(held.x, 0);
});

Deno.test("12.2 absent without last pose fails loud; never origin", () => {
  const err = assertCameraCode(
    () =>
      firstPersonCamera({
        kind: "absent",
        lastPose: null as unknown as CameraPose,
      }),
    "replay-spectator-camera-absent-without-pose",
  );
  assertEquals(err.message.includes("last CameraPose"), true);
});

Deno.test("12.2 absent: runner leave keeps feeders + focus; FP holds last", () => {
  const { session, collision } = liveCapturedSession({
    ticks: 6,
    leaveAt: { playerId: "b1", tick: 4 },
  });
  const playback = createReplayPlayback(session, {
    collision,
    focusedPlayerId: "b1",
  });
  playback.start();
  playback.frame(TICK_MS);
  playback.frame(TICK_MS);
  playback.frame(TICK_MS);
  playback.frame(TICK_MS); // leave tick — still projectable
  const lastFeed = playback.feeders.render();
  if (lastFeed === null) throw new Error("expected last successful feed");
  const lastPose = poseFromFeed(lastFeed);
  const err = assertThrows(
    () => playback.frame(TICK_MS),
    ReplayStateAccessError,
  );
  assertEquals(err.code, "replay-state-focus-unknown");
  assertEquals(playback.state.focusedPlayerId, "b1");
  assertEquals(playback.feeders.render(), lastFeed);
  const held = firstPersonCamera({ kind: "absent", lastPose });
  assertEquals(held.presence, "absent");
  assertStrictEquals(held.x, lastPose.x);
  assertStrictEquals(held.y, lastPose.y);
  assertStrictEquals(held.z, lastPose.z);
  assertNotEquals(held.x, 0);
  assertNotEquals(held.y, 0);
});

// ---------------------------------------------------------------------------
// Switch + end-hold (runner)
// ---------------------------------------------------------------------------

Deno.test("12.2 switch: new feed eyes immediately; clock unchanged", () => {
  const { session, collision } = liveCapturedSession({ ticks: 6 });
  const playback = createReplayPlayback(session, {
    collision,
    focusedPlayerId: "h1",
  });
  playback.start();
  for (let i = 0; i < 3; i++) playback.frame(TICK_MS);
  const before = clockSlice(playback);
  const h1Feed = playback.feeders.render()!;
  const h1Pose = poseFromFeed(h1Feed);
  playback.setFocusedPlayerId("b1");
  assertEquals(clockSlice(playback), before);
  assertEquals(playback.state.focusedPlayerId, "b1");
  const b1Feed = playback.feeders.render()!;
  const b1Pose = poseFromFeed(b1Feed);
  assertNotEquals(b1Pose.x, h1Pose.x);
  assertStrictEquals(b1Pose.x, b1Feed.localSim.x + b1Feed.viewOffset.x);
  assertEquals(b1Pose.presence, b1Feed.alive === false ? "eliminated" : "present");
});

Deno.test("12.2 end-hold: last tick is feed present/eliminated, not absent", () => {
  const { session, collision } = liveCapturedSession({ ticks: 4 });
  const playback = createReplayPlayback(session, {
    collision,
    focusedPlayerId: "h1",
  });
  playback.start();
  while (!playback.state.isEnded) {
    playback.frame(TICK_MS);
  }
  assertEquals(playback.state.isEnded, true);
  const feed = playback.feeders.render();
  if (feed === null) throw new Error("end-hold must keep a feed");
  const pose = poseFromFeed(feed);
  assertEquals(pose.presence === "present" || pose.presence === "eliminated", true);
  assertEquals(Number.isFinite(pose.x), true);
});

Deno.test("12.2 present: runner feed pose is frozen and copies numbers", () => {
  const { session, collision } = liveCapturedSession({ ticks: 3 });
  const playback = createReplayPlayback(session, {
    collision,
    focusedPlayerId: "h1",
  });
  playback.start();
  playback.frame(TICK_MS);
  const feed = playback.feeders.render()!;
  const pose = poseFromFeed(feed);
  assertEquals(Object.isFrozen(pose), true);
  assertEquals(pose.fov, undefined);
});

// ---------------------------------------------------------------------------
// Non-interference + shifted wall clock
// ---------------------------------------------------------------------------

Deno.test("12.2 non-interference: posing every tick ≡ never-observed snapshots", () => {
  const ticks = 6;
  const observed = liveCapturedSession({ ticks, seed: 0x51e2 });
  const control = liveCapturedSession({ ticks, seed: 0x51e2 });

  const watching = createReplayPlayback(observed.session, {
    collision: observed.collision,
    focusedPlayerId: "h1",
  });
  const quiet = createReplayPlayback(control.session, {
    collision: control.collision,
    focusedPlayerId: "h1",
  });
  watching.start();
  quiet.start();

  const watched: string[] = [];
  const untouched: string[] = [];
  let lastPose: CameraPose | null = null;
  for (let i = 0; i < ticks; i++) {
    watching.frame(TICK_MS);
    quiet.frame(TICK_MS);
    if (i % 2 === 0) watching.setFocusedPlayerId("b1");
    else watching.setFocusedPlayerId("h1");
    const feed = watching.feeders.render();
    if (feed) lastPose = poseFromFeed(feed);
    watched.push(snapshotFingerprint(watching.feeders.state()));
    untouched.push(snapshotFingerprint(quiet.feeders.state()));
  }
  assertEquals(watched, untouched);
  if (lastPose === null) throw new Error("expected at least one pose");

  const direct = createReplayRunner(control.session, {
    collision: makeCollision(),
  });
  direct.resetToInitial();
  const digest: string[] = [];
  for (
    let tick = control.session.firstTick;
    tick <= control.session.lastTick;
    tick++
  ) {
    const out = direct.step(tick);
    digest.push(JSON.stringify({
      tick: out.tick,
      scores: out.scores,
      roster: out.rosterDigest,
      deaths: out.overlapDeaths.length,
      respawned: out.respawnedIds,
      gameOver: out.gameOver,
    }));
  }
  const direct2 = createReplayRunner(observed.session, {
    collision: makeCollision(),
  });
  direct2.resetToInitial();
  const digest2: string[] = [];
  for (
    let tick = observed.session.firstTick;
    tick <= observed.session.lastTick;
    tick++
  ) {
    const out = direct2.step(tick);
    digest2.push(JSON.stringify({
      tick: out.tick,
      scores: out.scores,
      roster: out.rosterDigest,
      deaths: out.overlapDeaths.length,
      respawned: out.respawnedIds,
      gameOver: out.gameOver,
    }));
  }
  assertEquals(digest, digest2);
});

Deno.test("12.2 shifted-wall-clock: identical CameraPose", () => {
  const feed = literalFeed({ yaw: 0.9, pitch: 0.1 });
  const a = poseFromFeed(feed);
  const b = poseFromFeed(feed);
  assertEquals(a, b);
});

// ---------------------------------------------------------------------------
// Purity / isolation source scan
// ---------------------------------------------------------------------------

Deno.test("12.2 source-scan: pure module has no THREE/DOM/clock/sim/io", async () => {
  const src = await Deno.readTextFile(
    new URL("./spectatorCamera.ts", import.meta.url),
  );
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const banned of [
    "Date.now",
    "performance.now",
    "requestAnimationFrame",
    "setInterval",
    "setTimeout",
    "THREE",
    "document",
    "window",
    "keyboard",
    "ReplayPlayback",
    "createReplayPlayback",
    "replayPlaybackSession",
    "runner.step",
    "PlayerManager",
    "BotManager",
    "GameServer",
    "MapCollision",
    "interpolateReplayPose",
    "cinematicCameraDelta",
    "applyVisibilityFilter",
    "applyCameraPose",
    "SnapshotPacket",
    "Deno.",
    "node:fs",
    "ReplayBlobStore",
    "createStore",
    'from "../net/',
    'from "./net/',
    "socket.io",
  ]) {
    assertEquals(code.includes(banned), false, `banned token present: ${banned}`);
  }
  assertEquals(src.includes("firstPersonCamera"), true);
  assertEquals(src.includes("CameraPose"), true);
});
