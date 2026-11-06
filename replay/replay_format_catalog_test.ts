/**
 * Epic 17.1 — replay format-version catalog.
 *
 * Run from server-community/:
 *   deno test -A replay/replay_format_catalog_test.ts
 */

import { assertEquals, assertThrows } from "@std/assert";
import {
  isSupportedReplayFormatVersion,
  REPLAY_FORMAT_VERSION,
} from "../shared/replay/replayFormatVersion.ts";
import { CHECKPOINT_SCHEMA_VERSION } from "./authoritativeCheckpoint.ts";
import {
  assertReplayFormatCatalog,
  classifyReplayFormatVersion,
  currentReplayFormatEntry,
  replayFormatBumpOwner,
  replayFormatCatalogEntry,
  REPLAY_FORMAT_BUMP_RULES,
  REPLAY_FORMAT_BUMP_UNKNOWN,
  REPLAY_FORMAT_CATALOG,
  REPLAY_FORMAT_CATALOG_INVALID,
  REPLAY_FORMAT_CHANGE_KINDS,
  ReplayFormatCatalogError,
  type ReplayFormatCatalogEntry,
} from "./replayFormatCatalog.ts";
import { REPLAY_CONTAINER_SECTION_ORDER } from "./replayContainer.ts";
import { REPLAY_INDEX_VERSION } from "./replayIndex.ts";

Deno.test("17.1 catalog: one current row, the writer version, live sections and dialects", () => {
  assertReplayFormatCatalog();
  assertEquals(REPLAY_FORMAT_CATALOG.length, 1);
  const current = currentReplayFormatEntry();
  assertEquals(current.version, REPLAY_FORMAT_VERSION);
  assertEquals(current.version, 1);
  assertEquals(current.role, "current");
  assertEquals(current.sections, REPLAY_CONTAINER_SECTION_ORDER);
  assertEquals(isSupportedReplayFormatVersion(current.version), true);

  const index = current.dialects.find((row) => row.kind === "index");
  const checkpoint = current.dialects.find((row) => row.kind === "checkpoint");
  const integrity = current.dialects.find((row) => row.kind === "integrity");
  assertEquals(index, {
    kind: "index",
    version: REPLAY_INDEX_VERSION,
    when: "filled-index",
  });
  assertEquals(checkpoint, {
    kind: "checkpoint",
    version: CHECKPOINT_SCHEMA_VERSION,
    when: "every-frame",
  });
  assertEquals(integrity, {
    kind: "integrity",
    version: null,
    when: "reserved",
  });
  assertEquals(replayFormatCatalogEntry(1), current);
  assertEquals(replayFormatCatalogEntry(2), null);
});

Deno.test("17.1 classify: current, unknown, absent, malformed; previous does not load", () => {
  assertEquals(classifyReplayFormatVersion(1), "current");
  assertEquals(classifyReplayFormatVersion(1.0), "current");
  assertEquals(classifyReplayFormatVersion(REPLAY_FORMAT_VERSION), "current");

  for (const value of [0, 2, -1, 99]) {
    assertEquals(classifyReplayFormatVersion(value), "unknown");
    assertEquals(isSupportedReplayFormatVersion(value), false);
  }
  for (const value of [undefined, null]) {
    assertEquals(classifyReplayFormatVersion(value), "absent");
    assertEquals(isSupportedReplayFormatVersion(value), false);
  }
  for (const value of [1.5, Number.NaN, Number.POSITIVE_INFINITY, "1", "", {}, [], true, 1n]) {
    assertEquals(classifyReplayFormatVersion(value), "malformed");
    assertEquals(isSupportedReplayFormatVersion(value), false);
  }

  const current = currentReplayFormatEntry();
  const withPrevious: readonly ReplayFormatCatalogEntry[] = [
    current,
    {
      version: 2,
      role: "previous",
      sections: current.sections,
      dialects: current.dialects,
    },
  ];
  assertReplayFormatCatalog(withPrevious);
  assertEquals(classifyReplayFormatVersion(2, withPrevious), "previous");
  assertEquals(isSupportedReplayFormatVersion(2), false);
  assertEquals(classifyReplayFormatVersion(2), "unknown");
  assertEquals(classifyReplayFormatVersion(1, withPrevious), "current");
  assertEquals(classifyReplayFormatVersion(3, withPrevious), "unknown");
});

