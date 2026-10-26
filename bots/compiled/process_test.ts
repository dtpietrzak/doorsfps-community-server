import { assert, assertEquals } from "@std/assert";
import type { BotMapDefinition, ThinkBatchInput } from "@doors/bot-engine";
import { DenoCompiledBotThinkPipeline } from "./process.ts";

const stubHost = new URL("./stub-host.ts", import.meta.url).pathname;
const communityRoot = new URL("../..", import.meta.url).pathname;

const map: BotMapDefinition = {
  id: "stub-map",
  revision: "stub-map:1",
  formatVersion: 2,
  bounds: { minX: -10, maxX: 10, minZ: -10, maxZ: 10 },
  teamA: { edge: "south", doorHalfWidth: 2, spawnRadius: 2 },
  teamB: { edge: "north", doorHalfWidth: 2, spawnRadius: 2 },
  walls: [],
  wallCorners: [],
  hints: { nudges: [], camps: [], sprints: [], spawns: [], stuck: [] },
};

const thinkInput: ThinkBatchInput = {
  frame: {
    tick: 60,
    simDelta: 3,
    mapRevision: map.revision,
    doorsOpen: true,
    doorChangeTick: null,
    teamScoreA: 0,
    teamScoreB: 0,
    players: [{
      id: "bot-a",
      kind: "bot",
      team: "A",
      alive: true,
      health: 100,
      score: 0,
      spawnedAtTick: 10,
      x: 0,
      y: 1.7,
      z: 0,
      velocityX: 0,
      velocityY: 0,
      velocityZ: 0,
      yaw: 0,
      pitch: 0,
      crouch: false,
      onGround: true,
      sprintStamina: 1,
      moveYaw: null,
      matchPlayer: false,
      weapons: [{ id: 0, ammoInMagazine: 7, spareClips: 2 }],
      weapon: {
        id: 0,
        ammoInMagazine: 7,
        spareClips: 2,
        reloading: false,
        lastShotTick: 0,
      },
      skills: [],
    }],
  },
  applyTick: 69,
  bots: [{ botId: "bot-a", spawnedAtTick: 10 }],
};

function parseCounts(logs: readonly string[]): {
  loadMap: number;
  sync: number;
  think: number;
} | null {
  let latest: { loadMap: number; sync: number; think: number } | null = null;
  const pattern = /compiled-stub counts loadMap=(\d+) sync=(\d+) think=(\d+)/;
  for (const line of logs) {
    const match = pattern.exec(line);
    if (!match) continue;
    latest = {
      loadMap: Number(match[1]),
      sync: Number(match[2]),
      think: Number(match[3]),
    };
  }
  return latest;
}

function startStub(logs: string[]): DenoCompiledBotThinkPipeline {
  return DenoCompiledBotThinkPipeline.start(
    Deno.execPath(),
    {
      info: () => {},
      warn: (message) => logs.push(message),
    },
    {
      args: [
        "run",
        "-A",
        "--node-modules-dir=manual",
        stubHost,
      ],
      cwd: communityRoot,
    },
  );
}

async function waitReady(
  pipeline: DenoCompiledBotThinkPipeline,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (pipeline.snapshot().status === "ready") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("compiled stub never became ready");
}

Deno.test("compiled pipeline queues think behind an in-flight map/roster", async () => {
  const logs: string[] = [];
  const pipeline = startStub(logs);
  try {
    await waitReady(pipeline);
    const bots = [{
      id: "bot-a",
      role: "fill" as const,
      profile: "community",
      randomSeed: 1,
    }];
    for (let index = 0; index < 8; index += 1) {
      pipeline.loadMap(map);
      pipeline.synchronizeBots(bots);
    }
    const result = await pipeline.thinkBatch(thinkInput);
    assertEquals(result.output.tick, thinkInput.frame.tick);
    assertEquals(result.output.decisions.length, 1);
    const counts = parseCounts(logs);
    assert(counts, `missing stub counts in ${logs.join(" | ")}`);
    assertEquals(counts.loadMap, 1);
    assertEquals(counts.sync, 1);
    assertEquals(counts.think, 1);
  } finally {
    await pipeline.close();
  }
});

Deno.test("compiled pipeline refuses think batches until hello is ready", async () => {
  const logs: string[] = [];
  const pipeline = startStub(logs);
  try {
    let rejected = false;
    try {
      await pipeline.thinkBatch(thinkInput);
    } catch (error) {
      rejected = error instanceof Error &&
        error.message.includes("compiled pipeline is unavailable");
    }
    assertEquals(rejected, true);
    await waitReady(pipeline);
    pipeline.loadMap(map);
    pipeline.synchronizeBots([{
      id: "bot-a",
      role: "fill",
      profile: "community",
      randomSeed: 1,
    }]);
    await pipeline.idle();
    const result = await pipeline.thinkBatch(thinkInput);
    assertEquals(result.output.tick, thinkInput.frame.tick);
    assertEquals(result.output.decisions.length, 1);
  } finally {
    await pipeline.close();
  }
});
