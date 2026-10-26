/**
 * Epic 11.5 — replay state access.
 *
 * Run from server-community/:
 *   deno test -A replay/replay_state_access_test.ts
 */

import {
  assertEquals,
  assertAlmostEquals,
  assertThrows,
  assertStrictEquals,
  assertNotStrictEquals,
  assertNotEquals,
} from "@std/assert";
import { TICK_MS } from "../shared/sim/game.ts";
import { SPAWN_INVULN_TICKS } from "../protocol/network.ts";
import { moveEyeHeight } from "../shared/sim/moveStep.ts";
import type { CheckpointPlayerState } from "./authoritativeCheckpoint.ts";
import { interpolateReplayPose } from "./replayInterpolation.ts";
import {
  ReplayStateAccessError,
  extractReplayInterpPairs,
  projectReplayRenderFeed,
  projectReplaySnapshot,
  type ReplayViewState,
} from "./replayStateAccess.ts";

// ---------------------------------------------------------------------------
// Fixtures
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

function assertStateError(
  fn: () => unknown,
  code: ReplayStateAccessError["code"],
): ReplayStateAccessError {
  const err = assertThrows(fn, ReplayStateAccessError) as ReplayStateAccessError;
  assertEquals(err.code, code);
  return err;
}

/** Structural gate matching client isSnapshotPacketShaped. */
function isSnapshotPacketShaped(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.tick === "number" &&
    Array.isArray(p.players) &&
    Array.isArray(p.projectiles) &&
    p.scores !== null &&
    typeof p.scores === "object"
  );
}

/** Structural gate matching client isRenderFeedShaped. */
function isRenderFeedShaped(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const f = value as Record<string, unknown>;
  const xyz = (v: unknown) => {
    if (v === null || typeof v !== "object") return false;
    const o = v as Record<string, unknown>;
    return (
      typeof o.x === "number" &&
      typeof o.y === "number" &&
      typeof o.z === "number"
    );
  };
  return (
    xyz(f.localSim) &&
    xyz(f.prevSim) &&
    xyz(f.viewOffset) &&
    typeof f.localSimAccum === "number" &&
    typeof f.localSimDt === "number"
  );
}

const OMITTED_KEYS = [
  "name",
  "head",
  "visor",
  "shoulder",
  "body",
  "leg",
  "hue",
  "gunHue",
  "pistol",
  "rifle",
  "crosshair",
  "ping",
  "afk",
  "afkKickIn",
  "mmsRankId",
  "founderBadge",
  "botDec",
  "connectionIssue",
] as const;

// ---------------------------------------------------------------------------
// Snapshot projection
// ---------------------------------------------------------------------------

Deno.test("projectReplaySnapshot: seam-shaped + verbatim motion/lifecycle/scoring", () => {
  const row = playerRow({
    id: "alpha",
    x: 1.25,
    y: 2.5,
    z: -3.75,
    yaw: 0.4,
    pitch: -0.1,
    velocityX: 1,
    velocityY: 2,
    velocityZ: 3,
    health: 77,
    alive: true,
    crouch: true,
    onGround: false,
    sprintStamina: 1.5,
    score: 4,
    kills: 2,
    deaths: 1,
    xp: 99,
    team: "B",
    isAgent: true,
  });
  const v = view({
    tick: 42,
    players: [row],
    scores: { A: 3, B: 7 },
    phase: "prematch",
    doorsOpen: false,
    doorChangeTick: 55,
    matchEndTick: 900,
    projectiles: [{ id: "proj1", x: 1, y: 2, z: 3 }],
  });
  const packet = projectReplaySnapshot(v);

  assertEquals(isSnapshotPacketShaped(packet), true);
  assertEquals(packet.tick, 42);
  assertEquals(packet.doorsOpen, false);
  assertEquals(packet.doorChangeTick, 55);
  assertEquals(packet.matchEndTick, 900);
  assertEquals(packet.phase, "prematch");
  assertEquals(packet.scores, { A: 3, B: 7 });
  assertEquals(packet.projectiles, [{ id: "proj1", x: 1, y: 2, z: 3 }]);

  const p = packet.players[0]!;
  assertStrictEquals(p.x, 1.25);
  assertStrictEquals(p.y, 2.5);
  assertStrictEquals(p.z, -3.75);
  assertStrictEquals(p.yaw, 0.4);
  assertStrictEquals(p.pitch, -0.1);
  assertStrictEquals(p.velocityX, 1);
  assertStrictEquals(p.velocityY, 2);
  assertStrictEquals(p.velocityZ, 3);
  assertEquals(p.health, 77);
  assertEquals(p.alive, true);
  assertEquals(p.crouch, true);
  assertEquals(p.team, "B");
  assertEquals(p.isAgent, true);
  assertEquals(p.sprintStamina, 1.5);
  assertEquals(p.score, 4);
  assertEquals(p.kills, 2);
  assertEquals(p.deaths, 1);
  assertEquals(p.xp, 99);
  assertEquals(p.weapon, 0);
  assertEquals(p.ammoInMag, 12);
  assertEquals(p.spareClips, 3);
});

