import { assertEquals } from "@std/assert";
import {
  decodeBotThinkPipelineResponseFrame,
  encodeBotThinkPipelineResponseFrame,
} from "../spec/src/protocol/pipeline.ts";

const input = {
  forward: true,
  backward: false,
  left: false,
  right: false,
  jump: false,
  sprint: false,
  crouch: false,
  yaw: 0.5,
  pitch: -0.1,
};

function roundTrip(action: Record<string, unknown> | null) {
  const response = {
    type: "pipeline-think-batch-result" as const,
    requestId: 1,
    output: {
      tick: 30,
      applyTick: 33,
      mapRevision: "rev",
      decisions: [{ botId: "z", spawnedAtTick: 0, action }],
    },
  };
  // deno-lint-ignore no-explicit-any
  const frame = encodeBotThinkPipelineResponseFrame(response as any);
  const decoded = decodeBotThinkPipelineResponseFrame(frame);
  if (decoded.type !== "pipeline-think-batch-result") throw new Error(decoded.type);
  return { frame, action: decoded.output.decisions[0]!.action };
}

Deno.test("a melee swing survives the wire in the spare input bit", () => {
  const { action } = roundTrip({ input, shoot: false, melee: true });
  assertEquals(action, { input, shoot: false, melee: true });
});

Deno.test("an action without melee encodes byte-for-byte as before", () => {
  const plain = roundTrip({ input, shoot: false });
  const off = roundTrip({ input, shoot: false, melee: false });
  assertEquals(plain.action, { input, shoot: false });
  assertEquals(off.frame, plain.frame);
});
