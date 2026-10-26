/**
 * Epic 12.3 — third-person camera + Q1A focused display feeder.
 *
 * Run from server-community/:
 *   deno test -A replay/spectator_third_person_test.ts
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
import type { CheckpointPlayerState } from "./authoritativeCheckpoint.ts";
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
  interpolateReplayRoster,
  REPLAY_INTERP_SNAP_DISTANCE,
  type ReplayInterpPose,
} from "./replayInterpolation.ts";
import {
  ReplayStateAccessError,
  extractReplayInterpPairs,
  projectReplayFocusedDisplay,
  type ReplayViewState,
} from "./replayStateAccess.ts";
import { moveEyeHeight } from "../shared/sim/moveStep.ts";
import {
  THIRD_PERSON_CLAMP_EPSILON,
  THIRD_PERSON_DISTANCE,
  THIRD_PERSON_HEIGHT,
  THIRD_PERSON_MIN_DISTANCE,
  THIRD_PERSON_SHOULDER,
  firstPersonCamera,
  SpectatorCameraError,
  thirdPersonCamera,
  type CameraPose,
  type SpectatorCameraErrorCode,
  type SpectatorRaycast,
  type ThirdPersonDisplayPose,
  type ThirdPersonEyeDelta,
} from "./spectatorCamera.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noHit: SpectatorRaycast = () => null;

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

function displayPose(
  over: Partial<ThirdPersonDisplayPose> = {},
): ThirdPersonDisplayPose {
  return {
    x: over.x ?? 2,
    y: over.y ?? 1.6,
    z: over.z ?? -4,
    yaw: over.yaw ?? 0,
    pitch: over.pitch ?? -0.2,
    alive: over.alive ?? true,
  };
}

const defaultEye: ThirdPersonEyeDelta = { x: 0, y: 0.25, z: 0 };

function chase(
  pose: ThirdPersonDisplayPose,
  over: {
    snapped?: boolean;
    eye?: ThirdPersonEyeDelta;
    raycast?: SpectatorRaycast;
  } = {},
): CameraPose {
  return thirdPersonCamera(
    {
      kind: "pose",
      pose,
      snapped: over.snapped ?? false,
      eye: over.eye ?? defaultEye,
    },
    { raycast: over.raycast ?? noHit },
  );
}

/** Decision 8 expected tip (independent of camera module internals). */
function expectedTip(
  pose: ThirdPersonDisplayPose,
  eye: ThirdPersonEyeDelta,
): { x: number; y: number; z: number; eyeX: number; eyeY: number; eyeZ: number } {
  const eyeX = pose.x + eye.x;
  const eyeY = pose.y + eye.y;
  const eyeZ = pose.z + eye.z;
  const forwardX = -Math.sin(pose.yaw);
  const forwardZ = -Math.cos(pose.yaw);
  const rightX = Math.cos(pose.yaw);
  const rightZ = -Math.sin(pose.yaw);
  return {
    eyeX,
    eyeY,
    eyeZ,
    x: eyeX - forwardX * THIRD_PERSON_DISTANCE + rightX * THIRD_PERSON_SHOULDER,
    y: eyeY + THIRD_PERSON_HEIGHT,
    z: eyeZ - forwardZ * THIRD_PERSON_DISTANCE + rightZ * THIRD_PERSON_SHOULDER,
  };
}

const miniMap: DoorsMap = {
  name: "replay-tp-camera",
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
      runtimeMatchId: "rt-tp-camera-1",
      serverName: "tp-camera-test",
      serverId: "srv-tp-camera",
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
  const seed = opts?.seed ?? 0xc4e3;
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

function poseFromPlayback(playback: ReplayPlayback): CameraPose {
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
    { raycast: noHit },
  );
}

// ---------------------------------------------------------------------------
// Boom exactness (Decision 8)
// ---------------------------------------------------------------------------

