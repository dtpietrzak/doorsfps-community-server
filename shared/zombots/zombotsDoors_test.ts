import { assertEquals } from "@std/assert";
import { SLIDING_DOOR_COST, ZOMBOTS_DOOR_REACH } from "../world/slidingDoors.ts";
import {
  roomSpawnGate,
  spawnGate,
  type ZombotsDoorMap,
  zombotsDoorCharge,
  ZombotsDoorState,
  zombieSpawnDoorRequirements,
  zombotsRoomGraph,
} from "./zombotsDoors.ts";

/**
 * 20×20 arena split along z=0. North half is split again at x=0.
 *   south (pad, SW corner) --d1--> NW --d2--> NE
 */
function rooms(extra: Partial<ZombotsDoorMap> = {}): ZombotsDoorMap {
  return {
    bounds: { minX: -10, maxX: 10, minZ: -10, maxZ: 10 },
    walls: [
      { id: "w1", a: { x: -10, z: 0 }, b: { x: 10, z: 0 } },
      { id: "w2", a: { x: 0, z: 0 }, b: { x: 0, z: 10 } },
    ],
    doors: [
      { id: "d1", wallId: "w1", center: { x: -5, z: 0.1 } },
      { id: "d2", wallId: "w2", center: { x: 0, z: 5 }, cost: 750 },
    ],
    spawnCorner: 0,
    zombieSpawns: [
      { id: "south", p: { x: 5, z: -5 } },
      { id: "nw", p: { x: -5, z: 5 } },
      { id: "ne", p: { x: 5, z: 5 } },
    ],
    ...extra,
  };
}

function purse(points: number) {
  const calls: number[] = [];
  return {
    calls,
    get points() {
      return points;
    },
    spend: (cost: number) => {
      calls.push(cost);
      if (points < cost) return { ok: false, points };
      points -= cost;
      return { ok: true, points };
    },
  };
}

Deno.test("doors read id, wall, cost (default) and a reach point snapped onto the wall", () => {
  const state = new ZombotsDoorState(rooms());
  assertEquals(state.all().map((d) => [d.id, d.wallId, d.cost]), [
    ["d1", "w1", SLIDING_DOOR_COST],
    ["d2", "w2", 750],
  ]);
  assertEquals(state.door("d1")?.reachPoint, { x: -5, z: 0 });
  assertEquals(state.door("d1")?.center, { x: -5, z: 0.1 });
  assertEquals(state.door("nope"), null);
  assertEquals(state.openIds(), []);
});

Deno.test("tryOpenDoor refuses in order and only spends after reach passes", () => {
  const state = new ZombotsDoorState(rooms());
  const wallet = purse(600);
  assertEquals(state.tryOpenDoor("p1", "zz", { x: -5, z: -1 }, wallet.spend), {
    ok: false,
    reason: "unknown",
  });
  assertEquals(
    state.tryOpenDoor("p1", "d1", { x: -5, z: -ZOMBOTS_DOOR_REACH - 0.01 }, wallet.spend),
    { ok: false, reason: "outOfReach" },
  );
  assertEquals(state.tryOpenDoor("p1", "d1", { x: NaN, z: 0 }, wallet.spend).ok, false);
  assertEquals(wallet.calls, []);

  // Exactly at reach counts, like the playtest's nearestClosedSlidingDoor.
  const opened = state.tryOpenDoor("p1", "d1", { x: -5, z: -ZOMBOTS_DOOR_REACH }, wallet.spend);
  assertEquals(opened, {
    ok: true,
    doorId: "d1",
    cost: 500,
    charge: 500,
    paid: 500,
    points: 100,
    intent: { kind: "doorOpened", doorId: "d1", by: "p1" },
  });
  assertEquals(state.isOpen("d1"), true);
  assertEquals(state.tryOpenDoor("p2", "d1", { x: -5, z: -1 }, wallet.spend), {
    ok: false,
    reason: "alreadyOpen",
  });

  assertEquals(state.tryOpenDoor("p1", "d2", { x: -1, z: 5 }, wallet.spend), {
    ok: false,
    reason: "cantAfford",
  });
  assertEquals(wallet.calls, [500, 750]);
  assertEquals(wallet.points, 100);
  assertEquals(state.isOpen("d2"), false);
});

