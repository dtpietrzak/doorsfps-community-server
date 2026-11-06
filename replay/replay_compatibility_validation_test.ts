/**
 * Epic 17.5 — incompatible replays fail before a resimulation.
 *
 * Run from server-community/:
 *   deno test -A replay/replay_compatibility_validation_test.ts
 */

import { assertEquals, assertThrows } from "@std/assert";
import { ReplayFormatVersionError } from "../shared/replay/replayFormatVersion.ts";
import { encodeCatalogFixture } from "./replayCatalogFixture.ts";
import { extractReplayCatalog } from "./replayCatalog.ts";
import {
  assertReplayPlayable,
  REPLAY_INCOMPATIBLE,
  replayCompatibility,
  replayCompatibilityFromContainer,
  replayCompatibilityFromRunSession,
  ReplayIncompatibleError,
} from "./replayCompatibility.ts";
import {
  decodeReplayContainer,
  ReplayEncodingError,
} from "./replayEncoding.ts";
import { replayFormatBumpOwner } from "./replayFormatCatalog.ts";
import { loadReplay } from "./replayLoader.ts";
import {
  createReplayRunner,
  ReplayRunnerError,
  type ReplayRunSession,
} from "./replaySimulationRunner.ts";
import { parseProvisionalReplayFile } from "./serializeReplaySession.ts";

function rewrite(
  bytes: Uint8Array,
  edit: (doc: Record<string, unknown>) => void,
): Uint8Array {
  const doc = JSON.parse(new TextDecoder().decode(bytes)) as Record<
    string,
    unknown
  >;
  edit(doc);
  return new TextEncoder().encode(JSON.stringify(doc));
}

function mapObjects(doc: Record<string, unknown>): Record<string, unknown>[] {
  const header = doc.header as Record<string, unknown>;
  const initial = doc.initialState as Record<string, unknown>;
  const metadata = initial.metadata as Record<string, unknown>;
  const init = initial.init as Record<string, unknown>;
  return [
    header.map as Record<string, unknown>,
    metadata.map as Record<string, unknown>,
    init.map as Record<string, unknown>,
  ];
}

function stubSession(metadata: Record<string, unknown>): ReplayRunSession {
  return {
    initialState: {
      runtimeMatchId: "rt-17-5",
      captureTick: 1,
      init: {
        map: { name: "encoding-map", version: 1 },
      },
      metadata,
    } as ReplayRunSession["initialState"],
    firstTick: 5,
    lastTick: 1,
    inputAt() {
      throw new Error("stepped");
    },
    eventsAt() {
      throw new Error("stepped");
    },
  };
}

Deno.test("17.5 rejection: a playable file loads, and the bump stamps nothing", () => {
  const { bytes } = encodeCatalogFixture();
  const session = loadReplay(bytes);
  const verdict = replayCompatibilityFromContainer(session);
  assertReplayPlayable(verdict);
  assertEquals(verdict.mode, "previous");
  assertEquals(replayCompatibilityFromRunSession(session).playable, true);

  const current = loadReplay(rewrite(bytes, (doc) => {
    for (const map of mapObjects(doc)) map.version = 2;
  }));
  assertEquals(replayCompatibilityFromContainer(current).mode, "current");

  const rule = replayFormatBumpOwner("load-rejection");
  assertEquals(rule.owner, "17.5");
  assertEquals(rule.stamp, null);
  assertEquals(rule.bumpsFormatVersion, false);
});

Deno.test("17.5 rejection: an omitted simulation stamp still loads and stays absent", () => {
  const { bytes } = encodeCatalogFixture();
  const session = loadReplay(rewrite(bytes, (doc) => {
    delete (doc.metadata as Record<string, unknown>).simulationVersion;
    delete ((doc.initialState as Record<string, unknown>).metadata as Record<
      string,
      unknown
    >).simulationVersion;
  }));
  assertEquals(session.metadata.simulationVersion, undefined);
  const verdict = replayCompatibilityFromContainer(session);
  assertEquals(verdict.simulation.versionClass, "absent");
  assertEquals(verdict.playable, true);
});

