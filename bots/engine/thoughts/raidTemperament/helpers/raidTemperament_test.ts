/**
 * Ported from `server-community/bots/BotManager_test.ts` /
 * `bots/pipeline/bot_apply_hold_test.ts` (keys-only PR 6): the raid
 * move/pause cadence and the WASD-zero transform now live in bot-official.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { TICK_HZ } from "../../../shared/network.ts";
import {
  advanceRaidBotMovementCadence,
  createRaidBotMovementCadence,
  zeroRaidMovementInput,
} from "./raidTemperament.ts";

Deno.test("half-chance raid cadence moves 2-5s then stops 1-2s", () => {
  const minRolls = [0.49, 0, 0, 0, 0, 0];
  const roll = () => minRolls.shift() ?? 0;
  const cadence = createRaidBotMovementCadence(10, roll);
  assert(cadence);
  assertEquals(cadence.nextStopTick, 10 + 2 * TICK_HZ);
  assertEquals(
    advanceRaidBotMovementCadence(cadence, 10 + 2 * TICK_HZ - 1, roll),
    false,
  );

  const firstStopTick = 10 + 2 * TICK_HZ;
  assertEquals(
    advanceRaidBotMovementCadence(cadence, firstStopTick, roll),
    true,
  );
  assertEquals(cadence.stopUntilTick, firstStopTick + TICK_HZ);
  assertEquals(cadence.nextStopTick, firstStopTick + 3 * TICK_HZ);
  assertEquals(
    advanceRaidBotMovementCadence(cadence, cadence.stopUntilTick - 1, roll),
    true,
  );
  assertEquals(
    advanceRaidBotMovementCadence(cadence, cadence.stopUntilTick, roll),
    false,
  );

  // The other 50% never receives a stop cadence and keeps rushing.
  assertEquals(createRaidBotMovementCadence(0, () => 0.5), null);
});

Deno.test("raid pause zeroes WASD but preserves look and combat edges", () => {
  const input = {
    sequence: 7,
    forward: true,
    backward: false,
    left: true,
    right: false,
    jump: true,
    sprint: true,
    crouch: true,
    yaw: 1.25,
    pitch: -0.2,
  };

  const stopped = zeroRaidMovementInput(input);
  assertEquals(stopped, {
    sequence: 7,
    forward: false,
    backward: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
    crouch: true,
    yaw: 1.25,
    pitch: -0.2,
  });
  assertEquals(input.forward, true);
});
