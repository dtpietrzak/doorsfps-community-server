/**
 * Epic 18.6 — regression suite.
 *
 * Run from server-community/:
 *   deno test -A --unstable-net --node-modules-dir=manual replay/replay_regression_suite_test.ts
 */

import { assertEquals, assertThrows } from "@std/assert";
import { WEAPON_RIFLE } from "../protocol/network.ts";
import type { AuthoritativeCheckpoint } from "./authoritativeCheckpoint.ts";

type Mutable<T> = {
  -readonly [K in keyof T]: T[K] extends readonly (infer U)[] ? Mutable<U>[]
    : T[K] extends object ? Mutable<T[K]>
    : T[K];
};
import { hashAuthoritativeCheckpoint } from "./replayStateHash.ts";
import {
  formatReplayDivergence,
  replayDivergenceFacts,
} from "./replayDivergence.ts";
import {
  checkReplayRegressionFixture,
  REPLAY_REGRESSION_FIXTURE_IDS,
  REPLAY_REGRESSION_INVALID,
  REPLAY_REGRESSION_MISMATCH,
  ReplayRegressionError,
  type ReplayRegressionFixtureId,
  replayRegressionFixtures,
} from "./replayRegressionSuite.ts";

function loadGolden(id: ReplayRegressionFixtureId): AuthoritativeCheckpoint {
  const url = new URL(`./fixtures/regression/${id}.json`, import.meta.url);
  return JSON.parse(Deno.readTextFileSync(url)) as AuthoritativeCheckpoint;
}

function fixtureById(id: ReplayRegressionFixtureId) {
  const fixture = replayRegressionFixtures().find((row) => row.id === id);
  if (!fixture) throw new Error(`missing fixture ${id}`);
  return fixture;
}

function player(
  checkpoint: AuthoritativeCheckpoint,
  id: string,
) {
  const row = checkpoint.players.find((player) => player.id === id);
  if (!row) throw new Error(`missing ${id}`);
  return row;
}

function assertCovers(
  id: ReplayRegressionFixtureId,
  checkpoint: AuthoritativeCheckpoint,
): void {
  const h1 = player(checkpoint, "h1");
  if (id === "movement") {
    assertEquals(Math.abs(h1.x) > 10 || Math.abs(h1.z) > 10, true);
    assertEquals(h1.sprintStamina < 1, true);
    return;
  }
  if (id === "gunfire") {
    assertEquals(player(checkpoint, "h2").health < 100, true);
    const pistol = h1.weaponLoadouts.find((slot) => slot.weaponId === 0);
    if (!pistol) throw new Error("missing pistol");
    assertEquals(pistol.ammoInMag < 7, true);
    return;
  }
  if (id === "melee") {
    assertEquals(player(checkpoint, "h2").health < 100, true);
    assertEquals(h1.lastMeleeAtTick != null, true);
    return;
  }
  if (id === "weapons") {
    assertEquals(h1.weaponId, WEAPON_RIFLE);
    assertEquals(h1.reloadEndsAtTick != null, true);
    return;
  }
  if (id === "abilities") {
    assertEquals(typeof h1.abilityEndsAtTick.quick, "number");
    return;
  }
  if (id === "doors") {
    assertEquals(h1.enemyDoorSinceTick != null, true);
    assertEquals(h1.score, 0);
    return;
  }
  if (id === "scoring") {
    assertEquals(h1.score >= 1, true);
    assertEquals(checkpoint.match.scores.A >= 1, true);
    return;
  }
  const h2 = player(checkpoint, "h2");
  assertEquals(h1.kills >= 1, true);
  assertEquals(h2.deaths >= 1, true);
  assertEquals(h2.alive, true);
}

for (const id of REPLAY_REGRESSION_FIXTURE_IDS) {
  Deno.test(`18.6 regression: ${id} matches its stored checkpoint`, () => {
    const fixture = fixtureById(id);
    const golden = loadGolden(id);
    const result = checkReplayRegressionFixture(fixture, golden);
    assertEquals(result.id, id);
    assertEquals(result.ticks, fixture.lastTick - fixture.firstTick + 1);
    assertEquals(result.hash, hashAuthoritativeCheckpoint(golden));
    assertCovers(id, result.checkpoint);
  });
}

Deno.test("18.6 regression: a changed component names the fixture", () => {
  const fixture = fixtureById("movement");
  const golden = loadGolden("movement");
  const tampered = structuredClone(golden) as Mutable<AuthoritativeCheckpoint>;
  const h1 = tampered.players.find((row) => row.id === "h1");
  if (!h1) throw new Error("missing h1");
  h1.yaw += 1;
  const error = assertThrows(
    () => checkReplayRegressionFixture(fixture, tampered),
    ReplayRegressionError,
  );
  assertEquals(error.code, REPLAY_REGRESSION_MISMATCH);
  assertEquals(error.fixtureId, "movement");
  if (!error.report) throw new Error("missing report");
  const facts = replayDivergenceFacts(error.report);
  assertEquals(facts.entity, "h1");
  assertEquals(facts.component, "yaw");
  assertEquals(
    formatReplayDivergence(error.report).includes('component "yaw"'),
    true,
  );
});

Deno.test("18.6 regression: a golden from another script is invalid", () => {
  const fixture = fixtureById("abilities");
  const golden = loadGolden("abilities");
  const wrong = structuredClone(golden) as Mutable<AuthoritativeCheckpoint>;
  wrong.tick = 0;
  const error = assertThrows(
    () => checkReplayRegressionFixture(fixture, wrong),
    ReplayRegressionError,
  );
  assertEquals(error.code, REPLAY_REGRESSION_INVALID);
  assertEquals(error.fixtureId, "abilities");
  assertEquals(error.report, null);
});

Deno.test("18.6 regression: fixture files match the catalog", () => {
  const dir = new URL("./fixtures/regression/", import.meta.url);
  const names = [...Deno.readDirSync(dir)].map((entry) => entry.name).sort();
  assertEquals(
    names,
    REPLAY_REGRESSION_FIXTURE_IDS.map((id) => `${id}.json`).sort(),
  );
  assertEquals(
    replayRegressionFixtures().map((fixture) => fixture.id),
    [...REPLAY_REGRESSION_FIXTURE_IDS],
  );
});

Deno.test("18.6 exclusion: the suite does not record or boot a server", async () => {
  const src = await Deno.readTextFile(
    new URL("./replayRegressionSuite.ts", import.meta.url),
  );
  const code = src
    .split("\n")
    .filter((line) =>
      !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//")
    )
    .join("\n");
  const banned = [
    /ReplayRecorder|GameServer|loadReplay|encodeReplayContainer|createReplayRunner/,
    /thinkAll|BotManager/,
    /Date\.now|Math\.random/,
    /createHash|sha256|crypto\.subtle/,
    /Deno\.(read|write)/,
  ];
  for (const pattern of banned) {
    assertEquals(pattern.test(code), false, `banned pattern: ${pattern}`);
  }
  assertEquals(code.includes("runDeterminismHarness"), true);
  assertEquals(code.includes("hashAuthoritativeCheckpoint"), true);
  assertEquals(code.includes("detectReplayDivergence"), true);
});
