import { assertEquals } from "@std/assert";
import type { SkillId } from "../../../../shared/sim/skills.ts";
import {
  createUseSkillsStep,
  pickSituationalSkill,
  usableEquippedSkills,
} from "./index.ts";
import type { ReadyAction, ThinkContext } from "../../pipeline/index.ts";
import type { BotWorldView } from "../../types.ts";
import { TARGET_ENEMY_STATE_KEY } from "../targetEnemy/helpers/targetEnemy.ts";

function fakeSelf(opts: {
  loadout: Array<SkillId | null> | null;
  can: (id: SkillId) => boolean;
  health?: number;
  weaponId?: number;
  hawkeyes?: boolean;
}) {
  return {
    snapshotSkillLoadout: () => opts.loadout,
    canActivateAbility: (id: SkillId, _tick: number) => opts.can(id),
    health: opts.health ?? 100,
    weaponId: opts.weaponId ?? 1,
    isAbilityActive: (id: SkillId) => id === "hawkeyes" && opts.hawkeyes === true,
  };
}

function sit(
  over: Partial<Parameters<typeof pickSituationalSkill>[0]> & {
    usable: readonly SkillId[];
  },
): Parameters<typeof pickSituationalSkill>[0] {
  return {
    health: 100,
    locked: false,
    shooting: false,
    moving: false,
    hawkeyesActive: false,
    sensedHostileCount: 0,
    nearestSensedDist: null,
    weaponId: 1,
    stuck: false,
    ...over,
  };
}

Deno.test("usableEquippedSkills: skips null, passive, and blocked", () => {
  const self = fakeSelf({
    loadout: ["quick", "leech", "bullets", null],
    can: (id) => id === "quick" || id === "bullets",
  });
  // leech is passive → skipped even if canActivate returned true
  assertEquals(usableEquippedSkills(self, 0), ["quick", "bullets"]);
});

Deno.test("usableEquippedSkills: null loadout → none", () => {
  const self = fakeSelf({ loadout: null, can: () => true });
  assertEquals(usableEquippedSkills(self, 0), []);
});

Deno.test("pickSituationalSkill: heal beats Hawkeyes when hurt", () => {
  assertEquals(
    pickSituationalSkill(sit({
      usable: ["hawkeyes", "selfHeal"],
      health: 50,
      locked: true,
      moving: true,
    })),
    "selfHeal",
  );
});

Deno.test("pickSituationalSkill: Hawkeyes when locked + moving", () => {
  assertEquals(
    pickSituationalSkill(sit({
      usable: ["hawkeyes", "glitch", "quick"],
      locked: true,
      moving: true,
    })),
    "hawkeyes",
  );
});

Deno.test("pickSituationalSkill: Glitch only when sensed and losing", () => {
  assertEquals(
    pickSituationalSkill(sit({
      usable: ["glitch"],
      health: 40,
      sensedHostileCount: 1,
      shooting: false,
    })),
    "glitch",
  );
  assertEquals(
    pickSituationalSkill(sit({
      usable: ["glitch"],
      health: 40,
      sensedHostileCount: 1,
      shooting: true,
    })),
    null,
  );
  assertEquals(
    pickSituationalSkill(sit({
      usable: ["glitch"],
      health: 90,
      sensedHostileCount: 1,
    })),
    null,
  );
});

Deno.test("pickSituationalSkill: Rewind / Teleport only when stuck", () => {
  assertEquals(
    pickSituationalSkill(sit({ usable: ["rewind", "teleport"] })),
    null,
  );
  assertEquals(
    pickSituationalSkill(sit({ usable: ["rewind", "teleport"], stuck: true })),
    "rewind",
  );
});

Deno.test("pickSituationalSkill: Quick on door-run, not in a duel", () => {
  assertEquals(
    pickSituationalSkill(sit({ usable: ["quick"], moving: true })),
    "quick",
  );
  assertEquals(
    pickSituationalSkill(sit({
      usable: ["quick"],
      moving: true,
      locked: true,
    })),
    null,
  );
});

Deno.test("useSkills: chance 0 never sets ability", () => {
  const step = createUseSkillsStep({ skillUseChance: 0, rng: () => 0 });
  const prior: ReadyAction = {
    input: {
      sequence: 0,
      forward: true,
      backward: false,
      left: false,
      right: false,
      jump: false,
      sprint: false,
      crouch: false,
      yaw: 0,
      pitch: 0,
    },
    shoot: true,
  };
  const self = fakeSelf({
    loadout: ["quick", null, null, null],
    can: () => true,
  });
  const ctx = {
    view: { tick: 10, self } as unknown as BotWorldView,
    logicalTick: 10,
    botId: "b1",
    rng: () => 0,
  } as ThinkContext;
  const result = step.run(ctx, prior, {});
  assertEquals(result.ready?.ability, undefined);
  assertEquals(result.ready?.shoot, true);
});

Deno.test("useSkills: Hawkeyes when locked + moving", () => {
  const step = createUseSkillsStep({ skillUseChance: 1, rng: () => 0 });
  const prior: ReadyAction = {
    input: {
      sequence: 0,
      forward: true,
      backward: false,
      left: false,
      right: false,
      jump: false,
      sprint: false,
      crouch: false,
      yaw: 0,
      pitch: 0,
    },
  };
  const self = fakeSelf({
    loadout: ["hawkeyes", "selfHeal", null, null],
    can: () => true,
    health: 100,
  });
  const ctx = {
    view: { tick: 1, self } as unknown as BotWorldView,
    logicalTick: 1,
    botId: "b1",
    rng: () => 0,
  } as ThinkContext;
  const result = step.run(ctx, prior, { [TARGET_ENEMY_STATE_KEY]: "e1" });
  assertEquals(result.ready?.ability, "hawkeyes");
});

Deno.test("useSkills: no situational match → no activate", () => {
  const step = createUseSkillsStep({ skillUseChance: 1, rng: () => 0 });
  const prior: ReadyAction = { input: null };
  const self = fakeSelf({
    loadout: ["hawkeyes", "glitch", null, null],
    can: () => true,
    health: 100,
  });
  const ctx = {
    view: { tick: 1, self } as unknown as BotWorldView,
    logicalTick: 1,
    botId: "b1",
    rng: () => 0,
  } as ThinkContext;
  const result = step.run(ctx, prior, {});
  assertEquals(result.ready?.ability, undefined);
});
