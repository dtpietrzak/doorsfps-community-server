/**
 * Zombots windows (notes/zombots.md steps 9a and 12c) on the real map,
 * moved by the shared `stepMove` through the server collision views a
 * `Player` uses: zombies climb windows into the player closures, humans
 * can't cross a zombots window by any move, an arena window is unchanged,
 * and a closed sliding door still holds the horde.
 */
import { assert, assertEquals } from "@std/assert";
import { loadMapFile } from "../../world/loadMap.ts";
import { MapCollision as ServerCollision } from "../../world/MapCollision.ts";
import type { DoorsMap } from "../../world/map.ts";
import { zombotsLayout } from "../../shared/zombots/zombotsLayout.ts";
import { ZOMBOTS_TUNING } from "../../shared/zombots/zombotsTuning.ts";
import type { MoveCollision } from "../../shared/sim/moveStep.ts";
import { buildBotMapDefinition } from "../shadow/frame.ts";
import type { BotDefinition } from "../engine/model/index.ts";
import { createBotThinkEngine } from "../engine/engine/batch.ts";
import { runtimeMap } from "../engine/runtime/map.ts";
import { MapCollision as EngineCollision } from "../engine/world/MapCollision.ts";
import {
  frameOf,
  simOneTick,
  type SimPawn,
  simPawn,
  ZOMBIE_CONFIG,
} from "./simHarness.ts";

const MAP_PATH = new URL(
  "../../maps/zombots/Zombots-01.doors.json",
  import.meta.url,
).pathname;

const SLOW = ZOMBOTS_TUNING.zombie.baseSpeedScale;
const FAST = ZOMBOTS_TUNING.zombie.maxSpeedScale;

function zombieDef(id: string, seed: number): BotDefinition {
  return {
    id,
    role: "raid",
    profile: "zombie",
    randomSeed: seed,
    config: ZOMBIE_CONFIG,
  };
}

type World = {
  tick: number;
  pawns: SimPawn[];
  engine: ReturnType<typeof createBotThinkEngine>;
  server: ServerCollision;
  revision: string;
  open: string[];
};

async function zombotsWorld(pawns: SimPawn[]): Promise<World> {
  const server = new ServerCollision(await loadMapFile(MAP_PATH));
  const def = buildBotMapDefinition(server);
  const engine = createBotThinkEngine();
  engine.loadMap(def);
  engine.synchronizeBots(
    pawns.filter((p) => p.kind === "bot").map((p, i) =>
      zombieDef(p.id, 11 + i)
    ),
  );
  return { tick: 30, pawns, engine, server, revision: def.revision, open: [] };
}

/** One bot period: think, then three real sim ticks for every zombie. */
function botTick(w: World): void {
  const bots = w.pawns.filter((p) => p.kind === "bot");
  const out = w.engine.thinkBatch({
    frame: frameOf(w.tick, w.revision, w.pawns, w.open),
    applyTick: w.tick + 3,
    bots: bots.map((p) => ({ botId: p.id, spawnedAtTick: p.spawnedAtTick })),
  });
  for (const d of out.decisions) {
    const pawn = w.pawns.find((p) => p.id === d.botId)!;
    pawn.input = d.action?.input ?? null;
  }
  const zombie = w.server.bodyCollision("zombie");
  const portals = w.server.windowCrawlPortals();
  for (let s = 0; s < 3; s++) {
    for (const p of bots) {
      simOneTick(zombie, p, { portals, tick: w.tick + s });
    }
  }
  w.tick += 3;
}

const dist = (a: { x: number; z: number }, b: { x: number; z: number }) =>
  Math.hypot(a.x - b.x, a.z - b.z);

