import { assertEquals } from "jsr:@std/assert@1";
import {
  buildMmsLandscape,
  mmsTierIndexForScore,
  mmsTierIndexFromBelowCount,
  MMS_RANKS,
  MMS_RANK_COUNT,
} from "./mmsRanks.ts";

Deno.test("MMS ranks catalog has 10 ordered tiers", () => {
  assertEquals(MMS_RANKS.length, MMS_RANK_COUNT);
  assertEquals(MMS_RANKS[0]!.id, "scrap");
  assertEquals(MMS_RANKS[9]!.id, "singularity");
  for (let i = 0; i < MMS_RANKS.length; i++) {
    assertEquals(MMS_RANKS[i]!.tierIndex, i);
    assertEquals(MMS_RANKS[i]!.rank, i + 1);
  }
});

Deno.test("floor percentile bands on a flat 100-player ladder", () => {
  // 100 unique scores 0..99 → each decile is exactly 10 players.
  const pop = Array.from({ length: 100 }, (_, i) => i);
  for (let s = 0; s < 100; s++) {
    const tier = mmsTierIndexForScore(s, pop);
    assertEquals(tier, Math.floor(s / 10), `score ${s}`);
  }
});

Deno.test("ties take the lowest rank in the group", () => {
  // Ten players, five tied at the top score.
  const pop = [1, 2, 3, 4, 5, 10, 10, 10, 10, 10];
  // below for 10 = 5 → floor(5*10/10) = 5 → Sentinel (tier 5)
  assertEquals(mmsTierIndexForScore(10, pop), 5);
  // All five tied share that same (lowest) tier for the group.
  for (let i = 0; i < 5; i++) {
    assertEquals(mmsTierIndexForScore(10, pop), 5);
  }
  assertEquals(mmsTierIndexForScore(1, pop), 0);
});

Deno.test("single player is Scrap (bottom of the only percentile)", () => {
  assertEquals(mmsTierIndexForScore(9999, [9999]), 0);
});

Deno.test("empty population → Scrap", () => {
  assertEquals(mmsTierIndexFromBelowCount(0, 0), 0);
  assertEquals(mmsTierIndexForScore(100, []), 0);
});

Deno.test("landscape buckets sum to population and report ranges", () => {
  const pop = Array.from({ length: 100 }, (_, i) => i);
  const land = buildMmsLandscape(pop);
  assertEquals(land.totalPlayers, 100);
  let sum = 0;
  for (const t of land.tiers) {
    sum += t.playerCount;
    assertEquals(t.playerCount, 10);
    assertEquals(t.minMms, t.tierIndex * 10);
    assertEquals(t.maxMms, t.tierIndex * 10 + 9);
  }
  assertEquals(sum, 100);
});

Deno.test("landscape empty tier when all scores identical", () => {
  const pop = [500, 500, 500, 500];
  const land = buildMmsLandscape(pop);
  // below=0 for all → everyone Scrap
  assertEquals(land.tiers[0]!.playerCount, 4);
  assertEquals(land.tiers[0]!.minMms, 500);
  assertEquals(land.tiers[0]!.maxMms, 500);
  for (let i = 1; i < 10; i++) {
    assertEquals(land.tiers[i]!.playerCount, 0);
    assertEquals(land.tiers[i]!.minMms, null);
  }
});