Deno.test("projectReplaySnapshot: roster order ascending by id", () => {
  const packet = projectReplaySnapshot(
    view({
      players: [
        playerRow({ id: "z" }),
        playerRow({ id: "a" }),
        playerRow({ id: "m" }),
      ],
    }),
  );
  assertEquals(
    packet.players.map((p) => p.id),
    ["a", "m", "z"],
  );
});

Deno.test("projectReplaySnapshot: scores are a value copy", () => {
  const scores = { A: 1, B: 2 };
  const v = view({ scores });
  const packet = projectReplaySnapshot(v);
  // Output is deep-frozen (cannot mutate packet.scores); prove independence
  // by mutating the input view/scores after projection.
  assertNotStrictEquals(packet.scores, v.scores);
  assertNotStrictEquals(packet.scores, scores);
  scores.A = 99;
  (v.scores as { A: number }).A = 50;
  assertEquals(packet.scores.A, 1);
  assertEquals(packet.scores.B, 2);
});

Deno.test("projectReplaySnapshot: slide + reload/switch flags from tick windows", () => {
  const row = playerRow({
    id: "p1",
    slideRemaining: 0.3,
    slideDirX: 0.6,
    slideDirZ: -0.8,
    slideForceCrouch: true,
    reloadEndsAtTick: 20,
    weaponSwitchEndsAtTick: 15,
  });
  const mid = projectReplaySnapshot(view({ tick: 10, players: [row] }));
  assertEquals(mid.players[0]!.slide, true);
  assertEquals(mid.players[0]!.slideRemaining, 0.3);
  assertEquals(mid.players[0]!.slideDirX, 0.6);
  assertEquals(mid.players[0]!.slideDirZ, -0.8);
  assertEquals(mid.players[0]!.reloading, true);
  assertEquals(mid.players[0]!.switching, true);

  const after = projectReplaySnapshot(view({ tick: 25, players: [row] }));
  assertEquals(after.players[0]!.reloading, false);
  assertEquals(after.players[0]!.switching, false);
});

