import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { loadMapFile } from "../../world/loadMap.ts";
import { zombotsRoomGraph } from "./zombotsDoors.ts";
import {
  ZOMBOTS_LAYOUT_MIN_ROOM_AREA,
  zombotsLayout,
  type ZombotsLayoutMap,
  zombotsSpawnGate,
} from "./zombotsLayout.ts";

/**
 * 40×20 map, pad in the SW corner. Walls at x=-7 and x=7 run the full depth;
 * a wall at z=5 splits each column into a player room (south) and a zombie
 * strip (north) with one window between them.
 *
 *   zA | zB | zC        (spawns sA, sB, sC)
 *   -w-+-w--+-w-        windows at x = -14, 0, 14
 *   P1 d1 P2 d2 P3      doors low on x=-7 and x=7
 */
function base(extra: Partial<ZombotsLayoutMap> = {}): ZombotsLayoutMap {
  return {
    bounds: { minX: -20, maxX: 20, minZ: -10, maxZ: 10 },
    walls: [
      { id: "wz", a: { x: -20, z: 5 }, b: { x: 20, z: 5 }, kind: "full" },
      { id: "wl", a: { x: -7, z: -10 }, b: { x: -7, z: 10 }, kind: "full" },
      { id: "wr", a: { x: 7, z: -10 }, b: { x: 7, z: 10 }, kind: "full" },
    ],
    doors: [
      { id: "d1", wallId: "wl", center: { x: -7, z: -2 } },
      { id: "d2", wallId: "wr", center: { x: 7, z: -2 } },
    ],
    windows: [
      { id: "winA", wallId: "wz", center: { x: -14, z: 5 } },
      { id: "winB", wallId: "wz", center: { x: 0, z: 5 } },
      { id: "winC", wallId: "wz", center: { x: 14, z: 5 } },
    ],
    gunRacks: [
      { id: "pistol", wallId: "wz", center: { x: -10, z: 5 }, weapon: "pistol" },
      { id: "rifle", wallId: "wz", center: { x: 3, z: 5 }, weapon: "rifle" },
      { id: "shotgun", wallId: "wz", center: { x: 10, z: 5 }, weapon: "shotgun" },
    ],
    spawnCorner: 0,
    zombieSpawns: [
      { id: "sA", p: { x: -14, z: 8 } },
      { id: "sB", p: { x: 0, z: 8 } },
      { id: "sC", p: { x: 14, z: 8 } },
    ],
    ...extra,
  };
}

function hasError(errors: readonly string[], ...parts: string[]): boolean {
  return errors.some((e) => parts.every((p) => e.includes(p)));
}

Deno.test("valid three-phase map: phases, zombie rooms, links, racks, no errors", () => {
  const layout = zombotsLayout(base());
  assertEquals(layout.errors, []);
  assertEquals(layout.warnings, []);
  assertEquals(layout.slivers, []);
  const phases = layout.phases!;
  assert(phases);
  assertEquals(layout.roomOf({ x: -14, z: -5 }), phases[0]);
  assertEquals(layout.roomOf({ x: 0, z: -5 }), phases[1]);
  assertEquals(layout.roomOf({ x: 14, z: -5 }), phases[2]);
  assertEquals(layout.phaseOf({ x: 0, z: -5 }), 2);
  assertEquals(layout.phaseOf({ x: 0, z: 8 }), null);
  // On the wall's blocked band: no room.
  assertEquals(layout.roomOf({ x: 0, z: 5 }), null);

  const zA = layout.roomOf({ x: -14, z: 8 })!;
  const zB = layout.roomOf({ x: 0, z: 8 })!;
  const zC = layout.roomOf({ x: 14, z: 8 })!;
  assertEquals(
    layout.zombieRooms.map((z) => [z.room, z.spawnIds]).sort((a, b) => (a[0] as number) - (b[0] as number)),
    [[zA, ["sA"]], [zB, ["sB"]], [zC, ["sC"]]].sort((a, b) => (a[0] as number) - (b[0] as number)),
  );
  assertEquals(layout.windowLinks, [
    { windowId: "winA", zombieRoom: zA, playerRoom: phases[0], phase: 1 },
    { windowId: "winB", zombieRoom: zB, playerRoom: phases[1], phase: 2 },
    { windowId: "winC", zombieRoom: zC, playerRoom: phases[2], phase: 3 },
  ]);
  assertEquals(layout.rackPhase.map((r) => [r.rackId, r.playerRoom, r.phase]), [
    ["pistol", phases[0], 1],
    ["rifle", phases[1], 2],
    ["shotgun", phases[2], 3],
  ]);
  // Player rooms are south of the z=5 wall, so racks face -z.
  for (const rack of layout.rackPhase) {
    assertAlmostEquals(rack.facing!.x, 0, 1e-6);
    assertAlmostEquals(rack.facing!.z, -1, 1e-6);
  }
});

