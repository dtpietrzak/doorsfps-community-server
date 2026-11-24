import { assertEquals } from "@std/assert";
import { MAX_GUN_RACKS, normalizeGunRacks } from "./gunRacks.ts";

const walls = [
  { id: "w1", a: { x: -4, z: 0 }, b: { x: 4, z: 0 } },
  { id: "half", a: { x: 0, z: 2 }, b: { x: 0, z: 6 }, kind: "half" },
];

function rack(id: string, x: number, extra: Record<string, unknown> = {}) {
  return { id, wallId: "w1", center: { x, z: 0 }, weapon: "rifle", ...extra };
}

Deno.test("racks are dropped outside zombots maps", () => {
  assertEquals(normalizeGunRacks({ walls, gunRacks: [rack("r", 0)] }), []);
  assertEquals(
    normalizeGunRacks({ mirrorMode: "flipY", walls, gunRacks: [rack("r", 0)] }),
    [],
  );
});

Deno.test("good racks are kept in order on a zombots map", () => {
  const out = normalizeGunRacks({
    mirrorMode: "zombots",
    walls,
    gunRacks: [rack("a", 1, { weapon: "shotgun" }), rack("b", -1)],
  });
  assertEquals(out, [
    { id: "a", wallId: "w1", center: { x: 1, z: 0 }, weapon: "shotgun" },
    { id: "b", wallId: "w1", center: { x: -1, z: 0 }, weapon: "rifle" },
  ]);
});

Deno.test("bad racks are dropped one by one", () => {
  const out = normalizeGunRacks({
    mirrorMode: "zombots",
    walls,
    gunRacks: [
      rack("ok", 0),
      rack("ok", 1), // duplicate id
      rack("missingWall", 0, { wallId: "nope" }),
      rack("halfWall", 0, { wallId: "half", center: { x: 0, z: 4 } }),
      rack("offWall", 0, { center: { x: 0, z: 0.5 } }),
      rack("nearOffWall", 1, { center: { x: 1, z: 0.2 } }),
      rack("pastEnd", 3.8), // board overhangs the wall end
      rack("badWeapon", 0, { weapon: "rocket" }),
      rack("", 0),
      rack("nanCenter", Number.NaN),
      null,
      "rack",
    ],
  });
  assertEquals(out.map((r) => r.id), ["ok", "nearOffWall"]);
  assertEquals(out[1]!.center, { x: 1, z: 0.2 });
});

Deno.test("rack count is capped", () => {
  const gunRacks = Array.from({ length: MAX_GUN_RACKS + 4 }, (_, i) => rack(`r${i}`, 0));
  const out = normalizeGunRacks({ mirrorMode: "zombots", walls, gunRacks });
  assertEquals(out.length, MAX_GUN_RACKS);
  assertEquals(out[MAX_GUN_RACKS - 1]!.id, `r${MAX_GUN_RACKS - 1}`);
});
