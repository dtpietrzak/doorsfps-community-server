/**
 * Epic 15.6 — clip presentation.
 *
 * Run from server-community/:
 *   deno test -A replay/replay_clip_presentation_test.ts
 */

import { assertEquals } from "@std/assert";
import { defineReplayClip, ReplayClipError } from "./replayClip.ts";
import {
  defaultReplayClipCameraSettings,
  resolveReplayClipCameraSettings,
} from "./replayClipPresentation.ts";
import {
  FREE_CAMERA_FOV_MAX,
  FREE_CAMERA_FOV_MIN,
  THIRD_PERSON_DISTANCE,
  THIRD_PERSON_HEIGHT,
  THIRD_PERSON_MIN_DISTANCE,
  THIRD_PERSON_SHOULDER,
  thirdPersonCamera,
} from "./spectatorCamera.ts";
import { assertThrows } from "@std/assert";

Deno.test("15.6 settings: omitted and { version: 1 } are the 12.x defaults", () => {
  const defaults = defaultReplayClipCameraSettings();
  assertEquals(defaults, {
    version: 1,
    camera: {
      distance: THIRD_PERSON_DISTANCE,
      height: THIRD_PERSON_HEIGHT,
      shoulder: THIRD_PERSON_SHOULDER,
      fov: null,
    },
    playback: { loop: false },
  });
  assertEquals(resolveReplayClipCameraSettings(undefined), {
    ok: true,
    settings: defaults,
  });
  assertEquals(resolveReplayClipCameraSettings({ version: 1 }), {
    ok: true,
    settings: defaults,
  });
  const clip = defineReplayClip({
    replayId: "replay-1",
    startTick: 1,
    endTick: 2,
    cameraMode: "first-person",
    playerId: "h1",
  });
  assertEquals(clip.cameraSettings, defaults);
});

Deno.test("15.6 settings: partial camera and playback fill the rest", () => {
  const fov = FREE_CAMERA_FOV_MIN + 10;
  const parsed = resolveReplayClipCameraSettings({
    version: 1,
    camera: { fov, distance: THIRD_PERSON_MIN_DISTANCE },
    playback: { loop: true },
  });
  assertEquals(parsed.ok, true);
  if (!parsed.ok) return;
  assertEquals(parsed.settings.camera.fov, fov);
  assertEquals(parsed.settings.camera.distance, THIRD_PERSON_MIN_DISTANCE);
  assertEquals(parsed.settings.camera.height, THIRD_PERSON_HEIGHT);
  assertEquals(parsed.settings.camera.shoulder, THIRD_PERSON_SHOULDER);
  assertEquals(parsed.settings.playback.loop, true);

  const again = resolveReplayClipCameraSettings(parsed.settings);
  assertEquals(again, parsed);
});

Deno.test("15.6 settings: unknown keys, range, and types fail without clamping", () => {
  const bad = [
    { version: 1, boom: 2 },
    { version: 2 },
    null,
    [],
    { version: 1, camera: { distance: THIRD_PERSON_MIN_DISTANCE - 0.01 } },
    { version: 1, camera: { height: Number.NaN } },
    { version: 1, camera: { fov: FREE_CAMERA_FOV_MIN - 1 } },
    { version: 1, camera: { fov: FREE_CAMERA_FOV_MAX + 1 } },
    { version: 1, camera: { orbit: 1 } },
    { version: 1, playback: { loop: "yes" } },
    { version: 1, playback: { speed: 2 } },
  ];
  for (const value of bad) {
    const parsed = resolveReplayClipCameraSettings(value);
    assertEquals(parsed.ok, false, JSON.stringify(value));
  }
  const thrown = assertThrows(
    () =>
      defineReplayClip({
        replayId: "replay-1",
        startTick: 1,
        endTick: 2,
        cameraMode: "free",
        playerId: "h1",
        cameraSettings: { version: 1, boom: 2 } as { version: 1 },
      }),
    ReplayClipError,
  );
  assertEquals(thrown.code, "replay-clip-bad-settings");
});

Deno.test("15.6 boom: an explicit distance moves the chase; the default matches 12.3", () => {
  const pose = { x: 0, y: 1, z: 0, yaw: 0, pitch: 0, alive: true };
  const eye = { x: 0, y: 0, z: 0 };
  const input = { kind: "pose" as const, pose, snapped: false, eye };
  const raycast = () => null;
  const stock = thirdPersonCamera(input, { raycast });
  const named = thirdPersonCamera(input, {
    raycast,
    distance: THIRD_PERSON_DISTANCE,
    height: THIRD_PERSON_HEIGHT,
    shoulder: THIRD_PERSON_SHOULDER,
  });
  assertEquals(named, stock);
  const far = thirdPersonCamera(input, {
    raycast,
    distance: THIRD_PERSON_DISTANCE + 4,
  });
  assertEquals(far.z > stock.z, true);
});

Deno.test("15.6 source-scan: settings only, constants not copied", async () => {
  const src = await Deno.readTextFile(
    new URL("./replayClipPresentation.ts", import.meta.url),
  );
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (
    const banned of [
      "sqlite",
      "ReplayBlobStore",
      "node:fs",
      "defineReplayClip",
      "createReplayPlayback",
      "Date.now",
      "THREE",
      "document",
      "PlayerManager",
      'from "./replayClip.ts"',
      "3.5",
      "0.35",
      "0.45",
    ]
  ) {
    assertEquals(
      code.includes(banned),
      false,
      `banned token present: ${banned}`,
    );
  }
  assertEquals(code.includes("THIRD_PERSON_DISTANCE"), true);
  assertEquals(code.includes("THIRD_PERSON_MIN_DISTANCE"), true);
  assertEquals(code.includes("FREE_CAMERA_FOV_MIN"), true);
  assertEquals(code.includes("FREE_CAMERA_FOV_MAX"), true);
  assertEquals(code.includes("resolveReplayClipCameraSettings"), true);
});
