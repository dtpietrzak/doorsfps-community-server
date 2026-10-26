/**
 * Protocol-5 child used by commandBrain_test. Hold W for every requested pawn.
 * The first batch that contains an agent also answers for that agent id, which
 * the host must drop whole. Later batches are clean, with yaw 0.5, so a restart
 * can be told apart from the keys held before the poison batch.
 */
import type { ReadyAction } from "@doors/bot-engine";
import {
  BOT_THINK_PIPELINE_MAX_FRAME_BYTES,
  BOT_THINK_PIPELINE_PROTOCOL_VERSION,
  type BotThinkPipelineRequest,
  type BotThinkPipelineResponse,
  decodeBotThinkPipelineRequestFrame,
  encodeBotThinkPipelineResponseFrame,
  pipelineFramePayloadLength,
} from "@doors/bot-engine/protocol";

const SENTINEL_YAW = 2.5;
const SENTINEL_PITCH = -1.25;
const AFTER_POISON_YAW = 0.5;

let poisoned = false;

function holdW(yaw: number): ReadyAction {
  return {
    input: {
      forward: true,
      backward: false,
      left: false,
      right: false,
      jump: false,
      sprint: false,
      crouch: false,
      yaw,
      pitch: 0,
    },
  };
}

function respond(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  response: BotThinkPipelineResponse,
): Promise<void> {
  return writer.write(encodeBotThinkPipelineResponseFrame(response)).then(
    () => {},
  );
}

function answer(
  request: BotThinkPipelineRequest,
): BotThinkPipelineResponse | "exit" {
  switch (request.type) {
    case "pipeline-hello":
      return {
        type: "pipeline-hello",
        requestId: request.requestId,
        protocolVersion: BOT_THINK_PIPELINE_PROTOCOL_VERSION,
        engineVersion: "hold-w",
      };
    case "pipeline-load-map":
    case "pipeline-synchronize-bots":
      return {
        type: "pipeline-acknowledgement",
        requestId: request.requestId,
        accepted: true,
      };
    case "pipeline-shutdown":
      return "exit";
    case "pipeline-think-batch": {
      const input = request.input;
      const yaw = poisoned ? AFTER_POISON_YAW : 0;
      const decisions = input.bots.map((bot) => ({
        botId: bot.botId,
        spawnedAtTick: bot.spawnedAtTick,
        action: holdW(yaw),
      }));
      const agent = input.frame.players.find((player) => player.kind === "agent");
      if (agent && !poisoned) {
        poisoned = true;
        decisions.push({
          botId: agent.id,
          spawnedAtTick: agent.spawnedAtTick,
          action: {
            input: {
              forward: true,
              backward: true,
              left: true,
              right: true,
              jump: true,
              sprint: false,
              crouch: true,
              yaw: SENTINEL_YAW,
              pitch: SENTINEL_PITCH,
            },
          },
        });
      }
      return {
        type: "pipeline-think-batch-result",
        requestId: request.requestId,
        output: {
          tick: input.frame.tick,
          applyTick: input.applyTick,
          mapRevision: input.frame.mapRevision,
          decisions,
        },
      };
    }
    default:
      return {
        type: "pipeline-acknowledgement",
        requestId: request.requestId,
        accepted: true,
      };
  }
}

const writer = Deno.stdout.writable.getWriter();
const reader = Deno.stdin.readable.getReader();
let buffered = new Uint8Array(0);

while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  if (value && value.byteLength > 0) {
    const next = new Uint8Array(buffered.byteLength + value.byteLength);
    next.set(buffered);
    next.set(value, buffered.byteLength);
    buffered = next;
  }
  let start = 0;
  let exit = false;
  while (buffered.byteLength - start >= 4) {
    const length = pipelineFramePayloadLength(
      buffered.subarray(start, start + 4),
    );
    if (length < 8 || length > BOT_THINK_PIPELINE_MAX_FRAME_BYTES) {
      Deno.exit(1);
    }
    const total = 4 + length;
    if (buffered.byteLength - start < total) break;
    const request = decodeBotThinkPipelineRequestFrame(
      buffered.slice(start, start + total),
    );
    start += total;
    if (request.type === "pipeline-shutdown") {
      await respond(writer, {
        type: "pipeline-acknowledgement",
        requestId: request.requestId,
        accepted: true,
      });
      exit = true;
      break;
    }
    const response = answer(request);
    if (response === "exit") {
      exit = true;
      break;
    }
    await respond(writer, response);
  }
  if (start > 0) buffered = buffered.slice(start);
  if (exit) break;
}

try {
  await writer.close();
} catch {
  // host already closed the pipe
}
Deno.exit(0);
