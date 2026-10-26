import { assertEquals } from "@std/assert";
import {
  clearLastMove,
  createLastMoveMemory,
  getLastMove,
  recordLastMove,
  replayLastMove,
} from "./lastMove.ts";
import type { ReadyAction } from "./types.ts";

const moveA: ReadyAction = {
  input: {
    sequence: 1,
    forward: true,
    backward: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
    crouch: false,
    yaw: 0.5,
    pitch: 0,
  },
  shoot: true,
};

Deno.test("recordLastMove / getLastMove / replayLastMove", () => {
  const mem = createLastMoveMemory();
  assertEquals(getLastMove(mem, "b1"), undefined);
  assertEquals(replayLastMove(mem, "b1"), null);

  recordLastMove(mem, "b1", moveA);
  assertEquals(getLastMove(mem, "b1"), moveA);
  assertEquals(replayLastMove(mem, "b1"), moveA);

  recordLastMove(mem, "b1", null);
  assertEquals(getLastMove(mem, "b1"), null);
  assertEquals(replayLastMove(mem, "b1"), null);
});

Deno.test("clearLastMove removes bot entry", () => {
  const mem = createLastMoveMemory();
  recordLastMove(mem, "b1", moveA);
  clearLastMove(mem, "b1");
  assertEquals(getLastMove(mem, "b1"), undefined);
  assertEquals(replayLastMove(mem, "b1"), null);
});
