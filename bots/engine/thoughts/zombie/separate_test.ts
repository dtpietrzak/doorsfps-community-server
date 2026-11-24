import { assertEquals } from "@std/assert";
import {
  zombieSeparationStrafe,
  ZOMBIE_SEPARATION_RADIUS,
  type ZombieCrowdBody,
} from "./separate.ts";

function bot(id: string, x: number, z: number, alive = true): ZombieCrowdBody {
  return { id, x, z, alive, isBot: true };
}

Deno.test("zombieSeparationStrafe: stacked zombies peel to opposite sides", () => {
  const za = bot("za", 0, 0);
  const zb = bot("zb", 0, 0);
  const roster = [za, zb];
  assertEquals(zombieSeparationStrafe(za, 0, roster), "right");
  assertEquals(zombieSeparationStrafe(zb, 0, roster), "left");
});

Deno.test("zombieSeparationStrafe: push is away from a neighbour, not a human", () => {
  const self = bot("za", 0, 0);
  // +x is right when yaw is 0, so a bot there shoves us left.
  const beside = bot("zb", 0.4, 0);
  assertEquals(zombieSeparationStrafe(self, 0, [self, beside]), "left");

  const human = { id: "h", x: 0.2, z: 0, alive: true, isBot: false };
  assertEquals(zombieSeparationStrafe(self, 0, [self, human]), "none");

  const far = bot("far", ZOMBIE_SEPARATION_RADIUS + 1, 0);
  assertEquals(zombieSeparationStrafe(self, 0, [self, far]), "none");
  const dead = bot("dead", 0, 0, false);
  assertEquals(zombieSeparationStrafe(self, 0, [self, dead]), "none");
});

Deno.test("zombieSeparationStrafe: same roster, same side", () => {
  const roster = [bot("za", 0, 0), bot("zb", 0.2, 0.1), bot("zc", -0.3, 0.2)];
  const self = roster[0]!;
  assertEquals(
    zombieSeparationStrafe(self, 0.4, roster),
    zombieSeparationStrafe(self, 0.4, roster),
  );
});
