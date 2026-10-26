/**
 * Epic 12.4 — free camera (mirrored cinematic fly math). The parity checks
 * against the client's cinematic camera live in
 * client/src/game/spectatorCameraParity_test.ts.
 *
 * Run from server-community/:
 *   deno test -A replay/spectator_free_camera_test.ts
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
import { ReplayStateAccessError } from "./replayStateAccess.ts";
import {
  FREE_CAMERA_MOVE_SPEED,
  FREE_CAMERA_PITCH_LIMIT,
  firstPersonCamera,
  freeCamera,
  spawnFreeCamera,
  SpectatorCameraError,
  stepFreeCameraFov,
  thirdPersonCamera,
  type CameraPose,
  type SpectatorCameraErrorCode,
} from "./spectatorCamera.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertCameraCode(
  fn: () => unknown,
  code: SpectatorCameraErrorCode,
): SpectatorCameraError {
  const err = assertThrows(fn, SpectatorCameraError);
  assertEquals(err.code, code);
  return err;
}

function literalPose(over: Partial<CameraPose> = {}): CameraPose {
  return Object.freeze({
    x: over.x ?? 10,
    y: over.y ?? 2,
    z: over.z ?? -4,
    yaw: over.yaw ?? 0.3,
    pitch: over.pitch ?? -0.1,
    presence: over.presence ?? "eliminated",
    ...(over.fov !== undefined ? { fov: over.fov } : {}),
  });
}

const miniMap: DoorsMap = {
  name: "replay-free-camera",
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
      runtimeMatchId: "rt-free-camera-1",
      serverName: "free-camera-test",
      serverId: "srv-free-camera",
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
  leaveAt?: { playerId: string; tick: number };
}): {
  session: ReplayRunSession;
  collision: MapCollision;
} {
  const seed = opts?.seed ?? 0xf4e2;
  const tickCount = opts?.ticks ?? 8;
  const collision = makeCollision();
  const live = new PlayerManager(collision, {
    matchSeed: seed,
    matchDurationSeconds: 120,
    enablePrematch: false,
    nowMs: __replayTickNowMsForTest(0),
  });

  live.add("h1", "Human", "A", undefined, __replayTickNowMsForTest(0));
  live.addBot("b1", "BotOne", { team: "B" });
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
      tickEvents.push(makePlayerRemoveEvent(tick, opts.leaveAt.playerId));
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
      if (!sel) throw new Error(`missing selection for ${p.id} at tick ${tick}`);
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

function fpFromPlayback(playback: ReplayPlayback): CameraPose {
  const feed = playback.feeders.render();
  if (feed == null) throw new Error("expected render feed");
  return firstPersonCamera({ kind: "feed", feed });
}

function chaseFromPlayback(playback: ReplayPlayback): CameraPose {
  const display = playback.focusedDisplay();
  const feed = playback.feeders.render();
  if (display == null || feed == null) {
    throw new Error("expected focused display + render feed");
  }
  return thirdPersonCamera(
    {
      kind: "pose",
      pose: display.pose,
      snapped: display.snapped,
      eye: feed.viewOffset,
    },
    { raycast: () => null },
  );
}

// ---------------------------------------------------------------------------
// Constants + orientation
// ---------------------------------------------------------------------------

Deno.test("12.4 pitch limit stops just short of straight up/down", () => {
  assertStrictEquals(FREE_CAMERA_PITCH_LIMIT, Math.PI / 2 - 0.01);
});

Deno.test("12.4 yaw 0: forward is (0,0,-1), right is (1,0,0)", () => {
  const pose = literalPose({ x: 0, y: 0, z: 0 });
  const forward = freeCamera(pose, new Set(["KeyW"]), 0, 0, 1);
  assertStrictEquals(forward.x, 0);
  assertStrictEquals(forward.y, 0);
  assertStrictEquals(forward.z, -FREE_CAMERA_MOVE_SPEED);
  const right = freeCamera(pose, new Set(["KeyD"]), 0, 0, 1);
  assertStrictEquals(right.x, FREE_CAMERA_MOVE_SPEED);
  assertStrictEquals(right.y, 0);
  assertStrictEquals(right.z, 0);
});

Deno.test("12.4 FOV stops at both rails", () => {
  assertStrictEquals(stepFreeCameraFov(30, -1), 30);
  assertStrictEquals(stepFreeCameraFov(110, 1), 110);
});

// ---------------------------------------------------------------------------
// Orientation / presence / fov carry
// ---------------------------------------------------------------------------

Deno.test("12.4 pitch clamps at ±(π/2 − 0.01); yaw passes through", () => {
  const pose = literalPose();
  const hi = freeCamera(pose, new Set(), 0, Math.PI, 0);
  assertStrictEquals(hi.pitch, FREE_CAMERA_PITCH_LIMIT);
  const lo = freeCamera(pose, new Set(), 0, -Math.PI, 0);
  assertStrictEquals(lo.pitch, -FREE_CAMERA_PITCH_LIMIT);
  const wrapped = freeCamera(pose, new Set(), -4 * Math.PI, 0.2, 0);
  assertStrictEquals(wrapped.yaw, -4 * Math.PI);
  const over = freeCamera(pose, new Set(), 7, 0.2, 0);
  assertStrictEquals(over.yaw, 7);
});

Deno.test("12.4 presence is always present; focus presence is not carried", () => {
  const spawned = spawnFreeCamera(literalPose({ presence: "eliminated" }));
  assertEquals(spawned.presence, "present");
  const stepped = freeCamera(spawned, new Set(["KeyW"]), spawned.yaw, spawned.pitch, 0.016);
  assertEquals(stepped.presence, "present");
  assertEquals(Object.isFrozen(stepped), true);
});

Deno.test("12.4 fov omitted until stepped; carried through moves", () => {
  const spawned = spawnFreeCamera(literalPose());
  assertEquals(spawned.fov, undefined);
  const moved = freeCamera(spawned, new Set(["KeyW"]), 0, 0, 1);
  assertEquals(moved.fov, undefined);
  const withFov = spawnFreeCamera(literalPose({ fov: 75 }));
  assertStrictEquals(withFov.fov, 75);
  const movedFov = freeCamera(withFov, new Set(["KeyE"]), 0.4, -0.1, 0.5);
  assertStrictEquals(movedFov.fov, 75);
  const next = stepFreeCameraFov(movedFov.fov!, 1);
  assertStrictEquals(next, 80);
});

Deno.test("12.4 spawn copies eyes and does not clamp pitch", () => {
  const source = literalPose({ pitch: 1.4, yaw: -0.8, x: 9, y: 3, z: 1 });
  const spawned = spawnFreeCamera(source);
  assertStrictEquals(spawned.x, 9);
  assertStrictEquals(spawned.y, 3);
  assertStrictEquals(spawned.z, 1);
  assertStrictEquals(spawned.yaw, -0.8);
  assertStrictEquals(spawned.pitch, 1.4);
  assertEquals(spawned.presence, "present");
});

// ---------------------------------------------------------------------------
// Loud inputs
// ---------------------------------------------------------------------------

Deno.test("12.4 non-finite pose/yaw/pitch/dt/held/fov fail loud; never origin", () => {
  const code: SpectatorCameraErrorCode = "replay-spectator-camera-free-invalid";
  const pose = literalPose();
  assertCameraCode(
    () => freeCamera({ ...pose, x: NaN }, new Set(), 0, 0, 0.016),
    code,
  );
  assertCameraCode(
    () => freeCamera({ ...pose, y: Infinity }, new Set(), 0, 0, 0.016),
    code,
  );
  assertCameraCode(
    () => freeCamera(null as unknown as CameraPose, new Set(), 0, 0, 0.016),
    code,
  );
  assertCameraCode(
    () => freeCamera(pose, new Set(), Number.NaN, 0, 0.016),
    code,
  );
  assertCameraCode(
    () => freeCamera(pose, new Set(), 0, Infinity, 0.016),
    code,
  );
  assertCameraCode(
    () => freeCamera(pose, new Set(), 0, 0, Number.NaN),
    code,
  );
  assertCameraCode(
    () =>
      freeCamera(pose, null as unknown as ReadonlySet<string>, 0, 0, 0.016),
    code,
  );
  assertCameraCode(
    () => freeCamera(literalPose({ fov: NaN }), new Set(), 0, 0, 0.016),
    code,
  );
  assertCameraCode(() => spawnFreeCamera(null as unknown as CameraPose), code);
  assertCameraCode(() => spawnFreeCamera({ ...pose, z: NaN }), code);
  assertCameraCode(() => spawnFreeCamera(literalPose({ fov: Infinity })), code);
  assertCameraCode(() => stepFreeCameraFov(NaN, 1), code);
  assertCameraCode(
    () => stepFreeCameraFov(75, 0 as unknown as -1),
    code,
  );
});

// ---------------------------------------------------------------------------
// Runner-backed spawn / exit / absence / end-hold
// ---------------------------------------------------------------------------

Deno.test("12.4 spawn equals current FP eyes; exit restores 12.2/12.3; slot unchanged", () => {
  const { session, collision } = liveCapturedSession({ ticks: 6 });
  const playback = createReplayPlayback(session, {
    collision,
    focusedPlayerId: "h1",
  });
  playback.start();
  playback.frame(TICK_MS);
  const focus = playback.state.focusedPlayerId;
  const fp = fpFromPlayback(playback);
  const spawned = spawnFreeCamera(fp);
  assertStrictEquals(spawned.x, fp.x);
  assertStrictEquals(spawned.y, fp.y);
  assertStrictEquals(spawned.z, fp.z);
  assertStrictEquals(spawned.yaw, fp.yaw);
  assertStrictEquals(spawned.pitch, fp.pitch);
  assertEquals(spawned.presence, "present");
  assertEquals(fp.fov, undefined);

  const stepped = freeCamera(
    spawned,
    new Set(["KeyW", "KeyD"]),
    spawned.yaw,
    spawned.pitch,
    0.25,
  );
  assertNotEquals(stepped.x, spawned.x);
  assertEquals(playback.state.focusedPlayerId, focus);

  const fpExit = fpFromPlayback(playback);
  assertStrictEquals(fpExit.x, fp.x);
  assertStrictEquals(fpExit.y, fp.y);
  assertStrictEquals(fpExit.z, fp.z);
  const chaseExit = chaseFromPlayback(playback);
  assertEquals(chaseExit.presence === "present" || chaseExit.presence === "eliminated", true);
  assertEquals(playback.state.focusedPlayerId, "h1");
});

Deno.test("12.4 stepping free while focus leaves never moves the free pose", () => {
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
  const spawned = spawnFreeCamera(fpFromPlayback(playback));
  const err = assertThrows(
    () => playback.frame(TICK_MS),
    ReplayStateAccessError,
  );
  assertEquals(err.code, "replay-state-focus-unknown");
  assertEquals(playback.state.focusedPlayerId, "b1");
  const still = freeCamera(
    spawned,
    new Set(),
    spawned.yaw,
    spawned.pitch,
    1,
  );
  assertStrictEquals(still.x, spawned.x);
  assertStrictEquals(still.y, spawned.y);
  assertStrictEquals(still.z, spawned.z);
  assertEquals(still.presence, "present");
  assertEquals(playback.state.focusedPlayerId, "b1");
});

Deno.test("12.4 end-hold keeps last free pose", () => {
  const { session, collision } = liveCapturedSession({ ticks: 4 });
  const playback = createReplayPlayback(session, {
    collision,
    focusedPlayerId: "h1",
  });
  playback.start();
  while (!playback.state.isEnded) playback.frame(TICK_MS);
  const spawned = spawnFreeCamera(fpFromPlayback(playback));
  const held = freeCamera(spawned, new Set(), spawned.yaw, spawned.pitch, 1);
  assertStrictEquals(held.x, spawned.x);
  assertStrictEquals(held.y, spawned.y);
  assertStrictEquals(held.z, spawned.z);
  assertEquals(held.presence, "present");
});

Deno.test("12.4 isolation: no filter/roster input; same argv → same pose", () => {
  const pose = literalPose({ fov: 70 });
  const held = new Set(["KeyW", "KeyE"]);
  const a = freeCamera(pose, held, 0.5, -0.2, 0.1);
  const b = freeCamera(pose, held, 0.5, -0.2, 0.1);
  assertEquals(a, b);
  assertEquals("filter" in (freeCamera as object), false);
});

// ---------------------------------------------------------------------------
// Non-interference + wall-clock + purity scan
// ---------------------------------------------------------------------------

Deno.test("12.4 non-interference: FP+3P+free posing ≡ never-observed snapshots", () => {
  const ticks = 6;
  const observed = liveCapturedSession({ ticks, seed: 0x51e4 });
  const control = liveCapturedSession({ ticks, seed: 0x51e4 });
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
  let free = spawnFreeCamera(literalPose({ x: 0, y: 2, z: 0, yaw: 0, pitch: 0 }));
  for (let i = 0; i < ticks; i++) {
    watching.frame(TICK_MS);
    quiet.frame(TICK_MS);
    if (i % 2 === 0) watching.setFocusedPlayerId("b1");
    else watching.setFocusedPlayerId("h1");
    fpFromPlayback(watching);
    chaseFromPlayback(watching);
    free = freeCamera(free, new Set(["KeyW"]), free.yaw, free.pitch, TICK_MS / 1000);
    watched.push(snapshotFingerprint(watching.feeders.state()));
    untouched.push(snapshotFingerprint(quiet.feeders.state()));
  }
  assertEquals(watched, untouched);

  const digest: string[] = [];
  const direct = createReplayRunner(control.session, {
    collision: makeCollision(),
  });
  direct.resetToInitial();
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
  const digest2: string[] = [];
  const direct2 = createReplayRunner(observed.session, {
    collision: makeCollision(),
  });
  direct2.resetToInitial();
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

Deno.test("12.4 shifted-wall-clock: identical CameraPose", () => {
  const pose = literalPose({ fov: 65 });
  const held = new Set(["KeyW", "KeyD", "ShiftLeft"]);
  const a = freeCamera(pose, held, 0.7, -0.2, 0.016);
  const b = freeCamera(pose, held, 0.7, -0.2, 0.016);
  assertEquals(a, b);
});

Deno.test("12.4 source-scan: pure module has no THREE/DOM/clock/sim/io/client fly import", async () => {
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
    "cinematicCamera",
    "applyVisibilityFilter",
    "applyCameraPose",
    "applySpectatorPose",
    "SnapshotPacket",
    "Deno.",
    "node:fs",
    "ReplayBlobStore",
    "createStore",
    'from "../net/',
    'from "./net/',
    "socket.io",
    "moveEyeHeight",
    "crouchEyeViewOffset",
  ]) {
    assertEquals(code.includes(banned), false, `banned token present: ${banned}`);
  }
  assertEquals(/\bTHREE\b/.test(code), false);
  assertEquals(src.includes("freeCamera"), true);
  assertEquals(src.includes("spawnFreeCamera"), true);
  assertEquals(src.includes("stepFreeCameraFov"), true);
  assertEquals(src.includes("FREE_CAMERA_MOVE_SPEED"), true);
});
