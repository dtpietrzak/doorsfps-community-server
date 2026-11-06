/**
 * Epic 17.2 — simulation version recorded on a replay.
 *
 * Run from server-community/:
 *   deno test -A replay/replay_simulation_version_test.ts
 */

import { assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import { GAME_PROTO } from "../shared/net/opcodes.ts";
import { REPLAY_FORMAT_VERSION } from "../shared/replay/replayFormatVersion.ts";
import { SIMULATION_VERSION } from "../shared/sim/simulationVersion.ts";
import { encodeCatalogFixture } from "./replayCatalogFixture.ts";
import { extractReplayCatalog } from "./replayCatalog.ts";
import { decodeReplayContainer } from "./replayEncoding.ts";
import { replayFormatBumpOwner } from "./replayFormatCatalog.ts";
import {
  classifyReplaySimulationVersion,
  readReplayContainerSimulationVersion,
  REPLAY_SIMULATION_VERSION_INVALID,
  REPLAY_SIMULATION_VERSIONS,
  type ReplaySimulationVersionEntry,
  ReplaySimulationVersionError,
} from "./replaySimulationVersion.ts";

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

Deno.test("17.2 stamp: the writer version is its own constant", async () => {
  assertEquals(SIMULATION_VERSION, 1);
  assertEquals(REPLAY_SIMULATION_VERSIONS[0]?.version, SIMULATION_VERSION);
  assertEquals(replayFormatBumpOwner("simulation").stamp, "SIMULATION_VERSION");
  assertEquals(replayFormatBumpOwner("simulation").bumpsFormatVersion, false);

  const src = await Deno.readTextFile(
    new URL("../shared/sim/simulationVersion.ts", import.meta.url),
  );
  const code = src
    .split("\n")
    .filter((line) =>
      !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//")
    )
    .join("\n");
  assertEquals(
    /GAME_PROTO|REPLAY_FORMAT_VERSION|buildSha|map\.version/.test(code),
    false,
  );
  assertEquals(GAME_PROTO, 4);
  assertNotEquals(SIMULATION_VERSION, GAME_PROTO as number);
  assertEquals(typeof REPLAY_FORMAT_VERSION, "number");
});

Deno.test("17.2 record: a new file carries the writer version in both copies", async () => {
  const { bytes } = encodeCatalogFixture();
  const decoded = decodeReplayContainer(bytes);
  assertEquals(decoded.metadata.simulationVersion, SIMULATION_VERSION);
  assertEquals(
    decoded.initialState.metadata.simulationVersion,
    SIMULATION_VERSION,
  );
  assertEquals(
    readReplayContainerSimulationVersion(decoded),
    SIMULATION_VERSION,
  );
  assertEquals(classifyReplaySimulationVersion(SIMULATION_VERSION), "current");

  const stamp = await extractReplayCatalog(bytes);
  assertEquals(stamp?.simulationVersion, SIMULATION_VERSION);
  assertEquals(stamp?.gameProto, GAME_PROTO);
});

Deno.test("17.2 record: a file without the stamp still loads and stays absent", () => {
  const { bytes } = encodeCatalogFixture();
  const decoded = decodeReplayContainer(rewrite(bytes, (doc) => {
    delete (doc.metadata as Record<string, unknown>).simulationVersion;
    delete ((doc.initialState as Record<string, unknown>).metadata as Record<
      string,
      unknown
    >).simulationVersion;
  }));
  assertEquals(decoded.metadata.simulationVersion, undefined);
  assertEquals(readReplayContainerSimulationVersion(decoded), undefined);
  assertEquals(classifyReplaySimulationVersion(undefined), "absent");
  assertEquals(classifyReplaySimulationVersion(null), "absent");
});

Deno.test("17.2 record: another simulation version is kept and not treated as current", () => {
  const { bytes } = encodeCatalogFixture();
  const decoded = decodeReplayContainer(rewrite(bytes, (doc) => {
    const initMeta = (doc.initialState as Record<string, unknown>)
      .metadata as Record<
        string,
        unknown
      >;
    (doc.metadata as Record<string, unknown>).simulationVersion = 2;
    initMeta.simulationVersion = 2;
    (doc.metadata as Record<string, unknown>).gameProto = 99;
    initMeta.gameProto = 99;
  }));
  assertEquals(decoded.metadata.simulationVersion, 2);
  assertEquals(decoded.metadata.gameProto, 99);
  assertEquals(classifyReplaySimulationVersion(2), "unknown");
  assertEquals(
    classifyReplaySimulationVersion(
      2,
      [
        REPLAY_SIMULATION_VERSIONS[0]!,
        { version: 2, role: "previous" },
      ] satisfies readonly ReplaySimulationVersionEntry[],
    ),
    "previous",
  );
});

Deno.test("17.2 record: a torn or malformed stamp does not decode", () => {
  const { bytes } = encodeCatalogFixture();
  assertThrows(() =>
    decodeReplayContainer(rewrite(bytes, (doc) => {
      (doc.metadata as Record<string, unknown>).simulationVersion = 1;
      ((doc.initialState as Record<string, unknown>).metadata as Record<
        string,
        unknown
      >)
        .simulationVersion = 2;
    }))
  );
  assertThrows(() =>
    decodeReplayContainer(rewrite(bytes, (doc) => {
      (doc.metadata as Record<string, unknown>).simulationVersion = "1";
      ((doc.initialState as Record<string, unknown>).metadata as Record<
        string,
        unknown
      >)
        .simulationVersion = "1";
    }))
  );
  assertEquals(classifyReplaySimulationVersion("1"), "malformed");
  assertEquals(classifyReplaySimulationVersion(1.5), "malformed");
  assertEquals(classifyReplaySimulationVersion(0), "unknown");
});

Deno.test("17.2 catalog: the writer version cannot be labeled previous", () => {
  const error = assertThrows(
    () =>
      classifyReplaySimulationVersion(1, [
        { version: 1, role: "previous" },
      ]),
    ReplaySimulationVersionError,
  );
  assertEquals(error.code, REPLAY_SIMULATION_VERSION_INVALID);
});