Deno.test("same map in, same layout out", () => {
  const a = zombotsLayout(base());
  const b = zombotsLayout(base());
  assertEquals(
    { ...a, roomOf: null, phaseOf: null },
    { ...b, roomOf: null, phaseOf: null },
  );
});

Deno.test("spawn gate opens zombie rooms phase by phase", () => {
  const layout = zombotsLayout(base());
  const live = (n: number) => ["sA", "sB", "sC", "nope"].filter(zombotsSpawnGate(layout, n));
  assertEquals(live(1), ["sA"]);
  assertEquals(live(2), ["sA", "sB"]);
  assertEquals(live(3), ["sA", "sB", "sC"]);
});

Deno.test("spawn gate: a room with windows onto two phases is live from the earlier one", () => {
  // Stop the x=-7 wall at z=5 so zA and zB merge into one zombie closure
  // with windows onto phase 1 (winA) and phase 2 (winB).
  const map = base({
    walls: [
      { id: "wz", a: { x: -20, z: 5 }, b: { x: 20, z: 5 }, kind: "full" },
      { id: "wl", a: { x: -7, z: -10 }, b: { x: -7, z: 5 }, kind: "full" },
      { id: "wr", a: { x: 7, z: -10 }, b: { x: 7, z: 10 }, kind: "full" },
    ],
  });
  const layout = zombotsLayout(map);
  assertEquals(layout.errors, []);
  assertEquals(layout.zombieRooms.length, 2);
  assertEquals(["sA", "sB", "sC"].filter(zombotsSpawnGate(layout, 1)), ["sA", "sB"]);
});

Deno.test("error: not exactly three player closures", () => {
  const layout = zombotsLayout(base({ doors: [{ id: "d1", wallId: "wl", center: { x: -7, z: -2 } }] }));
  assertEquals(layout.phases, null);
  assert(hasError(layout.errors, "Expected exactly 3 player closures", "found 2"), layout.errors.join("\n"));
  // P3 is now a zombie closure with no spawn.
  assert(hasError(layout.errors, "Zombie closure near (13.6, -2.6)", "no zombie spawn"), layout.errors.join("\n"));
});

Deno.test("error: phase 1 opening onto two closures", () => {
  // P1 spans the whole south; walls split it from P2 (north-west) and P3 (north-east).
  const map: ZombotsLayoutMap = {
    bounds: { minX: -20, maxX: 20, minZ: -10, maxZ: 10 },
    walls: [
      { id: "wz", a: { x: -20, z: 0 }, b: { x: 20, z: 0 }, kind: "full" },
      { id: "wm", a: { x: 0, z: 0 }, b: { x: 0, z: 10 }, kind: "full" },
    ],
    doors: [
      { id: "d1", wallId: "wz", center: { x: -10, z: 0 } },
      { id: "d2", wallId: "wz", center: { x: 10, z: 0 } },
    ],
    spawnCorner: 0,
  };
  const layout = zombotsLayout(map);
  assertEquals(layout.phases, null);
  assert(hasError(layout.errors, "opens straight onto two closures"), layout.errors.join("\n"));
});

Deno.test("error: a door between two zombie closures", () => {
  const map = base();
  map.doors = [...map.doors!, { id: "dz", wallId: "wr", center: { x: 7, z: 7.5 } }];
  const layout = zombotsLayout(map);
  assert(hasError(layout.errors, "Door dz at (7, 7.5)", "doors may only join player closures"), layout.errors.join("\n"));
  // The rest still labels.
  assert(layout.phases);
});

Deno.test("error: a door that doesn't separate two rooms", () => {
  const map = base({
    walls: [...base().walls, { id: "stub", a: { x: -18, z: -8 }, b: { x: -14, z: -8 }, kind: "full" }],
  });
  map.doors = [...map.doors!, { id: "loose", wallId: "stub", center: { x: -16, z: -8 } }];
  const layout = zombotsLayout(map);
  assert(hasError(layout.errors, "Door loose at (-16, -8)", "doesn't separate two rooms"), layout.errors.join("\n"));
});

Deno.test("error: a zombie spawn inside a player closure", () => {
  const map = base();
  map.zombieSpawns = [...map.zombieSpawns!, { id: "bad", p: { x: 0, z: -5 } }];
  const layout = zombotsLayout(map);
  assert(hasError(layout.errors, "Zombie spawn bad at (0, -5)", "player closure (phase 2)"), layout.errors.join("\n"));
  assertEquals(zombotsSpawnGate(layout, 3)("bad"), false);
});