Deno.test("zombotsDoorCharge is one charge, or what is left", () => {
  assertEquals(zombotsDoorCharge(500), 500);
  assertEquals(zombotsDoorCharge(2000), 1000);
  assertEquals(zombotsDoorCharge(2000, 1000), 1000);
  assertEquals(zombotsDoorCharge(2500, 2000), 500);
  assertEquals(zombotsDoorCharge(2000, 2000), 0);
  assertEquals(zombotsDoorCharge(0), 0);
});

Deno.test("doors over one charge open after enough charges, from anyone", () => {
  const state = new ZombotsDoorState(rooms({
    doors: [{ id: "big", wallId: "w1", center: { x: -5, z: 0 }, cost: 4000 }],
  }));
  const eye = { x: -5, z: -1 };
  const alpha = purse(2500);
  const bravo = purse(2000);

  const first = state.tryOpenDoor("alpha", "big", eye, alpha.spend);
  assertEquals(first, {
    ok: true,
    doorId: "big",
    cost: 4000,
    charge: 1000,
    paid: 1000,
    points: 1500,
    intent: null,
  });
  assertEquals(state.isOpen("big"), false);
  assertEquals(state.paidDoors(), [{ doorId: "big", paid: 1000 }]);

  assertEquals(state.tryOpenDoor("bravo", "big", eye, bravo.spend).ok, true);
  assertEquals(state.tryOpenDoor("alpha", "big", eye, alpha.spend).ok, true);
  assertEquals(state.paidFor("big"), 3000);
  // Short of a charge: refused, nothing paid.
  assertEquals(state.tryOpenDoor("alpha", "big", eye, alpha.spend), { ok: false, reason: "cantAfford" });
  assertEquals(alpha.points, 500);
  assertEquals(state.paidFor("big"), 3000);

  const last = state.tryOpenDoor("bravo", "big", eye, bravo.spend);
  assertEquals(last.ok && last.intent, { kind: "doorOpened", doorId: "big", by: "bravo" });
  assertEquals(state.isOpen("big"), true);
  assertEquals(state.paidDoors(), []);
  assertEquals(bravo.calls, [1000, 1000]);
  assertEquals(bravo.points, 0);
});

Deno.test("a 2000 door is two 1000 charges, both payable by one player", () => {
  const state = new ZombotsDoorState(rooms({
    doors: [{ id: "d", wallId: "w1", center: { x: -5, z: 0 }, cost: 2000 }],
  }));
  const solo = purse(2000);
  const eye = { x: -5, z: -1 };
  assertEquals(state.tryOpenDoor("p", "d", eye, solo.spend).ok, true);
  assertEquals(state.isOpen("d"), false);
  assertEquals(state.tryOpenDoor("p", "d", eye, solo.spend).ok, true);
  assertEquals(state.isOpen("d"), true);
  assertEquals(solo.calls, [1000, 1000]);
});

Deno.test("openIds is map order whatever order doors were bought in", () => {
  const state = new ZombotsDoorState(rooms());
  const rich = purse(10_000);
  assertEquals(state.tryOpenDoor("p", "d2", { x: 1, z: 5 }, rich.spend).ok, true);
  assertEquals(state.tryOpenDoor("p", "d1", { x: -5, z: 1 }, rich.spend).ok, true);
  assertEquals(state.openIds(), ["d1", "d2"]);
  assertEquals(state.markOpen("d1"), false);
  assertEquals(state.markOpen("nope"), false);
});

Deno.test("markOpen opens without spending; duplicate door ids keep the first", () => {
  const state = new ZombotsDoorState(rooms({
    doors: [
      { id: "d1", wallId: "w1", center: { x: -5, z: 0 }, cost: 10 },
      { id: "d1", wallId: "w2", center: { x: 0, z: 5 }, cost: 20 },
    ],
  }));
  assertEquals(state.all().length, 1);
  assertEquals(state.door("d1")?.cost, 10);
  assertEquals(state.markOpen("d1"), true);
  assertEquals(state.isOpen("d1"), true);
});