Deno.test("12.3 boom exactness: yaw 0 tip = eye − forward·D + up·H + right·S", () => {
  const pose = displayPose({ x: 3, y: 1.5, z: -1, yaw: 0, pitch: -0.3 });
  const eye = { x: 0, y: 0.2, z: 0 };
  const cam = chase(pose, { eye });
  const tip = expectedTip(pose, eye);
  assertStrictEquals(cam.x, tip.x);
  assertStrictEquals(cam.y, tip.y);
  assertStrictEquals(cam.z, tip.z);
  assertStrictEquals(cam.x, tip.eyeX + THIRD_PERSON_SHOULDER);
  assertStrictEquals(cam.y, tip.eyeY + THIRD_PERSON_HEIGHT);
  assertStrictEquals(cam.z, tip.eyeZ + THIRD_PERSON_DISTANCE);
  assertStrictEquals(cam.yaw, pose.yaw);
  assertStrictEquals(cam.pitch, pose.pitch);
  assertEquals(cam.presence, "present");
  assertEquals(cam.fov, undefined);
});

Deno.test("12.3 boom exactness: yaw π/3 uses Decision 8 forward/right", () => {
  const yaw = Math.PI / 3;
  const pose = displayPose({ x: 1, y: 2, z: 3, yaw, pitch: 0.15 });
  const cam = chase(pose);
  const tip = expectedTip(pose, defaultEye);
  assertStrictEquals(cam.x, tip.x);
  assertStrictEquals(cam.y, tip.y);
  assertStrictEquals(cam.z, tip.z);
  assertStrictEquals(cam.yaw, yaw);
  assertStrictEquals(cam.pitch, 0.15);
  // yaw 0 would put shoulder on +X; π/3 must not.
  const yaw0 = expectedTip({ ...pose, yaw: 0 }, defaultEye);
  assertNotEquals(cam.x, yaw0.x);
});

Deno.test("12.3 shoulder space: nonzero SHOULDER is player-local right, not world X", () => {
  const yaw = Math.PI / 3;
  const pose = displayPose({ x: 0, y: 0, z: 0, yaw, pitch: 0 });
  const eye = { x: 0, y: 0, z: 0 };
  const cam = chase(pose, { eye });
  const rightX = Math.cos(yaw);
  const rightZ = -Math.sin(yaw);
  const forwardX = -Math.sin(yaw);
  const forwardZ = -Math.cos(yaw);
  const expectX = -forwardX * THIRD_PERSON_DISTANCE + rightX * THIRD_PERSON_SHOULDER;
  const expectZ = -forwardZ * THIRD_PERSON_DISTANCE + rightZ * THIRD_PERSON_SHOULDER;
  assertStrictEquals(cam.x, expectX);
  assertStrictEquals(cam.z, expectZ);
  assertNotEquals(cam.x, THIRD_PERSON_SHOULDER);
});

// ---------------------------------------------------------------------------
// Clamp
// ---------------------------------------------------------------------------

