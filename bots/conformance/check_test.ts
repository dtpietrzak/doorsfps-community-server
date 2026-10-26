/**
 * The conformance checker passes the Python example brain and catches the
 * hold-W brain's extra agent decision. The Python brain also runs inside a
 * real host and walks fill pawns toward the enemy door.
 */
import { assert, assertEquals } from "@std/assert";
import { MapCollision } from "../../world/MapCollision.ts";
import type { DoorsMap } from "../../world/map.ts";
import { PlayerManager } from "../../players/PlayerManager.ts";
import { BotManager } from "../BotManager.ts";
import { runConformance } from "./check.ts";

const PYTHON_BRAIN = new URL("../spec/examples/walk_to_door.py", import.meta.url)
  .pathname;
const HOLD_W_BRAIN = new URL("../compiled/holdWBrain.ts", import.meta.url).pathname;
const CONFIG = new URL("../../deno.json", import.meta.url).pathname;

const hasPython = await (async () => {
  try {
    return (await new Deno.Command("python3", { args: ["--version"] }).output())
      .success;
  } catch {
    return false;
  }
})();

Deno.test({
  name: "the Python example brain passes conformance",
  ignore: !hasPython,
  fn: async () => {
    const report = await runConformance(["python3", PYTHON_BRAIN], {
      periods: 12,
    });
    assertEquals(report.failures, []);
    assert(report.batches > 0);
  },
});

Deno.test("conformance catches a decision for a pawn that was not requested", async () => {
  const report = await runConformance(
    [Deno.execPath(), "run", "-A", `--config=${CONFIG}`, HOLD_W_BRAIN],
    { periods: 12 },
  );
  assertEquals(report.ok, false);
  assert(
    report.failures.some((failure) => failure.includes("decisions for")),
    report.failures.join("\n"),
  );
});

function corridor(): DoorsMap {
  return {
    version: 1,
    name: "Corridor",
    bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 },
    gridSize: 1,
    teamA: { corners: [0, 1], edge: "south", doorHalfWidth: 2.5, spawnRadius: 3 },
    teamB: { corners: [2, 3], edge: "north", doorHalfWidth: 2.5, spawnRadius: 3 },
    walls: [],
  };
}

Deno.test({
  name: "a host walks fill pawns toward the enemy door on the Python brain",
  ignore: !hasPython,
  fn: async () => {
    const collision = new MapCollision(corridor());
    const players = new PlayerManager(collision);
    const bots = new BotManager(players, {}, {
      fill: { minPlayers: 2, noBotsOnEmptyServer: false },
      brain: ["python3", PYTHON_BRAIN],
    });
    // South edge is minZ (team A's door), north edge is maxZ (team B's).
    const enemyDoorZ = (team: string) => team === "A" ? 20 : -20;
    const walking = (): boolean => {
      let any = false;
      for (const player of players.all()) {
        if (!player.isBot || player.isAgent) continue;
        const input = bots.lastReadyAction(player.id)?.input;
        if (!input) continue;
        const towardDoor = -Math.cos(input.yaw) *
          (enemyDoorZ(player.team) - player.z);
        if (!input.forward || towardDoor <= 0) return false;
        any = true;
      }
      return any;
    };
    try {
      players.add("h1", "Ada", "A");
      players.beginLiveMatch(0);
      bots.reconcile(8);
      const deadline = Date.now() + 8_000;
      for (let tick = 1; Date.now() < deadline && !walking(); tick++) {
        bots.tick(tick, collision);
        await bots.commandBrainSettled();
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert(walking(), "fill pawns hold W toward the enemy door");
    } finally {
      await bots.closeCommandBrain();
    }
  },
});
