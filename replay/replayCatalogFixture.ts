/**
 * Minimal encoded replay used by epic 16 tests.
 * Copied from the 10.2 happy-path fixture. Not a production helper.
 */

import {
  emptyAuthoritativeRosterSnapshot,
  makeMatchInitEvent,
  makeMatchStartEvent,
  type MatchInitEvent,
} from "../shared/sim/authoritativeEvent.ts";
import { TICK_HZ } from "../shared/sim/game.ts";
import {
  buildMatchMetadata,
  type MatchMetadata,
} from "../shared/replay/matchMetadata.ts";
import type { AuthoritativeCheckpoint } from "./authoritativeCheckpoint.ts";
import { CHECKPOINT_SCHEMA_VERSION } from "./authoritativeCheckpoint.ts";
import type { RecordedInitialState } from "./recordedInitialState.ts";
import type { RecordedTickEvents } from "./recordedTickEvents.ts";
import type { RecordedTickInputs } from "./recordedTickInputs.ts";
import {
  buildReplayContainer,
  type ReplayContainer,
  type ReplayContainerIndex,
} from "./replayContainer.ts";
import { encodeReplayContainer } from "./replayEncoding.ts";
import { buildReplayIndexFromContainerSections } from "./replayIndex.ts";

function sampleRoster(name = "P1") {
  return emptyAuthoritativeRosterSnapshot({
    id: "p1",
    name,
    team: "A",
  });
}

function sampleInit(name: string): MatchInitEvent {
  return makeMatchInitEvent({
    appliedTick: 10,
    map: { name: "encoding-map", version: 1 },
    matchSeed: 42,
    matchDurationTicks: 60 * TICK_HZ,
    prematchEnabled: false,
    phase: "live",
    raidDoorPolicy: "off",
    debugForceDoorsOpen: false,
    scores: { A: 0, B: 0 },
    roster: [sampleRoster(name)],
  });
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
      runtimeMatchId: "rt-encoding-1",
      serverName: "encoding-test",
      serverId: "srv-enc",
      modeId: "standard",
      raidId: null,
      buildSha: "cafebabe",
      raidMatch: { active: false },
    },
    { capturedAtIso: "2026-01-01T00:00:00.000Z" },
  );
  if (!built.ok) throw new Error(built.reason);
  return built.metadata;
}

function sampleRecordedInit(name: string): RecordedInitialState {
  const init = sampleInit(name);
  return {
    runtimeMatchId: "rt-encoding-1",
    captureTick: init.appliedTick,
    init,
    metadata: sampleMetadata(init),
  };
}

function inputRow(tick: number): RecordedTickInputs {
  return {
    tick,
    movement: [
      {
        tick,
        playerId: "p1",
        association: "fresh",
        appliedSequence: 1,
        inputHoldTicks: 1,
        selectedInput: {
          sequence: 1,
          forward: true,
          backward: false,
          left: false,
          right: false,
          jump: false,
          sprint: false,
          crouch: false,
          meleeLunge: false,
          yaw: 1.25,
          pitch: -0.125,
        },
      },
    ],
    actions: [],
  };
}

function eventRow(
  tick: number,
  events: RecordedTickEvents["events"] = [],
): RecordedTickEvents {
  return { tick, events };
}

function sampleCheckpoint(tick: number): AuthoritativeCheckpoint {
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    tick,
    runtimeMatchId: "rt-encoding-1",
    map: { name: "encoding-map", version: 1 },
    matchSeed: 42,
    rng: {
      damage: 1,
      spread: 2,
      spawn: 3,
      agents: 4,
      collisionSpawn: 5,
    },
    match: {
      scores: { A: 1, B: 0 },
      matchOver: false,
      inPrematch: false,
      restartAtTick: null,
      doorCycleOriginTick: 10,
      doorsPowerUpUntilTick: null,
      raidDoorPolicy: "off",
      debugForceDoorsOpen: false,
      matchEndTick: 10 + 60 * TICK_HZ,
      matchDurationTicks: 60 * TICK_HZ,
      raid: { active: false },
    },
    players: [],
    projectiles: [],
  };
}

export type CatalogFixtureOptions = {
  /** Player name. A non-ascii name checks the byte map's UTF-8 cursor. */
  rosterName?: string;
  /** Attach a filled 10.3 index. Default is the empty reserved index. */
  filledIndex?: boolean;
  /** When false, the checkpoint list is empty. */
  checkpoints?: boolean;
};

export function buildCatalogFixture(
  options: CatalogFixtureOptions = {},
): ReplayContainer {
  const init = sampleRecordedInit(options.rosterName ?? "P1");
  const inputs = [inputRow(10), inputRow(11), inputRow(12)];
  const events = [
    eventRow(10),
    eventRow(11, [
      makeMatchStartEvent({
        appliedTick: 11,
        phase: "live",
        matchSeed: init.init.matchSeed,
        matchEndTick: init.metadata.matchEndTick,
        doorCycleOriginTick: init.metadata.doorCycleOriginTick,
        scores: init.init.scores,
        roster: init.init.roster,
      }),
    ]),
    eventRow(12),
  ];
  const checkpoints = options.checkpoints === false
    ? []
    : [sampleCheckpoint(12)];
  const draft = buildReplayContainer({
    init,
    inputRows: inputs,
    eventRows: events,
    checkpoints,
  });
  if (!options.filledIndex) return draft;
  const index: ReplayContainerIndex = buildReplayIndexFromContainerSections({
    inputStream: draft.inputStream,
    eventStream: draft.eventStream,
    checkpoints: draft.checkpoints,
    firstTick: draft.header.firstTick,
    lastTick: draft.header.lastTick,
  });
  return buildReplayContainer({
    init,
    inputRows: inputs,
    eventRows: events,
    checkpoints,
    index,
  });
}

export function encodeCatalogFixture(
  options: CatalogFixtureOptions = {},
): { container: ReplayContainer; bytes: Uint8Array } {
  const container = buildCatalogFixture(options);
  return { container, bytes: encodeReplayContainer(container) };
}
