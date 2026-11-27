/**
 * Windows into a player closure the players haven't opened a door to are
 * sealed to zombies: the collision treats their pane as wall for zombie
 * bodies, window crawl won't start there, and the zombie nav skips them.
 * Opening the door chain to that closure unseals its windows.
 */
import { assert, assertEquals } from "@std/assert";
import { loadMapFile } from "../../world/loadMap.ts";
import { MapCollision } from "../../world/MapCollision.ts";
import { MapCollision as EngineCollision } from "../../bots/engine/world/MapCollision.ts";
import {
  buildZombieWindowNav,
  openZombieNavDoors,
  zombieWindowPlan,
} from "../../bots/engine/thoughts/zombie/window.ts";
import { emptyBotBrainState } from "../../bots/engine/pipeline/state.ts";
import type { DoorsMap } from "../../world/map.ts";
import { MAP_FORMAT_VERSION } from "../../bots/engine/shared/map.ts";
import { zombotsLayout, zombotsSealedWindowIds } from "./zombotsLayout.ts";

/**
 * 40×20, pad in the SW corner. One zombie strip runs the whole north side
 * (z > 5) with a window into each player room:
 *
 *            zombie strip (spawn s)
 *   --winA--+---winB---+--winC--     wall at z = 5
 *     P1    d1   P2    d2   P3       doors on x = -7 and x = 7
 */
function stripMap(): DoorsMap {
  return {
    name: "zombots-seal",
    version: MAP_FORMAT_VERSION,
    bounds: { minX: -20, maxX: 20, minZ: -10, maxZ: 10 },
    gridSize: 1,
    mirrorMode: "zombots",
    spawnCorner: 0,
    walls: [
      { id: "wz", a: { x: -20, z: 5 }, b: { x: 20, z: 5 }, kind: "full" },
      { id: "wl", a: { x: -7, z: -10 }, b: { x: -7, z: 5 }, kind: "full" },
      { id: "wr", a: { x: 7, z: -10 }, b: { x: 7, z: 5 }, kind: "full" },
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
    zombieSpawns: [{ id: "s", p: { x: 0, z: 8 } }],
    teamA: { corners: [0, 1], edge: "south", doorHalfWidth: 2, spawnRadius: 4 },
    teamB: { corners: [2, 3], edge: "north", doorHalfWidth: 2, spawnRadius: 4 },
  } as DoorsMap;
}

Deno.test("sealed windows: every window past an unbought door, shrinking as doors open", () => {
  const layout = zombotsLayout(stripMap());
  assert(layout.phases !== null);
  const open = new Set<string>();
  const sealed = () => zombotsSealedWindowIds(layout, (id) => open.has(id));
  assertEquals(sealed(), ["winB", "winC"]);
  open.add("d1");
  assertEquals(sealed(), ["winC"]);
  open.add("d2");
  assertEquals(sealed(), []);
});

Deno.test("sealed windows: d2 alone unlocks nothing (P3 is only reachable through P2)", () => {
  const layout = zombotsLayout(stripMap());
  assertEquals(zombotsSealedWindowIds(layout, (id) => id === "d2"), ["winB", "winC"]);
});

Deno.test("sealed windows: Zombots-01 seals phases 2 and 3 at the start", async () => {
  const map = await loadMapFile(
    new URL("../../maps/zombots/Zombots-01.doors.json", import.meta.url).pathname,
  );
  const layout = zombotsLayout(map);
  const later = layout.windowLinks.filter((w) => w.phase > 1).map((w) => w.windowId);
  assertEquals(zombotsSealedWindowIds(layout, () => false), later);
  const all = layout.doorRooms.map((d) => d.doorId);
  assertEquals(zombotsSealedWindowIds(layout, (id) => all.includes(id)), []);
});

/** A zombie body above the sill, pushed into winB's opening. */
function throughWinB(collision: { resolvePosition(x: number, z: number, r?: number, feetY?: number): { z: number } }) {
  return collision.resolvePosition(0, 5.05, undefined, 1.0).z;
}

Deno.test("server collision: a sealed pane is wall for zombies until its door opens", () => {
  const collision = new MapCollision(stripMap());
  const zombie = collision.bodyCollision("zombie");
  assert(throughWinB(zombie) > 5.4, "sealed pane pushes the zombie out");
  assertEquals(collision.windowCrawlPortals().map((p) => p.windowId), ["winA"]);
  collision.openSlidingDoor("d1");
  assert(Math.abs(throughWinB(zombie) - 5.05) < 1e-6, "unsealed pane lets the zombie through");
  assertEquals(collision.windowCrawlPortals().map((p) => p.windowId), ["winA", "winB"]);
});

Deno.test("server collision: a fresh copy replaying the open doors matches", () => {
  const live = new MapCollision(stripMap());
  live.openSlidingDoor("d1");
  const restored = new MapCollision(stripMap());
  for (const id of live.openSlidingDoorIds()) restored.openSlidingDoor(id);
  assertEquals(restored.sealedZombieWindowIds(), live.sealedZombieWindowIds());
  assertEquals(throughWinB(restored.bodyCollision("zombie")), throughWinB(live.bodyCollision("zombie")));
});

Deno.test("engine collision: same seal rule as the server", () => {
  const collision = new EngineCollision(stripMap(), { windowBody: "zombie" });
  assert(throughWinB(collision) > 5.4);
  assertEquals(collision.sealedZombieWindowIds(), ["winB", "winC"]);
  collision.openSlidingDoor("d1");
  assert(Math.abs(throughWinB(collision) - 5.05) < 1e-6);
  assertEquals(collision.sealedZombieWindowIds(), ["winC"]);
});

Deno.test("zombie nav: never latches a sealed window, even the nearest", () => {
  const map = stripMap();
  const collision = new EngineCollision(map, { windowBody: "zombie" });
  const nav = buildZombieWindowNav(map, collision);
  assert(nav !== null);
  const windowOf = (state: ReturnType<typeof emptyBotBrainState>) =>
    nav.portals[state.halfWallVaultOption as number]!.windowId;

  // Standing right behind winB with no goal: the old rule took winB (P2, shut).
  const self = { x: 0, z: 7, onGround: true };
  const sealedState = emptyBotBrainState();
  zombieWindowPlan(nav, self, null, sealedState);
  assertEquals(windowOf(sealedState), "winA");

  collision.openSlidingDoor("d1");
  openZombieNavDoors(nav, ["d1"], collision);
  assertEquals(nav.sealedWindows, ["winC"]);
  const openState = emptyBotBrainState();
  zombieWindowPlan(nav, self, null, openState);
  assertEquals(windowOf(openState), "winB");

  // A zombie latched on a sealed window drops it.
  const near3 = { x: 14, z: 7, onGround: true };
  const latched = emptyBotBrainState();
  latched.halfWallVaultOption = nav.portals.findIndex((p) => p.windowId === "winC");
  zombieWindowPlan(nav, near3, null, latched);
  assertEquals(windowOf(latched), "winB");
});
