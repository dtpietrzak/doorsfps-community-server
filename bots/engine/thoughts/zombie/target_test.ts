import { assertEquals } from "@std/assert";
import {
  isZombiePrey,
  pickZombieTarget,
  ZOMBIE_TARGET_SWITCH_MARGIN,
  type ZombiePlayerView,
} from "./target.ts";

function human(
  id: string,
  x: number,
  z: number,
  extra: Partial<ZombiePlayerView> = {},
): ZombiePlayerView {
  return {
    id,
    x,
    z,
    y: 1.6,
    alive: true,
    isBot: false,
    isAgent: false,
    glitchState: "inactive",
    ...extra,
  } as ZombiePlayerView;
}

const self = { id: "z", x: 0, z: 0 };

Deno.test("pickZombieTarget: nearest living human, smaller id on a tie", () => {
  const far = human("far", 0, -10);
  const near = human("near", 0, -4);
  const picked = pickZombieTarget(self, [far, near], "");
  assertEquals(picked?.id, "near");

  const a = human("b", 3, 0);
  const b = human("a", -3, 0);
  assertEquals(pickZombieTarget(self, [a, b], "")?.id, "a");
});

Deno.test("pickZombieTarget: sticky until another is closer by the margin", () => {
  const current = human("current", 0, -10);
  const almost = human("other", 0, -(10 - ZOMBIE_TARGET_SWITCH_MARGIN));
  assertEquals(
    pickZombieTarget(self, [current, almost], "current")?.id,
    "current",
  );

  const closer = human("other", 0, -(10 - ZOMBIE_TARGET_SWITCH_MARGIN - 0.1));
  assertEquals(
    pickZombieTarget(self, [current, closer], "current")?.id,
    "other",
  );
});

Deno.test("pickZombieTarget: downed, dead, gone, bots, and glitch are not prey", () => {
  const downed = human("down", 0, -1, { isDowned: true });
  const dead = human("dead", 0, -1, { alive: false });
  const bot = human("bot", 0, -1, { isBot: true });
  const agent = human("agent", 0, -1, { isAgent: true });
  const ghost = human("ghost", 0, -1, { glitchState: "hidden" });
  const living = human("live", 0, -9);
  const roster = [downed, dead, bot, agent, ghost, living];

  assertEquals(isZombiePrey(self.id, downed), false);
  assertEquals(isZombiePrey(self.id, living), true);
  assertEquals(pickZombieTarget(self, roster, "")?.id, "live");
  assertEquals(pickZombieTarget(self, roster, "down")?.id, "live");
  assertEquals(pickZombieTarget(self, roster, "dead")?.id, "live");
  assertEquals(pickZombieTarget(self, [downed], "down"), null);
  assertEquals(pickZombieTarget(self, roster, "missing")?.id, "live");
});

Deno.test("pickZombieTarget: same inputs, same target", () => {
  const roster = [human("b", 4, 1), human("a", 4, -1), human("c", 1, 8)];
  const first = pickZombieTarget(self, roster, "b");
  const second = pickZombieTarget(self, roster, "b");
  assertEquals(first?.id, second?.id);
  assertEquals(first?.x, second?.x);
  assertEquals(first?.z, second?.z);
});
