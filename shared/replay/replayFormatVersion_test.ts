/**
 * Epic 10.5 — minimal replay format-version gate tests.
 */

import {
  assertEquals,
  assertMatch,
  assertThrows,
} from "jsr:@std/assert@1";
import { REPLAY_FORMAT_VERSION as PLANTED_CONSTANT } from "./matchMetadata.ts";
import {
  assertReplayFormatVersion,
  isSupportedReplayFormatVersion,
  REPLAY_FORMAT_VERSION,
  REPLAY_FORMAT_VERSION_MISMATCH,
  ReplayFormatVersionError,
} from "./replayFormatVersion.ts";

Deno.test("10.5 stamp: gate re-exports the planted constant (no second constant)", () => {
  assertEquals(REPLAY_FORMAT_VERSION, PLANTED_CONSTANT);
  assertEquals(REPLAY_FORMAT_VERSION, 1);
});

Deno.test("10.5 accept: integer 1 is supported", () => {
  assertEquals(isSupportedReplayFormatVersion(1), true);
  assertEquals(isSupportedReplayFormatVersion(REPLAY_FORMAT_VERSION), true);
  const header = { replayFormatVersion: 1 as const };
  assertReplayFormatVersion(header);
  assertEquals(header.replayFormatVersion, 1);
});

Deno.test("10.5 reject: missing / null header / undefined / 0 / 2 / -1 / string / NaN / object", () => {
  const cases: unknown[] = [
    undefined,
    null,
    0,
    2,
    -1,
    "1",
    NaN,
    { v: 1 },
    1.5,
    true,
  ];
  for (const seen of cases) {
    assertEquals(
      isSupportedReplayFormatVersion(seen),
      false,
      `expected reject for ${String(seen)}`,
    );
  }

  for (const bad of [null, undefined, {}] as const) {
    const err = assertThrows(
      () => assertReplayFormatVersion(bad as never),
      ReplayFormatVersionError,
    ) as ReplayFormatVersionError;
    assertMatch(err.message, /missing/);
    assertEquals(err.code, "replay-version-mismatch");
  }

  for (const seen of [0, 2, -1, "1", NaN, 1.5] as const) {
    const err = assertThrows(
      () => assertReplayFormatVersion({ replayFormatVersion: seen }),
      ReplayFormatVersionError,
    ) as ReplayFormatVersionError;
    assertEquals(err.code, REPLAY_FORMAT_VERSION_MISMATCH);
    assertEquals(err.code, "replay-version-mismatch");
    assertEquals(err.expected, 1);
    if (typeof seen === "number" && Number.isNaN(seen)) {
      assertEquals(Number.isNaN(err.seen as number), true);
    } else {
      assertEquals(err.seen, seen);
    }
  }
});

Deno.test("10.5 reject: never a raw TypeError; always named mismatch", () => {
  try {
    assertReplayFormatVersion({ replayFormatVersion: "1" });
    throw new Error("expected throw");
  } catch (e) {
    assertEquals(e instanceof ReplayFormatVersionError, true);
    assertEquals(e instanceof TypeError, false);
    assertEquals((e as ReplayFormatVersionError).code, "replay-version-mismatch");
  }
});

Deno.test("10.5 freeze: gate never mutates its input", () => {
  const header = Object.freeze({
    replayFormatVersion: 2 as unknown as 1,
    matchSeed: 99,
  });
  const before = JSON.stringify(header);
  assertThrows(() => assertReplayFormatVersion(header), ReplayFormatVersionError);
  assertEquals(JSON.stringify(header), before);

  const ok = Object.freeze({ replayFormatVersion: 1 as const, matchSeed: 7 });
  const beforeOk = JSON.stringify(ok);
  assertReplayFormatVersion(ok);
  assertEquals(JSON.stringify(ok), beforeOk);
});

