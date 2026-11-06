/**
 * Epic 17.4 — compatibility policy.
 *
 * Run from server-community/:
 *   deno test -A replay/replay_compatibility_test.ts
 */

import { assertEquals, assertThrows } from "@std/assert";
import { isSupportedReplayFormatVersion } from "../shared/replay/replayFormatVersion.ts";
import { REPLAY_FORMAT_VERSION } from "../shared/replay/matchMetadata.ts";
import { isSupportedMapFormatVersion } from "../shared/world/doorsMapFormat.ts";
import { encodeCatalogFixture } from "./replayCatalogFixture.ts";
import { decodeReplayContainer } from "./replayEncoding.ts";
import { replayFormatBumpOwner } from "./replayFormatCatalog.ts";
import {
  REPLAY_COMPATIBILITY_INVALID,
  REPLAY_FORMAT_SUPPORT,
  REPLAY_MAP_SUPPORT,
  REPLAY_SIMULATION_SUPPORT,
  replayCompatibility,
  ReplayCompatibilityError,
  replayCompatibilityFromContainer,
  replayCompatibilityFromVersions,
  type ReplayCompatibilityMode,
  replayFormatSupport,
  replayMapSupport,
  replaySimulationSupport,
} from "./replayCompatibility.ts";
import type { ReplayFormatVersionClass } from "./replayFormatCatalog.ts";

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

Deno.test("17.4 policy: each class has one mode, and the bump stamps nothing", () => {
  assertEquals(REPLAY_FORMAT_SUPPORT.previous, "migrate");
  assertEquals(REPLAY_SIMULATION_SUPPORT.previous, "historical-sim");
  assertEquals(REPLAY_SIMULATION_SUPPORT.absent, "current");
  assertEquals(REPLAY_MAP_SUPPORT.previous, "previous");
  assertEquals(replayFormatSupport("previous").playable, false);
  assertEquals(replaySimulationSupport("previous").playable, false);
  assertEquals(replaySimulationSupport("absent"), {
    versionClass: "absent",
    mode: "current",
    playable: true,
  });
  assertEquals(replayMapSupport("previous").playable, true);
  assertEquals(replayFormatSupport("current").mode, "current");
  assertEquals(replayMapSupport("unknown").mode, "unsupported");

  const rule = replayFormatBumpOwner("support-policy");
  assertEquals(rule.owner, "17.4");
  assertEquals(rule.stamp, null);
  assertEquals(rule.bumpsFormatVersion, false);
  assertEquals(REPLAY_FORMAT_VERSION, 1);

  assertThrows(() => {
    (REPLAY_FORMAT_SUPPORT as { current: ReplayCompatibilityMode }).current =
      "migrate";
  });
  const error = assertThrows(
    () => replayFormatSupport("nope" as ReplayFormatVersionClass),
    ReplayCompatibilityError,
  );
  assertEquals(error.code, REPLAY_COMPATIBILITY_INVALID);
});

Deno.test("17.4 policy: the fixture map schema plays, and the current schema is current", () => {
  const { bytes } = encodeCatalogFixture();
  const decoded = decodeReplayContainer(bytes);
  const played = replayCompatibilityFromContainer(decoded);
  assertEquals(played.playable, true);
  assertEquals(played.mode, "previous");
  assertEquals(played.format.versionClass, "current");
  assertEquals(played.simulation.versionClass, "current");
  assertEquals(played.map.versionClass, "previous");

  const currentMap = decodeReplayContainer(rewrite(bytes, (doc) => {
    for (const map of mapObjects(doc)) map.version = 2;
  }));
  const current = replayCompatibilityFromContainer(currentMap);
  assertEquals(current.mode, "current");
  assertEquals(current.playable, true);
  assertEquals(current.map.versionClass, "current");
});

Deno.test("17.4 policy: an omitted simulation stamp stays absent and plays", () => {
  const { bytes } = encodeCatalogFixture();
  const decoded = decodeReplayContainer(rewrite(bytes, (doc) => {
    delete (doc.metadata as Record<string, unknown>).simulationVersion;
    delete ((doc.initialState as Record<string, unknown>).metadata as Record<
      string,
      unknown
    >).simulationVersion;
  }));
  assertEquals(decoded.metadata.simulationVersion, undefined);
  const verdict = replayCompatibilityFromContainer(decoded);
  assertEquals(verdict.simulation.versionClass, "absent");
  assertEquals(verdict.simulation.playable, true);
  assertEquals(verdict.playable, true);
  assertEquals(verdict.mode, "previous");
  assertEquals(
    replayCompatibilityFromVersions({
      format: 1,
      simulation: undefined,
      map: 1,
    }).simulation.versionClass,
    "absent",
  );
});