Deno.test("12.3 clamp: hit at d shortens boom to d − epsilon; null → full boom", () => {
  const pose = displayPose({ yaw: 0 });
  const eye = defaultEye;
  const tip = expectedTip(pose, eye);
  const boomLen = Math.hypot(tip.x - tip.eyeX, tip.y - tip.eyeY, tip.z - tip.eyeZ);
  const d = boomLen * 0.4;
  const calls: {
    origin: { x: number; y: number; z: number };
    dir: { x: number; y: number; z: number };
    maxRange: number;
  }[] = [];
  const raycast: SpectatorRaycast = (origin, dir, maxRange) => {
    calls.push({ origin: { ...origin }, dir: { ...dir }, maxRange });
    return d;
  };
  const cam = chase(pose, { eye, raycast });
  assertEquals(calls.length, 1);
  assertStrictEquals(calls[0]!.origin.x, tip.eyeX);
  assertStrictEquals(calls[0]!.origin.y, tip.eyeY);
  assertStrictEquals(calls[0]!.origin.z, tip.eyeZ);
  assertStrictEquals(calls[0]!.maxRange, boomLen);
  const dirLen = Math.hypot(
    calls[0]!.dir.x,
    calls[0]!.dir.y,
    calls[0]!.dir.z,
  );
  assertEquals(Math.abs(dirLen - 1) < 1e-12, true);
  assertStrictEquals(
    calls[0]!.dir.x,
    (tip.x - tip.eyeX) / boomLen,
  );
  const length = d - THIRD_PERSON_CLAMP_EPSILON;
  assertStrictEquals(cam.x, tip.eyeX + calls[0]!.dir.x * length);
  assertStrictEquals(cam.y, tip.eyeY + calls[0]!.dir.y * length);
  assertStrictEquals(cam.z, tip.eyeZ + calls[0]!.dir.z * length);

  const full = chase(pose, { eye, raycast: noHit });
  assertStrictEquals(full.x, tip.x);
  assertStrictEquals(full.y, tip.y);
  assertStrictEquals(full.z, tip.z);
});

Deno.test("12.3 clamp: hit nearer than MIN_DISTANCE floors at MIN_DISTANCE", () => {
  const pose = displayPose({ yaw: 0 });
  const cam = chase(pose, { raycast: () => 0.05 });
  const tip = expectedTip(pose, defaultEye);
  const boomLen = Math.hypot(tip.x - tip.eyeX, tip.y - tip.eyeY, tip.z - tip.eyeZ);
  const dirX = (tip.x - tip.eyeX) / boomLen;
  const dirY = (tip.y - tip.eyeY) / boomLen;
  const dirZ = (tip.z - tip.eyeZ) / boomLen;
  assertStrictEquals(cam.x, tip.eyeX + dirX * THIRD_PERSON_MIN_DISTANCE);
  assertStrictEquals(cam.y, tip.eyeY + dirY * THIRD_PERSON_MIN_DISTANCE);
  assertStrictEquals(cam.z, tip.eyeZ + dirZ * THIRD_PERSON_MIN_DISTANCE);
});

Deno.test("12.3 missing raycast fails loud", () => {
  assertCameraCode(
    () =>
      thirdPersonCamera(
        { kind: "pose", pose: displayPose(), snapped: false, eye: defaultEye },
        { raycast: null as unknown as SpectatorRaycast },
      ),
    "replay-spectator-camera-raycast-missing",
  );
});

Deno.test("12.3 invalid display pose fails loud", () => {
  assertCameraCode(
    () =>
      chase({ ...displayPose(), x: Number.NaN }),
    "replay-spectator-camera-display-missing",
  );
});

// ---------------------------------------------------------------------------
// Q1A feeder
// ---------------------------------------------------------------------------

Deno.test("12.3 Q1A: both-present bit-exact with extract pairs + interpolateReplayPose", () => {
  const prev = view({
    tick: 10,
    players: [
      playerRow({ id: "p1", x: 0, z: 0, yaw: 0, pitch: 0 }),
    ],
  });
  const next = view({
    tick: 11,
    players: [
      playerRow({
        id: "p1",
        x: 0.4,
        z: 0.8,
        yaw: Math.PI / 2,
        pitch: 0.2,
      }),
    ],
  });
  const u = 0.5;
  const display = projectReplayFocusedDisplay(prev, next, "p1", u)!;
  const pairs = extractReplayInterpPairs(prev, next);
  const blended = interpolateReplayPose(
    pairs[0]!.prev as ReplayInterpPose,
    pairs[0]!.next as ReplayInterpPose,
    u,
  );
  assertEquals(display.pose, blended.pose);
  assertEquals(display.snapped, blended.snapped);
  assertEquals(display.snapped, false);
});