Deno.test("10.5 companions: echoed in rejection, never interpreted as accept/reject", () => {
  // Exotic-but-wellformed companions still pass when version is 1.
  assertReplayFormatVersion({
    replayFormatVersion: 1,
    map: { name: "exotic-map", version: 99 },
    matchSeed: "not-a-number-but-opaque",
    tickRate: 120,
    gameProto: "future-proto",
    buildSha: "deadbeef",
  });

  const err = assertThrows(
    () =>
      assertReplayFormatVersion({
        replayFormatVersion: 2,
        map: { name: "exotic-map", version: 3 },
        matchSeed: 42,
        tickRate: 60,
        gameProto: "gp",
        buildSha: "abc",
      }),
    ReplayFormatVersionError,
  ) as ReplayFormatVersionError;
  assertMatch(err.message, /exotic-map/);
  assertMatch(err.message, /v3/);
  assertMatch(err.message, /seed 42/);
  assertEquals(err.companions?.map?.name, "exotic-map");
  assertEquals(err.companions?.matchSeed, 42);
});

Deno.test("10.5 companions: explicit echo overrides header extraction", () => {
  const err = assertThrows(
    () =>
      assertReplayFormatVersion(
        { replayFormatVersion: 0, map: { name: "from-header", version: 1 } },
        { map: { name: "from-arg", version: 9 }, matchSeed: 7 },
      ),
    ReplayFormatVersionError,
  ) as ReplayFormatVersionError;
  assertMatch(err.message, /from-arg/);
  assertMatch(err.message, /v9/);
  assertEquals(err.companions?.map?.name, "from-arg");
});

Deno.test("10.5 sub-versions: top-level gate ignores indexVersion / integrityVersion", () => {
  // Unknown section dialects with top-level 1 still pass the file-identity gate.
  const header = {
    replayFormatVersion: 1 as const,
    indexVersion: 99,
    integrityVersion: 99,
  };
  assertReplayFormatVersion(header);
  assertEquals(isSupportedReplayFormatVersion(header.replayFormatVersion), true);
});

Deno.test("10.5 determinism: same header → same verdict", () => {
  const header = { replayFormatVersion: 2 as unknown };
  const a = assertThrows(
    () => assertReplayFormatVersion(header),
    ReplayFormatVersionError,
  ) as ReplayFormatVersionError;
  const b = assertThrows(
    () => assertReplayFormatVersion(header),
    ReplayFormatVersionError,
  ) as ReplayFormatVersionError;
  assertEquals(a.code, b.code);
  assertEquals(a.expected, b.expected);
  assertEquals(a.seen, b.seen);
  assertEquals(a.message, b.message);
});

Deno.test("10.5 exclusion: gate module has no I/O / codec / sim / store imports", async () => {
  const src = await Deno.readTextFile(
    new URL("./replayFormatVersion.ts", import.meta.url),
  );
  // Single constant source: re-exports planted matchMetadata constant only.
  assertMatch(src, /from "\.\/matchMetadata\.ts"/);
  assertEquals(/REPLAY_CONTAINER_SCHEMA_VERSION/.test(src), false);

  // Scan import/code lines only — header comments may name excluded domains.
  const codeLines = src
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"))
    .join("\n");

  const banned = [
    /from ["'].*replayEncoding/,
    /from ["'].*ReplayBlobStore/,
    /from ["'].*replayContainer/,
    /from ["'].*\/net\//,
    /from ["'].*GameServer/,
    /Deno\.(read|write|open|stat|mkdir)/,
    /createHash|crypto\.subtle|sha256/,
    /\bgzip\b|\bdeflate\b/,
    /historicalSim/,
  ];
  for (const pattern of banned) {
    assertEquals(
      pattern.test(codeLines),
      false,
      `banned import/pattern: ${pattern}`,
    );
  }
  // Exactly one relative import (matchMetadata).
  const importCount = [...codeLines.matchAll(/^import\s/gm)].length;
  assertEquals(importCount, 1);
});

Deno.test("10.5 no-second-constant: shared + replay packages reuse one stamp", async () => {
  const gateSrc = await Deno.readTextFile(
    new URL("./replayFormatVersion.ts", import.meta.url),
  );
  assertEquals(/REPLAY_FORMAT_VERSION\s*=\s*1/.test(gateSrc), false);
  assertMatch(gateSrc, /REPLAY_FORMAT_VERSION/);

  const metaSrc = await Deno.readTextFile(
    new URL("./matchMetadata.ts", import.meta.url),
  );
  assertMatch(metaSrc, /REPLAY_FORMAT_VERSION = 1 as const/);
});
