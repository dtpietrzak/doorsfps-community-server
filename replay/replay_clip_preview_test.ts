/**
 * Epic 15.3 — clip preview.
 *
 * Run from server-community/:
 *   deno test -A replay/replay_clip_preview_test.ts
 */

import { assertEquals, assertThrows } from "@std/assert";
import { TICK_MS } from "../shared/sim/game.ts";
import {
  buildMatchMetadata,
  type MatchMetadata,
} from "../shared/replay/matchMetadata.ts";
import type { MatchInitEvent } from "../shared/sim/authoritativeEvent.ts";
import { PlayerManager } from "../players/PlayerManager.ts";
import type { TickSelectedInput } from "../players/tickAssociation.ts";
import type { DoorsMap } from "../world/map.ts";
import type { PlayerInput } from "../protocol/network.ts";
import { MapCollision } from "../world/MapCollision.ts";
import type { RecordedInitialState } from "./recordedInitialState.ts";
import type { RecordedTickInputs } from "./recordedTickInputs.ts";
import { defineReplayClip, ReplayClipError } from "./replayClip.ts";
import { startClipPreview } from "./replayClipPreview.ts";
import {
  __replayTickNowMsForTest,
  type ReplayRunSession,
} from "./replaySimulationRunner.ts";
import {
  firstPersonCamera,
  type SpectatorRaycast,
  thirdPersonCamera,
} from "./spectatorCamera.ts";
import { SpectatorSelectionError } from "./spectatorSelection.ts";

const miniMap: DoorsMap = {
  name: "replay-clip-preview",
  version: 1,
  bounds: { minX: -40, maxX: 40, minZ: -40, maxZ: 40 },
  gridSize: 1,
  walls: [],
  teamA: { corners: [0, 1], edge: "south", doorHalfWidth: 2, spawnRadius: 4 },
  teamB: { corners: [2, 3], edge: "north", doorHalfWidth: 2, spawnRadius: 4 },
};

function makeCollision(): MapCollision {
  return new MapCollision(miniMap);
}

function sampleMetadata(init: MatchInitEvent): MatchMetadata {
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
      runtimeMatchId: "rt-clip-preview",
      serverName: "clip-preview-test",
      serverId: "srv-clip",
      modeId: "standard",
      raidId: null,
      buildSha: "deadbeef",
      raidMatch: { active: false },
    },
    { capturedAtIso: "2026-01-01T00:00:00.000Z" },
  );
  if (!built.ok) throw new Error(built.reason);
  return built.metadata;
}

