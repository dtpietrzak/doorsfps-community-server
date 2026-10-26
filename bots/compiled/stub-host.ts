/**
 * Test-only pipeline host. Delays load-map acks so transport races are visible.
 */
import {
  BOT_THINK_ENGINE_VERSION,
  BOT_THINK_PIPELINE_MAX_FRAME_BYTES,
  BOT_THINK_PIPELINE_PROTOCOL_VERSION,
  decodeBotThinkPipelineRequestFrame,
  encodeBotThinkPipelineResponseFrame,
  pipelineFramePayloadLength,
} from "@doors/bot-engine/protocol";

const loadMapDelayMs = Number(
  Deno.env.get("COMPILED_STUB_LOAD_MAP_DELAY_MS") ?? "40",
);

let buffered = new Uint8Array(0);
let loadMaps = 0;
let syncs = 0;
let thinks = 0;
let handling = Promise.resolve();
let stopping = false;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function write(
  response: Parameters<typeof encodeBotThinkPipelineResponseFrame>[0],
): void {
  const frame = encodeBotThinkPipelineResponseFrame(response);
  Deno.stdout.writeSync(frame);
}

function reportCounts(): void {
  console.error(`compiled-stub counts loadMap=${loadMaps} sync=${syncs} think=${thinks}`);
}

async function handleFrame(frame: Uint8Array): Promise<boolean> {
  const request = decodeBotThinkPipelineRequestFrame(frame);
  switch (request.type) {
    case "pipeline-hello":
      write({
        type: "pipeline-hello",
        requestId: request.requestId,
        protocolVersion: BOT_THINK_PIPELINE_PROTOCOL_VERSION,
        engineVersion: BOT_THINK_ENGINE_VERSION,
      });
      return false;
    case "pipeline-load-map":
      loadMaps += 1;
      reportCounts();
      if (loadMapDelayMs > 0) await delay(loadMapDelayMs);
      write({
        type: "pipeline-acknowledgement",
        requestId: request.requestId,
        accepted: true,
      });
      return false;
    case "pipeline-synchronize-bots":
      syncs += 1;
      reportCounts();
      write({
        type: "pipeline-acknowledgement",
        requestId: request.requestId,
        accepted: true,
      });
      return false;
    case "pipeline-think-batch":
      thinks += 1;
      reportCounts();
      write({
        type: "pipeline-think-batch-result",
        requestId: request.requestId,
        output: {
          tick: request.input.frame.tick,
          applyTick: request.input.applyTick,
          mapRevision: request.input.frame.mapRevision,
          decisions: request.input.bots.map((bot) => ({
            botId: bot.botId,
            spawnedAtTick: bot.spawnedAtTick,
            action: null,
          })),
        },
      });
      return false;
    case "pipeline-shutdown":
      write({
        type: "pipeline-acknowledgement",
        requestId: request.requestId,
        accepted: true,
      });
      return true;
    default:
      write({
        type: "pipeline-acknowledgement",
        requestId: request.requestId,
        accepted: true,
      });
      return false;
  }
}

function consume(): void {
  let start = 0;
  const frames: Uint8Array[] = [];
  while (buffered.byteLength - start >= 4) {
    const length = pipelineFramePayloadLength(buffered.subarray(start, start + 4));
    if (length < 8 || length > BOT_THINK_PIPELINE_MAX_FRAME_BYTES) {
      throw new Error("invalid stub frame length");
    }
    const total = 4 + length;
    if (buffered.byteLength - start < total) break;
    frames.push(buffered.slice(start, start + total));
    start += total;
  }
  if (start > 0) buffered = buffered.slice(start);
  for (const frame of frames) {
    handling = handling.then(async () => {
      if (stopping) return;
      stopping = await handleFrame(frame);
    });
  }
}

const stdin = Deno.stdin.readable.getReader();
const pump = async (): Promise<void> => {
  while (!stopping) {
    const { value, done } = await stdin.read();
    if (done || value === undefined) break;
    const next = new Uint8Array(buffered.byteLength + value.byteLength);
    next.set(buffered);
    next.set(value, buffered.byteLength);
    buffered = next;
    consume();
  }
  await handling;
};

await pump();
