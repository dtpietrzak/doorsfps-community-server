import { assertEquals } from "jsr:@std/assert@1";
import {
  BOT_DEC_CAMP_PLANTED,
  BOT_DEC_CAMP_VIA_OWN,
  BOT_DEC_CLICK,
  BOT_DEC_COMBAT_ADAD,
  BOT_DEC_DOOR_CAMP,
  BOT_DEC_FLOAT_DUCK,
  BOT_DEC_HALF_VAULT,
  BOT_DEC_HEAD_AIM,
  BOT_DEC_HUNT,
  BOT_DEC_HUNT_ENEMY,
  BOT_DEC_LOOK_REACT,
  BOT_DEC_PATH,
  BOT_DEC_PATH_STRAFE,
  BOT_DEC_SHOOT_REACT,
  BOT_DEC_SPRINT,
  BOT_DEC_STAND_GROUND,
  BOT_DEC_STUCK_W,
  BOT_DEC_TARGET_ENEMY,
  BOT_DEC_YAW_BALLISTIC,
  BOT_DEC_YAW_POLE,
  BOT_DECISION_SWITCHES,
  botDecisionOn,
  encodeBotDecisions,
} from "./botDecisions.ts";

Deno.test("encodeBotDecisions: default path when no latches", () => {
  const bits = encodeBotDecisions({ tick: 0, state: {} });
  assertEquals(bits, BOT_DEC_PATH);
  assertEquals(botDecisionOn(bits, BOT_DEC_PATH), true);
  assertEquals(botDecisionOn(bits, BOT_DEC_HUNT), false);
});

Deno.test("encodeBotDecisions: hunt + enemy door bias + yaw pole", () => {
  const bits = encodeBotDecisions({
    tick: 100,
    state: {
      huntActive: true,
      huntDoorBias: "enemy",
      stickyYawPole: { x: 1, z: 2 },
      pathStrafeDir: "left",
    },
  });
  assertEquals(botDecisionOn(bits, BOT_DEC_HUNT), true);
  assertEquals(botDecisionOn(bits, BOT_DEC_HUNT_ENEMY), true);
  assertEquals(botDecisionOn(bits, BOT_DEC_YAW_POLE), true);
  assertEquals(botDecisionOn(bits, BOT_DEC_PATH_STRAFE), true);
  assertEquals(botDecisionOn(bits, BOT_DEC_PATH), false);
});

Deno.test("encodeBotDecisions: door camp planted + via own", () => {
  const bits = encodeBotDecisions({
    tick: 50,
    state: {
      doorCampActive: true,
      doorCampPlantX: 10,
      doorCampPlantZ: -4,
      doorCampViaOwn: true,
    },
    selfX: 10.1,
    selfZ: -4.05,
  });
  assertEquals(botDecisionOn(bits, BOT_DEC_DOOR_CAMP), true);
  assertEquals(botDecisionOn(bits, BOT_DEC_CAMP_PLANTED), true);
  assertEquals(botDecisionOn(bits, BOT_DEC_CAMP_VIA_OWN), true);
});

Deno.test("encodeBotDecisions: commits + combat lock stack", () => {
  const bits = encodeBotDecisions({
    tick: 10,
    state: {
      halfWallVaultTicksLeft: 5,
      floatWallDuckTicksLeft: 3,
      stuckWTurnTicksLeft: 2,
      targetEnemyId: "e1",
      targetEnemyStandGround: true,
      targetEnemyStrafePhase: "strafe",
      lookReactionForEnemyId: "e1",
      lookReactionReadyAtTick: 20,
      reactionForEnemyId: "e1",
      reactionReadyAtTick: 25,
      combatAimHeight: "head",
      yawHumanizePhase: "ballistic",
    },
    ready: {
      shoot: true,
      input: { sprint: true },
    },
  });
  assertEquals(botDecisionOn(bits, BOT_DEC_HALF_VAULT), true);
  assertEquals(botDecisionOn(bits, BOT_DEC_FLOAT_DUCK), true);
  assertEquals(botDecisionOn(bits, BOT_DEC_STUCK_W), true);
  assertEquals(botDecisionOn(bits, BOT_DEC_TARGET_ENEMY), true);
  assertEquals(botDecisionOn(bits, BOT_DEC_STAND_GROUND), true);
  assertEquals(botDecisionOn(bits, BOT_DEC_COMBAT_ADAD), true);
  assertEquals(botDecisionOn(bits, BOT_DEC_LOOK_REACT), true);
  assertEquals(botDecisionOn(bits, BOT_DEC_SHOOT_REACT), true);
  assertEquals(botDecisionOn(bits, BOT_DEC_HEAD_AIM), true);
  assertEquals(botDecisionOn(bits, BOT_DEC_YAW_BALLISTIC), true);
  assertEquals(botDecisionOn(bits, BOT_DEC_CLICK), true);
  assertEquals(botDecisionOn(bits, BOT_DEC_SPRINT), true);
});

Deno.test("BOT_DECISION_SWITCHES: unique bits and ids", () => {
  const bits = new Set<number>();
  const ids = new Set<string>();
  for (const s of BOT_DECISION_SWITCHES) {
    assertEquals(bits.has(s.bit), false, `duplicate bit ${s.bit}`);
    assertEquals(ids.has(s.id), false, `duplicate id ${s.id}`);
    bits.add(s.bit);
    ids.add(s.id);
  }
});
