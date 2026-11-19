/**
 * Epic 19.6 — input, event, and checkpoint compression.
 *
 * Run from server-community/:
 *   deno test -A --unstable-net --node-modules-dir=manual replay/replay_section_compression_test.ts
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { CHECKPOINT_SCHEMA_VERSION } from "./authoritativeCheckpoint.ts";
import type { AuthoritativeCheckpoint, CheckpointPlayerState } from "./authoritativeCheckpoint.ts";
import { buildReplayContainer } from "./replayContainer.ts";
import { deriveReplayByteMap } from "./replayByteMap.ts";
import {
  decodeReplayContainer,
  encodeReplayContainer,
  ReplayEncodingError,
} from "./replayEncoding.ts";
import { buildCatalogFixture } from "./replayCatalogFixture.ts";
import {
  packCheckpoints,
  packEventStream,
  packInputStream,
  unpackCheckpoints,
  unpackEventStream,
  unpackInputStream,
} from "./replaySectionCompression.ts";
import type { RecordedTickEvents } from "./recordedTickEvents.ts";
import type { RecordedTickInputs } from "./recordedTickInputs.ts";
import type { PlayerInput } from "../protocol/network.ts";
import { defaultPlayerEquipment } from "../shared/sim/game.ts";
import {
  emptyAuthoritativeRosterSnapshot,
  makeMatchEndEvent,
  makeMatchStartEvent,
  makePlayerDiedEvent,
  makeReadyVoteEvent,
} from "../shared/sim/authoritativeEvent.ts";

function inputRow(
  tick: number,
  over: {
    yaw?: number;
    pitch?: number;
    forward?: boolean;
    meleeLunge?: boolean;
    omitMelee?: boolean;
    queued?: boolean;
    actionTick?: number;
    weapon?: number;
  } = {},
): RecordedTickInputs {
  const selected: PlayerInput = {
    sequence: 3,
    forward: over.forward ?? false,
    backward: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
    crouch: false,
    yaw: over.yaw ?? 0.25,
    pitch: over.pitch ?? 0,
  };
  if (!over.omitMelee) selected.meleeLunge = over.meleeLunge ?? false;
  const movement: RecordedTickInputs["movement"][number] = {
    tick,
    playerId: "p1",
    association: "hold",
    appliedSequence: 3,
    inputHoldTicks: 2,
    selectedInput: selected,
  };
  if (over.queued) {
    (movement as { queuedInput?: unknown }).queuedInput = {
      sequence: 4,
      forward: false,
      backward: false,
      left: false,
      right: false,
      jump: false,
      sprint: false,
      crouch: false,
      yaw: 1,
      pitch: 0,
    };
  }
  const actions: RecordedTickInputs["actions"] = over.actionTick == null
    ? []
    : [{
      tick: over.actionTick,
      playerId: "p1",
      ordinal: 0,
      kind: "weaponSelect",
      weapon: over.weapon ?? 0,
    }];
  return { tick, movement: [movement], actions };
}

function pose(tick: number, x: number) {
  return {
    tick,
    x,
    y: 0,
    z: 0,
    crouch: false,
    slide: false,
    yaw: 0,
    pitch: 0,
    velocityX: 0,
    velocityY: 0,
    velocityZ: 0,
    onGround: true,
    landingAmount: 0,
  };
}

function player(over: Partial<CheckpointPlayerState> = {}): CheckpointPlayerState {
  const loadout = {
    weaponId: 0,
    ammoInMag: 0,
    spareClips: 0,
  };
  return {
    id: "p1",
    team: "A",
    isBot: false,
    isAgent: false,
    x: 0,
    y: 0,
    z: 1,
    yaw: 0,
    pitch: 0,
    velocityX: 0,
    velocityY: 0,
    velocityZ: 0,
    onGround: true,
    crouch: false,
    sprintStamina: 0,
    slideRemaining: 0,
    slideDirX: 0,
    slideDirZ: 0,
    slideForceCrouch: false,
    prevInputCrouch: false,
    lastLandedAtTick: null,
    poseHistory: [pose(0, 0), pose(4, 2)],
    health: 100,
    maxHealth: 100,
    alive: true,
    spawnedAtTick: 0,
    diedAtTick: null,
    enemyDoorSinceTick: null,
    hitSlowStacks: 0,
    hitSlowEndsAtTick: 0,
    weaponId: 0,
    weaponLoadouts: [loadout, { weaponId: 1, ammoInMag: 2, spareClips: 0, chambered: false }],
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
    equipment: defaultPlayerEquipment(),
    skillLoadout: null,
    ownedAbilities: null,
    score: 0,
    kills: 0,
    deaths: 0,
    xp: 0,
    ...over,
  };
}

function checkpoint(
  tick: number,
  runtimeMatchId: string,
  players: CheckpointPlayerState[],
): AuthoritativeCheckpoint {
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    tick,
    runtimeMatchId,
    map: { name: "encoding-map", version: 1 },
    matchSeed: 42,
    rng: { damage: 1, spread: 2, spawn: 3, agents: 4, collisionSpawn: 5 },
    match: {
      scores: { A: 0, B: 0 },
      matchOver: false,
      inPrematch: false,
      restartAtTick: null,
      doorCycleOriginTick: tick,
      doorsPowerUpUntilTick: null,
      raidDoorPolicy: "off",
      debugForceDoorsOpen: false,
      matchEndTick: tick + 100,
      matchDurationTicks: 100,
      raid: { active: false },
    },
    players,
    projectiles: [],
  };
}

Deno.test("19.6 pack keeps non-defaults, -0, and optional absence", () => {
  const row = inputRow(6, { yaw: -0, omitMelee: true, actionTick: 5, weapon: 2 });
  const packed = packInputStream([row]) as Array<Record<string, unknown>>;
  const movement = (packed[0]!.movement as Array<Record<string, unknown>>)[0]!;
  const selected = movement.selectedInput as Record<string, unknown>;
  assertEquals(movement.tick, undefined);
  assertEquals("backward" in selected, false);
  assertEquals("meleeLunge" in selected, false);
  assert(Object.is(selected.yaw, -0));
  assertEquals("queuedInput" in movement, false);
  const action = (packed[0]!.actions as Array<Record<string, unknown>>)[0]!;
  assertEquals(action.tick, 5);
  assertEquals(action.weapon, 2);
  assertEquals(action.ordinal, undefined);

  const restored = unpackInputStream(packed);
  assertEquals(restored, [row]);
});

Deno.test("19.6 identity values round-trip and empty actions drop", () => {
  const row = inputRow(4, { queued: true, actionTick: 4, weapon: 0 });
  const packed = JSON.stringify(packInputStream([row]));
  assertEquals(packed.includes("\"actions\""), true);
  assertEquals(packed.includes("\"backward\""), false);
  assertEquals(packed.includes("\"ordinal\""), false);
  assertEquals(packed.includes("\"weapon\""), false);
  assertEquals(unpackInputStream(packInputStream([row])), [row]);

  const quiet = inputRow(4);
  assertEquals(
    JSON.stringify(packInputStream([quiet])).includes("\"actions\""),
    false,
  );
  assertEquals(unpackInputStream(packInputStream([quiet])), [quiet]);
});

Deno.test("19.6 nothing to drop stays the same object text", () => {
  const row: RecordedTickInputs = {
    tick: 6,
    movement: [{
      tick: 5,
      playerId: "p1",
      association: "fresh",
      appliedSequence: 1,
      inputHoldTicks: 1,
      selectedInput: {
        sequence: 1,
        forward: true,
        backward: true,
        left: true,
        right: true,
        jump: true,
        sprint: true,
        crouch: true,
        yaw: 1,
        pitch: 1,
      },
    }],
    actions: [{
      tick: 5,
      playerId: "p1",
      ordinal: 1,
      kind: "reload",
    }],
  };
  assertEquals(JSON.stringify(packInputStream([row])), JSON.stringify([row]));
});

Deno.test("19.6 checkpoint and event identity round-trip", () => {
  const shell = player();
  const other = player({
    id: "p2",
    team: "B",
    alive: false,
    health: 0,
    onGround: false,
    x: 3,
    yaw: -0,
    isAgent: true,
    poseHistory: [pose(8, 1)],
    weaponLoadouts: [{ weaponId: 2, ammoInMag: 1, spareClips: 1 }],
    equipment: { ...defaultPlayerEquipment(), head: 4 },
    diedAtTick: 8,
    score: 2,
  });
  const cp = checkpoint(8, "rt", [shell, other]);
  const active = {
    ...cp,
    match: {
      ...cp.match,
      raidDoorPolicy: "open" as const,
      raid: {
        active: true as const,
        wave: 2,
        started: false,
        ended: false,
        expectedHumans: 4,
        failReason: null,
      },
    },
  };
  assertEquals(unpackCheckpoints(packCheckpoints([cp, active])), [cp, active]);

  const text = JSON.stringify(packCheckpoints([cp]));
  assertEquals(text.includes("\"projectiles\""), false);
  assertEquals(text.includes("\"backward\""), false);
  assertEquals(text.includes("\"chambered\":false"), true);
  assertEquals(text.includes("shellReloadNextAtTick"), false);

  const roster = emptyAuthoritativeRosterSnapshot({ id: "p1", name: "P1" });
  const events: RecordedTickEvents[] = [
    { tick: 1, events: [] },
    {
      tick: 2,
      events: [
        makeMatchStartEvent({
          appliedTick: 2,
          phase: "live",
          matchSeed: 42,
          matchEndTick: 100,
          doorCycleOriginTick: 2,
          scores: { A: 0, B: 0 },
          roster: [roster],
        }),
        makePlayerDiedEvent({
          appliedTick: 2,
          victimId: "p1",
          killerId: "p2",
          zone: "head",
          weapon: 0,
          killerName: "K",
          victimName: "V",
          killerTeam: "A",
          victimTeam: "B",
        }),
        makeReadyVoteEvent({ appliedTick: 2, playerId: "p1", ready: false }),
        makeMatchEndEvent({
          appliedTick: 2,
          winner: "A",
          scheduleRestart: false,
          restartSeconds: 0,
          restartAtTick: null,
          scores: { A: 1, B: 0 },
        }),
      ],
    },
  ];
  assertEquals(unpackEventStream(packEventStream(events)), events);
  const eventText = JSON.stringify(packEventStream(events));
  assertEquals(eventText.includes("\"maxHealth\""), false);
  assertEquals(eventText.includes("\"ready\""), false);
});

Deno.test("19.6 encode/decode keeps the container and shrinks a long input stream", () => {
  const base = buildCatalogFixture();
  const inputs: RecordedTickInputs[] = [];
  for (let tick = 10; tick <= 40; tick++) {
    inputs.push({
      tick,
      movement: [0, 1, 2, 3].map((i) => ({
        tick,
        playerId: `p${i}`,
        association: "hold" as const,
        appliedSequence: i + 1,
        inputHoldTicks: 2,
        selectedInput: {
          sequence: i + 1,
          forward: false,
          backward: false,
          left: false,
          right: false,
          jump: false,
          sprint: false,
          crouch: false,
          yaw: i === 0 ? -0 : 0.01 * i,
          pitch: 0,
        },
      })),
      actions: [],
    });
  }
  const container = buildReplayContainer({
    init: base.initialState,
    inputRows: inputs,
    eventRows: [{
      tick: 40,
      events: [
        makeMatchEndEvent({
          appliedTick: 40,
          winner: "A",
          scheduleRestart: false,
          restartSeconds: 0,
          restartAtTick: null,
          scores: { A: 0, B: 0 },
        }),
      ],
    }],
    checkpoints: [checkpoint(40, base.header.runtimeMatchId, [player(), player({ id: "p2", team: "B" })])],
    firstTick: 10,
    lastTick: 40,
  });

  const bytes = encodeReplayContainer(container);
  const again = encodeReplayContainer(container);
  assertEquals(again, bytes);
  assertEquals(decodeReplayContainer(bytes), container);

  const raw = JSON.stringify(container).length;
  assert(bytes.byteLength < raw * 0.85, `packed ${bytes.byteLength} vs raw ${raw}`);

  const legacy = decodeReplayContainer(new TextEncoder().encode(JSON.stringify(container)));
  assertEquals(legacy, container);

  const text = new TextDecoder().decode(bytes);
  assertEquals(text.includes("\"backward\""), false);
  assertEquals(text.startsWith("{\"header\":"), true);
});

Deno.test("19.6 tick 0 stays visible to the byte map", () => {
  const base = buildCatalogFixture();
  const container = buildReplayContainer({
    init: base.initialState,
    inputRows: [inputRow(0, { forward: true })],
    eventRows: [],
    checkpoints: [checkpoint(0, base.header.runtimeMatchId, [])],
    firstTick: 0,
    lastTick: 0,
  });
  const bytes = encodeReplayContainer(container);
  const map = deriveReplayByteMap(bytes);
  assertEquals(map?.checkpoints.map((row) => row.tick), [0]);
  assertEquals(map?.inputs.some((row) => row.tick === 0), true);
  assertEquals(decodeReplayContainer(bytes).inputStream[0]!.tick, 0);
});

Deno.test("19.6 catalog fixture still round-trips", () => {
  const container = buildCatalogFixture({ filledIndex: true });
  const bytes = encodeReplayContainer(container);
  assertEquals(decodeReplayContainer(bytes), container);
  const map = deriveReplayByteMap(bytes);
  assertEquals(map?.fileSizeBytes, bytes.byteLength);
  assert(map != null && map.checkpoints.length > 0);
});

Deno.test("19.6 bad bytes still use the encoding errors", () => {
  try {
    decodeReplayContainer(new TextEncoder().encode("{"));
    throw new Error("expected throw");
  } catch (err) {
    assert(err instanceof ReplayEncodingError);
    assertEquals(err.code, "replay-bad-json");
  }
});

Deno.test("19.6 packer does not import a compression frame", async () => {
  const src = await Deno.readTextFile(
    new URL("./replaySectionCompression.ts", import.meta.url),
  );
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assertEquals(/\bDeno\./.test(code), false);
  assertEquals(/\bgzip\b|\bdeflate\b|\bbrotli\b|CompressionStream/.test(code), false);
  assertEquals(/from\s+["']/.test(code), false);
});