Deno.test("17.5 rejection: another simulation version decodes, catalogs, and does not load", async () => {
  const { bytes } = encodeCatalogFixture();
  const rewritten = rewrite(bytes, (doc) => {
    const initMeta = (doc.initialState as Record<string, unknown>)
      .metadata as Record<string, unknown>;
    (doc.metadata as Record<string, unknown>).simulationVersion = 2;
    initMeta.simulationVersion = 2;
  });
  const decoded = decodeReplayContainer(rewritten);
  assertEquals(decoded.metadata.simulationVersion, 2);
  assertEquals(replayCompatibilityFromContainer(decoded).mode, "unsupported");

  const stamp = await extractReplayCatalog(rewritten);
  assertEquals(stamp?.simulationVersion, 2);

  const error = assertThrows(
    () => loadReplay(rewritten),
    ReplayIncompatibleError,
  );
  assertEquals(error.code, REPLAY_INCOMPATIBLE);
  assertEquals(error.mode, "unsupported");
  assertEquals(error.detail?.includes("simulation=unknown"), true);
  assertThrows(
    () => parseProvisionalReplayFile(rewritten),
    ReplayIncompatibleError,
  );
});

Deno.test("17.5 rejection: the format and map gates stay in front of the policy", () => {
  const { bytes } = encodeCatalogFixture();
  const format = assertThrows(
    () =>
      loadReplay(rewrite(bytes, (doc) => {
        (doc.header as Record<string, unknown>).replayFormatVersion = 2;
      })),
    ReplayFormatVersionError,
  );
  assertEquals(format.code, "replay-version-mismatch");

  const map = assertThrows(
    () =>
      loadReplay(rewrite(bytes, (doc) => {
        for (const entry of mapObjects(doc)) entry.version = 99;
      })),
    ReplayEncodingError,
  );
  assertEquals(map.code, "replay-unsupported-map");
});

Deno.test("17.5 rejection: unplayable modes throw before a step", () => {
  const cases = [
    {
      classes: {
        format: "previous" as const,
        simulation: "current" as const,
        map: "current" as const,
      },
      mode: "migrate" as const,
    },
    {
      classes: {
        format: "current" as const,
        simulation: "previous" as const,
        map: "previous" as const,
      },
      mode: "historical-sim" as const,
    },
    {
      classes: {
        format: "current" as const,
        simulation: "unknown" as const,
        map: "current" as const,
      },
      mode: "unsupported" as const,
    },
  ];
  for (const row of cases) {
    const error = assertThrows(
      () => assertReplayPlayable(replayCompatibility(row.classes)),
      ReplayIncompatibleError,
    );
    assertEquals(error.mode, row.mode);
    assertEquals(error.code, REPLAY_INCOMPATIBLE);
  }
  assertReplayPlayable(replayCompatibility({
    format: "current",
    simulation: "absent",
    map: "previous",
  }));
});

Deno.test("17.5 rejection: the runner refuses a foreign ruleset and accepts a local session", () => {
  let stepped = false;
  const foreign = stubSession({
    raidMatch: { active: false },
    simulationVersion: 2,
    replayFormatVersion: 1,
    map: { name: "encoding-map", version: 1 },
  });
  foreign.inputAt = () => {
    stepped = true;
    throw new Error("stepped");
  };
  const refused = assertThrows(
    () => createReplayRunner(foreign, { collision: null as never }),
    ReplayIncompatibleError,
  );
  assertEquals(refused.mode, "unsupported");
  assertEquals(stepped, false);

  const local = stubSession({
    raidMatch: { active: false },
    map: { name: "encoding-map", version: 1 },
  });
  const verdict = replayCompatibilityFromRunSession(local);
  assertEquals(verdict.playable, true);
  assertEquals(verdict.simulation.versionClass, "absent");
  assertEquals(verdict.format.versionClass, "current");
  assertThrows(
    () => createReplayRunner(local, { collision: null as never }),
    ReplayRunnerError,
  );
});
