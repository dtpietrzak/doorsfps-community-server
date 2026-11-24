/**
 * Zombie brains through the real think engine: a shut sliding door holds
 * the horde, a crowd spreads out, and zombies share a batch with gun bots
 * without changing what those bots do. Pawns walk on the harness's
 * kinematic world, so these are behaviour checks, not tuned numbers.
 */
import { assert, assertEquals } from "@std/assert";
import { BALANCE_BOT_CONFIG } from "../engine/config.ts";
import type {
  BotDefinition,
  BotMapDefinition,
} from "../engine/model/index.ts";
import { ZombieBrain } from "../engine/pipeline/zombieBrain.ts";
import { createBotThinkEngine } from "../engine/engine/batch.ts";
import {
  frameOf,
  harnessCollision,
  type SimPawn,
  simPawn,
  walkOneSimTick,
  ZOMBIE_CONFIG,
} from "./simHarness.ts";

const REV = "zombots:test";

function zombieDef(id: string, seed: number): BotDefinition {
  return {
    id,
    role: "raid",
    profile: "zombie",
    randomSeed: seed,
    config: ZOMBIE_CONFIG,
  };
}

function balanceDef(id: string, seed: number): BotDefinition {
  return {
    id,
    role: "balance",
    profile: "balance-bot",
    randomSeed: seed,
    config: BALANCE_BOT_CONFIG,
  };
}

/** Walled 8x8 room, one sliding door in its north wall, zombots rules. */
function sealedRoom(): BotMapDefinition {
  return {
    id: "zombots-room",
    revision: REV,
    formatVersion: 2,
    bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 30 },
    teamA: { edge: "south", doorHalfWidth: 2.5, spawnRadius: 3 },
    teamB: { edge: "north", doorHalfWidth: 2.5, spawnRadius: 3 },
    walls: [
      { id: "s", ax: 0, az: 0, bx: 8, bz: 0, kind: "full" },
      { id: "e", ax: 8, az: 0, bx: 8, bz: 8, kind: "full" },
      { id: "n", ax: 8, az: 8, bx: 0, bz: 8, kind: "full" },
      { id: "w", ax: 0, az: 8, bx: 0, bz: 0, kind: "full" },
    ],
    wallCorners: [],
    hints: { nudges: [], camps: [], sprints: [], spawns: [], stuck: [] },
    doors: [{ id: "d", wallId: "n", center: { x: 4, z: 8 }, cost: 500 }],
    mirrorMode: "zombots",
    spawnCorner: 0,
  };
}

/** Plain open field with one wall in the middle. */
function openField(): BotMapDefinition {
  return {
    ...sealedRoom(),
    id: "field",
    revision: "field:1",
    bounds: { minX: -30, maxX: 30, minZ: -30, maxZ: 30 },
    walls: [{ id: "mid", ax: -3, az: 0, bx: 3, bz: 0, kind: "full" }],
    doors: undefined,
    mirrorMode: undefined,
    spawnCorner: undefined,
  };
}

type World = {
  tick: number;
  pawns: SimPawn[];
  engine: ReturnType<typeof createBotThinkEngine>;
  collision: ReturnType<typeof harnessCollision>;
  revision: string;
  open: string[] | undefined;
};

function world(
  def: BotMapDefinition,
  pawns: SimPawn[],
  defs: BotDefinition[],
): World {
  const engine = createBotThinkEngine();
  engine.loadMap(def);
  engine.synchronizeBots(defs);
  return {
    tick: 30,
    pawns,
    engine,
    collision: harnessCollision(def),
    revision: def.revision,
    open: [],
  };
}

/** One bot period: every bot thinks once, then three sim ticks of walking. */
function botTick(w: World, ids: readonly string[]): void {
  const out = w.engine.thinkBatch({
    frame: frameOf(w.tick, w.revision, w.pawns, w.open),
    applyTick: w.tick + 3,
    bots: ids.map((botId) => ({
      botId,
      spawnedAtTick: w.pawns.find((p) => p.id === botId)!.spawnedAtTick,
    })),
  });
  for (const d of out.decisions) {
    const pawn = w.pawns.find((p) => p.id === d.botId)!;
    if (d.action?.input) pawn.input = d.action.input;
  }
  for (let s = 0; s < 3; s++) {
    for (const p of w.pawns) if (p.kind === "bot") walkOneSimTick(w.collision, p);
  }
  w.tick += 3;
}

function dist(a: SimPawn, b: SimPawn): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

Deno.test("zombie in a sealed room stays put until the door opens, then crosses toward the human", () => {
  const zombie = simPawn("z", "bot", 4, 4, { speedScale: 0.75 });
  const human = simPawn("h", "human", 4, 16);
  const w = world(sealedRoom(), [zombie, human], [zombieDef("z", 7)]);
  const startGap = dist(zombie, human);

  let maxZ = zombie.z;
  for (let n = 0; n < 160; n++) {
    botTick(w, ["z"]);
    maxZ = Math.max(maxZ, zombie.z);
    assert(Number.isFinite(zombie.x) && Number.isFinite(zombie.z));
  }
  // Wall is at z=8; the body radius keeps the centre short of it.
  assert(maxZ < 8, `zombie reached z=${maxZ} through a closed door`);
  assert(dist(zombie, human) > startGap - 6);

  // Door opens: the frame names it, the harness collision follows.
  w.open = ["d"];
  w.collision.openSlidingDoor("d");
  let crossed = false;
  for (let n = 0; n < 200 && !crossed; n++) {
    botTick(w, ["z"]);
    crossed = zombie.z > 9;
  }
  assert(crossed, `zombie never left the room, at (${zombie.x}, ${zombie.z})`);
  assert(dist(zombie, human) < startGap - 4, "no progress toward the human");
});