for (
  const [label, spawn, speed] of [
    ["zombie room 0", { x: 20, z: 18 }, SLOW],
    ["zombie room 0", { x: 33, z: 18 }, FAST],
    // Far side of the ring: the window field walks it round phase 3.
    ["zombie room 0", { x: -33, z: -18 }, SLOW],
    ["zombie room 3", { x: 15, z: -18 }, SLOW],
    ["zombie room 3", { x: 28, z: -18 }, FAST],
  ] as const
) {
  Deno.test(`a zombie from ${label} (${spawn.x}, ${spawn.z}) at speed ${speed} climbs a window to a phase 1 human`, async () => {
    const map = await loadMapFile(MAP_PATH);
    const layout = zombotsLayout(map);
    const human = simPawn("h", "human", 17, -5);
    assertEquals(layout.phaseOf(human), 1);
    const zombie = simPawn("z", "bot", spawn.x, spawn.z, { speedScale: speed });
    const startRoom = layout.roomOf(zombie);
    assert(
      startRoom !== null &&
        layout.zombieRooms.some((r) => r.room === startRoom),
    );
    const w = await zombotsWorld([zombie, human]);

    // Where the body first stood on player-closure floor.
    let entered: { x: number; z: number } | null = null;
    let reached = -1;
    // 1200 bot periods = 60 s. The far ring at baseSpeedScale (half the
    // first-pass 0.75) needs the longer budget to reach the human.
    for (let n = 0; n < 1200 && reached < 0; n++) {
      botTick(w);
      assert(Number.isFinite(zombie.x) && Number.isFinite(zombie.z));
      if (entered === null && layout.phaseOf(zombie) !== null) {
        entered = { x: zombie.x, z: zombie.z };
      }
      if (zombie.input) {
        assertEquals(zombie.input.jump, false, "zombie should crawl, not jump");
        assertEquals(
          zombie.input.crouch,
          false,
          "zombie should crawl, not crouch",
        );
      }
      if (dist(zombie, human) < 2) reached = n;
    }
    assert(
      reached >= 0,
      `never reached the human, stuck at (${zombie.x.toFixed(2)}, ${
        zombie.z.toFixed(2)
      })`,
    );
    assert(
      (zombie.crawlsStarted?.length ?? 0) >= 1,
      "expected zombie to enter hardcoded window crawl",
    );
    assert(entered !== null);
    // It came in over a sill: the first player-side floor is next to a window.
    const nearest = Math.min(
      ...layout.windowLinks.map((l) =>
        dist(entered!, map.windows!.find((w) => w.id === l.windowId)!.center)
      ),
    );
    assert(
      nearest < 1.5,
      `entered at (${entered.x}, ${entered.z}), ${nearest} from any window`,
    );
  });
}

/** The window on wall z = 0 at x = 15: zombie closure north, phase 1 south. */
const WINDOW = { x: 15, z: 0 };

type Moves = {
  forward: boolean;
  jump: boolean;
  sprint: boolean;
  crouch: boolean;
};

/** Hold these keys straight at the window (yaw 0 walks −z) from the north side. */
function tryCross(
  collision: MoveCollision,
  keys: (tick: number) => Moves,
  startZ = 1.2,
): number {
  const pawn = simPawn("p", "human", WINDOW.x, startZ);
  let minZ = pawn.z;
  for (let t = 0; t < 240; t++) {
    const k = keys(t);
    pawn.input = {
      forward: k.forward,
      backward: false,
      left: false,
      right: false,
      jump: k.jump,
      sprint: k.sprint,
      crouch: k.crouch,
      yaw: 0,
      pitch: 0,
    };
    simOneTick(collision, pawn);
    minZ = Math.min(minZ, pawn.z);
  }
  return minZ;
}

const MOVES: Record<string, (t: number) => Moves> = {
  walk: () => ({ forward: true, jump: false, sprint: false, crouch: false }),
  "jump held": () => ({
    forward: true,
    jump: true,
    sprint: false,
    crouch: false,
  }),
  "sprint jump": () => ({
    forward: true,
    jump: true,
    sprint: true,
    crouch: false,
  }),
  // Rising crouch every half second starts a slide each time it can.
  "slide": (t) => ({
    forward: true,
    jump: false,
    sprint: true,
    crouch: t % 30 < 15,
  }),
  "slide jump": (t) => ({
    forward: true,
    jump: t % 30 === 3,
    sprint: true,
    crouch: t % 30 < 15,
  }),
  "crouch jump": () => ({
    forward: true,
    jump: true,
    sprint: false,
    crouch: true,
  }),
};

Deno.test("a human can't cross a zombots window by walking, jumping or sliding", async () => {
  const server = new ServerCollision(await loadMapFile(MAP_PATH));
  for (const human of [server, server.bodyCollision("human")]) {
    for (const [name, keys] of Object.entries(MOVES)) {
      for (const startZ of [1.2, 4]) {
        const minZ = tryCross(human, keys, startZ);
        assert(minZ > 0.5, `${name} from z=${startZ} reached z=${minZ}`);
      }
    }
  }
});