Deno.test("error: a zombie closure with no spawn", () => {
  const layout = zombotsLayout(base({ zombieSpawns: [{ id: "sA", p: { x: -14, z: 8 } }, { id: "sB", p: { x: 0, z: 8 } }] }));
  assertEquals(layout.errors.length, 1, layout.errors.join("\n"));
  assert(hasError(layout.errors, "Zombie closure near (13.6, 7.6)", "no zombie spawn"), layout.errors.join("\n"));
});

Deno.test("error: a zombie closure with no window into a player closure", () => {
  const map = base();
  map.windows = map.windows!.filter((w) => w.id !== "winC");
  const layout = zombotsLayout(map);
  assertEquals(layout.errors.length, 1, layout.errors.join("\n"));
  assert(hasError(layout.errors, "no window into a player closure"), layout.errors.join("\n"));
  assertEquals(zombotsSpawnGate(layout, 3)("sC"), false);
});

Deno.test("error: racks before their phase, between two phases, or with no player side", () => {
  const map = base();
  map.gunRacks = [
    { id: "early", wallId: "wz", center: { x: 3, z: 5 }, weapon: "shotgun" },
    { id: "rifle", wallId: "wl", center: { x: -7, z: -6 }, weapon: "rifle" },
    { id: "shotgun", wallId: "wr", center: { x: 7, z: 8 }, weapon: "shotgun" },
  ];
  const layout = zombotsLayout(map);
  assert(hasError(layout.errors, "shotgun) at (3, 5) faces phase 2", "belong in phase 3"), layout.errors.join("\n"));
  assert(hasError(layout.errors, "rifle) at (-7, -6)", "between phase 1 and phase 2", "pick which side"), layout.errors.join("\n"));
  assert(hasError(layout.errors, "shotgun) at (7, 8)", "no player closure on either side"), layout.errors.join("\n"));
  assertEquals(layout.rackPhase.map((r) => [r.rackId, r.phase]), [["early", 2], ["rifle", null], ["shotgun", null]]);
});

Deno.test("racks: a picked face settles a wall between two phases", () => {
  // Wall wl runs a (-7,-10) → b (-7,10): its left normal points to -x.
  const placed = (face: 1 | -1) => {
    const map = base();
    map.gunRacks = [{ id: "p", wallId: "wl", center: { x: -7, z: -6 }, weapon: "pistol", face }];
    const layout = zombotsLayout(map);
    assert(!layout.errors.some((e) => e.includes("Gun rack")), layout.errors.join("\n"));
    return layout.rackPhase[0]!;
  };
  const left = placed(1);
  const right = placed(-1);
  assert(left.facing!.x < -0.999 && Math.abs(left.facing!.z) < 1e-9);
  assert(right.facing!.x > 0.999 && Math.abs(right.facing!.z) < 1e-9);
  assertEquals([left.phase, right.phase].sort(), [1, 2]);
  assert(left.playerRoom !== right.playerRoom);
});

Deno.test("racks: a picked face toward no player closure is an error", () => {
  const map = base();
  // wz is the phase 2 wall with a zombie closure behind it; face both ways.
  map.gunRacks = [
    { id: "a", wallId: "wz", center: { x: 3, z: 5 }, weapon: "pistol", face: 1 },
    { id: "b", wallId: "wz", center: { x: 5, z: 5 }, weapon: "pistol", face: -1 },
  ];
  const layout = zombotsLayout(map);
  const rackErrors = layout.errors.filter((e) => e.includes("faces a side with no player closure"));
  assertEquals(rackErrors.length, 1, layout.errors.join("\n"));
  assertEquals(layout.rackPhase.filter((r) => r.phase === 2).length, 1);
});

Deno.test("racks: an earlier weapon may hang in a later phase too", () => {
  const map = base();
  map.gunRacks = [
    { id: "pistol-2", wallId: "wz", center: { x: 3, z: 5 }, weapon: "pistol" },
    { id: "rifle-2", wallId: "wz", center: { x: 5, z: 5 }, weapon: "rifle" },
  ];
  const layout = zombotsLayout(map);
  assert(!layout.errors.some((e) => e.includes("Gun rack")), layout.errors.join("\n"));
  assertEquals(layout.rackPhase.map((r) => [r.rackId, r.phase]), [["pistol-2", 2], ["rifle-2", 2]]);
});

