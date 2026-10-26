import { assert, assertEquals } from "@std/assert";
import { poolMapVoteCount, seedPoolMapVotes } from "./poolMapVotes.ts";

const SHARE = { minShare: 0.2, maxShare: 0.8 };

/** Deterministic PRNG: returns values from `seq` then 0. */
function seqRand(seq: number[]): () => number {
  let i = 0;
  return () => {
    const v = seq[i] ?? 0;
    i++;
    return v;
  };
}

Deno.test("poolMapVoteCount: empty / non-positive → 0", () => {
  assertEquals(poolMapVoteCount(0, SHARE), 0);
  assertEquals(poolMapVoteCount(-3, SHARE), 0);
});

Deno.test("poolMapVoteCount: always within 20%–80% for n ≥ 2", () => {
  for (let n = 2; n <= 20; n++) {
    const lo = Math.ceil(n * 0.2);
    const hi = Math.floor(n * 0.8);
    for (let k = 0; k < 50; k++) {
      const c = poolMapVoteCount(n, SHARE);
      assert(c >= lo && c <= hi, `n=${n} got ${c} not in [${lo},${hi}]`);
    }
  }
});

Deno.test("poolMapVoteCount: n=1 yields 0 or 1 (no integer in 20–80%)", () => {
  assertEquals(poolMapVoteCount(1, SHARE, () => 0), 0);
  assertEquals(poolMapVoteCount(1, SHARE, () => 0.99), 1);
});

Deno.test("poolMapVoteCount: n=5 spans 1–4", () => {
  assertEquals(poolMapVoteCount(5, SHARE, () => 0), 1);
  assertEquals(poolMapVoteCount(5, SHARE, () => 0.99), 4);
});

Deno.test("poolMapVoteCount: n=10 spans 2–8", () => {
  assertEquals(poolMapVoteCount(10, SHARE, () => 0), 2);
  assertEquals(poolMapVoteCount(10, SHARE, () => 0.99), 8);
});

Deno.test("seedPoolMapVotes: empty inputs → empty map", () => {
  assertEquals(seedPoolMapVotes([], ["A"], SHARE).size, 0);
  assertEquals(seedPoolMapVotes(["p1"], [], SHARE).size, 0);
});

Deno.test("seedPoolMapVotes: count and valid maps", () => {
  const maps = ["Alpha", "Bravo", "Charlie"];
  const ids = ["s1", "s2", "s3", "s4", "s5"];
  const votes = seedPoolMapVotes(ids, maps, SHARE, seqRand([0]));
  assertEquals(votes.size, 1);
  for (const [id, map] of votes) {
    assert(ids.includes(id));
    assert(maps.includes(map));
  }
});

Deno.test("seedPoolMapVotes: max band for n=5 is 4 votes", () => {
  const maps = ["A", "B"];
  const ids = ["a", "b", "c", "d", "e"];
  const votes = seedPoolMapVotes(ids, maps, SHARE, () => 0.99);
  assertEquals(votes.size, 4);
  for (const map of votes.values()) {
    assert(maps.includes(map));
  }
});