Deno.test("a zombie body crosses the same window with a held jump, at every zombie speed", async () => {
  const server = new ServerCollision(await loadMapFile(MAP_PATH));
  const zombie = server.bodyCollision("zombie");
  for (const speed of [SLOW, 1, FAST]) {
    const pawn = simPawn("z", "bot", WINDOW.x, 1.2, { speedScale: speed });
    for (let t = 0; t < 120; t++) {
      pawn.input = {
        forward: true,
        backward: false,
        left: false,
        right: false,
        jump: true,
        sprint: false,
        crouch: false,
        yaw: 0,
        pitch: 0,
      };
      simOneTick(zombie, pawn);
    }
    assert(pawn.z < -1, `speed ${speed}: stopped at z=${pawn.z}`);
    // Walking alone never gets over the sill.
    assert(tryCross(zombie, MOVES.walk!) > 0.5);
  }
});

/** Open floor, one wall with a window, no zombots rules. */
function windowArena(zombots: boolean): DoorsMap {
  return {
    version: 1,
    name: "window-arena",
    bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 },
    gridSize: 1,
    teamA: { corners: [0, 1], edge: "south", doorHalfWidth: 2, spawnRadius: 3 },
    teamB: { corners: [2, 3], edge: "north", doorHalfWidth: 2, spawnRadius: 3 },
    walls: [{ id: "w", a: { x: 5, z: 0 }, b: { x: 25, z: 0 }, kind: "full" }],
    windows: [{ id: "win", wallId: "w", center: { x: WINDOW.x, z: 0 } }],
    ...(zombots
      ? { mirrorMode: "zombots" as const, spawnCorner: 1 as const }
      : {}),
  };
}

// A standing body is too tall for the 0.9–2.55 m opening (1.7 m), so the
// way through an arena window is a crouch jump (1.3 m), as before.
Deno.test("an arena window still lets a human crouch-jump through, and walking still can't", () => {
  const arena = new ServerCollision(windowArena(false));
  assert(
    tryCross(arena, MOVES["crouch jump"]!) < -1,
    "arena window blocked a crouch jump",
  );
  assert(tryCross(arena, MOVES.walk!) > 0.5, "arena sill let a walk through");
  // The body views are the same collision off zombots maps.
  assertEquals(arena.bodyCollision("human"), arena);
  assertEquals(arena.bodyCollision("zombie"), arena);
  // Same wall on a zombots map: sealed for humans, open for zombie jumps.
  const zombots = new ServerCollision(windowArena(true));
  assert(tryCross(zombots, MOVES["crouch jump"]!) > 0.5);
  assert(tryCross(zombots.bodyCollision("zombie"), MOVES["jump held"]!) < -1);
});

Deno.test("shots and sight still go through a zombots window", () => {
  for (const zombots of [false, true]) {
    const c = new ServerCollision(windowArena(zombots));
    const eye = { x: WINDOW.x, y: 1.6, z: 3 };
    assertEquals(c.raycastSolid(eye, { x: 0, y: 0, z: -1 }, 6), null);
    assertEquals(c.raycastFullSolid(eye, { x: 0, y: 0, z: -1 }, 6), null);
  }
});

Deno.test("a closed sliding door still holds a zombie, an opened one lets it through", async () => {
  // Phase 1 zombie at (10, -5); phase 2 human behind the door on x = 5.
  const map = await loadMapFile(MAP_PATH);
  const layout = zombotsLayout(map);
  const zombie = simPawn("z", "bot", 10, -5, { speedScale: FAST });
  const human = simPawn("h", "human", -5, -5);
  assertEquals(layout.phaseOf(zombie), 1);
  assertEquals(layout.phaseOf(human), 2);
  const w = await zombotsWorld([zombie, human]);
  let minX = zombie.x;
  for (let n = 0; n < 200; n++) {
    botTick(w);
    minX = Math.min(minX, zombie.x);
    assertEquals(layout.phaseOf(zombie) === 2, false, `crossed at n=${n}`);
  }
  assert(minX > 5, `zombie reached x=${minX} with the door shut`);
  // It stayed in phase 1: no window back out either.
  assert(layout.phaseOf(zombie) === 1 || layout.roomOf(zombie) === null);

  const door = "door_ei1akqdg";
  w.open = [door];
  w.server.openSlidingDoor(door);
  let crossed = false;
  for (let n = 0; n < 200 && !crossed; n++) {
    botTick(w);
    crossed = layout.phaseOf(zombie) === 2;
  }
  assert(
    crossed,
    `never went through the open door, at (${zombie.x}, ${zombie.z})`,
  );
});