Deno.test("room graph: pad room, spawn rooms and the rooms each door joins", () => {
  const graph = zombotsRoomGraph(rooms());
  assertEquals(graph.roomCount, 3);
  const south = graph.spawnRooms.get("south");
  const nw = graph.spawnRooms.get("nw");
  const ne = graph.spawnRooms.get("ne");
  assertEquals(graph.padRoom, south);
  assertEquals(new Set([south, nw, ne]).size, 3);
  const d1 = graph.doorRooms.find((d) => d.doorId === "d1")!.rooms!;
  const d2 = graph.doorRooms.find((d) => d.doorId === "d2")!.rooms!;
  assertEquals(new Set(d1), new Set([south, nw]));
  assertEquals(new Set(d2), new Set([nw, ne]));
});

Deno.test("spawn requirements: none from the pad room, chains through doors", () => {
  const req = zombieSpawnDoorRequirements(rooms());
  assertEquals([...req.entries()], [
    ["south", []],
    ["nw", ["d1"]],
    ["ne", ["d1", "d2"]],
  ]);
  const state = new ZombotsDoorState(rooms());
  const gate = spawnGate(req, (id) => state.isOpen(id));
  assertEquals([gate("south"), gate("nw"), gate("ne"), gate("missing")], [true, false, false, false]);
  state.markOpen("d1");
  assertEquals([gate("nw"), gate("ne")], [true, false]);
  state.markOpen("d2");
  assertEquals(gate("ne"), true);
});

Deno.test("a loop takes the fewest doors; roomSpawnGate accepts either route", () => {
  const map = rooms({
    doors: [
      { id: "d1", wallId: "w1", center: { x: -5, z: 0 } },
      { id: "d2", wallId: "w2", center: { x: 0, z: 5 } },
      { id: "d3", wallId: "w1", center: { x: 5, z: 0 } },
    ],
  });
  const req = zombieSpawnDoorRequirements(map);
  assertEquals(req.get("ne"), ["d3"]);
  const graph = zombotsRoomGraph(map);
  const open = new Set<string>(["d1", "d2"]);
  const exact = roomSpawnGate(graph, (id) => open.has(id));
  const table = spawnGate(req, (id) => open.has(id));
  assertEquals(exact("ne"), true);
  assertEquals(table("ne"), false);
  open.clear();
  assertEquals(exact("ne"), false);
  assertEquals(exact("south"), true);
});

Deno.test("half and float walls don't split rooms; windows do", () => {
  const walls = [
    { id: "w1", a: { x: -10, z: 0 }, b: { x: 10, z: 0 }, kind: "half" },
  ];
  const half = zombieSpawnDoorRequirements(rooms({ walls, doors: [] }));
  assertEquals(half.get("nw"), []);
  const float = zombieSpawnDoorRequirements(rooms({
    walls: [{ ...walls[0]!, kind: "float" }],
    doors: [],
  }));
  assertEquals(float.get("ne"), []);
  // A full wall with no door: the north spawns can never be reached.
  const sealed = zombieSpawnDoorRequirements(rooms({ walls: [rooms().walls[0]!], doors: [] }));
  assertEquals([sealed.get("south"), sealed.get("nw"), sealed.get("ne")], [[], null, null]);
  const gate = spawnGate(sealed, () => true);
  assertEquals(gate("nw"), false);
  // A window in that wall still seals it: the sill stops a walking body.
  const windowed = {
    ...rooms({ walls: [rooms().walls[0]!], doors: [] }),
    windows: [{ id: "win", wallId: "w1", center: { x: 5, z: 0 } }],
  };
  assertEquals(zombieSpawnDoorRequirements(windowed).get("ne"), null);
});

Deno.test("a spawn inside a wall or a map without spawns is handled", () => {
  const graph = zombotsRoomGraph(rooms({
    zombieSpawns: [{ id: "inWall", p: { x: 3, z: 0 } }],
  }));
  // Near a wall it snaps to the nearest open floor instead of failing.
  assertEquals(graph.spawnRooms.get("inWall") !== null, true);
  assertEquals(zombieSpawnDoorRequirements(rooms({ zombieSpawns: undefined })).size, 0);
});

Deno.test("the pad follows spawnCorner", () => {
  // NE corner (2) sits in the NE room, so the south needs both doors.
  const req = zombieSpawnDoorRequirements(rooms({ spawnCorner: 2 }));
  assertEquals(req.get("ne"), []);
  assertEquals(req.get("nw"), ["d2"]);
  assertEquals(req.get("south"), ["d2", "d1"]);
});