Deno.test("17.4 policy: another simulation version still decodes and is unsupported", () => {
  const { bytes } = encodeCatalogFixture();
  const decoded = decodeReplayContainer(rewrite(bytes, (doc) => {
    const initMeta = (doc.initialState as Record<string, unknown>)
      .metadata as Record<string, unknown>;
    (doc.metadata as Record<string, unknown>).simulationVersion = 2;
    initMeta.simulationVersion = 2;
  }));
  assertEquals(decoded.metadata.simulationVersion, 2);
  const verdict = replayCompatibilityFromContainer(decoded);
  assertEquals(verdict.simulation.versionClass, "unknown");
  assertEquals(verdict.mode, "unsupported");
  assertEquals(verdict.playable, false);
  assertEquals(
    replayCompatibilityFromVersions({ format: 1, simulation: 2, map: 2 }).mode,
    "unsupported",
  );
});

Deno.test("17.4 policy: combined severity follows the axes", () => {
  const cases: {
    classes: {
      format: "current" | "previous" | "unknown" | "absent" | "malformed";
      simulation: "current" | "previous" | "unknown" | "absent" | "malformed";
      map: "current" | "previous" | "unknown" | "absent" | "malformed";
    };
    mode: ReplayCompatibilityMode;
    playable: boolean;
  }[] = [
    {
      classes: { format: "previous", simulation: "current", map: "current" },
      mode: "migrate",
      playable: false,
    },
    {
      classes: { format: "current", simulation: "previous", map: "current" },
      mode: "historical-sim",
      playable: false,
    },
    {
      classes: { format: "current", simulation: "previous", map: "previous" },
      mode: "historical-sim",
      playable: false,
    },
    {
      classes: { format: "previous", simulation: "current", map: "previous" },
      mode: "migrate",
      playable: false,
    },
    {
      classes: { format: "previous", simulation: "previous", map: "previous" },
      mode: "historical-sim",
      playable: false,
    },
    {
      classes: { format: "unknown", simulation: "current", map: "current" },
      mode: "unsupported",
      playable: false,
    },
    {
      classes: { format: "current", simulation: "current", map: "absent" },
      mode: "unsupported",
      playable: false,
    },
    {
      classes: { format: "current", simulation: "current", map: "malformed" },
      mode: "unsupported",
      playable: false,
    },
    {
      classes: { format: "current", simulation: "malformed", map: "current" },
      mode: "unsupported",
      playable: false,
    },
    {
      classes: { format: "current", simulation: "current", map: "current" },
      mode: "current",
      playable: true,
    },
  ];
  for (const row of cases) {
    const verdict = replayCompatibility(row.classes);
    assertEquals(verdict.mode, row.mode);
    assertEquals(verdict.playable, row.playable);
  }
});

Deno.test("17.4 exclusion: policy does not widen either load gate", async () => {
  assertEquals(isSupportedReplayFormatVersion(1), true);
  assertEquals(isSupportedReplayFormatVersion(REPLAY_FORMAT_VERSION), true);
  assertEquals(isSupportedReplayFormatVersion(2), false);
  assertEquals(isSupportedMapFormatVersion(1), true);
  assertEquals(isSupportedMapFormatVersion(2), true);
  assertEquals(isSupportedMapFormatVersion(99), false);

  const src = await Deno.readTextFile(
    new URL("./replayCompatibility.ts", import.meta.url),
  );
  const code = src
    .split("\n")
    .filter((line) =>
      !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//")
    )
    .join("\n");
  const banned = [
    /isSupportedReplayFormatVersion/,
    /isSupportedMapFormatVersion/,
    /decodeReplayContainer/,
    /from ["'].*replayEncoding/,
    /from ["'].*replayLoader/,
    /GameLoop|createReplayRunner/,
    /migrateReplay|historicalSim/,
    /SIMULATION_VERSION/,
    /Deno\.(read|write|open|stat|mkdir)/,
  ];
  for (const pattern of banned) {
    assertEquals(pattern.test(code), false, `banned pattern: ${pattern}`);
  }
});