Deno.test("12.3 Q1A: snapped matches 11.4 on death-toggle, respawn, teleport, join/leave", () => {
  const u = 0.5;
  const base = playerRow({ id: "p1", x: 0, z: 0, alive: true, spawnedAtTick: 1 });
  const death = projectReplayFocusedDisplay(
    view({ players: [base] }),
    view({ players: [{ ...base, alive: false, diedAtTick: 11, health: 0 }] }),
    "p1",
    u,
  )!;
  assertEquals(death.snapped, true);
  assertEquals(death.pose.alive, false);

  const respawn = projectReplayFocusedDisplay(
    view({ players: [{ ...base, alive: false, diedAtTick: 5 }] }),
    view({
      players: [{ ...base, alive: true, spawnedAtTick: 12, diedAtTick: null }],
    }),
    "p1",
    u,
  )!;
  assertEquals(respawn.snapped, true);
  assertEquals(respawn.pose.spawnedAtTick, 12);

  const far = projectReplayFocusedDisplay(
    view({ players: [base] }),
    view({
      players: [{ ...base, x: REPLAY_INTERP_SNAP_DISTANCE + 1.5, z: 0 }],
    }),
    "p1",
    u,
  )!;
  assertEquals(far.snapped, true);

  const leavePrev = view({
    players: [base, playerRow({ id: "p2", x: 9, z: 9 })],
  });
  const leaveNext = view({ players: [base] });
  const leave = projectReplayFocusedDisplay(leavePrev, leaveNext, "p2", u)!;
  const rosterLeave = interpolateReplayRoster(
    {
      poses: leavePrev.players.map((p) =>
        interpolateReplayPose(
          // identity copy via 11.4 at u=0
          {
            id: p.id,
            x: p.x,
            y: p.y,
            z: p.z,
            yaw: p.yaw,
            pitch: p.pitch,
            alive: p.alive,
            spawnedAtTick: p.spawnedAtTick,
            diedAtTick: p.diedAtTick,
            crouch: p.crouch,
            onGround: p.onGround,
          },
          {
            id: p.id,
            x: p.x,
            y: p.y,
            z: p.z,
            yaw: p.yaw,
            pitch: p.pitch,
            alive: p.alive,
            spawnedAtTick: p.spawnedAtTick,
            diedAtTick: p.diedAtTick,
            crouch: p.crouch,
            onGround: p.onGround,
          },
          0,
        ).pose
      ),
    },
    {
      poses: leaveNext.players.map((p) => ({
        id: p.id,
        x: p.x,
        y: p.y,
        z: p.z,
        yaw: p.yaw,
        pitch: p.pitch,
        alive: p.alive,
        spawnedAtTick: p.spawnedAtTick,
        diedAtTick: p.diedAtTick,
        crouch: p.crouch,
        onGround: p.onGround,
      })),
    },
    u,
  );
  const leaveHit = rosterLeave.poses.find((p) => p.pose.id === "p2")!;
  assertEquals(leave.snapped, true);
  assertEquals(leave.pose.x, leaveHit.pose.x);
  assertEquals(leave.pose.z, 9);

  const join = projectReplayFocusedDisplay(
    view({ players: [base] }),
    view({ players: [base, playerRow({ id: "p2", x: 5, z: 7, yaw: 1 })] }),
    "p2",
    u,
  )!;
  assertEquals(join.snapped, true);
  assertEquals(join.pose.x, 5);
  assertEquals(join.pose.z, 7);
  assertEquals(join.pose.yaw, 1);
});

Deno.test("12.3 Q1A: unknown focus fails loud", () => {
  const err = assertThrows(
    () => projectReplayFocusedDisplay(view(), view({ tick: 11 }), "ghost", 0.5),
    ReplayStateAccessError,
  );
  assertEquals(err.code, "replay-state-focus-unknown");
});

