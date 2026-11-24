/**
 * Zombie brain: sticky human, hunt nav, melee, crowd strafe, no guns.
 */
import { assertAlmostEquals, assertEquals } from "@std/assert";
import { PISTOL } from "../../../shared/sim/weapons.ts";
import {
  BALANCE_BOT_CONFIG,
  ZOMBIE_BOT_CONFIG,
} from "../../botBrainConfig.ts";
import { clearCombatLosCache } from "../helpers/combat.ts";
import { PI } from "../math/index.ts";
import { MAP_FORMAT_VERSION, type DoorsMap } from "../shared/map.ts";
import type { BotAction, BotWorldView } from "../types.ts";
import { MapCollision } from "../world/MapCollision.ts";
import {
  meleeCooldownTicks,
  zombieLookAt,
  ZOMBIE_TARGET_SWITCH_MARGIN,
  type ZombiePlayerView,
} from "../thoughts/zombie/index.ts";
import { BotBrain, createBotBrain } from "./brain.ts";
import { emptyBotBrainState, type BotBrainState } from "./state.ts";
import { ZombieBrain } from "./zombieBrain.ts";

const MAP: DoorsMap = {
  name: "zombie-open",
  version: MAP_FORMAT_VERSION,
  bounds: { minX: -50, maxX: 50, minZ: -50, maxZ: 50 },
  gridSize: 1,
  walls: [],
  wallCorners: [],
  teamA: {
    corners: [0, 1],
    edge: "south",
    doorHalfWidth: 2,
    spawnRadius: 4,
  },
  teamB: {
    corners: [2, 3],
    edge: "north",
    doorHalfWidth: 2,
    spawnRadius: 4,
  },
};

const COLLISION = new MapCollision(MAP);

type Pawn = ZombiePlayerView;

function pawn(
  id: string,
  extra: Partial<Pawn> = {},
): Pawn {
  return {
    id,
    team: "A",
    alive: true,
    health: 100,
    x: 0,
    y: 1.6,
    z: 0,
    yaw: 0,
    pitch: 0,
    crouch: false,
    onGround: true,
    spawnedAtTick: 0,
    sprintStamina: 1,
    velocityX: 0,
    velocityY: 0,
    velocityZ: 0,
    moveYaw: null,
    lastShotAtTick: 0,
    isAgent: false,
    isBot: false,
    matchPlayer: true,
    glitchState: "inactive",
    weaponId: PISTOL.id,
    weapon: PISTOL,
    ammoInMag: PISTOL.magSize,
    spareClips: PISTOL.totalClips,
    reloading: false,
    weapons: [{
      id: PISTOL.id,
      ammoInMagazine: PISTOL.magSize,
      spareClips: PISTOL.totalClips,
    }],
    skills: [],
    unlimitedAmmo: false,
    ...extra,
  };
}

function world(
  tick: number,
  self: Pawn,
  players: readonly Pawn[],
  extra: Partial<BotWorldView> = {},
): BotWorldView {
  return {
    tick,
    self,
    players,
    collision: COLLISION,
    map: MAP,
    doorsOpen: true,
    ...extra,
  };
}

function brain(): ZombieBrain {
  return new ZombieBrain(ZOMBIE_BOT_CONFIG, { rng: () => 0.5 });
}

function think(
  bot: ZombieBrain,
  view: BotWorldView,
  state: BotBrainState = emptyBotBrainState(),
): { action: BotAction | null; state: BotBrainState } {
  const action = bot.think(view, state);
  return { action, state };
}

function assertNoGuns(action: BotAction | null): void {
  assertEquals(action?.shoot === true, false);
  assertEquals(action?.reload, undefined);
  assertEquals(action?.weapon, undefined);
  assertEquals(action?.ability, undefined);
}

function inputOf(action: BotAction | null): NonNullable<BotAction["input"]> {
  if (!action?.input) throw new Error("expected an input");
  return action.input;
}

Deno.test("createBotBrain: zombie flag selects ZombieBrain, balance stays BotBrain", () => {
  const zombie = createBotBrain(ZOMBIE_BOT_CONFIG);
  assertEquals(zombie instanceof ZombieBrain, true);
  assertEquals(zombie instanceof BotBrain, false);
  assertEquals(zombie.id, "zombie");

  const flagged = createBotBrain({ ...BALANCE_BOT_CONFIG, zombie: true });
  assertEquals(flagged instanceof ZombieBrain, true);

  const balance = createBotBrain(BALANCE_BOT_CONFIG);
  assertEquals(balance instanceof BotBrain, true);
  assertEquals(balance instanceof ZombieBrain, false);
  assertEquals(balance.id, "balance-bot");
});