function liveSession(tickCount = 8): {
  session: ReplayRunSession;
  collision: MapCollision;
} {
  const collision = makeCollision();
  const live = new PlayerManager(collision, {
    matchSeed: 0xc117,
    matchDurationSeconds: 120,
    enablePrematch: false,
    nowMs: __replayTickNowMsForTest(0),
  });
  live.add("h1", "Human", "A", undefined, __replayTickNowMsForTest(0));
  live.addBot("b1", "BotOne", { team: "B" });
  live.beginLiveMatch(0, __replayTickNowMsForTest(0));
  live.drainAuthoritativeEvents();
  const initRaw = live.buildMatchInitEvent(0);
  if (initRaw.kind !== "matchInit") throw new Error("expected matchInit");
  const initialState: RecordedInitialState = {
    runtimeMatchId: "rt-clip-preview",
    captureTick: 0,
    init: initRaw,
    metadata: sampleMetadata(initRaw),
  };

  const inputs = new Map<number, RecordedTickInputs>();
  for (let tick = 1; tick <= tickCount; tick++) {
    const nowMs = __replayTickNowMsForTest(tick);
    const human = live.get("h1");
    if (human?.alive) {
      const packet: PlayerInput = {
        sequence: tick,
        forward: tick % 2 === 0,
        backward: false,
        left: false,
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
    live.drainAuthoritativeEvents();
  }

  const session: ReplayRunSession = {
    initialState,
    firstTick: 1,
    lastTick: tickCount,
    inputAt(tick) {
      const row = inputs.get(tick);
      if (!row) throw new Error(`no inputs for ${tick}`);
      return row;
    },
    eventsAt() {
      return [];
    },
  };
  return { session, collision };
}

const raycast: SpectatorRaycast = () => null;

Deno.test("15.3 preview: plays the inclusive range at the clip speed and stops", () => {
  const { session, collision } = liveSession();
  const clip = defineReplayClip({
    replayId: "not-a-row",
    startTick: 3,
    endTick: 6,
    cameraMode: "first-person",
    playerId: "b1",
    playbackSpeed: 2,
  });
  const preview = startClipPreview(session, clip, { collision });
  assertEquals(preview.clip.replayId, "not-a-row");
  assertEquals(preview.state().currentTick, 2);
  assertEquals(preview.state().focusedPlayerId, "b1");
  assertEquals(preview.state().speed, 2);
  assertEquals(preview.state().ticksRemaining, 4);
  assertEquals(preview.state().phase, "playing");

  const feed = preview.playback.feeders.render();
  assertEquals(
    preview.pose,
    firstPersonCamera({ kind: "feed", feed: feed! }),
  );

  const done = preview.frame(10_000);
  assertEquals(done.ended, true);
  assertEquals(done.exitReason, "clip-end");
  assertEquals(done.currentTick, 6);
  assertEquals(preview.state().ticksRemaining, 0);
  assertEquals(session.lastTick > clip.endTick, true);

  const held = preview.frame(TICK_MS);
  assertEquals(held.currentTick, 6);
  assertEquals(held.exitReason, "clip-end");
  assertEquals(held.playback, done.playback);
});

Deno.test("15.3 preview: a clip at the session start uses the virgin open", () => {
  const { session, collision } = liveSession();
  const clip = defineReplayClip({
    replayId: "replay-1",
    startTick: 1,
    endTick: 1,
    cameraMode: "first-person",
    playerId: "h1",
  });
  const preview = startClipPreview(session, clip, { collision });
  assertEquals(preview.state().currentTick, 1);
  assertEquals(preview.state().ticksRemaining, 1);
  assertEquals(preview.state().speed, 1);
  const done = preview.frame(TICK_MS);
  assertEquals(done.playback?.steps, 1);
  assertEquals(done.exitReason, "clip-end");
  assertEquals(done.currentTick, 1);
});

Deno.test("15.3 preview: pause holds the tick, stop ends without seeking", () => {
  const { session, collision } = liveSession();
  const clip = defineReplayClip({
    replayId: "replay-1",
    startTick: 3,
    endTick: 5,
    cameraMode: "first-person",
    playerId: "h1",
  });
  const preview = startClipPreview(session, clip, { collision });
  preview.playback.setPaused(true);
  const paused = preview.frame(TICK_MS);
  assertEquals(paused.ended, false);
  assertEquals(paused.currentTick, 2);
  assertEquals(preview.state().ticksRemaining, 3);

  preview.playback.setPaused(false);
  const stopped = preview.stop();
  assertEquals(stopped.exitReason, "stop");
  assertEquals(stopped.currentTick, 2);
  assertEquals(stopped.focusedPlayerId, "h1");
  const after = preview.frame(TICK_MS);
  assertEquals(after.currentTick, 2);
  assertEquals(after.exitReason, "stop");
});

Deno.test("15.3 preview: free view spawns once and third-person uses the raycast", () => {
  const { session, collision } = liveSession();
  const freeClip = defineReplayClip({
    replayId: "replay-1",
    startTick: 3,
    endTick: 5,
    cameraMode: "free",
    playerId: "h1",
  });
  const free = startClipPreview(session, freeClip, { collision });
  const spawnedYaw = free.pose?.yaw;
  free.frame(TICK_MS);
  free.frame(TICK_MS);
  assertEquals(free.pose?.yaw, spawnedYaw);
  const feed = free.playback.feeders.render();
  const eyes = firstPersonCamera({ kind: "feed", feed: feed! });
  assertEquals(eyes.yaw === spawnedYaw, false);

  const thirdClip = defineReplayClip({
    replayId: "replay-1",
    startTick: 3,
    endTick: 4,
    cameraMode: "third-person",
    playerId: "h1",
  });
  const missing = assertThrows(
    () => startClipPreview(session, thirdClip, { collision }),
    ReplayClipError,
  );
  assertEquals(missing.code, "replay-clip-preview-needs-raycast");

  const third = startClipPreview(session, thirdClip, { collision, raycast });
  const display = third.playback.focusedDisplay();
  const thirdFeed = third.playback.feeders.render();
  assertEquals(
    third.pose,
    thirdPersonCamera(
      {
        kind: "pose",
        pose: display!.pose,
        snapped: display!.snapped,
        eye: thirdFeed!.viewOffset,
      },
      { raycast },
    ),
  );
});

Deno.test("15.3 preview: a range outside the session and an unknown player fail loud", () => {
  const { session, collision } = liveSession();
  const outside = defineReplayClip({
    replayId: "replay-1",
    startTick: 1,
    endTick: 100,
    cameraMode: "first-person",
    playerId: "h1",
  });
  const range = assertThrows(
    () => startClipPreview(session, outside, { collision }),
    ReplayClipError,
  );
  assertEquals(range.code, "replay-clip-outside-span");

  const missing = defineReplayClip({
    replayId: "replay-1",
    startTick: 2,
    endTick: 4,
    cameraMode: "first-person",
    playerId: "nope",
  });
  const focus = assertThrows(
    () => startClipPreview(session, missing, { collision }),
    SpectatorSelectionError,
  );
  assertEquals(focus.code, "replay-spectator-focus-unknown");
});

Deno.test("15.6 preview: fov, boom, and loop follow the clip settings", () => {
  const { session, collision } = liveSession();
  const fovPreview = startClipPreview(
    session,
    defineReplayClip({
      replayId: "replay-1",
      startTick: 3,
      endTick: 4,
      cameraMode: "first-person",
      playerId: "h1",
      cameraSettings: { version: 1, camera: { fov: 80 } },
    }),
    { collision },
  );
  assertEquals(fovPreview.pose?.fov, 80);

  const near = startClipPreview(
    session,
    defineReplayClip({
      replayId: "replay-1",
      startTick: 3,
      endTick: 4,
      cameraMode: "third-person",
      playerId: "h1",
    }),
    { collision, raycast },
  );
  const far = startClipPreview(
    session,
    defineReplayClip({
      replayId: "replay-1",
      startTick: 3,
      endTick: 4,
      cameraMode: "third-person",
      playerId: "h1",
      cameraSettings: { version: 1, camera: { distance: 12 } },
    }),
    { collision, raycast },
  );
  assertEquals(
    far.pose?.x === near.pose?.x && far.pose?.z === near.pose?.z,
    false,
  );

  const loop = startClipPreview(
    session,
    defineReplayClip({
      replayId: "replay-1",
      startTick: 3,
      endTick: 4,
      cameraMode: "first-person",
      playerId: "h1",
      playbackSpeed: 2,
      cameraSettings: { version: 1, playback: { loop: true } },
    }),
    { collision },
  );
  const end = loop.frame(10_000);
  assertEquals(end.ended, false);
  assertEquals(end.currentTick, 4);
  const wrapped = loop.frame(TICK_MS);
  assertEquals(wrapped.ended, false);
  assertEquals(wrapped.currentTick, 4);
  assertEquals(loop.state().speed, 2);
  assertEquals(loop.state().focusedPlayerId, "h1");

  const atStart = startClipPreview(
    session,
    defineReplayClip({
      replayId: "replay-1",
      startTick: 1,
      endTick: 1,
      cameraMode: "first-person",
      playerId: "h1",
      cameraSettings: { version: 1, playback: { loop: true } },
    }),
    { collision },
  );
  const once = atStart.frame(TICK_MS);
  assertEquals(once.ended, false);
  assertEquals(once.currentTick, 1);
  const twice = atStart.frame(TICK_MS);
  assertEquals(twice.ended, false);
  assertEquals(twice.currentTick, 1);
  assertEquals(atStart.state().speed, 1);
});

Deno.test("15.3 source-scan: playback driver, no killcam policy or storage", async () => {
  const src = await Deno.readTextFile(
    new URL("./replayClipPreview.ts", import.meta.url),
  );
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (
    const banned of [
      "Date.now",
      "performance.now",
      "requestAnimationFrame",
      "setInterval",
      "setTimeout",
      "killcamPlayback",
      "resolveKillcamDeath",
      "frameKillcamWindow",
      "createReplayClock",
      "loadReplay",
      "PlayerManager",
      "THREE",
      "document",
      "node:fs",
      "ReplayBlobStore",
      "sqlite",
    ]
  ) {
    assertEquals(
      code.includes(banned),
      false,
      `banned token present: ${banned}`,
    );
  }
  assertEquals(code.includes("createReplayPlayback"), true);
  assertEquals(code.includes("setSpeed"), true);
  assertEquals(code.includes("setFocusedPlayerId"), true);
  assertEquals(code.includes("firstPersonCamera"), true);
  assertEquals(code.includes("thirdPersonCamera"), true);
  assertEquals(code.includes("spawnFreeCamera"), true);
});
