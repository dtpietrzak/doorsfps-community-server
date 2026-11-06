import { assertEquals } from "@std/assert";
import type { MapCatalogEntry } from "./gameServerOptions.ts";
import { MapVote, type MapVoteDeps } from "./mapVote.ts";

function entry(name: string, stem = name): MapCatalogEntry {
  return { name, stem, path: name } as MapCatalogEntry;
}

function deps(
  catalog: readonly MapCatalogEntry[],
  raidRuntime: boolean,
  bots: MapVoteDeps["playerSimBots"] = {
    voteSeedPolicy: () => null,
    poolPawnIds: () => [],
  },
  players: ReadonlySet<string> = new Set(["p1", "p2", "pawn"]),
): MapVoteDeps {
  return {
    catalog: () => catalog,
    raidRuntime: () => raidRuntime,
    hasPlayer: (id) => players.has(id),
    playerSimBots: bots,
  };
}

Deno.test("resolveWinner breaks a tie with the injected random", () => {
  const catalog = [entry("A"), entry("B"), entry("C")];
  const votes = new MapVote(deps(catalog, false));
  votes.begin();
  votes.cast("p1", "A", true);
  votes.cast("p2", "B", true);

  assertEquals(votes.resolveWinner(() => 0)?.name, "A");
  assertEquals(votes.resolveWinner(() => 0.99)?.name, "B");
});

Deno.test("resolveWinner picks from the catalog when nobody voted", () => {
  const catalog = [entry("A"), entry("B"), entry("C")];
  const votes = new MapVote(deps(catalog, false));
  votes.begin();

  assertEquals(votes.resolveWinner(() => 0)?.name, "A");
  assertEquals(votes.resolveWinner(() => 0.99)?.name, "C");
  assertEquals(new MapVote(deps([], false)).resolveWinner(() => 0), null);
});

Deno.test("forget reports whether a ballot existed", () => {
  const votes = new MapVote(deps([entry("Courtyard")], false));
  assertEquals(votes.forget("p1"), false);
  votes.begin();
  votes.cast("p1", "Courtyard", true);
  assertEquals(votes.forget("p1"), true);
  assertEquals(votes.state().voterCount, 0);
  assertEquals(votes.forget("p1"), false);
});

Deno.test("begin seeds a share of the bot pawns", () => {
  const votes = new MapVote(deps(
    [entry("A"), entry("B")],
    false,
    {
      voteSeedPolicy: () => ({ minShare: 1, maxShare: 1 }),
      poolPawnIds: () => ["pawn"],
    },
  ));
  votes.begin();
  assertEquals(votes.state().voterCount, 1);
  assertEquals(votes.isOpen, true);
  votes.clear();
  assertEquals(votes.isOpen, false);
  assertEquals(votes.state().voterCount, 0);
});