Deno.test("12.3 Q1A: ReplayPlayback.focusedDisplay matches projector; frame shape unchanged", () => {
  const { session, collision } = liveCapturedSession({ ticks: 4 });
  const playback = createReplayPlayback(session, {
    collision,
    focusedPlayerId: "h1",
  });
  playback.start();
  const result = playback.frame(TICK_MS);
  assertEquals("snapshot" in result, true);
  assertEquals("feed" in result, true);
  assertEquals("display" in result, false);
  assertEquals(isRenderFeedShaped(result.feed), true);
  const display = playback.focusedDisplay();
  if (display == null) throw new Error("expected display");
  assertEquals(typeof display.snapped, "boolean");
  assertEquals(display.pose.id, "h1");
  assertEquals(Number.isFinite(display.pose.yaw), true);
});

// ---------------------------------------------------------------------------
// Cut exactness
// ---------------------------------------------------------------------------

Deno.test("12.3 cut exactness: snapped death→respawn is per-pose, never a lerp", () => {
  const eye = defaultEye;
  const living = displayPose({ x: 1, y: 1.6, z: 2, yaw: 0.2, alive: true });
  const corpse = displayPose({
    x: 1.1,
    y: 1.6,
    z: 2.1,
    yaw: 0.2,
    alive: false,
  });
  const respawned = displayPose({
    x: 20,
    y: 1.6,
    z: -20,
    yaw: 1.5,
    alive: true,
  });
  const pre = chase(living, { snapped: false, eye });
  const dead = chase(corpse, { snapped: true, eye });
  const post = chase(respawned, { snapped: true, eye });
  const deadDirect = chase(corpse, { snapped: true, eye });
  const postDirect = chase(respawned, { snapped: true, eye });
  assertEquals(dead, deadDirect);
  assertEquals(post, postDirect);
  assertNotEquals(dead.x, (pre.x + deadDirect.x) / 2);
  assertNotEquals(post.x, (dead.x + postDirect.x) / 2);
  assertEquals(dead.presence, "eliminated");
  assertEquals(post.presence, "present");
});

Deno.test("12.3 cut exactness: join/leave present-side chase equals per-pose compute", () => {
  const eye = defaultEye;
  const staying = playerRow({ id: "p1", x: 0, z: 0 });
  const leaver = playerRow({ id: "p2", x: 8, z: -3, yaw: 0.7 });
  const leaveDisplay = projectReplayFocusedDisplay(
    view({ players: [staying, leaver] }),
    view({ players: [staying] }),
    "p2",
    0.5,
  )!;
  assertEquals(leaveDisplay.snapped, true);
  const fromFeeder = chase(leaveDisplay.pose, {
    snapped: leaveDisplay.snapped,
    eye,
  });
  const fromLiteral = chase(
    {
      x: leaver.x,
      y: leaver.y,
      z: leaver.z,
      yaw: leaver.yaw,
      pitch: leaver.pitch,
      alive: leaver.alive,
    },
    { snapped: true, eye },
  );
  assertEquals(fromFeeder, fromLiteral);
});

// ---------------------------------------------------------------------------
// Dead ≠ absent
// ---------------------------------------------------------------------------

Deno.test("12.3 dead-but-present: current pose + eliminated; not lastPose", () => {
  const lastPose: CameraPose = Object.freeze({
    x: 99,
    y: 99,
    z: 99,
    yaw: 3,
    pitch: 1,
    presence: "present",
  });
  const pose = displayPose({ x: 7, y: 2, z: 9, yaw: 0.4, pitch: -0.1, alive: false });
  const cam = chase(pose);
  assertEquals(cam.presence, "eliminated");
  const tip = expectedTip(pose, defaultEye);
  assertStrictEquals(cam.x, tip.x);
  assertNotEquals(cam.x, lastPose.x);
});