Deno.test("17.1 catalog: a current row that is not the writer version is invalid", () => {
  const current = currentReplayFormatEntry();
  const mislabeled: readonly ReplayFormatCatalogEntry[] = [
    { ...current, role: "previous" },
    {
      version: 2,
      role: "current",
      sections: current.sections,
      dialects: current.dialects,
    },
  ];
  const error = assertThrows(
    () => classifyReplayFormatVersion(1, mislabeled),
    ReplayFormatCatalogError,
  );
  assertEquals(error.code, REPLAY_FORMAT_CATALOG_INVALID);
});

Deno.test("17.1 bump rules: only a section-contract change bumps the format version", () => {
  assertEquals(
    REPLAY_FORMAT_BUMP_RULES.map((rule) => rule.kind),
    [...REPLAY_FORMAT_CHANGE_KINDS],
  );
  const bumping = REPLAY_FORMAT_BUMP_RULES.filter((rule) => rule.bumpsFormatVersion);
  assertEquals(bumping.map((rule) => rule.kind), ["file-sections"]);
  assertEquals(replayFormatBumpOwner("file-sections").stamp, "REPLAY_FORMAT_VERSION");
  assertEquals(replayFormatBumpOwner("index-dialect").owner, "10.3");
  assertEquals(replayFormatBumpOwner("checkpoint-dialect").owner, "9.1");
  assertEquals(replayFormatBumpOwner("integrity-dialect").stamp, null);
  assertEquals(replayFormatBumpOwner("simulation").owner, "17.2");
  assertEquals(replayFormatBumpOwner("map").owner, "17.3");
  assertEquals(replayFormatBumpOwner("support-policy").owner, "17.4");
  assertEquals(replayFormatBumpOwner("load-rejection").owner, "17.5");
  assertEquals(replayFormatBumpOwner("clip-presentation").bumpsFormatVersion, false);

  for (const kind of ["migration", "historical-sim", ""]) {
    const error = assertThrows(
      () => replayFormatBumpOwner(kind),
      ReplayFormatCatalogError,
    );
    assertEquals(error.code, REPLAY_FORMAT_BUMP_UNKNOWN);
  }
});

Deno.test("17.1 determinism and freeze: same value, catalog is not writable", () => {
  assertEquals(classifyReplayFormatVersion(2), classifyReplayFormatVersion(2));
  assertEquals(classifyReplayFormatVersion(1), classifyReplayFormatVersion(1));
  assertThrows(() => {
    (REPLAY_FORMAT_CATALOG as ReplayFormatCatalogEntry[]).push(
      currentReplayFormatEntry(),
    );
  });
  assertThrows(() => {
    (currentReplayFormatEntry() as { role: string }).role = "previous";
  });
});

Deno.test("17.1 exclusion: catalog does not decode, store, migrate, or widen the gate", async () => {
  const src = await Deno.readTextFile(
    new URL("./replayFormatCatalog.ts", import.meta.url),
  );
  assertEquals(/REPLAY_FORMAT_VERSION\s*=\s*1/.test(src), false);
  assertEquals(/REPLAY_CONTAINER_SCHEMA_VERSION/.test(src), false);

  const codeLines = src
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"))
    .join("\n");
  const banned = [
    /from ["'].*replayEncoding/,
    /from ["'].*ReplayBlobStore/,
    /from ["'].*\/net\//,
    /from ["'].*GameServer/,
    /Deno\.(read|write|open|stat|mkdir)/,
    /createHash|crypto\.subtle|sha256/,
    /\bgzip\b|\bdeflate\b/,
    /historicalSim|migrateReplay/,
    /assertReplayFormatVersion/,
  ];
  for (const pattern of banned) {
    assertEquals(pattern.test(codeLines), false, `banned pattern: ${pattern}`);
  }
});