Deno.test("the engine's zombie copy agrees with the server's zombie view at every window", async () => {
  const map = await loadMapFile(MAP_PATH);
  const server = new ServerCollision(map);
  const engine = new EngineCollision(
    runtimeMap(buildBotMapDefinition(server)),
    {
      windowBody: "zombie",
    },
  );
  const zombie = server.bodyCollision("zombie");
  for (const win of map.windows ?? []) {
    for (let dx = -1.2; dx <= 1.2; dx += 0.3) {
      for (let dz = -1.2; dz <= 1.2; dz += 0.3) {
        for (const feet of [0, 0.95, 1.3]) {
          const x = win.center.x + dx;
          const z = win.center.z + dz;
          const e = engine.resolvePosition(x, z, undefined, feet, feet + 1.7);
          const s = zombie.resolvePosition(x, z, undefined, feet, feet + 1.7);
          assert(
            Math.abs(e.x - s.x) < 1e-6 && Math.abs(e.z - s.z) < 1e-6,
            `${x},${z} feet ${feet}`,
          );
        }
      }
    }
  }
});

Deno.test("a crowd of zombies approaching an open buyable door at an angle all pass through", async () => {
  const map = await loadMapFile(MAP_PATH);
  const layout = zombotsLayout(map);
  const door = "door_ei1akqdg";
  // Three zombies clustered at an oblique angle north-east of the door on x = 5, z = -5.
  const zombies = [
    simPawn("z1", "bot", 8, -2, { speedScale: SLOW }),
    simPawn("z2", "bot", 8.5, -2.5, { speedScale: SLOW }),
    simPawn("z3", "bot", 7.8, -1.5, { speedScale: SLOW }),
  ];
  // Human in phase 2, south-west of the door so a straight line clips the jamb.
  const human = simPawn("h", "human", -2, -9);
  assertEquals(layout.phaseOf(human), 2);
  const w = await zombotsWorld([...zombies, human]);
  w.open = [door];
  w.server.openSlidingDoor(door);

  for (let n = 0; n < 400; n++) {
    botTick(w);
    if (zombies.every((z) => dist(z, human) < 2.2)) break;
  }
  for (const z of zombies) {
    assert(
      dist(z, human) < 2.2,
      `${z.id} got stuck at (${z.x.toFixed(2)}, ${z.z.toFixed(2)})`,
    );
  }
});

Deno.test("a zombie chasing a human pressed against a closed buyable door reaches them without snapping across", async () => {
  const map = await loadMapFile(MAP_PATH);
  const layout = zombotsLayout(map);
  // Human pressed right up against the phase-1 side of the closed door at (5, -5).
  const human = simPawn("h", "human", 5.65, -5);
  // Zombie in phase 1 behind the pillar around x=10..14, z=-7..-3.
  const zombie = simPawn("z", "bot", 16, -5, { speedScale: SLOW });
  assertEquals(layout.phaseOf(zombie), 1);
  const w = await zombotsWorld([zombie, human]);

  let reached = false;
  for (let n = 0; n < 350 && !reached; n++) {
    botTick(w);
    if (dist(zombie, human) < 2.0) reached = true;
  }
  assert(
    reached,
    `zombie never reached human near closed door, stuck at (${zombie.x.toFixed(2)}, ${zombie.z.toFixed(2)})`,
  );
});

Deno.test("a zombie near the sealed south perimeter door in phase 2 is not pulled into the wall", async () => {
  const map = await loadMapFile(MAP_PATH);
  const layout = zombotsLayout(map);
  // Team A's sealed perimeter door is at (0, -20). Put a zombie right next to it
  // in phase 2 and a human further west along the south corridor.
  const zombie = simPawn("z", "bot", 1.5, -18, { speedScale: SLOW });
  const human = simPawn("h", "human", -10, -17);
  assertEquals(layout.phaseOf(zombie), 2);
  assertEquals(layout.phaseOf(human), 2);
  const w = await zombotsWorld([zombie, human]);

  let reached = false;
  for (let n = 0; n < 350 && !reached; n++) {
    botTick(w);
    if (dist(zombie, human) < 2.0) reached = true;
  }
  assert(
    reached,
    `zombie got pulled into sealed perimeter door at (${zombie.x.toFixed(2)}, ${zombie.z.toFixed(2)})`,
  );
});