Deno.test("12.3 dead-but-present: 12.1 focus unchanged (does not cycle)", () => {
  const { session, collision } = liveCapturedSession({ ticks: 3 });
  const playback = createReplayPlayback(session, {
    collision,
    focusedPlayerId: "h1",
  });
  playback.start();
  playback.frame(TICK_MS);
  const focus = playback.state.focusedPlayerId;
  const pose = displayPose({ alive: false });
  chase(pose);
  assertEquals(playback.state.focusedPlayerId, focus);
  assertEquals(playback.state.focusedPlayerId, "h1");
});

// ---------------------------------------------------------------------------
// Absent hold
// ---------------------------------------------------------------------------

Deno.test("12.3 absent hold: last chase + presence absent; never zero", () => {
  const last = chase(displayPose({ x: 2, y: 3, z: 4, yaw: 0.8, pitch: -0.25 }));
  const held = thirdPersonCamera(
    { kind: "absent", lastPose: last },
    { raycast: noHit },
  );
  assertEquals(held.presence, "absent");
  assertStrictEquals(held.x, last.x);
  assertStrictEquals(held.y, last.y);
  assertStrictEquals(held.z, last.z);
  assertStrictEquals(held.yaw, last.yaw);
  assertStrictEquals(held.pitch, last.pitch);
  assertNotEquals(held.x, 0);
});

Deno.test("12.3 absent without last pose fails loud; never origin", () => {
  const err = assertCameraCode(
    () =>
      thirdPersonCamera(
        { kind: "absent", lastPose: null as unknown as CameraPose },
        { raycast: noHit },
      ),
    "replay-spectator-camera-absent-without-pose",
  );
  assertEquals(err.message.includes("last CameraPose"), true);
});

Deno.test("12.3 absent: runner leave keeps focus; feeder miss; 3P holds last", () => {
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
  const lastDisplay = playback.focusedDisplay();
  if (lastFeed === null || lastDisplay === null) {
    throw new Error("expected last successful feed + display");
  }
  const lastPose = thirdPersonCamera(
    {
      kind: "pose",
      pose: lastDisplay.pose,
      snapped: lastDisplay.snapped,
      eye: lastFeed.viewOffset,
    },
    { raycast: noHit },
  );
  const err = assertThrows(
    () => playback.frame(TICK_MS),
    ReplayStateAccessError,
  );
  assertEquals(err.code, "replay-state-focus-unknown");
  const miss = assertThrows(
    () => playback.focusedDisplay(),
    ReplayStateAccessError,
  );
  assertEquals(miss.code, "replay-state-focus-unknown");
  assertEquals(playback.state.focusedPlayerId, "b1");
  assertEquals(playback.feeders.render(), lastFeed);
  const held = thirdPersonCamera(
    { kind: "absent", lastPose },
    { raycast: noHit },
  );
  assertEquals(held.presence, "absent");
  assertStrictEquals(held.x, lastPose.x);
  assertNotEquals(held.x, 0);
});

// ---------------------------------------------------------------------------
// Switch + end-hold + FP↔3P
// ---------------------------------------------------------------------------

Deno.test("12.3 switch: new display chase immediately; clock unchanged", () => {
  const { session, collision } = liveCapturedSession({ ticks: 6 });
  const playback = createReplayPlayback(session, {
    collision,
    focusedPlayerId: "h1",
  });
  playback.start();
  for (let i = 0; i < 3; i++) playback.frame(TICK_MS);
  const before = clockSlice(playback);
  const h1 = poseFromPlayback(playback);
  playback.setFocusedPlayerId("b1");
  assertEquals(clockSlice(playback), before);
  assertEquals(playback.state.focusedPlayerId, "b1");
  const b1 = poseFromPlayback(playback);
  assertNotEquals(b1.x, h1.x);
  assertEquals(b1.yaw, playback.focusedDisplay()!.pose.yaw);
});

