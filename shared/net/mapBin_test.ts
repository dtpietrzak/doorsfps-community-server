import { assertEquals } from "@std/assert";
import { ByteReader, ByteWriter } from "./bytes.ts";
import { readMap, type WireDoorsMap, writeMap } from "./mapBin.ts";

const side = (
  edge: "south" | "north",
  corners: [0 | 1 | 2 | 3, 0 | 1 | 2 | 3],
) => ({ corners, edge, doorHalfWidth: 1.5, spawnRadius: 2 });

const zombotsMap: WireDoorsMap = {
  version: 2,
  name: "Golden",
  bounds: { minX: -10, maxX: 10, minZ: -8, maxZ: 8 },
  gridSize: 1,
  teamA: side("south", [0, 1]),
  teamB: side("north", [2, 3]),
  walls: [
    { id: "w1", a: { x: -4, z: 0 }, b: { x: 4, z: 0 } },
    { id: "w2", a: { x: 0, z: 2 }, b: { x: 0, z: 6 }, kind: "half" },
  ],
  doors: [{ id: "d1", wallId: "w1", center: { x: 1, z: 0 } }],
  mirrorMode: "zombots",
  spawnCorner: 2,
};

const arenaMap: WireDoorsMap = {
  ...zombotsMap,
  doors: undefined,
  mirrorMode: undefined,
  spawnCorner: undefined,
};

// Captured from mapBin.ts before gun racks existed.
const ZOMBOTS_GOLDEN =
  "300106476f6c64656e000020c100002041000000c1000000410000803f0001000000c03f000000400203020000c03f000000400200027731000080c0000000000000804000000000000277320000000000000040000000000000c0400101000264310277310000803f00000000f40102";
const ARENA_GOLDEN =
  "000106476f6c64656e000020c100002041000000c1000000410000803f0001000000c03f000000400203020000c03f000000400200027731000080c0000000000000804000000000000277320000000000000040000000000000c04001";

function encode(map: WireDoorsMap): Uint8Array {
  const w = new ByteWriter();
  writeMap(w, map);
  return w.toBytes();
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const racks: NonNullable<WireDoorsMap["gunRacks"]> = [
  { id: "r1", wallId: "w1", center: { x: -2, z: 0 }, weapon: "pistol" },
  { id: "r2", wallId: "w1", center: { x: 2.5, z: 0 }, weapon: "rifle" },
  { id: "r3", wallId: "w1", center: { x: 3, z: 0 }, weapon: "shotgun" },
];

Deno.test("maps without racks encode exactly as before racks existed", () => {
  assertEquals(hex(encode(zombotsMap)), ZOMBOTS_GOLDEN);
  assertEquals(hex(encode(arenaMap)), ARENA_GOLDEN);
  assertEquals(hex(encode({ ...zombotsMap, gunRacks: [] })), ZOMBOTS_GOLDEN);
});

Deno.test("gun racks round-trip on a zombots map", () => {
  const back = readMap(new ByteReader(encode({ ...zombotsMap, gunRacks: racks })));
  assertEquals(back.gunRacks, racks);
  assertEquals(back.mirrorMode, "zombots");
  assertEquals(back.spawnCorner, 2);
  assertEquals(back.doors, zombotsMap.doors);
});

Deno.test("rack faces round-trip, and racks without one keep their old bytes", () => {
  const faced = [{ ...racks[0]!, face: -1 as const }, racks[1]!, { ...racks[2]!, face: 1 as const }];
  const back = readMap(new ByteReader(encode({ ...zombotsMap, gunRacks: faced })));
  assertEquals(back.gunRacks, faced);
  assertEquals(
    encode({ ...zombotsMap, gunRacks: faced }).length,
    encode({ ...zombotsMap, gunRacks: racks }).length + faced.length,
  );
});

Deno.test("gun racks are not written for a non-zombots map", () => {
  const bytes = encode({ ...arenaMap, gunRacks: racks });
  assertEquals(hex(bytes), ARENA_GOLDEN);
  assertEquals(readMap(new ByteReader(bytes)).gunRacks, undefined);
});