Deno.test("projectReplaySnapshot: omission rows never present (undefined, not zero-filled)", () => {
  const row = playerRow({
    id: "p1",
    // equipment exists on checkpoint but must not leak as cosmetics on snapshot
    equipment: {
      head: 2,
      visor: 1,
      shoulder: 3,
      body: 1,
      leg: 2,
      hue: 0.5,
      gunHue: -0.5,
      bulletHue: 0,
      crosshairColor: -1,
      nameHue: 0,
      scope: 0,
      pistol: 1,
      rifle: 2,
      shotgun: 0,
      crosshair: 3,
    },
  });
  const packet = projectReplaySnapshot(view({ players: [row] }));
  const p = packet.players[0]! as unknown as Record<string, unknown>;
  for (const key of OMITTED_KEYS) {
    assertEquals(
      key in p && p[key] !== undefined,
      false,
      `omission key ${key} must be absent/undefined`,
    );
  }
  // No wire / wall-clock / location substrings in serialized output.
  const json = JSON.stringify(packet);
  assertEquals(/https?:\/\//.test(json), false);
  assertEquals(/Date\.now|performance\.now/.test(json), false);
});

Deno.test("projectReplaySnapshot: invulnerable from spawn protect and Force Field", () => {
  const duringProtect = projectReplaySnapshot(
    view({
      tick: 0,
      players: [playerRow({ id: "p1", spawnedAtTick: 0, alive: true })],
    }),
  ).players[0]!;
  assertEquals(duringProtect.invulnerable, true);

  const afterProtect = projectReplaySnapshot(
    view({
      tick: SPAWN_INVULN_TICKS,
      players: [playerRow({ id: "p1", spawnedAtTick: 0, alive: true })],
    }),
  ).players[0]!;
  assertEquals(afterProtect.invulnerable, undefined);

  const dead = projectReplaySnapshot(
    view({
      tick: 0,
      players: [playerRow({ id: "p1", spawnedAtTick: 0, alive: false })],
    }),
  ).players[0]!;
  assertEquals(dead.invulnerable, undefined);

  const forceField = projectReplaySnapshot(
    view({
      tick: SPAWN_INVULN_TICKS + 10,
      players: [
        playerRow({
          id: "p1",
          spawnedAtTick: 0,
          alive: true,
          abilityEndsAtTick: { forceField: SPAWN_INVULN_TICKS + 20 },
        }),
      ],
    }),
  ).players[0]!;
  assertEquals(forceField.invulnerable, true);
});

Deno.test("projectReplaySnapshot: frozen output; mutating view does not alter packet", () => {
  const row = playerRow({ id: "p1", x: 1, score: 5 });
  const v = view({ players: [row], scores: { A: 1, B: 0 } });
  const packet = projectReplaySnapshot(v);
  assertEquals(Object.isFrozen(packet), true);
  assertEquals(Object.isFrozen(packet.players), true);
  assertEquals(Object.isFrozen(packet.players[0]), true);

  (row as { x: number }).x = 999;
  (v.scores as { A: number }).A = 50;
  assertStrictEquals(packet.players[0]!.x, 1);
  assertEquals(packet.scores.A, 1);

  assertThrows(() => {
    (packet as { tick: number }).tick = 0;
  });
});

// ---------------------------------------------------------------------------
// Pair extraction
// ---------------------------------------------------------------------------

Deno.test("extractReplayInterpPairs: id-matched 11.4 shape; join/leave yield no pair", () => {
  const prev = view({
    tick: 1,
    players: [
      playerRow({ id: "stay", x: 1, y: 2, z: 3, yaw: 0.1, crouch: false }),
      playerRow({ id: "leave", x: 9, z: 9 }),
    ],
  });
  const next = view({
    tick: 2,
    players: [
      playerRow({
        id: "stay",
        x: 4,
        y: 5,
        z: 6,
        yaw: 0.5,
        crouch: true,
        velocityX: 1,
      }),
      playerRow({ id: "join", x: 0, z: 0 }),
    ],
  });
  const pairs = extractReplayInterpPairs(prev, next);
  assertEquals(pairs.length, 1);
  assertEquals(pairs[0]!.prev.id, "stay");
  assertEquals(pairs[0]!.next.id, "stay");
  assertStrictEquals(pairs[0]!.prev.x, 1);
  assertStrictEquals(pairs[0]!.next.x, 4);
  assertEquals(pairs[0]!.next.crouch, true);
  assertEquals(pairs[0]!.next.velocityX, 1);
  // Present-side still projectable via snapshot:
  const snapPrev = projectReplaySnapshot(prev);
  const snapNext = projectReplaySnapshot(next);
  assertEquals(snapPrev.players.map((p) => p.id).sort(), ["leave", "stay"]);
  assertEquals(snapNext.players.map((p) => p.id).sort(), ["join", "stay"]);
});

// ---------------------------------------------------------------------------
// Render feed
// ---------------------------------------------------------------------------

Deno.test("projectReplayRenderFeed: null view → null", () => {
  assertEquals(projectReplayRenderFeed(null, null, "p1", 0.5), null);
});

Deno.test("projectReplayRenderFeed: unknown id fails loud", () => {
  assertStateError(
    () => projectReplayRenderFeed(view(), view({ tick: 11 }), "missing", 0.5),
    "replay-state-focus-unknown",
  );
});

Deno.test("projectReplayRenderFeed: ended (no next) projects view exactly", () => {
  const v = view({
    players: [playerRow({ id: "p1", x: 3, y: 4, z: 5 })],
  });
  const feed = projectReplayRenderFeed(v, null, "p1", 0.5)!;
  assertEquals(isRenderFeedShaped(feed), true);
  assertStrictEquals(feed.localSim.x, 3);
  assertStrictEquals(feed.localSim.y, 4);
  assertStrictEquals(feed.localSim.z, 5);
  assertStrictEquals(feed.prevSim.x, 3);
  assertEquals(feed.viewOffset, { x: 0, y: 0, z: 0 });
  assertEquals(feed.localSimDt, TICK_MS);
  assertStrictEquals(feed.yaw, 0);
  assertStrictEquals(feed.pitch, 0);
  assertStrictEquals(feed.alive, true);
});

Deno.test("projectReplayRenderFeed: leave-between-T-and-T+1 copies exact-T yaw/pitch/alive", () => {
  const prev = view({
    tick: 10,
    players: [
      playerRow({
        id: "p1",
        x: 3,
        y: 4,
        z: 5,
        yaw: 0.7,
        pitch: -0.2,
        alive: true,
      }),
    ],
  });
  const next = view({
    tick: 11,
    players: [playerRow({ id: "other", x: 9 })],
  });
  const feed = projectReplayRenderFeed(prev, next, "p1", 0.5)!;
  assertEquals(isRenderFeedShaped(feed), true);
  assertStrictEquals(feed.localSim.x, 3);
  assertStrictEquals(feed.yaw, 0.7);
  assertStrictEquals(feed.pitch, -0.2);
  assertStrictEquals(feed.alive, true);
});

Deno.test("projectReplayRenderFeed: u=0 / u=1 endpoints equal T / T+1 body poses", () => {
  const prev = view({
    tick: 10,
    players: [playerRow({ id: "p1", x: 0, y: 1, z: 0 })],
  });
  const next = view({
    tick: 11,
    players: [playerRow({ id: "p1", x: 10, y: 1, z: 20 })],
  });
  const at0 = projectReplayRenderFeed(prev, next, "p1", 0)!;
  assertStrictEquals(at0.localSim.x, 0);
  assertStrictEquals(at0.localSim.z, 0);

  const at1 = projectReplayRenderFeed(prev, next, "p1", 1)!;
  assertStrictEquals(at1.localSim.x, 10);
  assertStrictEquals(at1.localSim.z, 20);
});

Deno.test("projectReplayRenderFeed: mid-u equals real 11.4 blend of extracted pairs", () => {
  const prev = view({
    tick: 10,
    players: [
      playerRow({
        id: "p1",
        x: 0,
        y: moveEyeHeight(false),
        z: 0,
        yaw: 0,
        pitch: 0,
        velocityX: 0,
        velocityZ: 0,
      }),
    ],
  });
  const next = view({
    tick: 11,
    players: [
      playerRow({
        id: "p1",
        x: 4,
        y: moveEyeHeight(false),
        z: 8,
        yaw: Math.PI / 2,
        pitch: 0.2,
        velocityX: 2,
        velocityZ: 4,
      }),
    ],
  });
  const u = 0.5;
  const feed = projectReplayRenderFeed(prev, next, "p1", u)!;
  const pairs = extractReplayInterpPairs(prev, next);
  const blended = interpolateReplayPose(pairs[0]!.prev, pairs[0]!.next, u);
  assertStrictEquals(feed.localSim.x, blended.pose.x);
  assertStrictEquals(feed.localSim.y, blended.pose.y);
  assertStrictEquals(feed.localSim.z, blended.pose.z);
  assertEquals(feed.viewOffset.y, 0); // same crouch — no eye correction
  // Q4A: orientation is the 11.4 pose, not a second lerp / SnapshotPacket yaw.
  assertStrictEquals(feed.yaw, blended.pose.yaw);
  assertStrictEquals(feed.pitch, blended.pose.pitch);
  assertStrictEquals(feed.alive, blended.pose.alive);
});

Deno.test("projectReplayRenderFeed: crouch-flip carries eye delta in viewOffset", () => {
  const standY = moveEyeHeight(false);
  const crouchY = moveEyeHeight(true);
  const prev = view({
    tick: 10,
    players: [
      playerRow({
        id: "p1",
        x: 0,
        y: standY,
        z: 0,
        crouch: false,
        onGround: true,
      }),
    ],
  });
  const next = view({
    tick: 11,
    players: [
      playerRow({
        id: "p1",
        x: 0,
        y: crouchY,
        z: 0,
        crouch: true,
        onGround: true,
      }),
    ],
  });
  const u = 0.5;
  const feed = projectReplayRenderFeed(prev, next, "p1", u)!;
  const pairs = extractReplayInterpPairs(prev, next);
  const blended = interpolateReplayPose(pairs[0]!.prev, pairs[0]!.next, u);

  // Body stays the 11.4 blend (smeared eye y).
  assertStrictEquals(feed.localSim.y, blended.pose.y);
  // Offset corrects to discrete-newer (crouch) eye.
  assertNotEquals(feed.viewOffset.y, 0);
  const cameraY = feed.localSim.y + feed.viewOffset.y;
  assertAlmostEquals(cameraY, crouchY, 1e-9);

  // Endpoints: u=1 already at crouch eye → zero offset.
  const at1 = projectReplayRenderFeed(prev, next, "p1", 1)!;
  assertStrictEquals(at1.localSim.y, crouchY);
  assertEquals(at1.viewOffset.y, 0);
});

Deno.test("projectReplayRenderFeed: frozen; mutating views post-projection is safe", () => {
  const row = playerRow({ id: "p1", x: 1 });
  const prev = view({ players: [row] });
  const next = view({
    tick: 11,
    players: [playerRow({ id: "p1", x: 5 })],
  });
  const feed = projectReplayRenderFeed(prev, next, "p1", 0.25)!;
  assertEquals(Object.isFrozen(feed), true);
  (row as { x: number }).x = 999;
  assertNotEquals(feed.localSim.x, 999);
  assertThrows(() => {
    (feed.localSim as { x: number }).x = 0;
  });
});

Deno.test("purity: identical inputs → identical feeds (no wall-clock)", () => {
  const prev = view({
    players: [playerRow({ id: "p1", x: 0, z: 0 })],
  });
  const next = view({
    tick: 11,
    players: [playerRow({ id: "p1", x: 2, z: 4 })],
  });
  const u = 12.5 / TICK_MS;
  const a = projectReplayRenderFeed(prev, next, "p1", u)!;
  const b = projectReplayRenderFeed(prev, next, "p1", u)!;
  assertStrictEquals(a.localSim.x, b.localSim.x);
  assertStrictEquals(a.localSim.z, b.localSim.z);
  assertEquals(a.viewOffset, b.viewOffset);
});

// ---------------------------------------------------------------------------
// Source scan
// ---------------------------------------------------------------------------

Deno.test("source scan: no sim-owner / render / net / store / wall-clock imports", async () => {
  const src = await Deno.readTextFile(
    new URL("./replayStateAccess.ts", import.meta.url),
  );
  // Collect full import statements (including multiline).
  const importBlock = src
    .split("\n")
    .reduce<{ lines: string[]; inImport: boolean }>(
      (acc, line) => {
        if (/^\s*import\b/.test(line)) acc.inImport = true;
        if (acc.inImport) acc.lines.push(line);
        if (acc.inImport && /;\s*$/.test(line)) acc.inImport = false;
        return acc;
      },
      { lines: [], inImport: false },
    )
    .lines.join("\n");
  const forbiddenImports = [
    "PlayerManager",
    "BotManager",
    "../players/Player",
    "GameServer",
    "replayClock",
    "replaySimulationRunner",
    "../../client/",
    "remoteInterp",
    "ReplayBlobStore",
    "ReplayRecorder",
  ];
  for (const needle of forbiddenImports) {
    assertEquals(
      importBlock.includes(needle),
      false,
      `replayStateAccess.ts must not import ${JSON.stringify(needle)}`,
    );
  }
  // Type-only / allowed: CheckpointPlayerState type, network types, 11.4, moveStep, abilities.
  assertEquals(
    importBlock.includes('from "./authoritativeCheckpoint.ts"'),
    true,
  );
  assertEquals(importBlock.includes('from "./replayInterpolation.ts"'), true);

  const forbiddenBody = [
    "Date.now",
    "performance.now",
    "requestAnimationFrame",
    "Deno.read",
    "Deno.write",
    "fetch(",
  ];
  for (const needle of forbiddenBody) {
    assertEquals(
      src.includes(needle),
      false,
      `replayStateAccess.ts must not contain ${JSON.stringify(needle)}`,
    );
  }
});