Deno.test("slivers: a closed wall box is a warning, not a closure", () => {
  const box = [
    { id: "b1", a: { x: -15, z: -6 }, b: { x: -13, z: -6 }, kind: "full" },
    { id: "b2", a: { x: -13, z: -6 }, b: { x: -13, z: -4 }, kind: "full" },
    { id: "b3", a: { x: -13, z: -4 }, b: { x: -15, z: -4 }, kind: "full" },
    { id: "b4", a: { x: -15, z: -4 }, b: { x: -15, z: -6 }, kind: "full" },
  ];
  const layout = zombotsLayout(base({ walls: [...base().walls, ...box] }));
  assertEquals(layout.errors, []);
  assertEquals(layout.slivers.length, 1);
  assertEquals(layout.zombieRooms.length, 3);
  assertEquals(layout.warnings, [
    "gap near (-14, -5): 1 m² of floor shut in by walls (a closed wall box, or walls that almost meet). " +
    "Ignored; fine for a pillar, but open it up if it was meant to be a room.",
  ]);
  assertEquals(layout.phaseOf({ x: -14, z: -5 }), null);
  assert(ZOMBOTS_LAYOUT_MIN_ROOM_AREA > 4);
});

Deno.test("slivers: a spawn in one is an error", () => {
  const box = [
    { id: "b1", a: { x: 10, z: 6 }, b: { x: 12, z: 6 }, kind: "full" },
    { id: "b2", a: { x: 12, z: 6 }, b: { x: 12, z: 8 }, kind: "full" },
    { id: "b3", a: { x: 12, z: 8 }, b: { x: 10, z: 8 }, kind: "full" },
    { id: "b4", a: { x: 10, z: 8 }, b: { x: 10, z: 6 }, kind: "full" },
  ];
  const map = base({ walls: [...base().walls, ...box] });
  map.zombieSpawns = [...map.zombieSpawns!, { id: "boxed", p: { x: 11, z: 7 } }];
  const layout = zombotsLayout(map);
  assert(hasError(layout.errors, "Zombie spawn boxed at (11, 7)", "tiny walled-off gap"), layout.errors.join("\n"));
});

Deno.test("Zombots-01: three phases, two zombie closures, seven pillar slivers, no errors", async () => {
  const map = await loadMapFile(
    new URL("../../maps/zombots/Zombots-01.doors.json", import.meta.url).pathname,
  );
  const graph = zombotsRoomGraph(map);
  const layout = zombotsLayout(map);
  assertEquals(layout.errors, []);
  assertEquals(graph.roomCount, 12);

  // Pad room, then through door_ei1akqdg, then door_xxdwt2yj.
  assertEquals(layout.phases, [4, 2, 1]);
  assertEquals(graph.padRoom, 4);
  assertEquals(layout.phaseOf({ x: 20, z: -5 }), 1);
  assertEquals(layout.phaseOf({ x: -5, z: -5 }), 2);
  assertEquals(layout.phaseOf({ x: -20, z: 0 }), 3);

  // The seven spawn-less rooms are all the insides of closed wall-box pillars.
  assertEquals(layout.slivers, [5, 6, 7, 8, 9, 10, 11]);
  assertEquals(
    layout.slivers.map((r) => {
      const s = layout.rooms[r]!;
      return [s.centroid.x, s.centroid.z, s.cells * 0.0625];
    }),
    [[-6, -15, 1], [-20, -10, 1], [-7.5, -9, 4], [12, -5, 1], [23, -5, 1], [-5, 2.5, 4], [-20, 10, 1]],
  );

  assertEquals(layout.zombieRooms.map((z) => [z.room, z.spawnIds.length]), [[0, 7], [3, 2]]);
  const perPhase = [1, 2, 3].map((p) => layout.windowLinks.filter((w) => w.phase === p).map((w) => w.windowId));
  assertEquals(perPhase, [
    ["win_7b6wocpg", "win_81yfb6rs", "win_bsung1gh", "win_qi2rfxu8", "win_svmgbarz"],
    ["win_9fkd424m", "win_nubalolo", "win_0obiusvo", "win_9oos7zdn"],
    ["win_qb3iqdzz", "win_6d5939y0", "win_vgwts1ey", "win_8qonrdg7", "win_1bv3ncnp"],
  ]);
  assertEquals(layout.rackPhase.map((r) => [r.weapon, r.phase]), [["pistol", 1], ["rifle", 2], ["shotgun", 3]]);

  // The one non-gap warning: a window straight between phase 2 and phase 3.
  const other = layout.warnings.filter((w) => !w.startsWith("gap near"));
  assertEquals(other.length, 1);
  assert(other[0]!.startsWith("Window win_ua7pu8ma at (-15, 5) joins phase 2 and phase 3"));

  // Both zombie closures have a phase 1 window, so every spawn is live from the start.
  const ids = map.zombieSpawns!.map((s) => s.id);
  assertEquals(ids.filter(zombotsSpawnGate(layout, 1)).length, 9);
});