Deno.test("12.3 end-hold: last tick is pose present/eliminated, not absent", () => {
  const { session, collision } = liveCapturedSession({ ticks: 4 });
  const playback = createReplayPlayback(session, {
    collision,
    focusedPlayerId: "h1",
  });
  playback.start();
  while (!playback.state.isEnded) {
    playback.frame(TICK_MS);
  }
  const display = playback.focusedDisplay();
  if (display == null) throw new Error("end-hold must keep a display pose");
  assertEquals(display.snapped, false);
  const cam = poseFromPlayback(playback);
  assertEquals(cam.presence === "present" || cam.presence === "eliminated", true);
  assertEquals(Number.isFinite(cam.x), true);
});

Deno.test("12.3 FP↔3P: same frame yields each mode's pose with no interpolate-between", () => {
  const { session, collision } = liveCapturedSession({ ticks: 3 });
  const playback = createReplayPlayback(session, {
    collision,
    focusedPlayerId: "h1",
  });
  playback.start();
  playback.frame(TICK_MS);
  const feed = playback.feeders.render()!;
  const display = playback.focusedDisplay()!;
  const fp = firstPersonCamera({ kind: "feed", feed });
  const tp = thirdPersonCamera(
    {
      kind: "pose",
      pose: display.pose,
      snapped: display.snapped,
      eye: feed.viewOffset,
    },
    { raycast: noHit },
  );
  assertNotEquals(fp.x, tp.x);
  assertNotEquals(fp.z, tp.z);
  assertStrictEquals(fp.yaw, tp.yaw);
  assertStrictEquals(fp.pitch, tp.pitch);
  const midX = (fp.x + tp.x) / 2;
  assertNotEquals(fp.x, midX);
  assertNotEquals(tp.x, midX);
});

Deno.test("12.3 present: chase pose is frozen and copies yaw/pitch", () => {
  const pose = displayPose({ yaw: 1.11, pitch: -0.22 });
  const cam = chase(pose);
  assertEquals(Object.isFrozen(cam), true);
  assertStrictEquals(cam.yaw, 1.11);
  assertStrictEquals(cam.pitch, -0.22);
});

// ---------------------------------------------------------------------------
// Non-interference + shifted wall clock + purity
// ---------------------------------------------------------------------------

Deno.test("12.3 non-interference: posing every tick ≡ never-observed snapshots", () => {
  const ticks = 6;
  const observed = liveCapturedSession({ ticks, seed: 0x51e3 });
  const control = liveCapturedSession({ ticks, seed: 0x51e3 });

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
    lastPose = poseFromPlayback(watching);
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

Deno.test("12.3 shifted-wall-clock: identical CameraPose", () => {
  const pose = displayPose({ yaw: 0.9, pitch: 0.1 });
  assertEquals(chase(pose), chase(pose));
});

Deno.test("12.3 source-scan: pure module has no THREE/DOM/clock/sim/io", async () => {
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
    "moveEyeHeight",
    "crouchEyeViewOffset",
  ]) {
    assertEquals(code.includes(banned), false, `banned token present: ${banned}`);
  }
  assertEquals(/\bTHREE\b/.test(code), false);
  assertEquals(src.includes("thirdPersonCamera"), true);
  assertEquals(src.includes("CameraPose"), true);
  assertEquals(src.includes("THIRD_PERSON_DISTANCE"), true);
});

Deno.test("12.3 source-scan: Q1A feeder file may import 11.4/11.5 pieces", async () => {
  const src = await Deno.readTextFile(
    new URL("./replayStateAccess.ts", import.meta.url),
  );
  assertEquals(src.includes("projectReplayFocusedDisplay"), true);
  assertEquals(src.includes("interpolateReplayPose"), true);
  assertEquals(src.includes("interpolateReplayRoster"), true);
  assertEquals(src.includes("extractReplayInterpPairs"), true);
  const session = await Deno.readTextFile(
    new URL("./replayPlaybackSession.ts", import.meta.url),
  );
  assertEquals(session.includes("focusedDisplay"), true);
  assertEquals(/interpolateReplayPose/.test(session), false);
});