Deno.test("zombie brain: hunts the nearest human and never shoots", () => {
  const self = pawn("za", { isBot: true, team: "B", yaw: 0 });
  const human = pawn("h", { team: "A", x: 8, z: 0 });
  const state = emptyBotBrainState();
  const { action } = think(brain(), world(0, self, [self, human]), state);
  const input = inputOf(action);
  const look = zombieLookAt(self, human);

  assertEquals(state.targetEnemyId, "h");
  assertAlmostEquals(state.cadenceNavGoalX, human.x, 1e-9);
  assertAlmostEquals(state.cadenceNavGoalZ, human.z, 1e-9);
  assertEquals(state.cadenceNavGoalMode, "hunt");
  assertAlmostEquals(input.yaw, look.yaw, 1e-6);
  assertAlmostEquals(input.pitch, look.pitch, 1e-6);
  assertEquals(input.pitch < 0, true);
  assertEquals(input.forward, true);
  assertEquals(input.backward, false);
  assertEquals(input.left, false);
  assertEquals(input.right, false);
  assertEquals(input.jump, false);
  assertEquals(input.sprint, false);
  assertEquals(input.crouch, false);
  assertEquals(action?.melee === true, false);
  assertNoGuns(action);
});

Deno.test("zombie brain: same-team human is still prey", () => {
  const self = pawn("za", { isBot: true, team: "B" });
  const human = pawn("h", { team: "B", x: 6, z: 1 });
  const state = emptyBotBrainState();
  const { action } = think(brain(), world(0, self, [self, human]), state);
  assertEquals(state.targetEnemyId, "h");
  assertEquals(inputOf(action).forward, true);
  assertNoGuns(action);
});

Deno.test("zombie brain: sticky until another human is closer by the margin", () => {
  const self = pawn("za", { isBot: true, team: "B" });
  const sticky = pawn("sticky", { z: -10 });
  const other = pawn("other", { z: -(10 - ZOMBIE_TARGET_SWITCH_MARGIN) });
  const bot = brain();
  const state = emptyBotBrainState();

  think(bot, world(0, self, [self, sticky]), state);
  assertEquals(state.targetEnemyId, "sticky");

  think(bot, world(3, self, [self, sticky, other]), state);
  assertEquals(state.targetEnemyId, "sticky");

  other.z = -(10 - ZOMBIE_TARGET_SWITCH_MARGIN - 0.1);
  think(bot, world(6, self, [self, sticky, other]), state);
  assertEquals(state.targetEnemyId, "other");
});

Deno.test("zombie brain: downed humans are skipped", () => {
  const self = pawn("za", { isBot: true, team: "B" });
  const down = pawn("down", { z: -1, isDowned: true });
  const far = pawn("far", { z: -9 });
  const state = emptyBotBrainState();
  const { action } = think(
    brain(),
    world(0, self, [self, down, far]),
    state,
  );
  assertEquals(state.targetEnemyId, "far");
  assertEquals(inputOf(action).forward, true);
  assertNoGuns(action);

  const onlyDown = emptyBotBrainState();
  const stood = think(
    brain(),
    world(0, self, [self, down]),
    onlyDown,
  );
  assertEquals(onlyDown.targetEnemyId, "");
  assertEquals(inputOf(stood.action).forward, false);
  assertEquals(inputOf(stood.action).backward, false);
  assertNoGuns(stood.action);
});

Deno.test("zombie brain: lost target is walked toward, then a fresh life stands", () => {
  const self = pawn("za", { isBot: true, team: "B" });
  const human = pawn("h", { x: 8, z: -2 });
  const bot = brain();
  const state = emptyBotBrainState();
  think(bot, world(0, self, [self, human]), state);
  assertEquals(state.targetEnemyId, "h");

  human.alive = false;
  const wandered = think(bot, world(3, self, [self, human]), state);
  assertEquals(state.targetEnemyId, "");
  assertAlmostEquals(state.cadenceNavGoalX, 8, 1e-9);
  assertAlmostEquals(state.cadenceNavGoalZ, -2, 1e-9);
  assertEquals(inputOf(wandered.action).forward, true);
  assertNoGuns(wandered.action);

  const fresh = think(brain(), world(0, self, [self]));
  assertEquals(fresh.state.targetEnemyId, "");
  assertEquals(inputOf(fresh.action).forward, false);
  assertEquals(inputOf(fresh.action).yaw, self.yaw);
  assertNoGuns(fresh.action);
});

Deno.test("zombie brain: melee only in reach, in front, and off cooldown", () => {
  const human = pawn("h", { x: 0.4, z: 0 });
  const self = pawn("za", {
    isBot: true,
    team: "B",
    yaw: zombieLookAt({ x: 0, y: 1.6, z: 0 }, human).yaw,
  });
  const bot = brain();
  const state = emptyBotBrainState();
  const cd = meleeCooldownTicks();

  const first = think(bot, world(0, self, [self, human]), state);
  assertEquals(first.action?.melee === true, true);
  assertEquals(state.reactionReadyAtTick, cd);
  assertNoGuns(first.action);

  const cooling = think(bot, world(1, self, [self, human]), state);
  assertEquals(cooling.action?.melee === true, false);
  assertEquals(state.reactionReadyAtTick, cd);
  assertNoGuns(cooling.action);

  const again = think(bot, world(cd, self, [self, human]), state);
  assertEquals(again.action?.melee === true, true);
  assertNoGuns(again.action);

  const turned = pawn("za", {
    isBot: true,
    team: "B",
    yaw: zombieLookAt(self, human).yaw + PI,
  });
  const away = think(brain(), world(0, turned, [turned, human]));
  const awayInput = inputOf(away.action);
  assertEquals(away.action?.melee === true, false);
  assertAlmostEquals(awayInput.yaw, zombieLookAt(turned, human).yaw, 1e-6);
  assertNoGuns(away.action);
});