/** Eight zombies start bunched, one human stands far off. */
function runCrowd(ticks: number) {
  const ids = Array.from({ length: 8 }, (_, i) => `z${i}`);
  const zombies = ids.map((id, i) =>
    simPawn(id, "bot", -18 + (i % 4) * 0.4, -14 + Math.floor(i / 4) * 0.4, {
      speedScale: 0.75,
      yaw: i,
    })
  );
  const human = simPawn("h", "human", 14, 12);
  const w = world(
    openField(),
    [...zombies, human],
    ids.map((id, i) => zombieDef(id, 100 + i)),
  );
  w.open = undefined;

  const pairMin = () => {
    let m = Infinity;
    for (let i = 0; i < zombies.length; i++) {
      for (let j = i + 1; j < zombies.length; j++) {
        m = Math.min(m, dist(zombies[i]!, zombies[j]!));
      }
    }
    return m;
  };
  // Tightest the crowd got before anyone was within 3 of the human.
  let approachMin = Infinity;
  for (let n = 0; n < ticks; n++) {
    botTick(w, ids);
    for (const z of zombies) {
      assert(
        Number.isFinite(z.x) && Number.isFinite(z.z) &&
          Number.isFinite(z.yaw) && Number.isFinite(z.pitch),
        `${z.id} went non-finite at bot tick ${n}`,
      );
    }
    if (zombies.every((z) => dist(z, human) > 3)) {
      approachMin = Math.min(approachMin, pairMin());
    }
  }
  return {
    approachMin,
    finalMin: pairMin(),
    nearHuman: zombies.filter((z) => dist(z, human) < 4).length,
  };
}

Deno.test("crowd of eight closing on one human stays spread out and finite", () => {
  const r = runCrowd(300);
  assert(r.nearHuman >= 6, `only ${r.nearHuman} of 8 reached the human`);
  assert(r.approachMin > 0.3, `two zombies stacked at ${r.approachMin} on approach`);
});

function decisionsJson(
  w: World,
  ids: readonly string[],
): Map<string, string> {
  const out = w.engine.thinkBatch({
    frame: frameOf(w.tick, w.revision, w.pawns, w.open),
    applyTick: w.tick + 3,
    bots: ids.map((botId) => ({
      botId,
      spawnedAtTick: w.pawns.find((p) => p.id === botId)!.spawnedAtTick,
    })),
  });
  return new Map(out.decisions.map((d) => [d.botId, JSON.stringify(d)]));
}

Deno.test("zombies and gun bots share a batch without changing each other's output", () => {
  const gunIds = ["g0", "g1", "g2", "g3"];
  const zIds = ["z0", "z1", "z2", "z3"];
  const build = () => [
    simPawn("h", "human", 12, 10),
    ...gunIds.map((id, i) =>
      simPawn(id, "bot", -10 + i * 3, -10, { team: i % 2 ? "A" : "B" })
    ),
    ...zIds.map((id, i) => simPawn(id, "bot", 10 + i, -12)),
  ];
  const gunDefs = gunIds.map((id, i) => balanceDef(id, 40 + i));
  const zDefs = zIds.map((id, i) => zombieDef(id, 90 + i));

  // Same frames for all three engines. Positions drift on a fixed script so
  // later ticks differ without depending on any engine's output.
  const gunOnly = world(openField(), build(), gunDefs);
  const mixed = world(openField(), build(), [...gunDefs, ...zDefs]);
  const zOnly = world(openField(), build(), zDefs);
  for (const w of [gunOnly, mixed, zOnly]) w.open = undefined;

  let zombiesActed = false;
  for (let n = 0; n < 40; n++) {
    for (const w of [gunOnly, mixed, zOnly]) {
      for (const p of w.pawns) {
        p.x += Math.sin(n + p.id.length) * 0.4;
        p.z += Math.cos(n * 0.7) * 0.4;
        p.yaw = n * 0.1;
      }
    }
    const gunSolo = decisionsJson(gunOnly, gunIds);
    const both = decisionsJson(mixed, [...gunIds, ...zIds]);
    const zSolo = decisionsJson(zOnly, zIds);
    for (const id of gunIds) assertEquals(both.get(id), gunSolo.get(id), id);
    for (const id of zIds) {
      assertEquals(both.get(id), zSolo.get(id), id);
      if (!both.get(id)!.includes('"action":null')) zombiesActed = true;
    }
    gunOnly.tick += 3;
    mixed.tick += 3;
    zOnly.tick += 3;
  }
  assert(zombiesActed, "zombies never produced an action");
});

Deno.test("crowd that has arrived stays spread out around the human", () => {
  const r = runCrowd(300);
  assert(r.finalMin > 0.3, `two zombies stacked at ${r.finalMin}`);
});

// createSlot builds through createBotBrain, so a zombie config gets
// ZombieBrain with no swap.
Deno.test("batch dispatches zombie config to ZombieBrain", () => {
  const engine = createBotThinkEngine();
  engine.synchronizeBots([zombieDef("z", 1), balanceDef("g", 2)]);
  const slots = (engine as unknown as {
    slots: Array<{ id: string; brain: unknown }>;
  }).slots;
  assert(slots.find((s) => s.id === "z")!.brain instanceof ZombieBrain);
  assert(!(slots.find((s) => s.id === "g")!.brain instanceof ZombieBrain));
});