Deno.test("zombie brain: stacked zombies strafe apart and still do not shoot", () => {
  const za = pawn("za", { isBot: true, team: "B" });
  const zb = pawn("zb", { isBot: true, team: "B" });
  const human = pawn("h", { z: -8 });
  const players = [za, zb, human];
  const a = think(brain(), world(0, za, players));
  const b = think(brain(), world(0, zb, players));
  const aIn = inputOf(a.action);
  const bIn = inputOf(b.action);

  assertEquals(aIn.right, true);
  assertEquals(aIn.left, false);
  assertEquals(bIn.left, true);
  assertEquals(bIn.right, false);
  assertEquals(aIn.forward, true);
  assertEquals(bIn.forward, true);
  assertNoGuns(a.action);
  assertNoGuns(b.action);

  const idleA = pawn("za", { isBot: true, team: "B" });
  const idleB = pawn("zb", { isBot: true, team: "B" });
  const stood = [idleA, idleB];
  const standA = inputOf(think(brain(), world(0, idleA, stood)).action);
  const standB = inputOf(think(brain(), world(0, idleB, stood)).action);
  assertEquals(standA.forward, false);
  assertEquals(standA.right, true);
  assertEquals(standB.left, true);
  assertEquals(standB.forward, false);
});

Deno.test("zombie brain: dead returns null, match over stands without shooting", () => {
  const self = pawn("za", { isBot: true, team: "B", alive: false });
  const human = pawn("h", { x: 4 });
  const dead = think(brain(), world(0, self, [self, human]));
  assertEquals(dead.action, null);

  const live = pawn("za", { isBot: true, team: "B", yaw: 0.4, pitch: -0.2 });
  const over = think(
    brain(),
    world(9, live, [live, human], { matchOver: true }),
  );
  const input = inputOf(over.action);
  assertEquals(input.forward, false);
  assertEquals(input.backward, false);
  assertEquals(input.left, false);
  assertEquals(input.right, false);
  assertEquals(input.jump, false);
  assertEquals(input.sprint, false);
  assertEquals(over.action?.shoot, false);
  assertEquals(over.action?.melee === true, false);
});

Deno.test("zombie brain: same inputs and rng produce the same action", () => {
  function rngFrom(seed: number): () => number {
    let s = seed | 0;
    return () => {
      s = (s * 1103515245 + 12345) | 0;
      const u = s < 0 ? s + 4294967296 : s;
      return u / 4294967296;
    };
  }

  function run(seed: number): string[] {
    clearCombatLosCache();
    const bot = new ZombieBrain(ZOMBIE_BOT_CONFIG, { rng: rngFrom(seed) });
    const state = emptyBotBrainState();
    const lines: string[] = [];
    for (let n = 0; n < 8; n++) {
      const tick = n * 3;
      const human = pawn("h", { x: n < 4 ? 7 : 0.3, z: -0.2 });
      // Melee checks the body, which this harness does not turn. Face them
      // once they step into reach so the swing is part of the trace.
      const yaw = n < 4
        ? 0.2
        : zombieLookAt({ x: 0, y: 1.6, z: 0 }, human).yaw;
      const self = pawn("za", { isBot: true, team: "B", yaw });
      const crowd = pawn("zb", { isBot: true, team: "B", x: 0.4, z: 0.1 });
      const action = bot.think(world(tick, self, [self, human, crowd]), state);
      const input = action?.input;
      lines.push(JSON.stringify({
        shoot: action?.shoot === true,
        reload: action?.reload === true,
        weapon: action?.weapon ?? null,
        ability: action?.ability ?? null,
        melee: action?.melee === true,
        forward: input?.forward ?? null,
        backward: input?.backward ?? null,
        left: input?.left ?? null,
        right: input?.right ?? null,
        jump: input?.jump ?? null,
        sprint: input?.sprint ?? null,
        crouch: input?.crouch ?? null,
        yaw: input?.yaw ?? null,
        pitch: input?.pitch ?? null,
        id: state.targetEnemyId,
        ready: state.reactionReadyAtTick,
      }));
    }
    return lines;
  }

  const first = run(0x5eed);
  const second = run(0x5eed);
  assertEquals(second, first);
  assertEquals(first.some((line) => line.includes('"shoot":true')), false);
  assertEquals(first.some((line) => line.includes('"melee":true')), true);
});
